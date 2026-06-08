import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";

import { fetchLiveNQPrice } from "./livePrice";
import type { InsertWebhookPayload, InsertAnalysis } from "@shared/schema";
import Anthropic from "@anthropic-ai/sdk";
import { detectTriggers, generateCommentary, updateState } from "./commentaryEngine";
import { getPersonality, setPersonality, isTrashTalk, buildVwapRel, type MarketContext, type PersonalityId } from "./personalities";
import {
  buildMuzziSignal,
  recordTrade,
  getInsights,
  getWeights,
  getRecentLearningEntries,
} from "./learningKernel";
import {
  evaluateSignal,
  clearExpiredSignals,
  getPendingSignal,
  confirmSignal,
  updateSignalResult,
  getRecentSignals,
  getSignalStats,
} from "./signalEngine";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

// ── ICT + Order Flow Setup Scorer ────────────────────────────────────────────
function scoreSetup(webhooks: ReturnType<typeof storage.getRecentWebhooks>): {
  score: number;
  ictScore: number;
  orderFlowScore: number;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  confluences: string[];
  orderFlowConfluences: string[];
  warnings: string[];
  hasOrderFlow: boolean;
  tvLatest: ReturnType<typeof storage.getRecentWebhooks>[number] | null;
  tv15Latest: ReturnType<typeof storage.getRecentWebhooks>[number] | null;
  tv5Latest: ReturnType<typeof storage.getRecentWebhooks>[number] | null;
  tv1Latest: ReturnType<typeof storage.getRecentWebhooks>[number] | null;
  scLatest: ReturnType<typeof storage.getRecentWebhooks>[number] | null;
  tvFresh: boolean;
  scFresh: boolean;
  tvAge: number;
  scAge: number;
} {
  const confluences: string[] = [];
  const orderFlowConfluences: string[] = [];
  const warnings: string[] = [];
  let bullPoints = 0;
  let bearPoints = 0;
  let ofBullPoints = 0;
  let ofBearPoints = 0;

  // ── Split streams ──────────────────────────────────────────────────────────
  // TradingView sends ICT signals; Sierra Chart sends order flow.
  // Within TradingView we further split by timeframe:
  //   15m → session bias (trend direction)
  //   5m  → setup confirmation (structure / FVG / OB)
  //   1m  → trigger execution (MSS, delta flip, 3-bar play)
  const tvWebhooks = webhooks.filter(w => w.source === 'tradingview' || (!w.source && w.killzone !== null));
  const scWebhooks = webhooks.filter(w => w.source === 'sierra_chart' || w.source === 'bookmap_cme');

  // Timeframe sub-streams from TradingView
  const tv15 = tvWebhooks.filter(w => String(w.timeframe) === "15" || String(w.timeframe) === "15m");
  const tv5  = tvWebhooks.filter(w => String(w.timeframe) === "5"  || String(w.timeframe) === "5m");
  const tv1  = tvWebhooks.filter(w => String(w.timeframe) === "1"  || String(w.timeframe) === "1m");

  // Most recent per timeframe (fall back to general tvWebhooks if specific TF absent)
  const tv15Latest = tv15[0] ?? null;
  const tv5Latest  = tv5[0]  ?? null;
  const tv1Latest  = tv1[0]  ?? null;

  // tvLatest = best available for general ICT scoring (prefer 5m for setup, fall back to 15m)
  const tvLatest = tv5Latest ?? tv15Latest ?? tvWebhooks[0] ?? null;
  const tvAge = tvLatest ? Date.now() - tvLatest.receivedAt : Infinity;
  const tvFresh = tvAge < 30 * 60 * 1000; // 30 min

  // Use most recent Sierra Chart webhook for order flow (up to 5 min old)
  const scLatest = scWebhooks[0] ?? null;
  const scAge = scLatest ? Date.now() - scLatest.receivedAt : Infinity;
  const scFresh = scAge < 5 * 60 * 1000; // 5 min

  // Price: prefer SC (most current tick), fall back to TV
  const priceSource = scLatest ?? tvLatest ?? webhooks[0];

  if (!priceSource) return { score: 0, ictScore: 0, orderFlowScore: 0, bias: "NEUTRAL", confluences: ["No data received yet"], orderFlowConfluences: [], warnings: [], hasOrderFlow: false, tvLatest: null, tv15Latest: null, tv5Latest: null, tv1Latest: null, scLatest: null, tvFresh: false, scFresh: false, tvAge: Infinity, scAge: Infinity };

  // ── ICT Signals (from TradingView) ─────────────────────────────────────────

  if (!tvFresh) {
    warnings.push("TradingView ICT signals stale (>30min) — order flow only");
  }

  // Killzone check
  if (tvLatest?.killzone) {
    const kzLabel = tvLatest.killzone.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    confluences.push(`Active Killzone: ${kzLabel}`);
    bullPoints += 8;
    bearPoints += 8;
  } else {
    warnings.push("No active killzone — off-session trade");
  }

  // Market structure — 15m drives bias (highest weight), 5m confirms setup
  // 15m bias: strongest signal — session direction
  const ms15 = tv15Latest?.marketStructure || "";
  if (ms15) {
    if (ms15.includes("bull")) {
      confluences.push(`15m Bullish Structure: ${ms15.replace(/_/g, " ").toUpperCase()} — session bias LONG`);
      bullPoints += 25;
    } else if (ms15.includes("bear")) {
      confluences.push(`15m Bearish Structure: ${ms15.replace(/_/g, " ").toUpperCase()} — session bias SHORT`);
      bearPoints += 25;
    }
  }
  // 5m setup: confirms the trade structure
  const ms5 = tv5Latest?.marketStructure || "";
  if (ms5) {
    if (ms5.includes("bull")) {
      confluences.push(`5m Bullish Setup: ${ms5.replace(/_/g, " ").toUpperCase()} — entry structure confirmed`);
      bullPoints += 18;
    } else if (ms5.includes("bear")) {
      confluences.push(`5m Bearish Setup: ${ms5.replace(/_/g, " ").toUpperCase()} — entry structure confirmed`);
      bearPoints += 18;
    }
  }
  // 1m trigger: execution-level MSS (lighter weight — confirmation only)
  const ms1 = tv1Latest?.marketStructure || tvLatest?.marketStructure || "";
  if (ms1 && !ms15 && !ms5) {
    // Only use 1m if no higher TF data present
    if (ms1.includes("bull")) { confluences.push(`1m Bullish Trigger: ${ms1.replace(/_/g, " ").toUpperCase()}`); bullPoints += 12; }
    else if (ms1.includes("bear")) { confluences.push(`1m Bearish Trigger: ${ms1.replace(/_/g, " ").toUpperCase()}`); bearPoints += 12; }
  }

  // FVG — prefer 5m (setup timeframe) then fall back to latest
  const fvgSrc = tv5Latest ?? tvLatest;
  if (fvgSrc?.fvgBull) { confluences.push("5m Bullish Fair Value Gap — setup zone active"); bullPoints += 15; }
  if (fvgSrc?.fvgBear) { confluences.push("5m Bearish Fair Value Gap — setup zone active"); bearPoints += 15; }
  // 1m FVG as additional confluence (not primary)
  if (tv1Latest?.fvgBull && !fvgSrc?.fvgBull) { confluences.push("1m Bullish FVG — trigger-level gap"); bullPoints += 8; }
  if (tv1Latest?.fvgBear && !fvgSrc?.fvgBear) { confluences.push("1m Bearish FVG — trigger-level gap"); bearPoints += 8; }

  // Order Blocks — 5m OBs carry more weight than 1m
  if (fvgSrc?.obBull) { confluences.push("5m Bullish Order Block in range"); bullPoints += 12; }
  if (fvgSrc?.obBear) { confluences.push("5m Bearish Order Block in range"); bearPoints += 12; }

  // Liquidity sweeps — 15m sweep = manipulation leg complete (highest confidence)
  const sweepSrc = tv15Latest ?? tvLatest;
  if (sweepSrc?.sweepLow)  { confluences.push("15m Low swept — Manipulation leg done, bullish reversal likely"); bullPoints += 20; }
  if (sweepSrc?.sweepHigh) { confluences.push("15m High swept — Manipulation leg done, bearish reversal likely"); bearPoints += 20; }
  // 5m sweeps also valid
  if (tv5Latest?.sweepLow  && !sweepSrc?.sweepLow)  { confluences.push("5m Low swept — Turtle Soup setup possible"); bullPoints += 14; }
  if (tv5Latest?.sweepHigh && !sweepSrc?.sweepHigh) { confluences.push("5m High swept — Silver Bullet fade possible"); bearPoints += 14; }

  // Premium / Discount
  if (tvLatest?.discount) { confluences.push("Price in discount zone (below EQ) — long bias"); bullPoints += 12; }
  if (tvLatest?.premium) { confluences.push("Price in premium zone (above EQ) — short bias"); bearPoints += 12; }

  // VWAP relationship (prefer TV for VWAP context, priceSource for close)
  const vwapSource = tvLatest ?? priceSource;
  if (vwapSource.vwap && priceSource.close) {
    if (priceSource.close > vwapSource.vwap) { confluences.push("Price above VWAP — bullish intraday"); bullPoints += 8; }
    else { confluences.push("Price below VWAP — bearish intraday"); bearPoints += 8; }
  }

  // Trend consistency — weight by timeframe cascade
  // 15m consistency = strongest (multiple 15m bars bullish = confirmed bias)
  const bull15 = tv15.filter(w => (w.marketStructure || "").includes("bull")).length;
  const bear15 = tv15.filter(w => (w.marketStructure || "").includes("bear")).length;
  if (bull15 >= 2) { confluences.push(`${bull15}x 15m bullish bars — strong session bias LONG`);  bullPoints += 15; }
  if (bear15 >= 2) { confluences.push(`${bear15}x 15m bearish bars — strong session bias SHORT`); bearPoints += 15; }
  // 5m consistency = setup confirmation
  const bull5 = tv5.filter(w => (w.marketStructure || "").includes("bull")).length;
  const bear5 = tv5.filter(w => (w.marketStructure || "").includes("bear")).length;
  if (bull5 >= 2) { confluences.push(`${bull5}x 5m bullish bars — setup structure confirmed`);  bullPoints += 10; }
  if (bear5 >= 2) { confluences.push(`${bear5}x 5m bearish bars — setup structure confirmed`); bearPoints += 10; }

  // ── Order Flow Signals (Sierra Chart / Bookmap CME) ────────────────────────
  const hasOrderFlow = scFresh && !!scLatest;

  if (scLatest) {
    const { delta, bidStackSize, askStackSize, absorptionBull, absorptionBear,
            imbalanceBull, imbalanceBear, largeBuyCount, largeSellCount, vapPoc, close } = scLatest;

    // Delta (buy vol - sell vol) — strongest signal
    if (delta !== null && delta !== undefined) {
      if (delta > 500) {
        orderFlowConfluences.push(`Positive delta +${delta} — aggressive buying`);
        ofBullPoints += 20;
      } else if (delta > 150) {
        orderFlowConfluences.push(`Mild positive delta +${delta}`);
        ofBullPoints += 10;
      } else if (delta < -500) {
        orderFlowConfluences.push(`Negative delta ${delta} — aggressive selling`);
        ofBearPoints += 20;
      } else if (delta < -150) {
        orderFlowConfluences.push(`Mild negative delta ${delta}`);
        ofBearPoints += 10;
      } else {
        orderFlowConfluences.push(`Neutral delta ${delta > 0 ? '+' : ''}${delta} — balanced`);
      }
    }

    // Bid/Ask stack imbalance — stacked DOM
    if (imbalanceBull) {
      orderFlowConfluences.push(`Bid stack ${bidStackSize} >> Ask stack ${askStackSize} — DOM support`);
      ofBullPoints += 18;
    } else if (imbalanceBear) {
      orderFlowConfluences.push(`Ask stack ${askStackSize} >> Bid stack ${bidStackSize} — DOM resistance`);
      ofBearPoints += 18;
    } else if (bidStackSize && askStackSize) {
      orderFlowConfluences.push(`Balanced DOM: Bid ${bidStackSize} / Ask ${askStackSize}`);
    }

    // Absorption — high-conviction reversal signal
    if (absorptionBull) {
      orderFlowConfluences.push("Bull absorption: large sell absorbed at bid — reversal signal");
      ofBullPoints += 22;
    }
    if (absorptionBear) {
      orderFlowConfluences.push("Bear absorption: large buy absorbed at ask — reversal signal");
      ofBearPoints += 22;
    }

    // Large print imbalance
    if (largeBuyCount !== null && largeSellCount !== null) {
      if (largeBuyCount > largeSellCount + 1) {
        orderFlowConfluences.push(`Large buyer dominance: ${largeBuyCount} large buys vs ${largeSellCount} sells`);
        ofBullPoints += 12;
      } else if (largeSellCount > largeBuyCount + 1) {
        orderFlowConfluences.push(`Large seller dominance: ${largeSellCount} large sells vs ${largeBuyCount} buys`);
        ofBearPoints += 12;
      }
    }

    // POC relationship to price
    if (vapPoc && close) {
      if (close > vapPoc) {
        orderFlowConfluences.push(`Price above POC (${vapPoc}) — bullish value area`);
        ofBullPoints += 8;
      } else {
        orderFlowConfluences.push(`Price below POC (${vapPoc}) — bearish value area`);
        ofBearPoints += 8;
      }
    }

    // Warnings
    if (delta !== null && Math.abs(delta) < 50 && (largeBuyCount || 0) + (largeSellCount || 0) > 5) {
      warnings.push("High large-print activity but balanced delta — potential manipulation/spoof");
    }
    if (delta !== null && delta > 0 && (imbalanceBear || 0) === 1) {
      warnings.push("Positive delta but stacked asks — buyers may be trapped");
    }
    if (delta !== null && delta < 0 && (imbalanceBull || 0) === 1) {
      warnings.push("Negative delta but stacked bids — sellers may be trapped");
    }

    // Merge order flow into main scoring
    bullPoints += ofBullPoints;
    bearPoints += ofBearPoints;
  }

  // Warnings from price action
  if (priceSource.close && priceSource.high && priceSource.low) {
    const range = priceSource.high - priceSource.low;
    if (range < 10) warnings.push("Tight range bar — low momentum");
    if (range > 80) warnings.push("Extended range — potential exhaustion");
  }

  const ictMax = 103;
  const ofMax  = hasOrderFlow ? 80 : 0;
  const totalMax = ictMax + ofMax;

  const bias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    bullPoints > bearPoints + 10 ? "BULLISH" :
    bearPoints > bullPoints + 10 ? "BEARISH" : "NEUTRAL";

  const dominantPoints = Math.max(bullPoints, bearPoints);
  const score = Math.min(100, Math.round((dominantPoints / totalMax) * 100));
  const ictScore = Math.min(100, Math.round((Math.max(bullPoints - ofBullPoints, bearPoints - ofBearPoints) / ictMax) * 100));
  const orderFlowScore = hasOrderFlow ? Math.min(100, Math.round((Math.max(ofBullPoints, ofBearPoints) / ofMax) * 100)) : 0;

  return { score, ictScore, orderFlowScore, bias, confluences, orderFlowConfluences, warnings, hasOrderFlow, tvLatest, tv15Latest, tv5Latest, tv1Latest, scLatest, tvFresh, scFresh, tvAge, scAge };
}

