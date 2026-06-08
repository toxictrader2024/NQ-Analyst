/**
 * Signal Engine — patched v3
 *
 * Changes:
 *  - NT8 remains the sole execution signal source.
 *  - Adds server-side RiskEngine gate before creating pending signals.
 *  - Persists signal updates back to SQLite JSON rows.
 *  - Keeps Sierra order-flow contradiction gate.
 */

export interface TradeSignal {
  id: string;
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  qty: number;
  session: string;
  confidence: number;
  reason: string;
  createdAt: number;
  status: 'pending' | 'received' | 'filled' | 'closed' | 'expired' | 'cancelled';
  fillPrice?: number;
  fillTime?: string;
  exitPrice?: number;
  pnlPoints?: number;
  pnlDollars?: number;
  exitReason?: string;
  result?: 'TP1' | 'TP2' | 'STOPPED' | 'EXPIRED' | 'BREAKEVEN';
  closedAt?: number;
}

import Database from 'better-sqlite3';
import path from 'path';
import { evaluateRiskGate } from './RiskEngine';

const dbPath = path.resolve(process.cwd(), 'data.db');
const _db = new Database(dbPath);
_db.exec(`
  CREATE TABLE IF NOT EXISTS trade_signals (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  );
`);
try { _db.exec(`ALTER TABLE trade_signals ADD COLUMN data TEXT NOT NULL DEFAULT '{}'`); } catch (_) {}

function dbSave(sig: TradeSignal) {
  _db.prepare('INSERT OR REPLACE INTO trade_signals (id, data, created_at, status) VALUES (?, ?, ?, ?)')
    .run(sig.id, JSON.stringify(sig), sig.createdAt, sig.status);
}

function dbLoadRecent(): TradeSignal[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rows = _db.prepare('SELECT data FROM trade_signals WHERE created_at > ? ORDER BY created_at DESC LIMIT 200').all(cutoff) as any[];
  return rows.map(r => {
    try { return JSON.parse(r.data); } catch { return null; }
  }).filter(Boolean);
}

const MAX_SIGNALS = 200;
const signals: TradeSignal[] = dbLoadRecent();

