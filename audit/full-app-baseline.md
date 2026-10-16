# Full-App Baseline Audit — Master Audit, Repair & Production Readiness

**Date:** 2026-10-16 · **Task:** Master full-app audit (Phases A–K)
**Branch/HEAD:** `main` @ `15b56f4` (clean working tree, in sync with `origin/main`)
**Auditors:** 5 parallel read-only audit agents (Tasks 2-a…2-e in `worklog.md`) + main-agent runtime capture.
**Method:** source-level verification with file:line evidence, live runtime probes (curl/DB), and prior-audit cross-check — prior findings were re-verified, not assumed.

---

## 0. Runtime state at audit time (verified live)

| Check | Evidence |
|---|---|
| Dev server | `next dev` (Next 16.1.3) on :3000, uptime ~2.4 h, single `next-server` process |
| Bridge | `:3031/health` → `connected:true, authenticated:true` (Exness-MT5Trial6, source `mt5`) |
| Scheduler | ON (5-min cadence); last `SyncRun` = `success` @ 15:31:50Z (mode `scheduled`); 40 runs, **0 stuck `running`** |
| Data | 1,918 candles (M5:531, M15:439, H1:455, H4:493), tick VALID @ 15:31:52Z, 0 rejected, 0 duplicates |
| Autonomous evaluation | last `SignalEvaluation` @ 15:31:53Z → `NO_SETUP [ZONE_INVALIDATED]` (engine 9.0.0) |
| Outcome distribution (since 12:56Z restore) | WAIT 30 · NO_SETUP 8 · BLOCKED 1 · **BUY/SELL 0** (consistent with 30-day frozen funnel: retest-stage trio rejects ~72% of bars; ≈1 setup-episode/1.4 days) |
| Execution locks | live `/api/health` → `executionLocked:true`, `tradingMode:read_only`, reason "Phase 11 gate required" |
| Other tables | AnalysisRun 2 (manual), SystemEvent 89, PaperSignalOutcome 0 (no setups → nothing to track), DataQualityIssue 2,000 (flood-capped 50/run), SymbolSpec 1, BacktestRun/ValidationRun 0 (history wiped by sandbox rebuild — documented, not fabricated) |

---

## 1. Verified architecture (HEAD `15b56f4`)

- **Frontend:** `src/app/page.tsx` (685 lines) + 9 terminal components (`src/components/terminal/`) + 4 lib modules (`src/lib/dashboard/`). Dark trading terminal, Bengali UI, desktop workspace + mobile 5-nav, real candlestick chart (lightweight-charts v5) fed by `/api/data/chart` which reuses the exact engine functions.
- **API:** 20 route files / 26 handlers, all `force-dynamic`, GET or POST only. 18/20 behind `guardDataApi` (`src/lib/api-guard.ts`): `read` bucket (120/min/IP) and `trigger` bucket (12/min/IP); bearer `DATA_API_TOKEN` timing-safe when set; fail-closed 503 when unset unless explicit `MARKET_API_PUBLIC_READS`/`MARKET_API_PUBLIC_TRIGGERS` opt-in. **Zero order/execution endpoints anywhere** (3 independent test tripwires).
- **Market pipeline:** read-only Exness WS bridge (`mini-services/mt5-bridge`, GET-only REST, `x-trader-key` auth, TLS+SNI verified, 9-gateway failover, backoff, 4 s heartbeat) → `bridge-client` (never throws, bounded retries, auth-fail no-retry) → `validation.ts` (OHLC/future/dup/forming checks; INVALID never persisted) → `ingestion.ts` (allowlists, per-TF 15 s transaction, idempotent upserts, honest SyncRun status) → `quality.ts`/`readiness.ts` fail-closed gates.
- **Engine:** deterministic TS (signal engine 9.0.0, `hybrid-structure-retest/9.0.0`): 5 service fail-closed gates → closed-candles-only windows → swings/BOS/CHoCH/S-R → EMA50/RSI14/ATR14/ADX14 → entry zone/SL/2R target/expiry; outcomes BUY_SETUP/SELL_SETUP/WAIT/NO_SETUP/BLOCKED/FAILED all reachable; no look-ahead (test-pinned); candidate strategy 11.0.0-candidate.1 is offline research-only (Model A calls unmodified baseline).
- **AI:** exactly ONE GLM consumer class, two surfaces — Bengali chat commentary (read-only allowlisted tools, deterministic `dataState` kept separate, BLOCKED non-overridable) and `/api/ai/verify` capability probe. **No AI reviewer of signals exists** (AiReview table never written — Phase 6 plan). Deterministic layer is sole authority.
- **DB:** Prisma/SQLite, 16 models; active writers for 11; `Signal`/`AiReview`/`RiskCheck`/`TradeApproval`/`ExecutionLog` never written (legacy/planned/locked). Candles unique on (symbol, tf, barOpenUtc) — 0 duplicates across 1,918 rows verified. `SignalEvaluation` + `PaperSignalOutcome` append-only with DB-level race protection.
- **Tests:** 31 files, 540/540 green at HEAD (re-verified this session: 217/217 signal-side subset). Categories covered: validation, indicators, structure, strategy, gates, persistence, API auth (missing/invalid/valid/unset/public opt-in), bridge timeout+recovery, staleness, overlap guard, setup-identity races, locks, no-order regression.

