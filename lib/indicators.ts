// lib/indicators.ts
// Wraps the `technicalindicators` npm package for RSI, EMA, MACD, Bollinger
// Bands, Stoch RSI, ATR. Also computes Heikin-Ashi candle trend in-house
// (no extra dependency — just arithmetic on OHLC).
//
// v3.0 fix: HA guard corrected from < lookback+1 to < lookback+2

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
 * Converts raw OHLC to HA candles, then evaluates the last `lookback` candles:
 *   "bullish"       — last 3 HA candles all green, no lower wicks (strong momentum up)
 *   "bearish"       — last 3 HA candles all red, no upper wicks (strong momentum down)
 *   "transitioning" — colour flip on the most recent candle (potential reversal)
 *   null            — mixed / unclear
 *
 * Requires candles.length >= lookback + 2:
 *   +1 for the HA seed candle (index 0 of the slice)
 *   +1 because we start building from index 1
 */
function computeHaTrend(candles: Candle[], lookback = 3): HaTrend {
  // Need (lookback + 1) HA candles; building HA from a slice of (lookback + 2) raw candles
  // (first raw candle is used as seed only, produces no HA output)
  if (candles.length < lookback + 2) return null;

  const slice = candles.slice(-(lookback + 2));

  interface HaCandle {
    open: number;
    close: number;
    high: number;
    low: number;
  }

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

  // Take only the last `lookback` HA candles for the signal
  const recent = ha.slice(-lookback);

  const allGreen = recent.every((c) => c.close > c.open);
  const allRed   = recent.every((c) => c.close < c.open);

  // "No lower wick" means the candle body extends to the low (pure momentum)
  const noLowerWick = recent.every(
    (c) => Math.min(c.open, c.close) - c.low < 1e-10 * Math.abs(c.close)
  );
  const noUpperWick = recent.every(
    (c) => c.high - Math.max(c.open, c.close) < 1e-10 * Math.abs(c.close)
  );

  if (allGreen && noLowerWick) return "bullish";
  if (allRed   && noUpperWick) return "bearish";

  // Colour flip on the most recent candle relative to the one before it
  const cur  = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  if (cur && prev) {
    const curGreen  = cur.close  > cur.open;
    const prevGreen = prev.close > prev.open;
    if (curGreen !== prevGreen) return "transitioning";
  }

  return allGreen ? "bullish" : allRed ? "bearish" : null;
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
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const bbSeries       = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
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

  const lastMacd  = last(macdSeries, 0);
  const prevMacd  = last(macdSeries, 1);
  const lastBb    = last(bbSeries, 0);
  const lastStoch = last(stochRsiSeries, 0);
  const prevStoch = last(stochRsiSeries, 1);

  return {
    rsi:          last(rsiSeries, 0),
    rsiPrev:      last(rsiSeries, 1),
    ema20:        last(ema20Series, 0),
    ema50:        last(ema50Series, 0),
    ema200:       last(ema200Series, 0),
    ema20Prev:    last(ema20Series, 1),
    ema50Prev:    last(ema50Series, 1),
    macdHist:     lastMacd?.histogram ?? null,
    macdHistPrev: prevMacd?.histogram ?? null,
    macdLine:     lastMacd?.MACD      ?? null,
    macdSignal:   lastMacd?.signal    ?? null,
    bbUpper:      lastBb?.upper  ?? null,
    bbLower:      lastBb?.lower  ?? null,
    bbMiddle:     lastBb?.middle ?? null,
    stochRsiK:     lastStoch?.k ?? null,
    stochRsiKPrev: prevStoch?.k ?? null,
    stochRsiD:     lastStoch?.d ?? null,
    atr:      last(atrSeries, 0),
    volume:   volumes[volumes.length - 1] ?? 0,
    volumeAvg20,
    close:    closes[closes.length - 1] ?? 0,
    haTrend:  computeHaTrend(candles)
  };
}
