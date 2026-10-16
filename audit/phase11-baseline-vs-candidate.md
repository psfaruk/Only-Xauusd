# Phase 11-D — Baseline vs Candidate Comparison (FROZEN SYNTHETIC DATASET)

- **Date:** 2026-10-16 (UTC)
- **Baseline:** `hybrid-structure-retest/9.0.0` — UNMODIFIED (live strategy, immutable comparison baseline)
- **Candidate:** `hybrid-multimodel-research/11.0.0-candidate.1` — OFFLINE research code (not wired into live evaluation, persistence, or paper tracking)
- **Script:** `scripts/phase11-candidate-comparison.ts` (single run against the frozen spec constants; one determinism-verification rerun produced byte-identical numbers except wall-clock `elapsedMs` — disclosed)
- **Harness semantics:** EXACTLY the established baseline backtest harness (`runSignalBacktest`) — equivalence PROVEN by test (`tests/signal/candidate-harness.test.ts`: counters + trades byte-equal with the baseline evaluator). Costs: entry-side half-spread (0.12) + slippage (0.02) per fill, exit at level — identical for both strategies. Chronological dev 70% / OOS 30% split. No look-ahead (mutation test).

---

## 0. *** READ THIS FIRST — WHAT THIS COMPARISON IS AND IS NOT ***

> **The dataset below is SYNTHETIC** (seeded generator: `src/lib/signal/candidate/synthetic-dataset.ts`, seed 20261016, 60 days, fingerprint `053027f8…`). It contains **ZERO real market data** — the sandbox rebuild destroyed the runtime market DB and the broker bridge is disconnected (Phase 10.3-E ENV-1), so no real candles exist in this environment.
>
> These numbers verify **MECHANICS ONLY**: availability, reason distribution, dedup, conflict handling, Model-A equality, harness correctness, chronology. **NO performance claim is made or possible** — every P/L, PF and drawdown number below is an artifact of fabricated candles and is reported only for pipeline transparency. Per-strategy performance comparison on REAL data is a documented **activation pre-condition** of the preregistered protocol (`audit/phase11-candidate-forward-protocol.md` §2.2).

Evidence classes kept strictly separate: **synthetic** (this document), **historical real-data** (the frozen 30-day funnel in `audit/phase11a-no-setup-root-cause.md` §2.1 — from the committed Phase 10.1 report), **live** (none possible in the current environment).

---

## 1. The frozen dataset

| Property | Value |
|---|---|
| Generator | `generateSyntheticMarket({ seed: 20261016, days: 60 })` — mulberry32 + Box-Muller, regime-switching |
| Regimes (M5 bar ranges) | up[0-2159] · range[2160-4319] · down[4320-6479] · range[6480-8639] · up[8640-10799] · range[10800-12959] · down[12960-15119] · range[15120-17279] |
| Bars | M5 17,280 · M15 5,760 · H1 1,440 · H4 360 (coherent by construction — M15/H1/H4 aggregate the SAME M5 bars) |
| Fingerprint | `053027f8616a39379d13620a65b39d85e8fe25c837bb05c16b41d239aeb979c1` |
| Determinism | Same seed → byte-identical arrays (test-pinned); verification rerun → all counters identical |
| Costs | spread 0.24, slippage 0.02/side (documented assumptions — same values as every prior phase) |

## 2. Model-A equality — the "no filter weakened" proof

| Metric | Value |
|---|---|
| Baseline valid setups (9.0.0 evaluator) | **56** |
| Candidate Model-A emissions (inside 11.0.0-candidate.1) | **56** |
| Emission-bar lists | **byte-identical** |
| Verdict | **PROVEN — Model A is the baseline, unchanged.** Every candidate setup beyond the 56 comes from Models B/C, each with its own full confirmation chain (incl. M5 closed-candle confirmation). Test-pinned: `candidate mode > candidate Model-A emissions EQUAL baseline valid setups`. |

## 3. Side-by-side results (SYNTHETIC — mechanics only)

| Metric | Baseline 9.0.0 | Candidate 11.0.0-candidate.1 |
|---|---|---|
| Evaluations | 5,760 | 5,760 |
| BLOCKED (data gates) | 3,199 (55.5%) | 3,199 (identical — shared gates) |
| NO_SETUP | 1,880 | 3 |
| WAIT | 625 | 2,488 |
| **Emitted setups** | **56** (0.97%) | **70** (1.22%) — A 56 + B 1 + C 13 |
| Same-direction precedence suppressions | n/a | 0 |
| Cross-model conflicts | n/a | 0 |
| Distinct setup identities (dedup view) | n/a (baseline harness has no identity) | 45 distinct / 25 repeat emissions |
| Hypothetical fills (paper-model fill count) | 22 | 30 (A 22 + C 8; B 0 — its 1 setup never hit a flat fill window) |
| Completed outcomes | 22 (13 target / 9 stop) | 30 (14 target / 16 stop) |
| End-of-data open | 0 | 0 |
| Dev segment (SYNTHETIC) | 7 trades, 4W/3L, net +22.55, PF 2.51, maxDD 14.98, maxConsecLosses 3 | 9 trades, 4W/5L, net +17.90, PF 1.91, maxDD 19.63, maxConsecLosses 5 |
| OOS segment (SYNTHETIC) | 15 trades, 9W/6L, net +71.80, PF 3.61, maxDD 27.55, maxConsecLosses 6 | 21 trades, 10W/11L, net +64.39, PF 2.60, maxDD 40.21, maxConsecLosses 11 |

