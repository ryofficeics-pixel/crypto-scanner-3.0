// lib/scoring.ts
// The decision engine. Combines indicators + SMC + structure + pattern signals
// from 15m/1h/4h into a single tiered call (S / A / B / none), with ATR-based
// TP/SL and a human-readable reason string where every claim traces to a
// computed number — no vague labels, per project's no-fabrication standard.
//
// v3.0 changes:
//   - 14-signal engine (was 8): 4h OB, 4h FVG, liquidity, HA trend, 4h RSI, CHoCH event
//   - findLiquidityZones computed once (was called twice — in evaluateFlags AND scanSymbol)
//   - "none" flags suppressed: flags with weak=false && strong=false are not pushed
//   - pattern.bearish used for the veto (covers all bearish patterns, not just double_top)
//   - Tier S threshold: ≥5 signals, ≥3 strong (raised from ≥2 due to expanded signal set)

import type { Candle } from "./binance";
import { KLINES_LIMIT } from "./binance";
import { computeIndicators, IndicatorSnapshot } from "./indicators";
import { computeZigZag, detectStructure, Pivot } from "./zigzag";
import { findOrderBlocks, findFairValueGaps, findLiquidityZones, LiquidityZone } from "./smc";
import { detectPattern } from "./patterns";

/**
 * Listing-age heuristic — zero extra API calls.
 *
 * Binance's spot exchangeInfo has no listing-date field (onboardDate only
 * exists on the Futures API), so there's no direct way to ask "when was
 * this listed". Instead: klines always return as many candles as actually
 * exist, up to the requested `limit`. If the returned array is SHORTER
 * than KLINES_LIMIT, that array's first candle IS the symbol's genesis
 * candle at that interval — we can read its openTime directly.
 *
 * Checks finest-to-coarsest interval so the age estimate is as precise as
 * possible: 15m (up to ~2.6 days), then 1h (~10.4 days), then 4h (~41.7
 * days). Beyond that we can't tell from this data — treated as "not new".
 */
function estimateListingAgeHours(
  m15: Candle[], h1: Candle[], h4: Candle[]
): number | null {
  const now = Date.now();
  if (m15.length < KLINES_LIMIT && m15.length > 0) {
    return (now - m15[0].openTime) / 3_600_000;
  }
  if (h1.length < KLINES_LIMIT && h1.length > 0) {
    return (now - h1[0].openTime) / 3_600_000;
  }
  if (h4.length < KLINES_LIMIT && h4.length > 0) {
    return (now - h4[0].openTime) / 3_600_000;
  }
  return null; // has full history at every interval we checked — not "new"
}

// Matches the user's own stated pattern: the big move usually happens in
// the first 1-2 days after listing. 48h is the flagging threshold.
const NEW_LISTING_THRESHOLD_HOURS = 48;

/**
 * "Exit liquidity" pattern detection for fresh listings.
 *
 * Common pattern: a coin builds hype on a smaller exchange / social media,
 * gets listed on Binance, retail piles in on the listing, price spikes —
 * then dumps hard as early holders sell into that new liquidity. This is
 * fundamentally different from "still climbing" new-listing momentum, and
 * showing it as a normal bullish tier would be actively misleading.
 *
 * Uses the SAME candle array that estimateListingAgeHours already
 * identified as the symbol's full trading history (no extra API calls):
 * if price already pumped a meaningful amount off its earliest close
 * (confirms a real pump happened) AND has since retraced hard from its
 * high-since-listing, flag it. This is a shape-based heuristic on data we
 * already have — not a guarantee, just a risk flag.
 */
