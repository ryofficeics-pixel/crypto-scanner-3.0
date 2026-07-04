// lib/indicators.ts
// Wraps the `technicalindicators` npm package for RSI, EMA, MACD, Bollinger
// Bands, Stoch RSI, ATR. Also computes Heikin-Ashi trend, OBV divergence,
// and VWAP proximity in-house (no extra dependency).
//
// v3.1: Added OBV divergence, VWAP (session-approximate), bearish signals

import { RSI, EMA, MACD, BollingerBands, StochasticRSI, ATR } from "technicalindicators";
import type { Candle } from "./binance";

export type HaTrend = "bullish" | "bearish" | "transitioning" | null;
export type ObvDivergence = "bullish" | "bearish" | null;

export interface IndicatorSnapshot {
  rsi: number | null;
  rsiPrev: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  ema20Prev: number | null;
  ema50Prev: number | null;
  macdHist: number | null;
  macdHistPrev: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbMiddle: number | null;
  stochRsiK: number | null;
  stochRsiKPrev: number | null;
  stochRsiD: number | null;
  atr: number | null;
  volume: number;
  volumeAvg20: number | null;
  close: number;
  haTrend: HaTrend;
  obvDivergence: ObvDivergence;
  vwapDist: number | null; // % distance from VWAP (positive = above)
}

function last<T>(arr: T[], offset = 0): T | null {
  const idx = arr.length - 1 - offset;
  return idx >= 0 ? arr[idx] : null;
}

/**
 * Heikin-Ashi candle trend detector.
 * Requires candles.length >= lookback + 2
 */
function computeHaTrend(candles: Candle[], lookback = 3): HaTrend {
  if (candles.length < lookback + 2) return null;

  const slice = candles.slice(-(lookback + 2));
  interface HaCandle { open: number; close: number; high: number; low: number; }
  const ha: HaCandle[] = [];
  let prevHaOpen  = (slice[0].open + slice[0].close) / 2;
  let prevHaClose = (slice[0].open + slice[0].high + slice[0].low + slice[0].close) / 4;

  for (let i = 1; i < slice.length; i++) {
    const c       = slice[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen  = (prevHaOpen + prevHaClose) / 2;
    const haHigh  = Math.max(c.high, haOpen, haClose);
    const haLow   = Math.min(c.low,  haOpen, haClose);
    ha.push({ open: haOpen, close: haClose, high: haHigh, low: haLow });
    prevHaOpen  = haOpen;
    prevHaClose = haClose;
  }

  const recent     = ha.slice(-lookback);
  const allGreen   = recent.every((c) => c.close > c.open);
  const allRed     = recent.every((c) => c.close < c.open);
  const noLowerWick = recent.every((c) => Math.min(c.open, c.close) - c.low  < 1e-10 * Math.abs(c.close));
  const noUpperWick = recent.every((c) => c.high - Math.max(c.open, c.close)  < 1e-10 * Math.abs(c.close));

  if (allGreen && noLowerWick) return "bullish";
  if (allRed   && noUpperWick) return "bearish";

  const cur  = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  if (cur && prev) {
    const curGreen  = cur.close  > cur.open;
    const prevGreen = prev.close > prev.open;
    if (curGreen !== prevGreen) return "transitioning";
  }
  return allGreen ? "bullish" : allRed ? "bearish" : null;
}

/**
 * OBV (On-Balance Volume) divergence detector.
 *
 * Computes OBV series, then compares price trend vs OBV trend over
 * the last `lookback` candles using linear regression slope:
 *   Bullish divergence: price making lower lows but OBV making higher lows
 *   Bearish divergence: price making higher highs but OBV making lower highs
 *
 * Reference: standard OBV formula from Freqtrade/TA-Lib
 *   OBV[i] = OBV[i-1] + volume[i]  if close[i] > close[i-1]
 *           = OBV[i-1] - volume[i]  if close[i] < close[i-1]
 *           = OBV[i-1]              if close[i] = close[i-1]
 */
function computeObvDivergence(candles: Candle[], lookback = 20): ObvDivergence {
  if (candles.length < lookback + 2) return null;

  const slice = candles.slice(-(lookback + 1));

  // Compute OBV
  const obv: number[] = [0];
  for (let i = 1; i < slice.length; i++) {
    const prev = obv[obv.length - 1];
    if      (slice[i].close > slice[i - 1].close) obv.push(prev + slice[i].volume);
    else if (slice[i].close < slice[i - 1].close) obv.push(prev - slice[i].volume);
    else                                            obv.push(prev);
  }

  // Linear regression slope helper
  const slope = (arr: number[]): number => {
    const n     = arr.length;
    const xMean = (n - 1) / 2;
    const yMean = arr.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (arr[i] - yMean);
      den += (i - xMean) ** 2;
    }
    return den === 0 ? 0 : num / den;
  };

  const prices  = slice.slice(1).map((c) => c.close); // same length as obv tail
  const obvTail = obv.slice(1);

  const priceSlope = slope(prices);
  const obvSlope   = slope(obvTail);

  // Normalize slopes by their mean to make comparison scale-independent
  const priceMean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const obvMean   = Math.abs(obvTail.reduce((a, b) => a + b, 0) / obvTail.length) || 1;

  const priceNorm = priceSlope / priceMean;
  const obvNorm   = obvSlope   / obvMean;

  const THRESHOLD = 0.0002; // minimum slope magnitude to avoid noise

  // Bullish divergence: price falling, OBV rising (smart money accumulating)
  if (priceNorm < -THRESHOLD && obvNorm > THRESHOLD) return "bullish";
  // Bearish divergence: price rising, OBV falling (smart money distributing)
  if (priceNorm > THRESHOLD && obvNorm < -THRESHOLD) return "bearish";

  return null;
}

