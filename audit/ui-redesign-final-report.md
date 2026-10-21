# UI Redesign — Final Report (Task 39 / UI-03 "Sky Terminal")

## 1. Mission

User request: the app's design looked disorganized (এলোমেলো); rebuild it as an attractive, transparent, well-sequenced professional terminal with sidebar, dropdowns, toolboxes, panels, popups, search bar, aligned menus, filters, header, footer and hero — prioritizing **sky blue, sunlight amber, dark, white** — without breaking ANY backend↔frontend integration.

## 2. What was delivered

### Design system (globals.css rewrite)
- Full semantic token system for the four requested palettes, light + dark themes:
  - Sky blue primary: `#38BDF8` (dark) / `#0284C7` (light); brand text-safe `#7DD3FC` / `#0369A1`
  - Sunlight amber accent: `#FBBF24` / `#B45309` (+ `on-sun` for solid amber surfaces)
  - Dark terminal depth: `#0B1220` page → `#111C2E` panels → `#162338` cards → `#17253C` insets
  - Clean white light mode: `#F4F8FC` page, `#FFFFFF` surfaces, `#DCE5F0` borders
- New utility families: `bg-terminal/panel/surface`, `text-content`, `text-brand/sun/up/down/warn`, `border-border-strong` — all theme-flipping.
- Status semantics locked: up/down/warn/sun ALWAYS with icon + Bengali label, never color alone.
- Font wiring fixed (Hind Siliguri was defined but never connected — now `--font-sans`), tabular numerals enforced, token-aware scrollbars, `prefers-reduced-motion` respected, `--header-height` metric.

### Migration
- 1,799 + 78 = **1,877 hard-coded color classes** migrated to tokens across 14 components + i18n.ts (zero leftovers; prefix/opacity-preserving regex migration, elevation thresholds).

### App shell
- **Header**: brand, XAUUSDm chip (sun), LIVE/STALE/DEGRADED/DISCONNECTED badge, execution badge (backend verdict), Dhaka clock, global search launcher, theme toggle, chat.
- **Sidebar (desktop)**: grouped (ট্রেডিং / সিস্টেম), active sky highlight + indicator bar, collapsible w-60⇄w-[68px] with tooltips + localStorage, honest execution posture footer.
- **Command palette (Ctrl/⌘K)**: cmdk-based global search — navigation group + actions group wired ONLY to existing handlers (sync/analysis/signal/scalper/GLM verify/AI review/theme/chat).
- **Hero strip**: market anchor with verified bid (big mono), ask/spread, freshness, provenance, Dhaka clock — real payload only, honest empty states.
- **Footer**: sticky-bottom (`mt-auto` flex column), honest posture lines.
- **Mobile**: 6-item bottom nav (active = sky), one view at a time, safe-area aware, no horizontal scroll (verified 390px + 768px).
- **Desktop tabs removed** → sidebar-driven views; new `analysis` TerminalView (client state only).

### Charts
- lightweight-charts chrome reads CSS vars at creation and re-applies on theme flip via MutationObserver on `<html class>` (fixes next-themes parent-effect ordering); BOS/CHoCH markers enlarged to size 2.

### Component polish (parallel subagents 39-a/b/c2/d)
- Unified card anatomy, badge patterns, table conventions (uppercase headers, mono tabular numerics, row hover), level rows (entry/SL/TP color-coded + labels), reason chips, skeleton/empty/error states, 40px+ touch targets, focus rings.
- Fixed the VLM-detected M1/M5 agreement-chip overlap and SMC agent-grid collisions (banded layouts).
- BrokerSettingsView (Exness credential flow): professional form; save/validate/status logic byte-identical — verified live with the real connected Exness session.

## 3. API contracts preserved (the hard requirement)

Every endpoint, method, field, status code, auth rule, rate limit and socket event is unchanged — verified by endpoint health sweep (all 200/503-as-designed) and by the unchanged fetch layer in page.tsx (byte-identical data logic). The four execution safety locks remain enforced server-side; the UI still renders the backend's own lock verdict. No mock data, no fabricated signals, no new order capability.

## 4. Actual verification (commands + results)

| Check | Command | Result |
|---|---|---|
| Types | `bun run typecheck` | PASS (0 errors) |
| Lint | `bun run lint` | PASS (0 problems) |
| Unit/integration | `bun test` | 865/866 pass — 1 pre-existing full-load timeout (candidate harness, passes isolated 7/7) |
| Page load | agent-browser + `errors`/`console` | 0 errors, 0 hydration mismatches |
| Desktop dark | VLM screenshot review | shell 8.5/10 → post-fixes clean (no overlap) |
| Desktop light | VLM review after MutationObserver fix | 9/10, chart flips correctly |
| Mobile 390px | VLM review | 9–10/10, settings form excellent |
| Tablet 768px | DOM checks | mobile layout, no h-scroll |
| Command palette | Ctrl+K + Bengali filter "সিঙ্ক" | opens, filters, endpoint hints |
| Sidebar | collapse/expand + reload | localStorage persisted |
| Theme toggle | dark⇄light + chart | full flip incl. chart |
| Live data | quote strip, candles, scalper signals | real Exness feed rendering |

## 5. Files changed

- `src/app/globals.css` (full rewrite), `src/app/layout.tsx` (ThemeProvider), `src/app/page.tsx` (shell restructure, data logic untouched)
- `src/lib/dashboard/nav.ts` (+`analysis` view), `src/lib/dashboard/i18n.ts` (badge token migration)
- NEW: `src/components/terminal/AppSidebar.tsx`, `CommandPalette.tsx`, `HeroStrip.tsx`
- Restyled: `TerminalHeader`, `ChartPanel`, `ScalperSignalCard`, `SignalCard`, `CandidateSignalCard`, `DashboardView`, `HistoryView`, `AnalysisView`, `SystemView`, `ExecutionPanel`, `ChatView`, `BrokerSettingsView`, `bits.tsx`
- Tooling/docs: `.zscripts/migrate-tokens.py`, `audit/ui-redesign-design-system.md`, `audit/ui-redesign-baseline.md`, this report, screenshots in `audit/ui-redesign-shots/`

## 6. Known limitations / remaining work

- The diagnostics view intentionally shows raw technical detail (JSON/endpoint names) — dense by design for auditability.
- Light-mode chart candle colors are constant (data-encoding); grid/axes/text re-theme fully.
- The full-test-suite candidate-harness timeout predates this task (CPU contention in sandbox); passes in isolation.
- Bengali + English mixed labels retained where they carry technical meaning (strategy IDs, endpoint names).

## 7. Commit

All work (including tracked `.env`, per the established anti-rollback strategy) committed on task completion — see worklog Task 39 final entry for the exact hash.
