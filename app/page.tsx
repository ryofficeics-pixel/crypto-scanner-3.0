"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { ScanResult, Tier, SignalFlag } from "@/lib/scoring";

interface ScanResponse {
  scannedAt: string;
  symbolCount: number;
  results: ScanResult[];
}

type FilterTier = "ALL" | "S" | "A" | "B";

const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

const TIER_LABEL: Record<Tier, string> = { S: "S", A: "A", B: "B", NONE: "—" };
const TIER_CSS: Record<Tier, string> = {
  S: "badge-s",
  A: "badge-a",
  B: "badge-b",
  NONE: "badge-none"
};
const TIER_GLOW: Record<Tier, string> = {
  S: "0 0 24px 4px rgba(255,215,0,0.18)",
  A: "0 0 20px 3px rgba(58,123,255,0.18)",
  B: "0 0 0 0 transparent",
  NONE: "none"
};

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1)    return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

function fmtAge(isoDate: string): { label: string; cls: string } {
  const secs = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (secs < 60)  return { label: `${secs}s ago`,           cls: "age-fresh" };
  if (secs < 180) return { label: `${Math.floor(secs/60)}m ago`, cls: "age-fresh" };
  if (secs < 300) return { label: `${Math.floor(secs/60)}m ago`, cls: "age-aging" };
  return { label: `${Math.floor(secs/60)}m ago`, cls: "age-stale" };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span
      className={`${TIER_CSS[tier]} font-bold text-xs px-2.5 py-0.5 rounded-pill`}
      style={{ letterSpacing: "0.06em" }}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}

function StructureBadge({ event }: { event: string }) {
  if (!event || event === "NONE") return null;
  const isChoCH = event.startsWith("CHOCH");
  const isBullish = event.endsWith("BULLISH");
  if (!isBullish) return null; // only surface bullish events in a long-bias scanner
  return (
    <span className={isChoCH ? "badge-choch" : "badge-bos"}>
      {isChoCH ? "CHoCH" : "BOS"}
    </span>
  );
}

function SignalChips({ flags }: { flags: SignalFlag[] }) {
  const strong = flags.filter((f) => f.strong);
  const weak   = flags.filter((f) => f.weak && !f.strong);
  if (strong.length === 0 && weak.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {strong.map((f) => (
        <span key={f.key} className="chip-strong text-[10px] px-2 py-0.5 rounded-sm font-medium">
          ✦ {f.label}
        </span>
      ))}
      {weak.map((f) => (
        <span key={f.key} className="chip-weak text-[10px] px-2 py-0.5 rounded-sm font-medium">
          ◈ {f.label}
        </span>
      ))}
    </div>
  );
}

function RRBar({ rr }: { rr: number }) {
  const pct   = Math.min((rr / 4) * 100, 100);
  const color = rr >= 3 ? "var(--bull)" : rr >= 2 ? "var(--accent)" : "var(--warn)";
  return (
    <div className="mt-1.5 h-1 rounded-pill overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
      <div
        className="h-full rounded-pill"
        style={{ width: `${pct}%`, background: color, transition: "width 0.5s ease-out" }}
      />
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="glass rounded-lg px-4 py-4" style={{ borderRadius: "var(--radius-md)" }}>
      <div className="flex items-center gap-3 mb-3">
        <div className="skeleton w-8 h-5" />
        <div className="skeleton w-20 h-4" />
        <div className="skeleton w-24 h-3 ml-auto" />
      </div>
      <div className="skeleton w-full h-3 mb-2" />
      <div className="skeleton w-3/4 h-3" />
    </div>
  );
}

