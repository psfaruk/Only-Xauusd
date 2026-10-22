# Phase 2 Audit — Market Data Pipeline and Freshness

**Task:** 42-S2 (deep remediation, master prompt `upload/Only-Xauusd_Deep_Implementation_Master_Prompt.txt` §PHASE 2)
**Scope of this audit:** `src/lib/market/**`, `src/app/api/data/health/route.ts`, `tests/market/**`
**Method:** every master-prompt Phase 2 requirement mapped to the implementation that already existed *before* this task, then the named gaps closed. Verdicts: **SATISFIED** (with evidence), **GAP → CLOSED** (this task), **GAP (OPEN)**, **NOT-APPLICABLE (documented)**.

**Bottom line:** Phase 2 was already ~85% implemented by the mature Phase 3/4/8 pipeline. Three gaps existed: (1) no single consolidated market-health object, (2) closed candles were **mutable** on re-delivery (a real ingestion bug — found by the new regression test and fixed), (3) STALE→signal suppression had no service-level regression test. All three are closed by 42-S2.

---

## Task 1 — Authoritative quote source; event vs receive vs render time

**SATISFIED.**
- Authoritative source: the authenticated Exness MT5 session behind the local `mt5-bridge` (:3031). Source classification never upgrades data: `classifySource()` maps `broker | relay | cache | synthetic | unavailable` — `src/lib/market/integrity.ts:49-66`.
- Event vs receive time: broker event time (`quoteTimeUtc`, from `ts`) vs server receive time (`receivedAtUtc`, from `receivedAtMs`) are separate fields — `src/lib/market/integrity.ts:212-213`; persisted tick row carries both (`MarketLatestTick.tickTimeUtc` / `.receivedAtUtc`, `prisma/schema.prisma:81-93`); the NEW freshness surface keeps them distinct (`lastSourceTickAtUtc` vs `lastReceiveAtUtc`, `src/lib/market/quality.ts:368-369`).
- Browser render time is client-side only and never feeds the pipeline (dashboard polls / the tick-stream socket renders what it receives — malformed events ignored, never rendered: `src/hooks/use-tick-stream.ts:201`).

## Task 2 — Symbol normalization, digits, spread, timestamps, no silent substitution

**SATISFIED.**
- Strict symbol + timeframe allowlists at the API edge: `src/lib/market/schemas.ts:18-27` (non-allowlisted → 400 `SYMBOL_NOT_ALLOWED`, not silent fallback); ingestion re-checks (defense in depth) — `src/lib/market/ingestion.ts:170-190` (allowlist) and `SYMBOL_NOT_FOUND` when the bridge does not serve the symbol (`ingestion.ts:359-373`).
- Broker→UTC normalization happens in the bridge, measured live (`brokerOffsetSec` from broker time − local UTC; quote `ts` and bar-open `t` are served UTC-normalized) — `mini-services/mt5-bridge/index.ts:224-267`; app contract documents it: `src/lib/market/types.ts:152,198,203`.
- Digits verified from bridge responses; `SymbolSpec` stores ONLY bridge-verified fields (point is derived `10^-digits` and *labelled* derived, never claimed as broker-reported) — `src/lib/market/ingestion.ts:576-620`. Canonical decimal text everywhere: `toCanonicalPrice` (`src/lib/market/validation.ts`), precision anomalies flagged `CANDLE_PRICE_PRECISION_ANOMALY`, never silently rounded.
- Spread is always computed ourselves from ask − bid (never trusted from the wire): `src/lib/market/validation.ts:331,378`.
- Known limitation (honest, not a regression): tick size / tick value are not part of the bridge contract → stay null in the spec (never guessed).

## Task 3 — Tick validation with reason codes

**SATISFIED (one sub-item NOT-APPLICABLE by design, one accepted GAP).**
- Null/non-finite, non-positive, crossed bid/ask, zero spread, bad/future timestamps → `validateQuote()` with stable reason codes `TICK_INVALID | TICK_NON_POSITIVE | TICK_CROSSED | TICK_ZERO_SPREAD | TICK_BAD_TIME` — `src/lib/market/validation.ts:342-396` (future-tolerance 120s, `validation.ts:28`). Invalid ticks are REJECTED (never persisted as valid); warnings kept + flagged (`ingestion.ts:565-570`); rejection evidence lands in `DataQualityIssue` rows.
- Stale tick: freshness vs `MARKET_STALE_TICK_SEC` (default 120s) — `src/lib/market/quality.ts:71-79` and `src/lib/market/integrity.ts:174-182` (`LIVE | STALE | DEGRADED | DISCONNECTED`).
- Wrong symbol: quotes/candles for unserved symbols fail closed at the bridge (404) and via the allowlists above.
- Duplicate sequence / out-of-order events: **NOT-APPLICABLE (documented design)** — `MarketLatestTick` is a single-row-per-symbol snapshot, deliberately NOT a tick history (`prisma/schema.prisma:78-80`), so per-event sequence numbers do not exist. Candles (the aggregation input) DO have duplicate/out-of-order validation — see Task 4.
- **GAP (OPEN, accepted):** no "huge jump" outlier check on ticks (requires a tick history the schema deliberately avoids). Downstream risk is bounded by candle-level OHLC consistency + session-aware gap classification + quote-integrity numeric validation. Revisit only if a tick-history table is ever introduced.

