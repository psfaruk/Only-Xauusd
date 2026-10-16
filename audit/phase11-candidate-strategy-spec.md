# Phase 11-C — Candidate Strategy Specification

- **Candidate ID / version:** `hybrid-multimodel-research/11.0.0-candidate.1`
- **Status:** SPECIFICATION — frozen BEFORE any dataset run and before implementation. Thresholds below were chosen from the Phase 11-A evidence and documented design rationale ONLY. No number in this document was tuned against any result (the comparison in `phase11-baseline-vs-candidate.md` runs ONCE against these frozen values and is reported as-is).
- **Baseline:** `hybrid-structure-retest/9.0.0` remains UNTOUCHED, live, and the immutable comparison baseline. The candidate is **offline research code only** — it is NOT wired into `runSignalEvaluation`, the scheduler, persistence, or paper tracking. Activation requires the Phase 11-E protocol.
- **Safety:** no orders, no execution code, no lock changes, no Phase 10.2 protocol change. Pure functions only.

---

## 1. Models

### Model A — Structure break & retest (identity: `A`)

**Definition: EXACTLY the baseline 9.0.0 eligibility chain** (`src/lib/signal/core.ts` `evaluateSignal` steps S1–S12 with the baseline `buildStrategyRules()` values). The candidate calls the baseline core unchanged — therefore on identical data, Model A's outcome is **provably identical** to the baseline's (pinned by test). All baseline gates preserved: `maxBarsSinceBreak 8`, `zoneWidthAtr 0.5`, `entryToleranceAtr 0.25`, `slAtrBuffer 0.5`, `rewardRisk 2.0`, `minAdx 15`, RSI BUY 40–75 / SELL 25–60, `maxSpreadPrice 0.6`, `expiryBars 12`, swing 3/3, min bars 220/220/200, window 300.

Model A parameters are NOT re-declared in the candidate rules — the candidate reads the baseline `buildStrategyRules()` object directly (single source of truth, zero drift).

### Model B — Trend-continuation pullback (identity: `B`)

Context (all evaluated causally as-of the decision close, same primitives as baseline):

| Rule | Value | Rationale (a priori) |
|---|---|---|
| B-HTF context | H4 trend = direction **AND** H1 trend = direction (swing-structure labels via `causalTrendAt`) | Pullback entries want WITH-trend context; stricter than baseline's non-opposite filter on purpose — this model must not become a weaker clone of Model A |
| B-trend side | M15 decision close on the EMA50 trend side (BUY: close > EMA50) | Same convention as baseline S7 |
| B-pullback window | last **6** M15 bars (incl. decision bar) | A pullback that takes > 1.5 h to form is a regime change, not a pullback |
| B-pullback touch | BUY: ∃ bar i in window with `low[i] ≤ ema50[i] + 0.35×atr[i]` (SELL mirrored: `high[i] ≥ ema50[i] − 0.35×atr[i]`) — values **at bar i** (causal) | The EMA50 band is the documented pullback area; 0.35 ATR ≈ typical M15 noise band |
| B-invalid depth | BUY: no bar i in window with `close[i] < ema50[i] − 1.0×atr[i]` (SELL mirrored) | A close a full ATR beyond EMA50 means the pullback became a breakdown — the setup is dead, not pending |
| B-RSI band | same band as baseline (BUY 40–75 / SELL 25–60) | Consistency; no weakening |
| B-ADX floor | ADX(14) ≥ 15 (same as baseline) | Trend-continuation model — trend strength is constitutive |
| B-spread gate | spread ≤ 0.6 (same as baseline) | Unchanged risk control |
| B-anchor | most recent confirmed swing low (BUY) / swing high (SELL) with `index + swingRight ≤ decisionIdx` — same search as baseline S11 | Same SL anchoring discipline |
| B-entry zone | `[ema50 − 0.35×atr, ema50 + 0.35×atr]` (BUY, mirrored SELL) | The pullback band is the entry zone |
| B-live proximity | reference price within zone ± 0.25×ATR (same as baseline S10) | Unchanged |
| B-confirmation (M5) | the last M5 candle CLOSED by the decision close: BUY `close > open` **AND** `close > previous M5 close` (SELL mirrored); requires ≥ 2 closed M5 bars | Closed-candle momentum resumption; an EMA touch ALONE never produces a setup (mandate) |
| B-expiry | 12 M15 bars from decision close (same as baseline) | Unchanged |
| B-invalidation level | zone low (BUY) / zone high (SELL) | Pullback failed if price closes back through the band |

