import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useEffect, useRef, useState } from "react";
import { Bot, TrendingUp, TrendingDown, Zap, Activity, Repeat2, ChevronDown, ChevronUp, FlaskConical, Loader2, Bell, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useTTS } from "@/hooks/use-tts";

interface CommentaryItem {
  id: number;
  createdAt: number;
  type: string;
  urgency: string;
  title: string;
  message: string;
  price: number | null;
  suggestedSl: number | null;
  suggestedTp1: number | null;
  suggestedTp2: number | null;
  triggerSource: string | null;
  prevBias: string | null;
  newBias: string | null;
}

const TYPE_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string; border: string }> = {
  reversal:     { icon: Repeat2,    color: "text-yellow-400", bg: "bg-yellow-500/8",  border: "border-yellow-500/25" },
  continuation: { icon: TrendingUp, color: "text-blue-400",   bg: "bg-blue-500/8",   border: "border-blue-500/25" },
  bias_change:  { icon: Zap,        color: "text-purple-400", bg: "bg-purple-500/8", border: "border-purple-500/25" },
  absorption:   { icon: Activity,   color: "text-green-400",  bg: "bg-green-500/8",  border: "border-green-500/25" },
  tp_update:    { icon: TrendingUp, color: "text-orange-400", bg: "bg-orange-500/8", border: "border-orange-500/25" },
  sl_update:    { icon: TrendingDown, color: "text-red-400",  bg: "bg-red-500/8",    border: "border-red-500/25" },
  structure:    { icon: TrendingUp, color: "text-blue-400",   bg: "bg-blue-500/8",   border: "border-blue-500/25" },
  killzone:     { icon: Bell,       color: "text-cyan-400",   bg: "bg-cyan-500/8",   border: "border-cyan-500/25" },
  imbalance:    { icon: Activity,   color: "text-orange-400", bg: "bg-orange-500/8", border: "border-orange-500/25" },
  general:      { icon: Bot,        color: "text-muted-foreground", bg: "bg-muted/40", border: "border-border" },
};

const URGENCY_DOT: Record<string, string> = {
  high:   "bg-red-400 animate-pulse",
  medium: "bg-yellow-400",
  low:    "bg-muted-foreground",
};

