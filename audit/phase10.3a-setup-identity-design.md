# Phase 10.3-A — Setup Identity & Deduplication: Design Note (test-first, written BEFORE implementation)

- Task: Phase 10.3-A (user-authorized implementation scope)
- Baseline: commit `3bea601` (verified: HEAD match, clean working tree, 0 unpushed-file drift)
- Audit basis: `audit/phase10.2-signal-spec-audit.md` finding F3 (MEDIUM — no first-class setup
  identity; parallel paper rows possible) and §7 plan item 10.3-b
- Live evidence captured BEFORE this design (read-only SELECTs, `db/custom.db`, 2026-10-15):
  14 SignalEvaluation rows, 0 PaperSignalOutcome rows, 0 SETUP outcomes.
  **One logical setup — `BOS/bearish level=4144.821 break=2026-10-15T16:00:00Z` — was
  evaluated 11 times across 4 different decision candles (16:00 ×2, 16:15 ×3, 16:30 ×3,
  16:45 ×3) and 2 evaluation instants per candle.** This cluster is the ground truth the
  identity definition below must collapse to ONE identity.

## 1. What identifies "the same logical setup" (fingerprint payload)

`setupFingerprint = sha256(JSON.stringify(payload))` — deterministic, pure (no clock, no
network, no randomness). Payload fields (IN this order, exact names):

| Field | Source | Why it is identity |
|---|---|---|
| `identityVersion` | constant `setup-identity/1` | Explicit namespace. Identity-definition changes must bump this string — never a silent edit. Rows hashed under different versions never dedupe (disclosed residual risk). |
| `symbol` | evaluation row (`XAUUSDm`) | Different symbols are different setups by construction. |
| `timeframe` | execution TF label (`M15` from current `buildStrategyRules().executionTf`) | The setup lives on the execution TF. |
| `strategyVersion` | the evaluation row's OWN persisted `strategyVersion` (e.g. `hybrid-structure-retest/9.0.0`) | Same structure event under changed rules is a different setup (user regression scenario 6). Using the row's own version keeps cross-era rows self-consistent. |
| `setup.type` | `evidence.structureEvent.type` (`BOS`/`CHoCH`) | The structure event's identity — all four fields together uniquely identify one event: two different events cannot share break candle + level + type + direction (the scan emits events in order; this tuple is the event). |
| `setup.direction` | `evidence.structureEvent.direction` (`bullish`/`bearish`) | BUY vs SELL separation (user regression scenario 5). |
| `setup.level` | `evidence.structureEvent.level` (number) | The broken level defines the entry zone. |
| `setup.breakCandleTimeUtc` | `evidence.structureEvent.breakCandleTimeUtc` (ISO string) | The bar whose CLOSE broke the level — the event's time anchor. A NEW break (different candle and/or level) is a NEW setup (user regression scenario 4). |

## 2. Fields deliberately EXCLUDED from the key (each with its reason)

| Excluded field | Reason |
|---|---|
| `decisionCandleTimeUtc` | **The core decision.** The SAME setup spans multiple decision candles (live proof: the 11-row cluster above, 4 decision candles). Including it would make every new candle a "new setup" and disable deduplication exactly where it is needed (user constraint: variable tick timestamps must not blindly key the identity). |
| `barsSinceBreak` | Derived from the decision candle — same reason. Varies across the cluster (0→3 in the live rows). |
| `nowUtcSec` / `generatedAtUtc` / quote (bid/ask/spread/age) | Variable per-evaluation tick data. Same setup evaluated at 16:23 vs 16:26 must hash identically. |
| indicators (ema/rsi/atr/adx) | Recomputed per rolling window; EMA values shift as the window rolls. They are setup CONDITIONS (pass/fail), not identity. |
| `anchorSwing` + levels (entryReference/SL/target/risk) | Trade geometry varies per evaluation (entryReference depends on the live quote; a newer anchor swing can be confirmed later). The paper row freezes the FIRST emission's geometry — later variations of the same setup are repeats by identity. |
| `retestBarTimeUtc` | A condition detail (earliest retest bar), deterministic per event but not identity. |
| `levelText` | Derived from `level` — redundant. |
| reason codes / outcome (`WAIT` vs `NO_SETUP` vs `SETUP`) | The SAME setup legitimately produces different outcomes across evaluations (live proof: `WAIT[RETEST_PENDING]` → `NO_SETUP[ZONE_INVALIDATED]`). Outcome is a condition, not identity. |

## 3. When something is a NEW setup (gets a NEW fingerprint, may get its own paper row)

1. A **new structure break event** — different `breakCandleTimeUtc` and/or `level`, `type`, `direction`
   (user scenario 4: after invalidation the engine needs a new break; that new break is a new setup).
2. The **same event under a changed `strategyVersion`** (scenario 6).
3. **Different symbol** or **different execution timeframe** (by construction).
4. **BUY vs SELL**: `direction` is part of the event (scenario 5) — always distinct fingerprints.

## 4. When it is the SAME setup (repeated evaluation — deduplicated)

The same event re-evaluated: same or different decision candle, same or different evaluation
instant, `WAIT`→`SETUP` transitions, re-emission after the paper row resolved (a resolved row
still blocks a second row for the same fingerprint — "one paper row per setup, ever").

## 5. Where the fingerprint is computed and persisted

- **ONE pure module** `src/lib/signal/setup-identity.ts`:
  `computeSetupFingerprint(input)` (sha256 hex) + `setupFingerprintFromEvidence(...)`
  returning `null` when the identity is incomplete — never guessed.
