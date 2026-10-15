# Phase 10.3-B — Paper-Walk Chronology & Look-Ahead Prevention

**Date:** 2026-10-15/17 (UTC) · **Agent:** Z.ai Code (Task 20)
**Scope:** Ensure the paper outcome walk can NEVER use a market bar that closed before the signal existed; make the chronology between signal creation, decision candle and subsequent candles explicit and fail-closed. **No strategy parameter, no protocol constant, no execution lock, no order endpoint, no DB deletion, no credential access, no git push.**

---

## 0. Baseline & preflight verification (all read-only)

| Check | Expected (user baseline) | Found | Match |
|---|---|---|---|
| HEAD | `8173751` (Phase 10.3-A local commit) | `8173751f7f0711b437ddd8117ec918c527944bf9` | ✅ |
| Working tree | clean | clean (`git status --porcelain` empty) | ✅ |
| Migration state | db:push-managed (Phase 10.3-A posture) | `db/custom.db` carries all tables incl. `PaperSignalOutcome.setupFingerprint`; `_prisma_migrations` absent (push-managed, same as 10.3-A baseline) — migration record folder `20261015120000_phase10_3a_setup_fingerprint` present in repo | ✅ |
| Phase 10.2 protocol fingerprint | `paper-protocol.ts` unchanged since pre-registration `8d94a00` | `git diff 8d94a00..HEAD -- src/lib/signal/paper-protocol.ts` = EMPTY; also `core.ts`, `rules.ts`, `types.ts` empty-diff | ✅ |
| Four execution locks | locked | `TRADING_PHASE/EXECUTION_ARMED/ALLOW_EXECUTION/TRADING_MODE` absent from env → defaults: phase 1 (<11), `read_only`, armed=false, allow=false → `executionLocked = true` (`src/lib/config.ts:50-60`) | ✅ |
| Runtime | dev :3000 up, bridge :3031 live | dev.log healthy (200s, scheduler running); bridge `/health` = 200 | ✅ |
| Production paper state | pre-registration intact | `PaperSignalOutcome` = **0 rows**; **0 SETUP evaluations ever persisted** (only NO_SETUP / WAIT / BLOCKED) | ✅ |

**No stop condition triggered.** Also verified before any edit: working-tree `paper.ts` is byte-identical to `8173751` (snapshot taken for the before/after comparison).

---

## 1. Step 1 — Audit (trace, before any implementation)

### 1.1 The walker and its call sites

```
scheduler (src/instrumentation.ts:99-100, NEXT_RUNTIME==='nodejs' guarded)
  and POST /api/signal/run (src/lib/signal/service.ts:112)
    → trackPaperSignals(db, {symbol})          (src/lib/signal/paper.ts:265)
        scans SignalEvaluation (outcome BUY_SETUP/SELL_SETUP, levels ≠ null,
        createdAt DESC, take ≤ 200)            (paper.ts:285-293)
        per row:
          parseSetupRow — requires levels/decision/known/expiry JSON        (paper.ts:92-133)
          Phase 10.3-A dedup: evaluationId lookup → resolved ⇒ immutable skip;
          no row ⇒ setupFingerprintFromEvidence ⇒ create (P2002 ⇒ suppressed)
                                                    (paper.ts:301-375)
          ADVANCE (the walk under audit):
            decisionSec = paper.decisionCandleTimeUtc                    (paper.ts:379)
            expirySec   = paper.expiryUtc                                (paper.ts:380)
            uptoSec     = min(expirySec, nowUtcSec)                      (paper.ts:381)
            fetch MarketCandle: symbol, M15, isForming=false,
              validationStatus='VALID', source='bridge-mt5',
              candleTimeUtc ∈ (decisionCandleTime, uptoSec]  ← OPEN-time bounds
              orderBy asc, take ≤ 500                                    (paper.ts:386-397)
            OHLC sanity re-validation at read time                       (paper.ts:398-404)
            resolvePaperOutcome(dir, entry, SL, TP, invalidation, bars,
              expirySec, nowSec)  — pure walk                            (paper.ts:161-239)
              per bar: SL touched ⇒ stopped (collision if TP too);
                       M15 close through broken level ⇒ invalidated;
                       TP touched ⇒ targeted
              after loop: now ≥ expiry ⇒ expired (exit = lastClose, may be null)
              else unresolved
            update row (observations, lastChecked, details; on resolution also
              status/outcome/exitPrice/P&L/R — resolved rows never re-walked)
                                                    (paper.ts:417-471)
```

