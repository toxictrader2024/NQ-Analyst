/**
 * learningKernel.ts
 *
 * Tracks every completed Muzzi trade result and learns which checklist
 * configurations actually produce winning trades. Adjusts weights over
 * time using a simple exponential moving average (EMA) on win-rate per
 * feature bucket.
 *
 * Data is stored in-memory (max 500 entries) plus persisted to a JSON
 * file in /tmp/learning_kernel.json so it survives server restarts.
 *
 * The kernel exports:
 *   - recordTrade(entry)     — called by /api/learning-kernel/feed
 *   - getInsights()          — called by /api/learning-kernel/insights
 *   - getWeights()           — returns current feature weights for the dashboard
 *   - getMuzziLevels(data)   — computes entry/SL/TP levels from merged market data
 *   - buildMuzziSignal(data) — server-side Muzzi evaluation (mirrors MuzziAnalyzer.tsx)
 */

import fs   from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface LearningEntry {
  signalId       : string;
  grade          : string;       // "A+" | "A" | "B"
  direction      : string;       // "LONG" | "SHORT"
  gravityScore   : number;       // 0–5
  primaryPassing : number;       // 0–6 checklist items passing
  deltaFlip      : boolean;
  threeBarPlay   : boolean;
  extended1SD    : boolean;
  absorptionConf : boolean;
  killzone       : string;
  entryPrice     : number;
  slPrice        : number;
  tp1Price       : number;
  tp2Price       : number;
  exitPrice      : number;
  pnlPoints      : number;
  pnlDollars     : number;
  result         : string;       // "TP2" | "TP1" | "STOPPED" | "EXPIRED"
  exitReason     : string;
  scDelta        : number;
  scCvd          : number;
  scBuyVol       : number;
  scSellVol      : number;
  tradeDate      : string;
  entryTime      : string;
  exitTime       : string;
  recordedAt     : number;       // Date.now()
}

export interface FeatureWeight {
  feature        : string;
  wins           : number;
  total          : number;
  winRate        : number;       // 0–100
  weight         : number;       // 0.5–2.0, EMA-adjusted, used by muzzi-signal scorer
  lastUpdated    : number;
}

