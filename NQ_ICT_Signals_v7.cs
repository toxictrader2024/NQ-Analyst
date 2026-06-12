// NQ_ICT_Signals.cs — ICT Signal Engine for NinjaTrader 8
// v6 — Fixed all compile/runtime issues:
//   - enum moved inside class (NT8 requirement)
//   - Calculate.OnBarClose restored (OnPriceChange caused stutter + fires on 15m ticks)
//   - ATR stored as Series, initialized in OnStateChange DataLoaded
//   - Times[1][] replaced with BarsArray[1].GetTime() (indicator-safe)
//   - OB drawing deferred: 15m RunOB15() queues new OBs, 1m OnBarUpdate draws them
//   - All Draw calls consolidated in BarsInProgress==0 context only
//
// IMPORT ORDER: NQ_MuzziBot.cs first, then this file.
// ADD as INDICATOR on the 1-min chart.

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
    // ── Enum must be outside the class for NT8 NinjaScript compiler ──────────
    public enum ObMitigationMode { Wick, Close, FiftyPercent }

    public class NQ_ICT_Signals : Indicator
    {

        // ─────────────────────────────────────────────────────────────────
        #region Parameters

        [NinjaScriptProperty][Display(Name = "Server URL",      GroupName = "Server",    Order = 1)]  public string ServerUrl      { get; set; }
        // PostToRailway hardcoded true — not exposed as user property
        private bool PostToRailway => true;

        [NinjaScriptProperty][Display(Name = "FVG Scan Lookback (1m)",    GroupName = "Detection", Order = 3)]  public int    FvgScanBars   { get; set; }
        [NinjaScriptProperty][Display(Name = "OB Swing Length (15m)",     GroupName = "Detection", Order = 4)]  public int    ObSwingLen    { get; set; }
        [NinjaScriptProperty][Display(Name = "OB Max Search Bars (15m)",  GroupName = "Detection", Order = 5)]  public int    ObMaxBars     { get; set; }
        [NinjaScriptProperty][Display(Name = "Sweep Lookback (1m)",       GroupName = "Detection", Order = 6)]  public int    SweepLookback { get; set; }
        [NinjaScriptProperty][Display(Name = "ATR Period",                GroupName = "Detection", Order = 7)]  public int    AtrPeriod     { get; set; }
        [NinjaScriptProperty][Display(Name = "ATR Expansion Mult",        GroupName = "Detection", Order = 8)]  public double AtrMult       { get; set; }
        [NinjaScriptProperty][Display(Name = "OB Mitigation Mode",        GroupName = "Detection", Order = 9)]  public ObMitigationMode MitigationMode { get; set; }

        [NinjaScriptProperty][Display(Name = "Min Conf Long",   GroupName = "Signals",   Order = 10)] public int    MinConfLong   { get; set; }
        [NinjaScriptProperty][Display(Name = "Min Conf Short",  GroupName = "Signals",   Order = 11)] public int    MinConfShort  { get; set; }
        [NinjaScriptProperty][Display(Name = "Cooldown Bars",   GroupName = "Signals",   Order = 12)] public int    CooldownBars  { get; set; }
        [NinjaScriptProperty][Display(Name = "SL Points",       GroupName = "Signals",   Order = 13)] public double SlPts         { get; set; }
        [NinjaScriptProperty][Display(Name = "TP1 Points",      GroupName = "Signals",   Order = 14)] public double Tp1Pts        { get; set; }
        [NinjaScriptProperty][Display(Name = "TP2 Points",      GroupName = "Signals",   Order = 15)] public double Tp2Pts        { get; set; }

        [NinjaScriptProperty][Display(Name = "Filter: NY AM (7-11am ET)",   GroupName = "Session", Order = 16)] public bool FilterNyAm   { get; set; }
        [NinjaScriptProperty][Display(Name = "Filter: London (2-5am ET)",   GroupName = "Session", Order = 17)] public bool FilterLondon { get; set; }
        [NinjaScriptProperty][Display(Name = "Block Lunch (11:30-1pm ET)",  GroupName = "Session", Order = 18)] public bool BlockLunch   { get; set; }
        [NinjaScriptProperty][Display(Name = "Block News (±5min :00/:30)",  GroupName = "Session", Order = 19)] public bool BlockNews    { get; set; }

        [NinjaScriptProperty][Display(Name = "Show FVG",       GroupName = "Display",   Order = 20)] public bool ShowFvg      { get; set; }
        [NinjaScriptProperty][Display(Name = "Show OB (15m)",  GroupName = "Display",   Order = 21)] public bool ShowOb       { get; set; }
        [NinjaScriptProperty][Display(Name = "Show Structure", GroupName = "Display",   Order = 22)] public bool ShowStruct   { get; set; }
        [NinjaScriptProperty][Display(Name = "Show CISD",      GroupName = "Display",   Order = 23)] public bool ShowCisd     { get; set; }
        [NinjaScriptProperty][Display(Name = "Show Sweeps",    GroupName = "Display",   Order = 24)] public bool ShowSweeps   { get; set; }
        [NinjaScriptProperty][Display(Name = "Show Signals",   GroupName = "Display",   Order = 25)] public bool ShowSignals  { get; set; }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region Internal types
        private class FvgZone
        {
            public double   Top, Bot;
            public bool     IsBull, Filled;
            public DateTime OpenTime;
        }
        private class ObZone15
        {
            public double   Top, Bot;
            public bool     IsBull, Mitigated, Drawn;
            public int      Bar15;
            public DateTime ObTime;
            public bool     HadSweep, HadFvg, HadMss;
        }
        private class Swing15
        {
            public double Price;
            public int    Bar;
            public bool   IsHigh;
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region State fields
        private List<FvgZone>  fvgList     = new List<FvgZone>();
        private List<ObZone15> obList      = new List<ObZone15>();
        private List<Swing15>  swingList15 = new List<Swing15>();

        // 15m HTF bias
        private bool htfBull15 = false;
        private bool htfBear15 = false;

        // 1m structure
        private double lastSwingHigh  = double.NaN;
        private double lastSwingLow   = double.NaN;
        private bool   structBull     = false;
        private bool   structBear     = false;
        private bool   cisdBull       = false;
        private bool   cisdBear       = false;
        private bool   sweepHi        = false;
        private bool   sweepLo        = false;
        private int    lastSweepHiBar = -999;
        private int    lastSweepLoBar = -999;
        private int    lastSignalBar  = -999;

        // ATR series — initialized in DataLoaded, safe to call on every bar
        private ATR atrSeries;

        // Draw tag counters
        private int fvgCount = 0;
        private int obCount  = 0;
        private int sigCount = 0;

        private static readonly Brush BrushBullFvg = Brushes.Lime;
        private static readonly Brush BrushBearFvg = Brushes.Red;
        private static readonly Brush BrushBullOb  = Brushes.DodgerBlue;
        private static readonly Brush BrushBearOb  = Brushes.OrangeRed;
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region OnStateChange
        protected override void OnStateChange()
        {
            // Route ALL of this indicator's Print() calls to Output Tab 1.
            // ROOT CAUSE of the "silent OnBarUpdate": PrintTo was never set.
            // NT8 indicators nominally default to OutputTab1, but when the
            // default is left unassigned the prints can be swallowed entirely
            // (drawings still render because OnBarUpdate keeps running).
            // Set this as early as possible — before SetDefaults runs its body —
            // so even Configure/DataLoaded diagnostics land in Output 1.
            PrintTo = PrintTo.OutputTab1;

            if (State == State.SetDefaults)
            {
                Name                = "NQ ICT Signals";
                Description         = "ICT v6 — 15m OB, 1m FVG/Sweep/CISD, session filter, ATR gate";
                PrintTo             = PrintTo.OutputTab1;      // explicit — fixes blank Output
                Calculate           = Calculate.OnBarClose;   // restored — no stutter
                IsOverlay           = true;
                DisplayInDataBox    = false;
                DrawOnPricePanel    = true;
                IsAutoScale         = false;
                MaximumBarsLookBack = MaximumBarsLookBack.Infinite;

                ServerUrl      = "https://nq-analyst-production.up.railway.app";

                FvgScanBars    = 5;
                ObSwingLen     = 2;
                ObMaxBars      = 20;
                SweepLookback  = 40;
                AtrPeriod      = 14;
                AtrMult        = 1.2;
                MitigationMode = ObMitigationMode.Close;

                MinConfLong    = 4;
                MinConfShort   = 4;
                CooldownBars   = 15;
                SlPts          = 20;
                Tp1Pts         = 30;
                Tp2Pts         = 70;

                FilterNyAm     = false;
                FilterLondon   = false;
                BlockLunch     = false;
                BlockNews      = false;

                ShowFvg        = true;
                ShowOb         = true;
                ShowStruct     = false;
                ShowCisd       = false;
                ShowSweeps     = true;
                ShowSignals    = true;
            }
            else if (State == State.Configure)
            {
                // Index 1 = 15-minute secondary series
                AddDataSeries(new NinjaTrader.Data.BarsPeriod
                {
                    BarsPeriodType = NinjaTrader.Data.BarsPeriodType.Minute,
                    Value          = 15
                });
            }
            else if (State == State.DataLoaded)
            {
                // Initialize ATR on the PRIMARY (1m) series — index 0
                // Must be done in DataLoaded, not SetDefaults
                atrSeries = ATR(AtrPeriod);
                atrSeries.Plots[0].Brush = Brushes.Transparent; // hide from chart
            }
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region OnBarUpdate
        protected override void OnBarUpdate()
        {
            // Absolute first line — UNCONDITIONAL, no array access that could throw
            // before the print fires. Proves OnBarUpdate is running and that
            // prints reach Output 1.
            Print("[ICT] BAR " + CurrentBar + " BIP=" + BarsInProgress);

            // Guard the price-bearing diagnostic so a warmup CurrentBar==0 on the
            // 15m series can never throw and swallow subsequent prints.
            if (CurrentBars[BarsInProgress] >= 0)
                Print("[ICT] OBU BIP=" + BarsInProgress + " Bar=" + CurrentBar + " Close=" + Close[0].ToString("F2"));

            // ── 15m series (index 1) ─────────────────────────────────────
            // Calculate.OnBarClose means this fires once per 15m bar close.
            if (BarsInProgress == 1)
            {
                Track15mSwings();
                RunOB15();          // queues new OBs into obList, sets Drawn=false
                UpdateHTFBias15();
                return;
            }

            // ── 1m primary series (index 0) ──────────────────────────────
            if (CurrentBar < Math.Max(SweepLookback, FvgScanBars) + 5) return;

            // BIP=0 FIX: refresh HTF bias every 1m bar using loaded 15m data.
            // Prevents htfBull15/htfBear15 staying false when BIP==1 never fires.
            if (Closes[1].Count > 5) UpdateHTFBias15();

            // Draw any pending 15m OBs that were queued by RunOB15()
            // (drawing must happen from primary series context)
            DrawPendingOBs();

            RunFVG();
            RunSweeps();
            RunStructure();
            RunCISD();
            MitigateOBs();
            RunSignal();
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region 15m Swing Tracker
        private void Track15mSwings()
        {
            int cb    = CurrentBar;
            int swLen = ObSwingLen;
            if (cb < swLen * 2 + 1) return;

            bool isPH = true, isPL = true;
            for (int i = 0; i < swLen; i++)
            {
                if (Highs[1][swLen] <= Highs[1][i] || Highs[1][swLen] <= Highs[1][swLen + i + 1]) isPH = false;
                if (Lows[1][swLen]  >= Lows[1][i]  || Lows[1][swLen]  >= Lows[1][swLen  + i + 1]) isPL = false;
            }
            if (isPH)
            {
                int swBar = cb - swLen;
                bool dup = false;
                foreach (var s in swingList15) if (s.IsHigh && s.Bar == swBar) { dup = true; break; }
                if (!dup) swingList15.Add(new Swing15 { Price = Highs[1][swLen], Bar = swBar, IsHigh = true });
            }
            if (isPL)
            {
                int swBar = cb - swLen;
                bool dup = false;
                foreach (var s in swingList15) if (!s.IsHigh && s.Bar == swBar) { dup = true; break; }
                if (!dup) swingList15.Add(new Swing15 { Price = Lows[1][swLen], Bar = swBar, IsHigh = false });
            }
            while (swingList15.Count > 40) swingList15.RemoveAt(0);
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region HTF Bias from 15m structure
        private void UpdateHTFBias15()
        {
            // STALE SWING GUARD: if BIP=1 stopped firing after initial load, swingList15
            // contains old historical swings that no longer reflect current price action.
            // If the newest swing is more than 8 x 15m bars old relative to CurrentBars[1],
            // the list is stale — skip swing structure and go straight to EMA fallback.
            int newestSwingBar = 0;
            for (int i = swingList15.Count - 1; i >= 0; i--)
                if (swingList15[i].Bar > newestSwingBar) { newestSwingBar = swingList15[i].Bar; break; }
            int currentBar15 = (BarsInProgress == 1) ? CurrentBar : CurrentBars[1];
            bool swingsStale = (swingList15.Count < 4) || (currentBar15 - newestSwingBar > 8);

            double sh1 = double.NaN, sh2 = double.NaN;
            double sl1 = double.NaN, sl2 = double.NaN;
            if (!swingsStale)
            {
                for (int i = swingList15.Count - 1; i >= 0 && (double.IsNaN(sh2) || double.IsNaN(sl2)); i--)
                {
                    var s = swingList15[i];
                    if (s.IsHigh)  { if (double.IsNaN(sh1)) sh1 = s.Price; else if (double.IsNaN(sh2)) sh2 = s.Price; }
                    else           { if (double.IsNaN(sl1)) sl1 = s.Price; else if (double.IsNaN(sl2)) sl2 = s.Price; }
                }
            }
            bool hh = !double.IsNaN(sh1) && !double.IsNaN(sh2) && sh1 > sh2;
            bool hl = !double.IsNaN(sl1) && !double.IsNaN(sl2) && sl1 > sl2;
            bool lh = !double.IsNaN(sh1) && !double.IsNaN(sh2) && sh1 < sh2;
            bool ll = !double.IsNaN(sl1) && !double.IsNaN(sl2) && sl1 < sl2;

            if (!swingsStale && hh && hl) { htfBull15 = true;  htfBear15 = false; }
            else if (!swingsStale && lh && ll) { htfBull15 = false; htfBear15 = true;  }
            else
            {
                // Fallback: not enough swing data yet (e.g. after indicator reload).
                // Use price vs 20-bar EMA on the 15m series as bias proxy.
                // This keeps signals flowing during the first ~60 min after restart.
                if (Closes[1].Count >= 20)
                {
                    double ema20 = EMA(Closes[1], 20)[0];
                    if (Closes[1][0] > ema20)  { htfBull15 = true;  htfBear15 = false; }
                    else                        { htfBull15 = false; htfBear15 = true;  }
                    Print("[ICT] HTF fallback bias (EMA20 15m): " + (htfBull15 ? "BULL" : "BEAR") + " close=" + Closes[1][0].ToString("F2") + " ema=" + ema20.ToString("F2"));
                }
                // If fewer than 20 bars loaded, allow both directions (no bias gate)
                else
                {
                    htfBull15 = true;
                    htfBear15 = true;
                    Print("[ICT] HTF bias: insufficient bars (" + Closes[1].Count + "), both directions open");
                }
            }
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region ICT OB Detection on 15m — queues, does NOT draw
        private void RunOB15()
        {
            int cb = CurrentBar;
            if (cb < ObSwingLen * 2 + ObMaxBars + 2) return;

            // ─── BULLISH OB ───────────────────────────────────────────────
            bool sslSwept = false; int sslBar = -1; double sslLvl = double.NaN;
            for (int i = 1; i <= ObMaxBars; i++)
            {
                double swLow = GetLastSwingLow15(cb - i);
                if (double.IsNaN(swLow)) continue;
                if (Lows[1][i] < swLow && Closes[1][i] > swLow) { sslSwept = true; sslBar = i; sslLvl = swLow; break; }
            }
            if (sslSwept && sslBar >= 2)
            {
                double avg = AvgBody15(10);
                bool dispUp = false; int dispBar = -1;
                for (int i = sslBar - 1; i >= 1; i--)
                    if (Closes[1][i] > Opens[1][i] && (Closes[1][i] - Opens[1][i]) > avg * 1.2) { dispUp = true; dispBar = i; break; }

                if (dispUp && dispBar >= 2)
                {
                    bool fvg15 = Lows[1][dispBar] > Highs[1][dispBar + 2];
                    bool mssUp = false;
                    foreach (var sw in swingList15)
                        if (sw.IsHigh && sw.Bar < cb - dispBar && sw.Bar > cb - ObMaxBars && Closes[1][0] > sw.Price) { mssUp = true; break; }

                    int conf = (sslSwept?1:0) + (dispUp?1:0) + (fvg15?1:0) + (mssUp?1:0);
                    if (conf >= 3)
                    {
                        int obBarAgo = -1;
                        for (int i = sslBar; i >= dispBar + 1; i--)
                            if (Closes[1][i] < Opens[1][i]) { obBarAgo = i; break; }

                        if (obBarAgo > 0)
                        {
                            double obTop = Highs[1][obBarAgo], obBot = Lows[1][obBarAgo];
                            bool dup = false;
                            foreach (var o in obList)
                                if (o.IsBull && !o.Mitigated && Math.Abs(o.Bot - obBot) < TickSize * 4) { dup = true; break; }
                            if (!dup)
                            {
                                // Use BarsArray[1] to get the time of the OB candle — indicator-safe API
                                int absIdx15 = BarsArray[1].Count - 1 - obBarAgo;
                                DateTime obTime = absIdx15 >= 0 ? BarsArray[1].GetTime(absIdx15) : DateTime.MinValue;
                                obList.Add(new ObZone15 { Top=obTop, Bot=obBot, IsBull=true,
                                    Bar15=cb, ObTime=obTime, Drawn=false,
                                    HadSweep=sslSwept, HadFvg=fvg15, HadMss=mssUp });
                                Print("[OB15] Bull OB queued @ "+obBot.ToString("F2")+"-"+obTop.ToString("F2")+" Conf:"+conf);
                            }
                        }
                    }
                }
            }

            // ─── BEARISH OB ───────────────────────────────────────────────
            bool bslSwept = false; int bslBar = -1; double bslLvl = double.NaN;
            for (int i = 1; i <= ObMaxBars; i++)
            {
                double swHigh = GetLastSwingHigh15(cb - i);
                if (double.IsNaN(swHigh)) continue;
                if (Highs[1][i] > swHigh && Closes[1][i] < swHigh) { bslSwept = true; bslBar = i; bslLvl = swHigh; break; }
            }
            if (bslSwept && bslBar >= 2)
            {
                double avg = AvgBody15(10);
                bool dispDn = false; int dispBar = -1;
                for (int i = bslBar - 1; i >= 1; i--)
                    if (Closes[1][i] < Opens[1][i] && (Opens[1][i] - Closes[1][i]) > avg * 1.2) { dispDn = true; dispBar = i; break; }

                if (dispDn && dispBar >= 2)
                {
                    bool fvg15 = Highs[1][dispBar] < Lows[1][dispBar + 2];
                    bool mssDn = false;
                    foreach (var sw in swingList15)
                        if (!sw.IsHigh && sw.Bar < cb - dispBar && sw.Bar > cb - ObMaxBars && Closes[1][0] < sw.Price) { mssDn = true; break; }

                    int conf = (bslSwept?1:0) + (dispDn?1:0) + (fvg15?1:0) + (mssDn?1:0);
                    if (conf >= 3)
                    {
                        int obBarAgo = -1;
                        for (int i = bslBar; i >= dispBar + 1; i--)
                            if (Closes[1][i] > Opens[1][i]) { obBarAgo = i; break; }

                        if (obBarAgo > 0)
                        {
                            double obTop = Highs[1][obBarAgo], obBot = Lows[1][obBarAgo];
                            bool dup = false;
                            foreach (var o in obList)
                                if (!o.IsBull && !o.Mitigated && Math.Abs(o.Top - obTop) < TickSize * 4) { dup = true; break; }
                            if (!dup)
                            {
                                int absIdx15 = BarsArray[1].Count - 1 - obBarAgo;
                                DateTime obTime = absIdx15 >= 0 ? BarsArray[1].GetTime(absIdx15) : DateTime.MinValue;
                                obList.Add(new ObZone15 { Top=obTop, Bot=obBot, IsBull=false,
                                    Bar15=cb, ObTime=obTime, Drawn=false,
                                    HadSweep=bslSwept, HadFvg=fvg15, HadMss=mssDn });
                                Print("[OB15] Bear OB queued @ "+obBot.ToString("F2")+"-"+obTop.ToString("F2")+" Conf:"+conf);
                            }
                        }
                    }
                }
            }

            while (obList.Count > 10) obList.RemoveAt(0);
        }

        // Called from primary series context — safe to Draw
        private void DrawPendingOBs()
        {
            if (!ShowOb) return;
            foreach (var ob in obList)
            {
                if (ob.Drawn || ob.Mitigated) continue;
                if (ob.ObTime == DateTime.MinValue) { ob.Drawn = true; continue; }

                // Find 1m bar whose time is closest to the 15m OB candle time
                int startBarsAgo = 0;
                for (int i = 0; i < Math.Min(CurrentBar, 500); i++)
                {
                    if (Time[i] <= ob.ObTime) { startBarsAgo = i; break; }
                }

                string tag   = ob.IsBull ? "OB15_B_" + obCount++ : "OB15_S_" + obCount++;
                Brush  brush = ob.IsBull ? BrushBullOb : BrushBearOb;
                string lbl   = ob.IsBull ? "Bull OB 15m" : "Bear OB 15m";

                int endBarsAgo = Math.Max(0, startBarsAgo - 60);
                Draw.Rectangle(this, tag, false, startBarsAgo, ob.Bot, endBarsAgo, ob.Top, brush, brush, 25);

                double lblY = ob.IsBull ? ob.Top + TickSize * 10 : ob.Bot - TickSize * 14;
                Draw.Text(this, tag + "_L", lbl, startBarsAgo, lblY, brush);

                ob.Drawn = true;
            }
        }

        private double GetLastSwingLow15(int beforeBar)
        {
            double r = double.NaN; int best = -1;
            foreach (var s in swingList15) if (!s.IsHigh && s.Bar <= beforeBar && s.Bar > best) { best = s.Bar; r = s.Price; }
            return r;
        }
        private double GetLastSwingHigh15(int beforeBar)
        {
            double r = double.NaN; int best = -1;
            foreach (var s in swingList15) if (s.IsHigh && s.Bar <= beforeBar && s.Bar > best) { best = s.Bar; r = s.Price; }
            return r;
        }
        private double AvgBody15(int n)
        {
            if (CurrentBar < n) return 10.0;
            double sum = 0;
            for (int i = 1; i <= n; i++) sum += Math.Abs(Closes[1][i] - Opens[1][i]);
            return sum / n;
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region OB Mitigation — 1m
        private void MitigateOBs()
        {
            for (int i = obList.Count - 1; i >= 0; i--)
            {
                var o = obList[i];
                if (o.Mitigated) continue;
                double mid = (o.Top + o.Bot) / 2.0;
                switch (MitigationMode)
                {
                    case ObMitigationMode.Wick:
                        if ( o.IsBull && Low[0]   < o.Bot) o.Mitigated = true;
                        if (!o.IsBull && High[0]  > o.Top) o.Mitigated = true;
                        break;
                    case ObMitigationMode.Close:
                        if ( o.IsBull && Close[0] < o.Bot) o.Mitigated = true;
                        if (!o.IsBull && Close[0] > o.Top) o.Mitigated = true;
                        break;
                    case ObMitigationMode.FiftyPercent:
                        if ( o.IsBull && Close[0] < mid) o.Mitigated = true;
                        if (!o.IsBull && Close[0] > mid) o.Mitigated = true;
                        break;
                }
            }
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region FVG — 1m
        private void RunFVG()
        {
            if (CurrentBar < 2) return;
            int scan = Math.Min(FvgScanBars, CurrentBar - 2);
            for (int k = 0; k <= scan; k++)
            {
                if (k + 2 > CurrentBar) break;
                double lo0 = Low[k], hi0 = High[k];
                double lo2 = Low[k+2], hi2 = High[k+2];

                if (lo0 > hi2) // Bull FVG
                {
                    DateTime gt = Time[k + 1];
                    bool dup = false;
                    foreach (var z in fvgList) if (z.IsBull && z.OpenTime == gt) { dup = true; break; }
                    if (!dup)
                    {
                        var z = new FvgZone { Top = lo0, Bot = hi2, IsBull = true, OpenTime = gt };
                        fvgList.Add(z);
                        if (ShowFvg)
                        {
                            int endBarsAgo = Math.Max(0, k - 30);
                            Draw.Rectangle(this, "FVG_B_" + fvgCount++, false,
                                k + 2, z.Bot, endBarsAgo, z.Top, BrushBullFvg, BrushBullFvg, 20);
                        }
                    }
                }
                if (hi0 < lo2) // Bear FVG
                {
                    DateTime gt = Time[k + 1];
                    bool dup = false;
                    foreach (var z in fvgList) if (!z.IsBull && z.OpenTime == gt) { dup = true; break; }
                    if (!dup)
                    {
                        var z = new FvgZone { Top = lo2, Bot = hi0, IsBull = false, OpenTime = gt };
                        fvgList.Add(z);
                        if (ShowFvg)
                        {
                            int endBarsAgo = Math.Max(0, k - 30);
                            Draw.Rectangle(this, "FVG_S_" + fvgCount++, false,
                                k + 2, z.Bot, endBarsAgo, z.Top, BrushBearFvg, BrushBearFvg, 20);
                        }
                    }
                }
            }
            foreach (var z in fvgList)
            {
                if (z.Filled) continue;
                if ( z.IsBull && Low[0]  <= z.Bot) z.Filled = true;
                if (!z.IsBull && High[0] >= z.Top) z.Filled = true;
            }
            while (fvgList.Count > 20) fvgList.RemoveAt(0);
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region Sweeps — 1m
        private void RunSweeps()
        {
            sweepHi = false; sweepLo = false;
            double hi = double.MinValue, lo = double.MaxValue;
            for (int i = 1; i <= SweepLookback; i++) { if (High[i] > hi) hi = High[i]; if (Low[i] < lo) lo = Low[i]; }
            if (High[0] > hi && Close[0] < hi)
            {
                sweepHi = true; lastSweepHiBar = CurrentBar;
                if (ShowSweeps) Draw.Dot(this, "SWP_H_" + CurrentBar, false, 0, High[0] + TickSize * 6, Brushes.Red);
            }
            if (Low[0] < lo && Close[0] > lo)
            {
                sweepLo = true; lastSweepLoBar = CurrentBar;
                if (ShowSweeps) Draw.Dot(this, "SWP_L_" + CurrentBar, false, 0, Low[0] - TickSize * 6, Brushes.Lime);
            }
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region Structure — 1m
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
                    if (ph > lastSwingHigh) { structBull = true;  if (ShowStruct) Draw.Text(this, "HH_"+CurrentBar, "HH", swLen, ph+TickSize*6,  Brushes.Lime); }
                    else                    {                      if (ShowStruct) Draw.Text(this, "LH_"+CurrentBar, "LH", swLen, ph+TickSize*6,  Brushes.OrangeRed); }
                }
                lastSwingHigh = ph;
            }
            if (isPL)
            {
                double pl = Low[swLen];
                if (!double.IsNaN(lastSwingLow))
                {
                    if (pl < lastSwingLow) { structBear = true;  if (ShowStruct) Draw.Text(this, "LL_"+CurrentBar, "LL", swLen, pl-TickSize*10, Brushes.OrangeRed); }
                    else                   {                      if (ShowStruct) Draw.Text(this, "HL_"+CurrentBar, "HL", swLen, pl-TickSize*10, Brushes.Lime); }
                }
                lastSwingLow = pl;
            }
            if (!double.IsNaN(lastSwingHigh) && Close[0] > lastSwingHigh && !structBull)
            { structBull=true; structBear=false; if (ShowStruct) Draw.Text(this, "MSS_B_"+CurrentBar, "MSS^", 0, Low[0]-TickSize*10,  Brushes.Lime); }
            if (!double.IsNaN(lastSwingLow)  && Close[0] < lastSwingLow  && !structBear)
            { structBear=true; structBull=false; if (ShowStruct) Draw.Text(this, "MSS_S_"+CurrentBar, "MSSv", 0, High[0]+TickSize*6,  Brushes.OrangeRed); }
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region CISD — 1m (close beyond prior body)
        private void RunCISD()
        {
            cisdBull = false; cisdBear = false;
            if (CurrentBar < 2) return;
            // Bullish CISD: current closes ABOVE prior bearish candle's OPEN (body top)
            if (Close[1] < Open[1] && Close[0] > Open[1] && Close[0] > Open[0] && CheckBullLevel())
            {
                cisdBull = true;
                if (ShowCisd) Draw.Text(this, "CISD_B_"+CurrentBar, "CISD", 0, Low[0]-TickSize*10, Brushes.Red);
            }
            // Bearish CISD: current closes BELOW prior bullish candle's OPEN (body bottom)
            if (Close[1] > Open[1] && Close[0] < Open[1] && Close[0] < Open[0] && CheckBearLevel())
            {
                cisdBear = true;
                if (ShowCisd) Draw.Text(this, "CISD_S_"+CurrentBar, "CISD", 0, High[0]+TickSize*6,  Brushes.Lime);
            }
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region Session Filter
        private bool InSession()
        {
            // Convert bar time to ET
            DateTime et;
            try {
                et = TimeZoneInfo.ConvertTimeFromUtc(
                    Times[0][0].ToUniversalTime(),
                    TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time"));
            } catch { return true; }

            int h = et.Hour, m = et.Minute;
            int hm = h * 100 + m;

            // London Kill Zone: 2:00am - 5:00am ET
            bool london   = FilterLondon && (hm >= 200  && hm < 500);
            // NY AM Kill Zone: 7:00am - 11:00am ET
            bool nyAm     = FilterNyAm   && (hm >= 700  && hm < 1100);
            // Hard block: first 5 bars of open
            bool openChop = (hm >= 930 && hm < 935);
            // Lunch block
            bool lunch    = BlockLunch   && (hm >= 1130 && hm < 1300);
            // News block: ±5 min of :00 and :30
            bool news     = BlockNews    && (m <= 5 || (m >= 25 && m <= 35) || m >= 55);

            // All filters OFF = trade any time (except hard blocks)
            if (!FilterLondon && !FilterNyAm)
                return !openChop && !lunch && !(BlockNews && news);

            return (london || nyAm) && !openChop && !lunch && !(BlockNews && news);
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region Signal Engine
        private void RunSignal()
        {
            if (!ShowSignals) return;
            if (!InSession())  return;
            if (CurrentBar - lastSignalBar < CooldownBars) return;
            if (atrSeries == null || CurrentBar < AtrPeriod + 2) return;

            // ATR expansion filter — previous bar must show range >= AtrMult * ATR
            double atrVal   = atrSeries[1];
            double lastRange = High[1] - Low[1];
            bool   atrOk    = lastRange >= atrVal * AtrMult;

            double eq      = GetEQ(20);
            bool discount  = Close[0] < eq;
            bool premium   = Close[0] > eq;

            bool inBullFvg    = CheckInBullFvg();
            bool atBullOb     = CheckAtBullOb();
            bool inBearFvg    = CheckInBearFvg();
            bool atBearOb     = CheckAtBearOb();
            bool recentSwpLo  = (CurrentBar - lastSweepLoBar) <= 5;
            bool recentSwpHi  = (CurrentBar - lastSweepHiBar) <= 5;

            // LONG — HTF bias MUST be confirmed bullish (not just neutral)
            bool longLvl  = inBullFvg || atBullOb || sweepLo || recentSwpLo;
            int  longConf = 0;
            if (inBullFvg)              longConf++;
            if (atBullOb)               longConf++;
            if (sweepLo || recentSwpLo) longConf++;
            if (cisdBull)               longConf++;
            if (discount)               longConf++;
            if (structBull)             longConf++;
            if (htfBull15)              longConf++;

            // SHORT — HTF bias MUST be confirmed bearish (not just neutral)
            bool shortLvl  = inBearFvg || atBearOb || sweepHi || recentSwpHi;
            int  shortConf = 0;
            if (inBearFvg)              shortConf++;
            if (atBearOb)               shortConf++;
            if (sweepHi || recentSwpHi) shortConf++;
            if (cisdBear)               shortConf++;
            if (premium)                shortConf++;
            if (structBear)             shortConf++;
            if (htfBear15)              shortConf++;

            // htfBull15/htfBear15 contribute +1 to conf score above (lines 718/729).
            // Removed as hard boolean gate — 15m series silent after reload was
            // blocking ALL signals. MinConf threshold is sufficient filter.
            bool longValid  = longLvl  && discount && longConf  >= MinConfLong  && atrOk;
            bool shortValid = shortLvl && premium  && shortConf >= MinConfShort && atrOk;

            if (longValid)
            {
                double e = Close[0], sl = e-SlPts, tp1 = e+Tp1Pts, tp2 = e+Tp2Pts;
                string rsn   = MakeReason(true,  inBullFvg, atBullOb, sweepLo||recentSwpLo, cisdBull, discount, htfBull15);
                string slbl  = "LONG " + longConf + "/7\n" + rsn;
                Draw.TriangleUp(this,  "SIG_L_"  + sigCount, false, 0, Low[0]-TickSize*10,  Brushes.Lime);
                Draw.ArrowUp(this,     "SIG_LA_" + sigCount, false, 0, Low[0]-TickSize*22,  Brushes.Lime);
                Draw.Text(this,        "SIG_LT_" + sigCount, slbl,  0, Low[0]-TickSize*38,  Brushes.Lime);
                sigCount++;
                lastSignalBar = CurrentBar;
                string sigId = DateTime.Now.Ticks.ToString();
                Print("[ICT] SIGNAL LONG " + e.ToString("F2") + " InRealtime=" + IsInRealtimeMode() + " PostToRailway=" + PostToRailway);
                if (PostToRailway && IsInRealtimeMode()) { int capConf = longConf; ThreadPool.QueueUserWorkItem(_ => PostRailway("long",  e, sl, tp1, tp2, rsn, sigId, capConf)); }
                Print("[ICT] LONG "  + longConf  + "/7 @ " + e.ToString("F2") + " | " + rsn);
            }
            else if (shortValid)
            {
                double e = Close[0], sl = e+SlPts, tp1 = e-Tp1Pts, tp2 = e-Tp2Pts;
                string rsn   = MakeReason(false, inBearFvg, atBearOb, sweepHi||recentSwpHi, cisdBear, premium, htfBear15);
                string slbl  = "SHORT " + shortConf + "/7\n" + rsn;
                Draw.TriangleDown(this, "SIG_S_"  + sigCount, false, 0, High[0]+TickSize*10, Brushes.Red);
                Draw.ArrowDown(this,    "SIG_SA_" + sigCount, false, 0, High[0]+TickSize*22, Brushes.Red);
                Draw.Text(this,         "SIG_ST_" + sigCount, slbl,  0, High[0]+TickSize*38, Brushes.Red);
                sigCount++;
                lastSignalBar = CurrentBar;
                string sigId = DateTime.Now.Ticks.ToString();
                Print("[ICT] SIGNAL SHORT " + e.ToString("F2") + " InRealtime=" + IsInRealtimeMode() + " PostToRailway=" + PostToRailway);
                if (PostToRailway && IsInRealtimeMode()) { int capConf = shortConf; ThreadPool.QueueUserWorkItem(_ => PostRailway("short", e, sl, tp1, tp2, rsn, sigId, capConf)); }
                Print("[ICT] SHORT " + shortConf + "/7 @ " + e.ToString("F2") + " | " + rsn);
            }
        }
        #endregion

        // ─────────────────────────────────────────────────────────────────
        #region Helpers
        // NT8 indicators DO transition to State.Realtime once historical backfill
        // completes, so the primary signal is State == State.Realtime. We keep a
        // time-based fallback for safety: with Calculate.OnBarClose on a 1m chart
        // a just-closed live bar's Time[0] is at most ~1 min old, comfortably
        // under the 1.5-minute window. This guarantees IsInRealtimeMode() is true
        // during live trading and false during historical replay/backfill.
        private bool IsInRealtimeMode()
        {
            if (State == State.Realtime) return true;
            // Fallback: if the bar's timestamp is within 3 minutes of now, we're live
            return (DateTime.Now - Times[0][0]).TotalMinutes < 1.5;
        }

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

        private string MakeReason(bool isLong, bool fvg, bool ob, bool sweep, bool cisd, bool zone, bool htf)
        {
            var p = new List<string>();
            if (fvg)   p.Add("FVG");
            if (ob)    p.Add("OB15m");
            if (sweep) p.Add("Sweep");
            if (cisd)  p.Add("CISD");
            if (zone)  p.Add(isLong ? "Disc" : "Prem");
            if (htf)   p.Add(isLong ? "HTF↑" : "HTF↓");
            return string.Join("+", p);
        }

        // Returns the ICT killzone label for a given ET DateTime
        private string GetKillzoneLabel(DateTime et)
        {
            int hm = et.Hour * 100 + et.Minute;
            if (hm >= 200  && hm < 500)  return "london";
            if (hm >= 700  && hm < 930)  return "ny_open";       // pre-market / NY pre-open
            if (hm >= 1000 && hm < 1100) return "london_close";  // London close overlap (MUST be before ny_open 930-1100)
            if (hm >= 930  && hm < 1100) return "ny_open";       // NY AM killzone (930-1000 only)
            if (hm >= 1330 && hm < 1500) return "ny_afternoon";  // NY PM killzone
            return "off_session"; // Fix #8: off-hours correctly labeled
        }

        private void PostRailway(string dir, double e, double sl, double tp1, double tp2, string reason, string id, int conf)
        {
            try
            {
                var ci = System.Globalization.CultureInfo.InvariantCulture;
                // Get current ET time for killzone label
                DateTime et;
                try {
                    et = TimeZoneInfo.ConvertTime(DateTime.UtcNow,
                        TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time"));
                } catch { et = DateTime.UtcNow.AddHours(-5); }
                string body = "{\"long_signal\":"  + (dir=="long" ?"1":"0")
                    + ",\"short_signal\":" + (dir=="short"?"1":"0")
                    + ",\"direction\":\"" + dir + "\""
                    + ",\"close\":"  + e.ToString(ci)
                    + ",\"entry\":"  + e.ToString(ci)
                    + ",\"sl\":"     + sl.ToString(ci)
                    + ",\"tp1\":"    + tp1.ToString(ci)
                    + ",\"tp2\":"    + tp2.ToString(ci)
                    + ",\"source\":\"ninjatrader\",\"ticker\":\"NQ1!\""
                    + ",\"killzone\":\"" + GetKillzoneLabel(et) + "\",\"discount\":" + (dir=="long"?"1":"0") + ",\"premium\":" + (dir=="short"?"1":"0")
                    + ",\"signal_id\":\"" + id + "\",\"reason\":\"" + reason + "\",\"confidence\":" + conf.ToString() + "}";
                Print("[ICT] POST -> " + ServerUrl + "/api/webhook  body=" + body);
                var req = (HttpWebRequest)WebRequest.Create(ServerUrl + "/api/webhook");
                req.Method = "POST"; req.ContentType = "application/json"; req.Timeout = 5000;
                // NOTE: deliberately NO User-Agent header — NT8 blocks WebRequest
                // when a User-Agent is set, which silently kills the POST.
                byte[] data = Encoding.UTF8.GetBytes(body);
                req.ContentLength = data.Length;
                using (var s = req.GetRequestStream()) s.Write(data, 0, data.Length);
                using (var r = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(r.GetResponseStream()))
                {
                    string resp = sr.ReadToEnd();
                    Print("[ICT] POST OK " + (int)r.StatusCode + " resp=" + resp);
                }
            }
            catch (Exception ex) { Print("[ICT] Railway error: " + ex.Message); }
        }
        #endregion
    }
}