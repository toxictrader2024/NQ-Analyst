// ============================================================
//  NQ_Confluence.cs  —  NinjaTrader 8 Indicator
//
//  Single indicator combining every data source:
//
//  ICT LAYERS (drawn natively on chart)
//    • Fair Value Gaps (FVG) — extend right, flip to IFVG on
//      mitigation, stop extending after invalidation
//    • Order Blocks / Breaker Blocks — last opposing candle
//      before impulse, flip on structural break
//    • CISD (Change in State of Delivery) labels
//    • Sweep / SFP labels at swing highs/lows
//    • Market Structure — HH/HL/LH/LL labels + BOS/MSS lines
//    • OTE ConfluenceZone (62–79% Fibonacci of last swing)
//    • Kill ConfluenceZone shading (Asia AMD, London, NY Open, NY Close)
//    • Equilibrium line + Premium/Discount labels
//    • VWAP anchored to session + ±1SD + ±2SD bands
//
//  ORDER FLOW LAYERS (pulled from Railway /api/sc-latest)
//    • Delta bars — color-coded candles by bar delta (SC data)
//    • CVD line — cumulative volume delta trend
//    • DOM pressure gauge — bid vs ask stack bar
//    • Absorption labels — large volume, price didn't move
//    • Volume imbalance labels — 3:1 bid/ask stack ratio
//    • Spoof alert — extreme DOM imbalance vs delta direction
//    • Footprint proxy — Tower Candles, 3-Bar Play exhaustion,
//      Delta Flip at zone
//
//  LIQUIDITY MAP
//    • Equal highs (BSL) / equal lows (SSL) dotted lines
//    • VAP POC line from SC data
//
//  CONFLUENCE SCORE
//    • 0-100 score per bar combining all layers
//    • Score label on chart
//    • BUY ▲ / SELL ▼ signal arrows when score ≥ threshold
//      in a kill zone with correct bias
//
//  DATA FLOW
//    • ICT data: calculated natively from OHLCV bars (no TV needed)
//    • Order flow: polled from /api/sc-latest every N seconds
//      (Railway server stores latest Sierra Chart webhook)
//    • Polling runs on background thread — UI never blocks
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
using System.Windows;
using System.Windows.Media;
using System.Xml.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.DrawingTools;
using NinjaTrader.Data;
#endregion

namespace NinjaTrader.NinjaScript.Indicators
{
    // ── Order flow snapshot from /api/sc-latest ───────────────────────────────
    public class SCSnapshot
    {
        public bool   HasData        { get; set; }
        public double Price          { get; set; }
        public double Delta          { get; set; }
        public double Cvd            { get; set; }
        public double BuyVolume      { get; set; }
        public double SellVolume     { get; set; }
        public double BidStackSize   { get; set; }
        public double AskStackSize   { get; set; }
        public double StackRatio     { get; set; }
        public bool   AbsorptionBull { get; set; }
        public bool   AbsorptionBear { get; set; }
        public bool   ImbalanceBull  { get; set; }
        public bool   ImbalanceBear  { get; set; }
        public double VapPoc         { get; set; }
        public int    DomBidPct      { get; set; }
        public int    DomAskPct      { get; set; }
        public string DomBias        { get; set; }
        public bool   SpoofBid       { get; set; }
        public bool   SpoofAsk       { get; set; }
        public int    OfScore        { get; set; }   // 0-100
        public string OfBias         { get; set; }
        public bool   Fresh          { get; set; }
        public int    AgeSec         { get; set; }
    }

    // ── ConfluenceZone record ───────────────────────────────────────────────────────────
    struct ConfluenceZone
    {
        public int    StartBar;
        public double Top;
        public double Bottom;
        public bool   IsBull;
        public bool   Mitigated;   // FVG filled / OB broken
        public string Tag;         // "FVG" "OB" "BB"
    }

    // ─────────────────────────────────────────────────────────────────────────
    public class NQ_Confluence : Indicator
    {
        #region ──── PARAMETERS ─────────────────────────────────────

        // Server
        [NinjaScriptProperty]
        [Display(Name = "Server URL", GroupName = "Server", Order = 1)]
        public string ServerUrl { get; set; }

        [NinjaScriptProperty]
        [Range(5, 120)]
        [Display(Name = "SC Poll Interval (sec)", GroupName = "Server", Order = 2,
                 Description = "How often to pull order flow from Railway server")]
        public int PollIntervalSec { get; set; }

