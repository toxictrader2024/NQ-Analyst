/**
 * Commentary Engine
 * 
 * Watches every incoming signal and fires AI commentary when:
 *  - Bias flips (bullish → bearish or vice versa)
 *  - Absorption detected (high conviction reversal)
 *  - Market structure BOS/CHoCH fires
 *  - Delta divergence (price going up but delta going negative)
 *  - Score crosses a threshold (e.g. jumps from low → high or drops)
 *  - Killzone activates
 *  - DOM imbalance appears
 *  - Time-based update every N signals (general update)
 */

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";
import type { WebhookPayload } from "@shared/schema";
import { getPersonality, buildVwapRel, type MarketContext } from "./personalities";
import { evaluateSignal, clearExpiredSignals } from "./signalEngine";
import { fetchLiveNQPrice } from "./livePrice";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

// State tracking between signals
let lastBias: string = "NEUTRAL";
let lastScore: number = 0;
let lastKillzone: string | null = null;
let signalCount: number = 0;
let lastCommentaryAt: number = 0;
const MIN_COMMENTARY_GAP_MS = 5 * 60 * 1000; // minimum 5 min between any commentary

// Per-trigger-type cooldown — prevents same trigger spamming
const lastTriggerAt: Record<string, number> = {};
const TRIGGER_COOLDOWN_MS = 15 * 60 * 1000; // same trigger type won't fire within 15 min

type TriggerType = "reversal" | "continuation" | "tp_update" | "sl_update" | "bias_change" | "absorption" | "general" | "structure" | "killzone" | "imbalance";
type Urgency = "high" | "medium" | "low";

interface Trigger {
  type: TriggerType;
  urgency: Urgency;
  title: string;
  reason: string;
  source: string;
}

