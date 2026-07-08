# Crypto Scanner — Handoff Doc
**Stack:** Next.js 14.2.35 / TypeScript / Vercel  
**Data source:** Binance public REST API (no API key needed)  
**Last commit:** `539cbb8` — feat: tight mode toggle for 80% win rate (TP 0.5×ATR, SL 2.0×ATR)  
**Last updated:** 2026-07-08

---

## 1. What this is

A mobile-first web dashboard that scans a blended universe of Binance USDT spot pairs on demand. Every tap of **Scan** (or auto-refresh every 5 minutes) fetches live OHLCV data across 3 timeframes (15m / 1h / 4h), computes 14 signals spanning indicators, Smart Money Concepts on both 1h and 4h, Heikin-Ashi trend, and 7 chart pattern types — then ranks results into Tier S / A / B with ATR-based TP1/TP2/SL.

Scan universe is a **blended** set: 18 volume leaders, up to 30 big % movers (≥15% 24h, ≥$300k), up to 20 extreme movers (≥50% 24h, ≥$20k), up to 35 momentum movers (≥8% in last 1h, ≥$50k), plus random diversity fill up to 70 total — all filtered to coins on **both Binance and GateIO**.

No API key. No database. No WebSocket server. Opens in any mobile browser.

---

## 2. File structure

```
crypto-scanner/
├── app/
│   ├── api/
│   │   ├── scan/route.ts           ← Main scan endpoint (orchestrates everything)
│   │   └── announcements/route.ts  ← Pre-price listing radar (isolated, fail-silent)
│   ├── globals.css                 ← Design tokens + glassmorphism + all keyframes
│   ├── layout.tsx                  ← Root layout (viewport as separate export — Next.js 14 correct)
│   └── page.tsx                    ← Full dashboard UI (auto-scan, age bar, CHoCH badge, TP2 row)
├── lib/
│   ├── binance.ts       ← Binance public REST client + getScanCandidates (blended universe)
│   ├── announcements.ts ← Binance listing announcement scraper (undocumented endpoint)
│   ├── indicators.ts    ← RSI, EMA, MACD, BB, StochRSI, ATR + Heikin-Ashi trend
│   ├── zigzag.ts        ← ZigZag pivot detection + BOS/CHoCH structure
│   ├── smc.ts           ← Order blocks, FVG, liquidity zones
│   ├── patterns.ts      ← Double top/bottom, H&S, Inv H&S, wedges, triangle (7 patterns)
│   └── scoring.ts       ← 14-signal tier engine, ATR TP/SL, new listing + exit-liquidity detection
├── vercel.json          ← maxDuration 60s for scan function
├── package.json
├── tsconfig.json
└── HANDOFF.md
```

---

## 3. Deploy to Vercel

```bash
# 1. Push to GitHub (already done if you're reading this from the repo)

# 2. Import in Vercel dashboard
# vercel.com → New Project → Import from GitHub → crypto-scanner-3.0

# 3. No environment variables needed — all Binance data is public

# 4. Deploy
# Vercel auto-builds on push. Framework preset: Next.js
```

**Important:** Free Vercel plan caps serverless functions at **10 seconds**.
The blended scan (12 volume leaders + 35 movers) can approach this budget on slow Binance responses.

Options:
- **Upgrade to Vercel Pro** (60s limit, `vercel.json` already sets `maxDuration: 60`)
- **Or reduce mover slots** via `?limit=15` — scans faster, fewer mid-cap coins covered
- Hard cap in `route.ts` is `moverSlots = Math.min(Math.max(limit, 10), 45)` — never exceeds 45

---

## 4. Run locally

```bash
npm install
npm run dev
# Open http://localhost:3000
```

---

## 5. Tier system (v3.0)

| Tier | Condition | Meaning |
|------|-----------|---------|
| **S** | 5+ signals, ≥3 strong, 4h not bearish | High-conviction buy on weakness |
| **A** | 3+ signals, ≥1 strong, 4h neutral/bullish | Valid setup, less confirmation |
| **B** | 2 signals, any mix | Early watch — not actionable alone |
| **NONE** | <2 signals OR 4h bearish OR R:R < 1:2 | Filtered out, not shown |

> v3.0 raised the S-tier strong threshold from ≥2 → ≥3 to compensate for the
> expanded signal set (14 signals vs 8 in v2).

