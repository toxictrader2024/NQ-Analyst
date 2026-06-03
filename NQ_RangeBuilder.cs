#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Windows.Media;
using System.Xml.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.Gui.SuperDom;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.DrawingTools;
using NinjaTrader.Core.FloatingPoint;
#endregion

//
// NQ_RangeBuilder — Indicator 1 of 2
// Runs on 1-minute NQ chart (chart timezone = Eastern Time).
//
// Builds Asia range (6pm–2am ET), tracks PDH/PDL, calculates EQ /
// Premium / Discount zones, computes session VWAP ±2 SD, detects
// London sweeps, and exposes Plots + public properties for
// NQ_CK_Signals (Indicator 2).
//

namespace NinjaTrader.NinjaScript.Indicators
{
    public class NQ_RangeBuilder : Indicator
    {
        // ─────────────────────────────────────────────────────────────
        //  Private state — Asia range building
        // ─────────────────────────────────────────────────────────────
        private double  asiaHighRunning;
        private double  asiaLowRunning;
        private bool    inAsiaSession;          // 6pm ET → range locks
        private bool    asiaRangeLocked;

        private double  lockedAsiaHigh;
        private double  lockedAsiaLow;
        private double  lockedAsiaMid;

        // ATR for compression lock trigger
        private ATR     atrSeries;
        private int     atrPeriod  = 14;
        private int     compressionBarCount;    // consecutive bars below expansion threshold
        private const   int   CompressionBarsNeeded = 5;

        // Hard-lock time: 1:15 AM ET
        private static readonly TimeSpan AsiaStart      = new TimeSpan(18, 0, 0);   // 6:00 PM
        private static readonly TimeSpan AsiaLockHard   = new TimeSpan(1, 15, 0);   // 1:15 AM
        private static readonly TimeSpan AsiaEnd        = new TimeSpan(2, 0, 0);    // 2:00 AM
        private static readonly TimeSpan LondonStart    = new TimeSpan(2, 0, 0);    // 2:00 AM
        private static readonly TimeSpan LondonEnd      = new TimeSpan(5, 0, 0);    // 5:00 AM
        private static readonly TimeSpan RthOpen        = new TimeSpan(9, 30, 0);   // 9:30 AM
        private static readonly TimeSpan RthClose       = new TimeSpan(16, 0, 0);   // 4:00 PM

        // ─────────────────────────────────────────────────────────────
        //  Private state — PDH / PDL
        // ─────────────────────────────────────────────────────────────
        private double  currentPDH;
        private double  currentPDL;
        private double  rthSessionHigh;
        private double  rthSessionLow;
        private bool    inRthSession;

        // ─────────────────────────────────────────────────────────────
        //  Private state — VWAP
        // ─────────────────────────────────────────────────────────────
        private double  vwapSumPV;              // Σ (typicalPrice × volume)
        private double  vwapSumVol;             // Σ volume
        private double  vwapSumPV2;             // Σ (price² × volume) for variance
        private bool    vwapSessionActive;

        // ─────────────────────────────────────────────────────────────
        //  Private state — London sweeps
        // ─────────────────────────────────────────────────────────────
        private bool    londonSweptLow;
        private bool    londonSweptHigh;
        private bool    londonSweepLabelledLow;
        private bool    londonSweepLabelledHigh;

        // ─────────────────────────────────────────────────────────────
        //  Private state — session day tracking
        // ─────────────────────────────────────────────────────────────
        private int     currentSessionDay;      // tracks the "trading day" (date of 6pm open)
        private int     asiaRectStartBar;       // bar index when Asia session opened
        private int     lastPDHPDLDate;         // last date PDH/PDL was set (prevents double-set)

        // ─────────────────────────────────────────────────────────────
        //  Public properties consumed by Indicator 2
        // ─────────────────────────────────────────────────────────────
        [Browsable(false)]
        public bool   AsiaRangeLocked  { get; private set; }

        [Browsable(false)]
        public bool   LondonSweptLow   { get; private set; }

        [Browsable(false)]
        public bool   LondonSweptHigh  { get; private set; }

        [Browsable(false)]
        public double LockedAsiaHigh   { get; private set; }

        [Browsable(false)]
        public double LockedAsiaLow    { get; private set; }

        [Browsable(false)]
        public double LockedAsiaMid    { get; private set; }

        [Browsable(false)]
        public double CurrentPDH       { get; private set; }

