import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface ScorecardEntry {
  id: number;
  sessionDate: string;
  morningBias: string | null;
  morningScore: number | null;
  setup1Name: string | null;
  setup1Direction: string | null;
  setup1Entry: number | null;
  setup1Sl: number | null;
  setup1Tp1: number | null;
  setup1Tp2: number | null;
  setup1Confluences: string | null;
  setup1Outcome: string | null;
  setup1PnlPts: number | null;
  setup2Name: string | null;
  setup2Direction: string | null;
  setup2Entry: number | null;
  setup2Sl: number | null;
  setup2Tp1: number | null;
  setup2Tp2: number | null;
  setup2Confluences: string | null;
  setup2Outcome: string | null;
  setup2PnlPts: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  actualDirection: string | null;
  biasCorrect: number | null;
  reviewNarrative: string | null;
  keyLessons: string | null;
  rollingWinRate: number | null;
  rollingBiasAccuracy: number | null;
  rollingAvgPnlPts: number | null;
}

interface ScorecardStats {
  winRate: number;
  biasAccuracy: number;
  avgPnlPts: number;
  totalSessions: number;
}

interface ScorecardData {
  entries: ScorecardEntry[];
  stats: ScorecardStats;
}

function outcomeColor(outcome: string | null) {
  if (!outcome || outcome === "PENDING") return "text-gray-400";
  if (outcome === "TP2") return "text-emerald-400";
  if (outcome === "TP1") return "text-green-400";
  if (outcome === "STOPPED") return "text-red-400";
  if (outcome === "NO_TRIGGER") return "text-gray-500";
  return "text-gray-400";
}

function outcomeLabel(outcome: string | null) {
  if (!outcome) return "—";
  const map: Record<string, string> = {
    TP2: "✅ TP2 Hit",
    TP1: "🟡 TP1 Hit",
    STOPPED: "🛑 Stopped",
    NO_TRIGGER: "⬜ No Trigger",
    PENDING: "⏳ Pending",
  };
  return map[outcome] || outcome;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-500 uppercase tracking-widest">{label}</span>
      <span className="text-2xl font-bold text-white">{value}</span>
      {sub && <span className="text-xs text-gray-500">{sub}</span>}
    </div>
  );
}

function SetupCard({ n, entry }: { n: 1 | 2; entry: ScorecardEntry }) {
  const name = n === 1 ? entry.setup1Name : entry.setup2Name;
  const dir = n === 1 ? entry.setup1Direction : entry.setup2Direction;
  const entryPx = n === 1 ? entry.setup1Entry : entry.setup2Entry;
  const sl = n === 1 ? entry.setup1Sl : entry.setup2Sl;
  const tp1 = n === 1 ? entry.setup1Tp1 : entry.setup2Tp1;
  const tp2 = n === 1 ? entry.setup1Tp2 : entry.setup2Tp2;
  const outcome = n === 1 ? entry.setup1Outcome : entry.setup2Outcome;
  const pnl = n === 1 ? entry.setup1PnlPts : entry.setup2PnlPts;
  const conflRaw = n === 1 ? entry.setup1Confluences : entry.setup2Confluences;
  const confluences: string[] = conflRaw ? JSON.parse(conflRaw) : [];

  if (!name) return null;

  return (
    <div className="bg-gray-800 rounded-lg p-3 flex flex-col gap-2 text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="font-semibold text-white">{name}</span>
        <div className="flex items-center gap-2">
          {dir && (
            <span className={`text-xs font-bold px-2 py-0.5 rounded ${dir === "LONG" ? "bg-emerald-900 text-emerald-300" : "bg-red-900 text-red-300"}`}>
              {dir}
            </span>
          )}
          <span className={`text-xs font-semibold ${outcomeColor(outcome)}`}>{outcomeLabel(outcome)}</span>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs">
        <div><span className="text-gray-500">Entry</span><br /><span className="text-white">{entryPx?.toLocaleString() ?? "—"}</span></div>
        <div><span className="text-gray-500">SL</span><br /><span className="text-red-400">{sl?.toLocaleString() ?? "—"}</span></div>
        <div><span className="text-gray-500">TP1</span><br /><span className="text-green-400">{tp1?.toLocaleString() ?? "—"}</span></div>
        <div><span className="text-gray-500">TP2</span><br /><span className="text-emerald-400">{tp2?.toLocaleString() ?? "—"}</span></div>
      </div>
      {confluences.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {confluences.map((c, i) => (
            <span key={i} className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded-full">{c}</span>
          ))}
        </div>
      )}
      {pnl !== null && pnl !== 0 && (
        <div className={`text-xs font-semibold ${pnl > 0 ? "text-emerald-400" : "text-red-400"}`}>
          {pnl > 0 ? "+" : ""}{pnl} pts
        </div>
      )}
    </div>
  );
}

