import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, gte, and } from "drizzle-orm";
import {
  webhookPayloads,
  analyses,
  chatMessages,
  commentary,
  scorecard,
  type WebhookPayload,
  type InsertWebhookPayload,
  type Analysis,
  type InsertAnalysis,
  type ChatMessage,
  type InsertChatMessage,
  type Commentary,
  type InsertCommentary,
  type Scorecard,
  type InsertScorecard,
} from "@shared/schema";

// Use Railway persistent volume if mounted, otherwise local dev fallback
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? require("path").join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "data.db")
  : "data.db";
const sqlite = new Database(DB_PATH);
const db = drizzle(sqlite);

// Migrations
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS webhook_payloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at INTEGER NOT NULL,
    ticker TEXT NOT NULL DEFAULT 'NQ1!',
    timeframe TEXT NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume REAL,
    vwap REAL,
    killzone TEXT,
    market_structure TEXT,
    fvg_bull INTEGER DEFAULT 0,
    fvg_bear INTEGER DEFAULT 0,
    ob_bull INTEGER DEFAULT 0,
    ob_bear INTEGER DEFAULT 0,
    sweep_high INTEGER DEFAULT 0,
    sweep_low INTEGER DEFAULT 0,
    premium INTEGER DEFAULT 0,
    discount INTEGER DEFAULT 0,
    raw_json TEXT,
    source TEXT,
    bid_stack_size INTEGER,
    ask_stack_size INTEGER,
    delta INTEGER,
    buy_volume INTEGER,
    sell_volume INTEGER,
    large_trade_count INTEGER,
    large_buy_count INTEGER,
    large_sell_count INTEGER,
    absorption_bull INTEGER DEFAULT 0,
    absorption_bear INTEGER DEFAULT 0,
    vap_poc REAL,
    imbalance_bull INTEGER DEFAULT 0,
    imbalance_bear INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    latest_price REAL,
    session_bias TEXT NOT NULL,
    setup_score INTEGER NOT NULL,
    trade_direction TEXT,
    entry_zone TEXT,
    stop_loss TEXT,
    target1 TEXT,
    target2 TEXT,
    narrative TEXT NOT NULL,
    confluences TEXT NOT NULL,
    warnings TEXT,
    triggered_by TEXT
  );

  CREATE TABLE IF NOT EXISTS commentary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    type TEXT NOT NULL,
    urgency TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    price REAL,
    suggested_sl REAL,
    suggested_tp1 REAL,
    suggested_tp2 REAL,
    trigger_source TEXT,
    prev_bias TEXT,
    new_bias TEXT
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    session_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scorecard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_date TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    morning_bias TEXT,
    morning_score INTEGER,
    setup1_name TEXT,
    setup1_direction TEXT,
    setup1_entry REAL,
    setup1_sl REAL,
    setup1_tp1 REAL,
    setup1_tp2 REAL,
    setup1_confluences TEXT,
    setup1_outcome TEXT,
    setup1_entry_triggered INTEGER DEFAULT 0,
    setup1_tp1_hit INTEGER DEFAULT 0,
    setup1_tp2_hit INTEGER DEFAULT 0,
    setup1_stopped INTEGER DEFAULT 0,
    setup1_pnl_pts REAL,
    setup2_name TEXT,
    setup2_direction TEXT,
    setup2_entry REAL,
    setup2_sl REAL,
    setup2_tp1 REAL,
    setup2_tp2 REAL,
    setup2_confluences TEXT,
    setup2_outcome TEXT,
    setup2_entry_triggered INTEGER DEFAULT 0,
    setup2_tp1_hit INTEGER DEFAULT 0,
    setup2_tp2_hit INTEGER DEFAULT 0,
    setup2_stopped INTEGER DEFAULT 0,
    setup2_pnl_pts REAL,
    session_high REAL,
    session_low REAL,
    session_open REAL,
    session_close REAL,
    actual_direction TEXT,
    bias_correct INTEGER,
    review_narrative TEXT,
    key_lessons TEXT,
    rolling_win_rate REAL,
    rolling_bias_accuracy REAL,
    rolling_avg_pnl_pts REAL
  );

  CREATE TABLE IF NOT EXISTS trade_signals (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    entry REAL NOT NULL,
    sl REAL NOT NULL,
    tp1 REAL NOT NULL,
    tp2 REAL NOT NULL,
    qty INTEGER DEFAULT 1,
    session TEXT,
    confidence INTEGER DEFAULT 0,
    reason TEXT,
    source TEXT DEFAULT 'tradingview',
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    fill_price REAL,
    fill_time TEXT,
    exit_price REAL,
    pnl_points REAL,
    pnl_dollars REAL,
    exit_reason TEXT,
    result TEXT
  );
