// NQ_MuzziBot.cs — Execution strategy for NQ Analyst (CK Build v4 — MNQ Split Exit)
// ─────────────────────────────────────────────────────────────────────────────────
// EXIT LOGIC (v4):
//   Entry:     4 contracts, two named signals — E_HALF (2 contracts) + E_RUN (2 contracts)
//   TP1 hit:   E_HALF profit target fires → 2 contracts exit at TP1 automatically
//              via SetProfitTarget(E_HALF, tp1Ticks)
//   TP1 + 8:   OnBarUpdate detects price >= activeTp1 + 8 (long) / <= activeTp1 - 8 (short)
//              → SetStopLoss(E_RUN, CalculationMode.Price, activeTp1) — locks runners at TP1
//              → _trailActive = true, _trailHigh/_trailLow initialized to current price
//   Trail:     Once _trailActive, OnBarUpdate updates trail every tick:
//              long:  if High[0] > _trailHigh → _trailHigh = High[0]
//                     SetStopLoss(E_RUN, Price, _trailHigh - TrailPts)
//              short: if Low[0]  < _trailLow  → _trailLow  = Low[0]
//                     SetStopLoss(E_RUN, Price, _trailLow  + TrailPts)
//   TP2 hit:   E_RUN profit target fires → 2 runners exit, _lastTp2Time set → cooldown starts
//   Cooldown:  PostTp2CooldownMin (default 20) — PollForSignal() skips if in cooldown
//
// THREAD SAFETY:
//   • Background ThreadPool polls Railway, parks result in pendingExec + hasPending flag
//   • OnBarUpdate (main thread) is ONLY place EnterLong/EnterShort/SetStopLoss are called
//   • OnExecutionUpdate fires on NT8 internal thread — only sets volatile flags, never orders
//
// SOURCE: "tradingview" in all POST payloads (Railway fast-path filter — DO NOT CHANGE)
// ─────────────────────────────────────────────────────────────────────────────────

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
    public struct PendingSignal
    {
        public string Id;
        public string Direction;
        public double Entry;
        public double SL;
        public double TP1;
        public double TP2;
        public string Session;
    }

    public class NQ_MuzziBot : Strategy
    {
        // ── Server ─────────────────────────────────────────────────────────────
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
                 Description = "Minutes to block new entries after TP2 closes all contracts.")]
        public int PostTp2CooldownMin { get; set; }

        // ── Execution ──────────────────────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "ATM Strategy Name", GroupName = "Execution", Order = 1)]
        public string AtmStrategyName { get; set; }

        [NinjaScriptProperty]
        [Range(1, int.MaxValue)]
        [Display(Name = "Contracts Per Half (2 halves)", GroupName = "Execution", Order = 2,
                 Description = "Contracts per split. Total position = this x2. Default 2 = 4 MNQ total.")]
        public int HalfQty { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Enable Trading", GroupName = "Execution", Order = 3)]
        public bool EnableTrading { get; set; }

        // ── Trail ──────────────────────────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "Trail Trigger Pts past TP1", GroupName = "Trail", Order = 1,
                 Description = "How many pts past TP1 before SL locks to TP1 and trail starts. Default 8.")]
        public double TrailTriggerPts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Trail Distance Pts", GroupName = "Trail", Order = 2,
                 Description = "Trailing stop distance once trail is active. Default 8.5.")]
        public double TrailPts { get; set; }

        // ── Default / Asia Risk ────────────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "Default SL Pts",  GroupName = "Default / Asia Risk", Order = 1)]
        public double DefaultSlPts  { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Default TP1 Pts", GroupName = "Default / Asia Risk", Order = 2)]
        public double DefaultTp1Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Default TP2 Pts", GroupName = "Default / Asia Risk", Order = 3)]
        public double DefaultTp2Pts { get; set; }

        // ── London KZ Risk ─────────────────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "London SL Pts",  GroupName = "London KZ Risk", Order = 1)]
        public double LondonSlPts  { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "London TP1 Pts", GroupName = "London KZ Risk", Order = 2)]
        public double LondonTp1Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "London TP2 Pts", GroupName = "London KZ Risk", Order = 3)]
        public double LondonTp2Pts { get; set; }

        // ── NY Open / London Close Risk ────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "NY Open SL Pts",  GroupName = "NY Open / London Close Risk", Order = 1)]
        public double NySlPts  { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "NY Open TP1 Pts", GroupName = "NY Open / London Close Risk", Order = 2)]
        public double NyTp1Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "NY Open TP2 Pts", GroupName = "NY Open / London Close Risk", Order = 3)]
        public double NyTp2Pts { get; set; }

        // ── Threading ──────────────────────────────────────────────────────────
        private volatile bool    polling     = false;
        private volatile bool    hasPending  = false;
        private PendingSignal    pendingExec;
        private readonly object  pendingLock = new object();
        private DateTime         lastPoll    = DateTime.MinValue;

        // ── Trade state (main thread only) ─────────────────────────────────────
        private string   activeSignalId  = null;
        private string   activeDirection = null;
        private string   activeSession   = "";
        private double   activeEntry     = 0;
        private double   activeSL        = 0;
        private double   activeTp1       = 0;
        private double   activeTp2       = 0;
        private int      entryBar        = -1;
        private int      tradeCount      = 0;

        // ── Split-exit state ───────────────────────────────────────────────────
        private bool   _halfExited    = false;   // true once 2 contracts exited at TP1
        private bool   _slLockedToTp1 = false;  // true once SL moved to TP1 price
        private bool   _trailActive   = false;   // true once 8.5pt trail is running
        private double _trailHigh     = 0;       // highest price seen since trail started (long)
        private double _trailLow      = double.MaxValue; // lowest price (short)
        private double _currentTrailSL = 0;      // last SL price set by trail

        // ── TP2 cooldown ───────────────────────────────────────────────────────
        private DateTime _lastTp2Time = DateTime.MinValue;

        // ── Entry signal name constants ────────────────────────────────────────
        // Two named entries per trade so SetProfitTarget applies to each independently.
        private string SigHalf => activeSignalId + "_h";   // 2 contracts → exits at TP1
        private string SigRun  => activeSignalId + "_r";   // 2 contracts → rides to TP2

        // ── Draw tags ──────────────────────────────────────────────────────────
        private string TagEntry => "MZ_E_"  + tradeCount;
        private string TagSL    => "MZ_SL_" + tradeCount;
        private string TagTP1   => "MZ_T1_" + tradeCount;
        private string TagTP2   => "MZ_T2_" + tradeCount;
        private string TagOut   => "MZ_O_"  + tradeCount;
        private const string TagStatus = "MZ_Status";

        private static readonly Brush BullGreen  = Brushes.Lime;
        private static readonly Brush BearRed    = Brushes.Red;
        private static readonly Brush SlColor    = Brushes.OrangeRed;
        private static readonly Brush Tp1Color   = Brushes.Yellow;
        private static readonly Brush Tp2Color   = Brushes.Cyan;
        private static readonly Brush TrailColor = Brushes.DodgerBlue;
        private static readonly Brush StatusIdle = Brushes.Gray;

        // ── Lifecycle ──────────────────────────────────────────────────────────
        protected override void OnStateChange()
        {
            PrintTo = PrintTo.OutputTab2;

            if (State == State.SetDefaults)
            {
                Name                         = "NQ MuzziBot";
                Description                  = "CK Build v4 — MNQ 4-contract split exit with 8.5pt trail.";
                Calculate                    = Calculate.OnPriceChange;
                EntriesPerDirection          = 2;   // TWO named entries per direction
                EntryHandling                = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy = true;
                ExitOnSessionCloseSeconds    = 30;
                IsFillLimitOnTouch           = false;
                IsInstantiatedOnEachOptimizationIteration = false;
                StartBehavior                = StartBehavior.ImmediatelySubmit;
                BarsRequiredToTrade          = 0;

                ServerUrl          = "https://nq-analyst-production.up.railway.app";
                PollIntervalSec    = 5;
                PostTp2CooldownMin = 20;

                AtmStrategyName = "";
                HalfQty         = 2;     // 2+2 = 4 MNQ total
                EnableTrading   = true;

                TrailTriggerPts = 8.0;   // pts past TP1 → lock SL + start trail
                TrailPts        = 8.5;   // trailing distance

                // Default / Asia
                DefaultSlPts  = 15;
                DefaultTp1Pts = 20;
                DefaultTp2Pts = 40;

                // London KZ
                LondonSlPts  = 12;
                LondonTp1Pts = 18;
                LondonTp2Pts = 35;

                // NY Open / London Close
                NySlPts  = 15;
                NyTp1Pts = 20;
                NyTp2Pts = 40;
            }
            else if (State == State.DataLoaded)
            {
                DrawStatusLabel("MUZZIBOT v4 ONLINE | " + (HalfQty*2) + " MNQ | WAITING", StatusIdle);
                Print("[MuzziBot v4] DataLoaded | " + (HalfQty*2) + " MNQ | server " + ServerUrl);
            }
            else if (State == State.Terminated)
            {
                string sid = activeSignalId;
                if (!string.IsNullOrEmpty(sid))
                    ThreadPool.QueueUserWorkItem(delegate {
                        HttpPost(ServerUrl + "/api/trade-signal/result",
                            "{\"id\":\"" + sid + "\",\"status\":\"cancelled\",\"source\":\"tradingview\"}");
                    });
            }
        }

        // ── Main thread — every tick ────────────────────────────────────────────
        protected override void OnBarUpdate()
        {
            Print("[MuzziBot] TICK " + CurrentBar);

            if (BarsInProgress != 0) return;
            if (CurrentBar < 0)      return;

            // ── STEP 1: Execute pending signal ──────────────────────────────────
            if (hasPending && activeSignalId == null)
            {
                PendingSignal ps;
                lock (pendingLock) { ps = pendingExec; hasPending = false; }
                ExecuteSignalOnMainThread(ps);
                return;
            }

            // ── STEP 2: Split-exit management (only while in trade) ─────────────
            if (activeSignalId != null && Position.MarketPosition != MarketPosition.Flat)
            {
                bool isLong = activeDirection == "long";

                // Phase A — TP1 partial exit (managed by SetProfitTarget on SigHalf)
                // NT8 handles this automatically — we just track the flag via OnExecutionUpdate

                // Phase B — Trail trigger: price moved TrailTriggerPts past TP1
                if (_halfExited && !_slLockedToTp1)
                {
                    bool triggerHit = isLong
                        ? High[0] >= activeTp1 + TrailTriggerPts
                        : Low[0]  <= activeTp1 - TrailTriggerPts;

                    if (triggerHit)
                    {
                        _slLockedToTp1 = true;

                        // Lock SL to TP1 price on runners — guaranteed winner
                        SetStopLoss(SigRun, CalculationMode.Price, activeTp1, false);

                        // Initialize trail from current price
                        _trailActive = true;
                        _trailHigh   = High[0];
                        _trailLow    = Low[0];
                        _currentTrailSL = isLong
                            ? activeTp1  // starts at TP1, trail will move it up
                            : activeTp1;

                        // Redraw SL line at TP1
                        RemoveDrawObject(TagSL);
                        RemoveDrawObject(TagSL + "_lbl");
                        DrawHLine(TagSL, activeTp1, TrailColor, "SL → TP1 LOCKED");

                        string sl = activeSession == "" ? "DEFAULT"
                            : activeSession.ToUpperInvariant().Replace("_", " ");
                        DrawStatusLabel("TRAIL ACTIVE — SL LOCKED @ TP1 " + activeTp1.ToString("F2")
                            + " [" + sl + "]", TrailColor);
                        Print("[MuzziBot] Trail trigger hit — SL locked to TP1 " + activeTp1.ToString("F2")
                            + " | trail distance " + TrailPts + " pts");

                        PostStatus("trail_started", "sl_at_tp1:" + activeTp1.ToString("F2"));
                    }
                }

                // Phase C — Active 8.5pt trailing stop on runners
                if (_trailActive)
                {
                    bool moved = false;
                    double newSL;

                    if (isLong)
                    {
                        if (High[0] > _trailHigh)
                        {
                            _trailHigh = High[0];
                            newSL = _trailHigh - TrailPts;
                            // Only ratchet UP — never lower the stop
                            if (newSL > _currentTrailSL)
                            {
                                _currentTrailSL = newSL;
                                SetStopLoss(SigRun, CalculationMode.Price, newSL, false);
                                moved = true;
                            }
                        }
                    }
                    else
                    {
                        if (Low[0] < _trailLow)
                        {
                            _trailLow = Low[0];
                            newSL = _trailLow + TrailPts;
                            // Only ratchet DOWN — never raise the stop
                            if (newSL < _currentTrailSL)
                            {
                                _currentTrailSL = newSL;
                                SetStopLoss(SigRun, CalculationMode.Price, newSL, false);
                                moved = true;
                            }
                        }
                    }

                    if (moved)
                    {
                        RemoveDrawObject(TagSL);
                        RemoveDrawObject(TagSL + "_lbl");
                        DrawHLine(TagSL, _currentTrailSL, TrailColor,
                            "TRAIL " + _currentTrailSL.ToString("F2"));
                    }
                }
            }

            // ── STEP 3: Safety reset — stuck signal with flat position ───────────
            if (activeSignalId != null && Position.MarketPosition == MarketPosition.Flat)
            {
                if (entryBar >= 0 && (CurrentBar - entryBar) >= 60)
                {
                    Print("[MuzziBot] Safety reset — flat 60+ bars, clearing.");
                    DrawStatusLabel("RESET — WAITING FOR SIGNAL", StatusIdle);
                    ResetSignal();
                }
            }

            // ── STEP 4: Poll Railway for new signal ─────────────────────────────
            if (activeSignalId == null && !hasPending && !polling
                && (DateTime.Now - lastPoll).TotalSeconds >= PollIntervalSec)
            {
                lastPoll = DateTime.Now;
                ThreadPool.QueueUserWorkItem(delegate { PollForSignal(); });
            }
        }

        // ── Background poll ─────────────────────────────────────────────────────
        private void PollForSignal()
        {
            if (polling) return;
            polling = true;
            try
            {
                if (!EnableTrading)
                {
                    DrawStatusLabel("MUZZIBOT PAUSED | TRADING OFF", SlColor);
                    return;
                }

                // Post-TP2 cooldown check
                if (_lastTp2Time != DateTime.MinValue && PostTp2CooldownMin > 0)
                {
                    double mins = (DateTime.Now - _lastTp2Time).TotalMinutes;
                    if (mins < PostTp2CooldownMin)
                    {
                        int left = (int)Math.Ceiling(PostTp2CooldownMin - mins);
                        DrawStatusLabel("TP2 COOLDOWN — " + left + " MIN REMAINING", Tp2Color);
                        return;
                    }
                }

                DrawStatusLabel("POLLING... " + DateTime.Now.ToString("HH:mm:ss"), StatusIdle);

                string json = HttpGet(ServerUrl + "/api/trade-signal/pending", 5000);
                if (string.IsNullOrEmpty(json) || json == "{}" || json.Contains("\"id\":null"))
                {
                    DrawStatusLabel("ONLINE | NO SIGNAL " + DateTime.Now.ToString("HH:mm:ss"), StatusIdle);
                    return;
                }

                string rid   = GetString(json, "id");
                string rdir  = GetString(json, "direction");
                double rentry= GetDouble(json, "entry");
                double rsl   = GetDouble(json, "sl");
                double rtp1  = GetDouble(json, "tp1");
                double rtp2  = GetDouble(json, "tp2");
                string rsess = (GetString(json, "session") ?? "").ToLowerInvariant();
                rdir         = (rdir ?? "").ToLowerInvariant();

                if (string.IsNullOrEmpty(rid) || (rdir != "long" && rdir != "short")) return;

                HttpPost(ServerUrl + "/api/trade-signal/confirm",
                    "{\"id\":\"" + rid + "\"}");

                PendingSignal sig = new PendingSignal
                {
                    Id = rid, Direction = rdir, Entry = rentry,
                    SL = rsl, TP1 = rtp1, TP2 = rtp2, Session = rsess
                };
                lock (pendingLock) { pendingExec = sig; hasPending = true; }

                string sl = rsess == "" ? "DEFAULT" : rsess.ToUpperInvariant().Replace("_"," ");
                DrawStatusLabel("SIGNAL QUEUED: " + rdir.ToUpperInvariant()
                    + " @ " + rentry.ToString("F2") + " [" + sl + "]", StatusIdle);

                Print("[MuzziBot] Signal queued: " + rdir.ToUpperInvariant()
                    + " @ " + rentry.ToString("F2") + " sess=" + rsess + " id=" + rid);
            }
            catch (Exception ex) { Print("[MuzziBot] Poll error: " + ex.Message); }
            finally { polling = false; }
        }

        // ── Session risk selector ───────────────────────────────────────────────
        private void GetSessionRisk(string session,
            out double slPts, out double tp1Pts, out double tp2Pts)
        {
            switch (session)
            {
                case "london":
                    slPts = LondonSlPts; tp1Pts = LondonTp1Pts; tp2Pts = LondonTp2Pts; break;
                case "ny_open":
                case "london_close":
                    slPts = NySlPts; tp1Pts = NyTp1Pts; tp2Pts = NyTp2Pts; break;
                default:
                    slPts = DefaultSlPts; tp1Pts = DefaultTp1Pts; tp2Pts = DefaultTp2Pts; break;
            }
        }

        // ── Entry — main thread only ────────────────────────────────────────────
        private void ExecuteSignalOnMainThread(PendingSignal ps)
        {
            if (Position.MarketPosition != MarketPosition.Flat)
            {
                Print("[MuzziBot] Skipping — already in position " + Position.MarketPosition);
                return;
            }

            string id      = ps.Id;
            string dir     = ps.Direction;
            string sess    = ps.Session ?? "";
            bool   isLong  = dir == "long";

            double slPts, tp1Pts, tp2Pts;
            GetSessionRisk(sess, out slPts, out tp1Pts, out tp2Pts);

            tradeCount++;
            activeSignalId  = id;
            activeDirection = dir;
            activeSession   = sess;
            activeEntry     = Close[0];

            activeSL  = isLong ? activeEntry - slPts  : activeEntry + slPts;
            activeTp1 = isLong ? activeEntry + tp1Pts : activeEntry - tp1Pts;
            activeTp2 = isLong ? activeEntry + tp2Pts : activeEntry - tp2Pts;
            entryBar  = CurrentBar;

            // Reset split state
            _halfExited     = false;
            _slLockedToTp1  = false;
            _trailActive    = false;
            _trailHigh      = 0;
            _trailLow       = double.MaxValue;
            _currentTrailSL = 0;

            string sl = sess == "" ? "DEFAULT" : sess.ToUpperInvariant().Replace("_"," ");
            Print("[MuzziBot] EXECUTING " + dir.ToUpperInvariant()
                + " x" + (HalfQty*2) + " MNQ @ " + activeEntry.ToString("F2")
                + " | SL " + activeSL.ToString("F2")
                + " | TP1 " + activeTp1.ToString("F2")
                + " | TP2 " + activeTp2.ToString("F2")
                + " | trail >" + TrailTriggerPts + "pts past TP1 @ " + TrailPts + "pt trail"
                + " | " + sl);

            // ── SetStopLoss for BOTH halves (same initial stop price) ─────────
            SetStopLoss(SigHalf, CalculationMode.Ticks, ToTicks(slPts), false);
            SetStopLoss(SigRun,  CalculationMode.Ticks, ToTicks(slPts), false);

            // ── TP targets ────────────────────────────────────────────────────
            // SigHalf exits at TP1, SigRun exits at TP2 (or trail stop, whichever first)
            SetProfitTarget(SigHalf, CalculationMode.Ticks, ToTicks(tp1Pts));
            SetProfitTarget(SigRun,  CalculationMode.Ticks, ToTicks(tp2Pts));

            // ── Draw levels ───────────────────────────────────────────────────
            DrawHLine(TagSL,  activeSL,  SlColor,  "SL");
            DrawHLine(TagTP1, activeTp1, Tp1Color, "TP1 (½ exit)");
            DrawHLine(TagTP2, activeTp2, Tp2Color, "TP2 (runner)");

            DrawStatusLabel("ENTERING " + dir.ToUpperInvariant()
                + " x" + (HalfQty*2) + " @ " + activeEntry.ToString("F2")
                + " [" + sl + "]",
                isLong ? BullGreen : BearRed);

            // ── Submit BOTH entries ───────────────────────────────────────────
            if (isLong)
            {
                Draw.ArrowUp(this, TagEntry, false, 0, Low[0] - 3*TickSize, BullGreen);
                EnterLong(HalfQty, SigHalf);
                EnterLong(HalfQty, SigRun);
            }
            else
            {
                Draw.ArrowDown(this, TagEntry, false, 0, High[0] + 3*TickSize, BearRed);
                EnterShort(HalfQty, SigHalf);
                EnterShort(HalfQty, SigRun);
            }

            Print("[MuzziBot] Both entries submitted — " + SigHalf + " + " + SigRun);

            // Notify Railway — entry submitted
            string url  = ServerUrl + "/api/trade-signal/result";
            string body = "{\"id\":\"" + id + "\",\"status\":\"entered\""
                + ",\"entry\":"   + activeEntry.ToString("F2", CultureInfo.InvariantCulture)
                + ",\"halfQty\":" + HalfQty
                + ",\"tp1\":"     + activeTp1.ToString("F2", CultureInfo.InvariantCulture)
                + ",\"tp2\":"     + activeTp2.ToString("F2", CultureInfo.InvariantCulture)
                + ",\"session\":\"" + sess + "\""
                + ",\"source\":\"tradingview\"}";
            ThreadPool.QueueUserWorkItem(delegate { HttpPost(url, body); });
        }

        // ── Fills ───────────────────────────────────────────────────────────────
        protected override void OnExecutionUpdate(Execution execution, string executionId,
            double price, int quantity, MarketPosition marketPosition,
            string orderId, DateTime time)
        {
            if (execution == null || execution.Order == null) return;
            if (string.IsNullOrEmpty(activeSignalId))         return;

            string name = execution.Order.Name ?? "";
            double fill = execution.Price;

            // ── Entry fills ───────────────────────────────────────────────────
            if (name == SigHalf || name == SigRun)
            {
                Print("[MuzziBot] Entry fill: " + name + " @ " + fill.ToString("F2")
                    + " qty=" + quantity);
                entryBar = CurrentBar;

                string sl = activeSession == "" ? "DEFAULT"
                    : activeSession.ToUpperInvariant().Replace("_"," ");
                DrawStatusLabel("IN TRADE x" + (HalfQty*2) + " | "
                    + activeDirection.ToUpperInvariant()
                    + " @ " + fill.ToString("F2")
                    + " TP1=" + activeTp1.ToString("F2")
                    + " TP2=" + activeTp2.ToString("F2")
                    + " [" + sl + "]",
                    activeDirection == "long" ? BullGreen : BearRed);
                return;
            }

            // ── TP1 partial exit (SigHalf target fills) ───────────────────────
            bool isHalfTarget = name.IndexOf("Target", StringComparison.OrdinalIgnoreCase) >= 0
                             || name.IndexOf("Profit", StringComparison.OrdinalIgnoreCase) >= 0;
            bool isHalfFill   = isHalfTarget && !_halfExited
                             && Math.Abs(fill - activeTp1) < 5.0;   // within 5pts of TP1

            if (isHalfFill)
            {
                _halfExited = true;
                double halfPnl = activeDirection == "long"
                    ? (fill - activeEntry) * HalfQty
                    : (activeEntry - fill) * HalfQty;

                Print("[MuzziBot] TP1 PARTIAL EXIT — " + HalfQty + " contracts @ "
                    + fill.ToString("F2") + " | half PnL=" + halfPnl.ToString("F2") + " pts"
                    + " | Runners still open, waiting for TP1+" + TrailTriggerPts + " trigger");

                DrawStatusLabel("TP1 HIT — " + HalfQty + " OUT | RUNNERS OPEN | waiting trail trigger",
                    Tp1Color);

                // Redraw TP1 line as filled
                RemoveDrawObject(TagTP1);
                RemoveDrawObject(TagTP1 + "_lbl");
                DrawHLine(TagTP1, activeTp1, BullGreen, "TP1 HIT ✓ (" + HalfQty + " out)");

                PostStatus("tp1_partial", "fill:" + fill.ToString("F2")
                    + ",halfPnlPts:" + halfPnl.ToString("F2"));
                return;
            }

            // ── Full close — runners stopped or hit TP2 ───────────────────────
            bool isFinalClose = Position.MarketPosition == MarketPosition.Flat
                || (quantity >= HalfQty
                    && (name.IndexOf("Stop", StringComparison.OrdinalIgnoreCase) >= 0
                     || name.IndexOf("Target", StringComparison.OrdinalIgnoreCase) >= 0
                     || name.IndexOf("Profit", StringComparison.OrdinalIgnoreCase) >= 0));

            if (isFinalClose && _halfExited && Position.MarketPosition == MarketPosition.Flat)
            {
                // Total PnL = TP1 half + runner half
                double tp1Pnl    = activeDirection == "long"
                    ? (activeTp1 - activeEntry) * HalfQty
                    : (activeEntry - activeTp1) * HalfQty;
                double runnerPnl = activeDirection == "long"
                    ? (fill - activeEntry) * HalfQty
                    : (activeEntry - fill) * HalfQty;
                double totalPnl  = tp1Pnl + runnerPnl;

                bool   hitTp2  = Math.Abs(fill - activeTp2) < 5.0;
                string outcome = hitTp2 ? "TP2" : (_trailActive ? "TRAIL_STOP" : "STOPPED");
                Brush  col     = hitTp2 ? Tp2Color : (_trailActive ? TrailColor : SlColor);

                Print("[MuzziBot] TRADE CLOSED — " + outcome
                    + " @ " + fill.ToString("F2")
                    + " | TP1 half=" + tp1Pnl.ToString("F2")
                    + " runner=" + runnerPnl.ToString("F2")
                    + " TOTAL=" + totalPnl.ToString("F2") + " pts");

                Draw.Text(this, TagOut, outcome + " " + totalPnl.ToString("F1") + "pts",
                    0, fill + (hitTp2 ? 4 : -4) * TickSize, col);
                DrawStatusLabel("CLOSED " + outcome + " | TOTAL "
                    + totalPnl.ToString("F1") + " pts | WAITING", col);

                // Start cooldown only on TP2
                if (hitTp2)
                {
                    _lastTp2Time = DateTime.Now;
                    Print("[MuzziBot] TP2 full close — cooldown started " + PostTp2CooldownMin + " min");
                }

                string sid = activeSignalId;
                PostStatus("closed", "outcome:" + outcome
                    + ",exitPrice:" + fill.ToString("F2", CultureInfo.InvariantCulture)
                    + ",totalPnlPts:" + totalPnl.ToString("F2", CultureInfo.InvariantCulture)
                    + ",tp1PnlPts:" + tp1Pnl.ToString("F2", CultureInfo.InvariantCulture)
                    + ",runnerPnlPts:" + runnerPnl.ToString("F2", CultureInfo.InvariantCulture)
                    + ",trailActive:" + _trailActive.ToString().ToLower());

                RemoveTradeLines();
                ResetSignal();
                return;
            }

            // ── Stop out before TP1 (full loss — both halves stopped) ──────────
            if (!_halfExited && Position.MarketPosition == MarketPosition.Flat)
            {
                double pnl = activeDirection == "long"
                    ? (fill - activeEntry) * HalfQty * 2
                    : (activeEntry - fill) * HalfQty * 2;

                Print("[MuzziBot] FULL STOP — both halves stopped @ "
                    + fill.ToString("F2") + " | PnL=" + pnl.ToString("F2"));

                DrawStatusLabel("STOPPED " + pnl.ToString("F1") + " pts | WAITING", SlColor);
                Draw.Text(this, TagOut, "STOP " + pnl.ToString("F1"), 0,
                    fill - 4*TickSize, SlColor);

                PostStatus("closed", "outcome:STOPPED"
                    + ",exitPrice:" + fill.ToString("F2", CultureInfo.InvariantCulture)
                    + ",totalPnlPts:" + pnl.ToString("F2", CultureInfo.InvariantCulture));

                RemoveTradeLines();
                ResetSignal();
            }
        }

        // ── Helpers ─────────────────────────────────────────────────────────────
        private void PostStatus(string status, string extra)
        {
            string sid = activeSignalId ?? "?";
            string url = ServerUrl + "/api/trade-signal/result";
            string body = "{\"id\":\"" + sid + "\",\"status\":\"" + status + "\""
                + ",\"detail\":\"" + extra + "\""
                + ",\"session\":\"" + activeSession + "\""
                + ",\"source\":\"tradingview\"}";
            ThreadPool.QueueUserWorkItem(delegate { HttpPost(url, body); });
        }

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
            catch { }
        }

        private void RemoveTradeLines()
        {
            foreach (string t in new[]{ TagSL, TagTP1, TagTP2 })
            {
                RemoveDrawObject(t);
                RemoveDrawObject(t + "_lbl");
            }
        }

        private void ResetSignal()
        {
            activeSignalId  = null;
            activeDirection = null;
            activeSession   = "";
            activeEntry     = 0;
            activeSL        = 0;
            activeTp1       = 0;
            activeTp2       = 0;
            entryBar        = -1;
            _halfExited     = false;
            _slLockedToTp1  = false;
            _trailActive    = false;
            _trailHigh      = 0;
            _trailLow       = double.MaxValue;
            _currentTrailSL = 0;
        }

        private int ToTicks(double pts)
        {
            if (TickSize <= 0) return (int)Math.Round(pts * 4);
            return (int)Math.Round(pts / TickSize);
        }

        // ── HTTP helpers ─────────────────────────────────────────────────────────
        private string HttpGet(string url, int timeoutMs)
        {
            try
            {
                using (var wc = new TimedWebClient(timeoutMs))
                    return wc.DownloadString(url);
            }
            catch (Exception ex) { Print("[MuzziBot] GET error: " + ex.Message); return null; }
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
            catch (Exception ex) { Print("[MuzziBot] POST error: " + ex.Message); }
        }

        private class TimedWebClient : WebClient
        {
            private readonly int _ms;
            public TimedWebClient(int ms) { _ms = ms; }
            protected override WebRequest GetWebRequest(Uri address)
            {
                var r = base.GetWebRequest(address);
                if (r != null) r.Timeout = _ms;
                return r;
            }
        }

        // ── Minimal JSON parsers ────────────────────────────────────────────────
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
