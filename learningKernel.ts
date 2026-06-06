/**
 * learningKernel.ts — patched v2 SQLite persistence
 *
 * Replaces /tmp/learning_kernel.json with SQLite tables inside data.db.
 * Keeps the same exports used by routes.ts.
 */

import Database from 'better-sqlite3';
import path from 'path';

export interface LearningEntry {
  signalId: string;
  grade: string;
  direction: string;
  gravityScore: number;
  primaryPassing: number;
  deltaFlip: boolean;
  threeBarPlay: boolean;
  extended1SD: boolean;
  absorptionConf: boolean;
  killzone: string;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  exitPrice: number;
  pnlPoints: number;
  pnlDollars: number;
  result: string;
  exitReason: string;
  scDelta: number;
  scCvd: number;
  scBuyVol: number;
  scSellVol: number;
  tradeDate: string;
  entryTime: string;
  exitTime: string;
  recordedAt: number;
}

export interface FeatureWeight {
  feature: string;
  wins: number;
  total: number;
  winRate: number;
  weight: number;
  lastUpdated: number;
}

const dbPath = path.resolve(process.cwd(), 'data.db');
const db = new Database(dbPath);
const EMA_ALPHA = 0.15;
const MAX_ENTRIES = 500;

const DEFAULT_FEATURES = [
  'grade_Aplus', 'grade_A', 'grade_B',
  'gravity_1', 'gravity_2', 'gravity_3', 'gravity_4plus',
  'delta_flip', 'three_bar_play', 'extended_1sd', 'absorption_conf',
  'killzone_london', 'killzone_ny_open', 'killzone_ny_close', 'killzone_asia',
  'primary_6of6', 'primary_5of6', 'primary_4of6',
  'direction_long', 'direction_short',
  'pnl_positive_20plus', 'pnl_negative_15plus',
];

db.exec(`
  CREATE TABLE IF NOT EXISTS learning_entries (
    signal_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    result TEXT,
    pnl_points REAL,
    recorded_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS feature_weights (
    feature TEXT PRIMARY KEY,
    wins INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    win_rate REAL NOT NULL DEFAULT 0,
    weight REAL NOT NULL DEFAULT 1,
    last_updated INTEGER NOT NULL
  );
`);

function ensureDefaultWeights() {
  const stmt = db.prepare(`INSERT OR IGNORE INTO feature_weights (feature, wins, total, win_rate, weight, last_updated) VALUES (?,0,0,0,1,?)`);
  const now = Date.now();
  for (const f of DEFAULT_FEATURES) stmt.run(f, now);
}
ensureDefaultWeights();

function normalizeEntry(entry: any): Omit<LearningEntry, 'recordedAt'> {
  return {
    signalId: String(entry.signalId ?? entry.id ?? ''),
    grade: String(entry.grade ?? 'UNKNOWN'),
    direction: String(entry.direction ?? '').toUpperCase(),
    gravityScore: Number(entry.gravityScore ?? 0),
    primaryPassing: Number(entry.primaryPassing ?? 0),
    deltaFlip: Boolean(entry.deltaFlip),
    threeBarPlay: Boolean(entry.threeBarPlay),
    extended1SD: Boolean(entry.extended1SD),
    absorptionConf: Boolean(entry.absorptionConf),
    killzone: String(entry.killzone ?? entry.session ?? ''),
    entryPrice: Number(entry.entryPrice ?? entry.entry ?? 0),
    slPrice: Number(entry.slPrice ?? entry.sl ?? 0),
    tp1Price: Number(entry.tp1Price ?? entry.tp1 ?? 0),
    tp2Price: Number(entry.tp2Price ?? entry.tp2 ?? 0),
    exitPrice: Number(entry.exitPrice ?? 0),
    pnlPoints: Number(entry.pnlPoints ?? entry.pnlPts ?? 0),
    pnlDollars: Number(entry.pnlDollars ?? ((entry.pnlPoints ?? entry.pnlPts ?? 0) * 20)),
    result: String(entry.result ?? entry.outcome ?? 'UNKNOWN'),
    exitReason: String(entry.exitReason ?? ''),
    scDelta: Number(entry.scDelta ?? entry.delta ?? 0),
    scCvd: Number(entry.scCvd ?? entry.cvd ?? 0),
    scBuyVol: Number(entry.scBuyVol ?? entry.buyVolume ?? 0),
    scSellVol: Number(entry.scSellVol ?? entry.sellVolume ?? 0),
    tradeDate: String(entry.tradeDate ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })),
    entryTime: String(entry.entryTime ?? ''),
    exitTime: String(entry.exitTime ?? new Date().toISOString()),
  };
}

