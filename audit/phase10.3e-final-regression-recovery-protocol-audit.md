# Phase 10.3-E — Final Regression, Recovery & Protocol Integrity Audit

- **Date:** 2026-10-16 (UTC) · 05:1x–05:3x observation window
- **Repo:** `psfaruk/Xauusd-agent` · branch `main`
- **Audited HEAD:** `16db957` (parent `277c98b`) — matches the expected baseline exactly
- **Mode:** AUDIT-ONLY. No code, schema, config, protocol, lock, or production-data change. No push. No commit created (per mandate: audit-only phases do not create commits when no implementation change is needed).
- **Auditor role:** senior TypeScript/Next.js/Prisma engineer + financial-system auditor

---

## 0. Executive summary

**VERDICT: PASS WITH LIMITATIONS.**

All Phase 10.3-A/B/C/D code invariants hold byte-for-byte against their approved baselines, the Phase 10.2 pre-registered protocol is byte-identical to the pre-registration commit `8d94a00`, all four execution locks are engaged (live-verified via `/api/health`), the bridge remains GET-only fail-closed (live-probed), and the full regression suite is green: **444/444 tests, eslint clean, `tsc` app 0 errors, `tsc` bridge 0 errors**, browser E2E clean at 1280×800 and 390×844 with zero console/page errors.

**The single most important finding is an environment event, not a code defect:** between the completion of Phase 10.3-D (2026-10-15 ~19:26 UTC) and this audit (2026-10-16 ~04:55 UTC), **the sandbox was rebuilt**. Evidence: every process started 2026-10-16 04:55, `.env` was regenerated to contain only `DATABASE_URL` (50 bytes; key names only inspected — no values read or printed), `db/custom.db` was re-created empty at 04:56 (gitignored by design: "runtime SQLite files are never committed — data is re-syncable from the bridge"), and the MT5 bridge process is up but **broker-disconnected** with `MT5_BRIDGE_TOKEN` unset (fail-closed 401 on all data endpoints).

Consequences of the rebuild, all verified live:

1. **The forward-paper scheduler is currently OFF** — `instrumentation.ts` requires `MARKET_SYNC_INTERVAL_MS > 0` AND `MT5_BRIDGE_URL`; neither is set in the regenerated `.env`. Zero scheduler ticks appear in `dev.log`. This is the documented default-off posture, but it means **the Phase 10.2 observation clock is currently paused at the runtime level** (the pre-registered deadline 2027-01-13T16:30:00Z is stored in the protocol itself and is unaffected).
2. **All data APIs fail closed** with `503 MARKET_API_TOKEN_NOT_CONFIGURED` (`DATA_API_TOKEN` unset, `MARKET_API_PUBLIC_READS` unset) — the Phase 8 security posture working exactly as designed. The dashboard renders its honest empty states; nothing is fabricated.
3. **The runtime DB is empty** (0 SignalEvaluation / 0 PaperSignalOutcome / 0 candles / 0 specs / 0 analysis runs; 1 SystemEvent: `GLM_VERIFY_OK` at 04:56:19Z). **No paper outcome has ever existed** — the git-committed durability export `audit/phase10.2-paper-snapshot.json` (generated 2026-10-15T16:27:59Z) proves `rawRowCount: 0`, verdict `IN_PROGRESS`, 0/20 — so **the empty DB is fully consistent with the pre-registered protocol state; no protocol-critical data was lost.** What was lost is observability history (41 evaluation rows incl. the 19 10.3-D rows with rules snapshots, ~5000 candles, 2 analysis runs) — all documented as re-syncable and none ever part of verdict inputs.

**Restoration of the live loop is a user decision outside this audit's scope** (it requires re-adding env keys `MARKET_SYNC_INTERVAL_MS`, `MT5_BRIDGE_URL`, `MT5_BRIDGE_TOKEN`, bridge token/MT5 credentials via the platform's secure mechanism — credentials are never handled in chat). No defect fix is required to restore: the code, schema (zero drift vs `schema.prisma`), migration history, tests, and protocol all survived the rebuild intact via git.

No 10.3-A/B/C/D correctness defect was found. One cosmetic pre-existing observation is recorded (§9.3, static "TRADING_PHASE=4" label) — not a regression, not fixed (audit-only).

---

## 1. Mandatory preflight — verified baseline