        [Browsable(false)]
        public double CurrentPDL       { get; private set; }

        [Browsable(false)]
        public double DealingRangeEQ   { get; private set; }

        [Browsable(false)]
        public bool   PriceInPremium   { get; private set; }

        [Browsable(false)]
        public bool   PriceInDiscount  { get; private set; }

        // ─────────────────────────────────────────────────────────────
        //  Plot series indices (consumed by Indicator 2 via Values[n])
        //  0 = AsiaHigh | 1 = AsiaLow  | 2 = AsiaMid
        //  3 = PDH      | 4 = PDL
        //  5 = VWAP     | 6 = VWAP+2SD | 7 = VWAP-2SD
        // ─────────────────────────────────────────────────────────────

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description  = "CK Range Builder — Asia range, PDH/PDL, VWAP, London sweeps";
                Name         = "NQ_RangeBuilder";
                Calculate    = Calculate.OnBarClose;
                IsOverlay    = true;
                DisplayInDataBox    = true;
                DrawOnPricePanel    = true;
                DrawHorizontalGridLines = false;
                DrawVerticalGridLines   = false;
                PaintPriceMarkers   = false;
                ScaleJustification  = NinjaTrader.Gui.Chart.ScaleJustification.Right;
                IsSuspendedWhileInactive = true;

