// NQ_Analyst_Bridge.cpp
// Sierra Chart ACSIL Study — sends enriched order flow data to NQ Analyst dashboard
// 
// INSTALL:
//   1. Copy this file to C:\SierraChart\ACS_Source\
//   2. In Sierra Chart: Analysis → Studies → Add Custom Study → NQ Analyst Bridge
//   3. Set your Railway webhook URL in the study inputs
//   4. Apply to your NQ1! chart (any timeframe, 1m or 15m recommended)
//
// SENDS ON EVERY BAR CLOSE:
//   price, OHLCV, delta, CVD, DOM bid/ask stack, absorption, POC, imbalance
//
// REQUIRES: Sierra Chart Package 2+ (for DOM/depth data)

#include "sierrachart.h"

SCDLLName("NQ Analyst Bridge v2")

SCSFExport scsf_NQAnalystBridge(SCStudyInterfaceRef sc)
{
  // ── Input definitions ──────────────────────────────────────────────────────
  SCInputRef WebhookURL      = sc.Input[0];
  SCInputRef SendIntervalSec = sc.Input[1];
  SCInputRef DOMDepthLevels  = sc.Input[2];
  SCInputRef LargeTradeQty   = sc.Input[3];
  SCInputRef EnableDebugLog  = sc.Input[4];

  if (sc.SetDefaults)
  {
    sc.GraphName          = "NQ Analyst Bridge";
    sc.StudyDescription   = "Sends live order flow data to NQ Analyst AI dashboard";
    sc.AutoLoop           = 0; // manual loop — we control when we fire
    sc.UpdateAlways       = 1; // update on every tick
    sc.MaintainAdditionalChartDataArrays = 1;
    sc.UsesMarketDepthData = 1;

    WebhookURL.Name       = "Railway Webhook URL";
    WebhookURL.SetString("https://nq-analyst-production.up.railway.app/api/sierra-webhook");

    SendIntervalSec.Name  = "Send Interval (seconds)";
    SendIntervalSec.SetInt(30);
    SendIntervalSec.SetIntLimits(5, 300);

    DOMDepthLevels.Name   = "DOM Depth Levels to Sum";
    DOMDepthLevels.SetInt(10);
    DOMDepthLevels.SetIntLimits(1, 50);

    LargeTradeQty.Name    = "Large Trade Threshold (contracts)";
    LargeTradeQty.SetInt(20);
    LargeTradeQty.SetIntLimits(1, 500);

    EnableDebugLog.Name   = "Enable Debug Logging";
    EnableDebugLog.SetYesNo(0);

    return;
  }

  // ── Persistent state ────────────────────────────────────────────────────────
  int&   RequestState    = sc.GetPersistentInt(1);
  int&   LastSentBarIdx  = sc.GetPersistentInt(2);
  int64_t& LastSentTime  = sc.GetPersistentInt64(3);

  // ── Throttle: only send every N seconds ────────────────────────────────────
  SCDateTime now = sc.CurrentSystemDateTime;
  int64_t nowMs  = (int64_t)now.ToUNIXTime() * 1000;
  int intervalMs = SendIntervalSec.GetInt() * 1000;

  bool shouldSend = false;

  // Send on new bar close
  if (sc.GetBarHasClosedStatus(sc.Index) == BHCS_BAR_HAS_CLOSED)
    shouldSend = true;

  // Also send on interval even if bar hasn't closed
  if ((nowMs - LastSentTime) >= intervalMs)
    shouldSend = true;

  // Wait for previous HTTP request to finish
  if (RequestState == HTTP_REQUEST_MADE)
  {
    if (sc.HTTPRequestID != 0)
    {
      // Still waiting
      return;
    }
    RequestState = HTTP_REQUEST_RECEIVED;
  }

  if (!shouldSend)
    return;

  // ── Gather OHLCV ────────────────────────────────────────────────────────────
  int idx = sc.Index;
  float barOpen   = sc.Open[idx];
  float barHigh   = sc.High[idx];
  float barLow    = sc.Low[idx];
  float barClose  = sc.Close[idx];
  float barVol    = sc.Volume[idx];

  // ── Delta calculation ───────────────────────────────────────────────────────
  // sc.AskVolume and sc.BidVolume are available when market depth is enabled
  float buyVol  = sc.AskVolume[idx];  // trades that hit the ask = buyer initiated
  float sellVol = sc.BidVolume[idx];  // trades that hit the bid = seller initiated
  float delta   = buyVol - sellVol;

  // CVD — sum delta across all bars
  float cvd = 0.0f;
  for (int i = sc.DataStartIndex; i <= idx; i++)
    cvd += (sc.AskVolume[i] - sc.BidVolume[i]);

  // ── DOM Depth ───────────────────────────────────────────────────────────────
  int depthLevels = DOMDepthLevels.GetInt();
  float totalBidSize = 0.0f;
  float totalAskSize = 0.0f;
  float bestBid = 0.0f;
  float bestAsk = 0.0f;

  // Get DOM from Sierra Chart market depth data
  int domEntryCount = sc.GetBidMarketDepthNumberOfLevels();
  for (int i = 0; i < depthLevels && i < domEntryCount; i++)
  {
    s_MarketDepthEntry depthEntry;
    if (sc.GetBidMarketDepthEntryAtLevel(depthEntry, i) == 1)
    {
      totalBidSize += depthEntry.Quantity;
      if (i == 0) bestBid = depthEntry.Price;
    }
  }

  int askEntryCount = sc.GetAskMarketDepthNumberOfLevels();
  for (int i = 0; i < depthLevels && i < askEntryCount; i++)
  {
    s_MarketDepthEntry depthEntry;
    if (sc.GetAskMarketDepthEntryAtLevel(depthEntry, i) == 1)
    {
      totalAskSize += depthEntry.Quantity;
      if (i == 0) bestAsk = depthEntry.Price;
    }
  }

  float spread = (bestAsk > 0 && bestBid > 0) ? bestAsk - bestBid : 0.0f;

  // ── Imbalance detection ─────────────────────────────────────────────────────
  // Imbalance = one side has 3x+ the other
  int imbalanceBull = 0;
  int imbalanceBear = 0;
  if (totalAskSize > 0 && totalBidSize > totalAskSize * 3.0f) imbalanceBull = 1;
  if (totalBidSize > 0 && totalAskSize > totalBidSize * 3.0f) imbalanceBear = 1;

  // ── Absorption detection ────────────────────────────────────────────────────
  // Bullish absorption: large sell volume but price didn't drop (close >= open)
  // Bearish absorption: large buy volume but price didn't rise (close <= open)
  int largeThresh = LargeTradeQty.GetInt();
  int absorptionBull = 0;
  int absorptionBear = 0;
  int largeTradeCount = 0;
  int largeBuyCount = 0;
  int largeSellCount = 0;

  // Count large trades this bar
  if (sellVol >= largeThresh && barClose >= barOpen) { absorptionBull = 1; }
  if (buyVol  >= largeThresh && barClose <= barOpen) { absorptionBear = 1; }
  if (buyVol  >= largeThresh) largeBuyCount++;
  if (sellVol >= largeThresh) largeSellCount++;
  largeTradeCount = largeBuyCount + largeSellCount;

  // ── VWAP (use Sierra's built-in if available, else calculate) ───────────────
  // Sierra Chart provides VWAP via sc.VolumeAtPrice if enabled
  // We'll send the current close as a proxy and note the VWAP separately
  // For proper VWAP, add a VWAP study to chart and reference its subgraph
  // For now we compute a simple session VWAP from available data
  float vwapNum = 0.0f;
  float vwapDen = 0.0f;
  for (int i = sc.DataStartIndex; i <= idx; i++)
  {
    float typicalPrice = (sc.High[i] + sc.Low[i] + sc.Close[i]) / 3.0f;
    float vol = sc.Volume[i];
    vwapNum += typicalPrice * vol;
    vwapDen += vol;
  }
  float vwap = (vwapDen > 0) ? vwapNum / vwapDen : barClose;

  // ── POC from Volume at Price ────────────────────────────────────────────────
  // Use a simplified POC: find the close price with the highest volume in recent bars
  float pocPrice = barClose; // default fallback
  float pocVol   = 0.0f;
  for (int i = sc.DataStartIndex; i <= idx; i++)
  {
    float vol = sc.Volume[i];
    if (vol > pocVol)
    {
      pocVol   = vol;
      pocPrice = sc.Close[i];
    }
  }

  // ── Timestamp ───────────────────────────────────────────────────────────────
  SCDateTime barTime = sc.BaseDateTimeIn[idx];
  int64_t barTimestampMs = (int64_t)barTime.ToUNIXTime() * 1000;

  // ── Build JSON payload ──────────────────────────────────────────────────────
  SCString ticker   = sc.Symbol;
  SCString timeframe;
  timeframe.Format("%d", sc.SecondsPerBar / 60); // minutes

  SCString json;
  json.Format(
    "{"
    "\"source\":\"sierra_chart\","
    "\"ticker\":\"%s\","
    "\"timeframe\":\"%s\","
    "\"timestamp\":%lld,"
    "\"open\":%.2f,"
    "\"high\":%.2f,"
    "\"low\":%.2f,"
    "\"close\":%.2f,"
    "\"volume\":%.0f,"
    "\"vwap\":%.2f,"
    "\"delta\":%.0f,"
    "\"cvd\":%.0f,"
    "\"buyVolume\":%.0f,"
    "\"sellVolume\":%.0f,"
    "\"bidStackSize\":%.0f,"
    "\"askStackSize\":%.0f,"
    "\"bestBid\":%.2f,"
    "\"bestAsk\":%.2f,"
    "\"spread\":%.2f,"
    "\"absorptionBull\":%d,"
    "\"absorptionBear\":%d,"
    "\"imbalanceBull\":%d,"
    "\"imbalanceBear\":%d,"
    "\"largeTradeCount\":%d,"
    "\"largeBuyCount\":%d,"
    "\"largeSellCount\":%d,"
    "\"vapPoc\":%.2f"
    "}",
    ticker.GetChars(),
    timeframe.GetChars(),
    barTimestampMs,
    barOpen, barHigh, barLow, barClose,
    barVol, vwap,
    delta, cvd,
    buyVol, sellVol,
    totalBidSize, totalAskSize,
    bestBid, bestAsk, spread,
    absorptionBull, absorptionBear,
    imbalanceBull, imbalanceBear,
    largeTradeCount, largeBuyCount, largeSellCount,
    pocPrice
  );

  // ── Fire HTTP POST ──────────────────────────────────────────────────────────
  SCString url = WebhookURL.GetString();

  n_ACSIL::s_HTTPHeader header;
  header.Name  = "Content-Type";
  header.Value = "application/json";

  if (!sc.MakeHTTPPOSTRequest(url, json, &header, 1))
  {
    sc.AddMessageToLog("NQ Analyst Bridge: HTTP POST failed", 1);
    return;
  }

  RequestState = HTTP_REQUEST_MADE;
  LastSentTime = nowMs;

  if (EnableDebugLog.GetYesNo())
  {
    SCString logMsg;
    logMsg.Format("NQ Analyst Bridge: Sent | Close=%.2f Delta=%.0f CVD=%.0f Bid=%.0f Ask=%.0f",
      barClose, delta, cvd, totalBidSize, totalAskSize);
    sc.AddMessageToLog(logMsg, 0);
  }

  // ── Handle response ─────────────────────────────────────────────────────────
  if (RequestState == HTTP_REQUEST_MADE && sc.HTTPRequestID != 0)
  {
    // Response will come on next update cycle
    // sc.HTTPResponse will contain the server's reply
  }
}