The 4h bearish veto is a hard filter — prevents buying into falling knives.

---

## 6. Full signal stack (14 signals — v3.0)

| # | Signal | Timeframe | Weak | Strong |
|---|--------|-----------|------|--------|
| 1 | RSI(14) | 1h | 30–40 | <30 and turning up |
| 2 | EMA20/50 cross | 1h | Price reclaiming EMA20 | Golden cross confirmed |
| 3 | EMA200 support | 1h | Within ±1.5% | Bounce + volume spike |
| 4 | MACD histogram | 1h | Shrinking (neg) | Bullish crossover |
| 5 | Volume | 15m | >1.0× avg | ≥1.8× avg spike |
| 6 | Bollinger Bands | 1h | Touching lower band | BB touch + width <4% |
| 7 | StochRSI K | 1h | K<30 and rising | Cross up from below 20 |
| 8 | Order Block | 1h | — | Price in unmitigated bullish OB |
| 9 | Fair Value Gap | 1h | Price filling bullish FVG | — |
| 10 | **Order Block (HTF)** | **4h** | — | **Price in unmitigated 4h OB** |
| 11 | **FVG (HTF)** | **4h** | Price filling 4h bullish FVG | — |
| 12 | **Buy-side Liquidity** | **1h pivots** | Within 0.3% of cluster | ≥3-touch cluster |
| 13 | **Heikin-Ashi trend** | **1h** | Transitioning (colour flip) | 3 bullish HA candles, no lower wicks |
| 14 | **RSI(14) 4h** | **4h** | 30–45 | <30 and turning up |
| + | Chart pattern | 1h or 4h | Triangle/asc.wedge | Inv H&S, double bottom, desc.wedge |
| + | Structure event | 4h | BOS Bullish | CHoCH Bullish |

---

## 7. Chart patterns (v3.0 — 7 types)

| Pattern | Bearish? | Detection basis |
|---------|----------|-----------------|
| Double bottom | No — bullish | Two lows within 1.5% |
| Double top | Yes | Two highs within 1.5% |
| Symmetrical triangle | No — neutral/bullish | Highs descending + lows ascending |
| **Inverse H&S** | **No — strong bullish** | Three lows, middle lowest, shoulders ±4% |
| **Head & Shoulders** | **Yes** | Three highs, middle highest, shoulders ±4% |
| **Descending wedge** | **No — bullish** | Both slopes neg, highs falling faster |
| **Ascending wedge** | **Yes** | Both slopes pos, lows rising faster |

---

## 8. TP/SL formula

Two modes, toggled via `?tight=1` query param or the UI button:

### Standard mode (R:R 2:1, ~33% WR)
All levels computed from 1h ATR (14 periods). Entry is the current
market price *unless* a buy-side liquidity zone is within 0.5×ATR below
price — then entry becomes the zone price (limit order).

```
Without LIQ zone:    SL = Entry − (1.0 × ATR)
With LIQ zone:       SL = Zone − (0.8 × ATR)
Both cases:          TP1 = Entry + (2.0 × ATR)   TP2 = Entry + (3.5 × ATR)
```

Minimum enforced R:R: **1:2** at TP1.

### Tight mode (R:R 0.25, ~80% WR)
Backtested 2 years — 80.9% win rate (12,502 signals, 29 top symbols).
Sacrifices per-trade profit for high hit rate. No R:R minimum gate.

```
SL  = Entry − (2.0 × ATR)
TP1 = Entry + (0.5 × ATR)    ← partial exit target
TP2 = Entry + (1.0 × ATR)    ← full exit target
```

---

## 9. Auto-scan & refresh (v3.0)

- Page loads → scan runs automatically (no manual tap required)
- After each scan completes, a 5-minute countdown begins
- A thin progress bar below the header shows time until next auto-refresh
- Scan age is shown with colour coding: green <3m, amber 3-5m, red >5m
- Manual **Scan** button still available to force an immediate refresh
- All timers are cleaned up on unmount (no memory leaks)

---

## 10. UI additions (v3.0)

- **CHoCH / BOS badge** — appears inline with the symbol name when 4h structure
  has a bullish Change-of-Character or Break-of-Structure event
