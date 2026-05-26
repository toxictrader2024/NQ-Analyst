import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Bot, TrendingUp, TrendingDown, Activity, Loader2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TradeSignal {
  id: string;
  direction: "long" | "short";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  qty: number;
  session: string;
  confidence: number;
  reason: string;
  createdAt: number;
  status: "pending" | "received" | "filled" | "closed" | "expired";
  fillPrice?: number;
  fillTime?: string;
  exitPrice?: number;
  pnlPoints?: number;
  pnlDollars?: number;
  exitReason?: string;
  result?: "TP1" | "TP2" | "STOPPED" | "EXPIRED";
}

interface TradeStats {
  totalTrades: number;
  winRate: number;
  avgPnlPoints: number;
  todayPnlDollars: number;
}

// ── Status badge config ────────────────────────────────────────────────────────

function StatusBadge({ signal }: { signal: TradeSignal }) {
  const result = signal.result;

  if (result === "TP1" || result === "TP2") {
    return (
      <Badge className="text-xs font-mono bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/15">
        {result}
      </Badge>
    );
  }
  if (result === "STOPPED") {
    return (
      <Badge className="text-xs font-mono bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/15">
        STOPPED
      </Badge>
    );
  }
  if (signal.status === "expired" || result === "EXPIRED") {
    return (
      <Badge className="text-xs font-mono bg-muted text-muted-foreground border-border hover:bg-muted">
        EXPIRED
      </Badge>
    );
  }
  if (signal.status === "filled") {
    return (
      <Badge className="text-xs font-mono bg-blue-500/15 text-blue-400 border-blue-500/30 hover:bg-blue-500/15">
        FILLED
      </Badge>
    );
  }
  if (signal.status === "pending" || signal.status === "received") {
    return (
      <Badge className="text-xs font-mono bg-yellow-500/15 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/15">
        PENDING
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs font-mono">
      {signal.status.toUpperCase()}
    </Badge>
  );
}

// ── Direction badge ────────────────────────────────────────────────────────────

function DirectionBadge({ direction }: { direction: "long" | "short" }) {
  return direction === "long" ? (
    <Badge className="text-xs font-mono w-14 justify-center bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/15 gap-1">
      <TrendingUp className="w-3 h-3" />
      LONG
    </Badge>
  ) : (
    <Badge className="text-xs font-mono w-14 justify-center bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/15 gap-1">
      <TrendingDown className="w-3 h-3" />
      SHORT
    </Badge>
  );
}

// ── P&L display ───────────────────────────────────────────────────────────────

function PnlCell({ signal }: { signal: TradeSignal }) {
  if (signal.pnlPoints === undefined || signal.pnlPoints === null) {
    return <span className="text-muted-foreground font-mono text-xs">—</span>;
  }
  const pos = signal.pnlPoints >= 0;
  return (
    <span className={`font-mono text-xs font-semibold ${pos ? "text-green-400" : "text-red-400"}`}>
      {pos ? "+" : ""}{signal.pnlPoints.toFixed(1)} pts
    </span>
  );
}

// ── Price formatter ───────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function TradeLog() {
  const { data: signals = [], isLoading: sigLoading } = useQuery<TradeSignal[]>({
    queryKey: ["/api/trade-signal/history"],
    queryFn: () => apiRequest("GET", "/api/trade-signal/history").then(r => r.json()),
    refetchInterval: 5000,
  });

  const { data: stats } = useQuery<TradeStats>({
    queryKey: ["/api/trade-signal/stats"],
    queryFn: () => apiRequest("GET", "/api/trade-signal/stats").then(r => r.json()),
    refetchInterval: 10000,
  });

  const hasActive = signals.some(s => s.status === "pending" || s.status === "filled");

  return (
    <div className="flex flex-col bg-card border border-border rounded-xl overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-card flex-shrink-0">
        <Bot className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Bot Trade Log</span>
        {/* Live indicator */}
        <div className={`w-2 h-2 rounded-full ml-1 flex-shrink-0 ${hasActive ? "bg-green-400 animate-pulse" : "bg-muted-foreground"}`} />
        <span className="text-xs text-muted-foreground">{hasActive ? "Active" : "No active trade"}</span>
        <Activity className="w-3.5 h-3.5 text-muted-foreground ml-auto" />
      </div>

      {/* ── Stats bar ── */}
      <div className="grid grid-cols-4 divide-x divide-border border-b border-border flex-shrink-0">
        {[
          { label: "Total Trades", value: stats?.totalTrades ?? 0, mono: true },
          { label: "Win Rate",     value: stats ? `${stats.winRate}%` : "—", color: (stats?.winRate ?? 0) >= 50 ? "text-green-400" : "text-red-400" },
          { label: "Avg P&L",     value: stats ? `${stats.avgPnlPoints >= 0 ? "+" : ""}${stats.avgPnlPoints} pts` : "—", color: (stats?.avgPnlPoints ?? 0) >= 0 ? "text-green-400" : "text-red-400" },
          { label: "Today P&L",   value: stats ? `$${stats.todayPnlDollars >= 0 ? "+" : ""}${stats.todayPnlDollars.toFixed(0)}` : "—", color: (stats?.todayPnlDollars ?? 0) >= 0 ? "text-green-400" : "text-red-400" },
        ].map(({ label, value, mono, color }) => (
          <div key={label} className="flex flex-col items-center justify-center py-2.5 px-1">
            <span className="text-xs text-muted-foreground mb-0.5">{label}</span>
            <span className={`font-mono text-sm font-bold ${color ?? "text-foreground"}`}>{String(value)}</span>
          </div>
        ))}
      </div>

      {/* ── Table ── */}
      <div className="overflow-auto">
        {sigLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        )}

        {!sigLoading && signals.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-center px-4">
            <Bot className="w-7 h-7 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              No signals yet. The bot generates signals during the NY session (9:30–11:00 AM ET &amp; 1:30–2:00 PM ET) when score ≥ 65 and order flow score ≥ 60.
            </p>
          </div>
        )}

        {!sigLoading && signals.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Time</th>
                <th className="text-left px-3 py-2 font-medium">Dir</th>
                <th className="text-right px-3 py-2 font-medium">Entry</th>
                <th className="text-right px-3 py-2 font-medium">SL</th>
                <th className="text-right px-3 py-2 font-medium">TP1</th>
                <th className="text-right px-3 py-2 font-medium">TP2</th>
                <th className="text-center px-3 py-2 font-medium">Status</th>
                <th className="text-right px-3 py-2 font-medium">P&amp;L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {signals.map(sig => (
                <tr
                  key={sig.id}
                  className={`transition-colors hover:bg-muted/30 ${
                    sig.status === "pending" || sig.status === "filled"
                      ? "bg-primary/5"
                      : ""
                  }`}
                  title={sig.reason}
                >
                  {/* Time */}
                  <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">
                    {new Date(sig.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </td>

                  {/* Direction */}
                  <td className="px-3 py-2">
                    <DirectionBadge direction={sig.direction} />
                  </td>

                  {/* Entry */}
                  <td className="px-3 py-2 font-mono text-right text-foreground">
                    {fmt(sig.entry)}
                  </td>

                  {/* SL */}
                  <td className="px-3 py-2 font-mono text-right text-red-400">
                    {fmt(sig.sl)}
                  </td>

                  {/* TP1 */}
                  <td className="px-3 py-2 font-mono text-right text-green-400">
                    {fmt(sig.tp1)}
                  </td>

                  {/* TP2 */}
                  <td className="px-3 py-2 font-mono text-right text-green-300">
                    {fmt(sig.tp2)}
                  </td>

                  {/* Status */}
                  <td className="px-3 py-2 text-center">
                    <StatusBadge signal={sig} />
                  </td>

                  {/* P&L */}
                  <td className="px-3 py-2 text-right">
                    <PnlCell signal={sig} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="px-4 py-2 border-t border-border flex items-center gap-2 flex-shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
        <span className="text-xs text-muted-foreground">Live — polling every 5s</span>
        <span className="ml-auto text-xs text-muted-foreground font-mono">{signals.length} signal{signals.length !== 1 ? "s" : ""}</span>
      </div>
    </div>
  );
}
