import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Webhook payloads received from TradingView
export const webhookPayloads = sqliteTable("webhook_payloads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  receivedAt: integer("received_at").notNull(), // unix ms
  ticker: text("ticker").notNull().default("NQ1!"),
  timeframe: text("timeframe").notNull(), // e.g. "1", "15", "60"
  open: real("open"),
  high: real("high"),
  low: real("low"),
  close: real("close"),
  volume: real("volume"),
  vwap: real("vwap"),
  // ICT signals from TV Pine Script
  killzone: text("killzone"), // "london_open", "ny_open", "ny_close", null
  marketStructure: text("market_structure"), // "BOS_bull", "BOS_bear", "CHoCH_bull", "CHoCH_bear", null
  fvgBull: integer("fvg_bull").default(0), // 1 if bullish FVG present
  fvgBear: integer("fvg_bear").default(0),
  obBull: integer("ob_bull").default(0),  // order block
  obBear: integer("ob_bear").default(0),
  sweepHigh: integer("sweep_high").default(0), // liquidity sweep
  sweepLow: integer("sweep_low").default(0),
  premium: integer("premium").default(0), // price in premium zone (above EQ)
  discount: integer("discount").default(0), // price in discount zone
  rawJson: text("raw_json"), // full original payload
  // ── Bookmap / Order Flow fields ──────────────────────────────────────────
  source: text("source"), // "tradingview" | "bookmap_cme"
  bidStackSize: integer("bid_stack_size"),   // total bid qty within depth range
  askStackSize: integer("ask_stack_size"),   // total ask qty within depth range
  delta: integer("delta"),                   // buy_vol - sell_vol this bar
  buyVolume: integer("buy_volume"),
  sellVolume: integer("sell_volume"),
  largeTradeCount: integer("large_trade_count"),
  largeBuyCount: integer("large_buy_count"),
  largeSellCount: integer("large_sell_count"),
  absorptionBull: integer("absorption_bull").default(0), // large sell but bid held
  absorptionBear: integer("absorption_bear").default(0), // large buy but ask held
  vapPoc: real("vap_poc"),                   // highest-volume price (POC)
  imbalanceBull: integer("imbalance_bull").default(0), // bid stack >> ask stack
  imbalanceBear: integer("imbalance_bear").default(0), // ask stack >> bid stack
});

// AI-generated analyses
export const analyses = sqliteTable("analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: integer("created_at").notNull(),
  // context at time of analysis
  latestPrice: real("latest_price"),
  sessionBias: text("session_bias").notNull(), // "BULLISH" | "BEARISH" | "NEUTRAL"
  setupScore: integer("setup_score").notNull(), // 0-100
  // AI outputs
  tradeDirection: text("trade_direction"), // "LONG" | "SHORT" | "WAIT"
  entryZone: text("entry_zone"), // e.g. "21,420 - 21,440"
  stopLoss: text("stop_loss"),
  target1: text("target1"),
  target2: text("target2"),
  narrative: text("narrative").notNull(), // AI full text analysis
  confluences: text("confluences").notNull(), // JSON array of active signals
  warnings: text("warnings"), // JSON array of risk flags
  triggeredBy: text("triggered_by"), // "webhook" | "manual" | "chat"
});

// Chat messages for the AI chat panel
export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: integer("created_at").notNull(),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  sessionId: text("session_id").notNull(), // group messages into sessions
});

// AI Market Commentary (live feed)
export const commentary = sqliteTable("commentary", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: integer("created_at").notNull(),
  type: text("type").notNull(), // "reversal" | "continuation" | "tp_update" | "sl_update" | "bias_change" | "absorption" | "general"
  urgency: text("urgency").notNull(), // "high" | "medium" | "low"
  title: text("title").notNull(),
  message: text("message").notNull(),
  price: real("price"),           // price at time of commentary
  suggestedSl: real("suggested_sl"),
  suggestedTp1: real("suggested_tp1"),
  suggestedTp2: real("suggested_tp2"),
  triggerSource: text("trigger_source"), // what triggered this (e.g. "absorption_detected", "structure_flip")
  prevBias: text("prev_bias"),
  newBias: text("new_bias"),
});