No other DB-based forward walker exists: the backtest simulator (`src/lib/backtest/validation.ts:404-483`) walks an in-memory causal bar sequence (entry at the NEXT bar's open — "no look-ahead" by construction, Phase 10.1-verified) and has **no expiry walk at all**; `forward.ts` only aggregates finished paper rows.

### 1.2 Timestamp semantics — how stored, how compared (documented)

| Field | Meaning (source) | Storage | Compared how |
|---|---|---|---|
| `SignalEvaluation.decisionCandleTimeUtc` | **OPEN time** of the M15 decision bar — the last closed bar the engine evaluated (`core.ts:376,557`; engine gate excludes forming bars, `core.ts:296-297`) | DateTime (UTC, bar-open anchored, M15 grid: multiple of 900 s) | walk lower bound `candleTimeUtc > decisionCandleTimeUtc` (paper.ts:393) |
| `SignalEvaluation.setupKnownAtUtc` | decision bar **CLOSE** = decisionOpen + 900 s (`core.ts:296,377`) — earliest instant the setup is knowable | DateTime | persisted on the paper row; NOT used by the walk (audit finding, §1.5-A) |
| `SignalEvaluation.expiryUtc` | setupKnownAt + 12×900 s = decisionClose + 3 h (`core.ts:549`) | DateTime | walk upper bound via `min(expiry, now)` on **open** times (paper.ts:381,393) |
| `SignalEvaluation.createdAt` | evaluation-row creation instant (Prisma `@default(now())`, local clock at persist) | DateTime | copied to the paper row as `signalCreatedAtUtc` at creation; **never used by the walk** (the defect under audit) |
| `PaperSignalOutcome.signalCreatedAtUtc` | creation instant of the evaluation that created the paper row (frozen; the row's own anchor, schema.prisma:334) | DateTime (required, non-null) | **not consulted by the walk** before this phase |
| `MarketCandle.candleTimeUtc` | bar **OPEN** time, UTC seconds, broker→UTC offset applied inside the bridge (Exness trial empirically UTC+0, runtime-verified from live quotes — `mini-services/mt5-bridge/src/manager.ts:21-24`), served as `t` (`index.ts:149`) | DateTime + unique `(symbol, timeframe, candleTimeUtc)`; `isForming`/`validationStatus`/`source` encode closedness & verification | compared with `gt/lte` against decision/expiry/now on **open** instants |
| A bar's information availability | a bar is knowable only at its **close** = open + 900 s | derived, never persisted as a field | **never compared anywhere** before this phase (the core gap) |

**Clock domains:** bar times are broker-UTC (offset-verified, grid-quantized); `createdAt`/`now` are the local persist/track clock. Both UTC, but independent sources — hence raw equality comparisons across domains are unsafe without grid/ordering integrity checks (see invariant §2.4).

### 1.3 Edge-case examination (bridge latency / late / missing / duplicate / timezone)

- **Bridge latency (F4's path):** a sync can succeed while the bridge serves a stale candle window (the just-closed bar missing). Gate 5 then loads an **older decision candle**, and the evaluation is created LATE relative to real market time. Later syncs/backfills insert the missing bars (idempotent upserts — `ingestion.ts:398-412`). The walk then fetches everything in `(decisionOpen, min(expiry, now)]` — **including bars that closed before the evaluation row existed**. The paper P&L then mixes an evaluation-time entry price (`levels.entryReference`, sampled at creation) with price action that predates the publication instant → chronology inversion. Bounded: ≤ 13 bars (see next point). Live proof of the precondition (stale-window disagreement between freshness layers): the 2026-10-15 14:58 BLOCKED rows. **No production occurrence of the full path is claimed — 0 SETUP evaluations / 0 paper rows exist (honest: analysis, not observation).**
- **Late-arriving candle:** same mechanism as above from the walk's perspective — the bar arrives after the signal; under the current code it is walked regardless of having closed pre-creation. The fix (§2) makes its *close instant* the admission criterion.
- **Missing candle (gaps):** bars absent from the window (incl. the normal 75-min daily break, one Phase-10.1-verified fill crossed it) are honest non-observations today: fewer observations, expiry exits at the last *available* close, `null` exit when none. **Not** a chronology violation — gaps must NOT become errors (existing semantics preserved).
- **Duplicate timestamp:** impossible at DB level (unique `(symbol, timeframe, candleTimeUtc)`); but the pure walker received no duplicate/ordering guard of its own — added fail-closed (§2.4).
- **Timezone & timeframe alignment:** bridge applies the verified broker→UTC offset (UTC+0 for this Exness trial, re-verified from live quote timestamps); ingestion validates M15 grid membership (`expectedCandleTimes`, `validation.ts:258`); the walk hard-codes `timeframe: 'M15'`. Misaligned/non-integer bar timestamps would indicate corruption — previously trusted silently; now fail-closed (§2.4).
- **Prematurely-closed bar** (`isForming=false` while its close instant is still in the future): impossible through the normal ingestion path, but a corruption class the old walk trusted; now excluded defensively (availability bound §2.3).

### 1.4 F4 trigger path (Phase 10.2 audit §2-F4) — precise restatement

`paper.ts:316-334` (old line numbers) anchored the walk to the decision candle only. Trigger path, end-to-end:

1. scheduler tick T: sync OK but bridge window lags → decision candle D (older than the truly newest closed bar);
2. evaluation created at T (createdAt = T) with `levels.entryReference` from the T-quote;
3. bars between D and T close (and backfill into `MarketCandle`) — their information predates T;
4. `trackPaperSignals` walks `(D, min(expiry, now)]` → consumes those bars → outcome may be decided by pre-publication price action (and the entry price is a T-price compared against pre-T extremes — inverted chronology).

Also found during this audit (not in F4): the upper bound `candleTimeUtc <= min(expiry, now)` admits a bar **opening exactly at expiry** — a 13th bar whose entire range lies *after* the 12-bar/3 h expiry window (the documented expiry window is bars opening in `[setupKnownAt, expiry)`). It could stop/target a trade with post-expiry action, and its close could become an 'expired' exit price. Both bounds are corrected by the invariant below. **No production occurrence possible to date (0 paper rows).**

### 1.5 What Step 1 established (facts, no implementation yet)

- **A.** The walk used **open-time** comparisons only; the information-availability instant (bar close) was never computed or compared anywhere.
- **B.** `signalCreatedAtUtc` is persisted on every paper row since Phase 10 (required column) — **no migration is needed** to anchor the fix (contingency design if it had been missing: additive nullable column + backfill from the linked evaluation's `createdAt` + fail-closed NULL handling — recorded, not needed).
- **C.** `setupKnownAtUtc` (decision close) is persisted and engine-pinned (`decisionOpen + 900`) but never enforced on the paper row — usable as a chronology integrity anchor.
- **D.** Candle timestamp comparison ALONE is insufficient (open vs close vs creation vs DB-availability vs clock domains) — formalized in §2.5.

---

## 2. Step 2 — The Temporal Invariant (written BEFORE implementation)

### 2.1 Invariant

> **PAPER-WALK CHRONOLOGY INVARIANT (v1, setup-chronology/1)** — *A paper outcome may be determined ONLY by market information that became available strictly AFTER the paper signal's creation instant.* For a paper row *P* and a closed M15 bar *B* with open *T_o* and close *T_c = T_o + 900 s*:

1. **Publication lower bound (anti-look-ahead):** *B* may contribute to *P*'s outcome **only if `T_c > P.signalCreatedAtUtc`**. A bar closing at or before the creation instant is pre-publication information: it can neither validate nor invalidate a signal that did not yet exist, and it must never meet an entry price sampled at creation. *(Excluded bars are skipped, not errors — in the lag scenario they legitimately exist.)*
2. **Expiry upper bound:** *B* may contribute **only if `T_o < P.expiryUtc`** — the walk window is exactly the 12-bar expiry window (bars opening in `[setupKnownAt, expiry)`). Price action at/after the expiry instant can never resolve the setup.
3. **Availability bound:** *B* may contribute **only if `T_c ≤ now`** at walk time (defense-in-depth on top of `isForming = false`; a bar cannot be used before it has truly closed).
4. **Chronology integrity — fail-closed:** the walker refuses to advance *P* (records a row error, leaves the row open, **never resolves on ambiguous data**) when any of:
   - `P.signalCreatedAtUtc < P.setupKnownAtUtc` — creation allegedly before the setup was knowable (impossible chronology / corrupt row);
   - `P.setupKnownAtUtc ≠ P.decisionCandleTimeUtc + 900 s` — frozen anchor inconsistency;
   - the fetched bar sequence is not strictly ascending, contains duplicate timestamps, or contains a timestamp off the M15 UTC grid — unreliable ordering.
   **Gaps (absent bars, incl. the daily break) are NOT errors** — they are honest non-observations (existing semantics: fewer observations; expiry handles the null case; nothing is fabricated).

### 2.2 Timestamp semantics (defined, unambiguous)

- `decisionCandleTimeUtc` = OPEN of the M15 decision bar. The decision bar itself is **never** walked.
- `setupKnownAtUtc` = decision bar CLOSE = `decisionCandleTimeUtc + 900 s`. Earliest instant the setup could be known. Always ≤ `signalCreatedAtUtc` (enforced fail-closed).
- `signalCreatedAtUtc` (paper row) = creation instant of the SignalEvaluation row that created the paper row — the same evaluation whose quote produced the frozen `entryReference`. In the normal cadence (scheduler 300 s) it lies in `(setupKnownAt, setupKnownAt + ~300 s]`, and the first walkable bar closes at `setupKnownAt + 900 s` — so **in the normal cadence the invariant selects exactly the same bars as before** (proven by the before/after comparison, §4). It binds only in the lag case.
- Equal-instant rule: `T_c > creation` is STRICT. A bar closing exactly at the creation instant is excluded (conservative; at most one bar, and only in a same-second edge that the normal cadence never produces).

### 2.3 What the invariant deliberately does NOT change (frozen)

- **Expiry formula & semantics:** `expiry = decisionClose + 12×900` — untouched. The upper-bound fix *enforces* the documented 12-bar window (the old code could touch a 13th, post-expiry bar — a boundary defect against its own documentation; corrected and pinned by test T7; every affected outcome is documented in §4, none overwritten).
- **Frozen setup geometry:** `entryReference / stopLoss / target / invalidationLevel / riskPrice` are never altered by the walk (pinned by test T9).
- **Phase 10.3-A dedup/creation semantics:** unchanged (the invariant applies to the ADVANCE step only).
- **Phase 10.2 protocol & aggregation code:** `paper-protocol.ts`, `forward.ts` byte-untouched; aggregation input compared before/after (§4).
- **Cost model, collision rule, invalidation rule, conservative order:** unchanged.

### 2.4 Why comparing candle timestamps alone is NOT sufficient (source-level answer)

1. **Open ≠ availability.** A bar's open time says nothing about when its information existed; it exists at close. The old walk compared open times only (paper.ts:393) — hence both the pre-creation and post-expiry admissions.
2. **Availability lives in DB state, not timestamps.** `isForming=false / validationStatus='VALID' / source='bridge-mt5'` encode closedness and provenance; a prematurely-closed or unverified bar must be excluded regardless of its timestamp (invariant §2.1.3 + existing filters).
3. **Two clock domains meet at the bound.** Bar times are broker-UTC (offset-verified, grid-quantized); creation is the local persist clock. Comparing them is only sound with grid-alignment and strict-ordering integrity checks — which is why violations fail closed instead of being trusted (invariant §2.1.4).
4. **The creation instant is a different event than the decision close.** Anchoring to `setupKnownAt` alone would still admit bars that closed between the decision close and a lagged creation. Only the persisted `signalCreatedAtUtc` bounds the *publication*.

### 2.5 Implementation shape (minimal, additive)

- `resolvePaperOutcome(...)` gains one parameter `signalCreatedUtcSec` (pure function; enforces bounds 1–3 + integrity checks 4 internally — the contract lives where the walk lives, directly unit-testable).
- `trackPaperSignals` advance step: fail-closed chronology prechecks (integrity rule), query lower bound `open > max(decisionOpen, creation − 900 s)`, upper bound `open < expiry` (and `open ≤ now`), passes `createSec` to the resolver; `lastCheckedBarTimeUtc` refined to the last **walked** bar (no consumer outside paper.ts — verified).
- **No schema change, no migration** (`signalCreatedAtUtc` already required on every row — §1.5-B).
- Existing test fixtures gain explicit production-faithful `createdAt` values (normal cadence) — disclosed in §3.

*(Test-first: the regression suite below was written and committed to fail against the baseline walker BEFORE the implementation was applied.)*

---

## 3. Step 3 — Regression tests (written first) and results

### 3.1 Test-first process (honest red→green)

`tests/signal/paper-chronology.test.ts` (28 tests) was written BEFORE the implementation and run against the Phase 10.3-A walker: **14 pass / 14 fail** — every failure was a new chronology behavior (pre-creation bars walked, no fail-closed throws, post-expiry bar resolving, corrupt rows advancing). After the implementation: **28/28 pass**. (Fixture-collision and clock-region defects found during the red phase were fixed in the TEST file — disclosed: unique structure-event levels per test [fingerprint inputs], private decision-time regions with non-overlapping bar windows, row-scoped assertions, private track clocks where a row must stay open.)

### 3.2 Scenario coverage → results (all PASS, synthetic fixtures, isolated test DB)

| # | User-required scenario | Test(s) | Result |
|---|---|---|---|
| 1 | Signal-এর আগের candle বাদ পড়ে | T1 pure (lag: pre-creation SL bar excluded → later TP decides; all-pre-creation → expired/null) + T1/T4 DB (F4 end-to-end) | PASS |
| 2 | Decision candle ও পরবর্তী candle ordering | T2 DB (candle AT decision time never resolves) + T2 pure (out-of-order / duplicate / off-grid → throw) | PASS |
| 3 | Creation-এর পরে প্রথম বৈধ candle নির্বাচন | T3 pure ×3 (mid-bar creation → bar1 walked; creation == bar1 close → excluded [strict >]; +30 s → walk starts bar2) | PASS |
| 4 | Bridge latency / delayed candle → no look-ahead | T4-availability pure (bar closing after `now` skipped; closing exactly at now walked) + T1/T4 DB (backfilled pre-creation bars with `receivedAtUtc` AFTER creation — excluded by candle-time bound regardless of arrival) | PASS |
| 5 | Missing / out-of-order candle → fail-closed | T5 DB ×4 (gap = honest non-observation, no error; misaligned timestamp → row error, stays open; setupKnownAt ≠ decision+900 → row error; createdAt < setupKnownAt → row error) | PASS |
| 6 | Duplicate candle / repeated evaluation → no double-count | T2 pure (duplicate timestamps → throw) + T6 DB (resolved row immutable across later passes) + 10.3-A S-series still green (fingerprint-path immutability) | PASS |
| 7 | Expiry boundary সঠিক | T7 pure ×4 (bar OPENING at expiry never walks/resolves; 12th bar closing AT expiry IS walked; now<expiry → unresolved; now==expiry → expired) + T7 DB (post-expiry SL bar cannot stop; exit = last in-window close; `lastCheckedBarTimeUtc` = last WALKED bar) | PASS |
| 8 | Restart/recovery → no re-/mis-resolution | T8 DB ×2 (resolved row byte-stable across later passes with NEW bars; open row idempotent at same clock) | PASS |
| 9 | Frozen geometry অপরিবর্তিত | T9 DB (entryReference/stopLoss/target/invalidationLevel/decision/known/expiry/created all equal creation-time values after resolution) | PASS |
| 10 | Legacy rows ও Phase 10.2 aggregation | T10 DB ×2 (legacy no-fingerprint row walks identically, never backfilled; applyFirstOpenRule counts 1 + repeats 2 over chronology-correct rows) | PASS |

### 3.3 Full-suite verification

- **`bun test`: 364/364 pass, 0 fail** (336 pre-existing incl. all Phase 10.3-A S/D-series + 28 new; 1,507 expect() calls, 21 files).
- **eslint: clean. tsc (app): 0 errors. tsc (bridge): 0 errors. Build NOT run (sandbox rule).**
- **Disclosed fixture update in `tests/signal/paper.test.ts`:** (a) `insertSetupEvaluation` now takes a required `createdAtSec` (persisted explicitly, normal cadence = decision close + 300 s) — production-faithful; previously `createdAt` defaulted to the real wall clock, which under the new publication bound would have excluded every fixture bar (the fixture now matches what production rows have always carried). (b) the 9 pure `resolvePaperOutcome` calls pass the new `signalCreatedUtcSec` argument. All original assertion intents preserved.
- `tests/signal/setup-identity.test.ts` (Phase 10.3-A): **unchanged, still green** — its explicit `createdAtSec` values were already normal-cadence.

---

## 4. Step 4 — Before/after verification on the same frozen dataset

### 4.1 Method

`scripts/phase10.3b-chronology-comparison.ts` runs, over ONE seeded dataset in an isolated throwaway DB (`db/test-chronology-103b.db`, deleted after): the **OLD walker** — `scripts/phase10.3b-legacy-walker.ts`, a byte-identical snapshot of `src/lib/signal/paper.ts` @ 8173751 (only the 5 import specifiers rewritten to script-relative paths; `git show 8173751:src/lib/signal/paper.ts | diff -` verified) — then resets `PaperSignalOutcome` only (SignalEvaluation/MarketCandle untouched, legacy paper row re-seeded) and runs the **NEW walker** over the identical dataset. **MOCK DISCLOSURE: the dataset is synthetic (18 evaluations, 47 candles) — clearly labeled, never broker data.**

### 4.2 Row-by-row results (frozen dataset)

**IDENTICAL — 7/14 rows — every normal-cadence row, byte-for-byte (outcome, exit, resolution bar, observations, net P/L, R):**

| Row | Scenario | Both walkers |
|---|---|---|
| A1 | normal-cadence stopped @bar2 | stopped, exit 2640, obs 2 |
| A2 | normal-cadence targeted @bar2 | targeted, exit 2670, obs 2 |
| A3 | normal-cadence invalidated @bar1 | invalidated, exit 2644.2, obs 1 |
| A4 | normal-cadence expired (in-window bars only) | expired, exit 2657, obs 2 |
| A5 | normal-cadence open | open, obs 1 |
| E | legacy row (no fingerprint, per-evaluation path) | stopped, exit 2640, obs 1 |
| F1 | repeated evaluations, normal cadence → 1 deduped row | stopped @bar1, obs 1 |

→ **The normal production cadence (scheduler 300 s: creation between decision close and the first post-decision bar close) selects exactly the same bars and produces identical outcomes — the core no-regression proof.**

**CHANGED — 7/14 rows — every change is an edge-case correction, each documented:**

| Row | Scenario | OLD (baseline 8173751) | NEW (this phase) | Why changed |
|---|---|---|---|---|
| B1 | lag: 3 pre-creation SL bars + post-creation TP bar | stopped 2640 @bar1 (pre-creation!) | **targeted 2670 @bar4**, obs 1, net +19.72 | publication bound: bars closing ≤ creation excluded — the F4 look-ahead itself |
| B2 | lag: ALL bars pre-creation, expiry passed | expired exit 2658 (pre-creation close) | **expired exit null** (unobservable) | no post-publication information exists — nothing fabricated |
| B3 | creation AFTER expiry | stopped 2640 @bar1 (pre-creation) | **expired exit null** | same; the setup was dead before it was published |
| C1 | 13th bar (opens AT expiry) SL-hit | **stopped** 2640 @13th bar, obs 13 | **expired** exit 2652 (12th close), obs 12 | expiry upper bound: post-expiry price action can never resolve a setup (boundary defect corrected) |
| C2 | 13th no-hit bar | expired exit **2659** (post-expiry close), obs 13 | expired exit **2652** (in-window close), obs 12 | expired exit must be the last IN-WINDOW close |
| F2 | repeated evals; the CREATOR (newest, createdAt-DESC scan) was created after bar1 closed | stopped 2640 @bar1 (pre-creation of the row's own geometry) | **targeted 2670 @bar2**, obs 1 | the frozen entryReference is the creator evaluation's quote ⇒ the bound is the creator's creation instant — self-consistent (see residual risks R2) |
| G | corrupt off-grid bar (SL-touch) | **stopped** 2640 on the corrupt bar | **open, row error** (fail-closed) | ambiguous timestamps never resolve anything |

**No historical outcome was overwritten:** production has **0 paper rows** — nothing exists to re-walk; the synthetic dataset rows live only in the throwaway comparison DB. **No migration/backfill is needed or proposed** (if paper rows had existed, a separate proposal would be required to decide whether to re-walk them — explicitly out of scope).

### 4.3 Phase 10.2 aggregation over the same dataset (code untouched)

| | OLD outcomes | NEW outcomes |
|---|---|---|
| all rows | counted 14, repeats 0, trades 13, net −45.44, sumR −4.544 | counted 2, repeats 12, trades 1, net +19.72 (the fail-closed G row stays OPEN and holds the single paper position) |
| excluding the corrupt-bar G row | counted 13, repeats 0, trades 12, net −35.16 | counted 6, repeats 7, trades 5, net +2.60, sumR +0.26 |

`paper-protocol.ts` / `forward.ts` are byte-untouched (verified by git diff) — the aggregation differs **only** through the corrected outcome rows above. The synthetic edge-cases were deliberately loss-flavored (the old walker turned pre-creation SL hits into losses), so the corrections flip several losses to unobservable/targeted — this is the dataset's design, not a performance claim.

### 4.4 LIVE production evidence (read-only; synthetic vs real kept separate)

- **`PaperSignalOutcome`: 0 rows. SETUP evaluations: 0 of 26.** The pre-registration state is intact — **no paper walk has ever executed in production, so no production outcome can change.** Live forwardPaper verdict: `IN_PROGRESS`, 0/20 counted, 89.93 days remaining (unchanged).
- **Shadow bar-selection over the 24 real evaluations with decision candles (against the 2,012 real verified closed M15 candles): 23/24 identical; 1 differing** — `cmv9nznd90dguqdisp34h91io` [NO_SETUP], decision 2026-10-15T14:30Z, created 14:59:12Z: OLD would select 13 bars, NEW 12. The difference is exactly the bar opening AT the hypothetical expiry (the C-scenario boundary correction) — a REAL persisted instance of the 13th-bar shape (the evaluation is NOT lagged: created 48 s before the first post-decision bar closed).
- **Evaluations created after their first post-decision bar closed (the F4 lag path): 0 of 24.** The F4 trigger path has never materialized in persisted evaluation timestamps — consistent with the Phase 10.2 audit's "analysis, not observed" stance. (No claim is made that it cannot happen; the invariant now makes it harmless.)

### 4.5 Synthetic vs production evidence — explicitly separated

- Synthetic: §4.2/§4.3 (frozen dataset, both walkers, full outcome comparison). Real: §4.4 (row counts, verdict inputs, shadow bar-selection). The two are never mixed; no synthetic number is presented as market data.

---

## 5. Phase 10.2 protocol-integrity statement

- **Pre-registered constants — UNTOUCHED:** activation `2026-10-15T16:30:00Z`, 90-day window (to 2027-01-13T16:30Z), 20-trade floor, top-1 concentration 35%, consecutive-loss limit 8, drawdown limit 10R — `paper-protocol.ts` byte-identical to the pre-registration commit `8d94a00` (git-diff empty, verified this session).
- **Aggregation & verdict code — UNTOUCHED:** `forward.ts`, `applyFirstOpenRule`, `computeForwardPaperMetrics`, `evaluateForwardPaperVerdict` all outside the changed-file list; the full protocol test suite (20 pre-registration + 8 forward/API tests) passes unchanged.
- **Verdict inputs on the LIVE dataset — UNCHANGED:** 0 eligible rows / 0 counted / IN_PROGRESS before and after (the walker change cannot affect a table with zero rows).
- **Strategy & engine — UNTOUCHED:** `core.ts`, `rules.ts`, `types.ts`, `setup-identity.ts`, `config.ts` (incl. `rewardRisk` 2.0, expiryBars 12, all thresholds) — git-diff empty. Strategy version unchanged (`hybrid-structure-retest/9.0.0`).
- **Phase 10.3-A dedup semantics — UNTOUCHED:** setup-identity module, unique constraint, creation/suppression flow unchanged; its 19-test suite passes unchanged.
- **Expiry semantics — ENFORCED, not changed:** the formula (decision close + 12×900) is untouched; the walk now actually respects it (the old code could walk a 13th, post-expiry bar — a defect against the documented semantics, corrected + pinned by T7).
- **Four execution locks — INTACT:** phase 1 < 11, `read_only`, `EXECUTION_ARMED=false`, `ALLOW_EXECUTION=false` → `executionLocked=true`; dashboard shows LOCKED; no order/trade/position code added anywhere (diff contains no endpoints, no execution paths).

---

## 6. Changed files, commit, residual risks, declarations

### 6.1 Changed files

| File | Change |
|---|---|
| `src/lib/signal/paper.ts` | +107/−25 — the temporal invariant: `resolvePaperOutcome` gains `signalCreatedUtcSec` + integrity throws + the three availability bounds + `lastWalkedBarTime`; advance step gains the two fail-closed chronology prechecks, the corrected query bounds (`gt max(decisionOpen, creation−900)`, `lt expiry`, `lte now`), and documents `signalCreatedUtcSec`/`walkLowerBoundOpenUtcSec` in the row's details JSON; module header documents the invariant |
| `tests/signal/paper-chronology.test.ts` | NEW — 28 regression tests (all 10 user scenarios), written test-first |
| `tests/signal/paper.test.ts` | +34/−25 — disclosed fixture update (explicit production-faithful `createdAtSec`; 9 pure calls pass the new argument; assertion intents preserved) |
| `scripts/phase10.3b-legacy-walker.ts` | NEW — byte-identical snapshot of `paper.ts` @ 8173751 (imports only rewritten), comparison artifact |
| `scripts/phase10.3b-chronology-comparison.ts` | NEW — the §4 before/after comparison (throwaway DB; live read-only section) |
| `audit/phase10.3b-paper-walk-chronology.md` | NEW — this report |
| `audit/phase10.3b-{desktop,mobile}.png` | NEW — browser-verification screenshots |

**No schema change, no migration, no API change, no strategy/protocol/lock change** (all verified by git diff against the frozen list).

### 6.2 Local commit

- Local commit: the single phase10.3-B commit on top of `8173751` (see `git log`; final hash reported in the session summary — deliberately not self-referenced here, since embedding it would change it); **NO PUSH** (GitHub push remains gated on credentials via the platform's secure mechanism — never chat).

### 6.3 Residual risks (honest)

- **R1 — Live dedup/bound behavior unobservable until the first SETUP:** 0 paper rows exist; every production-path claim above is code- and test-level, plus the read-only shadow selection. The first real SETUP will be the first live exercise of the full path.
- **R2 — Paper-row creation anchor is the NEWEST evaluation (10.3-A createdAt-DESC scan):** combined with the publication bound, bars that closed between the FIRST and the LAST evaluation of a setup are excluded (F2 scenario). This is self-consistent (the row's geometry IS the creator's quote) and conservative, but it means a cluster whose newest evaluation is lagged loses observability of the pre-creator bars. Changing the creation anchor to the EARLIEST evaluation would be a Phase 10.3-A semantics change — deliberately NOT done (would need a separate proposal).
- **R3 — Near-boundary publication (creation within seconds of a bar close):** the strict `close > creation` rule excludes a bar closing in the same second as creation — at most one bar, only in a cadence the scheduler does not produce; conservative direction.
- **R4 — Corrupt rows fail closed forever:** a row with genuinely inconsistent anchors (e.g. `setupKnownAt ≠ decision+900`) will error on every pass and never resolve — honest unobservability, but it will be visible as a persistent row error until the data is corrected at the source.
- **R5 — The 13th-bar correction changes one real selection shape:** exactly 1 of 24 real evaluations (a NO_SETUP) would have had a 13-bar walk under the old bounds — moot in production (no SETUP rows), documented for completeness.
- **R6 — Bridge-lag path never observed:** 0 lagged evaluations to date; the invariant protects against it but production evidence of the protection working remains pending (R1).

### 6.4 Declarations

- **NO git push performed** (local commit only, per instruction).
- **NO order execution capability added** — no order/trade/position endpoints or code anywhere; bridge remains GET-only (405 non-GET); four execution locks intact.
- **NO secret or `.env` value read into output/log** — the comparison script parses only the DATABASE_URL *file path* internally and never prints it; secret-pattern scans over the full diff: 0 hits.
- **NO database deletion** — production DB accessed read-only (SELECTs); the comparison used a throwaway DB file, deleted afterward; no legacy record, snapshot or verdict history rewritten.
- **NO historical outcome overwritten** — 0 paper rows existed; nothing was backfilled or re-walked.

— End of report —
