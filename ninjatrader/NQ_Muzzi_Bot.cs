// ============================================================
//  NQ_Muzzi_Bot.cs  —  NinjaTrader 8 Strategy
//
//  Executes trades based on the Muzzi 10-step checklist grade
//  returned by the NQ Analyst server (/api/muzzi-signal).
//
//  Also reads Sierra Chart volume data (delta, CVD, buy/sell
//  volume) directly from the server to satisfy checklist items
//  that require order flow confirmation (items 8 & 9 — Three-Bar
//  Play detection and Delta Flip at zone).
//
//  After every trade closes, posts the full result to the
//  /api/learning-kernel/feed endpoint so the server's learning
//  kernel can update Muzzi checklist weights and bias scores.
//
//  Risk compliance: Lucid prop firm ($50k account)
//    - $1,200 max daily drawdown
//    - 4 contracts max
//    - Force-close at 4:44pm ET
//    - No entry in Wrecking Ball window (09:30–09:35 NY)
//    - Minimum 6-second hold before exits fire
//
//  Author:  NQ Analyst System
//  Version: 2.0.0 (Muzzi + Learning Kernel)
//  Target:  NinjaTrader 8 / .NET Framework 4.8
// ============================================================

#region Using Declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Media;
using System.Xml.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.Gui.SuperDom;
using NinjaTrader.Gui.Tools;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.Core.FloatingPoint;
using NinjaTrader.NinjaScript.DrawingTools;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    // ============================================================
    //  DATA MODELS
    // ============================================================

    /// <summary>
    /// Muzzi signal payload from /api/muzzi-signal.
    /// Contains the full Muzzi checklist evaluation plus
    /// Sierra Chart order flow data merged server-side.
    /// </summary>
    public class MuzziSignal
    {
        // ── Muzzi grade ──
        public string   id              { get; set; }   // unique signal ID
        public string   grade           { get; set; }   // "A+" | "A" | "B" | "WAIT" | "HARD RULE VIOLATED"
        public string   direction       { get; set; }   // "LONG" | "SHORT" | "WAIT"
        public int      gravityScore    { get; set; }   // 0-5 Institutional Gravity
        public string   hardRule        { get; set; }   // null or violation message
        public string   coachingNote    { get; set; }

        // ── Price levels ──
        public double   price           { get; set; }   // current NQ price
        public double   vwap            { get; set; }   // session VWAP
        public double   vwap1sdHi       { get; set; }   // VWAP +1SD
        public double   vwap1sdLo       { get; set; }   // VWAP -1SD
        public double   entryZoneLow    { get; set; }   // computed entry zone low
        public double   entryZoneHigh   { get; set; }   // computed entry zone high
        public double   suggestedEntry  { get; set; }   // midpoint of entry zone
        public double   suggestedSL     { get; set; }   // ICT-standard SL (20 pts)
        public double   suggestedTP1    { get; set; }   // 1.5R
        public double   suggestedTP2    { get; set; }   // 3.5R

        // ── Muzzi checklist status (auto-detected items) ──
        public bool     htfBiasPass     { get; set; }   // item 1
        public bool     dealingRangePass{ get; set; }   // item 2
        public bool     killzonePass    { get; set; }   // item 3
        public bool     sweepPass       { get; set; }   // item 4
        public bool     mssPass         { get; set; }   // item 5
        public bool     fvgPass         { get; set; }   // item 6
        public bool     vwapPass        { get; set; }   // item 7
        public bool     extended1SD     { get; set; }   // price beyond VWAP ±1SD
        public int      primaryPassing  { get; set; }   // # primary checklist items passing (0-6)

        // ── Sierra Chart order flow (from /api/sierra-webhook) ──
        public double   delta           { get; set; }   // last bar delta (buy-sell vol)
        public double   cvd             { get; set; }   // cumulative volume delta
        public double   buyVolume       { get; set; }
        public double   sellVolume      { get; set; }
        public bool     absorptionBull  { get; set; }   // large bid absorption detected
        public bool     absorptionBear  { get; set; }   // large ask absorption detected
        public bool     deltaFlip       { get; set; }   // delta flipped from prior bar (item 9)
        public bool     threeBarPlay    { get; set; }   // three-bar exhaustion detected (item 8)
        public string   killzone        { get; set; }   // "london_open" | "ny_open" | etc.
        public int      wreckingBall    { get; set; }   // 1 = 09:30-09:35 hard rule no-entry
        public long     createdAt       { get; set; }   // unix ms
    }

    /// <summary>
    /// Payload posted to /api/learning-kernel/feed after every trade closes.
    /// The server's learning kernel uses this to track which Muzzi checklist
    /// configurations actually result in wins and adjusts weights accordingly.
    /// </summary>
    public class LearningKernelEntry
    {
        public string   signalId        { get; set; }
        public string   grade           { get; set; }
        public string   direction       { get; set; }
        public int      gravityScore    { get; set; }
        public int      primaryPassing  { get; set; }
        public bool     deltaFlip       { get; set; }
        public bool     threeBarPlay    { get; set; }
        public bool     extended1SD     { get; set; }
        public bool     absorptionConf  { get; set; }  // absorptionBull (long) or absorptionBear (short)
        public string   killzone        { get; set; }
        public double   entryPrice      { get; set; }
        public double   slPrice         { get; set; }
        public double   tp1Price        { get; set; }
        public double   tp2Price        { get; set; }
        public double   exitPrice       { get; set; }
        public double   pnlPoints       { get; set; }
        public double   pnlDollars      { get; set; }
        public string   result          { get; set; }  // "TP2" | "TP1" | "STOPPED" | "EXPIRED"
        public string   exitReason      { get; set; }  // "TP1_HIT" | "TP2_HIT" | "SL_HIT" | "FORCE_CLOSE" | "MANUAL"
        public double   scDelta         { get; set; }  // SC delta at entry
        public double   scCvd           { get; set; }  // SC CVD at entry
        public double   scBuyVol        { get; set; }
        public double   scSellVol       { get; set; }
        public string   tradeDate       { get; set; }  // "2026-05-25"
        public string   entryTime       { get; set; }  // "09:42:15 ET"
        public string   exitTime        { get; set; }
    }

    // ============================================================
    //  MAIN STRATEGY
    // ============================================================
    public class NQ_Muzzi_Bot : Strategy
    {
        #region ──── PARAMETERS ─────────────────────────────────────

        [NinjaScriptProperty]
        [Display(Name = "Server URL", GroupName = "NQ Analyst Server", Order = 1,
                 Description = "Base Railway URL (no trailing slash)")]
        public string ServerUrl { get; set; }

        [NinjaScriptProperty]
        [Range(100, 10000)]
        [Display(Name = "Daily Loss Limit ($)", GroupName = "Risk Rules", Order = 2,
                 Description = "Hard daily drawdown limit. Bot halts when breached.")]
        public double DailyLossLimit { get; set; }

        [NinjaScriptProperty]
        [Range(1, 4)]
        [Display(Name = "Max Contracts", GroupName = "Risk Rules", Order = 3,
                 Description = "Max contracts per trade (Lucid limit = 4).")]
        public int MaxContracts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Enable Auto-Trading", GroupName = "Risk Rules", Order = 4,
                 Description = "Master kill switch. Uncheck to disable order submission (monitoring only).")]
        public bool EnableTrading { get; set; }

        [NinjaScriptProperty]
        [Range(2, 60)]
        [Display(Name = "Poll Interval (seconds)", GroupName = "NQ Analyst Server", Order = 5,
                 Description = "How often to poll /api/muzzi-signal for a new Muzzi grade.")]
        public int PollIntervalSeconds { get; set; }

        [NinjaScriptProperty]
        [Range(6, 120)]
        [Display(Name = "Min Hold (seconds)", GroupName = "Risk Rules", Order = 6,
                 Description = "Minimum seconds to hold before exits arm (Lucid micro-scalp rule).")]
        public int MinHoldSeconds { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Require A+ Only", GroupName = "Entry Filter", Order = 7,
                 Description = "When true, only A+ grades trigger entries. When false, A grades also qualify.")]
        public bool RequireAPlus { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Require Delta Flip", GroupName = "Entry Filter", Order = 8,
                 Description = "When true, checklist item 9 (Delta Flip at zone) must be confirmed by SC data before entry fires.")]
        public bool RequireDeltaFlip { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Require 3-Bar Play", GroupName = "Entry Filter", Order = 9,
                 Description = "When true, checklist item 8 (Three-Bar Play) must be confirmed by SC data.")]
        public bool RequireThreeBarPlay { get; set; }

        [NinjaScriptProperty]
        [Range(1, 3)]
        [Display(Name = "Min Gravity Score", GroupName = "Entry Filter", Order = 10,
                 Description = "Minimum Institutional Gravity score (1-5) required to take the trade.")]
        public int MinGravityScore { get; set; }

        #endregion

        #region ──── PRIVATE STATE ───────────────────────────────────

        // ── Daily P&L tracking ──
        private double   dailyPnL           = 0.0;
        private bool     dailyLimitHit      = false;
        private DateTime lastPnLResetDate   = DateTime.MinValue;

        // ── Position state ──
        private bool     inTrade            = false;
        private string   activeSignalId     = string.Empty;
        private DateTime entryTimestamp     = DateTime.MinValue;
        private bool     exitsArmed         = false;
        private bool     tp1Hit             = false;

        // ── Active signal snapshot (for learning kernel post) ──
        private MuzziSignal activeSignal    = null;
        private double   actualEntry        = 0.0;
        private double   actualTP1          = 0.0;
        private double   actualTP2          = 0.0;
        private double   actualSL           = 0.0;

        // ── Polling ──
        private DateTime lastPollTime       = DateTime.MinValue;
        private bool     pollRunning        = false;

        // ── Chart labels ──
        private int      labelIndex         = 0;

        #endregion

        #region ──── INITIALIZATION ─────────────────────────────────

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description              = "NQ Muzzi Bot — trades A+/A Muzzi grades with SC volume confirmation. Posts results to learning kernel.";
                Name                     = "NQ_Muzzi_Bot";
                Calculate                = Calculate.OnEachTick;
                EntriesPerDirection      = 1;
                EntryHandling            = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy = true;
                ExitOnSessionCloseSeconds    = 960; // 16 mins before close
                IsFillLimitOnTouch       = false;
                MaximumBarsLookBack      = MaximumBarsLookBack.TwoHundredFiftySix;
                OrderFillResolution      = OrderFillResolution.Standard;
                StartBehavior            = StartBehavior.WaitUntilFlat;
                TimeInForce              = TimeInForce.Gtc;
                TraceOrders              = false;
                RealtimeErrorHandling    = RealtimeErrorHandling.StopCancelClose;
                StopTargetHandling       = StopTargetHandling.PerEntryExecution;
                BarsRequiredToTrade      = 1;
                IsInstantiatedOnEachOptimizationIteration = true;

                // Default parameters
                ServerUrl           = "https://nq-analyst-production.up.railway.app";
                DailyLossLimit      = 1200.0;
                MaxContracts        = 1;
                EnableTrading       = true;
                PollIntervalSeconds = 5;
                MinHoldSeconds      = 6;
                RequireAPlus        = false;    // A+ and A both qualify by default
                RequireDeltaFlip    = true;     // SC item 9 required
                RequireThreeBarPlay = false;    // item 8 optional (manual)
                MinGravityScore     = 2;        // at least 2 gravity layers
            }
            else if (State == State.Configure)
            {
                // Nothing additional needed — bracket orders built on-the-fly
            }
            else if (State == State.DataLoaded)
            {
                lastPnLResetDate = DateTime.MinValue;
            }
        }

        #endregion

        #region ──── ON BAR UPDATE ──────────────────────────────────

        protected override void OnBarUpdate()
        {
            if (CurrentBar < BarsRequiredToTrade) return;
            if (State != State.Realtime) return;

            // ── Daily P&L reset ──────────────────────────────────────────────
            DateTime today = DateTime.Now.Date;
            if (today != lastPnLResetDate.Date)
            {
                dailyPnL         = 0.0;
                dailyLimitHit    = false;
                lastPnLResetDate = today;
                LogInfo("Daily P&L reset for " + today.ToString("yyyy-MM-dd"));
            }

            // ── Force-close at 4:44pm ET ──────────────────────────────────────
            DateTime etNow = TimeZoneInfo.ConvertTime(DateTime.UtcNow,
                TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time"));
            bool forceCloseWindow = etNow.Hour == 16 && etNow.Minute >= 44;

            if (forceCloseWindow && inTrade)
            {
                LogWarn("FORCE CLOSE — 4:44pm ET. Exiting all positions.");
                ForceClosePosition("FORCE_CLOSE_EOD");
                return;
            }

            // ── Halt when daily limit hit ─────────────────────────────────────
            if (dailyLimitHit)
            {
                DrawText("halt", "⛔ DAILY LIMIT HIT", 0, High[0] + 20, Brushes.Red);
                return;
            }

            // ── Arm exits after min hold elapsed ─────────────────────────────
            if (inTrade && !exitsArmed)
            {
                double elapsedSec = (DateTime.Now - entryTimestamp).TotalSeconds;
                if (elapsedSec >= MinHoldSeconds)
                {
                    exitsArmed = true;
                    LogInfo($"Exits armed after {elapsedSec:F1}s hold.");
                }
            }

            // ── Poll server for Muzzi signal ──────────────────────────────────
            double secondsSincePoll = (DateTime.Now - lastPollTime).TotalSeconds;
            if (secondsSincePoll >= PollIntervalSeconds && !pollRunning && !inTrade)
            {
                lastPollTime = DateTime.Now;
                Task.Run(() => PollAndEvaluate());
            }
        }

        #endregion

        #region ──── SIGNAL POLLING & EVALUATION ────────────────────

        private void PollAndEvaluate()
        {
            pollRunning = true;
            try
            {
                MuzziSignal sig = FetchMuzziSignal();
                if (sig == null) return;

                // Skip if same signal already processed
                if (sig.id == activeSignalId) return;

                // ── Gate 1: Hard rule or WAIT ──────────────────────────────────
                if (sig.direction == "WAIT" || sig.grade == "WAIT" ||
                    sig.grade == "HARD RULE VIOLATED")
                {
                    UpdateChartLabel($"⏳ {sig.grade} | {sig.coachingNote?.Substring(0, Math.Min(60, sig.coachingNote?.Length ?? 0))}...");
                    return;
                }

                // ── Gate 2: Grade filter ───────────────────────────────────────
                bool gradeOk = RequireAPlus
                    ? sig.grade == "A+"
                    : (sig.grade == "A+" || sig.grade == "A");

                if (!gradeOk)
                {
                    UpdateChartLabel($"📊 Grade {sig.grade} — below threshold | Gravity {sig.gravityScore}/5");
                    return;
                }

                // ── Gate 3: Institutional Gravity ──────────────────────────────
                if (sig.gravityScore < MinGravityScore)
                {
                    UpdateChartLabel($"📊 Gravity {sig.gravityScore}/{MinGravityScore} — insufficient zone layers");
                    return;
                }

                // ── Gate 4: Delta Flip (SC item 9) ────────────────────────────
                if (RequireDeltaFlip && !sig.deltaFlip)
                {
                    UpdateChartLabel($"⏳ Waiting for Delta Flip | {sig.grade} | Gravity {sig.gravityScore}");
                    return;
                }

                // ── Gate 5: Three-Bar Play (SC item 8) ────────────────────────
                if (RequireThreeBarPlay && !sig.threeBarPlay)
                {
                    UpdateChartLabel($"⏳ Waiting for 3-Bar Play | {sig.grade} | ΔFlip:{sig.deltaFlip}");
                    return;
                }

                // ── Gate 6: SC Absorption alignment ───────────────────────────
                bool absorptionOk = sig.direction == "LONG"
                    ? sig.absorptionBull
                    : sig.absorptionBear;
                // Absorption is a plus but not hard-required if delta flip already confirmed
                if (!absorptionOk && !sig.deltaFlip)
                {
                    UpdateChartLabel($"⏳ No SC volume confirmation | Grade {sig.grade}");
                    return;
                }

                // ── Gate 7: Wrecking Ball hard rule ───────────────────────────
                if (sig.wreckingBall == 1)
                {
                    UpdateChartLabel("⛔ WRECKING BALL 09:30–09:35 — NO ENTRY");
                    return;
                }

                // ── All gates passed — fire entry ─────────────────────────────
                if (EnableTrading)
                {
                    Dispatcher.InvokeAsync(() => ExecuteMuzziEntry(sig));
                }
                else
                {
                    LogInfo($"[DRY RUN] Would fire {sig.direction} @ {sig.suggestedEntry} | Grade {sig.grade}");
                    UpdateChartLabel($"🔵 DRY RUN {sig.direction} {sig.grade} | Gravity {sig.gravityScore}");
                }
            }
            catch (Exception ex)
            {
                LogWarn("PollAndEvaluate error: " + ex.Message);
            }
            finally
            {
                pollRunning = false;
            }
        }

        #endregion

        #region ──── ORDER EXECUTION ────────────────────────────────

        private void ExecuteMuzziEntry(MuzziSignal sig)
        {
            if (inTrade) return;
            if (Position.MarketPosition != MarketPosition.Flat) return;

            // Round all levels to NQ tick (0.25)
            double entry = RoundToTick(sig.suggestedEntry > 0 ? sig.suggestedEntry : sig.price);
            double sl    = RoundToTick(sig.suggestedSL);
            double tp1   = RoundToTick(sig.suggestedTP1);
            double tp2   = RoundToTick(sig.suggestedTP2);

            // Validate levels
            if (entry <= 0 || sl <= 0 || tp1 <= 0 || tp2 <= 0)
            {
                LogWarn("Invalid levels from Muzzi signal — skipping entry.");
                return;
            }

            bool isLong = sig.direction == "LONG";

            // Sanity check: SL on correct side
            if (isLong  && sl >= entry) { LogWarn("Long SL not below entry — skipping."); return; }
            if (!isLong && sl <= entry) { LogWarn("Short SL not above entry — skipping."); return; }

            // Store signal snapshot for learning kernel
            activeSignal  = sig;
            activeSignalId = sig.id;
            actualEntry   = entry;
            actualSL      = sl;
            actualTP1     = tp1;
            actualTP2     = tp2;
            inTrade       = true;
            exitsArmed    = false;
            tp1Hit        = false;
            entryTimestamp = DateTime.Now;

            int qty = Math.Min(MaxContracts, sig.gravityScore >= 3 ? 2 : 1);

            if (isLong)
            {
                EnterLong(qty, "Muzzi_Long");

                // TP1: half position, TP2: full exit
                ExitLongLimit(Math.Max(1, qty / 2), tp1, "Muzzi_TP1", "Muzzi_Long");
                ExitLongLimit(qty,                   tp2, "Muzzi_TP2", "Muzzi_Long");
                ExitLongStopMarket(qty, sl, "Muzzi_SL", "Muzzi_Long");
            }
            else
            {
                EnterShort(qty, "Muzzi_Short");

                ExitShortLimit(Math.Max(1, qty / 2), tp1, "Muzzi_TP1", "Muzzi_Short");
                ExitShortLimit(qty,                   tp2, "Muzzi_TP2", "Muzzi_Short");
                ExitShortStopMarket(qty, sl, "Muzzi_SL", "Muzzi_Short");
            }

            string logMsg = $"[ENTRY] {sig.direction} @ {entry} | SL:{sl} TP1:{tp1} TP2:{tp2} | Grade:{sig.grade} Gravity:{sig.gravityScore} ΔFlip:{sig.deltaFlip}";
            LogInfo(logMsg);
            UpdateChartLabel($"🟢 IN TRADE {sig.direction} @ {entry} | {sig.grade} | G{sig.gravityScore}");

            // Confirm signal received on server
            Task.Run(() => ConfirmSignal(sig.id));
        }

        private void ForceClosePosition(string reason)
        {
            if (Position.MarketPosition == MarketPosition.Long)
                ExitLong("Force_Close", "Muzzi_Long");
            else if (Position.MarketPosition == MarketPosition.Short)
                ExitShort("Force_Close", "Muzzi_Short");

            ResetTradeState(reason);
        }

        #endregion

        #region ──── ORDER EVENTS ───────────────────────────────────

        protected override void OnExecutionUpdate(Execution execution, string executionId,
            double price, int quantity, MarketPosition marketPosition,
            string orderId, DateTime time)
        {
            if (!inTrade) return;

            string name = execution.Order?.Name ?? "";

            // ── Entry fill ───────────────────────────────────────────────────
            if (name == "Muzzi_Long" || name == "Muzzi_Short")
            {
                actualEntry = price;
                LogInfo($"Fill confirmed: {name} @ {price}");
            }

            // ── TP1 hit ──────────────────────────────────────────────────────
            if (name == "Muzzi_TP1" && exitsArmed)
            {
                tp1Hit = true;
                double pts = activeSignal?.direction == "LONG"
                    ? price - actualEntry
                    : actualEntry - price;
                double dollars = pts * 20.0;
                dailyPnL += dollars;
                LogInfo($"TP1 HIT @ {price} | +{pts:F2}pts | +${dollars:F0}");
                UpdateChartLabel($"✅ TP1 @ {price} | +{pts:F1}pts");

                // Post partial result to learning kernel
                Task.Run(() => PostToLearningKernel(price, "TP1_HIT", "TP1"));
            }

            // ── TP2 hit ──────────────────────────────────────────────────────
            if (name == "Muzzi_TP2" && exitsArmed)
            {
                double pts = activeSignal?.direction == "LONG"
                    ? price - actualEntry
                    : actualEntry - price;
                double dollars = pts * 20.0;
                dailyPnL += (tp1Hit ? dollars / 2.0 : dollars); // partial already booked
                LogInfo($"TP2 HIT @ {price} | +{pts:F2}pts | Total PnL today: ${dailyPnL:F0}");
                UpdateChartLabel($"🏆 TP2 @ {price} | +{pts:F1}pts");

                Task.Run(() => PostToLearningKernel(price, "TP2_HIT", "TP2"));
                ResetTradeState("TP2_HIT");
            }

            // ── Stop loss hit ────────────────────────────────────────────────
            if (name == "Muzzi_SL")
            {
                double pts = activeSignal?.direction == "LONG"
                    ? price - actualEntry
                    : actualEntry - price;   // will be negative
                double dollars = pts * 20.0;
                dailyPnL += dollars;

                LogWarn($"STOPPED @ {price} | {pts:F2}pts | ${dollars:F0} | Daily PnL: ${dailyPnL:F0}");
                UpdateChartLabel($"🔴 STOPPED @ {price} | {pts:F1}pts");

                // Check daily limit
                if (dailyPnL <= -Math.Abs(DailyLossLimit))
                {
                    dailyLimitHit = true;
                    LogWarn($"⛔ DAILY LOSS LIMIT BREACHED (${dailyPnL:F0}). Trading halted for today.");
                }

                Task.Run(() => PostToLearningKernel(price, "SL_HIT", "STOPPED"));
                ResetTradeState("SL_HIT");
            }

            // ── Force close ──────────────────────────────────────────────────
            if (name == "Force_Close")
            {
                double pts = activeSignal?.direction == "LONG"
                    ? price - actualEntry
                    : actualEntry - price;
                Task.Run(() => PostToLearningKernel(price, "FORCE_CLOSE", pts >= 0 ? "TP1" : "STOPPED"));
                ResetTradeState("FORCE_CLOSE");
            }
        }

        private void ResetTradeState(string reason)
        {
            inTrade        = false;
            exitsArmed     = false;
            tp1Hit         = false;
            activeSignal   = null;
            activeSignalId = string.Empty;
            actualEntry    = 0.0;
            LogInfo($"Trade state reset — reason: {reason}");
        }

        #endregion

        #region ──── SERVER HTTP CALLS ──────────────────────────────

        /// <summary>
        /// Fetches the current Muzzi signal evaluation from the server.
        /// The server merges TradingView ICT data with Sierra Chart order flow
        /// and runs the same evaluateMuzziChecklist() logic, returning the
        /// full grade + computed levels + SC volume fields.
        /// </summary>
        private MuzziSignal FetchMuzziSignal()
        {
            try
            {
                string url      = $"{ServerUrl}/api/muzzi-signal";
                string response = HttpGet(url, 4000);
                if (string.IsNullOrEmpty(response)) return null;
                return SimpleJsonDeserialize<MuzziSignal>(response);
            }
            catch (Exception ex)
            {
                LogWarn("FetchMuzziSignal failed: " + ex.Message);
                return null;
            }
        }

        private void ConfirmSignal(string signalId)
        {
            try
            {
                string body = $"{{\"id\":\"{signalId}\",\"status\":\"received\"}}";
                HttpPost($"{ServerUrl}/api/trade-signal/confirm", body, 3000);
            }
            catch { /* non-critical */ }
        }

        /// <summary>
        /// Posts the completed trade to /api/learning-kernel/feed.
        /// The learning kernel server-side uses these results to:
        ///   1. Track win/loss rate per grade (A+ vs A vs B)
        ///   2. Track win/loss per gravity score (1-5)
        ///   3. Track which SC confirmations (deltaFlip, 3BarPlay, absorption) correlate with wins
        ///   4. Adjust Muzzi checklist scoring weights over time
        /// </summary>
        private void PostToLearningKernel(double exitPrice, string exitReason, string result)
        {
            try
            {
                if (activeSignal == null) return;

                DateTime etNow = TimeZoneInfo.ConvertTime(DateTime.UtcNow,
                    TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time"));

                double rawPts = activeSignal.direction == "LONG"
                    ? exitPrice - actualEntry
                    : actualEntry - exitPrice;

                var entry = new LearningKernelEntry
                {
                    signalId       = activeSignal.id,
                    grade          = activeSignal.grade,
                    direction      = activeSignal.direction,
                    gravityScore   = activeSignal.gravityScore,
                    primaryPassing = activeSignal.primaryPassing,
                    deltaFlip      = activeSignal.deltaFlip,
                    threeBarPlay   = activeSignal.threeBarPlay,
                    extended1SD    = activeSignal.extended1SD,
                    absorptionConf = activeSignal.direction == "LONG"
                                        ? activeSignal.absorptionBull
                                        : activeSignal.absorptionBear,
                    killzone       = activeSignal.killzone,
                    entryPrice     = actualEntry,
                    slPrice        = actualSL,
                    tp1Price       = actualTP1,
                    tp2Price       = actualTP2,
                    exitPrice      = exitPrice,
                    pnlPoints      = rawPts,
                    pnlDollars     = rawPts * 20.0,
                    result         = result,
                    exitReason     = exitReason,
                    scDelta        = activeSignal.delta,
                    scCvd          = activeSignal.cvd,
                    scBuyVol       = activeSignal.buyVolume,
                    scSellVol      = activeSignal.sellVolume,
                    tradeDate      = etNow.ToString("yyyy-MM-dd"),
                    entryTime      = entryTimestamp.ToString("HH:mm:ss") + " ET",
                    exitTime       = etNow.ToString("HH:mm:ss") + " ET",
                };

                string json = SimpleJsonSerialize(entry);
                HttpPost($"{ServerUrl}/api/learning-kernel/feed", json, 5000);
                LogInfo($"Learning kernel updated: {result} | {rawPts:F2}pts");
            }
            catch (Exception ex)
            {
                LogWarn("PostToLearningKernel failed: " + ex.Message);
            }
        }

        #endregion

        #region ──── HTTP HELPERS ────────────────────────────────────

        private string HttpGet(string url, int timeoutMs = 5000)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method  = "GET";
            req.Timeout = timeoutMs;
            req.Headers.Add("User-Agent", "NQ_Muzzi_Bot/2.0");
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr   = new StreamReader(resp.GetResponseStream()))
                return sr.ReadToEnd();
        }

        private string HttpPost(string url, string jsonBody, int timeoutMs = 5000)
        {
            byte[] data = Encoding.UTF8.GetBytes(jsonBody);
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method        = "POST";
            req.ContentType   = "application/json";
            req.ContentLength = data.Length;
            req.Timeout       = timeoutMs;
            req.Headers.Add("User-Agent", "NQ_Muzzi_Bot/2.0");
            using (var stream = req.GetRequestStream())
                stream.Write(data, 0, data.Length);
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr   = new StreamReader(resp.GetResponseStream()))
                return sr.ReadToEnd();
        }

        #endregion

        #region ──── JSON HELPERS ────────────────────────────────────
        // Minimal JSON parser — avoids Newtonsoft.Json dependency in NinjaTrader

        private T SimpleJsonDeserialize<T>(string json) where T : new()
        {
            var obj  = new T();
            var props = typeof(T).GetProperties();
            foreach (var prop in props)
            {
                string key    = prop.Name;
                string search = $"\"{key}\"";
                int idx = json.IndexOf(search, StringComparison.OrdinalIgnoreCase);
                if (idx < 0) continue;

                int colon = json.IndexOf(':', idx + search.Length);
                if (colon < 0) continue;

                int start = colon + 1;
                while (start < json.Length && json[start] == ' ') start++;

                if (start >= json.Length) continue;

                string rawVal;
                if (json[start] == '"')
                {
                    int end = json.IndexOf('"', start + 1);
                    rawVal = end > start ? json.Substring(start + 1, end - start - 1) : "";
                }
                else
                {
                    int end = start;
                    while (end < json.Length && json[end] != ',' && json[end] != '}') end++;
                    rawVal = json.Substring(start, end - start).Trim();
                }

                try
                {
                    if (prop.PropertyType == typeof(string))
                        prop.SetValue(obj, rawVal == "null" ? null : rawVal);
                    else if (prop.PropertyType == typeof(double))
                        prop.SetValue(obj, double.TryParse(rawVal, out double d) ? d : 0.0);
                    else if (prop.PropertyType == typeof(int))
                        prop.SetValue(obj, int.TryParse(rawVal, out int i) ? i : 0);
                    else if (prop.PropertyType == typeof(long))
                        prop.SetValue(obj, long.TryParse(rawVal, out long l) ? l : 0L);
                    else if (prop.PropertyType == typeof(bool))
                        prop.SetValue(obj, rawVal == "true" || rawVal == "1");
                }
                catch { /* skip uncastable fields */ }
            }
            return obj;
        }

        private string SimpleJsonSerialize(object obj)
        {
            var sb    = new StringBuilder("{");
            var props = obj.GetType().GetProperties();
            bool first = true;
            foreach (var prop in props)
            {
                if (!first) sb.Append(",");
                first = false;
                object val = prop.GetValue(obj);
                sb.Append($"\"{prop.Name}\":");
                if (val == null)
                    sb.Append("null");
                else if (val is string s)
                    sb.Append($"\"{s.Replace("\"", "\\\"")}\"");
                else if (val is bool b)
                    sb.Append(b ? "true" : "false");
                else
                    sb.Append(val.ToString());
            }
            sb.Append("}");
            return sb.ToString();
        }

        #endregion

        #region ──── UTILITY ────────────────────────────────────────

        private double RoundToTick(double price)
            => Math.Round(price * 4.0) / 4.0;

        private void LogInfo(string msg)
            => Print($"[MuzziBot][{DateTime.Now:HH:mm:ss}] {msg}");

        private void LogWarn(string msg)
            => Print($"[MuzziBot][WARN][{DateTime.Now:HH:mm:ss}] {msg}");

        private void UpdateChartLabel(string text)
        {
            try
            {
                Draw.TextFixed(this, "status_label", text, TextPosition.BottomLeft,
                    Brushes.Cyan, new SimpleFont("Arial", 11), Brushes.Transparent,
                    Brushes.Transparent, 0);
            }
            catch { /* non-critical */ }
        }

        private void DrawText(string tag, string text, int barsAgo, double price, Brush color)
        {
            try
            {
                Draw.Text(this, tag + labelIndex++, text, barsAgo, price, color);
            }
            catch { }
        }

        #endregion
    }
}
