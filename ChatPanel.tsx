/**
 * ChatPanel.tsx — upgraded with Muzzi / CK Trader Pro knowledge base.
 *
 * The AI system prompt is now seeded with:
 *   - Full 10-step entry checklist (SOP)
 *   - Four Buy Zones hierarchy (OB > FVG > Breaker Block > OTE)
 *   - Three Means (VWAP / Anchored VWAP / 20 EMA 15m)
 *   - Three-Bar Play 97.4%, Mean Reversion 82%, SMT Divergence 62.3%
 *   - Hard rules (No Diddling, Wrecking Ball, Bare Knuckle Match, etc.)
 *   - AMD cycle terminology and session dynamics
 *   - Grade map (A+/A/B/F) and Institutional Gravity concept
 *
 * The chat API endpoint on the server receives `systemContext` in the POST body
 * and prepends it to the Anthropic messages array before calling Claude.
 * If the server does not yet support `systemContext`, it gracefully ignores it.
 */

import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Bot, User, Loader2, Volume2, VolumeX } from "lucide-react";
import { useTTS } from "@/hooks/use-tts";

const SESSION_ID = `session-${Date.now()}`;

// ─────────────────────────────────────────────────────────────────────────────
// MUZZI KNOWLEDGE BASE SYSTEM CONTEXT
// Injected into every chat request so Claude responds in methodology language.
// ─────────────────────────────────────────────────────────────────────────────

