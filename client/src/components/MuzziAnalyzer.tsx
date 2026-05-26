/**
 * MuzziAnalyzer.tsx
 * Institutional-grade 10-step setup checklist panel for the NQ Quant Dashboard.
 * Built on the Muzzi / CK Trader Pro methodology.
 *
 * Displays:
 *   - 10-step checklist evaluated against the latest webhook signal
 *   - Institutional Gravity score (# of zone layers stacking at one price)
 *   - Setup grade (A+ / A / B / WAIT / ⚠ HARD RULE VIOLATED)
 *   - Coaching feedback in the mentor's language
 *   - Live statistical edges (82% mean reversion, 97.4% 3-bar, 62.3% divergence)
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  CheckCircle2, XCircle, MinusCircle, AlertTriangle, TrendingUp,
  TrendingDown, Layers, Target, Zap, Clock, BarChart2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface WebhookSignal {
  close: number;
  high: number;
  low: number;
  vwap: number;          // active session VWAP (RTH/London/Asia)
  vwapRth: number;       // RTH VWAP anchored at 8:30am CT
  vwapLondon: number;    // London VWAP anchored at 2am CT
  vwapAsia: number;      // Asia VWAP anchored at 5pm CT
  vwap1sdHi: number;     // +1 standard deviation band
  vwap1sdLo: number;     // -1 standard deviation band
  activeSession: string; // "RTH" | "London" | "Asia"
  timeframe: number;
  killzone: string;
  wreckingBall: number;  // 1 = 09:30-09:35 NY — hard rule NO entry
  marketStructure: string;
  fvgBull: number;
  fvgBear: number;
  sweepHigh: number;
  sweepLow: number;
  premium: number;
  discount: number;
  receivedAt: number;
}

interface DashboardData {
  latestWebhook: WebhookSignal | null;
  score: number;
  ictScore: number;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  confluences: string[];
  warnings: string[];
}

interface ChecklistItem {
  id: number;
  label: string;
  detail: string;
  status: "pass" | "fail" | "unknown";
  weight: "primary" | "secondary";
}

interface MuzziResult {
  grade: "A+" | "A" | "B" | "WAIT" | "HARD RULE VIOLATED";
  gravityScore: number;   // 0–7: number of zone layers present
  checklist: ChecklistItem[];
  hardRuleViolated: string | null;
  coachingNote: string;
  statEdge: string | null;
  direction: "LONG" | "SHORT" | "WAIT";
}

// ─────────────────────────────────────────────────────────────────────────────
// MUZZI GRADING ENGINE (client-side, based on webhook signal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates the 10-step checklist from the Muzzi SOP against the latest
 * webhook signal. Returns a full MuzziResult object.
 *
 * Note: Some checklist items require delta flip / Three-Bar Play / OTE data
 * that is not currently in the webhook payload. Those items are marked
 * "unknown" and shown as grey chips — they serve as manual reminders.
 */
