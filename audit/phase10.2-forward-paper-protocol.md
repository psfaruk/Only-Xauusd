# Phase 10.2 — Forward Paper Validation Protocol (PRE-REGISTERED)

**Status:** PRE-REGISTERED — fixed and committed BEFORE any forward paper outcome existed.
**Registration time:** 2026-10-15T16:16:05Z (UTC), verified against the live database:
`PaperSignalOutcome` table contained **exactly 0 rows** at registration.
**Protocol version:** `phase10.2-forward-paper/1`
**Rules version:** `phase10.2-forward-paper-rules/1` (machine-enforced in `src/lib/signal/paper-protocol.ts`, pinned by `tests/signal/paper-protocol.test.ts`)
**Strategy under test:** the PRODUCTION deterministic signal engine (hybrid-structure-retest, `strategyVersion` pinned in `src/lib/signal/rules.ts`). **No strategy parameter, rule, or pre-registered OOS threshold changes in this phase.**

---

## 1. Objective

Collect TRUE out-of-sample (forward) evidence for the current production strategy by paper-tracking what the price actually does after live BUY_SETUP / SELL_SETUP signals, until a pre-registered sample floor or a pre-registered time cap is reached — then apply pre-registered verdict rules. This directly serves the user's Phase 11 gate conditions, in particular:

1. যথেষ্ট পরিমাণ স্বাধীন out-of-sample trade data (sufficient independent OOS trade data)
2. বাস্তবসম্মত spread, slippage ও commission-সহ গ্রহণযোগ্য ফল (acceptable results under realistic costs)
3. Drawdown এবং consecutive losses-এর গ্রহণযোগ্যতা নির্ধারিত (acceptability determined IN ADVANCE)
4. Forward paper ফলাফল backtest-এর সঙ্গে সামঞ্জস্যপূর্ণ (forward results consistent with backtest)
5. চারটি execution lock ও নিরাপত্তা যাচাই অক্ষত (four execution locks intact)

Phase 10.1 established that the Phase 10 negative results are real, reproducible and structural — NOT an implementation defect. This protocol collects the forward evidence the pre-agreed decision framework requires. It is diagnostic observation only.

## 2. Pre-registered constants (immutable by discipline)

