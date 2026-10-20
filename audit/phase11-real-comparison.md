# Phase 11-E — Real-Data Baseline vs Candidate Comparison (activation pre-condition §2.2)

**Run:** 2026-10-20T15:4xZ · script `scripts/phase11-real-comparison.ts` (run once, reported as-is)
**Dataset:** the REAL verified broker candles in the runtime DB at run time — the largest depth the broker serves through the limit-only bridge API:
- M15 (execution): **1,999 closed candles** 2026-09-20T22:30Z → 2026-10-20T15:00Z (~30 days, bridge 2000-bar cap)
- H1 (context): 687 closed 2026-09-08 → 2026-10-20 · H4 (context): 499 closed 2026-06-29 → 2026-10-20
- M5 (candidate confirmation): **1,863 closed** 2026-10-11T22:00Z → 2026-10-20T15:10Z (**~9 days only** — the bridge serves latest-N; older M5 bars are unobtainable)
- Costs identical to the established harness: entry-side half-spread 0.12 + slippage 0.02 · dev/OOS split 0.7 · minCandles 220
- Dataset fingerprint (baseline harness): see script output; frozen constants from `audit/phase11-candidate-strategy-spec.md` — no number was tuned against any result.

**RESEARCH COMPARISON — NOT A PERFORMANCE CLAIM.** Sample = one ~30-day window; the pre-registered forward protocol (20-outcome floor, 90 days, `phase11-candidate-forward/1`) is the only basis for any verdict.

---

## 1. Model-A equality (the no-filter-weakened proof, REAL data)

| Check | Result |
|---|---|
| Model-A emissions in candidate mode vs baseline validSetups | **45 = 45 — EQUAL ✓** |
| Emission decision bars byte-identical | **YES ✓** |

The candidate calls the unmodified baseline engine for Model A; on real data their emissions are provably identical. No gate was weakened.

## 2. Availability / mechanics (the actual purpose of this run)

| Metric | Baseline 9.0.0 | Candidate 11.0.0-candidate.1 |
|---|---|---|
| Evaluations | 1,999 | 1,999 |
| BLOCKED (data gates) | 219 | 219 |
| NO_SETUP | 1,247 | 3 |
| WAIT | 488 | 1,730 |
| **Valid setups emitted** | **45** | **47** (A: 45 · B: 1 · C: 1) |
| Distinct setup identities | — | 23 (24 repeat emissions deduped) |
| Precedence suppressions / conflicts | — | 0 / 0 |
| Hypothetical fills | 15 | 16 |

- The candidate merges per-model stage codes (WAIT-class dominates NO_SETUP-class by design), which is why its NO_SETUP count collapses to 3 — the operator sees *which model needs what* instead of a bare NO_SETUP.
- Models B and C added only 2 setups in this window. Two honest reasons: (1) **M5 confirmation data exists only for the last ~9 days** of the 30-day M15 window (bridge limit-only API) — B/C setups on older bars could never confirm; (2) this window was a strong directional gold market — pullback (B) and range-sweep (C) opportunities were genuinely rare. In LIVE operation the M5 window is always fresh (rolling 2000-bar sync), so B/C have full confirmation coverage going forward.
- Fill rate is low in both modes (15-16 fills vs 45-47 setups): price ran away without pulling back to the entry zones (honest no-fill accounting, unchanged from the baseline harness).

## 3. Outcome accounting (this particular window — disclosed, not generalized)

| Segment | Baseline | Candidate |
|---|---|---|
| Dev trades | 11 (1 win) · net −224.81 · −8R · maxDD −10R | identical (Model-A dominated) |
| OOS trades | 4 (0 wins) · net −63.68 · −4R | 5 (0 wins) · net −79.35 · −5R (the +1 is a Model-B/C trade) |

Both strategies lost on this window — a strongly trending month in which the structure-retest family was repeatedly stopped. **This is exactly the regime the pre-registered stopping conditions exist for** (8 consecutive completed losses → `NEGATIVE_DRAWDOWN_STOP`): the forward protocol, not this backtest, decides. No threshold was (or will be) retuned against these results — that would require a new candidate version + new protocol document.

## 4. Conclusion (activation decision input)

- Mechanics verified on real data: dual evaluation, precedence, dedup, conflict handling, Model-A equality — all working exactly as on the synthetic set.
- Availability: the candidate adds setup sources (B/C) and much richer WAIT diagnostics without weakening anything.
- Performance: **no claim possible or made** from a single 30-day window; forward observation under `phase11-candidate-forward/1` (activated 2026-10-20T15:14:27Z, see `audit/phase11-activation.md`) is the pre-registered path to any verdict.

**Activation pre-condition §2.2: SATISFIED (comparison completed and documented).**
