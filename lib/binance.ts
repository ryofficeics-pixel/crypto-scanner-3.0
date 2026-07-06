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
 * Single call to /ticker/24hr, cleaned and typed. Every other selection
 * function below filters/sorts this same in-memory list — we never hit
 * the ticker endpoint more than once per scan.
 */
async function getAllUsdtPairs(): Promise<Ticker24hr[]> {
  const data = await safeFetchJson(`${BASE_URL}/api/v3/ticker/24hr`);
  return (data as Record<string, unknown>[])
    .filter((t) => typeof t.symbol === "string" && (t.symbol as string).endsWith("USDT"))
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

const ROLLING_TICKER_BATCH_SIZE = 100; // Binance's hard max symbols per /api/v3/ticker request

/**
 * Short-term rolling-window % change for a batch of symbols — closes the
 * "AIGENSYS gap": a coin can be flat-to-down over the last 24h while
 * accelerating hard in just the last 15-60 minutes. The 24h ticker nets
 * the earlier move against the recent spike and hides it entirely, so a
 * candidate-selection filter based only on 24h priceChangePercent can miss
 * a coin that's actively pumping RIGHT NOW.
 *
 * This is a genuinely different Binance endpoint (GET /api/v3/ticker, NOT
 * /api/v3/ticker/24hr) that computes stats over an arbitrary window
 * (e.g. "1h") on demand. Confirmed available on data-api.binance.vision.
 *
 * Cost: weight is 4 per requested symbol, capped at 200 once a request
 * asks for more than 50 symbols, max 100 symbols per request. Scanning
 * ~400-500 USDT pairs costs ~4-5 requests at ~200 weight each (~1000
 * total) — well inside the 6000/min budget. Batches run in parallel to
 * minimize added wall-clock time.
 */
async function getRollingWindowChanges(
  symbols: string[],
  windowSize: string
): Promise<Map<string, number>> {
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += ROLLING_TICKER_BATCH_SIZE) {
    batches.push(symbols.slice(i, i + ROLLING_TICKER_BATCH_SIZE));
  }

  const batchResults = await Promise.allSettled(
    batches.map(async (batch) => {
      const url =
        `${BASE_URL}/api/v3/ticker?symbols=${encodeURIComponent(JSON.stringify(batch))}` +
        `&windowSize=${windowSize}`;
      return safeFetchJson(url) as Promise<Record<string, unknown>[]>;
    })
  );

  const result = new Map<string, number>();
  for (const r of batchResults) {
    if (r.status !== "fulfilled") continue; // best-effort per batch
    for (const t of r.value) {
      const symbol = t.symbol as string;
      const pct = parseFloat(t.priceChangePercent as string);
      if (typeof symbol === "string" && Number.isFinite(pct)) result.set(symbol, pct);
    }
  }
  return result;
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
  momentumSlots?: number;
  momentumWindowSize?: string;
  momentumMinPct?: number;
  momentumMinVolume?: number;
}): Promise<Ticker24hr[]> {
  const {
    volumeSlots    = 18,
    moverSlots     = 40,
    minMovePct     = 15,     // ignore noise below this — we want the 30/60/80% moves
    minMoverVolume = 300_000, // USDT 24h — floor to filter dead/illiquid pumps
    // A brand-new listing can be pumping hard within its first few hours
    // while its 24h quote volume is still low (liquidity hasn't caught up
    // yet). The main `minMoverVolume` floor above would exclude it. This
    // third bucket uses a much lower floor, but demands a much bigger move
    // to compensate — so it only lets in *extreme* moves on thin books,
    // not generic illiquid noise.
    extremeMoverSlots     = 20,
    extremeMovePct        = 50,
    extremeMoverMinVolume = 20_000,
    // Fourth bucket: SHORT-TERM momentum, independent of 24h change. Fixes
    // the case where a coin was flat/down earlier in the day and only
    // started accelerating in the last hour — 24h priceChangePercent nets
    // that out and hides it from every bucket above until it's already
    // pumped for a while. Uses a dedicated rolling-window ticker call.
    momentumSlots      = 20,
    momentumWindowSize = "1h",
    momentumMinPct     = 8,     // an 8%+ move within just 1h is a real signal
    momentumMinVolume  = 50_000
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

  const momentumPool = all.filter((t) => t.quoteVolume >= momentumMinVolume);
  const rollingChanges = await getRollingWindowChanges(
    momentumPool.map((t) => t.symbol),
    momentumWindowSize
  );
  const momentumMovers = momentumPool
    .map((t) => ({ ticker: t, shortTermPct: rollingChanges.get(t.symbol) }))
    .filter((x): x is { ticker: Ticker24hr; shortTermPct: number } => x.shortTermPct !== undefined)
    .filter((x) => Math.abs(x.shortTermPct) >= momentumMinPct)
    .sort((a, b) => Math.abs(b.shortTermPct) - Math.abs(a.shortTermPct))
    .slice(0, momentumSlots)
    .map((x) => x.ticker);

  // Priority order matters here: Map preserves insertion order, and we cap
  // the total below. momentumMovers (fixes the reported miss) and
  // extremeMovers go in first so they're never the ones trimmed if we're
  // over budget — liquidityLeaders (BTC/ETH/majors, just context) are
  // least important and get trimmed first if needed.
  const merged = new Map<string, Ticker24hr>();
  for (const t of momentumMovers) merged.set(t.symbol, t);
  for (const t of extremeMovers) merged.set(t.symbol, t);
  for (const t of bigMovers) merged.set(t.symbol, t);
  for (const t of liquidityLeaders) merged.set(t.symbol, t);

  // Hard cap on total candidates regardless of how the slots above add up.
  // This exists purely to protect Vercel's free-tier ~10s function budget:
  // wall-clock time (not Binance's 6000 weight/min) is the real constraint,
  // since each candidate costs 3 sequential-ish kline requests. Trimming
  // happens in reverse insertion order, so liquidity leaders are dropped
  // first, then big movers — momentum/extreme movers are never trimmed.
  //
  // 70 is a rough-estimated ceiling (~5-6s modeled, cold start not
  // included), not empirically measured — this sandbox can't hit live
  // Binance or run on real Vercel infra to verify. After deploying, check
  // actual function duration in the Vercel dashboard; if you see
  // occasional timeouts, dial this back down rather than push it further.
  const MAX_TOTAL_CANDIDATES = 70;
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
