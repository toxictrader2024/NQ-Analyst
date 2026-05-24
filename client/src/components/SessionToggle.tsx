/**
 * SessionToggle — switches analysis mode between Asia, London, and NY sessions
 * Persists selection in localStorage. Exposed via /api/session GET+POST.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

const SESSIONS = [
  {
    id: "asia",
    label: "Asia",
    hours: "6PM–midnight ET",
    color: "from-blue-600/20 to-blue-500/10 border-blue-500/40 text-blue-400",
    activeColor: "from-blue-600/40 to-blue-500/20 border-blue-400 text-blue-300",
    dot: "bg-blue-400",
    description: "Range building, liquidity pools, stop hunts",
  },
  {
    id: "london",
    label: "London",
    hours: "Midnight–6AM ET",
    color: "from-purple-600/20 to-purple-500/10 border-purple-500/40 text-purple-400",
    activeColor: "from-purple-600/40 to-purple-500/20 border-purple-400 text-purple-300",
    dot: "bg-purple-400",
    description: "Sweep Asia highs/lows, set NY direction",
  },
  {
    id: "ny",
    label: "New York",
    hours: "7AM–11AM ET",
    color: "from-green-600/20 to-green-500/10 border-green-500/40 text-green-400",
    activeColor: "from-green-600/40 to-green-500/20 border-green-400 text-green-300",
    dot: "bg-green-400",
    description: "ICT setups, killzone entries, trend continuation",
  },
];

export default function SessionToggle() {
  const qc = useQueryClient();

  const { data } = useQuery<{ session: string }>({
    queryKey: ["/api/session"],
    queryFn: () => apiRequest("GET", "/api/session").then(r => r.json()),
    refetchInterval: 30000,
  });

  const mutation = useMutation({
    mutationFn: (session: string) =>
      apiRequest("POST", "/api/session", { session }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/session"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard"] });
    },
  });

  const active = data?.session || "ny";

  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <div className="text-xs text-muted-foreground font-medium mb-2 px-1">SESSION MODE</div>
      <div className="grid grid-cols-3 gap-2">
        {SESSIONS.map(s => {
          const isActive = active === s.id;
          return (
            <button
              key={s.id}
              onClick={() => mutation.mutate(s.id)}
              className={`relative rounded-lg border bg-gradient-to-b px-2 py-2.5 text-left transition-all duration-200 hover:scale-[1.02] ${
                isActive ? s.activeColor + " ring-1 ring-offset-0" : s.color + " opacity-70 hover:opacity-90"
              }`}
            >
              {isActive && (
                <span className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${s.dot} animate-pulse`} />
              )}
              <div className="font-bold text-xs mb-0.5">{s.label}</div>
              <div className="text-[10px] opacity-70 font-mono leading-tight">{s.hours}</div>
              <div className="text-[9px] opacity-60 leading-tight mt-1 hidden sm:block">{s.description}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