function CommentaryCard({ item, isNew }: { item: CommentaryItem; isNew: boolean }) {
  const [expanded, setExpanded] = useState(item.urgency === "high");
  const config = TYPE_CONFIG[item.type] || TYPE_CONFIG.general;
  const Icon = config.icon;

  return (
    <div
      className={`rounded-xl border ${config.border} ${config.bg} transition-all duration-300 ${
        isNew ? "ring-1 ring-primary/40 shadow-lg shadow-primary/5" : ""
      }`}
      data-testid={`card-commentary-${item.id}`}
    >
      {/* Header */}
      <button
        className="w-full text-left p-3.5 flex items-start gap-2.5"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Urgency dot */}
        <div className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${URGENCY_DOT[item.urgency] || URGENCY_DOT.low}`} />

        {/* Icon */}
        <Icon className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${config.color}`} />

        {/* Title + time */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-xs font-semibold leading-tight ${config.color}`}>{item.title}</span>
            <span className="text-xs text-muted-foreground font-mono flex-shrink-0">
              {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          </div>
          {item.price && (
            <div className="text-xs text-muted-foreground font-mono mt-0.5">
              @ {item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
          )}
        </div>

        {/* Expand toggle */}
        <div className="flex-shrink-0 text-muted-foreground">
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3.5 pb-3.5 space-y-3">
          {/* AI message */}
          <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap font-mono border-t border-border/50 pt-3">
            {item.message}
          </p>

          {/* Trade levels */}
          {(item.suggestedSl || item.suggestedTp1 || item.suggestedTp2) && (
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-background/60 rounded-lg p-2.5 text-center">
                <div className="text-xs text-muted-foreground mb-1">Stop Loss</div>
                <div className="font-mono text-sm font-bold text-red-400" data-testid={`text-sl-${item.id}`}>
                  {item.suggestedSl ? item.suggestedSl.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—"}
                </div>
              </div>
              <div className="bg-background/60 rounded-lg p-2.5 text-center">
                <div className="text-xs text-muted-foreground mb-1">TP1</div>
                <div className="font-mono text-sm font-bold text-green-400" data-testid={`text-tp1-${item.id}`}>
                  {item.suggestedTp1 ? item.suggestedTp1.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—"}
                </div>
              </div>
              <div className="bg-background/60 rounded-lg p-2.5 text-center">
                <div className="text-xs text-muted-foreground mb-1">TP2</div>
                <div className="font-mono text-sm font-bold text-green-300" data-testid={`text-tp2-${item.id}`}>
                  {item.suggestedTp2 ? item.suggestedTp2.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—"}
                </div>
              </div>
            </div>
          )}

          {/* Bias change indicator */}
          {item.type === "bias_change" && item.prevBias && item.newBias && (
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline" className="font-mono text-red-400 border-red-400/30">{item.prevBias}</Badge>
              <span className="text-muted-foreground">→</span>
              <Badge variant="outline" className="font-mono text-green-400 border-green-400/30">{item.newBias}</Badge>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CommentaryFeed() {
  const qc = useQueryClient();
  const feedRef = useRef<HTMLDivElement>(null);
  const [seenIds, setSeenIds] = useState<Set<number>>(new Set());
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const { muted, toggleMute, speak } = useTTS();

  // Get active personality
  const { data: personalityData } = useQuery<{ id: string; name: string }>({
    queryKey: ["/api/personality"],
    queryFn: () => apiRequest("GET", "/api/personality").then(r => r.json()),
    refetchInterval: 10000,
  });
  const personality = personalityData?.id || "shark";

  const { data: items = [], isLoading } = useQuery<CommentaryItem[]>({
    queryKey: ["/api/commentary"],
    queryFn: () => apiRequest("GET", "/api/commentary?limit=30").then(r => r.json()),
    refetchInterval: 4000,
  });

  const simulateMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/commentary/simulate", {}).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/commentary"] }),
  });

  // Track new items
  useEffect(() => {
    if (items.length === 0) return;
    const incoming = new Set<number>();
    items.forEach(item => {
      if (!seenIds.has(item.id)) incoming.add(item.id);
    });
    if (incoming.size > 0) {
      setNewIds(incoming);
      setSeenIds(prev => new Set([...prev, ...incoming]));
      setTimeout(() => setNewIds(new Set()), 8000);
      // Speak the highest urgency new item
      const newItems = items.filter(i => incoming.has(i.id));
      const toSpeak = newItems.find(i => i.urgency === "high") || newItems[0];
      if (toSpeak) {
        // Speak title + first sentence only — don't read the full analysis
        const firstSentence = toSpeak.message.split(/(?<=[.!?])\s+/)[0] || toSpeak.message;
        const truncated = firstSentence.length > 200 ? firstSentence.slice(0, 200) + "..." : firstSentence;
        speak(`${toSpeak.title}. ${truncated}`, personality);
      }
    }
  }, [items, personality, speak]);

  // Auto-scroll to top (newest first)
  useEffect(() => {
    if (autoScroll && feedRef.current && newIds.size > 0) {
      feedRef.current.scrollTop = 0;
    }
  }, [items, autoScroll]);

  const urgencyCounts = {
    high: items.filter(i => i.urgency === "high").length,
    medium: items.filter(i => i.urgency === "medium").length,
  };

  return (
    <div className="flex flex-col h-full bg-card border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-card flex-shrink-0">
        <div className="relative">
          <Bot className="w-4 h-4 text-primary" />
          {newIds.size > 0 && (
            <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-400 rounded-full animate-pulse" />
          )}
        </div>
        <span className="text-sm font-semibold text-foreground">AI Market Commentary</span>
        <Button
          variant="ghost"
          size="icon"
          className={`w-7 h-7 ml-1 ${muted ? "text-muted-foreground" : "text-primary"}`}
          onClick={toggleMute}
          title={muted ? "Unmute voice" : "Mute voice"}
        >
          {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </Button>
        <div className="flex gap-1.5 ml-1">
          {urgencyCounts.high > 0 && (
            <Badge variant="outline" className="text-xs h-4 px-1.5 text-red-400 border-red-400/30">{urgencyCounts.high} high</Badge>
          )}
        </div>
        <div className="ml-auto flex gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => simulateMutation.mutate()}
            disabled={simulateMutation.isPending}
            data-testid="button-demo-commentary"
          >
            {simulateMutation.isPending
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <FlaskConical className="w-3 h-3" />}
            Demo
          </Button>
        </div>
      </div>

      {/* Feed */}
      <div
        ref={feedRef}
        className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0"
        onScroll={e => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollTop < 40);
        }}
      >
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        )}

        {!isLoading && items.length === 0 && (
          <div className="text-center py-12 space-y-2">
            <Bot className="w-8 h-8 text-muted-foreground mx-auto" />
            <p className="text-xs text-muted-foreground">Watching for market events…</p>
            <p className="text-xs text-muted-foreground">Commentary fires on: bias flips, absorption, BOS/CHoCH, sweeps, delta divergence, DOM imbalance.</p>
            <button
              className="text-xs text-primary hover:underline mt-2 block mx-auto"
              onClick={() => simulateMutation.mutate()}
            >
              Inject a demo event →
            </button>
          </div>
        )}

        {items.map(item => (
          <CommentaryCard
            key={item.id}
            item={item}
            isNew={newIds.has(item.id)}
          />
        ))}
      </div>

      {/* Status bar */}
      <div className="px-4 py-2 border-t border-border flex items-center gap-2 flex-shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
        <span className="text-xs text-muted-foreground">Live — polling every 4s</span>
        <span className="ml-auto text-xs text-muted-foreground font-mono">{items.length} events</span>
      </div>
    </div>
  );
}
