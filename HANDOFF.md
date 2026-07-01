# Crypto Scanner 3.0 — Handoff Doc
**Stack:** Next.js 14 / TypeScript / Vercel  
**Data source:** Binance public REST API (no API key needed)  
**Last verified:** v3.0 — TypeScript clean compile ✓

---

## 1. What this is

A mobile-first web dashboard that scans Binance's top 25 USDT pairs on demand.
Every tap of **Scan** (or auto-refresh every 5 minutes) fetches live OHLCV data
across 3 timeframes (15m / 1h / 4h), computes 14 signals spanning indicators,
Smart Money Concepts on both 1h and 4h, Heikin-Ashi trend, and 7 chart pattern
types — then ranks results into Tier S / A / B with ATR-based TP1/TP2/SL.

No API key. No database. No WebSocket server. Opens in any mobile browser.

---

## 2. File structure

```
crypto-scanner/
├── app/
│   ├── api/scan/route.ts   ← Scan endpoint (orchestrates everything)
│   ├── globals.css         ← Design tokens + glassmorphism + all keyframes
│   ├── layout.tsx          ← Root layout (viewport as separate export — Next.js 14 correct)
│   └── page.tsx            ← Full dashboard UI (auto-scan, age bar, CHoCH badge, TP2 row)
├── lib/
│   ├── binance.ts          ← Binance public REST client
│   ├── indicators.ts       ← RSI, EMA, MACD, BB, StochRSI, ATR + Heikin-Ashi trend
│   ├── zigzag.ts           ← ZigZag pivot detection + BOS/CHoCH structure
│   ├── smc.ts              ← Order blocks, FVG, liquidity zones
│   ├── patterns.ts         ← Double top/bottom, H&S, Inv H&S, wedges, triangle (7 patterns)
│   └── scoring.ts          ← 14-signal tier engine, ATR TP/SL, 4h SMC confluence
├── vercel.json             ← maxDuration 60s for scan function
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
Scanning 25 symbols takes ~15–25s depending on Binance latency.

Options:
- **Upgrade to Vercel Pro** (60s limit, `vercel.json` already sets this)
- **Or reduce scan limit** in `page.tsx` `/api/scan?limit=25` → `limit=10`
  (10 symbols fits easily in the 10s free tier window)

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
| 12 | **Buy-side Liquidity** | **1h pivots** | Within 0.8% of cluster | ≥3-touch cluster |
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

All levels computed from 1h ATR (14 periods):

```
SL  = Entry − (1.5 × ATR)
TP1 = Entry + (2.0 × ATR)   ← partial exit target
TP2 = Entry + (3.5 × ATR)   ← full exit target
```

Minimum enforced R:R: **1:2** at TP1. Both TP1 and TP2 now shown in the
quick-view row on every card (no expansion needed).

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
- **LIQ pill** — appears when price is within 0.8% of a buy-side liquidity cluster
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
Each klines request costs ~2 weight. 3 TFs × 25 symbols = 150 weight total.  
Auto-refresh is every 5 minutes — well within limits.

---

## 16. Known limitations

1. **No persistence** — scan results are not stored. Each scan is fresh.
2. **No push alerts** — app must be open in browser to receive results.
3. **Vercel free tier timeout** — reduce `limit` to 10 if on free plan.
4. **EMA200 convergence** — needs 200+ candles; 250 fetched so fine for liquid pairs.
5. **Pattern detection is pivot-based** — not image/ML-based. Works well on clean
   swing structures; may miss patterns in choppy/low-liquidity candles.
6. **Heikin-Ashi is a lagging filter** — it confirms trend, doesn't predict it.
   Don't use HA alone as an entry trigger.

---

## 17. Repo references

| Repo | Used for |
|------|----------|
| [technicalindicators](https://www.npmjs.com/package/technicalindicators) | RSI, EMA, MACD, BB, StochRSI, ATR |
| [jbn/ZigZag](https://github.com/jbn/ZigZag) | Pivot detection (reimplemented in TS) |
| [joshyattridge/smart-money-concepts](https://github.com/joshyattridge/smart-money-concepts) | OB, FVG, liquidity (reimplemented in TS) |