function activeFeatures(entry: Omit<LearningEntry, 'recordedAt'>): string[] {
  const out: string[] = [];

  if (entry.grade === 'A+') out.push('grade_Aplus');
  else if (entry.grade === 'A') out.push('grade_A');
  else if (entry.grade === 'B') out.push('grade_B');

  const g = entry.gravityScore;
  if (g >= 4) out.push('gravity_4plus');
  else if (g === 3) out.push('gravity_3');
  else if (g === 2) out.push('gravity_2');
  else out.push('gravity_1');

  if (entry.direction === 'LONG') out.push('direction_long');
  if (entry.direction === 'SHORT') out.push('direction_short');
  if (entry.deltaFlip) out.push('delta_flip');
  if (entry.threeBarPlay) out.push('three_bar_play');
  if (entry.extended1SD) out.push('extended_1sd');
  if (entry.absorptionConf) out.push('absorption_conf');

  const kz = (entry.killzone || '').toLowerCase();
  if (kz.includes('london')) out.push('killzone_london');
  else if (kz.includes('ny')) out.push('killzone_ny_open');
  else if (kz.includes('asia')) out.push('killzone_asia');

  if (entry.primaryPassing >= 6) out.push('primary_6of6');
  else if (entry.primaryPassing >= 5) out.push('primary_5of6');
  else if (entry.primaryPassing >= 4) out.push('primary_4of6');

  if (entry.pnlPoints >= 20) out.push('pnl_positive_20plus');
  if (entry.pnlPoints <= -15) out.push('pnl_negative_15plus');

  return [...new Set(out)];
}

function updateWeight(feature: string, isWin: boolean) {
  db.prepare(`INSERT OR IGNORE INTO feature_weights (feature, wins, total, win_rate, weight, last_updated) VALUES (?,0,0,0,1,?)`)
    .run(feature, Date.now());
  const w = db.prepare(`SELECT * FROM feature_weights WHERE feature=?`).get(feature) as any;

  const wins = Number(w.wins) + (isWin ? 1 : 0);
  const total = Number(w.total) + 1;
  const rawWinRate = (wins / total) * 100;
  const prevWinRate = Number(w.win_rate ?? 0);
  const winRate = total === 1 ? rawWinRate : EMA_ALPHA * rawWinRate + (1 - EMA_ALPHA) * prevWinRate;

  let weight = 1.0;
  if (total >= 5) {
    if (winRate >= 80) weight = 2.0;
    else if (winRate >= 70) weight = 1.5;
    else if (winRate >= 60) weight = 1.2;
    else if (winRate >= 50) weight = 1.0;
    else if (winRate >= 40) weight = 0.8;
    else weight = 0.6;
  }

  db.prepare(`UPDATE feature_weights SET wins=?, total=?, win_rate=?, weight=?, last_updated=? WHERE feature=?`)
    .run(wins, total, winRate, weight, Date.now(), feature);
}

export function recordTrade(rawEntry: any): void {
  const entry = normalizeEntry(rawEntry);
  if (!entry.signalId) throw new Error('Missing signalId');

  const full: LearningEntry = { ...entry, recordedAt: Date.now() };
  const isWin = full.result === 'TP1' || full.result === 'TP2' || full.pnlPoints > 0;

  const existing = db.prepare(`SELECT signal_id FROM learning_entries WHERE signal_id=?`).get(full.signalId);
  if (existing) return;

  db.prepare(`INSERT INTO learning_entries (signal_id, data, result, pnl_points, recorded_at) VALUES (?, ?, ?, ?, ?)`)
    .run(full.signalId, JSON.stringify(full), full.result, full.pnlPoints, full.recordedAt);

  for (const f of activeFeatures(entry)) updateWeight(f, isWin);

  // Keep table compact.
  db.prepare(`DELETE FROM learning_entries WHERE signal_id NOT IN (SELECT signal_id FROM learning_entries ORDER BY recorded_at DESC LIMIT ?)`)
    .run(MAX_ENTRIES);

  console.log(`[LearningKernel] Recorded ${full.result} | ${full.grade} G${full.gravityScore} | ${full.pnlPoints}pts`);
}

