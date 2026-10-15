# PHASE 9.1 — Sandbox Recovery, Exness Reconnection & Database Rehydration

- **Date:** 2026-10-15 (UTC) · run window ≈ 11:35–11:50
- **Repo:** https://github.com/psfaruk/Xauusd-agent (branch `main`)
- **Expected base commit:** `87a342f` — confirmed as `origin/main` at start.
- **Target (not reached):** Exness demo `Exness-MT5Trial6`, symbol `XAUUSDm`
- **Safety stance:** strictly read-only; all four execution locks preserved; no order/trade/position/execution code added anywhere; no credentials printed or committed.

---

## 0. Incident context (why this phase exists)

The sandbox was rebuilt a **second time** at ≈11:27 UTC (first rebuild ≈08:25, recovered under Task 11). Each rebuild:

- wipes `/home/z/my-project/.env` down to `DATABASE_URL` only (MT5 credentials, bridge URL/token, API tokens — all gone),
- recreates `db/custom.db` as an **empty schema** (all data rows lost),
- restarts the dev server and bridge with the wiped environment.

Phase 9.1 therefore re-inspects the runtime, hunts for securely-restorable credentials, and reports honestly what could and could not be recovered. **Nothing was simulated.**

---

## 1. Step 1 — Runtime inspection

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1.1 | Actual commit & tree | **PASS** | `origin/main = 87a342f` (matches expected base). Local tree had one **unpushed sandbox auto-commit** `46ceaf9` (junk `tool-results/*.txt` only, secret-scan clean) — removed during housekeeping (see §8). Working tree clean after cleanup. |
| 1.2 | `.env.example` documented | **PASS** | Full template present: placeholders only (`MT5_LOGIN=""`, `MT5_PASSWORD=""`, `MT5_SERVER="Exness-MT5Trial6"`), bridge contract, fail-closed security notes, Phase 9 signal/chat knobs. No real secrets. |
| 1.3 | Runtime env-var presence (names only, values never printed) | **PASS** | `DATABASE_URL` SET · `MT5_BRIDGE_URL` SET (restored) · `MT5_BRIDGE_TOKEN` SET (freshly generated) · `MARKET_API_PUBLIC_READS=true` (restored) · `MT5_LOGIN` **ABSENT** · `MT5_PASSWORD` **ABSENT** · `MT5_SERVER` **ABSENT** (documented placeholders left commented in `.env`). |
| 1.4 | Bridge startup config | **PASS** | `mini-services/mt5-bridge` via `bun --hot --env-file=../../.env index.ts` (port 3031, GET-only, `x-trader-key` auth = `MT5_BRIDGE_TOKEN`; token unset ⇒ all data endpoints fail closed 401). |
| 1.5 | Bridge/app URL+token pair consistency | **PASS** | Both processes read the **same `.env`** → pair consistent by construction. Proven live: app's authenticated bridge call succeeds (`bridgeReachable:true` in `/api/data/health`). |
| 1.6 | Health routes | **PASS** | App `GET /api/health` + `GET /api/data/health` (200); bridge `GET :3031/health` (200, honest `connected:false`). |
| 1.7 | Database config & persistence | **PASS** | Prisma `datasource db { url = env("DATABASE_URL") }` → `db/custom.db` (SQLite, exists, 14 tables, schema migrated). Write path proven live: `CHAT_AGENT_TURN` SystemEvent row persisted and rendered in the UI audit trail. |

## 2. Step 2 — Credential restoration (secure)

Credential hunt (presence-only, values never printed): `.env`, shell environment, running-process `/proc/*/environ`, all `.env*`/`*.db*` backup paths, `~/.bash_history`, and git history (credentials were never committed — verified in earlier phases).

| Credential | Verdict | Detail |
|---|---|---|
| `MT5_LOGIN` | **BLOCKED** | Absent from every source. Expected value documented as commented placeholder. |
| `MT5_PASSWORD` | **BLOCKED** | Absent from every source. Not recoverable in this environment; the user must re-provision it — **never via chat or git**. |
| `MT5_SERVER` | **BLOCKED** | Absent (expected `Exness-MT5Trial6`, documented as commented placeholder). |

**→ Per instruction: live reconnection STOPPED and reported BLOCKED. No connection state was simulated, faked, or claimed.**

