/**
 * Signal Engine
 *
 * Evaluates ICT conditions and generates automated trade signals.
 * Signals are stored in-memory (max 200) and are ephemeral — they do not
 * persist to SQLite to keep the schema untouched.
 *
 * v2 changes:
 *  - Added London killzone support (was NY-only, missing all London signals)
 *  - Added Pine Script v3 fast-path: if TV sends long_signal=1/short_signal=1,
 *    trust it directly instead of re-scoring (TV already enforces confluence gates)
 *  - Killzone now covers: London Open 2-5am ET, NY Open 9:30-11am ET, London Close 1:30-2pm ET
 */

export interface TradeSignal {
  id: string;
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  qty: number;           // always 1 for now
  session: string;
  confidence: number;    // 0-100 ICT score
  reason: string;        // human-readable confluence description
  createdAt: number;     // Date.now()
  status: 'pending' | 'received' | 'filled' | 'closed' | 'expired';
  fillPrice?: number;
  fillTime?: string;
  exitPrice?: number;
  pnlPoints?: number;
  pnlDollars?: number;
  exitReason?: string;
  result?: 'TP1' | 'TP2' | 'STOPPED' | 'EXPIRED';
}

// ── SQLite persistence ───────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import path from 'path';
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

function dbSave(sig: TradeSignal) {
  _db.prepare('INSERT OR REPLACE INTO trade_signals (id, data, created_at, status) VALUES (?, ?, ?, ?)'
  ).run(sig.id, JSON.stringify(sig), sig.createdAt, sig.status);
}
function dbUpdateStatus(id: string, status: string) {
  _db.prepare('UPDATE trade_signals SET status=?, data=(
    SELECT json_set(data, \"$.status\", ?) FROM trade_signals WHERE id=?
  ) WHERE id=?').run(status, status, id, id);
  // Simpler: reload and re-save
  const row = _db.prepare('SELECT data FROM trade_signals WHERE id=?').get(id) as any;
  if (row) {
    const sig = JSON.parse(row.data);
    sig.status = status;
    _db.prepare('UPDATE trade_signals SET status=?, data=? WHERE id=?').run(status, JSON.stringify(sig), id);
  }
}
function dbLoadRecent(): TradeSignal[] {
  const cutoff = Date.now() - 60 * 60 * 1000; // last 60 min
  const rows = _db.prepare('SELECT data FROM trade_signals WHERE created_at > ? ORDER BY created_at DESC LIMIT 200').all(cutoff) as any[];
  return rows.map(r => JSON.parse(r.data));
}

// ── In-memory store (max 200) — seeded from SQLite on startup ─────────────────
const MAX_SIGNALS = 200;
const signals: TradeSignal[] = dbLoadRecent();

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId(): string {
  return `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Returns true when current ET wall-clock time falls inside any active killzone:
 *   - London Open:   02:00 – 05:00 ET  (Asia sweep / Silver Bullet / Turtle Soup)
 *   - NY Open:       09:30 – 11:00 ET
 *   - London Close:  13:30 – 14:00 ET
 */
function isInKillzone(): { active: boolean; name: string } {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hStr, mStr] = etStr.split(':');
  const etMinutes = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);

  const londonOpen  = { start: 2  * 60,       end: 5  * 60 };       // 02:00–05:00
  const nyOpen      = { start: 9  * 60 + 30,  end: 11 * 60 };       // 09:30–11:00
  const londonClose = { start: 13 * 60 + 30,  end: 14 * 60 };       // 13:30–14:00

  if (etMinutes >= londonOpen.start  && etMinutes < londonOpen.end)
    return { active: true, name: 'london_open' };
  if (etMinutes >= nyOpen.start      && etMinutes < nyOpen.end)
    return { active: true, name: 'ny_open' };
  if (etMinutes >= londonClose.start && etMinutes < londonClose.end)
    return { active: true, name: 'london_close' };

  return { active: false, name: '' };
}

/** Returns true if any signal is currently active (pending or filled).
 *  'received' is NOT counted — that just means MuzziBot acknowledged it.
 *  'filled' only blocks if the fill was recent (< 10 min) to prevent stale fills from blocking forever.
 */
function hasActiveSignal(): boolean {
  const TEN_MIN = 10 * 60 * 1000;
  const now = Date.now();
  return signals.some(s => {
    if (s.status === 'pending') return true;
    if (s.status === 'filled' && (now - s.createdAt) < TEN_MIN) return true;
    return false;
  });
}

// ── Core evaluation ───────────────────────────────────────────────────────────

/**
 * Evaluates the latest market snapshot and returns a TradeSignal if all
 * ICT conditions are met, or null otherwise.
 *
 * FAST PATH: If the TradingView webhook includes long_signal=1 or short_signal=1
 * (set by Pine Script v3 which already enforces killzone + discount/premium +
 * min 2 confluences), we trust it directly and skip server-side re-scoring.
 *
 * STANDARD PATH: Falls back to server-side ICT score gate (score >= 65,
 * order flow >= 60, directional delta/absorption) when TV signal fields absent.
 */
export function evaluateSignal(marketData: any, session: string): TradeSignal | null {
  if (!marketData) return null;

  const {
    close: price,
    delta,
    bias,
    score,
    orderFlowScore,
    absorptionBull,
    absorptionBear,
    // Pine Script v3 signal fields (may be absent from older TV alerts)
    long_signal,
    short_signal,
    long_conf,
    short_conf,
    killzone: tvKillzone,
  } = marketData as {
    close: number | null;
    delta: number | null;
    bias: string;
    score: number;
    orderFlowScore: number;
    absorptionBull: number | boolean | null;
    absorptionBear: number | boolean | null;
    long_signal?: number;
    short_signal?: number;
    long_conf?: number;
    short_conf?: number;
    killzone?: string;
  };

  // ── Gate 1: must have a usable price ────────────────────────────────────────
  if (!price) return null;

  // ── Gate 2: one trade at a time ──────────────────────────────────────────────
  if (hasActiveSignal()) return null;

  // ════════════════════════════════════════════════════════════════════════════
  // FAST PATH — Pine Script v3 already validated confluence + killzone on-chart
  // ════════════════════════════════════════════════════════════════════════════
  // ── NT8 fast path — direction field sent directly from NQ_ICT_Signals.cs ──
  const nt_direction = (marketData as any).direction as string | undefined;
  const nt_confidence = (marketData as any).confidence as number | undefined;
  const nt_reasons = (marketData as any).reasons as string | undefined;
  if (nt_direction === 'long' || nt_direction === 'short') {
    const isLong = nt_direction === 'long';
    const entry  = price;
    const nt_sl  = (marketData as any).nt_sl;
    const nt_tp1 = (marketData as any).nt_tp1;
    const nt_tp2 = (marketData as any).nt_tp2;
    const sl  = nt_sl  ?? (isLong ? entry - 15 : entry + 15);
    const tp1 = nt_tp1 ?? (isLong ? entry + 20 : entry - 20);
    const tp2 = nt_tp2 ?? (isLong ? entry + 40 : entry - 40);
    const signal: TradeSignal = {
      id:         generateId(),
      direction:  nt_direction,
      entry, sl, tp1, tp2,
      qty:        1,
      session:    session || 'NT8',
      confidence: nt_confidence ?? 70,
      reason:     nt_reasons ?? `NT8 ${nt_direction.toUpperCase()}`,
      createdAt:  Date.now(),
      status:     'pending',
    };
    signals.unshift(signal);
    if (signals.length > MAX_SIGNALS) signals.splice(MAX_SIGNALS);
    dbSave(signal);
    console.log(`[SignalEngine][NT8 FastPath] ${signal.direction.toUpperCase()} @ ${entry} | ${signal.reason}`);
    return signal;
  }

  const tvLong  = long_signal  === 1;
  const tvShort = short_signal === 1;

  if (tvLong || tvShort) {
    const isLong    = tvLong;
    const confCount = isLong ? (long_conf ?? 2) : (short_conf ?? 2);
    const kzLabel   = tvKillzone || session || 'killzone';

    const entry = price;
    // Use NT8 pre-calculated levels if present, otherwise default ICT levels
    const nt_sl  = (marketData as any).nt_sl;
    const nt_tp1 = (marketData as any).nt_tp1;
    const nt_tp2 = (marketData as any).nt_tp2;
    const sl    = nt_sl  ?? (isLong ? entry - 20  : entry + 20);
    const tp1   = nt_tp1 ?? (isLong ? entry + 30  : entry - 30);
    const tp2   = nt_tp2 ?? (isLong ? entry + 75  : entry - 75);

    const reason = [
      `TV signal (${confCount} conf)`,
      `${isLong ? 'LONG' : 'SHORT'}`,
      `KZ: ${kzLabel}`,
      `${isLong ? 'Discount zone' : 'Premium zone'}`,
    ].join(' | ');

    const signal: TradeSignal = {
      id:         generateId(),
      direction:  isLong ? 'long' : 'short',
      entry,
      sl,
      tp1,
      tp2,
      qty:        1,
      session:    kzLabel,
      confidence: Math.min(100, 60 + confCount * 8), // approx confidence from conf count
      reason,
      createdAt:  Date.now(),
      status:     'pending',
    };

    signals.unshift(signal);
    if (signals.length > MAX_SIGNALS) signals.splice(MAX_SIGNALS);
    dbSave(signal);
    console.log(`[SignalEngine][TV FastPath] ${signal.direction.toUpperCase()} @ ${entry} | ${reason}`);
    return signal;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STANDARD PATH — server-side ICT scoring gates
  // ════════════════════════════════════════════════════════════════════════════

  // ── Gate 3: strong ICT score ─────────────────────────────────────────────────
  if (score < 65) return null;

  // ── Gate 4: must be in a killzone (London OR NY — not just NY) ───────────────
  const kz = isInKillzone();
  if (!kz.active) return null;

  // ── Gate 5: order flow confirmation ─────────────────────────────────────────
  if ((orderFlowScore ?? 0) < 60) return null;

  // ── Determine direction from bias ────────────────────────────────────────────
  const biasUpper = (bias || '').toUpperCase();
  if (biasUpper === 'NEUTRAL') return null;
  const isLong = biasUpper === 'BULLISH';

  // ── Gate 6: directional order flow filter ────────────────────────────────────
  const absBull  = absorptionBull === 1 || absorptionBull === true;
  const absBear  = absorptionBear === 1 || absorptionBear === true;
  const deltaNum = delta ?? 0;

  if (isLong  && !absBull && !(deltaNum > 0)) return null;
  if (!isLong && !absBear && !(deltaNum < 0)) return null;

  // ── Build signal levels ───────────────────────────────────────────────────────
  const entry = price;
  const sl    = isLong ? entry - 20 : entry + 20;
  const tp1   = isLong ? entry + 30 : entry - 30;
  const tp2   = isLong ? entry + 75 : entry - 75;

  // ── Build reason string ───────────────────────────────────────────────────────
  const parts: string[] = [
    `Score ${score}/100`,
    `${biasUpper.charAt(0) + biasUpper.slice(1).toLowerCase()} bias`,
    `KZ: ${kz.name}`,
  ];
  if (deltaNum !== 0) parts.push(`Delta ${deltaNum > 0 ? '+' : ''}${deltaNum}`);
  if (absBull) parts.push('Bull absorption');
  if (absBear) parts.push('Bear absorption');
  const reason = parts.join(' | ');

  // ── Create & store the signal ─────────────────────────────────────────────────
  const signal: TradeSignal = {
    id:         generateId(),
    direction:  isLong ? 'long' : 'short',
    entry,
    sl,
    tp1,
    tp2,
    qty:        1,
    session:    kz.name,
    confidence: score,
    reason,
    createdAt:  Date.now(),
    status:     'pending',
  };

  signals.unshift(signal);
  if (signals.length > MAX_SIGNALS) signals.splice(MAX_SIGNALS);
  console.log(`[SignalEngine][Standard] ${signal.direction.toUpperCase()} @ ${entry} | ${reason}`);
  return signal;
}

// ── CRUD helpers ──────────────────────────────────────────────────────────────

/** Returns the oldest 'pending' signal, or null if none exists. */
export function getPendingSignal(): TradeSignal | null {
  const pending = signals.filter(s => s.status === 'pending');
  if (!pending.length) return null;
  return pending.reduce((oldest, s) => s.createdAt < oldest.createdAt ? s : oldest);
}

/** Mark a signal as 'received' (broker acknowledged). */
export function confirmSignal(id: string): void {
  const sig = signals.find(s => s.id === id);
  if (sig && sig.status === 'pending') {
    sig.status = 'received';
    console.log(`[SignalEngine] Confirmed signal ${id}`);
  }
}

/** Update fill / close data on an existing signal. */
export function updateSignalResult(id: string, data: Partial<TradeSignal>): void {
  const sig = signals.find(s => s.id === id);
  if (!sig) return;
  Object.assign(sig, data);

  // Auto-compute P&L if exit price just arrived
  if (data.exitPrice !== undefined && sig.direction) {
    const raw = sig.direction === 'long'
      ? data.exitPrice - sig.entry
      : sig.entry - data.exitPrice;
    sig.pnlPoints  = parseFloat(raw.toFixed(2));
    sig.pnlDollars = parseFloat((raw * 20).toFixed(2)); // NQ $20/pt
  }
  console.log(`[SignalEngine] Updated signal ${id}:`, data);
}

/** Returns the last N signals (newest first). */
export function getRecentSignals(limit = 50): TradeSignal[] {
  return signals.slice(0, limit);
}

/**
 * Mark any 'pending' signal older than 5 minutes as 'expired'.
 * Called each pulse cycle.
 */
export function clearExpiredSignals(): void {
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const now = Date.now();
  signals.forEach(s => {
    if (s.status === 'pending' && now - s.createdAt > FIVE_MIN_MS) {
      s.status = 'expired';
      s.result = 'EXPIRED';
      console.log(`[SignalEngine] Expired signal ${s.id}`);
    }
  });
}

// ── Stats helper (used by /api/trade-signal/stats route) ─────────────────────
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
  const todaySignals = closed.filter(s => {
    const d = new Date(s.createdAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return d === todayStr;
  });
  const todayPnlDollars = todaySignals.reduce((sum, s) => sum + (s.pnlDollars ?? 0), 0);

  return {
    totalTrades: closed.length,
    winRate: closed.length ? Math.round((wins / closed.length) * 100) : 0,
    avgPnlPoints: closed.length ? parseFloat((pnlPts / closed.length).toFixed(2)) : 0,
    todayPnlDollars: parseFloat(todayPnlDollars.toFixed(2)),
  };
}
