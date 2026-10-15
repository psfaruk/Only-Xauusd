# Phase 9 — Signal Engine Audit (Task B)

**Date:** 2026-10-15 (Asia/Dhaka) · **Module:** `src/lib/signal/*` (NEW — Phase 5's role, built now) · Strategy `hybrid-structure-retest/9.0.0` · Engine `9.0.0`
**Tests:** 25 signal-engine cases (tests/signal/engine.test.ts) — all pass; live evaluations executed against the real broker feed.
**Safety:** research signals only — no lot size, no order, no position code exists anywhere in Phase 9.

---

## 1. B1 — Typed outcome model, strictly separated — **PASS**

`BUY_SETUP | SELL_SETUP | WAIT | NO_SETUP | BLOCKED | FAILED` with typed reason codes (35 stable codes). Semantics enforced in `src/lib/signal/core.ts`:

- **BLOCKED** = a data/safety gate failed → NO levels, NO entry information (reason codes only).
- **WAIT** = valid inputs, strategy not strong enough yet (retest pending, HTF opposed, price beyond zone, spread too wide…) — levels null.
- **NO_SETUP** = valid inputs, conditions produce nothing (no recent break, break too old, zone invalidated, invalid level math).
- Pinned: RETEST_PENDING → WAIT; ZONE_INVALIDATED → NO_SETUP; all gate failures → BLOCKED with codes.

## 2. B2 — Deterministic strategy rules, documented & versioned — **PASS**

Rules (persisted with EVERY evaluation, baked into the fingerprint, configurable only via env — the LLM cannot touch them):

1. Confirmed close-basis BOS/CHoCH on M15 within `maxBarsSinceBreak` (8) bars of the decision bar (Phase 4 structure semantics reused — swings activate at confirmation, close-only breaks, consumed levels).
2. Retest into the entry zone (`zoneWidthAtr`×ATR beyond the level) required; any close back through the level invalidates the zone.
3. H1 + H4 context must not be OPPOSITE (range/unclear allowed) — an explicit filter, **not a vote**; the Phase 4 descriptive alignment summary is never used as one.
4. M15 EMA50 trend-side filter, RSI14 band (BUY 40–75, SELL mirrored 25–60), ADX14 ≥ 15.
5. Live mid must sit inside/near the entry zone (`entryToleranceAtr`×ATR tolerance).
6. SL beyond the most recent CONFIRMED anchor swing ± `slAtrBuffer`×ATR; target = fixed `rewardRisk`×(actual risk); expiry = `expiryBars` M15 bars.

## 3. B3 — Entry / SL / target / R:R — **PASS**

- Levels exist ONLY on setup outcomes, derived by ONE pure helper (`deriveLevels`) shared with the backtest — no drift possible.
- Spread-aware: BUY references ask-side entry (mid + half-spread), SELL bid-side.
- Strict ordering validated (BUY: SL < zoneLow ≤ entry < target; SELL mirrored); any violation → `LEVEL_CALC_INVALID`, never broken levels.
- Broker-verified digits (3) format every level; missing spec (`digits: null`) → BLOCKED `SPEC_MISSING` (never guessed). tickSize/tickValue are not served by the bridge contract — recorded as honest nulls, and level math does not depend on them.
- No lot-size or order-submission capability exists (by design).

## 4. B4 — Fail-closed readiness gates — **PASS (live + fixtures)**

Live service gates, in order: symbol allowlist → quote integrity (`signalPermitted`: authenticated broker source + fresh VALID quote — a stale relay snapshot can NEVER substitute) → verified symbol spec → Phase 3 market readiness (tick + per-TF freshness) → loader facts (demo rows BLOCK; suspicious in-window gaps BLOCK). Core gates: ascending chronology, OHLC re-validation, warm-up floors (M15 220 / H1 220 / H4 200 bars), forming-candle protection (decision close must be ≤ evaluation instant → `FORMING_CANDLE_IN_INPUT`).

Live evidence: with a stale stored tick (Phase 8 observation) the analysis layer returned BLOCKED; the signal layer applies the same semantics through the same gates. During Phase 9 live runs the feed was LIVE — evaluations returned WAIT (honest) rather than BLOCKED.

## 5. B5 — Reproducibility & provenance — **PASS (live-proven)**

- **Fingerprint:** sha256 over canonical decimal-text candles (M15+H1+H4) + rules + engine version. Live: two back-to-back evaluations produced **identical fingerprints** (`4d36f67a1eab0ffb…` twice; later `f69295ed29d07ecb…` after data ticked — different data, different hash, as designed).
- **Persistence:** additive-only migration `20261015055909_phase9_signal_evaluations` (CREATE TABLE + 3 indexes — verified DDL). Every evaluation (BLOCKED included) is an append-only `SignalEvaluation` row with engine/strategy versions, fingerprints, window ranges, evidence, levels (setups only), quote snapshot, `executionLocked: true`. Nothing is ever overwritten (`getSignalEvaluationHistory` reads; no update path exists).
- Same dataset + same config + same engine version → same result: pinned by byte-identical reruns in tests.

## 6. Live evaluation evidence (real verified broker data)

| Run | Outcome | Reason | Fingerprint |
|---|---|---|---|
| Live #1 (script) | WAIT | EMA_TREND_OPPOSITE | `4d36f67a1eab…` |
| Live #2 (script, immediately after) | WAIT | EMA_TREND_OPPOSITE | `4d36f67a1eab…` (identical — reproducible) |
| Live #3 (API, token-guarded) | WAIT | EMA_TREND_OPPOSITE | `f69295ed29d0…` (data had ticked; new M15 bar) |

Interpretation (honest): at those instants a bearish CHoCH had just occurred (1 bar earlier) but the M15 close sat above EMA50 → the EMA trend-side filter refused the short — a textbook WAIT. The engine emitted no setup because the strategy conditions were not met — not because data was missing.

## 7. Verdicts

| Acceptance item | Verdict |
|---|---|
| Deterministic identical results for identical inputs | **PASS** (byte-identical, live + tests) |
| BUY/SELL mutually consistent, direction from the event | **PASS** (mirrored-fixture test) |
| No setup when structure unclear/absent | **PASS** (NO_STRUCTURE_BREAK / UNCLEAR handling) |
| Stale quote blocks evaluation | **PASS** (integrity gate + mapped codes) |
| Missing H4/H1 data blocks | **PASS** (INSUFFICIENT_H4/H1_HISTORY) |
| Invalid symbol spec blocks level calculation | **PASS** (SPEC_MISSING, no guessed levels) |
| Spread & reward/risk arithmetic correct | **PASS** (hand-computed deriveLevels pins) |
| Forming candle can never confirm | **PASS** (FORMING_CANDLE_IN_INPUT) |
| Future-candle mutation cannot alter prior signals | **PASS** (mutation test) |
| Invalid SL/target ordering rejected | **PASS** (LEVEL_CALC_INVALID) |
| Insufficient history → BLOCKED | **PASS** |
| Evaluations never overwritten | **PASS** (append-only, no update path) |
| No execution capability | **PASS** (no such code exists) |
