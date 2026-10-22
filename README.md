# Only-Xauusd — XAUUSDm Signal Terminal

**Read-only market observation + deterministic signals for XAUUSDm (Exness MT5) — Bengali-first UI.**

> এই প্রোডাক্টটি কেবল বাজার পর্যবেক্ষণ, বিশ্লেষণ, ডিটারমিনিস্টিক সিগন্যাল, ব্যাকটেস্ট ও
> পেপার-ফরওয়ার্ড যাচাইয়ের জন্য। এটি কখনোই ব্রোকার অর্ডার পাঠায় না, পরিবর্তন করে না বা
> বন্ধ করে না — এক্সিকিউশন কোড মোটেই নেই, তাই কোনো env-ই এটি আবার চালু করতে পারে না।
> সিগন্যাল কোনো ট্রেডিং পরামর্শ নয়; ছোট নমুনা = অপর্যাপ্ত প্রমাণ (INSUFFICIENT EVIDENCE)।

---

## 1. What this product is (and is not)

**Is:** a signal-only market terminal. It observes XAUUSDm through a real Exness
MT5 connection, stores validated candles/ticks in SQLite, runs deterministic
(bit-reproducible) strategy engines, and records every evaluation,
backtest, and paper-forward outcome with full evidence.

**Is not:** a trading system. The order-execution layer — app services
(`src/lib/execution/*`, `/api/execution/*`), bridge order endpoints
(`/api/order`, `/api/position-close`, `/api/positions`), the bridge TRADE
command, and every auto-execution hook — was **deleted in Phase 0** of the deep
remediation (commit `834e09b`). Read-only is enforced **by construction**:
`TRADING_MODE` is a hard-locked `read_only` constant in `src/lib/config.ts`
(the env value is inert), and regression tests
(`tests/ui/execution-lock-invariants.test.ts`, 13 cases incl. subprocess env
probes with `EXECUTION_ARMED`/demo/live values) pin the absence of execution
code. No environment variable can re-enable ordering.

Signal engines (all deterministic, closed-candle, versioned, no look-ahead):

| Engine | Timeframes | Role |
|---|---|---|
| Scalper `scalper-m1-m5-m15-or/14.0.0` (SMC_CONFLUENCE ten-agent model + honest fallbacks) | M15 → M5 → M1 (OR-logic, priority order) | intraday scalping setups (research signals) |
| Baseline `hybrid-structure-retest/9.0.0` (`src/lib/signal/rules.ts`) | M15 | swing/setup baseline evaluation |

Both feed the same pipeline: validation → analysis (`ANALYSIS_*`) → signal
evaluation → backtest (fingerprinted) → paper-forward ledger. The GLM AI layer
is advisory only (Bengali narrative, chat, review); it can never decide a side
or bypass a data-quality gate.

## 2. Architecture

```
Browser (Bengali-first terminal UI, Next.js 16 / React 19 / Tailwind 4)
        │  HTTP + socket.io (:3041)
        ▼
Next.js app — port 3000 (single exposed port)
  · route handlers under src/app/api/* (guardDataApi: token / public opt-in)
  · deterministic engines, scheduler (sync + scalper + baseline + paper)
  · Prisma 6 + SQLite (db/custom.db)
        │  REST (x-trader-key bearer)
        ▼
mini-services/mt5-bridge — port 3031
  READ-ONLY market-data gateway (v2.0.0-signal-only).
  Speaks the MT5 web-terminal WebSocket protocol to Exness
  (TLS-verified), GET-only by construction; order layer deleted.

mini-services/tick-stream — port 3041
  READ-ONLY socket.io tick relay; polls the bridge quote stream
  and broadcasts realtime ticks to dashboard clients.

SQLite via Prisma — db/custom.db (16 models; prices stored as exact
decimal TEXT; every write idempotent and audited).
```

Supported platform: Linux (Debian) with **Bun ≥ 1.3** as the runtime/package
manager (`bun run dev`, `bun --env-file`). Node 24 works for the Next.js
server itself; the scripts assume Bun.

