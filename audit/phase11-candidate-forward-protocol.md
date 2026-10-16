# Phase 11-E — Candidate Forward-Paper Protocol (PRE-REGISTERED)

- **Protocol ID / version:** `phase11-candidate-forward/1`
- **Candidate:** `hybrid-multimodel-research/11.0.0-candidate.1` (spec: `audit/phase11-candidate-strategy-spec.md`, frozen 2026-10-16 BEFORE any candidate result was examined)
- **Status:** PRE-REGISTERED — saved BEFORE any candidate outcome data exists (the environment is disconnected; not a single candidate evaluation has ever run outside unit fixtures). No candidate result has been observed at the time of this writing.
- **Separation guarantee:** this protocol is COMPLETELY SEPARATE from the Phase 10.2 forward-paper protocol (`phase10.2-forward-paper/1`, baseline 9.0.0). Baseline and candidate metrics, rows, tables, and verdicts can never mix (§4).

---

## 1. Frozen rule definitions

The candidate rules are the frozen constants of the spec (`audit/phase11-candidate-strategy-spec.md` §1 and §7), implemented verbatim in `src/lib/signal/candidate/types.ts`. The spec + implementation + tests are committed together; ANY change to any candidate threshold after activation requires a NEW candidate version string (`…candidate.2`) and a NEW protocol document. Candidate rules and their provenance (verified-configuration / strategy-constant / derived) must be persisted as a candidate rules snapshot at activation time — same discipline as Phase 10.3-D (baseline manifest + candidate-only entries, namespaced `candidate-rules-snapshot/1`).

## 2. Activation pre-conditions (all required, in order)

1. **Environment restored:** bridge authenticated (verified broker feed), scheduler on, verified symbol spec — the same live gates the baseline runs under.
2. **Real-data historical comparison completed and reviewed:** baseline vs candidate on ≥ 60 calendar days of verified broker M15/H1/H4 candles (the largest depth the broker serves, up to 2000 M15 bars), using the frozen candidate constants, reviewed by the user. This comparison was IMPOSSIBLE at pre-registration time (sandbox rebuild destroyed the runtime market DB; no real candles exist in the environment) — the synthetic comparison in `phase11-baseline-vs-candidate.md` is explicitly NOT a substitute and NOT a performance claim.
3. **User authorization** for candidate forward observation (this document grants nothing by itself).

Until all three hold, the candidate stays offline research code: no persistence, no scheduler wiring, no paper rows.

## 3. Observation design (fixed now)

| Element | Value |
|---|---|
| Observation window | 90 calendar days from the activation instant (recorded at activation) |
| Minimum completed-outcome sample | 20 completed candidate paper outcomes — below this the verdict is INCOMPLETE, always |
| Symbol / timeframe | XAUUSDm · M15 execution, H1/H4 context, M5 confirmation (candidate input) |
| Duplicate policy | ONE paper row per candidate setup identity (`candidate-setup-identity/1`) EVER — DB-unique, race-proof (P2002 suppressed), same discipline as Phase 10.3-A |
| One-position-at-a-time | per model+anchor identity; concurrent models may hold separate paper positions ONLY when their identities differ; conflicting live direction (MODEL_CONFLICT) never opens anything |
| Paper walk | the EXISTING chronology-safe walker semantics (setup-chronology/1, Phase 10.3-B): a bar contributes only if its close is strictly after signal creation, its open strictly before expiry, and it has truly closed; corrupt/unordered/off-grid bars fail closed; gaps are honest non-observations |
| Entry/SL/TP/expiry/invalidation | frozen at setup creation from the winning model's levels (spread-adjusted reference entry; SL beyond anchor/sweep ± 0.5 ATR; fixed 2.0R target; 12-bar expiry; per-model invalidation level); resolved outcomes are IMMUTABLE |
| Costs | the existing documented cost model: observed spread at signal time + 0.02/side slippage assumption + 0 commission assumption; full round trip applied to every outcome; assumptions labeled on every report |
| Unobservable candles | a paper row whose walk window contains no observable post-creation bars resolves `expired` with NULL exit/P-L (never fabricated), exactly like the baseline |

