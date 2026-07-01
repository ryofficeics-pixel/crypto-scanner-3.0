// lib/scoring.ts
// The decision engine. Combines indicators + SMC + structure + pattern signals
// from 15m/1h/4h into a single tiered call (S / A / B / none), with ATR-based
// TP/SL and a human-readable reason string where every claim traces to a
// computed number — no vague labels, per project's no-fabrication standard.
//
// v3.0 changes:
//   - ind4h indicators now actively used for 4h SMC confluence signals
//   - nearBuySideLiquidity flag wired into signal stack
//   - 4h OB + 4h FVG feed as additional strong signals
//   - CHoCH event surfaces as an explicit flag
//   - Tier S threshold raised to ≥3 strong (was 2) to compensate for more signals

import type { Candle } from "./binance";
import { computeIndicators, IndicatorSnapshot } from "./indicators";
import { computeZigZag, detectStructure, Pivot } from "./zigzag";
import { findOrderBlocks, findFairValueGaps, findLiquidityZones } from "./smc";
import { detectPattern } from "./patterns";

export type Tier = "S" | "A" | "B" | "NONE";

export interface SignalFlag {
  key: string;
  label: string;
  weak: boolean;
  strong: boolean;
}

export interface ScanResult {
  symbol: string;
  tier: Tier;
  price: number;
  signalCount: number;
  trend4h: "up" | "down" | "ranging";
  structureEvent: string;
  flags: SignalFlag[];
  reason: string;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskRewardT1: number;
  riskRewardT2: number;
  atr: number | null;
  priceChangePercent: number;
  quoteVolume: number;
  // SMC extras for UI
  nearLiquidity: boolean;
  liquidityPrice: number | null;
}