## 3. Setup (exact commands)

```bash
# 1. install dependencies
bun install

# 2. create the environment — .env is GIT-IGNORED, never committed
cp .env.example .env
#    edit .env and fill the REAL broker values:
#    MT5_SERVER / MT5_LOGIN / MT5_PASSWORD  (Exness credentials)
#    MT5_BRIDGE_TOKEN (any long random string — must match in .env, it is
#    the shared app↔bridge key)

# 3. local fail-closed backup for the ensure-env guard (gitignored, 0600)
cp .env .zscripts/env.local

# 4. provision the database (sandbox/dev posture: db push, no migrations)
bun run db:push

# 5. start the market-data services (bridge first, then the app)
python3 .zscripts/relaunch-bridge.py            # :3031  (surviving daemon)
python3 mini-services/tick-stream/relaunch.py   # :3041  (surviving daemon)
bun run dev                                    # :3000  (Next.js dev server)

# 6. verify
curl -s localhost:3000/api/health          # ok · read_only · executionLocked:true
curl -s localhost:3031/health              # connected:true authenticated:true
bun run market:smoke                       # 8-point live data verification
```

Notes:

- `DATABASE_URL` in `.env.example` is `file:../db/custom.db` — Prisma resolves
  relative SQLite paths against `prisma/schema.prisma`, so this points at
  `<repo>/db/custom.db`. An absolute path works too.
- On a persistent/production host use `bun run db:deploy` (migration baseline)
  instead of `db:push`, and run `bun run build && bun run start` — see
  `docs/operations-and-troubleshooting.md` §3 for the push-vs-deploy decision.
- Missing secrets fail closed: `bun .zscripts/ensure-env.mjs` prints a clear,
  non-secret error and the dev server refuses to start.

## 4. Scripts (`bun run <name>`)

| Script | What it does |
|---|---|
| `dev` | env guard (`ensure-env.mjs --with-db`) then `next dev -p 3000`, log to `dev.log` |
| `lint` | ESLint over the repo |
| `typecheck` | `tsc --noEmit` (must stay at 0 errors — the build no longer ignores them) |
| `test` | `bun test` — full suite (840 tests green at the Phase 0 baseline, commit `834e09b`) |
| `secrets:scan` | `bun .zscripts/secret-scan.mjs` — scans every tracked file for secret shapes; must PASS before any commit |
| `db:push` / `db:generate` / `db:validate` | Prisma schema push / client generate / validate |
| `db:migrate` / `db:deploy` / `db:reset` | Prisma migrate dev / deploy / reset |
| `build` / `start` | production build (standalone) / start — for persistent hosts, not the sandbox |
| `market:smoke` | live 8-point read-only verification against the bridge |
| `market:sync` | idempotent candle sync (manual / backfill modes) |
| `backtest` | scalper backtest on stored, fingerprinted data (`--env-file=.env`) |
| `history:deep` | bounded deep-history pull |
| `paper:snapshot` | paper-forward durability snapshot |
| `bridge:dev` | start the mt5-bridge mini-service in the foreground |

## 5. API surface (all read-only; no mutation route exists)

| Route | Guard |
|---|---|
| `GET /api/health` | unguarded by design (liveness; secret-free) |
| `GET /api/data/status · candles · chart · latest · quality · health · sync-status` | read bucket |
| `POST /api/data/sync` | trigger bucket |
| `GET /api/analysis/latest` · `POST /api/analysis/run` | read / trigger |
| `GET /api/signal/latest · history` · `POST /api/signal/run · scalper` | read / trigger |
| `GET /api/backtest/latest` · `POST /api/backtest/run` | read / trigger |
| `POST /api/chat` · `GET /api/ai/review(/latest)` | read (chat has its own bucket) |
| `POST /api/ai/verify` | trigger |
| `GET /api/audit/environment` | read |
| `GET /api/validation/latest`, `GET/POST /api/broker/settings` | app + bridge read-only settings |

