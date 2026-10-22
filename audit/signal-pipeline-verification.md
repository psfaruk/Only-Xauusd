# Market-Data Health + Signal-Pipeline Verification (Task 45)

**Date:** 2026-10-22 · **Symbol:** XAUUSDm · **Provider:** Exness MT5 (Trial server `Exness-MT5Trial6`, login `414•••70` — read-only bridge :3031)

## 1. Market-data provider — identified and measurable

- Bridge `/api/status` (x-trader-key auth): `connected:true, authenticated:true, readOnly:true`,
  gateway 47.130.41.116, 355 symbols, watchlist XAUUSDm.
- App health surface: `/api/health` 200; freshness block LIVE on all five timeframes; the Fresh
  Signal Table's pipeline strip shows per-TF state + age + the engines' last-eval age + tick price
  (all from persisted records).

## 2. Data freshness & coverage (measured at verification time)

| TF | Closed bars | Latest closed | State |
|---|---|---|---|
| M1 | 100,256+ | current minute | FRESH |
| M5 | 35,891+ | current | FRESH |
| M15 | 11,964+ | current | FRESH |
| H1 | 2,992+ | current | FRESH |
| H4 | 808+ | current | FRESH |

- Scheduler: 121 SyncRuns over the first 2h, **max gap 61s**, 100% success (no missed cycle).
- Six-month broker-authorized dataset imported (Task 44): M15/M5/H1/H4 full 6 months; M1 serves
  only ~100 days from the broker (74,802 pre-history slots honestly reported — never fabricated).
- Ingestion validation: OHLC-consistency, chronology, future-time, forming-bar, duplicate and
  divergence checks (8 regression tests); 0 rejected in the live window.

## 3. Signal pipeline — stage-by-stage execution evidence

Source → Bridge → Validation → Storage → Engine → Persistence → API → Fresh Table:

1. **Sync (every 60s):** SyncRun rows prove each cycle; candles inserted per run.
2. **Engine evaluation:** 170+ SignalEvaluation rows in the live window — scalper every sync,
   hybrid 9.0.0 + candidate 11.0.0 every M15 close. Every cycle records outcome + reasonCodes +
   evidence + quote + fingerprints (the decision trace).
3. **Why no setups (the investigated question):** live reason distribution — SCALPER_NO_AGREE ×138,
   ZONE_INVALIDATED ×36, PULLBACK_CONTEXT_NOT_ALIGNED ×29, RANGE_NOT_DETECTED ×29,
   STRUCTURE_BREAK_TOO_OLD ×12, RETEST_PENDING ×6, SCALPER_HTF_OPPOSED ×1 — honest market
   conditions under deliberately selective filters (Task 36–38 hardening; six-month backtest
   frequency 0.2–0.4 setups/day is the ground truth). No engine exception in the window
   (FAILED count 0). Full analysis: `audit/signal-failure-root-cause.md`.
4. **Paper tracking:** wired in the scheduler (trackPaperSignals + candidate tracker); 0 paper rows
   because 0 setups — correct, not broken; the moment a setup persists, its paper row is created
   (unique setupFingerprint — duplicate publication impossible) and advanced each cycle.
5. **API:** `/api/signal/fresh` (new) + latest/history/scalper all 200; anon POST triggers 403.
6. **UI:** Fresh Signal Table renders the live pipeline state and the full archive (171 rows).

## 4. Failure-scenario test coverage added this task

- Data unavailable → DATA_UNAVAILABLE status (unit + API tests; empty-DB honest state)
- Data stale → STALE (thresholds pinned exactly, 1×/3× boundaries)
- Engine exception → ENGINE_ERROR (FAILED row surfaces through the API)
- Valid candidate → FRESH/PENDING rows with levels/paper/lifecycle (seeded matrix)
- All candidates rejected → REJECTED rows in archive with reasonCodes
- Expiry → EXPIRED (incl. expiry-dominates-stale priority pin)
- Invalidated → INVALIDATED; stopped → REJECTED (paper ledger mapping)
- Duplicate processing → prevented upstream by unique setupFingerprint (existing invariant tests);
  the fresh table joins 1:1 by evaluation id
- Authorization error → 400/403 fail-closed paths (6 validation tests)
- Out-of-order responses → dropped client-side (monotonic request sequence in the component)

## 5. Read-only + security verification (re-verified this task)

- `tradingMode = 'read_only' as const` (src/lib/config.ts) — hard constant, no env override.
- Bridge: GET-only data routes; order endpoints 405/404 (verified Task 43-c, unchanged since).
- No order/trade/execution route exists under src/app/api (grep verified).
- Fresh API response payload scanned for secrets in tests — none (no token/password/key strings).
- secret-scan: PASS (this task's files add no secrets; .env remains git-ignored).
- Anon trigger protection re-verified: POST /api/signal/run off-origin → 403 AUTH_INVALID_TOKEN.
