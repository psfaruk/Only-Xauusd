# Phase 3 Audit — Signal Data Contract and Lifecycle

**Task:** 42-S2 (deep remediation, master prompt §PHASE 3)
**Scope:** `src/lib/signal/types.ts`, NEW `src/lib/signal/lifecycle.ts`, `src/app/api/signal/latest/route.ts` (additive), `tests/signal/lifecycle.test.ts`
**Method:** every Phase 3 contract field/requirement mapped to the existing `SignalEvaluation` DB shape + API surface; verdicts SATISFIED (file:line) / GAP → CLOSED (this task) / GAP (OPEN, non-critical, noted honestly).

**Bottom line:** the persisted SignalEvaluation contract already carried ~90% of the required fields (it is a mature, append-only, fingerprinted audit trail). The missing piece was the explicit lifecycle layer — NEW `src/lib/signal/lifecycle.ts` (statuses, legal transitions, read-time derivation, canonical dedupe key, confidence-honesty label) + additive exposure at `/api/signal/latest`. Critical gaps closed; non-critical gaps are listed at the end.

---

## Contract field mapping (master prompt Phase 3 minimum set)

| Required field | Implementation | Verdict |
| --- | --- | --- |
| **signalId** | `SignalEvaluation.id` (cuid, append-only) — `prisma/schema.prisma:270`; exposed on every API row (`LatestSignalEvaluation.id`, `src/lib/signal/persistence.ts:157`) | SATISFIED |
| **dedupeKey** | NEW canonical `signalDedupeKey()` = `symbol\|strategyVersion\|setupFingerprint\|decisionCandleTimeUtc` — `src/lib/signal/lifecycle.ts:147-165`; exposed at `GET /api/signal/latest` → `lifecycle.dedupeKey` (`src/app/api/signal/latest/route.ts:109-114,146`). Backed by the EXISTING logical identity: `setupFingerprint` (sha256, `src/lib/signal/setup-identity.ts:44-52`, column `schema.prisma:277`) + unique per-setup paper rows (`schema.prisma:340,400`) + scalper same-bar dedup (`src/lib/signal/scalper-service.ts:271-286`) | SATISFIED (gap closed) |
| **symbol** | `SignalEvaluation.symbol` (`schema.prisma:273`); allowlist-enforced | SATISFIED |
| **side** | `outcome` BUY_SETUP/SELL_SETUP (`src/lib/signal/types.ts:32`) + `levels.direction` BUY/SELL (`types.ts:168`); WAIT/NO_SETUP/BLOCKED carry no side by construction | SATISFIED |
| **strategyName/version** | `strategyVersion` on every row (`schema.prisma:272`) — baseline `hybrid-structure-retest/9.0.0` (`types.ts:28-30`), scalper `scalper-m1-m5-m15-or/14.0.0` (`scalper/types.ts:25-27`), candidate `hybrid-multimodel-research/11.0.0-candidate.1`; engineVersion separate (`schema.prisma:271`) | SATISFIED |
| **lifecycle status** | NEW `SignalLifecycleStatus` CANDIDATE/CONFIRMED/ISSUED/EXPIRED/CANCELLED/OUTCOME_RECORDED + `LEGAL_TRANSITIONS` + `canTransition`/`transition` (pure) — `src/lib/signal/lifecycle.ts:39-84`; derived per-row at read time via `deriveLifecycleStatus()` (`lifecycle.ts:119-136`) and exposed at `signal/latest` → `lifecycle.status` + `scalperLifecycle.status` (`route.ts:98-139,146-147`) | SATISFIED (gap closed) |
| **timeframe roles** | persisted per-row rules snapshot: baseline `StrategyRules.executionTf/contextTfs` (`types.ts:105-106`) + window ranges in evidence (`executionWindow/h1Window/h4Window`, `types.ts:213-215`); scalper trio M15/M5/M1 + HTF context (`scalper/types.ts:30,166-184`); full rules JSON in `inputSnapshot` (`persistence.ts:96-141`) | SATISFIED |
| **generatedAtUtc** | `evaluation.generatedAtUtc` (`types.ts:244`) + row `createdAt` (`schema.prisma:288`) — server clock is the truth (`nowUtcSec` computed server-side, `service.ts:95-111`) | SATISFIED |
| **sourceCandleCloseAtUtc** | `decisionCandleTimeUtc` (`schema.prisma:282`, `types.ts:235`) — the decision candle's bar-OPEN time (standard MT5 semantics; its close = open + TF duration and is derivable). Naming differs, semantics identical and closed-bar-only (see requirement 4 below) | SATISFIED (naming note) |
| **latestQuoteAtUtc / quoteAgeMs** | quote snapshot persisted per row (`schema.prisma:285`): `quoteTimeUtc` + `ageSeconds` (`service.ts:189-200`); the health surface carries tick age in ms (`freshness.tickAgeMs`, `quality.ts:370`) | SATISFIED (row stores age in SECONDS, not ms — noted) |
| **spread** | quote `spread` persisted per row (`service.ts:196`); levels are spread-adjusted (`entryReference` ask-side for BUY, `types.ts:171`); spread gates (`maxSpreadPrice`, `SPREAD_TOO_WIDE`) | SATISFIED |
| **entry zone** | `levels.entryZoneLow/High/entryReference` (+ canonical text) — setups ONLY (`types.ts:167-182`); zone width in ATR multiples documented in persisted rules (`zoneWidthAtr`, `types.ts:119`) | SATISFIED |
| **invalidation condition** | engine rule encoded + persisted: anchor-swing SL beyond broken level (`slAtrBuffer`), evidence carries the anchor swing + structure event (`types.ts:186-200`); paper tracker encodes invalidation as "M15 close back through the broken level → invalidated" (`src/lib/signal/paper.ts:25,238-244`); candidate levels carry explicit `invalidationLevel` (`candidate/types.ts:114`) | SATISFIED |
| **stop/target methodology** | methodology IS the persisted rules: `slAtrBuffer` + `rewardRisk` fixed multiple (`types.ts:123-125`), scalper `slAtrMult`/`rewardRisk`/`minStopPrice` (`scalper/types.ts:104-111`); levels presented as methodology outputs, never profit promises (`purpose: 'research-signal-not-an-execution-instruction'`, `types.ts:232`) | SATISFIED |
| **expiryAtUtc** | `expiryUtc` on every setup row (`schema.prisma:284`, `types.ts:237`; baseline `expiryBars`, scalper `expirySec`); NEW read-time EXPIRED derivation (`lifecycle.ts:127`) | SATISFIED |
| **evidence** | full deterministic evidence persisted per row: structure event, anchor swing, indicators, HTF trends, decision close, window ranges (`types.ts:184-224`) + scalper per-TF judgements (`scalper/types.ts:134-210`) + SMC ten-agent block (`ict/types.ts`) | SATISFIED |
| **filters passed/failed** | typed `reasonCodes` union — gate family vs strategy family (`types.ts:35-100`) persisted on EVERY row including BLOCKED; read-time per-condition checklist `deriveConditionReport` (`src/lib/signal/conditions.ts:89`) exposed at `signal/latest → conditions` | SATISFIED |
| **data-quality state** | BLOCKED outcome family with DATA_* codes; quote integrity embedded per row; consolidated `freshness` surface (Phase 2, `/api/data/health`) | SATISFIED |
| **confidence type/value** | SMC confluence score 0-100 + tiers A/B/C (`src/lib/signal/ict/types.ts:44-52`) — persisted in evidence (`ict/types.ts:354,376`); NEW honesty layer: `confidenceLabel()` → **'EVIDENCE_SCORE'** (never 'probability') + `CONFIDENCE_CALIBRATED = false` (`lifecycle.ts:168-190`), exposed at `lifecycle.confidenceType` | SATISFIED (gap closed) |
| **outcome linkage** | `PaperSignalOutcome.signalEvaluationId` UNIQUE — exactly one outcome row per evaluation, ever (`schema.prisma:329-364`); `setupFingerprint` UNIQUE — one paper row per logical setup ever (`schema.prisma:340`); candidate twin `PaperCandidateOutcome` (`schema.prisma:379-400`); resolved outcomes immutable | SATISFIED for baseline + candidate; **GAP (OPEN): scalper setups have no forward outcome linkage** (no scalper paper tracker — forward evaluation of the scalper surface is unclaimed, see Open Gaps) |

