# Phase 8 — Signal Quality Audit (Task 5)

**Date:** 2026-10-15 (Asia/Dhaka) · **Engine audited:** Phase 4 Hybrid Market-Structure + Indicators engine (`src/lib/analysis/*`, engineVersion 4.0.0) — audited in place, not replaced.

## 1. What the engine is (verified by inspection)

- **Swing detection** (`swings.ts`): both-sides window (left/right, default 3/3), strict-left/non-strict-right comparison, earlier-wins tie rule, confirmation timestamp = (index + right) open + tf. A swing is only *known* at its confirmation candle — causal by construction.
- **BOS / CHoCH** (`structure.ts`): close-only breaks of the active swing level; wick-only crossings recorded separately as `unconfirmedCrossings` (never as breaks). Activation pointer admits swings strictly by confirmation index. Trend preserved at break (`trendAtBreak`).
- **Trend labels:** HH/HL/LH/LL pairs; ties → `UNCLEAR` (never guessed).
- **Indicators** (`indicators.ts`): EMA 20/50/200 (SMA seed), RSI 14 (Wilder), ATR 14 (Wilder), ADX 14 + DI±. Non-finite input → typed error, never a value. All series are recursive past-only.
- **Warm-up:** per-TF minimum bar count (`ANALYSIS_MIN_BARS_PER_TF=220`) gate before any output.

## 2. Signal-side guarantees (as required by Phase 8)

| Requirement | Verdict | Evidence |
|---|---|---|
| No signal on stale/missing/invalid/insufficient input | **PASS** | Readiness gates (tick + per-TF). Live-executed: with a stale stored tick the engine returned **BLOCKED [DATA_STALE, TICK_STALE]** (fingerprint `65c9b7f395fe…`), producing *no* structure/indicator output. Fixture tests pin BLOCKED-on-demo, BLOCKED-on-missing, BLOCKED-on-insufficient. |
| Blocked reason returned instead of a signal | **PASS** | `reasonCodes` surfaced in API + dashboard ("BLOCKED — অবৈধ/অসম্পূর্ণ ডেটায় সিগন্যাল নয়: …"). |
| Reproducibility (same data + config → same result) | **PASS (live)** | Executed twice back-to-back over the same verified broker dataset: **identical fingerprints `e4c25ece1e32701839841175…` and identical verdicts** (`scripts/phase8-analysis-audit.ts`). Fixture tests additionally pin byte-stability of all indicator families. |
| No look-ahead | **PASS (verified 2 ways)** | (a) By construction: swing confirmation index, close-only BOS confirmation instant, recursive indicators; entries in the backtest consume events strictly at the signal bar and enter at the NEXT bar's open. (b) Pinned by test: mutating every candle after a trade's entry bar leaves that trade byte-identical. |
| Provenance to reproduce a run | **PASS** | `AnalysisRun` persists engineVersion, input fingerprint (sha256 over canonical decimal text + config + engineVersion), per-TF input counts/ranges/source, readiness states, warnings, reasonCodes, durations. |
| Indicator values + structure evidence preserved | **PASS** | `perTimeframe` snapshots (EMA/RSI/ATR/ADX series + structure events with broken level/time/basis) on COMPLETED runs. |
| Entry/SL/target math | **N/A in engine / PASS in backtest** | The Phase 4 engine is deliberately analysis-only (no BUY/SELL). Entry-zone/SL/target/R:R math is exercised (and audited) inside the Phase 8 backtest simulator with spread-aware entries, swing±ATR stops, fixed-R targets — see the backtest report. |
| Multi-timeframe consistency | **PASS** | Live COMPLETED run: M5 range · M15 bullish · H1 bearish · H4 range — presented as a *descriptive* alignment ("mixed") with an explicit `descriptive-only-not-a-signal` disclaimer, never as a vote. |

## 3. Live verification evidence (2026-10-15)

```
ANALYSIS RUN 1 → COMPLETED  fp=e4c25ece1e32701839841175…
  M5: trend=range BOS=15 CHoCH=2
  M15: trend=bullish BOS=21 CHoCH=2
  H1: trend=bearish BOS=16 CHoCH=8
  H4: trend=range BOS=16 CHoCH=4
ANALYSIS RUN 2 → COMPLETED  fp=e4c25ece1e32701839841175…   ← identical
REPRODUCIBLE: YES ✓ · verdict match: true
```

Dataset: 3,900 verified broker candles (M5 904 / M15 1000 / H1 990 / H4 996 closed), source `bridge-mt5`, 0 invalid, 0 duplicates. Both honest outcomes were observed live: **BLOCKED when the stored tick was stale**, **COMPLETED (deterministically twice) once the scheduled sync refreshed it**.

## 4. Chart/price-correctness check

The dashboard's structure evidence (broken level, break candle time, basis=close, trend-at-break) is rendered from the same persisted fields the engine computed — verified against the API payload during browser E2E (values match; no client-side recomputation exists).

## 5. Verdict

**PASS** — the signal layer is deterministic, causal, provenance-complete, and fail-closed. No BUY/SELL signal exists anywhere (by design — signal construction is Phase 5+, not built), so nothing can present stale data as actionable: the engine BLOCKS instead.
