// NQ_ICT_Signals.cs — ICT Signal Engine for NinjaTrader 8
// Detects FVG, OB, Sweeps, CISD, Structure natively.
// Writes signals to NQ_SignalQueue (static class in NQ_MuzziBot.cs).
// Also POSTs signals to Railway for dashboard logging.
//
// IMPORT ORDER: Import NQ_MuzziBot.cs FIRST, then this file.
// ADD as INDICATOR on same 1-min chart as NQ_MuzziBot strategy.

#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Media;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.DrawingTools;
using NinjaTrader.NinjaScript.Indicators;

#endregion

namespace NinjaTrader.NinjaScript.Indicators
{
    public class NQ_ICT_Signals : Indicator
    {
        #region Parameters
        [NinjaScriptProperty]
        [Display(Name = "Server URL", GroupName = "Server", Order = 1)]
        public string ServerUrl { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Post To Railway", GroupName = "Server", Order = 2)]
        public bool PostToRailway { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "FVG Lookback", GroupName = "Detection", Order = 3)]
        public int FvgLookback { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "OB Lookback", GroupName = "Detection", Order = 4)]
        public int ObLookback { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Sweep Lookback", GroupName = "Detection", Order = 5)]
        public int SweepLookback { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Min Conf Long", GroupName = "Signals", Order = 6)]
        public int MinConfLong { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Min Conf Short", GroupName = "Signals", Order = 7)]
        public int MinConfShort { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Cooldown Bars", GroupName = "Signals", Order = 8)]
        public int CooldownBars { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "SL Points", GroupName = "Signals", Order = 9)]
        public double SlPts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "TP1 Points", GroupName = "Signals", Order = 10)]
        public double Tp1Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "TP2 Points", GroupName = "Signals", Order = 11)]
        public double Tp2Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show FVG", GroupName = "Display", Order = 12)]
        public bool ShowFvg { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show OB", GroupName = "Display", Order = 13)]
        public bool ShowOb { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Structure", GroupName = "Display", Order = 14)]
        public bool ShowStruct { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show CISD", GroupName = "Display", Order = 15)]
        public bool ShowCisd { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Sweeps", GroupName = "Display", Order = 16)]
        public bool ShowSweeps { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Signals", GroupName = "Display", Order = 17)]
        public bool ShowSignals { get; set; }
        #endregion

        #region State fields
        private class FvgZone { public double Top, Bot; public bool IsBull, Filled; }
        private class ObZone  { public double Top, Bot; public bool IsBull, Mitigated; public int Bar; }

        private List<FvgZone> fvgList = new List<FvgZone>();
        private List<ObZone>  obList  = new List<ObZone>();

        private double lastSwingHigh = double.NaN;
        private double lastSwingLow  = double.NaN;
        private bool   structBull    = false;
        private bool   structBear    = false;
        private bool   cisdBull      = false;
        private bool   cisdBear      = false;
        private bool   sweepHi       = false;
        private bool   sweepLo       = false;
        private int    lastSweepHiBar = -999;
        private int    lastSweepLoBar = -999;
        private int    lastSignalBar  = -999;
        private string htfBias        = "neutral";
        private int    fvgCount       = 0;
        private int    obCount        = 0;
        private int    sigCount       = 0;
        private int    lastBullObBar  = -999;
        private int    lastBearObBar  = -999;

        private static readonly Brush BrushBullFvgBorder = Brushes.Lime;
        private static readonly Brush BrushBearFvgBorder = Brushes.Red;
        private static readonly Brush BrushBullObBorder  = Brushes.DodgerBlue;
        private static readonly Brush BrushBearObBorder  = Brushes.OrangeRed;
        #endregion

        #region OnStateChange
        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name                = "NQ ICT Signals";
                Description         = "ICT FVG OB Sweep CISD signal engine";
                Calculate           = Calculate.OnBarClose;
                IsOverlay           = true;
                DisplayInDataBox    = false;
                DrawOnPricePanel    = true;
                IsAutoScale         = false;
                MaximumBarsLookBack = MaximumBarsLookBack.Infinite;

                ServerUrl     = "https://nq-analyst-production.up.railway.app";
                PostToRailway = true;
                FvgLookback   = 3;
                ObLookback    = 10;
                SweepLookback = 40;
                MinConfLong   = 2;
                MinConfShort  = 2;
                CooldownBars  = 15;
                SlPts         = 15;
                Tp1Pts        = 20;
                Tp2Pts        = 40;
                ShowFvg       = true;
                ShowOb        = true;
                ShowStruct    = false;
                ShowCisd      = false;
                ShowSweeps    = true;
                ShowSignals   = true;
            }
        }
        #endregion

        #region OnBarUpdate
        protected override void OnBarUpdate()
        {
            if (CurrentBar < SweepLookback + 5) return;
            RunFVG();
            RunOB();
            RunSweeps();
            RunStructure();
            RunCISD();
            RunHTFBias();
            RunSignal();
        }
        #endregion

        #region FVG
        private void RunFVG()
        {
            if (CurrentBar < 2) return;

            // Bull FVG: gap up — Low[0] > High[2]
            if (Low[0] > High[2])
            {
                var z = new FvgZone { Top = Low[0], Bot = High[2], IsBull = true };
                fvgList.Add(z);
                if (ShowFvg)
                {
                    string t = "FVG_B_" + fvgCount++;
                    // Draw.Rectangle(owner, tag, isAutoScale, startBarsAgo, startY, endBarsAgo, endY, outlineBrush, areaBrush, areaOpacity)
                    Draw.Rectangle(this, t, false, 1, z.Bot, -(FvgLookback * 10), z.Top,
                        BrushBullFvgBorder, BrushBullFvgBorder, 20);
                }
            }

            // Bear FVG: gap down — High[0] < Low[2]
            if (High[0] < Low[2])
            {
                var z = new FvgZone { Top = Low[2], Bot = High[0], IsBull = false };
                fvgList.Add(z);
                if (ShowFvg)
                {
                    string t = "FVG_S_" + fvgCount++;
                    Draw.Rectangle(this, t, false, 1, z.Bot, -(FvgLookback * 10), z.Top,
                        BrushBearFvgBorder, BrushBearFvgBorder, 20);
                }
            }

            foreach (var z in fvgList)
            {
                if (z.Filled) continue;
                if (z.IsBull  && Low[0]  <= z.Bot) z.Filled = true;
                if (!z.IsBull && High[0] >= z.Top) z.Filled = true;
            }
            while (fvgList.Count > 12) fvgList.RemoveAt(0);
        }
        #endregion

        #region OB
        private void RunOB()
        {
            if (CurrentBar < ObLookback + 1) return;

            // Average range over lookback
            double avgRange = 0;
            for (int i = 1; i <= ObLookback; i++) avgRange += (High[i] - Low[i]);
            avgRange /= ObLookback;
            if (avgRange <= 0) return;

            // Require 3x avg range impulse AND at least 10 bars since last OB of same type
            double impulseUp   = Close[0] - Low[ObLookback];
            double impulseDown = High[ObLookback] - Close[0];

            // Bull OB: strong up close, last candle in the down leg before impulse
            if (impulseUp > avgRange * 3.0 && Close[0] > Open[0]
                && (CurrentBar - lastBullObBar) > 10)
            {
                // Find the last bearish candle within the lookback (the OB candle)
                for (int i = 1; i <= ObLookback; i++)
                {
                    if (Close[i] < Open[i] && High[i] == High[i]) // bearish candle
                    {
                        // Confirm: candle after it (i-1) closed higher (impulse started)
                        if (i > 1 && Close[i - 1] > High[i])
                        {
                            bool dup = false;
                            foreach (var o in obList)
                                if (Math.Abs(o.Top - High[i]) < TickSize * 4) { dup = true; break; }
                            if (!dup)
                            {
                                var o = new ObZone { Top = High[i], Bot = Low[i], IsBull = true, Bar = CurrentBar };
                                obList.Add(o);
                                lastBullObBar = CurrentBar;
                                if (ShowOb)
                                {
                                    string t = "OB_B_" + obCount++;
                                    Draw.Rectangle(this, t, false, i, o.Bot, -20, o.Top,
                                        BrushBullObBorder, BrushBullObBorder, 20);
                                    Draw.Text(this, t + "_L", "Bull OB", i, o.Top + TickSize * 4, BrushBullObBorder);
                                }
                            }
                            break;
                        }
                    }
                }
            }

            // Bear OB: strong down close, last bullish candle before impulse down
            if (impulseDown > avgRange * 3.0 && Close[0] < Open[0]
                && (CurrentBar - lastBearObBar) > 10)
            {
                for (int i = 1; i <= ObLookback; i++)
                {
                    if (Close[i] > Open[i]) // bullish candle
                    {
                        // Confirm: candle after it (i-1) closed lower (impulse started)
                        if (i > 1 && Close[i - 1] < Low[i])
                        {
                            bool dup = false;
                            foreach (var o in obList)
                                if (Math.Abs(o.Bot - Low[i]) < TickSize * 4) { dup = true; break; }
                            if (!dup)
                            {
                                var o = new ObZone { Top = High[i], Bot = Low[i], IsBull = false, Bar = CurrentBar };
                                obList.Add(o);
                                lastBearObBar = CurrentBar;
                                if (ShowOb)
                                {
                                    string t = "OB_S_" + obCount++;
                                    Draw.Rectangle(this, t, false, i, o.Bot, -20, o.Top,
                                        BrushBearObBorder, BrushBearObBorder, 20);
                                    Draw.Text(this, t + "_L", "Bear OB", i, o.Bot - TickSize * 8, BrushBearObBorder);
                                }
                            }
                            break;
                        }
                    }
                }
            }

            // Mitigate OBs price has traded into
            foreach (var o in obList)
            {
                if (o.Mitigated) continue;
                if (o.IsBull  && Low[0]  < o.Bot) o.Mitigated = true;
                if (!o.IsBull && High[0] > o.Top) o.Mitigated = true;
            }
            // Keep only 4 active OBs per side
            while (obList.Count > 8) obList.RemoveAt(0);
        }
        #endregion

        #region Sweeps
        private void RunSweeps()
        {
            sweepHi = false;
            sweepLo = false;
            double hi = double.MinValue, lo = double.MaxValue;
            for (int i = 1; i <= SweepLookback; i++)
            {
                if (High[i] > hi) hi = High[i];
                if (Low[i]  < lo) lo = Low[i];
            }
            if (High[0] > hi && Close[0] < hi)
            {
                sweepHi = true;
                lastSweepHiBar = CurrentBar;
                if (ShowSweeps)
                    // Draw.Dot(owner, tag, isAutoScale, barsAgo, y, brush)
                    Draw.Dot(this, "SWP_H_" + CurrentBar, false, 0, High[0] + TickSize * 6, Brushes.Red);
            }
            if (Low[0] < lo && Close[0] > lo)
            {
                sweepLo = true;
                lastSweepLoBar = CurrentBar;
                if (ShowSweeps)
                    Draw.Dot(this, "SWP_L_" + CurrentBar, false, 0, Low[0] - TickSize * 6, Brushes.Lime);
            }
        }
        #endregion

        #region Structure
        private void RunStructure()
        {
            int swLen = 5;
            if (CurrentBar < swLen * 2 + 1) return;

            bool isPH = true, isPL = true;
            for (int i = 0; i < swLen; i++)
            {
                if (High[swLen] <= High[i] || High[swLen] <= High[swLen + i + 1]) isPH = false;
                if (Low[swLen]  >= Low[i]  || Low[swLen]  >= Low[swLen  + i + 1]) isPL = false;
            }

            if (isPH)
            {
                double ph = High[swLen];
                if (!double.IsNaN(lastSwingHigh))
                {
                    if (ph > lastSwingHigh) { structBull = true; if (ShowStruct) Draw.Text(this, "HH_" + CurrentBar, "HH", swLen, ph + TickSize * 6, Brushes.Lime); }
                    else                    {                     if (ShowStruct) Draw.Text(this, "LH_" + CurrentBar, "LH", swLen, ph + TickSize * 6, Brushes.OrangeRed); }
                }
                lastSwingHigh = ph;
            }
            if (isPL)
            {
                double pl = Low[swLen];
                if (!double.IsNaN(lastSwingLow))
                {
                    if (pl < lastSwingLow) { structBear = true; if (ShowStruct) Draw.Text(this, "LL_" + CurrentBar, "LL", swLen, pl - TickSize * 10, Brushes.OrangeRed); }
                    else                   {                     if (ShowStruct) Draw.Text(this, "HL_" + CurrentBar, "HL", swLen, pl - TickSize * 10, Brushes.Lime); }
                }
                lastSwingLow = pl;
            }
            if (!double.IsNaN(lastSwingHigh) && Close[0] > lastSwingHigh && !structBull)
            { structBull = true; structBear = false; if (ShowStruct) Draw.Text(this, "MSS_B_" + CurrentBar, "MSS^", 0, Low[0] - TickSize * 10, Brushes.Lime); }
            if (!double.IsNaN(lastSwingLow) && Close[0] < lastSwingLow && !structBear)
            { structBear = true; structBull = false; if (ShowStruct) Draw.Text(this, "MSS_S_" + CurrentBar, "MSSv", 0, High[0] + TickSize * 6, Brushes.OrangeRed); }
        }
        #endregion

        #region CISD
        private void RunCISD()
        {
            cisdBull = false;
            cisdBear = false;
            if (CurrentBar < 2) return;
            if (Close[1] < Open[1] && Close[0] > Open[0] && CheckBullLevel())
            {
                cisdBull = true;
                if (ShowCisd) Draw.Text(this, "CISD_B_" + CurrentBar, "CISD", 0, Low[0] - TickSize * 10, Brushes.Red);
            }
            if (Close[1] > Open[1] && Close[0] < Open[0] && CheckBearLevel())
            {
                cisdBear = true;
                if (ShowCisd) Draw.Text(this, "CISD_S_" + CurrentBar, "CISD", 0, High[0] + TickSize * 6, Brushes.Lime);
            }
        }
        #endregion

        #region HTF Bias
        private void RunHTFBias()
        {
            double net = Close[0] - Close[Math.Min(15, CurrentBar - 1)];
            if      (structBull && net > 0) htfBias = "bullish";
            else if (structBear && net < 0) htfBias = "bearish";
            else                            htfBias = "neutral";
        }
        #endregion

        #region Signal Engine
        private void RunSignal()
        {
            if (!ShowSignals) return;
            if (CurrentBar - lastSignalBar < CooldownBars) return;
            double eq       = GetEQ(20);
            bool   discount = Close[0] < eq;
            bool   premium  = Close[0] > eq;

            bool inBullFvg     = CheckInBullFvg();
            bool atBullOb      = CheckAtBullOb();
            bool inBearFvg     = CheckInBearFvg();
            bool atBearOb      = CheckAtBearOb();
            bool recentSweepLo = (CurrentBar - lastSweepLoBar) <= 5;
            bool recentSweepHi = (CurrentBar - lastSweepHiBar) <= 5;

            // LONG
            bool htfLong    = htfBias != "bearish";
            bool longLevel  = inBullFvg || atBullOb || sweepLo || recentSweepLo;
            bool longZone   = htfLong && longLevel && discount;
            int  longConf   = (inBullFvg ? 1 : 0) + (atBullOb ? 1 : 0)
                            + ((sweepLo || recentSweepLo) ? 1 : 0)
                            + (cisdBull ? 1 : 0) + (discount ? 1 : 0) + (structBull ? 1 : 0);

            // SHORT
            bool htfShort   = htfBias != "bullish";
            bool shortLevel = inBearFvg || atBearOb || sweepHi || recentSweepHi;
            int  shortConf  = (inBearFvg ? 1 : 0) + (atBearOb ? 1 : 0)
                            + ((sweepHi || recentSweepHi) ? 1 : 0)
                            + (cisdBear ? 1 : 0);

            if (longZone && longConf >= MinConfLong)
            {
                double e = Close[0], sl = e - SlPts, tp1 = e + Tp1Pts, tp2 = e + Tp2Pts;
                string reason = MakeReason(true, inBullFvg, atBullOb, sweepLo || recentSweepLo, cisdBull, discount);
                if (ShowSignals)
                {
                    Draw.TriangleUp(this, "SIG_L_" + sigCount, false, 0, Low[0] - TickSize * 10, Brushes.Lime);
                    Draw.ArrowUp(this,   "SIG_LA_" + sigCount, false, 0, Low[0] - TickSize * 20, Brushes.Lime);
                    sigCount++;
                }
                lastSignalBar = CurrentBar;
                string sigIdL = DateTime.Now.Ticks.ToString();
                if (PostToRailway) ThreadPool.QueueUserWorkItem(_ => PostRailway("long", e, sl, tp1, tp2, reason, sigIdL));
                Print("[ICT] LONG @ " + e + " | " + reason);
            }
            else if (htfShort && shortLevel && shortConf >= MinConfShort)
            {
                double e = Close[0], sl = e + SlPts, tp1 = e - Tp1Pts, tp2 = e - Tp2Pts;
                string reason = MakeReason(false, inBearFvg, atBearOb, sweepHi || recentSweepHi, cisdBear, premium);
                if (ShowSignals)
                {
                    Draw.TriangleDown(this, "SIG_S_" + sigCount,  false, 0, High[0] + TickSize * 10, Brushes.Red);
                    Draw.ArrowDown(this,    "SIG_SA_" + sigCount, false, 0, High[0] + TickSize * 20, Brushes.Red);
                    sigCount++;
                }
                lastSignalBar = CurrentBar;
                string sigIdS = DateTime.Now.Ticks.ToString();
                if (PostToRailway) ThreadPool.QueueUserWorkItem(_ => PostRailway("short", e, sl, tp1, tp2, reason, sigIdS));
                Print("[ICT] SHORT @ " + e + " | " + reason);
            }
        }
        #endregion

        #region Helpers
        private bool CheckBullLevel() { return CheckInBullFvg() || CheckAtBullOb(); }
        private bool CheckBearLevel() { return CheckInBearFvg() || CheckAtBearOb(); }

        private bool CheckInBullFvg()
        {
            foreach (var z in fvgList)
                if (z.IsBull && !z.Filled && Low[0] <= z.Top && (Low[0] >= z.Bot || Close[0] >= z.Bot)) return true;
            return false;
        }
        private bool CheckInBearFvg()
        {
            foreach (var z in fvgList)
                if (!z.IsBull && !z.Filled && High[0] >= z.Bot && (High[0] <= z.Top || Close[0] <= z.Top)) return true;
            return false;
        }
        private bool CheckAtBullOb()
        {
            foreach (var o in obList)
                if (o.IsBull && !o.Mitigated && Low[0] <= o.Top && Close[0] >= o.Bot) return true;
            return false;
        }
        private bool CheckAtBearOb()
        {
            foreach (var o in obList)
                if (!o.IsBull && !o.Mitigated && High[0] >= o.Bot && Close[0] <= o.Top) return true;
            return false;
        }

        private double GetEQ(int len)
        {
            double hi = double.MinValue, lo = double.MaxValue;
            for (int i = 0; i < Math.Min(len, CurrentBar); i++)
            { if (High[i] > hi) hi = High[i]; if (Low[i] < lo) lo = Low[i]; }
            return (hi + lo) / 2.0;
        }

        private string MakeReason(bool isLong, bool fvg, bool ob, bool sweep, bool cisd, bool zone)
        {
            var p = new List<string>();
            if (fvg)   p.Add("FVG");
            if (ob)    p.Add("OB");
            if (sweep) p.Add("Sweep");
            if (cisd)  p.Add("CISD");
            if (zone)  p.Add(isLong ? "Discount" : "Premium");
            return string.Join("+", p);
        }

        private void PostRailway(string dir, double e, double sl, double tp1, double tp2, string reason, string id)
        {
            try
            {
                string body = "{\"long_signal\":" + (dir == "long" ? "1" : "0")
                    + ",\"short_signal\":" + (dir == "short" ? "1" : "0")
                    + ",\"close\":" + e.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + ",\"sl\":"   + sl.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + ",\"tp1\":" + tp1.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + ",\"tp2\":" + tp2.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + ",\"source\":\"ninjatrader\",\"ticker\":\"NQ1!\""
                    + ",\"signal_id\":\"" + id + "\",\"reason\":\"" + reason + "\"}";

                var req = (HttpWebRequest)WebRequest.Create(ServerUrl + "/api/webhook");
                req.Method = "POST"; req.ContentType = "application/json"; req.Timeout = 5000;
                byte[] data = Encoding.UTF8.GetBytes(body);
                req.ContentLength = data.Length;
                using (var s = req.GetRequestStream()) s.Write(data, 0, data.Length);
                using (var r = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(r.GetResponseStream())) sr.ReadToEnd();
            }
            catch (Exception ex) { Print("[ICT] Railway error: " + ex.Message); }
        }
        #endregion
    }
}
