# Fresh Signal Table — Acceptance Report (Task 45)

**Date:** 2026-10-22 · **Branch:** `remediation/fresh-signal-table` · **Status: IMPLEMENTED + VERIFIED**

## What was built

| Component | Path | Purpose |
|---|---|---|
| Freshness policy (pure) | `src/lib/signal/freshness.ts` | The single centralized, configurable policy. Status derivation from persisted event timestamps ONLY (11 ordered rules); per-TF data classification (FRESH/STALE/DATA_UNAVAILABLE at 1×/3× thresholds); terminal/live semantics; Bengali status explanations |
| Table service | `src/lib/signal/fresh-service.ts` | Server-side assembly over real records (SignalEvaluation + PaperSignalOutcome/PaperCandidateOutcome joins + MarketCandle freshness + MarketLatestTick price). Bounded scan (2,000 rows, documented), deterministic ordering, derived-state filters |
| API | `src/app/api/signal/fresh/route.ts` (GET) | Fail-closed guard, strict zod query schema (`freshSignalQuerySchema`), server-side freshness, live/archive scope separation, pagination, and the pipeline-health block |
| Frontend | `src/components/terminal/FreshSignalTable.tsx` + nav (`signals` view) | The primary signals surface: pipeline-health strip, 6 filters + sort + search + pagination, 30s auto-refresh with pause/resume, details drawer with lifecycle timeline, honest empty/loading/error states, responsive desktop table + mobile cards |

## Requirement coverage (master prompt §Phase 3)

**Columns (24 required):** Signal ID ✓ · Symbol ✓ · Direction ✓ · Status ✓ · Entry/reference ✓ ·
Stop-loss ✓ · Take-profit ✓ · R:R ✓ · Timeframe ✓ · Strategy+version ✓ · Confidence/quality (SMC
confluence score only where the engine attached one — explicitly NOT a win probability) ✓ ·
Creation time ✓ · Market-data timestamp ✓ · Signal age ✓ · Expiry ✓ · Current reference price ✓ ·
Movement since creation (price + R) ✓ · Validation status (condition checklist) ✓ · Data freshness ✓ ·
Source ✓ · Reason summary ✓ · Details action ✓ · Paper-trade status ✓

**Badges (9 required):** FRESH · PENDING · VALIDATED · STALE · EXPIRED · INVALIDATED · REJECTED ·
DATA_UNAVAILABLE · ENGINE_ERROR — each shown ONLY from the server-derived persisted state, each with
a Bengali explanation. No invented states.

**Controls:** scope (live/archive) ✓ · direction ✓ · timeframe ✓ · strategy (product/baseline/
scalper/candidate/all) ✓ · status ✓ · date-range (fromUtc/toUtc API; UI date pickers deferred —
documented gap) · search by ID ✓ · sort (newest/oldest/timeframe/expiry) ✓ · pagination ✓ · manual
refresh ✓ · auto-refresh 30s ✓ · pause/resume ✓ · details drawer ✓ · lifecycle timeline ✓ ·
empty/loading/error/stale states ✓ · responsive ✓

**Freshness rules:** centralized policy ✓ · persisted event timestamps only ✓ (market-data age,
creation time, source TF, validity window, explicit expiry, data-stopped detection) · server-side
evaluation ✓ · live/archive separation ✓ (expired signals never silently removed from history)

## Verification evidence

- **Unit:** `tests/signal/freshness.test.ts` — 20 tests, 0 fail (all 11 rules, thresholds, terminal/live, fail-closed).
- **API:** `tests/signal/fresh-api.test.ts` — 20 tests, 0 fail (empty DB honest state, lifecycle
  matrix FRESH/PENDING/EXPIRED/VALIDATED/REJECTED/ENGINE_ERROR, candidate-isolation protocol §4,
  filters, pagination, sort determinism, no-secrets, fail-closed 400s).
- **Browser (gateway :81, real user path):** nav renders (desktop sidebar + mobile bottom-nav);
  live scope shows the honest empty state (169 scanned evaluations, expected-frequency context,
  top rejection reasons ×counts); archive scope lists 171 REAL evaluations as প্রত্যাখ্যাত rows;
  details drawer opens with লাইফসাইকেল টাইমলাইন / শর্ত-বাই-শর্ত ভ্যালিডেশন / লেভেল ও হিসাব /
  পেপার ট্র্যাকিং / উৎস ও কৌশল; pagination 1/7 → 2/7; mobile 390×844 no horizontal overflow;
  **zero console/page errors**. Screenshots: `audit/task45-details-drawer.png`,
  `audit/task45-mobile-fresh-table.png`, `audit/task45-desktop-archive.png`.

## Honest limitations

1. The live table is EMPTY of setups right now because no BUY/SELL_SETUP has occurred since the
   restart — this is the strategy's measured selectivity (6-month backtest ≈ 0.2–0.4 setups/day),
   NOT a defect. The table will populate the moment a real setup persists; nothing was fabricated.
2. UI date-range pickers are API-supported but not yet rendered in the controls bar (fromUtc/toUtc
   accepted server-side; `sort` by quality metric deliberately omitted — no calibrated quality
   metric exists).
3. The lifecycle timeline derives from persisted columns (evaluation + paper row) — no separate
   event-sourcing table was added (existing architecture already records every fact the timeline shows).
