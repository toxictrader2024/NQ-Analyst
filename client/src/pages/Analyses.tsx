import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { FileText, TrendingUp, TrendingDown, Minus, Loader2 } from "lucide-react";

interface Analysis {
  id: number;
  createdAt: number;
  latestPrice: number | null;
  sessionBias: string;
  setupScore: number;
  tradeDirection: string | null;
  entryZone: string | null;
  stopLoss: string | null;
  target1: string | null;
  target2: string | null;
  narrative: string;
  confluences: string;
  warnings: string | null;
  triggeredBy: string | null;
}

export default function Analyses() {
  const { data: analyses = [], isLoading } = useQuery<Analysis[]>({
    queryKey: ["/api/dashboard"],
    queryFn: () => apiRequest("GET", "/api/dashboard").then(r => r.json()).then(d => d.recentAnalyses),
    refetchInterval: 5000,
  });

  return (
    <div className="p-5">
      <div className="flex items-center gap-2 mb-5">
        <FileText className="w-4 h-4 text-primary" />
        <h1 className="text-base font-bold text-foreground">Analysis History</h1>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      ) : analyses.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground text-sm">
          No analyses yet. Run your first analysis from the dashboard.
        </div>
      ) : (
        <div className="space-y-4">
          {analyses.map((a) => {
            const bias = a.sessionBias;
            const biasColor = bias === "BULLISH" ? "text-green-500" : bias === "BEARISH" ? "text-red-500" : "text-yellow-500";
            const dirColor = a.tradeDirection === "LONG" ? "text-green-500" : a.tradeDirection === "SHORT" ? "text-red-500" : "text-yellow-500";
            const BiasIcon = bias === "BULLISH" ? TrendingUp : bias === "BEARISH" ? TrendingDown : Minus;
            const scoreColor = a.setupScore >= 65 ? "text-green-400" : a.setupScore >= 40 ? "text-yellow-400" : "text-red-400";
            const confluenceList = JSON.parse(a.confluences || "[]") as string[];
            const warningList = a.warnings ? JSON.parse(a.warnings) as string[] : [];

            return (
              <div key={a.id} className="bg-card border border-border rounded-xl p-5" data-testid={`card-analysis-${a.id}`}>
                {/* Header */}
                <div className="flex items-center gap-3 mb-4">
                  <BiasIcon className={`w-4 h-4 ${biasColor}`} />
                  <span className={`font-bold font-mono ${biasColor}`}>{bias}</span>
                  <span className={`font-mono font-bold ${dirColor}`}>{a.tradeDirection}</span>
                  <span className={`font-mono font-bold ${scoreColor}`}>{a.setupScore}/100</span>
                  <Badge variant="outline" className="text-xs ml-auto">{a.triggeredBy}</Badge>
                  <span className="text-xs text-muted-foreground font-mono">
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                </div>

                {/* Trade levels */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  {[
                    { label: "Entry", value: a.entryZone, color: "text-foreground" },
                    { label: "Stop", value: a.stopLoss, color: "text-red-400" },
                    { label: "T1", value: a.target1, color: "text-green-400" },
                    { label: "T2", value: a.target2, color: "text-green-300" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="bg-muted rounded-lg p-3 text-center">
                      <div className="text-xs text-muted-foreground mb-1">{label}</div>
                      <div className={`font-mono text-sm font-bold ${color}`}>{value || "—"}</div>
                    </div>
                  ))}
                </div>

                {/* Confluences */}
                {confluenceList.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {confluenceList.map((c, i) => (
                      <Badge key={i} variant="outline" className="text-xs bg-green-500/5 border-green-500/20 text-green-400">
                        {c}
                      </Badge>
                    ))}
                  </div>
                )}

                {/* Narrative */}
                <div className="bg-muted rounded-lg p-4">
                  <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap font-mono">
                    {a.narrative}
                  </p>
                </div>

                {/* Warnings */}
                {warningList.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {warningList.map((w, i) => (
                      <Badge key={i} variant="outline" className="text-xs bg-yellow-500/5 border-yellow-500/20 text-yellow-400">
                        ⚠ {w}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