| Check | Expected | Actual | Result |
|---|---|---|---|
| Branch | `main` | `main` | PASS |
| HEAD | `16db957` | `16db957` | PASS |
| Parent | `277c98b` | `277c98b` | PASS |
| Working tree | clean | clean (`git status --short` empty) | PASS |
| 10.3-A report | exists | `audit/phase10.3a-setup-identity-dedup.md` (+ design note) | PASS |
| 10.3-B report | exists | `audit/phase10.3b-paper-walk-chronology.md` | PASS |
| 10.3-C report | exists | `audit/phase10.3c-price-precision.md` | PASS |
| 10.3-D report | exists | `audit/phase10.3d-rules-snapshot-observability.md` | PASS |
| Protocol vs `8d94a00` | byte-identical | `git diff 8d94a00 HEAD -- …` = 0 lines for `paper-protocol.ts`, `core.ts`, `rules.ts`, `types.ts`, `src/lib/config.ts` | PASS |
| `forward.ts` (protocol runner) | unchanged since introduction `7da47ee` | `git diff 7da47ee HEAD -- src/lib/signal/forward.ts` = 0 | PASS |
| Execution locks | all locked | no `TRADING_*`/`EXECUTION_*` keys in `.env` → defaults: phase 1 (<11), `read_only`, `EXECUTION_ARMED=false`, `ALLOW_EXECUTION=false`; live `/api/health`: `executionLocked: true`, `tradingMode: "read_only"`, `checks.executionLock: "engaged"` | PASS |
| Bridge read-only | GET-only, no order routes | `mini-services/mt5-bridge/index.ts` lines 49–51: non-GET → 405; routes only `/health`, `/api/status`, `/api/symbols`, `/api/quote`, `/api/candles`; live probes: `POST /api/quote` → **405**, `GET /api/quote` no token → **401**, `GET /api/candles` no token → **401**, header `x-bridge-readonly: 1` | PASS |
| Order-submission scan | none | `rg "OrderSend|order_send|submitOrder|placeOrder|closePosition|modifyPosition|TRADE_ACTION|ORDER_TYPE"` over `src/`, `mini-services/`, `scripts/` → **0 hits**; `db.tradeApproval`/`db.executionLog` never referenced (dead Phase-5-era schema, never written) | PASS |
| DB state | record (read-only) | all tables 0 rows except SystemEvent=1 (`GLM_VERIFY_OK`); see §0 rebuild finding | RECORDED |
| Scheduler state | confirm, don't restart | scheduler **OFF** (env keys absent after sandbox rebuild; no `[scheduler]` lines in `dev.log`; single `next-server` PID 1091 holds :3000; single bridge PID 1340 holds :3031 — no duplicate instances) | RECORDED |
| Secret exposure | none | `.env` key names only (`DATABASE_URL`); `dev.log` secret-pattern scan (ghp_/x-trader-key/password/MT5_BRIDGE_TOKEN=) → 0 hits | PASS |
| Local commits not pushed | yes | `main...origin/main [ahead 11]`, no push performed | PASS |

Preflight conclusion: **no invariant owned by the codebase failed.** The environment rebuild (§0) changed the *runtime* state but violated no preflight invariant as specified (HEAD/parent/tree/protocol/locks/bridge/routes all match; DB counts were to be *recorded*, and the recorded state is provably consistent with the only durability-critical fact: 0 paper outcomes ever).

---

## 2. Cross-phase regression audit (integrated implementation)

### 2.1 Phase 10.3-A — Setup identity & deduplication

| Property | Evidence | Result |
|---|---|---|
| Fingerprint deterministic | `src/lib/signal/setup-identity.ts` — pure `sha256(JSON.stringify(payload))` over `{identityVersion: 'setup-identity/1', symbol, timeframe, strategyVersion, setup:{type,direction,level,breakCandleTimeUtc}}`; **byte-identical to its approval commit** (`git diff 8173751 HEAD -- src/lib/signal/setup-identity.ts` = 0) | PASS |
| Same setup → no duplicate paper outcomes | `PaperSignalOutcome.setupFingerprint @unique` (migration `20261015120000_phase10_3a_setup_fingerprint`); `trackPaperSignals` catches P2002 → `duplicatesSuppressed`; tests: "two concurrent tracker passes over the same setup → exactly ONE row", "constraint scope: one row per fingerprint value … ever" | PASS |
| Excluded fields stay excluded | decision candle, tick data, indicators, levels, outcome codes all absent from the payload (file lines 16–21, 52–65) | PASS |
| Legacy rows without fingerprints readable | evaluationId-first lookup path preserved; test: "a NULL-fingerprint legacy paper row advances by evaluationId and is never backfilled" | PASS |
| No resolved outcome overwritten | tests: "later pass after resolution → immutable row", "resolved row stays byte-stable across later passes with NEW bars", "a re-emission after resolution never mutates" | PASS |
| Strategy-version / identity semantics unchanged | `setup-identity.ts` untouched since `8173751`; `engineVersion`/`strategyVersion` not bumped in 10.3-D (verified in 10.3-D report §live-fingerprint-continuity: `setupFingerprint 730259ec7b3616e6` identical pre/post 10.3-D) | PASS |

