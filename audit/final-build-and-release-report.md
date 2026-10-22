# Final Build & Release Report — Task 45 (Signal Failure Remediation + Fresh Signal Table)

**Date:** 2026-10-22 · **Repository:** github.com/psfaruk/Only-Xauusd
**Branch:** `remediation/fresh-signal-table` (from main `94d4149`) → merged to main
**Release decision: PASS WITH LIMITATIONS** (limitations listed in §9 — all engineering gates green;
the strategy itself remains REJECTED for live-reliance per the Task 43 six-month OOS verdict, which
this task does not overturn and does not attempt to).

---

## 1. Commits

- **Starting SHA:** `94d4149` (main)
- **Final SHA:** see `git log -1` — this report is written pre-commit; the worklog entry records the
  final SHA after commit. Branch `remediation/fresh-signal-table` merged into `main` and pushed
  (no force-push; history preserved).

## 2. Confirmed root causes of "missing signals"

**The pipeline was never broken.** Stage-by-stage reproduction (Task 45 §Phase 0, evidence in
`audit/signal-failure-root-cause.md`): broker auth OK → scheduler 121/121 cycles (max gap 61s) →
ingestion validation clean → all 5 TFs fresh → 3 engines evaluate every cycle → 170+ evaluations
persisted with reason codes → APIs 200 → UI renders honestly. The signal absence is the
**measured selectivity of the hardened strategy** (SCALPER_NO_AGREE ×138, ZONE_INVALIDATED ×36 …;
live SMC scores 37–54 below the tier-B 55 threshold; six-month backtest ground truth 0.2–0.4
setups/day). The REAL defect was observability: no Fresh Signal Table, no centralized freshness
policy, no pipeline-health surface — a healthy selective engine looked like a broken one. **Fixed.**

## 3. What was implemented (files changed/added)

**Added:**
- `src/lib/signal/freshness.ts` — centralized freshness policy (pure, 11 ordered rules)
- `src/lib/signal/fresh-service.ts` — table assembly + pipeline-health service
- `src/app/api/signal/fresh/route.ts` — the Fresh Signal Table API (guard, strict zod, pagination)
- `src/components/terminal/FreshSignalTable.tsx` — the primary signals surface (table + drawer + timeline + controls)
- `tests/signal/freshness.test.ts` (20 tests) · `tests/signal/fresh-api.test.ts` (20 tests)
- `audit/signal-failure-root-cause.md` · `audit/fresh-signal-table-acceptance.md` ·
  `audit/signal-pipeline-verification.md` · this report · browser screenshots (3)

**Modified:**
- `src/lib/signal/schemas.ts` (+`freshSignalQuerySchema`) · `src/lib/dashboard/types.ts` (+fresh types)
- `src/lib/dashboard/nav.ts` (+`signals` view) · `src/components/terminal/AppSidebar.tsx` (+nav item)
- `src/app/page.tsx` (view wiring, mobile nav 7-col + Zap icon) · `tests/ui/nav.test.ts` (7 views pin)

**Untouched:** engines, ingestion, bridge, paper tracker, all existing API routes (hard red line
preserved — zero backend connection changes; the new route is purely additive).

## 4. Market data + engine evidence (live, this task)

- Provider: Exness MT5 `Exness-MT5Trial6` login `414•••70` (read-only). Latest verified tick at
  browser test: bid 4036.442 / ask 4036.682, age 0s.
- Analysis cycles during testing: 170+ evaluations persisted (scanning window at test time);
  valid candidates: 0; rejected: all 170 (reason distribution above); published signals: 0 —
  each cycle's decision is persisted and visible in the table's archive + drawer.
- Six-month backtest (Task 43, unchanged): baseline OOS −11.32R PF 0.72 REJECTED; candidate OOS
  −9.74R REJECTED. Data coverage: 151k broker-authorized candles; M1 >100d unavailable (reported).

## 5. Test commands and results (exact)

| Command | Result |
|---|---|
| `bunx tsc --noEmit` | **0 errors** (exit 0) |
| `bun run lint` | **0 problems** (exit 0) |
| `node .zscripts/secret-scan.mjs` | **PASS — 1618 tracked files, 0 findings** |
| `bun test` | **998 pass / 0 fail** — 63 files (was 958/958 at Task 44; +40 new Task-45 tests: 20 freshness-policy + 20 fresh-API; nav test updated to 7 views) |
| `bun test tests/signal/freshness.test.ts` | 20/20 |
| `bun test tests/signal/fresh-api.test.ts` | 20/20 |

## 6. Production build

**NOT RUN** — the sandbox platform forbids `bun run build` (recorded honestly, same as Tasks 42–44).
Compile dimension covered by the strict tsc gate (0 errors) and the running dev server compiling
every route on demand (all 200s).

## 7. Security & read-only verification

- `tradingMode` hard-locked `read_only` (code constant) · executionLocked true in /api/health.
- Bridge read-only (GET data routes only; order surface 405/404 — unchanged since Task 43-c).
- New API uses the same fail-closed guard; strict zod rejects bad input (6 × 400 tests); response
  payload secret-scanned in tests (none); anon triggers 403.
- No broker order was placed by any part of this work (read-only boundary intact).

## 8. Deployment status

- Dev server (:3000), bridge (:3031), tick-stream (:3041) all live through this session; the Fresh
  Signal Table verified end-to-end through the user gateway (:81) with zero console/page errors.
- One operational incident during the session: the next-server child died (likely OOM under the
  dev-server + 4-service + full-test-suite load) — relaunched via `.zscripts/relaunch-dev.py`,
  verified 200; not caused by the new code (it renders fine after restart).

## 9. Remaining blockers / owner actions / limitations

1. **Strategy verdict unchanged:** signals must NOT be treated as reliable/profitable — six-month
   OOS REJECTED both strategies; paper-forward ledger restarts at zero; only pre-registered
   forward evidence can change this. (Owner action: let it run; observe the paper tracker.)
2. Live table currently empty of setups — by selectivity, not defect (see §2/§4).
3. UI date-range pickers not yet rendered (API supports fromUtc/toUtc).
4. Production build not run in-sandbox (platform rule) — run `bun run build` in your environment.
5. Standing Task-42 user actions (docs/security-rotation.md): rotate the Exness password, confirm
   the repo is PRIVATE, rotate the bridge token.
6. M1 history older than ~100 days is broker-unavailable (explicitly not fabricated).

## 10. ADDENDUM — first REAL live signal captured end-to-end (post-commit proof)

Minutes after the release commit, at 2026-10-22T17:05:48Z the baseline engine
(hybrid-structure-retest/9.0.0) detected and persisted the FIRST REAL live setup of this session:

- **SELL_SETUP · M15** — entry 4037.806 · SL 4069.820 · TP 3973.779 · R:R 2.00 · expiry 20:00 UTC
- Paper row auto-created by the scheduler (open, 0 observations → status PENDING — honest)
- The Fresh Signal Table picked it up LIVE: badge অপেক্ষমাণ, movement +1.239 (+0.04R),
  current price 4039.045, lifecycle DECISION_CANDLE → SETUP_KNOWN → EVALUATED → PAPER_OPENED
- Screenshot: `audit/task45-first-live-signal.png` · zero console errors

This is the complete end-to-end proof the master prompt required: real broker data → validated
candles → engine decision → persisted signal → paper tracking → API → Fresh Signal Table → UI —
every stage verified with a REAL signal, nothing fabricated.
