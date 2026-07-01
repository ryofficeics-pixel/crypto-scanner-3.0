// lib/zigzag.ts
// TypeScript reimplementation of the core algorithm behind jbn/ZigZag:
// identify swing highs/lows by requiring a minimum % retracement before
// flipping direction. This produces the pivot points used for market
// structure (BOS/CHoCH) and chart pattern detection.

import type { Candle } from "./binance";

export interface Pivot {
  index: number;
  price: number;
  type: "high" | "low";
  time: number;
}

/**
 * deviation: minimum % move required to confirm a new pivot (filters noise).
 * 1.5-3% works well on 15m-4h crypto data; lower = more pivots (noisier),
 * higher = fewer, more significant pivots.
 */
export function computeZigZag(candles: Candle[], deviationPct = 2): Pivot[] {
  if (candles.length < 3) return [];

  const pivots: Pivot[] = [];
  let trend: "up" | "down" | null = null;
  let lastPivotPrice = candles[0].close;
  let extremeHigh = candles[0].high;
  let extremeHighIdx = 0;
  let extremeLow = candles[0].low;
  let extremeLowIdx = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];

    if (trend === null) {
      const upMove = ((c.high - lastPivotPrice) / lastPivotPrice) * 100;
      const downMove = ((lastPivotPrice - c.low) / lastPivotPrice) * 100;
      if (upMove >= deviationPct) {
        trend = "up";
        extremeHigh = c.high;
        extremeHighIdx = i;
      } else if (downMove >= deviationPct) {
        trend = "down";
        extremeLow = c.low;
        extremeLowIdx = i;
      }
      continue;
    }

    if (trend === "up") {
      if (c.high > extremeHigh) {
        extremeHigh = c.high;
        extremeHighIdx = i;
      }
      const retrace = ((extremeHigh - c.low) / extremeHigh) * 100;
      if (retrace >= deviationPct) {
        pivots.push({ index: extremeHighIdx, price: extremeHigh, type: "high", time: candles[extremeHighIdx].closeTime });
        lastPivotPrice = extremeHigh;
        trend = "down";
        extremeLow = c.low;
        extremeLowIdx = i;
      }
    } else {
      if (c.low < extremeLow) {
        extremeLow = c.low;
        extremeLowIdx = i;
      }
      const retrace = ((c.high - extremeLow) / extremeLow) * 100;
      if (retrace >= deviationPct) {
        pivots.push({ index: extremeLowIdx, price: extremeLow, type: "low", time: candles[extremeLowIdx].closeTime });
        lastPivotPrice = extremeLow;
        trend = "up";
        extremeHigh = c.high;
        extremeHighIdx = i;
      }
    }
  }

  return pivots;
}

export type StructureEvent = "BOS_BULLISH" | "BOS_BEARISH" | "CHOCH_BULLISH" | "CHOCH_BEARISH" | "NONE";

/**
 * Determines market structure state from the last few pivots.
 * BOS (Break of Structure) = continuation of existing trend, price breaks
 *   beyond the prior same-type pivot in the trend direction.
 * CHoCH (Change of Character) = trend reversal signal, price breaks
 *   structure in the OPPOSITE direction of the prevailing trend.
 */
export function detectStructure(pivots: Pivot[]): { event: StructureEvent; trend: "up" | "down" | "ranging" } {
  if (pivots.length < 4) return { event: "NONE", trend: "ranging" };

  const highs = pivots.filter((p) => p.type === "high").slice(-3);
  const lows = pivots.filter((p) => p.type === "low").slice(-3);

  if (highs.length < 2 || lows.length < 2) return { event: "NONE", trend: "ranging" };

  const higherHighs = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const higherLows = lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lowerHighs = highs[highs.length - 1].price < highs[highs.length - 2].price;
  const lowerLows = lows[lows.length - 1].price < lows[lows.length - 2].price;

  let trend: "up" | "down" | "ranging" = "ranging";
  if (higherHighs && higherLows) trend = "up";
  else if (lowerHighs && lowerLows) trend = "down";

  const lastPivot = pivots[pivots.length - 1];
  let event: StructureEvent = "NONE";

  if (trend === "up" && lastPivot.type === "low" && higherLows) {
    event = "BOS_BULLISH";
  } else if (trend === "down" && lastPivot.type === "high" && lowerHighs) {
    event = "BOS_BEARISH";
  } else if (lastPivot.type === "low" && lowerLows && trend !== "down") {
    event = "CHOCH_BEARISH";
  } else if (lastPivot.type === "high" && higherHighs && trend !== "up") {
    event = "CHOCH_BULLISH";
  }

  return { event, trend };
}