function getWeightRecord(feature: string): FeatureWeight | null {
  const row = db.prepare(`SELECT feature, wins, total, win_rate as winRate, weight, last_updated as lastUpdated FROM feature_weights WHERE feature=?`).get(feature) as any;
  if (!row) return null;
  return { feature: row.feature, wins: row.wins, total: row.total, winRate: row.winRate, weight: row.weight, lastUpdated: row.lastUpdated };
}

function getLearnedGravityBoost(features: {
  grade: string;
  deltaFlip: boolean;
  threeBarPlay: boolean;
  extended1SD: boolean;
  absorptionConf: boolean;
  killzone: string;
}): number {
  let boost = 0;
  const check = (key: string) => {
    const w = getWeightRecord(key);
    return !!w && w.total >= 5 && w.weight >= 1.5;
  };
  if (features.deltaFlip && check('delta_flip')) boost++;
  if (features.threeBarPlay && check('three_bar_play')) boost++;
  if (features.extended1SD && check('extended_1sd')) boost++;
  if (features.absorptionConf && check('absorption_conf')) boost++;
  return Math.min(2, boost);
}

export function buildMuzziSignal(mergedData: any): any {
  const tv = mergedData.tv || {};
  const sc = mergedData.sc || {};
  const price = tv.close || sc.close || 0;
  if (!price) return null;

  const tv15 = mergedData.tv15 || (String(tv.timeframe) === '15' ? tv : null);
  const tv5 = mergedData.tv5 || (String(tv.timeframe) === '5' ? tv : null);

  const bias15 = tv15
    ? (tv15.market_structure || tv15.marketStructure || '').includes('bull') ? 'BULLISH'
      : (tv15.market_structure || tv15.marketStructure || '').includes('bear') ? 'BEARISH'
      : 'NEUTRAL'
    : 'NEUTRAL';
  const bias = bias15 !== 'NEUTRAL' ? bias15 : (mergedData.bias || 'NEUTRAL');
  const isLong = bias === 'BULLISH';
  const isShort = bias === 'BEARISH';

  const setupSrc = tv5 || tv || {};
  const activeSession = tv.active_session || tv.activeSession || 'RTH';
  const vwap = activeSession === 'RTH'
    ? (tv.vwap_rth || tv.vwapRth || tv.vwap || 0)
    : activeSession === 'London'
      ? (tv.vwap_london || tv.vwapLondon || tv.vwap || 0)
      : (tv.vwap_asia || tv.vwapAsia || tv.vwap || 0);

  const vwap1sdHi = tv.vwap_1sd_hi || tv.vwap1sdHi || 0;
  const vwap1sdLo = tv.vwap_1sd_lo || tv.vwap1sdLo || 0;

  const killzoneActive = !!(setupSrc.killzone && setupSrc.killzone !== '' && setupSrc.killzone !== 'off_session') || !!(tv.killzone && tv.killzone !== '' && tv.killzone !== 'off_session');
  const inDiscount = !!(tv.discount || tv.premium === 0);
  const inPremium = !!(tv.premium || tv.discount === 0);
  const validZone = isLong ? inDiscount : isShort ? inPremium : false;
  const sweepDone = !!(tv15?.sweep_high || tv15?.sweepHigh || tv15?.sweep_low || tv15?.sweepLow || tv.sweep_high || tv.sweepHigh || tv.sweep_low || tv.sweepLow);
  const mssText = setupSrc.market_structure || setupSrc.marketStructure || tv.market_structure || tv.marketStructure || '';
  const mssPresent = !!mssText;
  const mssAligned = isLong ? mssText.includes('bull') : isShort ? mssText.includes('bear') : false;
  const fvgBull = !!(setupSrc.fvg_bull || setupSrc.fvgBull || tv.fvg_bull || tv.fvgBull);
  const fvgBear = !!(setupSrc.fvg_bear || setupSrc.fvgBear || tv.fvg_bear || tv.fvgBear);
  const fvgAligned = isLong ? fvgBull : isShort ? fvgBear : false;
  const vwapAligned = isLong ? (vwap > 0 && price < vwap) : isShort ? (vwap > 0 && price > vwap) : false;
  const extended1SD = vwap1sdHi > 0 && ((isLong && price <= vwap1sdLo) || (isShort && price >= vwap1sdHi));
  const wreckingBall = !!(tv.wrecking_ball || tv.wreckingBall);

  const delta = sc.delta || 0;
  const cvd = sc.cvd || 0;
  const buyVolume = sc.buy_volume || sc.buyVolume || 0;
  const sellVolume = sc.sell_volume || sc.sellVolume || 0;
  const absBull = !!(sc.absorption_bull || sc.absorptionBull);
  const absBear = !!(sc.absorption_bear || sc.absorptionBear);
  const prevDelta = sc.prev_delta || sc.prevDelta || 0;
  const deltaFlip = prevDelta !== 0 && ((prevDelta < 0 && delta > 0) || (prevDelta > 0 && delta < 0));
  const threeBarPlay = !!(sc.three_bar_play || sc.threeBarPlay);

  const checks = [bias !== 'NEUTRAL', validZone, killzoneActive, sweepDone, mssPresent && mssAligned, fvgAligned];
  const primaryPassing = checks.filter(Boolean).length;

  let gravity = 0;
  if (validZone) gravity++;
  if (fvgAligned) gravity++;
  if (extended1SD) gravity++;
  if (deltaFlip) gravity++;
  if (absBull && isLong) gravity++;
  if (absBear && isShort) gravity++;

  let grade = 'WAIT';
  let direction = bias === 'BULLISH' ? 'LONG' : bias === 'BEARISH' ? 'SHORT' : 'WAIT';
  let coachingNote = '';
  let hardRule: string | null = null;

  if (wreckingBall) {
    grade = 'HARD RULE VIOLATED'; direction = 'WAIT'; hardRule = 'WRECKING BALL 09:30–09:35 NY — NO ENTRY';
  } else if (!validZone && bias !== 'NEUTRAL') {
    grade = 'HARD RULE VIOLATED'; direction = 'WAIT'; hardRule = isLong ? 'HARD RULE: Never long into Premium. Wait for Discount.' : 'HARD RULE: Never short into Discount. Wait for Premium.';
  } else if (primaryPassing >= 6 && gravity >= 3) {
    grade = 'A+'; coachingNote = 'A+ setup — Institutional Gravity confirmed. Execute with conviction.';
  } else if (primaryPassing >= 5 || (primaryPassing >= 4 && gravity >= 2)) {
    grade = 'A'; coachingNote = 'Strong A setup — wait for Delta Flip or Three-Bar Play confirmation.';
  } else if (primaryPassing >= 3) {
    grade = 'B'; coachingNote = 'B setup — structure building. Let price come to your zone.';
  } else {
    direction = 'WAIT'; coachingNote = `Only ${primaryPassing}/6 primary criteria met. No trade.`;
  }

  const gravityBoost = getLearnedGravityBoost({ grade, deltaFlip, threeBarPlay, extended1SD, absorptionConf: isLong ? absBull : absBear, killzone: tv.killzone || '' });
  const adjustedGravity = Math.min(5, gravity + gravityBoost);
  const levels = computeLevels(price, isLong, vwap, vwap1sdHi, vwap1sdLo, extended1SD);

  return {
    id: `muz_${Date.now().toString(36)}`,
    grade,
    direction,
    gravityScore: adjustedGravity,
    hardRule,
    coachingNote,
    price, vwap, vwap1sdHi, vwap1sdLo,
    ...levels,
    htfBiasPass: bias !== 'NEUTRAL',
    dealingRangePass: validZone,
    killzonePass: killzoneActive,
    sweepPass: sweepDone,
    mssPass: mssPresent && mssAligned,
    fvgPass: fvgAligned,
    vwapPass: vwapAligned,
    extended1SD,
    primaryPassing,
    delta, cvd, buyVolume, sellVolume,
    absorptionBull: absBull,
    absorptionBear: absBear,
    deltaFlip,
    threeBarPlay,
    killzone: tv.killzone || '',
    wreckingBall: wreckingBall ? 1 : 0,
    activeSession,
    createdAt: Date.now(),
  };
}

