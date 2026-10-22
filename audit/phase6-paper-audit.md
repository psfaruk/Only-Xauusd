# Phase 6 Audit — Paper-Forward Signal Evaluation & Timing (Task 42-S3)

Scope: master prompt "PHASE 6 — PAPER-FORWARD SIGNAL EVALUATION AND TIMING" (tasks 1–5 + acceptance tests), mapped to file:line evidence; the timing capture + latency stats added by 42-S3; the minimum-evaluation-window policy proposal; the honest current status.

---

## 1) Paper ledger mechanics (as shipped)

Two COMPLETELY SEPARATE read-only ledgers (cannot-mix by construction):

| Ledger | Table | Walker | Scope filter |
|---|---|---|---|
| Baseline | `PaperSignalOutcome` (`prisma/schema.prisma:329-364`) | `trackPaperSignals` (`src/lib/signal/paper.ts:425+`) | `strategyVersion: SIGNAL_STRATEGY_VERSION` only (`paper.ts` query `where`) — candidate rows can never enter (`paper.ts` Phase 11-E isolation comment) |
| Candidate | `PaperCandidateOutcome` (`schema.prisma:385-425`) | `trackCandidatePaperSignals` (`src/lib/signal/candidate-paper.ts:187+`) | `strategyVersion: CANDIDATE_STRATEGY_VERSION` only |

**Never calls broker order APIs:** both trackers are read-only walks over persisted candles; no order code exists anywhere in the project (Phase 0 removed the execution layer by construction; `paper.ts:1-8` header: "it can NEVER submit, modify or close a broker order: no such code exists anywhere").