### 2.2 Phase 10.3-B — Paper-walk chronology

Code evidence, `src/lib/signal/paper.ts` (byte-identical to `6419ebd` — `git diff 6419ebd HEAD` = 0 lines):

| Property | Code line | Result |
|---|---|---|
| No candle used before it was available after signal creation | `if (closeSec <= signalCreatedUtcSec) continue;` (strict `>`, publication bound) + query bound `gt max(decisionOpen, creation−900)` | PASS |
| Only candles strictly before expiry eligible | `if (bar.timeUtcSec >= expiryUtcSec) continue;` + query `lt expiryUtc` — the 13th bar opening AT expiry can never act | PASS |
| Only fully closed candles processed | `if (closeSec > nowUtcSec) continue;` + query `lte now` + `isForming: false`, `validationStatus: 'VALID'`, `source: 'bridge-mt5'`, OHLC re-validated at read time | PASS |
| Invalid chronology / duplicates / off-grid / corrupt → fail closed | throws: "not on the M15 UTC grid", "order not strictly ascending", advance-time prechecks throw on `createdAt < setupKnownAt` and `setupKnownAt ≠ decision+900` → row error, no advance, stays open | PASS |
| Missing candles = documented non-observation | test: "gap in the window (missing bar) → no error, fewer observations, honest expiry exit" | PASS |
| Frozen geometry unchanged | entry/SL/TP/expiry/outcome arithmetic untouched (`paper.ts` diff vs `6419ebd` = 0); SL-first collision rule pinned by tests | PASS |

### 2.3 Phase 10.3-C — Price precision (presentation-only)

| Property | Evidence | Result |
|---|---|---|
| All UI price displays use the deterministic formatter | `price-display` imported ONLY by `src/app/page.tsx` (+ its own module + tests) — `rg -l "price-display" src/` confirms; 39 tests `tests/market/price-display.test.ts` | PASS |
| Precision from verified metadata, never assumed default | `priceDisplaySpecFromSymbolSpec`: digits accepted only from `verifiedFields`; missing/stale/invalid → `UNVERIFIED` → raw text shown + flagged | PASS |
| Missing/stale/invalid metadata handled honestly | tests: metadata missing/stale paths; live: with the specs table now empty the dhealth card shows honest `—` states (E2E screenshots) | PASS |
| Display never mutates calculation values | formatter returns strings/`{text, anomaly, rawText}` objects; purity pinned by tests; `rawText` preserved in tooltip | PASS |
| Quote/spec digit mismatches remain visible | mismatch ⚠ logic present (10.3-C report D-series); not live-observable now (no live quotes) — test-covered | PASS |
| No formatter effect on risk/R:R/levels/outcomes | formatter unreachable from calculation modules (import graph); backtest/paper/forward engines do not import it | PASS |

### 2.4 Phase 10.3-D — Rules snapshot & observability

| Property | Evidence | Result |
|---|---|---|
| New evaluations persist actual rules used | `saveSignalEvaluation` (persistence.ts lines 107–140): `buildRulesSnapshot(args.rules, {symbol, engineVersion, digits})` → `inputSnapshot.rules`; build failure → structured `{error: 'INVALID_RULES_SNAPSHOT', diagnostic}` — never throws | PASS |
| Historical null snapshots remain null | no backfill code path; parse maps null/absent → `not-recorded`; "Legacy rows keep rules:null … never backfilled" (comment + tests) | PASS |
| not-recorded ≠ invalid | parse states: `not-recorded` (legacy null/absent) vs `invalid` (version/shape/NaN/contradiction, safe reason codes e.g. `VALUE_TYPE_INVALID:<id>`, `VERSION_UNSUPPORTED`) | PASS |
| Validation rejects malformed data safely | 41 tests: malformed JSON, missing/unsupported version, NaN/Infinity survivors, wrong types, dropped/duplicate/unknown rule ids → invalid | PASS |
| Historical snapshots not recomputed from current rules | parse-only rendering; "snapshot versions come from the EVALUATION, not from 'current' constants" test | PASS |
| Snapshot hash separate from setup/protocol fingerprints | three distinct namespaces: input fingerprint (core.ts, pre-registered), `setup-identity/1` (10.3-A), `rules-snapshot/1` (rules-snapshot.ts line 133) | PASS |
| Dashboard counts distinguish evaluations / distinct setups / paper outcomes | three-count strip in validation tab; note "মূল্যায়ন-সংখ্যা ≠ স্বতন্ত্র সেটআপ-সংখ্যা" verified rendering in E2E | PASS |
| No sensitive config values exposed | test "no secret fields in the serialized snapshot"; manifest carries only rule values/units/provenance | PASS |