| Constant | Value | Rationale |
|---|---|---|
| Counting activation | **2026-10-15T16:30:00Z** | After protocol registration, before the autonomous loop is deployed. Nothing can pre-date it (table was empty). |
| Minimum completed trades for a verdict | **20** | The SAME ≥ 20 pre-registered interpretability floor as Phase 10 (`audit/phase10-backtest-integrity.md §9`). Deliberately NOT changed (Phase 10.1 rule). 20 is acknowledged as a LOW floor — wide confidence intervals are disclosed with every verdict. |
| Observation window | **90 days** from activation (deadline **2027-01-13T16:30:00Z**) | Hard cap. Below the floor at the deadline → `INCONCLUSIVE_TIMEOUT`; extending or redesigning is a separate explicit USER decision under a NEW protocol version. |
| Concentration limit | top-1 net-win share ≤ **35%** | Same pre-registered limit as Phase 10. |
| Consecutive-loss acceptability | ≤ **8** consecutive net losses | Pre-determined BEFORE any forward outcome existed (user's Phase 11 condition #3). |
| Drawdown acceptability | ≤ **10R** peak-to-trough (cumulative net R) | Pre-determined BEFORE any forward outcome existed (user's Phase 11 condition #3). |

Amendment policy: silent edits are FORBIDDEN. Any change requires a new protocol version string, a new document, and full disclosure of what changed and why.

## 3. Eligibility and counting rules

- **Eligible rows:** `PaperSignalOutcome` rows for the tracked symbol (XAUUSDm) with `signalCreatedAtUtc ≥ activation`, created by the production engine. Rows are only ever created from `SignalEvaluation` rows with outcome BUY_SETUP/SELL_SETUP that passed ALL fail-closed gates (verified broker quote, verified spec, readiness, no demo rows, no suspicious gaps) — the pipeline is the Phase 10 `paper.ts` (immutable, one row per evaluation via unique `signalEvaluationId`; resolved rows never reprocessed).
- **FIRST-OPEN rule (one-position model):** rows are walked chronologically. The first eligible row opens the single paper position. Every further setup observation arriving while that position is open (before its resolution bar/time) is a **repeat observation — NOT an independent trade**. After resolution, the next eligible row opens a new counted trade. This mirrors exactly the one-position model the Phase 10.1 audit verified in the backtests (all 33 skipped fills = POSITION_OPEN; episode-level fill rate 15/22 = 68%), keeping forward results comparable with backtest results.
- **Completion:** a counted trade is COMPLETED when resolved with observable P/L (`stopped`, `targeted`, `invalidated`, or `expired` with post-signal candles). `expired` with NO observable bars (net P/L honestly null) is resolved-but-unobservable: excluded from metrics, disclosed separately, never invented.
- **Open trades** count toward progress display but never toward the sample floor.

## 4. Fill and cost semantics (disclosed differences)

- Paper entry = `levels.entryReference` (the spread-adjusted reference the live engine published at signal time), evaluated on the autonomous loop cadence (each successful scheduled sync, default every 5 minutes). The backtest fills at the first flat M15 bar close inside the zone. **Disclosed difference:** forward paper can enter intra-bar (up to cadence granularity) — slightly earlier than the backtest's bar-close fill. Consistency is ASSESSED at verdict time, not assumed.
- Costs: the SAME Phase 10 conservative round trip (spread + 2× slippage + commission; default commission 0, spread 0.24 observed baseline) — the same convention as the validation harness. `entryReference` already contains the entry-side half spread; the overlap is knowingly borne (pessimistic, documented in `paper.ts`).
- Results are recorded in price units and R-multiples. No monetary claim anywhere.

## 5. Pre-registered verdict rules (ordered — first match wins)

1. Completed counted trades **< 20**:
   - before the 90-day deadline → **IN_PROGRESS** (no performance claim of any kind)
   - at/after the deadline → **INCONCLUSIVE_TIMEOUT** (next step = user decision: extend under a new protocol version, or redesign)
2. Net P/L (after modeled costs) **≤ 0** at ≥ 20 completed → **NEGATIVE_AFTER_COSTS**
3. Top-1 net-win share **> 35%** → **INCONCLUSIVE_CONCENTRATION**
4. Consecutive losses **> 8** OR drawdown **> 10R** → **INCONCLUSIVE_DRAWDOWN** (even if net > 0)
5. Otherwise → **PROMISING_CONTINUE_FORWARD**

`PROMISING_CONTINUE_FORWARD` is explicitly **NOT a profitability claim** and **NOT authorization for Phase 11 demo execution**. Phase 11 additionally requires separate explicit user authorization and all five pre-agreed conditions, including forward-vs-backtest consistency (assessed at that point by comparing forward metrics with the persisted Phase 10 baseline ValidationRun) and the four execution locks.

## 6. Metrics definitions (identical to the Phase 10 harness)

- Win = net P/L > 0; loss = net P/L ≤ 0; win rate = wins / completed.
- Profit factor = Σ(positive net) / |Σ(negative net)|; null when no losses (never fabricated).
- avgR / sumR over net R-multiples; max drawdown = peak-to-trough of cumulative net R (positive magnitude); max consecutive losses = longest net-loss streak.
- Top-1 net-win share = best trade's net P/L / Σ net wins; by-direction breakdown (BUY/SELL).
- Small-sample honesty: below the floor, metrics are still DISPLAYED for transparency but the verdict stays IN_PROGRESS/INCONCLUSIVE and every number carries its n.

## 7. Data integrity requirements

- Outcomes resolve only over CLOSED, VALID, `source=bridge-mt5` M15 candles re-validated at read time (`paper.ts` walk). No fabricated bars, no forward-fill, no synthetic data.
- Resolution order per bar is conservative and matches both backtest engines: SL first (collision → loss), then M15-close invalidation, then TP; expiry without touch → exit at last closed bar close (or honestly null when unobservable).
- Each outcome is counted exactly once (immutable resolved rows; unique key per evaluation; first-open aggregation on top).
- Every verdict carries the rules version, protocol version, and the fixed strategy version.

## 8. Durability & known limitations

- The sandbox has wiped `.env`/DB on rebuild three times. Forward evidence durability therefore relies on **periodic snapshots**: `bun run paper:snapshot` exports all raw `PaperSignalOutcome` rows plus derived status to `audit/phase10.2-paper-snapshot.json` (tracked in git). Procedure: run and commit the snapshot after each resolution batch / at least weekly. A rebuilt sandbox rehydrates analysis from snapshots; lost unsnapshotted rows are honestly reported as lost, never reconstructed.
- Weekend/market-close periods produce BLOCKED evaluations (stale quote) — honest, logged, and excluded from counting (no rows created).
- The observation window is wall-clock based; data outages shorten effective observation but never fabricate outcomes.

## 9. What this phase can never do

- No broker order, modification or closure — no such code exists anywhere (four execution locks verified each phase; static no-trading-endpoint scans in the test suite).
- No parameter tuning, no rule change, no OOS-threshold change, no cherry-picking: the verdict function is pure, versioned, and test-pinned BEFORE the first outcome exists.
- No profitability claim in any UI state (the dashboard renders IN_PROGRESS amber; PROMISING is amber, never green).

---

*Registered by Z.ai Code (Task 17, Phase 10.2). Companion implementation report: `audit/phase10.2-forward-paper-validation.md`.*