## Requirements (non-field)

**1. Typed, versioned contract** — SATISFIED. Every row is the typed `SignalEvaluation` (`types.ts:226-246`) with `engineVersion` + `strategyVersion` version pinning; the NEW lifecycle layer is versioned itself (`LIFECYCLE_CONTRACT_VERSION = 'signal-lifecycle/1.0.0'`, `lifecycle.ts:33`).

**2. Confidence is never a probability unless calibrated** — SATISFIED (gap closed). Tier/score vocabulary only; `confidenceLabel()` returns `'EVIDENCE_SCORE'` for every tier; `CONFIDENCE_CALIBRATED = false` is the machine-readable honesty bit until a calibration study exists (`lifecycle.ts:168-190`). UI language already speaks tier/স্কোর, never probability.

**3. Explicit lifecycle with legal transitions enforced in the domain layer** — SATISFIED (gap closed). `LEGAL_TRANSITIONS` + pure `canTransition`/`transition` (`lifecycle.ts:57-84`): CANDIDATE→CONFIRMED→ISSUED→EXPIRED/CANCELLED→OUTCOME_RECORDED; OUTCOME_RECORDED terminal; CANDIDATE→ISSUED explicitly ILLEGAL (no silent promotion). Matrix pinned exhaustively (all 36 pairs) in `tests/signal/lifecycle.test.ts`.