// ── Build AI context prompt ──────────────────────────────────────────────────
function buildAnalysisPrompt(
  webhooks: ReturnType<typeof storage.getRecentWebhooks>,
  score: number,
  bias: string,
  confluences: string[],
  warnings: string[],
  userQuestion?: string,
  session?: string,
  livePrice?: number | null,
  tvLatest?: ReturnType<typeof storage.getRecentWebhooks>[number] | null,
  scLatest?: ReturnType<typeof storage.getRecentWebhooks>[number] | null,
  tvFresh?: boolean,
  scFresh?: boolean,
  tvAge?: number,
  scAge?: number
): string {
  const latest = webhooks[0];
  // Prefer live Yahoo Finance price over stale webhook close
  const effectivePrice = livePrice ?? latest?.close ?? null;
  const priceStr = effectivePrice ? `$${effectivePrice.toLocaleString()}` : "unknown";
  const vwapStr = latest?.vwap ? `$${latest.vwap.toLocaleString()}` : "N/A";

  const recentSignals = webhooks.slice(0, 5).map(w =>
    `  [${new Date(w.receivedAt).toLocaleTimeString()}] TF:${w.timeframe} | C:${w.close} | ` +
    `MS:${w.marketStructure || "none"} | KZ:${w.killzone || "none"} | ` +
    `FVG:${w.fvgBull ? "bull" : w.fvgBear ? "bear" : "none"} | ` +
    `Sweep:${w.sweepHigh ? "high" : w.sweepLow ? "low" : "none"} | ` +
    `Zone:${w.premium ? "premium" : w.discount ? "discount" : "mid"}`
  ).join("\n");

  const ofLatest = webhooks.find(w => w.source === "sierra_chart");
  const ofSection = ofLatest ? `
ORDER FLOW DATA (Sierra Chart — Live CME Data):
- Delta (this bar): ${ofLatest.delta !== null ? (ofLatest.delta! > 0 ? "+" : "") + ofLatest.delta : "N/A"} contracts (positive = net buying pressure)
- Buy Volume: ${ofLatest.buyVolume ?? "N/A"} / Sell Volume: ${ofLatest.sellVolume ?? "N/A"}
- CVD trend available via recent delta history
- DOM Bid Stack: ${ofLatest.bidStackSize ?? "N/A"} / Ask Stack: ${ofLatest.askStackSize ?? "N/A"} (top ${10} levels)
- Spread: visible in raw data
- Large Prints: ${ofLatest.largeTradeCount ?? 0} total (${ofLatest.largeBuyCount ?? 0} buys / ${ofLatest.largeSellCount ?? 0} sells)
- Bull Absorption: ${ofLatest.absorptionBull ? "YES ← STRONG SIGNAL: sellers being absorbed, buyers in control" : "No"}
- Bear Absorption: ${ofLatest.absorptionBear ? "YES ← STRONG SIGNAL: buyers being absorbed, sellers in control" : "No"}
- DOM Imbalance: ${ofLatest.imbalanceBull ? "STACKED BIDS — 3x+ more bids than asks (bullish pressure)" : ofLatest.imbalanceBear ? "STACKED ASKS — 3x+ more asks than bids (bearish pressure)" : "Balanced DOM"}
- Volume POC: ${ofLatest.vapPoc ?? "N/A"} (highest volume price level — acts as magnet)
- VWAP: ${ofLatest.vwap ?? "N/A"}

ORDER FLOW INTERPRETATION:
${ofLatest.absorptionBull ? "→ Bullish absorption confirms buyers defending the level — ICT discount zone + absorption = high conviction long" : ""}
${ofLatest.absorptionBear ? "→ Bearish absorption confirms sellers capping the move — ICT premium zone + absorption = high conviction short" : ""}
${ofLatest.delta !== null && ofLatest.delta! > 0 && ofLatest.close !== null && ofLatest.close! < (ofLatest.vwap ?? 999999) ? "→ Positive delta below VWAP = buyers accumulating in discount — potential long setup" : ""}
${ofLatest.delta !== null && ofLatest.delta! < 0 && ofLatest.close !== null && ofLatest.close! > (ofLatest.vwap ?? 0) ? "→ Negative delta above VWAP = distribution in premium — potential short setup" : ""}
` : "ORDER FLOW: Sierra Chart not yet connected. Install NQ_Analyst_Bridge.cpp study in Sierra Chart to enable live delta, DOM, and absorption data.";

  const tvFreshFlag = tvFresh ?? false;
  const scFreshFlag = scFresh ?? false;
  const tvAgeMin = tvAge !== undefined && tvAge !== Infinity ? Math.round(tvAge / 60000) : null;
  const scAgeMin = scAge !== undefined && scAge !== Infinity ? Math.round(scAge / 60000) : null;

  const systemPrompt = `You are an elite NQ futures quant analyst combining ICT (Inner Circle Trader) methodology with live order flow analysis from Sierra Chart CME data.
You analyze NQ (Nasdaq 100 E-mini futures) using: kill zones (London Open 2-5am CT, NY Open 7-10am CT, NY Close 1-3pm CT), 
market structure (BOS/CHoCH), fair value gaps, order blocks, liquidity sweeps, premium/discount zones, VWAP, and 15-min bias with 1-min entries.
You also analyze order flow from Sierra Chart: delta, CVD, DOM depth (bid/ask stack), absorption events, large prints, and volume POC.

Your job: give precise, actionable trade analysis that COMBINES ICT context with order flow confirmation. Be direct like a prop desk analyst.
Never give generic advice. Always specify: bias, entry zone, stop, targets, and WHY with both ICT reasons AND order flow confirmation.

${session === "asia" ? `ACTIVE SESSION: AMD STRATEGY (6PM–2AM ET)
You are analyzing the AMD (Accumulation, Manipulation, Distribution) cycle.
- ACCUMULATION phase (6PM–8PM ET): Smart money builds a position quietly. Price moves sideways or compresses. Look for: tight range, low delta, equal highs/lows forming as future sweep targets. DO NOT call directional trades yet. Mark the range boundaries.
- MANIPULATION phase (8PM–11PM ET): False move to trap retail. Price sweeps above or below the accumulation range to hunt stops. Look for: liquidity grabs above equal highs or below equal lows, spike + reversal candle, delta divergence (price moves up but delta drops = bearish trap). Identify which side is being swept.
- DISTRIBUTION phase (11PM–2AM ET): Smart money delivers price in the true direction opposite the manipulation. Look for: strong displacement away from the swept level, FVG formation, order block left behind. Call the directional bias for London and NY based on which side was swept in manipulation.
Key output: Label current AMD phase, identify swept liquidity, call the directional bias for the rest of the night.` : session === "london" ? `ACTIVE SESSION: LONDON — WATCH FOR ASIA SWEEP REVERSAL (2AM–5AM ET)
You are watching for Turtle Soup setups and Silver Bullet reversals off the Asia range sweep.
- TURTLE SOUP: Price sweeps above the Asia session high or below the Asia session low (liquidity grab), then immediately reverses and closes back inside the Asia range. This is the signal. Long if Asia low was swept, Short if Asia high was swept. Entry: on the reversal candle close or first pullback FVG. SL: beyond the swept extreme. TP1: Asia range midpoint. TP2: opposite side of Asia range.
- SILVER BULLET (2:00AM–3:00AM ET window): A 3-candle FVG forms during this specific window after a liquidity sweep. Enter on the FVG fill. This is a high-probability setup — only valid if London has already swept a key level (Asia high, Asia low, prior day high/low, or overnight high/low).
- CONFIRMATION signals: Displacement candle (large body, closes near high/low), bullish/bearish engulfing after the sweep, delta confirms (buy delta surging after Asia low sweep = bullish Turtle Soup).
Key output: Has Asia high or low been swept yet? Is a Turtle Soup forming? Is this the Silver Bullet window? Call the setup with entry, SL, TP1, TP2.` : `ACTIVE SESSION: NEW YORK (7AM–11AM ET)
Focus: ICT kill zone entries. Use the London sweep direction as confirmation. Look for: OTE retracements (62-79% fib of the London displacement), FVG fills left by London displacement candles, order block taps in the NY open kill zone (7-9am ET). Give specific entry zones, stops, TP1 and TP2. This is the primary trading session — be precise and actionable.`}

CRITICAL RULES (never override these):
- Current time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: true })} CT / ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true })} ET
- The ONLY correct NQ price right now is ${priceStr}. Use this exact number whenever you write "Live Price", "Current Price", or any price reference.
- Every price level (entry, stop, TP1, TP2, support, resistance) MUST be within 200 points of ${priceStr}. Never use prices from training data or memory.
- Do NOT invent or estimate a different price. The price is ${priceStr}. Period.

CURRENT MARKET DATA:
- Instrument: NQ Futures (NQ1!)
- Live Price (authoritative): ${priceStr}
- VWAP: ${vwapStr}
- Combined Setup Score: ${score}/100
- Session Bias: ${bias}
- ICT Confluences: ${confluences.join("; ")}
- Warnings: ${warnings.length ? warnings.join("; ") : "None"}
- TradingView ICT Data: ${tvFreshFlag ? `LIVE (${tvAgeMin}min ago)` : 'STALE/DISCONNECTED'}
- Sierra Chart Order Flow: ${scFreshFlag ? `LIVE (${scAgeMin}min ago)` : 'STALE/DISCONNECTED'}
- ICT: killzone=${tvLatest?.killzone||'none'} | structure=${tvLatest?.marketStructure||'none'} | fvgBull=${tvLatest?.fvgBull||0} fvgBear=${tvLatest?.fvgBear||0} | obBull=${tvLatest?.obBull||0} obBear=${tvLatest?.obBear||0} | sweepHigh=${tvLatest?.sweepHigh||0} sweepLow=${tvLatest?.sweepLow||0} | premium=${tvLatest?.premium||0} discount=${tvLatest?.discount||0}
- OrderFlow: delta=${scLatest?.delta??'n/a'} | bid=${scLatest?.bidStackSize??'n/a'} ask=${scLatest?.askStackSize??'n/a'} | absorbBull=${scLatest?.absorptionBull||0} absorbBear=${scLatest?.absorptionBear||0}

${ofSection}

RECENT SIGNAL HISTORY (newest first):
${recentSignals || "  No signals received yet"}`; 

  const noData = !latest || (!latest.killzone && !latest.marketStructure && !latest.fvgBull && !latest.fvgBear && !latest.obBull && !latest.obBear && !latest.sweepLow && !latest.sweepHigh);

  const userPrompt = userQuestion
    ? userQuestion
    : noData
      ? `No live webhook data is connected yet (TradingView or Sierra Chart not sending signals). However, the live NQ price is ${priceStr}. Based ONLY on the live price, current session mode, and ICT methodology, provide a complete trade analysis. Use the live price as your anchor for ALL levels — entry zones, stop loss, TP1, TP2 must all be calculated relative to ${priceStr}. Do not use any price from memory or training data. State clearly that no confluence data is live yet, but still give a full actionable analysis using the live price.`
      : `Based on the current ICT signals and setup score of ${score}/100 with a ${bias} bias, provide your complete trade analysis including: session bias reasoning, setup score breakdown, specific entry zone, stop loss, and two targets. All price levels must be relative to the current live price of ${priceStr}. Also note any key risks.`;

  return `${systemPrompt}\n\nUser Question: ${userPrompt}`;
}

