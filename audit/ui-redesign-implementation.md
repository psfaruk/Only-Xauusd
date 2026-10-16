# PHASE UI-02 — Professional Trading Terminal Redesign — Implementation Report

**Date:** 2026-10-16 (Asia/Dhaka session) · **Repo:** `psfaruk/Xauusd-agent` · **Branch:** `main`
**Task:** Redesign the existing single-route dashboard into a professional dark trading terminal (desktop + mobile), connect it to the existing working backend, and verify — **without** touching strategy, risk thresholds, execution locks or protocol state.

---

## 1. Initial commit and working-tree status

| Item | Value (pre-implementation) |
|---|---|
| Branch | `main`, **ahead 2** of `origin/main` (both unpushed commits are the prior audit session's deliverables: `4cdea84` audit screenshots + `a6d8c42` Phase-11A/UI-lock audit reports — preserved untouched) |
| HEAD | `a6d8c42` |
| Working tree | clean at start |
| Runtime (found during preflight) | 3rd sandbox rebuild had wiped `.env` to `DATABASE_URL`-only → bridge MT5-disconnected, DB empty, all data APIs 503 `MARKET_API_TOKEN_NOT_CONFIGURED` — this, not frontend code, was the root cause of every "disabled/empty" control (documented in `audit/ui-lock-root-cause.md` F-02) |

**Post-implementation tree (final diff):** 12 modified files (+528/−3,875), 16 new files, 12 new screenshots. **No commit, no push** (per instruction — pending review).

## 2. Pages/components changed

Single route preserved (`src/app/page.tsx` is the only user-visible route). The 4,083-line single-file UI was restructured into a component architecture:

| File | Role |
|---|---|
| `src/app/page.tsx` (4,083 → 658 lines) | Terminal shell: data fetch loop (same 12 endpoints), actions, desktop workspace, mobile view switching, bottom nav, footer |
| `src/components/terminal/TerminalHeader.tsx` | NEW — gold XAUUSDm branding, connection state, live bid/ask/spread strip, last-data age, Dhaka clock, **Order Execution: LOCKED** badge (bound to backend `executionLocked`) |
| `src/components/terminal/ChartPanel.tsx` | NEW — `lightweight-charts` v5.2.1 candlestick workspace (real persisted broker candles) |
| `src/components/terminal/SignalCard.tsx` | NEW — compact latest-decision card (BUY/SELL/WAIT/NO_SETUP/BLOCKED/FAILED + levels + condition counts) |
| `src/components/terminal/DashboardView.tsx` | NEW — mobile dashboard (signal card, market snapshot, live status mini-cards) |
| `src/components/terminal/ChatView.tsx` | NEW — upgraded Bengali chat (Enter-send, Shift+Enter newline, retry, auto-scroll, deterministic data-state block) |
| `src/components/terminal/HistoryView.tsx` | PORTED — full latest evaluation, rules-snapshot (3 states), condition checklist, backtest comparison, append-only history table |
| `src/components/terminal/AnalysisView.tsx` | PORTED — analysis engine runs + Phase-10 validation + forward paper + backtest (sub-tabs) |
| `src/components/terminal/SystemView.tsx` | PORTED — audit v2 / market data / data health / GLM verify / MT5 / database / security / architecture (sub-tabs) + SystemEvent trail |
| `src/lib/dashboard/{types,i18n,nav,chat-logic}.ts` | NEW — extracted API shapes, Bengali maps, nav model, pure chat logic (all testable) |
| `src/app/api/data/chart/route.ts` | NEW — read-only chart data endpoint (see §3) |
| `src/app/layout.tsx` | metadata only (title/description updated from stale "Phase 1 Audit") |

## 3. New or reused UI functionality

**Reused (unchanged contracts):** all 12 GET endpoints, all 5 POST actions (GLM verify, manual sync, analysis run, signal run, chat), Prisma models, MT5 bridge, scheduler, price-precision display spec, Bengali error-code map, paper/validation surfaces — every former tab's content survives as a view/sub-tab.

**New:**
1. **Chart workspace** — real OHLC candles from the validated MT5-bridge data (never a different provider, never fabricated):
   - Timeframes H4/H1/M15/M5 (backend allowlist, `data-testid=tf-*`)
   - **EMA 20/50/200** — series computed by the *same* `src/lib/analysis/indicators.ts` the engine uses, over **closed candles only**; `INSUFFICIENT_DATA → null` rendered as an honest disabled toggle
   - **Swing highs/lows** (right-side-confirmed only), **BOS/CHoCH break markers** and **S/R price lines** (last confirmed swing high/low) — all from the *same* `detectSwings`/`scanStructureEvents`/`buildStructureResult` functions the engine uses, via the new endpoint (zero strategy logic duplicated in the UI)
   - Forming bar appended last and flagged (real broker data, excluded from indicators)
   - States: loading, empty, **stale** (per-TF threshold), **disconnected** (bridge down), **error + retry** — all verified live (screenshot `ui02-mobile-chart-error-state.png`), plus verified recovery
   - Resize via `autoSize` (ResizeObserver) — verified at 375px and 1280px
2. **New read-only endpoint `GET /api/data/chart`** — `guardDataApi('read')`, zod-validated (symbol/timeframe allowlists, limit 60–500), reuses the engine loader (`loadAnalysisInput`) so candles pass the same read-time re-validation. GET-only; no DB writes.
3. **Desktop layout** — header quote strip → chart (≈2/3 width) + right rail (signal decision + market snapshot) → status mini-cards → lower tabs (সিগন্যাল ইতিহাস | বিশ্লেষণ | সিস্টেম). Chat opens as a right **Sheet** so the chart stays visible.
4. **Mobile layout (deliberate, not shrunken desktop)** — compact header, one view at a time, **bottom navigation** (ড্যাশবোর্ড · চার্ট · এআই চ্যাট · সিগন্যাল · সিস্টেম) with safe-area inset, 56px touch targets, stacked panels. Zero horizontal overflow at 375px (verified programmatically on every view).
5. **Chat upgrades** — Enter sends / Shift+Enter newline; duplicate submission impossible while running; distinct progress/completion/error states; retry affordance resends the last failed message; honest error bubbles marked `isError` (never rendered as success).
6. **F-03/F-04/F-05/F-06 fixes from the prior UI audit** — GLM capability badges are three-state (`অজানা (API অনুপলব্ধ)` when the audit API is unreachable, never a false ✗); audit/validation/backtest/signal/history/quality surfaces render explicit *unavailable* banners distinct from *genuinely empty*; single phase label source (`health.phaseLabel`); KPI cards now bind live values only (removed the hardcoded "চ্যাট ✓ বাংলা ✓ টুল-কলিং ✓ (720ms)" static claim).

## 4. Root cause and resolution of `MARKET_API_TOKEN_NOT_CONFIGURED`

**Root cause (traced end-to-end, not an external token):** the error originates in the app's own API guard, `src/lib/api-guard.ts` (`guardDataApi`):
- **POST trigger endpoints** (`/api/data/sync`, `/api/analysis/run`, `/api/signal/run`) require `DATA_API_TOKEN` **always** — unset → 503 `MARKET_API_TOKEN_NOT_CONFIGURED`, **no bypass by design** (Phase 4 hardening).
- **GET read endpoints** require the token when set; when unset they fail closed **unless** `MARKET_API_PUBLIC_READS=true` (explicit preview opt-in).

**Is an external token required? No.** Market data flows through the existing approved path: MT5 bridge (`MT5_BRIDGE_TOKEN`, server-to-server) → ingestion → SQLite → GET APIs. No unrelated provider was added or substituted.

**Resolution:** restored the gitignored `.env` to the audited Task-25 preview posture — `MARKET_API_PUBLIC_READS=true` (anonymous dashboard reads work; verified: all 12 GETs return 200), `MT5_BRIDGE_URL/TOKEN`, MT5 session keys, `MARKET_SYNC_INTERVAL_MS=300000`, `FORWARD_PAPER_TRACKING=1`, and the four execution locks explicitly LOCKED. **POST triggers intentionally remain fail-closed for the anonymous browser** (a UI button must never bypass backend authorization): the Run-Analysis / Run-Signal / Manual-Sync buttons render the exact 503 reason plus the exact configuration variable (`DATA_API_TOKEN`) and the fact that the scheduler evaluates automatically every 5 minutes — honest, actionable, no fabricated success. Secrets never appear in code, logs, responses or this report.

## 5. Desktop and mobile verification results (agent-browser E2E, live server)

**Desktop 1280×800** — `GET /` 200; header quote strip renders **live** bid/ask/spread (e.g. 4164.497/4164.737/0.240, LIVE badge, Exness-MT5Trial6, 39ms latency); chart loads 300 closed + 1 forming M15 candles with real prices (O 4166.758 …), bearish structure LH/LL, last BOS @ 4171.066, S/R 4185.122/4171.066; **TF switching verified** (M15→H1→H4 each reload their own structure); lower tabs verified (সিস্টেম sub-tab list + বিশ্লেষণ); chat Sheet opens from header, message sent via **Enter**, GLM replied with live grounded data (bid/ask/spread/quote-time, "0 সেকেন্ড"); **0 page errors, 0 console errors**. Screenshots: `ui02-desktop-{initial,workspace,system,analysis,chat-sheet,final}.png`.

**Mobile 375×812** — bottom nav (5 items, safe-area aware) verified; all five views render with **zero horizontal overflow** (programmatic check per view); chart panel renders + error state + recovery verified via request interception; chat send verified end-to-end (agent honestly replied "কোনো বিশ্লেষণ রান হয়নি…" — no fabrication when AnalysisRun is empty); footer sits at exact document bottom (`footerBottom 812.06 = viewport 812`, no floating gap) and is pushed down naturally on long pages. Screenshots: `ui02-mobile-{dashboard,chart,chat,history,system,chart-error-state}.png`.

**Visual (GLM vision) verification:** desktop workspace — candles YES, EMA lines YES, bid/ask header YES, broken/overlapping UI NO; mobile dashboard — 5-item bottom nav YES, overflow NO, professional look YES.

## 6. Tests, lint, typecheck and build outcomes

| Check | Command | Result |
|---|---|---|
| TypeScript | `bunx tsc --noEmit` | **0 errors** |
| Lint | `bun run lint` | **0 errors, 0 warnings** |
| Full test suite | `bun test` | **532 pass / 0 fail** (85,387 expect calls, 30 files) — includes 33 NEW UI-02 tests (`tests/ui/`: nav model, chat logic, chart API, execution-lock invariants) |
| Production build | `bun run build` | **Not run** — sandbox constraint (dev-server-only policy on port 3000; a build would disrupt the running preview). Stated honestly; not claimed. |
| E2E | agent-browser (this section §5) | Passed, evidence screenshots committed under `audit/` |

**Test-hermeticity fix (pre-existing defect, root-caused in the Phase-11A audit):** the suite previously failed 3 tests whenever bun's readdir/inode file order put market/analysis seeders before signal tests. Added file-level `afterAll` cleanup to the seven seeding files (`tests/market/{quality,api}.test.ts`, `tests/analysis/{persistence-api,readiness}.test.ts`, `tests/signal/{forward-paper,paper-chronology,paper}.test.ts`). The suite is now **order-independent** (full run green; previously-failing pairs verified green).

## 7. Remaining issues and exact next steps

1. **AnalysisRun table stays empty in the anonymous preview** (by design): the scheduler runs signal evaluation + paper tracking, not the Phase-4 analysis engine; the manual run is token-guarded. *Next step (operator, no code change):* set `DATA_API_TOKEN` and `POST /api/analysis/run` with `Authorization: Bearer …` for an authenticated run — or, in a future phase, pre-register a scheduler extension that persists analysis runs (protocol impact must be audited first). The chart/structure panel already shows live engine-computed structure via `/api/data/chart`, and the chat agent honestly reports the absence.
2. **Sandbox persistence:** `.env` and the SQLite DB live outside git and are wiped by sandbox rebuilds (happened 3×). Re-apply the §4 posture (or the `.zscripts/relaunch-*.py` helpers) after any rebuild. Consider a `paper:snapshot` + commit cadence for durable paper data.
3. **Two unpushed prior-audit commits + this change set** await review; then commit (message drafted in worklog) and push.
4. **Chart niceties (optional):** crosshair OHLC readout, configurable bar count, pinch-zoom hints — none block the mandate.

## 8. Read-only execution and the four locks — confirmation

- **Code:** `git diff` shows **zero changes** under `src/lib/signal/`, `src/lib/market/`, `src/lib/config.ts`, `src/lib/api-guard.ts`, `src/instrumentation.ts`, `prisma/` — strategy thresholds, rules, validation protocol and lock logic are byte-identical.
- **Env:** `.env` pins all four switches LOCKED: `TRADING_PHASE=4` (gate needs ≥11), `TRADING_MODE=read_only`, `EXECUTION_ARMED=false`, `ALLOW_EXECUTION=false`. (If `.env` is ever absent, `src/lib/config.ts` fail-closed defaults produce the same locked state.)
- **Live:** `/api/health` → `executionLocked: true`, `read_only`, "Phase 4 is read-only by design (Phase 11 gate required)"; bridge `POST → 405`, no-token `GET → 401`; `POST /api/signal/run → 503` fail-closed.
- **No order path introduced:** new endpoint is GET-only + read-guarded (statically asserted in `tests/ui/execution-lock-invariants.test.ts`); no `order/trade/position/execution` route exists; the frontend fetch surface was statically scanned — no order calls. UI lock badge is bound to the backend flag and the lock never disables chart/analysis/chat/history.
- **Invariants test-tripwired:** `tests/ui/execution-lock-invariants.test.ts` fails if execution ever becomes enabled, if a mutation handler appears on the chart route, or if the frontend ever fetches an order endpoint.

**Result: the application remains analysis/signal-only and MT5 read-only. No trades can be placed by any path.**