function evaluateMuzziChecklist(d: DashboardData): MuzziResult {
  const w = d.latestWebhook;

  // ── Default state when no signal ──────────────────────────────────────────
  if (!w) {
    return {
      grade: "WAIT",
      gravityScore: 0,
      checklist: buildEmptyChecklist(),
      hardRuleViolated: null,
      coachingNote: "No signal yet. Paid to wait — only A+ setups deserve your capital.",
      statEdge: null,
      direction: "WAIT",
    };
  }

  const bias = d.bias;
  const isLong  = bias === "BULLISH";
  const isShort = bias === "BEARISH";

  // ── HARD RULE CHECKS ──────────────────────────────────────────────────────
  // 1. No Diddling in the Middle — equilibrium ban
  const range50pct = w.discount === 0 && w.premium === 0; // at EQ
  if (range50pct) {
    return hardRuleViolation(
      "NO DIDDLING IN THE MIDDLE — Price is at 0.5 Equilibrium. This is a C-grade wrecking zone. No entry.",
      "WAIT",
    );
  }

  // 2. Never short into Discount / Never long into Premium
  if (isLong && w.premium) {
    return hardRuleViolation(
      "HARD RULE: Never long into Premium. Price is above Equilibrium — wait for a Discount retracement.",
      "WAIT",
    );
  }
  if (isShort && w.discount) {
    return hardRuleViolation(
      "HARD RULE: Never short into Discount. Price is below Equilibrium — wait for Premium delivery.",
      "WAIT",
    );
  }

  // 3. NY Open Wrecking Ball — flagged directly by Pine Script [wrecking_ball:1]
  if (w.wreckingBall) {
    return hardRuleViolation(
      "WRECKING BALL WINDOW — 09:30–09:35 NY Open. Algorithms run stops in both directions. NO ENTRY — paid to wait.",
      "WAIT",
    );
  }

  // ── CHECKLIST EVALUATION ─────────────────────────────────────────────────

  const killzoneActive = !!w.killzone && w.killzone !== "" && w.killzone !== "off_session";

  // Kill zone label — map payload values to readable form
  const killzoneLabel = w.killzone
    ? w.killzone.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())
    : null;

  // MSS / CHOCH detected
  const mssPresent =
    !!w.marketStructure &&
    (w.marketStructure.includes("BOS") || w.marketStructure.includes("CHOCH"));
  const mssBull = w.marketStructure?.includes("bull");
  const mssBear = w.marketStructure?.includes("bear");

  // Zone alignment
  const inDiscount = !!w.discount;
  const inPremium  = !!w.premium;
  const validZone  = isLong ? inDiscount : isShort ? inPremium : false;

  // Sweep (manipulation leg)
  const sweepDone = !!(w.sweepHigh || w.sweepLow);

  // FVG present
  const fvgPresent = !!(w.fvgBull || w.fvgBear);
  const fvgAligned = isLong ? !!w.fvgBull : isShort ? !!w.fvgBear : false;

  // VWAP relationship — use the correct session-anchored VWAP
  // active_session from Pine tells us which VWAP is meaningful right now
  const sessionVwap = w.activeSession === "RTH"
    ? (w.vwapRth || w.vwap)
    : w.activeSession === "London"
    ? (w.vwapLondon || w.vwap)
    : (w.vwapAsia || w.vwap);
  const priceAboveVwap = sessionVwap > 0 && w.close > sessionVwap;
  const priceBelowVwap = sessionVwap > 0 && w.close < sessionVwap;
  const vwapAligned    = isLong ? priceBelowVwap : isShort ? priceAboveVwap : false;
  // Extended = price beyond 1SD from session VWAP (max mean reversion probability)
  const extended1SD = w.vwap1sdHi > 0 && (
    (isLong  && w.close <= w.vwap1sdLo) ||
    (isShort && w.close >= w.vwap1sdHi)
  );

  // MSS alignment with bias
  const mssAligned = isLong ? mssBull : isShort ? mssBear : false;

  // ── Institutional Gravity: count zone layers ──────────────────────────────
  // Each distinct structural layer at roughly the same price = +1 gravity
  let gravity = 0;
  if (validZone)     gravity++;    // Dealing range
  if (fvgAligned)    gravity++;    // FVG
  // OB, BB, OTE, BPR, IFVG require data not in current webhook — manual tracking
  // These are shown as "unknown" chips on the checklist

  // ── Build checklist ───────────────────────────────────────────────────────
  const checklist: ChecklistItem[] = [
    {
      id: 1,
      label: "HTF Bias (Daily + 4H)",
      detail: `Current bias: ${bias}. Confirm Daily + 4H before session.`,
      status: bias !== "NEUTRAL" ? "pass" : "fail",
      weight: "primary",
    },
    {
      id: 2,
      label: "Dealing Range — Price in Discount (Long) / Premium (Short)",
      detail: isLong
        ? (validZone ? "✓ Price is in Discount zone" : "✗ Price is NOT in Discount — No Entry")
        : isShort
        ? (validZone ? "✓ Price is in Premium zone"  : "✗ Price is NOT in Premium — No Entry")
        : "Bias unclear — identify HTF direction first",
      status: validZone ? "pass" : bias === "NEUTRAL" ? "unknown" : "fail",
      weight: "primary",
    },
    {
      id: 3,
      label: "Kill Zone Active (NY Open or London Open)",
      detail: killzoneActive
        ? `✓ ${killzoneLabel} is active`
        : "✗ Off-session — kill zones only: London 2–5am CT, NY 8:30–11am CT",
      status: killzoneActive ? "pass" : "fail",
      weight: "primary",
    },
    {
      id: 4,
      label: "Session H/L Swept — Manipulation Leg Complete",
      detail: sweepDone
        ? `✓ ${w.sweepHigh ? "High" : "Low"} swept — AMD Manipulation leg complete`
        : "✗ No sweep detected — Manipulation may not be done",
      status: sweepDone ? "pass" : "fail",
      weight: "primary",
    },
    {
      id: 5,
      label: "MSS / CHOCH Confirmed (1m or 5m)",
      detail: mssPresent
        ? `✓ ${w.marketStructure?.replace(/_/g, " ").toUpperCase()} — ${mssAligned ? "aligned with bias" : "⚠ check alignment"}`
        : "✗ No Market Structure Shift detected",
      status: mssPresent && mssAligned ? "pass" : mssPresent ? "unknown" : "fail",
      weight: "primary",
    },
    {
      id: 6,
      label: "Confluence Zone — OB / BB / FVG / OTE (2+ = Institutional Gravity)",
      detail: fvgAligned
        ? "✓ Aligned FVG present. Mark OB / BB / OTE manually for full Institutional Gravity score."
        : fvgPresent
        ? "⚠ FVG present but misaligned with bias"
        : "✗ No FVG. Manually verify OB / BB / OTE / IFVG / BPR on chart.",
      status: fvgAligned ? "pass" : fvgPresent ? "unknown" : "unknown",
      weight: "primary",
    },
    {
      id: 7,
      label: "VWAP + 20 EMA Aligned with Bias",
      detail: (() => {
        const sessionLabel = w.activeSession || "Session";
        const vwapStr = sessionVwap > 0 ? sessionVwap.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—";
        const sdInfo = w.vwap1sdHi > 0
          ? ` | ±1SD: ${w.vwap1sdLo.toFixed(2)} – ${w.vwap1sdHi.toFixed(2)}`
          : "";
        if (vwapAligned && extended1SD) {
          return `✓ EXTENDED beyond ±1SD from ${sessionLabel} VWAP (${vwapStr})${sdInfo} — MAX mean reversion probability (82% edge active)`;
        }
        if (vwapAligned) {
          return `✓ Price ${isLong ? "below" : "above"} ${sessionLabel} VWAP (${vwapStr})${sdInfo} — aligned. Confirm 20 EMA 15m slope.`;
        }
        return `✗ Price ${isLong ? "above" : "below"} ${sessionLabel} VWAP (${vwapStr})${sdInfo} — not aligned. Check 20 EMA 15m.`;
      })(),
      status: vwapAligned ? "pass" : "unknown",
      weight: "secondary",
    },
    {
      id: 8,
      label: "Three-Bar Play Complete OR Tower Candle 66% Fill (97.4% exhaustion)",
      detail: "Manual confirmation required — check 1m chart for three-candle exhaustion sequence or Tower Candle 66% rule.",
      status: "unknown",
      weight: "secondary",
    },
    {
      id: 9,
      label: "Delta Flip at Zone — The 'Right Now' Execution Signal",
      detail: "Manual confirmation required — verify delta flipped from sell to buy (long) or buy to sell (short) at your zone.",
      status: "unknown",
      weight: "secondary",
    },
    {
      id: 10,
      label: "No Body Close Inside Propulsion Candle (or retest complete)",
      detail: "Manual confirmation required — body of entry candle must NOT close inside the propulsion candle's body.",
      status: "unknown",
      weight: "secondary",
    },
  ];

  // ── Grade calculation ─────────────────────────────────────────────────────
  const passPrimary = checklist.filter(c => c.weight === "primary" && c.status === "pass").length;
  const totalPrimary = checklist.filter(c => c.weight === "primary").length;
  const passSecondary = checklist.filter(c => c.weight === "secondary" && c.status === "pass").length;
  const unknownCount = checklist.filter(c => c.status === "unknown").length;

  // Gravity from auto-detected zone layers
  const gravityFinal = gravity;

  let grade: MuzziResult["grade"] = "WAIT";
  let coachingNote = "";
  let statEdge: string | null = null;
  let direction: "LONG" | "SHORT" | "WAIT" = isLong ? "LONG" : isShort ? "SHORT" : "WAIT";

  if (passPrimary >= totalPrimary && passSecondary >= 1 && gravityFinal >= 2) {
    grade = "A+";
    coachingNote = "A+ setup — Institutional Gravity confirmed. This is the trade. Execute with conviction. Size up within your risk plan.";
    statEdge = vwapAligned ? "Mean Reversion edge active — 82% win rate when price is extended from VWAP + 20 EMA simultaneously." : null;
  } else if (passPrimary >= 4) {
    grade = "A";
    coachingNote = "Strong A setup — core criteria met. Delta Flip or Three-Bar Play not yet confirmed. Wait for item 8 or 9 before pulling the trigger. Patience is the trade.";
  } else if (passPrimary >= 3) {
    grade = "B";
    coachingNote = "B setup — structure is building but Institutional Gravity is not there yet. Stay on the sideline and let price come to your zone. The market pays for discipline.";
  } else {
    grade = "WAIT";
    direction = "WAIT";
    coachingNote = `Only ${passPrimary} of ${totalPrimary} primary criteria met. This is not a Muzzi-grade setup. The best trade right now is no trade. Come back when price respects the checklist.`;
  }

  // Special stat edges
  if (unknownCount <= 2 && grade === "A+") {
    statEdge = "All auto-detectable criteria confirmed. Three-Bar Play + Delta Flip would push this to 97.4% exhaustion edge.";
  }
  // Override with 1SD extension note when price is outside the band (highest probability)
  if (extended1SD && vwapAligned) {
    const sessionLabel = w?.activeSession || "Session";
    statEdge = `Price is beyond the ±1SD band from ${sessionLabel} VWAP — this is the maximum mean reversion zone. 82% win rate edge is ACTIVE. Rubber band is stretched — wait for the Three-Bar Play or Delta Flip to confirm.`;
  }

  return {
    grade,
    gravityScore: gravityFinal,
    checklist,
    hardRuleViolated: null,
    coachingNote,
    statEdge,
    direction,
  };
}