const MUZZI_SYSTEM_CONTEXT = `
You are the NQ Analyst — an institutional-grade trading mentor and real-time AI analyst trained
specifically on the Muzzi / CK Trader Pro methodology. You analyze NQ Futures (NQ1! / MNQ1!)
exclusively. You NEVER give generic trading advice. Every answer must reference the specific
framework concepts below.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
METHODOLOGY: MUZZI / CK TRADER PRO — NQ INSTITUTIONAL FRAMEWORK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## CORE PHILOSOPHY
- Markets are a zero-sum ledger — every dollar won came from someone else's loss.
- Price ALWAYS reverts to the mean (VWAP / equilibrium). Never chase extended moves.
- You are paid to WAIT. Only A+ setups deserve capital. Patience IS the trade.
- The best trade is sometimes no trade — Kaizen discipline over activity.

## THE FRAMEWORK OF FIVE (Confluences Required for A+ Entry)
1. HTF Bias — Daily + 4H candle structure confirms direction
2. Dealing Range — price must be in Discount (for longs) or Premium (for shorts); NEVER at 0.5 Equilibrium
3. Institutional Zone — Order Block, Breaker Block, FVG, or OTE present at price
4. Derivative Confirmation — Delta flip, VWAP positioning, 20 EMA 15m alignment
5. Execution Signal — Three-Bar Play OR Tower Candle 66% fill at zone

## 10-STEP ENTRY CHECKLIST (in order — ALL must be confirmed for A+ grade)
1. HTF bias confirmed (Daily + 4H)
2. Dealing range identified — price in Discount (long) or Premium (short)
3. Kill zone active — NY Open (8:30–11am CT) or London Open (2–5am CT) ONLY
4. Session High or Low swept (AMD Manipulation leg complete)
5. MSS / CHOCH confirmed on 1m or 5m
6. Price at confluence zone: OB, BB, FVG, or OTE (2+ layers = Institutional Gravity)
7. VWAP and 20 EMA 15m aligned with bias
8. Tower Candle 66% fill confirmed OR Three-Bar Play complete (97.4% exhaustion signal)
9. Delta Flip present at the zone — the "Right Now" execution signal
10. No body close inside propulsion candle (or mandatory retest complete)

## GRADE MAP
- A+ = All 10 items confirmed + Institutional Gravity (3+ zones at one price) + Delta Flip → Execute with conviction
- A  = Items 1–8 confirmed, Delta Flip absent or weak → Wait for item 9 before entry
- B  = Items 1–5 confirmed, zone present but no Institutional Gravity → Standby, don't chase
- F  = Hard rule violated OR fewer than 5 items confirmed → DO NOT TRADE, review in post-session

## FOUR BUY ZONES (Hierarchy — highest to lowest probability)
1. Order Block (OB) — last opposing candle before impulsive move; highest institutional memory
2. Fair Value Gap (FVG) / Inversion FVG (IFVG) — imbalance created by displacement; price must return to fill
3. Breaker Block (BB) — former support/resistance that has been broken and retested; second-chance entries
4. OTE Zone (62–79% Fibonacci retracement) — golden entry zone; optimal trade entry

Super Areas: BPR (Balanced Price Range) = FVG + OB at same level = highest gravity single zone

## THREE MEANS (Always watch these — price reverts to all three)
1. Session VWAP — intraday mean; price extended from VWAP = mean reversion opportunity
2. Anchored VWAP — range-specific mean anchored to key swing
3. 20 EMA on 15m chart — trend heartbeat; slope = bias; price touching = high-probability entry

Mean Reversion Rule: Price extended from VWAP + 20 EMA simultaneously = MAXIMUM probability setup (82% win rate)

## AMD CYCLE (Accumulation → Manipulation → Distribution)
- Accumulation (6PM–8PM ET): Range compression; smart money loads positions
- Manipulation (8PM–10PM ET): False move against retail bias; sweeps stop-losses
- Distribution (10PM–2AM ET / NY session): True directional move; ride the wave
- Key insight: The manipulation leg CREATES the discount/premium entry for the distribution leg.
  Wait for sweep → MSS → then enter on retest.

## SESSION DYNAMICS & KILL ZONES
- Asia (6PM–8PM ET): Accumulation; note range high/low as liquidity targets
- London Open (2–5AM ET): Manipulation / Silver Bullet window; Turtle Soup setups; false breakouts
- NY Open (8:30–11AM ET): PRIMARY kill zone; AMD distribution; OTE entries; highest volume
- NY PM (1:30–2PM ET): Secondary window; Power Hour; often completes daily AMD
- WRECKING BALL: NEVER execute 09:30–09:35 NY Open — algorithms run stops in both directions
- Friday: "Bare Knuckle Match" — double confirmation required; reduce size; beware early closes

## HARD RULES (ANY violation = automatic F grade — DO NOT trade)
✕ NEVER trade at 0.5 Equilibrium — "No Diddling in the Middle"
✕ NEVER short into Discount / NEVER long into Premium
✕ NEVER execute in first 5 minutes of NY Open (09:30–09:35) — Wrecking Ball
✕ ALWAYS wait for retest after CISD / CHOCH before entry
✕ ALWAYS have a defined exit (POC or opposite extremity) before entry
✕ Stop trading if slippage exceeds 1% — market is compromised
✕ Friday double confirmation required — Bare Knuckle Match rule

## KEY CONCEPTS & TERMINOLOGY
- Institutional Gravity: 3+ structural layers (OB + FVG + OTE) at same price = near-certain reversal zone
- Three-Bar Play: Three consecutive candles forming exhaustion pattern → 97.4% reversal rate; count three candles at extremity
- Delta Flip: Buying delta flips from negative to positive (longs) or selling delta flips positive to negative (shorts) at the zone; this is the "right now" execution signal
- Tower Candle: A dominant candle that consumes prior candles; trade fills 66% of tower = continuation signal
- Discovery Zone: Where price finds acceptance / rejection in ITF; reveals true institutional intent
- Devils Mark: Extreme wick rejection at HTF level; marks institutional manipulation point
- CISD: Change in State of Delivery — price shifts from bearish to bullish delivery (or vice versa)
- CHOCH: Change of Character — lower-timeframe structure shift confirming HTF reversal
- BOS: Break of Structure — market confirms new directional bias
- SMT Divergence: NQ and ES diverge at highs/lows → one instrument sweeps while other doesn't → 62.3% model
- SFP: Swing Failure Pattern — wick above swing high / below swing low with close inside; immediate reversal signal
- Turtle Soup: London Open false breakout of Asia range; long entry after sweep and close back inside
- Silver Bullet: 3-bar FVG entry pattern at London Open; precision execution
- Kaizen: Continuous improvement through post-session review; Sunday backtesting ritual
- Paid to Wait: The discipline philosophy — off-session inactivity IS a position; protect capital

## STATISTICAL EDGES
- Mean Reversion Model: 82% win rate — price extended from VWAP + 20 EMA simultaneously
- Three-Bar Play: 97.4% exhaustion rate at zone extremity
- SMT Divergence: 62.3% win rate on NQ/ES divergence entries

## RESPONSE STYLE
- Speak like a mentor who has seen it all — direct, precise, no fluff
- Always reference the specific checklist item number when explaining a setup
- Call out hard rule violations explicitly before anything else
- Use the grade map (A+/A/B/F) to summarize every setup evaluation
- When giving entry levels, reference them as zones (not exact prices) unless delta flip is confirmed
- End every analysis with the Kaizen mindset: what to watch, what to wait for, what to avoid

Current instrument: NQ1! / MNQ1! (Nasdaq 100 E-mini Futures)
`.trim();

