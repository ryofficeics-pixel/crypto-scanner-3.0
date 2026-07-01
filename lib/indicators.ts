// lib/indicators.ts
// Wraps the `technicalindicators` npm package for RSI, EMA, MACD, Bollinger
// Bands, Stoch RSI, ATR. Also computes Heikin-Ashi candle trend in-house
// (no extra dependency — just arithmetic on OHLC).
//
// v3.0: Added haTrend ("bullish" | "bearish" | "transitioning" | null)

import { RSI, EMA, MACD, BollingerBands, StochasticRSI, ATR } from "technicalindicators";
import type { Candle } from "./binance";

export type HaTrend = "bullish" | "bearish" | "transitioning" | null;

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
}

function last<T>(arr: T[], offset = 0): T | null {
  const idx = arr.length - 1 - offset;
  return idx >= 0 ? arr[idx] : null;
}

/**
 * Heikin-Ashi candle trend detector.
 *
 * Converts raw OHLC to HA candles, then looks at the last N candles:
 *   - "bullish"       : last 3 HA candles all green (haClose > haOpen), no lower wicks
 *   - "bearish"       : last 3 HA candles all red (haClose < haOpen), no upper wicks
 *   - "transitioning" : mixed (first candle after a colour change — doji-like)
 */
function computeHaTrend(candles: Candle[], lookback = 3): HaTrend {
  if (candles.length < lookback + 1) return null;

  // Build HA candles for the tail we care about
  const slice = candles.slice(-(lookback + 2));
  interface HaCandle { open: number; close: number; hasLowerWick: boolean; hasUpperWick: boolean }
  const ha: HaCandle[] = [];

  let prevHaOpen = (slice[0].open + slice[0].close) / 2;
  let prevHaClose = (slice[0].open + slice[0].high + slice[0].low + slice[0].close) / 4;

  for (let i = 1; i < slice.length; i++) {
    const c = slice[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);

    ha.push({
      open: haOpen,
      close: haClose,
      hasLowerWick: Math.min(haOpen, haClose) - haLow > 1e-10,
      hasUpperWick: haHigh - Math.max(haOpen, haClose) > 1e-10
    });

    prevHaOpen = haOpen;
    prevHaClose = haClose;
  }

  const recent = ha.slice(-lookback);
  const allGreen = recent.every((c) => c.close > c.open);
  const allRed = recent.every((c) => c.close < c.open);
  const noLowerWick = recent.every((c) => !c.hasLowerWick);
  const noUpperWick = recent.every((c) => !c.hasUpperWick);

  if (allGreen && noLowerWick) return "bullish";
  if (allRed && noUpperWick) return "bearish";
  // Mixed colours = transition candle
  if (recent[recent.length - 1].close > recent[recent.length - 1].open &&
      recent[recent.length - 2].close < recent[recent.length - 2].open) return "transitioning";
  if (recent[recent.length - 1].close < recent[recent.length - 1].open &&
      recent[recent.length - 2].close > recent[recent.length - 2].open) return "transitioning";

  return allGreen ? "bullish" : allRed ? "bearish" : null;
}

export function computeIndicators(candles: Candle[]): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const rsiSeries = RSI.calculate({ period: 14, values: closes });
  const ema20Series = EMA.calculate({ period: 20, values: closes });
  const ema50Series = EMA.calculate({ period: 50, values: closes });
  const ema200Series = EMA.calculate({ period: 200, values: closes });
  const macdSeries = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const bbSeries = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const stochRsiSeries = StochasticRSI.calculate({
    values: closes,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3
  });
  const atrSeries = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

  const volumeAvg20 =
    volumes.length >= 20 ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;

  const lastMacd = last(macdSeries, 0);
  const prevMacd = last(macdSeries, 1);
  const lastBb = last(bbSeries, 0);
  const lastStoch = last(stochRsiSeries, 0);
  const prevStoch = last(stochRsiSeries, 1);

  return {
    rsi: last(rsiSeries, 0),
    rsiPrev: last(rsiSeries, 1),
    ema20: last(ema20Series, 0),
    ema50: last(ema50Series, 0),
    ema200: last(ema200Series, 0),
    ema20Prev: last(ema20Series, 1),
    ema50Prev: last(ema50Series, 1),
    macdHist: lastMacd?.histogram ?? null,
    macdHistPrev: prevMacd?.histogram ?? null,
    macdLine: lastMacd?.MACD ?? null,
    macdSignal: lastMacd?.signal ?? null,
    bbUpper: lastBb?.upper ?? null,
    bbLower: lastBb?.lower ?? null,
    bbMiddle: lastBb?.middle ?? null,
    stochRsiK: lastStoch?.k ?? null,
    stochRsiKPrev: prevStoch?.k ?? null,
    stochRsiD: lastStoch?.d ?? null,
    atr: last(atrSeries, 0),
    volume: volumes[volumes.length - 1] ?? 0,
    volumeAvg20,
    close: closes[closes.length - 1] ?? 0,
    haTrend: computeHaTrend(candles)
  };
}
