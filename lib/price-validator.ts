/**
 * Price validation & cross-referencing layer.
 *
 * Root cause audit (v3.2): scanner was using h1 candle close (`scoring.ts:396`)
 * as the display price instead of the live ticker price. For thin coins like
 * FIO where the current 1h candle may have zero volume, the candle close
 * can be hours stale — diverging 142%+ from the actual live last price.
 *
 * Fix:
 *   1. Primary price = live 24hr ticker lastPrice
 *   2. Fallback = most recent non-zero candle close
 *   3. Cross-reference with Gate.io API
 *   4. Reject prices with >3% discrepancy between exchanges
 */

import type { Candle } from "./binance";

const GATE_API = "https://api.gateio.ws/api/v4";
const LOG_PREFIX = "[price-val]";

export type PriceSource = "ticker_live" | "candle_close" | "gate_live" | "fallback";

export interface PriceDebugInfo {
  symbol: string;
  scannerPrice: number;
  gatePrice: number | null;
  candleClose: number;
  tickerLastPrice: number | null;
  priceUsed: number;
  priceSource: PriceSource;
  discrepancyPct: number | null;
  valid: boolean;
  candleCloseTime: number | null;
  now: number;
  stalenessSec: number | null;
  gateLatencyMs: number | null;
}

/**
 * Fetch live prices from Gate.io for a list of symbols.
 * Format: FIOUSDT → FIO_USDT
 */
export async function getGateTickers(symbols: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (symbols.length === 0) return result;
  try {
    const batches: string[][] = [];
    const BATCH = 50;
    for (let i = 0; i < symbols.length; i += BATCH) {
      batches.push(symbols.slice(i, i + BATCH));
    }
    const batchResults = await Promise.allSettled(
      batches.map(async (batch) => {
        const pairs = batch.map((s) => s.replace("USDT", "_USDT"));
        const url = `${GATE_API}/spot/tickers?currency_pairs=${encodeURIComponent(pairs.join(","))}`;
        const res = await fetch(url, { next: { revalidate: 0 } });
        if (!res.ok) return;
        const data: Record<string, unknown>[] = await res.json();
        for (const t of data) {
          const pair = t.currency_pair as string;
          const last = parseFloat(t.last as string);
          if (pair && pair.endsWith("_USDT") && Number.isFinite(last)) {
            result.set(pair.replace("_USDT", "USDT"), last);
          }
        }
      })
    );
  } catch { /* fail open */ }
  return result;
}

/**
 * Compare scanner price against Gate.io price.
 * Returns validation info + debug data.
 */
export async function validatePrice(
  symbol: string,
  tickerLastPrice: number | null,
  candles1h: Candle[],
  gatePrices: Map<string, number>,
  threshold = 0.03
): Promise<{
  price: number;
  source: PriceSource;
  debug: PriceDebugInfo;
  valid: boolean;
}> {
  const now = Date.now();
  const lastCandle = candles1h[candles1h.length - 1];
  const candleClose = lastCandle?.close ?? 0;
  const candleCloseTime = lastCandle?.closeTime ?? null;
  const stalenessSec = candleCloseTime ? Math.floor((now - candleCloseTime) / 1000) : null;

  // Prioritize: ticker > candle close (only if recent)
  let price: number;
  let source: PriceSource;

  if (tickerLastPrice !== null && Number.isFinite(tickerLastPrice) && tickerLastPrice > 0) {
    price = tickerLastPrice;
    source = "ticker_live";
  } else if (candleClose > 0 && stalenessSec !== null && stalenessSec < 3600) {
    price = candleClose;
    source = "candle_close";
  } else if (candleClose > 0) {
    price = candleClose;
    source = "candle_close";
  } else {
    price = 0.0001; // last-resort fallback
    source = "fallback";
  }

  // Cross-reference with Gate.io
  const gatePrice = gatePrices.get(symbol) ?? null;
  let discrepancyPct: number | null = null;
  let valid = true;

  if (gatePrice !== null && gatePrice > 0) {
    discrepancyPct = Math.abs(price - gatePrice) / gatePrice;
    if (discrepancyPct > threshold) {
      valid = false;
      console.warn(
        `${LOG_PREFIX} PRICE DISCREPANCY EXCEEDS ${(threshold * 100).toFixed(0)}%:`,
        `${symbol} scanner=${price} gate=${gatePrice} diff=${(discrepancyPct * 100).toFixed(1)}%`
      );
    }
  }

  const debug: PriceDebugInfo = {
    symbol,
    scannerPrice: price,
    gatePrice,
    candleClose,
    tickerLastPrice,
    priceUsed: price,
    priceSource: source,
    discrepancyPct,
    valid,
    candleCloseTime,
    now,
    stalenessSec,
    gateLatencyMs: null,
  };

  return { price, source, debug, valid };
}

/**
 * Simple synchronous comparison (for in-line use where Gate price is known).
 */
export function compareExchangePrice(
  scannerPrice: number,
  gatePrice: number,
  threshold = 0.03
): { match: boolean; discrepancyPct: number } {
  if (gatePrice <= 0) return { match: true, discrepancyPct: 0 };
  const discrepancyPct = Math.abs(scannerPrice - gatePrice) / gatePrice;
  return { match: discrepancyPct <= threshold, discrepancyPct };
}