## 4. Isolation from Phase 10.2 (cannot-mix guarantees)

1. Candidate paper outcomes are stored in a **separate table** (`PaperCandidateOutcome`) — the Phase 10.2 aggregation reads `PaperSignalOutcome` only and is byte-frozen; candidate rows can never enter baseline metrics.
2. Candidate evaluations persist with `strategyVersion = hybrid-multimodel-research/11.0.0-candidate.1` — distinct from `hybrid-structure-retest/9.0.0` at every query surface; the dashboard three-count strip (evaluations / distinct setups / paper rows) stays baseline-scoped, with a separately-labeled candidate card.
3. Candidate setup fingerprints use the `candidate-setup-identity/1` namespace (payload includes the candidate version) — collision with baseline `setup-identity/1` is impossible.
4. The Phase 10.2 verdict, protocol files, aggregation inputs, and 0/20 IN_PROGRESS state remain untouched by everything in this protocol.

## 5. Stopping conditions (pre-registered)

The candidate forward observation ENDS with a final report when ANY of:

1. 20 completed outcomes AND the 90-day deadline reached → full evaluation (§6);
2. 90-day deadline reached with < 20 completed outcomes → verdict `INCOMPLETE_TIMEOUT` (no performance claim, ever);
3. 8 consecutive completed losses OR cumulative drawdown > 10R → verdict `NEGATIVE_DRAWDOWN_STOP` (same risk limits as the baseline protocol — risk discipline is NOT relaxed for the candidate);
4. A confirmed correctness defect is found in the candidate implementation (fail-closed bug) → observation halts, defect documented, fix requires a NEW candidate version + NEW protocol; already-collected rows are reported as-is with the defect disclosed.

## 6. Interpretation rules (pre-registered — mirrors the baseline's discipline)

1. Below 20 completed outcomes: `INCOMPLETE` — no claim of any kind.
2. At ≥ 20: net P/L (after modeled costs) ≤ 0 → `NEGATIVE_AFTER_COSTS`.
3. Net > 0 but top-1 winner's share of net wins > 35% → `INCONCLUSIVE_CONCENTRATION`.
4. Net > 0, diversified, but 8+ consecutive losses or > 10R drawdown at any point → `INCONCLUSIVE_DRAWDOWN`.
5. All gates passed → `CONTINUE_FORWARD_RESEARCH` — explicitly NOT trading authorization, NOT Phase 12, NOT an order-execution unlock. The four execution locks stay locked regardless of any candidate result.
6. Candidate vs baseline comparison statements are allowed ONLY with both samples ≥ 20 completed outcomes; otherwise "insufficient sample" is the only honest statement.
7. No profitability claim, no probability/confidence score, no live/demo order — at any point, under any result.

## 7. Reporting path

A separate candidate status endpoint/card (additive, read-only) reporting: evaluations, distinct candidate setups (by model), paper rows, outcome mix, net/R stats, days remaining, and this protocol's fingerprint. Protocol fingerprint recorded below; any future edit to this document invalidates the pre-registration and requires version `phase11-candidate-forward/2`.

## 8. Protocol fingerprint

```
protocol-id:        phase11-candidate-forward/1
candidate-version:  hybrid-multimodel-research/11.0.0-candidate.1
spec:               audit/phase11-candidate-strategy-spec.md (frozen 2026-10-16)
window-days:        90
min-completed:      20
max-consec-losses:  8
max-drawdown-r:     10
top1-share-limit:   0.35
costs:              observed-spread + 0.02/side slippage + 0 commission (labeled)
walk-semantics:     setup-chronology/1 (Phase 10.3-B, unchanged)
identity-namespace: candidate-setup-identity/1
storage:            PaperCandidateOutcome (separate table, activation-gated)
baseline-protocol:  phase10.2-forward-paper/1 — UNTOUCHED, byte-frozen
pre-registered-at:  2026-10-16 (before any candidate result existed)
```