## Task 4 — Deterministic candle aggregation; closed-candle immutability; gaps

**GAP → CLOSED (immutability was a REAL bug; fixed minimally by 42-S2).**
- Deterministic batch validation: per-bar OHLC consistency, bad/future times, precision anomalies, forming-flag + computed-forming cross-check — `src/lib/market/validation.ts:100-175`; batch duplicate keys (closed beats forming deterministically) + out-of-order detection — `validation.ts:205-280`.
- UTC timeframe boundaries: TF-aligned expected grid `expectedCandleTimes()` (`validation.ts:255-261`), bar OPEN times on the grid, forming vs closed (`f:1` + computed `t + tfSec > now`), the forming bar is never counted as closed history (`quality.ts:101-107`, `ingestion.ts` coverage verification excludes forming bars).
- Idempotent writes: upserts keyed on `(symbol, timeframe, candleTimeUtc)` unique index — `src/lib/market/ingestion.ts:413-542`; proven by `tests/market/ingestion.test.ts` ("first run inserts; second run with identical bars only updates").
- Gap detection: session-aware `findMissingCandles` (`validation.ts:282-296` + `sessions.ts` classification) at ingestion time (`ingestion.ts:507-519`) and at readiness time (`quality.ts:131-145`); closure-window gaps are info, others are suspicious warnings.
- **The bug this task exposed:** the upsert's `update` branch rewrote OHLC/`isForming`/`validationStatus` of ALREADY-CLOSED rows on every re-delivery — a divergent "revision" from the bridge silently mutated confirmed history (exactly what the master prompt forbids). **Fix (minimal):** closed rows now only get a `receivedAtUtc` receipt refresh; a divergent re-delivery (different OHLC, or re-sent as forming) is IGNORED and recorded as an auditable `CANDLE_CLOSED_REVISION_IGNORED` warning — `src/lib/market/ingestion.ts:413-428,444-468,534-542`; error code added at `src/lib/market/types.ts:95-98`. Forming→closed transitions still take the normal update path (final values DO land). **Regression tests:** `tests/market/closed-candle-immutability.test.ts` (divergent revision ignored + audited; re-forming ignored; forming→closed still finalizes; identical re-delivery is an OHLC no-op).

## Task 5 — Single authoritative market health object

**GAP → CLOSED by 42-S2.**
- NEW `computeFreshnessSnapshot()` — `src/lib/market/quality.ts:316-376` (+ types `src/lib/market/types.ts:320-367`): `lastSourceTickAtUtc`, `lastReceiveAtUtc`, `tickAgeMs`, per-TF `{latestClosedCandleAtUtc, stalenessState: LIVE|STALE|NO_DATA, ageSeconds, threshold, suspiciousGapsLast24h}`, `gapCountLast24h` (suspicious gaps across all checked TFs, from the closed-candle grid validation) and the single bit `confirmedSignalsPermitted` (true only when quote integrity passes AND M1+M5+M15 are all LIVE; fail-closed reasons in `blockReasons`).
- Exposed at `GET /api/data/health` → `freshness` block — `src/app/api/data/health/route.ts:42-51,69`. Reuses `computeReadiness` + `findMissingCandles` (no duplicated staleness/gap logic); reuses the route's already-fetched quote-integrity report (no second bridge round-trip). QualityState→staleness mapping documented at `quality.ts:271-277` (INVALID/UNAVAILABLE → NO_DATA — present-but-corrupt is not usable).
- Unit tests: `tests/market/quality.test.ts` (freshness snapshot describe block — 7 cases incl. fail-closed paths). **Live-verified** against the real Exness feed: all TFs LIVE, `confirmedSignalsPermitted: true`.

## Task 6 — Stale/disconnected ⇒ no new confirmed signals; unmistakable UI

