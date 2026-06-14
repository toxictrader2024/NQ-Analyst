/**
 * learningEngine.ts — v3 REAL FEEDBACK LOOP
 * Claude Audit — Jun 14 2026
 *
 * WHAT'S NEW vs Perplexity's version:
 *
 *   LEARN-001  recordTrade() now called automatically by MuzziBot after every
 *              close via POST /api/learning-kernel/feed. Before this, the
 *              storage existed but received zero data — nothing was wired up.
 *
 *   LEARN-002  Per-session win rates now computed from actual closed trades.
 *              After every recordTrade(), session stats are recomputed and
 *              stored in the feature_weights table under session_* keys.
 *
 *   LEARN-003  GET /api/learning-kernel/thresholds returns adaptive minimum
 *              confidence per session. MuzziBot reads this on startup and after
 *              every trade, and applies it before executing Railway signals.
 *              A session with < 40% win rate gets +1 required confidence.
 *              A session with < 30% win rate gets +2 required confidence.
 *              A session with > 65% win rate gets -1 required confidence (floor 4).
 *              Minimum data: 5 closed trades before thresholds change.
 *
 *   LEARN-004  Confidence score from ICT signal is now stored and used as a
 *              feature in win rate tracking. Signals with conf 8-10 vs 5-6
 *              are tracked separately so the system learns whether high-conf
 *              signals actually perform better in practice.
 */

import { getDb } from './db';

export interface LearningEntry {
  signalId:        string;
  grade:           string;
  direction:       string;
  gravityScore:    number;
  primaryPassing:  number;
  confidence:      number;   // ICT signal confidence score (1-10)
  deltaFlip:       boolean;
  threeBarPlay:    boolean;
  extended1SD:     boolean;
  absorptionConf:  boolean;
  trailWasActive:  boolean;
  halfExited:      boolean;
  killzone:        string;
  entryPrice:      number;
  slPrice:         number;
  tp1Price:        number;
  tp2Price:        number;
  exitPrice:       number;
  pnlPoints:       number;
  pnlDollars:      number;
  result:          string;
  exitReason:      string;
  reason:          string;
  tradeDate:       string;
  entryTime:       string;
  exitTime:        string;
  recordedAt:      number;
}

export interface FeatureWeight {
  feature:     string;
  wins:        number;
  total:       number;
  winRate:     number;
  weight:      number;
  lastUpdated: number;
}

// Adaptive threshold config
// These are the rules that turn win rate data into confidence requirements
const BASE_MIN_CONF    = 5;   // default minimum confidence (matches ICT signal MinConf)
const THRESHOLD_LOW    = 30;  // win rate % below this → +2 conf required
const THRESHOLD_MED    = 40;  // win rate % below this → +1 conf required
const THRESHOLD_HIGH   = 65;  // win rate % above this → -1 conf required (floor 4)
const MIN_TRADES_TO_ADJUST = 5; // don't adjust until we have at least 5 trades per session

const db = getDb();
const EMA_ALPHA  = 0.15;
const MAX_ENTRIES = 500;