---

## 3. Independent invariant checks (not relying on the test suite alone)

| # | Invariant | Independent evidence | Verdict |
|---|---|---|---|
| 1 | Setup fingerprint unchanged from approved 10.3-A | `git diff 8173751 HEAD -- src/lib/signal/setup-identity.ts` = **0 bytes** | HOLDS |
| 2 | Chronology rules match 10.3-B spec | `git diff 6419ebd HEAD -- src/lib/signal/paper.ts` = **0 bytes**; code read of the three bounds + two prechecks (§2.2) | HOLDS |
| 3 | 10.3-C formatter presentation-only | import graph: only `page.tsx`; string-typed outputs; purity tests | HOLDS |
| 4 | 10.3-D snapshot persisted without changing strategy input fingerprint | `core.ts` byte-identical to `8d94a00` (fingerprint payload includes `rules: input.rules` — unchanged since pre-registration); snapshot is written into a *different* column (`inputSnapshot.rules`) with its own hash namespace | HOLDS |
| 5 | Phase 10.2 protocol byte-identical to `8d94a00` | `git diff 8d94a00 HEAD` = 0 for `paper-protocol.ts`, `core.ts`, `rules.ts`, `types.ts`, `src/lib/config.ts`; `forward.ts` = 0 vs `7da47ee` | HOLDS |
| 6 | Four execution locks intact | code: `config.ts` requires `phase ≥ 11 AND EXECUTION_ARMED AND ALLOW_EXECUTION AND mode ≠ read_only`; env: no activation keys; live: `/api/health` `executionLocked: true` | HOLDS |
| 7 | Bridge read-only | code + live 405/401 probes + `x-bridge-readonly: 1` | HOLDS |
| 8 | No order-execution endpoint/method/switch introduced | full-tree scans (§1); all 19 app API routes inventoried — non-GET routes are `analysis/run`, `signal/run`, `backtest/run`, `ai/verify`, `chat`, `data/sync` (research/ingestion triggers, all pre-existing and token-guarded) | HOLDS |
| 9 | Validation verdict not manually overridden | `computeForwardVerdict` in `paper-protocol.ts` (byte-identical to pre-registration): ordered rules IN_PROGRESS → INCONCLUSIVE_TIMEOUT → NEGATIVE_AFTER_COSTS → INCONCLUSIVE_CONCENTRATION → INCONCLUSIVE_DRAWDOWN → PROMISING_CONTINUE_FORWARD; no env/manual override path exists | HOLDS |
| 10 | No threshold/rule/validation window silently changed | protocol files byte-identical (§3.5); drift-guard test "pre-registered constants are the documented values" passes | HOLDS |

---

## 4. Recovery & restart audit

### 4.1 LIVE recovery event (observed, not simulated)

The sandbox rebuild of 2026-10-16 04:55 UTC **is** a real recovery event and was observed without interfering with it:

- **What survived (git-committed):** all 24 local commits including 10.3-A/B/C/D (`16db957`), all audit reports, the pre-registered protocol, migration history (5 migration folders incl. `20261015120000_phase10_3a_setup_fingerprint`), the full test suite, the durability export `audit/phase10.2-paper-snapshot.json`.
- **What was lost (runtime-only, gitignored by design):** `db/custom.db` contents — 41 SignalEvaluation rows (incl. 19 rows carrying 10.3-D rules snapshots), ~5,000 MarketCandle rows, SymbolSpec rows, MarketLatestTick rows, 2 AnalysisRun rows. The `.gitignore` comment documents this exact posture: "runtime SQLite files are never committed (data is re-syncable from the bridge; schema lives in prisma/)".
- **Protocol-critical loss: NONE.** The committed snapshot export (generated 2026-10-15T16:27:59Z, before any evaluation activity of 10.3-D) proves `rawRowCount: 0` — **zero paper outcomes have ever existed**, so there was nothing outcome-critical to lose. Verdict inputs (paper rows) are 0 before and 0 after.
- **Honest fail behavior after recovery:** fresh DB auto-created with zero schema drift (`prisma migrate diff --from-url db --to-schema-datamodel` → "No difference detected"); `/` renders 200; data APIs fail closed 503 `MARKET_API_TOKEN_NOT_CONFIGURED`; dashboard shows honest empty states ("এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি", "সৎ খালি অবস্থা"); no fabricated data, no crash loops, no scheduler zombie.
- **Scheduler state:** OFF (missing env keys) — **the paper-validation loop is paused until the user restores configuration.** No data is being collected during the pause; the 90-day window (activated 2026-10-15T16:30:00Z, deadline 2027-01-13T16:30:00Z) is defined inside the pre-registered protocol itself, and elapsed observation time accrues only from real paper rows (currently 0). This is an honest pause, not a protocol distortion.

### 4.2 Scheduler architecture (code-reviewed)

- In-memory state only: a single `setInterval` + one warm-up `setTimeout`, both `.unref()`; `register()` executes once per server process (Next.js instrumentation contract); exactly one `next-server` process holds :3000 (verified `ss -tlnp`) — **no duplicate scheduler registration possible in the current topology**.
- Overlap: module-level guard refuses concurrent syncs (`SYNC_IN_PROGRESS`, ingestion.ts line 201).
- All durable truth is in the DB: `trackPaperSignals` re-derives state from rows each pass — isolation-tested by "a fresh tracker pass (all state from the DB) never duplicates".

### 4.3 Isolated failure probes (this audit, non-destructive)

- **DB unavailable:** Prisma client pointed at a non-existent path → clean `PrismaClientInitializationError` (fail-closed, no hang, no silent wrong data). Route-level `try/catch` returns structured 500 `INTERNAL_ERROR`. Isolated test — **not** a live kill of the production DB (prohibited).
- **Bridge unavailable (live):** bridge process up but MT5-disconnected; app data layer reports `bridgeConfigured: false`, `dataReady: false` in `/api/health` — no crash, no fabrication.

### 4.4 Restart-while-unresolved-outcomes — honesty note

**Live verification was impossible** (no unresolved paper rows exist; the only live restart observed had zero rows). Evidence for this scenario is therefore **isolated-test only** ("fresh tracker pass from DB never duplicates"; "unresolved setup stays open and advances observations on repeated runs"; "open row re-advanced at the same clock → idempotent"). This audit explicitly does **not** claim live-verified recovery with open outcomes.

---

## 5. Lifecycle coverage & the zero-SETUP limitation

**No live SETUP has ever been observed — before or after the rebuild. No filter was weakened, no threshold tuned, no protocol changed to force one** (per mandate). Live lifecycle evidence is limited to the empty/degraded paths; everything else is unit/integration/frozen-dataset evidence:

| Lifecycle state | Evidence type | Evidence |
|---|---|---|
| BLOCKED | unit (engine ×8) | SPEC_MISSING, INSUFFICIENT_DATA, H4/H1-missing, FORMING_CANDLE_IN_INPUT, CHRONOLOGY_BROKEN, DATA_INVALID, SOURCE_DEMO |
| WAIT | unit (engine ×4) | HTF-opposite, RETEST_PENDING, PRICE_BEYOND_ENTRY_ZONE, SPREAD_TOO_WIDE |
| NO_SETUP | unit (engine ×3) | NO_STRUCTURE_BREAK, ZONE_INVALIDATED, STRUCTURE_BREAK_TOO_OLD |
| SETUP | unit (engine ×3) | BUY_SETUP with valid levels, SELL mirror, mutual consistency |
| Paper outcome opened | integration (paper.test) | "unresolved setup stays open and advances observations on repeated runs" |
| Stop-loss resolution | integration | "SL touched → stopped"; same-bar collision → conservative stopped |
| Target resolution | integration | "target touched → targeted at the target level" |
| Expiry | integration (×4) | expiry at last in-window close; expired with NO observable bars → null exit (never fabricated); boundary `now == expiry` |
| Invalidation | integration | "close back through the broken level → invalidated" |
| Incomplete/corrupted market data | integration (chronology ×28) | off-grid/duplicate/out-of-order → throw (row error, stays open); gap → honest non-observation |
| Repeated evaluation of one setup | integration (identity ×19) | 11-eval cluster → 1 row; concurrent passes → 1 row; re-emission after resolution never mutates |
| Restart/recovery | LIVE (empty) + isolated | §4: rebuild with 0 rows; DB-state-only tracker pass tests |