// ── Detect what changed and whether to fire commentary ────────────────────────
export function detectTriggers(
  latest: WebhookPayload,
  currentBias: string,
  currentScore: number,
  confluences: string[],
): Trigger[] {
  const triggers: Trigger[] = [];
  const now = Date.now();

  // Throttle: don't fire if last commentary was too recent
  if (now - lastCommentaryAt < MIN_COMMENTARY_GAP_MS) return [];

  // Helper: only allow a trigger source once per cooldown window
  const allowed = (source: string) => {
    if (now - (lastTriggerAt[source] ?? 0) < TRIGGER_COOLDOWN_MS) return false;
    lastTriggerAt[source] = now;
    return true;
  };

  // 1. Bias flip — highest priority
  if (lastBias && currentBias !== "NEUTRAL" && currentBias !== lastBias && lastBias !== "NEUTRAL" && allowed("bias_flip")) {
    triggers.push({
      type: "bias_change",
      urgency: "high",
      title: `⚡ Bias Flip: ${lastBias} → ${currentBias}`,
      reason: `Market structure has shifted from ${lastBias} to ${currentBias}`,
      source: "bias_flip",
    });
  }

  // 2. Bull/Bear absorption — very high conviction
  if ((latest as any).absorptionBull && allowed("absorption_bull")) {
    triggers.push({
      type: "absorption",
      urgency: "high",
      title: "🟢 Bull Absorption Detected",
      reason: "Large sell order was fully absorbed at the bid — strong buying pressure",
      source: "absorption_bull",
    });
  }
  if ((latest as any).absorptionBear && allowed("absorption_bear")) {
    triggers.push({
      type: "absorption",
      urgency: "high",
      title: "🔴 Bear Absorption Detected",
      reason: "Large buy order absorbed at the ask — strong selling pressure hidden",
      source: "absorption_bear",
    });
  }

  // 3. Market structure flip (BOS or CHoCH)
  const ms = latest.marketStructure || "";
  if (ms.includes("CHoCH") && allowed("choch")) {
    triggers.push({
      type: "reversal",
      urgency: "high",
      title: `⚠️ CHoCH Detected — ${ms.includes("bull") ? "Bullish" : "Bearish"} Reversal`,
      reason: `Change of Character (CHoCH) printed on ${latest.timeframe}m — potential trend reversal`,
      source: "choch",
    });
  } else if (ms.includes("BOS") && allowed("bos")) {
    triggers.push({
      type: "continuation",
      urgency: "medium",
      title: `📊 BOS Confirmed — ${ms.includes("bull") ? "Bullish" : "Bearish"} Continuation`,
      reason: `Break of Structure (BOS) on ${latest.timeframe}m — trend continuation signal`,
      source: "bos",
    });
  }

  // 4. Liquidity sweep (high-value entry signal)
  if (latest.sweepLow && allowed("sweep_low")) {
    triggers.push({
      type: "reversal",
      urgency: "high",
      title: "💧 Low Swept — Bullish Entry Window",
      reason: "Buy-side liquidity taken below recent low — ICT reversal setup forming",
      source: "sweep_low",
    });
  }
  if (latest.sweepHigh && allowed("sweep_high")) {
    triggers.push({
      type: "reversal",
      urgency: "high",
      title: "💧 High Swept — Bearish Entry Window",
      reason: "Sell-side liquidity taken above recent high — ICT reversal setup forming",
      source: "sweep_high",
    });
  }

  // 5. Delta divergence — price moving opposite to order flow
  const delta = (latest as any).delta;
  const close = latest.close;
  if (delta !== null && delta !== undefined && close !== null) {
    const recentSignals = storage.getRecentWebhooks(3);
    const prevClose = recentSignals[1]?.close;
    if (prevClose) {
      const priceUp = close > prevClose;
      const deltaNeg = delta < -200;
      const deltaPos = delta > 200;
      if (priceUp && deltaNeg && allowed("delta_divergence_bear")) {
        triggers.push({
          type: "reversal",
          urgency: "medium",
          title: "📉 Delta Divergence — Price Up, Sellers Dominating",
          reason: `Price moved up to ${close} but cumulative delta is ${delta} — bearish divergence, potential trap`,
          source: "delta_divergence_bear",
        });
      } else if (!priceUp && deltaPos && allowed("delta_divergence_bull")) {
        triggers.push({
          type: "reversal",
          urgency: "medium",
          title: "📈 Delta Divergence — Price Down, Buyers Dominating",
          reason: `Price moved down to ${close} but cumulative delta is +${delta} — bullish divergence, potential reversal`,
          source: "delta_divergence_bull",
        });
      }
    }
  }

  // 6. DOM imbalance appeared
  if ((latest as any).imbalanceBull && allowed("imbalance_bull")) {
    triggers.push({
      type: "continuation",
      urgency: "medium",
      title: "📚 Stacked Bids — DOM Support Below",
      reason: "Bid stack significantly larger than ask stack — institutional support building",
      source: "imbalance_bull",
    });
  }
  if ((latest as any).imbalanceBear && allowed("imbalance_bear")) {
    triggers.push({
      type: "continuation",
      urgency: "medium",
      title: "📚 Stacked Asks — DOM Resistance Above",
      reason: "Ask stack significantly larger than bid stack — institutional supply wall",
      source: "imbalance_bear",
    });
  }

  // 7. Score crosses significant thresholds
  const scoreDelta = currentScore - lastScore;
  if (scoreDelta >= 20 && currentScore >= 65 && allowed("score_surge")) {
    triggers.push({
      type: "continuation",
      urgency: "medium",
      title: `📈 Setup Score Surged to ${currentScore}/100`,
      reason: `Confluence buildup: score jumped ${scoreDelta} points — high-probability setup forming`,
      source: "score_surge",
    });
  } else if (scoreDelta <= -20 && lastScore >= 50 && allowed("score_drop")) {
    triggers.push({
      type: "tp_update",
      urgency: "medium",
      title: `⚠️ Setup Score Dropped to ${currentScore}/100`,
      reason: `Confluence deteriorating: score dropped ${Math.abs(scoreDelta)} points — reassess position`,
      source: "score_drop",
    });
  }

  // 8. Killzone activated
  if (latest.killzone && latest.killzone !== lastKillzone && allowed("killzone_activate")) {
    const kzLabel = latest.killzone.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    triggers.push({
      type: "general",
      urgency: "medium",
      title: `🕐 ${kzLabel} Now Active`,
      reason: `Entering high-probability time window — ${kzLabel} killzone opens execution opportunities`,
      source: "killzone_activate",
    });
  }

  // 9. FVG + Order Block confluence appears
  if (((latest.fvgBull && (latest as any).obBull) || (latest.fvgBear && (latest as any).obBear)) && allowed("fvg_ob_confluence")) {
    triggers.push({
      type: "continuation",
      urgency: "medium",
      title: "🎯 FVG + Order Block Confluence",
      reason: "Fair value gap and order block aligning — high-probability entry zone",
      source: "fvg_ob_confluence",
    });
  }

  // 10. Fallback: general update every 5 signals if nothing else fired
  signalCount++;
  if (triggers.length === 0 && signalCount % 5 === 0 && currentScore > 30) {
    triggers.push({
      type: "general",
      urgency: "low",
      title: "📊 Market Update",
      reason: "Periodic market state summary",
      source: "periodic",
    });
  }

  // Return only the single highest-priority trigger to prevent commentary spam
  const priority = { high: 0, medium: 1, low: 2 };
  triggers.sort((a, b) => priority[a.urgency] - priority[b.urgency]);
  return triggers.slice(0, 1);
}