function StatsBar({ data }: { data: ScanResponse }) {
  const tiers = data.results.filter((r) => r.tier !== "NONE");
  const s = tiers.filter((r) => r.tier === "S").length;
  const a = tiers.filter((r) => r.tier === "A").length;
  const b = tiers.filter((r) => r.tier === "B").length;

  return (
    <div
      className="mx-5 mb-3 px-4 py-2.5 glass rounded-lg flex items-center gap-4 text-[11px]"
      style={{ borderRadius: "var(--radius-md)" }}
    >
      <span style={{ color: "var(--text-tertiary)" }}>
        {data.symbolCount} scanned
      </span>
      <span className="mx-1" style={{ color: "var(--divider)" }}>|</span>
      {s > 0 && <span style={{ color: "var(--tier-s)" }}><b>{s}</b> S</span>}
      {a > 0 && <span style={{ color: "var(--tier-a)" }}><b>{a}</b> A</span>}
      {b > 0 && <span style={{ color: "var(--tier-b)" }}><b>{b}</b> B</span>}
      {s === 0 && a === 0 && b === 0 && (
        <span style={{ color: "var(--text-tertiary)" }}>No signals</span>
      )}
    </div>
  );
}

function FilterBar({ active, setActive }: { active: FilterTier; setActive: (t: FilterTier) => void }) {
  const tiers: FilterTier[] = ["ALL", "S", "A", "B"];
  return (
    <div className="flex gap-2 px-5 mb-3 overflow-x-auto">
      {tiers.map((t) => (
        <button
          key={t}
          onClick={() => setActive(t)}
          className="text-[12px] font-semibold px-3.5 py-1 rounded-pill flex-shrink-0"
          style={{
            background: active === t ? "rgba(58,123,255,0.25)" : "rgba(255,255,255,0.05)",
            border: active === t ? "1px solid rgba(58,123,255,0.5)" : "1px solid rgba(255,255,255,0.1)",
            color: active === t ? "#fff" : "var(--text-tertiary)",
            transition: "all var(--transition-fast)"
          }}
        >
          {t === "ALL" ? "All" : `Tier ${t}`}
        </button>
      ))}
    </div>
  );
}

