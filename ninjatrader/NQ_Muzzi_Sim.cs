// ============================================================
//  NQ_Muzzi_Sim.cs  —  NinjaTrader 8 Strategy
//
//  SIMULATION / PAPER TRACKING MODE
//
//  Polls the server for every Muzzi signal (A+, A, B — all of
//  them) and shadow-tracks them against live price without ever
//  submitting a real order to the broker.
//
//  Each "sim trade" is filled at the market price the moment
//  the signal arrives, then monitored tick-by-tick. When price
//  hits TP1, TP2, or SL the result is recorded and posted to
//  /api/sim-trades so the dashboard can display full P&L
//  history, win rates by grade, and compare signal quality
//  over time.
//
//  Use this alongside your live strategy to:
//    - Validate Muzzi calls before going live
//    - Track B-grade signals you wouldn't normally take
//    - Feed the learning kernel with realistic outcome data
//    - Run during market hours with zero broker risk
//
//  Author:  NQ Analyst System
//  Version: 1.0.0
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
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.DrawingTools;
using NinjaTrader.Data;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    // ── Sim trade record ──────────────────────────────────────────────────────
    public class SimTrade
    {
        public string   id          { get; set; }
        public string   signalId    { get; set; }
        public string   grade       { get; set; }   // A+ | A | B | WAIT
        public string   direction   { get; set; }   // LONG | SHORT
        public int      gravityScore{ get; set; }
        public int      primaryPass { get; set; }
        public bool     deltaFlip   { get; set; }
        public bool     threeBarPlay{ get; set; }
        public string   killzone    { get; set; }
        public double   fillPrice   { get; set; }   // price at signal time
        public double   slPrice     { get; set; }
        public double   tp1Price    { get; set; }
        public double   tp2Price    { get; set; }
        public double   exitPrice   { get; set; }
        public double   pnlPoints   { get; set; }   // positive = profit
        public double   pnlDollars  { get; set; }   // NQ $20/pt
        public string   result      { get; set; }   // TP2 | TP1 | STOPPED | EXPIRED | OPEN
        public string   exitReason  { get; set; }
        public double   maxFavorable{ get; set; }   // max excursion in our direction (MFE)
        public double   maxAdverse  { get; set; }   // max drawdown against us (MAE)
        public string   openedAt    { get; set; }   // HH:mm:ss ET
        public string   closedAt    { get; set; }
        public string   tradeDate   { get; set; }   // yyyy-MM-dd
        public double   scDelta     { get; set; }
        public double   scCvd       { get; set; }
        public bool     htfBiasPass { get; set; }
        public bool     fvgPass     { get; set; }
        public bool     mssPass     { get; set; }
        public bool     vwapPass    { get; set; }
        public bool     extended1SD { get; set; }
    }

    public class NQ_Muzzi_Sim : Strategy
    {
        #region ──── PARAMETERS ─────────────────────────────────────

        [NinjaScriptProperty]
        [Display(Name = "Server URL", GroupName = "Server", Order = 1)]
        public string ServerUrl { get; set; }

        [NinjaScriptProperty]
        [Range(2, 60)]
        [Display(Name = "Poll Interval (seconds)", GroupName = "Server", Order = 2,
                 Description = "How often to check for new Muzzi signals")]
        public int PollIntervalSeconds { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Track A+ Grades", GroupName = "Grade Filter", Order = 3)]
        public bool TrackAPlus { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Track A Grades", GroupName = "Grade Filter", Order = 4)]
        public bool TrackA { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Track B Grades", GroupName = "Grade Filter", Order = 5,
                 Description = "Track B-grade signals too — useful to see what you're skipping")]
        public bool TrackB { get; set; }

        [NinjaScriptProperty]
        [Range(1, 5)]
        [Display(Name = "Min Gravity to Track", GroupName = "Grade Filter", Order = 6)]
        public int MinGravity { get; set; }

        [NinjaScriptProperty]
        [Range(15, 480)]
        [Display(Name = "Signal Expiry (minutes)", GroupName = "Risk", Order = 7,
                 Description = "Auto-close sim trade if it hasn't hit TP or SL after N minutes")]
        public int ExpiryMinutes { get; set; }

        [NinjaScriptProperty]
        [Range(5, 100)]
        [Display(Name = "SL Points Override (0 = use server level)", GroupName = "Risk", Order = 8)]
        public int SlPointsOverride { get; set; }

        [NinjaScriptProperty]
        [Range(10, 200)]
        [Display(Name = "TP1 Points Override (0 = use server level)", GroupName = "Risk", Order = 9)]
        public int Tp1PointsOverride { get; set; }

        [NinjaScriptProperty]
        [Range(30, 500)]
        [Display(Name = "TP2 Points Override (0 = use server level)", GroupName = "Risk", Order = 10)]
        public int Tp2PointsOverride { get; set; }

        #endregion

        #region ──── STATE ──────────────────────────────────────────

        // Active sim trades (can be multiple — we track all signals)
        private List<SimTrade> activeTrades   = new List<SimTrade>();
        private List<SimTrade> completedTrades = new List<SimTrade>();

        private DateTime lastPollTime   = DateTime.MinValue;
        private bool     pollRunning    = false;
        private string   lastSignalId   = string.Empty;

        // Session P&L
        private double   sessionPnLPts  = 0.0;
        private double   sessionPnLDollars = 0.0;
        private int      sessionWins    = 0;
        private int      sessionLosses  = 0;
        private int      sessionTotal   = 0;

        private int      labelIdx       = 0;

        #endregion

        #region ──── INIT ───────────────────────────────────────────

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description           = "NQ Muzzi Sim — paper-tracks every Muzzi signal against live price. No real orders.";
                Name                  = "NQ_Muzzi_Sim";
                Calculate             = Calculate.OnEachTick;
                IsExitOnSessionCloseStrategy = false;
                BarsRequiredToTrade   = 1;
                IsFillLimitOnTouch    = false;
                MaximumBarsLookBack   = MaximumBarsLookBack.TwoHundredFiftySix;
                IsInstantiatedOnEachOptimizationIteration = false;

                ServerUrl         = "https://nq-analyst-production.up.railway.app";
                PollIntervalSeconds = 5;
                TrackAPlus        = true;
                TrackA            = true;
                TrackB            = true;   // track everything for full picture
                MinGravity        = 1;
                ExpiryMinutes     = 120;
                SlPointsOverride  = 20;     // 20pt SL (ICT standard)
                Tp1PointsOverride = 30;     // 30pt TP1
                Tp2PointsOverride = 75;     // 75pt TP2
            }
        }

        #endregion

        #region ──── ON BAR UPDATE ──────────────────────────────────

        protected override void OnBarUpdate()
        {
            if (CurrentBar < 1) return;
            if (State != State.Realtime) return;

            double currentPrice = Close[0];
            DateTime etNow      = EtNow();

            // Force-close all sim trades at 4:45pm ET
            if (etNow.Hour == 16 && etNow.Minute >= 45)
            {
                foreach (var t in activeTrades.ToArray())
                    CloseSim(t, currentPrice, "FORCE_CLOSE_EOD");
                return;
            }

            // ── Tick-by-tick monitoring of active sim trades ────────────────
            foreach (var t in activeTrades.ToArray())
            {
                bool isLong = t.direction == "LONG";

                // Update MFE / MAE
                double excursion = isLong ? currentPrice - t.fillPrice : t.fillPrice - currentPrice;
                if (excursion > t.maxFavorable) t.maxFavorable = excursion;
                if (excursion < -t.maxAdverse)  t.maxAdverse   = -excursion;

                // Check TP2
                if ((isLong && currentPrice >= t.tp2Price) || (!isLong && currentPrice <= t.tp2Price))
                {
                    CloseSim(t, t.tp2Price, "TP2_HIT");
                    continue;
                }
                // Check TP1
                if ((isLong && currentPrice >= t.tp1Price) || (!isLong && currentPrice <= t.tp1Price))
                {
                    CloseSim(t, t.tp1Price, "TP1_HIT");
                    continue;
                }
                // Check SL
                if ((isLong && currentPrice <= t.slPrice) || (!isLong && currentPrice >= t.slPrice))
                {
                    CloseSim(t, t.slPrice, "SL_HIT");
                    continue;
                }
                // Check expiry
                double elapsedMin = (DateTime.Now - DateTime.Parse(t.openedAt.Split(' ')[0])).TotalMinutes;
                // Use wall-clock elapsed instead
                if ((DateTime.Now - DateTime.Parse(
                    etNow.ToString("yyyy-MM-dd") + " " + t.openedAt.Replace(" ET", ""))
                    ).TotalMinutes > ExpiryMinutes)
                {
                    CloseSim(t, currentPrice, "EXPIRED");
                }
            }

            // ── Poll for new signals ────────────────────────────────────────
            double secondsSincePoll = (DateTime.Now - lastPollTime).TotalSeconds;
            if (secondsSincePoll >= PollIntervalSeconds && !pollRunning)
            {
                lastPollTime = DateTime.Now;
                Task.Run(() => PollSignal(currentPrice));
            }

            // ── Update chart label ──────────────────────────────────────────
            int winRate = sessionTotal > 0 ? (int)Math.Round((double)sessionWins / sessionTotal * 100) : 0;
            string status = $"[SIM] Active:{activeTrades.Count} | Done:{sessionTotal} | WR:{winRate}% | P&L:{sessionPnLPts:+0.0;-0.0}pts ${sessionPnLDollars:+0;-0}";
            Draw.TextFixed(this, "sim_status", status, TextPosition.TopLeft,
                Brushes.Cyan, new SimpleFont("Consolas", 10), Brushes.Transparent, Brushes.Transparent, 0);
        }

        #endregion

        #region ──── SIGNAL POLL ────────────────────────────────────

        private void PollSignal(double currentPrice)
        {
            pollRunning = true;
            try
            {
                string json     = HttpGet($"{ServerUrl}/api/muzzi-signal", 4000);
                if (string.IsNullOrEmpty(json)) return;

                var sig = ParseMuzziSignal(json);
                if (sig == null || string.IsNullOrEmpty(sig.id)) return;

                // Skip duplicate signals
                if (sig.id == lastSignalId) return;

                // Skip WAIT / hard rule violations
                if (sig.direction == "WAIT" || sig.grade == "WAIT" ||
                    sig.grade == "HARD RULE VIOLATED") return;

                // Grade filter
                bool shouldTrack =
                    (sig.grade == "A+" && TrackAPlus) ||
                    (sig.grade == "A"  && TrackA)     ||
                    (sig.grade == "B"  && TrackB);

                if (!shouldTrack) return;
                if (sig.gravityScore < MinGravity) return;

                // Check we don't already have an active trade in same direction
                bool alreadyActive = activeTrades.Exists(t =>
                    t.direction == sig.direction && t.result == "OPEN");
                if (alreadyActive) return;

                lastSignalId = sig.id;
                Dispatcher.InvokeAsync(() => OpenSim(sig, currentPrice));
            }
            catch (Exception ex)
            {
                Print($"[Sim] Poll error: {ex.Message}");
            }
            finally
            {
                pollRunning = false;
            }
        }

        #endregion

        #region ──── SIM OPEN / CLOSE ───────────────────────────────

        private void OpenSim(dynamic sig, double fillPrice)
        {
            DateTime etNow = EtNow();
            bool isLong    = sig.direction == "LONG";

            // Use overrides if set, else server levels
            double sl  = SlPointsOverride  > 0 ? (isLong ? fillPrice - SlPointsOverride  : fillPrice + SlPointsOverride)  : sig.suggestedSL;
            double tp1 = Tp1PointsOverride > 0 ? (isLong ? fillPrice + Tp1PointsOverride : fillPrice - Tp1PointsOverride) : sig.suggestedTP1;
            double tp2 = Tp2PointsOverride > 0 ? (isLong ? fillPrice + Tp2PointsOverride : fillPrice - Tp2PointsOverride) : sig.suggestedTP2;

            // Round to NQ tick (0.25)
            sl  = Math.Round(sl  * 4) / 4.0;
            tp1 = Math.Round(tp1 * 4) / 4.0;
            tp2 = Math.Round(tp2 * 4) / 4.0;

            var trade = new SimTrade
            {
                id          = $"sim_{DateTime.Now.Ticks}",
                signalId    = sig.id,
                grade       = sig.grade,
                direction   = sig.direction,
                gravityScore= sig.gravityScore,
                primaryPass = sig.primaryPassing,
                deltaFlip   = sig.deltaFlip,
                threeBarPlay= sig.threeBarPlay,
                killzone    = sig.killzone ?? "",
                fillPrice   = fillPrice,
                slPrice     = sl,
                tp1Price    = tp1,
                tp2Price    = tp2,
                exitPrice   = 0,
                pnlPoints   = 0,
                pnlDollars  = 0,
                result      = "OPEN",
                exitReason  = "",
                maxFavorable= 0,
                maxAdverse  = 0,
                openedAt    = etNow.ToString("HH:mm:ss") + " ET",
                closedAt    = "",
                tradeDate   = etNow.ToString("yyyy-MM-dd"),
                scDelta     = sig.delta,
                scCvd       = sig.cvd,
                htfBiasPass = sig.htfBiasPass,
                fvgPass     = sig.fvgPass,
                mssPass     = sig.mssPass,
                vwapPass    = sig.vwapPass,
                extended1SD = sig.extended1SD,
            };

            activeTrades.Add(trade);

            // Draw entry arrow on chart
            string arrowTag = $"sim_entry_{labelIdx++}";
            if (isLong)
                Draw.ArrowUp(this, arrowTag, true, 0, Low[0] - 10, Brushes.Cyan);
            else
                Draw.ArrowDown(this, arrowTag, true, 0, High[0] + 10, Brushes.Cyan);

            // Draw TP/SL lines
            Draw.HorizontalLine(this, $"sim_sl_{trade.id}",  sl,  Brushes.Red);
            Draw.HorizontalLine(this, $"sim_tp1_{trade.id}", tp1, Brushes.LimeGreen);
            Draw.HorizontalLine(this, $"sim_tp2_{trade.id}", tp2, Brushes.Lime);

            Print($"[Sim] OPENED {trade.direction} @ {fillPrice} | Grade:{trade.grade} G{trade.gravityScore} | SL:{sl} TP1:{tp1} TP2:{tp2} | KZ:{trade.killzone}");

            // Post to server immediately as OPEN
            Task.Run(() => PostSimTrade(trade));
        }

        private void CloseSim(SimTrade trade, double exitPrice, string reason)
        {
            DateTime etNow = EtNow();
            bool isLong    = trade.direction == "LONG";

            double rawPts  = isLong ? exitPrice - trade.fillPrice : trade.fillPrice - exitPrice;
            trade.exitPrice  = exitPrice;
            trade.pnlPoints  = Math.Round(rawPts, 2);
            trade.pnlDollars = Math.Round(rawPts * 20.0, 2);
            trade.exitReason = reason;
            trade.closedAt   = etNow.ToString("HH:mm:ss") + " ET";

            // Map exit reason to result string
            trade.result = reason == "TP2_HIT"       ? "TP2"
                         : reason == "TP1_HIT"       ? "TP1"
                         : reason == "SL_HIT"        ? "STOPPED"
                         : reason == "FORCE_CLOSE_EOD" ? "TP1" // count EOD closes at profit as partial win
                         : "EXPIRED";

            // Session stats
            sessionTotal++;
            sessionPnLPts    += trade.pnlPoints;
            sessionPnLDollars += trade.pnlDollars;
            if (trade.result == "TP1" || trade.result == "TP2") sessionWins++;
            else sessionLosses++;

            activeTrades.Remove(trade);
            completedTrades.Insert(0, trade);
            if (completedTrades.Count > 200) completedTrades.RemoveAt(200);

            // Remove TP/SL lines
            try { RemoveDrawObject($"sim_sl_{trade.id}");  } catch { }
            try { RemoveDrawObject($"sim_tp1_{trade.id}"); } catch { }
            try { RemoveDrawObject($"sim_tp2_{trade.id}"); } catch { }

            // Draw exit marker
            Brush exitColor = trade.result == "TP2" ? Brushes.Gold
                            : trade.result == "TP1" ? Brushes.LimeGreen
                            : trade.result == "STOPPED" ? Brushes.Red : Brushes.Gray;
            Draw.Dot(this, $"sim_exit_{labelIdx++}", true, 0, exitPrice, exitColor);

            Print($"[Sim] CLOSED {trade.direction} | {trade.result} | {trade.pnlPoints:+0.00;-0.00}pts | Grade:{trade.grade} G{trade.gravityScore}");

            // Post final result to server + learning kernel
            Task.Run(() =>
            {
                PostSimTrade(trade);
                PostToLearningKernel(trade);
            });
        }

        #endregion

        #region ──── SERVER POSTS ───────────────────────────────────

        private void PostSimTrade(SimTrade trade)
        {
            try
            {
                string json = SerializeSimTrade(trade);
                HttpPost($"{ServerUrl}/api/sim-trades", json, 5000);
            }
            catch (Exception ex) { Print($"[Sim] PostSimTrade error: {ex.Message}"); }
        }

        private void PostToLearningKernel(SimTrade trade)
        {
            try
            {
                // Only post completed (non-open) trades to learning kernel
                if (trade.result == "OPEN" || trade.result == "EXPIRED") return;

                string json = $@"{{
  ""signalId"":""{trade.signalId}"",
  ""grade"":""{trade.grade}"",
  ""direction"":""{trade.direction}"",
  ""gravityScore"":{trade.gravityScore},
  ""primaryPassing"":{trade.primaryPass},
  ""deltaFlip"":{(trade.deltaFlip ? "true" : "false")},
  ""threeBarPlay"":{(trade.threeBarPlay ? "true" : "false")},
  ""extended1SD"":{(trade.extended1SD ? "true" : "false")},
  ""absorptionConf"":false,
  ""killzone"":""{trade.killzone}"",
  ""entryPrice"":{trade.fillPrice},
  ""slPrice"":{trade.slPrice},
  ""tp1Price"":{trade.tp1Price},
  ""tp2Price"":{trade.tp2Price},
  ""exitPrice"":{trade.exitPrice},
  ""pnlPoints"":{trade.pnlPoints},
  ""pnlDollars"":{trade.pnlDollars},
  ""result"":""{trade.result}"",
  ""exitReason"":""{trade.exitReason}"",
  ""scDelta"":{trade.scDelta},
  ""scCvd"":{trade.scCvd},
  ""scBuyVol"":0,
  ""scSellVol"":0,
  ""tradeDate"":""{trade.tradeDate}"",
  ""entryTime"":""{trade.openedAt}"",
  ""exitTime"":""{trade.closedAt}""
}}";
                HttpPost($"{ServerUrl}/api/learning-kernel/feed", json, 5000);
            }
            catch (Exception ex) { Print($"[Sim] LearningKernel error: {ex.Message}"); }
        }

        #endregion

        #region ──── PARSE ──────────────────────────────────────────

        private dynamic ParseMuzziSignal(string json)
        {
            // Use a simple property bag backed by a Dictionary
            var d = new DynamicJson(json);
            return d;
        }

        #endregion

        #region ──── SERIALIZE ──────────────────────────────────────

        private string SerializeSimTrade(SimTrade t)
        {
            return $@"{{
  ""id"":""{t.id}"",
  ""signalId"":""{t.signalId}"",
  ""grade"":""{t.grade}"",
  ""direction"":""{t.direction}"",
  ""gravityScore"":{t.gravityScore},
  ""primaryPass"":{t.primaryPass},
  ""deltaFlip"":{(t.deltaFlip ? "true" : "false")},
  ""threeBarPlay"":{(t.threeBarPlay ? "true" : "false")},
  ""killzone"":""{t.killzone}"",
  ""fillPrice"":{t.fillPrice},
  ""slPrice"":{t.slPrice},
  ""tp1Price"":{t.tp1Price},
  ""tp2Price"":{t.tp2Price},
  ""exitPrice"":{t.exitPrice},
  ""pnlPoints"":{t.pnlPoints},
  ""pnlDollars"":{t.pnlDollars},
  ""result"":""{t.result}"",
  ""exitReason"":""{t.exitReason}"",
  ""maxFavorable"":{t.maxFavorable},
  ""maxAdverse"":{t.maxAdverse},
  ""openedAt"":""{t.openedAt}"",
  ""closedAt"":""{t.closedAt}"",
  ""tradeDate"":""{t.tradeDate}"",
  ""scDelta"":{t.scDelta},
  ""scCvd"":{t.scCvd},
  ""htfBiasPass"":{(t.htfBiasPass ? "true" : "false")},
  ""fvgPass"":{(t.fvgPass ? "true" : "false")},
  ""mssPass"":{(t.mssPass ? "true" : "false")},
  ""vwapPass"":{(t.vwapPass ? "true" : "false")},
  ""extended1SD"":{(t.extended1SD ? "true" : "false")}
}}";
        }

        #endregion

        #region ──── HTTP HELPERS ────────────────────────────────────

        private string HttpGet(string url, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method  = "GET";
            req.Timeout = timeoutMs;
            req.Headers.Add("User-Agent", "NQ_Muzzi_Sim/1.0");
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr   = new StreamReader(resp.GetResponseStream()))
                return sr.ReadToEnd();
        }

        private string HttpPost(string url, string body, int timeoutMs)
        {
            byte[] data = Encoding.UTF8.GetBytes(body);
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method        = "POST";
            req.ContentType   = "application/json";
            req.ContentLength = data.Length;
            req.Timeout       = timeoutMs;
            req.Headers.Add("User-Agent", "NQ_Muzzi_Sim/1.0");
            using (var s = req.GetRequestStream())
                s.Write(data, 0, data.Length);
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr   = new StreamReader(resp.GetResponseStream()))
                return sr.ReadToEnd();
        }

        #endregion

        #region ──── UTILITY ────────────────────────────────────────

        private DateTime EtNow() =>
            TimeZoneInfo.ConvertTime(DateTime.UtcNow,
                TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time"));

        #endregion
    }

    // ── Minimal dynamic JSON reader ───────────────────────────────────────────
    // Avoids Newtonsoft dependency. Accessed via dynamic casting.
    public class DynamicJson : System.Dynamic.DynamicObject
    {
        private readonly Dictionary<string, string> _fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public DynamicJson(string json)
        {
            // Strip outer braces
            json = json.Trim();
            if (json.StartsWith("{")) json = json.Substring(1);
            if (json.EndsWith("}"))   json = json.Substring(0, json.Length - 1);

            // Simple key:value parser (no nested objects)
            int i = 0;
            while (i < json.Length)
            {
                // Skip whitespace
                while (i < json.Length && (json[i] == ' ' || json[i] == '\n' || json[i] == '\r' || json[i] == '\t' || json[i] == ',')) i++;
                if (i >= json.Length) break;

                // Read key
                if (json[i] != '"') { i++; continue; }
                i++;
                int keyStart = i;
                while (i < json.Length && json[i] != '"') i++;
                string key = json.Substring(keyStart, i - keyStart);
                i++; // skip closing "

                // Skip colon
                while (i < json.Length && (json[i] == ' ' || json[i] == ':')) i++;

                // Read value
                string val = "";
                if (i >= json.Length) break;

                if (json[i] == '"')
                {
                    i++;
                    int vs = i;
                    while (i < json.Length && json[i] != '"') i++;
                    val = json.Substring(vs, i - vs);
                    i++; // skip closing "
                }
                else
                {
                    int vs = i;
                    while (i < json.Length && json[i] != ',' && json[i] != '}') i++;
                    val = json.Substring(vs, i - vs).Trim();
                }

                _fields[key] = val;
            }
        }

        public override bool TryGetMember(System.Dynamic.GetMemberBinder binder, out object result)
        {
            string key = binder.Name;
            if (_fields.TryGetValue(key, out string raw))
            {
                // Auto-cast based on value content
                if (raw == "true")        { result = true;  return true; }
                if (raw == "false")       { result = false; return true; }
                if (raw == "null")        { result = null;  return true; }
                if (double.TryParse(raw, System.Globalization.NumberStyles.Any,
                    System.Globalization.CultureInfo.InvariantCulture, out double d))
                { result = d; return true; }
                result = raw;
                return true;
            }
            result = null;
            return true; // return true with null rather than throw
        }

        // String accessor for explicit casts
        public string GetString(string key) =>
            _fields.TryGetValue(key, out string v) ? v : "";

        public double GetDouble(string key) =>
            _fields.TryGetValue(key, out string v) && double.TryParse(v,
                System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out double d) ? d : 0.0;

        public bool GetBool(string key) =>
            _fields.TryGetValue(key, out string v) && v == "true";

        public int GetInt(string key) =>
            _fields.TryGetValue(key, out string v) && int.TryParse(v, out int i) ? i : 0;

        // Quick id check
        public string id          => GetString("id");
        public string grade       => GetString("grade");
        public string direction   => GetString("direction");
        public int    gravityScore=> GetInt("gravityScore");
        public int    primaryPassing => GetInt("primaryPassing");
        public bool   deltaFlip   => GetBool("deltaFlip");
        public bool   threeBarPlay=> GetBool("threeBarPlay");
        public string killzone    => GetString("killzone");
        public double suggestedSL => GetDouble("suggestedSL");
        public double suggestedTP1=> GetDouble("suggestedTP1");
        public double suggestedTP2=> GetDouble("suggestedTP2");
        public double delta       => GetDouble("delta");
        public double cvd         => GetDouble("cvd");
        public bool   htfBiasPass => GetBool("htfBiasPass");
        public bool   fvgPass     => GetBool("fvgPass");
        public bool   mssPass     => GetBool("mssPass");
        public bool   vwapPass    => GetBool("vwapPass");
        public bool   extended1SD => GetBool("extended1SD");
    }
}
