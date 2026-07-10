/**
 * 2-year backtest for Crypto Scanner v3.2
 *
 * Fetches historical 1h/4h klines for top USDT pairs, walks forward
 * in 6h steps, runs the scanner at each step (using the EXACT same
 * scoring engine from lib/scoring.ts), then tracks whether each
 * signal's TP or SL was hit within 14 days.
 *
 * Usage: npx tsx scripts/backtest.ts
 */
import { getKlines, KLINES_LIMIT, Ticker24hr } from "@/lib/binance";
import { scanSymbol } from "@/lib/scoring";
import { computeIndicators } from "@/lib/indicators";
import type { Candle } from "@/lib/binance";

// ── Config ──────────────────────────────────────────────────────────────────────
const BACKTEST_DAYS = 730;
const TOP_N = 30; // number of symbols by current volume
const SCAN_STEP_H = 12; // hours between scans (2/day = ~1460 steps over 2y)
const MAX_CANDIDATES = 20;
const TIGHT_MODE = false; // no longer used - using fixed % TP/SL (TP1=+15%, TP2=+20%, SL=-10%)
const HOLD_CANDLES = 336; // 14 days in 1h candles (336 = 14 × 24)
const MIN_CANDLE_COUNT = 500; // skip symbols with too little history

interface ExtendedCandle extends Candle {
  closeTime: number;
}

interface BacktestSignal {
  stepIdx: number;
  timestamp: number;
  symbol: string;
  tier: string;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  priceChangePercent: number;
  signalCount: number;
  strongCount: number;
  reason: string;
  /** Index within h1AllSymbols[symbol] where entry was triggered */
  entryCandleIdx: number;
  exitCandleIdx: number | null;
  exitPrice: number | null;
  result: "win" | "loss" | "open" | null;
  pnlPct: number | null;
  barsHeld: number | null;
}

// ── Data types for the walk-forward store ────────────────────────────────────────

/** Per-symbol: all 1h candles for the full 2y window */
const h1Store = new Map<string, Candle[]>();
/** Per-symbol: all 4h candles (computed from 1h by grouping) */
const h4Store = new Map<string, Candle[]>();

// ── Helpers ──────────────────────────────────────────────────────────────────────

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