*(Every number in the last two rows is a fabrication artifact. They are printed because the harness computes them; they are NOT evidence of anything about real markets. Note honestly: on THIS synthetic data the baseline's 22 fills happened to perform better than the candidate's added 8 fills — 7 of the 8 added (Model C) trades stopped. No tuning followed from this observation: the constants were frozen a priori in the spec and stay frozen.)*

### 3.1 Reason-code distribution (SYNTHETIC)

| Reason | Baseline | Candidate | Note |
|---|---|---|---|
| INSUFFICIENT_H4/H1/DATA (warm-up) | 3,199 | 3,199 | shared data gates |
| STRUCTURE_BREAK_TOO_OLD | 1,175 | 1,168 | Model A stage (identical logic; tiny diff = merged-code classification paths) |
| ZONE_INVALIDATED | 705 | 698 | Model A stage |
| RETEST_PENDING | 214 | 214 | Model A stage |
| PRICE_BEYOND_ENTRY_ZONE | 132 | 155 | A 132 + B/C proximity stages |
| RSI_OUT_OF_RANGE | 107 | 107 | shared band (A + B); C uses its documented one-sided rule |
| HTF_H1_OPPOSITE / HTF_H4_OPPOSITE | 108 / 14 | 108 / 19 | A + B/C filters |
| ADX_BELOW_MIN | 49 | 75 | A + B (C has NO ADX floor — documented per-model range rule) |
| EMA_TREND_OPPOSITE | 1 | 70 | B's EMA-side gate (B reaches it when context aligns) |
| PULLBACK_CONTEXT_NOT_ALIGNED | — | 2,369 | B: dual H4+H1 alignment rarely holds on this synthetic data |
| RANGE_NOT_DETECTED | — | 2,259 | C precondition outside range regimes |
| RANGE_SWEEP_PENDING / RANGE_RECLAIM_PENDING | — | 167 / 36 | C stages |
| M5_CONFIRMATION_PENDING | — | 11 | B/C confirmation waiting (fail-closed) |
| PULLBACK_TOO_DEEP / PULLBACK_NO_TOUCH | — | 9 / 5 | B stages |

### 3.2 Behavioral observations (mechanics, no performance inference)

1. **Availability**: +14 setups (+25%) from the new models on identical data, with Model-A emissions byte-identical — the frequency gain comes from NEW entry models, not weakened filters.
2. **Model B rarely fired (1 setup)**: its dual H4+H1 alignment requirement is strict, and the synthetic HTF swing-structure often classifies `unclear`. B's availability benefit is **unproven** on synthetic data — a real-data question.
3. **Model C fired 13 setups**, exclusively in the fabricated range regimes — the regime gating works as designed.
4. **WAIT vs NO_SETUP semantics**: the candidate classifies most non-setup bars as WAIT (2,488 vs baseline 625) because B/C pending stages are WAIT-class by design ("may become valid on a later bar"). This is a semantic widening of the WAIT bucket, not a change to any gate.
5. **Dedup visibility**: 45 distinct identities; 25 repeat emissions of already-known anchors (exactly the 10.3-A-style repeated-evaluation cluster shape). In forward tracking these map to ONE paper row per identity per protocol §3.
6. **Conflicts: 0** — on this dataset the models are mutually exclusive by regime (fresh-break vs aged-trend vs range). The MODEL_CONFLICT → WAIT path is exercised by unit tests.
7. **Warm-up BLOCKED dominates (55.5%)**: the 60-day synthetic set yields only 360 H4 bars; the first 200 are warm-up (minH4Bars). Real broker windows (999 H4 bars, Phase 10) warm up over ~11% of bars. Both strategies are identically affected; documented limitation of the synthetic dataset.

## 4. Splits, leakage, and optimization discipline

- Chronological dev 70% / OOS 30% (same convention as the Phase 10 harness); the OOS segment was **never** optimized against.
- No look-ahead: proven by the harness mutation test (mutating every candle after decision i leaves earlier decisions and trades byte-identical) and by construction (closed-bar windows, causal HTF filtering, M5 closed-by-decision-close rule).
- Thresholds: frozen in `audit/phase11-candidate-strategy-spec.md` BEFORE any run; this comparison ran ONCE against them (plus one determinism-verification rerun — identical). **No threshold was adjusted after seeing results** (including the observation that Model C's synthetic trades mostly stopped).

## 5. Data-quality failures and unobservable periods

- 3,199 BLOCKED evaluations (H1/H4 window warm-up — deterministic, identical for both strategies).
- No gaps, no duplicate candles, no stale data in the synthetic feed (generated continuous 24/7 grid — itself a synthetic simplification vs real weekend gaps; noted).

## 6. Conclusion of the comparison (mechanics verdict)

**MECHANICS VERIFIED.** The candidate evaluates deterministically, adds setups only through its new models (Model-A equality proven byte-level), respects every shared risk gate, dedups by identity, and fails closed on absent confirmation. **Comparative PERFORMANCE is NOT evaluable in this environment** (no real data) — per the preregistered protocol, the real-data historical comparison (≥ 60 days of verified broker candles) is a mandatory activation pre-condition before any forward-paper testing begins, and no forward claim is made here. Live forward validation has NOT started (environment disconnected).

---

## 7. Phase 11 final verdict (cross-referenced from the root-cause report)

**CANDIDATE READY FOR FORWARD PAPER TESTING** — activation gated by the preregistered protocol's three pre-conditions (environment restored · real-data historical comparison ≥ 60 verified days · user authorization). NO live forward validation has started; no performance claim is made; the baseline 9.0.0 and the Phase 10.2 protocol are byte-unchanged.
