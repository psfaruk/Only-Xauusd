# Phase 9 — Final Report

**Environment Audit v2, Deterministic XAUUSD Signal Engine & Bengali Chat Agent**
**Date:** 2026-10-15 (Asia/Dhaka) · **Phase:** 9 of 12 · **Mode:** READ-ONLY (four-switch execution lock engaged) · **Commit base:** 46d1225 (working tree carries Phase 9, to be committed after this report)

---

## 1. Executive summary

Phase 9 delivered its three pillars on top of the verified Phase 8 live data path, in the order the user prescribed (audit truth first, then the signal engine, then the chat agent):

1. **Environment Audit v2** — the misleading Phase 1 checklist ("2 fail" forever) is replaced by a six-state versioned model that separates CURRENT fresh checks (13, executed per request with timestamps/durations/commit identity) from preserved HISTORICAL Phase 1 evidence (11, original timestamps, never re-run) and code-inspection-backed NOT_APPLICABLE verdicts for the obsolete Wine/MetaTrader5-Python dependencies. The live bridge architecture is audited as independent checks (health ≠ authentication ≠ server identity ≠ symbol resolution ≠ quote freshness ≠ candle history ≠ signal readiness ≠ locks).
2. **Deterministic signal engine** (`hybrid-structure-retest/9.0.0`) — typed outcomes (BUY_SETUP/SELL_SETUP/WAIT/NO_SETUP/BLOCKED), fail-closed gates, spread-aware validated levels via ONE pure implementation shared with the backtest, append-only persistence with dataset fingerprints. Live-verified: reproducible fingerprints, honest WAIT outcomes.
3. **Bengali chat agent** — 8 allowlisted read-only tools, an architectural grounding guard that makes ungrounded market answers impossible (added after a real hallucination was caught during live testing), and a deterministic data-state block rendered separately from model text. Live conversations verified against the real model and real broker feed.

## 2. Files changed (summary)

**New modules:** `src/lib/audit/{model,historical,runtime-checks,runtime-identity,report}.ts` · `src/lib/signal/{types,rules,core,persistence,service,schemas}.ts` · `src/lib/backtest/signal-engine.ts` · `src/lib/chat/agent.ts` · API routes `api/signal/{run,latest,history}`, `api/chat` · tests `tests/audit/runtime-checks.test.ts`, `tests/signal/engine.test.ts`, `tests/backtest/engine.test.ts` (restored+extended), `tests/chat/tools.test.ts` · scripts `scripts/phase9-signal-audit.ts` · migration `20261015055909_phase9_signal_evaluations` · audit reports (7 files).

**Modified:** `src/lib/config.ts` (v0.2.0-phase9, signal+chat sections, expectedServer, execution switch exposure) · `src/lib/audit/static-audit.ts` (metadata reconciliation) · `src/lib/tools/registry.ts` (8 active read-only tools) · `src/lib/analysis/structure.ts` (pairLabel exported) · `src/lib/backtest/service.ts` (+signal-engine strategy) · `api/backtest/run` (+strategy param) · `api/audit/environment` (v2 + guard) · `src/app/page.tsx` (audit v2 tab, সিগন্যাল tab, চ্যাট tab, Phase 9 labels) · `prisma/schema.prisma` (+SignalEvaluation) · `tests/market/api.test.ts` (registry pin updated) · `tests/market/helpers/mock-bridge.ts` (+server field) · `.env.example` (Phase 9 vars) · `.env` (TRADING_PHASE=9).

## 3. Actual command results (executed this session)

| Command | Result |
|---|---|
| `bun test` | **243 pass / 0 fail** (970 expect calls, 13 files) |
| `bun run lint` | **exit 0, no problems** |
| `bunx tsc --noEmit` (app) | **0 errors** |
| `bunx tsc --noEmit` (bridge) | **0 errors** |
| `bunx prisma migrate dev` | applied `phase9_signal_evaluations` (additive-only, verified) |
| `scripts/phase9-signal-audit.ts` | 2 live evaluations (WAIT, reproducible fp) + 2 backtests (identical dataset fp) |
| `POST /api/signal/run` (token) | 200 → WAIT persisted; without token → 401 |
| `POST /api/backtest/run` (signal-engine) | 200 completed — honest counts |
| Browser E2E (agent-browser) | 11 tabs render; audit v2 3-section; signal tab live data; chat live conversation; mobile 390px no-overflow; sticky footer; **fresh-browser errors: 0** |
| `bun run build` | **NOT RUN** (sandbox rule) — disclosed, not claimed |

