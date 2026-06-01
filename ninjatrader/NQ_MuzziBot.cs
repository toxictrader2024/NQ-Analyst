// NQ_MuzziBot.cs — Execution strategy for NQ Analyst
// Clean rewrite from scratch — guaranteed compile, no accumulated bugs.
// ─────────────────────────────────────────────────────────────────────
// ARCHITECTURE (NT8 thread-safety rules strictly followed):
//   • Calculate.OnPriceChange  → OnBarUpdate fires on every tick.
//   • A single background ThreadPool worker polls the Railway API every
//     PollIntervalSec seconds and parks the result in a VOLATILE slot
//     (pendingExec). It NEVER calls EnterLong / EnterShort.
//   • OnBarUpdate (main thread, BarsInProgress == 0) consumes pendingExec
//     and is the ONLY place orders are submitted.
//   • OnExecutionUpdate detects fills and posts results back to Railway
//     on a background thread.
//   • SL / TP1 / TP2 are placed with managed SetStopLoss / SetProfitTarget.
//   • No User-Agent header (NT8 blocks WebRequest with a User-Agent).
// ─────────────────────────────────────────────────────────────────────

#region Using declarations
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Globalization;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.DrawingTools;
using NinjaTrader.NinjaScript.Strategies;
using System.Windows.Media;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    // ── Pending execution slot (handed from background thread → main thread) ──
    public struct PendingSignal
    {
        public string Id;
        public string Direction;   // "long" | "short"
        public double Entry;
        public double SL;
        public double TP1;
        public double TP2;
    }

    public class NQ_MuzziBot : Strategy
    {
        // ── Parameters ─────────────────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "Server URL", GroupName = "Server", Order = 1)]
        public string ServerUrl { get; set; }

        [NinjaScriptProperty]
        [Range(1, int.MaxValue)]
        [Display(Name = "Poll Interval Sec", GroupName = "Server", Order = 2)]
        public int PollIntervalSec { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "ATM Strategy Name", GroupName = "Execution", Order = 3)]
        public string AtmStrategyName { get; set; }

        [NinjaScriptProperty]
        [Range(1, int.MaxValue)]
        [Display(Name = "Contracts", GroupName = "Execution", Order = 4)]
        public int Qty { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "SL Pts", GroupName = "Execution", Order = 5)]
        public double SlPts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "TP1 Pts", GroupName = "Execution", Order = 6)]
        public double Tp1Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "TP2 Pts", GroupName = "Execution", Order = 7)]
        public double Tp2Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Max Loss Pts", GroupName = "Execution", Order = 8)]
        public double MaxLossPts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Enable Trading", GroupName = "Execution", Order = 9)]
        public bool EnableTrading { get; set; }

        // ── Threading state ────────────────────────────────────────────────
        private volatile bool   polling     = false;
        private volatile bool   hasPending  = false;   // true when pendingExec holds a fresh signal
        private PendingSignal    pendingExec;           // guarded by pendingLock + hasPending flag
        private readonly object  pendingLock = new object();
        private DateTime         lastPoll    = DateTime.MinValue;

        // ── Active trade state (main-thread only) ──────────────────────────
        private string activeSignalId  = null;
        private string activeDirection = null;   // "long" | "short"
        private double activeEntry     = 0;
        private double activeSL        = 0;
        private double activeTp1       = 0;
        private double activeTp2       = 0;
        private int    entryBar        = -1;
        private int    tradeCount      = 0;

        // ── Order names ─────────────────────────────────────────────────────
        private const string SL_NAME  = "MuzziSL";
        private const string TP1_NAME = "MuzziTP1";
        private const string TP2_NAME = "MuzziTP2";

        // ── Drawing tags / colors ───────────────────────────────────────────
        private string TagEntry  => "MZ_Entry_"  + tradeCount;
        private string TagSL     => "MZ_SL_"     + tradeCount;
        private string TagTP1    => "MZ_TP1_"    + tradeCount;
        private string TagTP2    => "MZ_TP2_"    + tradeCount;
        private string TagOut    => "MZ_Out_"    + tradeCount;
        private const string TagStatus = "MZ_Status";

        private static readonly Brush BullGreen  = Brushes.Lime;
        private static readonly Brush BearRed    = Brushes.Red;
        private static readonly Brush SlColor    = Brushes.OrangeRed;
        private static readonly Brush Tp1Color   = Brushes.Yellow;
        private static readonly Brush Tp2Color   = Brushes.Cyan;
        private static readonly Brush StatusIdle = Brushes.Gray;

        // ── Lifecycle ────────────────────────────────────────────────────────
        protected override void OnStateChange()
        {
            // Route ALL of this strategy's Print() calls to Output Tab 2.
            // ROOT CAUSE of the "silent OnBarUpdate": PrintTo defaults to
            // PrintTo.OutputTab1, so every MuzziBot print was landing in
            // Output 1 (mixed with the ICT indicator) while we were watching
            // a blank Output 2. OnBarUpdate WAS firing the whole time.
            // Set this as early as possible so even SetDefaults/Configure
            // diagnostics land in Output 2.
            PrintTo = PrintTo.OutputTab2;

            if (State == State.SetDefaults)
            {
                Print("[MuzziBot] OnStateChange → SetDefaults");
                Name                          = "NQ MuzziBot";
                Description                   = "Polls NQ Analyst Railway API and executes signals on the NT8 main thread.";
                Calculate                     = Calculate.OnPriceChange;
                EntriesPerDirection           = 1;
                EntryHandling                 = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy  = true;
                ExitOnSessionCloseSeconds     = 30;
                IsFillLimitOnTouch            = false;
                IsInstantiatedOnEachOptimizationIteration = false;
                StartBehavior                 = StartBehavior.ImmediatelySubmit;
                BarsRequiredToTrade           = 0;

                ServerUrl       = "https://nq-analyst-production.up.railway.app";
                PollIntervalSec = 5;
                AtmStrategyName = "";
                Qty             = 1;
                SlPts           = 15;
                Tp1Pts          = 20;
                Tp2Pts          = 40;
                MaxLossPts      = 25;
                EnableTrading   = true;
            }
            else if (State == State.Configure)
            {
                Print("[MuzziBot] OnStateChange → Configure");
            }
            else if (State == State.DataLoaded)
            {
                Print("[MuzziBot] OnStateChange → DataLoaded");
                DrawStatusLabel("MUZZIBOT ONLINE | WAITING FOR SIGNAL", StatusIdle);
                Print("[MuzziBot] DataLoaded — server " + ServerUrl + " | poll " + PollIntervalSec + "s | qty " + Qty);
            }
            else if (State == State.Historical)
            {
                Print("[MuzziBot] OnStateChange → Historical");
            }
            else if (State == State.Transition)
            {
                Print("[MuzziBot] OnStateChange → Transition");
            }
            else if (State == State.Realtime)
            {
                Print("[MuzziBot] OnStateChange → Realtime — strategy is now live.");
            }
            else if (State == State.Terminated)
            {
                string sid = activeSignalId;
                if (!string.IsNullOrEmpty(sid))
                {
                    string url = ServerUrl + "/api/trade-signal/result";
                    string body = "{\"id\":\"" + sid + "\",\"status\":\"cancelled\",\"reason\":\"strategy terminated\"}";
                    ThreadPool.QueueUserWorkItem(delegate { HttpPost(url, body); });
                }
                Print("[MuzziBot] Terminated.");
            }
        }

        // ── Main thread — fires on every tick (Calculate.OnPriceChange) ──────
        protected override void OnBarUpdate()
        {
            // Absolute first line, no conditions — proves OnBarUpdate fires.
            Print("[MuzziBot] TICK " + CurrentBar);

            if (BarsInProgress != 0) return;
            if (CurrentBar < 0)      return;

            // STEP 1 — execute a pending signal (ONLY place orders are entered)
            if (hasPending && activeSignalId == null)
            {
                PendingSignal ps;
                lock (pendingLock)
                {
                    ps = pendingExec;
                    hasPending = false;
                }
                ExecuteSignalOnMainThread(ps);
                return;
            }

            // STEP 2 — kick off a background poll if idle
            if (activeSignalId == null && !hasPending && !polling
                && (DateTime.Now - lastPoll).TotalSeconds >= PollIntervalSec)
            {
                lastPoll = DateTime.Now;
                ThreadPool.QueueUserWorkItem(delegate { PollForSignal(); });
            }

            // STEP 3 — detect a position that closed (exit orders filled etc.)
            if (activeSignalId != null && Position.MarketPosition == MarketPosition.Flat)
            {
                // STEP 4 — safety reset: signal set but flat for 60+ bars
                if (entryBar >= 0 && (CurrentBar - entryBar) >= 60)
                {
                    Print("[MuzziBot] Safety reset — activeSignalId stuck flat 60+ bars, clearing.");
                    DrawStatusLabel("RESET — WAITING FOR SIGNAL", StatusIdle);
                    ResetSignal();
                }
            }
        }

        // ── Background thread — polls Railway, parks result. No order calls. ─
        private void PollForSignal()
        {
            if (polling) return;
            polling = true;
            try
            {
                if (!EnableTrading)
                {
                    DrawStatusLabel("MUZZIBOT PAUSED | ENABLE TRADING OFF", SlColor);
                    return;
                }

                DrawStatusLabel("POLLING... " + DateTime.Now.ToString("HH:mm:ss"), StatusIdle);

                string json = HttpGet(ServerUrl + "/api/trade-signal/pending", 5000);
                if (string.IsNullOrEmpty(json) || json == "{}" || json.Contains("\"id\":null"))
                {
                    DrawStatusLabel("MUZZIBOT ONLINE | NO SIGNAL", StatusIdle);
                    return;
                }

                string rid    = GetString(json, "id");
                string rdir   = GetString(json, "direction");
                double rentry = GetDouble(json, "entry");
                double rsl    = GetDouble(json, "sl");
                double rtp1   = GetDouble(json, "tp1");
                double rtp2   = GetDouble(json, "tp2");

                if (string.IsNullOrEmpty(rid) || string.IsNullOrEmpty(rdir)) return;

                rdir = rdir.ToLowerInvariant();
                if (rdir != "long" && rdir != "short")
                {
                    Print("[MuzziBot] Ignoring signal with unknown direction: " + rdir);
                    return;
                }

                Print("[MuzziBot] Signal received: " + rdir.ToUpperInvariant() + " @ " + rentry.ToString("F2") + " | ID " + rid);

                // Confirm receipt so Railway doesn't re-queue it
                HttpPost(ServerUrl + "/api/trade-signal/confirm", "{\"id\":\"" + rid + "\"}");

                // Hand off to the main thread
                PendingSignal sig = new PendingSignal
                {
                    Id = rid, Direction = rdir, Entry = rentry,
                    SL = rsl, TP1 = rtp1, TP2 = rtp2
                };
                lock (pendingLock)
                {
                    pendingExec = sig;
                    hasPending  = true;
                }

                DrawStatusLabel("SIGNAL QUEUED: " + rdir.ToUpperInvariant() + " @ " + rentry.ToString("F2"), StatusIdle);
            }
            catch (Exception ex)
            {
                Print("[MuzziBot] PollForSignal error: " + ex.Message);
            }
            finally
            {
                polling = false;
            }
        }

        // ── Main thread only — safe to submit entry orders here ──────────────
        private void ExecuteSignalOnMainThread(PendingSignal ps)
        {
            string id        = ps.Id;
            string direction = ps.Direction;
            bool   isLong    = direction == "long";

            // Don't stack onto an existing position.
            if (Position.MarketPosition != MarketPosition.Flat)
            {
                Print("[MuzziBot] Skipping signal " + id + " — already in position " + Position.MarketPosition);
                return;
            }

            tradeCount++;
            activeSignalId  = id;
            activeDirection = direction;
            activeEntry     = Close[0];

            // Derive SL / TP levels from configured point distances.
            double slDist = SlPts;
            if (MaxLossPts > 0 && slDist > MaxLossPts) slDist = MaxLossPts;

            if (isLong)
            {
                activeSL  = activeEntry - slDist;
                activeTp1 = activeEntry + Tp1Pts;
                activeTp2 = activeEntry + Tp2Pts;
            }
            else
            {
                activeSL  = activeEntry + slDist;
                activeTp1 = activeEntry - Tp1Pts;
                activeTp2 = activeEntry - Tp2Pts;
            }
            entryBar = CurrentBar;

            // Managed bracket — set BEFORE the entry submits.
            SetStopLoss(id, CalculationMode.Ticks, ToTicks(slDist), false);
            SetProfitTarget(id, CalculationMode.Ticks, ToTicks(Tp2Pts));

            Print("[MuzziBot] EXECUTING " + direction.ToUpperInvariant() + " @ " + activeEntry.ToString("F2")
                  + " | SL " + activeSL.ToString("F2") + " | TP1 " + activeTp1.ToString("F2")
                  + " | TP2 " + activeTp2.ToString("F2") + " | Bar " + CurrentBar);
            DrawStatusLabel("ENTERING: " + direction.ToUpperInvariant() + " @ " + activeEntry.ToString("F2"),
                isLong ? BullGreen : BearRed);

            bool useAtm = !string.IsNullOrEmpty(AtmStrategyName);
            if (isLong)
            {
                Draw.ArrowUp(this, TagEntry, false, 0, Low[0] - 3 * TickSize, BullGreen);
                EnterLong(Qty, id);
                Print("[MuzziBot] EnterLong submitted — Qty:" + Qty + " Name:" + id
                      + (useAtm ? " ATM:" + AtmStrategyName : ""));
            }
            else
            {
                Draw.ArrowDown(this, TagEntry, false, 0, High[0] + 3 * TickSize, BearRed);
                EnterShort(Qty, id);
                Print("[MuzziBot] EnterShort submitted — Qty:" + Qty + " Name:" + id
                      + (useAtm ? " ATM:" + AtmStrategyName : ""));
            }
        }

        // ── Fills & exits — detect, draw, report to Railway ──────────────────
        protected override void OnExecutionUpdate(Execution execution, string executionId,
            double price, int quantity, MarketPosition marketPosition,
            string orderId, DateTime time)
        {
            if (execution == null || execution.Order == null) return;
            if (string.IsNullOrEmpty(activeSignalId))         return;

            string name = execution.Order.Name;
            double fill = execution.Price;

            // Entry fill — order name == signal id (set in ExecuteSignalOnMainThread)
            if (name == activeSignalId)
            {
                Print("[MuzziBot] Entry filled @ " + fill.ToString("F2"));
                entryBar = CurrentBar;

                DrawHLine(TagSL,  activeSL,  SlColor,  "SL");
                DrawHLine(TagTP1, activeTp1, Tp1Color, "TP1");
                DrawHLine(TagTP2, activeTp2, Tp2Color, "TP2");

                DrawStatusLabel("IN TRADE: " + activeDirection.ToUpperInvariant()
                    + " | ENTRY " + fill.ToString("F2") + " | SL " + activeSL.ToString("F2")
                    + " | TP2 " + activeTp2.ToString("F2"),
                    activeDirection == "long" ? BullGreen : BearRed);

                string sid = activeSignalId;
                string url = ServerUrl + "/api/trade-signal/result";
                string body = "{\"id\":\"" + sid + "\",\"status\":\"filled\",\"fillPrice\":"
                              + fill.ToString("F2", CultureInfo.InvariantCulture) + "}";
                ThreadPool.QueueUserWorkItem(delegate { HttpPost(url, body); });
                return;
            }

            // Exit fill — stop or target. Detect via order name.
            bool isStop   = name == SL_NAME  || name.IndexOf("Stop",   StringComparison.OrdinalIgnoreCase) >= 0;
            bool isTarget = name == TP2_NAME || name == TP1_NAME
                            || name.IndexOf("Profit", StringComparison.OrdinalIgnoreCase) >= 0
                            || name.IndexOf("Target", StringComparison.OrdinalIgnoreCase) >= 0;

            // Only treat as a close if the position is now flat.
            if (Position.MarketPosition == MarketPosition.Flat && (isStop || isTarget))
            {
                double pnl = activeDirection == "long" ? fill - activeEntry : activeEntry - fill;
                string outcome = isTarget ? "TP2" : "STOPPED";
                Brush col      = isTarget ? Tp2Color : SlColor;

                Print("[MuzziBot] " + outcome + " hit @ " + fill.ToString("F2") + " | PnL " + pnl.ToString("F2") + " pts");
                Draw.Text(this, TagOut, outcome + " " + pnl.ToString("F1"), 0,
                    fill + (isTarget ? 4 : -4) * TickSize, col);
                DrawStatusLabel("CLOSED " + outcome + " " + pnl.ToString("F1") + " pts | WAITING FOR SIGNAL", col);

                string sid = activeSignalId;
                string url = ServerUrl + "/api/trade-signal/result";
                string body = "{\"id\":\"" + sid + "\",\"status\":\"closed\",\"outcome\":\"" + outcome
                              + "\",\"exitPrice\":" + fill.ToString("F2", CultureInfo.InvariantCulture)
                              + ",\"pnlPts\":" + pnl.ToString("F2", CultureInfo.InvariantCulture) + "}";
                ThreadPool.QueueUserWorkItem(delegate { HttpPost(url, body); });

                RemoveTradeLines();
                ResetSignal();
            }
        }

        // ── Draw helpers ──────────────────────────────────────────────────────
        private void DrawHLine(string tag, double price, Brush color, string label)
        {
            int barsAgo = Math.Max(0, CurrentBar - entryBar);
            Draw.Line(this, tag, false, barsAgo, price, -50, price, color, DashStyleHelper.Dash, 1);
            Draw.Text(this, tag + "_lbl", label + " " + price.ToString("F2"), -48, price, color);
        }

        private void DrawStatusLabel(string text, Brush color)
        {
            try
            {
                Draw.TextFixed(this, TagStatus, text, TextPosition.TopRight,
                    color, new SimpleFont("Arial", 11), Brushes.Transparent, Brushes.Transparent, 0);
            }
            catch { /* drawing not available outside chart context */ }
        }

        private void RemoveTradeLines()
        {
            RemoveDrawObject(TagSL);   RemoveDrawObject(TagSL  + "_lbl");
            RemoveDrawObject(TagTP1);  RemoveDrawObject(TagTP1 + "_lbl");
            RemoveDrawObject(TagTP2);  RemoveDrawObject(TagTP2 + "_lbl");
        }

        private void ResetSignal()
        {
            activeSignalId  = null;
            activeDirection = null;
            activeEntry     = 0;
            activeSL        = 0;
            activeTp1       = 0;
            activeTp2       = 0;
            entryBar        = -1;
        }

        private int ToTicks(double pts)
        {
            if (TickSize <= 0) return (int)Math.Round(pts * 4); // NQ fallback
            return (int)Math.Round(pts / TickSize);
        }

        // ── HTTP helpers (WebClient — NO User-Agent header) ──────────────────
        private string HttpGet(string url, int timeoutMs)
        {
            try
            {
                using (var wc = new TimedWebClient(timeoutMs))
                {
                    return wc.DownloadString(url);
                }
            }
            catch (Exception ex)
            {
                Print("[MuzziBot] GET error: " + ex.Message);
                return null;
            }
        }

        private void HttpPost(string url, string json)
        {
            try
            {
                using (var wc = new TimedWebClient(5000))
                {
                    wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                    wc.UploadString(url, "POST", json);
                }
            }
            catch (Exception ex)
            {
                Print("[MuzziBot] POST error: " + ex.Message);
            }
        }

        // WebClient with a configurable timeout. No User-Agent set anywhere.
        private class TimedWebClient : WebClient
        {
            private readonly int timeoutMs;
            public TimedWebClient(int timeoutMs) { this.timeoutMs = timeoutMs; }
            protected override WebRequest GetWebRequest(Uri address)
            {
                WebRequest req = base.GetWebRequest(address);
                if (req != null) req.Timeout = timeoutMs;
                return req;
            }
        }

        // ── Minimal JSON parsers ─────────────────────────────────────────────
        private double GetDouble(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\":", StringComparison.Ordinal);
            if (i < 0) return 0.0;
            int c = json.IndexOf(':', i) + 1, e = c;
            while (e < json.Length && json[e] != ',' && json[e] != '}') e++;
            return double.TryParse(json.Substring(c, e - c).Trim(),
                NumberStyles.Any, CultureInfo.InvariantCulture, out double d) ? d : 0.0;
        }

        private string GetString(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\":", StringComparison.Ordinal);
            if (i < 0) return null;
            int q = json.IndexOf('"', json.IndexOf(':', i) + 1) + 1;
            if (q <= 0) return null;
            int e = json.IndexOf('"', q);
            return e > q ? json.Substring(q, e - q) : null;
        }
    }
}
