# Phase 4 Audit — Deterministic Market Analysis Engine

Audit performed at the current working tree (branch `main`; the commit containing
this file is the audited state). This document does NOT rewrite
`phase3-audit.md` — that file remains as history; this one supersedes it for
the current state, per the Phase 3 review instruction: "create a fresh audit
section for the current commit".

---

## 0. Step 0 — mandatory repository inspection (real commands, real results)

| # | Command | Exit code | Result |
| --- | --- | --- | --- |
| 1 | `bun test` (pre-Phase-4 baseline) | 0 | 78 pass / 0 fail across 4 files |
| 2 | `bun run lint` (pre-Phase-4 baseline) | 0 | clean |
| 3 | `bun test` (final, after Phase 4) | 0 | **144 pass / 0 fail** across 8 files |
| 4 | `bun run lint` (final) | 0 | clean |
| 5 | `bunx tsc --noEmit` | pre-existing noise only (examples/, skills/, bun:test types) — **zero new errors from Phase 4 code** | verified twice |
| 6 | `bun run market:smoke` | not re-run in Phase 4 — bridge still not deployed (unchanged honest status; see §4) | — |

Database state verified with `bun:sqlite` (read-only) BEFORE the Phase 4
migration was created:

```
SystemEvent 5 · MarketCandle 0 · MarketLatestTick 0 · SymbolSpec 0
DataQualityIssue 0 · SyncRun 4 · AnalysisRun 0
_prisma_migrations: 0_init | 20261014121253_phase3_market_data
```

## 1. Resolving the reported Phase 3 audit contradictions

### 1.1 "Audit report describes the OLD schema while claiming Phase 3 complete"

`phase3-audit.md` was written during Step 1 (a point-in-time audit of the
PRE-Phase-3 state) and then left in place while the implementation landed in
the same session. The worklog (Task 3) records both. Resolution:
**this file is now the authoritative statement of the current state**;
`phase3-audit.md` stays untouched as the historical Step 1 record.

Current-state facts (all verified by command, not by README claim):

- `prisma/schema.prisma` — 13 models; Phase 3 tables (MarketCandle,
  MarketLatestTick, SymbolSpec, DataQualityIssue, SyncRun) + Phase 4
  AnalysisRun (v2) all present.
- Migrations applied: `0_init`, `20261014121253_phase3_market_data`,
  `20261014133225_phase4_analysis_runs` (verified via `_prisma_migrations`).
- All 144 tests re-run at the current tree (§0 row 3) — the test-pass claim is
  now an executed fact, not a README assertion.

### 1.2 "§D3 says Prisma Decimal but the schema uses String"

Not a contradiction — it is the decision trail. §D3 of the Phase 3 audit
records the **empirical finding** (Prisma `Decimal` on SQLite stores as REAL
float64 — `typeof() === 'real'`), and the schema comment records the
**resulting decision**: persisted prices are canonical decimal TEXT
(`"2654.32"`). The engine parses them to float64 for calculation only; the
exact text is preserved in every persisted input snapshot. This is restated
in the Phase 3 schema header comment and in `calculationConfig.pricePrecision`
of every analysis run (`exact-decimal-text-persisted-float64-calculated`).

### 1.3 "Migration drops MarketTick / rebuilds MarketCandle — data-loss risk"

Verified facts for migration `20261014121253_phase3_market_data`:

- At migration time the affected tables had **0 rows** (the Phase 1 scaffold
  never wrote them — only SystemEvent was written by Phase 1 code; recorded in
  the worklog Task 1/3 and consistent with the pre-Phase-4 DB state above).
  Therefore no market data existed to lose. The dropped fields
  (`timestamp`, `volume`, `quality`) belonged to the never-activated scaffold
  tables.
- The general practice concern stands and is adopted going forward: Phase 4's
  migration is **additive-only** and this audit requires that for future
  migrations (see §5).

## 2. Phase 4 changes — what was actually built

### 2.1 Prerequisite fixes from the Phase 3 review

| Review issue | Fix | Proof |
| --- | --- | --- |
| #1 API auth open by default (POST included) | `guardDataApi` hardened: POST triggers require `DATA_API_TOKEN` ALWAYS (unset → 503 `MARKET_API_TOKEN_NOT_CONFIGURED`, no bypass — not even with public reads ON). GETs fail closed by default; open only with explicit `MARKET_API_PUBLIC_READS=true`. | tests: `persistence-api.test.ts` ("POST NEVER runs…even with public reads ON", 401s, 503 posture trio in `api.test.ts`); live probe below |
| #5 Backfill coverage not verified | `computeBackfillCoverage` builds the due-bar grid for the requested range and counts what is REALLY persisted; incomplete → run is never `success` (all-incomplete→failed, some→partial) with `BACKFILL_INCOMPLETE` + per-tf coverage in the outcome. `scripts/sync-market.ts` prints the coverage table. | tests: the three backfill cases in `ingestion.test.ts`; behavior change is deliberate and documented (the old test expected `success` for a 100/288-bar day — that was the bug) |

Live posture probe after restart (curl, sandbox preview env):

