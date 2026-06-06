/**
 * RiskEngine.ts
 *
 * Central server-side risk gate for Muzzi AI.
 * Blocks new automated trade signals when daily/session limits are hit.
 * Uses the existing SQLite data.db trade_signals table used by signalEngine.ts.
 */

import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'data.db');
const db = new Database(dbPath);

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
  maxDailyLossDollars: number;
  maxConsecutiveLosses: number;
  maxLondonLongs: number;
  maxLondonShorts: number;
  maxNyLongs: number;
  maxNyShorts: number;
  maxAsiaLongs: number;
  maxAsiaShorts: number;
  cooldownAfterStopMinutes: number;
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
  maxDailyLossDollars: 1000,
  maxConsecutiveLosses: 3,
  maxLondonLongs: 3,
  maxLondonShorts: 3,
  maxNyLongs: 3,
  maxNyShorts: 3,
  maxAsiaLongs: 3,
  maxAsiaShorts: 3,
  cooldownAfterStopMinutes: 30,
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

function normalizeSession(session?: string): 'asia' | 'london' | 'ny' | 'other' {
  const s = (session || '').toLowerCase();
  if (s.includes('asia')) return 'asia';
  if (s.includes('london')) return 'london';
  if (s.includes('ny') || s.includes('new_york')) return 'ny';
  return 'other';
}

function queryClosedToday(): any[] {
  const start = new Date(`${todayEt()}T00:00:00-04:00`).getTime();
  return db.prepare(`
    SELECT data, created_at, status
    FROM trade_signals
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
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const s of closed) {
    const isLoss = s.result === 'STOPPED' || (s.pnlPoints ?? 0) < 0;
    if (!isLoss) break;
    count++;
  }
  return count;
}

function recentStopCooldown(signals: any[], cooldownMinutes: number): boolean {
  const cutoff = Date.now() - cooldownMinutes * 60 * 1000;
  return signals.some(s =>
    s.status === 'closed' &&
    (s.result === 'STOPPED' || (s.pnlPoints ?? 0) < 0) &&
    (s.closedAt ?? s.createdAt) >= cutoff
  );
}

function countSessionDirection(signals: any[], session: string, direction: string): number {
  return signals.filter(s => {
    const sameSession = normalizeSession(s.session) === normalizeSession(session);
    return sameSession && s.direction === direction && ['pending', 'received', 'filled', 'closed'].includes(s.status);
  }).length;
}

function isLunchBlocked(): boolean {
  const m = etMinutesNow();
  return m >= (11 * 60 + 30) && m < (13 * 60);
}

function isNewsMinuteWindow(): boolean {
  // Conservative generic lockout: +/- 5 minutes around :00 and :30.
  // Replace with real economic calendar later.
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
  const todayPnl = signals
    .filter(s => s.status === 'closed')
    .reduce((sum, s) => sum + (s.pnlDollars ?? ((s.pnlPoints ?? 0) * 20)), 0);

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

  if (recentStopCooldown(signals, cfg.cooldownAfterStopMinutes)) {
    const reason = `Cooldown active after stop/loss (${cfg.cooldownAfterStopMinutes} min)`;
    logRiskEvent('cooldown_lockout', reason, { cooldownAfterStopMinutes: cfg.cooldownAfterStopMinutes });
    return { allowed: false, reason };
  }

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

  const sess = normalizeSession(args.session);
  const dir = args.direction;
  const count = countSessionDirection(signals, args.session, dir);
  let maxAllowed = Infinity;
  if (sess === 'london' && dir === 'long') maxAllowed = cfg.maxLondonLongs;
  if (sess === 'london' && dir === 'short') maxAllowed = cfg.maxLondonShorts;
  if (sess === 'ny' && dir === 'long') maxAllowed = cfg.maxNyLongs;
  if (sess === 'ny' && dir === 'short') maxAllowed = cfg.maxNyShorts;
  if (sess === 'asia' && dir === 'long') maxAllowed = cfg.maxAsiaLongs;
  if (sess === 'asia' && dir === 'short') maxAllowed = cfg.maxAsiaShorts;

  if (count >= maxAllowed) {
    const reason = `Session trade limit hit: ${sess} ${dir} ${count}/${maxAllowed}`;
    logRiskEvent('session_trade_limit', reason, { session: sess, direction: dir, count, maxAllowed });
    return { allowed: false, reason, details: { session: sess, direction: dir, count, maxAllowed } };
  }

  return { allowed: true, reason: 'Risk checks passed', details: { todayPnl, lossStreak, sessionCount: count } };
}

export function getRiskSnapshot(): object {
  const signals = queryClosedToday();
  const todayPnl = signals.filter(s => s.status === 'closed')
    .reduce((sum, s) => sum + (s.pnlDollars ?? ((s.pnlPoints ?? 0) * 20)), 0);
  return {
    dateEt: todayEt(),
    todayPnlDollars: Number(todayPnl.toFixed(2)),
    consecutiveLosses: consecutiveLosses(signals),
    closedTradesToday: signals.filter(s => s.status === 'closed').length,
    pendingOrFilled: signals.filter(s => ['pending', 'received', 'filled'].includes(s.status)).length,
    config: DEFAULT_RISK_CONFIG,
  };
}
