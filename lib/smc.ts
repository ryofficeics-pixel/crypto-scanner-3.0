// lib/smc.ts
// Reimplements core concepts from joshyattridge/smart-money-concepts in TypeScript:
// - Order Blocks: last opposite candle before a strong impulsive move (institutional entry zone)
// - Fair Value Gaps (FVG): 3-candle imbalance where price likely returns to fill
// - Liquidity zones: equal highs/lows where stop-loss clusters sit (sweep targets)
//
// v3.0 fix: liquidity tolerance raised from 0.15% → 0.5% so clusters actually fire
// on real market data (0.15% was far too tight for crypto pivots).

import type { Candle } from "./binance";
import type { Pivot } from "./zigzag";

export interface OrderBlock {
  index: number;
  type: "bullish" | "bearish";
  top: number;
  bottom: number;
  time: number;
  mitigated: boolean;
}

export interface FairValueGap {
  index: number;
  type: "bullish" | "bearish";
  top: number;
  bottom: number;
  filled: boolean;
}

export interface LiquidityZone {
  price: number;
  type: "buy_side" | "sell_side";
  touches: number;
}

// 1.2% body move qualifies as a "strong" impulsive candle for OB detection
const IMPULSE_THRESHOLD = 0.012;

// 0.5% tolerance for clustering equal highs/lows into a liquidity zone.
// 0.15% was too tight — real pivot clusters in crypto span 0.3-0.8%.
const LIQUIDITY_TOLERANCE_PCT = 0.5;

export function findOrderBlocks(candles: Candle[]): OrderBlock[] {
  const blocks: OrderBlock[] = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const cur      = candles[i];
    const next     = candles[i + 1];
    const bodyMove = (next.close - cur.close) / cur.close;

    // Bullish OB: down-candle immediately before a strong up-move
    if (cur.close < cur.open && bodyMove >= IMPULSE_THRESHOLD) {
      blocks.push({
        index: i, type: "bullish",
        top: cur.high, bottom: cur.low,
        time: cur.closeTime, mitigated: false
      });
    }
    // Bearish OB: up-candle immediately before a strong down-move
    if (cur.close > cur.open && bodyMove <= -IMPULSE_THRESHOLD) {
      blocks.push({
        index: i, type: "bearish",
        top: cur.high, bottom: cur.low,
        time: cur.closeTime, mitigated: false
      });
    }
  }

  // Mark mitigated: any later candle that trades through the OB range
  for (const ob of blocks) {
    for (let j = ob.index + 2; j < candles.length; j++) {
      if (candles[j].low <= ob.top && candles[j].high >= ob.bottom) {
        ob.mitigated = true;
        break;
      }
    }
  }

  // Keep only the most recent 15 blocks (older ones are less relevant)
  return blocks.slice(-15);
}

export function findFairValueGaps(candles: Candle[]): FairValueGap[] {
  const gaps: FairValueGap[] = [];

  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];

    // Bullish FVG: gap up between candle[i-2].high and candle[i].low
    if (a.high < c.low) {
      gaps.push({ index: i - 1, type: "bullish", top: c.low, bottom: a.high, filled: false });
    }
    // Bearish FVG: gap down between candle[i-2].low and candle[i].high
    if (a.low > c.high) {
      gaps.push({ index: i - 1, type: "bearish", top: a.low, bottom: c.high, filled: false });
    }
  }

  // Mark filled: any later candle that trades back into the gap range
  for (const gap of gaps) {
    for (let j = gap.index + 2; j < candles.length; j++) {
      if (candles[j].low <= gap.top && candles[j].high >= gap.bottom) {
        gap.filled = true;
        break;
      }
    }
  }

  return gaps.slice(-10);
}

export function findLiquidityZones(
  pivots: Pivot[],
  tolerancePct = LIQUIDITY_TOLERANCE_PCT
): LiquidityZone[] {
  const zones: LiquidityZone[] = [];
  const highs = pivots.filter((p) => p.type === "high");
  const lows  = pivots.filter((p) => p.type === "low");

  const cluster = (points: Pivot[], type: "buy_side" | "sell_side") => {
    const used = new Set<number>();
    for (let i = 0; i < points.length; i++) {
      if (used.has(i)) continue;
      let touches = 1;
      for (let j = i + 1; j < points.length; j++) {
        if (used.has(j)) continue;
        const diff = (Math.abs(points[i].price - points[j].price) / points[i].price) * 100;
        if (diff <= tolerancePct) {
          touches++;
          used.add(j);
        }
      }
      if (touches >= 2) zones.push({ price: points[i].price, type, touches });
      used.add(i);
    }
  };

  cluster(highs, "sell_side");
  cluster(lows,  "buy_side");
  return zones;
}
