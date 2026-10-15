# Phase 10.3-A — Setup Identity & Deduplication (Implementation Report)

- Task: Phase 10.3-A (user-authorized scope)
- Baseline verified before work: HEAD `3bea601` (audit report `audit/phase10.2-signal-spec-audit.md`),
  clean working tree, db:push-managed migration state, 4 execution locks intact — all matched; no stop condition triggered.
- Design note (written BEFORE implementation, per protocol): `audit/phase10.3a-setup-identity-design.md`
- Implements audit finding F3 (MEDIUM): no first-class setup identity → parallel paper rows possible.

## 1. What was implemented

1. **`src/lib/signal/setup-identity.ts`** (new, pure): `setupFingerprint = sha256({identityVersion: 'setup-identity/1', symbol, timeframe, strategyVersion, setup:{type,direction,level,breakCandleTimeUtc}})`. Deterministic — no clock/network. `setupFingerprintFromEvidence` returns `null` when the identity is incomplete (never guessed). Excluded from the key by design (documented in the note): decision candle, barsSinceBreak, evaluation instant, quote, indicators, anchor/levels, outcome — variable per evaluation; the live 2026-10-15 cluster (ONE BOS/bearish setup evaluated 14+ times across 4+ decision candles) proves the same setup legitimately spans all of them.
2. **Additive migration** (reviewed SQL before application — exactly 2 `ADD COLUMN` + 1 `CREATE UNIQUE INDEX`, no drop/rewrite/backfill):
   - `SignalEvaluation.setupFingerprint TEXT NULL` (NOT unique — repeated evaluation rows remain the append-only audit trail).
   - `PaperSignalOutcome.setupFingerprint TEXT NULL @unique` — **database-level race guard**: ONE paper row per logical setup EVER (open/counted/resolved all block re-creation). SQLite allows multiple NULLs → legacy rows never conflict (17 legacy rows live, all left NULL).
   - Record: `prisma/migrations/20261015120000_phase10_3a_setup_fingerprint/migration.sql`; applied via `bun run db:push` (project practice); post-push `prisma migrate diff` = empty; data integrity verified (row counts before/after, unique-index behavior: duplicate fingerprint → P2002, two NULLs coexist).
3. **Persistence**: `saveSignalEvaluation` persists the fingerprint (NULL for no-event rows — includes WAIT/NO_SETUP repeats for traceability); service passes `rules.executionTf`. `strategyVersion` comes from each row itself (cross-era self-consistency).
4. **`trackPaperSignals` dedup flow**: per-evaluation lookup first (legacy rows keep the old path, never backfilled); no row → compute fingerprint → `create` with it; **P2002 → counted as a suppressed duplicate, never an error, never a second row**; if the found row is resolved → immutable skip (never re-walked/re-stamped). The advance now uses the **paper row's OWN frozen geometry** (anchor = its own decision candle — never a later evaluation's; riskPrice recomputed by the engine's exact formula). New result counter `duplicatesSuppressed`.
5. Fail-closed: a SETUP evaluation with an incomplete structure-event identity gets NO paper row + a recorded error (D3) — never an ambiguous dedup key.
6. `src/instrumentation.ts`: the Phase-10 paper import gained the same official `NEXT_RUNTIME === 'nodejs'` guard used by the Phase 10.2 signal import (setup-identity's node:crypto entered paper.ts's chain; Edge compile now clean again — dev.log verified error-free after restart).

## 2. Test evidence

