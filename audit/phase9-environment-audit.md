# Phase 9 — Environment Audit v2 Report (Task A)

**Date:** 2026-10-15 (Asia/Dhaka) · **Scope:** audit model v2, honest API, bridge-architecture checks, metadata reconciliation
**Live state during verification:** dev :3000 up · bridge :3031 authenticated (Exness-MT5Trial6, gateway 47.130.41.116) · XAUUSDm LIVE quote
**Commands executed:** `bun test` 243/243 · `bun run lint` clean · `bunx tsc --noEmit` 0 errors (app) · 0 errors (bridge, own tsconfig) · browser E2E (agent-browser)

---

## 1. A1 — The misleading static checklist is REPLACED — **PASS**

| Item | Before (Phase 1 shape) | After (v2) |
|---|---|---|
| Status vocabulary | `pass / warn / fail` (3 states) | `PASS / WARN / FAIL / BLOCKED / NOT_APPLICABLE / NOT_TESTED` (6 states, `src/lib/audit/model.ts`) |
| `wine` check | `fail` (shown as a current failure forever) | current check `dep.wine` = **NOT_APPLICABLE** with code-inspection evidence + historical `phase1.wine` = FAIL preserved verbatim |
| `mt5-pkg` check | `fail` | `dep.metatrader5-python` = **NOT_APPLICABLE** (same pattern) |
| Evidence model | one string per check | evidenceType (STATIC/COMMAND/API_PROBE/LIVE_BROKER/FIXTURE), timestamps, duration, runtime identity, HTTP status, freshness policy, reason |
| Aggregation | unexplained "9 pass / 2 fail" | separate totals: currentRequired{pass,warn,fail,blocked} / notApplicable / historical / notTested |

The two legacy checks became NOT_APPLICABLE **only after code inspection** established that no runtime path depends on Wine or the MetaTrader5 Python package (the market-data path is `mini-services/mt5-bridge`, a TypeScript WebSocket client) — evidence text cites the inspection and links the preserved Phase 1 failures (`phase1.wine`, `phase1.mt5-pkg`) so nothing is hidden.

## 2. A2 — Historical vs current evidence separation — **PASS**

- `src/lib/audit/historical.ts`: the 11 Phase 1 command results preserved **verbatim** (original values, original timestamp `2026-10-14T17:40:00Z`, phase tag 1, `freshnessPolicy: historical-phase1`, `evidenceType: COMMAND`).
- Current checks (`src/lib/audit/runtime-checks.ts`): executed fresh per request with `freshnessPolicy: per-request`, each carrying start/completion timestamps, duration ms, commit identity (read from `.git` safely in-process — no shell), HTTP status where applicable.
- Pinned by tests: historical entries never enter current-required totals; NOT_APPLICABLE / NOT_TESTED never count as PASS (`tests/audit/runtime-checks.test.ts`).

## 3. A3 — Honest audit API — **PASS**

- `GET /api/audit/environment` (v2, `model: environment-audit/2.0`) combines: (1) current runtime checks (fresh per request), (2) preserved historical evidence, (3) persisted facts (last GLM verification, last sync, run counts), (4) data-health state through the checks themselves, (5) explicit notes on what a refresh re-runs and what it never re-runs.
- **No shell execution through HTTP — by construction:** the check ids are hard-coded; the only client input is an optional symbol validated against the allowlist. A client can never supply a command, path or URL.
- No separate audit-run trigger was needed (documented decision in the pre-audit): the fresh checks are bounded in-process probes (≤4 s timeouts, no retries), safe per request. The endpoint is now read-guarded (`guardDataApi` 'read') — an authorization STRENGTHENING over the Phase 1 public posture.

## 4. A4 — Current bridge architecture audited as SEPARATE checks — **PASS (live)**

Each fact is its own check (verified live 2026-10-15, browser + API):

