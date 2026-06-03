// NQ_MuzziBot.cs — Execution strategy for NQ Analyst (CK Build v3)
// ─────────────────────────────────────────────────────────────────────
// WHAT'S NEW in v3 (TP1 stop-lock):
//   • Single entry, Qty contracts, one bracket (SL + TP2) same as before.
//   • OnBarUpdate watches price vs activeTp1 every tick while in trade.
//     When price TOUCHES OR CROSSES TP1:
//       → SetStopLoss moved to entry price (breakeven / lock-in)
//       → TP1 line redrawn as "LOCKED" in green
//       → _tp1Hit = true so it only fires once
//   • The full position still targets TP2. If price reverses after TP1
//     it stops out at breakeven — a guaranteed at-worst scratch.
//   • Outcome labels: TP2 / STOPPED / STOPPED_AFTER_TP1 / NO_TRIGGER
//   • Session-aware risk params unchanged (London / NY Open / Default)
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
//   • source="tradingview" in all POST payloads (Railway fast-path filter).
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
        public string Session;     // "london" | "ny_open" | "london_close" | "asia" | ""
    }

    public class NQ_MuzziBot : Strategy
    {
        // ── Server Parameters ──────────────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "Server URL", GroupName = "Server", Order = 1)]
        public string ServerUrl { get; set; }

        [NinjaScriptProperty]
        [Range(1, int.MaxValue)]
        [Display(Name = "Poll Interval Sec", GroupName = "Server", Order = 2)]
        public int PollIntervalSec { get; set; }

        [NinjaScriptProperty]
        [Range(0, 120)]
        [Display(Name = "Post-TP2 Cooldown Min", GroupName = "Server", Order = 3,
                 Description = "Minutes to block new entries after a TP2 hit. Default 20.")]
        public int PostTp2CooldownMin { get; set; }

        // ── Execution Parameters ───────────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "ATM Strategy Name", GroupName = "Execution", Order = 1)]
        public string AtmStrategyName { get; set; }

        [NinjaScriptProperty]
        [Range(1, int.MaxValue)]
        [Display(Name = "Contracts", GroupName = "Execution", Order = 2)]
        public int Qty { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Max Loss Pts (hard cap)", GroupName = "Execution", Order = 3)]
        public double MaxLossPts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Enable Trading", GroupName = "Execution", Order = 4)]
        public bool EnableTrading { get; set; }

        // ── Default / Asia Risk ────────────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "Default SL Pts", GroupName = "Default / Asia Risk", Order = 1)]
        public double DefaultSlPts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Default TP1 Pts", GroupName = "Default / Asia Risk", Order = 2)]
        public double DefaultTp1Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Default TP2 Pts", GroupName = "Default / Asia Risk", Order = 3)]
        public double DefaultTp2Pts { get; set; }

        // ── London Killzone Risk ───────────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "London SL Pts", GroupName = "London KZ Risk", Order = 1)]
        public double LondonSlPts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "London TP1 Pts", GroupName = "London KZ Risk", Order = 2)]
        public double LondonTp1Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "London TP2 Pts", GroupName = "London KZ Risk", Order = 3)]
        public double LondonTp2Pts { get; set; }

        // ── NY Open / London Close Risk ────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "NY Open SL Pts", GroupName = "NY Open / London Close Risk", Order = 1)]
        public double NySlPts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "NY Open TP1 Pts", GroupName = "NY Open / London Close Risk", Order = 2)]
        public double NyTp1Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "NY Open TP2 Pts", GroupName = "NY Open / London Close Risk", Order = 3)]
        public double NyTp2Pts { get; set; }

        // ── Threading state ────────────────────────────────────────────────────
        private volatile bool   polling     = false;
        private volatile bool   hasPending  = false;   // true when pendingExec holds a fresh signal
        private PendingSignal    pendingExec;           // guarded by pendingLock + hasPending flag
        private readonly object  pendingLock = new object();
        private DateTime         lastPoll    = DateTime.MinValue;

        // ── Active trade state (main-thread only) ──────────────────────────────
        private string activeSignalId  = null;
        private string activeDirection = null;   // "long" | "short"
        private string activeSession   = "";     // "london" | "ny_open" | "london_close" | "asia"
        private double activeEntry     = 0;
        private double activeSL        = 0;
        private double activeTp1       = 0;
        private double activeTp2       = 0;
        private int    entryBar        = -1;
        private int    tradeCount      = 0;
        private bool     _tp1Hit          = false;   // true once SL has been moved to BE at TP1
        private DateTime _lastTp2Time      = DateTime.MinValue;  // CT time of last TP2 hit

        // ── Order names ────────────────────────────────────────────────────────
        private const string SL_NAME  = "MuzziSL";
        private const string TP1_NAME = "MuzziTP1";
        private const string TP2_NAME = "MuzziTP2";

        // ── Drawing tags / colors ──────────────────────────────────────────────
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

        // ── Lifecycle ──────────────────────────────────────────────────────────
        protected override void OnStateChange()
        {
            // Route ALL Print() calls to Output Tab 2.
            // ROOT CAUSE of the "silent OnBarUpdate": PrintTo defaults to
            // PrintTo.OutputTab1, so every MuzziBot print landed in Output 1
            // (mixed with the ICT indicator) while we watched a blank Output 2.
            // Set this as early as possible so even SetDefaults prints land in Output 2.
            PrintTo = PrintTo.OutputTab2;

            if (State == State.SetDefaults)
            {
                Print("[MuzziBot] OnStateChange → SetDefaults");
                Name                          = "NQ MuzziBot";
                Description                   = "CK Build v2 — Session-aware execution bot for NQ Analyst Railway API.";
                Calculate                     = Calculate.OnPriceChange;
                EntriesPerDirection           = 1;
                EntryHandling                 = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy  = true;
                ExitOnSessionCloseSeconds     = 30;
                IsFillLimitOnTouch            = false;
                IsInstantiatedOnEachOptimizationIteration = false;
                StartBehavior                 = StartBehavior.ImmediatelySubmit;
                BarsRequiredToTrade           = 0;

                // Server
                ServerUrl           = "https://nq-analyst-production.up.railway.app";
                PollIntervalSec     = 5;   // DO NOT CHANGE — user locked at 5 min
                PostTp2CooldownMin  = 20;  // Block new signals 20 min after TP2

                // Execution
                AtmStrategyName = "";
                Qty             = 1;
                MaxLossPts      = 25;
                EnableTrading   = true;

                // Default / Asia risk
                DefaultSlPts  = 15;
                DefaultTp1Pts = 20;
                DefaultTp2Pts = 40;

                // London KZ risk (tighter — lower volatility 2-5am ET)
                LondonSlPts  = 12;
                LondonTp1Pts = 18;
                LondonTp2Pts = 35;

                // NY Open / London Close risk (standard)
                NySlPts  = 15;
                NyTp1Pts = 20;
                NyTp2Pts = 40;
            }
            else if (State == State.Configure)
            {
                Print("[MuzziBot] OnStateChange → Configure");
            }
            else if (State == State.DataLoaded)
            {
                Print("[MuzziBot] OnStateChange → DataLoaded");
                DrawStatusLabel("MUZZIBOT ONLINE | WAITING FOR SIGNAL", StatusIdle);
                Print("[MuzziBot] DataLoaded — server " + ServerUrl
                      + " | poll " + PollIntervalSec + "s | qty " + Qty);
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
                    string url  = ServerUrl + "/api/trade-signal/result";
                    string body = "{\"id\":\"" + sid + "\",\"status\":\"cancelled\",\"reason\":\"strategy terminated\"}";
                    ThreadPool.QueueUserWorkItem(delegate { HttpPost(url, body); });
                }
                Print("[MuzziBot] Terminated.");
            }
        }

        // ── Main thread — fires on every tick (Calculate.OnPriceChange) ─────────
        protected override void OnBarUpdate()
        {
            // Absolute first line — proves OnBarUpdate fires.
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

            // STEP 2 — TP1 stop-lock check (every tick while in trade)
            if (activeSignalId != null && !_tp1Hit && activeTp1 != 0
                && Position.MarketPosition != MarketPosition.Flat)
            {
                bool tp1Reached = activeDirection == "long"
                    ? High[0] >= activeTp1
                    : Low[0]  <= activeTp1;

                if (tp1Reached)
                {
                    _tp1Hit = true;

                    // Move SL to entry price — locks in at worst a scratch
                    SetStopLoss(activeSignalId, CalculationMode.Price, activeEntry, false);

                    // Redraw TP1 line as locked (bright green) and update status
                    RemoveDrawObject(TagTP1);
                    RemoveDrawObject(TagTP1 + "_lbl");
                    DrawHLine(TagTP1, activeTp1, BullGreen, "TP1 LOCKED ✓");

                    string sessLabel = activeSession == ""
                        ? "DEFAULT"
                        : activeSession.ToUpperInvariant().Replace("_", " ");

                    DrawStatusLabel("TP1 LOCKED — RUNNING TO TP2 "
                        + activeTp2.ToString("F2")
                        + " [" + sessLabel + "]",
                        BullGreen);

                    Print("[MuzziBot] TP1 reached @ " + High[0].ToString("F2")
                          + " — SL moved to BE " + activeEntry.ToString("F2")
                          + " | Running to TP2 " + activeTp2.ToString("F2"));

                    // Notify Railway that TP1 level was touched
                    string sid  = activeSignalId;
                    string url  = ServerUrl + "/api/trade-signal/result";
                    string body = "{\"id\":\"" + sid + "\",\"status\":\"tp1_locked\""
                                  + ",\"tp1Price\":"  + activeTp1.ToString("F2", CultureInfo.InvariantCulture)
                                  + ",\"bePrice\":"   + activeEntry.ToString("F2", CultureInfo.InvariantCulture)
                                  + ",\"session\":\"" + activeSession + "\""
                                  + ",\"source\":\"tradingview\"}";
                    ThreadPool.QueueUserWorkItem(delegate { HttpPost(url, body); });
                }
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

        // ── Background thread — polls Railway, parks result. No order calls. ───
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

                // ── Post-TP2 cooldown check ────────────────────────────────────
                // After a TP2 hit the move is exhausted — block re-entry for N min.
                if (_lastTp2Time != DateTime.MinValue && PostTp2CooldownMin > 0)
                {
                    double minsSinceTp2 = (DateTime.Now - _lastTp2Time).TotalMinutes;
                    if (minsSinceTp2 < PostTp2CooldownMin)
                    {
                        int minsLeft = (int)Math.Ceiling(PostTp2CooldownMin - minsSinceTp2);
                        DrawStatusLabel("TP2 COOLDOWN — " + minsLeft + " MIN REMAINING", Tp2Color);
                        return;   // Don't poll — skip this cycle entirely
                    }
                }

                DrawStatusLabel("POLLING... " + DateTime.Now.ToString("HH:mm:ss"), StatusIdle);

                string json = HttpGet(ServerUrl + "/api/trade-signal/pending", 5000);
                if (string.IsNullOrEmpty(json) || json == "{}" || json.Contains("\"id\":null"))
                {
                    DrawStatusLabel("MUZZIBOT ONLINE | NO SIGNAL " + DateTime.Now.ToString("HH:mm:ss"), StatusIdle);
                    return;
                }

                string rid     = GetString(json, "id");
                string rdir    = GetString(json, "direction");
                double rentry  = GetDouble(json, "entry");
                double rsl     = GetDouble(json, "sl");
                double rtp1    = GetDouble(json, "tp1");
                double rtp2    = GetDouble(json, "tp2");
                string rsess   = GetString(json, "session") ?? "";   // NEW — session field

                if (string.IsNullOrEmpty(rid) || string.IsNullOrEmpty(rdir)) return;

                rdir  = rdir.ToLowerInvariant();
                rsess = rsess.ToLowerInvariant();

                if (rdir != "long" && rdir != "short")
                {
                    Print("[MuzziBot] Ignoring signal with unknown direction: " + rdir);
                    return;
                }

                Print("[MuzziBot] Signal received: " + rdir.ToUpperInvariant()
                      + " @ " + rentry.ToString("F2")
                      + " | SESSION: " + (rsess == "" ? "default" : rsess)
                      + " | ID " + rid);

                // Confirm receipt so Railway doesn't re-queue it
                HttpPost(ServerUrl + "/api/trade-signal/confirm", "{\"id\":\"" + rid + "\"}");

                // Hand off to the main thread
                PendingSignal sig = new PendingSignal
                {
                    Id        = rid,
                    Direction = rdir,
                    Entry     = rentry,
                    SL        = rsl,
                    TP1       = rtp1,
                    TP2       = rtp2,
                    Session   = rsess      // NEW
                };
                lock (pendingLock)
                {
                    pendingExec = sig;
                    hasPending  = true;
                }

                string sessLabel = rsess == "" ? "DEFAULT" : rsess.ToUpperInvariant().Replace("_", " ");
                DrawStatusLabel("SIGNAL QUEUED: " + rdir.ToUpperInvariant()
                    + " @ " + rentry.ToString("F2")
                    + " [" + sessLabel + "]", StatusIdle);
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

        // ── Session-aware risk parameter selection ─────────────────────────────
        // Returns (slPts, tp1Pts, tp2Pts) for the given session string.
        // Falls back to Default if session is unrecognized.
        private void GetSessionRisk(string session,
            out double slPts, out double tp1Pts, out double tp2Pts)
        {
            switch (session)
            {
                case "london":
                    slPts  = LondonSlPts;
                    tp1Pts = LondonTp1Pts;
                    tp2Pts = LondonTp2Pts;
                    break;

                case "ny_open":
                case "london_close":
                    slPts  = NySlPts;
                    tp1Pts = NyTp1Pts;
                    tp2Pts = NyTp2Pts;
                    break;

                default:   // "asia", "", or any unknown value
                    slPts  = DefaultSlPts;
                    tp1Pts = DefaultTp1Pts;
                    tp2Pts = DefaultTp2Pts;
                    break;
            }

            // Hard cap — never exceed MaxLossPts regardless of session
            if (MaxLossPts > 0 && slPts > MaxLossPts)
                slPts = MaxLossPts;
        }

        // ── Main thread only — safe to submit entry orders here ─────────────────
        private void ExecuteSignalOnMainThread(PendingSignal ps)
        {
            string id        = ps.Id;
            string direction = ps.Direction;
            string session   = ps.Session ?? "";
            bool   isLong    = direction == "long";

            // Don't stack onto an existing position.
            if (Position.MarketPosition != MarketPosition.Flat)
            {
                Print("[MuzziBot] Skipping signal " + id + " — already in position " + Position.MarketPosition);
                return;
            }

            // ── Session-aware risk ─────────────────────────────────────────────
            double slPts, tp1Pts, tp2Pts;
            GetSessionRisk(session, out slPts, out tp1Pts, out tp2Pts);

            string sessLabel = session == "" ? "DEFAULT" : session.ToUpperInvariant().Replace("_", " ");
            Print("[MuzziBot] Session=" + sessLabel
                  + " | SL=" + slPts + " TP1=" + tp1Pts + " TP2=" + tp2Pts);

            tradeCount++;
            activeSignalId  = id;
            activeDirection = direction;
            activeSession   = session;
            activeEntry     = Close[0];

            if (isLong)
            {
                activeSL  = activeEntry - slPts;
                activeTp1 = activeEntry + tp1Pts;
                activeTp2 = activeEntry + tp2Pts;
            }
            else
            {
                activeSL  = activeEntry + slPts;
                activeTp1 = activeEntry - tp1Pts;
                activeTp2 = activeEntry - tp2Pts;
            }
            entryBar = CurrentBar;

            // Managed bracket — set BEFORE the entry submits.
            SetStopLoss(id, CalculationMode.Ticks, ToTicks(slPts), false);
            SetProfitTarget(id, CalculationMode.Ticks, ToTicks(tp2Pts));

            Print("[MuzziBot] EXECUTING " + direction.ToUpperInvariant()
                  + " @ " + activeEntry.ToString("F2")
                  + " | SL " + activeSL.ToString("F2")
                  + " | TP1 " + activeTp1.ToString("F2")
                  + " | TP2 " + activeTp2.ToString("F2")
                  + " | SESSION " + sessLabel
                  + " | Bar " + CurrentBar);

            DrawStatusLabel("ENTERING: " + direction.ToUpperInvariant()
                + " @ " + activeEntry.ToString("F2")
                + " [" + sessLabel + "]",
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

        // ── Fills & exits — detect, draw, report to Railway ─────────────────────
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

                string sessLabel = activeSession == ""
                    ? "DEFAULT"
                    : activeSession.ToUpperInvariant().Replace("_", " ");

                DrawStatusLabel("IN TRADE: " + activeDirection.ToUpperInvariant()
                    + " | ENTRY " + fill.ToString("F2")
                    + " | SL " + activeSL.ToString("F2")
                    + " | TP2 " + activeTp2.ToString("F2")
                    + " [" + sessLabel + "]",
                    activeDirection == "long" ? BullGreen : BearRed);

                string sid  = activeSignalId;
                string url  = ServerUrl + "/api/trade-signal/result";
                string body = "{\"id\":\"" + sid + "\",\"status\":\"filled\",\"fillPrice\":"
                              + fill.ToString("F2", CultureInfo.InvariantCulture)
                              + ",\"session\":\"" + activeSession + "\""
                              + ",\"source\":\"tradingview\"}";
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

                // Determine outcome label — distinguish stop-after-TP1 from clean stop
                string outcome;
                Brush  col;
                if (isTarget)
                {
                    outcome      = "TP2";
                    col          = Tp2Color;
                    _lastTp2Time = DateTime.Now;   // Start post-TP2 cooldown timer
                    Print("[MuzziBot] TP2 hit — cooldown started for " + PostTp2CooldownMin + " min");
                }
                else if (_tp1Hit)
                {
                    // Stopped at breakeven after TP1 was locked — guaranteed scratch
                    outcome = "STOPPED_AFTER_TP1";
                    col     = Tp1Color;   // yellow — not a loss
                }
                else
                {
                    outcome = "STOPPED";
                    col     = SlColor;
                }

                Print("[MuzziBot] " + outcome + " hit @ " + fill.ToString("F2")
                      + " | PnL " + pnl.ToString("F2") + " pts | SESSION " + activeSession);

                Draw.Text(this, TagOut, outcome + " " + pnl.ToString("F1"), 0,
                    fill + (isTarget ? 4 : -4) * TickSize, col);
                DrawStatusLabel("CLOSED " + outcome + " " + pnl.ToString("F1")
                    + " pts | WAITING FOR SIGNAL", col);

                string sid  = activeSignalId;
                string url  = ServerUrl + "/api/trade-signal/result";
                string body = "{\"id\":\"" + sid + "\",\"status\":\"closed\",\"outcome\":\"" + outcome
                              + "\",\"exitPrice\":" + fill.ToString("F2", CultureInfo.InvariantCulture)
                              + ",\"pnlPts\":"      + pnl.ToString("F2", CultureInfo.InvariantCulture)
                              + ",\"session\":\""   + activeSession + "\""
                              + ",\"source\":\"tradingview\"}";
                ThreadPool.QueueUserWorkItem(delegate { HttpPost(url, body); });

                RemoveTradeLines();
                ResetSignal();
            }
        }

        // ── Draw helpers ───────────────────────────────────────────────────────
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
            _tp1Hit         = false;
            activeSession   = "";
            activeEntry     = 0;
            activeSL        = 0;
            activeTp1       = 0;
            activeTp2       = 0;
            entryBar        = -1;
        }

        private int ToTicks(double pts)
        {
            if (TickSize <= 0) return (int)Math.Round(pts * 4); // NQ fallback: 0.25 tick
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

        // ── Minimal JSON parsers ──────────────────────────────────────────────
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