Evidence classes are strictly separated: **unit/integration** (above), **frozen-dataset** (10.3-B walker comparison on frozen synthetic dataset; 10.3-C display comparison on frozen backtest dataset — both from prior phases, reports committed), **live runtime** (only empty-state + fail-closed paths; zero SETUP/paper-walk live evidence ever). Synthetic coverage is **not** labeled a live broker test anywhere in this report.

---

## 6. Full regression validation — exact commands & results

| Check | Command | Result |
|---|---|---|
| Full test suite | `bun test` | **444 pass / 0 fail**, 1764 expect() calls, 23 files, 14.06s — matches the reported 444/444 baseline exactly |
| Focused: setup identity | `tests/signal/setup-identity.test.ts` (19) | pass (within suite) |
| Focused: chronology | `tests/signal/paper-chronology.test.ts` (28) | pass (within suite) |
| Focused: price formatting | `tests/market/price-display.test.ts` (39) | pass (within suite) |
| Focused: rules snapshots | `tests/signal/rules-snapshot.test.ts` (41) | pass (within suite) |
| Lint | `bun run lint` (`eslint .`) | exit 0, no output |
| App TypeScript | `bunx tsc --noEmit` | exit 0, 0 errors |
| Bridge TypeScript | `cd mini-services/mt5-bridge && bunx tsc --noEmit` | exit 0, 0 errors |
| DB schema/migration validation | `bunx prisma migrate diff --from-url file:db/custom.db --to-schema-datamodel prisma/schema.prisma` | **"No difference detected"** (read-only) |
| Protocol fingerprint comparison | `git diff 8d94a00 HEAD -- <protocol files>` | 0 lines (§3.5) |
| Execution-lock audit | env names + `config.ts` logic + live `/api/health` | all locked / engaged |
| Bridge health (read-only) | `GET :3031/health` | 200 `{ok:true, connected:false, source:"disconnected"}` + 405/401 fail-closed probes |
| App health | `GET :3000/api/health` | 200, `executionLocked: true`, `database: ok`, `glm: verified`, market honest `dataReady: false` |
| Browser E2E 1280×800 | agent-browser | page 200; Order Execution LOCKED card; GLM verified; bridge card honest "ডেটা অবস্থা: — · প্রস্তুত: না"; signal tab honest empty + counts note; validation tab "সৎ খালি অবস্থা"; **0 page errors, 0 console errors**; screenshots `audit/phase10.3e-{desktop,signal-tab,validation-tab}.png` |
| Browser E2E 390×844 | agent-browser | scrollWidth 390 = clientWidth 390 (**no horizontal overflow**); footer pinned to viewport bottom (rect.bottom 844 = innerHeight 844); signal tab honest empty; 0 errors; screenshots `audit/phase10.3e-{mobile,mobile-signal}.png` |
| `dev.log` review | full read + pattern scans | 0 secrets; only anomaly = one transient `EADDRINUSE :::3000` at startup (a duplicate-start race during the sandbox restart; the server then bound successfully and is healthy — pre-existing environment event, not a code regression); no scheduler errors (scheduler off); 503s all `MARKET_API_TOKEN_NOT_CONFIGURED` (honest fail-closed) |
| Production build | **NOT RUN** | sandbox rule prohibits `bun run build` — recorded as **UNVERIFIED**; no build-pass claim is made |

No check failed. No pre-existing failure was found to conceal: the suite was fully green at the baseline and remains fully green.

---

## 7. Frozen before/after comparison

"Before" = state captured at audit start (05:14 UTC); "After" = state after all audit activity (05:3x UTC). All queries read-only (`SELECT COUNT`/`findFirst`/`$queryRaw`).