function SessionRow({ entry, onClick, selected }: { entry: ScorecardEntry; onClick: () => void; selected: boolean }) {
  const totalPnl = (entry.setup1PnlPts ?? 0) + (entry.setup2PnlPts ?? 0);
  const dayLabel = new Date(entry.sessionDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg border transition-colors ${selected ? "border-blue-600 bg-blue-950/40" : "border-gray-800 bg-gray-900 hover:border-gray-700"}`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="text-white font-medium text-sm">{dayLabel}</span>
          {entry.morningBias && (
            <span className={`text-xs font-bold px-2 py-0.5 rounded ${entry.morningBias === "BULLISH" ? "bg-emerald-900 text-emerald-300" : entry.morningBias === "BEARISH" ? "bg-red-900 text-red-300" : "bg-gray-700 text-gray-300"}`}>
              {entry.morningBias}
            </span>
          )}
          {entry.biasCorrect !== null && (
            <span className={`text-xs ${entry.biasCorrect === 1 ? "text-emerald-400" : "text-red-400"}`}>
              {entry.biasCorrect === 1 ? "✓ Bias correct" : "✗ Bias wrong"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className={outcomeColor(entry.setup1Outcome)}>{outcomeLabel(entry.setup1Outcome)}</span>
          <span className={outcomeColor(entry.setup2Outcome)}>{outcomeLabel(entry.setup2Outcome)}</span>
          {(entry.setup1PnlPts !== null || entry.setup2PnlPts !== null) && (
            <span className={`font-bold ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {totalPnl > 0 ? "+" : ""}{totalPnl} pts
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

export default function Scorecard() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ScorecardEntry | null>(null);

  const { data, isLoading } = useQuery<ScorecardData>({
    queryKey: ["/api/scorecard"],
    queryFn: () => fetch("/api/scorecard").then(r => r.json()),
    refetchInterval: 60_000,
  });

  const simulate = useMutation({
    mutationFn: () => fetch("/api/scorecard/simulate", { method: "POST" }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/scorecard"] }),
  });

  const stats = data?.stats;
  const entries = data?.entries ?? [];

  const lessons: string[] = selected?.keyLessons
    ? (() => { try { return JSON.parse(selected.keyLessons); } catch { return [selected.keyLessons]; } })()
    : [];

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Session Scorecard</h1>
          <p className="text-sm text-gray-500 mt-0.5">Post-session grading — builds your statistical edge over time</p>
        </div>
        <button
          onClick={() => simulate.mutate()}
          disabled={simulate.isPending}
          className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg border border-gray-700 transition-colors"
        >
          {simulate.isPending ? "Loading..." : "Inject Demo Session"}
        </button>
      </div>

      {/* Rolling Stats */}
      {stats && stats.totalSessions > 0 ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Win Rate" value={`${stats.winRate}%`} sub="Sessions with TP1+ hit (last 20)" />
          <StatCard label="Bias Accuracy" value={`${stats.biasAccuracy}%`} sub="Morning bias vs. actual (last 20)" />
          <StatCard label="Avg P&L" value={`${stats.avgPnlPts > 0 ? "+" : ""}${stats.avgPnlPts} pts`} sub="Per session average (last 20)" />
          <StatCard label="Sessions Graded" value={String(stats.totalSessions)} sub="Total logged sessions" />
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
          <p className="text-gray-400 text-sm">No sessions graded yet.</p>
          <p className="text-gray-600 text-xs mt-1">The 4pm CT review cron will populate this automatically each trading day. Hit "Inject Demo Session" to preview the layout.</p>
        </div>
      )}

      {/* Two-column layout: list + detail */}
      {entries.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Session list */}
          <div className="lg:col-span-2 flex flex-col gap-2">
            <h2 className="text-xs text-gray-500 uppercase tracking-widest mb-1">Session History</h2>
            {isLoading ? (
              <div className="text-gray-600 text-sm">Loading...</div>
            ) : (
              entries.map(e => (
                <SessionRow
                  key={e.id}
                  entry={e}
                  onClick={() => setSelected(e)}
                  selected={selected?.id === e.id}
                />
              ))
            )}
          </div>

          {/* Detail panel */}
          <div className="lg:col-span-3">
            {selected ? (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col gap-5 sticky top-4">
                {/* Date + meta */}
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <h2 className="text-lg font-bold text-white">
                      {new Date(selected.sessionDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                    </h2>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      {selected.morningBias && (
                        <span className={`text-xs font-bold px-2 py-0.5 rounded ${selected.morningBias === "BULLISH" ? "bg-emerald-900 text-emerald-300" : selected.morningBias === "BEARISH" ? "bg-red-900 text-red-300" : "bg-gray-700 text-gray-300"}`}>
                          {selected.morningBias} BIAS
                        </span>
                      )}
                      {selected.morningScore !== null && (
                        <span className="text-xs text-gray-400">Score: {selected.morningScore}/100</span>
                      )}
                      {selected.actualDirection && (
                        <span className={`text-xs font-semibold ${selected.actualDirection === "UP" ? "text-emerald-400" : selected.actualDirection === "DOWN" ? "text-red-400" : "text-gray-400"}`}>
                          Actual: {selected.actualDirection}
                        </span>
                      )}
                      {selected.biasCorrect !== null && (
                        <span className={`text-xs font-bold ${selected.biasCorrect === 1 ? "text-emerald-400" : "text-red-400"}`}>
                          {selected.biasCorrect === 1 ? "✓ Bias Correct" : "✗ Bias Wrong"}
                        </span>
                      )}
                    </div>
                  </div>
                  {(selected.sessionHigh || selected.sessionLow) && (
                    <div className="text-xs text-gray-500 text-right">
                      <div>H: <span className="text-green-400">{selected.sessionHigh?.toLocaleString()}</span></div>
                      <div>L: <span className="text-red-400">{selected.sessionLow?.toLocaleString()}</span></div>
                    </div>
                  )}
                </div>

                {/* Setups */}
                <div>
                  <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-2">Setups</h3>
                  <div className="flex flex-col gap-2">
                    <SetupCard n={1} entry={selected} />
                    <SetupCard n={2} entry={selected} />
                  </div>
                </div>

                {/* AI Review */}
                {selected.reviewNarrative && (
                  <div>
                    <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-2">AI Post-Mortem</h3>
                    <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{selected.reviewNarrative}</p>
                  </div>
                )}

                {/* Key Lessons */}
                {lessons.length > 0 && (
                  <div>
                    <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-2">Key Lessons</h3>
                    <ul className="flex flex-col gap-2">
                      {lessons.map((l, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                          <span className="text-blue-400 mt-0.5">▸</span>
                          <span>{l}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Rolling edge at time of this session */}
                {selected.rollingWinRate !== null && (
                  <div className="border-t border-gray-800 pt-4">
                    <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-2">Rolling Edge (at close of this session)</h3>
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div>
                        <div className="text-lg font-bold text-white">{selected.rollingWinRate}%</div>
                        <div className="text-xs text-gray-500">Win Rate</div>
                      </div>
                      <div>
                        <div className="text-lg font-bold text-white">{selected.rollingBiasAccuracy}%</div>
                        <div className="text-xs text-gray-500">Bias Accuracy</div>
                      </div>
                      <div>
                        <div className={`text-lg font-bold ${(selected.rollingAvgPnlPts ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {(selected.rollingAvgPnlPts ?? 0) > 0 ? "+" : ""}{selected.rollingAvgPnlPts} pts
                        </div>
                        <div className="text-xs text-gray-500">Avg P&L</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 flex flex-col items-center justify-center text-center h-full min-h-[300px]">
                <div className="text-3xl mb-3">📊</div>
                <p className="text-gray-400 text-sm">Select a session to see the full post-mortem.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