function buildEmptyChecklist(): ChecklistItem[] {
  const labels = [
    ["HTF Bias (Daily + 4H)", "primary"],
    ["Dealing Range — Discount (Long) / Premium (Short)", "primary"],
    ["Kill Zone Active", "primary"],
    ["Session H/L Swept — Manipulation Leg Complete", "primary"],
    ["MSS / CHOCH Confirmed (1m or 5m)", "primary"],
    ["Confluence Zone — OB / BB / FVG / OTE", "primary"],
    ["VWAP + 20 EMA Aligned", "secondary"],
    ["Three-Bar Play or Tower Candle 66% Fill", "secondary"],
    ["Delta Flip at Zone", "secondary"],
    ["No Body Close Inside Propulsion Candle", "secondary"],
  ] as const;

  return labels.map(([label, weight], i) => ({
    id: i + 1,
    label,
    detail: "Awaiting signal data...",
    status: "unknown" as const,
    weight: weight as "primary" | "secondary",
  }));
}

function hardRuleViolation(message: string, direction: "WAIT"): MuzziResult {
  return {
    grade: "HARD RULE VIOLATED",
    gravityScore: 0,
    checklist: buildEmptyChecklist(),
    hardRuleViolated: message,
    coachingNote: message,
    statEdge: null,
    direction,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GRADE BADGE
// ─────────────────────────────────────────────────────────────────────────────

function GradeBadge({ grade }: { grade: MuzziResult["grade"] }) {
  const map: Record<string, string> = {
    "A+":                  "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
    "A":                   "bg-green-500/20 text-green-400 border-green-500/40",
    "B":                   "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
    "WAIT":                "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    "HARD RULE VIOLATED":  "bg-red-500/20 text-red-400 border-red-500/40",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded font-mono text-xs font-bold border ${map[grade] || map["WAIT"]}`}>
      {grade}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECKLIST ROW
// ─────────────────────────────────────────────────────────────────────────────

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const Icon =
    item.status === "pass"    ? CheckCircle2 :
    item.status === "fail"    ? XCircle :
    MinusCircle;

  const iconColor =
    item.status === "pass"    ? "text-emerald-500" :
    item.status === "fail"    ? "text-red-500" :
    "text-zinc-500";

  const labelColor =
    item.status === "pass"    ? "text-foreground" :
    item.status === "fail"    ? "text-red-400" :
    "text-muted-foreground";

  return (
    <div className="flex items-start gap-2.5 py-1.5 border-b border-border/40 last:border-0">
      <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${iconColor}`} />
      <div className="flex-1 min-w-0">
        <div className={`text-xs font-medium ${labelColor} flex items-center gap-1.5`}>
          <span className="font-mono text-muted-foreground w-4 flex-shrink-0">{item.id}.</span>
          {item.label}
          {item.weight === "primary" && (
            <span className="text-[10px] px-1 py-0 bg-primary/10 text-primary rounded font-mono flex-shrink-0">
              CORE
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 pl-5 leading-relaxed">
          {item.detail}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTITUTIONAL GRAVITY METER
// ─────────────────────────────────────────────────────────────────────────────

function GravityMeter({ score }: { score: number }) {
  const maxLayers = 5;
  const label =
    score >= 3 ? "A+ ZONE — Institutional Gravity" :
    score === 2 ? "Confluence Building" :
    score === 1 ? "Single Layer — Weak" :
    "No Zone Detected";

  const barColor =
    score >= 3 ? "bg-emerald-500" :
    score === 2 ? "bg-yellow-500" :
    score === 1 ? "bg-orange-500" :
    "bg-zinc-600";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground flex items-center gap-1">
          <Layers className="w-3 h-3" /> Institutional Gravity
        </span>
        <span className={`font-mono font-bold ${score >= 3 ? "text-emerald-400" : score >= 1 ? "text-yellow-400" : "text-zinc-500"}`}>
          {score}/{maxLayers}
        </span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: maxLayers }).map((_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-all ${i < score ? barColor : "bg-muted"}`}
          />
        ))}
      </div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STAT EDGES CARD
// ─────────────────────────────────────────────────────────────────────────────

const STAT_EDGES = [
  { label: "Mean Reversion", value: "82%", detail: "When price extended from VWAP + 20 EMA simultaneously", icon: TrendingUp },
  { label: "Three-Bar Play", value: "97.4%", detail: "Exhaustion / reversal signal at zone extremity", icon: BarChart2 },
  { label: "SMT Divergence", value: "62.3%", detail: "NQ/ES divergence model", icon: Target },
];

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function MuzziAnalyzer() {
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/dashboard"],
    queryFn: () => apiRequest("GET", "/api/dashboard").then(r => r.json()),
    refetchInterval: 5000,
  });

  const result: MuzziResult = data
    ? evaluateMuzziChecklist(data)
    : {
        grade: "WAIT",
        gravityScore: 0,
        checklist: buildEmptyChecklist(),
        hardRuleViolated: null,
        coachingNote: "Connecting to signal feed...",
        statEdge: null,
        direction: "WAIT",
      };

  const dirColor =
    result.direction === "LONG"  ? "text-emerald-400" :
    result.direction === "SHORT" ? "text-red-400" :
    "text-zinc-400";

  const dirIcon =
    result.direction === "LONG"  ? <TrendingUp  className="w-4 h-4 text-emerald-400" /> :
    result.direction === "SHORT" ? <TrendingDown className="w-4 h-4 text-red-400" /> :
    <Clock className="w-4 h-4 text-zinc-400" />;

  return (
    <div className="space-y-4">

      {/* ── Header card: grade + direction ─────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Muzzi Setup Analyzer</span>
            <span className="text-[10px] font-mono text-muted-foreground px-1.5 py-0.5 rounded bg-muted">10-STEP SOP</span>
          </div>
          <div className="flex items-center gap-2">
            {dirIcon}
            <span className={`font-mono text-sm font-bold ${dirColor}`}>{result.direction}</span>
            <GradeBadge grade={result.grade} />
          </div>
        </div>

        {/* Hard rule violation banner */}
        {result.hardRuleViolated && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 mb-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-400 leading-relaxed font-medium">{result.hardRuleViolated}</p>
          </div>
        )}

        {/* Coaching note */}
        <div className="bg-muted rounded-lg px-3 py-2.5 mb-3">
          <p className="text-xs text-foreground leading-relaxed">{result.coachingNote}</p>
        </div>

        {/* Stat edge (when applicable) */}
        {result.statEdge && (
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 flex items-start gap-2">
            <Target className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-emerald-300 leading-relaxed">{result.statEdge}</p>
          </div>
        )}
      </div>

      {/* ── Institutional Gravity ──────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-4">
        <GravityMeter score={result.gravityScore} />
        <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
          3+ zone layers at one price = Institutional Gravity = A+ entry. Mark OB, BB, OTE, IFVG, BPR
          on chart. Each layer stacking at your entry price adds +1 gravity point.
        </p>
      </div>

      {/* ── 10-Step Checklist ─────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
            10-Step Entry Checklist
          </span>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Auto</span>
            <span className="text-zinc-500 flex items-center gap-1"><MinusCircle className="w-3 h-3" /> Manual</span>
          </div>
        </div>
        <div className="space-y-0">
          {result.checklist.map(item => (
            <ChecklistRow key={item.id} item={item} />
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground mt-3 leading-relaxed border-t border-border/40 pt-2">
          Grey items (1m / 5m) require manual verification on chart. Auto-detected items use live
          TradingView webhook data. Complete all 10 before entry.
        </p>
      </div>

      {/* ── Statistical Edges Reference ───────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-foreground mb-3">
          Statistical Edges
        </div>
        <div className="space-y-2">
          {STAT_EDGES.map(({ label, value, detail, icon: Icon }) => (
            <div key={label} className="flex items-start gap-2.5">
              <Icon className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-foreground font-medium">{label}</span>
                  <span className="font-mono text-xs font-bold text-primary">{value}</span>
                </div>
                <div className="text-[10px] text-muted-foreground">{detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Hard Rules Quick Reference ────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-foreground mb-3 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
          Hard Rules — Absolute
        </div>
        <div className="space-y-1.5">
          {[
            "No Diddling in the Middle — NEVER entry at 0.5 Equilibrium",
            "NEVER short into Discount / NEVER long into Premium",
            "FORBID execution 09:30–09:35 NY Open (Wrecking Ball)",
            "ALWAYS wait for retest after CISD / CHOCH — paid to wait",
            "Friday = Bare Knuckle Match — double confirmation required",
            "Stop trading if slippage exceeds 1%",
          ].map((rule, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px] text-muted-foreground">
              <span className="text-red-500 flex-shrink-0">✕</span>
              {rule}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