| Metric | Before | After | Δ |
|---|---|---|---|
| SignalEvaluation | 0 | 0 | 0 |
| distinct setupFingerprint | 0 | 0 | 0 |
| PaperSignalOutcome | 0 | 0 | 0 |
| AnalysisRun / BacktestRun / ValidationRun | 0/0/0 | 0/0/0 | 0 |
| MarketCandle / SymbolSpec / MarketLatestTick | 0/0/0 | 0/0/0 | 0 |
| SystemEvent | 1 (`GLM_VERIFY_OK` 04:56:19Z, pre-audit) | 1 | 0 |
| Signal IDs / setup fingerprints / snapshot hashes / entry-SL-TP-R:R / resolution timestamps | none exist | none exist | n/a (nothing to mutate — and nothing was) |
| Phase 10.2 aggregation inputs / verdict | 0 rows → IN_PROGRESS 0/20 (per committed protocol + snapshot export) | unchanged | 0 |
| Protocol fingerprint | byte-identical to `8d94a00` | byte-identical (re-verified) | 0 |
| Execution-lock state | locked (live) | locked (unchanged) | 0 |
| Git working tree | clean @ `16db957` | clean except this new report file (the deliverable) | intended |

**The audit changed no production data, no trading calculation, no strategy eligibility, no setup identity, no chronology, no validation threshold, and no protocol behavior.** (The historical 41-row dataset that previous phases compared against no longer exists at runtime due to the rebuild — the frozen comparisons for those phases live in their committed reports and remain valid as historical evidence.)

---

## 8. Failure & recovery scenarios

| Scenario | Expected behavior | Actual behavior | Evidence | Type |
|---|---|---|---|---|
| Bridge unavailable | fail-closed, no fabricated data | data layer `bridgeConfigured:false`, `dataReady:false`; APIs honest; no crash | live `/api/health` + E2E (bridge MT5-disconnected since rebuild) | **observed live** |
| Stale quote | BLOCKED TICK_STALE, no signal | engine gates; 2 live BLOCKED rows existed pre-rebuild (Phase 10.2 report); now unobservable live (no quotes at all) | unit/integration + historical live | unit + historical live |
| Missing symbol precision | BLOCKED SPEC_MISSING / UNVERIFIED display → raw, never default precision | engine test + price-display tests; live now: specs table empty → honest `—`/raw states | tests + live degraded path | unit + live (degraded) |
| Invalid rules snapshot | invalid (≠ not-recorded), safe reason, no throw | 41 tests: version/shape/NaN/type/id failures → diagnostic | `tests/signal/rules-snapshot.test.ts` | unit |
| Legacy evaluation without snapshot | not-recorded display, never reconstructed | parse states + tests; was live-proven in 10.3-D (18 legacy rows) — those rows no longer exist post-rebuild | unit + historical live | unit + historical live |
| Corrupted / duplicate candle | fail-closed (throw → row error, no advance) / rejected at ingestion | chronology tests ×28; ingestion validation tests | tests | unit/integration |
| Database temporarily unavailable | structured error, fail-closed, no hang | `PrismaClientInitializationError` probe; route try/catch 500 | isolated probe (§4.3) | **isolated test** |
| Repeated scheduler invocation | refused, not queued (`SYNC_IN_PROGRESS`) | ingestion.ts line 201 + guard test | code + unit | code + unit |
| Repeated evaluation of one setup | one paper row ever (DB unique + P2002) | identity tests ×19 | tests | integration |
| Restart while unresolved paper outcomes exist | no duplication, walk continues from frozen geometry | DB-state-only tracker tests — **not live-verifiable (no unresolved rows exist)** | tests only | **isolated only** |
| Resolved outcome encountered again | immutable, byte-stable, never recounted | "later pass after resolution → immutable row"; first-open aggregation excludes resolved repeats | tests | integration |
| Missing required configuration | default-off / fail-closed 503, never silent activation | **live now**: scheduler OFF (no keys), data APIs 503 `MARKET_API_TOKEN_NOT_CONFIGURED`, locks at locked defaults, zero crashes | live `/api/*` + `dev.log` | **observed live** |

All observed behaviors match the existing architecture's contracts. **No new behavior was invented during this audit.**

---

## 9. Findings

### 9.1 ENV-1 (HIGH, environment — not a code defect) — Sandbox rebuild degraded the live loop
The 2026-10-16 04:55 UTC rebuild left the system code-complete but runtime-degraded: scheduler OFF, bridge MT5-disconnected, DB empty, data APIs fail-closed. **Phase 10.2 observation is paused at the runtime level.** Restoration (user decision, outside audit scope): re-add `MARKET_SYNC_INTERVAL_MS`, `MT5_BRIDGE_URL`, `MT5_BRIDGE_TOKEN` (and `DATA_API_TOKEN` or `MARKET_API_PUBLIC_READS=true` for the dashboard) via the platform's secure env mechanism, and re-authenticate the MT5 bridge session (Phase 9.2 procedure). Credentials must never transit chat. Until then, no new evaluations/paper rows can be created — consistent with the honest-empty dashboard.

