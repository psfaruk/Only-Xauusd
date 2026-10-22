# Operations & Troubleshooting Guide

**Audience:** whoever operates this XAUUSD terminal (sandbox or a persistent host).
**Scope:** run/restart procedures, health checks, common failures + exact recovery.
**Companion docs:** [`README.md`](../README.md) (architecture, API, roadmap) · [`docs/environment-configuration.md`](./environment-configuration.md) (env vars, postures) · [`audit/`](../audit/) (evidence trail; see especially `production-readiness-report.md` and `full-app-final-report.md`).

> This guide LINKS the phase-specific Bengali material in README §8 rather than duplicating it. Where README §8 covers Phase-3 ingestion detail, this file covers whole-app operation.

---

## 1. Daily operation — what "healthy" looks like

| Surface | Check | Healthy |
|---|---|---|
| App | `GET /api/health` | `status:"ok"`, `executionLocked:true`, `checks.database:"ok"` |
| Bridge | `GET :3031/health` (bridge port) | `connected:true, authenticated:true` |
| Scheduler | `GET /api/data/sync-status?limit=3` | Latest run `success`, started within `MARKET_SYNC_INTERVAL_MS` (+slack) |
| Data | `GET /api/data/health?symbol=XAUUSDm` | `quote.freshness:"LIVE"`, all 4 TFs present |
| Terminal UI | Footer + header | LIVE badge, real bid/ask, LOCKED badge, footer at document bottom |

Quick CLI sweep (read-only, no secrets printed):

```bash
curl -s localhost:3000/api/health | head -c 400
curl -s "localhost:3000/api/data/sync-status?limit=2"
bun run scripts/db-status.ts   # counts + latest eval/sync/tick
```

## 2. Start / restart procedures

```bash
# Dev server (sandbox) — background daemon with auto-restart
python3 .zscripts/relaunch-dev.py

# MT5 bridge (mini-service, port 3031) — reads MT5_* keys from .env
python3 .zscripts/relaunch-bridge.py

# Both print their own logs:
tail -f .zscripts/dev.log
tail -f .zscripts/mini-service-mt5-bridge.log
```

