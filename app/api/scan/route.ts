// app/api/scan/route.ts
// On-demand scan endpoint. Called on page load. Fetches top USDT pairs,
// pulls multi-timeframe klines for each, computes all indicators + SMC +
// patterns, returns ranked results. No caching — always live data.

import { NextResponse } from "next/server";
import { getTopUsdtPairsByVolume, getMultiTimeframeKlines } from "@/lib/binance";
import { scanSymbol } from "@/lib/scoring";

export const runtime = "nodejs"; // edge runtime can't use technicalindicators (node APIs)
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Pro allows 60s; free tier is 10s (may timeout on 25 symbols)

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = parseInt(url.searchParams.get("limit") ?? "20");
  const limit = Math.min(Math.max(limitParam, 5), 30);

  try {
    const tickers = await getTopUsdtPairsByVolume(limit);
    if (!tickers.length) {
      return NextResponse.json({ error: "No USDT pairs returned from Binance" }, { status: 502 });
    }

    // Fetch klines concurrently with a concurrency cap to avoid rate-limiting
    // Binance public API limit: 6000 weight/min. Each getMultiTimeframeKlines
    // costs 3 requests × ~2 weight = ~6 weight. 25 symbols = ~150 weight total.
    const BATCH = 5;
    const results = [];

    for (let i = 0; i < tickers.length; i += BATCH) {
      const batch = tickers.slice(i, i + BATCH);
      const batchResults = await Promise.allSettled(
        batch.map(async (ticker) => {
          const candles = await getMultiTimeframeKlines(ticker.symbol);
          return scanSymbol(ticker.symbol, candles, {
            priceChangePercent: ticker.priceChangePercent,
            quoteVolume: ticker.quoteVolume
          });
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled" && r.value !== null) {
          results.push(r.value);
        }
      }

      // Polite delay between batches — avoid burst rate limiting
      if (i + BATCH < tickers.length) {
        await new Promise((res) => setTimeout(res, 300));
      }
    }

    // Sort: S first, then A, then B, then NONE; within tier sort by signalCount desc
    const tierOrder: Record<string, number> = { S: 0, A: 1, B: 2, NONE: 3 };
    results.sort((a, b) => {
      const td = tierOrder[a.tier] - tierOrder[b.tier];
      if (td !== 0) return td;
      return b.signalCount - a.signalCount;
    });

    return NextResponse.json({
      scannedAt: new Date().toISOString(),
      symbolCount: results.length,
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
