import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Settings, Copy, CheckCircle2, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

const PINE_SCRIPT_TEMPLATE = `//@version=5
indicator("NQ Muzzi Signals → Webhook", overlay=true)

// ══ Inputs ════════════════════════════════════════════════════════════════════
webhook_url = input.string("YOUR_WEBHOOK_URL_HERE", "Webhook URL")
ticker      = input.string("NQ1!", "Ticker")

// ══ SESSION-ANCHORED VWAP ═════════════════════════════════════════════════════
// All times in UTC. NQ futures sessions:
//   RTH (Regular Trading Hours) = 13:30–20:00 UTC  (8:30am–3pm CT)
//   Asia session                = 22:00–07:00 UTC  (5pm–2am CT previous day)
//   London session              = 07:00–13:30 UTC  (2am–8:30am CT)
//
// VWAP is reset at the start of each session so it anchors correctly.
// RTH VWAP resets at 13:30 UTC. Asia VWAP resets at 22:00 UTC.
// London VWAP resets at 07:00 UTC.
//
// The active VWAP sent in the payload is whichever session is currently live.

utc_h = hour(time, "UTC")
utc_m = minute(time, "UTC")
utc_mins = utc_h * 60 + utc_m   // total minutes into the UTC day

// Session boundary flags (fires true on the FIRST bar of each session)
is_rth_start    = (utc_h == 13 and utc_m == 30)
is_asia_start   = (utc_h == 22 and utc_m == 0)
is_london_start = (utc_h == 7  and utc_m == 0)

// ── RTH VWAP (anchored 13:30 UTC = 8:30am CT) ─────────────────────────────
// Reset numerator/denominator at RTH open each day
var float rth_num = 0.0
var float rth_den = 0.0
if is_rth_start
    rth_num := 0.0
    rth_den := 0.0
typical_price = (high + low + close) / 3
rth_num := rth_num + typical_price * volume
rth_den := rth_den + volume
rth_vwap = rth_den > 0 ? rth_num / rth_den : close

// ── Asia VWAP (anchored 22:00 UTC = 5pm CT) ───────────────────────────────
var float asia_num = 0.0
var float asia_den = 0.0
if is_asia_start
    asia_num := 0.0
    asia_den := 0.0
asia_num := asia_num + typical_price * volume
asia_den := asia_den + volume
asia_vwap = asia_den > 0 ? asia_num / asia_den : close

// ── London VWAP (anchored 07:00 UTC = 2am CT) ─────────────────────────────
var float lon_num = 0.0
var float lon_den = 0.0
if is_london_start
    lon_num := 0.0
    lon_den := 0.0
lon_num := lon_num + typical_price * volume
lon_den := lon_den + volume
lon_vwap = lon_den > 0 ? lon_num / lon_den : close

// ── Pick the active session VWAP ──────────────────────────────────────────
// RTH: 13:30–20:00 UTC | London: 07:00–13:30 UTC | Asia: 22:00–07:00 UTC
is_rth    = (utc_mins >= 810 and utc_mins < 1200)   // 13:30–20:00
is_london = (utc_mins >= 420 and utc_mins < 810)    // 07:00–13:30
is_asia   = (utc_mins >= 1320 or utc_mins < 420)    // 22:00–07:00 (wraps midnight)

// Active VWAP = RTH for NY, London for London, Asia for Asia
active_vwap = is_rth ? rth_vwap : is_london ? lon_vwap : asia_vwap
active_session_name = is_rth ? "RTH" : is_london ? "London" : "Asia"

// Plot all three for visual reference
plot(rth_vwap,    title="RTH VWAP",    color=color.new(color.blue,   20), linewidth=2)
plot(lon_vwap,    title="London VWAP", color=color.new(color.orange,  30), linewidth=1)
plot(asia_vwap,   title="Asia VWAP",   color=color.new(color.purple,  40), linewidth=1)

// ══ KILL ZONES ════════════════════════════════════════════════════════════════
// Muzzi kill zones in UTC:
//   London Open: 07:00–10:00 UTC (2–5am CT)
//   NY Open:     13:30–16:00 UTC (8:30–11am CT)  ← primary
//   NY PM:       18:30–19:30 UTC (1:30–2:30pm CT) ← secondary
//   Asia:        22:00–00:00 UTC (5–7pm CT)
kz_london  = (utc_mins >= 420  and utc_mins < 600)    // 07:00–10:00
kz_ny_open = (utc_mins >= 810  and utc_mins < 960)    // 13:30–16:00
kz_ny_pm   = (utc_mins >= 1110 and utc_mins < 1170)   // 18:30–19:30
kz_asia    = (utc_mins >= 1320 or  utc_mins < 120)    // 22:00–02:00

// Wrecking Ball: 13:30–13:35 UTC (09:30–09:35 ET) — flag but DO NOT trade
wrecking_ball = (utc_h == 13 and utc_m >= 30 and utc_m <= 35)

killzone_str = kz_ny_open and not wrecking_ball ? "ny_open" :
               kz_london  ? "london_open" :
               kz_ny_pm   ? "ny_pm" :
               kz_asia    ? "asia" :
               wrecking_ball ? "wrecking_ball" : ""

// ══ MARKET STRUCTURE (BOS / CHOCH) ════════════════════════════════════════════
swing_hi = ta.pivothigh(high, 5, 5)
swing_lo  = ta.pivotlow(low,  5, 5)
prev_hi   = ta.valuewhen(not na(swing_hi), swing_hi, 0)
prev_lo   = ta.valuewhen(not na(swing_lo), swing_lo, 0)
ms_str    = close > prev_hi ? "BOS_bull" : close < prev_lo ? "BOS_bear" : ""

// ══ FAIR VALUE GAPS ════════════════════════════════════════════════════════════
fvg_bull = low > high[2] and close[1] > high[2]
fvg_bear = high < low[2] and close[1] < low[2]

// ══ LIQUIDITY SWEEPS ══════════════════════════════════════════════════════════
// Use session high/low of last 20 bars (tighter than arbitrary 20-bar lookback)
sweep_hi = high > ta.highest(high[1], 20) and close < ta.highest(high[1], 20)
sweep_lo = low  < ta.lowest(low[1],  20) and close > ta.lowest(low[1],  20)

// ══ PREMIUM / DISCOUNT (dealing range) ════════════════════════════════════════
// 50-bar dealing range — equilibrium at 0.5
range_hi = ta.highest(high, 50)
range_lo  = ta.lowest(low,  50)
eq        = (range_hi + range_lo) / 2.0
premium   = close > eq
discount  = close < eq

// ══ VWAP STANDARD DEVIATIONS (for extended targets) ══════════════════════════
// 1SD above/below active VWAP — marks extended zones
var float sq_sum = 0.0
var float sq_den = 0.0
if is_rth_start or is_london_start or is_asia_start
    sq_sum := 0.0
    sq_den := 0.0
sq_sum := sq_sum + math.pow(typical_price - active_vwap, 2) * volume
sq_den := sq_den + volume
vwap_sd = sq_den > 0 ? math.sqrt(sq_sum / sq_den) : 0.0
vwap_1sd_hi = active_vwap + vwap_sd
vwap_1sd_lo = active_vwap - vwap_sd

// ══ WEBHOOK PAYLOAD ════════════════════════════════════════════════════════════
if barstate.isconfirmed
    payload = '{"ticker":"'       + ticker                              + '",' +
              '"timeframe":'      + '"' + str.tostring(timeframe.period) + '",' +
              '"open":'           + str.tostring(open)                  + ',' +
              '"high":'           + str.tostring(high)                  + ',' +
              '"low":'            + str.tostring(low)                   + ',' +
              '"close":'          + str.tostring(close)                 + ',' +
              '"volume":'         + str.tostring(volume)                + ',' +
              '"vwap":'           + str.tostring(active_vwap)           + ',' +
              '"vwap_rth":'       + str.tostring(rth_vwap)              + ',' +
              '"vwap_london":'    + str.tostring(lon_vwap)              + ',' +
              '"vwap_asia":'      + str.tostring(asia_vwap)             + ',' +
              '"vwap_1sd_hi":'    + str.tostring(vwap_1sd_hi)           + ',' +
              '"vwap_1sd_lo":'    + str.tostring(vwap_1sd_lo)           + ',' +
              '"active_session":"'+ active_session_name                 + '",' +
              '"killzone":"'      + killzone_str                        + '",' +
              '"wrecking_ball":'  + (wrecking_ball ? "1" : "0")         + ',' +
              '"market_structure":"' + ms_str                           + '",' +
              '"fvg_bull":'       + (fvg_bull  ? "1" : "0")            + ',' +
              '"fvg_bear":'       + (fvg_bear  ? "1" : "0")            + ',' +
              '"sweep_high":'     + (sweep_hi  ? "1" : "0")            + ',' +
              '"sweep_low":'      + (sweep_lo  ? "1" : "0")            + ',' +
              '"premium":'        + (premium   ? "1" : "0")            + ',' +
              '"discount":'       + (discount  ? "1" : "0")            + '}'
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
            Use this URL as the webhook endpoint in NinjaTrader (NQ_ICT_Signals_v7) and Sierra Chart (NQ Analyst Bridge) settings.
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
              <h2 className="text-sm font-semibold text-foreground">3. NinjaTrader Indicator</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Load NQ_ICT_Signals_v7.cs in NinjaTrader 8 on the 1m NQ/MNQ chart. Set the Railway webhook URL in the indicator inputs. TradingView is not used — disable any TV alerts pointing to this URL.
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
                  ["Active Session VWAP",     "vwap",            "Session-anchored: RTH/London/Asia"],
                  ["RTH VWAP (8:30am CT)",    "vwap_rth",        "Resets at 8:30am CT every day"],
                  ["London VWAP (2am CT)",     "vwap_london",     "Resets at 2am CT"],
                  ["Asia VWAP (5pm CT)",       "vwap_asia",       "Resets at 5pm CT"],
                  ["VWAP ±1SD bands",          "vwap_1sd_hi/lo",  "Extension targets / reversal zones"],
                  ["Active session name",      "active_session",  "RTH | London | Asia"],
                  ["Kill Zone",               "killzone",         "ny_open / london_open / ny_pm / asia"],
                  ["Wrecking Ball flag",       "wrecking_ball",   "1 = 09:30–09:35 NY — NO entry"],
                  ["Market Structure",        "market_structure", "BOS_bull / BOS_bear"],
                  ["Fair Value Gap",          "fvg_bull/fvg_bear","1 = FVG present"],
                  ["Liquidity Sweep",         "sweep_high/low",   "1 = session H/L swept"],
                  ["Premium / Discount Zone", "premium/discount", "1 = price above/below EQ"],
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