- **LIQ pill** — appears when price is within 0.3% of a buy-side liquidity cluster
- **TP2** now shown in the quick-view row alongside TP1 and SL (no tap needed)
- **R:R row** shows both TP1 and TP2 multiples
- Empty-state illustration with context message when no signals match the filter
- Spinning loader in the Scan button replaces static text during scan
- `anim-float`, `anim-pulse`, `anim-spin` CSS animations added to globals.css

---

## 11. Heikin-Ashi trend (lib/indicators.ts)

Computed in-house (no extra dependency) from the last 3 HA candles:

- **bullish** — last 3 HA candles green with no lower wicks (strong momentum)
- **bearish** — last 3 HA candles red with no upper wicks
- **transitioning** — colour flip on most recent candle (potential reversal)

Used as signal #13. Strong when `bullish`, weak when `transitioning`.

---

## 12. 4h SMC confluence (lib/scoring.ts)

v3.0 wires 4h candle data into the SMC layer:

- **OB(4h)**: Price inside an unmitigated 4h bullish order block → auto-strong signal
  (higher timeframe institutional demand zone)
- **FVG(4h)**: Price filling a 4h bullish fair-value gap → weak signal
- Both are computed from `ind4h` / `candles4h` which were present but unused in v2

---

## 13. Smart Money Concepts (lib/smc.ts)

Unchanged from v2. See original HANDOFF sections 8 and 9 for detail.

**Order blocks:** Last opposite candle before ≥1.2% impulsive move.  
**Fair Value Gaps:** 3-candle imbalance (candle[i-2].high < candle[i].low).  
**Liquidity zones:** Equal highs/lows clusters within 0.15% across ZigZag pivots.

---

## 14. Market structure (lib/zigzag.ts)

Unchanged from v2. 2% deviation on 1h, 2.5% on 4h (wider = cleaner pivots).

BOS Bullish / BOS Bearish / CHoCH Bullish / CHoCH Bearish.  
CHoCH Bullish on 4h is now surfaced as a **strong** signal in the flag engine.

---

## 15. Binance rate limits

Public REST API: 6,000 weight/minute.  
Each klines request costs ~2 weight. 3 TFs × up to 57 symbols (12 volume + 45 movers) = ~342 weight per scan.  
Auto-refresh is every 5 minutes — well within limits.  
`exchangeInfo` (for active-trading filter) costs 20 weight and is cached for the invocation lifetime.

---

## 16. Known limitations / open items

1. **No persistence** — scan results are not stored. Each scan is fresh.
2. **No push alerts** — app must be open in browser to receive results.
3. **Vercel free tier timeout** — reduce `?limit=` to 15 or lower if hitting 10s wall.
4. **EMA200 convergence** — needs 200+ candles; 250 fetched so fine for liquid pairs.
5. **Pattern detection is pivot-based** — not image/ML-based. Works well on clean swing structures; may miss patterns in choppy/low-liquidity candles.
6. **Heikin-Ashi is a lagging filter** — confirms trend, doesn't predict it. Don't use HA alone as an entry trigger.
7. **Announcement radar uses an undocumented Binance endpoint** — has returned 403 before (confirmed Jan 2025). Fails silently, returns empty array. The main scan is completely unaffected if it goes dark.
8. **GateIO filter fetches Gate.io's ticker list on every scan invocation** — if Gate.io is slow it eats into the 10s free-tier budget. Consider caching the Gate.io symbol set for the invocation lifetime, same pattern as `_binanceTradingCache` in `lib/binance.ts`.
9. **Liquidity zones are pivot-based, not order-book** — a zone at $X means price bounced at similar levels historically, not that buy orders actually sit there. SL below the zone still protects, but false positives are possible in choppy markets.
10. **Diversity fill is random** — the random sample from the remaining pool has no signal filter, so some filler candidates will score NONE and be hidden. This is intentional (rotates fresh names into view), but means the actual result count can be below the 70 candidate cap.

---

## 17. Recent changes (post v3.0)