Order matters after a full outage: **bridge first, then app** (the scheduler's next tick probes the bridge; if it is down, syncs fail honestly — no fabricated data — and recover on the following tick).

## 3. Database provisioning — **the migrate-vs-db:push decision**

Two supported paths (pick ONE per host and stay on it):

- **`bun run db:push`** (sandbox default): reflects `prisma/schema.prisma` directly into `db/custom.db`. No migration bookkeeping. Fine for ephemeral/dev databases.
- **`bun run db:deploy`** (`prisma migrate deploy`): applies `prisma/migrations/0_baseline_full_schema` (a single consolidated baseline generated from the schema on 2026-10-16; the old 6-migration chain had drift — `ValidationRun`/`PaperSignalOutcome` had no CREATE TABLE, so `migrate deploy` on a fresh host FAILED). Use this on persistent hosts. Regression-tested on every test run (`tests/db/migration-chain.test.ts` provisions a scratch DB and asserts the exact 16 tables).

⚠ **Do not mix:** running `db:push` against a migrate-managed DB (or vice versa) desynchronizes `_prisma_migrations`. The runtime sandbox DB is push-managed by design; a production host should be deploy-managed.

**Backups (persistent host):** SQLite single file — copy `db/custom.db` while the app is stopped (or use `sqlite3 db/custom.db ".backup ..."` for a hot copy). The paper-protocol durability artifact is `bun run paper:snapshot` → commit `audit/phase10.2-paper-snapshot.json`.

## 4. Troubleshooting — symptom → cause → fix

### "৪৮ ঘণ্টায় কোনো সিগন্যাল নেই" / zero signals
1. Check the three surfaces in §1 — the historical root cause was **environment loss** (`.env` wiped by a host rebuild → bridge unconfigured → pipeline down), NOT the strategy. See `audit/signal-pipeline-root-cause.md`.
2. If all surfaces healthy and evaluations show `WAIT`/`NO_SETUP` with Bengali reason codes — that is the **honest strategy verdict** (retest-stage filters reject ~72% of bars; ≈1 setup-episode/1.4 days on real data). Do NOT loosen thresholds to "create" signals; every evaluation row carries the full decision trace (শর্ত-বাই-শর্ত checklist in the signal tab).
3. `MARKET_API_TOKEN_NOT_CONFIGURED` on manual buttons = `DATA_API_TOKEN` unset AND `MARKET_API_PUBLIC_TRIGGERS` not opted in (preview). See `docs/environment-configuration.md`.

### Bridge down / `ডেটা পাওয়া যাচ্ছে না`
- `curl -s localhost:3031/health` → if not `connected`, check `.env` MT5_* keys exist (names only: `MT5_BRIDGE_TOKEN`, `MT5_LOGIN`, `MT5_PASSWORD`, `MT5_SERVER`), then relaunch the bridge.
- 401 from the bridge = `MT5_BRIDGE_TOKEN` mismatch — both the app and the bridge read the same `.env` via `--env-file`; check the value is quoted consistently.
- Broker offset: the bridge normalizes broker→UTC using a live-measured offset (`offsetSec` in `GET :3031/api/status`). Today Exness-MT5Trial6 runs offset 0.

### Scheduler not syncing
- `MARKET_SYNC_INTERVAL_MS` must be > 0 (300000 = 5 min) and `MT5_BRIDGE_URL` set.
- Overlap is refused (`SYNC_IN_PROGRESS`) — a >5-min sync simply loses the next slot (no pileup).
- Orphaned `running` SyncRun rows (crashed process) are auto-demoted to `failed/ORPHANED_SYNC_RUN` after 15 min by the reaper at the next sync start.
- Multi-worker deployments (cluster/PM2) would run N schedulers — add a DB advisory lock BEFORE scaling out; the current lock is per-process.

### Tick stale (`TICK_STALE`) on manual evaluation
Expected between syncs: tick threshold is 120 s vs the 5-min cadence. The UI syncs first (sync-first orchestration); the API alone does not — call `POST /api/data/sync` before `/api/signal/run` if scripting.

### Chart empty on one timeframe
Honest empty state — that TF has no stored candles yet; the scheduled sync fills them (H4 needs the most history). The chart NEVER fabricates bars; `insufficient` TFs are flagged in the legend.

### GLM chat/verify failures
- `GLM_VERIFY_FAIL` events in SystemEvent (`/api/audit/environment`) show the failing leg (chat / Bengali / tool loop). The chat falls back to an honest error bubble — never fabricated replies.
- `/api/ai/verify` is trigger-guarded: from the UI it works via the preview opt-in; with a token set, curl it with `Authorization: Bearer …`.

### After a host rebuild (sandbox or VPS)
1. Restore `.env` (names in `.env.example`; NEVER commit it).
2. `bun install && bun run db:push` (or `db:deploy` on a migrate-managed host).
3. Relaunch bridge, then app. First sync + first evaluation land within one interval.

## 5. Safety invariants — never change these operationally

- **Execution capability was deleted in Phase 0** — there is no execution code to lock: the app execution services/routes, the bridge order endpoints, and the auto-execution hooks are gone, and `TRADING_MODE` is hard-locked to `read_only` in `src/lib/config.ts` (the env value is inert). `EXECUTION_ARMED`/`ALLOW_EXECUTION` no longer exist as concepts. Regression tests (`tests/ui/execution-lock-invariants.test.ts`, incl. subprocess env probes) pin the absence.
- The bridge is GET-only; there is no order code anywhere (3 test tripwires + runtime checks pin this).
- Demo feed is never ingested by default (`SOURCE_DEMO` skip) — demo data is never analysis-ready.
- All market data is broker-verified or honestly absent — a `—` means unavailable, never 0.

## 6. Known limitations (honest)

- Production build (`next build`) is not runnable inside the sandbox (platform constraint); `tsc --noEmit` + `eslint` + `bun test` are the verification gates there. On a persistent host, run `bun run build` once before `bun run start`.
- `next.config.ts` no longer sets `typescript.ignoreBuildErrors` (Phase 1 strict gate) — `next build` now fails on type errors. Keep `bun run typecheck` as the fast dedicated gate in CI and before every commit.
- Browser E2E is currently a documented manual procedure (screenshots in `audit/`), not an automated suite.
- In-memory rate-limit buckets and the scheduler lock are per-process (fine single-process; see §4 before scaling).