// ── Generate AI commentary for a trigger ─────────────────────────────────────
export async function generateCommentary(
  trigger: Trigger,
  webhooks: WebhookPayload[],
  currentBias: string,
  currentScore: number,
  ictScore: number,
  confluences: string[],
  warnings: string[],
): Promise<void> {
  const latest = webhooks[0];
  if (!latest) return;

  // Always use live Yahoo price — never let stale webhook close bleed into commentary
  const livePrice = await fetchLiveNQPrice();
  const price = livePrice ?? latest.close ?? 0;

  const prompt = `You are a live NQ futures trading desk AI analyst providing real-time market commentary using ICT methodology.

CRITICAL: The live NQ price is ${price.toLocaleString()}. Every price level you output MUST be near this number. Do not use prices from training data.

TRIGGER EVENT: ${trigger.title}
REASON: ${trigger.reason}

CURRENT STATE:
- Price: ${price.toLocaleString()}
- ICT Score: ${currentScore}/100
- Session Bias: ${currentBias}
- Killzone: ${latest.killzone || "None"}
- Market Structure: ${latest.marketStructure || "None"}
- FVG: ${latest.fvgBull ? "BULL" : latest.fvgBear ? "BEAR" : "None"}
- Sweep: ${latest.sweepHigh ? "HIGH SWEPT" : latest.sweepLow ? "LOW SWEPT" : "None"}
- Zone: ${(latest as any).premium ? "PREMIUM" : (latest as any).discount ? "DISCOUNT" : "Mid"}
- VWAP: ${(tvHook?.vwap && tvHook.vwap > 25000) ? tvHook.vwap.toLocaleString() : "N/A (SC VWAP excluded)"}

ICT Confluences: ${confluences.join("; ") || "None"}
Warnings: ${warnings.join("; ") || "None"}

Provide a CONCISE market update (3-5 sentences max). Be direct and specific:
1. What just happened and what it means RIGHT NOW
2. Is this a reversal signal or continuation?
3. Specific updated Stop Loss level (exact price)
4. Specific Take Profit 1 (conservative, nearest structure) 
5. Specific Take Profit 2 (extended target)

Format your response as plain text. Start with the key insight, then give the trade management levels.
Use exact NQ price numbers. Be a prop desk analyst, not a textbook.`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const message = (msg.content[0] as any).text as string;

    // Parse SL/TP from the response
    const slMatch = message.match(/stop[- ]?loss[:\s]+\$?([\d,]+(?:\.\d+)?)/i);
    const tp1Match = message.match(/(?:tp1|take profit 1|target 1)[:\s]+\$?([\d,]+(?:\.\d+)?)/i);
    const tp2Match = message.match(/(?:tp2|take profit 2|target 2)[:\s]+\$?([\d,]+(?:\.\d+)?)/i);

    const parsePrice = (m: RegExpMatchArray | null) =>
      m ? parseFloat(m[1].replace(/,/g, "")) : null;

    // Smart defaults based on bias and price
    const slDefault = currentBias === "BULLISH"
      ? price - 25
      : currentBias === "BEARISH"
      ? price + 25
      : null;
    const tp1Default = currentBias === "BULLISH"
      ? price + 30
      : currentBias === "BEARISH"
      ? price - 30
      : null;
    const tp2Default = currentBias === "BULLISH"
      ? price + 60
      : currentBias === "BEARISH"
      ? price - 60
      : null;

    storage.saveCommentary({
      createdAt: Date.now(),
      type: trigger.type,
      urgency: trigger.urgency,
      title: trigger.title,
      message,
      price,
      suggestedSl: parsePrice(slMatch) ?? slDefault,
      suggestedTp1: parsePrice(tp1Match) ?? tp1Default,
      suggestedTp2: parsePrice(tp2Match) ?? tp2Default,
      triggerSource: trigger.source,
      prevBias: lastBias,
      newBias: currentBias,
    });

    lastCommentaryAt = Date.now();
    console.log(`[Commentary] Generated: ${trigger.title} (${trigger.urgency})`);
  } catch (err) {
    console.error("[Commentary] AI generation failed:", err);

    // Save a demo commentary without AI
    const demoMessage = `[Demo Mode — Add ANTHROPIC_API_KEY for live AI commentary]\n\n${trigger.title}\n\n${trigger.reason}\n\nAt current price ${price.toLocaleString()}, bias is ${currentBias} with a setup score of ${currentScore}/100.\n\nSuggested levels based on current structure:\n• Stop Loss: ${currentBias === "BULLISH" ? (price - 25).toFixed(2) : (price + 25).toFixed(2)}\n• TP1: ${currentBias === "BULLISH" ? (price + 30).toFixed(2) : (price - 30).toFixed(2)}\n• TP2: ${currentBias === "BULLISH" ? (price + 60).toFixed(2) : (price - 60).toFixed(2)}`;

    storage.saveCommentary({
      createdAt: Date.now(),
      type: trigger.type,
      urgency: trigger.urgency,
      title: trigger.title,
      message: demoMessage,
      price,
      suggestedSl: currentBias === "BULLISH" ? price - 25 : currentBias === "BEARISH" ? price + 25 : null,
      suggestedTp1: currentBias === "BULLISH" ? price + 30 : currentBias === "BEARISH" ? price - 30 : null,
      suggestedTp2: currentBias === "BULLISH" ? price + 60 : currentBias === "BEARISH" ? price - 60 : null,
      triggerSource: trigger.source,
      prevBias: lastBias,
      newBias: currentBias,
    });

    lastCommentaryAt = Date.now();
  }
}

