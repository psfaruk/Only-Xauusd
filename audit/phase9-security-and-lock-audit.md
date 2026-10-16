# Phase 9 — Security & Execution-Lock Audit (Task 8-equivalent)

**Date:** 2026-10-15 (Asia/Dhaka) · **Scope:** entire tree — `src/`, `mini-services/mt5-bridge/`, `scripts/`, `tests/`, `prisma/`, configs.

## 1. Execution routes/commands — NONE (PASS)

- **POST route inventory (complete, test-pinned):** `/api/data/sync`, `/api/analysis/run`, `/api/backtest/run`, `/api/signal/run`, `/api/chat`, `/api/ai/verify` — all data/analysis/chat triggers behind `guardDataApi`. The pre-existing static scan (`tests/market/api.test.ts` case 18) re-verified: no route path mentions orders/trades/positions/execution; no order-submission code patterns anywhere.
- **Bridge surface unchanged:** GET-only REST (:3031, 405 otherwise), x-trader-key auth, no trading command ids in the WS client (AUTH/LOGIN/ACCOUNT/SYMBOLS/SUBSCRIBE/QUOTES/CANDLES/HEARTBEAT only).
- **Signal engine:** no lot size, no order type, no position management — research outputs only; every persisted row records `executionLocked: true`.

> **Correction (2026-10-16, master audit — `audit/full-app-baseline.md` §A1):** "all … behind `guardDataApi`" was **not true for `/api/ai/verify` at Phase 9 time** (it was unguarded apart from an in-process interval). Guarded on 2026-10-16 with regression tests; the inventory list itself was and remains correct.

## 2. Four-switch execution lock — INTACT (PASS)

| Switch | Value | Source |
|---|---|---|
| Phase gate (`TRADING_PHASE ≥ 11`) | 9 → **not passed** | `.env` TRADING_PHASE=9 |
| `EXECUTION_ARMED` | **false** | `.env` |
| `ALLOW_EXECUTION` | **false** | `.env` |
| `TRADING_MODE ≠ read_only` | **read_only** | `.env` |

`executionEnabled = false` — live `/api/health` confirms `executionLocked: true` with the Phase 11-gate reason. Individual switch states are now exposed read-only through the audit report for transparency. No "enable trading" shortcut exists.

## 3. Authorization & rate limits — STRENGTHENED (PASS)

- New trigger `POST /api/signal/run`: token ALWAYS required (live-verified: without token → 401 with token set; 503 when unset).
- `POST /api/chat`: read-guard posture (token required whenever set; preview-only public opt-in identical to every GET) **plus** a stricter chat-specific rate limit (12/min default) and message/history caps. Not an anonymous state-changing route (no domain state mutated).
- `GET /api/audit/environment`: NOW guarded (previously public since Phase 1) — an explicit hardening; works in preview via the documented opt-in.
- Existing guards untouched: timing-safe token compare, per-IP fixed windows, fail-closed 503 semantics.

## 4. Credentials & secrets (PASS)

- Credentials remain env-only (bridge process memory → LOGIN frame; masked login `414•••70` in status). The chat tool layer never touches credentials; model context scans are clean (test-pinned).
- Full-tree scan for the live credential patterns + `ghp_` tokens: clean. `.env` untracked; runtime DBs untracked.
- The audit runtime checks read `.git/HEAD` refs via fs (fixed paths, read-only) for commit identity — no shell, nothing client-controllable, no secret content.

## 5. LLM boundary (PASS)

- 8 active read-only tools; arbitrary tools/symbols/URLs/args rejected (test-pinned); planned tools refused.
- Grounding guard: an ungrounded first answer forces a real tool call server-side — the model cannot ship unverified market claims from this endpoint.
- Deterministic `dataState` derived from tool facts only; the UI renders it separately from model text.
- z-ai-web-dev-sdk remains server-side only.

## 6. Migration safety (PASS)

`20261015055909_phase9_signal_evaluations`: additive-only (CREATE TABLE + 3 CREATE INDEX — verified DDL, no ALTER/DROP). Prior data untouched (SystemEvent/AnalysisRun/BacktestRun row counts preserved).

## 7. Verdicts

| Criterion | Verdict |
|---|---|
| No order/trade/position route or command introduced | **PASS** |
| Four execution locks intact & engaged | **PASS** |
| Authorization/rate limits preserved or strengthened | **PASS** (audit endpoint now guarded; chat rate-limited) |
| Credentials never in frontend/logs/API/model context/DB | **PASS** |
| Append-only audit trails (SystemEvent / SignalEvaluation) | **PASS** |
| Additive-only migration | **PASS** |
| Production build | **NOT RUN** (sandbox rule) — compile verified via tsc + dev-server E2E; disclosed |
