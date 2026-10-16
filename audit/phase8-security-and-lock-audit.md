# Phase 8 — Security & Execution-Lock Audit (Task 8)

**Date:** 2026-10-15 (Asia/Dhaka) · **Scope:** entire working tree (`src/`, `mini-services/mt5-bridge/`, `scripts/`, `tests/`, `prisma/`, configs).

## 1. Execution routes — NONE (PASS)

Static scan over all source for order/trade/position execution:

- `grep` for `order_send|place.*order|/api/order|/api/trade|/api/position|close.*position|trade.*execute` → only benign hits: shadcn CSS classes, documentation comments, and the backtest simulator's **in-memory** position bookkeeping (pure analysis, no broker interaction).
- **POST route inventory (complete):** `/api/data/sync`, `/api/analysis/run`, `/api/backtest/run`, `/api/ai/verify` — all data/analysis triggers, all behind `guardDataApi` trigger semantics (token always required; unset token → 503 fail-closed, no bypass).
- **Bridge surface:** `GET /health`, `GET /api/status|symbols|quote|candles` only. HTTP method gate returns 405 for anything but GET. **No POST endpoints exist on the bridge.**

> **Correction (2026-10-16, master audit — `audit/full-app-baseline.md` §A1):** the "all behind `guardDataApi`" claim above was **inaccurate when written** — at Phase 8 time `/api/ai/verify` was *not* behind `guardDataApi` (it had only an in-process interval limiter). It was brought behind the trigger guard on 2026-10-16 (regression-tested in `tests/market/api.test.ts`).

## 2. Bridge trading-command absence (PASS)

The read-only MT5 client implements **only**: AUTH(0), ACCOUNT(3), SUBSCRIBE(7), QUOTES(8), CANDLES(11), LOGIN(28), SYMBOLS(34), HEARTBEAT(51). The trading command layer of the reference implementation (TRADE 12, POSITIONS 4, DEALS 5, TRADE_EVENT 19, POS_UPDATE 22) is **deliberately not ported** — verified by scanning every `cmdId` the client can emit. TLS is **verified** (`servername mt5.exwebterm.com`, `rejectUnauthorized: true`); no insecure-escape hatch exists in the bridge.

## 3. Four-switch execution lock — INTACT (PASS)

`src/lib/config.ts` (unchanged logic, live-verified values):

| Switch | Value now | Source |
|---|---|---|
| Phase gate (`TRADING_PHASE ≥ 11`) | 8 → **not passed** | `.env` TRADING_PHASE=8 |
| `EXECUTION_ARMED` | **false** | `.env` |
| `ALLOW_EXECUTION` | **false** | `.env` |
| `TRADING_MODE ≠ read_only` | **read_only** | `.env` |

`executionEnabled = phaseGatePassed && executionArmed && allowExecution && mode !== 'read_only'` → **false**. Live `/api/health`: `"executionLocked": true, "reason": "Execution locked: Phase 8 is read-only by design (Phase 11 gate required)."` No "enable trading" shortcut exists anywhere.

## 4. Credentials & secrets (PASS — one incident found & remediated)

- Credentials live **only** in `.env` (git-untracked — remediated this phase: `.env` was tracked from the scaffold's initial commit; removed via `git rm --cached`).
- Bridge reads them at startup into memory; they appear in the LOGIN frame only. Never logged (no `console` path touches them), never returned (status reports **masked** login `414•••70`), never forwarded to the app (the app never asks).
- **Incident (honest record):** the live login/password were briefly hardcoded in a test fixture during development. Caught by the credential-leak scan before any commit; replaced with synthetic patterns + pattern-based assertions. Final scan over all tracked file types for the literal credentials: **clean**.
- Token hygiene: bridge auth via `x-trader-key` (env, fail-closed 401 when unset); test-isolation setup strips bridge/credential env so no test can touch the live bridge.
- `.gitignore` covers `.env`, `db/*.db`; migration history contains only DDL.

## 5. Authorization & rate limits preserved (PASS)

- `guardDataApi`: triggers always-token (503 `MARKET_API_TOKEN_NOT_CONFIGURED` when unset); reads fail-closed unless `MARKET_API_PUBLIC_READS=true` (preview-only posture, documented). Per-IP rate limits: reads 120/min, triggers ~12/min. Live-verified earlier phases; unchanged.
- The new `/api/data/health` (GET/read) and `/api/backtest/*` routes go through the same guard; backtest run is a **trigger**.

## 6. Verdicts

| Criterion | Verdict |
|---|---|
| No order/trade/position execution route or command introduced | **PASS** |
| Four execution-lock switches intact & engaged | **PASS** |
| Broker credentials never in frontend bundle, logs, API responses, URLs, storage, errors | **PASS** (post-remediation) |
| No "enable trading" shortcut | **PASS** |
| Authorization + rate limits preserved on protected endpoints | **PASS** |
| New execution-related SDK/WS commands | **NONE FOUND** |