function ScanAgeDisplay({ scannedAt, nextScanIn }: { scannedAt: string; nextScanIn: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 10000);
    return () => clearInterval(id);
  }, []);

  const { label, cls } = fmtAge(scannedAt);
  const pct = Math.max(0, Math.min(100, ((AUTO_REFRESH_MS - nextScanIn) / AUTO_REFRESH_MS) * 100));

  return (
    <div className="px-5 mb-3">
      <div className="flex items-center justify-between mb-1.5 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
        <span>Last scan <span className={cls}>{label}</span></span>
        <span>Auto-refresh in {Math.ceil(nextScanIn / 1000)}s</span>
      </div>
      <div className="h-px w-full" style={{ background: "rgba(255,255,255,0.06)", borderRadius: "var(--radius-pill)" }}>
        <div className="refresh-bar" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ResultCard({ r, index }: { r: ScanResult; index: number }) {
  const [expanded, setExpanded] = useState(false);
  if (r.tier === "NONE") return null;

  const pctColor  = r.priceChangePercent >= 0 ? "var(--bull)" : "var(--bear)";
  const trendCls  = r.trend4h === "up" ? "trend-up" : r.trend4h === "down" ? "trend-down" : "trend-ranging";
  const trendIcon = r.trend4h === "up" ? "▲" : r.trend4h === "down" ? "▼" : "◆";

  return (
    <div
      className="glass card-interactive anim-fade-up overflow-hidden"
      style={{ borderRadius: "var(--radius-md)", boxShadow: TIER_GLOW[r.tier] }}
      onClick={() => setExpanded((e) => !e)}
    >
      {/* ── Header row ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-2.5">
          <TierBadge tier={r.tier} />
          <div>
            <div className="flex items-center gap-1.5 font-semibold text-[15px] tracking-wide">
              {r.symbol.replace("USDT", "")}
              <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>/USDT</span>
              <StructureBadge event={r.structureEvent} />
              {r.nearLiquidity && <span className="liq-pill">LIQ</span>}
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>
              <span className={trendCls}>{trendIcon} 4h {r.trend4h}</span>
              <span className="mx-1.5" style={{ color: "var(--divider)" }}>·</span>
              {r.signalCount} signals
              <span className="mx-1.5" style={{ color: "var(--divider)" }}>·</span>
              {fmtVol(r.quoteVolume)}
            </div>
          </div>
        </div>

        <div className="text-right">
          <div className="font-mono font-semibold text-[15px]">${fmt(r.price)}</div>
          <div className="text-[11px] font-medium mt-0.5" style={{ color: pctColor }}>
            {r.priceChangePercent >= 0 ? "+" : ""}{r.priceChangePercent.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* ── Quick TP1 / TP2 / SL row ───────────────────────────── */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-4 pb-2 text-[11px]">
        <span>
          <span style={{ color: "var(--text-tertiary)" }}>Entry </span>
          <span className="price-entry font-mono">${fmt(r.entry)}</span>
        </span>
        <span>
          <span style={{ color: "var(--text-tertiary)" }}>TP1 </span>
          <span className="price-tp font-mono">${fmt(r.takeProfit1)}</span>
        </span>
        <span>
          <span style={{ color: "var(--text-tertiary)" }}>TP2 </span>
          <span className="price-tp font-mono">${fmt(r.takeProfit2)}</span>
        </span>
        <span>
          <span style={{ color: "var(--text-tertiary)" }}>SL </span>
          <span className="price-sl font-mono">${fmt(r.stopLoss)}</span>
        </span>
      </div>

      {/* ── R:R bar ────────────────────────────────────────────── */}
      <div className="px-4 pb-3">
        <div className="flex justify-between text-[10px] mb-0.5" style={{ color: "var(--text-tertiary)" }}>
          <span>R:R TP1 {r.riskRewardT1.toFixed(1)}x</span>
          <span>TP2 {r.riskRewardT2.toFixed(1)}x</span>
        </div>
        <RRBar rr={r.riskRewardT1} />
      </div>

      {/* ── Expanded detail ────────────────────────────────────── */}
      {expanded && (
        <>
          <hr className="divider mx-4" />
          <div className="px-4 py-3">

            {/* Signal chips */}
            <SignalChips flags={r.flags} />

            {/* Liquidity price if nearby */}
            {r.nearLiquidity && r.liquidityPrice !== null && (
              <div className="mt-2 text-[10px]" style={{ color: "var(--warn)" }}>
                ⚡ Buy-side liquidity at ${fmt(r.liquidityPrice)} — potential sweep target
              </div>
            )}

            {/* Reason string */}
            <p className="mt-2.5 text-[11px] leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
              {r.reason}
            </p>

            {/* ATR info */}
            {r.atr !== null && (
              <p className="mt-1.5 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                ATR(1h) {fmt(r.atr)} · SL {((r.price - r.stopLoss) / r.price * 100).toFixed(2)}% below entry
              </p>
            )}
          </div>
        </>
      )}

      {/* ── Expand hint ────────────────────────────────────────── */}
      <div
        className="text-center pb-1.5 text-[10px]"
        style={{ color: "var(--text-tertiary)", opacity: 0.5 }}
      >
        {expanded ? "▲ less" : "▼ more"}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [data,    setData]    = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [filter,  setFilter]  = useState<FilterTier>("ALL");
  const [nextIn,  setNextIn]  = useState(AUTO_REFRESH_MS);

  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current)    clearTimeout(timerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }, []);

  const scheduleNext = useCallback((runScan: () => void) => {
    clearTimers();
    setNextIn(AUTO_REFRESH_MS);

    const startedAt = Date.now();
    countdownRef.current = setInterval(() => {
      const remaining = AUTO_REFRESH_MS - (Date.now() - startedAt);
      setNextIn(Math.max(0, remaining));
    }, 1000);

    timerRef.current = setTimeout(() => {
      runScan();
    }, AUTO_REFRESH_MS);
  }, [clearTimers]);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/scan?limit=25");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const json: ScanResponse = await res.json();
      setData(json);
      setFilter("ALL");
    } catch (e: any) {
      setError(e?.message ?? "Scan failed — check connection");
    } finally {
      setLoading(false);
    }
  }, []);

  // Wire up auto-refresh: each completed scan schedules the next one
  const runScanWithSchedule = useCallback(async () => {
    await runScan();
    // scheduleNext captures the latest runScanWithSchedule via closure
    scheduleNext(runScanWithSchedule);
  }, [runScan, scheduleNext]);

  // Auto-scan on mount
  useEffect(() => {
    runScanWithSchedule();
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = data?.results.filter((r) => {
    if (r.tier === "NONE") return false;
    if (filter === "ALL")  return true;
    return r.tier === filter;
  }) ?? [];

  return (
    <>
      <div className="bg-scene" aria-hidden="true" />

      <main
        className="relative z-10 min-h-dvh max-w-md mx-auto pb-10"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        {/* ── Header ──────────────────────────────────────────── */}
        <div className="px-5 pt-6 pb-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-[22px] font-bold tracking-tight">
                Crypto Scanner
                <span
                  className="ml-2 text-[11px] font-semibold px-2 py-0.5 rounded-pill"
                  style={{
                    background: "rgba(58,123,255,0.18)",
                    border: "1px solid rgba(58,123,255,0.3)",
                    color: "var(--accent)",
                    verticalAlign: "middle"
                  }}
                >
                  3.0
                </span>
              </h1>
              <p className="text-[12px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>
                Binance · 15m / 1h / 4h · SMC + HTF
              </p>
            </div>

            <button
              onClick={runScanWithSchedule}
              disabled={loading}
              aria-label="Run scan"
              className="flex items-center gap-2 px-4 py-2 text-[13px] font-semibold rounded-pill"
              style={{
                background: loading
                  ? "rgba(58,123,255,0.15)"
                  : "linear-gradient(135deg, var(--accent), var(--midblue))",
                border: "1px solid rgba(58,123,255,0.35)",
                color: loading ? "rgba(255,255,255,0.5)" : "#fff",
                boxShadow: loading ? "none" : "0 4px 20px rgba(58,123,255,0.3)",
                transition: "all var(--transition-normal)",
                cursor: loading ? "not-allowed" : "pointer"
              }}
            >
              {loading ? (
                <>
                  <span
                    className="anim-spin inline-block w-3 h-3 rounded-full"
                    style={{ border: "2px solid rgba(255,255,255,0.15)", borderTopColor: "rgba(255,255,255,0.6)" }}
                    aria-hidden="true"
                  />
                  Scanning…
                </>
              ) : (
                <>⟳ Scan</>
              )}
            </button>
          </div>
        </div>

        {/* ── Scan age + auto-refresh bar ─────────────────────── */}
        {data && !loading && (
          <ScanAgeDisplay scannedAt={data.scannedAt} nextScanIn={nextIn} />
        )}

        {/* ── Error ───────────────────────────────────────────── */}
        {error && (
          <div
            className="mx-5 mt-2 mb-3 px-4 py-3 text-[13px]"
            style={{
              background: "rgba(255,75,110,0.1)",
              border: "1px solid rgba(255,75,110,0.25)",
              color: "var(--bear)",
              borderRadius: "var(--radius-md)"
            }}
            role="alert"
          >
            ⚠ {error}
          </div>
        )}

        {/* ── Loading skeletons ────────────────────────────────── */}
        {loading && (
          <div className="flex flex-col gap-3 px-5 mt-2">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {/* ── Results ─────────────────────────────────────────── */}
        {data && !loading && (
          <>
            <StatsBar data={data} />
            <FilterBar active={filter} setActive={setFilter} />

            {visible.length === 0 ? (
              <div
                className="text-center mt-12 px-8 anim-float"
                style={{ color: "var(--text-tertiary)", fontSize: 13 }}
              >
                <div className="text-3xl mb-3">◎</div>
                No {filter !== "ALL" ? `Tier ${filter}` : ""} signals this scan.
                <div className="mt-1 text-[11px]">
                  {filter !== "ALL" ? "Try 'All' to see lower-tier setups." : "Markets may be ranging — try again soon."}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3 px-5">
                {visible.map((r, i) => (
                  <ResultCard key={r.symbol} r={r} index={i} />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Initial state (before first scan completes) ──────── */}
        {!data && !loading && !error && (
          <div className="flex flex-col items-center justify-center mt-24 px-8 text-center">
            <div className="text-4xl mb-4 anim-pulse">◉</div>
            <p className="text-[14px] font-semibold">Starting scan…</p>
            <p className="text-[12px] mt-1" style={{ color: "var(--text-tertiary)" }}>
              Fetching top 25 USDT pairs across 3 timeframes
            </p>
          </div>
        )}
      </main>
    </>
  );
}