function evaluateFlags(
  ind15: IndicatorSnapshot,
  ind1h: IndicatorSnapshot,
  ind4h: IndicatorSnapshot,
  candles1h: Candle[],
  candles4h: Candle[],
  pivots1h: Pivot[],
  pivots4h: Pivot[]
): SignalFlag[] {
  const flags: SignalFlag[] = [];

  // ── 1. RSI 1h ────────────────────────────────────────────────
  if (ind1h.rsi !== null) {
    const turningUp = ind1h.rsiPrev !== null && ind1h.rsi > ind1h.rsiPrev;
    flags.push({
      key: "rsi",
      label: `RSI(1h) ${ind1h.rsi.toFixed(1)}`,
      weak: ind1h.rsi >= 30 && ind1h.rsi <= 40,
      strong: ind1h.rsi < 30 && turningUp
    });
  }

  // ── 2. EMA20/50 cross 1h ─────────────────────────────────────
  if (ind1h.ema20 !== null && ind1h.ema50 !== null && ind1h.ema20Prev !== null && ind1h.ema50Prev !== null) {
    const goldenCross = ind1h.ema20 > ind1h.ema50 && ind1h.ema20Prev <= ind1h.ema50Prev;
    const reclaiming = ind1h.close > ind1h.ema20 && ind1h.ema20 < ind1h.ema50;
    flags.push({
      key: "ema_cross",
      label: `EMA20/50(1h) ${ind1h.ema20 > ind1h.ema50 ? "bullish" : "bearish"}`,
      weak: reclaiming,
      strong: goldenCross
    });
  }

  // ── 3. EMA200 support test 1h ────────────────────────────────
  if (ind1h.ema200 !== null) {
    const distPct = ((ind1h.close - ind1h.ema200) / ind1h.ema200) * 100;
    const nearSupport = Math.abs(distPct) <= 1.5;
    const bounceConfirmed =
      nearSupport && ind1h.close > ind1h.ema200 && ind1h.volume > (ind1h.volumeAvg20 ?? Infinity);
    flags.push({
      key: "ema200",
      label: `EMA200(1h) ${distPct >= 0 ? "+" : ""}${distPct.toFixed(2)}%`,
      weak: nearSupport,
      strong: bounceConfirmed
    });
  }

  // ── 4. MACD histogram 1h ─────────────────────────────────────
  if (ind1h.macdHist !== null && ind1h.macdHistPrev !== null) {
    const shrinking = Math.abs(ind1h.macdHist) < Math.abs(ind1h.macdHistPrev) && ind1h.macdHist < 0;
    const bullishCross = ind1h.macdHistPrev < 0 && ind1h.macdHist >= 0;
    flags.push({
      key: "macd",
      label: `MACD hist(1h) ${ind1h.macdHist.toFixed(5)}`,
      weak: shrinking,
      strong: bullishCross
    });
  }

  // ── 5. Volume spike 15m ──────────────────────────────────────
  if (ind15.volumeAvg20 !== null && ind15.volumeAvg20 > 0) {
    const ratio = ind15.volume / ind15.volumeAvg20;
    flags.push({
      key: "volume",
      label: `Vol(15m) ${ratio.toFixed(2)}x avg`,
      weak: ratio > 1.0,
      strong: ratio >= 1.8
    });
  }

  // ── 6. Bollinger Bands squeeze 1h ────────────────────────────
  if (ind1h.bbLower !== null && ind1h.bbUpper !== null) {
    const touchingLower = ind1h.close <= ind1h.bbLower * 1.005;
    const bandWidth = (ind1h.bbUpper - ind1h.bbLower) / (ind1h.bbMiddle ?? ind1h.close);
    flags.push({
      key: "bb",
      label: `BB(1h) width ${(bandWidth * 100).toFixed(2)}%`,
      weak: touchingLower,
      strong: touchingLower && bandWidth < 0.04
    });
  }

  // ── 7. Stochastic RSI 1h ─────────────────────────────────────
  if (ind1h.stochRsiK !== null && ind1h.stochRsiKPrev !== null) {
    const crossingUp = ind1h.stochRsiK > ind1h.stochRsiKPrev;
    const bullishCrossFromOversold = ind1h.stochRsiKPrev < 20 && ind1h.stochRsiK >= 20;
    flags.push({
      key: "stoch_rsi",
      label: `StochRSI K(1h) ${ind1h.stochRsiK.toFixed(1)}`,
      weak: ind1h.stochRsiK < 30 && crossingUp,
      strong: bullishCrossFromOversold
    });
  }

  // ── 8. SMC Order Block 1h ────────────────────────────────────
  const obs1h = findOrderBlocks(candles1h);
  const price1h = ind1h.close;
  const bullishOB1h = obs1h.find(
    (ob) => ob.type === "bullish" && !ob.mitigated && price1h >= ob.bottom && price1h <= ob.top * 1.005
  );
  flags.push({
    key: "ob_1h",
    label: bullishOB1h
      ? `OB(1h) bullish zone ${bullishOB1h.bottom.toPrecision(5)}–${bullishOB1h.top.toPrecision(5)}`
      : "OB(1h) none",
    weak: false,
    strong: !!bullishOB1h
  });

  // ── 9. SMC FVG 1h ────────────────────────────────────────────
  const fvgs1h = findFairValueGaps(candles1h);
  const bullishFvg1h = fvgs1h.find(
    (g) => g.type === "bullish" && !g.filled && price1h >= g.bottom && price1h <= g.top
  );
  flags.push({
    key: "fvg_1h",
    label: bullishFvg1h
      ? `FVG(1h) bullish fill ${bullishFvg1h.bottom.toPrecision(5)}–${bullishFvg1h.top.toPrecision(5)}`
      : "FVG(1h) none",
    weak: !!bullishFvg1h,
    strong: false
  });

  // ── 10. SMC Order Block 4h (higher-timeframe confluence) ─────
  const obs4h = findOrderBlocks(candles4h);
  const price4h = ind4h.close;
  const bullishOB4h = obs4h.find(
    (ob) => ob.type === "bullish" && !ob.mitigated && price4h >= ob.bottom && price4h <= ob.top * 1.01
  );
  flags.push({
    key: "ob_4h",
    label: bullishOB4h
      ? `OB(4h) bullish zone ${bullishOB4h.bottom.toPrecision(5)}–${bullishOB4h.top.toPrecision(5)}`
      : "OB(4h) none",
    weak: false,
    strong: !!bullishOB4h // 4h OB is always strong — higher timeframe matters most
  });

  // ── 11. SMC FVG 4h ────────────────────────────────────────────
  const fvgs4h = findFairValueGaps(candles4h);
  const bullishFvg4h = fvgs4h.find(
    (g) => g.type === "bullish" && !g.filled && price4h >= g.bottom && price4h <= g.top
  );
  flags.push({
    key: "fvg_4h",
    label: bullishFvg4h
      ? `FVG(4h) bullish fill ${bullishFvg4h.bottom.toPrecision(5)}–${bullishFvg4h.top.toPrecision(5)}`
      : "FVG(4h) none",
    weak: !!bullishFvg4h,
    strong: false
  });

  // ── 12. Buy-side liquidity proximity ─────────────────────────
  const zones1h = findLiquidityZones(pivots1h);
  const buySideZones = zones1h.filter((z) => z.type === "buy_side");
  const nearBuySide = buySideZones.find((z) => {
    const dist = Math.abs(price1h - z.price) / z.price;
    return dist <= 0.008; // within 0.8% of a liquidity cluster
  });
  flags.push({
    key: "liquidity",
    label: nearBuySide
      ? `Liq sweep zone ${nearBuySide.price.toPrecision(5)} (${nearBuySide.touches} touches)`
      : "Liq zone: none nearby",
    weak: !!nearBuySide,
    strong: !!(nearBuySide && nearBuySide.touches >= 3)
  });

  // ── 13. Heikin-Ashi trend confirmation ───────────────────────
  if (ind1h.haTrend !== null) {
    flags.push({
      key: "ha_trend",
      label: `HA(1h) trend: ${ind1h.haTrend}`,
      weak: ind1h.haTrend === "transitioning",
      strong: ind1h.haTrend === "bullish"
    });
  }

  // ── 14. 4h RSI divergence / oversold ─────────────────────────
  if (ind4h.rsi !== null) {
    const turningUp4h = ind4h.rsiPrev !== null && ind4h.rsi > ind4h.rsiPrev;
    flags.push({
      key: "rsi_4h",
      label: `RSI(4h) ${ind4h.rsi.toFixed(1)}`,
      weak: ind4h.rsi >= 30 && ind4h.rsi <= 45,
      strong: ind4h.rsi < 30 && turningUp4h
    });
  }

  return flags;
}

