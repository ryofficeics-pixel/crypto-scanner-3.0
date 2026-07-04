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

const STABLES = new Set([
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "BUSDUSDT",
  "DAIUSDT",  "USDPUSDT",  "EURUSDT",  "USDTUSDT"
]);

/**
 * Fetch the set of actively TRADING USDT spot symbols from exchangeInfo.
 * This is the authoritative source — the 24hr ticker endpoint returns data
 * for delisted/suspended symbols that no longer appear in the exchange UI
 * (e.g. FIROUSDT shows a price but is not tradeable). Cached in module scope
 * for the lifetime of the serverless function invocation (one scan = one call).
 */
let _tradingSymbolsCache: Set<string> | null = null;

async function getTradingSymbols(): Promise<Set<string>> {
  if (_tradingSymbolsCache) return _tradingSymbolsCache;
  const data = await safeFetchJson(`${BASE_URL}/api/v3/exchangeInfo`);
  const symbols = new Set<string>();
  for (const s of (data as any).symbols ?? []) {
    if (s.status === "TRADING" && s.quoteAsset === "USDT") {
      symbols.add(s.symbol as string);
    }
  }
  _tradingSymbolsCache = symbols;
  return symbols;
}

/**
 * Single call to /ticker/24hr, cleaned and typed, filtered to actively
 * trading symbols only. Every other selection function below filters/sorts
 * this same in-memory list — we never hit the ticker endpoint more than
 * once per scan.
 */
async function getAllUsdtPairs(): Promise<Ticker24hr[]> {
  const [data, tradingSymbols] = await Promise.all([
    safeFetchJson(`${BASE_URL}/api/v3/ticker/24hr`),
    getTradingSymbols()
  ]);
  return (data as Record<string, unknown>[])
    .filter((t) => typeof t.symbol === "string" && (t.symbol as string).endsWith("USDT"))
    .filter((t) => tradingSymbols.has(t.symbol as string))  // only actively trading pairs
    .filter((t) => !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol as string))
    .filter((t) => !STABLES.has(t.symbol as string))
    .map((t) => ({
      symbol:             t.symbol as string,
      lastPrice:          parseFloat(t.lastPrice as string),
      priceChangePercent: parseFloat(t.priceChangePercent as string),
      quoteVolume:        parseFloat(t.quoteVolume as string)
    }))
    .filter((t) => Number.isFinite(t.lastPrice) && Number.isFinite(t.quoteVolume) && t.quoteVolume > 0)
    .filter((t) => Number.isFinite(t.priceChangePercent));
}

/**
 * Returns top N USDT pairs by 24h quote volume, excluding leveraged tokens
 * and stablecoin-to-stablecoin pairs. Kept for backward compatibility /
 * "liquidity leaders" mode.
 */
export async function getTopUsdtPairsByVolume(limit = 25): Promise<Ticker24hr[]> {
  const usdtPairs = await getAllUsdtPairs();
  usdtPairs.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return usdtPairs.slice(0, limit);
}

/**
 * Blended universe: this is the function the scanner should use.
 *
 * Big-cap coins (BTC, ETH, SOL...) rarely move more than ~5% in 24h, so a
 * pure "top by volume" list will always look like the same 25 names and
 * will structurally never surface a mid/low-cap coin that just pumped
 * 30-80%. Fix: build the candidate set from TWO buckets and merge them.
 *
 *  Bucket 1 — "liquidity leaders": top `volumeSlots` pairs by raw 24h
 *             quote volume. Keeps BTC/ETH/majors in view for context.
 *  Bucket 2 — "big movers": ALL pairs with |priceChangePercent| >= minMovePct
 *             AND quoteVolume >= minMoverVolume (liquidity floor so we
 *             don't chase illiquid/manipulated micro-caps), sorted by
 *             |priceChangePercent| descending, top `moverSlots` taken.
 *
 * Deduped by symbol. This is still exactly ONE network call total
 * (getAllUsdtPairs), so it costs nothing extra vs. the old function —
 * the only change is which rows we keep before running klines/scoring.
 */
export async function getScanCandidates(opts?: {
  volumeSlots?: number;
  moverSlots?: number;
  minMovePct?: number;
  minMoverVolume?: number;
  extremeMoverSlots?: number;
  extremeMovePct?: number;
  extremeMoverMinVolume?: number;
}): Promise<Ticker24hr[]> {
  const {
    volumeSlots    = 15,
    moverSlots     = 35,
    minMovePct     = 15,     // ignore noise below this — we want the 30/60/80% moves
    minMoverVolume = 300_000, // USDT 24h — floor to filter dead/illiquid pumps
    // A brand-new listing can be pumping hard within its first few hours
    // while its 24h quote volume is still low (liquidity hasn't caught up
    // yet). The main `minMoverVolume` floor above would exclude it. This
    // third bucket uses a much lower floor, but demands a much bigger move
    // to compensate — so it only lets in *extreme* moves on thin books,
    // not generic illiquid noise.
    extremeMoverSlots     = 15,
    extremeMovePct        = 50,
    extremeMoverMinVolume = 20_000
  } = opts ?? {};

  const all = await getAllUsdtPairs();

  const liquidityLeaders = [...all]
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, volumeSlots);

  const bigMovers = all
    .filter((t) => Math.abs(t.priceChangePercent) >= minMovePct)
    .filter((t) => t.quoteVolume >= minMoverVolume)
    .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
    .slice(0, moverSlots);

  const extremeMovers = all
    .filter((t) => Math.abs(t.priceChangePercent) >= extremeMovePct)
    .filter((t) => t.quoteVolume >= extremeMoverMinVolume)
    .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
    .slice(0, extremeMoverSlots);

  // Priority order matters here: Map preserves insertion order, and we cap
  // the total below. extremeMovers (freshest/most time-sensitive) and
  // bigMovers go in first so they're never the ones trimmed if we're over
  // budget — liquidityLeaders (BTC/ETH/majors, just context) are least
  // important and get trimmed first if needed.
  const merged = new Map<string, Ticker24hr>();
  for (const t of extremeMovers) merged.set(t.symbol, t);
  for (const t of bigMovers) merged.set(t.symbol, t);
  for (const t of liquidityLeaders) merged.set(t.symbol, t);

  // Hard cap on total candidates regardless of how the slots above add up.
  // This exists purely to protect Vercel's free-tier ~10s function budget:
  // wall-clock time (not Binance's 6000 weight/min) is the real constraint,
  // since each candidate costs 3 sequential-ish kline requests. Trimming
  // happens in reverse insertion order, so liquidity leaders are dropped
  // first, then big movers — extreme movers are never trimmed.
  const MAX_TOTAL_CANDIDATES = 50;
  const combined = Array.from(merged.values());
  return combined.length > MAX_TOTAL_CANDIDATES
    ? combined.slice(0, MAX_TOTAL_CANDIDATES)
    : combined;
}

/**
 * Fetch OHLCV klines for a symbol/interval. Returns enough candles for
 * accurate EMA200 calculation (needs ~200+ periods to converge).
 */
// Default candle count requested per timeframe. Exported so callers (e.g.
// scoring.ts's listing-age heuristic) can detect truncation without a
// duplicated magic number: if Binance returns fewer than this many candles,
// that IS the symbol's entire trading history at that interval.
export const KLINES_LIMIT = 250;

export async function getKlines(
  symbol: string,
  interval: "15m" | "1h" | "4h",
  limit = KLINES_LIMIT
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
