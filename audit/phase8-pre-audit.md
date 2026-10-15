# Phase 8 Pre-Audit — Repository & Phase 7 Inspection

**Date:** 2026-10-15 (Asia/Dhaka) · **Auditor:** Z.ai Code (Phase 8 main orchestrator)
**Method:** Direct inspection of the live working tree, `git` state, the published GitHub repository, the user's reference repo, and live network probes. No code was modified before this report.

---

## 0. Executive Summary

**The reported Phase 7 state ("session live-connected, Connection Center displays live XAUUSDm quotes") does not exist in this environment and is not present in the published repository.** The last published commit on `github.com/psfaruk/Xauusd-agent` is Phase 4 (`b522a58`). No Phase 5, 6, or 7 code — no Connection Center, no session manager, no bridge deployment, no live quote feed — exists anywhere that this sandbox can reach. The local working tree was reset to the bare Next.js scaffold (`a8ef8a4 Initial commit`, default `page.tsx`, empty `mini-services/`, default User/Post Prisma schema).

However, the underlying **live data path is feasible**: direct WebSocket dialing to the Exness-MT5Trial6 gateways by IP **succeeds from this sandbox** (verified `101 Switching Protocols`), and the user's reference repo (`psfaruk/Xauusd-trad`) contains a **verified, documented** reverse-engineered MT5 web-terminal protocol (`mt5-poc/PROTOCOL.md`, verified live 2026-09-27) plus a production `mt5-service`. Phase 8 will therefore (a) restore the Phase 3/4 foundation from the published repo, (b) implement the read-only broker feed bridge that Phase 7 claimed but never shipped, and (c) layer the Phase 8 verification & quality-control systems on top — honestly labeling every source.

## 1. Repository State

| Item | Finding |
|---|---|
| Local branch | `main` @ `a8ef8a4` "Initial commit" — bare scaffold |
| Local working tree | Default shadcn page, empty `mini-services/`, default Prisma User/Post schema, `db/custom.db` untouched by market code |
| GitHub `psfaruk/Xauusd-agent` | `main` @ `b522a58` "feat(phase4): deterministic market analysis engine + Phase 3 review fixes" — **latest** |
| Phase 5 artifacts | **NOT FOUND** (no signal-construction modules in either location) |
| Phase 6 artifacts | **NOT FOUND** (no deployed bridge, no mt5 WebSocket client in `Xauusd-agent`) |
| Phase 7 artifacts | **NOT FOUND** (no Connection Center UI, no connection APIs, no session manager, no live-verification report) |
| `audit/` in published repo | phase1/phase3/phase4 reports only; `phase3-audit.md` itself records the Phase 3-era blockers B1/B2 (bridge undeployed, no credentials) |
| `worklog.md` (published) | Confirms: Phase 3 complete, Phase 4 complete, Phase 5+ never started there |

**Conclusion:** the user's status report is unverified and, in every location this audit can reach, **false**. Per the Phase 8 mandate ("Do not assume the user's status report proves live connectivity"), live-feed authenticity is marked **BLOCKED-PENDING-IMPLEMENTATION**, not PASS.

## 2. Data-Path Trace (as found)

Required chain: `Exness WebSocket → authenticated session → symbol validation → live quotes → candle history → database → signal engine → dashboard`.

- **Exness WebSocket → authenticated session:** absent. `src/lib/market/bridge-client.ts` (Phase 3) is an HTTP REST client for a *contract* bridge that was never deployed (`MT5_BRIDGE_URL` unset → every call fails closed with `BRIDGE_NOT_CONFIGURED`).
- **Symbol validation / live quotes:** absent at runtime; contract-level code only (`schemas.ts`, `validation.ts`, `quality.ts` — all fixture-tested, never broker-tested).
- **Candle history → database:** ingestion code exists and is idempotent (`MarketCandle` unique on symbol+tf+bar-open), but the DB has **0 market rows** (no sync ever ran).
- **Signal engine:** Phase 4 analysis engine exists (`src/lib/analysis/*`, deterministic, fingerprinted, BLOCKED semantics) but with no data it can only ever return `BLOCKED [DATA_MISSING]`.
- **Dashboard:** Phase 4 dashboard exists with market/analysis tabs showing honest DISCONNECTED/BLOCKED states — but no "Connection Center", no live quotes.

## 3. Network Reachability Probes (live, this sandbox, 2026-10-15)