/**
 * VWAP approximation over the last N candles.
 *
 * True intraday VWAP resets at session open. Since we don't have
 * tick data, we approximate using OHLC/4 as typical price over
 * the last `period` candles — this is the standard "rolling VWAP"
 * approach used in freqtrade community strategies.
 *
 * Returns % distance of current close from VWAP.
 * Positive = price above VWAP (bullish bias)
 * Negative = price below VWAP (potential support / buy zone)
 */
function computeVwapDist(candles: Candle[], period = 20): number | null {
  if (candles.length < period) return null;

  const slice = candles.slice(-period);
  let cumTPV = 0; // cumulative (typical price × volume)
  let cumVol = 0;

  for (const c of slice) {
    const tp = (c.high + c.low + c.close) / 3; // typical price
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }

  if (cumVol === 0) return null;
  const vwap   = cumTPV / cumVol;
  const close  = candles[candles.length - 1].close;
  return ((close - vwap) / vwap) * 100;
}

export function computeIndicators(candles: Candle[]): IndicatorSnapshot {
  const closes  = candles.map((c) => c.close);
  const highs   = candles.map((c) => c.high);
  const lows    = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const rsiSeries    = RSI.calculate({ period: 14, values: closes });
  const ema20Series  = EMA.calculate({ period: 20, values: closes });
  const ema50Series  = EMA.calculate({ period: 50, values: closes });
  const ema200Series = EMA.calculate({ period: 200, values: closes });
  const macdSeries   = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false
  });
  const bbSeries       = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const stochRsiSeries = StochasticRSI.calculate({
    values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3
  });
  const atrSeries  = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const volumeAvg20 = volumes.length >= 20
    ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;

  const lastMacd  = last(macdSeries, 0);
  const prevMacd  = last(macdSeries, 1);
  const lastBb    = last(bbSeries, 0);
  const lastStoch = last(stochRsiSeries, 0);
  const prevStoch = last(stochRsiSeries, 1);

  return {
    rsi:           last(rsiSeries, 0),
    rsiPrev:       last(rsiSeries, 1),
    ema20:         last(ema20Series, 0),
    ema50:         last(ema50Series, 0),
    ema200:        last(ema200Series, 0),
    ema20Prev:     last(ema20Series, 1),
    ema50Prev:     last(ema50Series, 1),
    macdHist:      lastMacd?.histogram ?? null,
    macdHistPrev:  prevMacd?.histogram ?? null,
    macdLine:      lastMacd?.MACD      ?? null,
    macdSignal:    lastMacd?.signal    ?? null,
    bbUpper:       lastBb?.upper  ?? null,
    bbLower:       lastBb?.lower  ?? null,
    bbMiddle:      lastBb?.middle ?? null,
    stochRsiK:     lastStoch?.k ?? null,
    stochRsiKPrev: prevStoch?.k ?? null,
    stochRsiD:     lastStoch?.d ?? null,
    atr:           last(atrSeries, 0),
    volume:        volumes[volumes.length - 1] ?? 0,
    volumeAvg20,
    close:         closes[closes.length - 1] ?? 0,
    haTrend:       computeHaTrend(candles),
    obvDivergence: computeObvDivergence(candles),
    vwapDist:      computeVwapDist(candles),
  };
}