function computeLevels(price: number, isLong: boolean, vwap: number, vwap1sdHi: number, vwap1sdLo: number, extended1SD: boolean) {
  let entryZoneLow: number;
  let entryZoneHigh: number;
  if (extended1SD && vwap > 0) {
    if (isLong) { entryZoneHigh = vwap1sdLo + 2; entryZoneLow = vwap1sdLo - 8; }
    else { entryZoneLow = vwap1sdHi - 2; entryZoneHigh = vwap1sdHi + 8; }
  } else {
    entryZoneLow = isLong ? price - 8 : price;
    entryZoneHigh = isLong ? price : price + 8;
  }
  const suggestedEntry = (entryZoneLow + entryZoneHigh) / 2;
  const suggestedSL = isLong ? entryZoneLow - 20 : entryZoneHigh + 20;
  const slDist = Math.abs(suggestedEntry - suggestedSL);
  const suggestedTP1 = isLong ? suggestedEntry + slDist * 1.5 : suggestedEntry - slDist * 1.5;
  const suggestedTP2 = isLong ? suggestedEntry + slDist * 3.5 : suggestedEntry - slDist * 3.5;
  const r = (n: number) => Math.round(n * 4) / 4;
  return { entryZoneLow: r(entryZoneLow), entryZoneHigh: r(entryZoneHigh), suggestedEntry: r(suggestedEntry), suggestedSL: r(suggestedSL), suggestedTP1: r(suggestedTP1), suggestedTP2: r(suggestedTP2) };
}

