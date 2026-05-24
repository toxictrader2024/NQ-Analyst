/**
 * Signal Engine
 *
 * Evaluates ICT conditions and generates automated trade signals.
 * Signals are stored in-memory (max 200) and are ephemeral — they do not
 * persist to SQLite to keep the schema untouched.
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

// ── In-memory store (max 200) ─────────────────────────────────────────────────
const MAX_SIGNALS = 200;
const signals: TradeSignal[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId(): string {
  return `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Returns true when the current ET wall-clock time falls inside a NY killzone:
 *   - NY Open: 09:30 – 11:00 ET
 *   - London Close: 13:30 – 14:00 ET
 */
function isNYKillzone(): boolean {
  const now = new Date();
  // ET offset: UTC-5 standard / UTC-4 daylight; simplify via Intl
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const [hStr, mStr] = etStr.split(':');
  const etMinutes = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);

  const nyOpen     = { start: 9 * 60 + 30,  end: 11 * 60 };       // 09:30–11:00
  const londonClose = { start: 13 * 60 + 30, end: 14 * 60 };      // 13:30–14:00

  return (etMinutes >= nyOpen.start     && etMinutes < nyOpen.end) ||
         (etMinutes >= londonClose.start && etMinutes < londonClose.end);
}

/** Returns true if any signal is currently active (pending or filled). */
function hasActiveSignal(): boolean {
  return signals.some(s => s.status === 'pending' || s.status === 'filled');
}

// ── Core evaluation ───────────────────────────────────────────────────────────

/**
 * Evaluates the latest market snapshot and returns a TradeSignal if all
 * ICT conditions are met, or null otherwise.
 *
 * @param marketData  Latest merged data point (from storage.getLatestWebhook / combined)
 * @param session     Active session string ('asia' | 'london' | 'ny')
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
  } = marketData as {
    close: number | null;
    delta: number | null;
    bias: string;
    score: number;
    orderFlowScore: number;
    absorptionBull: number | boolean | null;
    absorptionBear: number | boolean | null;
  };

  // ── Gate 1: must have a usable price ────────────────────────────────────────
  if (!price) return null;

  // ── Gate 2: strong ICT score ─────────────────────────────────────────────────
  if (score < 65) return null;

  // ── Gate 3: NY session only ──────────────────────────────────────────────────
  if (session !== 'ny') return null;

  // ── Gate 4: NY killzone time ─────────────────────────────────────────────────
  if (!isNYKillzone()) return null;

  // ── Gate 5: one trade at a time ──────────────────────────────────────────────
  if (hasActiveSignal()) return null;

  // ── Gate 6: order flow confirmation ─────────────────────────────────────────
  if ((orderFlowScore ?? 0) < 60) return null;

  // ── Determine direction from bias ────────────────────────────────────────────
  const biasUpper = (bias || '').toUpperCase();
  if (biasUpper === 'NEUTRAL') return null;

  const isLong = biasUpper === 'BULLISH';

  // ── Gate 7: directional order flow filter ────────────────────────────────────
  const absBull = absorptionBull === 1 || absorptionBull === true;
  const absBear = absorptionBear === 1 || absorptionBear === true;
  const deltaNum = delta ?? 0;

  if (isLong  && !absBull && !(deltaNum > 0)) return null;
  if (!isLong && !absBear && !(deltaNum < 0)) return null;

  // ── Build signal levels ───────────────────────────────────────────────────────
  const entry = price;
  const sl   = isLong ? entry - 20 : entry + 20;
  const tp1  = isLong ? entry + 30 : entry - 30;
  const tp2  = isLong ? entry + 75 : entry - 75;

  // ── Build reason string ───────────────────────────────────────────────────────
  const parts: string[] = [
    `Score ${score}/100`,
    `${biasUpper.charAt(0) + biasUpper.slice(1).toLowerCase()} bias`,
  ];
  if (deltaNum !== 0) parts.push(`Delta ${deltaNum > 0 ? '+' : ''}${deltaNum}`);
  if (absBull) parts.push('Bull absorption active');
  if (absBear) parts.push('Bear absorption active');
  parts.push('NY killzone');
  const reason = parts.join(' | ');

  // ── Create & store the signal ─────────────────────────────────────────────────
  const signal: TradeSignal = {
    id: generateId(),
    direction: isLong ? 'long' : 'short',
    entry,
    sl,
    tp1,
    tp2,
    qty: 1,
    session,
    confidence: score,
    reason,
    createdAt: Date.now(),
    status: 'pending',
  };

  signals.unshift(signal);
  if (signals.length > MAX_SIGNALS) signals.splice(MAX_SIGNALS);

  console.log(`[SignalEngine] New ${signal.direction.toUpperCase()} signal @ ${entry} | ${reason}`);
  return signal;
}

// ── CRUD helpers ──────────────────────────────────────────────────────────────

/** Returns the oldest 'pending' signal, or null if none exists. */
export function getPendingSignal(): TradeSignal | null {
  // signals are stored newest-first; pending is typically the most recent
  const pending = signals.filter(s => s.status === 'pending');
  if (!pending.length) return null;
  // return oldest pending (lowest createdAt)
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

  // Today's P&L (ET calendar day)
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