// ── Update tracking state ──────────────────────────────────────────────────────
export function updateState(bias: string, score: number, killzone: string | null) {
  lastBias = bias;
  lastScore = score;
  lastKillzone = killzone;
}

// ── 5-Minute Market Pulse ─────────────────────────────────────────────────────
// Fires every 5 minutes during market hours regardless of signal events
// Gives a real-time read on current state, updated TP/SL, and next likely move
let pulseInterval: NodeJS.Timeout | null = null;

export function startPulse() {
  if (pulseInterval) return; // already running

  pulseInterval = setInterval(async () => {
    // Only fire during market hours (Sun 5pm CT – Fri 4pm CT = Sun 22:00 UTC – Fri 21:00 UTC)
    const now = new Date();
    const utcDay  = now.getUTCDay();  // 0=Sun 6=Sat
    const utcHour = now.getUTCHours();
    const utcMin  = now.getUTCMinutes();
    const utcTime = utcHour * 100 + utcMin;

    // Sat = no market. Sun before 2200 UTC = no market.
    if (utcDay === 6) return;
    if (utcDay === 0 && utcTime < 2200) return;
    // Fri after 2100 UTC = market closed
    if (utcDay === 5 && utcTime >= 2100) return;

    // Need at least one real signal before pulsing
    const webhooks = storage.getRecentWebhooks(10);
    if (!webhooks.length || !webhooks[0].close) return;

    // Don't pulse if a commentary just fired (respect the 45s gap)
    const now2 = Date.now();
    if (now2 - lastCommentaryAt < MIN_COMMENTARY_GAP_MS) return;

    const latest   = webhooks[0];
    // Always anchor to live price — never trust stale webhook close
    const livePrice = await fetchLiveNQPrice();
    const price    = livePrice ?? latest.close ?? 0;
    // VWAP: only use TV source — SC VWAP field is stale/historical, always ignore it
    const tvHook   = webhooks.find(w => w.source === 'tradingview');
    const rawVwap  = tvHook?.vwap ?? null;
    const vwap     = (rawVwap && rawVwap > 25000) ? rawVwap : 0;
    const bias     = lastBias;
    const score    = lastScore;

    // Build rich ICT context from recent signals
    const recentPrices = webhooks.slice(0, 5).map(w => w.close).filter(Boolean);
    const priceDirection = recentPrices.length >= 2
      ? (recentPrices[0]! > recentPrices[recentPrices.length - 1]! ? "trending up" : "trending down")
      : "flat";

    const hasFvg    = latest.fvgBull || latest.fvgBear;
    const hasOb     = (latest as any).obBull || (latest as any).obBear;
    const hasSweep  = latest.sweepHigh || latest.sweepLow;
    const hasCisd   = (latest as any).cisdBull || (latest as any).cisdBear;
    const hasDelta  = (latest as any).deltaBull || (latest as any).deltaBear;
    const kz        = latest.killzone?.replace(/_/g, " ") || "none";
    const ms        = latest.marketStructure || "none";
    const zone      = (latest as any).premium ? "premium" : (latest as any).discount ? "discount" : "equilibrium";
    const vwapRel   = vwap > 0 ? (price > vwap ? "above VWAP" : price < vwap ? "below VWAP" : "at VWAP") : "(VWAP N/A)";

    const confluenceList = [
      hasFvg    ? (latest.fvgBull ? "Bull FVG" : "Bear FVG") : null,
      hasOb     ? ((latest as any).obBull ? "Bull OB" : "Bear OB") : null,
      hasSweep  ? (latest.sweepLow ? "Low Swept" : "High Swept") : null,
      hasCisd   ? ((latest as any).cisdBull ? "Bullish CISD" : "Bearish CISD") : null,
      hasDelta  ? ((latest as any).deltaBull ? "Bull Delta Block" : "Bear Delta Block") : null,
      ms !== "none" ? ms.replace("_", " ").toUpperCase() : null,
    ].filter(Boolean).join(", ") || "No active confluences";

    const personality = getPersonality();
    const ctx: MarketContext = {
      price, vwap, bias, score,
      killzone: kz,
      marketStructure: ms,
      zone,
      confluences: confluenceList,
      recentPrices: recentPrices.map(p => p?.toLocaleString()).join(" → "),
      priceDirection,
      time: new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit" }),
      vwapRel: buildVwapRel(price, vwap),
    };
    const ctTime = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: true });
    const etTime = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });
    const priceAnchor = `\n\nCRITICAL FACTS (do not override):\n- Current time: ${ctTime} CT / ${etTime} ET\n- The ONLY correct NQ price is ${price.toLocaleString()}. Use this exact number for any "Live Price" or "Current Price" reference.\n- Every SL, TP1, TP2 MUST be within 200 points of ${price.toLocaleString()}. Never use prices from training data. Never state a different time than above.`;
    const prompt = personality.pulsePrompt(ctx) + priceAnchor;

    try {
      const msg = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 350,
        messages: [{ role: "user", content: prompt }],
      });

      const message = (msg.content[0] as any).text as string;
      const slMatch  = message.match(/stop[- ]?loss[:\s]+\$?([\d,]+(?:\.\d+)?)/i);
      const tp1Match = message.match(/(?:tp1|take profit 1|target 1)[:\s]+\$?([\d,]+(?:\.\d+)?)/i);
      const tp2Match = message.match(/(?:tp2|take profit 2|target 2)[:\s]+\$?([\d,]+(?:\.\d+)?)/i);
      const parseP   = (m: RegExpMatchArray | null) => m ? parseFloat(m[1].replace(/,/g, "")) : null;

      storage.saveCommentary({
        createdAt: Date.now(),
        type: "general",
        urgency: score >= 70 ? "high" : score >= 50 ? "medium" : "low",
        title: `${personality.emoji} ${personality.name} — ${price.toLocaleString()} | ${bias} ${score}/100`,
        message,
        price,
        suggestedSl:  parseP(slMatch)  ?? (bias === "BULLISH" ? price - 20 : bias === "BEARISH" ? price + 20 : null),
        suggestedTp1: parseP(tp1Match) ?? (bias === "BULLISH" ? price + 30 : bias === "BEARISH" ? price - 30 : null),
        suggestedTp2: parseP(tp2Match) ?? (bias === "BULLISH" ? price + 65 : bias === "BEARISH" ? price - 65 : null),
        triggerSource: "pulse_5min",
        prevBias: bias,
        newBias:  bias,
      });

      lastCommentaryAt = Date.now();
      console.log(`[Pulse] 5-min update fired at price ${price}`);
    } catch (err) {
      console.error("[Pulse] AI generation failed:", err);
    }

    // ── Signal Engine evaluation ──────────────────────────────────────────────
    // Build a combined market data object from latest stored signals so the
    // engine has access to both ICT scores (from routes.ts scoreSetup) and
    // the raw webhook fields it needs.
    try {
      // Import scoreSetup dynamically is awkward; instead pass what we have
      // available in commentaryEngine's closure: bias, score, and the latest
      // webhook payload fields.
      const signalMarketData = {
        close:           latest.close,
        delta:           (latest as any).delta ?? null,
        bias,
        score,
        orderFlowScore:  0, // pulse doesn't recompute OF score; signal engine guards this
        absorptionBull:  (latest as any).absorptionBull ?? 0,
        absorptionBear:  (latest as any).absorptionBear ?? 0,
      };
      // Determine active session from current ET hour
      // Use Intl.DateTimeFormat to reliably get 0-23 hour in ET
      const etNow = new Date();
      const etHour = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(etNow),
        10
      ) % 24; // guard against "24" returned at midnight
      // AMD Strat = 6PM(18)-2AM ET, London = 2AM-5AM ET, NY = 7AM-11AM ET
      const activeSession = (etHour >= 7 && etHour < 11) ? 'ny'
        : (etHour >= 2 && etHour < 5) ? 'london'
        : 'asia';

      const newSignal = evaluateSignal(signalMarketData, activeSession);
      if (newSignal) {
        console.log(`[Pulse] Signal generated: ${newSignal.direction.toUpperCase()} @ ${newSignal.entry}`);
      }
    } catch (sigErr) {
      console.error("[Pulse] Signal evaluation failed:", sigErr);
    }

    // Clear any pending signals older than 5 minutes
    clearExpiredSignals();
  }, 5 * 60 * 1000); // every 5 minutes

  console.log("[Pulse] 5-minute market pulse started");
}

export function stopPulse() {
  if (pulseInterval) {
    clearInterval(pulseInterval);
    pulseInterval = null;
  }
}
