// app/api/scan/route.ts
// On-demand scan endpoint. Called on page load. Fetches a BLENDED symbol
// universe (liquidity leaders + big % movers, see lib/binance.ts), pulls
// multi-timeframe klines for each, computes all indicators + SMC +
// patterns, returns ranked results. No caching — always live data.
//
// v3.1: fixed "same coins every time" — old code only ever scanned the
// top-25-by-volume pairs, which structurally excludes mid/low-cap coins
// making 30-80% moves (those never crack top-25 by raw volume). Now uses
// getScanCandidates() which unions volume leaders with high % movers.

import { NextResponse } from "next/server";
import { getScanCandidates, getMultiTimeframeKlines } from "@/lib/binance";
import { scanSymbol } from "@/lib/scoring";
import { getFundingSignals } from "@/lib/futures";

export const runtime = "nodejs"; // edge runtime can't use technicalindicators (node APIs)
export const dynamic = "force-dynamic";
// NOTE: on Vercel's free (Hobby) plan, function duration is hard-capped at
// 10s regardless of this value — it only takes effect on Pro (60s) or
// higher. Since this project is meant to stay free, tune BATCH/DELAY below
// as if the real ceiling is ~10s, not 60s.
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  // "limit" now controls how many big-movers slots we scan (on top of a
  // fixed set of liquidity leaders) rather than the whole universe size.
  // Guard against NaN from malformed query params (e.g. ?limit=abc) — an
  // un-guarded NaN would flow into Math.min/Math.max/slice() and silently
  // zero out the entire big-movers bucket with no error thrown.
  const limitParamRaw = parseInt(url.searchParams.get("limit") ?? "40");
  const limitParam = Number.isFinite(limitParamRaw) ? limitParamRaw : 40;
  const moverSlots = Math.min(Math.max(limitParam, 10), 55); // raised cap — see MAX_TOTAL_CANDIDATES note in binance.ts

  const minMovePctRaw = parseFloat(url.searchParams.get("minMove") ?? "15");
  const minMovePct = Number.isFinite(minMovePctRaw) ? minMovePctRaw : 15;

  // tightMode param removed - using fixed % TP/SL now
  const tightMode = false;

  try {
    const tickers = await getScanCandidates({
      moverSlots,                // mid/low-cap coins with big 24h moves — the point of this fix
      minMovePct,                 // ignore <15% noise by default; raise via ?minMove=30 for only 30%+ etc.
      minMoverVolume: 300_000    // USDT 24h floor — filters out illiquid/manipulated micro-caps
      // volumeSlots, extremeMoverSlots, momentumSlots, momentumWindowSize,
      // momentumMinPct, momentumMinVolume: left at their (raised) defaults
      // from lib/binance.ts rather than overridden here.
    });

    if (!tickers.length) {
      return NextResponse.json({ error: "No USDT pairs returned from Binance" }, { status: 502 });
    }

    // ── Futures funding signals (shorts squeeze detection) ──────
    const fundingMap = await getFundingSignals();

    // ── Multi-pair correlation filter ───────────────────────────
    // Check BTC 1h performance: if BTC is dumping hard, altcoin buy
    // signals are less reliable (correlated selloff). When BTC 1h is
    // down >2%, we suppress all altcoin tiers below A.
    let btcBearishRisk = false;
    try {
      const btcKlinesRes = await fetch(
        "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2"
      );
      const btcRaw: unknown[][] = await btcKlinesRes.json();
      if (btcRaw.length >= 2) {
        const prevClose = parseFloat(btcRaw[0][4] as string);
        const curClose  = parseFloat(btcRaw[1][4] as string);
        const btc1hPct  = ((curClose - prevClose) / prevClose) * 100;
        btcBearishRisk = btc1hPct < -2;
      }
    } catch { /* fail open */ }

    // Fetch klines concurrently with a concurrency cap to avoid rate-limiting.
    // Binance weight budget is 6000/min — even 70 symbols (~420 weight) is
    // nowhere near that limit, so the real constraint is wall-clock time on
    // the free tier, not API weight. Larger batches + shorter delay to fit
    // the raised MAX_TOTAL_CANDIDATES (70, see binance.ts) inside the ~10s
    // window — see the rough estimate/caveat there too.
    const BATCH = 10;
    const INTER_BATCH_DELAY_MS = 100;
    const results = [];

    for (let i = 0; i < tickers.length; i += BATCH) {
      const batch = tickers.slice(i, i + BATCH);
      const batchResults = await Promise.allSettled(
        batch.map(async (ticker) => {
          const candles = await getMultiTimeframeKlines(ticker.symbol);
          const funding = fundingMap.get(ticker.symbol);
          const result = scanSymbol(ticker.symbol, candles, {
            priceChangePercent: ticker.priceChangePercent,
            quoteVolume: ticker.quoteVolume
          }, tightMode, funding);
          // Correlation filter: if BTC is dumping, suppress altcoin tiers below A
          if (result && btcBearishRisk && result.tier !== "NONE" && ticker.symbol !== "BTCUSDT") {
            // Downgrade B to NONE during BTC-led selloffs (B-tier is weakest signal)
            if (result.tier === "B") result.tier = "NONE";
            // A-tier becomes B-tier (still visible but de-emphasized)
            if (result.tier === "A") result.tier = "B";
            // S-tier stays S (strong enough to survive market context)
          }
          return result;
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled" && r.value !== null) {
          results.push(r.value);
        }
      }

      if (i + BATCH < tickers.length) {
        await new Promise((res) => setTimeout(res, INTER_BATCH_DELAY_MS));
      }
    }

    // Sort: S first, then A, then B, then NONE — but a fresh listing jumps
    // ahead of same-tier peers since catching it early (within the 1-2 day
    // window) is the whole point of this feature.
    const tierOrder: Record<string, number> = { S: 0, A: 1, B: 2, NONE: 3 };
    results.sort((a, b) => {
      const td = tierOrder[a.tier] - tierOrder[b.tier];
      if (td !== 0) return td;
      if (a.isNewListing !== b.isNewListing) return a.isNewListing ? -1 : 1;
      const moveDiff = Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent);
      if (moveDiff !== 0) return moveDiff;
      return b.signalCount - a.signalCount;
    });

    return NextResponse.json({
      scannedAt: new Date().toISOString(),
      symbolCount: results.length,
      candidateCount: tickers.length,
      results
    });
  } catch (err: any) {
    console.error("[scan] Fatal error:", err?.message ?? err);
    return NextResponse.json(
      { error: err?.message ?? "Unknown error during scan" },
      { status: 500 }
    );
  }
}