## 6. Security posture

- **Secrets are never committed.** `.env` is gitignored; `.env.example` carries
  placeholders only; `.zscripts/env.local` (the fail-closed backup) is
  gitignored with `chmod 600`. `bun run secrets:scan` must PASS before every
  commit — it fails on env-secret assignments, bridge-token shapes, tracked
  env artifacts, and literal broker-password shapes.
- **API authorization.** `src/lib/api-guard.ts` (single guard, read + trigger
  buckets, per-IP rate limits). A surface opens only when (a) `DATA_API_TOKEN`
  is set and a valid `Authorization: Bearer` is presented, or (b) the operator
  explicitly opted in with `MARKET_API_PUBLIC_READS=true` /
  `MARKET_API_PUBLIC_TRIGGERS=true` **while no token is set** — there is no
  third path (fail-closed 503 `MARKET_API_TOKEN_NOT_CONFIGURED`).
- **Public triggers are same-origin only (Phase 9).** Anonymous
  `MARKET_API_PUBLIC_TRIGGERS` calls from a browser must carry same-origin
  evidence (`Sec-Fetch-Site`/`Origin`); off-box anonymous callers get 403 and
  must use `DATA_API_TOKEN`. Recommended production posture: long random
  `DATA_API_TOKEN`, both public flags unset.
- **Read-only by construction.** No order/close/position route exists anywhere
  (app or bridge); the bridge is GET-only; the AI tool registry has no order
  tool; regression tests pin all of this.
- **Incident history & rotation.** Real credentials were previously committed
  to git history. They must be treated as compromised and rotated at the
  source — see **[docs/security-rotation.md](docs/security-rotation.md)** for
  the mandatory user actions and the optional history-cleanup runbook.

## 7. TRADING_PHASE is an informational label only

`TRADING_PHASE=15` feeds exactly one string: the UI/health phase label
(“Phase 15 — Signal-Only (read-only)”). It is **not** a capability gate — the
old four-switch execution gate was deleted with the execution code. There is
no phase value, env combination, or runtime state that can enable order
placement. `TRADING_MODE` is likewise inert: `src/lib/config.ts` hard-locks it
to `read_only`.

## 8. Honest limitations

- **Small backtest samples are INSUFFICIENT EVIDENCE.** Every backtest report
  labels low trade counts as `INSUFFICIENT_DATA`; no strategy receives a
  “validated” status from a handful of trades. Backtests are simulations with
  realistic costs — they are never proof of profitability.
- **Signals are not trading advice.** The deterministic engines output
  research observations with entry/invalidation methodology. There is no
  guaranteed accuracy, no promised win rate, and a good system must sometimes
  return NO SIGNAL. Never act on a signal without independent judgment.
- No live-trading capability exists or will be re-added behind a flag.
- The news-blackout envelopes are approximate scheduled windows (no live
  calendar feed is claimed); weekend/holiday sessions are “likely closed”
  judgments, never verified schedules.
- Production `next build` is not runnable inside the sandbox (platform
  constraint); the verification gates there are `typecheck` + `lint` +
  `bun test` (+ `secrets:scan`). The strict build gate (`next.config.ts`)
  no longer ignores TypeScript errors.

## 9. Documentation map

| Doc | Scope |
|---|---|
| [`docs/environment-reference.md`](docs/environment-reference.md) | every env key: meaning, default, secret? |
| [`docs/environment-configuration.md`](docs/environment-configuration.md) | postures, guard buckets, rotation |
| [`docs/operations-and-troubleshooting.md`](docs/operations-and-troubleshooting.md) | run/restart, health checks, recovery |
| [`docs/security-rotation.md`](docs/security-rotation.md) | incident, credential rotation (user actions) |
| [`audit/`](audit/) | dated evidence records (immutable history) |
| [`worklog.md`](worklog.md) | task ledger with commit SHAs |

---

*Only-Xauusd · v2.0.0-signal-only · Phase 15 — Signal-Only (read-only)*
