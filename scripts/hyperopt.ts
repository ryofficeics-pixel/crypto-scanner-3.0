/**
 * Hyperopt — parameter tuning for Crypto Scanner v3.2 (regime-aware)
 *
 * Tests combinations of TP/SL multipliers, min-move filters, and signal
 * thresholds against historical data. Reports best-performing params.
 *
 * Usage: npx tsx scripts/hyperopt.ts
 *   Runs ~72 combos (TP × SL × minMove). Add --all for full grid (~288).
 *
 * Inspired by Freqtrade's hyperopt: walk-forward validation over 2 years,
 * scoring each param set by Sharpe-like ratio (avg return / std dev).
 */
import { getKlines, KLINES_LIMIT, Ticker24hr } from "@/lib/binance";
import { scanSymbol } from "@/lib/scoring";
import type { Candle } from "@/lib/binance";

// ── Config ──────────────────────────────────────────────────────────────────────
const BACKTEST_DAYS = 180; // shorter than full backtest — hyperopt is iterative
const TOP_N = 20;
const SCAN_STEP_H = 24; // daily scans
const MAX_CANDIDATES = 15;
const HOLD_CANDLES = 336;
const MIN_CANDLE_COUNT = 500;

// ── Parameter search space ──────────────────────────────────────────────────────
const TP_MULTIPLIERS = [4, 5, 6, 7, 8];
const SL_MULTIPLIERS = [1.5, 2.0, 2.5, 3.0];
const MIN_MOVE_PCTS = [10, 15, 20, 25];
const MIN_MOVER_VOLUMES = [100_000, 200_000, 300_000, 500_000];

interface ParamSet {
  tpMul: number;
  slMul: number;
  minMovePct: number;
  minMoverVolume: number;
}

interface HyperoptResult {
  params: ParamSet;
  score: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  totalSignals: number;
  sharpe: number;
}

// ── Data ──────────────────────────────────────────────────────────────────────────
const h1Store = new Map<string, Candle[]>();
const h4Store = new Map<string, Candle[]>();

function build4hFrom1h(h1: Candle[]): Candle[] {
  const h4: Candle[] = [];
  for (let i = 0; i + 3 < h1.length; i += 4) {
    const slice = h1.slice(i, i + 4);
    h4.push({
      openTime: slice[0].openTime,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[3].close,
      volume: slice.reduce((s, c) => s + c.volume, 0),
      closeTime: slice[3].closeTime,
    });
  }
  return h4;
}

