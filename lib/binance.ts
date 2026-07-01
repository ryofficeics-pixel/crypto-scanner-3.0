// lib/binance.ts
// Direct Binance public REST API client. No API key needed (public market data only).
// Deliberately avoids ccxt to keep Vercel serverless function bundle size small
// and cold-start fast. Every value returned here traces directly to a Binance
// endpoint response — nothing is synthesized.

const BASE_URL = "https://api.binance.com";

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

async function safeFetchJson(url: string): Promise<any> {
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
  const STABLES = new Set(["USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "BUSDUSDT", "DAIUSDT", "USDPUSDT", "EURUSDT"]);

  const usdtPairs = (data as any[])
    .filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("USDT"))
    .filter((t) => !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .filter((t) => !STABLES.has(t.symbol))
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      priceChangePercent: parseFloat(t.priceChangePercent),
      quoteVolume: parseFloat(t.quoteVolume)
    }))
    .filter((t) => Number.isFinite(t.lastPrice) && Number.isFinite(t.quoteVolume));

  usdtPairs.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return usdtPairs.slice(0, limit);
}

/**
 * Fetch OHLCV klines for a symbol/interval. Returns enough candles for
 * accurate EMA200 calculation (needs ~200+ periods to converge).
 */
export async function getKlines(symbol: string, interval: "15m" | "1h" | "4h", limit = 250): Promise<Candle[]> {
  const url = `${BASE_URL}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await safeFetchJson(url);
  return (raw as any[]).map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6]
  }));
}

export async function getMultiTimeframeKlines(symbol: string) {
  const [m15, h1, h4] = await Promise.all([
    getKlines(symbol, "15m", 250),
    getKlines(symbol, "1h", 250),
    getKlines(symbol, "4h", 250)
  ]);
  return { m15, h1, h4 };
}
