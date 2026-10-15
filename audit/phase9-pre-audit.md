# Phase 9 Pre-Audit — Repository & Runtime Inspection (before any implementation change)

**Date:** 2026-10-15 (Asia/Dhaka) · **Auditor:** Z.ai Code (Phase 9 main orchestrator)
**Method:** Direct inspection of the working tree, git state, live runtime (dev :3000, bridge :3031), database, and the full Phase 8 report set. No implementation code was changed before this report.

---

## 0. Executive summary

The Phase 8 foundation is **real and live-verified right now**: the read-only bridge holds an authenticated Exness-MT5Trial6 session, a fresh XAUUSDm quote flows, and 3,920 closed verified candles sit in SQLite. However, the audit found **three honest discrepancies** that Phase 9 must address, exactly as the spec predicted ("Do not assume the contents of the Phase 8 reports are proof that the current deployed runtime still behaves identically"):

1. **The environment audit misrepresents the current architecture** (Task A target): `src/lib/audit/static-audit.ts` still ships Phase 1 checks `wine: FAIL` and `mt5-pkg: FAIL`, although the running system depends on neither — the real data path is the TypeScript WebSocket bridge. The dashboard renders these as "2 fail" without explaining they are obsolete-dependency failures, not current-system failures.
2. **The Phase 8 backtest tests are GONE**: the Phase 8 final report and worklog claim `tests/backtest/engine.test.ts — 11 cases` (no-look-ahead mutation pin, collision pin, fingerprint identity, cost monotonicity). That file **does not exist in the working tree nor anywhere in git history** — it was lost before the Phase 8 tree was committed (sandbox restart). Today `src/lib/backtest/engine.ts` has **zero test coverage**. The current suite (166 pass / 9 files) does not touch the backtest engine. Phase 9 Task G must recreate this coverage (the new signal-backtest tests subsume it).
3. **Stale metadata contradicting the code** (Task A5): `mt5Feasibility` still proposes the obsolete "Linux VPS + Wine / Windows VPS" bridge plan; `architectureLayers` describes the bridge as "EXTERNAL — outside sandbox"; `databaseModels` marks active models (MarketCandle, AnalysisRun, BacktestRun…) as "planned"; `config.version` is still `0.1.0-phase4`.

## 1. Git & tree state

| Item | Finding (evidence) |
|---|---|
| Branch / HEAD | `main` @ `46d1225` (= GitHub head, verified via API after Task 9 push) |
| Working tree | clean at inspection (`git status --porcelain` empty) |
| Published content | Phases 1–8 complete, incl. `mini-services/mt5-bridge/`, `src/lib/{market,analysis,backtest}/`, 6 phase8 audit reports |
| Lost artifacts | `tests/backtest/engine.test.ts` — absent from tree AND from every commit (verified `git ls-tree -r` on all Phase 8 commits). Phase 8 report §5 claims it existed; it cannot be reproduced from the current tree. |

## 2. Live runtime state (verified 2026-10-15 ~05:45 UTC)

| Probe | Result |
|---|---|
| `GET localhost:3000/api/health` | 200 `status: ok`, `executionLocked: true`, DB ok, uptime ~5,238 s |
| `GET localhost:3031/health` | 200 `connected: true, authenticated: true, source: mt5` |
| `GET :3031/api/status` (auth) | `server: "Exness-MT5Trial6"` (matches intended), `gateway: 47.130.41.116`, `loginMasked: 414•••70`, 355 symbols, `brokerOffsetVerified: true`, `reconnects: 0` |
| `GET :3031/api/quote?symbol=XAUUSDm` | `bid 4139.622 / ask 4139.862, spread 0.240, digits 3, ts == now` (fresh) |
| DB candle counts (closed) | M5 921 · M15 1006 · H1 994 · H4 999 (all `source=bridge-mt5`) |
| DB tick | fresh (`bridge-mt5`, updated by scheduled 5-min sync — `MARKET_SYNC_SUCCESS` in dev.log) |
| SymbolSpec | `digits=3` **verified** from broker; `point=0.001` derived; `tickSize/tickValue/volume*` = null (not served by the bridge contract — honest nulls) |
| Signal table | 0 rows (Phase 5 never built — signal construction genuinely absent) |
| AnalysisRun / BacktestRun | 4 / 10 rows persisted |

