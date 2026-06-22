/**
 * Signal Engine — v5
 *
 * Fixes applied:
 *  #1  — Uses shared getDb() from db.ts (Railway persistent volume)
 *  #2  — Hard 15:00 ET clock block in evaluateSignal()
 *  #5  — 'entered' status treated as active in hasActiveSignal()
 *  #7  — PnL uses $2/pt MNQ (not $20/pt NQ); prefers MuzziBot totalPnlPts
 *  #10 — Session trade cap counts both directions combined (3 total per killzone)
 *  #11 — SC VolumeGate now uses NT8's own payload CVD/delta/dom fields instead
 *         of Railway's cached SC snapshot. NT8 already baked SC flow into its
 *         confidence score — Railway's gate should use the same snapshot NT8 used,
 *         not a fresher one that may contradict the scored setup.
 *         SHORT veto threshold raised: delta>300 (was >50), absorption only blocks
 *         if delta also >200 (was >0). Mild positive delta no longer kills shorts.
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

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA-AGNOSTIC PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

_db.exec(`
  CREATE TABLE IF NOT EXISTS trade_signals (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending'
  );
`);
try { _db.exec(`ALTER TABLE trade_signals ADD COLUMN data TEXT NOT NULL DEFAULT '{}'`); } catch (_) {}

interface ColInfo { name: string; type: string; notnull: number; dflt_value: any; pk: number; }

function readLiveColumns(): ColInfo[] {
  try {
    const rows = _db.prepare(`PRAGMA table_info(trade_signals)`).all() as any[];
    return rows.map(r => ({
      name: String(r.name),
      type: String(r.type || '').toUpperCase(),
      notnull: Number(r.notnull) || 0,
      dflt_value: r.dflt_value,
      pk: Number(r.pk) || 0,
    }));
  } catch (e: any) {
    console.error('[dbSave] PRAGMA table_info failed:', e?.message);
    return [];
  }
}

let LIVE_COLUMNS: ColInfo[] = readLiveColumns();
console.log(`[SignalEngine] trade_signals live schema (${LIVE_COLUMNS.length} cols): ` +
  LIVE_COLUMNS.map(c => `${c.name}${c.notnull ? '!' : ''}`).join(', '));

function valueForColumn(col: ColInfo, sig: TradeSignal): any {
  const s = sig as any;
  switch (col.name) {
    case 'id':          return sig.id;
    case 'data':        return JSON.stringify(sig);
    case 'created_at':  return sig.createdAt ?? Date.now();
    case 'createdat':   return sig.createdAt ?? Date.now();
    case 'status':      return sig.status ?? 'pending';
    case 'direction':   return sig.direction ?? '';
    case 'entry':       return sig.entry ?? 0;
    case 'sl':          return sig.sl ?? 0;
    case 'tp1':         return sig.tp1 ?? 0;
    case 'tp2':         return sig.tp2 ?? 0;
    case 'qty':         return sig.qty ?? 1;
    case 'session':     return sig.session ?? '';
    case 'confidence':  return sig.confidence ?? 0;
    case 'score':       return s.score ?? sig.confidence ?? 0;
    case 'reason':      return sig.reason ?? '';
    case 'source':      return s.source ?? 'ninjatrader';
    case 'fill_price':  return sig.fillPrice ?? null;
    case 'fill_time':   return sig.fillTime ?? null;
    case 'exit_price':  return sig.exitPrice ?? null;
    case 'pnl_points':  return sig.pnlPoints ?? null;
    case 'pnl_dollars': return sig.pnlDollars ?? null;
    case 'exit_reason': return sig.exitReason ?? null;
    case 'result':      return sig.result ?? null;
    case 'closed_at':   return sig.closedAt ?? null;
    default:            return undefined;
  }
}

function notNullFallback(col: ColInfo): any {
  const t = col.type;
  if (t.includes('INT') || t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUM')) return 0;
  return '';
}

function dbSave(sig: TradeSignal) {
  if (!LIVE_COLUMNS.length) LIVE_COLUMNS = readLiveColumns();

  const cols: string[] = [];
  const vals: any[] = [];
  for (const col of LIVE_COLUMNS) {
    let v = valueForColumn(col, sig);
    if (v === undefined) {
      if (col.notnull && col.dflt_value === null) {
        v = notNullFallback(col);
      } else {
        continue;
      }
    }
    cols.push(col.name);
    vals.push(v);
  }

  if (cols.length) {
    try {
      const placeholders = cols.map(() => '?').join(', ');
      const sql = `INSERT OR REPLACE INTO trade_signals (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;
      _db.prepare(sql).run(...vals);
      return;
    } catch (e: any) {
      console.error('[dbSave] dynamic insert failed, trying minimal fallback:', e?.message);
    }
  }

  try {
    _db.prepare(`INSERT OR REPLACE INTO trade_signals (id, data, created_at, status) VALUES (?, ?, ?, ?)`)
      .run(sig.id, JSON.stringify(sig), sig.createdAt ?? Date.now(), sig.status ?? 'pending');
  } catch (e: any) {
    console.error('[dbSave] minimal fallback also failed:', e?.message);
  }
}

function dbLoadRecent(): TradeSignal[] {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const rows = _db.prepare('SELECT data FROM trade_signals WHERE created_at > ? ORDER BY created_at DESC LIMIT 200').all(cutoff) as any[];
  return rows.map(r => {
    try { return JSON.parse(r.data); } catch { return null; }
  }).filter(Boolean);
}

const MAX_SIGNALS = 200;

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

function hasActiveSignal(): boolean {
  const TEN_MIN    = 10 * 60 * 1000;
  const TWO_MIN_MS =  1 * 60 * 1000;
  const now = Date.now();
  return signals.some(s => {
    if (s.status === 'pending'  && (now - s.createdAt) > TWO_MIN_MS) return false;
    if (s.status === 'pending')  return true;
    if (s.status === 'received' && (now - s.createdAt) > TWO_MIN_MS) return false;
    if (s.status === 'received') return true;
    if (s.status === 'entered')  return true;
    if (s.status === 'filled' && (now - s.createdAt) < TEN_MIN) return true;
    return false;
  });
}

function isAfter15etHardBlock(): boolean {
  try {
    const etStr = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const [h, m] = etStr.split(':').map(Number);
    return h * 60 + m >= 15 * 60;
  } catch {
    return false;
  }
}

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

  // ── Stale price guard ──────────────────────────────────────────────────────
  const ntDataAge = marketData.ntDataAge as number | undefined;
  if (ntDataAge !== undefined && ntDataAge > 60_000) {
    console.log(`[SignalEngine][StalePrice] BLOCKED ${marketData.direction ?? '?'} @ ${price} — NT8 data is ${Math.round(ntDataAge / 1000)}s old (max 60s)`);
    return null;
  }

  // ── Hard 15:00 ET block ────────────────────────────────────────────────────
  if (isAfter15etHardBlock()) {
    console.log(`[SignalEngine][HardBlock] BLOCKED — past 15:00 ET hard cutoff`);
    return null;
  }

  if (hasActiveSignal()) return null;

  // ── Direction from NT8 payload ─────────────────────────────────────────────
  let ntDirection = marketData.direction as string | undefined;
  if (!ntDirection) {
    if (marketData.long_signal  === 1) ntDirection = 'long';
    if (marketData.short_signal === 1) ntDirection = 'short';
  }
  if (ntDirection !== 'long' && ntDirection !== 'short') return null;

  const isLong = ntDirection === 'long';
  const entry  = price;
  const sl     = marketData.nt_sl  ?? (isLong ? entry - 20 : entry + 20);
  const tp1    = marketData.nt_tp1 ?? (isLong ? entry + 30 : entry - 30);
  const tp2    = marketData.nt_tp2 ?? (isLong ? entry + 70 : entry - 70);

  // ── FIX #11: SC VolumeGate — use NT8's own payload SC values ──────────────
  //
  // PROBLEM: Railway was reading delta/absorptionBull from its own cached SC
  // snapshot (latestScData), which could be fresher than what NT8 used when it
  // scored the setup. A SHORT scored by NT8 with CVD=-565 was blocked because
  // Railway's snapshot had refreshed to delta=+185/absBull=true by the time the
  // POST arrived. The gate contradicted the signal's own scoring basis.
  //
  // FIX: Prefer NT8's own SC fields sent in the webhook payload:
  //   - body.cvd  → NT8's CVD reading at signal time (from its PollSCState call)
  //   - body.delta → NT8's delta reading at signal time
  //   - body.dom_bull / body.dom_bear → NT8's DOM reading at signal time
  // Fall back to Railway's cached SC values only if NT8 didn't send them.
  //
  // Also raised the SHORT veto threshold:
  //   - delta veto: >300 (was >50) — mild positive delta no longer kills shorts
  //   - absorption veto: only if delta also >200 (was: any positive delta)
  // NT8 already factored SC flow into its confidence score. Railway's gate
  // should only hard-veto on genuinely extreme contradicting flow.

  // Prefer NT8's own CVD first, then delta, then Railway's cached delta
  const scDelta: number | null =
    marketData.cvd   !== undefined && marketData.cvd   !== null ? Number(marketData.cvd)
  : marketData.delta !== undefined && marketData.delta !== null ? Number(marketData.delta)
  : null;

  // Prefer NT8's dom_bull/dom_bear (from its own DOM poll) over cached absorption
  const scAbsBull: boolean =
    marketData.dom_bull !== undefined && marketData.dom_bull !== null
      ? Number(marketData.dom_bull) > 0
      : (marketData.absorptionBull === 1 || marketData.absorptionBull === true);

  const scAbsBear: boolean =
    marketData.dom_bear !== undefined && marketData.dom_bear !== null
      ? Number(marketData.dom_bear) > 0
      : (marketData.absorptionBear === 1 || marketData.absorptionBear === true);

  const scImbBull  = marketData.imbalanceBull === 1 || marketData.imbalanceBull === true;
  const scImbBear  = marketData.imbalanceBear === 1 || marketData.imbalanceBear === true;
  const scBidStack = marketData.bidStackSize !== undefined ? Number(marketData.bidStackSize) : null;
  const scAskStack = marketData.askStackSize !== undefined ? Number(marketData.askStackSize) : null;
  const scHasFreshData = scDelta !== null;

  if (scHasFreshData) {
    const domBull = scBidStack !== null && scAskStack !== null && scAskStack > 0 && scBidStack > scAskStack * 2;
    const domBear = scBidStack !== null && scAskStack !== null && scBidStack > 0 && scAskStack > scBidStack * 2;

    // LONG gate: only block if delta is strongly negative AND no bullish confirmation
    if (isLong && scDelta < -100 && !scAbsBull && !scImbBull && !domBull) {
      console.log(`[SignalEngine][SC VolumeGate] BLOCKED LONG @ ${entry} — delta=${scDelta} (strongly bearish flow, no bull confirmation)`);
      return null;
    }

    // SHORT gate: only block on genuinely extreme bullish contradiction
    // Raised from delta>50 → delta>300, and absorption only if delta also >200
    const strongBullDeltaBlocksShort  = scDelta > 300 && !scAbsBear && !scImbBear && !domBear;
    const strongBullAbsorbBlocksShort = scAbsBull && scDelta > 200 && !scAbsBear;
    if (!isLong && (strongBullDeltaBlocksShort || strongBullAbsorbBlocksShort)) {
      console.log(`[SignalEngine][SC VolumeGate] BLOCKED SHORT @ ${entry} — delta=${scDelta} absBull=${scAbsBull} (extreme bull contradiction)`);
      return null;
    }
  }

  // ── Session allowlist ──────────────────────────────────────────────────────
  const sessionLabel = getSessionLabel(marketData, session);
  const ALLOWED_SESSIONS = ['london', 'ny_open', 'london_close', 'ny_open_london_close', 'ny_afternoon'];
  const normalizedSession = sessionLabel.toLowerCase().replace(/[\s-]/g, '_');
  if (!ALLOWED_SESSIONS.some(s => normalizedSession.includes(s))) {
    console.log(`[SignalEngine][SessionBlock] BLOCKED ${ntDirection.toUpperCase()} @ ${entry} — session='${sessionLabel}' not in allowed killzones`);
    return null;
  }

  // ── Session trade cap: 3 total per killzone per day ────────────────────────
  const sessionCount = countSessionTotal(sessionLabel);
  if (sessionCount >= 3) {
    console.log(`[SignalEngine][KillzoneCap] BLOCKED ${ntDirection.toUpperCase()} @ ${entry} — session '${sessionLabel}' already has ${sessionCount}/3 trades today`);
    return null;
  }

  // ── NY Afternoon extra rules ───────────────────────────────────────────────
  if (normalizedSession.includes('ny_afternoon')) {
    const confidence   = (marketData.confidence as number) ?? 0;
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

  // ── Risk gate ──────────────────────────────────────────────────────────────
  const risk = evaluateRiskGate({ direction: ntDirection, session: sessionLabel, confidence: marketData.confidence });
  if (!risk.allowed) {
    console.log(`[SignalEngine][RiskGate] BLOCKED ${ntDirection.toUpperCase()} @ ${entry} — ${risk.reason}`);
    return null;
  }

  // ── Build reason string ────────────────────────────────────────────────────
  const volParts: string[] = [];
  if (scHasFreshData) {
    volParts.push(`SC delta ${scDelta! > 0 ? '+' : ''}${scDelta}`);
    if (scAbsBull) volParts.push('bull absorb');
    if (scAbsBear) volParts.push('bear absorb');
    if (scImbBull) volParts.push('bid imbalance');
    if (scImbBear) volParts.push('ask imbalance');
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
    status: 'pending',
    reason: 'TEST INJECT — pipeline verification',
    createdAt: Date.now(),
    qty: 4,
    confidence: 5,
  } as any;
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
  // Always write critical close fields directly to DB first
  const directFields: string[] = [];
  const directVals: any[] = [];
  if (data.status              != null) { directFields.push('status = ?');      directVals.push(data.status); }
  if (data.result              != null) { directFields.push('result = ?');      directVals.push(data.result); }
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

  let sig = signals.find(s => s.id === id);
  if (!sig) {
    const row = _db.prepare('SELECT data FROM trade_signals WHERE id=?').get(id) as any;
    if (row) {
      try {
        sig = JSON.parse(row.data) as TradeSignal;
        if (sig) { sig.id = id; signals.unshift(sig); }
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

  // Fix #7: PnL — prefer MuzziBot's pnlPoints; fallback to price diff
  const incomingPnl  = (data as any).pnlPoints;
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

  dbSave(sig);
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
  const closed  = signals.filter(s => s.status === 'closed' && s.result !== undefined && s.result !== 'EXPIRED');
  const wins    = closed.filter(s => s.result === 'TP1' || s.result === 'TP2').length;
  const pnlPts  = closed.reduce((sum, s) => sum + (s.pnlPoints ?? 0), 0);
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todaySignals = closed.filter(s => new Date(s.createdAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayStr);
  const todayPnlDollars = todaySignals.reduce((sum, s) => sum + (s.pnlDollars ?? 0), 0);
  return {
    totalTrades:    closed.length,
    winRate:        closed.length ? Math.round((wins / closed.length) * 100) : 0,
    avgPnlPoints:   closed.length ? parseFloat((pnlPts / closed.length).toFixed(2)) : 0,
    todayPnlDollars,
  };
}