// ─────────────────────────────────────────────────────────────────────────────
// DB Setup
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS learning_entries (
    signal_id   TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    result      TEXT,
    pnl_points  REAL,
    confidence  INTEGER DEFAULT 0,
    killzone    TEXT DEFAULT '',
    direction   TEXT DEFAULT '',
    recorded_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS feature_weights (
    feature      TEXT PRIMARY KEY,
    wins         INTEGER NOT NULL DEFAULT 0,
    total        INTEGER NOT NULL DEFAULT 0,
    win_rate     REAL NOT NULL DEFAULT 0,
    weight       REAL NOT NULL DEFAULT 1,
    last_updated INTEGER NOT NULL
  );
`);

// Add columns that may not exist on older DBs
['confidence INTEGER DEFAULT 0', 'killzone TEXT DEFAULT \'\'', 'direction TEXT DEFAULT \'\''].forEach(col => {
  try { db.exec(`ALTER TABLE learning_entries ADD COLUMN ${col}`); } catch (_) {}
});

const DEFAULT_FEATURES = [
  'grade_Aplus', 'grade_A', 'grade_B',
  'conf_high', 'conf_mid', 'conf_low',          // LEARN-004: track confidence tiers
  'gravity_1', 'gravity_2', 'gravity_3', 'gravity_4plus',
  'delta_flip', 'three_bar_play', 'extended_1sd', 'absorption_conf',
  'trail_active', 'half_exited',
  'killzone_london', 'killzone_ny_open', 'killzone_london_close',
  'killzone_ny_afternoon', 'killzone_asia',
  // LEARN-002: per-session win rate tracking
  'session_london', 'session_ny_open', 'session_london_close',
  'session_ny_afternoon', 'session_default',
  'primary_6of6', 'primary_5of6', 'primary_4of6',
  'direction_long', 'direction_short',
];

const ensureStmt = db.prepare(
  `INSERT OR IGNORE INTO feature_weights (feature, wins, total, win_rate, weight, last_updated) VALUES (?,0,0,0,1,?)`
);
const now0 = Date.now();
for (const f of DEFAULT_FEATURES) ensureStmt.run(f, now0);

// ─────────────────────────────────────────────────────────────────────────────
// Normalize incoming trade entry
// ─────────────────────────────────────────────────────────────────────────────
function normalizeEntry(entry: any): Omit<LearningEntry, 'recordedAt'> {
  const conf = Number(entry.confidence ?? entry.conf ?? 0);
  return {
    signalId:       String(entry.signalId ?? entry.id ?? ''),
    grade:          String(entry.grade ?? (conf >= 8 ? 'A+' : conf >= 6 ? 'A' : conf >= 5 ? 'B' : 'C')),
    direction:      String(entry.direction ?? '').toUpperCase(),
    gravityScore:   Number(entry.gravityScore ?? 0),
    primaryPassing: Number(entry.primaryPassing ?? conf),
    confidence:     conf,
    deltaFlip:      Boolean(entry.deltaFlip),
    threeBarPlay:   Boolean(entry.threeBarPlay),
    extended1SD:    Boolean(entry.extended1SD),
    absorptionConf: Boolean(entry.absorptionConf),
    trailWasActive: Boolean(entry.trailWasActive),
    halfExited:     Boolean(entry.halfExited),
    killzone:       String(entry.killzone ?? entry.session ?? ''),
    entryPrice:     Number(entry.entryPrice ?? entry.entry ?? 0),
    slPrice:        Number(entry.slPrice ?? entry.sl ?? 0),
    tp1Price:       Number(entry.tp1Price ?? entry.tp1 ?? 0),
    tp2Price:       Number(entry.tp2Price ?? entry.tp2 ?? 0),
    exitPrice:      Number(entry.exitPrice ?? 0),
    pnlPoints:      Number(entry.pnlPoints ?? entry.pnlPts ?? 0),
    pnlDollars:     Number(entry.pnlDollars ?? ((entry.pnlPoints ?? entry.pnlPts ?? 0) * 8)),
    result:         String(entry.result ?? entry.outcome ?? 'UNKNOWN'),
    exitReason:     String(entry.exitReason ?? entry.result ?? ''),
    reason:         String(entry.reason ?? ''),
    tradeDate:      String(entry.tradeDate ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })),
    entryTime:      String(entry.entryTime ?? ''),
    exitTime:       String(entry.exitTime ?? new Date().toISOString()),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Active features for a trade entry
// ─────────────────────────────────────────────────────────────────────────────
function activeFeatures(e: Omit<LearningEntry, 'recordedAt'>): string[] {
  const out: string[] = [];

  if (e.grade === 'A+') out.push('grade_Aplus');
  else if (e.grade === 'A') out.push('grade_A');
  else if (e.grade === 'B') out.push('grade_B');

  // LEARN-004: confidence tier tracking
  if (e.confidence >= 8) out.push('conf_high');
  else if (e.confidence >= 6) out.push('conf_mid');
  else out.push('conf_low');

  const g = e.gravityScore;
  if (g >= 4) out.push('gravity_4plus');
  else if (g === 3) out.push('gravity_3');
  else if (g === 2) out.push('gravity_2');
  else out.push('gravity_1');

  if (e.direction === 'LONG')  out.push('direction_long');
  if (e.direction === 'SHORT') out.push('direction_short');
  if (e.deltaFlip)      out.push('delta_flip');
  if (e.threeBarPlay)   out.push('three_bar_play');
  if (e.extended1SD)    out.push('extended_1sd');
  if (e.absorptionConf) out.push('absorption_conf');
  if (e.trailWasActive) out.push('trail_active');
  if (e.halfExited)     out.push('half_exited');

  const kz = (e.killzone || '').toLowerCase();
  if (kz.includes('london') && kz.includes('close')) {
    out.push('killzone_london_close');
    out.push('session_london_close'); // LEARN-002
  } else if (kz.includes('london')) {
    out.push('killzone_london');
    out.push('session_london');
  } else if (kz.includes('ny_afternoon') || kz.includes('afternoon')) {
    out.push('killzone_ny_afternoon');
    out.push('session_ny_afternoon');
  } else if (kz.includes('ny') || kz.includes('new_york')) {
    out.push('killzone_ny_open');
    out.push('session_ny_open');
  } else if (kz.includes('asia')) {
    out.push('killzone_asia');
    out.push('session_default');
  } else {
    out.push('session_default');
  }

  const p = e.primaryPassing;
  if (p >= 6) out.push('primary_6of6');
  else if (p >= 5) out.push('primary_5of6');
  else if (p >= 4) out.push('primary_4of6');

  return [...new Set(out)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Update a single feature weight with EMA smoothing
// ─────────────────────────────────────────────────────────────────────────────
function updateWeight(feature: string, isWin: boolean) {
  db.prepare(
    `INSERT OR IGNORE INTO feature_weights (feature, wins, total, win_rate, weight, last_updated) VALUES (?,0,0,0,1,?)`
  ).run(feature, Date.now());

  const w = db.prepare(`SELECT * FROM feature_weights WHERE feature=?`).get(feature) as any;
  const wins  = Number(w.wins) + (isWin ? 1 : 0);
  const total = Number(w.total) + 1;
  const rawWR = (wins / total) * 100;
  const prevWR = Number(w.win_rate ?? 0);
  const winRate = total === 1 ? rawWR : EMA_ALPHA * rawWR + (1 - EMA_ALPHA) * prevWR;

  let weight = 1.0;
  if (total >= 5) {
    if (winRate >= 80)      weight = 2.0;
    else if (winRate >= 70) weight = 1.5;
    else if (winRate >= 60) weight = 1.2;
    else if (winRate >= 50) weight = 1.0;
    else if (winRate >= 40) weight = 0.8;
    else                    weight = 0.6;
  }

  db.prepare(
    `UPDATE feature_weights SET wins=?, total=?, win_rate=?, weight=?, last_updated=? WHERE feature=?`
  ).run(wins, total, winRate, weight, Date.now(), feature);
}

// ─────────────────────────────────────────────────────────────────────────────
// LEARN-003: Compute adaptive threshold for a session
// ─────────────────────────────────────────────────────────────────────────────
function computeThresholdForSession(sessionFeature: string): number {
  const row = db.prepare(
    `SELECT wins, total, win_rate FROM feature_weights WHERE feature=?`
  ).get(sessionFeature) as any;

  if (!row || row.total < MIN_TRADES_TO_ADJUST) {
    // Not enough data — use base threshold
    return BASE_MIN_CONF;
  }

  const winRate = Number(row.win_rate);
  if (winRate < THRESHOLD_LOW)  return BASE_MIN_CONF + 2;  // poor session → require high conf
  if (winRate < THRESHOLD_MED)  return BASE_MIN_CONF + 1;  // below average → require more conf
  if (winRate >= THRESHOLD_HIGH) return Math.max(4, BASE_MIN_CONF - 1); // strong session → relax
  return BASE_MIN_CONF;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: recordTrade — called by /api/learning-kernel/feed after MuzziBot close
// ─────────────────────────────────────────────────────────────────────────────
export function recordTrade(rawEntry: any): void {
  const entry = normalizeEntry(rawEntry);
  if (!entry.signalId) throw new Error('Missing signalId');

  const existing = db.prepare(`SELECT signal_id FROM learning_entries WHERE signal_id=?`).get(entry.signalId);
  if (existing) {
    console.log(`[LearningEngine] Trade ${entry.signalId} already recorded — skipping duplicate`);
    return;
  }

  const full: LearningEntry = { ...entry, recordedAt: Date.now() };
  const isWin = full.result === 'TP1' || full.result === 'TP2' || full.pnlPoints > 0;

  db.prepare(
    `INSERT INTO learning_entries (signal_id, data, result, pnl_points, confidence, killzone, direction, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    full.signalId, JSON.stringify(full), full.result,
    full.pnlPoints, full.confidence, full.killzone,
    full.direction, full.recordedAt
  );

  // Update all active features
  for (const f of activeFeatures(entry)) updateWeight(f, isWin);

  // Trim to MAX_ENTRIES
  db.prepare(
    `DELETE FROM learning_entries WHERE signal_id NOT IN (SELECT signal_id FROM learning_entries ORDER BY recorded_at DESC LIMIT ?)`
  ).run(MAX_ENTRIES);

  // Log with computed thresholds so we can see learning in action
  const sessionFeature = `session_${entry.killzone.replace(/[\s-]/g, '_').toLowerCase() || 'default'}`;
  const newThreshold = computeThresholdForSession(sessionFeature);

  console.log(
    `[LearningEngine] ✅ Recorded: ${full.result} | ${full.direction} @ ${full.exitPrice} | ` +
    `${full.pnlPoints > 0 ? '+' : ''}${full.pnlPoints}pts | ` +
    `sess=${full.killzone} conf=${full.confidence} | ` +
    `→ session threshold now: ${newThreshold}/10`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: getThresholds — called by GET /api/learning-kernel/thresholds
// Returns adaptive minimum confidence per session based on historical win rates
// ─────────────────────────────────────────────────────────────────────────────
export function getThresholds(): {
  default:       number;
  london:        number;
  ny_open:       number;
  london_close:  number;
  ny_afternoon:  number;
  _meta: {
    london_winRate:       number;
    ny_open_winRate:      number;
    london_close_winRate: number;
    ny_afternoon_winRate: number;
    london_trades:        number;
    ny_open_trades:       number;
    london_close_trades:  number;
    ny_afternoon_trades:  number;
  };
} {
  const getWR = (feature: string) => {
    const r = db.prepare(`SELECT win_rate, total FROM feature_weights WHERE feature=?`).get(feature) as any;
    return { winRate: r ? Number(r.win_rate) : 0, total: r ? Number(r.total) : 0 };
  };

  const lon   = getWR('session_london');
  const ny    = getWR('session_ny_open');
  const lc    = getWR('session_london_close');
  const nyaft = getWR('session_ny_afternoon');

  return {
    default:      computeThresholdForSession('session_default'),
    london:       computeThresholdForSession('session_london'),
    ny_open:      computeThresholdForSession('session_ny_open'),
    london_close: computeThresholdForSession('session_london_close'),
    ny_afternoon: computeThresholdForSession('session_ny_afternoon'),
    _meta: {
      london_winRate:       Math.round(lon.winRate),
      ny_open_winRate:      Math.round(ny.winRate),
      london_close_winRate: Math.round(lc.winRate),
      ny_afternoon_winRate: Math.round(nyaft.winRate),
      london_trades:        lon.total,
      ny_open_trades:       ny.total,
      london_close_trades:  lc.total,
      ny_afternoon_trades:  nyaft.total,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: getWeights, getInsights, getRecentLearningEntries (unchanged interface)
// ─────────────────────────────────────────────────────────────────────────────
export function getWeights(): FeatureWeight[] {
  const rows = db.prepare(
    `SELECT feature, wins, total, win_rate as winRate, weight, last_updated as lastUpdated FROM feature_weights ORDER BY win_rate DESC`
  ).all() as any[];
  return rows.map(r => ({ feature: r.feature, wins: r.wins, total: r.total, winRate: r.winRate, weight: r.weight, lastUpdated: r.lastUpdated }));
}

export function getRecentLearningEntries(limit = 50): LearningEntry[] {
  const rows = db.prepare(`SELECT data FROM learning_entries ORDER BY recorded_at DESC LIMIT ?`).all(limit) as any[];
  return rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
}

export function getInsights(): object {
  const entries = getRecentLearningEntries(MAX_ENTRIES);
  const totalTrades = entries.length;
  const totalWins   = entries.filter(e => e.result === 'TP1' || e.result === 'TP2' || e.pnlPoints > 0).length;
  const weights     = getWeights().filter(w => w.total >= 5);

  const bySession: Record<string, { wins: number; total: number; avgConf: number }> = {};
  const byConfTier: Record<string, { wins: number; total: number }> = {};

  for (const e of entries) {
    const sess = e.killzone || 'unknown';
    if (!bySession[sess]) bySession[sess] = { wins: 0, total: 0, avgConf: 0 };
    bySession[sess].total++;
    bySession[sess].avgConf += (e.confidence ?? 0);
    if (e.result === 'TP1' || e.result === 'TP2' || e.pnlPoints > 0) bySession[sess].wins++;

    const tier = (e.confidence ?? 0) >= 8 ? 'high(8-10)' : (e.confidence ?? 0) >= 6 ? 'mid(6-7)' : 'low(4-5)';
    if (!byConfTier[tier]) byConfTier[tier] = { wins: 0, total: 0 };
    byConfTier[tier].total++;
    if (e.result === 'TP1' || e.result === 'TP2' || e.pnlPoints > 0) byConfTier[tier].wins++;
  }

  const thresholds = getThresholds();

  return {
    totalTrades,
    totalWins,
    overallWinRate: totalTrades ? `${((totalWins / totalTrades) * 100).toFixed(1)}%` : '0.0%',
    // LEARN-003: show adaptive thresholds with their data basis
    adaptiveThresholds: thresholds,
    bySession: Object.entries(bySession).map(([sess, d]) => ({
      session:    sess,
      winRate:    d.total ? `${((d.wins / d.total) * 100).toFixed(0)}%` : '—',
      wins:       d.wins,
      total:      d.total,
      avgConf:    d.total ? (d.avgConf / d.total).toFixed(1) : '—',
      minConfReq: (thresholds as any)[sess] ?? thresholds.default,
    })),
    // LEARN-004: show confidence tier win rates
    byConfidenceTier: Object.entries(byConfTier).map(([tier, d]) => ({
      tier,
      winRate: d.total ? `${((d.wins / d.total) * 100).toFixed(0)}%` : '—',
      wins:    d.wins,
      total:   d.total,
    })),
    bestFeatures:  weights.slice(0, 5).map(w => ({ feature: w.feature, winRate: `${w.winRate.toFixed(0)}%`, trades: w.total })),
    worstFeatures: [...weights].sort((a, b) => a.winRate - b.winRate).slice(0, 5).map(w => ({ feature: w.feature, winRate: `${w.winRate.toFixed(0)}%`, trades: w.total })),
    recentTrades: entries.slice(0, 10).map(e => ({
      date: e.tradeDate, direction: e.direction, session: e.killzone,
      result: e.result, conf: e.confidence, pnlPts: e.pnlPoints,
    })),
    lastUpdated: new Date().toISOString(),
  };
}

// Keep buildMuzziSignal export for routes.ts compatibility
export { buildMuzziSignal } from './learningKernel';