function detectExitLiquidityPattern(
  isNewListing: boolean,
  m15: Candle[], h1: Candle[], h4: Candle[]
): { possibleExitLiquidity: boolean; athSinceListing: number | null; drawdownFromAthPct: number | null } {
  const none = { possibleExitLiquidity: false, athSinceListing: null, drawdownFromAthPct: null };
  if (!isNewListing) return none;

  let windowCandles: Candle[] | null = null;
  if (m15.length < KLINES_LIMIT && m15.length > 0) windowCandles = m15;
  else if (h1.length < KLINES_LIMIT && h1.length > 0) windowCandles = h1;
  else if (h4.length < KLINES_LIMIT && h4.length > 0) windowCandles = h4;
  if (!windowCandles || windowCandles.length < 3) return none;

  const athSinceListing = Math.max(...windowCandles.map((c) => c.high));
  const currentPrice = windowCandles[windowCandles.length - 1].close;
  const firstClose = windowCandles[0].close;

  const pumpedPct = firstClose > 0 ? ((athSinceListing - firstClose) / firstClose) * 100 : 0;
  const drawdownFromAthPct = athSinceListing > 0 ? ((currentPrice - athSinceListing) / athSinceListing) * 100 : 0;

  const MIN_PUMP_TO_QUALIFY_PCT       = 20;  // it needs to have actually pumped first
  const EXIT_LIQUIDITY_DRAWDOWN_PCT   = -15; // ...then given back at least this much

  const possibleExitLiquidity =
    pumpedPct >= MIN_PUMP_TO_QUALIFY_PCT && drawdownFromAthPct <= EXIT_LIQUIDITY_DRAWDOWN_PCT;

  return { possibleExitLiquidity, athSinceListing, drawdownFromAthPct };
}

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
  nearLiquidity: boolean;
  liquidityPrice: number | null;
  isNewListing: boolean;
  listingAgeHours: number | null;
  possibleExitLiquidity: boolean;
  athSinceListing: number | null;
  drawdownFromAthPct: number | null;
}

/** Only push a flag if it carries a signal (weak or strong). Suppresses noisy "none" entries. */
function pushFlag(flags: SignalFlag[], flag: SignalFlag): void {
  if (flag.weak || flag.strong) flags.push(flag);
}