// ── Parse AI trade plan from narrative ──────────────────────────────────────
function parseTradePlan(narrative: string, latest: ReturnType<typeof storage.getLatestWebhook>, livePrice?: number | null) {
  const entryMatch = narrative.match(/entry[:\s]+\$?([\d,]+(?:\.\d+)?(?:\s*[-–]\s*\$?[\d,]+(?:\.\d+)?)?)/i);
  const stopMatch  = narrative.match(/stop[^\n]{0,20}[:\s]+\$?([\d,]+(?:\.\d+)?)/i);
  const t1Match    = narrative.match(/(?:target\s*1|tp\s*1|take\s*profit\s*1)[:\s]+\$?([\d,]+(?:\.\d+)?)/i);
  const t2Match    = narrative.match(/(?:target\s*2|tp\s*2|take\s*profit\s*2)[:\s]+\$?([\d,]+(?:\.\d+)?)/i);

  // Use live price as fallback anchor — never stale webhook close
  const p = livePrice ?? latest?.close ?? null;

  return {
    entryZone: entryMatch?.[1] || (p ? `${(p - 8).toFixed(2)} - ${(p + 3).toFixed(2)}` : null),
    stopLoss:  stopMatch?.[1]  || (p ? `${(p - 20).toFixed(2)}` : null),
    target1:   t1Match?.[1]   || (p ? `${(p + 30).toFixed(2)}` : null),
    target2:   t2Match?.[1]   || (p ? `${(p + 75).toFixed(2)}` : null),
  };
}

