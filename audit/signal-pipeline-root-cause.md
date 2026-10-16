# PHASE 13 — Signal-Pipeline Root-Cause Report (48-Hour No-Signal Investigation)

**Audit window:** 2026-10-14T14:19Z → 2026-10-16T14:19Z (the reported ~48 h), extended to the live moment of audit (2026-10-16T14:34Z).
**Method:** read-only DB queries (`scripts/phase13-pipeline-audit.ts`), live API probes, bridge daemon probes, source tracing, browser E2E. No data was fabricated, modified or deleted. No credentials are printed.
**All timestamps UTC** (DB stores UTC; the dashboard renders Asia/Dhaka).

---

## 1. Executive finding

The report "48 ঘন্টায় একটি সিগন্যালও আসেনি" is **true and has three stacked causes**, only one of which was a code-level defect:

| # | Cause | Category | Share of the window |
|---|---|---|---|
| C1 | Sandbox rebuilds wiped the gitignored `.env` (bridge URL/token, MT5 session) and the runtime SQLite DB → scheduler had no bridge → **zero syncs, zero evaluations**, chat/reads failed closed with `MARKET_API_TOKEN_NOT_CONFIGURED` | Environment loss (dominant) | Most of the 48 h (unquantifiable — see §3) |
| C2 | After restoration, the engine ran correctly but produced only **legitimate WAIT / NO_SETUP** verdicts (mixed H1/H4 context) — a healthy strategy outcome, **not** a defect | Market condition | The retained ~83 min of live runtime |
| C3 | Manual trigger buttons (sync / analysis / signal) all returned **503 MARKET_API_TOKEN_NOT_CONFIGURED** (fail-closed guard, `DATA_API_TOKEN` unset) → the user could not force anything, and honest WAIT reasons rendered as "অজানা সমস্যা (CODE)" → **the UI read as broken** | UX/config defects (fixed in Phase 13) | Whole window |

**The engine itself is proven capable of directional signals** — unit fixtures produce `BUY_SETUP`/`SELL_SETUP` with valid levels (`tests/signal/engine.test.ts`, "bullish break + successful retest + friendly filters → BUY_SETUP"), and the full suite (540 tests) passes. No signal fired because (a) the pipeline was down for most of the window, and (b) when it was up, higher-timeframe context legitimately vetoed every setup.

---

## 2. Evidence — what is CONFIRMED (retained records + live probes)

### 2.1 Pipeline state NOW (live, at audit close 2026-10-16T14:34Z)

| Stage | Evidence | Status |
|---|---|---|
| MT5 bridge daemon | `GET :3031/health` → `connected:true, authenticated:true, server:Exness-MT5Trial6, uptime ~91 min, latency 47 ms, 355 symbols`; `loginMasked: 414•••70` | ✅ HEALTHY |
| Bridge security | data endpoints without `x-trader-key` → **401**; any POST → **405 (GET only)** | ✅ READ-ONLY |
| Quote | `/api/quote?symbol=XAUUSDm` → bid 4197.609 / ask 4197.849, spread 0.240, digits 3, tick timestamp fresh | ✅ LIVE |
| Candle sync | `SyncRun` rows: **all `success`**, exact 5-min cadence, max gap 5.0 min, **0 rejected candles**; last scheduled run 14:31:50Z (next due 14:36:50Z) | ✅ HEALTHY |
| Candle depth | M5 516 / M15 434 / H1 454 / H4 493 rows; H4 back to 2026-06-28 (backfill); forming bars current per TF; `validationStatus=VALID` | ✅ HEALTHY |
| Deterministic evaluation | `SignalEvaluation` rows every 5 min, duration 36–84 ms, `executionLocked=true` on every row | ✅ HEALTHY |
| GLM chat | `CHAT_AGENT_TURN` events; live Bengali reply grounded in the actual latest evaluation (WAIT / `HTF_H4_OPPOSITE` / CHoCH @ 4181.492) | ✅ HEALTHY |
| Execution lock | `/api/health` → `executionLocked:true`, `tradingMode:read_only`, phase 4 | ✅ LOCKED (unchanged) |

### 2.2 Classification of every retained evaluation run

The current DB holds **17 evaluations at audit start (now more)** — earliest `2026-10-16T12:56:58Z`. Classification:

| Category | Count | Reason codes |
|---|---|---|
| Valid WAIT (setup detected, gate vetoed) | 10 | `RETEST_PENDING` ×6, `HTF_H1_OPPOSITE` ×6*, `ZONE_INVALIDATED` ×3, `STRUCTURE_BREAK_TOO_OLD` ×1, `HTF_H4_OPPOSITE` ×1 (*one run can carry the code alongside others) |
| Valid NO_SETUP (no qualifying structure) | 4 | `NO_STRUCTURE_BREAK` family |
| BUY_SETUP / SELL_SETUP | **0** | — (see §4 for why this is legitimate) |
| BLOCKED (stale/insufficient data) | 0 (autonomous loop) | manual runs between syncs correctly `TICK_STALE`/`DATA_STALE` |
| FAILED (engine error) | 0 | — |
| Bridge disconnected / scheduler not running | **0 after 12:56Z**; the whole pre-12:56Z window has no records (§3) | |

**Scheduler gaps:** max interval between retained evaluations = 5.0 min (exactly the configured cadence). No missed runs, no overlaps (`runSync` refuses concurrent runs — `SYNC_IN_PROGRESS`), no double scheduler loops (single `register()` per Next.js process; restart creates a fresh single interval).

### 2.3 The latest evaluation, decoded (why WAIT is correct)

```
outcome: WAIT   reason: HTF_H4_OPPOSITE
M15 structure event: CHoCH bullish, level 4181.492, break candle 13:45Z (1 bar ago)
H1 trend: bullish · H4 trend: bearish  → mixed higher-timeframe context
indicators: EMA50 4174.45 · RSI14 59.8 · ATR14 9.02 · ADX14 17.3
decision close: 4189.17 · decision candle 14:00Z
```
The engine detected a real bullish CHoCH but the H4 context is bearish — the strategy (by design, unchanged since Phase 9) refuses to trade against the higher timeframe. This is the **correct** verdict for this market state.

---

## 3. Why the 48-hour evidence does NOT exist in the DB (and what that proves)

