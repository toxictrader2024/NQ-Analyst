import { useState, useEffect } from "react";

const PERSONALITIES = [
  {
    id: "shark",
    emoji: "🦈",
    name: "The Shark",
    desc: "Blunt. Trash-talking. Always right.",
    color: "border-red-500 bg-red-500/10 text-red-400",
    activeColor: "border-red-400 bg-red-500/30 text-red-300 ring-2 ring-red-500/50",
  },
  {
    id: "suit",
    emoji: "👔",
    name: "The Suit",
    desc: "Institutional. Cold. Precise.",
    color: "border-blue-500 bg-blue-500/10 text-blue-400",
    activeColor: "border-blue-400 bg-blue-500/30 text-blue-300 ring-2 ring-blue-500/50",
  },
  {
    id: "oracle",
    emoji: "🔮",
    name: "The Oracle",
    desc: "Sharp. Unbothered. Deadly accurate.",
    color: "border-purple-500 bg-purple-500/10 text-purple-400",
    activeColor: "border-purple-400 bg-purple-500/30 text-purple-300 ring-2 ring-purple-500/50",
  },
];

export default function PersonalitySelector() {
  const [active, setActive] = useState<string>("shark");
  const [loading, setLoading] = useState(false);

  // Load current personality on mount
  useEffect(() => {
    fetch("/api/personality")
      .then(r => r.json())
      .then(d => setActive(d.id))
      .catch(() => {});
  }, []);

  async function switchPersonality(id: string) {
    if (id === active || loading) return;
    setLoading(true);
    try {
      const r = await fetch("/api/personality", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (r.ok) setActive(id);
    } catch {}
    setLoading(false);
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-mono text-gray-400 uppercase tracking-widest">Quant Personality</span>
        {loading && <span className="text-xs text-gray-500 animate-pulse">switching...</span>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {PERSONALITIES.map(p => (
          <button
            key={p.id}
            onClick={() => switchPersonality(p.id)}
            className={`
              flex flex-col items-center gap-1 p-3 rounded-lg border transition-all duration-200 cursor-pointer
              ${active === p.id ? p.activeColor : p.color + " opacity-60 hover:opacity-100"}
            `}
          >
            <span className="text-2xl">{p.emoji}</span>
            <span className="text-xs font-bold leading-tight text-center">{p.name}</span>
            <span className="text-[10px] text-center opacity-70 leading-tight">{p.desc}</span>
          </button>
        ))}
      </div>
      <p className="text-[10px] text-gray-600 mt-2 text-center">
        Talk trash → they talk back harder
      </p>
    </div>
  );
}

// v2
