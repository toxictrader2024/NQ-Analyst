/**
 * Live NQ price — uses webhook storage as primary source (most accurate),
 * falls back to Yahoo Finance only when no recent webhook data exists.
 * Yahoo is unreliable when market is closed (returns stale historical prices).
 */
import { storage } from "./storage";

let cachedYahooPrice: number | null = null;
let cachedYahooPriceAt = 0;

async function fetchYahooNQPrice(): Promise<number | null> {
  if (cachedYahooPrice && Date.now() - cachedYahooPriceAt < 60_000) return cachedYahooPrice;
  try {
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/NQ=F?interval=1m&range=5d",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const json = await res.json() as any;
    const meta = json?.chart?.result?.[0]?.meta;
    // Use regularMarketPrice but sanity-check it's in a reasonable NQ range (20k-40k)
    const price = meta?.regularMarketPrice as number | undefined;
    if (price && price > 20000 && price < 40000) {
      // Extra sanity: also check chartPreviousClose for range validation
      const prev = meta?.chartPreviousClose as number | undefined;
      if (!prev || Math.abs(price - prev) < 2000) {
        cachedYahooPrice = price;
        cachedYahooPriceAt = Date.now();
        console.log(`[LivePrice] Yahoo NQ=${price}`);
        return price;
      } else {
        console.warn(`[LivePrice] Yahoo price ${price} too far from prev close ${prev} — rejecting`);
      }
    } else {
      console.warn(`[LivePrice] Yahoo price ${price} outside valid NQ range — rejecting`);
    }
  } catch (e) {
    console.warn("[LivePrice] Yahoo fetch failed:", e);
  }
  return null;
}

export async function fetchLiveNQPrice(): Promise<number | null> {
  // PRIMARY: use most recent webhook close — most accurate, always current
  const webhooks = storage.getRecentWebhooks(1);
  const webhookClose = webhooks[0]?.close;
  const webhookAge = webhooks[0] ? Date.now() - webhooks[0].receivedAt : Infinity;

  // If webhook is fresh (< 30 min old) and in valid range, use it
  if (webhookClose && webhookClose > 20000 && webhookClose < 40000 && webhookAge < 30 * 60 * 1000) {
    console.log(`[LivePrice] Using webhook price: ${webhookClose} (age: ${Math.round(webhookAge/1000)}s)`);
    return webhookClose;
  }

  // FALLBACK: Yahoo Finance (only when no fresh webhook data)
  console.log(`[LivePrice] No fresh webhook — trying Yahoo Finance`);
  return fetchYahooNQPrice();
}