---

## 2. Existing completed features (verified, not claimed)

Read-only XAUUSDm terminal: live quote strip (bid/ask/spread/freshness), 4-TF candlestick chart with EMA/swings/BOS/S-R overlays, per-rule condition checklist (✓/✗/— funnel-honest), on-demand sync/analysis/signal (sync-first orchestration), autonomous 5-min evaluation loop, Bengali chat (grounded, tool-loop, honest fallback), signal history with levels+expiry, system/bridge/DB/GLM diagnostics tabs, paper-tracking protocol (pre-registered, 0 outcomes), backtest/validation harnesses, 100% Bengali reason-code coverage (test-enforced).

---

## 3. Confirmed defects (prioritized; all re-verified at HEAD)

| # | Sev | Defect | Evidence | Fix (this session) |
|---|---|---|---|---|
| A1 | **HIGH-MED** | `/api/ai/verify` POST is the only unguarded action route (no `guardDataApi`, no per-IP limit) — anonymous GLM-quota burn + SystemEvent writes possible even in production posture; 3 docs + a runtime-check falsely claim it is guarded | `src/app/api/ai/verify/route.ts:235` (no guard call); `audit/phase8-security-and-lock-audit.md:10`, `audit/phase9-security-and-lock-audit.md:7`, `src/lib/audit/runtime-checks.ts:607,641`, `tests/audit/runtime-checks.test.ts:242` | Add `guardDataApi(request,'trigger')` to POST; align docs/checks/tests |
| E1 | **HIGH (deploy)** | Migration drift: no migration ever CREATEs `ValidationRun`/`PaperSignalOutcome`; `20261015120000_phase10_3a` ALTERs a table no migration created; runtime DB has no `_prisma_migrations` (built via `db push`) → `prisma migrate deploy` on a fresh host **fails** | `prisma/migrations/` inventory; `tests/market/helpers/setup.ts:52-60` | Consolidated baseline migration generated from schema; verified `migrate deploy` on scratch DB; regression test |
| B-D1 | MED | 3 orphaned API-error codes (`apiErrors.market/.dataLatest/.backtest`) — outages masquerade as "empty" (MarketSnapshot, SystemMiniCards asserts facts from null, SystemView market tab '—' rows, sync button silently disabled, AnalysisView "no backtest") | `page.tsx:161,172,178` set-never-rendered; `DashboardView.tsx:82-84,128-153`; `SystemView.tsx:276-491`; `AnalysisView.tsx:732` | Thread codes into components; render UnavailableBanner + disable reasons |
| B-D3 | MED-LOW | Untruthful phase text: footer hardcodes "Phase 12" release-gate vs backend gate **Phase 11** (`config.ts:58,81`); `phaseLabel "Phase 4 of 12"` presents a lock value as roadmap progress ("of 12" hardcoded literal; project is past Phase 13) | `page.tsx:638`; `config.ts:65`; live `/api/health` | Derive from shared gate constant; drop "of 12" framing; truthful label |
| B-D2 | MED-LOW | LOCKED badge label invariant (renders "LOCKED" even if flag were false — styling only varies); "Order Execution" mini-card fully static | `TerminalHeader.tsx:92-99`; `DashboardView.tsx:172-179` | Derive label/state from `health.executionLocked`; strengthen tripwire test |
| D-D1 | MED (honesty) | Header tagline claims "GLM রিভিউ · Risk Gate সর্বোচ্চ কর্তৃত্ব" — a GLM signal-review layer **does not exist** (chat commentary + verify probe only) | `TerminalHeader.tsx:64`; grep: GLM only in `chat/agent.ts` + `ai/verify` | Reword truthfully (do NOT build a reviewer to match copy) |
| B-D4 | LOW | Static Phase-1 GLM capability constants rendered as current facts ("✓ যাচাইকৃত", "Full loop 720ms", sample req/resp); runtime `liveStatus` returned but never rendered; hardcoded model-name fallback | `static-audit.ts:52-67`; `SystemView.tsx:709-735,758,799-805` | Render `liveStatus`; timestamp capability evidence (`AUDIT_PERFORMED_AT`) |
| C-D2 | MED (latent) | Bridge never applies measured `brokerOffsetSec` to quote `ts`/candle `t` despite documented contract (harmless today: offset 0, verified; a small negative broker shift would silently skew timestamps) | `mt5-bridge/index.ts:123,149`; `src/lib/market/types.ts:145` | Apply offset at response boundary + fail-closed on \|offset\| > tolerance |
| C-D1 | LOW | `quality.ts` operator-precedence bug: tick-source demo check computed but discarded (`a || b ? c : false`) | `src/lib/market/quality.ts:161-173` | Fix precedence + regression test |
| A5 | LOW | `POST /api/signal/run` swallows malformed JSON → `{}` (siblings 400); `GET /api/data/health` + `/api/audit/environment` accept unvalidated `symbol` (silent fallback instead of 400) | `signal/run/route.ts:34-38`; `data/health/route.ts:26`; `runtime-checks.ts:99` | Align with sibling validation behavior |
| D-M1 | MINOR | Post-Gate-3 BLOCKED paths omit `digits` → rules snapshot records "unavailable" though digits were verified (understates provenance) | `signal/service.ts:211,218,221,228` | Pass `digits` at call sites |
| D-M2 | MINOR | `TICK_STALE` cast into `SignalReasonCode` though absent from the union (handled at runtime/i18n) | `signal/types.ts:35-71`; `service.ts:193-200` | Add to union |
| C-D4 | INFO | A crashed sync leaves orphan `SyncRun.status='running'` forever (0 today) | ingestion lifecycle | Sweep stale running rows at sync start → `failed/ORPHANED` |
| C-D3 | INFO | SymbolSpec upsert failure silently swallowed (no observability) | `ingestion.ts:578` | SystemEvent on failure |
| A2/A3/E3 | LOW | Doc drifts: `backtest/run` doc-comment missing Phase-13 exception; README env-table scope ("সব /api/data/*" — actually 18 routes); README "১২টি মডেল" (16 actual); SystemView static "১৪টি মডেল — ৯টি সচল" copy | `backtest/run/route.ts:5-6`; `README.md:170`+DB section; `SystemView.tsx:857` | Correct docs |
| B-D5/D6 | LOW/TRIVIAL | Chat textarea lacks visible focus ring; dead code (`viewRef`, `inputRef`, unused `variant==='sheet'`); `tmp-audit-db.ts` tracked with throwaway name | `ChatView.tsx:226,56,84`; `page.tsx:108`; `scripts/tmp-audit-db.ts` | Focus ring, remove dead refs, rename script `db-status.ts` |
| E4 | LOW | No `typecheck`/`prisma validate` scripts; `next.config.ts` `ignoreBuildErrors:true` means build skips TS (tsc run ad hoc — currently 0 errors) | `package.json`; `next.config.ts:6` | Add scripts; document build flag remediation |

