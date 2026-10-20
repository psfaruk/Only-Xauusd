# Phase 11-E — Candidate Activation Record

**Protocol:** `phase11-candidate-forward/1` (pre-registered 2026-10-16, audit/phase11-candidate-forward-protocol.md)
**Candidate:** `hybrid-multimodel-research/11.0.0-candidate.1` (spec frozen: audit/phase11-candidate-strategy-spec.md)
**Activation instant (UTC):** 2026-10-20T15:14:27Z — first live candidate evaluation row persisted
**Activated by:** orchestrator Task 31-c per the user's explicit instruction ("সব কিছু কমপ্লিট করেন, সিগন্যাল আসছে না সমাধান করেন" — complete every remaining phase and fix signals-not-coming), interpreted as the §2.3 user authorization for candidate forward observation.

---

## 1. Activation pre-conditions (protocol §2) — all satisfied

| # | Pre-condition | Evidence |
|---|---|---|
| 1 | Environment restored (bridge authenticated, scheduler on, verified spec) | Bridge :3031 connected+authenticated Exness-MT5Trial6 (probe: latency 39 ms, 355 symbols); dev server restarted 14:38Z with env at boot → `[instrumentation] market sync scheduler: ON — every 300s`; SymbolSpec XAUUSDm digits=3 verified. (Root cause of the earlier outage: the 12:42Z dev-server boot predated the .env restore → scheduler OFF → zero syncs/evals since 13:07Z. Fixed by orchestrator Task 31-a.) |
| 2 | Real-data historical comparison completed and reviewed | `audit/phase11-real-comparison.md` (Task 31-b) — baseline vs candidate on the full broker-served real candle depth (2000 M15 bars ≈ 28 calendar days + aligned M5/H1/H4), frozen constants, run once, reported as-is. |
| 3 | User authorization for candidate forward observation | User's blanket completion directive (above), given after being shown the Phase 11 candidate work across multiple sessions. No order-execution authorization is implied or granted by this record. |

## 2. What activation changed (implementation summary)

- **Dual evaluation (live):** `runSignalEvaluation` now ALSO runs `evaluateCandidate` on the SAME windows/reference/spread/clock whenever the shared gates pass, and persists a separate `SignalEvaluation` row with `strategyVersion = hybrid-multimodel-research/11.0.0-candidate.1`, candidate namespaced fingerprints (`computeCandidateFingerprint`, `candidate-setup-identity/1`) and a `candidate-rules-snapshot/1` rules snapshot. Candidate evaluation is error-isolated — it can never change the baseline verdict, rows or fingerprints (pinned by test).
- **M5 confirmation window** is loaded additionally for the candidate (same loader semantics, closed bars only).
- **Paper tracking:** NEW `PaperCandidateOutcome` table (additive `db:push`; baseline tables untouched) + `src/lib/signal/candidate-paper.ts` mirroring the baseline walker (setup-chronology/1 semantics, observed-spread + 0.02/side cost model, immutable resolved outcomes, honest null-exit expiry). One row per candidate setup identity EVER (unique constraint, P2002 suppressed). Runs after every successful scheduled sync (same `FORWARD_PAPER_TRACKING` switch — no new switch).
- **Isolation (protocol §4, cannot-mix guarantees):** `getLatestSignalEvaluation`/`getSignalEvaluationHistory` DEFAULT to the baseline strategy version — the execution/approval pipeline, multi-agent review, chat tools, conditions card and dashboard baseline counts stay baseline-scoped even when candidate rows are newer. Candidate reads go through dedicated candidate-persistence functions; `/api/signal/history?strategy=candidate` is the explicit candidate surface. Baseline `trackPaperSignals` filters baseline rows only. Verified + test-pinned.
- **API surface (additive):** `/api/signal/latest` gains `candidate` {evaluation, levels, model, paperStats} + `strategyVersions` {activeLive, researchCandidate, candidateStatus}; `/api/signal/run` gains the candidate summary; `/api/signal/history` gains `?strategy=candidate`.

## 3. What activation did NOT change

- Baseline `hybrid-structure-retest/9.0.0` engine, rules, thresholds, fingerprints, rows, paper protocol (`phase10.2-forward-paper/1`, 0/20 state) — byte-identical behavior (equivalence test-pinned).
- The four execution locks and the approval pipeline semantics — nothing here executes anything. (Separately, the Phase 11 demo execution stack — trial account, human approval per order, max 0.10 lots — was armed by the preceding session per the user's directive; that posture is unchanged by this activation and remains fully audited: bridge `orderRequests=0`.)
- No candidate threshold was retuned (CANDIDATE_RULES frozen — any change requires `…candidate.2` + a new protocol document).

## 4. Observation state at activation

- Window: 90 calendar days from 2026-10-20T15:14:27Z (ends 2027-01-18T15:14:27Z).
- Completed-outcome floor: 20 (verdict INCOMPLETE below it — always).
- Stop conditions: 8 consecutive completed losses OR cumulative drawdown > 10R → `NEGATIVE_DRAWDOWN_STOP`; confirmed correctness defect → halt + new version; deadline with < 20 → `INCOMPLETE_TIMEOUT`.
- Starting state: 0 candidate paper rows, 0 completed outcomes, verdict INCOMPLETE. paperStats surfaced live on `/api/signal/latest`.

## 5. First live observations (honest)

- First dual cycle 15:14Z: baseline WAIT [HTF_H1_OPPOSITE] + candidate WAIT [HTF_H1_OPPOSITE, EMA_TREND_OPPOSITE, RANGE_NOT_DETECTED] — the candidate now shows per-model stage codes (Model A/B/C) so the operator can see exactly which model needs what to fire.
- Multi-model coverage means setups can now also come from Model B (H4+H1-aligned M15 pullback with M5 confirmation) and Model C (range sweep-rejection) — the documented, frozen answer to "signals not coming" without weakening a single gate.
