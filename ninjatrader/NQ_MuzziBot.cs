// NQ_MuzziBot.cs — Execution strategy + chart drawings for NQ Analyst
// ─────────────────────────────────────────────────────────────────────
// Polls /api/trade-signal/pending every N seconds.
// When a signal arrives: enters Long or Short at market,
// sets Stop Loss and two Take Profit targets via OCO orders.
// Draws entry arrow, SL/TP lines, and status label on chart.
// Posts fill + close results back to /api/trade-signal/result.
//
// SETUP IN NINJATRADER:
//   1. Import this file via Tools → Import NinjaScript
//   2. Add as a STRATEGY (not indicator) on NQ1! or MNQM26 1-min chart
//   3. Set ServerUrl to https://nq-analyst-production.up.railway.app
//   4. Set account + qty in strategy parameters
//   5. Enable "Sim" account first — live account requires prop firm approval
//
// Pair with NQ_Confluence indicator for full ICT level overlays.
// ─────────────────────────────────────────────────────────────────────

#region Using declarations
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Collections.Generic;
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
    public class NQ_MuzziBot : Strategy
    {
        // ── Parameters ─────────────────────────────────────────────────────────
        [NinjaScriptProperty]
        [Display(Name = "Server URL", GroupName = "Server", Order = 1)]
        public string ServerUrl { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Poll Interval Sec", GroupName = "Server", Order = 2)]
        public int PollIntervalSec { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Contracts", GroupName = "Execution", Order = 3)]
        public int Qty { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Max Loss Pts", GroupName = "Execution", Order = 4)]
        public double MaxLossPts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Enable Trading", GroupName = "Execution", Order = 5)]
        public bool EnableTrading { get; set; }

        // ── State ──────────────────────────────────────────────────────────────
        private DateTime    lastPoll        = DateTime.MinValue;
        private bool        polling         = false;
        private object      pollLock        = new object();

        private string      activeSignalId  = null;
        private string      activeDirection = null;
        private double      activeEntry     = 0;
        private double      activeSL        = 0;
        private double      activeTp1       = 0;
        private double      activeTp2       = 0;
        private bool        tp1Hit          = false;
        private int         entryBar        = -1;       // bar index when trade was entered
        private int         tradeCount      = 0;        // rolling count for unique draw tag IDs

        private const string LONG_ENTRY   = "MuzziLong";
        private const string SHORT_ENTRY  = "MuzziShort";
        private const string SL_NAME      = "MuzziSL";
        private const string TP1_NAME     = "MuzziTP1";
        private const string TP2_NAME     = "MuzziTP2";

        // Drawing tag prefixes — unique per trade
        private string TagEntry  => $"MZ_Entry_{tradeCount}";
        private string TagSL     => $"MZ_SL_{tradeCount}";
        private string TagTP1    => $"MZ_TP1_{tradeCount}";
        private string TagTP2    => $"MZ_TP2_{tradeCount}";
        private string TagBE     => $"MZ_BE_{tradeCount}";
        private string TagStatus => "MZ_Status";

        // Colors
        private static readonly Brush BullGreen  = Brushes.Lime;
        private static readonly Brush BearRed    = Brushes.Red;
        private static readonly Brush SlColor    = Brushes.OrangeRed;
        private static readonly Brush Tp1Color   = Brushes.Yellow;
        private static readonly Brush Tp2Color   = Brushes.Cyan;
        private static readonly Brush BeColor    = Brushes.White;
        private static readonly Brush StatusIdle = Brushes.Gray;

        // ── Lifecycle ──────────────────────────────────────────────────────────
        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name                          = "NQ MuzziBot";
                Description                   = "Polls NQ Analyst Railway API, executes signals, draws on chart";
                Calculate                     = Calculate.OnBarClose;
                EntriesPerDirection           = 1;
                EntryHandling                 = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy  = true;
                ExitOnSessionCloseSeconds     = 30;
                IsFillLimitOnTouch            = false;
                IsInstantiatedOnEachOptimizationIteration = false;

                ServerUrl       = "https://nq-analyst-production.up.railway.app";
                PollIntervalSec = 5;
                Qty             = 1;
                MaxLossPts      = 25;
                EnableTrading   = true;
            }
            else if (State == State.Configure)
            {
                // no additional data series needed
            }
            else if (State == State.DataLoaded)
            {
                DrawStatusLabel("MUZZIBOT ONLINE | WAITING FOR SIGNAL", StatusIdle);
            }
            else if (State == State.Terminated)
            {
                if (activeSignalId != null)
                {
                    ThreadPool.QueueUserWorkItem(_ =>
                        HttpPost(ServerUrl + "/api/trade-signal/result",
                            $"{{\"id\":\"{activeSignalId}\",\"status\":\"cancelled\",\"reason\":\"strategy terminated\"}}"));
                }
                DrawStatusLabel("MUZZIBOT OFFLINE", SlColor);
            }
        }

        protected override void OnBarUpdate()
        {
            if (BarsInProgress != 0) return;

            // ── Poll for new signal ──────────────────────────────────────────────
            if (!polling && (DateTime.Now - lastPoll).TotalSeconds >= PollIntervalSec)
            {
                lastPoll = DateTime.Now;
                ThreadPool.QueueUserWorkItem(_ => PollAndExecute());
            }

            // ── Monitor open position for TP1/BE ────────────────────────────────
            if (activeSignalId != null && Position.MarketPosition != MarketPosition.Flat)
            {
                MonitorPosition();
            }

            // ── Detect external close or SL hit ─────────────────────────────────
            if (activeSignalId != null && Position.MarketPosition == MarketPosition.Flat)
            {
                OnPositionClosed();
            }
        }

        // ── Poll Railway for pending signal ───────────────────────────────
        // NQ_ICT_Signals posts to Railway /api/webhook -> evaluateSignal() -> pending queue
        // MuzziBot polls /api/trade-signal/pending every N seconds and executes.
        private void PollAndExecute()
        {
            lock (pollLock)
            {
                if (polling) return;
                polling = true;
            }

            try
            {
                if (activeSignalId != null) return;
                if (!EnableTrading)
                {
                    DrawStatusLabel("MUZZIBOT PAUSED | ENABLE TRADING OFF", SlColor);
                    return;
                }

                DrawStatusLabel("POLLING... " + DateTime.Now.ToString("HH:mm:ss"), StatusIdle);

                string railJson = HttpGet(ServerUrl + "/api/trade-signal/pending", 5000);
                if (string.IsNullOrEmpty(railJson) || railJson == "{}" || railJson.Contains("\"id\":null"))
                {
                    DrawStatusLabel("MUZZIBOT ONLINE | NO SIGNAL", StatusIdle);
                    return;
                }

                string rid        = GetString(railJson, "id");
                string rdirection = GetString(railJson, "direction");
                double rentry     = GetDouble(railJson, "entry");
                double rsl        = GetDouble(railJson, "sl");
                double rtp1       = GetDouble(railJson, "tp1");
                double rtp2       = GetDouble(railJson, "tp2");

                if (string.IsNullOrEmpty(rid) || string.IsNullOrEmpty(rdirection)) return;
                if (rentry <= 0) return;

                // Confirm receipt immediately
                HttpPost(ServerUrl + "/api/trade-signal/confirm",
                    $"{{\"id\":\"{rid}\",\"status\":\"filled\"}}");

                Print($"[MuzziBot] Railway signal: {rdirection.ToUpper()} @ {rentry:F2} | ID {rid}");
                ExecuteSignal(rid, rdirection, rentry, rsl, rtp1, rtp2);
            }
            catch (Exception ex)
            {
                Print($"[MuzziBot] PollAndExecute error: {ex.Message}");
            }
            finally
            {
                polling = false;
            }
        }

        // ── Shared entry execution (called from both internal queue and Railway) ──
        private void ExecuteSignal(string id, string direction, double entry,
            double sl, double tp1, double tp2)
        {
            // Enforce hard max loss
            if (direction == "long"  && (entry - sl) > MaxLossPts) sl = entry - MaxLossPts;
            if (direction == "short" && (sl - entry) > MaxLossPts) sl = entry + MaxLossPts;

            tradeCount++;
            activeSignalId  = id;
            activeDirection = direction;
            activeEntry     = entry;
            activeSL        = sl;
            activeTp1       = tp1;
            activeTp2       = tp2;
            tp1Hit          = false;
            entryBar        = CurrentBar;

            Print($"[MuzziBot] Executing: {direction.ToUpper()} @ {entry:F2} | SL {sl:F2} | TP1 {tp1:F2} | TP2 {tp2:F2} | ID {id}");

            bool isLong = direction == "long";
            DrawStatusLabel($"SIGNAL: {direction.ToUpper()} @ {entry:F2}", isLong ? BullGreen : BearRed);

            if (isLong)
            {
                Draw.ArrowUp(this, TagEntry, false, 0, Low[0] - 3 * TickSize, BullGreen);
                EnterLong(Qty, LONG_ENTRY);
            }
            else
            {
                Draw.ArrowDown(this, TagEntry, false, 0, High[0] + 3 * TickSize, BearRed);
                EnterShort(Qty, SHORT_ENTRY);
            }
        }

        // ── Entry filled — place bracket orders + draw SL/TP lines ─────────────
        protected override void OnExecutionUpdate(Execution execution, string executionId,
            double price, int quantity, MarketPosition marketPosition,
            string orderId, DateTime time)
        {
            if (execution.Order == null) return;
            string name = execution.Order.Name;

            // ── Entry filled ────────────────────────────────────────────────────
            if ((name == LONG_ENTRY || name == SHORT_ENTRY) && activeSignalId != null)
            {
                double fillPrice = execution.Price;
                Print($"[MuzziBot] Entry filled @ {fillPrice}");

                // Recalculate from actual fill price
                double sl  = activeDirection == "long" ? fillPrice - (activeEntry - activeSL)
                                                       : fillPrice + (activeSL - activeEntry);
                double tp1 = activeDirection == "long" ? fillPrice + (activeTp1 - activeEntry)
                                                       : fillPrice - (activeEntry - activeTp1);
                double tp2 = activeDirection == "long" ? fillPrice + (activeTp2 - activeEntry)
                                                       : fillPrice - (activeEntry - activeTp2);

                activeSL   = sl;
                activeTp1  = tp1;
                activeTp2  = tp2;
                entryBar   = CurrentBar;

                // Draw horizontal lines extending 50 bars (no extend.right to avoid clutter)
                DrawHLine(TagSL,  sl,  SlColor,  "SL");
                DrawHLine(TagTP1, tp1, Tp1Color, "TP1");
                DrawHLine(TagTP2, tp2, Tp2Color, "TP2");

                DrawStatusLabel($"IN TRADE: {activeDirection.ToUpper()} | ENTRY {fillPrice:F2} | SL {sl:F2} | TP2 {tp2:F2}",
                    activeDirection == "long" ? BullGreen : BearRed);

                if (activeDirection == "long")
                {
                    ExitLongStopMarket(0, true, Qty, sl,  SL_NAME,  LONG_ENTRY);
                    ExitLongLimit(0, true, Qty, tp2, TP2_NAME, LONG_ENTRY);
                }
                else
                {
                    ExitShortStopMarket(0, true, Qty, sl,  SL_NAME,  SHORT_ENTRY);
                    ExitShortLimit(0, true, Qty, tp2, TP2_NAME, SHORT_ENTRY);
                }

                HttpPost(ServerUrl + "/api/trade-signal/result",
                    $"{{\"id\":\"{activeSignalId}\",\"status\":\"filled\",\"fillPrice\":{fillPrice}}}");
            }

            // ── TP2 hit ─────────────────────────────────────────────────────────
            if (name == TP2_NAME && activeSignalId != null)
            {
                double pnlPts = activeDirection == "long"
                    ? execution.Price - activeEntry
                    : activeEntry - execution.Price;

                Print($"[MuzziBot] TP2 hit @ {execution.Price} | PnL: {pnlPts:F2} pts");

                Draw.Text(this, $"MZ_Out_{tradeCount}", $"TP2 +{pnlPts:F1}",
                    0, execution.Price + 4 * TickSize, Tp2Color);

                DrawStatusLabel($"CLOSED TP2 +{pnlPts:F1} pts | WAITING FOR SIGNAL", Tp2Color);

                HttpPost(ServerUrl + "/api/trade-signal/result",
                    $"{{\"id\":\"{activeSignalId}\",\"status\":\"closed\",\"outcome\":\"TP2\"," +
                    $"\"exitPrice\":{execution.Price},\"pnlPts\":{pnlPts:F2}}}");

                RemoveTradeLines();
                ResetSignal();
            }

            // ── SL hit ──────────────────────────────────────────────────────────
            if (name == SL_NAME && activeSignalId != null)
            {
                double pnlPts = activeDirection == "long"
                    ? execution.Price - activeEntry
                    : activeEntry - execution.Price;

                Print($"[MuzziBot] SL hit @ {execution.Price} | PnL: {pnlPts:F2} pts");

                Draw.Text(this, $"MZ_Out_{tradeCount}", $"SL {pnlPts:F1}",
                    0, execution.Price - 4 * TickSize, SlColor);

                DrawStatusLabel($"STOPPED {pnlPts:F1} pts | WAITING FOR SIGNAL", SlColor);

                HttpPost(ServerUrl + "/api/trade-signal/result",
                    $"{{\"id\":\"{activeSignalId}\",\"status\":\"closed\",\"outcome\":\"STOPPED\"," +
                    $"\"exitPrice\":{execution.Price},\"pnlPts\":{pnlPts:F2}}}");

                RemoveTradeLines();
                ResetSignal();
            }
        }

        // ── Monitor for TP1 / move SL to BE ────────────────────────────────────
        private void MonitorPosition()
        {
            if (tp1Hit) return;

            bool tp1Reached = activeDirection == "long"
                ? Close[0] >= activeTp1
                : Close[0] <= activeTp1;

            if (tp1Reached)
            {
                tp1Hit = true;
                double beLevel = activeEntry + (activeDirection == "long" ? 1 : -1);
                Print($"[MuzziBot] TP1 hit @ {Close[0]:F2} — moving SL to BE {beLevel:F2}");

                // Move SL to breakeven
                if (activeDirection == "long")
                    ExitLongStopMarket(0, true, Qty, beLevel, SL_NAME, LONG_ENTRY);
                else
                    ExitShortStopMarket(0, true, Qty, beLevel, SL_NAME, SHORT_ENTRY);

                // Redraw SL line at BE level
                RemoveDrawObject(TagSL);
                DrawHLine(TagBE, beLevel, BeColor, "BE");

                // Mark TP1 hit on chart
                Draw.Diamond(this, $"MZ_TP1Hit_{tradeCount}", false, 0,
                    activeDirection == "long" ? activeTp1 + 2 * TickSize : activeTp1 - 2 * TickSize,
                    Tp1Color);

                DrawStatusLabel($"TP1 HIT — SL → BE {beLevel:F2} | RIDING TO TP2", Tp1Color);

                HttpPost(ServerUrl + "/api/trade-signal/result",
                    $"{{\"id\":\"{activeSignalId}\",\"status\":\"tp1_hit\",\"tp1Price\":{Close[0]:F2}}}");
            }
        }

        // ── Position went flat without our orders firing ─────────────────────────
        private void OnPositionClosed()
        {
            if (activeSignalId == null) return;

            Print($"[MuzziBot] Position closed externally — resetting");

            Draw.Text(this, $"MZ_Out_{tradeCount}", "CLOSED", 0, Close[0], StatusIdle);
            DrawStatusLabel("CLOSED EXTERNALLY | WAITING FOR SIGNAL", StatusIdle);

            HttpPost(ServerUrl + "/api/trade-signal/result",
                $"{{\"id\":\"{activeSignalId}\",\"status\":\"closed\",\"outcome\":\"EXTERNAL\"}}");

            RemoveTradeLines();
            ResetSignal();
        }

        // ── Drawing helpers ─────────────────────────────────────────────────────

        /// Draw a horizontal price line with a text label at bar 0 (current bar)
        private void DrawHLine(string tag, double price, Brush color, string label)
        {
            // Draw a horizontal ray from entryBar forward 50 bars
            int barsAgo = Math.Max(0, CurrentBar - entryBar);
            Draw.Line(this, tag, false, barsAgo, price, -50, price, color, DashStyleHelper.Dash, 1);
            Draw.Text(this, tag + "_lbl", label + " " + price.ToString("F2"),
                -48, price, color);
        }

        /// Status label — top right corner of price panel (uses TextFixed)
        private void DrawStatusLabel(string text, Brush color)
        {
            Draw.TextFixed(this, TagStatus, text, TextPosition.TopRight,
                color, new SimpleFont("Arial", 11), Brushes.Transparent, Brushes.Transparent, 0);
        }

        private void RemoveTradeLines()
        {
            RemoveDrawObject(TagSL);
            RemoveDrawObject(TagTP1);
            RemoveDrawObject(TagTP2);
            RemoveDrawObject(TagBE);
            RemoveDrawObject(TagSL  + "_lbl");
            RemoveDrawObject(TagTP1 + "_lbl");
            RemoveDrawObject(TagTP2 + "_lbl");
            RemoveDrawObject(TagBE  + "_lbl");
        }

        private void ResetSignal()
        {
            activeSignalId  = null;
            activeDirection = null;
            activeEntry     = 0;
            activeSL        = 0;
            activeTp1       = 0;
            activeTp2       = 0;
            tp1Hit          = false;
            entryBar        = -1;
        }

        // ── HTTP helpers ────────────────────────────────────────────────────────
        private string HttpGet(string url, int timeoutMs)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method  = "GET";
                req.Timeout = timeoutMs;
                req.Headers.Add("User-Agent", "NQ_MuzziBot/1.0");
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr   = new StreamReader(resp.GetResponseStream()))
                    return sr.ReadToEnd();
            }
            catch (Exception ex)
            {
                Print($"[MuzziBot] GET error ({url}): {ex.Message}");
                return null;
            }
        }

        private void HttpPost(string url, string jsonBody)
        {
            try
            {
                var req  = (HttpWebRequest)WebRequest.Create(url);
                req.Method      = "POST";
                req.ContentType = "application/json";
                req.Timeout     = 5000;
                req.Headers.Add("User-Agent", "NQ_MuzziBot/1.0");
                byte[] data = Encoding.UTF8.GetBytes(jsonBody);
                req.ContentLength = data.Length;
                using (var stream = req.GetRequestStream())
                    stream.Write(data, 0, data.Length);
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr   = new StreamReader(resp.GetResponseStream()))
                    sr.ReadToEnd();
            }
            catch (Exception ex)
            {
                Print($"[MuzziBot] POST error ({url}): {ex.Message}");
            }
        }

        // Minimal JSON field extractors (no Newtonsoft dependency)
        private double GetDouble(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\":", StringComparison.Ordinal);
            if (i < 0) return 0.0;
            int c = json.IndexOf(':', i) + 1;
            int e = c;
            while (e < json.Length && json[e] != ',' && json[e] != '}') e++;
            return double.TryParse(json.Substring(c, e - c).Trim(),
                System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out double d) ? d : 0.0;
        }

        private string GetString(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\":", StringComparison.Ordinal);
            if (i < 0) return null;
            int c = json.IndexOf('"', json.IndexOf(':', i) + 1) + 1;
            int e = json.IndexOf('"', c);
            return e > c ? json.Substring(c, e - c) : null;
        }
    }
}