/** Fetch ALL 1h klines for a symbol from `since` to now, paginating 1000 at a time */
async function fetchAllKlines(
  symbol: string,
  since: number
): Promise<Candle[]> {
  const all: Candle[] = [];
  let startTime = since;
  const endTime = Date.now();
  const limit = 1000;
  let attempts = 0;
  while (startTime < endTime && attempts < 50) {
    attempts++;
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${startTime}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`  [${symbol}] HTTP ${res.status} — retrying after delay`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
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
    startTime = (raw[raw.length - 1][0] as number) + 1; // next after last openTime
    // Small delay between paginations out of courtesy
    if (raw.length === limit) await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

/** Compute 24h quote volume from the last 24 candles of h1 data */
function computeQuoteVolume(h1: Candle[]): number {
  const recent24 = h1.slice(-24);
  return recent24.reduce((s, c) => s + (c.close * c.volume), 0);
}

// ── Main ─────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(60));
  console.log(`  Crypto Scanner v3.2 — 2-Year Backtest (regime-aware)`);
  console.log(`  Period: ${BACKTEST_DAYS} days, step ${SCAN_STEP_H}h, top ${TOP_N} symbols`);
  console.log(`  TP1=6.0×ATR  TP2=10.0×ATR  SL=2.0×ATR`);
  console.log("═".repeat(60));
  console.log();

  // Step 1 — Get top symbols by current volume
  console.log("[1/4] Fetching top USDT pairs…");
  const tickerRes = await fetch(
    "https://data-api.binance.vision/api/v3/ticker/24hr"
  );
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

  // Step 2 — Download 2 years of 1h klines for each symbol
  console.log("\n[2/4] Downloading historical klines (2 years, 1h candles)…");
  const since = Date.now() - BACKTEST_DAYS * 86_400_000;
  let downloaded = 0;
  let errors = 0;

  const fetchQueue = topSymbols.map(async (sym) => {
    try {
      const candles = await fetchAllKlines(sym, since);
      if (candles.length >= MIN_CANDLE_COUNT) {
        h1Store.set(sym, candles);
        const h4 = build4hFrom1h(candles);
        h4Store.set(sym, h4);
        downloaded++;
      } else {
        console.warn(`  [${sym}] too few candles (${candles.length}), skipping`);
        errors++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  [${sym}] failed: ${msg}`);
      errors++;
    }
    // Show progress every 10 symbols
    if ((downloaded + errors) % 10 === 0) {
      console.log(`  ... ${downloaded} OK, ${errors} failed`);
    }
  });

  await Promise.allSettled(fetchQueue);
  console.log(`  Done: ${downloaded} symbols, ${errors} failed`);

  const symbols = Array.from(h1Store.keys());
  if (symbols.length === 0) {
    console.error("No symbols with enough data — aborting");
    process.exit(1);
  }

  // Determine the widest time range across ALL symbols (not intersection).
  // Each symbol is evaluated at each step only if it has data up to that point.
  let earliestStart = Infinity;
  let latestEnd = 0;
  for (const sym of symbols) {
    const c = h1Store.get(sym)!;
    earliestStart = Math.min(earliestStart, c[0].openTime);
    latestEnd = Math.max(latestEnd, c[c.length - 1].openTime);
  }
  // Align to step boundaries
  const stepMs = SCAN_STEP_H * 3_600_000;
  const firstStep = Math.floor(earliestStart / stepMs) * stepMs + stepMs;
  const lastStep = Math.floor(latestEnd / stepMs) * stepMs;
  const totalSteps = Math.floor((lastStep - firstStep) / stepMs);
  console.log(
    `\n  Window: ${new Date(earliestStart).toISOString().slice(0, 10)} → ${new Date(latestEnd).toISOString().slice(0, 10)}`
  );
  console.log(`  Steps: ${totalSteps} (every ${SCAN_STEP_H}h)`);

  // Give user a chance to see the counts before the long loop
  console.log("\n[3/4] Running walk-forward backtest…");

  const allSignals: BacktestSignal[] = [];
  let stepCount = 0;
  let lastReportPct = -1;

  for (let s = 0; s < totalSteps; s++) {
    const stepTime = firstStep + s * stepMs;
    stepCount++;

    // Progress: report every 5%
    const pct = Math.floor((s / totalSteps) * 100);
    if (pct >= lastReportPct + 5) {
      lastReportPct = pct;
      console.log(`  ${pct}% (step ${s}/${totalSteps}, ${allSignals.length} signals so far)`);
    }

    // For each symbol, slice data up to stepTime (last candle whose closeTime <= stepTime)
    const candidates: { symbol: string; priceChangePercent: number; quoteVolume: number; h1: Candle[]; h4: Candle[]; endIdx: number }[] = [];

    for (const sym of symbols) {
      const h1All = h1Store.get(sym)!;
      const h4All = h4Store.get(sym)!;

      // Find the slice end index: last candle whose closeTime <= stepTime
      let endIdx = h1All.length - 1;
      while (endIdx >= 0 && h1All[endIdx].closeTime > stepTime) endIdx--;
      if (endIdx < 24) continue; // not enough history at this point

      const h1Slice = h1All.slice(0, endIdx + 1);
      // For 4h, find the matching slice
      let h4End = h4All.length - 1;
      while (h4End >= 0 && h4All[h4End].closeTime > stepTime) h4End--;
      if (h4End < 0) continue;
      const h4Slice = h4All.slice(0, h4End + 1);

      // 24h price change: close vs close 24 candles ago
      const now = h1Slice[h1Slice.length - 1].close;
      const then = h1Slice[h1Slice.length - 25]?.close;
      if (!then || then <= 0) continue;
      const pct24h = ((now - then) / then) * 100;

      // 24h quote volume
      const vol24h = computeQuoteVolume(h1Slice);

      candidates.push({
        symbol: sym,
        priceChangePercent: pct24h,
        quoteVolume: vol24h,
        h1: h1Slice,
        h4: h4Slice,
        endIdx,
      });
    }

    if (candidates.length === 0) continue;

    // Debug: show first 10 steps
    if (s < 10) {
      console.log(`  [debug step ${s}] ${candidates.length} candidates, first=${candidates[0]?.symbol} 24h=${candidates[0]?.priceChangePercent.toFixed(1)}%`);
    }

    // Select candidates: blend of momentum, extreme, big movers, and volume
    // Same priority logic as lib/binance.ts getScanCandidates()
    const momentumMinPct = 8;
    const momentumMinVol = 50_000;
    const extremePct = 50;
    const extremeMinVol = 20_000;
    const bigMovePct = 15;
    const bigMoveMinVol = 300_000;

    const momentumMovers = candidates
      .filter((c) => Math.abs(c.priceChangePercent) >= momentumMinPct && c.quoteVolume >= momentumMinVol)
      .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
      .slice(0, 15);
    const extremeMovers = candidates
      .filter((c) => Math.abs(c.priceChangePercent) >= extremePct && c.quoteVolume >= extremeMinVol)
      .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
      .slice(0, 10);
    const bigMovers = candidates
      .filter((c) => Math.abs(c.priceChangePercent) >= bigMovePct && c.quoteVolume >= bigMoveMinVol)
      .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
      .slice(0, 15);
    const volLeaders = [...candidates]
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 10);

    const merged = new Map<string, typeof candidates[0]>();
    for (const c of momentumMovers) merged.set(c.symbol, c);
    for (const c of extremeMovers) merged.set(c.symbol, c);
    for (const c of bigMovers) merged.set(c.symbol, c);
    for (const c of volLeaders) merged.set(c.symbol, c);

    const selected = Array.from(merged.values()).slice(0, MAX_CANDIDATES);

    if (s < 10) {
      console.log(`  [debug step ${s}] merged=${merged.size} selected=${selected.length} first=${selected[0]?.symbol}`);
    }

    // Score each candidate
    for (const c of selected) {
      // Pass 1h data as 15m proxy (scanSymbol requires all 3 arrays non-empty).
      // Volume-spike sensitivity differs but tier scoring is 1h/4h-dominated.
      const m15Slice = c.h1.slice(-250);

      const meta = {
        priceChangePercent: c.priceChangePercent,
        quoteVolume: c.quoteVolume,
      };

      // Verify data sizes before scoring
      if (s < 5 && c.symbol === selected[0]?.symbol) {
        console.log(`  [debug ${c.symbol}] h1=${c.h1.length} h4=${c.h4.length} m15=${m15Slice.length}`);
      }

      try {
        const result = scanSymbol(c.symbol, { m15: m15Slice, h1: c.h1, h4: c.h4 }, meta, TIGHT_MODE);
        if (!result) {
          if (s < 5) console.log(`  [debug ${c.symbol}] scanSymbol returned null`);
          continue;
        }
        if (result.tier === "NONE") continue;

        allSignals.push({
          stepIdx: s,
          timestamp: stepTime,
          symbol: result.symbol,
          tier: result.tier,
          entry: result.entry,
          stopLoss: result.stopLoss,
          takeProfit1: result.takeProfit1,
          takeProfit2: result.takeProfit2,
          priceChangePercent: result.priceChangePercent,
          signalCount: result.signalCount,
          strongCount: result.flags.filter((f) => f.strong).length,
          reason: result.reason,
          entryCandleIdx: c.endIdx,
          exitCandleIdx: null,
          exitPrice: null,
          result: null,
          pnlPct: null,
          barsHeld: null,
        });
      } catch {
        // skip errors silently
      }
    }
  } // end step loop

  console.log(`\n  Total signals generated: ${allSignals.length}`);

  // Step 4 — Check outcomes: for each signal, look ahead up to HOLD_CANDLES
  // to see if TP1 or SL was hit
  console.log("\n[4/4] Checking signal outcomes (TP/SL hits within 14 days)…");

  let checked = 0;
  for (const sig of allSignals) {
    checked++;
    if (checked % 1000 === 0) {
      console.log(`  ... checked ${checked}/${allSignals.length}`);
    }

    const h1All = h1Store.get(sig.symbol);
    if (!h1All) continue;

    // Look ahead from entryCandleIdx
    const startIdx = sig.entryCandleIdx;
    for (let i = startIdx + 1; i < Math.min(startIdx + HOLD_CANDLES, h1All.length); i++) {
      const c = h1All[i];
      // Check SL hit (low <= stopLoss)
      if (c.low <= sig.stopLoss) {
        sig.exitCandleIdx = i;
        sig.exitPrice = sig.stopLoss;
        sig.result = "loss";
        sig.pnlPct = ((sig.stopLoss - sig.entry) / sig.entry) * 100;
        sig.barsHeld = i - startIdx;
        break;
      }
      // Check TP1 hit (high >= takeProfit1) — partial exit target
      if (c.high >= sig.takeProfit1) {
        sig.exitCandleIdx = i;
        sig.exitPrice = sig.takeProfit1;
        sig.result = "win";
        sig.pnlPct = ((sig.takeProfit1 - sig.entry) / sig.entry) * 100;
        sig.barsHeld = i - startIdx;
        break;
      }
    }

    // If never hit, mark as open
    if (sig.result === null) {
      const lastIdx = Math.min(startIdx + HOLD_CANDLES - 1, h1All.length - 1);
      sig.exitCandleIdx = lastIdx;
      sig.exitPrice = h1All[lastIdx].close;
      sig.result = "open";
      sig.pnlPct = ((sig.exitPrice - sig.entry) / sig.entry) * 100;
      sig.barsHeld = lastIdx - startIdx;
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("  BACKTEST RESULTS — v3.2");
  console.log("═".repeat(60));

  const total = allSignals.length;
  const closedSignals = allSignals.filter((s) => s.result !== "open");
  const wins   = closedSignals.filter((s) => s.result === "win").length;
  const losses = closedSignals.filter((s) => s.result === "loss").length;
  const open   = total - closedSignals.length;
  const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;

  const avgWin  = wins  > 0 ? closedSignals.filter((s) => s.result === "win").reduce((a, b) => a + (b.pnlPct ?? 0), 0) / wins  : 0;
  const avgLoss = losses > 0 ? closedSignals.filter((s) => s.result === "loss").reduce((a, b) => a + (b.pnlPct ?? 0), 0) / losses : 0;

  // Gross profit / loss for Profit Factor
  const grossProfit  = closedSignals.filter((s) => s.result === "win").reduce((a, b) => a + (b.pnlPct ?? 0), 0);
  const grossLoss    = Math.abs(closedSignals.filter((s) => s.result === "loss").reduce((a, b) => a + (b.pnlPct ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Expected value (mean PnL% across all closed trades)
  const allPnlPcts = closedSignals.map((s) => s.pnlPct!);
  const avgTrade   = allPnlPcts.length > 0 ? allPnlPcts.reduce((a, b) => a + b, 0) / allPnlPcts.length : 0;

  // Simulate equity curve with 2% risk per trade
  let equity = 10_000;
  const equityCurve: number[] = [equity];
  let maxEquity = equity;
  let maxDrawdownPct = 0;
  let totalPnl = 0;
  let trades = 0;
  const allEquityReturns: number[] = [];

  for (const sig of allSignals) {
    if (sig.result === "open") continue;
    trades++;
    const riskAmt = equity * 0.02;
    const riskPct = (sig.entry - sig.stopLoss) / sig.entry;
    const actualPnl = sig.pnlPct!;
    const positionSize = riskPct > 0 ? riskAmt / (riskPct * sig.entry) : 0;
    const tradePnl = positionSize * actualPnl * sig.entry / 100;
    const prevEquity = equity;
    equity += tradePnl;
    totalPnl += tradePnl;
    allEquityReturns.push((equity - prevEquity) / prevEquity);
    equityCurve.push(equity);
    maxEquity = Math.max(maxEquity, equity);
    const dd = ((maxEquity - equity) / maxEquity) * 100;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);
  }

  // Sharpe Ratio (annualized, using equity returns)
  const meanReturn = allEquityReturns.length > 0
    ? allEquityReturns.reduce((a, b) => a + b, 0) / allEquityReturns.length
    : 0;
  const returnVariance = allEquityReturns.length > 1
    ? allEquityReturns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / (allEquityReturns.length - 1)
    : 0;
  const returnStd = Math.sqrt(returnVariance);
  const sharpe = returnStd > 0 ? (meanReturn / returnStd) * Math.sqrt(365) : 0;

  // Recovery Factor
  const totalReturnPct = equity / 10000 - 1;
  const recoveryFactor = maxDrawdownPct > 0 ? totalReturnPct / (maxDrawdownPct / 100) : totalReturnPct > 0 ? Infinity : 0;

  const avgBars = allSignals.filter((s) => s.barsHeld !== null).reduce((a, b) => a + (b.barsHeld ?? 0), 0) / Math.max(1, total);

  // Exposure time estimate: total bars held / total possible bars
  const totalBarsHeld = allSignals.filter((s) => s.barsHeld !== null).reduce((a, b) => a + (b.barsHeld ?? 0), 0);
  const totalPossibleBars = totalSteps * HOLD_CANDLES; // rough upper bound
  const exposurePct = totalPossibleBars > 0 ? Math.min(100, (totalBarsHeld / totalPossibleBars) * 100) : 0;

  console.log(`\n  Overall`);
  console.log(`  ───────`);
  console.log(`  Total signals:    ${total}`);
  console.log(`  Closed trades:    ${wins + losses}  (${wins}W / ${losses}L)  Open: ${open}`);
  console.log(`  Win rate:         ${winRate.toFixed(1)}%`);
  console.log(`  Avg win:          ${avgWin.toFixed(2)}%  Avg loss: ${avgLoss.toFixed(2)}%`);
  console.log(`  Avg trade:        ${avgTrade >= 0 ? "+" : ""}${avgTrade.toFixed(2)}%`);
  console.log(`  Avg hold time:    ${avgBars.toFixed(0)}h (${(avgBars / 24).toFixed(1)}d)`);
  console.log(`  Profit Factor:    ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`);
  console.log(`  Sharpe Ratio:     ${sharpe.toFixed(2)}`);
  console.log(`  Recovery Factor:  ${recoveryFactor === Infinity ? "∞" : recoveryFactor.toFixed(2)}`);
  console.log(`  Max DD:           ${maxDrawdownPct.toFixed(1)}%`);
  console.log(`  Exposure time:    ${exposurePct.toFixed(1)}%`);
  console.log(`  Final equity:     $${equity.toFixed(0)}`);
  console.log(`  Total return:     ${totalReturnPct >= 0 ? "+" : ""}${(totalReturnPct * 100).toFixed(1)}%`);

  // Per-tier breakdown
  const tiers = ["S", "A", "B"];
  console.log(`\n  Per-Tier Breakdown`);
  console.log(`  ─────────────────`);
  for (const t of tiers) {
    const subset = allSignals.filter((s) => s.tier === t);
    if (subset.length === 0) continue;
    const w = subset.filter((s) => s.result === "win").length;
    const l = subset.filter((s) => s.result === "loss").length;
    const o = subset.filter((s) => s.result === "open").length;
    const wr = (w + l) > 0 ? ((w / (w + l)) * 100).toFixed(1) : "N/A";
    const aw = subset.filter((s) => s.result === "win").reduce((a, b) => a + (b.pnlPct ?? 0), 0) / Math.max(1, w);
    const al = subset.filter((s) => s.result === "loss").reduce((a, b) => a + (b.pnlPct ?? 0), 0) / Math.max(1, l);
    const pf = al !== 0 && l > 0 ? (aw * w) / Math.abs(al * l) : 0;
    console.log(`  Tier ${t}: ${subset.length} sigs | ${w}W ${l}L ${o}O | WR ${wr}% | AvgW ${aw.toFixed(2)}% AvgL ${al.toFixed(2)}% | PF ${pf.toFixed(2)}`);
  }

  // Best / worst signals
  if (allSignals.length > 0) {
    const sorted = [...allSignals].filter((s) => s.pnlPct !== null).sort((a, b) => (b.pnlPct ?? 0) - (a.pnlPct ?? 0));
    console.log(`\n  Best 5 signals (by P&L%)`);
    for (let i = 0; i < Math.min(5, sorted.length); i++) {
      const s = sorted[i];
      console.log(`    ${i + 1}. ${s.symbol} ${s.tier} | ${s.pnlPct?.toFixed(1)}% | ${s.reason.slice(0, 80)}`);
    }
    console.log(`\n  Worst 5 signals (by P&L%)`);
    for (let i = 0; i < Math.min(5, sorted.length); i++) {
      const s = sorted[sorted.length - 1 - i];
      console.log(`    ${i + 1}. ${s.symbol} ${s.tier} | ${s.pnlPct?.toFixed(1)}% | ${s.reason.slice(0, 80)}`);
    }
  }

  // Monthly breakdown
  console.log(`\n  Monthly Performance (last 12 months with signals)`);
  const monthMap = new Map<string, { wins: number; losses: number; open: number; totalPnl: number }>();
  for (const sig of allSignals) {
    if (sig.result === "open") continue;
    const d = new Date(sig.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!monthMap.has(key)) monthMap.set(key, { wins: 0, losses: 0, open: 0, totalPnl: 0 });
    const m = monthMap.get(key)!;
    if (sig.result === "win") m.wins++;
    else if (sig.result === "loss") m.losses++;
    m.totalPnl += sig.pnlPct ?? 0;
  }
  const months = Array.from(monthMap.entries()).sort(([a], [b]) => a.localeCompare(b)).slice(-12);
  for (const [month, m] of months) {
    const tot = m.wins + m.losses;
    const wr = tot > 0 ? ((m.wins / tot) * 100).toFixed(0) : "-";
    console.log(`  ${month}: ${tot} trades, ${m.wins}W ${m.losses}L, WR ${wr}%, PnL ${m.totalPnl > 0 ? "+" : ""}${m.totalPnl.toFixed(1)}%`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Backtest complete. Next: npx tsx scripts/hyperopt.ts");
  console.log("═".repeat(60));
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
