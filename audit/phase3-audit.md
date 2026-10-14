# Phase 3 Audit Report — Repository & Phase 2 Status

Audit performed: 2026-10-14 (UTC) · Auditor: Z.ai Code (main orchestrator)
Method: direct filesystem inspection, live dev-log reading, and previously recorded
real command executions. **No live MT5 connection test was performed in this phase**
(see §3) — nothing below claims one.

---

## 1. Confirmed facts (verified by direct inspection / execution)

### 1.1 Application stack (VERIFIED)
| Item | Finding | Evidence |
|---|---|---|
| Framework | Next.js 16 (App Router), TypeScript 5 | `package.json`, `src/app/` |
| Runtime | Bun 1.3.14 (dev server on port 3000), healthy | `dev.log` — all routes 200 |
| Database | Prisma 6.11.1 + **SQLite** at `db/custom.db` (122,880 bytes, `SystemEvent` rows present) | `prisma/schema.prisma`, `src/lib/db.ts` |
| DB provisioning | `prisma db push` used in Phase 1 — **no migrations directory exists** | `prisma/` contains only `schema.prisma` |
| Existing API routes | `GET /api/health`, `GET /api/audit/environment`, `POST /api/ai/verify` (rate-limited, audit-trailed) | `src/app/api/**` |
| Existing schema | 12 models; **only `SystemEvent` is actively written**. `MarketCandle`/`MarketTick` exist as empty Phase-3 placeholders | schema comments + table inspection |
| Dashboard | Single user-visible route `src/app/page.tsx` (Bengali, dark gold terminal, 6 tabs, sticky footer, custom scrollbars) | browser-verified in Phase 1 |
| Test infra | **None.** `tests/` contains only shell scripts; no jest/vitest/bun-test files | `tests/` listing |
| Secrets | `.env` contains only `DATABASE_URL`. No credentials committed | `.env` key listing (values masked) |

### 1.2 Phase 2 (MT5 Bridge) status — NOT OPERATIONAL (VERIFIED)
- `mini-services/` in this project is **empty** (only `.gitkeep`). No bridge process
  runs on port 3031/3030. No MT5 integration code exists anywhere in `src/`.
- **Phase 2 was researched but never implemented here.** The research task
  (worklog `2-research`) established a new, simpler architecture: the MT5
  **web-terminal binary protocol** (wss to broker gateway, AES-framed) works from
  this sandbox — no Wine/VPS/terminal needed for market data.
- Transport-level proof (real, recorded): anonymous **AUTH handshake** with an
  Exness-MT5Trial6 gateway succeeded over verified TLS
  (`audit/mt5-auth-probe.ts` → "RESULT: PROVEN", run 2026-10-14).
- **NOT proven (explicitly):** LOGIN with credentials, XAUUSDm symbol resolution,
  candle/quote retrieval. Blocked on `.env` credentials (§3).