export function getWeights(): FeatureWeight[] {
  const rows = db.prepare(`SELECT feature, wins, total, win_rate as winRate, weight, last_updated as lastUpdated FROM feature_weights ORDER BY win_rate DESC`).all() as any[];
  return rows.map(r => ({ feature: r.feature, wins: r.wins, total: r.total, winRate: r.winRate, weight: r.weight, lastUpdated: r.lastUpdated }));
}

export function getRecentLearningEntries(limit = 50): LearningEntry[] {
  const rows = db.prepare(`SELECT data FROM learning_entries ORDER BY recorded_at DESC LIMIT ?`).all(limit) as any[];
  return rows.map(r => JSON.parse(r.data));
}

export function getInsights(): object {
  const entries = getRecentLearningEntries(MAX_ENTRIES);
  const totalTrades = entries.length;
  const totalWins = entries.filter(e => e.result === 'TP1' || e.result === 'TP2' || e.pnlPoints > 0).length;
  const overallWinRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';
  const weights = getWeights().filter(w => w.total >= 5);
  const best = weights.slice(0, 3);
  const worst = [...weights].sort((a, b) => a.winRate - b.winRate).slice(0, 3);
  const byGrade: Record<string, { wins: number; total: number }> = {};
  const byGravity: Record<number, { wins: number; total: number }> = {};
  for (const e of entries) {
    if (!byGrade[e.grade]) byGrade[e.grade] = { wins: 0, total: 0 };
    byGrade[e.grade].total++;
    if (e.result === 'TP1' || e.result === 'TP2' || e.pnlPoints > 0) byGrade[e.grade].wins++;
    if (!byGravity[e.gravityScore]) byGravity[e.gravityScore] = { wins: 0, total: 0 };
    byGravity[e.gravityScore].total++;
    if (e.result === 'TP1' || e.result === 'TP2' || e.pnlPoints > 0) byGravity[e.gravityScore].wins++;
  }
  return {
    totalTrades,
    totalWins,
    overallWinRate: `${overallWinRate}%`,
    byGrade: Object.entries(byGrade).map(([grade, d]) => ({ grade, winRate: d.total ? `${((d.wins / d.total) * 100).toFixed(0)}%` : '—', wins: d.wins, total: d.total })),
    byGravity: Object.entries(byGravity).map(([g, d]) => ({ gravity: Number(g), winRate: d.total ? `${((d.wins / d.total) * 100).toFixed(0)}%` : '—', wins: d.wins, total: d.total })).sort((a, b) => a.gravity - b.gravity),
    bestFeatures: best.map(w => ({ feature: w.feature, winRate: `${w.winRate.toFixed(0)}%`, trades: w.total })),
    worstFeatures: worst.map(w => ({ feature: w.feature, winRate: `${w.winRate.toFixed(0)}%`, trades: w.total })),
    recentTrades: entries.slice(0, 10).map(e => ({ date: e.tradeDate, grade: e.grade, direction: e.direction, result: e.result, pnlPts: e.pnlPoints })),
    lastUpdated: new Date().toISOString(),
  };
}