// ── Post-Session Scorecard ───────────────────────────────────────────────────
// One row per trading day. Populated by the 4pm CT post-session review cron.
export const scorecard = sqliteTable("scorecard", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionDate: text("session_date").notNull().unique(), // "2026-05-16" (ET date)
  createdAt: integer("created_at").notNull(),

  // Morning brief context (what the pre-market plan predicted)
  morningBias: text("morning_bias"),           // "BULLISH" | "BEARISH" | "NEUTRAL"
  morningScore: integer("morning_score"),       // 0-100

  // Setup 1
  setup1Name: text("setup1_name"),
  setup1Direction: text("setup1_direction"),    // "LONG" | "SHORT"
  setup1Entry: real("setup1_entry"),
  setup1Sl: real("setup1_sl"),
  setup1Tp1: real("setup1_tp1"),
  setup1Tp2: real("setup1_tp2"),
  setup1Confluences: text("setup1_confluences"), // JSON array
  setup1Outcome: text("setup1_outcome"),         // "TP1" | "TP2" | "STOPPED" | "NO_TRIGGER" | "PENDING"
  setup1EntryTriggered: integer("setup1_entry_triggered").default(0), // 1 if price reached entry
  setup1Tp1Hit: integer("setup1_tp1_hit").default(0),
  setup1Tp2Hit: integer("setup1_tp2_hit").default(0),
  setup1Stopped: integer("setup1_stopped").default(0),
  setup1PnlPts: real("setup1_pnl_pts"),         // net pts (negative if stopped)

  // Setup 2
  setup2Name: text("setup2_name"),
  setup2Direction: text("setup2_direction"),
  setup2Entry: real("setup2_entry"),
  setup2Sl: real("setup2_sl"),
  setup2Tp1: real("setup2_tp1"),
  setup2Tp2: real("setup2_tp2"),
  setup2Confluences: text("setup2_confluences"),
  setup2Outcome: text("setup2_outcome"),
  setup2EntryTriggered: integer("setup2_entry_triggered").default(0),
  setup2Tp1Hit: integer("setup2_tp1_hit").default(0),
  setup2Tp2Hit: integer("setup2_tp2_hit").default(0),
  setup2Stopped: integer("setup2_stopped").default(0),
  setup2PnlPts: real("setup2_pnl_pts"),

  // Session actual results
  sessionHigh: real("session_high"),
  sessionLow: real("session_low"),
  sessionOpen: real("session_open"),
  sessionClose: real("session_close"),
  actualDirection: text("actual_direction"),    // "UP" | "DOWN" | "RANGE"
  biasCorrect: integer("bias_correct"),         // 1 if morning bias matched actual direction

  // AI review narrative
  reviewNarrative: text("review_narrative"),    // AI post-mortem text
  keyLessons: text("key_lessons"),              // JSON array of lesson strings

  // Rolling edge stats (computed by cron and stored for display)
  rollingWinRate: real("rolling_win_rate"),     // % of sessions with TP1 hit (last 20)
  rollingBiasAccuracy: real("rolling_bias_accuracy"), // % bias correct (last 20)
  rollingAvgPnlPts: real("rolling_avg_pnl_pts"),      // avg pts per session (last 20)
});

export const insertScorecardSchema = createInsertSchema(scorecard).omit({ id: true });
export type InsertScorecard = z.infer<typeof insertScorecardSchema>;
export type Scorecard = typeof scorecard.$inferSelect;

export const insertCommentarySchema = createInsertSchema(commentary).omit({ id: true });
export type InsertCommentary = z.infer<typeof insertCommentarySchema>;
export type Commentary = typeof commentary.$inferSelect;

// Insert schemas
export const insertWebhookPayloadSchema = createInsertSchema(webhookPayloads).omit({ id: true });
export type InsertWebhookPayload = z.infer<typeof insertWebhookPayloadSchema>;
export type WebhookPayload = typeof webhookPayloads.$inferSelect;

export const insertAnalysisSchema = createInsertSchema(analyses).omit({ id: true });
export type InsertAnalysis = z.infer<typeof insertAnalysisSchema>;
export type Analysis = typeof analyses.$inferSelect;

export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({ id: true });
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;
