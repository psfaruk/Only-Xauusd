# Phase 9 — Backtest Validation Report (Task C)

**Date:** 2026-10-15 (Asia/Dhaka) · **Module:** `src/lib/backtest/signal-engine.ts` (NEW — validates the REAL signal core) + restored Phase 8 proxy coverage
**Tests:** 20 backtest cases (tests/backtest/engine.test.ts) — all pass. Live runs executed over verified broker candles.

> **Backtests are simulations, not proof of profitability.** The strategy is NOT validated by the numbers below; small samples are reported honestly.

---

## 1. The actual signal engine is validated — not the proxy — **PASS**

`runSignalBacktest` calls the SAME pure core (`evaluateSignal`) the live service calls, once per decision bar, with windows cut as-of that bar (M15 rolling window + H1/H4 windows containing only bars CLOSED before the decision close). The Phase 8 `8.0.0-structure-proxy` remains available for regression but is never presented as signal-engine validation: `/api/signal/latest` embeds only backtests whose `strategyVersion` equals the CURRENT signal strategy.

## 2. Method guarantees (each test-pinned)

| Requirement | Verdict | Evidence |
|---|---|---|
| Verified candles only | **PASS** | the Phase 8 loader (source='bridge-mt5', VALID, closed, read-time OHLC re-validation) feeds all three TFs |
| Chronological processing, no look-ahead | **PASS** | next-bar-open entries; **mutation test**: mutating every candle (M15+H1+H4) after the last trade's signal bar leaves earlier trades byte-identical |
| Entry only after the setup is knowable | **PASS** | decision = signal core evaluated at bar i (all inputs as-of i); entry at bar i+1 open |
| Spread + slippage assumptions | **PASS** | 0.24 spread (live-observed) + 0.02 slippage per side; entry-side test pins ask-side long / bid-side short fills; cost monotonicity pinned |
| Conservative same-candle SL/target collision | **PASS** | SL-first rule; test asserts no 'target' exit occurs on a bar that also touched the stop |
| Forming candles excluded | **PASS** | loader semantics (isForming=false) |
| Dev/OOS chronological split | **PASS** | 70/30; dev trades strictly precede oos trades (pinned); split fraction recorded on every run |
| OOS never used for optimization | **PASS** | no optimization code exists at all; the split is configuration-fixed and recorded |
| Incomplete history / insufficient samples | **PASS** | INSUFFICIENT_DATA with reasons; metrics stay null — never invented |
| Reproducible | **PASS** | dataset fingerprint (M15+H1+H4) identical for identical data, differs for any change; full-run JSON byte-identical on rerun |
| Honest counts | **PASS** | evaluations / blocked / noSetup / wait / candidateSetups / validSetups / hypotheticalFills / completedOutcomes reported SEPARATELY |

## 3. LIVE run results (verified broker candles, 2026-10-15)

Dataset: M15 1,009 · H1 995 · H4 999 closed candles (2026-09-30 → 2026-10-15, 2026-08-16, 2026-03-02 respectively), fingerprint `2b7fefc5a2ff8139…` (reproduced identically on a second run).

| Counter | Value |
|---|---|
| evaluations | 1,009 |
| blockedEvaluations | 219 (warm-up region — first 219 decision bars lack the 220-bar M15 window; honestly counted) |
| noSetup | 520 |
| wait | 243 |
| candidateSetups | 466 |
| validSetups | 27 |
| hypotheticalFills | 8 (no overlapping positions — valid setups during an open position were not filled) |
| completedOutcomes | 8 |

| Segment | Trades | Result |
|---|---|---|
| dev | 6 | COMPUTED — winRate 0%, PF 0, net −131.24 price units |
| oos | 2 | **INSUFFICIENT_DATA** (2 < 5 — metrics NOT invented) |

**Honest reading:** the strategy LOST on the dev segment in this window and the OOS sample is too small to say anything. No profitability claim is made anywhere in the product. The documented live-vs-backtest difference (live references the real-time quote; the backtest references the decision close + configured spread) is stated in the limitations list of every run and surfaced in the UI.

## 4. Restored Phase 8 proxy coverage — **PASS**

The Phase 8 report claimed `tests/backtest/engine.test.ts` (11 cases) but the file was lost before commit (documented in the Phase 9 pre-audit). Coverage restored + extended (9 proxy cases: INSUFFICIENT_DATA honesty, version/rules recording, next-bar entry, no-look-ahead mutation, conservative collision, fingerprint identity/difference, chronological partition, cost monotonicity, honest end_of_data exits).

## 5. Verdict

**PASS as a validation harness:** the actual signal engine runs causally over verified candles with realistic costs, honest counts and reproducible fingerprints. **NOT a profitability claim** — dev is negative, OOS insufficient; long-horizon validation still limited by the broker-bounded H4 depth (1,458 bars) and the M15 window (≈15 days per fetch window).