// ── 5-minute gate for auto-analysis on webhook ─────────────────────────────
// Prevents AI analysis from firing on every incoming tick — max once per 5 min.
let lastAutoAnalysisAt = 0;
const AUTO_ANALYSIS_INTERVAL_MS = 15 * 60 * 1000; // 15 min — was 5 min, burning $40-50/day

// ── GLOBAL Claude API gate — ALL callers must check this ─────────────────────
// Sierra posts every 15s. Without this gate every absorption flag = Claude call.
let lastAnyClaudeCallAt = 0;
const GLOBAL_CLAUDE_GATE_MS = 15 * 60 * 1000; // hard 15-minute minimum between ANY Claude call
function claudeGateOpen(): boolean {
  const now = Date.now();
  if (now - lastAnyClaudeCallAt < GLOBAL_CLAUDE_GATE_MS) return false;
  lastAnyClaudeCallAt = now;
  return true;
}
let lastSierraCommentaryAt = 0;
const SIERRA_COMMENTARY_GATE_MS = 15 * 60 * 1000;

export function registerRoutes(httpServer: Server, app: Express) {

  // ── POST /api/webhook — TradingView webhook receiver ──────────────────────
  app.post("/api/webhook", async (req, res) => {
    try {
      const body = req.body;
      if (!body) return res.status(400).json({ error: "Empty body" });

      const payload: InsertWebhookPayload = {
        receivedAt: Date.now(),
        ticker: body.ticker || "NQ1!",
        timeframe: String(body.timeframe || body.tf || "15"),
        open: body.open !== undefined ? Number(body.open) : null,
        high: body.high !== undefined ? Number(body.high) : null,
        low: body.low !== undefined ? Number(body.low) : null,
        close: body.close !== undefined ? Number(body.close) : null,
        volume: body.volume !== undefined ? Number(body.volume) : null,
        vwap: body.vwap !== undefined ? Number(body.vwap) : null,
        killzone: body.killzone || body.kz || null,
        marketStructure: body.market_structure || body.ms || null,
        fvgBull: body.fvg_bull ? 1 : 0,
        fvgBear: body.fvg_bear ? 1 : 0,
        obBull: body.ob_bull ? 1 : 0,
        obBear: body.ob_bear ? 1 : 0,
        sweepHigh: body.sweep_high ? 1 : 0,
        sweepLow: body.sweep_low ? 1 : 0,
        premium: body.premium ? 1 : 0,
        discount: body.discount ? 1 : 0,
        rawJson: JSON.stringify(body),
        // Order flow fields (Bookmap)
        source: body.source || "tradingview",
        bidStackSize: body.bid_stack_size !== undefined ? Number(body.bid_stack_size) : null,
        askStackSize: body.ask_stack_size !== undefined ? Number(body.ask_stack_size) : null,
        delta: body.delta !== undefined ? Number(body.delta) : null,
        buyVolume: body.buy_volume !== undefined ? Number(body.buy_volume) : null,
        sellVolume: body.sell_volume !== undefined ? Number(body.sell_volume) : null,
        largeTradeCount: body.large_trade_count !== undefined ? Number(body.large_trade_count) : null,
        largeBuyCount: body.large_buy_count !== undefined ? Number(body.large_buy_count) : null,
        largeSellCount: body.large_sell_count !== undefined ? Number(body.large_sell_count) : null,
        absorptionBull: body.absorption_bull ? 1 : 0,
        absorptionBear: body.absorption_bear ? 1 : 0,
        vapPoc: body.vap_poc !== undefined ? Number(body.vap_poc) : null,
        imbalanceBull: body.imbalance_bull ? 1 : 0,
        imbalanceBear: body.imbalance_bear ? 1 : 0,
      };

      const saved = storage.saveWebhook(payload);

      // ── Commentary Engine — detect triggers and generate AI commentary ──────
      try {
        const allWebhooks = storage.getRecentWebhooks(10);
        const { score, ictScore, bias, confluences, warnings } = scoreSetup(allWebhooks);
        
        const triggers = detectTriggers(saved, bias, score, confluences);
        updateState(bias, score, saved.killzone);

        // Fire commentary for the highest-urgency trigger only (avoid spam)
        if (triggers.length > 0) {
          const top = triggers.sort((a, b) =>
            (a.urgency === "high" ? 0 : a.urgency === "medium" ? 1 : 2) -
            (b.urgency === "high" ? 0 : b.urgency === "medium" ? 1 : 2)
          )[0];
          // Fire async — don't block webhook response
          generateCommentary(top, allWebhooks, bias, score, ictScore, confluences, warnings)
            .catch(e => console.error("[Commentary] Error:", e));
        }
      } catch (e) {
        console.error("[Commentary] Trigger detection failed:", e);
      }

      // Auto-generate analysis on webhook if AI key is present — max once per 5 min
      const nowMs = Date.now();
      if (process.env.ANTHROPIC_API_KEY && (nowMs - lastAutoAnalysisAt) >= AUTO_ANALYSIS_INTERVAL_MS && claudeGateOpen()) {
        const webhooks = storage.getRecentWebhooks(10);
        const { score, ictScore, bias, confluences, warnings, tvLatest, scLatest, tvFresh, scFresh, tvAge, scAge } = scoreSetup(webhooks);

        if (score >= 40) {
          lastAutoAnalysisAt = nowMs;
          try {
            const livePrice = await fetchLiveNQPrice();
            const prompt = buildAnalysisPrompt(webhooks, score, bias, confluences, warnings, undefined, activeSession, livePrice, tvLatest, scLatest, tvFresh, scFresh, tvAge, scAge);
            const msg = await anthropic.messages.create({
              model: "claude-opus-4-5",
              max_tokens: 800,
              messages: [{ role: "user", content: prompt }],
            });
            const narrative = (msg.content[0] as any).text;
            const latest = webhooks[0];
            const tradePlan = parseTradePlan(narrative, latest, livePrice);

            const direction = bias === "BULLISH" ? "LONG" : bias === "BEARISH" ? "SHORT" : "WAIT";

            storage.saveAnalysis({
              createdAt: Date.now(),
              latestPrice: livePrice ?? latest?.close ?? null,
              sessionBias: bias,
              setupScore: score,
              tradeDirection: direction,
              ...tradePlan,
              narrative,
              confluences: JSON.stringify(confluences),
              warnings: warnings.length ? JSON.stringify(warnings) : null,
              triggeredBy: "webhook",
            });
          } catch (e) {
            console.error("AI analysis failed:", e);
          }
        }
      }

      // ── Signal Engine — evaluate for auto-trade signal ────────────────────
      // Uses TV fast-path (long_signal/short_signal from Pine v3) or server scoring
      try {
        clearExpiredSignals();
        // Only evaluate TV webhooks — SC sends too frequently with no ICT data
        const isTVWebhook = !body.source || body.source === 'tradingview' || body.source === 'ninjatrader';
        if (isTVWebhook) {
          const freshWebhooks = storage.getRecentWebhooks(10);
          const { score, bias, orderFlowScore, tvLatest, scLatest } = scoreSetup(freshWebhooks);

          // Build merged marketData object — ICT from TV/NT8, order flow from SC
          // BUG FIX: if source is ninjatrader, use body.close directly (NT8 sends actual price)
          // tvLatest only includes tradingview-sourced webhooks — stale for NT8 signals
          const ntPrice = body.source === 'ninjatrader' && body.close ? Number(body.close) : null;
          const mergedMarketData = {
            close: ntPrice ?? tvLatest?.close ?? scLatest?.close ?? null,
            // ── SC Volume fields — all passed through to signalEngine volume gate ──
            delta:          scLatest?.delta          ?? null,
            absorptionBull: scLatest?.absorptionBull ?? null,
            absorptionBear: scLatest?.absorptionBear ?? null,
            imbalanceBull:  scLatest?.imbalanceBull  ?? null,
            imbalanceBear:  scLatest?.imbalanceBear  ?? null,
            bidStackSize:   scLatest?.bidStackSize   ?? null,
            askStackSize:   scLatest?.askStackSize   ?? null,
            bias,
            score,
            orderFlowScore,
            // Direct signal fields from NT8 or Pine Script v3
            long_signal: body.long_signal ? Number(body.long_signal) : undefined,
            short_signal: body.short_signal ? Number(body.short_signal) : undefined,
            long_conf: body.long_conf ? Number(body.long_conf) : undefined,
            short_conf: body.short_conf ? Number(body.short_conf) : undefined,
            killzone: body.killzone || body.kz || null,
            // NT8 sends pre-calculated SL/TP — pass through so evaluateSignal can use them
            nt_sl:  body.source === 'ninjatrader' && body.sl  ? Number(body.sl)  : undefined,
            nt_tp1: body.source === 'ninjatrader' && body.tp1 ? Number(body.tp1) : undefined,
            nt_tp2: body.source === 'ninjatrader' && body.tp2 ? Number(body.tp2) : undefined,
            // Fix 1: Pass NT8 session tag through so signalEngine stores the correct label
            nt_session: body.session ? String(body.session) : null,
            // CRITICAL: pass direction field so NT8 fast path in evaluateSignal triggers
            direction: body.source === 'ninjatrader' && body.direction ? String(body.direction) : undefined,
            confidence: body.confidence ? Number(body.confidence) : undefined,
            reasons: body.reasons ? String(body.reasons) : undefined,
          };

          const newSignal = evaluateSignal(mergedMarketData, activeSession);
          if (newSignal) {
            console.log(`[Webhook] Auto-signal fired: ${newSignal.direction.toUpperCase()} @ ${newSignal.entry}`);
          }
        }
      } catch (sigErr) {
        console.error("[Signal] Evaluation error:", sigErr);
      }

      return res.json({ ok: true, id: saved.id });
    } catch (err) {
      console.error("Webhook error:", err);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ── POST /api/debug-signal — Test evaluateSignal directly with NT8 payload ───
  app.post("/api/debug-signal", (req, res) => {
    const body = req.body || {};
    const freshWebhooks = storage.getRecentWebhooks(10);
    const { score, bias, orderFlowScore, tvLatest, scLatest } = scoreSetup(freshWebhooks);
    const ntPrice = body.source === 'ninjatrader' && body.close ? Number(body.close) : null;
    const mergedMarketData = {
      close: ntPrice ?? tvLatest?.close ?? scLatest?.close ?? null,
      delta: scLatest?.delta ?? null,
      bias,
      score,
      orderFlowScore,
      absorptionBull: scLatest?.absorptionBull ?? null,
      absorptionBear: scLatest?.absorptionBear ?? null,
      long_signal: body.long_signal ? Number(body.long_signal) : undefined,
      short_signal: body.short_signal ? Number(body.short_signal) : undefined,
      long_conf: body.long_conf ? Number(body.long_conf) : undefined,
      short_conf: body.short_conf ? Number(body.short_conf) : undefined,
      killzone: body.killzone || body.kz || null,
      nt_sl:  body.source === 'ninjatrader' && body.sl  ? Number(body.sl)  : undefined,
      nt_tp1: body.source === 'ninjatrader' && body.tp1 ? Number(body.tp1) : undefined,
      nt_tp2: body.source === 'ninjatrader' && body.tp2 ? Number(body.tp2) : undefined,
      nt_session: body.session ? String(body.session) : null,
      direction: body.source === 'ninjatrader' && body.direction ? String(body.direction) : undefined,
      confidence: body.confidence ? Number(body.confidence) : undefined,
      reasons: body.reasons ? String(body.reasons) : undefined,
    };
    // Also expose hasActiveSignal state by checking pending signals
    const { getRecentSignals } = require('./signalEngine');
    const recent = getRecentSignals(10);
    const pendingSignals = recent.filter((s: any) => s.status === 'pending');
    const filledRecent = recent.filter((s: any) => s.status === 'filled' && (Date.now() - s.createdAt) < 10 * 60 * 1000);
    const isBlocked = pendingSignals.length > 0 || filledRecent.length > 0;
    const newSignal = evaluateSignal(mergedMarketData, activeSession);
    return res.json({
      mergedMarketData,
      activeSession,
      pendingSignals,
      filledRecent,
      isBlocked,
      result: newSignal ? 'SIGNAL_CREATED' : 'NULL_NO_SIGNAL',
      signal: newSignal,
      score,
      bias,
    });
  });

  // ── POST /api/simulate — Inject test/demo data ─────────────────────────────
  app.post("/api/simulate", async (req, res) => {
    // Always use live NQ price as the base — never hardcode stale levels
    const liveBase = await fetchLiveNQPrice() ?? (storage.getRecentWebhooks(1)[0]?.close ?? 29900);
    const b = Math.round(liveBase * 4) / 4; // round to nearest 0.25 tick
    const scenarios = [
      {
        timeframe: "15", close: b, high: b + 25, low: b - 30, open: b - 5, volume: 12500,
        vwap: b - 15, killzone: "ny_open", marketStructure: "BOS_bull",
        fvg_bull: 1, sweep_low: 1, discount: 1,
      },
      {
        timeframe: "1", close: b + 8, high: b + 15, low: b - 5, open: b, volume: 3200,
        vwap: b - 8, killzone: "ny_open", marketStructure: "CHoCH_bull",
        ob_bull: 1, fvg_bull: 1, discount: 1,
      },
      {
        timeframe: "15", close: b - 40, high: b + 10, low: b - 60, open: b - 5, volume: 9800,
        vwap: b + 10, killzone: "ny_close", marketStructure: "BOS_bear",
        fvg_bear: 1, sweep_high: 1, premium: 1,
      },
    ];

    const pick = scenarios[Math.floor(Math.random() * scenarios.length)];
    const payload: InsertWebhookPayload = {
      receivedAt: Date.now(),
      ticker: "NQ1!",
      timeframe: pick.timeframe,
      open: pick.open,
      high: pick.high,
      low: pick.low,
      close: pick.close,
      volume: pick.volume,
      vwap: pick.vwap,
      killzone: pick.killzone || null,
      marketStructure: pick.marketStructure || null,
      fvgBull: pick.fvg_bull ? 1 : 0,
      fvgBear: (pick as any).fvg_bear ? 1 : 0,
      obBull: pick.ob_bull ? 1 : 0,
      obBear: (pick as any).ob_bear ? 1 : 0,
      sweepHigh: (pick as any).sweep_high ? 1 : 0,
      sweepLow: pick.sweep_low ? 1 : 0,
      premium: (pick as any).premium ? 1 : 0,
      discount: pick.discount ? 1 : 0,
      rawJson: JSON.stringify(pick),
    };
    const saved = storage.saveWebhook(payload);
    return res.json({ ok: true, id: saved.id });
  });

  // ── GET /api/dashboard — Main dashboard data ──────────────────────────────
  app.get("/api/dashboard", (req, res) => {
    const webhooks = storage.getRecentWebhooks(20);
    const latestAnalysis = storage.getLatestAnalysis();
    const recentAnalyses = storage.getRecentAnalyses(5);
    const { score, ictScore, bias, confluences, warnings, tvFresh, scFresh, tvAge, scAge, tvLatest, scLatest } = scoreSetup(webhooks);

    const tvAgeMin = tvAge !== Infinity ? Math.round(tvAge / 60000) : null;
    const scAgeMin = scAge !== Infinity ? Math.round(scAge / 60000) : null;

    return res.json({
      latestWebhook: webhooks.find((w: any) => w.source !== "bookmap_cme") || null,
      score,
      ictScore,
      bias,
      confluences,
      warnings,
      latestAnalysis,
      recentAnalyses,
      totalSignals: webhooks.length,
      // Feed freshness — consumed by Dashboard.tsx feed status banner
      tvFresh,
      scFresh,
      tvAgeMin,
      scAgeMin,
      hasTVData: !!tvLatest,
      hasSCData: !!scLatest,
    });
  });

  // ── GET /api/signals — Signal history ─────────────────────────────────────
  app.get("/api/signals", (req, res) => {
    const signals = storage.getRecentWebhooks(50);
    return res.json(signals);
  });

  // ── POST /api/analyze — Manual analysis trigger ───────────────────────────
  app.post("/api/analyze", async (req, res) => {
    const webhooks = storage.getRecentWebhooks(10);
    const { score, ictScore, bias, confluences, warnings, tvLatest, scLatest, tvFresh, scFresh, tvAge, scAge } = scoreSetup(webhooks);

    if (!process.env.ANTHROPIC_API_KEY) {
      // Demo mode — use live price, never stale webhook close
      const livePrice = await fetchLiveNQPrice();
      const latest = webhooks[0];
      const p = livePrice ?? latest?.close ?? null;
      const direction = bias === "BULLISH" ? "LONG" : bias === "BEARISH" ? "SHORT" : "WAIT";
      const demoNarrative = `[DEMO MODE — ANTHROPIC_API_KEY not configured]\n\nSetup Score: ${score}/100 | Bias: ${bias} | Live Price: ${p ? `$${p.toLocaleString()}` : "unknown"}\n\nActive Confluences:\n${confluences.map(c => `• ${c}`).join("\n")}\n\n${warnings.length ? `Risk Warnings:\n${warnings.map(w => `⚠ ${w}`).join("\n")}\n\n` : ""}Based on current ICT signals at live price $${p?.toLocaleString() ?? "unknown"}, the market shows a ${bias.toLowerCase()} setup. ${direction === "WAIT" ? "Confluence is mixed — wait for clearer structure." : `Look for ${direction === "LONG" ? "bullish" : "bearish"} confirmation on the 1-minute chart.`}`;

      const analysis = storage.saveAnalysis({
        createdAt: Date.now(),
        latestPrice: p,
        sessionBias: bias,
        setupScore: score,
        tradeDirection: direction,
        entryZone: p ? `${(p - 8).toFixed(2)} - ${(p + 3).toFixed(2)}` : null,
        stopLoss: p ? `${(p - 20).toFixed(2)}` : null,
        target1: p ? `${(p + 25).toFixed(2)}` : null,
        target2: p ? `${(p + 60).toFixed(2)}` : null,
        narrative: demoNarrative,
        confluences: JSON.stringify(confluences),
        warnings: warnings.length ? JSON.stringify(warnings) : null,
        triggeredBy: "manual",
      });
      return res.json(analysis);
    }

    try {
      const livePrice = await fetchLiveNQPrice();
      const prompt = buildAnalysisPrompt(webhooks, score, bias, confluences, warnings, undefined, activeSession, livePrice, tvLatest, scLatest, tvFresh, scFresh, tvAge, scAge);
      const msg = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      });
      const narrative = (msg.content[0] as any).text;
      const latest = webhooks[0];
      const tradePlan = parseTradePlan(narrative, latest, livePrice);
      const direction = bias === "BULLISH" ? "LONG" : bias === "BEARISH" ? "SHORT" : "WAIT";

      const analysis = storage.saveAnalysis({
        createdAt: Date.now(),
        latestPrice: livePrice ?? latest?.close ?? null,
        sessionBias: bias,
        setupScore: score,
        tradeDirection: direction,
        ...tradePlan,
        narrative,
        confluences: JSON.stringify(confluences),
        warnings: warnings.length ? JSON.stringify(warnings) : null,
        triggeredBy: "manual",
      });
      return res.json(analysis);
    } catch (err) {
      console.error("Analyze error:", err);
      return res.status(500).json({ error: "AI analysis failed" });
    }
  });

  // ── POST /api/chat — Personality-aware chat with trash talk detection ─────────
  app.post("/api/chat", async (req, res) => {
    const { message, sessionId } = req.body;
    if (!message || !sessionId) return res.status(400).json({ error: "message and sessionId required" });

    storage.saveChatMessage({ createdAt: Date.now(), role: "user", content: message, sessionId });

    const history  = storage.getChatMessages(sessionId).slice(-10);
    const webhooks = storage.getRecentWebhooks(10);
    const { score, bias, confluences } = scoreSetup(webhooks);
    const latest   = webhooks[0];
    const price    = latest?.close ?? 0;
    const vwap     = latest?.vwap  ?? 0;

    const personality = getPersonality();
    const recentCalls = storage.getRecentCommentary(5).map((c: any) => `${c.title} @ ${c.price?.toLocaleString() || "?"}`);

    const ctx: MarketContext = {
      price, vwap, bias, score,
      killzone: latest?.killzone || "none",
      marketStructure: latest?.marketStructure || "none",
      zone: (latest as any)?.premium ? "premium" : (latest as any)?.discount ? "discount" : "equilibrium",
      confluences: confluences.join(", ") || "none",
      recentPrices: webhooks.slice(0, 5).map((w: any) => w.close?.toLocaleString()).join(" → "),
      priceDirection: "steady",
      time: new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit" }),
      vwapRel: buildVwapRel(price, vwap),
    };

    const talking_trash = isTrashTalk(message);
    const prompt = talking_trash
      ? personality.trashTalkPrompt(ctx, message, recentCalls)
      : personality.chatPrompt(ctx, message, recentCalls);

    if (!process.env.ANTHROPIC_API_KEY) {
      const demoReply = `[DEMO MODE — Add ANTHROPIC_API_KEY for ${personality.name} to go live]\nScore: ${score}/100 | Bias: ${bias}`;
      const reply = storage.saveChatMessage({ createdAt: Date.now(), role: "assistant", content: demoReply, sessionId });
      return res.json({ message: reply });
    }

    try {
      const priorMessages: { role: "user" | "assistant"; content: string }[] = [
        ...history.slice(0, -1).map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user", content: prompt },
      ];

      const msg = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 500,
        system: personality.basePrompt,
        messages: priorMessages,
      });
      const replyText = (msg.content[0] as any).text;
      const reply = storage.saveChatMessage({ createdAt: Date.now(), role: "assistant", content: replyText, sessionId });
      return res.json({ message: reply, personality: personality.id, trash_talk_detected: talking_trash });
    } catch (err) {
      console.error("Chat error:", err);
      return res.status(500).json({ error: "AI chat failed" });
    }
  });

  // ── POST /api/personality — Switch active personality ──────────────────────
  app.post("/api/personality", (req, res) => {
    const { id } = req.body;
    if (!["shark", "suit", "oracle"].includes(id)) {
      return res.status(400).json({ error: "Invalid personality. Use: shark, suit, oracle" });
    }
    setPersonality(id as PersonalityId);
    const p = getPersonality();
    return res.json({ ok: true, personality: { id: p.id, name: p.name, emoji: p.emoji, description: p.description } });
  });

  // ── GET /api/personality — Get active personality ──────────────────────────
  app.get("/api/personality", (req, res) => {
    const p = getPersonality();
    return res.json({ id: p.id, name: p.name, emoji: p.emoji, description: p.description });
  });

  // ── GET/POST /api/session — Get or set active session mode ──────────────────
  let activeSession = "ny"; // default NY session

  app.get("/api/session", (req, res) => {
    return res.json({ session: activeSession });
  });

  app.post("/api/session", (req, res) => {
    const { session } = req.body;
    if (!["asia", "london", "ny"].includes(session))
      return res.status(400).json({ error: "Invalid session. Use: asia, london, ny" });
    activeSession = session;
    return res.json({ session: activeSession });
  });

  // ── GET /api/chat/:sessionId — Get chat history ───────────────────────────
  app.get("/api/chat/:sessionId", (req, res) => {
    const messages = storage.getChatMessages(req.params.sessionId);
    return res.json(messages);
  });

  // ── POST /api/sierra-webhook — Sierra Chart ACSIL order flow receiver ─────
  app.post("/api/sierra-webhook", async (req, res) => {
    try {
      const body = req.body;
      if (!body) return res.status(400).json({ error: "Empty body" });

      // Merge Sierra Chart order flow into webhook payload
      // Sierra sends camelCase keys — map them to our schema
      const payload: InsertWebhookPayload = {
        receivedAt: Date.now(),
        ticker: body.ticker || "NQ1!",
        timeframe: String(body.timeframe || "1"),
        open:   body.open   !== undefined ? Number(body.open)   : null,
        high:   body.high   !== undefined ? Number(body.high)   : null,
        low:    body.low    !== undefined ? Number(body.low)    : null,
        close:  body.close  !== undefined ? Number(body.close)  : null,
        volume: body.volume !== undefined ? Number(body.volume) : null,
        vwap:   body.vwap   !== undefined ? Number(body.vwap)   : null,
        // ICT fields — not provided by Sierra, keep nulls so TV data stays dominant
        killzone: null,
        marketStructure: null,
        fvgBull: 0, fvgBear: 0,
        obBull: 0,  obBear: 0,
        sweepHigh: 0, sweepLow: 0,
        premium: 0, discount: 0,
        rawJson: JSON.stringify(body),
        // Order flow fields from Sierra
        source: "sierra_chart",
        bidStackSize:   body.bidStackSize   !== undefined ? Number(body.bidStackSize)   : null,
        askStackSize:   body.askStackSize   !== undefined ? Number(body.askStackSize)   : null,
        delta:          body.delta          !== undefined ? Number(body.delta)          : null,
        buyVolume:      body.buyVolume      !== undefined ? Number(body.buyVolume)      : null,
        sellVolume:     body.sellVolume     !== undefined ? Number(body.sellVolume)     : null,
        largeTradeCount: body.largeTradeCount !== undefined ? Number(body.largeTradeCount) : null,
        largeBuyCount:  body.largeBuyCount  !== undefined ? Number(body.largeBuyCount)  : null,
        largeSellCount: body.largeSellCount !== undefined ? Number(body.largeSellCount) : null,
        absorptionBull: body.absorptionBull ? 1 : 0,
        absorptionBear: body.absorptionBear ? 1 : 0,
        vapPoc:         body.vapPoc         !== undefined ? Number(body.vapPoc)         : null,
        imbalanceBull:  body.imbalanceBull  ? 1 : 0,
        imbalanceBear:  body.imbalanceBear  ? 1 : 0,
      };

      const saved = storage.saveWebhook(payload);

      // ── Merge with latest TradingView signal for combined analysis ──────────
      // Get the most recent TradingView signal and overlay Sierra order flow
      const recentWebhooks = storage.getRecentWebhooks(10);
      const latestTV = recentWebhooks.find(w => w.source === "tradingview" || w.source === null);

      if (latestTV && saved.delta !== null) {
        // Check if absorption or imbalance warrants a commentary event
        const triggers = [];
        if (saved.absorptionBull) {
          triggers.push({
            type: "absorption" as const,
            urgency: "high" as const,
            title: "Bullish Absorption Detected",
            detail: `Large sell volume (${saved.sellVolume} contracts) absorbed at ${saved.close?.toFixed(2)} — sellers couldn't push price down`,
          });
        }
        if (saved.absorptionBear) {
          triggers.push({
            type: "absorption" as const,
            urgency: "high" as const,
            title: "Bearish Absorption Detected",
            detail: `Large buy volume (${saved.buyVolume} contracts) absorbed at ${saved.close?.toFixed(2)} — buyers couldn't push price up`,
          });
        }
        if (saved.imbalanceBull) {
          triggers.push({
            type: "general" as const,
            urgency: "medium" as const,
            title: "DOM Bid Imbalance",
            detail: `Bid stack (${saved.bidStackSize}) is 3x+ the ask — strong buy-side pressure at ${saved.close?.toFixed(2)}`,
          });
        }
        if (saved.imbalanceBear) {
          triggers.push({
            type: "general" as const,
            urgency: "medium" as const,
            title: "DOM Ask Imbalance",
            detail: `Ask stack (${saved.askStackSize}) is 3x+ the bid — strong sell-side pressure at ${saved.close?.toFixed(2)}`,
          });
        }

        // GATE: only fire Claude commentary once per 15 min from Sierra data
        const nowSierra = Date.now();
        if (triggers.length > 0 && process.env.ANTHROPIC_API_KEY &&
            (nowSierra - lastSierraCommentaryAt) >= SIERRA_COMMENTARY_GATE_MS &&
            claudeGateOpen()) {
          lastSierraCommentaryAt = nowSierra;
          const { score, ictScore, bias, confluences, warnings } = scoreSetup(recentWebhooks);
          const top = triggers[0];
          generateCommentary(top, recentWebhooks, bias, score, ictScore, confluences, warnings)
            .catch(e => console.error("[Sierra Commentary] Error:", e));
        }
      }

      return res.json({ ok: true, id: saved.id, source: "sierra_chart" });
    } catch (err) {
      console.error("[Sierra Webhook] Error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── POST /api/tts — OpenAI Text-to-Speech proxy ──────────────────────────
  app.post("/api/tts", async (req, res) => {
    try {
      const { text, voice = "onyx" } = req.body;
      if (!text) return res.status(400).json({ error: "No text provided" });
      if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OpenAI API key not configured" });

      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: text.slice(0, 4096), // OpenAI max
          voice,
          speed: voice === "onyx" ? 1.05 : 1.0, // Shark talks fast
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error("[TTS] OpenAI error:", err);
        return res.status(502).json({ error: "OpenAI TTS failed" });
      }

      const audioBuffer = await response.arrayBuffer();
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", audioBuffer.byteLength);
      return res.send(Buffer.from(audioBuffer));
    } catch (err) {
      console.error("[TTS] Error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /api/webhook-url — Return the webhook URL hint ───────────────────
  app.get("/api/webhook-url", (req, res) => {
    const host = req.headers.host || "localhost:5000";
    const proto = req.headers["x-forwarded-proto"] || "http";
    return res.json({ url: `${proto}://${host}/api/webhook` });
  });

  // ── GET /api/muzzi-signal — Muzzi checklist evaluation for NinjaTrader bot ──
  app.get("/api/muzzi-signal", (_req, res) => {
    try {
      const freshWebhooks = storage.getRecentWebhooks(20);
      const scored = scoreSetup(freshWebhooks);
      const { tvLatest, scLatest, bias } = scored as any;

      if (!tvLatest && !scLatest) {
        return res.json({ direction: "WAIT", grade: "WAIT", coachingNote: "No live data — both TradingView and Sierra Chart feeds are silent." });
      }

      const mergedData = {
        tv  : tvLatest  || {},
        tv15: (scored as any).tv15Latest || null,
        tv5 : (scored as any).tv5Latest  || null,
        tv1 : (scored as any).tv1Latest  || null,
        sc  : scLatest  || {},
        bias: bias       || "NEUTRAL",
      };

      const muzziSig = buildMuzziSignal(mergedData);
      if (!muzziSig) {
        return res.json({ direction: "WAIT", grade: "WAIT", coachingNote: "Insufficient market data for Muzzi evaluation." });
      }

      return res.json(muzziSig);
    } catch (err) {
      console.error("[muzzi-signal] Error:", err);
      return res.status(500).json({ error: "Muzzi signal evaluation failed" });
    }
  });

  // ── POST /api/learning-kernel/feed — Receive completed trade result from NT bot ──
  app.post("/api/learning-kernel/feed", (req, res) => {
    try {
      const entry = req.body;
      if (!entry || !entry.signalId) {
        return res.status(400).json({ error: "Missing signalId in payload" });
      }
      recordTrade(entry);
      return res.json({ ok: true, message: "Learning kernel updated" });
    } catch (err) {
      console.error("[learning-kernel/feed] Error:", err);
      return res.status(500).json({ error: "Failed to record trade in learning kernel" });
    }
  });

  // ── GET /api/learning-kernel/insights — Win rates, feature weights, recent trades ──
  app.get("/api/learning-kernel/insights", (_req, res) => {
    try {
      return res.json({
        insights: getInsights(),
        weights : getWeights(),
        recent  : getRecentLearningEntries(20),
      });
    } catch (err) {
      return res.status(500).json({ error: "Failed to load learning kernel insights" });
    }
  });

    // ── GET /api/scorecard — Full scorecard history + stats ───────────────────
  app.get("/api/scorecard", (req, res) => {
    const limit = parseInt(String(req.query.limit || "60"));
    const entries = storage.getRecentScorecard(limit);
    const stats = storage.getScorecardStats();
    return res.json({ entries, stats });
  });

  // ── POST /api/scorecard — Upsert a scorecard entry (used by cron) ─────────
  app.post("/api/scorecard", (req, res) => {
    try {
      const entry = storage.upsertScorecardEntry({ ...req.body, createdAt: req.body.createdAt || Date.now() });
      return res.json(entry);
    } catch (err) {
      console.error("Scorecard upsert error:", err);
      return res.status(500).json({ error: "Failed to save scorecard entry" });
    }
  });

  // ── POST /api/scorecard/simulate — Inject demo scorecard data ─────────────
  app.post("/api/scorecard/simulate", async (req, res) => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const liveBase = await fetchLiveNQPrice() ?? (storage.getRecentWebhooks(1)[0]?.close ?? 29900);
    const b = Math.round(liveBase * 4) / 4;
    const demoEntry = {
      sessionDate: today,
      createdAt: Date.now(),
      morningBias: "BULLISH",
      morningScore: 72,
      setup1Name: "London Sweep → NY Reversal Long",
      setup1Direction: "LONG",
      setup1Entry: b - 30,
      setup1Sl: b - 52,
      setup1Tp1: b + 5,
      setup1Tp2: b + 60,
      setup1Confluences: JSON.stringify(["London low swept", "Bullish FVG", "NY Open killzone", "Discount zone"]),
      setup1Outcome: "TP2",
      setup1EntryTriggered: 1,
      setup1Tp1Hit: 1,
      setup1Tp2Hit: 1,
      setup1Stopped: 0,
      setup1PnlPts: 90,
      setup2Name: "VWAP Rejection Short",
      setup2Direction: "SHORT",
      setup2Entry: b + 60,
      setup2Sl: b + 82,
      setup2Tp1: b + 25,
      setup2Tp2: b - 10,
      setup2Confluences: JSON.stringify(["Bearish OB at VWAP", "Premium zone", "NY close killzone"]),
      setup2Outcome: "NO_TRIGGER",
      setup2EntryTriggered: 0,
      setup2Tp1Hit: 0,
      setup2Tp2Hit: 0,
      setup2Stopped: 0,
      setup2PnlPts: 0,
      sessionHigh: b + 68,
      sessionLow: b - 62,
      sessionOpen: b - 28,
      sessionClose: b + 50,
      actualDirection: "UP",
      biasCorrect: 1,
      reviewNarrative: `[DEMO] Perfect ICT playbook day. London swept the Asian low, creating the liquidity grab that fueled the NY morning pump. Setup 1 played out cleanly: price tapped the FVG at ${(b-30).toLocaleString()}, bounced with strong delta, and ran all the way to TP2 at ${(b+60).toLocaleString()}. Setup 2 never triggered — price stalled just below the entry zone before the close. Bias was correct. Key win: trusting the London sweep thesis instead of fading the initial push.`,
      keyLessons: JSON.stringify(["London sweep thesis was the highest-conviction signal of the day", "FVG fill + positive delta = high-probability long", "TP2 patience rewarded — don't take all off at TP1 on clean ICT setups"]),
      rollingWinRate: 65,
      rollingBiasAccuracy: 72,
      rollingAvgPnlPts: 38.5,
    };
    try {
      const entry = storage.upsertScorecardEntry(demoEntry as any);
      return res.json({ ok: true, entry });
    } catch (err) {
      console.error("Scorecard simulate error:", err);
      return res.status(500).json({ error: "Simulate failed" });
    }
  });

  // ── GET /api/trade-signal/pending — Return oldest pending signal ─────────
  app.get("/api/trade-signal/pending", (_req, res) => {
    const signal = getPendingSignal();
    return res.json(signal ?? {});
  });

  // ── POST /api/trade-signal/confirm — Confirm receipt of a signal ───────────
  app.post("/api/trade-signal/confirm", (req, res) => {
    const { id, status } = req.body as { id: string; status?: string };
    if (!id) return res.status(400).json({ error: "id required" });
    confirmSignal(id);
    // Allow caller to also pass an updated status (e.g. 'filled')
    if (status && status !== 'pending') {
      updateSignalResult(id, { status: status as any });
    }
    return res.json({ ok: true, id });
  });

  // ── POST /api/trade-signal/result — Update fill/close data ────────────────
  app.post("/api/trade-signal/result", (req, res) => {
    const { id, ...rest } = req.body as { id: string; [key: string]: any };
    if (!id) return res.status(400).json({ error: "id required" });
    updateSignalResult(id, rest);
    return res.json({ ok: true, id });
  });

  // ── GET /api/trade-signal/history — Last 50 signals with outcomes ──────────
  app.get("/api/trade-signal/history", (_req, res) => {
    return res.json(getRecentSignals(50));
  });

  // ── GET /api/trade-signal/stats — Aggregated performance stats ────────────
  app.get("/api/trade-signal/stats", (_req, res) => {
    return res.json(getSignalStats());
  });

  // ── GET /api/commentary — Live commentary feed ─────────────────────────────
  app.get("/api/commentary", (req, res) => {
    const limit = parseInt(String(req.query.limit || "30"));
    const items = storage.getRecentCommentary(limit);
    return res.json(items);
  });

  // ── POST /api/commentary/simulate — Inject demo commentary ─────────────────
  app.post("/api/commentary/simulate", async (req, res) => {
    const webhooks = storage.getRecentWebhooks(10);
    const { score, ictScore, orderFlowScore, bias, confluences, orderFlowConfluences, warnings } = scoreSetup(webhooks);
    const latest = webhooks[0];
    const price = latest?.close ?? (await fetchLiveNQPrice()) ?? 29900;

    const demoTriggers = [
      { type: "bias_change" as const, urgency: "high" as const, title: "⚡ Bias Flip: BEARISH → BULLISH", reason: "CHoCH printed on 15m with low swept and FVG fill", source: "demo_bias" },
      { type: "absorption" as const, urgency: "high" as const, title: "🟢 Bull Absorption Detected", reason: "Large sell order fully absorbed at bid — 450 contract print at "+price, source: "demo_absorption" },
      { type: "reversal" as const, urgency: "high" as const, title: "💧 Low Swept — Bullish Entry Window", reason: "Buy-side liquidity taken below session low — ICT reversal setup", source: "demo_sweep" },
      { type: "continuation" as const, urgency: "medium" as const, title: "📊 BOS Confirmed — Bullish Continuation", reason: "Break of Structure on 15m — trend continuation, add to longs", source: "demo_bos" },
      { type: "general" as const, urgency: "low" as const, title: "📊 Market Update", reason: "Periodic state summary", source: "demo_periodic" },
    ];
    const pick = demoTriggers[Math.floor(Math.random() * demoTriggers.length)];

    const fallbackWebhook: any = {
      id: 1, receivedAt: Date.now(), ticker: "NQ1!", timeframe: "15",
      open: price, high: price+20, low: price-15, close: price, volume: 12000,
      vwap: price-5, killzone: "ny_open", marketStructure: "BOS_bull",
      fvgBull: 1, fvgBear: 0, obBull: 0, obBear: 0, sweepHigh: 0, sweepLow: 1,
      premium: 0, discount: 1, rawJson: null, source: "tradingview",
      bidStackSize: null, askStackSize: null, delta: null, buyVolume: null,
      sellVolume: null, largeTradeCount: null, largeBuyCount: null,
      largeSellCount: null, absorptionBull: 0, absorptionBear: 0,
      vapPoc: null, imbalanceBull: 0, imbalanceBear: 0,
    };

    await generateCommentary(
      pick,
      webhooks.length ? webhooks : [fallbackWebhook],
      bias || "BULLISH", score || 65, ictScore || 50, orderFlowScore || 0,
      confluences, orderFlowConfluences, warnings
    );

    return res.json({ ok: true });
  });
}