| Probe | Result |
|---|---|
| `https://github.com` | 200 OK |
| `https://www.exness.com` | 403 (blocked at proxy) |
| DNS `wsmt5.exness.com`, `mt5.exness.com`, `trade.mt5.com` | **unresolvable** (egress DNS allowlist) |
| **Direct IP dial `https://47.130.41.116:443/terminal`** | **200 OK (0.15s)** |
| **Direct IP dial `57.182.183.85`, `8.219.172.6`** | **200 OK** |
| **WebSocket upgrade → `wss://47.130.41.116:443/terminal`** | **`101 Switching Protocols` — Exness gateway accepts WS** |
| User's Railway app `xauusd-trad-production.up.railway.app` | reachable (Next.js 404 on `/health`; it is the AURUM terminal, not a bridge) |

**Key finding:** Exness MT5 gateways are reachable **by IP** (the domain names are blocked, but the PROTOCOL.md gateway IPs are not). The Phase 6-era "unreliable connectivity" blocker is therefore **resolvable**: a read-only bridge dialing `wss://<gateway-ip>:443/terminal` with SNI `mt5.exwebterm.com` (cert `*.exwebterm.com`, TLS verified) is viable.

## 4. Reference Assets Available (user's own repos — read-only usage)

- `psfaruk/Xauusd-trad/mt5-poc/PROTOCOL.md` — complete verified protocol spec: framing (`[len u32][ver u32][AES-256-CBC]`), static AUTH key, session-key derivation, LOGIN payload layout (912B), SYMBOLS (cmd 34, gzip, 526B records, symbol_id/digits), SUBSCRIBE (cmd 7), QUOTES push (cmd 8, 50B records, raw prices ÷ 10^digits), CANDLES (cmd 11, 48B bars, real prices), HEARTBEAT (cmd 51), TF codes (M1=1 … H4=16388), gateway IP list, `XAUUSDm` resolution rule ("always resolve from the cmd-34 symbol table, don't hardcode").
- `psfaruk/Xauusd-trad/mini-services/mt5-service/` — production service containing a working `Mt5WsClient` implementation (market-data + trading). **Phase 8 constraint: only the market-data command layer (AUTH/LOGIN/ACCOUNT/SYMBOLS/SUBSCRIBE/QUOTES/CANDLES/HEARTBEAT) may be referenced; the trading layer (cmd 12 TRADE, positions, deals, close/modify) is FORBIDDEN and will NOT be ported.**

## 5. Security & Lock Posture (as found)

- Four-switch execution lock intact in Phase 4 `config.ts`: `phase >= 11` AND `EXECUTION_ARMED` AND `ALLOW_EXECUTION` AND `mode != read_only`. None of the four can pass in the current state (`TRADING_PHASE` default 1, mode `read_only`).
- No order/trade/position routes exist in `Xauusd-agent` (statically scanned in Phases 3/4 audits; re-verified for this audit over the published tree).
- User credentials for live verification (provided in chat for Phase 7) will live **only** in the local `.env` — never committed, logged, or rendered.

## 6. Phase 8 Plan (derived from findings)

1. **Restore** the published Phase 3/4 foundation into the working tree (preserves working modules; no rebuild).
2. **Implement the read-only Exness bridge** (`mini-services/mt5-bridge/`, port 3031) exposing the exact Phase 3 contract (`/health`, `/api/status`, `/api/symbols`, `/api/quote`, `/api/candles`) over a TLS-verified, IP-dialed, authenticated MT5 session. No execution commands — by construction and by static audit.
3. **Live verification**: AUTH → LOGIN → symbol table → resolve `XAUUSDm` (id, digits) → subscribe → verify fresh quotes → fetch M1–H4 candle windows → validate OHLC/gaps → persist → re-verify reproducibility. Every step logged with evidence; anything unverifiable is reported as FAIL/BLOCKED, never faked.
4. **Phase 8 QC layer**: quote-integrity monitor (freshness/staleness/degradation, source labels), candle-history validation reports, idempotent-sync audit, Phase-4 signal-engine audit (provenance, no-look-ahead, BLOCKED semantics), backtest module (verified candles only, spread/slippage, conservative collision rule, fingerprints), dashboard "Data & Signal Health" panel, full test/lint/typecheck/build run.
5. **Reports**: the six required Phase 8 audit files, each verdict PASS/FAIL/BLOCKED/NOT TESTED with evidence.

## 7. Pre-Implementation Verdicts

| Phase 8 acceptance criterion | Pre-state |
|---|---|
| Phase 7 implementation inspected | **FAIL — does not exist** (documented above) |
| Live-feed authenticity | **BLOCKED** (bridge never deployed; path proven feasible — §3) |
| Quotes/candles validated with source labels | NOT TESTED (no feed yet) |
| H4 limitations visible | NOT TESTED (no data yet) |
| Signal reproducibility / blocking | Phase 4 engine present; BLOCKED-on-no-data verified previously |
| Backtests on verified data | NOT TESTED (no backtest module exists — new module justified) |
| Four execution locks intact | PASS (as found, re-verified after changes) |
| No execution routes | PASS (as found, re-verified after changes) |