New file `tests/signal/setup-identity.test.ts` — 19 tests, all user-mandated scenarios:
- **S1** same setup, same decision candle, repeated evaluation → 1 row; second evaluation suppressed; first emission's geometry frozen.
- **S2** concurrent tracker passes → exactly 1 row (P2002 path); plus direct constraint-scope proof: same fingerprint blocked while OPEN, after RESOLUTION (ever-semantics), different fingerprint allowed (per-value scope) — each P2002 asserted.
- **S3** same setup on a NEW decision candle → same fingerprint (pure assert), no second row, the same row advances with its OWN anchor (observations=1 proves the walk is anchored at the row's decision candle, not the later evaluation's).
- **S4** new structure event after invalidation → own row (newly NOT dropped); first-open classifies it a repeat while the first is open (aggregation over both rows asserted via `getForwardPaperStatus`).
- **S5** BUY vs SELL → distinct fingerprints (pure + DB via S4's bullish/bearish rows).
- **S6** strategy version change → distinct fingerprints; same event under a new version gets its own row (lookup uses the row's own strategyVersion).
- **S7** restart/recovery → fresh pass never duplicates (evaluationId lookup needs no create; P2002 exercised by the re-emission); persisted fingerprint === fresh recomputation from the row's own evidence; resolved row never re-stamped (resolvedAtUtc byte-identical after a re-emission).
- **S8** legacy NULL-fingerprint rows keep the per-evaluation path, never backfilled; pre-registered first-open/metrics/verdict produce identical results over mixed rows (20 protocol tests unmodified and green).
- **D1** determinism/sensitivity (1e-9 level change → different hash; incomplete identity → null; NaN/string-typed level → null).
- **D2** `saveSignalEvaluation` persists exactly what the tracker recomputes (SETUP row + NULL for NO_STRUCTURE_BREAK row).
- **D3** fail-closed unidentifiable setup → no row + recorded error.
- **D4** BEFORE/AFTER on the SAME persisted dataset (below).

Disclosed fixture update in `tests/signal/paper.test.ts` (assertions unchanged in intent; count unchanged 17/17):
- seeds now carry the complete structure-event identity the real engine always emits (breakCandleTimeUtc derived per test → distinct setup identities);
- `riskPrice` now derived from geometry (the old fixture said 12 while entry 2650/SL 2640 implies 10 — an internal inconsistency; the new tracker recomputes risk from the frozen geometry exactly like the engine, so the rMultiple assertion moved to /10). For real engine rows `levels.riskPrice === entryReference − stopLoss`, so this is fixture-only.

**Results: `bun test` 336/336 pass (317 pre-existing + 19 new), `bun run lint` clean, `tsc --noEmit` 0 errors (app), bridge tsc 0 errors. No failure hidden.**

## 3. BEFORE/AFTER comparison on the same persisted dataset

**Live DB (read-only script `scripts/phase10.3a-dedup-comparison.ts`, run 2026-10-15T17:30:18Z):**
- 17 raw SignalEvaluation rows → **2 distinct logical setups** by fingerprint (15 rows identifiable, 2 BLOCKED without identity).
- The live cluster: **14 evaluations of ONE setup** (`BOS/bearish level=4144.821 break=2026-10-15T16:00Z`; WAIT[RETEST_PENDING] → NO_SETUP[ZONE_INVALIDATED]) spanning 16:23→17:26 across decision candles 16:00/16:15/16:30/16:45 — the old algorithm would have created one paper row per evaluation; the new algorithm creates one for the whole cluster.
- Paper rows: 0 exist (0 SETUP outcomes yet) → comparison degenerate 0→0 on live data — stated honestly. The meaningful proof is D4 (below) on a synthetic 11-row cluster shaped exactly like the live one.
- Forward verdict inputs: `eligibleRows=0, countedCompleted=0, repeatObservations=0` → IN_PROGRESS — **identical before/after** (pre-registered aggregation unchanged; Phase 10.3-A changes which FUTURE rows are created, never re-counts existing ones).
- Live cross-version consistency proof: the newest evaluation (created by the restarted server through the NEW code path) persisted fingerprint `730259ec7b36…` — byte-identical to the fingerprint recomputed from the legacy rows' evidence by the comparison script. Legacy 17 rows untouched (NULL), 2 new rows fingerprinted.

**D4 (same persisted dataset, synthetic 11-row cluster: 6 evaluations on decision candle X + 5 on Y):**
- Raw evaluations 11 → OLD algorithm 11 paper rows; NEW algorithm **1** (1 newlyOpened + 10 duplicatesSuppressed).
- First-open over both row sets: **counted = 1 both; metrics identical (netPnl −10.28, avgR −1.028, drawdown equal); verdict IN_PROGRESS both, same rulesVersion.**
- The ONLY verdict-input difference: `repeatObservations` 10 → 0 and `eligibleRows` 11 → 1 — the dedup removes exactly the rows the first-open rule would have disclosed as repeats; the counted trade is identical.

## 4. Phase 10.2 protocol integrity statement

- `src/lib/signal/paper-protocol.ts` **byte-identical** (not in the changed-file list): activation `2026-10-15T16:30:00Z`, 90-day window, 20-trade floor, 35%/8-loss/10R gates, first-open rule text, verdict ordering — all untouched. The 20 pre-registered protocol tests run unmodified and green.
- Live forward state before/after this work: 0 paper rows, 0 counted, IN_PROGRESS — unchanged.
- Strategy untouched: `core.ts`, `rules.ts`, `types.ts` not modified; `strategyVersion` unchanged (`hybrid-structure-retest/9.0.0`); no entry/SL/TP logic change (the tracker now reads the levels the row already persisted — no level was recomputed differently; riskPrice formula is the engine's own).
- Four execution locks intact: `config.ts` unmodified (phase < 11, TRADING_MODE=read_only default, EXECUTION_ARMED/ALLOW_EXECUTION default false); every evaluation row still records `executionLocked: true`; bridge still GET-only; diff scan for order/trade/position endpoints: **0 hits**.

## 5. Changed-file list

New: `src/lib/signal/setup-identity.ts`, `tests/signal/setup-identity.test.ts`, `scripts/phase10.3a-dedup-comparison.ts`, `prisma/migrations/20261015120000_phase10_3a_setup_fingerprint/migration.sql`, `audit/phase10.3a-setup-identity-design.md`, this report, `audit/phase10.3a-validation-{desktop,mobile}.png`.
Modified: `prisma/schema.prisma`, `src/lib/signal/persistence.ts`, `src/lib/signal/service.ts`, `src/lib/signal/paper.ts`, `src/instrumentation.ts`, `tests/signal/paper.test.ts`.
NOT touched: `paper-protocol.ts`, `core.ts`, `rules.ts`, `types.ts`, `forward.ts`, `config.ts`, `.env`, `db/custom.db` rows (additive columns only), bridge service.

## 6. Residual risks (disclosed)

1. **Identity-version boundary**: if the identity definition ever changes, `SETUP_IDENTITY_VERSION` must be bumped — rows hashed under different versions never dedupe (a same-setup row could appear across the boundary). Explicit, never silent.
2. **Backfill owner semantics**: in the live pipeline (tracker runs after every evaluation) the FIRST emission owns the paper row; in a recovery/backfill single pass the first-PROCESSED (newest) evaluation creates it. Deterministic either way; the live DB had 0 SETUP rows so no backfill ever occurred.
3. **Strategy-version boundary**: the same event under a new strategyVersion legitimately gets a second paper row (user scenario 6) — the one-position model stays enforced at aggregation by the untouched first-open rule.
4. **Live dedup effect unobservable yet**: 0 SETUP outcomes exist in live data (the cluster was WAIT/NO_SETUP); the first live SETUP will exercise the dedup in production. The synthetic D4 proof covers the semantics meanwhile.
5. **riskPrice source change**: paper P/L risk now recomputed from the row's frozen geometry (engine's exact formula) instead of the evaluation's `levels.riskPrice` — identical for all real engine rows; only the old test fixture was internally inconsistent (fixed, disclosed).
6. Setup identity uses the CURRENT execution-TF label at tracking time; a future TF change would come with a strategy version change (which is in the fingerprint), so no wrong-match is possible — misses only, which is the desired new-identity behavior.

## 7. Declarations

- **No push performed** — the commit is local only (push remains gated on GitHub credentials via the platform's secure mechanism, never chat).
- **No order execution** — no order/trade/position endpoint exists; none added; bridge GET-only; four locks verified intact.
- **No data loss**: additive columns + one unique index only; 17 legacy evaluation rows untouched (NULL fingerprints); 0 paper rows existed and 0 exist; no snapshot deleted; `.env` untouched; no credential/token/secret printed, logged or committed (pre-commit scan 0 hits).
- Verification: 336/336 tests, lint clean, tsc 0 errors (app + bridge), dev.log clean after restart (Edge guard fix), browser-verified (desktop 1280×800 + mobile 390×844, 0 page errors, no overflow, footer intact, honest-empty Phase 10.2 card).
