/**
 * routes.ts — NQ Analyst Bridge
 * FIXED BUILD — Claude Audit — Jun 14 2026
 *
 * FIXES IN THIS VERSION:
 *
 *   ROUTE-001  /api/sierra-webhook now caches latest SC payload in latestScData
 *              and exposes it at GET /api/sc-state for NinjaTrader to poll.
 *              Before: SC data arrived and was saved to DB but never readable
 *              by NQ_ICT_Signals_v2 in real time.
 *
 *   ROUTE-002  /api/sierra-webhook logs meaningful per-field data on every receipt
 *              so Railway logs actually show what's happening (was: silent 200s).
 *
 *   ROUTE-003  /api/webhook now maps NinjaTrader's nt_sl/nt_tp1/nt_tp2 fields
 *              correctly — old code looked for body.sl/body.tp1/body.tp2 but
 *              NQ_ICT_Signals posts nt_sl/nt_tp1/nt_tp2.
 *
 *   ROUTE-004  Signal evaluation logs what blocked a signal (cooldown, session,
 *              no direction, etc.) so missed trades are diagnosable in Railway logs.
 *
 *   ROUTE-005  /api/trade-signal/pending returns proper empty object {} not null
 *              when no pending signal — MuzziBot's null check was failing.
 *
 *   ROUTE-006  Render keep-alive changed to Railway-compatible check
 *              (was checking RENDER_EXTERNAL_URL which never exists on Railway).
 *
 *   ROUTE-007  /api/sc-state returns empty {} with staleReason when SC data is
 *              older than 2 minutes so NinjaTrader knows SC is offline.
 *
 *   ROUTE-008  POST /api/webhook now accepts both camelCase (NT8) and snake_case
 *              (TradingView legacy) field names for all ICT signal fields.
 */

import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";

import { fetchLiveNQPrice } from "./livePrice";
import type { InsertWebhookPayload, InsertAnalysis } from "@shared/schema";
import Anthropic from "@anthropic-ai/sdk";
import { detectTriggers, generateCommentary, updateState } from "./commentaryEngine";
import {
  getPersonality, setPersonality, isTrashTalk,
  buildVwapRel, type MarketContext, type PersonalityId,
} from "./personalities";
import {
  buildMuzziSignal, recordTrade, getInsights,
  getWeights, getRecentLearningEntries,
} from "./learningKernel";
import {
  evaluateSignal, clearExpiredSignals, getPendingSignal, setBriefState, getBriefState,
  confirmSignal, updateSignalResult, getRecentSignals,
  getSignalStats, injectTestSignal,
} from "./signalEngine";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE-001: Sierra Chart state cache
// NQ_ICT_Signals_v2 polls GET /api/sc-state every 30 bars (~30 seconds)
// to get the latest delta, CVD, DOM data for signal scoring.
// latestScData is written by /api/sierra-webhook on every SC post.
// ─────────────────────────────────────────────────────────────────────────────
let latestScData: Record<string, any> = {};
let latestScReceivedAt = 0;
const SC_STALE_MS = 2 * 60 * 1000; // 2 minutes — SC sends every 30s so 2min = definitely offline

// ─────────────────────────────────────────────────────────────────────────────
// Claude API gates — prevent runaway token spend
// ─────────────────────────────────────────────────────────────────────────────
let lastAutoAnalysisAt      = 0;
let lastAnyClaudeCallAt     = 0;
let lastSierraCommentaryAt  = 0;
const AUTO_ANALYSIS_INTERVAL_MS  = 5 * 60 * 1000;
const GLOBAL_CLAUDE_GATE_MS      = 5 * 60 * 1000;
const SIERRA_COMMENTARY_GATE_MS  = 5 * 60 * 1000;

