import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import type { InsertWebhookPayload, InsertAnalysis } from "@shared/schema";
import Anthropic from "@anthropic-ai/sdk";
import { detectTriggers, generateCommentary, updateState } from "./commentaryEngine";
import { getPersonality, setPersonality, isTrashTalk, buildVwapRel, type MarketContext, type PersonalityId } from "./personalities";

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
} {
  const confluences: string[] = [];
  const orderFlowConfluences: string[] = [];
  const warnings: string[] = [];
  let bullPoints = 0;
  let bearPoints = 0;
  let ofBullPoints = 0;
  let ofBearPoints = 0;

  const recent = webhooks.slice(0, 10);
  const latest = recent[0];

  if (!latest) return { score: 0, ictScore: 0, orderFlowScore: 0, bias: "NEUTRAL", confluences: ["No data received yet"], orderFlowConfluences: [], warnings: [], hasOrderFlow: false };

  // ── ICT Signals ────────────────────────────────────────────────────────────

  // Killzone check
  if (latest.killzone) {
    const kzLabel = latest.killzone.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    confluences.push(`Active Killzone: ${kzLabel}`);
    bullPoints += 8;
    bearPoints += 8;
  } else {
    warnings.push("No active killzone — off-session trade");
  }

  // Market structure
  if (latest.marketStructure) {
    if (latest.marketStructure.includes("bull")) {
      confluences.push(`Bullish Market Structure: ${latest.marketStructure.replace(/_/g, " ").toUpperCase()}`);
      bullPoints += 20;
    } else if (latest.marketStructure.includes("bear")) {
      confluences.push(`Bearish Market Structure: ${latest.marketStructure.replace(/_/g, " ").toUpperCase()}`);
      bearPoints += 20;
    }
  }

  // FVG
  if (latest.fvgBull) { confluences.push("Bullish Fair Value Gap present"); bullPoints += 15; }
  if (latest.fvgBear) { confluences.push("Bearish Fair Value Gap present"); bearPoints += 15; }

  // Order Blocks
  if (latest.obBull) { confluences.push("Bullish Order Block in range"); bullPoints += 12; }
  if (latest.obBear) { confluences.push("Bearish Order Block in range"); bearPoints += 12; }

  // Liquidity sweeps
  if (latest.sweepLow) { confluences.push("Recent low swept — bullish setup likely"); bullPoints += 18; }
  if (latest.sweepHigh) { confluences.push("Recent high swept — bearish setup likely"); bearPoints += 18; }

  // Premium / Discount
  if (latest.discount) { confluences.push("Price in discount zone (below EQ) — long bias"); bullPoints += 12; }
  if (latest.premium) { confluences.push("Price in premium zone (above EQ) — short bias"); bearPoints += 12; }

  // VWAP relationship
  if (latest.vwap && latest.close) {
    if (latest.close > latest.vwap) { confluences.push("Price above VWAP — bullish intraday"); bullPoints += 8; }
    else { confluences.push("Price below VWAP — bearish intraday"); bearPoints += 8; }
  }

  // Trend consistency across recent bars
  const bullBars = recent.filter(w => (w.marketStructure || "").includes("bull")).length;
  const bearBars = recent.filter(w => (w.marketStructure || "").includes("bear")).length;
  if (bullBars > bearBars + 2) { confluences.push("Consistent bullish structure (multi-bar)"); bullPoints += 10; }
  if (bearBars > bullBars + 2) { confluences.push("Consistent bearish structure (multi-bar)"); bearPoints += 10; }

  // ── Order Flow Signals (Bookmap CME) ───────────────────────────────────────
  // Find the most recent Bookmap signal
  const ofLatest = recent.find(w => w.source === "bookmap_cme");
  const hasOrderFlow = !!ofLatest;

  if (ofLatest) {
    const { delta, bidStackSize, askStackSize, absorptionBull, absorptionBear,
            imbalanceBull, imbalanceBear, largeBuyCount, largeSellCount, vapPoc, close } = ofLatest;

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
  if (latest.close && latest.high && latest.low) {
    const range = latest.high - latest.low;
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

  return { score, ictScore, orderFlowScore, bias, confluences, orderFlowConfluences, warnings, hasOrderFlow };
}

// ── Build AI context prompt ──────────────────────────────────────────────────
function buildAnalysisPrompt(
  webhooks: ReturnType<typeof storage.getRecentWebhooks>,
  score: number,
  bias: string,
  confluences: string[],
  warnings: string[],
  userQuestion?: string
): string {
  const latest = webhooks[0];
  const priceStr = latest?.close ? `$${latest.close.toLocaleString()}` : "unknown";
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

  const systemPrompt = `You are an elite NQ futures quant analyst combining ICT (Inner Circle Trader) methodology with live order flow analysis from Sierra Chart CME data.
You analyze NQ (Nasdaq 100 E-mini futures) using: kill zones (London Open 2-5am CT, NY Open 7-10am CT, NY Close 1-3pm CT), 
market structure (BOS/CHoCH), fair value gaps, order blocks, liquidity sweeps, premium/discount zones, VWAP, and 15-min bias with 1-min entries.
You also analyze order flow from Sierra Chart: delta, CVD, DOM depth (bid/ask stack), absorption events, large prints, and volume POC.

Your job: give precise, actionable trade analysis that COMBINES ICT context with order flow confirmation. Be direct like a prop desk analyst.
Never give generic advice. Always specify: bias, entry zone, stop, targets, and WHY with both ICT reasons AND order flow confirmation.

CURRENT MARKET DATA:
- Instrument: NQ Futures (NQ1!)
- Latest Price: ${priceStr}
- VWAP: ${vwapStr}
- Combined Setup Score: ${score}/100
- Session Bias: ${bias}
- ICT Confluences: ${confluences.join("; ")}
- Warnings: ${warnings.length ? warnings.join("; ") : "None"}

${ofSection}

RECENT SIGNAL HISTORY (newest first):
${recentSignals || "  No signals received yet"}`; 

  const userPrompt = userQuestion 
    ? userQuestion 
    : `Based on the current ICT signals and setup score of ${score}/100 with a ${bias} bias, provide your complete trade analysis including: session bias reasoning, setup score breakdown, specific entry zone, stop loss, and two targets. Also note any key risks.`;

  return `${systemPrompt}\n\nUser Question: ${userPrompt}`;
}

// ── Parse AI trade plan from narrative ──────────────────────────────────────
function parseTradePlan(narrative: string, latest: ReturnType<typeof storage.getLatestWebhook>) {
  const entryMatch = narrative.match(/entry[:\s]+\$?([\d,]+(?:\s*-\s*[\d,]+)?)/i);
  const stopMatch = narrative.match(/stop[:\s]+\$?([\d,]+)/i);
  const t1Match = narrative.match(/target\s*1[:\s]+\$?([\d,]+)/i);
  const t2Match = narrative.match(/target\s*2[:\s]+\$?([\d,]+)/i);

  return {
    entryZone: entryMatch?.[1] || (latest?.close ? `${(latest.close - 5).toFixed(0)} - ${(latest.close + 5).toFixed(0)}` : null),
    stopLoss: stopMatch?.[1] || null,
    target1: t1Match?.[1] || null,
    target2: t2Match?.[1] || null,
  };
}

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

      // Auto-generate analysis on webhook if AI key is present
      if (process.env.ANTHROPIC_API_KEY) {
        const webhooks = storage.getRecentWebhooks(10);
        const { score, ictScore, bias, confluences, warnings } = scoreSetup(webhooks);

        if (score >= 40) {
          try {
            const prompt = buildAnalysisPrompt(webhooks, score, bias, confluences, warnings);
            const msg = await anthropic.messages.create({
              model: "claude-opus-4-5",
              max_tokens: 800,
              messages: [{ role: "user", content: prompt }],
            });
            const narrative = (msg.content[0] as any).text;
            const latest = webhooks[0];
            const tradePlan = parseTradePlan(narrative, latest);

            const direction = bias === "BULLISH" ? "LONG" : bias === "BEARISH" ? "SHORT" : "WAIT";

            storage.saveAnalysis({
              createdAt: Date.now(),
              latestPrice: latest?.close || null,
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

      return res.json({ ok: true, id: saved.id });
    } catch (err) {
      console.error("Webhook error:", err);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ── POST /api/simulate — Inject test/demo data ─────────────────────────────
  app.post("/api/simulate", async (req, res) => {
    const scenarios = [
      {
        timeframe: "15", close: 21420, high: 21445, low: 21390, open: 21400, volume: 12500,
        vwap: 21405, killzone: "ny_open", marketStructure: "BOS_bull",
        fvg_bull: 1, sweep_low: 1, discount: 1,
      },
      {
        timeframe: "1", close: 21428, high: 21435, low: 21415, open: 21420, volume: 3200,
        vwap: 21408, killzone: "ny_open", marketStructure: "CHoCH_bull",
        ob_bull: 1, fvg_bull: 1, discount: 1,
      },
      {
        timeframe: "15", close: 21380, high: 21410, low: 21360, open: 21395, volume: 9800,
        vwap: 21410, killzone: "ny_close", marketStructure: "BOS_bear",
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
    const { score, ictScore, bias, confluences, warnings } = scoreSetup(webhooks);

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
    const { score, ictScore, bias, confluences, warnings } = scoreSetup(webhooks);

    if (!process.env.ANTHROPIC_API_KEY) {
      // Demo mode — return scored analysis without AI narrative
      const direction = bias === "BULLISH" ? "LONG" : bias === "BEARISH" ? "SHORT" : "WAIT";
      const latest = webhooks[0];
      const demoNarrative = `[DEMO MODE — Add ANTHROPIC_API_KEY for full AI analysis]\n\nSetup Score: ${score}/100\nBias: ${bias}\n\nActive Confluences:\n${confluences.map(c => `• ${c}`).join("\n")}\n\n${warnings.length ? `Warnings:\n${warnings.map(w => `⚠ ${w}`).join("\n")}\n\n` : ""}Based on the current ICT signals, the market shows a ${bias.toLowerCase()} setup. ${direction === "WAIT" ? "Confluence is mixed — wait for clearer structure." : `Look for ${direction === "LONG" ? "bullish" : "bearish"} confirmation on the 1-minute chart within the identified zones.`}`;

      const analysis = storage.saveAnalysis({
        createdAt: Date.now(),
        latestPrice: latest?.close || null,
        sessionBias: bias,
        setupScore: score,
        tradeDirection: direction,
        entryZone: latest?.close ? `${(latest.close - 8).toFixed(0)} - ${(latest.close + 3).toFixed(0)}` : null,
        stopLoss: latest?.close ? `${(latest.close - 20).toFixed(0)}` : null,
        target1: latest?.close ? `${(latest.close + 25).toFixed(0)}` : null,
        target2: latest?.close ? `${(latest.close + 50).toFixed(0)}` : null,
        narrative: demoNarrative,
        confluences: JSON.stringify(confluences),
        warnings: warnings.length ? JSON.stringify(warnings) : null,
        triggeredBy: "manual",
      });
      return res.json(analysis);
    }

    try {
      const prompt = buildAnalysisPrompt(webhooks, score, bias, confluences, warnings);
      const msg = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      });
      const narrative = (msg.content[0] as any).text;
      const latest = webhooks[0];
      const tradePlan = parseTradePlan(narrative, latest);
      const direction = bias === "BULLISH" ? "LONG" : bias === "BEARISH" ? "SHORT" : "WAIT";

      const analysis = storage.saveAnalysis({
        createdAt: Date.now(),
        latestPrice: latest?.close || null,
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

        if (triggers.length > 0 && process.env.ANTHROPIC_API_KEY) {
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
  app.post("/api/scorecard/simulate", (req, res) => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const demoEntry = {
      sessionDate: today,
      createdAt: Date.now(),
      morningBias: "BULLISH",
      morningScore: 72,
      setup1Name: "London Sweep → NY Reversal Long",
      setup1Direction: "LONG",
      setup1Entry: 21420,
      setup1Sl: 21398,
      setup1Tp1: 21455,
      setup1Tp2: 21510,
      setup1Confluences: JSON.stringify(["London low swept", "Bullish FVG", "NY Open killzone", "Discount zone"]),
      setup1Outcome: "TP2",
      setup1EntryTriggered: 1,
      setup1Tp1Hit: 1,
      setup1Tp2Hit: 1,
      setup1Stopped: 0,
      setup1PnlPts: 90,
      setup2Name: "VWAP Rejection Short",
      setup2Direction: "SHORT",
      setup2Entry: 21510,
      setup2Sl: 21532,
      setup2Tp1: 21475,
      setup2Tp2: 21440,
      setup2Confluences: JSON.stringify(["Bearish OB at VWAP", "Premium zone", "NY close killzone"]),
      setup2Outcome: "NO_TRIGGER",
      setup2EntryTriggered: 0,
      setup2Tp1Hit: 0,
      setup2Tp2Hit: 0,
      setup2Stopped: 0,
      setup2PnlPts: 0,
      sessionHigh: 21518,
      sessionLow: 21388,
      sessionOpen: 21402,
      sessionClose: 21490,
      actualDirection: "UP",
      biasCorrect: 1,
      reviewNarrative: "[DEMO] Perfect ICT playbook day. London swept the Asian low, creating the liquidity grab that fueled the NY morning pump. Setup 1 played out cleanly: price tapped the FVG at 21,420, bounced with strong delta, and ran all the way to TP2 at 21,510. Setup 2 never triggered — price stalled just below the entry zone before the close. Bias was correct. Key win: trusting the London sweep thesis instead of fading the initial push.",
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
    const price = latest?.close ?? 21420;

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