### 9.2 DATA-1 (INFO) — Observability history lost with the runtime DB
The 41 evaluation rows (incl. 19 with rules snapshots), candles, ticks, specs, and 2 analysis runs are gone. None affect the verdict (0 paper outcomes ever — proven by the committed snapshot export). Historical evidence for 10.3-A/B/C/D live behavior is preserved in the committed phase reports and screenshots; the current DB cannot re-show it.

### 9.3 COSM-1 (INFO, pre-existing — not a 10.3 regression) — Static "TRADING_PHASE=4" card label
`src/app/page.tsx` line 1646 renders a static informational line "TRADING_PHASE=4 · চার-সুইচ গেট (Phase ≥ 11)" on the Order Execution LOCKED card — written in the Phase-4 era (introduced in `8eba403`) and identical at `16db957`. The actual lock state is displayed correctly (LOCKED; `/api/health` phase 1, read_only). Cosmetic staleness only; **not fixed** (audit-only phase; no code change without approval).

### 9.4 No correctness defect found in 10.3-A/B/C/D
No fix was implemented; nothing was silently changed.

---

## 10. Residual risks & unresolved issues

1. **R-E1 — Observation-clock pause:** until env/bridge are restored, no forward-paper evidence accrues; the 90-day window deadline (2027-01-13) is protocol-fixed, so a long pause reduces effective observation time. User action required (§9.1).
2. **R-E2 — Live lifecycle paths remain unexercised:** zero SETUP ever; the entire SETUP→paper-walk path (levels card, expiry UI, paper outcome rendering, live dedup effect) is proven only by tests/frozen datasets. This limitation is *stronger* now: even the historical NO_SETUP/WAIT/BLOCKED evaluation stream is gone from the live DB.
3. **R-E3 — Restart-with-open-outcomes unproven live:** isolated-test-only (§4.4). Will remain so until the first SETUP exists and survives a restart.
4. **R-E4 — Production build unverified:** prohibited by sandbox rules; lint/tsc/tests/dev-server/browser verification reported instead.
5. **R-E5 — Legacy-row dashboard paths:** the "not recorded for this evaluation" branch was live-proven in 10.3-D but can no longer be observed live (legacy rows lost); remains covered by 41 lib tests.
6. **R-E6 — Cosmetic label (COSM-1)** persists until a future authorized UI pass.

---

## 11. Protocol integrity — final statement

- Phase 10.2 pre-registered files are **byte-identical** to `8d94a00`: `src/lib/signal/paper-protocol.ts`, `src/lib/signal/core.ts`, `src/lib/signal/rules.ts`, `src/lib/signal/types.ts`, `src/lib/config.ts`; the runner `src/lib/signal/forward.ts` is byte-identical to its authorized introduction `7da47ee`.
- Verdict logic is rule-driven with no manual override; drift-guard test pins the constants.
- Paper outcomes: **0 ever** (committed durability export + live DB agree).
- Phase 10.2 verdict state: **IN_PROGRESS, 0/20 completed trades, 90-day window to 2027-01-13T16:30:00Z** — unchanged by the rebuild and by this audit.
- Four execution locks engaged; bridge read-only; no order-execution capability exists anywhere in the codebase.

---

## 12. Verdict

**PASS WITH LIMITATIONS.**

- **PASS:** every code-level invariant of Phases 10.3-A/B/C/D holds against its approved baseline (byte-level where applicable); the Phase 10.2 pre-registered protocol is byte-identical to pre-registration; all four execution locks are engaged; the bridge is verifiably read-only; the full regression suite (444/444), lint, both TypeScript checks, schema validation, and browser E2E (desktop + mobile) are green with honest empty-state rendering; the audit itself changed nothing.
- **LIMITATIONS:** (1) the sandbox rebuild paused the live observation loop (scheduler OFF, bridge disconnected, runtime DB empty) — restoration is a user action outside this audit; (2) zero live SETUP ever — lifecycle coverage beyond the empty state is unit/integration/frozen-dataset evidence, not live; (3) restart-with-unresolved-outcomes is isolated-test-only; (4) production build not run per sandbox rule.

No commit was created (audit-only, no implementation change). No push. No order execution. The active paper-validation *state* (0 outcomes, pre-registered protocol, IN_PROGRESS 0/20) is preserved exactly.