- **One row per logical setup EVER**: unique `signalEvaluationId` + unique `setupFingerprint` (`schema.prisma:340`, `:400`); repeated evaluations are suppressed repeats (P2002 race guard, `paper.ts` `isUniqueViolation`); resolved rows are IMMUTABLE and never reprocessed (`paper.ts:355-357` skip-resolved; re-walk impossible).
- **Recorded per row:** candidates (setup evaluations), rejected candidates (suppressed duplicates), expiry/invalidation, entry-zone touch (the walk), subsequent path (observations, lastCheckedBar), simulated outcome under realistic costs (Phase 10 conservative round trip; R-multiples recomputed from the row's own frozen geometry).
- **Chronology (Phase 10.3-B):** a bar contributes only if its close is strictly AFTER the signal-creation instant, its open strictly BEFORE expiry, and it has truly closed; corrupt anchors/unordered bars fail CLOSED (row error, no advance). Pinned by `tests/signal/paper-chronology.test.ts` (T1–T10) and `tests/signal/paper.test.ts`.

**Restart-safety / recovery (cited code):** everything above is table state, not memory — restarting the service loses nothing:
- resolved rows are skipped by status (`paper.ts:355-357`, `candidate-paper.ts:229-231`);
- open rows only ever ADVANCE (idempotent per row: the same clock yields identical observations; `paper-chronology.test.ts` T8 "restart/recovery never re- or mis-resolves", T6 "a resolved row is never re-walked");
- duplicate signals are not counted twice (unique constraints at the DB level — the race guard `isUniqueViolation`);
- every outcome links to its originating signal version (`strategyVersion` column on both tables + `signalEvaluationId` linkage; the candidate rows additionally pin `candidateVersion`).

## 2) End-to-end timing (NEW — Task 42-S3, deliverable G)

The three instants needed for latency measurement are **pre-existing columns on every row** (no migration — `prisma/schema.prisma` untouched):

- `decisionCandleCloseAtUtc` = `setupKnownAtUtc` — the engine stamps the decision bar's close instant there (`src/lib/signal/core.ts:549-559`: `setupKnownAtUtc = decision open + tfSec`);
- `detectedAtUtc` = `signalCreatedAtUtc` (the originating evaluation row's `createdAt`);
- `trackedAtUtc` = the paper row's own `createdAt`.

Added by 42-S3 (additive only):

- **Capture:** new rows persist an explicit `timing` block inside the existing `details` JSON (`paper.ts` `timingBlockForCreate` — from the injectable clock at create; `timingBlockForRow` — recomputed EXACTLY from the row's own columns on every advance rewrite, so the block can never be lost or drift). The candidate ledger carries the identical block (`candidate-paper.ts` create + update paths).
- **Stats surface:** `getPaperSignalSummary` now returns `timing: { decisionLatencyMs: {count, medianMs, p95Ms}, trackedLatencyMs: {...}, invalidRows, note }` (`paper.ts` `computePaperTimingStats` — pure; nearest-rank percentiles, defensive skip of impossible negative deltas). `decisionLatency` = detectedAt − candleClose (median/p95); `trackedLatency` = trackedAt − detectedAt. Exposed through the existing paper stats surface (`/api/validation/latest` → `paper.timing`).
- **Historical gap, stated honestly:** there is NO historical gap for the latency statistics — rows created before 42-S3 carry the same three columns, so they are fully computable (pinned by `tests/strategy/paper-timing.test.ts`: old-style rows without a `details.timing` block still contribute). The ONLY pre-42-S3 gap is observational: the explicit `details.timing` block did not exist on old rows (it is additive JSON meta, not the source of the stats) and no rows before 42-S3 recorded anything beyond these three instants (browser-visible time / notification dispatch are NOT measured anywhere yet — master prompt Phase 6 task 2 lists more legs than the current store can express; see gaps).
- Pinned by NEW `tests/strategy/paper-timing.test.ts` (6 tests): capture on create, survival across the advance rewrite, exact percentile arithmetic, historical-row computability.

## 3) Minimum evaluation window — policy proposal (deliverable H)

Current pre-registered floors (already enforced in code):

- Candidate protocol: **≥ 20 completed outcomes** within a **90-day** window, else the verdict stays `INCOMPLETE` / `INCOMPLETE_TIMEOUT` — no performance claim of any kind below the floor (`src/lib/signal/candidate-protocol.ts:30-31,34,43,68-73,95-100`); stopping conditions (8 consecutive losses / > 10R drawdown) are checked continuously.
- Phase 10 interpretation floor: OOS `< minInterpretableTrades` ⇒ no interpretable verdict (`src/lib/backtest/validation.ts:688-735`).
- NEW (42-S3): `sampleAdequacy` labels — `< 30 trades` can never carry statistical language on any backtest surface (`src/lib/backtest/sample-adequacy.ts`).

**Proposal (baseline paper ledger — to be adopted as a pre-registered rule before any "validated" wording is ever used):**

1. **Minimum window:** ≥ 2 consecutive weeks of prospective paper tracking AND ≥ 20 completed outcomes with observable P/L before ANY word stronger than "preliminary" is attached to the baseline ledger; "validated" requires ≥ 100 outcomes (aligning with the `sampleAdequacy` ADEQUATE floor) — and even then only as "validated forward-paper statistics", never as a profitability claim or trade authorization.
2. **Version discipline:** any strategy/rule change creates a NEW strategy version string and RESTARTS the prospective evidence window from zero (old rows stay attributed to their own version forever — the version column already isolates them).
3. **Unobservable outcomes never count** toward the floors (expired-with-no-bars rows are disclosed, not silently included — the current behavior).
4. **Restart the window** also on: data-quality regressions (chronology errors above a documented threshold) or a ledger rebuild from snapshots.

## 4) Honest current status — how many paper outcomes exist right now

Counted the test-safe way: from code + the persisted snapshot documents, NOT ad-hoc queries against the live DB:

- **Last persisted snapshot** (`audit/phase10.2-paper-snapshot.json`, generated 2026-10-15T16:27:59Z — the durability export with `rawRowCount: 0`): `statusCounts = { open: 0, stopped: 0, targeted: 0, invalidated: 0, expired: 0, expiredUnobservable: 0 }` — i.e. **ZERO paper outcomes existed at snapshot time**; verdict `IN_PROGRESS` with "0/20 completed counted trades; 90 day(s) of the 90-day window remain" and "No performance claim is made below the pre-registered sample floor."
- The candidate protocol was activated 2026-10-20T15:00:00Z (`candidate-protocol.ts:43`) — after that activation the forward window started from zero by construction (`getCandidatePaperStats` counts only rows created at/after the activation instant).
- **Live, always-on visibility without manual queries:** `/api/validation/latest?symbol=XAUUSDm` returns the current `paper` summary (including the new `paper.timing` latency stats) and the candidate `forwardPaper` status; `/api/signal/latest` returns `paperStats` for the candidate card. Whatever those surfaces report is the current count — this audit deliberately does not freeze a number that the scheduler changes hourly.

**Bottom line for Phase 6 acceptance:** restart-safety, duplicate-immunity and outcome→version linkage are all pinned by existing tests (`paper-chronology.test.ts`, `paper.test.ts`, `candidate-paper.test.ts`); latency metrics are now reproducible from stored events for ALL rows (new tests); the measurement legs that are still missing (browser-visible time, notification dispatch) are listed below.

## 5) Gaps left open (honest)

- **Unmeasured latency legs** (master prompt Phase 6 task 2): `decision → API publication` is now measurable in aggregate (`trackedLatency`), but **API → browser-visible** and **notification dispatch/arrival** are not instrumented anywhere (the schema has no columns for them and additive JSON cannot express events that happen outside the server). Requires a deliberate observability feature (client-side beacon + a SystemEvent category), not an audit patch.
- **p50/p95/p99 reporting:** the current volume of paper outcomes is zero-to-tiny; the stats code computes median/p95 whenever rows exist and honestly returns nulls otherwise. p99 is intentionally NOT surfaced — with the current sample sizes it would be noise dressed as a statistic.
- **The minimum-window policy in §3 is a proposal** — it is not yet pre-registered in code for the BASELINE ledger (the candidate ledger already enforces its own 20/90-day floor); adopting it is a one-line constant + verdict-function change for the baseline side, deliberately left for the strategy owner after review.

## 6) New/changed files for Phase 6

- CHANGED `src/lib/signal/paper.ts` — timing capture (`timingBlockForCreate`/`timingBlockForRow`, exported), `computePaperTimingStats`, `PaperSummary.timing`, `PaperOutcomeRow.setupKnownAtUtc/trackedAtUtc` (all additive; schema untouched).
- CHANGED `src/lib/signal/candidate-paper.ts` — same `timing` block on create + advance (additive).
- NEW `tests/strategy/paper-timing.test.ts` (6 tests).