                // --- Plots ---
                // Plot 0: Asia High
                AddPlot(new Stroke(Brushes.Yellow, DashStyleHelper.Solid, 1),
                        PlotStyle.HLine, "AsiaHigh");
                // Plot 1: Asia Low
                AddPlot(new Stroke(Brushes.Yellow, DashStyleHelper.Solid, 1),
                        PlotStyle.HLine, "AsiaLow");
                // Plot 2: Asia Mid / EQ
                AddPlot(new Stroke(Brushes.Yellow, DashStyleHelper.Dash, 2),
                        PlotStyle.HLine, "AsiaMid");
                // Plot 3: PDH
                AddPlot(new Stroke(Brushes.Cyan, DashStyleHelper.Solid, 1),
                        PlotStyle.HLine, "PDH");
                // Plot 4: PDL
                AddPlot(new Stroke(Brushes.Magenta, DashStyleHelper.Solid, 1),
                        PlotStyle.HLine, "PDL");
                // Plot 5: VWAP
                AddPlot(new Stroke(Brushes.White, DashStyleHelper.Solid, 2),
                        PlotStyle.Line, "VWAP");
                // Plot 6: VWAP +2SD
                AddPlot(new Stroke(Brushes.LightBlue, DashStyleHelper.Dash, 1),
                        PlotStyle.Line, "VWAP_P2SD");
                // Plot 7: VWAP -2SD
                AddPlot(new Stroke(Brushes.LightCoral, DashStyleHelper.Dash, 1),
                        PlotStyle.Line, "VWAP_M2SD");
            }
            else if (State == State.DataLoaded)
            {
                // Initialise ATR on the primary series
                atrSeries = ATR(atrPeriod);

                // Initialise private fields
                asiaHighRunning     = double.MinValue;
                asiaLowRunning      = double.MaxValue;
                inAsiaSession       = false;
                asiaRangeLocked     = false;
                lockedAsiaHigh      = 0;
                lockedAsiaLow       = 0;
                lockedAsiaMid       = 0;

                currentPDH          = 0;
                currentPDL          = 0;
                rthSessionHigh      = double.MinValue;
                rthSessionLow       = double.MaxValue;
                inRthSession        = false;
                lastPDHPDLDate      = 0;

                vwapSumPV           = 0;
                vwapSumVol          = 0;
                vwapSumPV2          = 0;
                vwapSessionActive   = false;

                londonSweptLow      = false;
                londonSweptHigh     = false;
                londonSweepLabelledLow  = false;
                londonSweepLabelledHigh = false;

                currentSessionDay   = 0;
                asiaRectStartBar    = 0;

                compressionBarCount = 0;
            }
        }

        protected override void OnBarUpdate()
        {
            // Only operate on the primary data series (BarsInProgress == 0)
            if (BarsInProgress != 0) return;

            // Need at least atrPeriod bars to have a valid ATR
            if (CurrentBar < atrPeriod) return;

            // ── Determine current ET time ─────────────────────────────
            // NT8 bar Time[0] reflects chart timezone (must be set to ET)
            DateTime barTime   = Time[0];
            TimeSpan barTOD    = barTime.TimeOfDay;
            int      barDate   = ToDay(barTime);  // YYYYMMDD int

            // ─────────────────────────────────────────────────────────
            //  SESSION BOUNDARY — reset at 6pm ET
            // ─────────────────────────────────────────────────────────
            // A "trading day" starts at 6pm ET and runs to the following 6pm ET.
            // Determine session identifier: if after 6pm ET, the session day is today;
            // if midnight→6pm, the session day is yesterday (same trading day).
            // Use DateTime arithmetic to avoid YYYYMMDD subtraction bugs at month/year boundaries.
            int sessionId;
            if (barTOD >= AsiaStart)
            {
                sessionId = barDate;
            }
            else
            {
                // Bar is in the 12am–6pm window — belongs to yesterday's session
                DateTime yesterday = barTime.Date.AddDays(-1);
                sessionId = ToDay(yesterday);
            }

            if (sessionId != currentSessionDay)
            {
                // New trading day — capture prior RTH as PDH/PDL
                if (currentSessionDay != 0 && rthSessionHigh > double.MinValue && rthSessionLow < double.MaxValue)
                {
                    currentPDH = rthSessionHigh;
                    currentPDL = rthSessionLow;
                    CurrentPDH = currentPDH;
                    CurrentPDL = currentPDL;
                    DealingRangeEQ = (currentPDH + currentPDL) / 2.0;
                }

                // Reset for new session
                currentSessionDay   = sessionId;
                asiaHighRunning     = double.MinValue;
                asiaLowRunning      = double.MaxValue;
                inAsiaSession       = false;
                asiaRangeLocked     = false;
                AsiaRangeLocked     = false;
                lockedAsiaHigh      = 0;
                lockedAsiaLow       = 0;
                lockedAsiaMid       = 0;
                LockedAsiaHigh      = 0;
                LockedAsiaLow       = 0;
                LockedAsiaMid       = 0;
                compressionBarCount = 0;

                londonSweptLow      = false;
                londonSweptHigh     = false;
                LondonSweptLow      = false;
                LondonSweptHigh     = false;
                londonSweepLabelledLow  = false;
                londonSweepLabelledHigh = false;

                rthSessionHigh      = double.MinValue;
                rthSessionLow       = double.MaxValue;
                inRthSession        = false;

                vwapSumPV           = 0;
                vwapSumVol          = 0;
                vwapSumPV2          = 0;
                vwapSessionActive   = false;

                asiaRectStartBar    = CurrentBar;
            }

            // ─────────────────────────────────────────────────────────
            //  ASIA RANGE BUILDING (6pm → 2am ET)
            // ─────────────────────────────────────────────────────────
            bool inAsiaWindow = (barTOD >= AsiaStart) || (barTOD < AsiaEnd);

            if (inAsiaWindow && !asiaRangeLocked)
            {
                inAsiaSession = true;

                // Expand running high/low
                if (High[0] > asiaHighRunning) asiaHighRunning = High[0];
                if (Low[0]  < asiaLowRunning)  asiaLowRunning  = Low[0];

                // ── Hard-lock at 1:15 AM ET ───────────────────────
                if (barTOD >= AsiaLockHard && barTOD < AsiaEnd)
                {
                    LockAsiaRange(barTime);
                }
                else
                {
                    // ── ATR compression lock ──────────────────────
                    // Lock early when the bar range has contracted to < ATR × 0.05
                    // for CompressionBarsNeeded consecutive bars.
                    double barRange     = High[0] - Low[0];
                    double atrValue     = atrSeries[0];
                    if (atrValue > 0 && barRange < atrValue * 0.05)
                        compressionBarCount++;
                    else
                        compressionBarCount = 0;

                    if (compressionBarCount >= CompressionBarsNeeded)
                        LockAsiaRange(barTime);
                }
            }

            // If Asia window closed without lock, force lock now
            if (!asiaRangeLocked && inAsiaSession && barTOD >= AsiaEnd && barTOD < LondonEnd)
            {
                LockAsiaRange(barTime);
            }

            // ─────────────────────────────────────────────────────────
            //  RTH SESSION TRACKING (9:30am → 4pm ET) for PDH/PDL
            // ─────────────────────────────────────────────────────────
            bool isRthBar = barTOD >= RthOpen && barTOD < RthClose;

            if (isRthBar)
            {
                if (!inRthSession)
                {
                    inRthSession   = true;
                    rthSessionHigh = High[0];
                    rthSessionLow  = Low[0];
                }
                else
                {
                    if (High[0] > rthSessionHigh) rthSessionHigh = High[0];
                    if (Low[0]  < rthSessionLow)  rthSessionLow  = Low[0];
                }
            }
            else if (inRthSession && barTOD >= RthClose)
            {
                // RTH just closed — we'll promote to PDH/PDL on next session reset
                inRthSession = false;
            }

            // ─────────────────────────────────────────────────────────
            //  VWAP — anchor to 9:30am RTH open
            // ─────────────────────────────────────────────────────────
            if (isRthBar)
            {
                if (!vwapSessionActive)
                {
                    // First RTH bar — reset VWAP accumulators
                    vwapSumPV  = 0;
                    vwapSumVol = 0;
                    vwapSumPV2 = 0;
                    vwapSessionActive = true;
                }

                double tp  = (High[0] + Low[0] + Close[0]) / 3.0;
                double vol = Volume[0];

                vwapSumPV  += tp * vol;
                vwapSumVol += vol;
                vwapSumPV2 += tp * tp * vol;

                if (vwapSumVol > 0)
                {
                    double vwap     = vwapSumPV / vwapSumVol;
                    double variance = (vwapSumPV2 / vwapSumVol) - (vwap * vwap);
                    double sd       = variance > 0 ? Math.Sqrt(variance) : 0;

                    Values[5][0] = vwap;
                    Values[6][0] = vwap + 2.0 * sd;
                    Values[7][0] = vwap - 2.0 * sd;
                }
            }
            else if (!isRthBar && vwapSessionActive && barTOD >= RthClose)
            {
                vwapSessionActive = false;
            }

            // ─────────────────────────────────────────────────────────
            //  LONDON SWEEP DETECTION (2am–5am ET)
            // ─────────────────────────────────────────────────────────
            bool isLondon = barTOD >= LondonStart && barTOD < LondonEnd;

            if (isLondon && asiaRangeLocked)
            {
                // Sweep below Asia Low
                if (!londonSweptLow && Low[0] < lockedAsiaLow)
                {
                    londonSweptLow = true;
                    LondonSweptLow = true;
                }

                // Sweep above Asia High
                if (!londonSweptHigh && High[0] > lockedAsiaHigh)
                {
                    londonSweptHigh = true;
                    LondonSweptHigh = true;
                }
            }

            // ─────────────────────────────────────────────────────────
            //  POPULATE PLOT SERIES
            // ─────────────────────────────────────────────────────────
            if (asiaRangeLocked)
            {
                Values[0][0] = lockedAsiaHigh;
                Values[1][0] = lockedAsiaLow;
                Values[2][0] = lockedAsiaMid;
            }
            else if (inAsiaSession && asiaHighRunning > double.MinValue)
            {
                // Publish running values before lock
                Values[0][0] = asiaHighRunning;
                Values[1][0] = asiaLowRunning;
                Values[2][0] = (asiaHighRunning + asiaLowRunning) / 2.0;
            }

            if (currentPDH > 0) Values[3][0] = currentPDH;
            if (currentPDL > 0) Values[4][0] = currentPDL;

            // ─────────────────────────────────────────────────────────
            //  PUBLIC PROPERTY SYNC
            // ─────────────────────────────────────────────────────────
            if (currentPDH > 0 && currentPDL > 0)
            {
                DealingRangeEQ  = (currentPDH + currentPDL) / 2.0;
                PriceInPremium  = Close[0] > DealingRangeEQ;
                PriceInDiscount = Close[0] < DealingRangeEQ;
            }

            // ─────────────────────────────────────────────────────────
            //  DRAW CALLS  (must be inside BarsInProgress == 0 context,
            //               which is guaranteed by the early return above)
            // ─────────────────────────────────────────────────────────
            string dayTag = sessionId.ToString();

            // PDH / PDL horizontal lines
            if (currentPDH > 0)
            {
                Draw.HorizontalLine(this, "PDH_" + dayTag, currentPDH,
                    Brushes.Cyan, DashStyleHelper.Solid, 1);
                Draw.Text(this, "PDH_Label_" + dayTag, "PDH",
                    0, currentPDH + TickSize * 2, Brushes.Cyan);
            }

            if (currentPDL > 0)
            {
                Draw.HorizontalLine(this, "PDL_" + dayTag, currentPDL,
                    Brushes.Magenta, DashStyleHelper.Solid, 1);
                Draw.Text(this, "PDL_Label_" + dayTag, "PDL",
                    0, currentPDL - TickSize * 4, Brushes.Magenta);
            }

            // Premium / Discount zones (redraw every bar — last wins, no flicker)
            if (currentPDH > 0 && currentPDL > 0)
            {
                // Number of bars since session open (capped to available history)
                int barsBack = Math.Min(CurrentBar - asiaRectStartBar, CurrentBar);
                if (barsBack < 0) barsBack = 0;

                double eq = DealingRangeEQ;

                // Premium zone: EQ → PDH (semi-transparent red)
                Draw.Rectangle(this, "Premium_" + dayTag, false,
                    barsBack, currentPDH, 0, eq,
                    Brushes.Transparent, DashStyleHelper.Solid, 0,
                    Brushes.Red, 15);

                // Discount zone: PDL → EQ (semi-transparent green)
                Draw.Rectangle(this, "Discount_" + dayTag, false,
                    barsBack, eq, 0, currentPDL,
                    Brushes.Transparent, DashStyleHelper.Solid, 0,
                    Brushes.Lime, 15);

                // EQ line (bold dashed yellow)
                Draw.HorizontalLine(this, "EQ_" + dayTag, eq,
                    Brushes.Yellow, DashStyleHelper.Dash, 2);
                Draw.Text(this, "EQ_Label_" + dayTag, "EQ / THE SUN",
                    0, eq + TickSize * 2, Brushes.Yellow);
            }

            // Asia High / Low lines (only once locked)
            if (asiaRangeLocked)
            {
                Draw.HorizontalLine(this, "AsiaHi_" + dayTag, lockedAsiaHigh,
                    Brushes.Yellow, DashStyleHelper.Solid, 1);
                Draw.Text(this, "AsiaHi_Label_" + dayTag, "Asia High",
                    0, lockedAsiaHigh + TickSize * 2, Brushes.Yellow);

                Draw.HorizontalLine(this, "AsiaLo_" + dayTag, lockedAsiaLow,
                    Brushes.Yellow, DashStyleHelper.Solid, 1);
                Draw.Text(this, "AsiaLo_Label_" + dayTag, "Asia Low",
                    0, lockedAsiaLow - TickSize * 4, Brushes.Yellow);

                // Asia Mid / EQ of Asia Range
                Draw.HorizontalLine(this, "AsiaMid_" + dayTag, lockedAsiaMid,
                    Brushes.Yellow, DashStyleHelper.Dash, 1);
                Draw.Text(this, "AsiaMid_Label_" + dayTag, "Asia Mid",
                    0, lockedAsiaMid + TickSize * 2, Brushes.Yellow);

                // Asia rectangle shading
                int barsBackAsia = Math.Min(CurrentBar - asiaRectStartBar, CurrentBar);
                if (barsBackAsia < 0) barsBackAsia = 0;

                Draw.Rectangle(this, "AsiaRect_" + dayTag, false,
                    barsBackAsia, lockedAsiaHigh, 0, lockedAsiaLow,
                    Brushes.Yellow, DashStyleHelper.Solid, 1,
                    Brushes.Goldenrod, 10);
            }

            // London sweep labels
            if (londonSweptLow && !londonSweepLabelledLow)
            {
                londonSweepLabelledLow = true;
                Draw.Text(this, "LondonSweptLow_" + dayTag,
                    "London Swept Low → Look LONG in NY",
                    0, Low[0] - TickSize * 6, Brushes.LimeGreen);
            }

            if (londonSweptHigh && !londonSweepLabelledHigh)
            {
                londonSweepLabelledHigh = true;
                Draw.Text(this, "LondonSweptHigh_" + dayTag,
                    "London Swept High → Look SHORT in NY",
                    0, High[0] + TickSize * 6, Brushes.OrangeRed);
            }
        }

        // ─────────────────────────────────────────────────────────────
        //  LockAsiaRange — called when range is ready to lock
        // ─────────────────────────────────────────────────────────────
        private void LockAsiaRange(DateTime lockTime)
        {
            // lockTime is used for diagnostic output
            System.Diagnostics.Debug.WriteLine("[NQ_RangeBuilder] Asia range locked at " + lockTime.ToString("HH:mm"));
            if (asiaRangeLocked) return;
            if (asiaHighRunning <= double.MinValue || asiaLowRunning >= double.MaxValue) return;

            asiaRangeLocked = true;
            AsiaRangeLocked = true;

            lockedAsiaHigh  = asiaHighRunning;
            lockedAsiaLow   = asiaLowRunning;
            lockedAsiaMid   = (lockedAsiaHigh + lockedAsiaLow) / 2.0;

            LockedAsiaHigh  = lockedAsiaHigh;
            LockedAsiaLow   = lockedAsiaLow;
            LockedAsiaMid   = lockedAsiaMid;

            compressionBarCount = 0;
        }

        // ─────────────────────────────────────────────────────────────
        //  User-configurable parameters
        // ─────────────────────────────────────────────────────────────
        [NinjaScriptProperty]
        [Range(5, 50)]
        [Display(Name = "ATR Period", Description = "ATR period used for Asia range compression lock",
                 Order = 1, GroupName = "Parameters")]
        public int AtrPeriod
        {
            get { return atrPeriod; }
            set { atrPeriod = Math.Max(5, value); }
        }

        // ─────────────────────────────────────────────────────────────
        //  Accessor to Plot series (for Indicator 2 convenience)
        // ─────────────────────────────────────────────────────────────
        [Browsable(false)]
        [XmlIgnore]
        public Series<double> AsiaHighSeries  => Values[0];

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> AsiaLowSeries   => Values[1];

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> AsiaMidSeries   => Values[2];

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> PDHSeries        => Values[3];

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> PDLSeries        => Values[4];

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> VWAPSeries       => Values[5];

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> VWAPPlus2SD      => Values[6];

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> VWAPMinus2SD     => Values[7];
    }
}

