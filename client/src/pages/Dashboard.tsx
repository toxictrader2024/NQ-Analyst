import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import ScoreGauge from "@/components/ScoreGauge";
import ChatPanel from "@/components/ChatPanel";
import CommentaryFeed from "@/components/CommentaryFeed";
import PersonalitySelector from "@/components/PersonalitySelector";
import SessionToggle from "@/components/SessionToggle";
import TradeLog from "@/components/TradeLog";
import { RefreshCw, Zap, TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle2, Clock, Loader2, FlaskConical } from "lucide-react";

interface DashboardData {
  latestWebhook: any;
  score: number;
  ictScore: number;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  confluences: string[];
  warnings: string[];
  latestAnalysis: any;
  recentAnalyses: any[];
  totalSignals: number;
}

export default function Dashboard() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, refetch } = useQuery<DashboardData>({
    queryKey: ["/api/dashboard"],
    queryFn: () => apiRequest("GET", "/api/dashboard").then(r => r.json()),
    refetchInterval: 5000,
  });

  const analyzeMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/analyze", {}).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: "Analysis complete", description: "AI has updated the trade plan." });
    },
    onError: () => toast({ title: "Analysis failed", description: "Check console for details.", variant: "destructive" }),
  });

  const simulateMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/simulate", {}).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: "Simulated signal injected", description: "New ICT signal data loaded." });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  const d = data!;
  const lw = d.latestWebhook;
  const la = d.latestAnalysis;

  const biasIcon = d.bias === "BULLISH"
    ? <TrendingUp className="w-4 h-4 text-green-500" />
    : d.bias === "BEARISH"
    ? <TrendingDown className="w-4 h-4 text-red-500" />
    : <Minus className="w-4 h-4 text-yellow-500" />;

  const dirColor = la?.tradeDirection === "LONG" ? "text-green-500" : la?.tradeDirection === "SHORT" ? "text-red-500" : "text-yellow-500";

  const killzoneLabel = lw?.killzone
    ? lw.killzone.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-card">
        <div>
          <h1 className="text-base font-bold text-foreground">NQ Quant Dashboard</h1>
          <p className="text-xs text-muted-foreground font-mono">
            {lw ? `Last signal: ${new Date(lw.receivedAt).toLocaleTimeString()} · ${lw.timeframe}m` : "Awaiting first signal"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => simulateMutation.mutate()}
            disabled={simulateMutation.isPending}
            className="text-xs gap-1.5"
            data-testid="button-simulate"
          >
            <FlaskConical className="w-3.5 h-3.5" />
            Demo Signal
          </Button>
          <Button
            size="sm"
            onClick={() => analyzeMutation.mutate()}
            disabled={analyzeMutation.isPending}
            className="text-xs gap-1.5 bg-primary hover:bg-primary/90"
            data-testid="button-analyze"
          >
            {analyzeMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Analyze Now
          </Button>
          <Button variant="ghost" size="icon" onClick={() => refetch()} className="w-8 h-8" data-testid="button-refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-5 grid grid-cols-1 xl:grid-cols-3 gap-4">

        {/* Left column — Score + signals */}
        <div className="xl:col-span-2 space-y-4">

          {/* Top row: score + key metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Score Gauge */}
            <div className="space-y-2">
              <ScoreGauge score={d.score} bias={d.bias} />
              <div className="bg-muted rounded-lg px-3 py-2 text-center">
                <div className="text-xs text-muted-foreground">ICT Score</div>
                <div className="font-mono text-sm font-bold text-primary">{d.ictScore}/100</div>
              </div>
            </div>

            {/* Price + VWAP */}
            <div className="bg-card border border-border rounded-xl p-5 space-y-3">
              <div className="text-xs text-muted-foreground uppercase tracking-widest">Price</div>
              <div className="font-mono text-2xl font-bold text-foreground" data-testid="text-price">
                {lw?.close ? lw.close.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—"}
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">VWAP</span>
                  <span className="font-mono text-foreground">{lw?.vwap?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || "—"}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">High</span>
                  <span className="font-mono text-foreground">{lw?.high?.toLocaleString() || "—"}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Low</span>
                  <span className="font-mono text-foreground">{lw?.low?.toLocaleString() || "—"}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Timeframe</span>
                  <span className="font-mono text-foreground">{lw?.timeframe ? `${lw.timeframe}m` : "—"}</span>
                </div>
              </div>
            </div>

            {/* Status flags */}
            <div className="bg-card border border-border rounded-xl p-5 space-y-3">
              <div className="text-xs text-muted-foreground uppercase tracking-widest">ICT Signals</div>
              <div className="space-y-2">
                {[
                  { label: "Killzone", value: killzoneLabel, active: !!lw?.killzone },
                  { label: "Mkt Structure", value: lw?.marketStructure?.replace(/_/g, " ").toUpperCase() || null, active: !!lw?.marketStructure },
                  { label: "FVG", value: lw?.fvgBull ? "BULL" : lw?.fvgBear ? "BEAR" : null, active: !!(lw?.fvgBull || lw?.fvgBear) },
                  { label: "Liq Sweep", value: lw?.sweepHigh ? "HIGH SWEPT" : lw?.sweepLow ? "LOW SWEPT" : null, active: !!(lw?.sweepHigh || lw?.sweepLow) },
                  { label: "Zone", value: lw?.premium ? "PREMIUM" : lw?.discount ? "DISCOUNT" : null, active: !!(lw?.premium || lw?.discount) },
                ].map(({ label, value, active }) => (
                  <div key={label} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{label}</span>
                    {active && value
                      ? <Badge variant="outline" className="text-xs h-5 font-mono text-primary border-primary/30 bg-primary/5">{value}</Badge>
                      : <span className="text-muted-foreground font-mono">—</span>
                    }
                  </div>
                ))}
              </div>
              <div className="pt-1 text-xs text-muted-foreground font-mono">{d.totalSignals} signals received</div>
            </div>
          </div>

          {/* Confluences & Warnings */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                <span className="text-xs font-semibold uppercase tracking-wider text-foreground">Active Confluences</span>
              </div>
              <div className="space-y-1.5">
                {d.confluences.length > 0 ? d.confluences.map((c, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-foreground">
                    <span className="text-green-500 mt-0.5 flex-shrink-0">●</span>
                    {c}
                  </div>
                )) : <p className="text-xs text-muted-foreground">No confluences detected</p>}
              </div>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />
                <span className="text-xs font-semibold uppercase tracking-wider text-foreground">Risk Warnings</span>
              </div>
              <div className="space-y-1.5">
                {d.warnings.length > 0 ? d.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-foreground">
                    <span className="text-yellow-500 mt-0.5 flex-shrink-0">▲</span>
                    {w}
                  </div>
                )) : <p className="text-xs text-muted-foreground">No warnings</p>}
              </div>
            </div>
          </div>

          {/* Latest AI Analysis */}
          {la && (
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-primary" />
                  <span className="text-sm font-semibold text-foreground">AI Trade Plan</span>
                </div>
                <div className="flex items-center gap-2">
                  {biasIcon}
                  <span className={`text-sm font-bold font-mono ${dirColor}`} data-testid="text-direction">
                    {la.tradeDirection}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono">
                    <Clock className="w-3 h-3 inline mr-1" />
                    {new Date(la.createdAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>
              {/* Trade levels */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                {[
                  { label: "Entry Zone", value: la.entryZone, color: "text-foreground" },
                  { label: "Stop Loss", value: la.stopLoss, color: "text-red-400" },
                  { label: "Target 1", value: la.target1, color: "text-green-400" },
                  { label: "Target 2", value: la.target2, color: "text-green-300" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-muted rounded-lg p-3 text-center">
                    <div className="text-xs text-muted-foreground mb-1">{label}</div>
                    <div className={`font-mono text-sm font-bold ${color}`} data-testid={`text-${label.replace(/\s+/g, "-").toLowerCase()}`}>
                      {value || "—"}
                    </div>
                  </div>
                ))}
              </div>
              {/* Narrative — render markdown as formatted HTML */}
              <div className="bg-muted rounded-lg p-4">
                <div
                  className="text-xs text-foreground leading-relaxed prose prose-invert prose-sm max-w-none"
                  data-testid="text-narrative"
                  dangerouslySetInnerHTML={{
                    __html: (la.narrative || "")
                      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                      .replace(/^### (.+)$/gm, "<h3 class='text-xs font-bold text-primary mt-3 mb-1'>$1</h3>")
                      .replace(/^## (.+)$/gm,  "<h2 class='text-xs font-bold text-primary mt-4 mb-1 uppercase tracking-wide'>$1</h2>")
                      .replace(/^# (.+)$/gm,   "<h1 class='text-sm font-bold text-primary mt-4 mb-2'>$1</h1>")
                      .replace(/^---$/gm, "<hr class='border-border my-2'>")
                      .replace(/\n/g, "<br>")
                  }}
                />
              </div>
            </div>
          )}

          {!la && (
            <div className="bg-card border border-border border-dashed rounded-xl p-8 text-center">
              <Zap className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No analysis yet — click "Analyze Now" or inject a demo signal to get started.</p>
            </div>
          )}

          {/* Bot Trade Log */}
          <TradeLog />
        </div>

        {/* Right column — Personality + Commentary + Chat */}
        <div className="xl:col-span-1 flex flex-col gap-4 min-h-0">
          <SessionToggle />
          <PersonalitySelector />
          <div className="h-[400px] xl:h-[50%] flex-shrink-0">
            <CommentaryFeed />
          </div>
          <div className="h-[380px] xl:flex-1">
            <ChatPanel />
          </div>
        </div>
      </div>
    </div>
  );
}