function evaluateFlags(
  ind15: IndicatorSnapshot,
  ind1h: IndicatorSnapshot,
  ind4h: IndicatorSnapshot,
  candles1h: Candle[],
  candles4h: Candle[],
  zones1h: LiquidityZone[]   // pre-computed — passed in to avoid duplicate work
): SignalFlag[] {
  const flags: SignalFlag[] = [];

  // ── 1. RSI 1h ────────────────────────────────────────────────
  if (ind1h.rsi !== null) {
    const turningUp = ind1h.rsiPrev !== null && ind1h.rsi > ind1h.rsiPrev;
    pushFlag(flags, {
      key: "rsi",
      label: `RSI(1h) ${ind1h.rsi.toFixed(1)}`,
      weak:   ind1h.rsi >= 30 && ind1h.rsi <= 40,
      strong: ind1h.rsi < 30 && turningUp
    });
  }

  // ── 2. EMA20/50 cross 1h ─────────────────────────────────────
  if (
    ind1h.ema20 !== null && ind1h.ema50 !== null &&
    ind1h.ema20Prev !== null && ind1h.ema50Prev !== null
  ) {
    const goldenCross = ind1h.ema20 > ind1h.ema50 && ind1h.ema20Prev <= ind1h.ema50Prev;
    const reclaiming  = ind1h.close > ind1h.ema20 && ind1h.ema20 < ind1h.ema50;
    pushFlag(flags, {
      key: "ema_cross",
      label: `EMA20/50(1h) ${ind1h.ema20 > ind1h.ema50 ? "bullish" : "bearish"}`,
      weak:   reclaiming,
      strong: goldenCross
    });
  }

  // ── 3. EMA200 support test 1h ────────────────────────────────
  if (ind1h.ema200 !== null) {
    const distPct = ((ind1h.close - ind1h.ema200) / ind1h.ema200) * 100;
    const nearSupport = Math.abs(distPct) <= 1.5;
    const bounceConfirmed =
      nearSupport &&
      ind1h.close > ind1h.ema200 &&
      ind1h.volume > (ind1h.volumeAvg20 ?? Infinity);
    pushFlag(flags, {
      key: "ema200",
      label: `EMA200(1h) ${distPct >= 0 ? "+" : ""}${distPct.toFixed(2)}%`,
      weak:   nearSupport,
      strong: bounceConfirmed
    });
  }

  // ── 4. MACD histogram 1h ─────────────────────────────────────
  if (ind1h.macdHist !== null && ind1h.macdHistPrev !== null) {
    const shrinking    = Math.abs(ind1h.macdHist) < Math.abs(ind1h.macdHistPrev) && ind1h.macdHist < 0;
    const bullishCross = ind1h.macdHistPrev < 0 && ind1h.macdHist >= 0;
    pushFlag(flags, {
      key: "macd",
      label: `MACD hist(1h) ${ind1h.macdHist.toFixed(5)}`,
      weak:   shrinking,
      strong: bullishCross
    });
  }

  // ── 5. Volume spike 15m ──────────────────────────────────────
  if (ind15.volumeAvg20 !== null && ind15.volumeAvg20 > 0) {
    const ratio = ind15.volume / ind15.volumeAvg20;
    pushFlag(flags, {
      key: "volume",
      label: `Vol(15m) ${ratio.toFixed(2)}x avg`,
      weak:   ratio > 1.0,
      strong: ratio >= 1.8
    });
  }

  // ── 6. Bollinger Bands squeeze 1h ────────────────────────────
  if (ind1h.bbLower !== null && ind1h.bbUpper !== null && ind1h.bbMiddle !== null) {
    const touchingLower = ind1h.close <= ind1h.bbLower * 1.005;
    const bandWidth     = (ind1h.bbUpper - ind1h.bbLower) / ind1h.bbMiddle;
    pushFlag(flags, {
      key: "bb",
      label: `BB(1h) width ${(bandWidth * 100).toFixed(2)}%`,
      weak:   touchingLower,
      strong: touchingLower && bandWidth < 0.04
    });
  }

  // ── 7. Stochastic RSI 1h ─────────────────────────────────────
  if (ind1h.stochRsiK !== null && ind1h.stochRsiKPrev !== null) {
    const crossingUp              = ind1h.stochRsiK > ind1h.stochRsiKPrev;
    const bullishCrossFromOversold = ind1h.stochRsiKPrev < 20 && ind1h.stochRsiK >= 20;
    pushFlag(flags, {
      key: "stoch_rsi",
      label: `StochRSI K(1h) ${ind1h.stochRsiK.toFixed(1)}`,
      weak:   ind1h.stochRsiK < 30 && crossingUp,
      strong: bullishCrossFromOversold
    });
  }

  // ── 8. SMC Order Block 1h ────────────────────────────────────
  const obs1h     = findOrderBlocks(candles1h);
  const price1h   = ind1h.close;
  const bullishOB1h = obs1h.find(
    (ob) => ob.type === "bullish" && !ob.mitigated &&
            price1h >= ob.bottom && price1h <= ob.top * 1.005
  );
  if (bullishOB1h) {
    flags.push({
      key: "ob_1h",
      label: `OB(1h) bullish ${bullishOB1h.bottom.toPrecision(5)}–${bullishOB1h.top.toPrecision(5)}`,
      weak:   false,
      strong: true
    });
  }

  // ── 9. SMC FVG 1h ────────────────────────────────────────────
  const fvgs1h      = findFairValueGaps(candles1h);
  const bullishFvg1h = fvgs1h.find(
    (g) => g.type === "bullish" && !g.filled &&
           price1h >= g.bottom && price1h <= g.top
  );
  if (bullishFvg1h) {
    flags.push({
      key: "fvg_1h",
      label: `FVG(1h) bullish fill ${bullishFvg1h.bottom.toPrecision(5)}–${bullishFvg1h.top.toPrecision(5)}`,
      weak:   true,
      strong: false
    });
  }

  // ── 10. SMC Order Block 4h (higher-timeframe confluence) ─────
  const obs4h     = findOrderBlocks(candles4h);
  const price4h   = ind4h.close;
  const bullishOB4h = obs4h.find(
    (ob) => ob.type === "bullish" && !ob.mitigated &&
            price4h >= ob.bottom && price4h <= ob.top * 1.01
  );
  if (bullishOB4h) {
    flags.push({
      key: "ob_4h",
      label: `OB(4h) bullish ${bullishOB4h.bottom.toPrecision(5)}–${bullishOB4h.top.toPrecision(5)}`,
      weak:   false,
      strong: true  // 4h OB always strong — higher timeframe institutional demand
    });
  }

  // ── 11. SMC FVG 4h ───────────────────────────────────────────
  const fvgs4h      = findFairValueGaps(candles4h);
  const bullishFvg4h = fvgs4h.find(
    (g) => g.type === "bullish" && !g.filled &&
           price4h >= g.bottom && price4h <= g.top
  );
  if (bullishFvg4h) {
    flags.push({
      key: "fvg_4h",
      label: `FVG(4h) bullish fill ${bullishFvg4h.bottom.toPrecision(5)}–${bullishFvg4h.top.toPrecision(5)}`,
      weak:   true,
      strong: false
    });
  }

  // ── 12. Buy-side liquidity proximity ─────────────────────────
  // Note: proximity tightened from 0.8% → 0.3% because a loose threshold
  // falsely implied support was nearby when price was actually well above
  // the zone, leading users to buy at market expecting a bounce that never
  // came.
  const buySideZones = zones1h.filter((z) => z.type === "buy_side");
  const nearBuySide  = buySideZones.find((z) => {
    const dist = Math.abs(price1h - z.price) / z.price;
    return dist <= 0.003; // within 0.3% of a liquidity cluster
  });
  if (nearBuySide) {
    flags.push({
      key: "liquidity",
      label: `Liq zone ${nearBuySide.price.toPrecision(5)} (${nearBuySide.touches} touches)`,
      weak:   nearBuySide.touches < 3,
      strong: nearBuySide.touches >= 3
    });
  }

  // ── 13. Heikin-Ashi trend confirmation 1h ────────────────────
  if (ind1h.haTrend !== null) {
    pushFlag(flags, {
      key: "ha_trend",
      label: `HA(1h) ${ind1h.haTrend}`,
      weak:   ind1h.haTrend === "transitioning",
      strong: ind1h.haTrend === "bullish"
    });
  }

  // ── 14. RSI 4h oversold ──────────────────────────────────────
  if (ind4h.rsi !== null) {
    const turningUp4h = ind4h.rsiPrev !== null && ind4h.rsi > ind4h.rsiPrev;
    pushFlag(flags, {
      key: "rsi_4h",
      label: `RSI(4h) ${ind4h.rsi.toFixed(1)}`,
      weak:   ind4h.rsi >= 30 && ind4h.rsi <= 45,
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

  const listingAgeHours = estimateListingAgeHours(m15, h1, h4);
  const isNewListing = listingAgeHours !== null && listingAgeHours <= NEW_LISTING_THRESHOLD_HOURS;
  const { possibleExitLiquidity, athSinceListing, drawdownFromAthPct } =
    detectExitLiquidityPattern(isNewListing, m15, h1, h4);

  const price = h1[h1.length - 1].close;
  if (!Number.isFinite(price) || price <= 0) return null;

  const ind15 = computeIndicators(m15);
  const ind1h = computeIndicators(h1);
  const ind4h = computeIndicators(h4);

  const pivots1h   = computeZigZag(h1, 2);
  const pivots4h   = computeZigZag(h4, 2.5); // wider deviation on 4h for cleaner pivots
  const structure4h = detectStructure(pivots4h);

  // Compute liquidity zones ONCE and reuse in both evaluateFlags and nearestBuySide lookup
  const zones1h = findLiquidityZones(pivots1h);

  // Pattern detection: prefer 4h pattern when meaningful, fall back to 1h
  const pattern1h = detectPattern(pivots1h);
  const pattern4h = detectPattern(pivots4h);
  const pattern   = pattern4h.type !== "none" ? pattern4h : pattern1h;

  const flags = evaluateFlags(ind15, ind1h, ind4h, h1, h4, zones1h);

  // ── Pattern signal ────────────────────────────────────────────
  if (pattern.type !== "none") {
    flags.push({
      key: "pattern",
      label: pattern.description,
      weak:   !pattern.bearish && pattern.type === "triangle_compression",
      strong: !pattern.bearish && pattern.confidence > 0.6
    });
  }

  // ── CHoCH / BOS structure event as explicit flag ──────────────
  const isChoCHBullish = structure4h.event === "CHOCH_BULLISH";
  const isBosBullish   = structure4h.event === "BOS_BULLISH";
  if (isChoCHBullish || isBosBullish) {
    flags.push({
      key: "structure_event",
      label: isChoCHBullish ? "CHoCH Bullish (4h)" : "BOS Bullish (4h)",
      weak:   isBosBullish,
      strong: isChoCHBullish
    });
  }

  // Hard veto: any bearish pattern suppresses all strong signals.
  // Uses pattern.bearish so H&S and ascending wedge are also covered (not just double_top).
  if (pattern.bearish) {
    flags.forEach((f) => (f.strong = false));
  }

  const strongCount  = flags.filter((f) => f.strong).length;
  const weakCount    = flags.filter((f) => f.weak && !f.strong).length;
  const signalCount  = strongCount + weakCount;

  // Tier thresholds (v3.0: S requires ≥3 strong given the expanded 14-signal set)
  let tier: Tier = "NONE";
  if (signalCount >= 5 && strongCount >= 3 && structure4h.trend !== "down") tier = "S";
  else if (signalCount >= 3 && strongCount >= 1 && structure4h.trend !== "down") tier = "A";
  else if (signalCount >= 2) tier = "B";

  // Nearest buy-side liquidity below price — computed BEFORE entry/SL since
  // it now feeds into the entry price (limit order at the zone, not market).
  const nearestBuySide = zones1h
    .filter((z) => z.type === "buy_side" && z.price < price)
    .sort((a, b) => b.price - a.price)[0] ?? null;

  // ATR-based TP/SL (1h ATR — matches setup-confirmation timeframe)
  // Multipliers chosen so R:R is mathematically achievable:
  //   SL  = 1.0 × ATR below entry  → risk = 1 ATR
  //   TP1 = 2.0 × ATR above entry  → R:R = 2.0  (enforced minimum)
  //   TP2 = 3.5 × ATR above entry  → R:R = 3.5
  // Previous values (SL=1.5×, TP1=2.0×) gave R:R=1.33 which ALWAYS
  // failed the ≥2.0 gate, vetoing every single result.
  const atr = ind1h.atr ?? price * 0.02; // fallback only for very new listings

  // When a buy-side liquidity zone exists below price AND is close enough
  // to use as a limit-entry level, the entry becomes the zone price —
  // not the current market price. This fixes the bug where the scanner
  // showed "buy-side liquidity at $X" but placed a market entry above it,
  // so the zone was never actually used for the trade. SL goes just below
  // the zone so it actually protects against a breakdown.
  let entry: number;
  let stopLoss: number;
  if (nearestBuySide && (price - nearestBuySide.price) <= 0.5 * atr) {
    entry = nearestBuySide.price;        // limit order at the liquidity zone
    stopLoss = entry - 0.8 * atr;        // SL below the zone (tighter than 1.0× since entry is better)
  } else {
    entry = price;                        // market entry at current price
    stopLoss = price - 1.0 * atr;
  }
  const takeProfit1 = entry + 2.0 * atr;
  const takeProfit2 = entry + 3.5 * atr;
  const risk         = entry - stopLoss;
  const riskRewardT1 = risk > 0 ? (takeProfit1 - entry) / risk : 0;
  const riskRewardT2 = risk > 0 ? (takeProfit2 - entry) / risk : 0;

  // Enforce minimum 1:2 R:R at TP1 (now always met: 2.0 ATR / 1.0 ATR = 2.0)
  if (riskRewardT1 < 2 && tier !== "NONE") tier = "NONE";

  // Veto: a fresh listing that already pumped and is now dumping hard from
  // its own ATH is a classic "hype -> Binance listing -> exit liquidity"
  // pattern. Showing this as a bullish S/A/B tier would be actively
  // misleading regardless of what the indicators say — those signals were
  // likely generated ON the way up and are now stale/wrong. Force NONE so
  // it only ever surfaces via the NEW/warning badge, never as a buy tier.
  if (possibleExitLiquidity) tier = "NONE";

  const activeReasons = flags
    .filter((f) => f.strong || f.weak)
    .map((f) => f.label);

  const reason =
    possibleExitLiquidity
      ? `⚠ Possible exit liquidity — pumped then ${drawdownFromAthPct?.toFixed(1)}% off ATH within ${listingAgeHours?.toFixed(1)}h of listing`
      : activeReasons.length > 0
      ? `${activeReasons.join(" + ")} — 4h: ${structure4h.trend}${
          structure4h.event !== "NONE" ? ` (${structure4h.event})` : ""
        }`
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
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskRewardT1,
    riskRewardT2,
    atr: ind1h.atr,
    priceChangePercent: meta.priceChangePercent,
    quoteVolume: meta.quoteVolume,
    nearLiquidity: !!nearestBuySide,
    liquidityPrice: nearestBuySide?.price ?? null,
    isNewListing,
    listingAgeHours,
    possibleExitLiquidity,
    athSinceListing,
    drawdownFromAthPct
  };
}
