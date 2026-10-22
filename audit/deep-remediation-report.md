# Only-Xauusd — Deep Remediation Evidence Report (Phases 0–11)

Per `upload/Only-Xauusd_Deep_Implementation_Master_Prompt.txt`.
Generated after all gates below were run. **Every claim in this report was
verified by executing the named command or browser action.** Items NOT run are
explicitly marked NOT RUN with the reason.

## 1. Starting state

- Start commit: `326fa3d` (Task 41 push) — working tree clean except uploads.
- Baseline audit CONFIRMED all report claims: tracked `.env` +
  `.zscripts/env.golden` containing live Exness credentials + bridge token;
  credentials in `worklog.md`; `ensure-env.mjs` restoring secrets from git;
  execution flags fully armed (`TRADING_MODE=demo`, `EXECUTION_ARMED=true`,
  `EXECUTION_AUTO=true`, `BRIDGE_ORDERS_ENABLED=true`); order/close API routes
  + bridge order layer + position manager live; `ignoreBuildErrors: true`;
  hardcoded `/home/z` paths in scripts.

## 2. Phase-by-phase results

| Phase | Verdict | Key changes |
|---|---|---|
| 0 — Safety lock, secrets, read-only | **DONE** | See §3/§4 |
| 1 — Reproducible baseline & build health | **DONE** (42-S1, commit `d0c7c63`) | `ignoreBuildErrors` removed; all tracked-script absolute paths made relative (behavior verified identical, relaunch exercised live); README fully rewritten for the signal-only product; docs de-staled; NEW `docs/environment-reference.md` (31-key table); `.gitignore` hardened |
| 2 — Market data truth & freshness | **DONE** (42-S2, `3f70fc9`) | Audit: ~85% pre-satisfied (tick validation, per-TF staleness, gaps, UTC normalization, demo blocking). Gaps closed: consolidated `freshness` block on `/api/data/health` (tick age, per-TF LIVE/STALE/NO_DATA, gapCount, `confirmedSignalsPermitted`); stale→BLOCKED suppression regression test; closed-candle immutability — a REAL ingestion bug (re-delivery rewrote final OHLC) found by the new test and FIXED |
| 3 — Signal contract & lifecycle | **DONE** (42-S2, `3f70fc9`) | NEW `src/lib/signal/lifecycle.ts` (statuses, legal-transition matrix, pure `transition`, fail-closed `deriveLifecycleStatus`, canonical `signalDedupeKey`, confidence-typed label EVIDENCE_SCORE); `/api/signal/latest` exposes `lifecycle` + `scalperLifecycle`; audit doc maps every master-prompt field |
| 4 — Strategy determinism & no-look-ahead | **DONE** (42-S3, `4a0b271`) | Replay-determinism + future-candle-invariance tests (engines proven causal; identical inputs → byte-identical outputs); warm-up boundary tests; audit doc with file:line evidence |
| 5 — Backtest honesty | **DONE** (42-S3, `4a0b271`) | No-look-ahead + same-bar-fill tests (fill = next-bar open ± half-spread+slippage, proven to 1e-9; SL-first intrabar resolution verified conservative); NEW `sampleAdequacy` label (<30 trades → INSUFFICIENT_EVIDENCE — current snapshots are all small samples and are now labeled so) + Bengali `uncertaintyNote`; NEW `bootstrap.ts` (deterministic seed, p05/median/p95 expectancy CI) wired into `/api/backtest/latest` |
| 6 — Paper-forward timing | **DONE** (42-S3, `4a0b271`) | Timing capture (candle-close→decision→tracked) on new paper rows + median/p95 stats in the paper summary; restart-safe ledger verified; minimum-window policy documented; current paper outcomes = 0 → honestly INSUFFICIENT EVIDENCE |
| 7 — Real agent runtime | **DONE** (42-S4, `55830b8`) | NEW bounded tool-using runtime: task state machine (CREATED→…→COMPLETED/FAILED/BLOCKED/CANCELLED, illegal transitions rejected), 9-tool READ-ONLY allowlist (no execution tool possible), per-call timeout+bounded retries+backoff, budgets (6 steps / 8 tool calls / 60 s) → honest BUDGET_EXCEEDED, every transition+step persisted (AgentRun/AgentStep Prisma models, restart-safe), deterministic verification drops facts without tool observations, optional GLM summary can never add facts; `GET/POST /api/agent/runs`; 32 hermetic integration tests with fake tools (retry, budget, unknown-task, persistence, no-execution-tool). LIVE-verified end-to-end (see §6) |
| 8 — UI for honest signal interpretation | **DONE** (42-S5, `64bc870`) | Lifecycle badges (নিশ্চিত/মেয়াদোত্তীর্ণ/প্রার্থী + মেয়াদ + প্রমাণ-স্কোর, never "সম্ভাবনা"); ক্লোজড-ক্যান্ডেল badge on scalper; NEW AgentActivityPanel (persisted backend state only, no fake animation, honest empty/403/429/5xx states); stale/disconnected badges (পুরনো ডেটা / কোট বিচ্ছিন্ন); zero guaranteed-profit language (grep-verified); risk disclosure line; order-UI fully removed in Phase 0 |
| 9 — API authorization & rate limiting | **DONE** (orchestrator, `3a39575`) | Public-trigger opt-in now requires same-origin evidence (Sec-Fetch-Site / Origin⇔Host/X-Forwarded-Host/URL match): browser UI passes, anonymous off-box curl → 403, foreign origin → 403 (live-verified); token posture unchanged (DATA_API_TOKEN always honored; rate limits unchanged) |
| 10 — Observability & recovery | **PARTIAL** (folded into 2/7) | Freshness observability surface (Phase 2), agent run/step audit trail + SystemEvent logging (Phase 7), health endpoint reflects data quality not just uptime (pre-existing), restart-safe agent runs + paper ledger (regression-tested). Correlation-ID propagation across every hop and p99 latency SLO dashboards: NOT BUILT (documented gap) |
| 11 — Release gate | **DONE** | See §5 |

