# NQ Quant Dashboard — VWAP Fix (v3)

## Root Cause Fixed
The old Pine Script used `ta.vwap()` which is a **chart-origin cumulative VWAP** —
it accumulates from the first bar on your chart, not from any session open.
On a 1m NQ chart open all day this can be 1000+ points off from reality.

## What's Different Now

### Three Session-Anchored VWAPs
| VWAP | Anchor Time | Covers |
|------|-------------|--------|
| RTH VWAP | 13:30 UTC (8:30am CT) | Regular Trading Hours |
| London VWAP | 07:00 UTC (2:00am CT) | London session |
| Asia VWAP | 22:00 UTC (5:00pm CT) | Overnight / Asia session |

Each VWAP resets its numerator and denominator to zero at the start of its session
using `var float` accumulators — this is the correct way to anchor VWAPs in Pine Script v5.

### Payload Changes (new fields)
```json
"vwap"          : active session VWAP  (was broken chart-origin)
"vwap_rth"      : RTH VWAP
"vwap_london"   : London VWAP
"vwap_asia"     : Asia VWAP
"vwap_1sd_hi"   : active VWAP + 1 standard deviation (extension target)
"vwap_1sd_lo"   : active VWAP - 1 standard deviation (extension target)
"active_session": "RTH" | "London" | "Asia"
"wrecking_ball" : 1 = 09:30-09:35 NY — hard rule NO ENTRY
```

### Dashboard Changes
- Price card now shows the **active session VWAP** prominently in cyan
- Other session VWAPs shown as grey reference lines below
- Muzzi Analyzer checklist item 7 now shows the actual session VWAP value and ±1SD bands
- When price is BEYOND ±1SD from VWAP → stat edge banner fires: "82% edge ACTIVE"
- Wrecking Ball now detected by Pine directly (not client-side time math)

## Deploy Instructions
Same as before — drop these into your Railway repo:

```
Dashboard.tsx     → client/src/pages/Dashboard.tsx
ChatPanel.tsx     → client/src/components/ChatPanel.tsx
MuzziAnalyzer.tsx → client/src/components/MuzziAnalyzer.tsx
Setup.tsx         → client/src/components/Setup.tsx  (or pages/ — wherever it lives)
Sidebar.tsx       → client/src/components/Sidebar.tsx (unchanged)
```

## IMPORTANT — TradingView Alert Setup
After deploying, you MUST replace your TradingView alert script with the new Pine Script
from the Setup page. The old script sent wrong VWAP values.

Steps:
1. Open TradingView → your NQ1! chart
2. Remove the old "NQ ICT Signals → Webhook" indicator
3. Open Pine Editor → paste the new script from the Setup page
4. Click "Add to chart"
5. Create a new alert → Webhook → paste your webhook URL
6. Delete the old alert (it still fires the broken VWAP)
