# Phase 9 — Chat Agent Audit (Task D)

**Date:** 2026-10-15 (Asia/Dhaka) · **Module:** `src/lib/chat/agent.ts` + 7 new tools in `src/lib/tools/registry.ts` + `POST /api/chat`
**Tests:** 16 chat cases (tests/chat/tools.test.ts) — all pass (fake-model injection, no real GLM in tests). Live conversations executed against the REAL model + REAL broker feed.

---

## 1. D1 — Allowlisted read-only tools only — **PASS**

Active registry (exactly 8 tools, none execution-capable — pinned by tests):

| Tool | Backing service | Bound |
|---|---|---|
| `get_system_health` | collectHealth() | in-process |
| `get_market_health` | quoteIntegrity() (source class, freshness, blockedReasons) | 4 s timeout, no retries |
| `get_latest_quote` | quoteIntegrity() quote fields | honest `available:false` when absent |
| `get_candle_coverage` | auditCandleHistory() | per-TF counts/gaps/H4 note |
| `get_latest_analysis` | getLatestAnalysisRun() | trends, events, fingerprint |
| `get_latest_signal` | getLatestSignalEvaluation() | outcome + levels (setups only) |
| `get_backtest_summary` | BacktestRun (current strategy version + overall) | always carries the no-profit disclaimer |
| `explain_signal_evidence` | latest + history(20) | structure event, anchor swing, indicators, HTF, retest |

Security properties (test-pinned): arbitrary tool names rejected (`run_shell`, `fetch_url`, `raw_sql`, `place_order`); planned tools refused at runtime; malformed args rejected; **arbitrary symbols rejected inside every handler** (allowlist; the model cannot pick EURUSDm or an external URL — none exists); tool output capped at 6,000 chars; secrets never appear in output (credential-pattern scan). No shell, no raw SQL, no filesystem, no network tool, no execution tool — by construction.

## 2. D2 — LLM separated from deterministic decisions — **PASS**

- The signal engine owns direction/levels/readiness; the chat tools only READ them.
- The system prompt forbids inventing prices, overriding BLOCKED, altering SL/target, and claiming execution (test-pinned content).
- **Architectural guard (stronger than the prompt):** if the model answers a first round with NO tool call, the agent deterministically executes `get_market_health` server-side, feeds the real facts back, and requires the answer to be grounded in them — the forced call is recorded and displayed like any tool call. Live incident that motivated this: the first live chat produced a plausible-looking answer with ZERO tool calls (hallucination risk); after the guard, every answer carries verified tool data.
- The response's `dataState` block is computed from TOOL FACTS only — never from model text — and the UI renders it in a visually separate "নির্ধারিত ডেটা অবস্থা" block labeled as authoritative. A model claiming "LIVE" while tools say STALE is impossible to represent in that block (test: a BLOCKED evaluation seeded in the DB → dataState reports BLOCKED + its reason codes regardless of model wording).

## 3. D3 — Evidence-backed answers — **PASS (live-verified)**

Live conversation #1 ("এখন XAUUSDm-এর বাজারের অবস্থা কী?"):
- Tool executed: `get_market_health` (grounding guard) → reply quoted the exact tool values: source broker (Exness-MT5Trial6, authenticated), bid 4133.361 / ask 4133.601, spread 0.240, quote timestamp, LIVE.
- UI displayed: কোট: LIVE · উৎস: broker · `4133.361 / 4133.601` (deterministic badge) · কোট-সময় (timestamp).

Live conversation #2 ("সর্বশেষ সিগন্যাল কেন WAIT হয়েছে?"):
- Tools: `get_latest_signal` + `explain_signal_evidence` → reply explained WAIT [EMA_TREND_OPPOSITE] with the exact EMA50 value (4130.19), price, H1 bearish / H4 range context, and the CHoCH structure event — all matching the persisted evaluation.
- dataState: latestSignalOutcome WAIT, reasonCodes [EMA_TREND_OPPOSITE].

When data is unavailable the tools return `available:false` with a reason — never an estimated price (test-pinned for get_latest_quote).

## 4. API posture (Task F overlap) — **PASS**

- `POST /api/chat`: read-guard posture (token REQUIRED whenever DATA_API_TOKEN is set — 401/503 otherwise) **plus a stricter chat-specific rate limit** (12/min default) and message/history size caps (2,000 chars / 20 turns server-side; schema + config double-bounded). It mutates no domain state (only an audit SystemEvent), documented as a query endpoint.
- Secrets never travel to the model: tool outputs contain masked login at most; credential-pattern scan of model context is clean.

## 5. Frontend (Task E overlap) — **PASS (browser-verified)**

Bengali-first chat tab: suggested-question chips (the five spec questions), user/assistant bubbles, loading state ("টুল থেকে যাচাইকৃত ডেটা আনা হচ্ছে…"), error handling, and the separate deterministic-state block under every assistant answer. No false "live" badge — freshness badges come from tool facts only. Desktop + mobile 390px verified.

## 6. Verdicts

| Acceptance item | Verdict |
|---|---|
| Bengali market question uses the correct allowlisted tool | **PASS** (live #2: get_latest_signal + explain_signal_evidence; fake-model test for get_market_health) |
| Model cannot invent a price when no quote is available | **PASS** (tool returns available:false; prompt + grounding guard) |
| Model cannot override BLOCKED | **PASS** (dataState from tool facts; seeded-BLOCKED test) |
| Arbitrary tools / symbols / URLs / malformed args rejected | **PASS** |
| Secrets never in model context or output | **PASS** |
| Tool errors surfaced honestly | **PASS** (recorded with error text; never dropped) |
| Agent never calls an execution tool | **PASS** (none exists in the registry) |
| Ungrounded answers impossible | **PASS** (architectural grounding guard — the Phase 9 incident found in live testing was fixed by it) |