## 3. Module map (what Phase 9 reuses — no rebuilding)

- **Data integrity (Phase 8):** `src/lib/market/integrity.ts` — `quoteIntegrity()` (source class broker/relay/cache/synthetic, freshness LIVE/STALE/DEGRADED/DISCONNECTED, `signalPermitted` + `blockedReasons`), `auditCandleHistory()` (per-TF gaps/duplicates/OHLC re-check/H4 coverage note). Consumed by `GET /api/data/health`.
- **Analysis (Phase 4, pure & causal):** `swings.ts` (both-sides window, confirmation index), `structure.ts` (`classifyStructure`, `scanStructureEvents` close-only BOS/CHoCH with consumed levels, `trendFromLabels`, `pairLabel` exported), `indicators.ts` (EMA/RSI/ATR/ADX Wilder conventions), `engine.ts` (`computeInputFingerprint` sha256 over exact decimal text), `persistence.ts` (closed-candle loader with read-time re-validation), `service.ts` (BLOCKED/FAILED semantics + audit trail).
- **Backtest (Phase 8):** `engine.ts` — verified-candles-only, next-bar-open entries, spread 0.24 + slippage 0.02, SL-first collision rule, dev/OOS 70/30, INSUFFICIENT_DATA honesty, dataset fingerprints; `service.ts` — loader (source='bridge-mt5', VALID, closed) + BacktestRun persistence.
- **Tool registry (Phase 1):** `executeTool()` allowlist gate + JSON-schema-subset validation; 1 active tool (`get_system_health`), 8 planned. Phase 9 replaces the planned list with 7 new active read-only tools.
- **Guards & logging:** `guardDataApi` (trigger always-token / read token-or-public-opt-in, timing-safe, per-IP rate limit), `logEvent` (secret-masked SystemEvent trail).
- **GLM:** `z-ai-web-dev-sdk` (server-only), proven tool-calling loop in `/api/ai/verify`.

## 4. Task A target — what exactly is misleading today

- `environmentChecks[]` in `static-audit.ts`: 11 entries with Phase 1 timestamps (`AUDIT_PERFORMED_AT = 2026-10-14T17:40:00Z`), including `wine: fail` + `mt5-pkg: fail`. The audit route merges them with live runtime values but **never re-tests the two failing checks** and never marks them historical/obsolete → the UI shows an unexplained "9 pass / 2 fail" aggregate.
- No current-architecture checks exist at all: bridge health, authenticated session, intended server identity, exact `XAUUSDm` resolution, quote freshness, candle coverage, DB health, signal-engine readiness, execution-lock state are NOT part of the audit report (they live only in `/api/data/health`).
- Evidence model has no `PASS/WARN/FAIL/BLOCKED/NOT_APPLICABLE/NOT_TESTED` distinction, no evidence type, no timestamps per check, no freshness policy.
- `POST` trigger inventory today: `/api/data/sync`, `/api/analysis/run`, `/api/backtest/run`, `/api/ai/verify` — all token-guarded. No audit-run trigger exists (none needed: fresh runtime checks are cheap, bounded, and run per GET request — decision recorded here).

## 5. Design decisions locked for Phase 9 (from pre-audit findings)

