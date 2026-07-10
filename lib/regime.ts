import type { Candle } from "./binance";
import type { IndicatorSnapshot } from "./indicators";

export type MarketRegime =
  | "trending"
  | "ranging"
  | "mean_reverting"
  | "volatile"
  | "calm";

export interface RegimeSnapshot {
  regime: MarketRegime;
  trendStrength: number;
  volatility: "low" | "normal" | "high";
  isOverextended: boolean;
  description: string;
}

function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Market regime classifier.
 *
 * Uses price action + existing indicators to classify each symbol's current
 * market regime. This feeds into signal strength — trend-following setups
 * are favored in trending regimes, mean-reversion/grid setups in ranging or
 * mean_reverting regimes, and all signals are down-weighted in volatile regimes.
 */
export function classifyRegime(
  candles: Candle[],
  ind: IndicatorSnapshot
): RegimeSnapshot {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const currentPrice = ind.close;

  // ── Trend strength (0–100) ────────────────────────────────────
  // Use EMA20 slope normalized by ATR. Steeper slope relative to noise
  // = stronger trend.
  let trendStrength = 0;
  if (ind.atr !== null && ind.atr > 0 && closes.length >= 20) {
    const ema20Slice = closes.slice(-20);
    const emaSlope = linearSlope(ema20Slice);
    // Normalize: how many ATRs the price has moved per period
    const atr = ind.atr;
    const normSlope = Math.abs(emaSlope) / (atr / currentPrice);
    trendStrength = Math.min(100, normSlope * 50);
  } else if (ind.ema20 !== null && ind.ema50 !== null) {
    // Fallback: EMA distance ratio
    const distPct = Math.abs(ind.ema20 - ind.ema50) / ind.ema50 * 100;
    trendStrength = Math.min(50, distPct * 5);
  }

  // ── Volatility ────────────────────────────────────────────────
  let volatility: "low" | "normal" | "high" = "normal";
  if (ind.bbUpper !== null && ind.bbLower !== null && ind.bbMiddle !== null && ind.bbMiddle > 0) {
    const bbWidth = (ind.bbUpper - ind.bbLower) / ind.bbMiddle;
    const avgBbWidth = estimateAvgBbWidth(candles);
    const bbRatio = avgBbWidth > 0 ? bbWidth / avgBbWidth : 1;
    if (bbRatio > 1.5) volatility = "high";
    else if (bbRatio < 0.7) volatility = "low";
  }

  // ── Overextension ─────────────────────────────────────────────
  const isOverextended =
    (ind.rsi !== null && (ind.rsi > 70 || ind.rsi < 30)) ||
    (ind.vwapDist !== null && Math.abs(ind.vwapDist) > 3);

  // ── Regime decision ───────────────────────────────────────────
  let regime: MarketRegime;
  if (volatility === "high" && trendStrength > 40) {
    regime = "volatile";
  } else if (trendStrength > 50 && !isOverextended) {
    regime = "trending";
  } else if (isOverextended && volatility !== "high") {
    regime = "mean_reverting";
  } else if (trendStrength < 20 && volatility === "low") {
    regime = "calm";
  } else {
    regime = "ranging";
  }

  const descParts: string[] = [regime.replace("_", " ")];
  if (trendStrength > 0) descParts.push(`${trendStrength.toFixed(0)}% trend`);
  descParts.push(`${volatility} vol`);

  return {
    regime,
    trendStrength,
    volatility,
    isOverextended,
    description: descParts.join(" · "),
  };
}

/** Estimate the average BB width over the last ~50 periods */
function estimateAvgBbWidth(candles: Candle[]): number {
  const window = Math.min(50, Math.floor(candles.length / 2));
  if (window < 20) return 0.1;
  const closes = candles.slice(-window).map((c) => c.close);
  const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
  const variance = closes.reduce((s, v) => s + (v - mean) ** 2, 0) / closes.length;
  const stdDev = Math.sqrt(variance);
  return mean > 0 ? (4 * stdDev) / mean : 0.1;
}
