/**
 * Signal Engine — v4
 *
 * Fixes applied:
 *  #1  — Uses shared getDb() from db.ts (Railway persistent volume)
 *  #2  — Hard 15:00 ET clock block in evaluateSignal()
 *  #5  — 'entered' status treated as active in hasActiveSignal()
 *  #7  — PnL uses $2/pt MNQ (not $20/pt NQ); prefers MuzziBot totalPnlPts
 *  #10 — Session trade cap counts both directions combined (3 total per killzone)
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
  status: 'pending' | 'received' | 'entered' | 'filled' | 'closed' | 'expired' | 'cancelled';
  fillPrice?: number;
  fillTime?: string;
  exitPrice?: number;
  pnlPoints?: number;
  pnlDollars?: number;
  exitReason?: string;
  result?: 'TP1' | 'TP2' | 'STOPPED' | 'EXPIRED' | 'BREAKEVEN';
  closedAt?: number;
}

import { getDb } from './db';
import { evaluateRiskGate } from './RiskEngine';

// Single shared DB — all modules use getDb()
const _db = getDb();

_db.exec(`
  CREATE TABLE IF NOT EXISTS trade_signals (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  );
`);
// Add columns for direct close-data writes — safe to run on every startup (IF NOT EXISTS)
try { _db.exec(`ALTER TABLE trade_signals ADD COLUMN data TEXT NOT NULL DEFAULT '{}'`); } catch (_) {}
try { _db.exec(`ALTER TABLE trade_signals ADD COLUMN result TEXT`); }       catch (_) {}
try { _db.exec(`ALTER TABLE trade_signals ADD COLUMN exit_price REAL`); }    catch (_) {}
try { _db.exec(`ALTER TABLE trade_signals ADD COLUMN pnl_points REAL`); }    catch (_) {}
try { _db.exec(`ALTER TABLE trade_signals ADD COLUMN fill_price REAL`); }    catch (_) {}

function dbSave(sig: TradeSignal) {
  // Write all columns that may have NOT NULL constraints from prior Railway DB migrations.
  // The data JSON blob is the source of truth; individual columns are for DB-level queries.
  const stmt = _db.prepare(`
    INSERT OR REPLACE INTO trade_signals
      (id, data, created_at, status, direction, entry, sl, tp1, tp2, session, source, confidence, score, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  try {
    stmt.run(
      sig.id,
      JSON.stringify(sig),
      sig.createdAt ?? Date.now(),
      sig.status   ?? 'pending',
      sig.direction ?? null,
      sig.entry     ?? null,
      sig.sl        ?? null,
      sig.tp1       ?? null,
      sig.tp2       ?? null,
      sig.session   ?? null,
      sig.source    ?? 'ninjatrader',
      sig.confidence ?? null,
      sig.score      ?? null,
      sig.reason     ?? null,
    );
  } catch (e: any) {
    // Fallback: minimal insert if schema differs
    console.error('[dbSave] full insert failed, trying minimal:', e?.message);
    _db.prepare('INSERT OR REPLACE INTO trade_signals (id, data, created_at, status) VALUES (?, ?, ?, ?)')
      .run(sig.id, JSON.stringify(sig), sig.createdAt ?? Date.now(), sig.status ?? 'pending');
  }
}

function dbLoadRecent(): TradeSignal[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rows = _db.prepare('SELECT data FROM trade_signals WHERE created_at > ? ORDER BY created_at DESC LIMIT 200').all(cutoff) as any[];
  return rows.map(r => {
    try { return JSON.parse(r.data); } catch { return null; }
  }).filter(Boolean);
}

const MAX_SIGNALS = 200;

// On startup: load recent signals, expire stale pending (>2min) to prevent carry-over blocks
const signals: TradeSignal[] = (() => {
  const loaded = dbLoadRecent();
  const TWO_MIN_MS = 2 * 60 * 1000;
  const now = Date.now();
  loaded.forEach(s => {
    if (!s.direction) return;
    if ((s.status === 'pending' || s.status === 'received') && (now - s.createdAt) > TWO_MIN_MS) {
      s.status = 'expired';
      s.result = 'EXPIRED';
      dbSave(s);
      console.log(`[SignalEngine] Startup: expired stale signal ${s.id} (age ${Math.round((now - s.createdAt)/60000)}min)`);
    }
  });
  return loaded;
})();

function generateId(): string {
  return `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Fix #5: treat 'entered' as active ───────────────────────────────────────
function hasActiveSignal(): boolean {
  const TEN_MIN  = 10 * 60 * 1000;
  const TWO_MIN  =  2 * 60 * 1000;
  const now = Date.now();
  return signals.some(s => {
    // Stale pending (>2min unconfirmed) → expired, don't block
    if (s.status === 'pending' && (now - s.createdAt) > TWO_MIN) return false;
    if (s.status === 'pending') return true;
    // received but not filled for >2min → stale
    if (s.status === 'received' && (now - s.createdAt) > TWO_MIN) return false;
    if (s.status === 'received') return true;
    // FIX #5: 'entered' = MuzziBot received, submitted order — definitely active
    if (s.status === 'entered') return true;
    if (s.status === 'filled' && (now - s.createdAt) < TEN_MIN) return true;
    return false;
  });
}

// ── Fix #2: 15:00 ET hard clock block ───────────────────────────────────────
function isAfter15etHardBlock(): boolean {
  try {
    const etStr = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const [h, m] = etStr.split(':').map(Number);
    const etMin = h * 60 + m;
    return etMin >= (15 * 60); // >= 15:00 ET
  } catch {
    return false;
  }
}

// ── Fix #10: session trade cap — 3 TOTAL per killzone (not per direction) ───
function countSessionTotal(sessionLabel: string): number {
  const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return signals.filter(s => {
    if (!s.session) return false;
    const sameSession = normalizeKillzone(s.session) === normalizeKillzone(sessionLabel);
    const isToday = new Date(s.createdAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayEt;
    return sameSession && isToday && ['pending', 'received', 'entered', 'filled', 'closed'].includes(s.status);
  }).length;
}

function normalizeKillzone(session: string): string {
  const s = session.toLowerCase().replace(/[\s-]/g, '_');
  if (s.includes('london_close') || (s.includes('london') && s.includes('close'))) return 'london_close';
  if (s.includes('ny_afternoon') || s.includes('afternoon')) return 'ny_afternoon';
  if (s.includes('london')) return 'london';
  if (s.includes('ny') || s.includes('new_york')) return 'ny_open';
  if (s.includes('asia')) return 'asia';
  return s;
}

function getSessionLabel(marketData: any, fallback: string): string {
  return String(marketData.nt_session || marketData.session || marketData.killzone || fallback || 'NT8');
}

export function evaluateSignal(marketData: any, session: string): TradeSignal | null {
  if (!marketData) return null;

  const price = marketData.close as number | null;
  if (!price) return null;

  // ── Fix #2: Hard 15:00 ET block — no new signals at or after 3pm ET ────────
  if (isAfter15etHardBlock()) {
    console.log(`[SignalEngine][HardBlock] BLOCKED — past 15:00 ET hard cutoff`);
    return null;
  }

  if (hasActiveSignal()) return null;

  // NT8 is sole execution trigger
  let ntDirection = marketData.direction as string | undefined;
  if (!ntDirection) {
    if (marketData.long_signal  === 1) ntDirection = 'long';
    if (marketData.short_signal === 1) ntDirection = 'short';
  }
  if (ntDirection !== 'long' && ntDirection !== 'short') {
    return null;
  }

  const isLong = ntDirection === 'long';
  const entry = price;
  const sl = marketData.nt_sl ?? (isLong ? entry - 20 : entry + 20);
  const tp1 = marketData.nt_tp1 ?? (isLong ? entry + 30 : entry - 30);
  const tp2 = marketData.nt_tp2 ?? (isLong ? entry + 70 : entry - 70);

  // ── Fix #3 is in routes.ts — SC delta only present if fresh ─────────────────
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

    if (isLong && scDelta < -100 && !absBull && !imbBull && !domBull) {
      console.log(`[SignalEngine][SC VolumeGate] BLOCKED LONG @ ${entry} — delta=${scDelta}`);
      return null;
    }

    const positiveDeltaShortBlock = scDelta > 50 && !absBear && !imbBear && !domBear;
    const bullAbsorptionShortBlock = absBull && scDelta > 0 && !absBear;
    if (!isLong && (positiveDeltaShortBlock || bullAbsorptionShortBlock)) {
      console.log(`[SignalEngine][SC VolumeGate] BLOCKED SHORT @ ${entry} — delta=${scDelta} absBull=${absBull}`);
      return null;
    }
  }

  const sessionLabel = getSessionLabel(marketData, session);

  // ── Session allowlist ────────────────────────────────────────────────────────
  const ALLOWED_SESSIONS = ['london', 'ny_open', 'london_close', 'ny_open_london_close', 'ny_afternoon'];
  const normalizedSession = sessionLabel.toLowerCase().replace(/[\s-]/g, '_');
  if (!ALLOWED_SESSIONS.some(s => normalizedSession.includes(s))) {
    console.log(`[SignalEngine][SessionBlock] BLOCKED ${ntDirection.toUpperCase()} @ ${entry} — session='${sessionLabel}' not in allowed killzones`);
    return null;
  }

  // ── Fix #10: 3 trades total per killzone per day ─────────────────────────────
  const sessionCount = countSessionTotal(sessionLabel);
  if (sessionCount >= 3) {
    console.log(`[SignalEngine][KillzoneCap] BLOCKED ${ntDirection.toUpperCase()} @ ${entry} — session '${sessionLabel}' already has ${sessionCount}/3 trades today`);
    return null;
  }

  // ── NY Afternoon extra rules ─────────────────────────────────────────────────
  if (normalizedSession.includes('ny_afternoon')) {
    const confidence = (marketData.confidence as number) ?? 0;
    const intradayBias = (marketData.htfBias ?? marketData.bias ?? '') as string;
    const biasDirection = intradayBias.toLowerCase().includes('bull') ? 'long'
                        : intradayBias.toLowerCase().includes('bear') ? 'short'
                        : null;
    if (confidence < 65) {
      console.log(`[SignalEngine][AfternoonBlock] BLOCKED ${ntDirection.toUpperCase()} @ ${entry} — score=${confidence} < 65 required for ny_afternoon`);
      return null;
    }
    if (biasDirection && biasDirection !== ntDirection) {
      console.log(`[SignalEngine][AfternoonBlock] BLOCKED ${ntDirection.toUpperCase()} @ ${entry} — counter-trend in ny_afternoon (bias=${intradayBias})`);
      return null;
    }
  }

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

  const ntSigId = marketData.nt_signal_id ? ` | nt_id:${marketData.nt_signal_id}` : '';
  const signal: TradeSignal = {
    id: generateId(),
    direction: ntDirection,
    entry, sl, tp1, tp2,
    qty: 1,
    session: sessionLabel,
    confidence: marketData.confidence ?? 70,
    reason: `${marketData.reasons ?? `NT8 ${ntDirection.toUpperCase()}`} | ${volParts.join(' | ')} | Risk: ${risk.reason}${ntSigId}`,
    createdAt: Date.now(),
    status: 'pending',
  };

  signals.unshift(signal);
  if (signals.length > MAX_SIGNALS) signals.splice(MAX_SIGNALS);
  dbSave(signal);
  console.log(`[SignalEngine][NT8 FastPath] ${signal.direction.toUpperCase()} @ ${entry} | ${signal.reason}`);
  return signal;
}

// Test-inject: bypasses time/session gating — for pipeline verification only
export function injectTestSignal(direction: 'long'|'short', entry: number, sl: number, tp1: number, tp2: number, session = 'ny_open'): TradeSignal {
  const id = generateId();
  const sig: TradeSignal = {
    id, direction, entry, sl, tp1, tp2, session,
    status: 'pending', score: 99,
    reason: 'TEST INJECT — pipeline verification',
    source: 'ninjatrader',
    createdAt: Date.now(),
    qty: 4,
    confidence: 5,
  };
  signals.unshift(sig);
  dbSave(sig);
  console.log(`[SignalEngine] TEST INJECT: ${id} ${direction} @ ${entry}`);
  return sig;
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
  // ── FIX: Always write critical close fields directly to DB first ──────────
  // This ensures result/exitPrice/pnlPoints survive even if in-memory lookup
  // fails (e.g. Railway restarted mid-session and cleared the signals array).
  const directFields: string[] = [];
  const directVals: any[] = [];
  if (data.status     != null) { directFields.push('status = ?');      directVals.push(data.status); }
  if (data.result     != null) { directFields.push('result = ?');      directVals.push(data.result); }
  if ((data as any).exitPrice  != null) { directFields.push('exit_price = ?');  directVals.push((data as any).exitPrice); }
  if ((data as any).pnlPoints  != null) { directFields.push('pnl_points = ?');  directVals.push((data as any).pnlPoints); }
  if ((data as any).fillPrice  != null) { directFields.push('fill_price = ?');  directVals.push((data as any).fillPrice); }
  if (directFields.length > 0) {
    directVals.push(id);
    try {
      _db.prepare(`UPDATE trade_signals SET ${directFields.join(', ')} WHERE id = ?`).run(...directVals);
      console.log(`[SignalEngine] DB direct-write for ${id}:`, data);
    } catch (e: any) {
      console.error(`[SignalEngine] DB direct-write failed for ${id}:`, e?.message);
    }
  }

  // ── In-memory update ─────────────────────────────────────────────────────
  let sig = signals.find(s => s.id === id);
  if (!sig) {
    // Try to reload from DB — handles Railway restarts wiping in-memory array
    const row = _db.prepare('SELECT data FROM trade_signals WHERE id=?').get(id) as any;
    if (row) {
      try {
        sig = JSON.parse(row.data) as TradeSignal;
        if (sig) { sig.id = id; signals.unshift(sig); } // ensure id is set
      } catch { sig = undefined; }
    }
  }
  if (!sig) {
    console.warn(`[SignalEngine] updateSignalResult: signal ${id} not found in memory or DB — direct DB write already applied`);
    return;
  }

  Object.assign(sig, data);

  if (data.fillPrice !== undefined) {
    sig.fillTime = new Date().toISOString();
  }

  // ── Fix #7: PnL — prefer MuzziBot's pnlPoints; fallback to price diff ───────
  const incomingPnl = (data as any).pnlPoints;
  const incomingExit = (data as any).exitPrice;
  if (incomingExit !== undefined && sig.direction) {
    const raw = sig.direction === 'long' ? incomingExit - sig.entry : sig.entry - incomingExit;
    const pnlPts = (incomingPnl !== undefined && incomingPnl !== 0)
      ? incomingPnl
      : parseFloat(raw.toFixed(2));
    sig.pnlPoints  = pnlPts;
    sig.pnlDollars = parseFloat((pnlPts * 2 * 4).toFixed(2)); // MNQ $8/pt
    sig.closedAt   = Date.now();
  }

  dbSave(sig); // full JSON blob re-serialized with all updated fields
  console.log(`[SignalEngine] Updated signal ${id}:`, data);
}

export function getRecentSignals(limit = 50): TradeSignal[] {
  return signals.slice(0, limit);
}

export function clearExpiredSignals(): void {
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
    todayPnlDollars,
  };
}
