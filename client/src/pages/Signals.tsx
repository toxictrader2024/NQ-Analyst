import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Activity, Loader2 } from "lucide-react";

interface Signal {
  id: number;
  receivedAt: number;
  ticker: string;
  timeframe: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  vwap: number | null;
  killzone: string | null;
  marketStructure: string | null;
  fvgBull: number;
  fvgBear: number;
  obBull: number;
  obBear: number;
  sweepHigh: number;
  sweepLow: number;
  premium: number;
  discount: number;
}

export default function Signals() {
  const { data: signals = [], isLoading } = useQuery<Signal[]>({
    queryKey: ["/api/signals"],
    queryFn: () => apiRequest("GET", "/api/signals").then(r => r.json()),
    refetchInterval: 5000,
  });

  return (
    <div className="p-5">
      <div className="flex items-center gap-2 mb-5">
        <Activity className="w-4 h-4 text-primary" />
        <h1 className="text-base font-bold text-foreground">Signal History</h1>
        <Badge variant="outline" className="ml-auto font-mono text-xs">{signals.length} signals</Badge>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      ) : signals.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground text-sm">
          No signals yet. Connect TradingView webhook or use "Demo Signal" on the dashboard.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-left">
                {["Time", "TF", "Close", "High", "Low", "VWAP", "Killzone", "Structure", "FVG", "Sweep", "Zone"].map(h => (
                  <th key={h} className="pb-2.5 pr-4 font-medium uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {signals.map((s) => {
                const fvg = s.fvgBull ? "BULL" : s.fvgBear ? "BEAR" : null;
                const sweep = s.sweepHigh ? "HIGH" : s.sweepLow ? "LOW" : null;
                const zone = s.premium ? "PREMIUM" : s.discount ? "DISCOUNT" : null;
                const msColor = (s.marketStructure || "").includes("bull") ? "text-green-400" : (s.marketStructure || "").includes("bear") ? "text-red-400" : "text-muted-foreground";

                return (
                  <tr key={s.id} className="hover:bg-muted/30 transition-colors" data-testid={`row-signal-${s.id}`}>
                    <td className="py-2.5 pr-4 font-mono text-muted-foreground whitespace-nowrap">
                      {new Date(s.receivedAt).toLocaleTimeString()}
                    </td>
                    <td className="py-2.5 pr-4 font-mono">{s.timeframe}m</td>
                    <td className="py-2.5 pr-4 font-mono font-semibold text-foreground">{s.close?.toLocaleString() || "—"}</td>
                    <td className="py-2.5 pr-4 font-mono text-green-400">{s.high?.toLocaleString() || "—"}</td>
                    <td className="py-2.5 pr-4 font-mono text-red-400">{s.low?.toLocaleString() || "—"}</td>
                    <td className="py-2.5 pr-4 font-mono text-muted-foreground">{s.vwap?.toLocaleString() || "—"}</td>
                    <td className="py-2.5 pr-4">
                      {s.killzone
                        ? <Badge variant="outline" className="text-xs h-5 text-primary border-primary/30">{s.killzone.replace(/_/g, " ")}</Badge>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className={`py-2.5 pr-4 font-mono ${msColor}`}>
                      {s.marketStructure?.replace(/_/g, " ").toUpperCase() || "—"}
                    </td>
                    <td className="py-2.5 pr-4">
                      {fvg ? <span className={fvg === "BULL" ? "text-green-400 font-mono" : "text-red-400 font-mono"}>{fvg}</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-2.5 pr-4">
                      {sweep ? <span className="text-yellow-400 font-mono">{sweep}</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-2.5 pr-4">
                      {zone ? <span className={zone === "DISCOUNT" ? "text-blue-400 font-mono" : "text-orange-400 font-mono"}>{zone}</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