- Earliest retained rows: `SyncRun` 12:56:55Z, `SignalEvaluation` 12:56:58Z (both 2026-10-16). The SQLite file and the gitignored `.env` were **wiped by sandbox rebuilds** (documented across worklog Tasks 24–25 and the prior session's summary: three rebuilds; after each, MT5_*/MARKET_API_* keys were missing until manually restored).
- Therefore: **no claim can be made about evaluation outcomes for 2026-10-14 → 2026-10-16 12:56Z from the DB.** The honest statement is: *the pipeline could not have been evaluating for most of that period, because its configuration and database were absent — the chat error the user saw (`MARKET_API_TOKEN_NOT_CONFIGURED`) and the disabled controls are the exact symptoms of that wiped-`.env` state (both `DATA_API_TOKEN` and `MARKET_API_PUBLIC_READS` were missing then, so even GET reads failed closed).*
- Timeline anchors that ARE retained: worklog Task-25 record (bridge restored, first honest NO_SETUP cycles), `GLM_VERIFY_OK` SystemEvent 12:24:43Z, dev-server boot ≈12:56Z (uptime 4911 s at 14:18:40Z).

---

## 4. Was "zero BUY/SELL ever" a defect? — No (evidence)

1. **Engine capability is proven by fixtures:** `tests/signal/engine.test.ts` — *"bullish break + successful retest + friendly filters → BUY_SETUP with valid levels"* (and the mirrored SELL case, mutual-consistency and level-validation tests). 540/540 tests pass.
2. **Live gating is coherent:** every retained WAIT carries the precise veto reason (e.g., `HTF_H4_OPPOSITE` while H1 is bullish — a genuine mixed-context market). No setup was detected-then-silently-discarded: the reason codes are emitted by the same gate chain that is unit-tested stage by stage.
3. **No suppression bugs:** signal history API returns all outcomes (WAIT/NO_SETUP included — visible in the UI "সাম্প্রতিক মূল্যায়ন তালিকা"); deduplication (`setupFingerprint`) only suppresses identical repeated setups, and `PaperSignalOutcome` is empty simply because no qualifying setup has occurred since restoration (forward paper protocol activates on the first qualifying signal).
4. **Thresholds untouched:** Phase 13 changed **no** strategy, data-quality, risk or signal-qualification threshold (verified by diff — `src/lib/signal/**`, `src/lib/market/**`, `prisma/**`, `instrumentation.ts` all unchanged).

Per the task rules, a legitimate WAIT/NO_SETUP is **not** treated as an error, and no threshold was loosened to "produce more signals".

---

## 5. Defects confirmed and fixed in Phase 13

| ID | Defect (confirmed) | Root cause | Fix | Regression test |
|---|---|---|---|---|
| D1 | Manual trigger buttons (POST `/api/data/sync`, `/api/analysis/run`, `/api/signal/run`) returned 503 `MARKET_API_TOKEN_NOT_CONFIGURED` in the preview deployment → "UI partially disabled" | `guardDataApi(…,'trigger')` in `src/lib/api-guard.ts` requires `DATA_API_TOKEN` unconditionally; the preview `.env` (correctly) has no token — the flag name is the app's own guard, **not** an external API token | New **explicit** preview opt-in `MARKET_API_PUBLIC_TRIGGERS=true` (default **false** — fail-closed preserved). Only applies when `DATA_API_TOKEN` is unset; a set token always requires the bearer. Guarded operations are broker-read-only (sync/analysis/research signal; no order code exists) and the tight trigger rate-limit bucket still applies. Documented in README §Security, `.env.example`, route doc-comments | 4 new tests in `tests/market/api.test.ts` (opt-in passes guard→zod 400; opt-in runs route; token+flag→401; default→503) + 2 existing tests extended to control the flag |
| D2 | On-demand evaluation between 5-min syncs blocked with `TICK_STALE` (~60 % of the time) — honest but made the button feel dead | `MARKET_STALE_TICK_SEC=120` (fail-closed, kept) vs `MARKET_SYNC_INTERVAL_MS=300000` | UI-level **sync-first orchestration** (`syncBeforeRun` in `page.tsx`): the analysis & signal buttons now refresh data before evaluating. **No threshold changed** — if the sync fails the evaluation still reports the honest stale verdict | Covered by existing pipeline tests; E2E-verified live (manual runs persisted `mode:"manual", status:"success"` then WAIT) |
| D3 | Honest WAIT verdicts rendered as **"অজানা সমস্যা (HTF_H4_OPPOSITE)"** ("unknown problem") — healthy outcomes read as failures; key contributor to the "system is broken" perception | 30+ engine reason codes had no Bengali mapping in `bnErrorText` (`src/lib/dashboard/i18n.ts`) | Full Bengali mapping of every engine reason code with honest wording — WAIT-family codes explicitly say `(স্বাভাবিক WAIT)` ("normal WAIT") | `tests/ui/reason-code-i18n.test.ts` — scans `conditions.ts` for all codes and asserts 100 % mapping + WAIT-family wording |
| D4 | Console a11y warning: chat Sheet missing Description | Missing `SheetDescription` | Added `sr-only` Bengali description (also improves screen-reader context: read-only assistant) | Manual E2E (warning gone) |

**AnalysisRun table note:** it was empty (all-time 0) because only *manual* analysis runs write it and every manual run had been 503-blocked since the last rebuild; after D1 the button persists rows (verified: 2 rows, `status:"completed"`). The autonomous loop records in `SignalEvaluation` by design.

---

## 6. End-to-end stage trace (post-fix, live)

| Stage | Result at 2026-10-16T14:2x–14:3xZ |
|---|---|
| MT5 connection | ✅ authenticated Exness-MT5Trial6, 47 ms |
| Symbol selection | ✅ XAUUSDm (digits 3, point 0.001) via authenticated session |
| Quote/tick ingestion | ✅ bid 4197.609/ask 4197.849, spread 0.240, fresh |
| Candle sync (M5/M15/H1/H4) | ✅ 1881–1882 upserts/run, 0 rejected, 0 duplicates |
| Completeness/freshness validation | ✅ VALID for all TFs; forming bars flagged and excluded from decisions |
| H4/H1 context | ✅ H4 bearish / H1 bullish (mixed) |
| M15 setup detection | ✅ bullish CHoCH @ 4181.492 detected |
| M5 confirmation / gates | ✅ gates evaluated (retest/zone/HTF/ADX/RSI/spread) |
| Deterministic decision | ✅ WAIT + `HTF_H4_OPPOSITE` (correct) |
| Persistence | ✅ SignalEvaluation + SystemEvent rows on every run |
| API response | ✅ 200 with full evidence payload |
| Dashboard/history rendering | ✅ verified in browser E2E with Bengali reasons |

---

## 7. Honest limitations of this audit

- The 48 h window's per-run classification **cannot** be reconstructed from persisted records — they were destroyed by the environment rebuilds (not by the application). Worklog/SystemEvent anchors and the symptom triad (token error, disabled UI, empty history) are the evidence for C1.
- Live-market verification is necessarily a snapshot; the forward paper protocol will accumulate outcome statistics only after the first qualifying setup.
- `MARKET_API_TOKEN_NOT_CONFIGURED` shown *in chat* historically: the chat route uses the `read` bucket — with the wiped `.env` even reads failed closed; today chat works (grounded reply verified).