| Commit | Change |
|--------|--------|
| `539cbb8` | Tight mode toggle: `?tight=1` switches to TP 0.5×ATR / SL 2.0×ATR for ~80% win rate. Backtested across 2 years (80.9% WR, 12,502 signals). UI toggle button. |
| `f1179ea` | Fix stagnant coin pool (momentum≥35, mover≤30, diversity fill) and buy-liquidity accuracy (entry at zone, tighter proximity, SL below zone) |
| `524dc5a` | Filter scan candidates to coins tradable on **both** Binance and GateIO — ensures every setup is executable on both exchanges |
| `db27f4a` | v3.0 blended scan universe (`getScanCandidates`), new listing radar (`/api/announcements`), exit-liquidity detection, announcement radar |
| `897e155` | 88-assertion stress test suite — all passing |
| `e5f473f` | **Critical R:R bug fix** — SL was 1.5×ATR (gave TP1 R:R 1.33); corrected to 1.0×ATR (TP1 R:R 2.0, TP2 R:R 3.5) |
| `1e92d2f` | Next.js 14.2.5 → 14.2.35 security patch |
| `dac1d84` | Switch Binance base URL to `data-api.binance.vision` (bypasses geo-blocks) |
| `e988cc7` | Brute-force audit pass — 8 bugs fixed |
| `297da36` | v3.0 initial: 14-signal SMC engine, 4h HTF confluence, HA trend, 7 patterns, auto-refresh UI |

---

## 18. New listing detection (two independent paths)

### Path 1 — Candle-truncation heuristic (`scoring.ts → estimateListingAgeHours`)
Zero extra API calls. Binance klines always return as many candles as exist up to the requested limit (250). If the returned array is shorter than `KLINES_LIMIT`, the first candle is the genesis candle — its `openTime` gives listing age directly.

- Checks 15m → 1h → 4h (finest to coarsest) for precision up to ~41.7 days
- `isNewListing = true` if age ≤ 48h
- Fresh listings are sorted ahead of same-tier peers in the results

### Path 2 — Announcement radar (`lib/announcements.ts → GET /api/announcements`)
Pre-price signal — catches a coin before it has any candle history at all.

- Polls Binance's undocumented internal CMS endpoint (`/bapi/composite/v1/public/cms/article/list/query`) for catalogId=48 ("New Cryptocurrency Listing")
- Parses titles matching `"Binance Will List <Name> (<SYMBOL>)"` format
- Deduplicates per symbol, keeps earliest announcement, drops items >168h old
- **Isolated in its own API route** — failure never blocks `/api/scan`
- Fails silently (empty array, 5s abort timeout) on any error
- Has historically returned 403; treat as a bonus signal only

### Exit-liquidity detection (`scoring.ts`)
Fresh listing (≤48h) that has already pumped to an ATH then dropped ≥25% from it → `possibleExitLiquidity: true`. Shows a ⚠ warning in the reason string instead of a buy signal.

---

## 19. Scan universe (`lib/binance.ts → getScanCandidates`)

Four priority buckets plus random diversity fill, filtered to actively-TRADING symbols on Binance (`exchangeInfo` status check) AND listed on GateIO:

| Bucket | Slots (default) | Filter |
|--------|----------------|--------|
| Momentum movers | 35 | ≥8% 1h rolling change, ≥$50k vol — fastest rotation |
| Extreme movers | 20 | ≥50% 24h change, ≥$20k vol — thin-book pumps |
| Big movers | 30 | ≥15% 24h change, ≥$300k vol — mid-cap sweep |
| Volume leaders | 18 | Top by 24h quote volume — BTC/ETH/majors for context |
| Diversity fill | (up to cap) | Random sample from remaining pool — breaks stagnation |

Hard cap: **70 total candidates** (modeled ~5-6s, not load-tested on live Vercel).
Priority order ensures momentum/extreme movers are never trimmed.

Query params: `?limit=40` (mover slots, clamped 10–55), `?minMove=15` (% move threshold).

`_binanceTradingCache` is module-scoped — `exchangeInfo` is fetched once per serverless invocation, not per symbol.

---

## 20. Repo references

| Repo | Used for |
|------|----------|
| [technicalindicators](https://www.npmjs.com/package/technicalindicators) | RSI, EMA, MACD, BB, StochRSI, ATR |
| [jbn/ZigZag](https://github.com/jbn/ZigZag) | Pivot detection (reimplemented in TS) |
| [joshyattridge/smart-money-concepts](https://github.com/joshyattridge/smart-money-concepts) | OB, FVG, liquidity (reimplemented in TS) |