## 3. Highest-risk issues fixed

1. **Live broker credentials committed to a pushed repository** — untracked
   (`.env`), golden copy deleted, worklog redacted, restore-from-git logic
   deleted (fail-closed), scanner added (`bun run secrets:scan`, PASS on 1,599
   tracked files, sanity-tested both ways).
2. **Auto-execution of broker orders** — the ENTIRE execution surface deleted:
   app service/manager/routes, bridge order endpoints + trade protocol code,
   agent execution paths; `tradingMode` hard-locked `'read_only'` in code;
   proven by 13 invariant tests incl. subprocess env probes (demo/live/armed
   env values are inert).
3. **Anonymous trigger surface** — same-origin enforcement (Phase 9).
4. **Build silently ignoring TS errors** — removed; typecheck is a strict gate.
5. **Closed-candle mutation bug** in ingestion (Phase 2) — fixed + regression
   test.

## 4. Remaining external actions (USER ACTION REQUIRED)

Documented in `docs/security-rotation.md`:
1. Rotate the Exness account password (old value is in git history).
2. Rotate the bridge token (local `.env` + `.zscripts/env.local` + restart
   bridge).
3. Confirm the GitHub repo is PRIVATE.
4. Optional: run the filter-repo history purge (runbook with impact plan
   provided). **Rotation remains mandatory regardless.**

NOT performed (no authorization channel): any broker-portal action, GitHub
visibility change, history force-push (left to the user per the non-destructive
default; safe procedure documented).

## 5. Exact commands run + results (release gate, final run)

| Check | Command | Result |
|---|---|---|
| Secret scan | `bun .zscripts/secret-scan.mjs` | **PASS** — 1,599 files, 0 findings |
| Typecheck | `bunx tsc --noEmit` | **PASS** — 0 errors |
| Lint | `bun run lint` | **PASS** — 0 problems |
| Unit/integration tests | `bun test` | **PASS** — **950/950** (60 files, 88,433 expect calls) |
| Signal-only invariants | `bun test tests/ui/execution-lock-invariants.test.ts` | 13/13 |
| Agent runtime | `bun test tests/agent-runtime/` | 32/32 |
| Migration/schema | `bun run db:validate` + migration-chain test | PASS (18+2 tables) |
| Production build | `bun run build` | **NOT RUN** — platform rule (dev-server sandbox; `next build` changes standalone output and risks the running preview). The strict TS gate (`ignoreBuildErrors` removed) plus 0-error typecheck cover the compile dimension. |
| Browser E2E | agent-browser (see §6) | PASS — 0 console/page errors |
| Paper-forward validation report | data | **INSUFFICIENT EVIDENCE** — 0 completed paper outcomes in the current window (honestly labeled in-product) |

## 6. Live end-to-end verification (browser + curl)

- `/` → 200; footer "Phase 15 — Signal-Only (read-only) · রিড-ওনলি সিগন্যাল মোড".
- `GET /api/health` → 200: `tradingMode: read_only`, `executionLocked: true`, status ok.
- `GET /api/data/health?symbol=XAUUSDm` → 200 + freshness: **all 5 TFs LIVE,
  confirmedSignalsPermitted: true, gapCountLast24h: 0** (live Exness feed).
- `POST /api/agent/runs` (same-origin) → 200 **COMPLETED** run — 2 steps
  (get_latest_quote + get_market_health), 2/8 tool calls, ~4 s, Bengali summary
  quoting only observed numbers (bid 4088.135 / ask 4088.375 / spread 0.240).
- Bridge (port 3031): `POST /api/order` → **405**, `POST /api/position-close` →
  **405**, `GET /api/positions` → **404**, `GET /api/status|quote|candles` → 200
  (Exness connected + authenticated).
- App triggers: anonymous curl `POST /api/data/sync` → **403**; same-origin → passes guard.
- System view in browser: Agent Activity panel renders the real persisted run;
  lifecycle badges, closed-candle badge, stale badges, disclosure line all
  present; **0 console errors** (screenshots: `audit/phase0-after-signal-only.png`,
  `audit/phase0-8-final-system-view.png`).

## 7. Read-only confirmation

**The application is read-only and signal-only by construction.** No code path
— API route, scheduler, agent tool, bridge endpoint or env combination — can
place, close or modify a broker order: the execution modules do not exist on
either side of the bridge, the trading mode is a code constant, and 13
regression tests + a repository scanner pin this state. **No broker order was
sent by this remediation work** (the only order-capable code, which existed
before Phase 0, was deleted without being invoked; the last app-placed order
remains the historical Phase 14 demo trade recorded in the audit trail).

## 8. Remaining risks & rollback

- Git history (local + GitHub) still contains the pre-Phase-0 secrets until the
  documented purge runs — hence mandatory rotation (§4).
- Dev-server-only validation: `next build` not exercised (platform rule);
  standalone-output issues would surface only at real deployment.
- Browser→backend latency legs and cross-hop correlation IDs not instrumented
  (Phase 10 partial).
- Paper-forward evidence window starts now (0 outcomes) — every "validated"
  claim is intentionally impossible until the pre-registered minimums are met.
- Rollback: `git revert` of commits `d0c7c63 4a0b271 3f70fc9 64bc870 55830b8
  3a39575 834e09b` restores the Phase 14 demo-trading posture — NOT
  recommended (it re-exposes secrets and re-adds live order capability);
  the safe rollback for any single regression is the same list, one commit at
  a time, with `bun test` as the acceptance gate.
