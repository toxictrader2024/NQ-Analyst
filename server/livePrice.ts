/**
 * Live NQ price fetcher — Yahoo Finance, no auth required.
 * Cached for 30 seconds. Used by both routes.ts and commentaryEngine.ts
 * so the AI never falls back to stale webhook prices.
 */

let cachedNQPrice: number | null = null;
let cachedNQPriceAt = 0;

export async function fetchLiveNQPrice(): Promise<number | null> {
  if (cachedNQPrice && Date.now() - cachedNQPriceAt < 30_000) return cachedNQPrice;
  try {
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/NQ=F?interval=1m&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const json = await res.json() as any;
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice as number | undefined;
    if (price && price > 0) {
      cachedNQPrice = price;
      cachedNQPriceAt = Date.now();
      console.log(`[LivePrice] NQ=${price}`);
      return price;
    }
  } catch (e) {
    console.warn("[LivePrice] Yahoo fetch failed:", e);
  }
  return null;
}