function generateId(): string {
  return `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function hasActiveSignal(): boolean {
  const TEN_MIN  = 10 * 60 * 1000;
  const TWO_MIN  =  2 * 60 * 1000;
  const now = Date.now();
  return signals.some(s => {
    // Stale pending (>2min unconfirmed) = treat as expired, don't block new signal
    if (s.status === 'pending' && (now - s.createdAt) > TWO_MIN) return false;
    if (s.status === 'pending') return true;
    // received but not filled for >2min = stale, don't block
    if (s.status === 'received' && (now - s.createdAt) > TWO_MIN) return false;
    if (s.status === 'received') return true;
    if (s.status === 'filled' && (now - s.createdAt) < TEN_MIN) return true;
    return false;
  });
}

function getSessionLabel(marketData: any, fallback: string): string {
  return String(marketData.nt_session || marketData.session || marketData.killzone || fallback || 'NT8');
}

export function evaluateSignal(marketData: any, session: string): TradeSignal | null {
  if (!marketData) return null;

  const price = marketData.close as number | null;
  if (!price) return null;

  if (hasActiveSignal()) return null;

  // Support both explicit direction field AND long_signal/short_signal=1 from NT8 indicator
  let ntDirection = marketData.direction as string | undefined;
  if (!ntDirection) {
    if (marketData.long_signal  === 1) ntDirection = 'long';
    if (marketData.short_signal === 1) ntDirection = 'short';
  }
  if (ntDirection !== 'long' && ntDirection !== 'short') {
    // HARD BLOCK: NT8 is sole execution trigger.
    return null;
  }

  const isLong = ntDirection === 'long';
  const entry = price;
  const sl = marketData.nt_sl ?? (isLong ? entry - 20 : entry + 20);
  const tp1 = marketData.nt_tp1 ?? (isLong ? entry + 30 : entry - 30);
  const tp2 = marketData.nt_tp2 ?? (isLong ? entry + 70 : entry - 70);

  // Sierra order-flow contradiction gate.
  const scDelta = marketData.delta as number | null;
  const scAbsBull = marketData.absorptionBull as number | boolean | null;
  const scAbsBear = marketData.absorptionBear as number | boolean | null;
  const scImbBull = marketData.imbalanceBull as number | boolean | null;
  const scImbBear = marketData.imbalanceBear as number | boolean | null;
  const scBidStack = marketData.bidStackSize as number | null;
  const scAskStack = marketData.askStackSize as number | null;
  const scHasFreshData = scDelta !== null && scDelta !== undefined;

  if (scHasFreshData) {
    const absBull = scAbsBull === 1 || scAbsBull === true;
    const absBear = scAbsBear === 1 || scAbsBear === true;
    const imbBull = scImbBull === 1 || scImbBull === true;
    const imbBear = scImbBear === 1 || scImbBear === true;
    const domBull = scBidStack !== null && scAskStack !== null && scAskStack > 0 && scBidStack > scAskStack * 2;
    const domBear = scBidStack !== null && scAskStack !== null && scBidStack > 0 && scAskStack > scBidStack * 2;

    if (isLong && scDelta < -500 && !absBull && !imbBull && !domBull) {
      console.log(`[SignalEngine][SC VolumeGate] BLOCKED LONG @ ${entry} — delta=${scDelta}`);
      return null;
    }
    if (!isLong && scDelta > 500 && !absBear && !imbBear && !domBear) {
      console.log(`[SignalEngine][SC VolumeGate] BLOCKED SHORT @ ${entry} — delta=${scDelta}`);
      return null;
    }
  }

  const sessionLabel = getSessionLabel(marketData, session);
  const risk = evaluateRiskGate({ direction: ntDirection, session: sessionLabel, confidence: marketData.confidence });
  if (!risk.allowed) {
    console.log(`[SignalEngine][RiskGate] BLOCKED ${ntDirection.toUpperCase()} @ ${entry} — ${risk.reason}`);
    return null;
  }

  const volParts: string[] = [];
  if (scHasFreshData) {
    volParts.push(`SC delta ${scDelta! > 0 ? '+' : ''}${scDelta}`);
    if (scAbsBull === 1 || scAbsBull === true) volParts.push('bull absorb');
    if (scAbsBear === 1 || scAbsBear === true) volParts.push('bear absorb');
    if (scImbBull === 1 || scImbBull === true) volParts.push('bid imbalance');
    if (scImbBear === 1 || scImbBear === true) volParts.push('ask imbalance');
  } else {
    volParts.push('SC offline');
  }

  const signal: TradeSignal = {
    id: generateId(),
    direction: ntDirection,
    entry, sl, tp1, tp2,
    qty: 1,
    session: sessionLabel,
    confidence: marketData.confidence ?? 70,
    reason: `${marketData.reasons ?? `NT8 ${ntDirection.toUpperCase()}`} | ${volParts.join(' | ')} | Risk: ${risk.reason}`,
    createdAt: Date.now(),
    status: 'pending',
  };

  signals.unshift(signal);
  if (signals.length > MAX_SIGNALS) signals.splice(MAX_SIGNALS);
  dbSave(signal);
  console.log(`[SignalEngine][NT8 FastPath] ${signal.direction.toUpperCase()} @ ${entry} | ${signal.reason}`);
  return signal;
}

export function getPendingSignal(): TradeSignal | null {
  const pending = signals.filter(s => s.status === 'pending');
  if (!pending.length) return null;
  return pending.reduce((oldest, s) => s.createdAt < oldest.createdAt ? s : oldest);
}

export function confirmSignal(id: string): void {
  const sig = signals.find(s => s.id === id);
  if (sig && sig.status === 'pending') {
    sig.status = 'received';
    dbSave(sig);
    console.log(`[SignalEngine] Confirmed signal ${id}`);
  }
}

export function updateSignalResult(id: string, data: Partial<TradeSignal>): void {
  let sig = signals.find(s => s.id === id);
  if (!sig) {
    const row = _db.prepare('SELECT data FROM trade_signals WHERE id=?').get(id) as any;
    if (row) {
      sig = JSON.parse(row.data) as TradeSignal;
      signals.unshift(sig);
    }
  }
  if (!sig) return;

  Object.assign(sig, data);

  if (data.fillPrice !== undefined) {
    sig.fillTime = new Date().toISOString();
  }

  if (data.exitPrice !== undefined && sig.direction) {
    const raw = sig.direction === 'long' ? data.exitPrice - sig.entry : sig.entry - data.exitPrice;
    sig.pnlPoints = parseFloat(raw.toFixed(2));
    sig.pnlDollars = parseFloat((raw * 20).toFixed(2));
    sig.closedAt = Date.now();
  }

  dbSave(sig);
  console.log(`[SignalEngine] Updated signal ${id}:`, data);
}

export function getRecentSignals(limit = 50): TradeSignal[] {
  return signals.slice(0, limit);
}

export function clearExpiredSignals(): void {
  // Raised from 5min to 2min — MuzziBot polls every 5s so 2min is plenty
  // Old 5min was too short when NT8/Railway had any latency
  const TWO_MIN_MS = 2 * 60 * 1000;
  const now = Date.now();
  signals.forEach(s => {
    if (s.status === 'pending' && now - s.createdAt > TWO_MIN_MS) {
      s.status = 'expired';
      s.result = 'EXPIRED';
      dbSave(s);
      console.log(`[SignalEngine] Expired signal ${s.id}`);
    }
  });
}

export function getSignalStats(): {
  totalTrades: number;
  winRate: number;
  avgPnlPoints: number;
  todayPnlDollars: number;
} {
  const closed = signals.filter(s => s.status === 'closed' && s.result !== undefined && s.result !== 'EXPIRED');
  const wins = closed.filter(s => s.result === 'TP1' || s.result === 'TP2').length;
  const pnlPts = closed.reduce((sum, s) => sum + (s.pnlPoints ?? 0), 0);
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todaySignals = closed.filter(s => new Date(s.createdAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayStr);
  const todayPnlDollars = todaySignals.reduce((sum, s) => sum + (s.pnlDollars ?? 0), 0);
  return {
    totalTrades: closed.length,
    winRate: closed.length ? Math.round((wins / closed.length) * 100) : 0,
    avgPnlPoints: closed.length ? parseFloat((pnlPts / closed.length).toFixed(2)) : 0,
    todayPnlDollars: parseFloat(todayPnlDollars.toFixed(2)),
  };
}