**4. Confirmed signals based on closed candles; PROVISIONAL visually separate** — SATISFIED. Loaders query `isForming: false` ONLY (`src/lib/analysis/persistence.ts:52`) — both baseline (`loadSignalWindows`) and scalper (`loadScalperWindows`) windows are closed-candle-only by construction, so a CONFIRMED derivation is honest; `deriveLifecycleStatus` refuses CONFIRMED when `decisionCandleTimeUtc` is absent (fail closed, `lifecycle.ts:131-132`). No pre-close alert path exists anywhere, so the PROVISIONAL tier is NOT-APPLICABLE (nothing to keep separate — nothing is ever emitted pre-close).

**5. Expire stale setups; cancel on invalidation; mark missed; never show old entries as current** — SATISFIED with one naming note. Expiry: `expiryUtc` on setups + paper resolves "expiry without a hit → expired (exit at the last closed bar's close; null when no bars were available — never fabricated)" (`paper.ts:38-39,262`); NEW read-time EXPIRED status means an old entry can never render as current (`lifecycle.ts:127`, surfaced at `signal/latest`). Invalidation: paper `invalidated` outcome (`paper.ts:238-244`). "Missed" is recorded as the `expired`-without-touch outcome rather than a distinct MISSED state — same semantics (price never reached the zone), one fewer state; noted honestly.

**6. UTC everywhere; server timestamps as truth** — SATISFIED. All persisted times are UTC (`DateTime` + ISO strings out); generation instants come from the server clock (`nowUtcSec`, `service.ts:95-111`); display formatting happens in the UI layer only.

**7. Idempotency/dedupe keys — retries/reloads never repeat an alert** — SATISFIED. Layered: (a) append-only rows with `inputFingerprint` (replay detection), (b) logical `setupFingerprint` (Phase 10.3-A) with UNIQUE paper rows per setup ever, (c) scalper emission cooldown + same-bar fingerprint dedup (`scalper-service.ts:271-286`), (d) NEW canonical `signalDedupeKey` for consumers. Pinned by `tests/signal/setup-identity.test.ts` (S1-S8), `paper-chronology.test.ts`, and the new lifecycle tests.

## Acceptance tests (master prompt)

| Required | Evidence | Verdict |
| --- | --- | --- |
| Illegal state transitions fail | NEW `tests/signal/lifecycle.test.ts` (full 36-pair matrix + terminal + no-silent-promotion) | SATISFIED |
| Duplicated events produce one signal | `setup-identity.test.ts` (S1/S2/S4/S7/D4), unique paper constraints | SATISFIED |
| Replay gives the same lifecycle | NEW determinism test + `inputFingerprint` replay equivalence (`candidate-dual-run.test.ts`) | SATISFIED |
| Expiry / invalidation / missed-entry behave | `paper.test.ts`, `paper-chronology.test.ts`, `paper-protocol.test.ts` (+ NEW expired-derivation cases) | SATISFIED |

## Open gaps (non-critical, honestly noted)

1. **Scalper setups lack forward outcome linkage** — no scalper paper tracker exists (baseline + candidate only). The scalper lifecycle status is derivable (EXPIRED/CONFIRMED/CANDIDATE) but no prospective outcome rows are recorded for it. Belongs to the paper-forward phase scope (S3).
2. **Lifecycle statuses are derived at read time, not persisted as a state-machine column** — deliberate architecture (append-only audit trail; replay-stable derivation), but consumers must use `lifecycle.ts` rather than a `status` column. A persisted transition log would be new scope.
3. **quoteAge persisted in seconds** (`ageSeconds`) not milliseconds — the consolidated health surface provides `tickAgeMs` for ms precision.
4. **`sourceCandleCloseAtUtc` is stored as the decision candle's bar-OPEN time** (`decisionCandleTimeUtc`) — MT5-standard semantics; close time is derivable (open + TF duration).