| Check | Live verdict | Evidence (excerpt) |
|---|---|---|
| `bridge.health` | PASS | GET /health → 200 ok (service mt5-bridge) |
| `bridge.authenticated-session` | PASS (LIVE_BROKER) | connected=true authenticated=true server=Exness-MT5Trial6 gateway=47.130.41.116 loginMasked=414•••70 |
| `bridge.server-identity` | PASS (LIVE_BROKER) | status.server === MT5_SERVER ("Exness-MT5Trial6") exactly |
| `data.symbol-resolution` | PASS (LIVE_BROKER) | exact-name "XAUUSDm" resolved, digits=3 verified |
| `data.fresh-quote` | PASS (LIVE_BROKER) | bid/ask valid, spread 0.240, age 0–1 s, LIVE, source=broker |
| `data.candle-history` | PASS | M5 921+ / M15 1006+ / H1 994+ / H4 999+ closed, 0 invalid, 0 duplicates, H4 ≥ 200 |
| `signal.engine-readiness` | PASS (API_PROBE) | computeReadiness ready=true |
| `database.sqlite` / `database.signal-persistence` | PASS | Prisma reads succeed; SignalEvaluation table queryable |
| `security.execution-lock` | PASS | four switches: phase 9 < 11 · armed=false · allow=false · mode=read_only → enabled=false |
| `security.read-only-surface` | PASS | bridge client = exactly 5 read-only methods; registry has no execution tool; POST inventory = 6 guarded triggers |
| `glm.runtime-access` | PASS (after live re-verify) | GLM_VERIFY_OK (chat+Bengali+tool-calling) — WARN when stale/absent, FAIL on a failed latest verification |

Failure-path tests (mock bridge): disconnected → FAIL (never PASS); connected-but-unauthenticated → FAIL; wrong server identity → FAIL; missing quote → honest unavailable. A healthy HTTP bridge alone never proves authentication; an authenticated session never proves quote freshness — the checks are independent and both orders of failure are pinned by tests.

## 5. A5 — Metadata reconciliation — **PASS**

- `mt5Feasibility`: obsolete "VPS + Wine" bridge options replaced by the current TS web-terminal bridge (marked `deployed-and-verified`); the Phase 1 study is preserved as `historicalStudy` with `supersededBy` linkage.
- `architectureLayers`: bridge layer now describes the INTERNAL :3031 service; engines layer includes signal + integrity; tools layer describes the 8 active read-only tools.
- `databaseModels`: statuses corrected — 9 active (Phases 1–9, incl. the new SignalEvaluation), Signal marked superseded (0 rows, replaced by SignalEvaluation), TradeApproval/ExecutionLog locked-until-11.
- `repositoryTree` regenerated for the Phase 9 tree; `acceptanceChecklist` entries marked historical where Phase-1-specific.
- Planned-tool list reconciled: the superseded Phase 2/4/5 planned tools were removed; `run_risk_check` (Phase 7) remains planned and refused at runtime.
- `config.version` → `0.2.0-phase9`; `TRADING_PHASE=9` (execution still locked — phase gate requires ≥ 11).

## 6. Frontend presentation (Task E overlap) — **PASS (browser-verified)**

- Audit tab v2 renders THREE sections with separate totals: "বর্তমান প্রয়োজনীয় চেক (13)" (fresh timestamps + durations + evidence types), "অপ্রযোজ্য লিগ্যাসি ডিপেন্ডেন্সি (3)" with the "NOT_APPLICABLE ≠ PASS" badge, "ঐতিহাসিক প্রমাণ — Phase 1 (11)" with original timestamps and an explicit note that a refresh never re-executes them.
- The old unexplained "N pass / 2 fail" aggregate is GONE (the `checkSummary` memo was removed).
- Two client-side crashes found during E2E (stale `audit.environmentChecks` aggregation + missing `live` block in the v2 response) were fixed and re-verified with a fresh browser: **0 errors**.

## 7. Verdicts

| Acceptance item | Verdict | Evidence |
|---|---|---|
| Environment audit no longer misrepresents obsolete Wine/Python requirements as current failures | **PASS** | §1, §4 + live UI |
| Dashboard distinguishes current vs historical evidence | **PASS** | browser-verified 3-section audit tab |
| Bridge connectivity + data freshness independently verified | **PASS (live)** | §4 table |
| No shell/HTTP command execution surface; fixed check ids only | **PASS** | §3 + tests |
| NOT_APPLICABLE / NOT_TESTED never counted as PASS | **PASS** | tests/audit/runtime-checks.test.ts |
| Failed live probe → FAIL/BLOCKED, never PASS | **PASS** | mock-bridge failure injections |
| Secrets never in the report | **PASS** | credential-pattern scan of the full report (test + live) |
| Production build | **NOT RUN** (sandbox rule prohibits `bun run build`) — compile verified via dev server + tsc + browser E2E instead | disclosed |