```
GET /api/data/status      200   (public-reads opt-in)
GET /api/analysis/latest  200   (public-reads opt-in)
POST /api/data/sync       503   MARKET_API_TOKEN_NOT_CONFIGURED (fail closed)
POST /api/analysis/run    503   MARKET_API_TOKEN_NOT_CONFIGURED (fail closed)
```

### 2.2 Analysis engine (all pure, LLM-free, deterministic)

- `src/lib/analysis/types.ts` — typed reason codes, output contract, ENGINE_VERSION 4.0.0.
- `src/lib/analysis/readiness.ts` — per-tf gate reusing Phase 3 semantics; tick gate.
- `src/lib/analysis/swings.ts` — both-sides window; strict-left / non-strict-right; tie rule: earlier candle wins; original + confirmation timestamps.
- `src/lib/analysis/structure.ts` — HH/HL/LH/LL (+UNCLEAR on ties); trend; close-only BOS/CHoCH with consumed levels, unconfirmed wick crossings recorded separately.
- `src/lib/analysis/indicators.ts` — EMA 20/50/200 (SMA seed), RSI 14 / ATR 14 / ADX 14 (Wilder; ADX DI± surfaced). Non-finite anywhere → error, never a value.
- `src/lib/analysis/engine.ts` — orchestration + sha256 input fingerprint (exact decimal-text prices).
- `src/lib/analysis/persistence.ts` — loader (closed-only window; read-time re-validation rejects corrupt rows, e.g. `'NaN'` text) + honest AnalysisRun saver.
- `src/lib/analysis/schemas.ts`, `src/lib/analysis/service.ts` — zod schemas; orchestration with audit trail (`ANALYSIS_RUN_COMPLETED/BLOCKED/FAILED`).

Blocked semantics: ANY gate failure (tick, any timeframe, demo source,
insufficient warm-up, in-window suspicious gap) → whole run BLOCKED;
structure/indicators are OMITTED (never partially fabricated).

### 2.3 API + dashboard

- `POST /api/analysis/run` (always-auth trigger) and `GET /api/analysis/latest`.
- New Bengali "বিশ্লেষণ" dashboard tab: last-run card (status/engine/fingerprint),
  per-tf readiness chips, per-tf structure + indicator cards, BLOCKED banner
  with Bengali reason text, explicit "কোনো ট্রেড সিগন্যাল নয়" disclaimers.

### 2.4 DB migration (additive only)

`prisma/migrations/20261014133225_phase4_analysis_runs/migration.sql` contains
ONLY `ALTER TABLE "AnalysisRun" ADD COLUMN …` (6 nullable columns) and
`CREATE INDEX` (2). No DROP, no ALTER COLUMN, no data rewrite. Post-migration
row counts unchanged (SystemEvent 5, SyncRun 4, market tables 0, AnalysisRun 0).

## 3. Test evidence (mock vs real, reported separately)

- **Automated (mock, clearly labelled):** 144/144 pass. Phase 4 adds 62 tests:
  indicators (17 — hand-computed references incl. exact closed forms
  EMA_n=n+1−9.5, RSI 750/14, ATR 447/196, ADX=100/DI+=100),
  structure (16 — fixtures pinned in the file header), readiness/gate (13),
  persistence/API (16 — incl. real synchronous-fault injection for FAILED, not
  a mocked verdict). All bridge responses in tests are from
  `tests/market/helpers/mock-bridge.ts`; all candles are synthetic.
- **Real infrastructure:** NOT performed in Phase 4 and not claimed:
  the MT5 bridge is still not deployed and no Exness credentials exist.
  `bun run market:smoke` would honestly SKIP (exit 2). The Phase 3 blockers
  (B1 bridge not deployed, B2 no credentials) still stand.
- **Determinism:** same input + config + engineVersion → byte-identical
  output; proven by the fingerprint test (two runs → identical hash, distinct
  honest rows; changed input → different hash).

## 4. Honest MT5 / bridge status (unchanged)

- AUTH handshake against Exness web-terminal gateways: proven earlier
  (`audit/mt5-auth-probe.ts`, Task 2-research) — still the only real
  connectivity evidence.
- Live LOGIN → XAUUSDm quotes/candles: **UNVERIFIED** (no bridge, no
  credentials). No Phase 4 claim depends on it: the engine blocked-paths are
  what run in the sandbox today, by design.

## 5. Remaining risks & follow-ups

1. Bridge deployment (Phase 2 deliverable) + Exness demo credentials remain
   the prerequisite for any live data — and therefore for any meaningful
   analysis run. Until then every analysis returns BLOCKED, honestly.
2. Session envelopes remain approximate; closure-window gaps are info-only
   (never silently ignored, never claimed verified).
3. `MARKET_API_PUBLIC_READS=true` is enabled ONLY in this preview sandbox
   `.env` — production/VPS must set a strong `DATA_API_TOKEN` and leave
   public reads off.
4. The analysis engine is a technical snapshot, not a signal: Phase 5
   (signal construction) is explicitly NOT started. No order/trade/position
   code exists anywhere (statically tested, including the new
   `/api/analysis/*` routes and `src/lib/analysis/*`).
5. Future migrations must stay additive-only unless a separate, explicitly
   approved data-copy plan exists (backup → row counts → copy → verify).