// ─────────────────────────────────────────────────────────────────────
//  Factory method — allows other NinjaScript code to reference the
//  indicator with the standard NT8 accessor pattern:
//      NQ_RangeBuilder(…)
// ─────────────────────────────────────────────────────────────────────
#region NinjaScript generated code. Neither change nor remove.

namespace NinjaTrader.NinjaScript.Indicators
{
    public partial class Indicator : NinjaTrader.Gui.NinjaScript.IndicatorRenderBase
    {
        private NQ_RangeBuilder[] cacheNQ_RangeBuilder;

        public NQ_RangeBuilder NQ_RangeBuilder(int atrPeriod)
        {
            return NQ_RangeBuilder(Input, atrPeriod);
        }

        public NQ_RangeBuilder NQ_RangeBuilder(ISeries<double> input, int atrPeriod)
        {
            if (cacheNQ_RangeBuilder != null)
            {
                for (int idx = 0; idx < cacheNQ_RangeBuilder.Length; idx++)
                {
                    if (cacheNQ_RangeBuilder[idx] != null
                        && cacheNQ_RangeBuilder[idx].AtrPeriod == atrPeriod
                        && cacheNQ_RangeBuilder[idx].EqualsInput(input))
                    {
                        return cacheNQ_RangeBuilder[idx];
                    }
                }
            }

            return CacheIndicator<NQ_RangeBuilder>(
                new NQ_RangeBuilder { AtrPeriod = atrPeriod },
                input,
                ref cacheNQ_RangeBuilder);
        }
    }
}

namespace NinjaTrader.NinjaScript.MarketAnalyzerColumns
{
    public partial class MarketAnalyzerColumn : MarketAnalyzerColumnBase
    {
        public Indicators.NQ_RangeBuilder NQ_RangeBuilder(int atrPeriod)
        {
            return indicator.NQ_RangeBuilder(Input, atrPeriod);
        }

        public Indicators.NQ_RangeBuilder NQ_RangeBuilder(ISeries<double> input, int atrPeriod)
        {
            return indicator.NQ_RangeBuilder(input, atrPeriod);
        }
    }
}

namespace NinjaTrader.NinjaScript.Strategies
{
    public partial class Strategy : NinjaTrader.Gui.NinjaScript.StrategyRenderBase
    {
        public Indicators.NQ_RangeBuilder NQ_RangeBuilder(int atrPeriod)
        {
            return indicator.NQ_RangeBuilder(Input, atrPeriod);
        }

        public Indicators.NQ_RangeBuilder NQ_RangeBuilder(ISeries<double> input, int atrPeriod)
        {
            return indicator.NQ_RangeBuilder(input, atrPeriod);
        }
    }
}

#endregion
