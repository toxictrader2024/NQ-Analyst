#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Windows;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Media;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.Core.FloatingPoint;
using NinjaTrader.NinjaScript.DrawingTools;
using NinjaTrader.NinjaScript.Indicators;
#endregion

// ─── ENUM MUST BE OUTSIDE THE CLASS (NT8 compiler requirement) ──────────────
namespace NinjaTrader.NinjaScript.Indicators
{
    public enum ObMitigationMode
    {
        CloseInside,
        TouchZone
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  NQ_CK_Signals  –  Indicator 2 of 2
    //
    //  Reads levels from NQ_RangeBuilder (Indicator 1).
    //  NQ_RangeBuilder MUST be added to the same chart.
    //
    //  Fires buy/sell signals during:
    //    London KZ  : 02:00–05:00 ET
    //    NY Open KZ : 09:30–11:00 ET
    //    London Close (sub-set of NY): 10:00–11:00 ET
    //
    //  Confluence scoring (max 7, bonus from SFP/OTE capped at 7):
    //    1. HTF Bias     – LondonSweptLow/High from RangeBuilder
    //    2. Zone         – Discount (long) / Premium (short)
    //    3. FVG          – 1m fair-value gap retest
    //    4. Order Block  – 15m OB zone (un-mitigated)
    //    5. CISD         – Body closes through prior body
    //    6. MSS          – Close breaks prior 10-bar swing
    //    7. Killzone     – Inside an active killzone window
    //    +1 SFP          – Wick-sweep + reversal close
    //    +1 OTE          – Inside 62–79 % retracement zone (capped at 7)
    // ═══════════════════════════════════════════════════════════════════════════
    public class NQ_CK_Signals : Indicator
    {
        // ── Inner data containers ────────────────────────────────────────────
        private sealed class FvgZone
        {
            public bool   IsBull;
            public double Top;
            public double Bottom;
            public int    BirthBar1m;
            public bool   Alive;
            public string Tag;
        }

        private sealed class ObZone
        {
            public bool   IsBull;
            public double Top;
            public double Bottom;
            public int    BirthBar15m;
            public bool   Mitigated;
            public string Tag;
        }

        private sealed class OteZone
        {
            public bool   IsBull;
            public double Top;
            public double Bottom;
            public int    BirthBar1m;
            public string Tag;
        }

        // ── Fields ──────────────────────────────────────────────────────────
        private NQ_RangeBuilder    _rb;
        private ATR                _atr1m;

        private const int          IDX_15M = 1;

        private readonly List<FvgZone> _fvgZones  = new List<FvgZone>();
        private readonly List<ObZone>  _obZones   = new List<ObZone>();
        private readonly List<OteZone> _oteZones  = new List<OteZone>();

        private int  _lastSignalBar1m = -9999;
        private int  _bars15mSeen    = 0;

        // ── Per-session trade cap (Fix 3) ────────────────────────────────────
        // Tracks how many signals fired in each killzone window today.
        // Resets on new trading date. Max 3 per session window.
        private const int MAX_SIGNALS_PER_SESSION = 3;
        private int      _londonCount    = 0;
        private int      _nyOpenCount    = 0;
        private DateTime _lastCapDate    = DateTime.MinValue;

        // ── Parameters ──────────────────────────────────────────────────────

        [NinjaScriptProperty]
        [Display(Name = "Server URL", GroupName = "Server", Order = 0)]
        public string ServerUrl { get; set; }

        [NinjaScriptProperty]
        [Range(5, 200)]
        [Display(Name = "FVG Scan Bars", GroupName = "FVG", Order = 0)]
        public int FvgScanBars { get; set; }

        [NinjaScriptProperty]
        [Range(0.25, 50.0)]
        [Display(Name = "FVG Min Points", GroupName = "FVG", Order = 1)]
        public double FvgMinPts { get; set; }

        [NinjaScriptProperty]
        [Range(5, 200)]
        [Display(Name = "OB Max Bars (15m)", GroupName = "Order Block", Order = 0)]
        public int ObMaxBars { get; set; }

        [NinjaScriptProperty]
        [Range(2, 10)]
        [Display(Name = "OB Impulse Bars", GroupName = "Order Block", Order = 1)]
        public int ObSwingLen { get; set; }

        [NinjaScriptProperty]
        [Range(3, 100)]
        [Display(Name = "ATR Period", GroupName = "Filters", Order = 0)]
        public int AtrPeriod { get; set; }

        [NinjaScriptProperty]
        [Range(0.1, 10.0)]
        [Display(Name = "ATR Multiplier (Entry Filter)", GroupName = "Filters", Order = 1)]
        public double AtrMult { get; set; }

        [NinjaScriptProperty]
        [Range(1, 7)]
        [Display(Name = "Min Confluence (MinConf)", GroupName = "Signals", Order = 0)]
        public int MinConf { get; set; }

        [NinjaScriptProperty]
        [Range(1, 100)]
        [Display(Name = "Cooldown Bars", GroupName = "Signals", Order = 1)]
        public int CooldownBars { get; set; }

        [NinjaScriptProperty]
        [Range(1.0, 500.0)]
        [Display(Name = "Stop Loss Points", GroupName = "Signals", Order = 2)]
        public double SlPts { get; set; }

        [NinjaScriptProperty]
        [Range(1.0, 500.0)]
        [Display(Name = "TP1 Points", GroupName = "Signals", Order = 3)]
        public double Tp1Pts { get; set; }