**Decision — documented, deliberately NOT changed:** two error-envelope shapes coexist (guard nested vs route-local flat; all codes actionable) — unifying is a wide refactor with regression risk, deferred; `MARKET_API_TOKEN_NOT_CONFIGURED` name refers to `DATA_API_TOKEN` (known confusion, now documented in 3 places, clients/tests depend on it) — kept; `ignoreBuildErrors:true` left (build not executable in sandbox; tsc is enforced separately and green) — remediation documented for persistent host.

---

## 4. Suspected defects requiring runtime evidence (browser/deploy)

1. **No client fetch timeout/AbortController** — a network blackhole leaves chat "sending" forever (`page.tsx:384-388`, refresh loop `:112-189`). *Fix planned this session (shared timeout helper).*
2. **IME composition**: Enter-to-send doesn't check `isComposing` — Bengali IME users risk premature sends (`ChatView.tsx:217`). *Fix planned.*
3. **TF-switch stale frame**: overlay only on `data===null`; switching TF briefly shows previous TF's chart while toolbar highlights the new one (`ChartPanel.tsx:413`). *Fix planned (dim+spinner while loading).*
4. **Contrast**: `text-zinc-600` ≈2.6:1 on zinc-950 for 10-11 px disclaimers; toggle chips ~20 px < WCAG 24 px target. *Fix planned (zinc-400, min-height 24 px).*
5. **XFF-spoofable rate-limit buckets** if :3000 directly reachable (Caddy overwrites XFF on the proxied path — safe as deployed). *Documented as production hardening.*
6. **Multi-worker scheduler duplication** — `syncRunning` is per-process; correct for single-process sandbox; needs a DB advisory lock before any cluster/PM2 deploy. *Documented as deploy precondition.*
7. Bridge token compare is `===` not timing-safe (local socket, high-entropy token — informational).
8. `/api/health` exposes node version/platform/memory unauthenticated (standard, noted as hardening choice).

