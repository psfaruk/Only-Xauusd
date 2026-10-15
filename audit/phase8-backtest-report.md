# Phase 8 — Backtest Verification Report (Task 6)

**Date:** 2026-10-15 (Asia/Dhaka) · **Module:** `src/lib/backtest/*` (new — justified: no pre-existing backtest module existed anywhere in the repository; this is not a duplicate engine). Strategy version `8.0.0-structure-proxy`.

> **Backtests are simulations, not proof of live profitability.** Nothing below is a profitability claim.

## 1. Verified dataset

Every run loads **only** persisted candles with `source='bridge-mt5'`, `validationStatus='VALID'`, `isForming=false`, and re-validates OHLC at read time (excluded rows are counted and reported, never used). Each run persists a `BacktestRun` row with the **dataset fingerprint** (sha256 over exact decimal text + timestamps), date range, rules, dev/OOS metrics, trades and limitations.

Live runs executed 2026-10-15 (UTC):

| TF | Candles | Range (UTC) | Fingerprint (16 hex) |
|---|---|---|---|
| M15 | 999 | 2026-09-30 → 2026-10-15 | `e01f357edf44070b` |
| H1 | 993 | 2026-08-16 → 2026-10-15 | `1fbafbbfda912e3f` |
| H4 | 999 | 2026-03-02 → 2026-10-15 | `b831771ed4dd2a79` |

## 2. Method (all requirements checked)

- **Chronological, no future leakage:** Phase 4 causal components (swing confirmation, close-only BOS/CHoCH, EMA/RSI/ATR recursion) reused; entry at the NEXT bar's open; pinned by test — mutations after a trade's entry bar leave earlier trades byte-identical.
- **Realistic execution:** entry = next-bar open ± half-spread ± slippage (spread 0.24 price units = the live observed XAUUSDm spread; slippage 0.02). Not every signal fills at a theoretical price — there is no theoretical-price assumption at all.
- **Conservative collision rule:** a candle touching both SL and target resolves to the **loss** (SL first) — documented, deterministic, pinned by test.
- **Forming candle excluded** (never a completed candle).
- **Dev / out-of-sample:** chronological 70/30 split; OOS is reported separately and never optimized against.
- **Cost sensitivity:** wider spread/slippage can never improve net P&L (pinned by test).

## 3. Results (hypothetical, price units, 1 XAU per unit)

| TF | Segment | Trades | Win rate | Profit factor | Net P&L | Max DD | Avg R | Streak W/L |
|---|---|---|---|---|---|---|---|---|
| M15 | dev | 7 | 28.6% | 0.51 | −70.28 | 98.53 | −0.14 | 1/3 |
| M15 | oos | 5 | 40.0% | 0.89 | −8.96 | 35.06 | +0.20 | 1/1 |
| H1 | dev | 10 | 30.0% | 0.70 | −201.61 | 582.04 | −0.10 | 1/6 |
| H1 | oos | — | **INSUFFICIENT_DATA** (3 trades < 5) — not invented | | | | | |
| H4 | dev | 5 | 60.0% | 1.86 | +427.92 | 295.67 | +0.80 | 1/1 |
| H4 | oos | 5 | 60.0% | 2.10 | +261.90 | 239.11 | +0.41 | 2/2 |

Honest reading: the structure-proxy ruleset is **not validated** — M15/H1 dev segments are negative; H4 shows positive dev and OOS on **5 trades each**, far too few for statistical significance. No optimization was performed against any segment.

## 4. Data coverage & exclusions (reported per run)

- Only broker-verified closed candles; forming excluded.
- Weekend/daily-break gaps are market design (46 weekend gaps inside the H4 broker window), not data loss; 3 broker-side intra-window H4 gaps reported as-is.
- H4 depth limited to the broker-served window (1,458-bar ceiling probed) — long-horizon statistics are limited accordingly (limitation stored on every run).
- Trade counts are small because the ruleset is deliberately strict (BOS + EMA trend filter + RSI bound) — reported, not tuned.

## 5. Tests (fixture-based, kept separate from live evidence)

`tests/backtest/engine.test.ts` — 11 cases: INSUFFICIENT_DATA honesty, version/rules recording, next-bar entry, **no-look-ahead**, collision→loss (generic + precisely pinned), fingerprint identity/difference, full-result reproducibility, chronological dev/OOS partition, cost monotonicity, honest `end_of_data` exits.

## 6. Verdict

**PASS** as a verification harness: verified-data-only, fingerprinted, reproducible, conservative, honestly-empty when data is insufficient. **NOT a profitability claim** — results above are hypothetical simulations with documented limitations.