        [NinjaScriptProperty]
        [Range(1.0, 1000.0)]
        [Display(Name = "TP2 Points", GroupName = "Signals", Order = 4)]
        public double Tp2Pts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show FVG Zones", GroupName = "Display", Order = 0)]
        public bool ShowFvg { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Order Blocks", GroupName = "Display", Order = 1)]
        public bool ShowOb { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show CISD Labels", GroupName = "Display", Order = 2)]
        public bool ShowCisd { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show MSS Markers", GroupName = "Display", Order = 3)]
        public bool ShowMss { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show Signals", GroupName = "Display", Order = 4)]
        public bool ShowSignals { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Show OTE Zones", GroupName = "Display", Order = 5)]
        public bool ShowOte { get; set; }

        // ── Lifecycle ────────────────────────────────────────────────────────

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description              = "CK Methodology confluence signal indicator (Indicator 2 of 2).";
                Name                     = "NQ_CK_Signals";
                Calculate                = Calculate.OnBarClose;
                IsOverlay                = true;
                PrintTo                  = PrintTo.OutputTab1;
                DisplayInDataBox         = false;
                DrawOnPricePanel         = true;
                DrawHorizontalGridLines  = false;
                DrawVerticalGridLines    = false;
                PaintPriceMarkers        = false;
                ScaleJustification       = NinjaTrader.Gui.Chart.ScaleJustification.Right;
                IsSuspendedWhileInactive = true;

                // Default parameter values
                ServerUrl    = "https://nq-analyst-production.up.railway.app";
                FvgScanBars  = 20;
                FvgMinPts    = 2.0;
                ObMaxBars    = 30;
                ObSwingLen   = 3;
                AtrPeriod    = 14;
                AtrMult      = 1.0;
                MinConf      = 4;
                CooldownBars = 5;
                SlPts        = 15.0;
                Tp1Pts       = 25.0;
                Tp2Pts       = 60.0;
                ShowFvg      = true;
                ShowOb       = true;
                ShowCisd     = true;
                ShowMss      = true;
                ShowSignals  = true;
                ShowOte      = true;
            }
            else if (State == State.Configure)
            {
                // Secondary 15-minute data series at index 1
                AddDataSeries(BarsPeriodType.Minute, 15);
            }
            else if (State == State.DataLoaded)
            {
                // ATR on primary 1m series only — must be assigned in DataLoaded
                _atr1m = ATR(AtrPeriod);

                // NT8 factory method uses an internal cache keyed by (input, AtrPeriod).
                // If NQ_RangeBuilder is already loaded on this chart it returns THAT instance
                // (same historical data, same Asia/PDH/PDL locks) — NOT a new blank copy.
                // Add NQ_RangeBuilder to the chart BEFORE NQ_CK_Signals for full history.
                _rb = NQ_RangeBuilder(AtrPeriod);

                Print("[CK_Signals] Loaded — RangeBuilder: " + (_rb != null ? "OK (chart instance)" : "NULL — ADD NQ_RangeBuilder first!"));
                Print("[CK_Signals] MinConf=" + MinConf + " CooldownBars=" + CooldownBars + " SL=" + SlPts + " TP1=" + Tp1Pts + " TP2=" + Tp2Pts);
                Print("[CK_Signals] ServerUrl=" + ServerUrl);
            }
            else if (State == State.Terminated)
            {
                Print("[CK_Signals] Terminated.");
            }
        }

        // ── OnBarUpdate ──────────────────────────────────────────────────────

        protected override void OnBarUpdate()
        {
            // ----------------------------------------------------------------
            // 15m secondary series processing
            // ----------------------------------------------------------------
            if (BarsInProgress == IDX_15M)
            {
                if (CurrentBars[IDX_15M] < ObMaxBars + ObSwingLen + 5)
                    return;

                _bars15mSeen++;
                ScanOrderBlocks();
                return;
            }

            // ----------------------------------------------------------------
            // Primary 1m series processing
            // ----------------------------------------------------------------
            if (BarsInProgress != 0)
                return;

            // Warmup guard
            if (CurrentBar < Math.Max(AtrPeriod + 10, FvgScanBars + 5))
                return;

            // RangeBuilder must be ready
            if (_rb == null)
                return;

            // Force RangeBuilder current before reading any properties
            _rb.Update();

            // -- Update OB mitigation status on every 1m bar --
            CheckObMitigation();

            // -- Scan FVG zones (also expires dead zones) --
            ScanFvgZones();

            // -- Scan OTE zones (tower candle check) --
            ScanOteZones();

            // -- CISD --
            bool bullCisd = false, bearCisd = false;
            DetectCisd(ref bullCisd, ref bearCisd);

            // -- MSS --
            bool bullMss = false, bearMss = false;
            DetectMss(ref bullMss, ref bearMss);

            // -- SFP --
            bool bullSfp = false, bearSfp = false;
            DetectSfp(ref bullSfp, ref bearSfp);

            // -- Session / time gate --
            DateTime etNow        = ToEasternTime(Time[0]);
            bool inLondon         = IsInLondonKZ(etNow);
            bool inNyOpen         = IsInNyOpenKZ(etNow);
            bool inLondonClose    = IsInLondonCloseKZ(etNow);
            bool inLunch          = IsInLunch(etNow);
            bool inInitialBalance = IsInitialBalance(etNow);
            // LondonClose is a subset of NyOpen (10-11am) — only flag it, don't add extra KZ
            bool inAnyKZ          = inLondon || inNyOpen;

            // ── Fix 5: Hard time block — NEVER fire outside 2-11am ET ───────
            // Belt-and-suspenders: even if session flags leak, this stops afternoon trades.
            var etTod = etNow.TimeOfDay;
            bool inHardBlock = etTod < new TimeSpan(2, 0, 0)    // before London (Asia + overnight handled by RangeBuilder)
                            || etTod >= new TimeSpan(11, 0, 0);  // at or after NY Close KZ end

            // Block signals outside killzones, during lunch, IB, or hard block
            if (!inAnyKZ || inLunch || inInitialBalance || inHardBlock)
            {
                // Print once per minute to show we're alive but gated
                if (CurrentBar % 5 == 0)
                    Print("[CK_Signals] " + etNow.ToString("HH:mm") + " ET | GATED — KZ:" + inAnyKZ + " Lunch:" + inLunch + " HardBlk:" + inHardBlock);
                return;
            }

            // Cooldown
            if (CurrentBar - _lastSignalBar1m < CooldownBars)
                return;

            // ── Fix 3: Per-session trade cap ─────────────────────────────────
            // Reset counters on new date
            DateTime todayDate = etNow.Date;
            if (todayDate != _lastCapDate)
            {
                _londonCount = 0;
                _nyOpenCount = 0;
                _lastCapDate = todayDate;
            }

            // Check cap before scoring
            if (inLondon && !inNyOpen && _londonCount >= MAX_SIGNALS_PER_SESSION)
                return;    // London cap reached
            if (inNyOpen && _nyOpenCount >= MAX_SIGNALS_PER_SESSION)
                return;    // NY Open cap reached

            // Session label for payload
            string sessionTag = GetSessionTag(inLondon, inNyOpen, inLondonClose);

            // HTF bias flags
            bool htfBull = _rb.LondonSweptLow;
            bool htfBear = _rb.LondonSweptHigh;

            Print("[CK_Signals] " + etNow.ToString("HH:mm") + " ET | KZ:" + sessionTag
                + " | HTFBull:" + htfBull + " HTFBear:" + htfBear
                + " | AsiaLocked:" + _rb.AsiaRangeLocked
                + " | AsiaH:" + _rb.LockedAsiaHigh.ToString("F2")
                + " | AsiaL:" + _rb.LockedAsiaLow.ToString("F2")
                + " | CISD B/S:" + bullCisd + "/" + bearCisd
                + " MSS B/S:" + bullMss + "/" + bearMss
                + " | Price:" + Close[0].ToString("F2"));

            // ── Fix 4: Bias-lock kill switch ─────────────────────────────────
            // If LondonSweptHigh (bearish bias) but price has already blasted
            // through PDH by 20+ pts, the sweep reversed — kill bear signals.
            if (htfBear && _rb != null && _rb.CurrentPDH > 0
                && Close[0] > _rb.CurrentPDH + 20.0)
            {
                htfBear = false;   // Don't short above PDH+20 on a sweep-reversal day
            }

            // ── LONG evaluation ──
            if (htfBull)
            {
                int score = ScoreLong(bullCisd, bullMss, bullSfp, inAnyKZ);
                Print("[CK_Signals] LONG score=" + score + "/7 (need " + MinConf + ") — FVG:" + PriceInBullFvg(Close[0]) + " OB:" + PriceInBullOb(Close[0]) + " Disc:" + _rb.PriceInDiscount);
                if (score >= MinConf)
                {
                    Print("[CK_Signals] >>> FIRING LONG @ " + Close[0].ToString("F2") + " score=" + score + "/7");
                    FireSignal(true, score, sessionTag);
                    // Increment per-session counter after firing
                    if (inLondon && !inNyOpen) _londonCount++;
                    if (inNyOpen)              _nyOpenCount++;
                }
            }

            // ── SHORT evaluation ──
            if (htfBear)
            {
                int score = ScoreShort(bearCisd, bearMss, bearSfp, inAnyKZ);
                Print("[CK_Signals] SHORT score=" + score + "/7 (need " + MinConf + ") — FVG:" + PriceInBearFvg(Close[0]) + " OB:" + PriceInBearOb(Close[0]) + " Prem:" + _rb.PriceInPremium);
                if (score >= MinConf)
                {
                    Print("[CK_Signals] >>> FIRING SHORT @ " + Close[0].ToString("F2") + " score=" + score + "/7");
                    FireSignal(false, score, sessionTag);
                    if (inLondon && !inNyOpen) _londonCount++;
                    if (inNyOpen)              _nyOpenCount++;
                }
            }
        }

        // ── Confluence scorers ───────────────────────────────────────────────

        private int ScoreLong(bool cisd, bool mss, bool sfp, bool inKz)
        {
            int s = 0;
            s += 1;                                           // 1. HTF Bias (caller guarantees LondonSweptLow)
            if (_rb.PriceInDiscount)       s += 1;           // 2. Zone
            if (PriceInBullFvg(Close[0])) s += 1;           // 3. FVG
            if (PriceInBullOb(Close[0]))  s += 1;           // 4. OB
            if (cisd)                      s += 1;           // 5. CISD
            if (mss)                       s += 1;           // 6. MSS
            if (inKz)                      s += 1;           // 7. Killzone
            if (sfp)                       s = Math.Min(7, s + 1);  // Bonus SFP
            if (PriceInOteZone(Close[0], true)) s = Math.Min(7, s + 1); // Bonus OTE
            return s;
        }

        private int ScoreShort(bool cisd, bool mss, bool sfp, bool inKz)
        {
            int s = 0;
            s += 1;                                           // 1. HTF Bias
            if (_rb.PriceInPremium)        s += 1;           // 2. Zone
            if (PriceInBearFvg(Close[0])) s += 1;           // 3. FVG
            if (PriceInBearOb(Close[0]))  s += 1;           // 4. OB
            if (cisd)                      s += 1;           // 5. CISD
            if (mss)                       s += 1;           // 6. MSS
            if (inKz)                      s += 1;           // 7. Killzone
            if (sfp)                       s = Math.Min(7, s + 1);
            if (PriceInOteZone(Close[0], false)) s = Math.Min(7, s + 1);
            return s;
        }

        // ════════════════════════════════════════════════════════════════════
        //  SESSION HELPERS
        // ════════════════════════════════════════════════════════════════════

        private static readonly TimeZoneInfo _etZone = GetEasternZone();

        private static TimeZoneInfo GetEasternZone()
        {
            try { return TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time"); }
            catch { }
            try { return TimeZoneInfo.FindSystemTimeZoneById("America/New_York"); }
            catch { }
            return TimeZoneInfo.Local;
        }

        private DateTime ToEasternTime(DateTime t)
        {
            // NT8 bar Time[] is local machine time.  Convert to ET for session checks.
            if (t.Kind == DateTimeKind.Unspecified)
                t = DateTime.SpecifyKind(t, DateTimeKind.Local);
            try { return TimeZoneInfo.ConvertTime(t, _etZone); }
            catch { return t; }
        }

        private static bool IsInLondonKZ(DateTime et)
        {
            // 02:00 – 05:00 ET
            var ts = et.TimeOfDay;
            return ts >= new TimeSpan(2, 0, 0) && ts < new TimeSpan(5, 0, 0);
        }

        private static bool IsInNyOpenKZ(DateTime et)
        {
            // 09:30 – 11:00 ET
            var ts = et.TimeOfDay;
            return ts >= new TimeSpan(9, 30, 0) && ts < new TimeSpan(11, 0, 0);
        }

        private static bool IsInLondonCloseKZ(DateTime et)
        {
            // 10:00 – 11:00 ET (subset of NY Open KZ — label only, not an extra window)
            // Fix 2: This is purely a label flag now. Actual session gating handled by
            // inHardBlock (hard block >= 11am) so London Close can never fire after 11am.
            var ts = et.TimeOfDay;
            return ts >= new TimeSpan(10, 0, 0) && ts < new TimeSpan(11, 0, 0);
        }

        private static bool IsInLunch(DateTime et)
        {
            // 11:00 – 13:00 ET — blocked (redundant with inHardBlock but kept as guard)
            var ts = et.TimeOfDay;
            return ts >= new TimeSpan(11, 0, 0) && ts < new TimeSpan(13, 0, 0);
        }

        private static bool IsInitialBalance(DateTime et)
        {
            // 09:30 – 09:35 ET — block first bar of NY open
            var ts = et.TimeOfDay;
            return ts >= new TimeSpan(9, 30, 0) && ts < new TimeSpan(9, 35, 0);
        }

        private static string GetSessionTag(bool london, bool nyOpen, bool londonClose)
        {
            // Fix 2: Session tags now match the Railway DB values exactly (lowercase_underscore)
            // so MuzziBot's session-aware risk params fire correctly.
            if (londonClose) return "london_close";
            if (nyOpen)      return "ny_open";
            if (london)      return "london";
            return "london";  // fallback — never fires post-fix due to inHardBlock
        }

        // ════════════════════════════════════════════════════════════════════
        //  FVG DETECTION (1m)
        // ════════════════════════════════════════════════════════════════════

        private void ScanFvgZones()
        {
            if (CurrentBar < FvgScanBars + 3)
                return;

            // Expire zones that price closed through
            foreach (FvgZone z in _fvgZones)
            {
                if (!z.Alive) continue;
                if ( z.IsBull && Close[0] < z.Bottom) z.Alive = false;
                if (!z.IsBull && Close[0] > z.Top)    z.Alive = false;
            }

            // Scan for new FVGs: need bars i, i+1, i+2 where i=0 is current
            // Pattern uses barsAgo: [i] newest, [i+2] oldest
            int maxI = Math.Min(FvgScanBars, CurrentBar - 2);

            for (int i = 0; i < maxI; i++)
            {
                // ── Bull FVG ─────────────────────────────────────────────
                // Condition: Low[i] > High[i+2]  →  gap exists above High[i+2]
                double bullGapBot = High[i + 2];
                double bullGapTop = Low[i];

                if (bullGapTop - bullGapBot >= FvgMinPts && Close[i + 1] > Open[i + 1])
                {
                    string tag = "FVG_B_" + CurrentBar + "_" + i;
                    if (!FvgExists(tag))
                    {
                        var z = new FvgZone
                        {
                            IsBull    = true,
                            Top       = bullGapTop,
                            Bottom    = bullGapBot,
                            BirthBar1m = CurrentBar,
                            Alive     = true,
                            Tag       = tag
                        };
                        _fvgZones.Add(z);

                        if (ShowFvg)
                        {
                            // Draw semi-transparent green rectangle
                            // barsAgo: right edge = i (newer), left edge = i+2 (older)
                            Draw.Rectangle(this, tag,
                                           false,          // autoScale
                                           i + 2,          // startBarsAgo (left / older bar)
                                           bullGapBot,     // y1
                                           i,              // endBarsAgo   (right / newer bar)
                                           bullGapTop,     // y2
                                           Brushes.Transparent,
                                           Brushes.LimeGreen,
                                           30);
                        }
                    }
                }

                // ── Bear FVG ─────────────────────────────────────────────
                // Condition: High[i] < Low[i+2]  →  gap exists below Low[i+2]
                double bearGapTop = Low[i + 2];
                double bearGapBot = High[i];

                if (bearGapTop - bearGapBot >= FvgMinPts && Close[i + 1] < Open[i + 1])
                {
                    string tag = "FVG_S_" + CurrentBar + "_" + i;
                    if (!FvgExists(tag))
                    {
                        var z = new FvgZone
                        {
                            IsBull    = false,
                            Top       = bearGapTop,
                            Bottom    = bearGapBot,
                            BirthBar1m = CurrentBar,
                            Alive     = true,
                            Tag       = tag
                        };
                        _fvgZones.Add(z);

                        if (ShowFvg)
                        {
                            Draw.Rectangle(this, tag,
                                           false,
                                           i + 2,
                                           bearGapBot,
                                           i,
                                           bearGapTop,
                                           Brushes.Transparent,
                                           Brushes.Red,
                                           30);
                        }
                    }
                }
            }
        }

        private bool FvgExists(string tag)
        {
            foreach (FvgZone z in _fvgZones)
                if (z.Tag == tag) return true;
            return false;
        }

        private bool PriceInBullFvg(double price)
        {
            foreach (FvgZone z in _fvgZones)
                if (z.Alive && z.IsBull && price >= z.Bottom && price <= z.Top) return true;
            return false;
        }

        private bool PriceInBearFvg(double price)
        {
            foreach (FvgZone z in _fvgZones)
                if (z.Alive && !z.IsBull && price >= z.Bottom && price <= z.Top) return true;
            return false;
        }

        // ════════════════════════════════════════════════════════════════════
        //  ORDER BLOCK DETECTION (15m secondary series)
        // ════════════════════════════════════════════════════════════════════

        private void ScanOrderBlocks()
        {
            // Build a rough ATR on 15m using raw bar ranges
            int atrLookback = Math.Min(14, CurrentBars[IDX_15M] - 1);
            if (atrLookback < 3) return;

            double atr15 = 0;
            for (int k = 1; k <= atrLookback; k++)
                atr15 += Highs[IDX_15M][k] - Lows[IDX_15M][k];
            atr15 /= atrLookback;

            double impulseThresh = atr15 * 0.5;

            int scanLimit = Math.Min(ObMaxBars, CurrentBars[IDX_15M] - ObSwingLen - 2);

            // ── Bull OB: last bearish candle before ObSwingLen bullish impulse bars ──
            for (int i = ObSwingLen + 1; i <= scanLimit; i++)
            {
                // Candidate OB bar at index i must be bearish
                if (Closes[IDX_15M][i] >= Opens[IDX_15M][i]) continue;

                // ObSwingLen bars NEWER than i (indices i-1 .. i-ObSwingLen) all close up
                bool impulseOk = true;
                double totalUp = 0;
                for (int j = 1; j <= ObSwingLen; j++)
                {
                    int idx = i - j;
                    if (idx < 0) { impulseOk = false; break; }
                    if (Closes[IDX_15M][idx] <= Opens[IDX_15M][idx]) { impulseOk = false; break; }
                    totalUp += Closes[IDX_15M][idx] - Opens[IDX_15M][idx];
                }
                if (!impulseOk || totalUp < impulseThresh) continue;

                double obHigh = Math.Max(Opens[IDX_15M][i], Closes[IDX_15M][i]);
                double obLow  = Math.Min(Opens[IDX_15M][i], Closes[IDX_15M][i]);
                string tag    = "OB_BULL_" + CurrentBars[IDX_15M] + "_" + i;

                if (!ObExists(tag))
                {
                    bool mit = IsMitigatedOn1m(obLow, obHigh);
                    _obZones.Add(new ObZone
                    {
                        IsBull      = true,
                        Top         = obHigh,
                        Bottom      = obLow,
                        BirthBar15m = CurrentBars[IDX_15M],
                        Mitigated   = mit,
                        Tag         = tag
                    });

                    if (ShowOb && !mit)
                    {
                        // Draw on 1m chart: i 15m-bars ago ≈ i*15 1m-bars ago
                        int barsAgo1m = i * 15;
                        if (barsAgo1m <= CurrentBar)
                            Draw.Rectangle(this, tag,
                                           false,
                                           barsAgo1m, obLow,
                                           0,         obHigh,
                                           Brushes.Transparent,
                                           Brushes.DodgerBlue,
                                           40);
                    }
                }
            }

            // ── Bear OB: last bullish candle before ObSwingLen bearish impulse bars ──
            for (int i = ObSwingLen + 1; i <= scanLimit; i++)
            {
                if (Closes[IDX_15M][i] <= Opens[IDX_15M][i]) continue;

                bool impulseOk = true;
                double totalDn = 0;
                for (int j = 1; j <= ObSwingLen; j++)
                {
                    int idx = i - j;
                    if (idx < 0) { impulseOk = false; break; }
                    if (Closes[IDX_15M][idx] >= Opens[IDX_15M][idx]) { impulseOk = false; break; }
                    totalDn += Opens[IDX_15M][idx] - Closes[IDX_15M][idx];
                }
                if (!impulseOk || totalDn < impulseThresh) continue;

                double obHigh = Math.Max(Opens[IDX_15M][i], Closes[IDX_15M][i]);
                double obLow  = Math.Min(Opens[IDX_15M][i], Closes[IDX_15M][i]);
                string tag    = "OB_BEAR_" + CurrentBars[IDX_15M] + "_" + i;

                if (!ObExists(tag))
                {
                    bool mit = IsMitigatedOn1m(obLow, obHigh);
                    _obZones.Add(new ObZone
                    {
                        IsBull      = false,
                        Top         = obHigh,
                        Bottom      = obLow,
                        BirthBar15m = CurrentBars[IDX_15M],
                        Mitigated   = mit,
                        Tag         = tag
                    });

                    if (ShowOb && !mit)
                    {
                        int barsAgo1m = i * 15;
                        if (barsAgo1m <= CurrentBar)
                            Draw.Rectangle(this, tag,
                                           false,
                                           barsAgo1m, obLow,
                                           0,         obHigh,
                                           Brushes.Transparent,
                                           Brushes.OrangeRed,
                                           40);
                    }
                }
            }
        }

        // Check whether price has already closed inside an OB zone (on 1m)
        private bool IsMitigatedOn1m(double low, double high)
        {
            int check = Math.Min(20, CurrentBar);
            for (int k = 0; k < check; k++)
                if (Close[k] >= low && Close[k] <= high) return true;
            return false;
        }

        // Called every 1m bar to update mitigation status
        private void CheckObMitigation()
        {
            foreach (ObZone ob in _obZones)
            {
                if (ob.Mitigated) continue;
                if (Close[0] >= ob.Bottom && Close[0] <= ob.Top)
                    ob.Mitigated = true;
            }
        }

        private bool ObExists(string tag)
        {
            foreach (ObZone ob in _obZones)
                if (ob.Tag == tag) return true;
            return false;
        }

        private bool PriceInBullOb(double price)
        {
            foreach (ObZone ob in _obZones)
                if (ob.IsBull && !ob.Mitigated && price >= ob.Bottom && price <= ob.Top) return true;
            return false;
        }

        private bool PriceInBearOb(double price)
        {
            foreach (ObZone ob in _obZones)
                if (!ob.IsBull && !ob.Mitigated && price >= ob.Bottom && price <= ob.Top) return true;
            return false;
        }

        // ════════════════════════════════════════════════════════════════════
        //  CISD DETECTION (1m)
        // ════════════════════════════════════════════════════════════════════

        private void DetectCisd(ref bool bull, ref bool bear)
        {
            if (CurrentBar < 2) return;

            // ── Bull CISD ────────────────────────────────────────────────
            // Current bar is green AND its body close breaks above prior red candle's body high
            bool currGreen   = Close[0] > Open[0];
            bool prevRed     = Close[1] < Open[1];
            double prevBodyH = Math.Max(Open[1], Close[1]);

            if (currGreen && prevRed && Close[0] > prevBodyH)
            {
                bull = true;
                if (ShowCisd)
                {
                    // Per user instruction: bullish CISD gets a RED label
                    string tag = "CISD_B_" + CurrentBar;
                    Draw.Text(this, tag, false, "C", 0,
                              Low[0] - 4 * TickSize, 0,
                              Brushes.Red,
                              new NinjaTrader.Gui.Tools.SimpleFont("Arial", 9),
                              TextAlignment.Center,
                              Brushes.Transparent, Brushes.Transparent, 0);
                }
            }

            // ── Bear CISD ────────────────────────────────────────────────
            // Current bar is red AND its body close breaks below prior green candle's body low
            bool currRed     = Close[0] < Open[0];
            bool prevGreen   = Close[1] > Open[1];
            double prevBodyL = Math.Min(Open[1], Close[1]);

            if (currRed && prevGreen && Close[0] < prevBodyL)
            {
                bear = true;
                if (ShowCisd)
                {
                    // Per user instruction: bearish CISD gets a GREEN label
                    string tag = "CISD_S_" + CurrentBar;
                    Draw.Text(this, tag, false, "C", 0,
                              High[0] + 4 * TickSize, 0,
                              Brushes.Lime,
                              new NinjaTrader.Gui.Tools.SimpleFont("Arial", 9),
                              TextAlignment.Center,
                              Brushes.Transparent, Brushes.Transparent, 0);
                }
            }
        }

        // ════════════════════════════════════════════════════════════════════
        //  MSS DETECTION (1m — 10-bar swing)
        // ════════════════════════════════════════════════════════════════════

        private void DetectMss(ref bool bull, ref bool bear)
        {
            if (CurrentBar < 11) return;

            double swHigh = double.MinValue;
            double swLow  = double.MaxValue;
            for (int i = 1; i <= 10; i++)
            {
                if (High[i] > swHigh) swHigh = High[i];
                if (Low[i]  < swLow)  swLow  = Low[i];
            }

            // Bull MSS: CLOSE above every high in the lookback window
            if (Close[0] > swHigh)
            {
                bull = true;
                if (ShowMss)
                    Draw.TriangleUp(this, "MSS_B_" + CurrentBar, false,
                                    0, Low[0] - 6 * TickSize, Brushes.Cyan);
            }

            // Bear MSS: CLOSE below every low in the lookback window
            if (Close[0] < swLow)
            {
                bear = true;
                if (ShowMss)
                    Draw.TriangleDown(this, "MSS_S_" + CurrentBar, false,
                                      0, High[0] + 6 * TickSize, Brushes.Magenta);
            }
        }

        // ════════════════════════════════════════════════════════════════════
        //  SFP DETECTION (1m — 10-bar swing)
        // ════════════════════════════════════════════════════════════════════

        private void DetectSfp(ref bool bull, ref bool bear)
        {
            if (CurrentBar < 11) return;

            double swHigh = double.MinValue;
            double swLow  = double.MaxValue;
            for (int i = 1; i <= 10; i++)
            {
                if (High[i] > swHigh) swHigh = High[i];
                if (Low[i]  < swLow)  swLow  = Low[i];
            }

            // Bull SFP: wick swept below prior swing low but closed ABOVE it (reversal)
            if (Low[0] < swLow && Close[0] > swLow)
                bull = true;

            // Bear SFP: wick swept above prior swing high but closed BELOW it
            if (High[0] > swHigh && Close[0] < swHigh)
                bear = true;
        }

        // ════════════════════════════════════════════════════════════════════
        //  OTE ZONE DETECTION (1m — tower candle 62–79% retracement)
        // ════════════════════════════════════════════════════════════════════

        private void ScanOteZones()
        {
            if (CurrentBar < AtrPeriod + 5) return;

            double curAtr    = _atr1m[0];
            double towerMin  = curAtr * 1.5;
            double bodySize  = Math.Abs(Close[1] - Open[1]);

            if (bodySize < towerMin) return;  // previous bar was not a tower candle

            bool   towerBull  = Close[1] > Open[1];
            double towerHigh  = Math.Max(Open[1], Close[1]);
            double towerLow   = Math.Min(Open[1], Close[1]);
            double towerRange = towerHigh - towerLow;

            // 62–79% retracement zone
            double zoneTop, zoneBot;
            if (towerBull)
            {
                // Bull tower: price moved up. OTE zone = 62–79% pullback from high
                zoneTop = towerHigh - towerRange * 0.62;
                zoneBot = towerHigh - towerRange * 0.79;
            }
            else
            {
                // Bear tower: price moved down. OTE zone = 62–79% pullback from low
                zoneBot = towerLow  + towerRange * 0.62;
                zoneTop = towerLow  + towerRange * 0.79;
            }

            string tag = "OTE_" + CurrentBar;

            bool exists = false;
            foreach (OteZone z in _oteZones)
                if (z.Tag == tag) { exists = true; break; }

            if (!exists)
            {
                _oteZones.Add(new OteZone
                {
                    IsBull    = towerBull,
                    Top       = zoneTop,
                    Bottom    = zoneBot,
                    BirthBar1m = CurrentBar,
                    Tag       = tag
                });

                if (ShowOte)
                    Draw.Rectangle(this, tag,
                                   false,
                                   1,       zoneBot,
                                   0,       zoneTop,
                                   Brushes.Transparent,
                                   Brushes.Orange,
                                   40);
            }

            // Expire OTE zones older than 20 bars
            _oteZones.RemoveAll(z => CurrentBar - z.BirthBar1m > 20);
        }

        private bool PriceInOteZone(double price, bool bullDir)
        {
            foreach (OteZone z in _oteZones)
                if (z.IsBull == bullDir && price >= z.Bottom && price <= z.Top) return true;
            return false;
        }

        // ════════════════════════════════════════════════════════════════════
        //  SIGNAL FIRING + CHART DRAW
        // ════════════════════════════════════════════════════════════════════

        private void FireSignal(bool isLong, int score, string session)
        {
            _lastSignalBar1m = CurrentBar;

            double entry = Close[0];
            double sl, tp1, tp2;

            if (isLong)
            {
                sl  = entry - SlPts;
                tp1 = entry + Tp1Pts;
                tp2 = entry + Tp2Pts;
            }
            else
            {
                sl  = entry + SlPts;
                tp1 = entry - Tp1Pts;
                tp2 = entry - Tp2Pts;
            }

            string label = (isLong ? "LONG " : "SHORT ") + score + "/7";

            if (ShowSignals)
            {
                if (isLong)
                {
                    string aTag = "SIG_L_" + CurrentBar;
                    Draw.ArrowUp(this, aTag, false, 0, Low[0]  - 5 * TickSize, Brushes.Lime);
                    Draw.Text(this, aTag + "_T", false, label,
                              0, Low[0] - 10 * TickSize, 0,
                              Brushes.Lime,
                              new NinjaTrader.Gui.Tools.SimpleFont("Arial", 8) { Bold = true },
                              TextAlignment.Center,
                              Brushes.Transparent, Brushes.Transparent, 0);
                }
                else
                {
                    string aTag = "SIG_S_" + CurrentBar;
                    Draw.ArrowDown(this, aTag, false, 0, High[0] + 5 * TickSize, Brushes.Red);
                    Draw.Text(this, aTag + "_T", false, label,
                              0, High[0] + 10 * TickSize, 0,
                              Brushes.Red,
                              new NinjaTrader.Gui.Tools.SimpleFont("Arial", 8) { Bold = true },
                              TextAlignment.Center,
                              Brushes.Transparent, Brushes.Transparent, 0);
                }
            }

            // Dispatch HTTP POST on thread pool (non-blocking)
            PostSignal(isLong ? "long" : "short", entry, sl, tp1, tp2, session, score);
        }

        // ════════════════════════════════════════════════════════════════════
        //  HTTP POST TO RAILWAY
        // ════════════════════════════════════════════════════════════════════

        private void PostSignal(string direction, double entry, double sl,
                                double tp1, double tp2, string session, int score)
        {
            bool inDiscount = _rb != null && _rb.PriceInDiscount;
            bool inPremium  = _rb != null && _rb.PriceInPremium;
            bool isLong     = direction == "long";

            string endpoint = (ServerUrl ?? string.Empty).TrimEnd('/') + "/api/webhook";

            // Build JSON string — source:"tradingview" is critical for Railway routing
            string json = string.Concat(
                "{",
                "\"source\":\"tradingview\",",
                "\"long_signal\":",   isLong    ? "1" : "0",   ",",
                "\"short_signal\":",  isLong    ? "0" : "1",   ",",
                "\"close\":",         entry.ToString("F2"),     ",",
                "\"sl\":",            sl.ToString("F2"),        ",",
                "\"tp1\":",           tp1.ToString("F2"),       ",",
                "\"tp2\":",           tp2.ToString("F2"),       ",",
                "\"session\":\"",     session,                  "\",",
                "\"killzone\":\"",   session,                  "\",",
                "\"discount\":",      inDiscount ? "true" : "false", ",",
                "\"premium\":",       inPremium  ? "true" : "false", ",",
                "\"confidence\":",    score.ToString(),
                "}"
            );

            byte[] body = Encoding.UTF8.GetBytes(json);

            // Snapshot mutable state before crossing thread boundary
            string capturedEndpoint = endpoint;
            byte[] capturedBody     = body;

            ThreadPool.QueueUserWorkItem(state =>
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(capturedEndpoint);
                    req.Method             = "POST";
                    req.ContentType        = "application/json";
                    req.Timeout            = 4000;
                    req.ContentLength      = capturedBody.Length;
                    req.AllowAutoRedirect  = false;  // CRITICAL: prevent POST→GET redirect on 301
                    // NO User-Agent header — NT8 blocks it

                    using (Stream stream = req.GetRequestStream())
                        stream.Write(capturedBody, 0, capturedBody.Length);

                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        // Fire-and-forget; response body intentionally discarded
                    }
                }
                catch (Exception ex)
                {
                    // Log to NT8 Output window without crashing the indicator
                    Print("[CK_Signals] POST error to " + capturedEndpoint + " : " + ex.Message);
                    Print("[CK_Signals] JSON: " + Encoding.UTF8.GetString(capturedBody));
                }
            });
        }
    }
}

#region NinjaScript generated code. Neither change nor remove.
namespace NinjaTrader.NinjaScript.Indicators
{
    public partial class Indicator : NinjaTrader.Gui.NinjaScript.IndicatorRenderBase
    {
        private NQ_RangeBuilder[] cacheNQ_RangeBuilder;
        public NQ_RangeBuilder NQ_RangeBuilder(int atrPeriod) { return NQ_RangeBuilder(Input, atrPeriod); }
        public NQ_RangeBuilder NQ_RangeBuilder(ISeries<double> input, int atrPeriod)
        {
            if (cacheNQ_RangeBuilder != null)
                for (int idx = 0; idx < cacheNQ_RangeBuilder.Length; idx++)
                    if (cacheNQ_RangeBuilder[idx] != null && cacheNQ_RangeBuilder[idx].AtrPeriod == atrPeriod && cacheNQ_RangeBuilder[idx].EqualsInput(input))
                        return cacheNQ_RangeBuilder[idx];
            return CacheIndicator<NQ_RangeBuilder>(new NQ_RangeBuilder { AtrPeriod = atrPeriod }, input, ref cacheNQ_RangeBuilder);
        }
    }
}
namespace NinjaTrader.NinjaScript.MarketAnalyzerColumns
{
    public partial class MarketAnalyzerColumn : MarketAnalyzerColumnBase
    {
        public Indicators.NQ_RangeBuilder NQ_RangeBuilder(int atrPeriod) { return indicator.NQ_RangeBuilder(Input, atrPeriod); }
        public Indicators.NQ_RangeBuilder NQ_RangeBuilder(ISeries<double> input, int atrPeriod) { return indicator.NQ_RangeBuilder(input, atrPeriod); }
    }
}
namespace NinjaTrader.NinjaScript.Strategies
{
    public partial class Strategy : NinjaTrader.Gui.NinjaScript.StrategyRenderBase
    {
        public Indicators.NQ_RangeBuilder NQ_RangeBuilder(int atrPeriod) { return indicator.NQ_RangeBuilder(Input, atrPeriod); }
        public Indicators.NQ_RangeBuilder NQ_RangeBuilder(ISeries<double> input, int atrPeriod) { return indicator.NQ_RangeBuilder(input, atrPeriod); }
    }
}
#endregion