## 3. Step 3 — Reconnect & verify

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 3.1 | Bridge restarted via documented process | **PASS** | Restarted daemonized (`bun run dev` from `mini-services/mt5-bridge`, detached so the sandbox cannot reap it); picked up the re-restored `.env`. |
| 3.2 | Bridge health | **PASS** | `{"ok":true,"service":"mt5-bridge","version":"1.0.0-phase8","source":"disconnected","connected":false,"authenticated":false}` — HTTP-healthy, honestly disconnected. Auto-reconnect active (`reconnects` counter observed rising, e.g. 5). |
| 3.3 | Authenticated account login | **BLOCKED** | Credentials absent. Redacted last error from bridge (gateway IP only): `WS connect failed (wss://<gateway-ip>:443/terminal): Connection ended` — bridge keeps retrying in background. |
| 3.4 | Exact broker symbol resolution (`XAUUSDm`) | **NOT TESTED** | Requires an authenticated session. |
| 3.5 | Fresh bid/ask quote + validation (timestamp, positivity, bid≤ask, freshness) | **NOT TESTED** | Requires an authenticated session. Quote fields honestly `null`; `freshness:"DISCONNECTED"`; `validationStatus:"UNAVAILABLE"`. |

## 4. Step 4 — Database recovery

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 4.1 | Backup search (no delete/overwrite) | **PASS** | Searched `db/*.db*`, `/home/z/*.db*`, `.env*` backups, home dir, `/tmp` — **no backups exist**. Nothing deleted or overwritten. |
| 4.2 | Restore from backup | **NOT APPLICABLE** | No backup exists to restore. |
| 4.3 | Document historical records unavailable | **PASS** | Current `db/custom.db` row counts: `SystemEvent 1` (new, from this session's chat turn) · `SyncRun 0` · `MarketCandle 0` · `DataQualityIssue 0` · `AnalysisRun 0` · `BacktestRun 0` · `SignalEvaluation 0`. **All Phase 8/9 analysis, signal, backtest and sync history is LOST** (both rebuilds). Candle data is re-syncable from the broker once credentials return; derived run-history is not. |
| 4.4 | No synthetic candles | **PASS** | `MarketCandle = 0`; nothing fabricated. |
| 4.5 | Current database preserved | **PASS** | `custom.db` untouched except appends; schema intact (14 tables). |

## 5. Step 5 — Candle resynchronization

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 5.1 | Live resync (M5/M15/H1/H4) | **BLOCKED** | No authenticated broker session (Step 2). |
| 5.2 | OHLC/duplicate/gap/provenance validation on live data | **NOT TESTED** | Same blocker. (Validation logic itself exists and is covered by the 243-test mocked suite.) |
| 5.3 | H4 history limit | **NOT TESTED** | Broker-side ceiling last measured in Phase 8 at ~1,458 bars (~332 days). Must be re-probed after reconnection; never claimed as "full history". |
| 5.4 | Idempotency / no relay-synthetic overwrite | **NOT TESTED** (live) / **PASS** (design) | Sync module rejects relay/demo-synthetic sources and re-validates at read time; enforced by tests, but no live sync ran in this phase. |

## 6. Step 6 — Derived-data rebuild

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 6.1 | Analysis runs recalculated | **BLOCKED** | Underlying candles absent (integrity gates correctly refuse). `AnalysisRun = 0`; UI shows honest "no runs". |
| 6.2 | Signal evaluations | **BLOCKED** | `SignalEvaluation = 0`; UI: "এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি"; `signalPermitted:false`, `blockedReasons:[SOURCE_DISCONNECTED, SOURCE_UNAVAILABLE, TICK_UNAVAILABLE]`. **Signals stay blocked — fail-closed works.** |
| 6.3 | Backtests recalculated with own fingerprints | **BLOCKED** | `BacktestRun = 0`. Original backtest history **was not restored and is not pretended to be restored** — it is lost (§4.3). Future recalculations will persist as new runs with new dataset fingerprints. |

## 7. Step 7 — Frontend verification (independent, browser)

Verified at http://localhost:3000/ with a real browser (desktop 1280×800 + mobile 390×844):

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 7.1 | Bridge connection shown honestly | **PASS** | Data-Health tab: `DISCONNECTED` badge, `bridgeReachable:true`, reconnect counter, redacted last error, no fake "live" badge. |
| 7.2 | Authentication state | **PASS** | `authenticated:false` displayed honestly in audit + health surfaces. |
| 7.3 | Quote freshness | **PASS** | `freshness:"DISCONNECTED"`, bid/ask null — nothing invented. |
| 7.4 | Candle coverage | **PASS** | Per-TF table all `MISSING` (M5/M15/H1/H4 = 0 closed candles) — honest. |
| 7.5 | Database persistence | **PASS** | SystemEvent live audit-trail card renders the persisted `CHAT_AGENT_TURN` row (timestamped, Dhaka TZ). |
| 7.6 | Analysis readiness | **PASS** | Honest not-ready/no-runs state; engine fails closed without data. |
| 7.7 | Signal status | **PASS** | 0 evaluations, blocked, research-only disclaimers intact. |
| 7.8 | Backtest status | **PASS** | Honest null/empty. |
| 7.9 | Execution lock state | **PASS** | `ORDER EXECUTION — LOCKED` visible; footer "Read-Only — কোনো অর্ডার পাঠানো হবে না"; four locks intact (audit API: `phase 9`, both arm switches false, `read_only`). |
| 7.10 | Console/page errors | **PASS** | 0 page errors, 0 console errors (fresh load, desktop + mobile). |
| 7.11 | Responsive layout | **PASS** | 390×844: `scrollWidth=390 = clientWidth` → no horizontal overflow; sticky footer intact. |
| 7.12 | Chat agent E2E | **PASS** | Bengali Q&A grounded in tool facts (no invented prices); deterministic data-state block rendered separately from LLM text. |

## 8. Housekeeping performed (this phase)

- Re-restored `.env` runtime posture wiped by rebuild #2: `MT5_BRIDGE_URL`, fresh `MT5_BRIDGE_TOKEN` (openssl-generated), `MARKET_API_PUBLIC_READS=true` (preview posture; trigger POSTs still fail closed 503 `MARKET_API_TOKEN_NOT_CONFIGURED` — verified live), commented credential placeholders, sync scheduler left OFF until credentials return.
- Restarted bridge (daemonized) + dev server (`relaunch-dev.py`); both left running.
- Removed the unpushed sandbox junk auto-commit `46ceaf9` (`tool-results/*` only; secret-scan clean before removal) and added `tool-results/` to `.gitignore`.
- Screenshots: `audit/phase9.1-desktop.png`, `audit/phase9.1-mobile.png`.

## 9. Verification commands actually executed (real results)

| Command | Result |
|---|---|
| `bun test` | **243 pass / 0 fail** (970 expect calls, 13 files) — exit 0 |
| `bun run lint` | clean — exit 0 |
| `bunx tsc --noEmit` (app) | 0 errors — exit 0 |
| `bunx tsc --noEmit` (mt5-bridge) | 0 errors — exit 0 |
| `bun run build` | **NOT RUN** (sandbox rule — disclosed, as in Phases 8/9) |
| Browser E2E | 12 checks above — all PASS |

## 10. Overall verdict

| Area | Verdict |
|---|---|
| Runtime inspection & environment plumbing | **PASS** |
| Secure credential restoration | **BLOCKED** (credentials absent everywhere; never simulated) |
| Exness reconnection & live verification | **BLOCKED** |
| Database recovery | **PASS** (honest: no backup exists; history lost & documented; nothing fabricated; DB preserved) |
| Candle resynchronization | **BLOCKED** |
| Derived-data rebuild | **BLOCKED** (fail-closed gates verified working) |
| Frontend honesty verification | **PASS** |
| Read-only safety & four execution locks | **PASS** (unchanged, verified) |

**Recovery is NOT complete** — by design it cannot be until MT5 credentials are re-provisioned. Everything that could be honestly verified was verified; everything that depends on the broker session is reported BLOCKED, not faked.

## 11. Blockers & next actions

1. **BLOCKER — credentials:** set `MT5_LOGIN`, `MT5_PASSWORD`, `MT5_SERVER=Exness-MT5Trial6` in `/home/z/my-project/.env` (or the platform's environment/secret settings if available). **Never paste them into chat or commit them.** Note: sandbox rebuilds wipe `.env` — prefer a platform-level env store if one is available.
2. After credentials: restart bridge + dev server, verify `connected:true, authenticated:true` with server-identity match, resolve `XAUUSDm`, pull a fresh quote (validate timestamp/positivity/bid≤ask/freshness), then run the read-only sync (M5/M15/H1/H4), re-probe the H4 depth ceiling, and only then run analysis → signal → backtest as **new** fingerprinted runs.
3. Re-enable `MARKET_SYNC_INTERVAL_MS=300000` together with the credentials.
4. Rotate the GitHub PAT previously shared in chat (standing advisory).

*Report generated by the Phase 9.1 recovery run. Every verdict above maps to a command or browser check executed in this session; nothing is assumed from prior phases.*