export function scanSymbol(
  symbol: string,
  candles: { m15: Candle[]; h1: Candle[]; h4: Candle[] },
  meta: { priceChangePercent: number; quoteVolume: number }
): ScanResult | null {
  const { m15, h1, h4 } = candles;
  if (!m15.length || !h1.length || !h4.length) return null;

  const price = h1[h1.length - 1].close;
  if (!Number.isFinite(price) || price <= 0) return null;

  const ind15 = computeIndicators(m15);
  const ind1h = computeIndicators(h1);
  const ind4h = computeIndicators(h4);

  const pivots1h = computeZigZag(h1, 2);
  const pivots4h = computeZigZag(h4, 2.5); // slightly wider deviation on 4h for cleaner pivots
  const structure4h = detectStructure(pivots4h);

  // Pattern detection on both 1h and 4h pivots
  const pattern1h = detectPattern(pivots1h);
  const pattern4h = detectPattern(pivots4h);
  // Prefer 4h pattern if it's more significant
  const pattern = pattern4h.type !== "none" ? pattern4h : pattern1h;

  const flags = evaluateFlags(ind15, ind1h, ind4h, h1, h4, pivots1h, pivots4h);

  // ── Pattern signal (appended after base flags) ────────────────
  flags.push({
    key: "pattern",
    label: pattern.type !== "none" ? pattern.description : "No pattern",
    weak: pattern.type === "triangle_compression",
    strong: pattern.type === "double_bottom" && pattern.confidence > 0.6
  });

  // ── CHoCH structure event flag ────────────────────────────────
  const isChoCHBullish = structure4h.event === "CHOCH_BULLISH";
  const isBosBullish = structure4h.event === "BOS_BULLISH";
  if (isChoCHBullish || isBosBullish) {
    flags.push({
      key: "structure_event",
      label: isChoCHBullish ? "CHoCH Bullish (4h)" : "BOS Bullish (4h)",
      weak: isBosBullish,
      strong: isChoCHBullish
    });
  }

  // Hard veto: double top suppresses all strong signals
  if (pattern.type === "double_top") {
    flags.forEach((f) => (f.strong = false));
  }

  const strongCount = flags.filter((f) => f.strong).length;
  const weakCount = flags.filter((f) => f.weak && !f.strong).length;
  const signalCount = strongCount + weakCount;

  // Tier thresholds (v3.0: S now requires ≥3 strong given expanded signal set)
  let tier: Tier = "NONE";
  if (signalCount >= 5 && strongCount >= 3 && structure4h.trend !== "down") tier = "S";
  else if (signalCount >= 3 && strongCount >= 1 && structure4h.trend !== "down") tier = "A";
  else if (signalCount >= 2) tier = "B";

  // ATR-based TP/SL (1h ATR)
  const atr = ind1h.atr ?? price * 0.02;
  const stopLoss = price - 1.5 * atr;
  const takeProfit1 = price + 2 * atr;
  const takeProfit2 = price + 3.5 * atr;
  const risk = price - stopLoss;
  const riskRewardT1 = risk > 0 ? (takeProfit1 - price) / risk : 0;
  const riskRewardT2 = risk > 0 ? (takeProfit2 - price) / risk : 0;

  // Enforce minimum 1:2 R:R at TP1
  if (riskRewardT1 < 2 && tier !== "NONE") {
    tier = "NONE";
  }

  // Liquidity info for UI display
  const zones1h = findLiquidityZones(pivots1h);
  const nearestBuySide = zones1h
    .filter((z) => z.type === "buy_side" && z.price < price)
    .sort((a, b) => b.price - a.price)[0] ?? null;

  const activeReasons = flags.filter((f) => f.strong || f.weak).map((f) => f.label);
  const reason =
    activeReasons.length > 0
      ? `${activeReasons.join(" + ")} — 4h: ${structure4h.trend}${structure4h.event !== "NONE" ? ` (${structure4h.event})` : ""}`
      : `No signals aligned — 4h: ${structure4h.trend}`;

  return {
    symbol,
    tier,
    price,
    signalCount,
    trend4h: structure4h.trend,
    structureEvent: structure4h.event,
    flags,
    reason,
    entry: price,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskRewardT1,
    riskRewardT2,
    atr: ind1h.atr,
    priceChangePercent: meta.priceChangePercent,
    quoteVolume: meta.quoteVolume,
    nearLiquidity: !!nearestBuySide,
    liquidityPrice: nearestBuySide?.price ?? null
  };
}