### 1.3 Reference bridge contract (VERIFIED from user's own repo)
Source: `psfaruk/xauusd-trad` (user's prior project "AURUM·T" v20), cloned at
`/home/z/xauusd-trad`, `mini-services/mt5-service/`. This is the "existing
read-only Bridge API" Phase 3 ingests from. Read-only REST surface (`:3031`):

| Endpoint | Shape | Notes |
|---|---|---|
| `GET /health` | `{ok, service, source, connected, uptime, credentials}` | public |
| `GET /api/status` | `{connected, source, server, latencyMs, serverTime, offsetSec, reason, symbols}` | auth |
| `GET /api/symbols` | `{source, list}` | auth |
| `GET /api/quote?symbol=` | `{symbol, bid, ask, mid, ts, spread}` — `ts` = **UTC seconds** | auth; 404 if no quote yet |
| `GET /api/candles?symbol=&tf=&limit=` | `{symbol, tf, digits, source, bars:[{t,o,h,l,c,v,f?}]}` — `t` = **UTC seconds (bar open)**, `f:1` marks the forming bar | auth; 503 on failure |

- Auth: `x-trader-key` header (shared secret) or session cookie; 401 otherwise;
  rate limit 300/min/IP on market endpoints.
- Timestamps are **already normalized to UTC** by the bridge (broker→UTC offset,
  30-min quantized — a documented v20 fix).
- Honest demo mode: `source ∈ {"mt5","disconnected","demo"}`. Demo feed is clearly
  labelled and never presented as real market data. The v20 trader refuses to act
  on demo data.
- **Trading endpoints exist in that repo (`/api/trader/*`, `/api/mt5-connect`) but
  are OUT OF SCOPE. Phase 3 neither ports nor calls them.** Read-only endpoints only.

## 2. Missing functionality (to be delivered in Phase 3)
- M1 — Market-data persistence layer (candles with UTC times, validation status,
  forming-bar flag; latest-tick snapshot; verified symbol specs; data-quality
  issues; sync-run history). Existing placeholder models are insufficient
  (no UTC-normalized naming, no validation status, no receipt tracking, no
  spread/volume distinction, tick table is an unused history shape).
- M2 — Ingestion service (idempotent upserts, allowlists, bounded retries,
  timeouts, partial-response handling, bounded backfill, honest sync records).
- M3 — Deterministic validation (OHLC invariants, finiteness, tick bid/ask,
  duplicates, ordering, session-aware gap detection, staleness thresholds).
- M4 — Read-only Data API with typed schemas, allowlists, bounds, auth, rate
  limiting, stable error codes, UTC ISO-8601 everywhere.
- M5 — Dashboard market-data tab (Bengali, fail-closed UX, demo-labeled).
- M6 — Automated test suite (none exists) + real-bridge smoke-test procedure.
- M7 — Migration history baseline (db push left no migrations).

## 3. Blockers & risks
- **B1 — No operational bridge.** Phase 2 deliverable (the bridge service) is not
  deployed in this sandbox. Consequence: ingestion cannot retrieve live data;
  every market-data surface must (and does) fail closed with
  `ডেটা পাওয়া যাচ্ছে না`. A real smoke-test script is provided; the live smoke
  test itself was **not performed**.
- **B2 — No broker credentials.** `.env` lacks `MT5_LOGIN` / `MT5_PASSWORD` /
  `MT5_SERVER`. Even with the bridge deployed, LOGIN → XAUUSDm data flow remains
  unverified until the user adds Exness demo credentials (read-only/investor
  password recommended).
- **B3 — SQLite precision.** Binary float persistence risk for prices; resolved
  per §4-D3 (Decimal support empirically verified during migration work).
- **R1 — Reference bridge is single-symbol-oriented** but the contract is
  parameterized; Phase 3 enforces its own strict allowlist (default `XAUUSDm`)
  regardless of what the bridge offers.
- **R2 — Bridge `limit`-only candles API** (no from/to): historical backfill is
  implemented as a bounded-limit fetch with validated date windows; documented
  honestly.

## 4. Decisions
- **D1 — Service boundary.** Next.js app (this repo) ↔ bridge (separate service,
  Phase 2) over HTTP REST, contract identical to the user's v20 `mt5-service`.
  The browser never calls the bridge directly; the bridge client is server-side
  only. No second MT5 integration is created.
- **D2 — Demo data policy.** Bridge `source:"demo"` data is stored **only** when
  `MARKET_INGEST_DEMO=true` (default false → skip + record `SOURCE_DEMO`), is
  always row-labelled, never counts as live market data, and never yields
  `ready:true` for analysis.
- **D3 — Prices as Decimal.** Prisma `Decimal` on SQLite verified empirically
  during Phase 3 migration work; all price fields use it (exact decimal
  representation, no binary float artifacts). Fallback documented if unsupported.
- **D4 — Migration strategy.** Baseline the existing push-created database into
  `_prisma_migrations` (zero data loss), then apply additive Phase 3 migrations.
  Existing tables/rows untouched (verified by row counts).

## 5. Audit conclusion
Phase 1 foundation is healthy and browser-verified. Phase 2 (bridge) is **not
operational** — research only, with transport-level proof of feasibility. Phase 3
therefore implements the complete database + ingestion + validation + Data API
pipeline against the documented bridge contract, fails closed everywhere, and
separates mocked automated tests from the (unperformed, documented) real smoke
test.
