# UI Redesign — Baseline & API Contract Inventory (Task 39 / UI-03)

## 1. Repository baseline

- Next.js 16 App Router, TypeScript strict, Tailwind CSS 4 + shadcn/ui (New York), Prisma/SQLite, socket.io tick-stream mini-service (:3041), MT5 bridge mini-service (:3020).
- Single user-visible route `/` (src/app/page.tsx, client component); all features are client-state views (`TerminalView`), no additional routes.
- Pre-redesign design: hard-coded zinc/amber palette (1,799 raw color-class occurrences across 13 terminal components + page.tsx), dark-only, tabs-based desktop navigation, no sidebar, no theme toggle, no global search.

## 2. Component inventory (before → after)

| Component | Purpose | Data source (unchanged) | Redesign |
|---|---|---|---|
| page.tsx | Terminal shell, 15-endpoint refresh loop, all actions | 15 REST endpoints + tick-stream socket | Sidebar shell + view switching; ALL fetch/state logic byte-identical |
| TerminalHeader | Brand, quote strip, badges, clock | /api/data/health, /api/health | Redesigned + search launcher + theme toggle |
| AppSidebar (NEW) | Desktop grouped nav | health prop | New component |
| CommandPalette (NEW) | Ctrl/⌘K search + toolbox | existing handlers only | New component (cmdk) |
| HeroStrip (NEW) | Market overview anchor | /api/data/health | New component (real quote only) |
| ChartPanel | lightweight-charts candlesticks | /api/data/chart + tick | Theme-aware chrome (CSS vars), marker size 2 |
| ScalperSignalCard | M1/M5/M15 scalper signal | /api/signal/scalper | Token polish + overlap fix (agent 39-a + orchestrator) |
| SignalCard | Baseline signal decision | /api/signal/latest | Token polish (39-a) |
| CandidateSignalCard | Research candidate | /api/signal/latest | Token polish (39-a) |
| DashboardView (+MarketSnapshot, SystemMiniCards) | Mobile dashboard | props | Token polish (39-a) |
| HistoryView | Signal history + AI review + execution | /api/signal/history ×2, review, execution | Token polish (39-b) |
| AnalysisView | Analysis + validation + backtest | /api/analysis/latest, /api/validation/latest, /api/backtest/latest | Token polish (39-b) |
| SystemView | Audit, data health, GLM verify, sync, tick-stream diag | /api/audit/environment, /api/data/*, /api/ai/verify | Token polish (39-c2, after 39-c restore) |
| ExecutionPanel | Approvals + positions | /api/execution/state, decide, close + live bundles | Token polish (39-c) |
| ChatView | Bengali AI chat | /api/chat | Token polish (39-d) |
| BrokerSettingsView | Exness credential form (user's #1 flow) | /api/broker/settings GET/POST | Token polish, save logic byte-identical (39-d) |
| bits.tsx | Price text, status icons, clock | props | Token polish (39-a) |
| i18n.ts (lib) | Bengali labels + badge classes | — | Badge helpers migrated to tokens (78 classes) |

## 3. API contract inventory (all preserved — verified post-redesign)

| Endpoint | Method | Consumers | Status after redesign |
|---|---|---|---|
| /api/health | GET (503 carries payload) | page.tsx refresh, header/footer | 200/503 as designed ✓ |
| /api/audit/environment | GET | SystemView | 200 ✓ |
| /api/data/status | GET | SystemView, DashboardView | 200 ✓ |
| /api/data/quality | GET | SystemView | 200 ✓ |
| /api/data/health?symbol | GET | header, hero, snapshot | 200 ✓ |
| /api/data/latest?symbol | GET | price spec | 200 ✓ |
| /api/data/chart?symbol&tf&limit | GET | ChartPanel | 200 ✓ |
| /api/data/sync | POST | sync button + palette action | unchanged ✓ |
| /api/analysis/latest · /run | GET/POST | AnalysisView + button/palette | 200 ✓ / POST unchanged ✓ |
| /api/signal/latest · /run · /history(×2) | GET/POST | SignalCard, HistoryView | 200 ✓ |
| /api/signal/scalper?symbol | GET/POST | ScalperSignalCard | 200 ✓ |
| /api/validation/latest | GET | AnalysisView | 200 ✓ |
| /api/backtest/latest | GET | AnalysisView, SystemView | 200 ✓ |
| /api/ai/verify · /api/ai/review(·/latest) | POST/GET | SystemView, ExecutionPanel | 200 ✓ |
| /api/execution/state · decide · close | GET/POST/POST | ExecutionPanel | 200 ✓ |
| /api/chat | POST | ChatView | unchanged ✓ |
| /api/broker/settings | GET/POST | BrokerSettingsView | unchanged ✓ (verified live: Exness session connected) |
| tick-stream socket (:3041 via gateway) | socket.io | useTickStream → chart/execution | unchanged ✓ |

**Contract rules applied**: no endpoint path, method, request/response field, status-code semantic, auth header, rate limit, or event payload was modified. No mock data introduced. No order-execution capability added or removed — the four fail-closed switches and the backend execution gate are untouched; the UI still displays the backend's own `executionLocked` verdict.

## 4. Test status

- `tsc --noEmit`: PASS. `eslint .`: PASS (0 problems).
- `bun test`: 865/866 pass; the single failure is a pre-existing CPU-contention timeout in the candidate comparison harness (7.6s vs 5s budget under full-suite load) — passes in isolation (7/7 in its file). No UI-related test failures.
- Browser-verified (agent-browser + VLM screenshot analysis): desktop dark, desktop light (incl. chart re-theme), mobile 390px (dashboard/settings/chart), tablet 768px, command palette (Ctrl+K + Bengali filtering), sidebar collapse/expand + localStorage, chat sheet, theme toggle, hydration (0 mismatches), no console errors.

## 5. Main risks & mitigations

- **Environment rollback** (recurring platform issue) → all work git-committed including `.env` (tracked), per the established Task 35/38 recovery strategy.
- **Subagent 39-c mid-edit breakage** → SystemView restored from HEAD, tokens re-migrated, re-run by focused agent 39-c2 with incremental compile gates.
- **Hydration mismatch from next-themes** → all `resolvedTheme`-dependent SSR attributes mounted-gated.
- **Chart theme lag** (next-themes flips class in parent effect after child effects) → MutationObserver on `<html class>` re-applies chart chrome after the actual class mutation.
