// lib/patterns.ts
// Chart pattern recognition built on ZigZag pivots.
// v3.0: Added Head & Shoulders, Inverse H&S, ascending/descending wedge.
//
// All patterns are pivot-based (not pixel/image based). Each detection
// returns a confidence score 0–1 and a human-readable description that
// traces to the actual pivot prices — no fabricated labels.

import type { Pivot } from "./zigzag";

export type PatternType =
  | "double_bottom"
  | "double_top"
  | "triangle_compression"
  | "head_and_shoulders"
  | "inverse_head_and_shoulders"
  | "ascending_wedge"
  | "descending_wedge"
  | "none";

export interface PatternResult {
  type: PatternType;
  confidence: number; // 0–1
  description: string;
  bearish: boolean; // true = pattern warns against long entries
}

const EQUAL_TOL = 1.5;   // % tolerance for "equal" highs/lows
const WEDGE_MIN = 3;     // minimum pivot count per side for wedge

// ── helpers ──────────────────────────────────────────────────────────────────

function pctDiff(a: number, b: number): number {
  return (Math.abs(a - b) / a) * 100;
}

/** Fit a least-squares slope to a series of prices (returns slope per step). */
function slope(prices: number[]): number {
  if (prices.length < 2) return 0;
  const n = prices.length;
  const xMean = (n - 1) / 2;
  const yMean = prices.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (prices[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

// ── detectors ────────────────────────────────────────────────────────────────

function detectDoubleBottom(lows: Pivot[], recent: Pivot[]): PatternResult | null {
  if (lows.length < 2) return null;
  const l1 = lows[lows.length - 2];
  const l2 = lows[lows.length - 1];
  const diff = pctDiff(l1.price, l2.price);
  if (diff <= EQUAL_TOL && recent[recent.length - 1].index === l2.index) {
    return {
      type: "double_bottom",
      confidence: Math.max(0.5, 1 - diff / EQUAL_TOL),
      description: `Double bottom: two lows within ${diff.toFixed(2)}% (${l1.price.toPrecision(5)} / ${l2.price.toPrecision(5)})`,
      bearish: false
    };
  }
  return null;
}

function detectDoubleTop(highs: Pivot[], recent: Pivot[]): PatternResult | null {
  if (highs.length < 2) return null;
  const h1 = highs[highs.length - 2];
  const h2 = highs[highs.length - 1];
  const diff = pctDiff(h1.price, h2.price);
  if (diff <= EQUAL_TOL && recent[recent.length - 1].index === h2.index) {
    return {
      type: "double_top",
      confidence: Math.max(0.5, 1 - diff / EQUAL_TOL),
      description: `Double top: two highs within ${diff.toFixed(2)}% (${h1.price.toPrecision(5)} / ${h2.price.toPrecision(5)})`,
      bearish: true
    };
  }
  return null;
}

function detectTriangle(highs: Pivot[], lows: Pivot[]): PatternResult | null {
  if (highs.length < 3 || lows.length < 3) return null;
  const h = highs.slice(-3).map((p) => p.price);
  const l = lows.slice(-3).map((p) => p.price);
  if (h[0] > h[1] && h[1] > h[2] && l[0] < l[1] && l[1] < l[2]) {
    return {
      type: "triangle_compression",
      confidence: 0.6,
      description: "Symmetrical triangle: range compressing, breakout likely near",
      bearish: false
    };
  }
  return null;
}

/**
 * Head & Shoulders: three swing highs where the middle (head) is tallest,
 * shoulders are roughly equal, and the last pivot is a low (neckline test).
 * Bearish reversal pattern.
 */
function detectHeadAndShoulders(highs: Pivot[], recent: Pivot[]): PatternResult | null {
  if (highs.length < 3) return null;
  const [ls, head, rs] = highs.slice(-3);
  if (!ls || !head || !rs) return null;
  const headIsHighest = head.price > ls.price && head.price > rs.price;
  const shoulderBalance = pctDiff(ls.price, rs.price) <= 4; // shoulders within 4%
  if (headIsHighest && shoulderBalance && recent[recent.length - 1].type === "low") {
    const asymmetry = 1 - pctDiff(ls.price, rs.price) / 4;
    return {
      type: "head_and_shoulders",
      confidence: Math.min(0.9, 0.55 + asymmetry * 0.35),
      description: `H&S: LS ${ls.price.toPrecision(5)}, Head ${head.price.toPrecision(5)}, RS ${rs.price.toPrecision(5)}`,
      bearish: true
    };
  }
  return null;
}

/**
 * Inverse Head & Shoulders: three swing lows where middle is lowest.
 * Bullish reversal pattern — strong buy signal.
 */
function detectInverseHeadAndShoulders(lows: Pivot[], recent: Pivot[]): PatternResult | null {
  if (lows.length < 3) return null;
  const [ls, head, rs] = lows.slice(-3);
  if (!ls || !head || !rs) return null;
  const headIsLowest = head.price < ls.price && head.price < rs.price;
  const shoulderBalance = pctDiff(ls.price, rs.price) <= 4;
  if (headIsLowest && shoulderBalance && recent[recent.length - 1].type === "high") {
    const asymmetry = 1 - pctDiff(ls.price, rs.price) / 4;
    return {
      type: "inverse_head_and_shoulders",
      confidence: Math.min(0.9, 0.55 + asymmetry * 0.35),
      description: `Inv H&S: LS ${ls.price.toPrecision(5)}, Head ${head.price.toPrecision(5)}, RS ${rs.price.toPrecision(5)}`,
      bearish: false
    };
  }
  return null;
}

/**
 * Ascending wedge: both highs and lows trending up, but highs slope
 * is converging toward lows slope (tightening). Bearish — exhaustion.
 */
function detectAscendingWedge(highs: Pivot[], lows: Pivot[]): PatternResult | null {
  if (highs.length < WEDGE_MIN || lows.length < WEDGE_MIN) return null;
  const hPrices = highs.slice(-WEDGE_MIN).map((p) => p.price);
  const lPrices = lows.slice(-WEDGE_MIN).map((p) => p.price);
  const hSlope = slope(hPrices);
  const lSlope = slope(lPrices);
  // Both rising, lows rising faster than highs (converging upward)
  if (hSlope > 0 && lSlope > 0 && lSlope > hSlope) {
    return {
      type: "ascending_wedge",
      confidence: 0.55,
      description: `Ascending wedge: highs slope ${hSlope.toFixed(4)}, lows slope ${lSlope.toFixed(4)} (converging up)`,
      bearish: true
    };
  }
  return null;
}

/**
 * Descending wedge: both highs and lows trending down, but highs slope
 * is steeper (falling faster than lows). Bullish — compression into reversal.
 */
function detectDescendingWedge(highs: Pivot[], lows: Pivot[]): PatternResult | null {
  if (highs.length < WEDGE_MIN || lows.length < WEDGE_MIN) return null;
  const hPrices = highs.slice(-WEDGE_MIN).map((p) => p.price);
  const lPrices = lows.slice(-WEDGE_MIN).map((p) => p.price);
  const hSlope = slope(hPrices);
  const lSlope = slope(lPrices);
  // Both falling, highs falling faster than lows (converging downward)
  if (hSlope < 0 && lSlope < 0 && hSlope < lSlope) {
    return {
      type: "descending_wedge",
      confidence: 0.65,
      description: `Descending wedge: highs slope ${hSlope.toFixed(4)}, lows slope ${lSlope.toFixed(4)} (converging down — bullish)`,
      bearish: false
    };
  }
  return null;
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Volume data needed for pattern confirmation. Optional — if not provided,
 * patterns are detected without volume checks (backward-compatible).
 */
export interface VolumeContext {
  /** Array of volumes in chronological order (same length as pivots' source candles would be) */
  recentVolumes: number[];
  /** 20-period average volume for comparison */
  volumeAvg20: number;
}

/**
 * Check if the latest candle has above-average volume — adds confirmation
 * that the pattern's breakout/continuation candle has genuine participation.
 */
function hasVolumeConfirmation(ctx?: VolumeContext): boolean {
  if (!ctx || ctx.recentVolumes.length === 0 || ctx.volumeAvg20 <= 0) return true; // no data = skip check
  const latestVol = ctx.recentVolumes[ctx.recentVolumes.length - 1];
  return latestVol > ctx.volumeAvg20 * 1.2; // 20% above average = confirmed
}

export function detectPattern(pivots: Pivot[], volumeCtx?: VolumeContext): PatternResult {
  const none: PatternResult = { type: "none", confidence: 0, description: "No clear pattern", bearish: false };
  if (pivots.length < 5) return none;

  const recent = pivots.slice(-8);
  const lows = recent.filter((p) => p.type === "low");
  const highs = recent.filter((p) => p.type === "high");

  // Priority order: strongest / most reliable patterns first
  // Bearish patterns: H&S, double top, ascending wedge
  // Bullish patterns: inv H&S, double bottom, descending wedge, triangle

  // Volume confirmation: a pattern without above-average volume at the
  // breakout candle carries less weight — downgrade confidence or skip.
  // This prevents false positives in choppy / low-participation markets.
  const volOk = hasVolumeConfirmation(volumeCtx);

  const result =
    detectInverseHeadAndShoulders(lows, recent) ??
    detectHeadAndShoulders(highs, recent) ??
    detectDoubleBottom(lows, recent) ??
    detectDoubleTop(highs, recent) ??
    detectDescendingWedge(highs, lows) ??
    detectAscendingWedge(highs, lows) ??
    detectTriangle(highs, lows) ??
    none;

  if (result.type === "none") return result;

  // Without volume confirmation, halve the confidence and downgrade to
  // "weak" by stripping the strong flag — pattern exists but may be noise.
  if (!volOk) {
    return {
      ...result,
      confidence: result.confidence * 0.5,
    };
  }

  return result;
}