---

## 5. Missing features / gaps

- **Decision-trace gaps:** no explicit correlation ID (inputFingerprint is the implicit correlator); signal duration persisted but not rendered in signal UI; per-TF granular quality counts live in AnalysisRun rows, not on signal rows; **M5 confirmation stage absent from the live baseline by design** (exists only in offline candidate Models B/C) — documentation must stop describing "M5 confirmation" as live behavior.
- **No automated GLM-timeout test** (chat `withTimeout` rejection path) — attempt this session if injectable; else document.
- **Browser E2E is manual/documented** (screenshots in `audit/`), not an automated suite.
- **No CI, no deployment config** (no `.github/`, Dockerfile) — deployment assumptions live in `audit/production-readiness-report.md`; `docs/` does not exist yet (both final docs will be new files that link, not duplicate, `.env.example`/README/audit).
- **`AiReview`/`RiskCheck`/`Signal` models never written** — annotate as intentional (Phase 6/7 unbuilt, legacy superseded) rather than remove (schema churn without benefit).

---

## 6. Security review (baseline)

- **No secrets in code/bundles/responses/logs:** env read only in `config.ts` (reduced to booleans), `api-guard.ts` (timing-safe, never echoed), `bridge-client.ts` (header only, errors truncated); bridge masks login; live `/api/health` body secret-free (verified). `.env` gitignored; `.env.example` placeholders only; unpushed-history secret scans clean.
- **No execution capability:** no order routes, GET-only bridge, no trading cmd IDs in WS client, 3 test tripwires, live lock verified. Four execution locks (`TRADING_PHASE=4` gate, `TRADING_MODE=read_only`, `EXECUTION_ARMED=false`, `ALLOW_EXECUTION=false`) — untouched this session.
- **Auth contract consistent** across code/`.env.example`/README (12/min trigger figure matches); rate limit runs before auth; brute force contained.
- **The one real security gap = A1** (`/api/ai/verify` unguarded) — fixed this session.

---

## 7. Test & deployment gaps

- `prisma migrate deploy` untested/broken on fresh hosts (E1) — fixed + tested this session.
- No `typecheck`/`db:validate` scripts (E4) — added.
- Production build never runnable in sandbox (platform constraint) — remains an honest blocker, documented.
- GLM-timeout path untested (see §5).
- Persistent hosting still required for real production (ephemeral sandbox wipes env+DB — the root cause of the original 48-hour incident, per `audit/signal-pipeline-root-cause.md`).

---

## 8. Session fix plan (priority order)

1. **API security:** guard `/api/ai/verify` + align 3 docs + runtime-check + tests.
2. **DB/deploy:** consolidated baseline migration + scratch-DB `migrate deploy` verification + regression test + scripts (`typecheck`, `db:validate`).
3. **Engine/pipeline small fixes:** quality precedence, digits arg, TICK_STALE union, signal/run 400, data/health+audit/env symbol validation, SyncRun reaper, SymbolSpec failure event.
4. **Bridge:** apply broker offset + tolerance fail-closed (offset 0 today → behavior unchanged, verified by smoke).
5. **UI honesty/UX pack:** B-D1 banners, B-D2 lock badge derivation, B-D3 truthful phase text, B-D4 GLM liveStatus, D-D1 tagline, focus ring, IME guard, contrast, chip size, fetch timeout, TF-switch overlay, dead code, static copy corrections.
6. **Docs:** README fixes; new `docs/operations-and-troubleshooting.md` + `docs/environment-configuration.md` (link, not duplicate); rename tmp script.
7. **Verification:** eslint, tsc, full `bun test`, `prisma validate`, scratch-DB migration test, live bridge smoke, browser E2E desktop+mobile, four-locks live check.
8. **Delivery:** `audit/full-app-final-report.md`, worklog, commit, push (user-authorized).

**Constraints honored:** read-only posture; four locks untouched; no threshold loosening; no fabricated data; no destructive reset; secrets never printed.
