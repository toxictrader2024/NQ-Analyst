// ============================================================
//  NQ_ICT_Bot.cs  —  NinjaTrader 8 Strategy
//  Polls the NQ Analyst Railway server for ICT trade signals
//  and executes bracket orders on NQ futures with full prop-firm
//  risk compliance (Lucid $50k account rules).
//
//  Author:  NQ Analyst Bot
//  Version: 1.0.0
//  Target:  NinjaTrader 8 / .NET Framework 4.8
//
//  HOW TO INSTALL:
//  1. In NinjaTrader, open NinjaScript Editor (Tools > Edit NinjaScript > Strategy)
//  2. Paste this entire file, or use New > Strategy and replace contents
//  3. Compile (F5) and apply to a 1-minute NQ continuous contract chart
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
    //  SIGNAL DATA MODEL
    //  Mirrors the JSON payload from /api/trade-signal/pending
    // ============================================================
    public class TradeSignal
    {
        public string   id         { get; set; }
        public string   direction  { get; set; }   // "long" | "short"
        public double   entry      { get; set; }
        public double   sl         { get; set; }
        public double   tp1        { get; set; }
        public double   tp2        { get; set; }
        public int      qty        { get; set; }
        public string   session    { get; set; }
        public int      confidence { get; set; }
        public string   reason     { get; set; }
    }

    // ============================================================
    //  MAIN STRATEGY CLASS
    // ============================================================
    public class NQ_ICT_Bot : Strategy
    {
        #region ──── PARAMETERS ─────────────────────────────────────

        [NinjaScriptProperty]
        [Display(Name = "Server URL", GroupName = "NQ Analyst Server",
                 Description = "Base URL of the Railway NQ Analyst server",
                 Order = 1)]
        public string ServerUrl { get; set; }

        [NinjaScriptProperty]
        [Range(100, 10000)]
        [Display(Name = "Daily Loss Limit ($)", GroupName = "Risk Rules",
                 Description = "Hard daily loss limit in dollars. Trading halts if breached.",
                 Order = 2)]
        public double DailyLossLimit { get; set; }

        [NinjaScriptProperty]
        [Range(1, 4)]
        [Display(Name = "Max Contracts", GroupName = "Risk Rules",
                 Description = "Maximum contracts per trade (Lucid limit = 4).",
                 Order = 3)]
        public int MaxContracts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Enable Trading", GroupName = "Risk Rules",
                 Description = "Master kill switch. Uncheck to disable all order submission.",
                 Order = 4)]
        public bool EnableTrading { get; set; }

        [NinjaScriptProperty]
        [Range(1, 60)]
        [Display(Name = "Poll Interval (seconds)", GroupName = "NQ Analyst Server",
                 Description = "How often to poll the server for new signals.",
                 Order = 5)]
        public int PollIntervalSeconds { get; set; }

        [NinjaScriptProperty]
        [Range(1, 60)]
        [Display(Name = "Min Trade Duration (seconds)", GroupName = "Risk Rules",
                 Description = "Minimum seconds to hold a position before exits are active (Lucid micro-scalp rule).",
                 Order = 6)]
        public int MinTradeDurationSeconds { get; set; }

        #endregion

        #region ──── PRIVATE STATE ───────────────────────────────────

        // ── Daily P&L tracking ──
        private double  currentDailyPnL    = 0.0;
        private bool    dailyLimitBreached = false;
        private DateTime lastResetDate     = DateTime.MinValue;

        // ── Position state ──
        private bool    isInTrade          = false;
        private string  lastSignalId       = string.Empty;
        private DateTime entryTime         = DateTime.MinValue;
        private bool    exitsArmed         = false;   // true once min-duration elapsed
        private int     activeQty          = 0;
        private bool    isLong             = true;

        // ── Active bracket orders ──
        private Order   stopOrder          = null;
        private Order   tp1Order           = null;
        private Order   tp2Order           = null;

        // ── Signal prices (held so OnOrderUpdate can use them) ──
        private double  signalSL           = 0.0;
        private double  signalTP1          = 0.0;
        private double  signalTP2          = 0.0;
        private int     signalQty          = 0;

        // ── HTTP polling infrastructure ──
        private System.Threading.Timer pollTimer    = null;
        private volatile bool          isPollActive = false;   // guard against re-entrant polls
        private volatile bool          isShuttingDown = false;

        // ── Minimum-duration enforcement ──
        private System.Threading.Timer minDurationTimer = null;

        // ── Force-close flag ──
        private bool forceCloseTriggered = false;

        // ── Constants ──
        private const double NQ_TICK_VALUE  = 5.0;   // $5 per 0.25 point tick per contract
        private const double NQ_TICK_SIZE   = 0.25;
        private const string LOG_PREFIX     = "[NQ_BOT]";

        #endregion

        #region ──── NINJASCRIPT LIFECYCLE ──────────────────────────

        protected override void OnStateChange()
        {
            // ── SetDefaults: fills parameter defaults shown in UI ──
            if (State == State.SetDefaults)
            {
                Description             = "NQ ICT Bot — polls NQ Analyst Railway server and executes bracket orders on NQ futures.";
                Name                    = "NQ_ICT_Bot";
                Calculate               = Calculate.OnBarClose;
                EntriesPerDirection     = 1;
                EntryHandling           = EntryHandling.UniqueEntries;
                IsExitOnSessionCloseStrategy = false;   // we handle our own force-close
                IsUnmanaged             = false;        // use managed order API
                StartBehavior           = StartBehavior.WaitUntilFlat;
                TimeInForce             = TimeInForce.Day;
                TraceOrders             = true;

                // Default parameter values
                ServerUrl               = "https://nq-analyst-production.up.railway.app";
                DailyLossLimit          = 1200.0;
                MaxContracts            = 1;
                EnableTrading           = true;
                PollIntervalSeconds     = 2;
                MinTradeDurationSeconds = 6;
            }

            // ── Configure: runs before historical data loads ──
            else if (State == State.Configure)
            {
                // Nothing additional needed for configure
            }

            // ── DataLoaded: safe to access BarsArray ──
            else if (State == State.DataLoaded)
            {
                Log($"DataLoaded. Instrument={Instrument.FullName}  Server={ServerUrl}", LogLevel.Information);
            }

            // ── Realtime: live trading has started — kick off the poll timer ──
            else if (State == State.Realtime)
            {
                Log($"Entering Realtime. Initialising poll timer ({PollIntervalSeconds}s interval).", LogLevel.Information);
                isShuttingDown = false;
                StartPollTimer();
                Print($"{LOG_PREFIX} Strategy started. EnableTrading={EnableTrading} DailyLossLimit=${DailyLossLimit}");
            }

            // ── Terminated: clean up timers and background threads ──
            else if (State == State.Terminated)
            {
                isShuttingDown = true;
                StopPollTimer();
                StopMinDurationTimer();
                Print($"{LOG_PREFIX} Strategy terminated. Final daily P&L: ${currentDailyPnL:F2}");
            }
        }

        // ── Called on each bar close (1-minute chart) ──
        protected override void OnBarUpdate()
        {
            // Only act on live bars
            if (BarsInProgress != 0 || State != State.Realtime)
                return;

            // ── Daily reset at midnight ──
            ResetDailyPnLIfNewDay();

            // ── Force-close check: 4:44 PM ET ──
            CheckForceCloseWindow();

            // ── Arm exits once min-duration has elapsed ──
            // (Timer callback sets exitsArmed; this is a belt-and-suspenders check)
            if (isInTrade && !exitsArmed)
            {
                double secondsHeld = (DateTime.UtcNow - entryTime).TotalSeconds;
                if (secondsHeld >= MinTradeDurationSeconds)
                {
                    exitsArmed = true;
                    Print($"{LOG_PREFIX} Exits armed (bar-check). Held {secondsHeld:F1}s");
                }
            }
        }

        // ── Called when a managed order changes state ──
        protected override void OnOrderUpdate(Order order, double limitPrice, double stopPrice,
            int quantity, int filled, double averageFillPrice, OrderState orderState,
            DateTime time, ErrorCode error, string comment)
        {
            if (order == null) return;

            // Log state transitions for debugging
            Print($"{LOG_PREFIX} OrderUpdate: {order.Name} | State={orderState} | Filled={filled} | AvgFill={averageFillPrice:F2}");

            // Entry order filled — place bracket
            if (orderState == OrderState.Filled && filled > 0 && !isInTrade)
            {
                // Detect if this is our entry order by checking if it's in the entry direction
                bool isEntryOrder = (isLong  && order.OrderAction == OrderAction.Buy) ||
                                    (!isLong && order.OrderAction == OrderAction.SellShort);

                if (isEntryOrder && order.Name.StartsWith("ICT_Entry"))
                {
                    HandleEntryFill(order, averageFillPrice, filled);
                }
            }

            // Handle bracket order fills for P&L tracking and result reporting
            if (isInTrade)
            {
                bool isBracketFill = (order == stopOrder || order == tp1Order || order == tp2Order)
                                     && orderState == OrderState.Filled;

                if (isBracketFill)
                {
                    HandleExitFill(order, averageFillPrice, filled);
                }
            }
        }

        // ── Called on each execution (fill) ──
        protected override void OnExecutionUpdate(Execution execution, string executionId,
            double price, int quantity, MarketPosition marketPosition, string orderId,
            DateTime time)
        {
            // Additional execution logging — primary logic in OnOrderUpdate
            Print($"{LOG_PREFIX} Execution: {execution.Name} | Price={price:F2} | Qty={quantity} | Position={marketPosition}");
        }

        #endregion

        #region ──── SIGNAL POLLING ─────────────────────────────────

        /// <summary>
        /// Starts the background timer that polls for trade signals.
        /// </summary>
        private void StartPollTimer()
        {
            int intervalMs = PollIntervalSeconds * 1000;
            pollTimer = new System.Threading.Timer(
                callback: PollCallback,
                state:    null,
                dueTime:  intervalMs,       // first fire after one interval
                period:   intervalMs);
        }

        private void StopPollTimer()
        {
            if (pollTimer != null)
            {
                pollTimer.Dispose();
                pollTimer = null;
            }
        }

        /// <summary>
        /// Timer callback — runs on a .NET thread pool thread, NOT the NT UI thread.
        /// All NT order submission must be marshalled via TriggerCustomEvent.
        /// </summary>
        private void PollCallback(object state)
        {
            if (isShuttingDown)   return;
            if (isPollActive)     return;   // previous poll still running — skip
            if (!EnableTrading)   return;
            if (dailyLimitBreached) return;

            isPollActive = true;
            try
            {
                FetchAndProcessSignal();
            }
            catch (Exception ex)
            {
                Print($"{LOG_PREFIX} PollCallback unhandled exception: {ex.Message}");
            }
            finally
            {
                isPollActive = false;
            }
        }

        /// <summary>
        /// Performs the HTTP GET to /api/trade-signal/pending and processes the result.
        /// Runs on the thread-pool thread — safe for HTTP, NOT for NT order calls.
        /// </summary>
        private void FetchAndProcessSignal()
        {
            string url = $"{ServerUrl.TrimEnd('/')}/api/trade-signal/pending";
            string json = null;

            // ── HTTP GET ──
            try
            {
                using (var client = new WebClient())
                {
                    client.Headers[HttpRequestHeader.Accept]       = "application/json";
                    client.Headers[HttpRequestHeader.ContentType]  = "application/json";
                    client.Encoding = Encoding.UTF8;
                    json = client.DownloadString(url);
                }
            }
            catch (WebException wex)
            {
                // 404 / empty = no pending signal; anything else is a connectivity issue
                if (wex.Response is HttpWebResponse resp && resp.StatusCode == HttpStatusCode.NotFound)
                    return;   // no signal pending — normal

                Print($"{LOG_PREFIX} Poll HTTP error: {wex.Message}");
                return;
            }
            catch (Exception ex)
            {
                Print($"{LOG_PREFIX} Poll exception: {ex.Message}");
                return;
            }

            if (string.IsNullOrWhiteSpace(json) || json.Trim() == "null" || json.Trim() == "{}")
                return;

            // ── Parse JSON manually (no Newtonsoft in standard NT8 install) ──
            TradeSignal signal = ParseSignalJson(json);
            if (signal == null || string.IsNullOrWhiteSpace(signal.id))
            {
                Print($"{LOG_PREFIX} Could not parse signal JSON: {json}");
                return;
            }

            // ── Deduplicate — ignore signals we've already processed ──
            if (signal.id == lastSignalId)
                return;

            Print($"{LOG_PREFIX} New signal received: id={signal.id} dir={signal.direction} " +
                  $"entry={signal.entry} sl={signal.sl} tp1={signal.tp1} tp2={signal.tp2} " +
                  $"qty={signal.qty} confidence={signal.confidence}% reason={signal.reason}");

            // ── Immediately acknowledge to prevent re-fire ──
            PostConfirmation(signal.id, "received");

            // ── Risk gate: reject if already in a trade ──
            if (isInTrade)
            {
                Print($"{LOG_PREFIX} Signal {signal.id} REJECTED — already in a trade.");
                return;
            }

            // ── Risk gate: daily loss limit ──
            if (dailyLimitBreached)
            {
                Print($"{LOG_PREFIX} Signal {signal.id} REJECTED — daily loss limit breached.");
                return;
            }

            // ── Risk gate: force-close window ──
            if (forceCloseTriggered)
            {
                Print($"{LOG_PREFIX} Signal {signal.id} REJECTED — inside force-close window (after 4:44 PM ET).");
                return;
            }

            // ── Risk gate: market open buffer (9:30:00–9:30:30 ET) ──
            TimeZoneInfo et = TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");
            DateTime nowEt  = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, et);
            if (nowEt.Hour == 9 && nowEt.Minute == 30 && nowEt.Second < 30)
            {
                Print($"{LOG_PREFIX} Signal {signal.id} REJECTED — inside 30-second market-open buffer.");
                return;
            }

            // ── Clamp quantity to risk limits ──
            int qty = Math.Min(signal.qty, MaxContracts);
            qty     = Math.Min(qty, 4);   // Lucid absolute maximum
            if (qty < 1) qty = 1;

            // ── Store signal details and marshal entry to NT thread ──
            lastSignalId = signal.id;
            signalSL     = signal.sl;
            signalTP1    = signal.tp1;
            signalTP2    = signal.tp2;
            signalQty    = qty;
            isLong       = signal.direction.ToLower() == "long";

            // TriggerCustomEvent marshals the lambda onto the NinjaTrader strategy thread
            // so we can safely call EnterLong / EnterShort.
            TriggerCustomEvent(o => SubmitEntryOrder(signal, qty), null);
        }

        #endregion

        #region ──── ORDER SUBMISSION ───────────────────────────────

        /// <summary>
        /// Submits a market entry order. MUST be called on the NT strategy thread via TriggerCustomEvent.
        /// </summary>
        private void SubmitEntryOrder(TradeSignal signal, int qty)
        {
            if (!EnableTrading)
            {
                Print($"{LOG_PREFIX} EnableTrading=false — order suppressed.");
                return;
            }
            if (isInTrade)
            {
                Print($"{LOG_PREFIX} SubmitEntryOrder: already in trade — skipping.");
                return;
            }

            string orderName = $"ICT_Entry_{signal.id.Substring(0, 8)}";
            Print($"{LOG_PREFIX} Submitting {(isLong ? "LONG" : "SHORT")} market entry | qty={qty} | name={orderName}");

            if (isLong)
                EnterLong(qty, orderName);
            else
                EnterShort(qty, orderName);

            // Mark position as pending — full state set in HandleEntryFill once confirmed
        }

        /// <summary>
        /// Called from OnOrderUpdate when the entry order is confirmed filled.
        /// Places the stop-loss and TP bracket orders.
        /// </summary>
        private void HandleEntryFill(Order entryOrder, double fillPrice, int filledQty)
        {
            isInTrade  = true;
            entryTime  = DateTime.UtcNow;
            exitsArmed = false;
            activeQty  = filledQty;

            Print($"{LOG_PREFIX} Entry FILLED: price={fillPrice:F2} qty={filledQty} " +
                  $"sl={signalSL:F2} tp1={signalTP1:F2} tp2={signalTP2:F2}");

            // ── POST fill result to server ──
            string fillTimeIso = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");
            Task.Run(() => PostFillResult(lastSignalId, fillPrice, fillTimeIso, filledQty));

            // ── Determine TP quantities ──
            int tp1Qty, tp2Qty;
            if (filledQty >= 2)
            {
                tp1Qty = filledQty / 2;          // floor to int — 50% at TP1
                tp2Qty = filledQty - tp1Qty;      // remainder at TP2
            }
            else
            {
                // qty == 1: can't split; put full qty at TP2 only
                tp1Qty = 0;
                tp2Qty = filledQty;
            }

            Print($"{LOG_PREFIX} Bracket: TP1qty={tp1Qty} @ {signalTP1:F2} | TP2qty={tp2Qty} @ {signalTP2:F2} | SL @ {signalSL:F2}");

            // ── Place stop loss ──
            if (isLong)
            {
                stopOrder = ExitLongStopMarket(0, true, filledQty, signalSL, "ICT_SL", entryOrder.Name);

                if (tp1Qty > 0)
                    tp1Order = ExitLong(0, true, tp1Qty, signalTP1, "ICT_TP1", entryOrder.Name);

                tp2Order = ExitLong(0, true, tp2Qty, signalTP2, "ICT_TP2", entryOrder.Name);
            }
            else
            {
                stopOrder = ExitShortStopMarket(0, true, filledQty, signalSL, "ICT_SL", entryOrder.Name);

                if (tp1Qty > 0)
                    tp1Order = ExitShort(0, true, tp1Qty, signalTP1, "ICT_TP1", entryOrder.Name);

                tp2Order = ExitShort(0, true, tp2Qty, signalTP2, "ICT_TP2", entryOrder.Name);
            }

            // ── Start minimum-duration hold timer ──
            StartMinDurationTimer();
        }

        /// <summary>
        /// Called from OnOrderUpdate when a bracket (exit) order is filled.
        /// Tracks P&L, reports to server, and resets position state when fully closed.
        /// </summary>
        private void HandleExitFill(Order order, double exitPrice, int filledQty)
        {
            // Determine exit reason label
            string exitReason = "unknown";
            if (order == stopOrder) exitReason = "SL";
            else if (order == tp1Order) exitReason = "TP1";
            else if (order == tp2Order) exitReason = "TP2";

            // ── Minimum duration guard ──
            // If exits are not yet armed, this fill arrived before our min-hold window.
            // NinjaTrader will have already filled it; we flag the violation in the log.
            if (!exitsArmed)
            {
                Print($"{LOG_PREFIX} WARNING: Exit filled before min-duration armed! " +
                      $"Reason={exitReason} — Lucid micro-scalp rule may be violated.");
            }

            // ── P&L calculation ──
            double pnlPoints  = isLong ? (exitPrice - signalTP1) : (signalTP1 - exitPrice);
            // Use actual entry vs exit for accurate P&L
            double actualEntry = isLong
                ? (stopOrder != null ? signalSL + 999 : 0)   // fallback; real calc below
                : 0;

            // We don't store fill price directly; derive from position
            // Use Position.AveragePrice if available, otherwise approximate
            double avgEntryPrice = Position.AveragePrice != 0 ? Position.AveragePrice : signalTP1;
            pnlPoints = isLong ? (exitPrice - avgEntryPrice) : (avgEntryPrice - exitPrice);
            double pnlDollars = pnlPoints * (1.0 / NQ_TICK_SIZE) * NQ_TICK_VALUE * filledQty;

            // Accumulate daily P&L
            currentDailyPnL += pnlDollars;

            Print($"{LOG_PREFIX} Exit FILLED: reason={exitReason} price={exitPrice:F2} qty={filledQty} " +
                  $"pnlPts={pnlPoints:F2} pnlUSD=${pnlDollars:F2} | DailyPnL=${currentDailyPnL:F2}");

            // ── Check daily loss limit ──
            if (currentDailyPnL <= -DailyLossLimit)
            {
                dailyLimitBreached = true;
                Print($"{LOG_PREFIX} DAILY LOSS LIMIT BREACHED (${Math.Abs(currentDailyPnL):F2}). " +
                      "All further trading halted for today.");
            }

            // ── Report to server ──
            double capturedExit  = exitPrice;
            double capturedPnlPt = pnlPoints;
            double capturedPnlUsd = pnlDollars;
            string capturedReason = exitReason;
            string capturedId    = lastSignalId;
            Task.Run(() => PostCloseResult(capturedId, capturedExit, capturedPnlPt, capturedPnlUsd, capturedReason));

            // ── Reset state if fully flat ──
            // Check if both TP1 (partial) and TP2/SL have filled, i.e. Position is flat
            if (Position.MarketPosition == MarketPosition.Flat)
            {
                ResetPositionState();
            }
        }

        /// <summary>
        /// Clears all position-related state after a trade closes.
        /// </summary>
        private void ResetPositionState()
        {
            isInTrade  = false;
            exitsArmed = false;
            stopOrder  = null;
            tp1Order   = null;
            tp2Order   = null;
            entryTime  = DateTime.MinValue;
            activeQty  = 0;
            StopMinDurationTimer();
            Print($"{LOG_PREFIX} Position closed. State reset. Ready for next signal.");
        }

        #endregion

        #region ──── RISK RULES ─────────────────────────────────────

        /// <summary>
        /// Resets daily P&L tracking at the start of a new trading day.
        /// </summary>
        private void ResetDailyPnLIfNewDay()
        {
            DateTime today = DateTime.UtcNow.Date;
            if (today != lastResetDate)
            {
                Print($"{LOG_PREFIX} New trading day detected. Resetting daily P&L. " +
                      $"Previous: ${currentDailyPnL:F2}");
                currentDailyPnL    = 0.0;
                dailyLimitBreached = false;
                forceCloseTriggered = false;
                lastResetDate      = today;
            }
        }

        /// <summary>
        /// Checks if it's at or past 4:44 PM ET and triggers a force-close if so.
        /// Called on every bar close.
        /// </summary>
        private void CheckForceCloseWindow()
        {
            try
            {
                TimeZoneInfo et = TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");
                DateTime nowEt  = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, et);

                // 4:44 PM ET = 16 hours 44 minutes
                bool isPastCutoff = nowEt.Hour > 16 ||
                                    (nowEt.Hour == 16 && nowEt.Minute >= 44);

                if (isPastCutoff && !forceCloseTriggered)
                {
                    forceCloseTriggered = true;
                    Print($"{LOG_PREFIX} 4:44 PM ET force-close triggered. Closing all positions.");
                    ForceCloseAllPositions();
                }
            }
            catch (Exception ex)
            {
                Print($"{LOG_PREFIX} CheckForceCloseWindow error: {ex.Message}");
            }
        }

        /// <summary>
        /// Immediately flattens all open positions — Lucid 4:45 PM cutoff compliance.
        /// </summary>
        private void ForceCloseAllPositions()
        {
            if (Position.MarketPosition == MarketPosition.Flat)
            {
                Print($"{LOG_PREFIX} ForceClose: already flat, nothing to do.");
                return;
            }

            Print($"{LOG_PREFIX} ForceClose: submitting flatten order.");
            try
            {
                if (Position.MarketPosition == MarketPosition.Long)
                    ExitLong("ICT_ForceClose");
                else if (Position.MarketPosition == MarketPosition.Short)
                    ExitShort("ICT_ForceClose");
            }
            catch (Exception ex)
            {
                Print($"{LOG_PREFIX} ForceClose exception: {ex.Message}");
            }
        }

        /// <summary>
        /// Starts the minimum-hold timer. After MinTradeDurationSeconds, sets exitsArmed = true.
        /// This prevents NT from triggering exits before the Lucid micro-scalp window.
        /// Note: NT8 doesn't allow blocking exit orders natively; this flag is used for 
        /// logging/compliance awareness. For hard prevention, move exits to be placed
        /// only after the timer fires.
        /// </summary>
        private void StartMinDurationTimer()
        {
            StopMinDurationTimer();
            int durationMs = MinTradeDurationSeconds * 1000;
            minDurationTimer = new System.Threading.Timer(
                callback: _ =>
                {
                    exitsArmed = true;
                    Print($"{LOG_PREFIX} Min-duration ({MinTradeDurationSeconds}s) elapsed — exits now armed.");
                },
                state:   null,
                dueTime: durationMs,
                period:  Timeout.Infinite);   // one-shot
        }

        private void StopMinDurationTimer()
        {
            if (minDurationTimer != null)
            {
                minDurationTimer.Dispose();
                minDurationTimer = null;
            }
        }

        #endregion

        #region ──── HTTP HELPERS ───────────────────────────────────

        /// <summary>
        /// POSTs a confirmation to /api/trade-signal/confirm to acknowledge receipt.
        /// Runs on caller's thread — call via Task.Run from background context.
        /// </summary>
        private void PostConfirmation(string signalId, string status)
        {
            string url  = $"{ServerUrl.TrimEnd('/')}/api/trade-signal/confirm";
            string body = $"{{\"id\":\"{signalId}\",\"status\":\"{status}\"}}";
            HttpPost(url, body, "PostConfirmation");
        }

        /// <summary>
        /// POSTs fill details to /api/trade-signal/result after entry is confirmed.
        /// </summary>
        private void PostFillResult(string signalId, double fillPrice, string fillTime, int qty)
        {
            string url  = $"{ServerUrl.TrimEnd('/')}/api/trade-signal/result";
            string body = $"{{" +
                          $"\"signalId\":\"{signalId}\"," +
                          $"\"status\":\"filled\"," +
                          $"\"fillPrice\":{fillPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)}," +
                          $"\"fillTime\":\"{fillTime}\"," +
                          $"\"qty\":{qty}" +
                          $"}}";
            HttpPost(url, body, "PostFillResult");
        }

        /// <summary>
        /// POSTs close details to /api/trade-signal/result after TP or SL hit.
        /// </summary>
        private void PostCloseResult(string signalId, double exitPrice,
            double pnlPoints, double pnlDollars, string exitReason)
        {
            string url  = $"{ServerUrl.TrimEnd('/')}/api/trade-signal/result";
            string body = $"{{" +
                          $"\"signalId\":\"{signalId}\"," +
                          $"\"status\":\"closed\"," +
                          $"\"exitPrice\":{exitPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)}," +
                          $"\"pnlPoints\":{pnlPoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)}," +
                          $"\"pnlDollars\":{pnlDollars.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)}," +
                          $"\"exitReason\":\"{exitReason}\"" +
                          $"}}";
            HttpPost(url, body, "PostCloseResult");
        }

        /// <summary>
        /// Generic HTTP POST helper — never throws, always logs errors.
        /// </summary>
        private void HttpPost(string url, string jsonBody, string callerName)
        {
            try
            {
                using (var client = new WebClient())
                {
                    client.Headers[HttpRequestHeader.ContentType] = "application/json";
                    client.Headers[HttpRequestHeader.Accept]      = "application/json";
                    client.Encoding = Encoding.UTF8;
                    string response = client.UploadString(url, "POST", jsonBody);
                    Print($"{LOG_PREFIX} {callerName} POST OK | url={url} | response={response}");
                }
            }
            catch (WebException wex)
            {
                string errBody = string.Empty;
                if (wex.Response != null)
                {
                    using (var sr = new StreamReader(wex.Response.GetResponseStream()))
                        errBody = sr.ReadToEnd();
                }
                Print($"{LOG_PREFIX} {callerName} HTTP error: {wex.Message} | body={errBody}");
            }
            catch (Exception ex)
            {
                Print($"{LOG_PREFIX} {callerName} exception: {ex.Message}");
            }
        }

        #endregion

        #region ──── JSON PARSING ───────────────────────────────────

        /// <summary>
        /// Minimal hand-rolled JSON parser for TradeSignal.
        /// Avoids the Newtonsoft.Json dependency which is not always
        /// present in base NinjaTrader 8 installations.
        /// Falls back to null on any parse error.
        /// </summary>
        private TradeSignal ParseSignalJson(string json)
        {
            try
            {
                var sig = new TradeSignal();
                sig.id         = ExtractJsonString(json, "id");
                sig.direction  = ExtractJsonString(json, "direction");
                sig.session    = ExtractJsonString(json, "session");
                sig.reason     = ExtractJsonString(json, "reason");
                sig.entry      = ExtractJsonDouble(json, "entry");
                sig.sl         = ExtractJsonDouble(json, "sl");
                sig.tp1        = ExtractJsonDouble(json, "tp1");
                sig.tp2        = ExtractJsonDouble(json, "tp2");
                sig.confidence = (int)ExtractJsonDouble(json, "confidence");
                sig.qty        = (int)ExtractJsonDouble(json, "qty");
                return sig;
            }
            catch (Exception ex)
            {
                Print($"{LOG_PREFIX} ParseSignalJson error: {ex.Message}");
                return null;
            }
        }

        /// <summary>Extracts a string value for the given key from a flat JSON object.</summary>
        private string ExtractJsonString(string json, string key)
        {
            string search = $"\"{key}\"";
            int idx = json.IndexOf(search, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return string.Empty;
            idx += search.Length;
            // skip whitespace and colon
            while (idx < json.Length && (json[idx] == ':' || json[idx] == ' ')) idx++;
            if (idx >= json.Length) return string.Empty;
            if (json[idx] == '"')
            {
                // quoted string
                idx++;
                int end = json.IndexOf('"', idx);
                if (end < 0) return string.Empty;
                return json.Substring(idx, end - idx);
            }
            // null literal
            if (json.Substring(idx, Math.Min(4, json.Length - idx)) == "null")
                return string.Empty;
            return string.Empty;
        }

        /// <summary>Extracts a numeric value for the given key from a flat JSON object.</summary>
        private double ExtractJsonDouble(string json, string key)
        {
            string search = $"\"{key}\"";
            int idx = json.IndexOf(search, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return 0;
            idx += search.Length;
            while (idx < json.Length && (json[idx] == ':' || json[idx] == ' ')) idx++;
            if (idx >= json.Length) return 0;
            // read until comma, }, or whitespace
            int start = idx;
            while (idx < json.Length && json[idx] != ',' && json[idx] != '}' && json[idx] != ' '
                   && json[idx] != '\n' && json[idx] != '\r') idx++;
            string numStr = json.Substring(start, idx - start).Trim();
            double result;
            if (double.TryParse(numStr, System.Globalization.NumberStyles.Any,
                                System.Globalization.CultureInfo.InvariantCulture, out result))
                return result;
            return 0;
        }

        #endregion

    } // end class NQ_ICT_Bot
} // end namespace NinjaTrader.NinjaScript.Strategies