Levels: the SHARED pure `deriveLevels` (baseline implementation) — entryRef = reference ± half-spread (BUY pays ask side), SL = anchor ∓ `slAtrBuffer×ATR`, target = fixed 2.0R of actual risk, strict ordering or NO setup.

### Model C — Range sweep & rejection (identity: `C`)

| Rule | Value | Rationale (a priori) |
|---|---|---|
| C-range window | last **96** M15 bars (24 h) | Intraday range definition |
| C-range detection | let H1,H2 = the two most recent confirmed swing highs, L1,L2 = the two most recent confirmed swing lows (confirmed by the decision bar). Range exists iff `|H1−H2| ≤ 0.6×ATR` AND `|L1−L2| ≤ 0.6×ATR` AND top = `min(H1,H2)`, bottom = `max(L1,L2)`, height = top−bottom with `2.0×ATR ≤ height ≤ 8.0×ATR` | Both highs above top and both lows below bottom → a real, tested range; height floor excludes noise, ceiling excludes runaway markets |
| C-sweep | BUY: ∃ bar s in the last **3** bars (incl. decision) with `low[s] < bottom − 0.1×ATR`; sweep extreme = min low of the sweeping bars (SELL mirrored above top) | Liquidity sweep must actually take out the boundary |
| C-reclaim | decision close back INSIDE the range (BUY: `bottom < close < top`) | Confirmed rejection — a wick alone is NEVER a trade (mandate) |
| C-HTF filter | H1 and H4 trends NOT opposite to the rejection direction (same semantics as baseline S6) | Fading a sweep into a strong opposing HTF trend is the failure mode this filter removes |
| C-RSI rule | BUY: RSI ≤ 75 (no lower bound); SELL: RSI ≥ 25 | Mean-reversion entry FROM an extreme — a lower bound would contradict the model (documented, deliberate, per-model rule; NOT a weakening of the baseline band, which still governs Models A/B) |
| C-ADX | **no ADX floor for Model C only** | ADX measures trend strength; a range model applying a trend-strength floor would be self-contradictory. The range detector itself is the regime filter. (Documented per-model rule, not a removed global filter.) |
| C-spread gate | spread ≤ 0.6 (same as baseline) | Unchanged risk control |
| C-anchor for SL | sweep extreme ∓ `slAtrBuffer×ATR` | Stop beyond the swept extreme |
| C-entry zone | BUY: `[bottom, bottom + 0.5×ATR]` (SELL mirrored below top) | The reclaim area just inside the boundary (`zoneWidthAtr` 0.5, same value as baseline) |
| C-live proximity | reference within zone ± 0.25×ATR (same as baseline S10) | Unchanged |
| C-confirmation (M5) | same M5 rule as Model B, in the rejection direction | Closed-candle confirmation |
| C-expiry | 12 M15 bars from decision close | Unchanged |
| C-invalidation level | BUY: bottom / SELL: top (a close back beyond the reclaimed boundary = failed reclaim) | Explicit invalidation |

Levels: same shared `deriveLevels`.

## 2. Data gates (shared, fail-closed — identical to baseline)

All BLOCKED-family gates of the baseline apply to the WHOLE candidate evaluation (G0–G5, service gates included when run live): spec digits, finite inputs, window minimums/chronology/OHLC validity, forming-candle guard, demo-source policy, indicator warm-up, and — for the M5 confirmation window — the same closed-bar rule (`M5 close ≤ decision close`, forming M5 bars excluded). Stale/missing data → BLOCKED, never a strategy verdict.

## 3. Precedence, conflict, dedup