- `saveSignalEvaluation` (persistence.ts): persists `setupFingerprint` on **SignalEvaluation**
  rows (nullable; computed for every row whose evidence carries a complete structure event —
  includes WAIT/NO_SETUP repeats for traceability; `null` for BLOCKED/FAILED/no-event rows).
  No unique constraint here — repeated evaluation rows remain the append-only audit trail.
- `trackPaperSignals` (paper.ts): persists `setupFingerprint` on **PaperSignalOutcome** with a
  **database-level UNIQUE constraint** (`@unique`). Scope of the constraint: ONE paper row per
  fingerprint value across ALL evaluations, ALL time, ANY status (open/counted/resolved).
  Concurrent creates: the loser gets Prisma `P2002` → recorded as a suppressed duplicate,
  never an error, never a second row.
- Fail-closed rule: a SETUP evaluation whose evidence lacks a complete structure-event identity
  gets NO paper row (an error entry is recorded) — never a guessed identity, never an ambiguous
  dedup key.

## 6. Deduplication flow in `trackPaperSignals` (per evaluation row)

1. Parse the setup (existing rules — outcome BUY_SETUP/SELL_SETUP, levels, three times).
2. Look up the paper row by `signalEvaluationId` (per-evaluation link, preserved) — if found
   and resolved → skip (immutable; unchanged).
3. If no row exists for this evaluation: compute the fingerprint from the row's own evidence;
   attempt `create` (including `setupFingerprint`). On `P2002` (same setup already has a row —
   incl. the concurrent-race case) → count as suppressed duplicate, continue.
4. Advance THE PAPER ROW found by either key, using the paper row's OWN fields
   (`decisionCandleTimeUtc` anchor, own levels, own `invalidationLevel`), updating by `id`.
   The walk anchor therefore never drifts to a later evaluation's decision candle.
5. The pre-registered first-open aggregation (`applyFirstOpenRule`) is untouched — it stays as
   belt-and-suspenders for the one-position model.

## 7. Migration (additive only)

- `SignalEvaluation.setupFingerprint TEXT NULL` (no unique).
- `PaperSignalOutcome.setupFingerprint TEXT NULL UNIQUE` (SQLite: multiple NULLs allowed —
  legacy rows never conflict; 0 paper rows exist today anyway).
- Applied via the project's established practice: inspected `prisma migrate diff` SQL first,
  then `bun run db:push`, then re-diff (must be empty) + row-count/data-integrity check.
  A `prisma/migrations/<timestamp>_phase10_3a_setup_fingerprint/migration.sql` record is
  committed for the audit trail. No existing row is deleted, rewritten, or backfilled.

## 8. Test plan (written BEFORE implementation — every scenario from the user's list)

New file `tests/signal/setup-identity.test.ts` (synthetic fixtures on the ISOLATED test DB —
never broker data), plus a disclosed fixture update in `tests/signal/paper.test.ts` (its
synthetic seeds gain the complete structure-event identity the real engine always emits;
assertions unchanged):

- **S1** same setup, same decision candle, repeated evaluation → exactly 1 paper row; second
  evaluation suppressed; row keeps the first emission's geometry.
- **S2** concurrent evaluation of the same setup → exactly 1 paper row (P2002 path); direct
  unique-constraint proof: two raw `create`s with the same fingerprint → second throws P2002
  (scope: any evaluation id, any time, any status).
- **S3** same setup on a NEW decision candle, still active → same fingerprint (pure assert),
  no second paper row, the SAME row advances (walk anchored at its own decision candle).
- **S4** new valid setup after invalidation (new break event) → new fingerprint, own paper row;
  while the first row is open the new row is a first-open REPEAT at aggregation.
- **S5** BUY vs SELL events → distinct fingerprints.
- **S6** strategy version change → distinct fingerprints for the same event.
- **S7** restart/recovery → after a fresh `trackPaperSignals` call (all state from the DB)
  still exactly 1 row; persisted fingerprint === recomputed fingerprint from the row's own
  evidence (cross-restart consistency).
- **S8** legacy/old records untouched + pre-registered aggregation unchanged: NULL-fingerprint
  legacy-style rows follow the old per-evaluation path; `applyFirstOpenRule` /
  `computeForwardPaperMetrics` / `evaluateForwardPaperVerdict` produce identical pre-registered
  results (20 protocol tests stay green, unmodified).
- **D1** fingerprint determinism & sensitivity (identical evidence → identical hash; a 1e-9
  level change → different hash; incomplete identity → `null`).
- **D2** persisted-vs-recomputed consistency (SignalEvaluation column === recomputation from
  the row's persisted evidence JSON).
- **D3** fail-closed: unidentifiable SETUP → no paper row + recorded error.
- **D4** BEFORE/AFTER on the SAME persisted dataset: 11 seeded evaluations of one setup
  (mirroring the live cluster) → old per-evaluation algorithm would persist 11 paper rows,
  new algorithm persists 1; first-open counting over both row sets: identical `counted`,
  identical metrics, identical verdict; `repeatObservations` 10 → 0, `eligibleRows` 11 → 1.

## 9. Explicit non-goals (unchanged by this note)

Strategy parameters, entry/SL/TP logic, `strategyVersion`, all Phase 10.2 pre-registered
constants (activation 2026-10-15T16:30Z, 90-day window, 20-trade floor, 35%/8-loss/10R gates),
first-open rule text, the four execution locks, any order/execution code (none exists),
dashboard/API field surfacing (that is Phase 10.3-d), and every legacy row's meaning.