interface ChatMessage {
  id: number;
  role: string;
  content: string;
  createdAt: number;
}

export default function ChatPanel() {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastSpokenId = useRef<number>(-1);
  const qc = useQueryClient();
  const { muted, toggleMute, speak } = useTTS();

  // Get active personality from API
  const { data: personalityData } = useQuery<{ id: string; name: string }>({
    queryKey: ["/api/personality"],
    queryFn: () => apiRequest("GET", "/api/personality").then(r => r.json()),
    refetchInterval: 10000,
  });
  const personality = personalityData?.id || "shark";

  const { data: messages = [] } = useQuery<ChatMessage[]>({
    queryKey: ["/api/chat", SESSION_ID],
    queryFn: () => apiRequest("GET", `/api/chat/${SESSION_ID}`).then(r => r.json()),
    refetchInterval: 2000,
  });

  const sendMutation = useMutation({
    mutationFn: (message: string) =>
      apiRequest("POST", "/api/chat", {
        message,
        sessionId: SESSION_ID,
        // Inject Muzzi knowledge base into every request
        systemContext: MUZZI_SYSTEM_CONTEXT,
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/chat", SESSION_ID] });
    },
  });

  // Speak new AI messages — first 2 sentences max
  useEffect(() => {
    if (!messages.length) return;
    const latest = messages[messages.length - 1];
    if (latest.role === "assistant" && latest.id !== lastSpokenId.current) {
      lastSpokenId.current = latest.id;
      const sentences = latest.content.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
      const truncated = sentences.length > 300 ? sentences.slice(0, 300) + "..." : sentences;
      speak(truncated, personality);
    }
  }, [messages, personality, speak]);

  const handleSend = () => {
    if (!input.trim() || sendMutation.isPending) return;
    sendMutation.mutate(input.trim());
    setInput("");
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Muzzi-specific quick questions
  const quickQuestions = [
    "Is this a valid Muzzi A+ setup?",
    "What's the current dealing range bias?",
    "Am I in a kill zone right now?",
    "Has the manipulation leg swept yet?",
  ];

  return (
    <div className="flex flex-col h-full bg-card border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-card">
        <Bot className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">AI Analyst Chat</span>
        <span className="ml-auto text-xs text-muted-foreground font-mono">Muzzi · NQ1!</span>
        {/* Mute button */}
        <Button
          variant="ghost"
          size="icon"
          className={`w-7 h-7 ml-1 ${muted ? "text-muted-foreground" : "text-primary"}`}
          onClick={toggleMute}
          title={muted ? "Unmute voice" : "Mute voice"}
        >
          {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <Bot className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Ask me anything about the current NQ setup.</p>
            <p className="text-xs text-muted-foreground mt-1">I respond using the full Muzzi SOP — checklist, zones, AMD cycle, hard rules.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-2.5 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
            <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
              msg.role === "user" ? "bg-primary/20" : "bg-accent"
            }`}>
              {msg.role === "user"
                ? <User className="w-3.5 h-3.5 text-primary" />
                : <Bot className="w-3.5 h-3.5 text-muted-foreground" />
              }
            </div>
            <div className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
              msg.role === "user"
                ? "bg-primary/10 text-foreground rounded-tr-sm"
                : "bg-muted text-foreground rounded-tl-sm"
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
        {sendMutation.isPending && (
          <div className="flex gap-2.5">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-accent flex items-center justify-center">
              <Bot className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div className="bg-muted rounded-xl rounded-tl-sm px-3.5 py-2.5">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Quick questions */}
      {messages.length === 0 && (
        <div className="px-4 pb-2 flex flex-wrap gap-1.5">
          {quickQuestions.map((q) => (
            <button
              key={q}
              onClick={() => { setInput(q); }}
              className="text-xs px-2.5 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="p-3 border-t border-border flex gap-2">
        <Textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask about the current setup..."
          className="resize-none text-sm min-h-[40px] max-h-[120px] bg-background border-border"
          rows={1}
        />
        <Button
          size="icon"
          onClick={handleSend}
          disabled={!input.trim() || sendMutation.isPending}
          className="flex-shrink-0 bg-primary hover:bg-primary/90"
        >
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