async function fetchAllKlines(symbol: string, since: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let startTime = since;
  const endTime = Date.now();
  const limit = 1000;
  let attempts = 0;
  while (startTime < endTime && attempts < 50) {
    attempts++;
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${startTime}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    const raw: unknown[][] = await res.json();
    if (raw.length === 0) break;
    for (const k of raw) {
      all.push({
        openTime: k[0] as number,
        open: parseFloat(k[1] as string),
        high: parseFloat(k[2] as string),
        low: parseFloat(k[3] as string),
        close: parseFloat(k[4] as string),
        volume: parseFloat(k[5] as string),
        closeTime: k[6] as number,
      });
    }
    startTime = (raw[raw.length - 1][0] as number) + 1;
    if (raw.length === limit) await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

function computeQuoteVolume(h1: Candle[]): number {
  return h1.slice(-24).reduce((s, c) => s + (c.close * c.volume), 0);
}

// ── Run a single param set ──────────────────────────────────────────────────────
async function runBacktest(params: ParamSet): Promise<HyperoptResult> {
  const { tpMul, slMul, minMovePct, minMoverVolume } = params;
  const now = Date.now();
  const since = now - BACKTEST_DAYS * 86_400_000;
  const stepMs = SCAN_STEP_H * 3_600_000;
  const firstStep = Math.ceil(since / stepMs) * stepMs;
  const lastStep = Math.floor(now / stepMs) * stepMs;
  const totalSteps = Math.floor((lastStep - firstStep) / stepMs);

  const symbols = Array.from(h1Store.keys());
  const allPnlPcts: number[] = [];
  const allSignals: { result: "win" | "loss" | "open"; pnlPct: number }[] = [];

  for (let s = 0; s < totalSteps; s++) {
    const stepTime = firstStep + s * stepMs;
    const candidates: { symbol: string; pct24h: number; vol24h: number; h1: Candle[]; h4: Candle[]; endIdx: number }[] = [];

    for (const sym of symbols) {
      const h1All = h1Store.get(sym)!;
      const h4All = h4Store.get(sym)!;
      let endIdx = h1All.length - 1;
      while (endIdx >= 0 && h1All[endIdx].closeTime > stepTime) endIdx--;
      if (endIdx < 24) continue;
      const h1Slice = h1All.slice(0, endIdx + 1);
      let h4End = h4All.length - 1;
      while (h4End >= 0 && h4All[h4End].closeTime > stepTime) h4End--;
      if (h4End < 0) continue;
      const h4Slice = h4All.slice(0, h4End + 1);
      const nowC = h1Slice[h1Slice.length - 1].close;
      const then = h1Slice[h1Slice.length - 25]?.close;
      if (!then || then <= 0) continue;
      const pct24h = ((nowC - then) / then) * 100;
      const vol24h = computeQuoteVolume(h1Slice);
      candidates.push({ symbol: sym, pct24h, vol24h, h1: h1Slice, h4: h4Slice, endIdx });
    }

    if (candidates.length === 0) continue;

    // Filter by min move and volume
    const filtered = candidates.filter((c) => Math.abs(c.pct24h) >= minMovePct && c.vol24h >= minMoverVolume);
    if (filtered.length === 0) continue;

    const volLeaders = [...filtered].sort((a, b) => b.vol24h - a.vol24h).slice(0, 10);
    const movers = filtered.sort((a, b) => Math.abs(b.pct24h) - Math.abs(a.pct24h)).slice(0, MAX_CANDIDATES - 5);
    const merged = new Map<string, typeof candidates[0]>();
    for (const c of movers) merged.set(c.symbol, c);
    for (const c of volLeaders) merged.set(c.symbol, c);
    const selected = Array.from(merged.values()).slice(0, MAX_CANDIDATES);

    for (const c of selected) {
      try {
        const m15Slice = c.h1.slice(-250);
        const result = scanSymbol(c.symbol, { m15: m15Slice, h1: c.h1, h4: c.h4 }, {
          priceChangePercent: c.pct24h,
          quoteVolume: c.vol24h,
        }, false);
        if (!result || result.tier === "NONE") continue;

        // Custom TP/SL for this param set
        const atr = result.atr ?? result.price * 0.02;
        const entry = result.entry;
        const stopLoss = entry - slMul * atr;
        const takeProfit1 = entry + tpMul * atr;
        const risk = entry - stopLoss;
        const rr = risk > 0 ? (takeProfit1 - entry) / risk : 0;
        if (rr < 2) continue;

        // Check outcome in future candles
        const h1All = h1Store.get(c.symbol)!;
        const startIdx = c.endIdx;
        let outcome: "win" | "loss" | "open" = "open";
        let pnlPct = 0;
        for (let i = startIdx + 1; i < Math.min(startIdx + HOLD_CANDLES, h1All.length); i++) {
          const candle = h1All[i];
          if (candle.low <= stopLoss) {
            outcome = "loss";
            pnlPct = ((stopLoss - entry) / entry) * 100;
            break;
          }
          if (candle.high >= takeProfit1) {
            outcome = "win";
            pnlPct = ((takeProfit1 - entry) / entry) * 100;
            break;
          }
        }
        if (outcome === "open") {
          const lastIdx = Math.min(startIdx + HOLD_CANDLES - 1, h1All.length - 1);
          pnlPct = ((h1All[lastIdx].close - entry) / entry) * 100;
        }
        allPnlPcts.push(pnlPct);
        allSignals.push({ result: outcome, pnlPct });
      } catch { /* skip */ }
    }
  }

  const total = allSignals.length;
  if (total === 0) return { params, score: -999, winRate: 0, avgWin: 0, avgLoss: 0, totalSignals: 0, sharpe: 0 };

  const wins = allSignals.filter((s) => s.result === "win").length;
  const losses = allSignals.filter((s) => s.result === "loss").length;
  const winRate = total > 0 ? wins / (wins + losses) * 100 : 0;
  const avgWin = wins > 0 ? allSignals.filter((s) => s.result === "win").reduce((a, b) => a + b.pnlPct, 0) / wins : 0;
  const avgLoss = losses > 0 ? allSignals.filter((s) => s.result === "loss").reduce((a, b) => a + b.pnlPct, 0) / losses : 0;

  // Sharpe-like score: (mean return / std dev of returns) * sqrt(trades)
  const meanReturn = allPnlPcts.reduce((a, b) => a + b, 0) / allPnlPcts.length;
  const stdDev = Math.sqrt(allPnlPcts.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / allPnlPcts.length);
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(total) : 0;

  // Composite score: prefer higher Sharpe, but penalize very low signal counts
  const score = sharpe * Math.min(total / 10, 1);

  return { params, score, winRate, avgWin, avgLoss, totalSignals: total, sharpe };
}

// ── Main ──────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(70));
  console.log("  Crypto Scanner v3.2 — Hyperopt (regime-aware)");
  console.log("═".repeat(70));
  console.log();
  console.log("  Search space:");
  console.log(`    TP multipliers:  ${TP_MULTIPLIERS.map((v) => `${v}×ATR`).join(", ")}`);
  console.log(`    SL multipliers:  ${SL_MULTIPLIERS.map((v) => `${v}×ATR`).join(", ")}`);
  console.log(`    Min move %:      ${MIN_MOVE_PCTS.join(", ")}`);
  console.log(`    Min mover vol:   ${MIN_MOVER_VOLUMES.map((v) => `$${(v / 1000).toFixed(0)}k`).join(", ")}`);

  // Step 1 — download data
  console.log("\n[1/3] Fetching top USDT pairs…");
  const tickerRes = await fetch("https://data-api.binance.vision/api/v3/ticker/24hr");
  const tickerAll: Record<string, unknown>[] = await tickerRes.json();
  const usdtPairs: Ticker24hr[] = tickerAll
    .filter((t) => typeof t.symbol === "string" && (t.symbol as string).endsWith("USDT"))
    .filter((t) => !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol as string))
    .map((t) => ({
      symbol: t.symbol as string,
      lastPrice: parseFloat(t.lastPrice as string),
      priceChangePercent: parseFloat(t.priceChangePercent as string),
      quoteVolume: parseFloat(t.quoteVolume as string),
    }))
    .filter((t) => Number.isFinite(t.lastPrice) && t.quoteVolume > 0);
  usdtPairs.sort((a, b) => b.quoteVolume - a.quoteVolume);
  const topSymbols = usdtPairs.slice(0, TOP_N).map((t) => t.symbol);
  console.log(`  Selected ${topSymbols.length} symbols`);

  console.log("\n[2/3] Downloading 6 months of 1h klines…");
  const since = Date.now() - BACKTEST_DAYS * 86_400_000;
  let downloaded = 0;
  let errors = 0;
  const fetchQueue = topSymbols.map(async (sym) => {
    try {
      const candles = await fetchAllKlines(sym, since);
      if (candles.length >= MIN_CANDLE_COUNT) {
        h1Store.set(sym, candles);
        h4Store.set(sym, build4hFrom1h(candles));
        downloaded++;
      } else { errors++; }
    } catch { errors++; }
    if ((downloaded + errors) % 5 === 0) process.stdout.write(".");
  });
  await Promise.allSettled(fetchQueue);
  console.log(`\n  ${downloaded} OK, ${errors} failed`);

  const symbols = Array.from(h1Store.keys());
  if (symbols.length === 0) { console.error("No data — aborting"); process.exit(1); }

  // Step 3 — test combos
  console.log("\n[3/3] Running hyperopt…");
  const combos: ParamSet[] = [];
  for (const tpMul of TP_MULTIPLIERS) {
    for (const slMul of SL_MULTIPLIERS) {
      for (const minMovePct of MIN_MOVE_PCTS) {
        for (const minMoverVolume of MIN_MOVER_VOLUMES) {
          combos.push({ tpMul, slMul, minMovePct, minMoverVolume });
        }
      }
    }
  }

  const results: HyperoptResult[] = [];
  let done = 0;
  const totalCombos = combos.length;
  const startTime = Date.now();

  // Run in batches of 4 to avoid overwhelming Binance
  for (let i = 0; i < combos.length; i += 4) {
    const batch = combos.slice(i, i + 4);
    const batchResults = await Promise.allSettled(batch.map(runBacktest));
    for (const r of batchResults) {
      if (r.status === "fulfilled") results.push(r.value);
    }
    done += batch.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const pct = (done / totalCombos * 100).toFixed(0);
    const eta = done > 0 ? ((Date.now() - startTime) / done * (totalCombos - done) / 1000).toFixed(0) : "?";
    process.stdout.write(`\r  ${pct}% (${done}/${totalCombos}) — ${elapsed}s elapsed, ~${eta}s remaining`);
  }

  console.log("\n");

  // ── Report ──────────────────────────────────────────────────────────────────
  results.sort((a, b) => b.score - a.score);
  console.log("\n" + "═".repeat(70));
  console.log("  TOP 10 PARAMETER SETS (by Sharpe-like score)");
  console.log("═".repeat(70));
  console.log("  #  TP  SL  Min%  MinVol  Sharpe  WR%    AvgW  AvgL    Signals  Score");
  console.log("  " + "─".repeat(66));
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    console.log(
      `  ${String(i + 1).padStart(2, " ")}  ${String(r.params.tpMul).padStart(2, " ")}×` +
      `  ${r.params.slMul.toFixed(1)}×  ${String(r.params.minMovePct).padStart(2, " ")}%` +
      `  $${(r.params.minMoverVolume / 1000).toFixed(0)}k` +
      `  ${r.sharpe.toFixed(2)}  ${r.winRate.toFixed(1)}%` +
      `  ${r.avgWin.toFixed(1)}%  ${r.avgLoss.toFixed(1)}%` +
      `  ${String(r.totalSignals).padStart(4, " ")}  ${r.score.toFixed(2)}`
    );
  }

  const best = results[0];
  if (best) {
    console.log("\n  BEST PARAMETER SET:");
    console.log(`    TP multiplier:  ${best.params.tpMul}× ATR  (currently 6×)`);
    console.log(`    SL multiplier:  ${best.params.slMul}× ATR  (currently 2×)`);
    console.log(`    Min move %:     ${best.params.minMovePct}%     (currently 15%)`);
    console.log(`    Min mover vol:  $${(best.params.minMoverVolume / 1000).toFixed(0)}k  (currently $300k)`);
    console.log(`    Win rate:       ${best.winRate.toFixed(1)}%`);
    console.log(`    Avg win/loss:   ${best.avgWin.toFixed(1)}% / ${best.avgLoss.toFixed(1)}%`);
    console.log(`    Sharpe:         ${best.sharpe.toFixed(3)}`);
    console.log(`    Score:          ${best.score.toFixed(3)}`);
  }

  const defaultResult = results.find(
    (r) => r.params.tpMul === 6 && r.params.slMul === 2 && r.params.minMovePct === 15 && r.params.minMoverVolume === 300_000
  );
  if (defaultResult && best && defaultResult !== best) {
    console.log("\n  COMPARISON vs CURRENT DEFAULTS:");
    console.log(`    Current: Sharpe ${defaultResult.sharpe.toFixed(3)}, WR ${defaultResult.winRate.toFixed(1)}%, Score ${defaultResult.score.toFixed(3)}`);
    console.log(`    Best:    Sharpe ${best.sharpe.toFixed(3)}, WR ${best.winRate.toFixed(1)}%, Score ${best.score.toFixed(3)}`);
    console.log(`    Improvement: ${((best.score - defaultResult.score) / Math.abs(defaultResult.score || 1) * 100).toFixed(1)}% better`);
  }

  console.log("\n" + "═".repeat(70));
  console.log("  Hyperopt complete.");
  console.log("═".repeat(70));
}

main().catch((e) => { console.error("Fatal error:", e); process.exit(1); });