`);

// ── Trade Signal DB helpers (raw sqlite for speed) ─────────────────────────
export function dbSaveSignal(sig: {
  id: string; direction: string; entry: number; sl: number; tp1: number; tp2: number;
  qty: number; session: string; confidence: number; reason: string; source?: string;
  createdAt: number; status: string;
}): void {
  sqlite.prepare(`
    INSERT OR REPLACE INTO trade_signals
      (id, direction, entry, sl, tp1, tp2, qty, session, confidence, reason, source, created_at, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(sig.id, sig.direction, sig.entry, sig.sl, sig.tp1, sig.tp2,
         sig.qty, sig.session, sig.confidence, sig.reason, sig.source ?? 'tradingview',
         sig.createdAt, sig.status);
}

export function dbGetPendingSignals(): any[] {
  return sqlite.prepare(`SELECT * FROM trade_signals WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

export function dbUpdateSignalStatus(id: string, status: string, extra?: Record<string, any>): void {
  const fields = ['status = ?'];
  const vals: any[] = [status];
  if (extra?.fill_price  != null) { fields.push('fill_price = ?');  vals.push(extra.fill_price); }
  if (extra?.exit_price  != null) { fields.push('exit_price = ?');  vals.push(extra.exit_price); }
  if (extra?.pnl_points  != null) { fields.push('pnl_points = ?');  vals.push(extra.pnl_points); }
  if (extra?.result      != null) { fields.push('result = ?');       vals.push(extra.result); }
  if (extra?.exit_reason != null) { fields.push('exit_reason = ?'); vals.push(extra.exit_reason); }
  vals.push(id);
  sqlite.prepare(`UPDATE trade_signals SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function dbGetRecentSignals(limit = 50): any[] {
  return sqlite.prepare(`SELECT * FROM trade_signals ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export interface IStorage {
  // Webhooks
  saveWebhook(data: InsertWebhookPayload): WebhookPayload;
  getRecentWebhooks(limit?: number): WebhookPayload[];
  getLatestWebhook(): WebhookPayload | undefined;
  clearSeedData(): { deletedWebhooks: number; deletedCommentary: number };

  // Analyses
  saveAnalysis(data: InsertAnalysis): Analysis;
  getRecentAnalyses(limit?: number): Analysis[];
  getLatestAnalysis(): Analysis | undefined;

  // Chat
  saveChatMessage(data: InsertChatMessage): ChatMessage;
  getChatMessages(sessionId: string): ChatMessage[];
  getRecentChatSessions(): string[];

  // Commentary
  saveCommentary(data: InsertCommentary): Commentary;
  getRecentCommentary(limit?: number): Commentary[];
  getLatestCommentary(): Commentary | undefined;

  // Scorecard
  saveScorecardEntry(data: InsertScorecard): Scorecard;
  upsertScorecardEntry(data: InsertScorecard): Scorecard;
  getScorecardEntry(sessionDate: string): Scorecard | undefined;
  getRecentScorecard(limit?: number): Scorecard[];
  getScorecardStats(): { winRate: number; biasAccuracy: number; avgPnlPts: number; totalSessions: number; };
}

export const storage: IStorage = {
  saveWebhook(data) {
    return db.insert(webhookPayloads).values(data).returning().get();
  },
  getRecentWebhooks(limit = 50) {
    return db.select().from(webhookPayloads).orderBy(desc(webhookPayloads.receivedAt)).limit(limit).all();
  },
  getLatestWebhook() {
    return db.select().from(webhookPayloads).orderBy(desc(webhookPayloads.receivedAt)).limit(1).get();
  },
  clearSeedData() {
    // Remove any webhooks where close price is clearly demo/seed data (below 25000)
    const wResult = sqlite.prepare("DELETE FROM webhook_payloads WHERE close IS NOT NULL AND close < 25000").run();
    // Remove demo commentary (triggerSource LIKE 'demo_%' or price < 25000)
    const cResult = sqlite.prepare("DELETE FROM commentary WHERE price IS NOT NULL AND price < 25000").run();
    return { deletedWebhooks: wResult.changes, deletedCommentary: cResult.changes };
  },

  saveAnalysis(data) {
    return db.insert(analyses).values(data).returning().get();
  },
  getRecentAnalyses(limit = 20) {
    return db.select().from(analyses).orderBy(desc(analyses.createdAt)).limit(limit).all();
  },
  getLatestAnalysis() {
    return db.select().from(analyses).orderBy(desc(analyses.createdAt)).limit(1).get();
  },

  saveChatMessage(data) {
    return db.insert(chatMessages).values(data).returning().get();
  },
  getChatMessages(sessionId) {
    return db.select().from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(chatMessages.createdAt)
      .all();
  },
  getRecentChatSessions() {
    const rows = db.select({ sessionId: chatMessages.sessionId }).from(chatMessages)
      .orderBy(desc(chatMessages.createdAt))
      .all();
    const seen = new Set<string>();
    const sessions: string[] = [];
    for (const r of rows) {
      if (!seen.has(r.sessionId)) {
        seen.add(r.sessionId);
        sessions.push(r.sessionId);
        if (sessions.length >= 10) break;
      }
    }
    return sessions;
  },

  saveCommentary(data) {
    return db.insert(commentary).values(data).returning().get();
  },
  getRecentCommentary(limit = 50) {
    return db.select().from(commentary).orderBy(desc(commentary.createdAt)).limit(limit).all();
  },
  getLatestCommentary() {
    return db.select().from(commentary).orderBy(desc(commentary.createdAt)).limit(1).get();
  },

  saveScorecardEntry(data) {
    return db.insert(scorecard).values(data).returning().get();
  },
  upsertScorecardEntry(data) {
    // Use raw SQL for upsert on session_date unique constraint
    const existing = db.select().from(scorecard)
      .where(eq(scorecard.sessionDate, data.sessionDate))
      .limit(1).get();
    if (existing) {
      return db.update(scorecard)
        .set(data)
        .where(eq(scorecard.sessionDate, data.sessionDate))
        .returning().get();
    }
    return db.insert(scorecard).values(data).returning().get();
  },
  getScorecardEntry(sessionDate) {
    return db.select().from(scorecard)
      .where(eq(scorecard.sessionDate, sessionDate))
      .limit(1).get();
  },
  getRecentScorecard(limit = 60) {
    return db.select().from(scorecard)
      .orderBy(desc(scorecard.sessionDate))
      .limit(limit)
      .all();
  },
  getScorecardStats() {
    const rows = db.select().from(scorecard)
      .orderBy(desc(scorecard.sessionDate))
      .limit(20)
      .all();
    if (!rows.length) return { winRate: 0, biasAccuracy: 0, avgPnlPts: 0, totalSessions: 0 };
    const graded = rows.filter(r => r.setup1Outcome && r.setup1Outcome !== "PENDING");
    const wins = graded.filter(r =>
      r.setup1Outcome === "TP1" || r.setup1Outcome === "TP2" ||
      r.setup2Outcome === "TP1" || r.setup2Outcome === "TP2"
    ).length;
    const biasRows = rows.filter(r => r.biasCorrect !== null && r.biasCorrect !== undefined);
    const biasCorrect = biasRows.filter(r => r.biasCorrect === 1).length;
    const pnlRows = rows.filter(r => r.setup1PnlPts !== null || r.setup2PnlPts !== null);
    const totalPnl = pnlRows.reduce((sum, r) => {
      return sum + (r.setup1PnlPts ?? 0) + (r.setup2PnlPts ?? 0);
    }, 0);
    return {
      winRate: graded.length ? Math.round((wins / graded.length) * 100) : 0,
      biasAccuracy: biasRows.length ? Math.round((biasCorrect / biasRows.length) * 100) : 0,
      avgPnlPts: pnlRows.length ? parseFloat((totalPnl / pnlRows.length).toFixed(1)) : 0,
      totalSessions: rows.length,
    };
  },
};
