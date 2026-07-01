// lib/binance.ts
// Direct Binance public REST API client. No API key needed (public market data only).
// Deliberately avoids ccxt to keep Vercel serverless function bundle size small
// and cold-start fast. Every value returned here traces directly to a Binance
// endpoint response — nothing is synthesized.
//
// BASE_URL uses data-api.binance.vision — the official Binance public data mirror
// that is accessible in regions where api.binance.com is geo-blocked (ETIMEDOUT).
// Identical endpoints, identical response shapes, same rate limits.
// Fallback: if the vision mirror ever fails, swap to https://api.binance.com

const BASE_URL = "https://data-api.binance.vision";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface Ticker24hr {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number; // volume in USDT
}

async function safeFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { next: { revalidate: 0 } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance API error ${res.status} for ${url}: ${body}`);
  }
  return res.json();
}

/**
 * Returns top N USDT pairs by 24h quote volume, excluding leveraged tokens
 * (UP/DOWN/BULL/BEAR) and stablecoin-to-stablecoin pairs which produce
 * meaningless technical signals.
 */
export async function getTopUsdtPairsByVolume(limit = 25): Promise<Ticker24hr[]> {
  const data = await safeFetchJson(`${BASE_URL}/api/v3/ticker/24hr`);
  const STABLES = new Set([
    "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "BUSDUSDT",
    "DAIUSDT",  "USDPUSDT",  "EURUSDT",  "USDTUSDT"
  ]);

  const usdtPairs = (data as Record<string, unknown>[])
    .filter((t) => typeof t.symbol === "string" && (t.symbol as string).endsWith("USDT"))
    .filter((t) => !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol as string))
    .filter((t) => !STABLES.has(t.symbol as string))
    .map((t) => ({
      symbol:             t.symbol as string,
      lastPrice:          parseFloat(t.lastPrice as string),
      priceChangePercent: parseFloat(t.priceChangePercent as string),
      quoteVolume:        parseFloat(t.quoteVolume as string)
    }))
    .filter((t) => Number.isFinite(t.lastPrice) && Number.isFinite(t.quoteVolume) && t.quoteVolume > 0);

  usdtPairs.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return usdtPairs.slice(0, limit);
}

/**
 * Fetch OHLCV klines for a symbol/interval. Returns enough candles for
 * accurate EMA200 calculation (needs ~200+ periods to converge).
 */
export async function getKlines(
  symbol: string,
  interval: "15m" | "1h" | "4h",
  limit = 250
): Promise<Candle[]> {
  const url = `${BASE_URL}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await safeFetchJson(url);
  return (raw as unknown[][]).map((k) => ({
    openTime:  k[0] as number,
    open:      parseFloat(k[1] as string),
    high:      parseFloat(k[2] as string),
    low:       parseFloat(k[3] as string),
    close:     parseFloat(k[4] as string),
    volume:    parseFloat(k[5] as string),
    closeTime: k[6] as number
  }));
}

export async function getMultiTimeframeKlines(symbol: string) {
  const [m15, h1, h4] = await Promise.all([
    getKlines(symbol, "15m", 250),
    getKlines(symbol, "1h",  250),
    getKlines(symbol, "4h",  250)
  ]);
  return { m15, h1, h4 };
}