interface KernelState {
  entries        : LearningEntry[];
  weights        : Record<string, FeatureWeight>;
  totalTrades    : number;
  totalWins      : number;
  lastUpdated    : number;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

const PERSIST_PATH = "/tmp/learning_kernel.json";
const MAX_ENTRIES  = 500;
const EMA_ALPHA    = 0.15;  // how fast weights update (0 = ignore new data, 1 = forget old)

function loadState(): KernelState {
  try {
    if (fs.existsSync(PERSIST_PATH)) {
      const raw = fs.readFileSync(PERSIST_PATH, "utf-8");
      return JSON.parse(raw) as KernelState;
    }
  } catch (e) {
    console.warn("[LearningKernel] Could not load persisted state:", e);
  }
  return {
    entries    : [],
    weights    : buildDefaultWeights(),
    totalTrades: 0,
    totalWins  : 0,
    lastUpdated: Date.now(),
  };
}

function saveState(state: KernelState): void {
  try {
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    console.warn("[LearningKernel] Could not persist state:", e);
  }
}

function buildDefaultWeights(): Record<string, FeatureWeight> {
  const features = [
    "grade_Aplus",       // grade = A+
    "grade_A",           // grade = A
    "grade_B",
    "gravity_1",
    "gravity_2",
    "gravity_3",
    "gravity_4plus",
    "delta_flip",        // checklist item 9
    "three_bar_play",    // checklist item 8
    "extended_1sd",      // price beyond VWAP ±1SD
    "absorption_conf",   // SC absorption at zone
    "killzone_london",
    "killzone_ny_open",
    "killzone_ny_close",
    "primary_6of6",      // all 6 primary items passing
    "primary_5of6",
    "primary_4of6",
  ];

  const defaults: Record<string, FeatureWeight> = {};
  for (const f of features) {
    defaults[f] = {
      feature    : f,
      wins       : 0,
      total      : 0,
      winRate    : 0,
      weight     : 1.0,   // neutral until we have data
      lastUpdated: Date.now(),
    };
  }
  return defaults;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

let state: KernelState = loadState();

// ─────────────────────────────────────────────────────────────────────────────
// RECORD A TRADE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accepts a completed trade result from the NinjaTrader bot and updates
 * feature win-rates and weights using EMA.
 */
export function recordTrade(entry: Omit<LearningEntry, "recordedAt">): void {
  const full: LearningEntry = { ...entry, recordedAt: Date.now() };

  // Store entry (cap at MAX_ENTRIES, newest first)
  state.entries.unshift(full);
  if (state.entries.length > MAX_ENTRIES) state.entries.splice(MAX_ENTRIES);

  const isWin = entry.result === "TP1" || entry.result === "TP2";

  state.totalTrades++;
  if (isWin) state.totalWins++;

  // ── Map entry to feature keys ────────────────────────────────────────────
  const activeFeatures: string[] = [];

  // Grade
  if (entry.grade === "A+") activeFeatures.push("grade_Aplus");
  else if (entry.grade === "A") activeFeatures.push("grade_A");
  else if (entry.grade === "B") activeFeatures.push("grade_B");

  // Gravity
  const g = entry.gravityScore;
  if      (g >= 4) activeFeatures.push("gravity_4plus");
  else if (g === 3) activeFeatures.push("gravity_3");
  else if (g === 2) activeFeatures.push("gravity_2");
  else              activeFeatures.push("gravity_1");

  // SC confirmations
  if (entry.deltaFlip)      activeFeatures.push("delta_flip");
  if (entry.threeBarPlay)   activeFeatures.push("three_bar_play");
  if (entry.extended1SD)    activeFeatures.push("extended_1sd");
  if (entry.absorptionConf) activeFeatures.push("absorption_conf");

  // Kill zone
  if (entry.killzone?.includes("london")) activeFeatures.push("killzone_london");
  else if (entry.killzone?.includes("ny_open"))  activeFeatures.push("killzone_ny_open");
  else if (entry.killzone?.includes("ny_close")) activeFeatures.push("killzone_ny_close");

  // Primary passing count
  const pp = entry.primaryPassing;
  if      (pp >= 6) activeFeatures.push("primary_6of6");
  else if (pp >= 5) activeFeatures.push("primary_5of6");
  else if (pp >= 4) activeFeatures.push("primary_4of6");

  // ── Update weights for all active features (EMA) ──────────────────────────
  for (const feat of activeFeatures) {
    if (!state.weights[feat]) {
      state.weights[feat] = {
        feature    : feat,
        wins       : 0,
        total      : 0,
        winRate    : 0,
        weight     : 1.0,
        lastUpdated: Date.now(),
      };
    }
    const w = state.weights[feat];
    w.total++;
    if (isWin) w.wins++;

    // Raw win rate
    const rawWinRate = (w.wins / w.total) * 100;

    // EMA smoothed win rate (prevents overfitting on small samples)
    w.winRate = w.total === 1
      ? rawWinRate
      : EMA_ALPHA * rawWinRate + (1 - EMA_ALPHA) * w.winRate;

    // Convert win rate to weight multiplier:
    //   >70% win rate → weight 1.5–2.0 (boost entries with this feature)
    //   50–70%        → weight 1.0–1.5 (neutral to slight boost)
    //   <50%          → weight 0.5–1.0 (penalize)
    //   Require >= 5 trades before non-neutral weights apply
    if (w.total >= 5) {
      if      (w.winRate >= 80) w.weight = 2.0;
      else if (w.winRate >= 70) w.weight = 1.5;
      else if (w.winRate >= 60) w.weight = 1.2;
      else if (w.winRate >= 50) w.weight = 1.0;
      else if (w.winRate >= 40) w.weight = 0.8;
      else                      w.weight = 0.6;
    }
    w.lastUpdated = Date.now();
  }

  state.lastUpdated = Date.now();
  saveState(state);

  console.log(`[LearningKernel] Recorded ${entry.result} | ${entry.grade} G${entry.gravityScore} | ${entry.pnlPoints}pts | WinRate: ${((state.totalWins / state.totalTrades) * 100).toFixed(1)}%`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER-SIDE MUZZI EVALUATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors the MuzziAnalyzer.tsx evaluateMuzziChecklist() logic server-side.
 * Merges TradingView ICT fields with Sierra Chart order flow fields.
 * Used by /api/muzzi-signal to serve the NinjaTrader bot.
 */
export function buildMuzziSignal(mergedData: any): any {
  const tv = mergedData.tv || {};   // TradingView ICT fields
  const sc = mergedData.sc || {};   // Sierra Chart order flow fields
  const price = tv.close || sc.close || 0;

  if (!price) return null;

  // Timeframe cascade: 15m = bias, 5m = setup, 1m = trigger
  // tv object can contain sub-timeframe fields prefixed tf15_, tf5_, tf1_
  // OR the caller can pass tv15/tv5/tv1 as separate objects
  const tv15 = mergedData.tv15 || (String(tv.timeframe) === "15" ? tv : null);
  const tv5  = mergedData.tv5  || (String(tv.timeframe) === "5"  ? tv : null);
  const tv1  = mergedData.tv1  || (String(tv.timeframe) === "1"  ? tv : null);

  // Bias from 15m (session direction) — fall back to server-computed bias
  const bias15 = tv15
    ? (tv15.market_structure || tv15.marketStructure || "").includes("bull")
      ? "BULLISH"
      : (tv15.market_structure || tv15.marketStructure || "").includes("bear")
      ? "BEARISH"
      : "NEUTRAL"
    : "NEUTRAL";

  const bias = bias15 !== "NEUTRAL" ? bias15 : (mergedData.bias || "NEUTRAL");
  const isLong  = bias === "BULLISH";
  const isShort = bias === "BEARISH";

  // Setup source: prefer 5m for FVG/OB/MSS structure
  const setupSrc = tv5 || tv || {};
  // Trigger source: 1m for delta flip / 3-bar play confirmation
  const triggerSrc = tv1 || sc || {};

  // ── Session VWAP (use active session VWAP) ────────────────────────────────
  const activeSession = tv.active_session || tv.activeSession || "RTH";
  const vwap = activeSession === "RTH"
    ? (tv.vwap_rth   || tv.vwapRth    || tv.vwap || 0)
    : activeSession === "London"
    ? (tv.vwap_london || tv.vwapLondon || tv.vwap || 0)
    : (tv.vwap_asia   || tv.vwapAsia   || tv.vwap || 0);

  const vwap1sdHi = tv.vwap_1sd_hi || tv.vwap1sdHi || 0;
  const vwap1sdLo = tv.vwap_1sd_lo || tv.vwap1sdLo || 0;

  // ── Checklist items (mirrors MuzziAnalyzer.tsx) ───────────────────────────
  const killzoneActive = !!(setupSrc.killzone && setupSrc.killzone !== "" && setupSrc.killzone !== "off_session") ||
                         !!(tv.killzone     && tv.killzone    !== "" && tv.killzone    !== "off_session");
  const inDiscount     = !!(tv.discount || tv.premium === 0);
  const inPremium      = !!(tv.premium  || tv.discount === 0);
  const validZone      = isLong ? inDiscount : isShort ? inPremium : false;
  const sweepDone      = !!(tv15?.sweep_high || tv15?.sweepHigh || tv15?.sweep_low || tv15?.sweepLow ||
                            tv.sweep_high  || tv.sweepHigh  || tv.sweep_low  || tv.sweepLow);
  const mssPresent     = !!(setupSrc.market_structure || setupSrc.marketStructure || tv.market_structure || tv.marketStructure);
  const mssBull        = (setupSrc.market_structure || setupSrc.marketStructure || tv.market_structure || tv.marketStructure || "").includes("bull");
  const mssBear        = (setupSrc.market_structure || setupSrc.marketStructure || tv.market_structure || tv.marketStructure || "").includes("bear");
  const mssAligned     = isLong ? mssBull : isShort ? mssBear : false;
  const fvgBull        = !!(setupSrc.fvg_bull || setupSrc.fvgBull || tv.fvg_bull || tv.fvgBull);
  const fvgBear        = !!(setupSrc.fvg_bear || setupSrc.fvgBear || tv.fvg_bear || tv.fvgBear);
  const fvgAligned     = isLong ? fvgBull : isShort ? fvgBear : false;
  const priceAboveVwap = vwap > 0 && price > vwap;
  const priceBelowVwap = vwap > 0 && price < vwap;
  const vwapAligned    = isLong ? priceBelowVwap : isShort ? priceAboveVwap : false;
  const extended1SD    = vwap1sdHi > 0 && (
    (isLong  && price <= vwap1sdLo) ||
    (isShort && price >= vwap1sdHi)
  );
  const wreckingBall   = !!(tv.wrecking_ball || tv.wreckingBall);

  // ── SC order flow fields ──────────────────────────────────────────────────
  const delta        = sc.delta       || 0;
  const cvd          = sc.cvd         || 0;
  const buyVolume    = sc.buy_volume  || sc.buyVolume  || 0;
  const sellVolume   = sc.sell_volume || sc.sellVolume || 0;
  const absBull      = !!(sc.absorption_bull || sc.absorptionBull);
  const absBear      = !!(sc.absorption_bear || sc.absorptionBear);
  const prevDelta    = sc.prev_delta  || sc.prevDelta  || 0;
  // Delta flip: delta changed sign or crossed zero vs prior bar
  const deltaFlip    = prevDelta !== 0 && (
    (prevDelta < 0 && delta > 0) ||
    (prevDelta > 0 && delta < 0)
  );
  // Three-bar play: 3 consecutive bars of exhausting delta in one direction
  const threeBarPlay = !!(sc.three_bar_play || sc.threeBarPlay);

  // ── Primary checklist pass count ──────────────────────────────────────────
  const checks = [
    bias !== "NEUTRAL",      // item 1: 15m bias confirmed
    validZone,               // item 2: dealing range
    killzoneActive,          // item 3: kill zone
    sweepDone,               // item 4: manipulation sweep
    mssPresent && mssAligned,// item 5: 5m MSS/CHOCH setup
    fvgAligned,              // item 6: FVG/OB confluence
  ];
  const primaryPassing = checks.filter(Boolean).length;

  // ── Institutional Gravity ──────────────────────────────────────────────────
  let gravity = 0;
  if (validZone)   gravity++;
  if (fvgAligned)  gravity++;
  if (extended1SD) gravity++;     // being beyond ±1SD = extra gravity
  if (deltaFlip)   gravity++;     // delta flip = order flow gravity layer
  if (absBull && isLong) gravity++;
  if (absBear && isShort) gravity++;

  // ── Grade ─────────────────────────────────────────────────────────────────
  let grade    = "WAIT";
  let direction = bias === "BULLISH" ? "LONG" : bias === "BEARISH" ? "SHORT" : "WAIT";
  let coachingNote = "";
  let hardRule: string | null = null;

  // Hard rule checks
  if (wreckingBall) {
    grade    = "HARD RULE VIOLATED";
    direction = "WAIT";
    hardRule  = "WRECKING BALL 09:30–09:35 NY — NO ENTRY";
  } else if (!validZone && bias !== "NEUTRAL") {
    grade    = "HARD RULE VIOLATED";
    direction = "WAIT";
    hardRule  = isLong
      ? "HARD RULE: Never long into Premium. Wait for Discount."
      : "HARD RULE: Never short into Discount. Wait for Premium.";
  } else if (primaryPassing >= 6 && gravity >= 3) {
    grade = "A+";
    coachingNote = "A+ setup — Institutional Gravity confirmed. Execute with conviction.";
  } else if (primaryPassing >= 5 || (primaryPassing >= 4 && gravity >= 2)) {
    grade = "A";
    coachingNote = "Strong A setup — wait for Delta Flip or Three-Bar Play confirmation.";
  } else if (primaryPassing >= 3) {
    grade = "B";
    coachingNote = "B setup — structure building. Let price come to your zone.";
  } else {
    direction    = "WAIT";
    coachingNote = `Only ${primaryPassing}/6 primary criteria met. No trade.`;
  }

  // ── Apply learning kernel weight adjustments to gravity ───────────────────
  // If the kernel has learned that certain features are high-probability,
  // allow them to nudge a borderline A → A+ (gravity boost only, not grade override)
  const gravityBoost = getLearnedGravityBoost({
    grade, deltaFlip, threeBarPlay, extended1SD,
    absorptionConf: isLong ? absBull : absBear,
    killzone: tv.killzone || "",
  });
  const adjustedGravity = Math.min(5, gravity + gravityBoost);

  // ── Compute trade levels ──────────────────────────────────────────────────
  const { entryZoneLow, entryZoneHigh, suggestedEntry, suggestedSL, suggestedTP1, suggestedTP2 }
    = computeLevels(price, isLong, vwap, vwap1sdHi, vwap1sdLo, extended1SD);

  // ── Build final signal ID ──────────────────────────────────────────────────
  const signalId = `muz_${Date.now().toString(36)}`;

  return {
    id            : signalId,
    grade,
    direction,
    gravityScore  : adjustedGravity,
    hardRule,
    coachingNote,

    // Levels
    price,
    vwap,
    vwap1sdHi,
    vwap1sdLo,
    entryZoneLow,
    entryZoneHigh,
    suggestedEntry,
    suggestedSL,
    suggestedTP1,
    suggestedTP2,

    // Checklist flags
    htfBiasPass   : bias !== "NEUTRAL",
    dealingRangePass: validZone,
    killzonePass  : killzoneActive,
    sweepPass     : sweepDone,
    mssPass       : mssPresent && mssAligned,
    fvgPass       : fvgAligned,
    vwapPass      : vwapAligned,
    extended1SD,
    primaryPassing,

    // SC order flow
    delta,
    cvd,
    buyVolume,
    sellVolume,
    absorptionBull: absBull,
    absorptionBear: absBear,
    deltaFlip,
    threeBarPlay,
    killzone      : tv.killzone || "",
    wreckingBall  : wreckingBall ? 1 : 0,
    activeSession,
    createdAt     : Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEVELS CALCULATOR
// ─────────────────────────────────────────────────────────────────────────────

function computeLevels(
  price: number,
  isLong: boolean,
  vwap: number,
  vwap1sdHi: number,
  vwap1sdLo: number,
  extended1SD: boolean,
) {
  // Entry zone: if extended from VWAP, use VWAP band as natural entry
  // Otherwise, use standard ICT OTE logic (price ±5 pts for zone width)
  let entryZoneLow: number, entryZoneHigh: number;

  if (extended1SD && vwap > 0) {
    // Enter at the ±1SD band — this is the max mean-reversion zone
    if (isLong) {
      entryZoneHigh = vwap1sdLo + 2;
      entryZoneLow  = vwap1sdLo - 8;
    } else {
      entryZoneLow  = vwap1sdHi - 2;
      entryZoneHigh = vwap1sdHi + 8;
    }
  } else {
    // Standard: enter within 5pts of current price (wait for rejection)
    entryZoneLow  = isLong ? price - 8  : price;
    entryZoneHigh = isLong ? price      : price + 8;
  }

  const suggestedEntry = (entryZoneLow + entryZoneHigh) / 2;

  // ICT-standard SL: 20pts beyond zone (not 50pts — tight, structure-based)
  const suggestedSL  = isLong
    ? entryZoneLow  - 20
    : entryZoneHigh + 20;

  // TP1 = 1.5R (30pts), TP2 = 3.5R (70pts)
  const slDist = Math.abs(suggestedEntry - suggestedSL);
  const suggestedTP1 = isLong
    ? suggestedEntry + (slDist * 1.5)
    : suggestedEntry - (slDist * 1.5);
  const suggestedTP2 = isLong
    ? suggestedEntry + (slDist * 3.5)
    : suggestedEntry - (slDist * 3.5);

  return {
    entryZoneLow : Math.round(entryZoneLow  * 4) / 4,
    entryZoneHigh: Math.round(entryZoneHigh * 4) / 4,
    suggestedEntry: Math.round(suggestedEntry * 4) / 4,
    suggestedSL  : Math.round(suggestedSL   * 4) / 4,
    suggestedTP1 : Math.round(suggestedTP1  * 4) / 4,
    suggestedTP2 : Math.round(suggestedTP2  * 4) / 4,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAVITY BOOST FROM LEARNING KERNEL
// ─────────────────────────────────────────────────────────────────────────────

function getLearnedGravityBoost(features: {
  grade: string;
  deltaFlip: boolean;
  threeBarPlay: boolean;
  extended1SD: boolean;
  absorptionConf: boolean;
  killzone: string;
}): number {
  let boost = 0;
  const MIN_TRADES = 5;

  const check = (key: string) => {
    const w = state.weights[key];
    if (!w || w.total < MIN_TRADES) return false;
    return w.weight >= 1.5; // only boost when kernel is confident
  };

  if (features.deltaFlip      && check("delta_flip"))      boost++;
  if (features.threeBarPlay   && check("three_bar_play"))  boost++;
  if (features.extended1SD    && check("extended_1sd"))    boost++;
  if (features.absorptionConf && check("absorption_conf")) boost++;

  return Math.min(2, boost); // cap at +2 gravity boost
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC GETTERS
// ─────────────────────────────────────────────────────────────────────────────

export function getWeights(): FeatureWeight[] {
  return Object.values(state.weights).sort((a, b) => b.winRate - a.winRate);
}

export function getInsights(): object {
  const totalTrades = state.totalTrades;
  const totalWins   = state.totalWins;
  const overallWinRate = totalTrades > 0
    ? ((totalWins / totalTrades) * 100).toFixed(1)
    : "0.0";

  // Best and worst performing features (min 5 trades)
  const qualified = Object.values(state.weights).filter(w => w.total >= 5);
  const sorted    = [...qualified].sort((a, b) => b.winRate - a.winRate);
  const best      = sorted.slice(0, 3);
  const worst     = sorted.slice(-3).reverse();

  // Last 10 trades summary
  const recent = state.entries.slice(0, 10).map(e => ({
    date     : e.tradeDate,
    grade    : e.grade,
    direction: e.direction,
    result   : e.result,
    pnlPts   : e.pnlPoints,
  }));

  // Win rate by grade
  const byGrade: Record<string, { wins: number; total: number }> = {};
  for (const e of state.entries) {
    if (!byGrade[e.grade]) byGrade[e.grade] = { wins: 0, total: 0 };
    byGrade[e.grade].total++;
    if (e.result === "TP1" || e.result === "TP2") byGrade[e.grade].wins++;
  }

  // Win rate by gravity score
  const byGravity: Record<number, { wins: number; total: number }> = {};
  for (const e of state.entries) {
    const g = e.gravityScore;
    if (!byGravity[g]) byGravity[g] = { wins: 0, total: 0 };
    byGravity[g].total++;
    if (e.result === "TP1" || e.result === "TP2") byGravity[g].wins++;
  }

  return {
    totalTrades,
    totalWins,
    overallWinRate: `${overallWinRate}%`,
    byGrade: Object.entries(byGrade).map(([grade, d]) => ({
      grade,
      winRate: d.total > 0 ? `${((d.wins / d.total) * 100).toFixed(0)}%` : "—",
      wins   : d.wins,
      total  : d.total,
    })),
    byGravity: Object.entries(byGravity).map(([g, d]) => ({
      gravity: parseInt(g),
      winRate: d.total > 0 ? `${((d.wins / d.total) * 100).toFixed(0)}%` : "—",
      wins   : d.wins,
      total  : d.total,
    })).sort((a, b) => a.gravity - b.gravity),
    bestFeatures : best.map(w => ({ feature: w.feature, winRate: `${w.winRate.toFixed(0)}%`, trades: w.total })),
    worstFeatures: worst.map(w => ({ feature: w.feature, winRate: `${w.winRate.toFixed(0)}%`, trades: w.total })),
    recentTrades : recent,
    lastUpdated  : new Date(state.lastUpdated).toISOString(),
  };
}

export function getRecentLearningEntries(limit = 50): LearningEntry[] {
  return state.entries.slice(0, limit);
}
