/**
 * RiskEngine.ts — v2
 *
 * Fixes applied:
 *  #1  — Uses shared getDb() from db.ts (Railway persistent volume)
 *  #7  — Daily loss uses $2/pt × 4 contracts = $8/pt (MNQ, not NQ)
 *  #10 — Session cap is combined-direction (3 total per killzone) — counting
 *         is now done in signalEngine.ts countSessionTotal(); RiskEngine only
 *         checks daily-loss and consecutive-loss limits
 *  #11 — Removed 30-min cooldown-after-any-stop; cooldown lives only in
 *         MuzziBot (20min after TP2). RiskEngine no longer blocks on stops.
 */

import { getDb } from './db';

const db = getDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT
  );
`);

export interface RiskConfig {
  enabled: boolean;
  /** Daily loss limit in dollars — MNQ $2/pt × 4 = $8/pt */
  maxDailyLossDollars: number;
  maxConsecutiveLosses: number;
  blockLunchEt: boolean;
  blockNewsMinuteWindows: boolean;
}

export interface RiskDecision {
  allowed: boolean;
  reason: string;
  details?: Record<string, any>;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  enabled: true,
  /** $400 = 50pt loss × $8/pt (4 MNQ) — roughly 2.5 full stops before lockout */
  maxDailyLossDollars: 400,
  maxConsecutiveLosses: 3,
  blockLunchEt: true,
  blockNewsMinuteWindows: true,
};

function todayEt(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function etMinutesNow(): number {
  const etStr = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [h, m] = etStr.split(':').map(Number);
  return h * 60 + m;
}

function queryClosedToday(): any[] {
  const start = new Date(`${todayEt()}T00:00:00`).getTime();
  return db.prepare(`
    SELECT data FROM trade_signals
    WHERE created_at >= ?
    ORDER BY created_at DESC
  `).all(start).map((row: any) => {
    try { return JSON.parse(row.data); } catch { return null; }
  }).filter(Boolean);
}

function logRiskEvent(eventType: string, message: string, data?: Record<string, any>) {
  db.prepare(`INSERT INTO risk_events (created_at, event_type, message, data) VALUES (?, ?, ?, ?)`)
    .run(Date.now(), eventType, message, data ? JSON.stringify(data) : null);
}

function consecutiveLosses(signals: any[]): number {
  let count = 0;
  const closed = signals
    .filter(s => s.status === 'closed' && s.result && s.result !== 'EXPIRED')
    .sort((a: any, b: any) => b.createdAt - a.createdAt);
  for (const s of closed) {
    const isLoss = s.result === 'STOPPED' || (s.pnlPoints ?? 0) < 0;
    if (!isLoss) break;
    count++;
  }
  return count;
}

function isLunchBlocked(): boolean {
  const m = etMinutesNow();
  return m >= (11 * 60 + 30) && m < (13 * 60);
}

function isNewsMinuteWindow(): boolean {
  const minute = etMinutesNow() % 60;
  return minute <= 5 || (minute >= 25 && minute <= 35) || minute >= 55;
}

export function evaluateRiskGate(args: {
  direction: 'long' | 'short';
  session: string;
  confidence?: number;
  config?: Partial<RiskConfig>;
}): RiskDecision {
  const cfg = { ...DEFAULT_RISK_CONFIG, ...(args.config || {}) };
  if (!cfg.enabled) return { allowed: true, reason: 'Risk engine disabled' };

  const signals = queryClosedToday();

  // Fix #7: PnL uses MNQ $2/pt × 4 contracts.
  // pnlDollars is now computed correctly in signalEngine.ts updateSignalResult().
  // Here we trust pnlDollars if set; fallback computes as $8/pt.
  const todayPnl = signals
    .filter((s: any) => s.status === 'closed')
    .reduce((sum: number, s: any) => {
      if (s.pnlDollars !== undefined && s.pnlDollars !== null) return sum + s.pnlDollars;
      return sum + ((s.pnlPoints ?? 0) * 8); // $2/pt × 4 contracts
    }, 0);

  if (todayPnl <= -Math.abs(cfg.maxDailyLossDollars)) {
    const reason = `Daily loss lockout hit: $${todayPnl.toFixed(2)}`;
    logRiskEvent('daily_loss_lockout', reason, { todayPnl, maxDailyLossDollars: cfg.maxDailyLossDollars });
    return { allowed: false, reason, details: { todayPnl } };
  }

  const lossStreak = consecutiveLosses(signals);
  if (lossStreak >= cfg.maxConsecutiveLosses) {
    const reason = `Consecutive loss lockout: ${lossStreak} losses`;
    logRiskEvent('loss_streak_lockout', reason, { lossStreak });
    return { allowed: false, reason, details: { lossStreak } };
  }

  // Fix #11: NO stop-cooldown in RiskEngine.
  // Cooldown is managed exclusively by MuzziBot's 20-min-after-TP2 gate.

  if (cfg.blockLunchEt && isLunchBlocked()) {
    const reason = 'Lunch block active: 11:30–13:00 ET';
    logRiskEvent('lunch_lockout', reason);
    return { allowed: false, reason };
  }

  if (cfg.blockNewsMinuteWindows && isNewsMinuteWindow()) {
    const reason = 'Generic news-time lockout active: near :00 or :30';
    logRiskEvent('news_window_lockout', reason);
    return { allowed: false, reason };
  }

  // Fix #10: per-session killzone cap is handled in signalEngine.ts countSessionTotal()
  // RiskEngine no longer duplicates per-direction counts.

  return { allowed: true, reason: 'Risk checks passed', details: { todayPnl, lossStreak } };
}

export function getRiskSnapshot(): object {
  const signals = queryClosedToday();
  const todayPnl = signals.filter((s: any) => s.status === 'closed')
    .reduce((sum: number, s: any) => {
      if (s.pnlDollars !== undefined) return sum + s.pnlDollars;
      return sum + ((s.pnlPoints ?? 0) * 8);
    }, 0);
  return {
    dateEt: todayEt(),
    todayPnlDollars: Number(todayPnl.toFixed(2)),
    consecutiveLosses: consecutiveLosses(signals),
    closedTradesToday: signals.filter((s: any) => s.status === 'closed').length,
    pendingOrFilled: signals.filter((s: any) => ['pending', 'received', 'entered', 'filled'].includes(s.status)).length,
    config: DEFAULT_RISK_CONFIG,
  };
}