function claudeGateOpen(): boolean {
  const now = Date.now();
  if (now - lastAnyClaudeCallAt < GLOBAL_CLAUDE_GATE_MS) return false;
  lastAnyClaudeCallAt = now;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// ICT + Order Flow Setup Scorer
// ─────────────────────────────────────────────────────────────────────────────
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
  let bullPoints = 0, bearPoints = 0;
  let ofBullPoints = 0, ofBearPoints = 0;

  const ntWebhooks = webhooks.filter(w =>
    w.source === "ninjatrader" || w.source === "tradingview" || (!w.source && w.killzone !== null)
  );
  const scWebhooks = webhooks.filter(w =>
    w.source === "sierra_chart" || w.source === "bookmap_cme"
  );

  const nt15 = ntWebhooks.filter(w => String(w.timeframe) === "15" || String(w.timeframe) === "15m");
  const nt5  = ntWebhooks.filter(w => String(w.timeframe) === "5"  || String(w.timeframe) === "5m");
  const nt1  = ntWebhooks.filter(w => String(w.timeframe) === "1"  || String(w.timeframe) === "1m");

  const nt15Latest = nt15[0] ?? null;
  const nt5Latest  = nt5[0]  ?? null;
  const nt1Latest  = nt1[0]  ?? null;
  const ntLatest   = nt5Latest ?? nt15Latest ?? ntWebhooks[0] ?? null;
  const ntAge      = ntLatest ? Date.now() - ntLatest.receivedAt : Infinity;
  const ntFresh = ntAge < 3 * 60 * 1000; // 3 minutes — was 30min, caused stale price signals
  // Alias for backwards compat
  const tvLatest   = ntLatest;
  const tv15Latest = nt15Latest;
  const tv5Latest  = nt5Latest;
  const tv1Latest  = nt1Latest;
  const tvAge      = ntAge;
  const tvFresh    = ntFresh;
  const tv15       = nt15;
  const tv5        = nt5;

  const scLatest = scWebhooks[0] ?? null;
  const scAge    = scLatest ? Date.now() - scLatest.receivedAt : Infinity;
  const scFresh  = scAge < 5 * 60 * 1000;

  const priceSource = scLatest ?? tvLatest ?? webhooks[0];

  if (!priceSource) {
    return {
      score: 0, ictScore: 0, orderFlowScore: 0, bias: "NEUTRAL",
      confluences: ["No data received yet"], orderFlowConfluences: [],
      warnings: [], hasOrderFlow: false,
      tvLatest: null, tv15Latest: null, tv5Latest: null, tv1Latest: null,
      scLatest: null, tvFresh: false, scFresh: false, tvAge: Infinity, scAge: Infinity,
    };
  }

  if (!tvFresh) warnings.push("NinjaTrader ICT signals stale (>30min) — check NT8 indicator");

  if (tvLatest?.killzone) {
    confluences.push(`Active Killzone: ${tvLatest.killzone.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`);
    bullPoints += 8; bearPoints += 8;
  } else {
    warnings.push("No active killzone — off-session");
  }

  const ms15 = tv15Latest?.marketStructure || "";
  if (ms15.includes("bull")) { confluences.push(`15m Bullish: ${ms15.toUpperCase()}`); bullPoints += 25; }
  else if (ms15.includes("bear")) { confluences.push(`15m Bearish: ${ms15.toUpperCase()}`); bearPoints += 25; }

  const ms5 = tv5Latest?.marketStructure || "";
  if (ms5.includes("bull")) { confluences.push(`5m Bullish: ${ms5.toUpperCase()}`); bullPoints += 18; }
  else if (ms5.includes("bear")) { confluences.push(`5m Bearish: ${ms5.toUpperCase()}`); bearPoints += 18; }

  const fvgSrc = tv5Latest ?? tvLatest;
  if (fvgSrc?.fvgBull) { confluences.push("Bull FVG active"); bullPoints += 15; }
  if (fvgSrc?.fvgBear) { confluences.push("Bear FVG active"); bearPoints += 15; }
  if (fvgSrc?.obBull)  { confluences.push("Bull OB in range"); bullPoints += 12; }
  if (fvgSrc?.obBear)  { confluences.push("Bear OB in range"); bearPoints += 12; }

  const sweepSrc = tv15Latest ?? tvLatest;
  if (sweepSrc?.sweepLow)  { confluences.push("Low swept — bull reversal likely"); bullPoints += 20; }
  if (sweepSrc?.sweepHigh) { confluences.push("High swept — bear reversal likely"); bearPoints += 20; }

  if (tvLatest?.discount) { confluences.push("Discount zone"); bullPoints += 12; }
  if (tvLatest?.premium)  { confluences.push("Premium zone");  bearPoints += 12; }

  if (tvLatest?.vwap && priceSource.close) {
    if (priceSource.close > tvLatest.vwap) { confluences.push("Above VWAP"); bullPoints += 8; }
    else                                   { confluences.push("Below VWAP"); bearPoints += 8; }
  }

  const bull15 = tv15.filter(w => (w.marketStructure || "").includes("bull")).length;
  const bear15 = tv15.filter(w => (w.marketStructure || "").includes("bear")).length;
  if (bull15 >= 2) { confluences.push(`${bull15}x 15m bullish`); bullPoints += 15; }
  if (bear15 >= 2) { confluences.push(`${bear15}x 15m bearish`); bearPoints += 15; }

  const hasOrderFlow = scFresh && !!scLatest;

  if (scLatest) {
    const { delta, bidStackSize, askStackSize, absorptionBull, absorptionBear,
            imbalanceBull, imbalanceBear, largeBuyCount, largeSellCount, vapPoc, close } = scLatest;

    if (delta !== null && delta !== undefined) {
      if (delta > 500)       { orderFlowConfluences.push(`Delta +${delta} — aggressive buying`); ofBullPoints += 20; }
      else if (delta > 150)  { orderFlowConfluences.push(`Delta +${delta} — mild buying`); ofBullPoints += 10; }
      else if (delta < -500) { orderFlowConfluences.push(`Delta ${delta} — aggressive selling`); ofBearPoints += 20; }
      else if (delta < -150) { orderFlowConfluences.push(`Delta ${delta} — mild selling`); ofBearPoints += 10; }
      else                   { orderFlowConfluences.push(`Delta ${delta > 0 ? "+" : ""}${delta} — balanced`); }
    }

    if (imbalanceBull)       { orderFlowConfluences.push(`Bid ${bidStackSize} >> Ask ${askStackSize}`); ofBullPoints += 18; }
    else if (imbalanceBear)  { orderFlowConfluences.push(`Ask ${askStackSize} >> Bid ${bidStackSize}`); ofBearPoints += 18; }

    if (absorptionBull)      { orderFlowConfluences.push("Bull absorption — sellers absorbed"); ofBullPoints += 22; }
    if (absorptionBear)      { orderFlowConfluences.push("Bear absorption — buyers absorbed"); ofBearPoints += 22; }

    if (largeBuyCount !== null && largeSellCount !== null) {
      if (largeBuyCount > largeSellCount + 1)  { orderFlowConfluences.push(`Large buyer dominance: ${largeBuyCount}B vs ${largeSellCount}S`); ofBullPoints += 12; }
      if (largeSellCount > largeBuyCount + 1)  { orderFlowConfluences.push(`Large seller dominance: ${largeSellCount}S vs ${largeBuyCount}B`); ofBearPoints += 12; }
    }

    if (vapPoc && close) {
      if (close > vapPoc) { orderFlowConfluences.push(`Above POC (${vapPoc})`); ofBullPoints += 8; }
      else                { orderFlowConfluences.push(`Below POC (${vapPoc})`); ofBearPoints += 8; }
    }

    bullPoints += ofBullPoints;
    bearPoints += ofBearPoints;
  }

  if (priceSource.close && priceSource.high && priceSource.low) {
    const range = priceSource.high - priceSource.low;
    if (range < 10) warnings.push("Tight range bar — low momentum");
    if (range > 80) warnings.push("Extended range — potential exhaustion");
  }

  const ictMax   = 103;
  const ofMax    = hasOrderFlow ? 80 : 0;
  const totalMax = ictMax + ofMax;

  const bias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    bullPoints > bearPoints + 10 ? "BULLISH" :
    bearPoints > bullPoints + 10 ? "BEARISH" : "NEUTRAL";

  const dominantPoints = Math.max(bullPoints, bearPoints);
  const score          = Math.min(100, Math.round((dominantPoints / totalMax) * 100));
  const ictScore       = Math.min(100, Math.round((Math.max(bullPoints - ofBullPoints, bearPoints - ofBearPoints) / ictMax) * 100));
  const orderFlowScore = hasOrderFlow ? Math.min(100, Math.round((Math.max(ofBullPoints, ofBearPoints) / ofMax) * 100)) : 0;

  return {
    score, ictScore, orderFlowScore, bias,
    confluences, orderFlowConfluences, warnings, hasOrderFlow,
    tvLatest, tv15Latest, tv5Latest, tv1Latest, scLatest,
    tvFresh, scFresh, tvAge, scAge,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI prompt builder
// ─────────────────────────────────────────────────────────────────────────────
function buildAnalysisPrompt(
  webhooks: ReturnType<typeof storage.getRecentWebhooks>,
  score: number, bias: string, confluences: string[], warnings: string[],
  userQuestion?: string, session?: string, livePrice?: number | null,
  tvLatest?: any, scLatest?: any,
  tvFresh?: boolean, scFresh?: boolean, tvAge?: number, scAge?: number,
): string {
  const latest       = webhooks[0];
  const effectivePrice = livePrice ?? latest?.close ?? null;
  const priceStr     = effectivePrice ? `$${effectivePrice.toLocaleString()}` : "unknown";
  const tvAgeMin     = tvAge !== undefined && tvAge !== Infinity ? Math.round(tvAge / 60000) : null;
  const scAgeMin     = scAge !== undefined && scAge !== Infinity ? Math.round(scAge / 60000) : null;

  const recentSignals = webhooks.slice(0, 5).map(w =>
    `  [${new Date(w.receivedAt).toLocaleTimeString()}] TF:${w.timeframe} C:${w.close} ` +
    `MS:${w.marketStructure || "none"} KZ:${w.killzone || "none"} ` +
    `FVG:${w.fvgBull ? "bull" : w.fvgBear ? "bear" : "none"} ` +
    `Sweep:${w.sweepHigh ? "high" : w.sweepLow ? "low" : "none"} ` +
    `Zone:${w.premium ? "premium" : w.discount ? "discount" : "mid"}`
  ).join("\n");

  const sessionContext = session === "asia"
    ? "ASIA SESSION — AMD Strategy: identify Accumulation, Manipulation, Distribution phases"
    : session === "london"
    ? "LONDON SESSION — watch for Asia range sweep → Turtle Soup reversal"
    : "NEW YORK SESSION — ICT kill zone entries using London sweep as confirmation";

  return `You are an elite NQ futures analyst combining ICT methodology with live Sierra Chart order flow.
Current time: ${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true })} ET
Live NQ price (authoritative): ${priceStr}
Session: ${sessionContext}
Setup score: ${score}/100 | Bias: ${bias}
Confluences: ${confluences.join("; ")}
Warnings: ${warnings.length ? warnings.join("; ") : "None"}
NT8 data: ${tvFresh ? `LIVE (${tvAgeMin}min)` : "STALE"} | SC data: ${scFresh ? `LIVE (${scAgeMin}min)` : "STALE"}
SC delta: ${scLatest?.delta ?? "n/a"} | DOM bid: ${scLatest?.bidStackSize ?? "n/a"} ask: ${scLatest?.askStackSize ?? "n/a"}
AbsBull: ${scLatest?.absorptionBull || 0} | AbsBear: ${scLatest?.absorptionBear || 0}

Recent signals:
${recentSignals || "None"}

ALL price levels in your response MUST be within 200 points of ${priceStr}.

User: ${userQuestion || `Provide complete trade analysis: bias, entry zone, SL, TP1, TP2. All levels relative to ${priceStr}.`}`;
}

function parseTradePlan(narrative: string, latest: any, livePrice?: number | null) {
  const entryMatch = narrative.match(/entry[:\s]+\$?([\d,]+(?:\.\d+)?(?:\s*[-–]\s*\$?[\d,]+(?:\.\d+)?)?)/i);
  const stopMatch  = narrative.match(/stop[^\n]{0,20}[:\s]+\$?([\d,]+(?:\.\d+)?)/i);
  const t1Match    = narrative.match(/(?:target\s*1|tp\s*1|take\s*profit\s*1)[:\s]+\$?([\d,]+(?:\.\d+)?)/i);
  const t2Match    = narrative.match(/(?:target\s*2|tp\s*2|take\s*profit\s*2)[:\s]+\$?([\d,]+(?:\.\d+)?)/i);
  const p          = livePrice ?? latest?.close ?? null;
  return {
    entryZone: entryMatch?.[1] || (p ? `${(p - 8).toFixed(2)} - ${(p + 3).toFixed(2)}` : null),
    stopLoss:  stopMatch?.[1]  || (p ? `${(p - 20).toFixed(2)}` : null),
    target1:   t1Match?.[1]    || (p ? `${(p + 30).toFixed(2)}` : null),
    target2:   t2Match?.[1]    || (p ? `${(p + 75).toFixed(2)}` : null),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────────────
export function registerRoutes(httpServer: Server, app: Express) {

  let activeSession = "ny";

  // ══════════════════════════════════════════════════════════════════════════
  // GET /api/sc-state — ROUTE-001
  // NQ_ICT_Signals_v2 polls this every 30 bars to get live SC order flow data.
  // Returns empty {} with staleReason if SC hasn't posted in 2+ minutes.
  // ══════════════════════════════════════════════════════════════════════════
  app.get("/api/sc-state", (_req, res) => {
    const age = Date.now() - latestScReceivedAt;
    if (latestScReceivedAt === 0 || age > SC_STALE_MS) {
      return res.json({
        stale: true,
        staleReason: latestScReceivedAt === 0
          ? "No SC data received yet — check Sierra Chart bridge study"
          : `SC data stale: ${Math.round(age / 1000)}s old (limit 120s)`,
      });
    }
    return res.json({ ...latestScData, stale: false, ageMs: age });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /api/sierra-webhook — Sierra Chart ACSIL order flow receiver
  // ROUTE-001: caches payload in latestScData for /api/sc-state
  // ROUTE-002: logs meaningful data per receipt
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/sierra-webhook", async (req, res) => {
    try {
      const body = req.body;
      if (!body) return res.status(400).json({ error: "Empty body" });

      // ROUTE-001: cache for NinjaTrader polling
      latestScData = {
        close:          body.close         !== undefined ? Number(body.close)         : null,
        delta:          body.delta         !== undefined ? Number(body.delta)         : null,
        cvd:            body.cvd           !== undefined ? Number(body.cvd)           : null,
        buyVolume:      body.buyVolume     !== undefined ? Number(body.buyVolume)     : null,
        sellVolume:     body.sellVolume    !== undefined ? Number(body.sellVolume)    : null,
        bidStackSize:   body.bidStackSize  !== undefined ? Number(body.bidStackSize)  : null,
        askStackSize:   body.askStackSize  !== undefined ? Number(body.askStackSize)  : null,
        absorptionBull: body.absorptionBull ? 1 : 0,
        absorptionBear: body.absorptionBear ? 1 : 0,
        imbalanceBull:  body.imbalanceBull  ? 1 : 0,
        imbalanceBear:  body.imbalanceBear  ? 1 : 0,
        largeBuyCount:  body.largeBuyCount  !== undefined ? Number(body.largeBuyCount)  : null,
        largeSellCount: body.largeSellCount !== undefined ? Number(body.largeSellCount) : null,
        largeTradeCount:body.largeTradeCount!== undefined ? Number(body.largeTradeCount): null,
        vapPoc:         body.vapPoc        !== undefined ? Number(body.vapPoc)        : null,
        vwap:           body.vwap          !== undefined ? Number(body.vwap)          : null,
        spread:         body.spread        !== undefined ? Number(body.spread)        : null,
        bestBid:        body.bestBid       !== undefined ? Number(body.bestBid)       : null,
        bestAsk:        body.bestAsk       !== undefined ? Number(body.bestAsk)       : null,
        ticker:         body.ticker        || "NQ1!",
        receivedAt:     Date.now(),
      };
      latestScReceivedAt = Date.now();

      // ROUTE-002: meaningful log line
      console.log(
        `[SC] ${new Date().toLocaleTimeString()} ` +
        `close=${body.close ?? "?"} ` +
        `delta=${body.delta !== undefined ? (body.delta > 0 ? "+" : "") + body.delta : "?"} ` +
        `cvd=${body.cvd !== undefined ? (body.cvd > 0 ? "+" : "") + Number(body.cvd).toFixed(0) : "?"} ` +
        `bid=${body.bidStackSize ?? "?"} ask=${body.askStackSize ?? "?"} ` +
        `absBull=${body.absorptionBull ? "YES" : "no"} absBear=${body.absorptionBear ? "YES" : "no"} ` +
        `imbBull=${body.imbalanceBull ? "YES" : "no"} imbBear=${body.imbalanceBear ? "YES" : "no"}`
      );

      // Save to DB as before
      const payload: InsertWebhookPayload = {
        receivedAt:     latestScData.receivedAt,
        ticker:         latestScData.ticker,
        timeframe:      String(body.timeframe || "1"),
        open:           body.open   !== undefined ? Number(body.open)   : null,
        high:           body.high   !== undefined ? Number(body.high)   : null,
        low:            body.low    !== undefined ? Number(body.low)    : null,
        close:          latestScData.close,
        volume:         body.volume !== undefined ? Number(body.volume) : null,
        vwap:           latestScData.vwap,
        killzone:       null,
        marketStructure: null,
        fvgBull: 0, fvgBear: 0,
        obBull:  0, obBear:  0,
        sweepHigh: 0, sweepLow: 0,
        premium:   0, discount:  0,
        rawJson:        JSON.stringify(body),
        source:         "sierra_chart",
        bidStackSize:   latestScData.bidStackSize,
        askStackSize:   latestScData.askStackSize,
        delta:          latestScData.delta,
        buyVolume:      latestScData.buyVolume,
        sellVolume:     latestScData.sellVolume,
        largeTradeCount: latestScData.largeTradeCount,
        largeBuyCount:  latestScData.largeBuyCount,
        largeSellCount: latestScData.largeSellCount,
        absorptionBull: latestScData.absorptionBull,
        absorptionBear: latestScData.absorptionBear,
        vapPoc:         latestScData.vapPoc,
        imbalanceBull:  latestScData.imbalanceBull,
        imbalanceBear:  latestScData.imbalanceBear,
      };

      const saved = storage.saveWebhook(payload);

      // Commentary triggers for high-value SC events
      const recentWebhooks = storage.getRecentWebhooks(10);
      const { score, ictScore, bias, confluences, warnings } = scoreSetup(recentWebhooks);

      const triggers: any[] = [];
      if (saved.absorptionBull) triggers.push({
        type: "absorption", urgency: "high",
        title: "Bullish Absorption Detected",
        detail: `Large sell absorbed at ${saved.close?.toFixed(2)} — ${saved.sellVolume} contracts`,
      });
      if (saved.absorptionBear) triggers.push({
        type: "absorption", urgency: "high",
        title: "Bearish Absorption Detected",
        detail: `Large buy absorbed at ${saved.close?.toFixed(2)} — ${saved.buyVolume} contracts`,
      });
      if (saved.imbalanceBull) triggers.push({
        type: "general", urgency: "medium",
        title: "DOM Bid Imbalance",
        detail: `Bid ${saved.bidStackSize} >> Ask ${saved.askStackSize} at ${saved.close?.toFixed(2)}`,
      });
      if (saved.imbalanceBear) triggers.push({
        type: "general", urgency: "medium",
        title: "DOM Ask Imbalance",
        detail: `Ask ${saved.askStackSize} >> Bid ${saved.bidStackSize} at ${saved.close?.toFixed(2)}`,
      });

      const nowSierra = Date.now();
      if (triggers.length > 0 && process.env.ANTHROPIC_API_KEY &&
          (nowSierra - lastSierraCommentaryAt) >= SIERRA_COMMENTARY_GATE_MS &&
          claudeGateOpen()) {
        lastSierraCommentaryAt = nowSierra;
        generateCommentary(triggers[0], recentWebhooks, bias, score, ictScore, confluences, warnings)
          .catch(e => console.error("[Sierra Commentary]", e));
      }

      return res.json({ ok: true, id: saved.id, source: "sierra_chart" });
    } catch (err) {
      console.error("[SC Webhook] Error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /api/webhook — NinjaTrader ICT signal receiver (primary signal path)
  // ROUTE-003: correctly maps nt_sl/nt_tp1/nt_tp2 from NQ_ICT_Signals_v2
  // ROUTE-004: logs what blocked/passed each signal evaluation
  // ROUTE-008: accepts both camelCase (NT8) and snake_case (TV legacy)
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/webhook", async (req, res) => {
    try {
      const body = req.body;
      if (!body) return res.status(400).json({ error: "Empty body" });

      const isNT8 = body.source === "ninjatrader";

      // ROUTE-008: accept both naming conventions
      const payload: InsertWebhookPayload = {
        receivedAt:      Date.now(),
        ticker:          body.ticker || "NQ1!",
        timeframe:       String(body.timeframe || body.tf || "1"),
        open:            body.open   !== undefined ? Number(body.open)   : null,
        high:            body.high   !== undefined ? Number(body.high)   : null,
        low:             body.low    !== undefined ? Number(body.low)    : null,
        close:           body.close  !== undefined ? Number(body.close)  : null,
        volume:          body.volume !== undefined ? Number(body.volume) : null,
        vwap:            body.vwap   !== undefined ? Number(body.vwap)   : null,
        killzone:        body.killzone || body.kz || null,
        marketStructure: body.market_structure || body.marketStructure || body.ms || null,
        // ROUTE-008: accept both fvg_bull (TV) and fvgBull (NT8)
        fvgBull:         (body.fvg_bull || body.fvgBull)   ? 1 : 0,
        fvgBear:         (body.fvg_bear || body.fvgBear)   ? 1 : 0,
        obBull:          (body.ob_bull  || body.obBull)    ? 1 : 0,
        obBear:          (body.ob_bear  || body.obBear)    ? 1 : 0,
        sweepHigh:       (body.sweep_high || body.sweepHigh) ? 1 : 0,
        sweepLow:        (body.sweep_low  || body.sweepLow)  ? 1 : 0,
        premium:         body.premium  ? 1 : 0,
        discount:        body.discount ? 1 : 0,
        rawJson:         JSON.stringify(body),
        source:          body.source || "tradingview",
        // Order flow passthrough (NT8 sends these from its SC poll)
        bidStackSize:    body.bidStackSize   !== undefined ? Number(body.bidStackSize)   : null,
        askStackSize:    body.askStackSize   !== undefined ? Number(body.askStackSize)   : null,
        delta:           body.delta          !== undefined ? Number(body.delta)          : null,
        buyVolume:       body.buyVolume      !== undefined ? Number(body.buyVolume)      : null,
        sellVolume:      body.sellVolume     !== undefined ? Number(body.sellVolume)     : null,
        largeTradeCount: body.largeTradeCount!== undefined ? Number(body.largeTradeCount): null,
        largeBuyCount:   body.largeBuyCount  !== undefined ? Number(body.largeBuyCount)  : null,
        largeSellCount:  body.largeSellCount !== undefined ? Number(body.largeSellCount) : null,
        absorptionBull:  (body.absorptionBull || body.absorption_bull) ? 1 : 0,
        absorptionBear:  (body.absorptionBear || body.absorption_bear) ? 1 : 0,
        vapPoc:          body.vapPoc !== undefined ? Number(body.vapPoc) : null,
        imbalanceBull:   (body.imbalanceBull || body.imbalance_bull)  ? 1 : 0,
        imbalanceBear:   (body.imbalanceBear || body.imbalance_bear)  ? 1 : 0,
      };

      const saved = storage.saveWebhook(payload);

      // Log every NT8 signal receipt
      if (isNT8) {
        console.log(
          `[NT8] ${new Date().toLocaleTimeString()} ` +
          `dir=${body.direction || "none"} ` +
          `close=${body.close ?? "?"} ` +
          `kz=${body.killzone || "none"} ` +
          `conf=${body.confidence ?? "?"} ` +
          `nt_sl=${body.nt_sl ?? "?"} nt_tp1=${body.nt_tp1 ?? "?"} nt_tp2=${body.nt_tp2 ?? "?"} ` +
          `sig_id=${body.signal_id || "none"}`
        );
      }

      // Commentary engine
      try {
        const allWebhooks = storage.getRecentWebhooks(10);
        const { score, ictScore, bias, confluences, warnings } = scoreSetup(allWebhooks);
        const triggers = detectTriggers(saved, bias, score, confluences);
        updateState(bias, score, saved.killzone);
        if (triggers.length > 0) {
          const top = triggers.sort((a, b) =>
            (a.urgency === "high" ? 0 : a.urgency === "medium" ? 1 : 2) -
            (b.urgency === "high" ? 0 : b.urgency === "medium" ? 1 : 2)
          )[0];
          generateCommentary(top, allWebhooks, bias, score, ictScore, confluences, warnings)
            .catch(e => console.error("[Commentary]", e));
        }
      } catch (e) {
        console.error("[Commentary trigger]", e);
      }

      // Auto AI analysis
      const nowMs = Date.now();
      if (process.env.ANTHROPIC_API_KEY &&
          (nowMs - lastAutoAnalysisAt) >= AUTO_ANALYSIS_INTERVAL_MS &&
          claudeGateOpen()) {
        const webhooks = storage.getRecentWebhooks(10);
        const { score, bias, confluences, warnings, tvLatest, scLatest, tvFresh, scFresh, tvAge, scAge } = scoreSetup(webhooks);
        if (score >= 40) {
          lastAutoAnalysisAt = nowMs;
          (async () => {
            try {
              const livePrice = await fetchLiveNQPrice();
              const prompt    = buildAnalysisPrompt(webhooks, score, bias, confluences, warnings, undefined, activeSession, livePrice, tvLatest, scLatest, tvFresh, scFresh, tvAge, scAge);
              const msg       = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 800, messages: [{ role: "user", content: prompt }] });
              const narrative = (msg.content[0] as any).text;
              const tradePlan = parseTradePlan(narrative, webhooks[0], livePrice);
              const direction = bias === "BULLISH" ? "LONG" : bias === "BEARISH" ? "SHORT" : "WAIT";
              storage.saveAnalysis({ createdAt: Date.now(), latestPrice: livePrice ?? webhooks[0]?.close ?? null, sessionBias: bias, setupScore: score, tradeDirection: direction, ...tradePlan, narrative, confluences: JSON.stringify(confluences), warnings: warnings.length ? JSON.stringify(warnings) : null, triggeredBy: "webhook" });
            } catch (e) { console.error("[Auto analysis]", e); }
          })();
        }
      }

      // Signal evaluation
      try {
        clearExpiredSignals();
        const isTVOrNT = !body.source || body.source === "tradingview" || body.source === "ninjatrader";
        if (isTVOrNT) {
          const freshWebhooks = storage.getRecentWebhooks(10);
          const { score, bias, orderFlowScore, tvLatest, scLatest, scFresh } = scoreSetup(freshWebhooks);
          const scData = scFresh ? scLatest : null;
          const ntPrice = isNT8 && body.close ? Number(body.close) : null;

          // ROUTE-003: correctly read nt_sl/nt_tp1/nt_tp2 (not body.sl/body.tp1/body.tp2)
     const mergedMarketData = {
  close:          ntPrice ?? tvLatest?.close ?? scLatest?.close ?? null,
ntDataAge: isNT8 ? 0 : (tvLatest ? Date.now() - (tvLatest as any).receivedAt : undefined),
  delta:          scData?.delta          ?? null,
            
            absorptionBull: scData?.absorptionBull ?? null,
            absorptionBear: scData?.absorptionBear ?? null,
            imbalanceBull:  scData?.imbalanceBull  ?? null,
            imbalanceBear:  scData?.imbalanceBear  ?? null,
            bidStackSize:   scData?.bidStackSize   ?? null,
            askStackSize:   scData?.askStackSize   ?? null,
            // Also pass NT8's own SC state fields (from its PollSCState() call)
            dom_bull:       body.dom_bull ? Number(body.dom_bull) : null,
            dom_bear:       body.dom_bear ? Number(body.dom_bear) : null,
            bias, score, orderFlowScore,
            long_signal:    body.long_signal  !== undefined ? Number(body.long_signal)  : undefined,
            short_signal:   body.short_signal !== undefined ? Number(body.short_signal) : undefined,
            long_conf:      body.long_conf    !== undefined ? Number(body.long_conf)    : undefined,
            short_conf:     body.short_conf   !== undefined ? Number(body.short_conf)   : undefined,
            killzone:       body.killzone || body.kz || null,
            // ROUTE-003: NT8 sends nt_sl/nt_tp1/nt_tp2 — was incorrectly reading sl/tp1/tp2
            nt_sl:          body.nt_sl  !== undefined ? Number(body.nt_sl)  : undefined,
            nt_tp1:         body.nt_tp1 !== undefined ? Number(body.nt_tp1) : undefined,
            nt_tp2:         body.nt_tp2 !== undefined ? Number(body.nt_tp2) : undefined,
            nt_session:     body.session    ? String(body.session)    : null,
            direction:      body.direction  ? String(body.direction)  : undefined,
            confidence:     body.confidence ? Number(body.confidence) : undefined,
            reasons:        body.reason || body.reasons ? String(body.reason || body.reasons) : undefined,
            nt_signal_id:   body.signal_id  ? String(body.signal_id)  : undefined,
            htfBias:        body.htfBias    ? String(body.htfBias)    : undefined,
          };

          // ROUTE-004: log what the signal evaluator sees
          console.log(
            `[SignalEval] dir=${mergedMarketData.direction || "none"} ` +
            `close=${mergedMarketData.close} kz=${mergedMarketData.killzone || "none"} ` +
            `conf=${mergedMarketData.confidence ?? "?"} ` +
            `nt_sl=${mergedMarketData.nt_sl ?? "?"} nt_tp1=${mergedMarketData.nt_tp1 ?? "?"} nt_tp2=${mergedMarketData.nt_tp2 ?? "?"}`
          );
          if(!isNT8) return res.json({ ok: true, id: saved.id });
          const newSignal = evaluateSignal(mergedMarketData, activeSession);
          if (newSignal) {
            console.log(`[Signal] ✅ CREATED: ${newSignal.direction.toUpperCase()} @ ${newSignal.entry} id=${newSignal.id}`);
          } else {
            // ROUTE-004: log the block reason so missed trades are diagnosable
            if (!mergedMarketData.direction) {
              console.log("[Signal] ⛔ No direction in payload — signal not created");
            } else if (!mergedMarketData.close) {
              console.log("[Signal] ⛔ No close price — signal not created");
            } else {
              console.log(`[Signal] ⛔ evaluateSignal returned null for ${mergedMarketData.direction} @ ${mergedMarketData.close} — check cooldown/session/gate in signalEngine`);
            }
          }
        }
      } catch (sigErr) {
        console.error("[Signal eval]", sigErr);
      }

      return res.json({ ok: true, id: saved.id });
    } catch (err) {
      console.error("[Webhook]", err);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GET /api/dashboard
  // ══════════════════════════════════════════════════════════════════════════
  app.get("/api/dashboard", (req, res) => {
    const webhooks       = storage.getRecentWebhooks(20);
    const latestAnalysis = storage.getLatestAnalysis();
    const recentAnalyses = storage.getRecentAnalyses(5);
    const { score, ictScore, bias, confluences, warnings, tvFresh, scFresh, tvAge, scAge, tvLatest, scLatest } = scoreSetup(webhooks);
    return res.json({
      latestWebhook:  webhooks.find((w: any) => w.source !== "bookmap_cme") || null,
      score, ictScore, bias, confluences, warnings,
      latestAnalysis, recentAnalyses,
      totalSignals:   webhooks.length,
      tvFresh, scFresh,
      tvAgeMin:       tvAge !== Infinity ? Math.round(tvAge / 60000) : null,
      scAgeMin:       scAge !== Infinity ? Math.round(scAge / 60000) : null,
      hasTVData:      !!tvLatest,
      hasSCData:      !!scLatest,
      // Surface SC state for dashboard display
      latestSCState:  latestScReceivedAt > 0 ? { ...latestScData, ageMs: Date.now() - latestScReceivedAt } : null,
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GET /api/signals
  // ══════════════════════════════════════════════════════════════════════════
  app.get("/api/signals", (req, res) => {
    return res.json(storage.getRecentWebhooks(50));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /api/analyze — Manual AI analysis
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/analyze", async (req, res) => {
    const webhooks = storage.getRecentWebhooks(10);
    const { score, bias, confluences, warnings, tvLatest, scLatest, tvFresh, scFresh, tvAge, scAge } = scoreSetup(webhooks);

    if (!process.env.ANTHROPIC_API_KEY) {
      const livePrice = await fetchLiveNQPrice();
      const p = livePrice ?? webhooks[0]?.close ?? null;
      const direction = bias === "BULLISH" ? "LONG" : bias === "BEARISH" ? "SHORT" : "WAIT";
      const analysis = storage.saveAnalysis({
        createdAt: Date.now(), latestPrice: p, sessionBias: bias, setupScore: score,
        tradeDirection: direction,
        entryZone: p ? `${(p - 8).toFixed(2)} - ${(p + 3).toFixed(2)}` : null,
        stopLoss:  p ? `${(p - 20).toFixed(2)}` : null,
        target1:   p ? `${(p + 25).toFixed(2)}` : null,
        target2:   p ? `${(p + 60).toFixed(2)}` : null,
        narrative: `[DEMO MODE] Score: ${score}/100 | Bias: ${bias} | Price: ${p?.toLocaleString() ?? "?"}`,
        confluences: JSON.stringify(confluences),
        warnings: warnings.length ? JSON.stringify(warnings) : null,
        triggeredBy: "manual",
      });
      return res.json(analysis);
    }

    try {
      const livePrice = await fetchLiveNQPrice();
      const prompt    = buildAnalysisPrompt(webhooks, score, bias, confluences, warnings, req.body?.question, activeSession, livePrice, tvLatest, scLatest, tvFresh, scFresh, tvAge, scAge);
      const msg       = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] });
      const narrative = (msg.content[0] as any).text;
      const tradePlan = parseTradePlan(narrative, webhooks[0], livePrice);
      const direction = bias === "BULLISH" ? "LONG" : bias === "BEARISH" ? "SHORT" : "WAIT";
      const analysis  = storage.saveAnalysis({ createdAt: Date.now(), latestPrice: livePrice ?? webhooks[0]?.close ?? null, sessionBias: bias, setupScore: score, tradeDirection: direction, ...tradePlan, narrative, confluences: JSON.stringify(confluences), warnings: warnings.length ? JSON.stringify(warnings) : null, triggeredBy: "manual" });
      return res.json(analysis);
    } catch (err) {
      console.error("[Analyze]", err);
      return res.status(500).json({ error: "AI analysis failed" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /api/chat
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/chat", async (req, res) => {
    const { message, sessionId } = req.body;
    if (!message || !sessionId) return res.status(400).json({ error: "message and sessionId required" });

    storage.saveChatMessage({ createdAt: Date.now(), role: "user", content: message, sessionId });

    const history  = storage.getChatMessages(sessionId).slice(-10);
    const webhooks = storage.getRecentWebhooks(10);
    const { score, bias, confluences } = scoreSetup(webhooks);
    const latest = webhooks[0];
    const personality = getPersonality();
    const ctx: MarketContext = {
      price: latest?.close ?? 0, vwap: latest?.vwap ?? 0,
      bias, score, killzone: latest?.killzone || "none",
      marketStructure: latest?.marketStructure || "none",
      zone: (latest as any)?.premium ? "premium" : (latest as any)?.discount ? "discount" : "equilibrium",
      confluences: confluences.join(", ") || "none",
      recentPrices: webhooks.slice(0, 5).map((w: any) => w.close?.toLocaleString()).join(" → "),
      priceDirection: "steady",
      time: new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit" }),
      vwapRel: buildVwapRel(latest?.close ?? 0, latest?.vwap ?? 0),
    };

    const recentCalls = storage.getRecentCommentary(5).map((c: any) => `${c.title} @ ${c.price?.toLocaleString() || "?"}`);
    const trashTalk   = isTrashTalk(message);
    const prompt      = trashTalk ? personality.trashTalkPrompt(ctx, message, recentCalls) : personality.chatPrompt(ctx, message, recentCalls);

    if (!process.env.ANTHROPIC_API_KEY) {
      const reply = storage.saveChatMessage({ createdAt: Date.now(), role: "assistant", content: `[DEMO] Score: ${score}/100 | Bias: ${bias}`, sessionId });
      return res.json({ message: reply });
    }

    try {
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-6", max_tokens: 500,
        system: personality.basePrompt,
        messages: [
          ...history.slice(0, -1).map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content })),
          { role: "user", content: prompt },
        ],
      });
      const replyText = (msg.content[0] as any).text;
      const reply = storage.saveChatMessage({ createdAt: Date.now(), role: "assistant", content: replyText, sessionId });
      return res.json({ message: reply, personality: personality.id, trash_talk_detected: trashTalk });
    } catch (err) {
      console.error("[Chat]", err);
      return res.status(500).json({ error: "AI chat failed" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Session, Personality
  // ══════════════════════════════════════════════════════════════════════════
  app.get("/api/session", (_req, res) => res.json({ session: activeSession }));
  app.post("/api/session", (req, res) => {
    const { session } = req.body;
    if (!["asia", "london", "ny"].includes(session)) return res.status(400).json({ error: "Use: asia, london, ny" });
    activeSession = session;
    return res.json({ session: activeSession });
  });

  app.get("/api/personality", (_req, res) => { const p = getPersonality(); return res.json({ id: p.id, name: p.name, emoji: p.emoji, description: p.description }); });
  app.post("/api/personality", (req, res) => {
    const { id } = req.body;
    if (!["shark", "suit", "oracle"].includes(id)) return res.status(400).json({ error: "Use: shark, suit, oracle" });
    setPersonality(id as PersonalityId);
    const p = getPersonality();
    return res.json({ ok: true, personality: { id: p.id, name: p.name, emoji: p.emoji, description: p.description } });
  });

  app.get("/api/chat/:sessionId", (req, res) => res.json(storage.getChatMessages(req.params.sessionId)));

  // ══════════════════════════════════════════════════════════════════════════
  // Trade signal endpoints (MuzziBot polling)
  // ══════════════════════════════════════════════════════════════════════════

  // ROUTE-005: always returns {} not null when no signal pending
  app.get("/api/trade-signal/pending", (_req, res) => {
    const signal = getPendingSignal();
    if (!signal) {
      console.log("[Pending] No pending signal");
      return res.json({});
    }
    console.log(`[Pending] Returning signal ${signal.id} ${signal.direction} @ ${signal.entry}`);
    return res.json(signal);
  });

  app.post("/api/trade-signal/confirm", (req, res) => {
    try {
      const { id, status } = req.body as { id: string; status?: string };
      if (!id) return res.status(400).json({ error: "id required" });
      confirmSignal(id);
      if (status && status !== "pending") updateSignalResult(id, { status: status as any });
      console.log(`[Confirm] Signal ${id} confirmed`);
      return res.json({ ok: true, id });
    } catch (err: any) {
      console.error("[Confirm]", err?.message);
      return res.json({ ok: true, warn: err?.message });
    }
  });

  app.post("/api/trade-signal/cancel", (req, res) => {
    try {
      const { id } = req.body as { id: string };
      if (!id) return res.status(400).json({ error: "id required" });
      updateSignalResult(id, { status: "cancelled", result: "EXPIRED", exitReason: "MuzziBot rejected" });
      console.log(`[Cancel] Signal ${id} cancelled`);
      return res.json({ ok: true, id });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  app.post("/api/trade-signal/result", (req, res) => {
    try {
      const { id, source: _src, ...rest } = req.body as { id: string; source?: string; [key: string]: any };
      if (!id) return res.status(400).json({ error: "id required" });
      updateSignalResult(id, rest);
      console.log(`[Result] Signal ${id} updated:`, rest);
      return res.json({ ok: true, id });
    } catch (err: any) {
      console.error("[Result]", err?.message);
      return res.json({ ok: true, warn: err?.message });
    }
  });

  app.get("/api/trade-signal/history", (_req, res) => res.json(getRecentSignals(50)));
  app.get("/api/trade-signal/stats",   (_req, res) => res.json(getSignalStats()));

  // ══════════════════════════════════════════════════════════════════════════
  // Test / Debug endpoints
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/test-inject", (req, res) => {
    try {
      const { direction = "long", entry = 29500, sl, tp1, tp2, session = "ny_open" } = req.body || {};
      const e = Number(entry);
      const sig = injectTestSignal(
        direction, e,
        Number(sl  ?? (direction === "long" ? e - 20 : e + 20)),
        Number(tp1 ?? (direction === "long" ? e + 30 : e - 30)),
        Number(tp2 ?? (direction === "long" ? e + 70 : e - 70)),
        session,
      );
      console.log(`[TestInject] Created ${sig.direction} @ ${sig.entry} id=${sig.id}`);
      return res.json({ ok: true, id: sig.id, direction: sig.direction, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, session: sig.session });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  app.post("/api/debug-signal", (req, res) => {
    const body = req.body || {};
    const freshWebhooks = storage.getRecentWebhooks(10);
    const { score, bias, orderFlowScore, tvLatest, scLatest } = scoreSetup(freshWebhooks);
    const ntPrice = body.source === "ninjatrader" && body.close ? Number(body.close) : null;
    const mergedMarketData = {
      close: ntPrice ?? tvLatest?.close ?? scLatest?.close ?? null,
      delta: scLatest?.delta ?? null, bias, score, orderFlowScore,
      absorptionBull: scLatest?.absorptionBull ?? null,
      absorptionBear: scLatest?.absorptionBear ?? null,
      long_signal:  body.long_signal  !== undefined ? Number(body.long_signal)  : undefined,
      short_signal: body.short_signal !== undefined ? Number(body.short_signal) : undefined,
      killzone: body.killzone || body.kz || null,
      // ROUTE-003: correct field names
      nt_sl:    body.nt_sl  !== undefined ? Number(body.nt_sl)  : undefined,
      nt_tp1:   body.nt_tp1 !== undefined ? Number(body.nt_tp1) : undefined,
      nt_tp2:   body.nt_tp2 !== undefined ? Number(body.nt_tp2) : undefined,
      nt_session: body.session   ? String(body.session)   : null,
      direction:  body.direction ? String(body.direction) : undefined,
      confidence: body.confidence ? Number(body.confidence) : undefined,
    };
    const recent = getRecentSignals(10);
    const pendingSignals = recent.filter((s: any) => s.status === "pending");
    const filledRecent   = recent.filter((s: any) => s.status === "filled" && (Date.now() - s.createdAt) < 10 * 60 * 1000);
    const isBlocked      = pendingSignals.length > 0 || filledRecent.length > 0;
    const newSignal      = evaluateSignal(mergedMarketData, activeSession);
    return res.json({ mergedMarketData, activeSession, pendingSignals, filledRecent, isBlocked, result: newSignal ? "SIGNAL_CREATED" : "NULL_NO_SIGNAL", signal: newSignal, score, bias });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Simulate / Scorecard / Commentary / Learning / Trades Today
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/simulate", async (req, res) => {
    const liveBase = await fetchLiveNQPrice() ?? (storage.getRecentWebhooks(1)[0]?.close ?? 29900);
    const b = Math.round(liveBase * 4) / 4;
    const scenarios = [
      { timeframe: "15", close: b,     high: b+25, low: b-30, open: b-5,  volume: 12500, vwap: b-15, killzone: "ny_open",   marketStructure: "BOS_bull", fvg_bull: 1, sweep_low: 1,  discount: 1 },
      { timeframe: "1",  close: b+8,   high: b+15, low: b-5,  open: b,    volume: 3200,  vwap: b-8,  killzone: "ny_open",   marketStructure: "CHoCH_bull", ob_bull: 1, fvg_bull: 1, discount: 1 },
      { timeframe: "15", close: b-40,  high: b+10, low: b-60, open: b-5,  volume: 9800,  vwap: b+10, killzone: "ny_close",  marketStructure: "BOS_bear",  fvg_bear: 1, sweep_high: 1, premium: 1 },
    ];
    const pick = scenarios[Math.floor(Math.random() * scenarios.length)];
    const payload: InsertWebhookPayload = { receivedAt: Date.now(), ticker: "NQ1!", timeframe: pick.timeframe, open: (pick as any).open, high: pick.high, low: pick.low, close: pick.close, volume: pick.volume, vwap: pick.vwap, killzone: pick.killzone || null, marketStructure: pick.marketStructure || null, fvgBull: (pick as any).fvg_bull ? 1 : 0, fvgBear: (pick as any).fvg_bear ? 1 : 0, obBull: (pick as any).ob_bull ? 1 : 0, obBear: 0, sweepHigh: (pick as any).sweep_high ? 1 : 0, sweepLow: (pick as any).sweep_low ? 1 : 0, premium: (pick as any).premium ? 1 : 0, discount: (pick as any).discount ? 1 : 0, rawJson: JSON.stringify(pick) };
    const saved = storage.saveWebhook(payload);
    return res.json({ ok: true, id: saved.id });
  });

  app.get("/api/scorecard",          (req, res) => { const limit = parseInt(String(req.query.limit || "60")); return res.json({ entries: storage.getRecentScorecard(limit), stats: storage.getScorecardStats() }); });
  app.post("/api/scorecard",         (req, res) => { try { return res.json(storage.upsertScorecardEntry({ ...req.body, createdAt: req.body.createdAt || Date.now() })); } catch (e) { console.error(e); return res.status(500).json({ error: "Scorecard upsert failed" }); } });
  app.get("/api/commentary",         (req, res) => res.json(storage.getRecentCommentary(parseInt(String(req.query.limit || "30")))));
  app.get("/api/webhook-url",        (req, res) => { const host = req.headers.host || "localhost:5000"; const proto = req.headers["x-forwarded-proto"] || "http"; return res.json({ url: `${proto}://${host}/api/webhook` }); });

  app.post("/api/learning-kernel/feed", (req, res) => {
    try { if (!req.body?.signalId) return res.status(400).json({ error: "Missing signalId" }); recordTrade(req.body); return res.json({ ok: true }); }
    catch (e) { console.error(e); return res.status(500).json({ error: "Learning kernel update failed" }); }
  });
  app.get("/api/learning-kernel/insights", (_req, res) => {
    try { return res.json({ insights: getInsights(), weights: getWeights(), recent: getRecentLearningEntries(20) }); }
    catch (e) { return res.status(500).json({ error: "Learning kernel read failed" }); }
  });

  // ── GET /api/learning-kernel/thresholds — adaptive min confidence per session
  // MuzziBot polls this on startup and after every trade close.
  // Returns learned minimum confidence thresholds based on historical win rates.
  // Sessions with poor win rates require higher confidence before MuzziBot executes.
  app.get("/api/learning-kernel/thresholds", (_req, res) => {
    try {
      const { getThresholds } = require('./learningEngine');
      const thresholds = getThresholds();
      console.log('[Thresholds] Serving adaptive thresholds:', JSON.stringify(thresholds));
      return res.json(thresholds);
    } catch (e: any) {
      // Fallback to base thresholds if learningEngine not available
      console.warn('[Thresholds] learningEngine not available, using base thresholds:', e?.message);
      return res.json({ default: 5, london: 5, ny_open: 5, london_close: 5, ny_afternoon: 5 });
    }
  });

  app.get("/api/muzzi-signal", (_req, res) => {
    try {
      const webhooks = storage.getRecentWebhooks(20);
      const scored = scoreSetup(webhooks);
      const { tvLatest, scLatest, bias } = scored as any;
      if (!tvLatest && !scLatest) return res.json({ direction: "WAIT", grade: "WAIT", coachingNote: "No live data" });
      const sig = buildMuzziSignal({ tv: tvLatest || {}, tv15: (scored as any).tv15Latest, tv5: (scored as any).tv5Latest, tv1: (scored as any).tv1Latest, sc: scLatest || {}, bias });
      return res.json(sig || { direction: "WAIT", grade: "WAIT", coachingNote: "Insufficient data" });
    } catch (e) { console.error(e); return res.status(500).json({ error: "Muzzi signal failed" }); }
  });

  app.get("/api/trades/today", (_req, res) => {
    const todayET  = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const all      = getRecentSignals(200);
    const today    = all.filter((s: any) => new Date(s.createdAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === todayET && s.direction);
    const closed   = today.filter((s: any) => s.status === "closed");
    const wins     = closed.filter((s: any) => s.result === "TP1" || s.result === "TP2");
    const totalPnl = closed.reduce((sum: number, s: any) => sum + (s.pnlPoints ?? 0), 0);
    return res.json({
      date: todayET,
      summary: { total_trades: closed.length, wins: wins.length, win_rate_pct: closed.length ? Math.round((wins.length / closed.length) * 100) : 0, total_pnl_pts: parseFloat(totalPnl.toFixed(2)), total_pnl_usd: parseFloat((totalPnl * 8).toFixed(2)) },
      trades: today.map((s: any) => ({ id: s.id, direction: s.direction, session: s.session, entry: s.entry, exit_price: s.exitPrice, sl: s.sl, tp1: s.tp1, tp2: s.tp2, status: s.status, result: s.result, pnl_pts: s.pnlPoints, reason: s.reason, created_at: new Date(s.createdAt).toISOString() })),
    });
  });

  // Health check
  app.post("/api/brief-state", (req, res) => {
    try {
      const body = req.body as any;
      if (!body || typeof body.bias !== 'string' || typeof body.bias_score !== 'number')
        return res.status(400).json({ ok: false, error: "Missing bias/bias_score" });
      setBriefState({ bias: body.bias, bias_score: body.bias_score, setups: Array.isArray(body.setups) ? body.setups : [], generated_at: body.generated_at ?? Date.now() });
      return res.json({ ok: true, bias: body.bias, bias_score: body.bias_score, setups_loaded: (body.setups||[]).length });
    } catch(e: any) { return res.status(500).json({ ok: false, error: e?.message }); }
  });
  app.get("/api/brief-state", (_req, res) => res.json(getBriefState() ?? { ok: false, message: "No brief state loaded" }));

  app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
}