        // ICT
        [NinjaScriptProperty]
        [Display(Name = "Show FVG / IFVG", GroupName = "ICT Layers", Order = 10)]
        public bool ShowFVG { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Order Blocks / Breakers", GroupName = "ICT Layers", Order = 11)]
        public bool ShowOB { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Structure HH/HL/BOS", GroupName = "ICT Layers", Order = 12)]
        public bool ShowStructure { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Kill ConfluenceZone Shading", GroupName = "ICT Layers", Order = 13)]
        public bool ShowKillZones { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show VWAP + Bands", GroupName = "ICT Layers", Order = 14)]
        public bool ShowVWAP { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show CISD", GroupName = "ICT Layers", Order = 15)]
        public bool ShowCISD { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Sweeps / SFP", GroupName = "ICT Layers", Order = 16)]
        public bool ShowSweeps { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Liquidity Pools (BSL/SSL)", GroupName = "ICT Layers", Order = 17)]
        public bool ShowLiquidity { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show OTE ConfluenceZone (62-79% Fib)", GroupName = "ICT Layers", Order = 17)]
        public bool ShowOTE { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Delta Blocks", GroupName = "ICT Layers", Order = 18)]
        public bool ShowDelta { get; set; }

        [NinjaScriptProperty]
        [Range(2, 10)]
        [Display(Name = "Delta Block Length (bars)", GroupName = "ICT Layers", Order = 19,
                 Description = "N consecutive bull/bear closes = delta block zone")]
        public int DeltaBlockLen { get; set; }

        [NinjaScriptProperty]
        [Range(5, 100)]
        [Display(Name = "ConfluenceZone Extend (bars)", GroupName = "ICT Layers", Order = 20)]
        public int ZoneExtend { get; set; }

        [NinjaScriptProperty]
        [Range(3, 50)]
        [Display(Name = "OB Lookback", GroupName = "ICT Layers", Order = 19)]
        public int OBLookback { get; set; }

        [NinjaScriptProperty]
        [Range(5, 100)]
        [Display(Name = "Liquidity Lookback", GroupName = "ICT Layers", Order = 20)]
        public int LiqLookback { get; set; }

        [NinjaScriptProperty]
        [Range(0.5, 20.0)]
        [Display(Name = "Equal H/L Tolerance (pts)", GroupName = "ICT Layers", Order = 21)]
        public double EqualTolerance { get; set; }

        // Order flow
        [NinjaScriptProperty]
        [Display(Name = "Show Order Flow Labels", GroupName = "Order Flow", Order = 30)]
        public bool ShowOrderFlow { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show DOM Pressure Bar", GroupName = "Order Flow", Order = 31)]
        public bool ShowDOM { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Footprint Proxy", GroupName = "Order Flow", Order = 32)]
        public bool ShowFootprint { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Spoof Alerts", GroupName = "Order Flow", Order = 33)]
        public bool ShowSpoof { get; set; }

        // Confluence
        [NinjaScriptProperty]
        [Display(Name = "Show Confluence Score", GroupName = "Confluence", Order = 40)]
        public bool ShowScore { get; set; }

        [NinjaScriptProperty]
        [Range(40, 100)]
        [Display(Name = "Signal Threshold (0-100)", GroupName = "Confluence", Order = 41)]
        public int SignalThreshold { get; set; }

        [NinjaScriptProperty]
        [Range(1, 8)]
        [Display(Name = "Min Confluences to Signal", GroupName = "Confluence", Order = 42)]
        public int MinConfluences { get; set; }

        #endregion

        #region ──── PLOTS ──────────────────────────────────────────

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> ConfScore { get; set; }   // plot 0

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> VWAP { get; set; }        // plot 1

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> VWAP1Hi { get; set; }     // plot 2

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> VWAP1Lo { get; set; }     // plot 3

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> VWAP2Hi { get; set; }     // plot 4

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> VWAP2Lo { get; set; }     // plot 5

        #endregion

        #region ──── PRIVATE STATE ──────────────────────────────────

        // ConfluenceZone stores
        private List<ConfluenceZone> fvgZones = new List<ConfluenceZone>();
        private List<ConfluenceZone> obZones  = new List<ConfluenceZone>();

        // Structure tracking
        private double lastSwingHi  = double.NaN;
        private double lastSwingLo  = double.NaN;
        private int    lastSwingHiBar = -1;
        private int    lastSwingLoBar = -1;
        private double prevSwingHi  = double.NaN;
        private double prevSwingLo  = double.NaN;
        private bool   bossBullFired = false;   // prevents re-firing MSS every bar after break
        private bool   bossBearFired = false;

        // OTE ConfluenceZone state
        private double oteSwingHi   = double.NaN;
        private double oteSwingLo   = double.NaN;
        private double oteTop       = double.NaN;  // 79% fib
        private double oteBot       = double.NaN;  // 62% fib
        private int    oteUpdateBar = -1;           // bar when OTE was last recalculated

        // Delta Block state (N consecutive bull/bear candles = supply/demand block)
        private List<ConfluenceZone> deltaZones = new List<ConfluenceZone>();
        private const int SwingLen  = 5;

        // VWAP
        private double vwapSum      = 0;
        private double vwapVolSum   = 0;
        private double vwapSqSum    = 0;
        private int    vwapBarCount = 0;
        private double vwapValue    = 0;
        private double vwapStdDev   = 0;
        private DateTime lastVwapSession = DateTime.MinValue;

        // SC order flow (background polled)
        private SCSnapshot scData   = new SCSnapshot { HasData = false, DomBias = "BALANCED", OfBias = "NEUTRAL" };
        private DateTime   lastPoll = DateTime.MinValue;
        private bool       polling  = false;
        private readonly object scLock = new object();

        // Liquidity lines (DrawingTool tags to remove when invalidated)
        private List<string> liqTags  = new List<string>();
        private int          tagIdx   = 0;

        // Label index
        private int lblIdx = 0;

        // Per-bar label stacking (reset each bar to prevent overlap)
        private int aboveStack = 0;  // counts labels placed above current bar
        private int belowStack = 0;  // counts labels placed below current bar
        private const double LabelStep = 12.0; // pts between stacked labels (15m NQ scale)

        // ET timezone
        private static readonly TimeZoneInfo ET =
            TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");

        #endregion

        #region ──── INIT ───────────────────────────────────────────

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description          = "NQ Confluence — ICT + Sierra Chart order flow in one indicator.";
                Name                 = "NQ_Confluence";
                Calculate            = Calculate.OnEachTick;
                IsOverlay            = true;
                DisplayInDataBox     = false;
                DrawOnPricePanel     = true;
                PaintPriceMarkers    = false;
                ScaleJustification   = NinjaTrader.Gui.Chart.ScaleJustification.Right;
                IsSuspendedWhileInactive = true;
                MaximumBarsLookBack  = MaximumBarsLookBack.TwoHundredFiftySix;
                BarsRequiredToPlot   = 10;

                // Defaults
                ServerUrl        = "https://nq-analyst-production.up.railway.app";
                PollIntervalSec  = 15;
                ShowFVG          = true;
                ShowOB           = true;
                ShowStructure    = true;
                ShowKillZones    = true;
                ShowVWAP         = true;
                ShowCISD         = true;
                ShowSweeps       = true;
                ShowLiquidity    = true;
                ShowOTE          = true;
                ShowDelta        = true;
                DeltaBlockLen    = 3;
                ZoneExtend       = 20;
                OBLookback       = 10;
                LiqLookback      = 30;
                EqualTolerance   = 3.0;
                ShowOrderFlow    = true;
                ShowDOM          = true;
                ShowFootprint    = true;
                ShowSpoof        = true;
                ShowScore        = true;
                SignalThreshold  = 65;
                MinConfluences   = 3;

                // Add plots (rendered in separate sub-panel via AddLine)
                AddPlot(new Stroke(Brushes.Transparent, 0), PlotStyle.Line, "ConfScore");
                AddPlot(new Stroke(Brushes.Yellow,      1), PlotStyle.Line, "VWAP");
                AddPlot(new Stroke(Brushes.Gold,        1), PlotStyle.Line, "VWAP+1σ");
                AddPlot(new Stroke(Brushes.Gold,        1), PlotStyle.Line, "VWAP-1σ");
                AddPlot(new Stroke(Brushes.DarkGoldenrod,1),PlotStyle.Line, "VWAP+2σ");
                AddPlot(new Stroke(Brushes.DarkGoldenrod,1),PlotStyle.Line, "VWAP-2σ");
            }
            else if (State == State.Configure)
            {
                ConfScore = Values[0];
                VWAP      = Values[1];
                VWAP1Hi   = Values[2];
                VWAP1Lo   = Values[3];
                VWAP2Hi   = Values[4];
                VWAP2Lo   = Values[5];
            }
            else if (State == State.DataLoaded)
            {
                fvgZones.Clear();
                obZones.Clear();
                deltaZones.Clear();
            }
        }

        #endregion

        #region ──── ON BAR UPDATE ──────────────────────────────────

        protected override void OnBarUpdate()
        {
            if (CurrentBar < Math.Max(SwingLen * 2, OBLookback) + 5) return;

            // ── Session VWAP reset ────────────────────────────────────────────
            DateTime etNow = TimeZoneInfo.ConvertTime(Time[0], ET);
            bool newSession = etNow.Date != lastVwapSession.Date ||
                              (etNow.Hour == 9 && etNow.Minute == 30 && vwapBarCount > 0 &&
                               etNow.Date == lastVwapSession.Date);
            if (newSession || vwapBarCount == 0)
            {
                vwapSum = vwapVolSum = vwapSqSum = 0;
                vwapBarCount = 0;
                lastVwapSession = etNow;
            }

            double tp = (High[0] + Low[0] + Close[0]) / 3.0;
            double vol = Volume[0];
            vwapSum    += tp * vol;
            vwapVolSum += vol;
            vwapSqSum  += tp * tp * vol;
            vwapBarCount++;

            vwapValue = vwapVolSum > 0 ? vwapSum / vwapVolSum : Close[0];
            double variance = vwapVolSum > 0
                ? Math.Max(0, vwapSqSum / vwapVolSum - vwapValue * vwapValue)
                : 0;
            vwapStdDev = Math.Sqrt(variance);

            if (ShowVWAP)
            {
                VWAP[0]   = vwapValue;
                VWAP1Hi[0]= vwapValue + vwapStdDev;
                VWAP1Lo[0]= vwapValue - vwapStdDev;
                VWAP2Hi[0]= vwapValue + 2 * vwapStdDev;
                VWAP2Lo[0]= vwapValue - 2 * vwapStdDev;
            }

            // ── Kill zone shading ─────────────────────────────────────────────
            if (ShowKillZones && IsFirstTickOfBar)
            {
                int etH = etNow.Hour; int etM = etNow.Minute;
                int etMin = etH * 60 + etM;
                // Asia AMD: 6pm–9pm ET
                bool asia   = etMin >= 1080 || etMin < 120;
                // London: 2am–5am ET
                bool london = etMin >= 120  && etMin < 300;
                // NY Open: 9:30am–11am ET
                bool nyOpen = etMin >= 570  && etMin < 660;
                // London Close / NY Close: 1:30pm–2pm ET
                bool nyCls  = etMin >= 810  && etMin < 840;

                Brush kzBrush = null;
                if      (asia)   kzBrush = new SolidColorBrush(Color.FromArgb(15,  128,0,  128));
                else if (london) kzBrush = new SolidColorBrush(Color.FromArgb(15,  0,  0,  200));
                else if (nyOpen) kzBrush = new SolidColorBrush(Color.FromArgb(15,  0,  160,0));
                else if (nyCls)  kzBrush = new SolidColorBrush(Color.FromArgb(15,  200,120,0));

                if (kzBrush != null)
                {
                    kzBrush.Freeze();
                    BackBrushes[0] = kzBrush;
                }
            }

            // ── Equilibrium & premium/discount ───────────────────────────────
            double rangeHi = MAX(High,  50)[0];
            double rangeLo = MIN(Low,   50)[0];
            double eq      = (rangeHi + rangeLo) / 2.0;
            bool   prem    = Close[0] > eq;
            bool   disc    = Close[0] < eq;

            // ── VWAP extension flags ──────────────────────────────────────────
            double sd1 = vwapStdDev;
            bool ext1Lo = Close[0] <= vwapValue - sd1;
            bool ext1Hi = Close[0] >= vwapValue + sd1;
            bool ext2Lo = Close[0] <= vwapValue - 2 * sd1;
            bool ext2Hi = Close[0] >= vwapValue + 2 * sd1;

            // ── Background SC poll ────────────────────────────────────────────
            if ((DateTime.Now - lastPoll).TotalSeconds >= PollIntervalSec && !polling)
            {
                lastPoll = DateTime.Now;
                ThreadPool.QueueUserWorkItem(_ => PollSC());
            }

            // ── Only draw on confirmed bars ───────────────────────────────────
            if (!IsFirstTickOfBar && State == State.Realtime) return;

            // ── Reset per-bar label stacks so nothing overlaps ────────────────
            aboveStack = 1;
            belowStack = 1;

            // ── Market structure ──────────────────────────────────────────────
            bool bosBull = false, bosBear = false;
            DetectStructure(ref bosBull, ref bosBear);

            // ── Sweeps ───────────────────────────────────────────────────────
            double lookHi = MAX(High, 20)[1];
            double lookLo = MIN(Low,  20)[1];
            bool sweepHi  = High[0] > lookHi && Close[0] < lookHi;
            bool sweepLo  = Low[0]  < lookLo && Close[0] > lookLo;

            if (ShowSweeps && sweepHi)
                DrawLabelAbove("sfp_hi_" + lblIdx++, "SFP↓", Brushes.Red, 9);
            if (ShowSweeps && sweepLo)
                DrawLabelBelow("sfp_lo_" + lblIdx++, "SFP↑", Brushes.Lime, 9);

            // ── CISD ────────────────────────────────────────────────────────
            bool cisdBull = Close[1] < Open[1] && Close[0] > Open[0] && Close[0] > Open[1];
            bool cisdBear = Close[1] > Open[1] && Close[0] < Open[0] && Close[0] < Open[1];
            if (ShowCISD && cisdBull)
                DrawLabelBelow("cisd_b_" + lblIdx++, "CISD", Brushes.Tomato, 8);
            if (ShowCISD && cisdBear)
                DrawLabelAbove("cisd_r_" + lblIdx++, "CISD", Brushes.LimeGreen, 8);

            // ── FVGs ─────────────────────────────────────────────────────────
            bool inBullFVG = false, inBearFVG = false;
            if (ShowFVG) ProcessFVGs(ref inBullFVG, ref inBearFVG);

            // ── Order Blocks ─────────────────────────────────────────────────
            bool atBullOB = false, atBearOB = false;
            if (ShowOB) ProcessOBs(ref atBullOB, ref atBearOB);

            // ── OTE ConfluenceZone (62–79% Fibonacci of last swing)
            bool inOTE = false;
            if (ShowOTE) ProcessOTE(ref inOTE);

            // ── Delta Blocks (N consecutive bull/bear closes)
            bool inDeltaBull = false, inDeltaBear = false;
            if (ShowDelta) ProcessDeltaBlocks(ref inDeltaBull, ref inDeltaBear);

            // ── Liquidity pools ───────────────────────────────────────────────
            if (ShowLiquidity) DetectLiquidity();

            // ── Footprint proxy ───────────────────────────────────────────────
            double range  = High[0] - Low[0];
            double body   = Math.Abs(Close[0] - Open[0]);
            double bPct   = range > 0 ? body / range : 0;
            bool towerBull = bPct >= 0.66 && Close[0] > Open[0];
            bool towerBear = bPct >= 0.66 && Close[0] < Open[0];

            bool threeBullExhaust = CurrentBar >= 3 &&
                Close[0] > Open[0] && Close[1] > Open[1] && Close[2] > Open[2] &&
                range < (High[1] - Low[1]) * 0.5;
            bool threeBearExhaust = CurrentBar >= 3 &&
                Close[0] < Open[0] && Close[1] < Open[1] && Close[2] < Open[2] &&
                range < (High[1] - Low[1]) * 0.5;

            bool dFlipBull = Close[1] < Open[1] && Close[0] > Open[0];
            bool dFlipBear = Close[1] > Open[1] && Close[0] < Open[0];

            if (ShowFootprint)
            {
                if (towerBull)
                    DrawLabelAbove("tc_b_"  + lblIdx++, "TC↑", Brushes.Cyan, 8);
                if (towerBear)
                    DrawLabelBelow("tc_r_"  + lblIdx++, "TC↓", Brushes.OrangeRed, 8);
                if (threeBullExhaust)
                    DrawLabelAbove("3b_b_"  + lblIdx++, "3B✓", Brushes.Yellow, 8);
                if (threeBearExhaust)
                    DrawLabelBelow("3b_r_"  + lblIdx++, "3B✓", Brushes.Yellow, 8);
                if (dFlipBull && inBullFVG)
                    DrawLabelBelow("df_b_"  + lblIdx++, "ΔFlip↑", Brushes.Aqua, 8);
                if (dFlipBear && inBearFVG)
                    DrawLabelAbove("df_r_"  + lblIdx++, "ΔFlip↓", Brushes.Orange, 8);
            }

            // ── SC order flow labels ──────────────────────────────────────────
            SCSnapshot sc;
            lock (scLock) { sc = scData; }

            if (ShowOrderFlow && sc.HasData && sc.Fresh)
            {
                if (sc.AbsorptionBull)
                    DrawLabelBelow("abs_b_" + lblIdx++, "Abs↑", Brushes.Aqua, 8);
                if (sc.AbsorptionBear)
                    DrawLabelAbove("abs_r_" + lblIdx++, "Abs↓", Brushes.OrangeRed, 8);
                if (sc.ImbalanceBull)
                    DrawLabelBelow("imb_b_" + lblIdx++, "Imb↑", Brushes.LimeGreen, 8);
                if (sc.ImbalanceBear)
                    DrawLabelAbove("imb_r_" + lblIdx++, "Imb↓", Brushes.Tomato, 8);
                if (ShowSpoof && sc.SpoofBid)
                    DrawLabelBelow("sp_b_"  + lblIdx++, "Spoof Bid", Brushes.Lime, 9);
                if (ShowSpoof && sc.SpoofAsk)
                    DrawLabelAbove("sp_r_"  + lblIdx++, "Spoof Ask", Brushes.Red, 9);

                // VAP POC line (horizontal)
                if (sc.VapPoc > 0 && Math.Abs(sc.VapPoc - Close[0]) < 500)
                    Draw.HorizontalLine(this, "vap_poc",
                        sc.VapPoc, Brushes.MediumPurple,
                        DashStyleHelper.Dash, 1);
            }

            // ── Confluence scoring ────────────────────────────────────────────
            int longPts  = 0, longConf  = 0;
            int shortPts = 0, shortConf = 0;

            // ICT long confluences
            if (disc)         { longPts += 8;  longConf++; }
            if (inBullFVG)    { longPts += 12; longConf++; }
            if (atBullOB)     { longPts += 10; longConf++; }
            if (sweepLo)      { longPts += 12; longConf++; }
            if (cisdBull)     { longPts += 6;  longConf++; }
            if (inOTE)        { longPts += 10; longConf++; shortPts += 10; shortConf++; }
            if (inDeltaBull)  { longPts  += 8; longConf++; }
            if (inDeltaBear)  { shortPts += 8; shortConf++; }
            if (bosBull)      { longPts += 8;  longConf++; }
            if (InKillZone(etNow)) { longPts += 6; longConf++; }
            if (ext1Lo)       { longPts += 5;  longConf++; }
            if (dFlipBull && (inBullFVG || atBullOB)) { longPts += 8; longConf++; }
            if (towerBull && atBullOB) { longPts += 6; longConf++; }
            if (threeBullExhaust && CurrentBar > 0 &&
                Close[1] < Open[1]) { longPts += 5; longConf++; } // bears exhausted last bar

            // SC order flow long confluences
            if (sc.HasData && sc.Fresh)
            {
                if (sc.AbsorptionBull) { longPts += 10; longConf++; }
                if (sc.ImbalanceBull)  { longPts += 8;  longConf++; }
                if (sc.Delta > 0)      { longPts += 5;  }
                if (sc.DomBias == "BUY_PRESSURE") { longPts += 5; }
                if (sc.SpoofBid)       { longPts += 4;  }  // bid wall will pull = buy opportunity
                if (sc.OfBias == "BULLISH") { longPts += 6; longConf++; }
            }

            // ICT short confluences
            if (prem)         { shortPts += 8;  shortConf++; }
            if (inBearFVG)    { shortPts += 12; shortConf++; }
            if (atBearOB)     { shortPts += 10; shortConf++; }
            if (sweepHi)      { shortPts += 12; shortConf++; }
            if (cisdBear)     { shortPts += 6;  shortConf++; }
            if (bosBear)      { shortPts += 8;  shortConf++; }
            if (InKillZone(etNow)) { shortPts += 6; shortConf++; }
            if (ext1Hi)       { shortPts += 5;  shortConf++; }
            if (dFlipBear && (inBearFVG || atBearOB)) { shortPts += 8; shortConf++; }
            if (towerBear && atBearOB) { shortPts += 6; shortConf++; }
            if (threeBearExhaust && CurrentBar > 0 &&
                Close[1] > Open[1]) { shortPts += 5; shortConf++; }

            // SC order flow short confluences
            if (sc.HasData && sc.Fresh)
            {
                if (sc.AbsorptionBear) { shortPts += 10; shortConf++; }
                if (sc.ImbalanceBear)  { shortPts += 8;  shortConf++; }
                if (sc.Delta < 0)      { shortPts += 5;  }
                if (sc.DomBias == "SELL_PRESSURE") { shortPts += 5; }
                if (sc.SpoofAsk)       { shortPts += 4;  }
                if (sc.OfBias == "BEARISH") { shortPts += 6; shortConf++; }
            }

            int longScore  = Math.Min(100, longPts);
            int shortScore = Math.Min(100, shortPts);
            int bestScore  = Math.Max(longScore, shortScore);

            ConfScore[0] = bestScore;

            // Score label
            if (ShowScore && bestScore >= 40)
            {
                bool isLong = longScore >= shortScore;
                string dir  = isLong ? "L" : "S";
                Brush col   = bestScore >= SignalThreshold
                    ? (isLong ? Brushes.Lime : Brushes.Red)
                    : Brushes.Gray;
                DrawLabelBelow("score_" + lblIdx++, dir + ":" + bestScore, col, 9);
            }

            // ── BUY / SELL signal arrows ────────────────────────────────────
            bool inKZ   = InKillZone(etNow);

            bool longSig  = inKZ && disc  && longScore  >= SignalThreshold && longConf  >= MinConfluences;
            bool shortSig = inKZ && prem  && shortScore >= SignalThreshold && shortConf >= MinConfluences;
            longSig  = longSig  && !shortSig;

            if (longSig)
            {
                double arrowYL = Low[0] - (belowStack * LabelStep);
                Draw.ArrowUp(this, "buy_" + lblIdx++, true, 0, arrowYL, Brushes.Lime);
                belowStack++;
                DrawLabelBelow("buy_lbl_" + lblIdx++,
                    "BUY " + longScore + " (" + longConf + ")", Brushes.Lime, 10);
            }
            if (shortSig)
            {
                double arrowYS = High[0] + (aboveStack * LabelStep);
                Draw.ArrowDown(this, "sell_" + lblIdx++, true, 0, arrowYS, Brushes.Red);
                aboveStack++;
                DrawLabelAbove("sell_lbl_" + lblIdx++,
                    "SELL " + shortScore + " (" + shortConf + ")", Brushes.Red, 10);
            }
        }

        #endregion

        #region ──── ICT PROCESSING ─────────────────────────────────

        private void DetectStructure(ref bool bosBull, ref bool bosBear)
        {
            if (!ShowStructure) return;

            // Pivot detection (simplified — look for local high/low)
            if (CurrentBar < SwingLen * 2) return;

            bool isPH = true, isPL = true;
            for (int i = 1; i <= SwingLen; i++)
            {
                if (High[SwingLen] <= High[i - 1] || High[SwingLen] <= High[SwingLen + i]) isPH = false;
                if (Low[SwingLen]  >= Low[i - 1]  || Low[SwingLen]  >= Low[SwingLen + i])  isPL = false;
            }

            if (isPH)
            {
                double ph = High[SwingLen];
                string tag = double.IsNaN(lastSwingHi) ? "HH" : ph > lastSwingHi ? "HH" : "LH";
                DrawLabel("ph_" + (CurrentBar - SwingLen), SwingLen, ph + 2, tag, Brushes.White, 8);
                prevSwingHi    = lastSwingHi;
                lastSwingHi    = ph;
                lastSwingHiBar = CurrentBar - SwingLen;
                bossBullFired  = false;   // new swing formed — reset so next break fires once
            }
            if (isPL)
            {
                double pl = Low[SwingLen];
                string tag = double.IsNaN(lastSwingLo) ? "LL" : pl < lastSwingLo ? "LL" : "HL";
                DrawLabel("pl_" + (CurrentBar - SwingLen), SwingLen, pl - 2, tag, Brushes.White, 8);
                prevSwingLo    = lastSwingLo;
                lastSwingLo    = pl;
                lastSwingLoBar = CurrentBar - SwingLen;
                bossBearFired  = false;   // new swing formed — reset
            }

            // BOS / MSS — fire ONCE per swing break (guard with fired flag + clear prevSwing)
            if (!double.IsNaN(prevSwingHi) && !bossBullFired && Close[0] > prevSwingHi)
            {
                bosBull       = true;
                bossBullFired = true;
                int barsBack  = CurrentBar - lastSwingHiBar;
                Draw.Line(this, "bos_b_" + CurrentBar, true,
                    barsBack, prevSwingHi, 0, prevSwingHi,
                    Brushes.Lime, DashStyleHelper.Solid, 1);
                DrawLabelBelow("mss_b_" + CurrentBar, "MSS↑", Brushes.Lime, 9);
                prevSwingHi = double.NaN;  // consumed — won't retrigger
            }
            if (!double.IsNaN(prevSwingLo) && !bossBearFired && Close[0] < prevSwingLo)
            {
                bosBear       = true;
                bossBearFired = true;
                int barsBack  = CurrentBar - lastSwingLoBar;
                Draw.Line(this, "bos_r_" + CurrentBar, true,
                    barsBack, prevSwingLo, 0, prevSwingLo,
                    Brushes.Red, DashStyleHelper.Solid, 1);
                DrawLabelAbove("mss_r_" + CurrentBar, "MSS↓", Brushes.Red, 9);
                prevSwingLo = double.NaN;  // consumed — won't retrigger
            }
        }

        private void ProcessFVGs(ref bool inBullFVG, ref bool inBearFVG)
        {
            if (CurrentBar < 3) return;

            // Detect new FVGs
            bool newBullFVG = Low[0]  > High[2];
            bool newBearFVG = High[0] < Low[2];

            if (newBullFVG)
                fvgZones.Add(new ConfluenceZone {
                    StartBar = CurrentBar - 2,
                    Top      = Low[0],
                    Bottom   = High[2],
                    IsBull   = true,
                    Tag      = "FVG"
                });
            if (newBearFVG)
                fvgZones.Add(new ConfluenceZone {
                    StartBar = CurrentBar - 2,
                    Top      = Low[2],
                    Bottom   = High[0],
                    IsBull   = false,
                    Tag      = "FVG"
                });

            // Update existing FVGs
            for (int i = fvgZones.Count - 1; i >= 0; i--)
            {
                var z = fvgZones[i];
                if (z.Mitigated) { fvgZones.RemoveAt(i); continue; }

                int barsAgo = CurrentBar - z.StartBar;
                if (barsAgo > ZoneExtend * 3) { fvgZones.RemoveAt(i); continue; }

                // Check if price is in this zone
                if (z.IsBull && Low[0]  <= z.Top && Low[0]  >= z.Bottom) inBullFVG = true;
                if (!z.IsBull && High[0] >= z.Bottom && High[0] <= z.Top) inBearFVG = true;

                // Mitigation check
                bool mitigated = z.IsBull ? Close[0] < z.Top : Close[0] > z.Bottom;
                if (mitigated)
                {
                    // Flip colors — draw IFVG box (freeze at current bar)
                    string tag = "ifvg_" + i;
                    Brush ifvgCol = z.IsBull
                        ? new SolidColorBrush(Color.FromArgb(40, 255, 50, 50))
                        : new SolidColorBrush(Color.FromArgb(40, 50, 255, 50));
                    ifvgCol.Freeze();
                    Draw.Rectangle(this, tag, true,
                        barsAgo, z.Top,
                        0,       z.Bottom,
                        ifvgCol, ifvgCol, 1);
                    var mut = z; mut.Mitigated = true; mut.Tag = "IFVG";
                    fvgZones[i] = mut;
                }
                else
                {
                    // Extend FVG box
                    SolidColorBrush fvgBull = new SolidColorBrush(Color.FromArgb(40, 50, 200, 50)); fvgBull.Freeze();
                    SolidColorBrush fvgBear = new SolidColorBrush(Color.FromArgb(40, 200, 50, 50)); fvgBear.Freeze();
                    Brush fvgCol = z.IsBull ? fvgBull : fvgBear;
                    Draw.Rectangle(this, "fvg_" + i, true,
                        barsAgo, z.Top,
                        -ZoneExtend, z.Bottom,
                        fvgCol, fvgCol, 1);
                    DrawLabel("fvg_l_" + i, -ZoneExtend / 2,
                        (z.Top + z.Bottom) / 2,
                        z.IsBull ? "FVG" : "FVG",
                        z.IsBull ? Brushes.LimeGreen : Brushes.Tomato, 8);
                }
            }

            // Cap list size
            if (fvgZones.Count > 80) fvgZones.RemoveRange(0, fvgZones.Count - 80);
        }

        private int lastOBBar = -1;  // one-shot guard — only add OB once per bar

        private void ProcessOBs(ref bool atBullOB, ref bool atBearOB)
        {
            if (CurrentBar < OBLookback + 2) return;

            // Detect new OBs — last opposing candle before impulse (one per bar)
            if (CurrentBar != lastOBBar)
            {
                bool bullImpulse = Close[0] > MAX(High, OBLookback)[1];
                bool bearImpulse = Close[0] < MIN(Low,  OBLookback)[1];

                if (bullImpulse && Close[1] < Open[1])
                {
                    lastOBBar = CurrentBar;
                    obZones.Add(new ConfluenceZone {
                        StartBar = CurrentBar - 1,
                        Top      = Math.Max(Open[1], Close[1]),
                        Bottom   = Math.Min(Open[1], Close[1]),
                        IsBull   = true,
                        Tag      = "OB"
                    });
                }
                else if (bearImpulse && Close[1] > Open[1])
                {
                    lastOBBar = CurrentBar;
                    obZones.Add(new ConfluenceZone {
                        StartBar = CurrentBar - 1,
                        Top      = Math.Max(Open[1], Close[1]),
                        Bottom   = Math.Min(Open[1], Close[1]),
                        IsBull   = false,
                        Tag      = "OB"
                    });
                }
            }

            // Update existing OBs
            for (int i = obZones.Count - 1; i >= 0; i--)
            {
                var z = obZones[i];
                int barsAgo = CurrentBar - z.StartBar;
                if (barsAgo > ZoneExtend * 3) { obZones.RemoveAt(i); continue; }

                // Check if price at zone
                if (!z.Mitigated)
                {
                    if (z.IsBull  && Low[0]  <= z.Top && Low[0]  >= z.Bottom) atBullOB = true;
                    if (!z.IsBull && High[0] >= z.Bottom && High[0] <= z.Top) atBearOB = true;
                }

                // Mitigation → flip to Breaker Block
                bool broken = z.IsBull ? Close[0] < z.Bottom : Close[0] > z.Top;
                if (broken && !z.Mitigated)
                {
                    Brush bbCol = z.IsBull
                        ? new SolidColorBrush(Color.FromArgb(45, 220, 50, 50))
                        : new SolidColorBrush(Color.FromArgb(45, 50, 220, 50));
                    bbCol.Freeze();
                    Draw.Rectangle(this, "bb_" + i, true,
                        barsAgo, z.Top,
                        -ZoneExtend, z.Bottom,
                        bbCol, bbCol, 1);
                    DrawLabel("bb_l_" + i, -ZoneExtend / 2,
                        (z.Top + z.Bottom) / 2,
                        "Breaker",
                        z.IsBull ? Brushes.Tomato : Brushes.LimeGreen, 8);
                    var mut = z; mut.Mitigated = true; mut.Tag = "BB";
                    obZones[i] = mut;
                }
                else if (!z.Mitigated)
                {
                        Brush obCol = z.IsBull
                        ? new SolidColorBrush(Color.FromArgb(45, 0, 180, 160))
                        : new SolidColorBrush(Color.FromArgb(45, 200, 50, 50));
                    obCol.Freeze();
                    Draw.Rectangle(this, "ob_" + i, true,
                        barsAgo, z.Top,
                        -ZoneExtend, z.Bottom,
                        obCol, obCol, 1);
                    DrawLabel("ob_l_" + i, -ZoneExtend / 2,
                        (z.Top + z.Bottom) / 2,
                        z.IsBull ? "Bull OB" : "Bear OB",
                        z.IsBull ? Brushes.Cyan : Brushes.Tomato, 8);
                }
            }
            if (obZones.Count > 60) obZones.RemoveRange(0, obZones.Count - 60);
        }

        private void DetectLiquidity()
        {
            if (CurrentBar < LiqLookback + 2) return;

            // Use fixed tag per bar so each bar overwrites its own label (no accumulation)
            string bslTag  = "bsl_"   + CurrentBar;
            string bslLbl  = "bsl_l_" + CurrentBar;
            string sslTag  = "ssl_"   + CurrentBar;
            string sslLbl  = "ssl_l_" + CurrentBar;

            bool foundBSL = false, foundSSL = false;
            for (int j = 1; j <= Math.Min(LiqLookback, CurrentBar - 1); j++)
            {
                // Equal highs — Buy Side Liquidity
                if (!foundBSL &&
                    Math.Abs(High[0] - High[j]) <= EqualTolerance &&
                    High[0] >= MAX(High, j)[1])
                {
                    Draw.Line(this, bslTag, true, j, High[j], 0, High[0],
                        Brushes.Yellow, DashStyleHelper.Dot, 1);
                    DrawLabelAbove(bslLbl, "BSL", Brushes.Yellow, 8);
                    if (!liqTags.Contains(bslTag)) liqTags.Add(bslTag);
                    foundBSL = true;
                }
                // Equal lows — Sell Side Liquidity
                if (!foundSSL &&
                    Math.Abs(Low[0] - Low[j]) <= EqualTolerance &&
                    Low[0] <= MIN(Low, j)[1])
                {
                    Draw.Line(this, sslTag, true, j, Low[j], 0, Low[0],
                        Brushes.Orange, DashStyleHelper.Dot, 1);
                    DrawLabelBelow(sslLbl, "SSL", Brushes.Orange, 8);
                    if (!liqTags.Contains(sslTag)) liqTags.Add(sslTag);
                    foundSSL = true;
                }
                if (foundBSL && foundSSL) break;
            }

            // Prune old liquidity draw objects (keep last 40 bars worth)
            if (liqTags.Count > 80)
            {
                try { RemoveDrawObject(liqTags[0]); RemoveDrawObject(liqTags[0] + "_l"); } catch { }
                liqTags.RemoveAt(0);
            }
        }

        private bool InKillZone(DateTime etNow)
        {
            int etMin = etNow.Hour * 60 + etNow.Minute;
            return (etMin >= 120  && etMin < 300)  // London 2-5am ET
                || (etMin >= 570  && etMin < 660)  // NY Open 9:30-11am ET
                || (etMin >= 810  && etMin < 840); // London Close 1:30-2pm ET
        }

        #endregion

        #region ──── SC POLLING ──────────────────────────────────────

        private void PollSC()
        {
            polling = true;
            try
            {
                string json = HttpGet(ServerUrl + "/api/sc-latest", 4000);
                if (string.IsNullOrEmpty(json)) return;
                var snap = ParseSCSnapshot(json);
                lock (scLock) { scData = snap; }
            }
            catch (Exception ex)
            {
                Print("[NQ_Confluence] SC poll error: " + ex.Message);
            }
            finally { polling = false; }
        }

        private SCSnapshot ParseSCSnapshot(string json)
        {
            var s = new SCSnapshot { DomBias = "BALANCED", OfBias = "NEUTRAL" };
            s.HasData        = GetBool(json, "hasData");
            s.Fresh          = GetBool(json, "fresh");
            s.AgeSec         = GetInt(json, "ageSec");
            s.Price          = GetDouble(json, "price");
            s.Delta          = GetDouble(json, "delta");
            s.Cvd            = GetDouble(json, "cvd");
            s.BuyVolume      = GetDouble(json, "buyVolume");
            s.SellVolume     = GetDouble(json, "sellVolume");
            s.BidStackSize   = GetDouble(json, "bidStackSize");
            s.AskStackSize   = GetDouble(json, "askStackSize");
            s.StackRatio     = GetDouble(json, "stackRatio");
            s.AbsorptionBull = GetBool(json, "absorptionBull");
            s.AbsorptionBear = GetBool(json, "absorptionBear");
            s.ImbalanceBull  = GetBool(json, "imbalanceBull");
            s.ImbalanceBear  = GetBool(json, "imbalanceBear");
            s.VapPoc         = GetDouble(json, "vapPoc");
            s.DomBidPct      = GetInt(json, "domBidPct");
            s.DomAskPct      = GetInt(json, "domAskPct");
            s.DomBias        = GetString(json, "domBias")  ?? "BALANCED";
            s.SpoofBid       = GetBool(json, "spoofBid");
            s.SpoofAsk       = GetBool(json, "spoofAsk");
            s.OfScore        = GetInt(json, "ofScore");
            s.OfBias         = GetString(json, "ofBias")   ?? "NEUTRAL";
            return s;
        }

        #endregion

        #region ──── HELPERS ────────────────────────────────────────

        // DrawLabelAbove / DrawLabelBelow — auto-stack labels so they never overlap
        // Each call consumes one slot from the per-bar above/below stack counter.
        private void DrawLabelAbove(string tag, string text, Brush color, int size)
        {
            try
            {
                double y = High[0] + (aboveStack * LabelStep);
                Draw.Text(this, tag, text, 0, y, color);
                aboveStack++;
            }
            catch { }
        }

        private void DrawLabelBelow(string tag, string text, Brush color, int size)
        {
            try
            {
                double y = Low[0] - (belowStack * LabelStep);
                Draw.Text(this, tag, text, 0, y, color);
                belowStack++;
            }
            catch { }
        }

        // Legacy overload kept for pivot HH/HL/LH/LL labels that need a specific bar offset
        private void DrawLabel(string tag, int barsAgo, double price, string text, Brush color, int size)
        {
            try
            {
                Draw.Text(this, tag, text, barsAgo, price, color);
            }
            catch { }
        }

        private string HttpGet(string url, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method  = "GET";
            req.Timeout = timeoutMs;
            req.Headers.Add("User-Agent", "NQ_Confluence/1.0");
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr   = new StreamReader(resp.GetResponseStream()))
                return sr.ReadToEnd();
        }

        // Minimal JSON field extractors
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

        private int GetInt(string json, string key)
            => (int)GetDouble(json, key);

        private bool GetBool(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\":", StringComparison.Ordinal);
            if (i < 0) return false;
            int c = json.IndexOf(':', i) + 1;
            while (c < json.Length && json[c] == ' ') c++;
            return c < json.Length - 3 && json.Substring(c, 4) == "true";
        }

        private string GetString(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\":", StringComparison.Ordinal);
            if (i < 0) return null;
            int c = json.IndexOf('"', json.IndexOf(':', i) + 1) + 1;
            int e = json.IndexOf('"', c);
            return e > c ? json.Substring(c, e - c) : null;
        }

        private void ProcessOTE(ref bool inOTE)
        {
            // Recalculate OTE zone whenever we have valid swing H and L
            if (!double.IsNaN(lastSwingHi) && !double.IsNaN(lastSwingLo) && lastSwingHi > lastSwingLo)
            {
                bool newSwing = (oteUpdateBar != lastSwingHiBar && oteUpdateBar != lastSwingLoBar);
                if (newSwing)
                {
                    oteSwingHi   = lastSwingHi;
                    oteSwingLo   = lastSwingLo;
                    oteTop       = oteSwingLo + (oteSwingHi - oteSwingLo) * 0.79;
                    oteBot       = oteSwingLo + (oteSwingHi - oteSwingLo) * 0.62;
                    oteUpdateBar = Math.Max(lastSwingHiBar, lastSwingLoBar);
                }

                // Extend rectangle to current bar + ZoneExtend (redraw is idempotent by tag)
                int barsBack = CurrentBar - oteUpdateBar;
                try
                {
                    var oteBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(40, 0, 200, 180));
                    oteBrush.Freeze();
                    Draw.Rectangle(this, "ote_zone", true,
                        barsBack, oteTop, -ZoneExtend, oteBot,
                        Brushes.Transparent, oteBrush, 30);
                    DrawLabel("ote_lbl", barsBack - 1, (oteTop + oteBot) / 2,
                        "OTE", Brushes.MediumTurquoise, 9);
                }
                catch { }

                inOTE = Close[0] >= oteBot && Close[0] <= oteTop;

                // Invalidate when price extends far beyond swing extremes
                if (Close[0] > oteSwingHi * 1.002 || Close[0] < oteSwingLo * 0.998)
                {
                    oteSwingHi = oteSwingLo = oteTop = oteBot = double.NaN;
                    oteUpdateBar = -1;
                    try { RemoveDrawObject("ote_zone"); RemoveDrawObject("ote_lbl"); } catch { }
                }
            }
        }

        private void ProcessDeltaBlocks(ref bool inDeltaBull, ref bool inDeltaBear)
        {
            if (CurrentBar < DeltaBlockLen + 2) return;

            // Detect N consecutive bull or bear closes (matches Pine script logic)
            bool bullStreak = true, bearStreak = true;
            for (int k = 0; k < DeltaBlockLen; k++)
            {
                if (Close[k] <= Open[k]) bullStreak = false;
                if (Close[k] >= Open[k]) bearStreak = false;
            }

            // Fire on the first confirmed bar that completes the streak
            bool newBull = bullStreak && (CurrentBar < 1 || !(Close[1] > Open[1] && Close[2] > Open[2]
                && (DeltaBlockLen < 3 || Close[2] > Open[2])));
            bool newBear = bearStreak && (CurrentBar < 1 || !(Close[1] < Open[1] && Close[2] < Open[2]
                && (DeltaBlockLen < 3 || Close[2] < Open[2])));

            // Simpler: just fire every time streak is complete (Rectangle tag by bar = once per bar)
            if (bullStreak)
            {
                double top = MAX(High, DeltaBlockLen)[0];
                double bot = MIN(Low,  DeltaBlockLen)[0];
                string tag = "db_bull_" + CurrentBar;
                try
                {
                    var dbBullBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(35, 0, 180, 160));
                    dbBullBrush.Freeze();
                    Draw.Rectangle(this, tag, true,
                        DeltaBlockLen - 1, top, -ZoneExtend, bot,
                        Brushes.Transparent, dbBullBrush, 1);
                    DrawLabel("db_bull_lbl_" + CurrentBar, DeltaBlockLen / 2,
                        (top + bot) / 2, "Δ Bull", Brushes.MediumTurquoise, 8);
                }
                catch { }
                deltaZones.Add(new ConfluenceZone { Top = top, Bottom = bot, IsBull = true,
                    Tag = tag, Mitigated = false, StartBar = CurrentBar });
            }
            if (bearStreak)
            {
                double top = MAX(High, DeltaBlockLen)[0];
                double bot = MIN(Low,  DeltaBlockLen)[0];
                string tag = "db_bear_" + CurrentBar;
                try
                {
                    var dbBearBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(35, 180, 0, 30));
                    dbBearBrush.Freeze();
                    Draw.Rectangle(this, tag, true,
                        DeltaBlockLen - 1, top, -ZoneExtend, bot,
                        Brushes.Transparent, dbBearBrush, 1);
                    DrawLabel("db_bear_lbl_" + CurrentBar, DeltaBlockLen / 2,
                        (top + bot) / 2, "Δ Bear", Brushes.Tomato, 8);
                }
                catch { }
                deltaZones.Add(new ConfluenceZone { Top = top, Bottom = bot, IsBull = false,
                    Tag = tag, Mitigated = false, StartBar = CurrentBar });
            }

            // Manage existing zones
            for (int i = deltaZones.Count - 1; i >= 0; i--)
            {
                var z = deltaZones[i];
                if (z.Mitigated) { if (CurrentBar - z.StartBar > ZoneExtend * 3) deltaZones.RemoveAt(i); continue; }

                bool hit = z.IsBull ? Close[0] < z.Bottom : Close[0] > z.Top;
                if (hit)
                {
                    z.Mitigated = true;
                    try {
                        var mitBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(12,
                            z.IsBull ? (byte)0   : (byte)180,
                            z.IsBull ? (byte)180 : (byte)0,
                            z.IsBull ? (byte)160 : (byte)30));
                        mitBrush.Freeze();
                        Draw.Rectangle(this, z.Tag, true,
                            CurrentBar - z.StartBar, z.Top, -ZoneExtend / 2, z.Bottom,
                            Brushes.Transparent, mitBrush, 1);
                    } catch { }
                }

                if (!z.Mitigated && Close[0] >= z.Bottom && Close[0] <= z.Top)
                {
                    if (z.IsBull) inDeltaBull = true;
                    else          inDeltaBear = true;
                }
            }
        }


        #endregion
    }
}