**SATISFIED (regression proof ADDED by 42-S2).**
- Enforced per-service BEFORE any evaluation: Gate 2 quote integrity (`signalPermitted`) — `src/lib/signal/service.ts:188-204`, `src/lib/signal/scalper-service.ts:185-201`; Gate 4 readiness (tick + per-TF freshness) — `service.ts:214-241`, `scalper-service.ts:211-237`. Blocked outcomes persist append-only with reason codes (`DATA_STALE` family) and never carry levels/evidence.
- **NEW regression test** `tests/market/stale-suppression.test.ts`: service-level run of `runScalperEvaluation` with an injected clock (`opts.now`) over an isolated test DB seeded with 2h-old closes → `BLOCKED` + `DATA_STALE` reason codes + ZERO emitted-setup rows persisted; also proves a single stale TF (M1) blocks, and a fresh-seeded control passes the data gates (the block is caused by staleness, not seeding).
- UI: freshness/quality badges render STALE/DISCONNECTED states with ages (dashboard quality-state labels; the health surface's `quote.freshness` + NEW `freshness.stalenessState` per TF). No fake ticks or animated prices anywhere (`src/lib/dashboard/live-candle.ts` never fabricates).

## Task 7 — Update cadence only from real data; no invented ticks

**SATISFIED.**
- The tick-stream mini-service (socket.io :3041) forwards genuine bridge events only; the frontend renders what arrives and ignores malformed payloads (`src/hooks/use-tick-stream.ts:138,201`). There is no refresh-rate target and no synthetic interpolation anywhere in the render path; the chart consumes persisted/served candles only. Genuine tick counts are surfaced honestly (`quoteCount`, `lastQuoteAtMs` — `src/lib/market/types.ts:170-181`).

## Task 8 — Caches, polling/WS lifecycle, reconnect backoff, duplicate ingestion

**SATISFIED.**
- Bridge client: bounded per-request timeout (AbortController), bounded retries with jittered exponential backoff on network/timeout/5xx only (4xx never retried) — `src/lib/market/bridge-client.ts:19-20,63-64,141-171`.
- Rate limiting + auth at the API edge (`src/lib/api-guard.ts`; token/preview switches fail closed). Reconnect observability: `reconnects`/`lastError` surfaced through bridge status → `quoteIntegrity` report (`integrity.ts:126-127,217-218`).
- Duplicate ingestion is impossible at the row level (unique index + idempotent upserts, Task 4) and bounded at the bookkeeping level (`duplicates` counters, `DataQualityIssue` caps — `ingestion.ts` §9).

---

## Acceptance tests (master prompt)

| Required test | Evidence | Verdict |
| --- | --- | --- |
| duplicates | `tests/market/ingestion.test.ts` (duplicate keys in one response), `validation.test.ts` | SATISFIED |
| gaps | `tests/market/quality.test.ts` (session-aware gap reporting), `ingestion.test.ts` (backfill coverage) | SATISFIED |
| out-of-order ticks/bars | `validation.test.ts`, `integrity.test.ts` (out-of-order audit) | SATISFIED |
| reconnect | `tests/market/ingestion.test.ts` (bridge timeout + recovery), `integrity.test.ts` (reconnect counters) | SATISFIED |
| stale quote | `tests/market/quality.test.ts` (staleness per TF), NEW `stale-suppression.test.ts` | SATISFIED |
| wrong symbol | `ingestion.test.ts` (SYMBOL_NOT_ALLOWED / SYMBOL_NOT_FOUND), `api.test.ts` (400 allowlist) | SATISFIED |
| daylight/timezone boundaries | UTC-only pipeline + bridge offset normalization (`mt5-bridge/index.ts:224-267`); session/closure envelopes `src/lib/market/sessions.ts` | SATISFIED |
| closed-candle immutability | NEW `tests/market/closed-candle-immutability.test.ts` | SATISFIED (gap closed) |
| idempotent aggregation | `ingestion.test.ts` (identical re-sync), NEW immutability test (identical no-op) | SATISFIED |
| stale data blocks confirmed signals + unmistakable warning | NEW `stale-suppression.test.ts` (service level); UI freshness badges | SATISFIED |

## Gaps left open (honest)

1. **Tick-level "huge jump" outlier detection** — not implemented (no tick history by design). Accepted with rationale (Task 3 above).
2. **Candle corrections** are ignored + audited (`CANDLE_CLOSED_REVISION_IGNORED`), not versioned/applied — the master prompt permits either ("if corrections are supported, version and audit them"); we chose immutability + audit trail. A versioned-correction ledger would be new scope.
3. The H4 broker-history depth limitation remains (bounded per-request windows, honestly reported by `auditCandleHistory().h4Coverage`).
