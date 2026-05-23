interface ScoreGaugeProps {
  score: number;
  bias: string;
}

export default function ScoreGauge({ score, bias }: ScoreGaugeProps) {
  const color =
    score >= 65 ? "#22c55e" :
    score >= 40 ? "#f59e0b" :
    "#ef4444";

  const glow =
    score >= 65 ? "glow-green" :
    score >= 40 ? "glow-yellow" :
    "glow-red";

  const biasColor =
    bias === "BULLISH" ? "#22c55e" :
    bias === "BEARISH" ? "#ef4444" :
    "#f59e0b";

  // SVG arc math
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const arcLength = circumference * 0.75; // 270° sweep
  const filled = arcLength * (score / 100);
  const dashOffset = arcLength - filled;
  const cx = 70;
  const cy = 70;

  return (
    <div className={`flex flex-col items-center justify-center p-6 rounded-xl bg-card border border-border ${glow}`}>
      <div className="relative w-36 h-36">
        <svg viewBox="0 0 140 140" className="w-full h-full -rotate-[135deg]">
          {/* Track */}
          <circle
            cx={cx} cy={cy} r={radius}
            fill="none"
            stroke="hsl(220 10% 18%)"
            strokeWidth="10"
            strokeDasharray={`${arcLength} ${circumference}`}
            strokeLinecap="round"
          />
          {/* Fill */}
          <circle
            cx={cx} cy={cy} r={radius}
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeDasharray={`${filled} ${circumference}`}
            strokeDashoffset={0}
            strokeLinecap="round"
            style={{ transition: "stroke-dasharray 0.8s cubic-bezier(0.16,1,0.3,1)" }}
          />
        </svg>
        {/* Center label */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-3xl font-bold" style={{ color }}>{score}</span>
          <span className="text-xs text-muted-foreground font-mono">/ 100</span>
        </div>
      </div>
      <div className="mt-2 text-center">
        <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Setup Score</div>
        <div className="text-lg font-bold font-mono" style={{ color: biasColor }}>
          {bias}
        </div>
      </div>
    </div>
  );
}
