# Six-Month Backtest Report (Phase 5) — XAUUSDm, broker-verified dataset

**Run:** 2026-10-22T12:45–12:46 UTC · script `scripts/six-month-backtest.ts` (branch `remediation/six-month-backtest`)
**Dataset:** the Phase 3 broker-authorized acquisition (`audit/historical-data-report.md`) — **first backtest in project history with full six-month M15 execution + six-month M5 confirmation + H1/H4 context coverage** (all previous runs were bounded by the bridge's 2000-bar latest-N cap: ~30 days M15, ~9 days M5).
**Machine-readable:** `audit/six-month-backtest-results.json`.

> **RESEARCH RESULT — NOT A PERFORMANCE CLAIM. Both strategies are classified REJECTED under the pre-registered rules. No reliability or profitability claim is made or implied.**

---

## 1. Pre-registered design (fixed before results were seen)

- Dataset: every verified closed broker candle (source `bridge-mt5`, `VALID`, non-forming): M15 11,956 · M5 35,867 · H1 2,989 · H4 810 bars (2026-04-23 → 2026-10-22, dataset fingerprint in the JSON).
- Baseline strategy: the current production signal core (`hybrid-structure-retest/9.0.0` via `runSignalBacktest`) — **unmodified**.
- Candidate: the pre-registered `hybrid-multimodel-research/11.0.0-candidate.1` via the same harness, identical costs. **No parameter of either was tuned on this dataset by this run** (Model-A equality re-proven on six-month data: 315 = 315 emissions, decision bars byte-identical).
- Chronological split dev/OOS = 70/30 (the project's established, test-pinned pre-registration; OOS never optimized against).
- Costs: entry-side half-spread 0.12 + slippage 0.02/side — **labeled assumption** (historical per-bar spread not served by the source); sensitivity band 0.20 / 0.24 / 0.30 / 0.35.
- Classification rules (§5.6, declared before evaluation): engine INSUFFICIENT_DATA → INSUFFICIENT_DATA; OOS completed trades < 30 → INSUFFICIENT_SAMPLE; OOS bootstrap p95 ≤ 0 → REJECTED; OOS bootstrap median ≤ 0 → REJECTED; otherwise PAPER_FORWARD_REQUIRED.

## 2. Baseline — real signal core (9.0.0), six-month dataset

| Segment | Trades | Win rate | Net P&L (price) | Sum R | Profit factor | Max DD | Max consec. losses |
|---|---|---|---|---|---|---|---|
| Dev (70%) | 42 | 33.3% | **+93.55** | 0.00 | 1.11 | −13.0R | 8 |
| **OOS (30%)** | **33** | **21.2%** | **−175.26** | **−11.32R** | **0.72** | **−17.32R** | **16** |

Pipeline over 11,956 M15 evaluations: 2,918 blocked (data gates) · 6,129 NO_SETUP · 2,594 WAIT · 4,980 candidate-setup stages · **315 valid setups** · 75 hypothetical fills · 75 completed outcomes (fills are conservative: price ran away without pulling back to entry zones — honest no-fill accounting).

**OOS bootstrap (1000 iterations, seed 42, 33 samples): median −0.343R · p05 −0.686R · p95 +0.041R.**

**Classification: REJECTED** — rule "OOS bootstrap median ≤ 0" (−0.343R). Even the optimistic band edge barely crosses zero.

## 3. Candidate — pre-registered 11.0.0-candidate.1 (adds Models B/C + M5 confirmation)

| Segment | Trades | Win rate | Net P&L (price) | Sum R | Profit factor | Max DD | Max consec. losses |
|---|---|---|---|---|---|---|---|
| Dev (70%) | 54 | 29.6% | −6.24 | −6.00R | 0.99 | −15.0R | 11 |
| **OOS (30%)** | **36** | **25.0%** | **−100.78** | **−9.74R** | **0.85** | **−17.0R** | **16** |

OOS bootstrap: median −0.271R. Model-A equality on six-month data: **315 = 315, bars identical ✓** (the candidate provably weakens nothing).
**Classification: REJECTED** — OOS bootstrap median ≤ 0.

## 4. Spread sensitivity (baseline, OOS segment)

| Full spread | 0.20 | 0.24 | 0.30 | 0.35 |
|---|---|---|---|---|
| OOS net P&L (price) | −175.02 | −175.26 | −175.62 | −175.92 |
| OOS sum R | −11.32 | −11.32 | −11.32 | −11.33 |

The OOS loss is **not a cost artifact** — it persists across the entire spread band (the strategy's R-losses come from stop-outs, not from spread assumptions).

## 5. Interpretation (evidence-based, restrained)

- The dev segment's marginal profit (+93.55, PF 1.11) does **not** carry out-of-sample: OOS is decisively negative for both strategies. This is the classic overfit-to-development pattern the chronological split exists to expose.
- 16 consecutive OOS losses would have tripped the pre-registered forward stopping condition (`NEGATIVE_DRAWDOWN_STOP`, 8 consecutive) twice over.
- The previous ~30-day comparison (`audit/phase11-real-comparison.md`) could not see this — its window was too short and M5 confirmation was missing for most of it. **The six-month view is the more trustworthy one and it is negative.**
- What this does NOT say: that the strategy family can never work — it says the CURRENT, UNMODIFIED configurations lose on this six-month out-of-sample window under conservative execution assumptions, and that no live-reliance is justified.

## 6. Recommendation (per user's directive)

1. **Do not treat signals from the current strategy as reliable or profitable.** The app's signal-only research posture (read-only, paper-tracking) is exactly the right containment.
2. Any strategy change must go through a NEW pre-registered candidate + NEW forward protocol (the project's established process) — not parameter tuning against this OOS window (that would convert the OOS into a tuning set).
3. Forward paper evidence must re-accumulate from zero (the platform DB wipe on 2026-10-22 reset the ledger; completed forward outcomes = 0 at this run).
4. Sample adequacy: OOS n=33–36 is PRELIMINARY (30–99 band). The REJECTED classification is nonetheless valid because the median is decisively negative and losses persist across the cost band; a larger sample would be needed only to refine the estimate, not to reverse its sign credibly.

## 7. Verification status

- Verified by direct execution: all tables above (script output + results JSON); Model-A equality; bootstrap determinism (seed 42, pinned by existing tests).
- Verified by source inspection: no-look-ahead guarantees are test-pinned (`tests/backtest/` mutation tests), cost model, SL-first collision rule, chronological split.
- Not tested / blocked: production build (platform constraint — `bun run build` is forbidden in this sandbox; the strict `tsc --noEmit` gate + lint + 958/958 tests cover the compile dimension; recorded honestly as NOT RUN, not as passed).