1. **Audit v2 model** (`src/lib/audit/`): versioned results with `status ∈ {PASS, WARN, FAIL, BLOCKED, NOT_APPLICABLE, NOT_TESTED}`, `evidenceType ∈ {STATIC, COMMAND, API_PROBE, LIVE_BROKER, FIXTURE}`, per-check timestamps + durations + freshness policy. Phase 1 evidence preserved verbatim as `historical` (phase tag 1, original timestamp); Wine + MetaTrader5-Python become `NOT_APPLICABLE` **only** with code-inspection evidence (no `wine`/`MetaTrader5` dependency anywhere in the runtime path — the bridge is the TS WebSocket client). Current bridge checks (health / auth / server identity / symbol resolution / fresh quote / candle coverage / DB / signal readiness / execution lock) run fresh per request as bounded in-process probes — **no shell, no client-supplied commands, fixed check ids only**.
2. **Signal engine** (`src/lib/signal/`): pure core (`core.ts`) reused by BOTH the live service and the backtest — one implementation, no drift. Outcomes `BUY_SETUP | SELL_SETUP | WAIT | BLOCKED | NO_SETUP` (+ FAILED for exceptions), typed reason codes, entry-zone/SL/target/R:R only when every gate + strategy condition passes, additive Prisma model `SignalEvaluation` (append-only, never overwritten).
3. **Backtest of the signal engine** (`src/lib/backtest/` extension): same verified-candle loader + cost model + collision rule; the strategy core evaluated as-of each bar (no look-ahead, mutation-tested); separate counts for candidate/valid/blocked/fills/completed; OOS never optimized.
4. **Chat agent** (`src/lib/chat/` + `POST /api/chat`): Bengali-first, 7 allowlisted read-only tools, deterministic state always rendered separately from LLM text (the model cannot override BLOCKED — it has no tool that can, and the UI shows the authoritative block). Chat uses the existing `read` guard posture (token required whenever `DATA_API_TOKEN` is set; preview-only public opt-in otherwise, same convention as all GETs) **plus a stricter chat-specific rate limit and message-size caps** — documented as a query endpoint (no domain state mutation; only audit-trail events).
5. **Signal run** stays a `trigger` (token always required, like analysis/backtest runs). **Audit refresh** = re-GET (no new trigger route).
6. **Recreated + new tests** (Task G): audit v2, signal engine, signal backtest (subsumes the lost Phase 8 backtest tests), chat tools/agent loop, regression/security pins.

## 6. Pre-implementation verdicts

| Phase 9 acceptance criterion | Pre-state |
|---|---|
| 1. Environment audit stops misrepresenting Wine/Python as current failures | **FAIL (current state)** — Task A implements the fix |
| 2. Dashboard distinguishes current vs historical evidence | **FAIL** — single stale aggregate today |
| 3. Bridge connectivity & data freshness independently verified | **PASS (live, re-verified this audit — §2)** |
| 4. Deterministic signal engine produces valid setups only when all conditions pass | **NOT PRESENT** — Phase 5 never built; 0 Signal rows |
| 5. Invalid/stale inputs fail closed with reasons | Partially present in analysis layer; absent in signal layer (doesn't exist) |
| 6. Signal engine connected to verified-data backtest | **NOT PRESENT** — backtest runs a structure-proxy, not the signal engine |
| 7. Backtest reproducible + honest limitations | Present for the proxy; signal-engine variant NOT PRESENT |
| 8. Bengali Chat Agent with allowlisted tools | **NOT PRESENT** — only `get_system_health` is active today |
| 9. LLM cannot override deterministic signals/gates | Architecture ready (registry); chat loop NOT PRESENT |
| 10. Tests/lint/type-check accurately reported | Current: 166/166 pass (9 files), BUT backtest engine untested (lost file) — Task G fixes |
| 11. Four execution locks intact | **PASS** — `phase 8 < 11, EXECUTION_ARMED=false, ALLOW_EXECUTION=false, mode=read_only` → `executionEnabled=false` (live health confirms) |
| 12. No broker execution route/command | **PASS** — POST inventory = 4 guarded triggers; bridge GET-only, no trading cmd ids (Phase 8 scan; re-verified in Task 9 security pass) |

**Go decision:** proceed with Task A (environment audit truth fix) first — per the user's explicit instruction, the first acceptable Phase 9 result is fixing the audit misclassification — then Task B (signal engine), Task C (backtest validation), Task D (chat agent), Tasks E–G (frontend, API contracts, tests), and the 7 audit reports.
