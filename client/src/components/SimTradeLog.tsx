/**
 * SimTradeLog.tsx
 *
 * Displays every Muzzi signal tracked by NQ_Muzzi_Sim.cs —
 * open trades, closed trades, P&L by grade, and win rate by
 * Institutional Gravity score. Auto-refreshes every 10 seconds.
 */

import { useEffect, useState } from "react";
import { TrendingUp, TrendingDown, Clock, BarChart3, Zap, Target } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SimTrade {
  id           : string;
  grade        : string;
  direction    : string;
  gravityScore : number;
  fillPrice    : number;
  slPrice      : number;
  tp1Price     : number;
  tp2Price     : number;
  exitPrice    : number;
  pnlPoints    : number;
  pnlDollars   : number;
  result       : string;
  exitReason   : string;
  maxFavorable : number;
  maxAdverse   : number;
  openedAt     : string;
  closedAt     : string;
  tradeDate    : string;
  killzone     : string;
  deltaFlip    : boolean;
  threeBarPlay : boolean;
  primaryPass  : number;
}

interface GradeStat {
  grade   : string;
  wins    : number;
  total   : number;
  winRate : number;
  pnl     : number;
}

interface GravityStat {
  gravity : number;
  wins    : number;
  total   : number;
  winRate : number;
  pnl     : number;
}

interface SimStats {
  total          : number;
  wins           : number;
  losses         : number;
  winRate        : number;
  totalPnlPts    : number;
  totalPnlDollars: number;
  avgPnlPts      : number;
  byGrade        : GradeStat[];
  byGravity      : GravityStat[];
}

