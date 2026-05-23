import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Settings, Copy, CheckCircle2, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

const PINE_SCRIPT_TEMPLATE = `//@version=5
indicator("NQ ICT Signals → Webhook", overlay=true)

// ══ Inputs ═══════════════════════════════════════════════
webhook_url = input.string("YOUR_WEBHOOK_URL_HERE", "Webhook URL")
ticker      = input.string("NQ1!", "Ticker")

// ══ VWAP ══════════════════════════════════════════════════
[v, _, _] = ta.vwap(high, low, close, volume)

// ══ Kill Zones (CT timezone = UTC-5/6) ════════════════════
utc_hour = hour(time, "UTC")
london_open = (utc_hour >= 7 and utc_hour < 10)   // 2-5am CT
ny_open     = (utc_hour >= 12 and utc_hour < 15)  // 7-10am CT
ny_close    = (utc_hour >= 18 and utc_hour < 20)  // 1-3pm CT
killzone = london_open ? "london_open" : ny_open ? "ny_open" : ny_close ? "ny_close" : ""

// ══ Market Structure (simplified BOS/CHoCH) ════════════════
swing_hi = ta.pivothigh(high, 5, 5)
swing_lo  = ta.pivotlow(low, 5, 5)
prev_hi   = ta.valuewhen(not na(swing_hi), swing_hi, 0)
prev_lo   = ta.valuewhen(not na(swing_lo), swing_lo, 0)
ms = close > prev_hi ? "BOS_bull" : close < prev_lo ? "BOS_bear" : ""

// ══ Fair Value Gaps ════════════════════════════════════════
fvg_bull = low > high[2] and close[1] > high[2]
fvg_bear = high < low[2] and close[1] < low[2]

// ══ Liquidity Sweeps ══════════════════════════════════════
sweep_hi = high > ta.highest(high[1], 20)[1] and close < ta.highest(high[1], 20)[1]
sweep_lo = low < ta.lowest(low[1], 20)[1] and close > ta.lowest(low[1], 20)[1]

// ══ Premium / Discount (equilibrium midpoint) ══════════════
range_hi = ta.highest(high, 50)
range_lo  = ta.lowest(low, 50)
eq        = (range_hi + range_lo) / 2
premium  = close > eq
discount = close < eq

// ══ Webhook payload ═══════════════════════════════════════
if barstate.isconfirmed
    payload = '{"ticker":"' + ticker + '",' +
              '"timeframe":"' + str.tostring(timeframe.period) + '",' +
              '"open":' + str.tostring(open) + ',' +
              '"high":' + str.tostring(high) + ',' +
              '"low":' + str.tostring(low) + ',' +
              '"close":' + str.tostring(close) + ',' +
              '"volume":' + str.tostring(volume) + ',' +
              '"vwap":' + str.tostring(v) + ',' +
              '"killzone":"' + killzone + '",' +
              '"market_structure":"' + ms + '",' +
              '"fvg_bull":' + (fvg_bull ? "1" : "0") + ',' +
              '"fvg_bear":' + (fvg_bear ? "1" : "0") + ',' +
              '"sweep_high":' + (sweep_hi ? "1" : "0") + ',' +
              '"sweep_low":' + (sweep_lo ? "1" : "0") + ',' +
              '"premium":' + (premium ? "1" : "0") + ',' +
              '"discount":' + (discount ? "1" : "0") + '}'
    alert(payload, alert.freq_once_per_bar_close)`;

export default function Setup() {
  const [copied, setCopied] = useState<string | null>(null);

  const { data: urlData } = useQuery({
    queryKey: ["/api/webhook-url"],
    queryFn: () => apiRequest("GET", "/api/webhook-url").then(r => r.json()),
  });

  const webhookUrl = urlData?.url || "https://your-deployed-url/api/webhook";

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="p-5 max-w-3xl">
      <div className="flex items-center gap-2 mb-6">
        <Settings className="w-4 h-4 text-primary" />
        <h1 className="text-base font-bold text-foreground">Setup & Configuration</h1>
      </div>

      <div className="space-y-6">

        {/* Webhook URL */}
        <section className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-foreground mb-1">1. Your Webhook URL</h2>
          <p className="text-xs text-muted-foreground mb-3">
            Use this URL as the webhook endpoint in TradingView alert settings.
          </p>
          <div className="flex items-center gap-2 bg-muted rounded-lg p-3">
            <code className="text-xs font-mono text-primary flex-1 break-all" data-testid="text-webhook-url">{webhookUrl}</code>
            <Button
              variant="ghost"
              size="icon"
              className="flex-shrink-0 w-7 h-7"
              onClick={() => copy(webhookUrl, "url")}
              data-testid="button-copy-url"
            >
              {copied === "url" ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </section>

        {/* AI Key */}
        <section className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-foreground mb-1">2. Anthropic API Key</h2>
          <p className="text-xs text-muted-foreground mb-3">
            Set <code className="font-mono text-xs text-primary">ANTHROPIC_API_KEY</code> as an environment variable on your server to enable full AI analysis. Without it, the app runs in demo/scoring mode.
          </p>
          <div className="bg-muted rounded-lg p-3">
            <code className="text-xs font-mono text-muted-foreground">ANTHROPIC_API_KEY=sk-ant-...</code>
          </div>
          <a
            href="https://console.anthropic.com/account/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-2"
          >
            Get your key at console.anthropic.com <ExternalLink className="w-3 h-3" />
          </a>
        </section>

        {/* Pine Script */}
        <section className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">3. TradingView Pine Script</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Add this indicator to your NQ chart. Set the webhook URL in the input, then create an alert → Webhook.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-xs gap-1.5 flex-shrink-0"
              onClick={() => copy(PINE_SCRIPT_TEMPLATE.replace("YOUR_WEBHOOK_URL_HERE", webhookUrl), "pine")}
              data-testid="button-copy-pine"
            >
              {copied === "pine" ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
              Copy Script
            </Button>
          </div>
          <div className="relative bg-muted rounded-lg p-4 overflow-auto max-h-80">
            <pre className="text-xs font-mono text-muted-foreground whitespace-pre">{PINE_SCRIPT_TEMPLATE}</pre>
          </div>
        </section>

        {/* Signal guide */}
        <section className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-foreground mb-3">4. ICT Signal Reference</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-left">
                  <th className="pb-2 pr-6 font-medium">Signal</th>
                  <th className="pb-2 pr-6 font-medium">Payload Key</th>
                  <th className="pb-2 font-medium">Scoring</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[
                  ["Kill Zone active", "killzone", "+15 pts (shared bull/bear)"],
                  ["Market Structure BOS/CHoCH", "market_structure", "+20 pts dominant side"],
                  ["Fair Value Gap", "fvg_bull / fvg_bear", "+15 pts"],
                  ["Order Block", "ob_bull / ob_bear", "+12 pts"],
                  ["Liquidity Sweep", "sweep_high / sweep_low", "+18 pts"],
                  ["Premium/Discount Zone", "premium / discount", "+12 pts"],
                  ["VWAP relationship", "vwap + close", "+8 pts"],
                  ["Multi-bar structure trend", "auto-calculated", "+10 pts"],
                ].map(([sig, key, pts]) => (
                  <tr key={sig}>
                    <td className="py-2 pr-6 text-foreground">{sig}</td>
                    <td className="py-2 pr-6 font-mono text-primary">{key}</td>
                    <td className="py-2 text-muted-foreground">{pts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

      </div>
    </div>
  );
}