1. All three models are evaluated on the SAME decision bar with the SAME input windows.
2. **Conflict** (models emitting setups in OPPOSITE directions on the same bar) → the candidate returns **WAIT [`MODEL_CONFLICT`]** and emits NO setup. (Mandate: independent models disagreeing → WAIT.)
3. **Agreement** (multiple models, same direction) → exactly ONE setup is emitted, precedence **A > B > C**; the losing models are recorded in `evidence.suppressedModels` (audit trail, no silent drops). One signal per decision bar per direction — the same opportunity can never be double-emitted.
4. **Non-setup aggregation** (no model emitted): BLOCKED (from the shared data gates) dominates; then WAIT-class stage codes dominate NO_SETUP-class; emitted reason codes are the merged, de-duplicated per-model stage codes (Model A's codes first — primary model).
5. **Setup identity (dedup):** `candidate-setup-identity/1` = sha256 over `{identityVersion, symbol, executionTf, candidateVersion, model, direction, anchorKey}` where `anchorKey` = the structure-event identity (Model A: type/direction/level/breakCandleTime — the same fields as the 10.3-A baseline identity) | the pullback-touch bar time (Model B) | the sweep bar time (Model C). Repeated evaluations of the same anchor → the SAME fingerprint (dedup-safe); a new anchor → a new fingerprint. This is a SEPARATE namespace from `setup-identity/1` — baseline and candidate fingerprints can never collide or mix (the candidate version string is in the payload).
6. **Fingerprint separation:** the candidate's `inputFingerprint` is namespaced by the candidate version and includes the M5 window and the frozen candidate rules; it is computed by `computeCandidateFingerprint` — the baseline `computeSignalFingerprint` is untouched. Setup, input, rules-snapshot and Phase 10.2 protocol fingerprints remain four separate concerns.

## 4. Candidate reason codes (new, additive — baseline codes unchanged)

`MODEL_CONFLICT` (WAIT) · `PULLBACK_CONTEXT_NOT_ALIGNED` (WAIT) · `PULLBACK_NO_TOUCH` (WAIT) · `PULLBACK_TOO_DEEP` (NO_SETUP) · `M5_CONFIRMATION_PENDING` (WAIT) · `RANGE_NOT_DETECTED` (NO_SETUP) · `RANGE_SWEEP_PENDING` (WAIT) · `RANGE_RECLAIM_PENDING` (WAIT). All baseline codes are reused where the same condition applies (e.g. `SPREAD_TOO_WIDE`, `RSI_OUT_OF_RANGE`, `NO_ANCHOR_SWING`, `LEVEL_CALC_INVALID`, `PRICE_BEYOND_ENTRY_ZONE`).

Stage-class mapping (deterministic): a model's stage reason is WAIT-class if the condition may still become true on a later bar (pending/aligned-later), NO_SETUP-class if the anchor opportunity is dead (too deep / no range / baseline NO_SETUP semantics).

## 5. Output contract (per evaluation)

Same field surface as the baseline `SignalEvaluation` (outcome ∈ {BUY_SETUP, SELL_SETUP, WAIT, NO_SETUP, BLOCKED, FAILED}; reasonCodes; decision/setup-known/expiry timestamps; levels ONLY on setups — never a probability/confidence score, never an unconfirmed direction), PLUS: `candidateVersion`, `model` (winning model or null), `direction`, `setupFingerprint` (candidate identity, setups only), and evidence `{ modelA: {outcome, reasonCodes}, modelB: {stage, detail}, modelC: {stage, detail}, suppressedModels, conflict }`. Entry is always the spread-adjusted reference (ask-side for BUY) — the current quote is never silently used for a historical signal.

## 6. What this candidate is NOT

- NOT a weakening of 9.0.0: Model A is imported unchanged; Models B/C add models with their own full confirmation chains; every shared risk control (spread gate, level ordering, risk>0, expiry, invalidation, one-setup-per-anchor dedup) is preserved.
- NOT a performance claim: availability comparison only, on clearly-labeled data (see 11-D).
- NOT live: no persistence, no scheduler wiring, no paper rows, until the 11-E protocol is activated.

## 7. Implementation surface (planned, test-first)

| File | Content |
|---|---|
| `src/lib/signal/candidate/types.ts` | candidate types + frozen rule constants (this spec, verbatim) |
| `src/lib/signal/candidate/core.ts` | pure `evaluateCandidate(input)` — calls baseline `evaluateSignal` for Model A, implements B/C, precedence/conflict/dedup |
| `src/lib/signal/candidate/identity.ts` | `candidate-setup-identity/1` fingerprint |
| `src/lib/signal/candidate/harness.ts` | offline comparison harness (mirrors `runSignalBacktest` semantics exactly; equivalence with the baseline harness is pinned by test using the baseline evaluator) |
| `src/lib/signal/candidate/synthetic-dataset.ts` | seeded deterministic synthetic market generator (SYNTHETIC — research only; can never be persisted as market data; carries `source: 'synthetic-research'`) |
| `scripts/phase11-candidate-comparison.ts` | runs baseline vs candidate on the frozen synthetic dataset, prints the comparison |

Frozen candidate constants (single source in `types.ts`, mirrored here): `pullbackLookbackBars 6` · `pullbackZoneAtr 0.35` · `pullbackMaxDepthAtr 1.0` · `rangeLookbackBars 96` · `rangeBandAtr 0.6` · `rangeMinHeightAtr 2.0` · `rangeMaxHeightAtr 8.0` · `sweepLookbackBars 3` · `sweepMinBeyondAtr 0.1` · `m5WindowBars 30` · M5 confirm = directional body + higher close (§1.B).
