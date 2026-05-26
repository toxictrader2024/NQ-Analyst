import { Activity, TrendingUp, TrendingDown, Zap, AlertTriangle, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface BookmapData {
  delta: number | null;
  buyVolume: number | null;
  sellVolume: number | null;
  bidStackSize: number | null;
  askStackSize: number | null;
  largeTradeCount: number | null;
  largeBuyCount: number | null;
  largeSellCount: number | null;
  absorptionBull: number;
  absorptionBear: number;
  imbalanceBull: number;
  imbalanceBear: number;
  vapPoc: number | null;
  close: number | null;
  receivedAt: number;
}

interface OrderFlowPanelProps {
  latestBookmap: BookmapData | null;
  orderFlowScore: number;
  orderFlowConfluences: string[];
  hasOrderFlow: boolean;
}

function DeltaBar({ delta }: { delta: number }) {
  const maxDelta = 1000;
  const pct = Math.min(Math.abs(delta) / maxDelta * 100, 100);
  const positive = delta >= 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">SELL</span>
        <span className={`font-mono font-bold text-sm ${positive ? "text-green-400" : "text-red-400"}`}>
          {positive ? "+" : ""}{delta.toLocaleString()}
        </span>
        <span className="text-muted-foreground">BUY</span>
      </div>
      <div className="h-3 bg-muted rounded-full overflow-hidden relative flex">
        {/* center line */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-border z-10" />
        {positive ? (
          <>
            <div className="flex-1" />
            <div
              className="bg-green-500 rounded-r-full transition-all duration-700"
              style={{ width: `${pct / 2}%` }}
            />
            <div className="flex-1" />
          </>
        ) : (
          <>
            <div className="flex-1" />
            <div
              className="bg-red-500 rounded-l-full transition-all duration-700"
              style={{ width: `${pct / 2}%` }}
            />
            <div className="flex-1" />
          </>
        )}
      </div>
    </div>
  );
}

function StackBar({ bidSize, askSize }: { bidSize: number; askSize: number }) {
  const total = bidSize + askSize || 1;
  const bidPct = (bidSize / total) * 100;
  const askPct = (askSize / total) * 100;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-green-400 font-mono w-16">{bidSize.toLocaleString()}</span>
        <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden flex">
          <div className="bg-green-500/70 rounded-l-full transition-all duration-700" style={{ width: `${bidPct}%` }} />
          <div className="bg-red-500/70 rounded-r-full transition-all duration-700" style={{ width: `${askPct}%` }} />
        </div>
        <span className="text-red-400 font-mono w-16 text-right">{askSize.toLocaleString()}</span>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>BID STACK</span>
        <span>ASK STACK</span>
      </div>
    </div>
  );
}

export default function OrderFlowPanel({ latestBookmap, orderFlowScore, orderFlowConfluences, hasOrderFlow }: OrderFlowPanelProps) {
  const scoreColor =
    orderFlowScore >= 65 ? "text-green-400" :
    orderFlowScore >= 40 ? "text-yellow-400" :
    "text-red-400";

  if (!hasOrderFlow || !latestBookmap) {
    return (
      <div className="bg-card border border-border border-dashed rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Layers className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Order Flow</span>
          <Badge variant="outline" className="ml-auto text-xs text-muted-foreground">Bookmap</Badge>
        </div>
        <div className="text-center py-6">
          <Activity className="w-7 h-7 text-muted-foreground mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">No Bookmap data yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Install the Python add-on and set your webhook URL.</p>
          <a href="/#/setup" className="text-xs text-primary hover:underline mt-2 inline-block">
            View setup instructions →
          </a>
        </div>
      </div>
    );
  }

  const bm = latestBookmap;
  const delta = bm.delta ?? 0;
  const bidSz = bm.bidStackSize ?? 0;
  const askSz = bm.askStackSize ?? 0;

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Order Flow</span>
          <Badge variant="outline" className="text-xs text-primary border-primary/30 bg-primary/5">CME Live</Badge>
        </div>
        <div className="text-right">
          <div className={`font-mono text-lg font-bold ${scoreColor}`}>{orderFlowScore}/100</div>
          <div className="text-xs text-muted-foreground">OF Score</div>
        </div>
      </div>

      {/* Delta bar */}
      <div className="bg-muted rounded-lg p-3">
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Cumulative Delta</div>
        <DeltaBar delta={delta} />
        <div className="flex justify-between text-xs text-muted-foreground mt-2">
          <span>Buy Vol: <span className="text-green-400 font-mono">{(bm.buyVolume ?? 0).toLocaleString()}</span></span>
          <span>Sell Vol: <span className="text-red-400 font-mono">{(bm.sellVolume ?? 0).toLocaleString()}</span></span>
        </div>
      </div>

      {/* DOM Stack bar */}
      <div className="bg-muted rounded-lg p-3">
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">DOM Depth (±10 pts)</div>
        <StackBar bidSize={bidSz} askSize={askSz} />
      </div>

      {/* Key metrics grid */}
      <div className="grid grid-cols-3 gap-2">
        {[
          {
            label: "Large Prints",
            value: String(bm.largeTradeCount ?? 0),
            sub: `${bm.largeBuyCount ?? 0}B / ${bm.largeSellCount ?? 0}S`,
            color: (bm.largeBuyCount ?? 0) > (bm.largeSellCount ?? 0) ? "text-green-400" : (bm.largeSellCount ?? 0) > (bm.largeBuyCount ?? 0) ? "text-red-400" : "text-foreground",
          },
          {
            label: "POC",
            value: bm.vapPoc ? bm.vapPoc.toLocaleString() : "—",
            sub: bm.close && bm.vapPoc ? (bm.close > bm.vapPoc ? "▲ Above" : "▼ Below") : "",
            color: bm.close && bm.vapPoc ? (bm.close > bm.vapPoc ? "text-green-400" : "text-red-400") : "text-foreground",
          },
          {
            label: "Updated",
            value: new Date(bm.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            sub: "last bar",
            color: "text-muted-foreground",
          },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className="bg-muted rounded-lg p-2.5 text-center">
            <div className="text-xs text-muted-foreground mb-1">{label}</div>
            <div className={`font-mono text-sm font-bold ${color}`}>{value}</div>
            {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
          </div>
        ))}
      </div>

      {/* Absorption / Imbalance alerts */}
      <div className="space-y-1.5">
        {bm.absorptionBull ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
            <TrendingUp className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
            <span className="text-xs text-green-400 font-medium">Bull Absorption — large sell absorbed at bid</span>
          </div>
        ) : null}
        {bm.absorptionBear ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
            <TrendingDown className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
            <span className="text-xs text-red-400 font-medium">Bear Absorption — large buy absorbed at ask</span>
          </div>
        ) : null}
        {bm.imbalanceBull ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
            <Zap className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
            <span className="text-xs text-green-400 font-medium">DOM Imbalance — stacked bids, support below</span>
          </div>
        ) : null}
        {bm.imbalanceBear ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
            <span className="text-xs text-red-400 font-medium">DOM Imbalance — stacked asks, resistance above</span>
          </div>
        ) : null}
      </div>

      {/* OF Confluences */}
      {orderFlowConfluences.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground uppercase tracking-wider">OF Confluences</div>
          {orderFlowConfluences.map((c, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-foreground">
              <span className="text-primary mt-0.5 flex-shrink-0">◆</span>
              {c}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