## 4. Live broker evidence

- Bridge: authenticated Exness-MT5Trial6 session (gateway 47.130.41.116, masked login 414•••70), XAUUSDm quote LIVE (bid 4133.361/ask 4133.601, spread 0.240, age ≤1 s) during E2E.
- Signal evaluations (real data): WAIT [EMA_TREND_OPPOSITE] ×3 with reproducible fingerprints (`4d36f67a1eab…`×2 identical; `f69295ed29d0…` after data ticked).
- Signal-engine backtest (verified candles M15 1009/H1 995/H4 999): 1,009 evaluations · 466 candidates · 27 valid setups · 8 fills · dev 6 trades **net −131.24 (PF 0)** · OOS **INSUFFICIENT_DATA** (2 trades) — reported honestly, no profitability claim.
- Chat (real GLM): market-status answer grounded in get_market_health (exact tool values in reply + deterministic badge); signal-explanation answer grounded in get_latest_signal + explain_signal_evidence.

## 5. Environment-audit status changes (before → after)

| Check | Phase 8 era | Phase 9 |
|---|---|---|
| wine | FAIL (misleading) | NOT_APPLICABLE (current) + historical FAIL preserved |
| mt5-pkg | FAIL (misleading) | NOT_APPLICABLE (current) + historical FAIL preserved |
| bridge health/auth/identity/symbol/quote/candles/signal-readiness | not checked | 13 current checks, fresh per request (12 PASS + 1 WARN→PASS after GLM re-verify at audit time) |
| execution lock / read-only surface | not in audit | PASS (per-request invariants) |
| Totals shown | "9 pass / 2 fail" (unexplained) | current 13 (12 pass/1 warn/0 fail) · 3 not-applicable · 11 historical — separately |

## 6. Remaining blockers & limitations (honest list)

1. **Strategy not validated:** dev-segment result is negative and OOS is insufficient — the engine is verified for DETERMINISM and fail-closed behavior, not profitability. More data + long-horizon OOS validation remains future work (user's own noted limit).
2. **H4 broker depth** still bounded (~1,458 bars) — long-horizon statistics limited.
3. **Production build not run** (sandbox rule) — compile verified via tsc/dev-server/browser E2E.
4. **Live-vs-backtest reference-price difference** (real-time quote vs decision-bar close) is documented on every backtest run rather than eliminated.
5. The five-minute scheduled sync means M15 decision bars can be up to ~5 min old at evaluation time; the engine treats them as the latest CLOSED bars (correct by definition) and the quote gate enforces live freshness for the reference price.

## 7. Read-only confirmation

The application remains **strictly read-only**: no order/trade/position route or command exists anywhere (statically scanned + test-pinned); all four execution-lock switches engaged (phase 9 < 11, EXECUTION_ARMED=false, ALLOW_EXECUTION=false, mode=read_only); the bridge is GET-only with no trading commands; the LLM is confined to 8 read-only tools and can never override deterministic outputs; every signal evaluation records `executionLocked: true`.

## 8. Acceptance gate (spec §10)

| # | Criterion | Verdict |
|---|---|---|
| 1 | Audit no longer misrepresents Wine/Python as current failures | **PASS** |
| 2 | Dashboard distinguishes current vs historical evidence | **PASS** (browser-verified) |
| 3 | Bridge connectivity & freshness independently verified | **PASS (live)** |
| 4 | Signal engine emits setups only when all conditions pass | **PASS** |
| 5 | Invalid/stale inputs fail closed with specific reasons | **PASS** |
| 6 | Signal engine connected to the verified-data backtest | **PASS** (same core, live runs) |
| 7 | Backtest reproducible + honest limitations | **PASS** |
| 8 | Bengali chat uses allowlisted tools, explains real data | **PASS (live)** |
| 9 | LLM cannot override deterministic signals/gates | **PASS** |
| 10 | Tests/lint/type-checks accurately reported | **PASS** (243/243, clean, build NOT RUN disclosed) |
| 11 | Four execution locks intact | **PASS** |
| 12 | No execution route/command added | **PASS** |