interface SimData {
  trades : SimTrade[];
  open   : SimTrade[];
  stats  : SimStats;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function gradeColor(grade: string): string {
  if (grade === "A+") return "text-yellow-300 bg-yellow-500/20 border-yellow-500/40";
  if (grade === "A")  return "text-green-300  bg-green-500/20  border-green-500/40";
  if (grade === "B")  return "text-blue-300   bg-blue-500/20   border-blue-500/40";
  return "text-gray-400 bg-gray-500/10 border-gray-500/30";
}

function resultBadge(result: string) {
  if (result === "TP2")     return <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-yellow-500/20 text-yellow-300 border border-yellow-500/40">TP2 🏆</span>;
  if (result === "TP1")     return <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-green-500/20  text-green-300  border border-green-500/40">TP1 ✅</span>;
  if (result === "STOPPED") return <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-red-500/20    text-red-300    border border-red-500/40">STOP 🔴</span>;
  if (result === "EXPIRED") return <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-gray-500/20   text-gray-400   border border-gray-500/30">EXP ⏳</span>;
  if (result === "OPEN")    return <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-cyan-500/20   text-cyan-300   border border-cyan-500/40 animate-pulse">LIVE 🔵</span>;
  return null;
}

function pnlColor(pts: number) {
  return pts > 0 ? "text-green-400" : pts < 0 ? "text-red-400" : "text-gray-400";
}

function killzoneLabel(kz: string): string {
  if (!kz) return "—";
  if (kz.includes("london")) return "London";
  if (kz.includes("ny_open")) return "NY Open";
  if (kz.includes("ny_close")) return "NY Close";
  if (kz.includes("asia")) return "Asia";
  return kz;
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function SimTradeLog() {
  const [data,    setData]    = useState<SimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab,     setTab]     = useState<"trades" | "stats">("trades");

  const fetchData = async () => {
    try {
      const res  = await fetch("/api/sim-trades?limit=100");
      const json = await res.json();
      setData(json);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm gap-2">
        <Clock className="w-4 h-4 animate-spin" /> Loading sim trades…
      </div>
    );
  }

  if (!data || (data.trades.length === 0 && data.open.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-sm gap-3">
        <Target className="w-8 h-8 opacity-40" />
        <p>No sim trades yet.</p>
        <p className="text-xs opacity-60 text-center max-w-xs">
          Add <span className="text-cyan-400 font-mono">NQ_Muzzi_Sim</span> to your NQ chart in NinjaTrader
          to start tracking all Muzzi signals automatically.
        </p>
      </div>
    );
  }

  const s = data.stats;
  const allTrades = [...data.open, ...data.trades.filter(t => t.result !== "OPEN")];

  return (
    <div className="flex flex-col gap-4">

      {/* ── Summary Bar ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Win Rate */}
        <div className="bg-card border border-border rounded-xl p-3 flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">Win Rate</p>
          <p className={`text-2xl font-bold ${s.winRate >= 60 ? "text-green-400" : s.winRate >= 50 ? "text-yellow-400" : "text-red-400"}`}>
            {s.winRate}%
          </p>
          <p className="text-xs text-muted-foreground">{s.wins}W / {s.losses}L</p>
        </div>

        {/* Total P&L */}
        <div className="bg-card border border-border rounded-xl p-3 flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">Total P&L</p>
          <p className={`text-2xl font-bold ${pnlColor(s.totalPnlPts)}`}>
            {s.totalPnlPts > 0 ? "+" : ""}{s.totalPnlPts.toFixed(1)}pts
          </p>
          <p className={`text-xs ${pnlColor(s.totalPnlDollars)}`}>
            {s.totalPnlDollars > 0 ? "+" : ""}${s.totalPnlDollars.toFixed(0)}
          </p>
        </div>

        {/* Avg P&L per trade */}
        <div className="bg-card border border-border rounded-xl p-3 flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">Avg / Trade</p>
          <p className={`text-2xl font-bold ${pnlColor(s.avgPnlPts)}`}>
            {s.avgPnlPts > 0 ? "+" : ""}{s.avgPnlPts.toFixed(1)}pts
          </p>
          <p className="text-xs text-muted-foreground">{s.total} closed trades</p>
        </div>

        {/* Live open */}
        <div className="bg-card border border-border rounded-xl p-3 flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">Live Open</p>
          <p className="text-2xl font-bold text-cyan-400">{data.open.length}</p>
          <p className="text-xs text-muted-foreground">sim trades active</p>
        </div>
      </div>

      {/* ── Tab Switcher ─────────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab("trades")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === "trades" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}
        >
          <Zap className="w-3 h-3" /> Trade Log
        </button>
        <button
          onClick={() => setTab("stats")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === "stats" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}
        >
          <BarChart3 className="w-3 h-3" /> Stats by Grade & Gravity
        </button>
      </div>

      {/* ── Trade Log ────────────────────────────────────────────────────────── */}
      {tab === "trades" && (
        <div className="flex flex-col gap-2">
          {allTrades.slice(0, 50).map((t) => (
            <div
              key={t.id}
              className={`bg-card border rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 ${t.result === "OPEN" ? "border-cyan-500/30" : "border-border"}`}
            >
              {/* Grade + Direction */}
              <div className="flex items-center gap-2 shrink-0">
                <span className={`px-2 py-0.5 text-xs font-bold rounded border ${gradeColor(t.grade)}`}>
                  {t.grade}
                </span>
                <span className={`flex items-center gap-0.5 text-xs font-semibold ${t.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                  {t.direction === "LONG" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {t.direction}
                </span>
                {resultBadge(t.result)}
              </div>

              {/* Levels */}
              <div className="flex-1 grid grid-cols-3 sm:grid-cols-5 gap-x-4 gap-y-0.5 text-xs">
                <div>
                  <p className="text-muted-foreground">Entry</p>
                  <p className="font-mono text-foreground">{t.fillPrice.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">SL</p>
                  <p className="font-mono text-red-400">{t.slPrice.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">TP1</p>
                  <p className="font-mono text-green-400">{t.tp1Price.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">TP2</p>
                  <p className="font-mono text-yellow-400">{t.tp2Price.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">P&L</p>
                  <p className={`font-mono font-bold ${pnlColor(t.pnlPoints)}`}>
                    {t.result === "OPEN" ? "—" : `${t.pnlPoints > 0 ? "+" : ""}${t.pnlPoints.toFixed(1)}pts`}
                  </p>
                </div>
              </div>

              {/* Metadata */}
              <div className="flex flex-col items-end shrink-0 text-xs text-muted-foreground">
                <span>G{t.gravityScore} • {killzoneLabel(t.killzone)}</span>
                <span>{t.deltaFlip ? "ΔFlip ✓" : ""}{t.threeBarPlay ? " 3Bar ✓" : ""}</span>
                <span>{t.openedAt}</span>
              </div>
            </div>
          ))}

          {allTrades.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-6">No closed trades yet — waiting for first signal to complete.</p>
          )}
        </div>
      )}

      {/* ── Stats ────────────────────────────────────────────────────────────── */}
      {tab === "stats" && (
        <div className="flex flex-col gap-4">

          {/* By Grade */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Win Rate by Grade</h3>
            <div className="flex flex-col gap-1.5">
              {s.byGrade.map(g => (
                <div key={g.grade} className="flex items-center gap-3">
                  <span className={`w-10 text-center px-1.5 py-0.5 text-xs font-bold rounded border ${gradeColor(g.grade)}`}>{g.grade}</span>
                  <div className="flex-1 bg-secondary rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${g.winRate >= 60 ? "bg-green-500" : g.winRate >= 50 ? "bg-yellow-500" : "bg-red-500"}`}
                      style={{ width: `${g.winRate}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono w-10 text-right">{g.winRate}%</span>
                  <span className="text-xs text-muted-foreground w-20 text-right">{g.wins}W/{g.total}T</span>
                  <span className={`text-xs font-mono w-16 text-right ${pnlColor(g.pnl)}`}>
                    {g.pnl > 0 ? "+" : ""}{g.pnl.toFixed(1)}pts
                  </span>
                </div>
              ))}
              {s.byGrade.length === 0 && <p className="text-xs text-muted-foreground">No data yet.</p>}
            </div>
          </div>

          {/* By Gravity */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Win Rate by Institutional Gravity</h3>
            <div className="flex flex-col gap-1.5">
              {s.byGravity.map(g => (
                <div key={g.gravity} className="flex items-center gap-3">
                  <span className="w-10 text-center text-xs font-bold text-purple-300">G{g.gravity}</span>
                  <div className="flex-1 bg-secondary rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${g.winRate >= 60 ? "bg-green-500" : g.winRate >= 50 ? "bg-yellow-500" : "bg-red-500"}`}
                      style={{ width: `${g.winRate}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono w-10 text-right">{g.winRate}%</span>
                  <span className="text-xs text-muted-foreground w-20 text-right">{g.wins}W/{g.total}T</span>
                  <span className={`text-xs font-mono w-16 text-right ${pnlColor(g.pnl)}`}>
                    {g.pnl > 0 ? "+" : ""}{g.pnl.toFixed(1)}pts
                  </span>
                </div>
              ))}
              {s.byGravity.length === 0 && <p className="text-xs text-muted-foreground">No data yet.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
