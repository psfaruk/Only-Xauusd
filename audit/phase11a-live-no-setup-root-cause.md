# Phase 11-A — LIVE NO_SETUP ROOT-CAUSE AUDIT

- **Date:** 2026-10-16 (UTC) — audit-only, no code/lock/protocol change, no commit, no push
- **Repo:** `psfaruk/Xauusd-agent` · branch `main`
- **Audited HEAD:** `24ca3ab` (the Task-25 live-restore ops commit; working tree clean during the audit except this report)
- **Baseline strategy:** `hybrid-structure-retest/9.0.0` (frozen; byte-identical to `8d94a00` — re-verified below)
- **Mode:** verify actual runtime state before conclusions; report facts, not the reported facts

---

## 1. Safety and preflight — ALL PASS, one environment event recorded

| Check | Expected | Actual (verified this audit) | Result |
|---|---|---|---|
| Git HEAD / branch | `24ca3ab` on `main` | `24ca3ab`, parent `698bc19`; tree clean | PASS |
| Origin sync | `0 0` (synced) | `git rev-list --left-right --count origin/main...HEAD` → `0 0` (Task-25 push completed the sync) | PASS |
| `.env` gitignored, untracked | yes | `git check-ignore .env` → ignored; `git ls-files .env` → not tracked; keys-only inspection (values never printed) | PASS |
| Credentials in output | none | No credential, token, password, or auth-header value printed or persisted anywhere in this audit | PASS |
| Four execution locks | all LOCKED | No `TRADING_*`/`EXECUTION_*` keys in `.env` → fail-closed defaults (`config.ts:50-60`: phase=1, mode=`read_only`, `EXECUTION_ARMED=false`, `ALLOW_EXECUTION=false`); live `/api/health` → `executionLocked: true`, `tradingMode: read_only`, reason `Execution locked: Phase 1 is read-only by design (Phase 11 gate required)` | PASS |
| MT5 bridge read-only | GET-only | Live probes: `POST /health` → **405**, `POST /api/candles` → **405**, `GET /api/candles` without token → **401**, response header `x-bridge-readonly: 1` | PASS |
| Single evaluation loop | one | `src/instrumentation.ts:112-113`: one `setTimeout` + one `setInterval` in `register()` (Next.js runs `register()` exactly once per server process); `runSync` refuses concurrent runs (`SYNC_IN_PROGRESS` overlap guard); signal evaluation fires only inside the successful-sync branch, fire-and-forget, error-isolated | PASS |
| No order-execution endpoints | none | `rg` scan over `src/` + `mini-services/` for order/trade/position submission patterns → 0 hits (the single `paper-protocol.ts` match is the documented "no order will ever be sent" prose); `tradeApproval.create`/`executionLog.create` → 0 hits; no `app.post` routes beyond the token-guarded data/analysis/signal/verify triggers | PASS |
| Protocol files frozen | byte-identical | `git diff 8d94a00 -- src/lib/signal/{paper-protocol,core,rules,types}.ts src/lib/config.ts` → 0 lines; `git diff 7da47ee -- src/lib/signal/forward.ts` → 0 lines | PASS |
| No strategy/schema/threshold change | none | Working tree clean at start; nothing modified by this audit (one throwaway read-only DB script created and deleted) | PASS |
| No push / no commit | none | No commit created; no push attempted | PASS |

**No safety invariant failed. The audit proceeded.**

### 1.1 CRITICAL environment event discovered: a THIRD sandbox rebuild (~2026-10-16 11:51 UTC)

The user's reported current state (bridge restored, live quotes, 5-minute scheduler, latest NO_SETUP, 499/499, commits pushed) **was true when Task 25 completed (~07:20–08:00 UTC)** but **no longer describes the runtime**:

| Runtime fact (verified 12:00–12:35 UTC) | Evidence |
|---|---|
| Dev server + bridge processes restarted at **11:51 UTC** | `ps` start times; fresh `dev.log` boot |
| `.env` regenerated to `DATABASE_URL` only | keys-only listing (all MT5/bridge/token keys gone) |
| Bridge :3031 UP but **MT5 disconnected** | `GET /health` → `{"connected":false,"authenticated":false,"source":"disconnected"}` |
| Runtime DB **wiped again** (all tables 0 rows) | Prisma counts: evaluations 0, candles 0, ticks 0, syncRuns 0, events 0 (post-audit: 1 SystemEvent = the GLM verify I clicked during the UI audit — disclosed in §7) |
| Scheduler **OFF** | `[instrumentation] market sync scheduler: OFF (default)` condition (no `MARKET_SYNC_INTERVAL_MS`/`MT5_BRIDGE_URL`); 0 `[scheduler]` lines in dev.log |
| All data APIs fail-closed **503** `MARKET_API_TOKEN_NOT_CONFIGURED` | dev.log + direct API probes |
| Dashboard honest-empty | browser-verified in the companion UI audit (`audit/ui-lock-root-cause.md`) |

**Classification: INFRASTRUCTURE / environment — never a strategy failure** (standing mandate). The Task-25 live window's row-level history was lost with the DB (gitignored-by-design, "re-syncable"); the *committed* evidence (screenshots in `24ca3ab`, worklog, prior frozen reports) survives and is the evidence base below. Nothing was fabricated to fill the gap.

---

## 2. One coherent live snapshot — two timestamps, both labeled

### 2.1 CURRENT snapshot (degraded): 2026-10-16T12:00:14Z

| Field | Value | Source |
|---|---|---|
| Broker connection | **disconnected** (`connected:false, authenticated:false, source:"disconnected"`, uptime 498s) | bridge `/health` |
| Symbol metadata / verified digits | **NOT AVAILABLE** (SymbolSpec table empty post-rebuild; last verified value digits=3, from the frozen Task-25 evidence) | DB + commit `24ca3ab` |
| Bid/ask/spread/quote freshness | **NOT AVAILABLE** (no valid tick stored; `MarketLatestTick` empty) | DB |
| Latest closed candles M5/M15/H1/H4 | **NOT AVAILABLE** (0 candles) | DB |
| Latest evaluation | **NONE** (0 rows) | DB |
| Rules snapshot | **NONE persisted** (0 rows; schema + code intact — `rules-snapshot.ts` verified unchanged) | DB |
| Scheduler run state | **OFF**; last known successful scheduled sync **2026-10-16 07:20:37 UTC** (Task-25 worklog + committed screenshots) | dev.log / worklog |

### 2.2 LAST COHERENT LIVE snapshot (the evidence for the reported NO_SETUP): Task-25 window, decision candle 2026-10-16T06:00Z, displayed 12:30 Dhaka (≈06:30 UTC)

Recovered from the **committed** screenshots (`audit/phase11-live-restore-signal.png`, `-market.png` — pushed in `24ca3ab`) via vision extraction, cross-checked against engine code:

| Field | Value |
|---|---|
| Broker | Exness-MT5Trial6, authenticated, source `mt5`, 355 symbols, latency 38–39 ms, login masked |
| Symbol | XAUUSDm, **verified digits 3** |
| Quote (signal tab context) | bid 4185.561 / ask 4185.801 / **spread 0.240** (≤ maxSpreadPrice 0.6 → S5 PASS) |
| Candle depth (sync 07:20:37 UTC) | M5 499 · M15 405 · H1 499 · H4 490 closed bars (H4 from 2026-06-28); sync `success +1897 new, 0 rejected, 0 duplicates` |
| Indicators at decision bar | EMA50 4166.34 · RSI(14) 63.4 · ATR(14) 6.84 · ADX(14) 24.3 (all computable → G5 PASS, warm-up complete) |
| HTF context | H1 **flat/neutral** (allowed) · H4 **bullish** (allowed for the bearish setup? — see §3: gate not reached) |
| Latest evaluation | `NO_SETUP` · reason `STRUCTURE_BREAK_TOO_OLD` |
| Structure break (the decision input) | BOS, break candle open **2026-10-16T03:45:00Z** |
| Strategy version | `hybrid-structure-retest/9.0.0` (baseline; candidate v11 line displayed as offline-research only) |
| Fingerprints | setup `a94bfb68…`, dataset `5b7c7a39…` (short forms as displayed; full values lost with the DB) |
| Data-quality notes | `GAP_MARKET_LIKELY_CLOSED` entries at 13:10 Dhaka (session-aware approximate gap scan — honest observability, not a strategy input) |

Both snapshots are internally coherent; neither fabricates a missing value.

---

## 3. Gate-by-gate decision trace of the reported NO_SETUP

Code path: scheduler tick (post-sync) → `runSignalEvaluation` (`src/lib/signal/service.ts`) → `evaluateSignal` (`src/lib/signal/core.ts:248+`). Trace of the last traceable evaluation (decision candle 06:00Z, break candle 03:45Z):

| # | Gate (stable ID) | Source | Input (observed) | Expected | Actual | Class |
|---|---|---|---|---|---|---|
| G0 | Verified spec digits | `service.ts:179-183` | digits 3 (verified, live) | spec present | **PASS** | — |
| G1 | Quote integrity | `service.ts:160-176` | spread 0.240, live tick | finite, fresh, broker-sourced | **PASS** (LIVE badge, age 0 s) | — |
| G2 | Window shape/warm-up | `core.ts:283-290` (`gateWindow` 103-118) | M15 405 · H1 499 · H4 490 closed bars | ≥220/≥220/≥200, ascending, OHLC-valid | **PASS** (deepest window ever observed live) | — |
| G3 | Decision bar fully closed | `core.ts:292-299` | decision open 06:00Z, close 06:15Z ≤ now 06:30Z | close ≤ now | **PASS** | — |
| G4 | Source is broker | `core.ts:301-305` | `bridge-mt5` | not demo/synthetic | **PASS** | — |
| G5 | Indicators computable | `core.ts:326-339` | EMA/RSI/ATR/ADX all finite at decision bar | computable | **PASS** | — |
| S1 | Confirmed BOS/CHoCH exists ≤ decision bar | `core.ts:404-414` | BOS @ 4179.783 zone context, break candle 03:45Z (close-basis, confirmed) | event exists | **PASS** (event found) | — |
| **S2** | **Break within `maxBarsSinceBreak` = 8 M15 bars** | `core.ts:415-429`; constant `config.ts:157` (env-default 8, clamp 2–20; no env override present) | break 03:45Z → decision 06:00Z = **9 bars** | `barsSinceBreak ≤ 8` | **FAIL → `NO_SETUP [STRUCTURE_BREAK_TOO_OLD]`** | **Genuine strategy rejection** |
| S3/S3b | Zone invalidation / boundary | `core.ts:434-448` | not reached | — | **not evaluated** (funnel-honest `—` in the UI condition card) | — |
| S4 | Retest into ATR-scaled zone | `core.ts:450-468` | not reached | — | **not evaluated** | — |
| S5 | Spread ≤ 0.6 | `core.ts:470-473` | 0.240 (would pass) | — | **not evaluated** | — |
| S6–S10 | HTF/EMA/RSI/ADX/price-zone | `core.ts:475-507` | H1 flat, H4 bullish, RSI 63.4, ADX 24.3 (several would pass) | — | **not evaluated** | — |
| S11/S12 | Anchor swing / level math | `core.ts:510-546` | not reached | — | **not evaluated** | — |

**Primary (and only) rejection reason: S2 — the structure break aged past the 8-bar retest window before a valid retest+confirmation sequence completed.** No secondary reason codes present. The dashboard's শর্ত-বাই-শর্ত card rendered exactly this: three ✓ (digits, market-open, chronology), one ✗ (recent structure break, detail: break candle 2026-10-16T03:45:00.000Z), seven `—` (downstream, honestly null).

**Category classification (mandated list): category 4/5 boundary — M15 structure EXISTS but is STALE (break older than the retest window) → engine emits `NO_SETUP [STRUCTURE_BREAK_TOO_OLD]`.** It is *not* any of: data unavailable (categories 1–2: all data gates passed), HTF conflict (6: not reached), BOS/CHoCH absent (5: break existed), retest/confirmation failure (6–7: not reached — the window closed first), spread/volatility (8), duplicate suppression (9), or internal error (11).

---

## 4. Rejection bottleneck quantification

### 4.1 Coverage limitation (honest)

The 24-hour window cannot be row-quantified: the runtime DB was wiped **twice** since the evaluations ran (rebuild #2 at 04:55 UTC — documented in Phase 10.3-E; rebuild #3 at ~11:51 UTC — this audit). Per mandate, no prior result is fabricated; a **new observation window begins at env restoration** (currently 0 evaluations — scheduler off). The restored live window (≈07:20–11:51 UTC, ≈4.5 h) is qualitatively evidenced by committed artifacts: ≥1 successful scheduled sync (+1,897 candles), autonomous evaluations running (worklog Task 25: "autonomous signal evaluation resumed (honest NO_SETUP)"), the event log in the screenshots (`SIGNAL_NO_SETUP … fp=a94bfb68…`, `MARKET_SYNC_SUCCESS`, `GLM_VERIFY_OK`), and the last traceable evaluation traced in §3. Exact NO_SETUP/WAIT/blocked counts for that window: **not recoverable — stated, not guessed.**

### 4.2 Frozen REAL-DATA funnel (30 days, 1,999 evaluations — committed `phase10.1-signal-failure-investigation.md`, same `evaluateSignal` core, test-pinned)

| Outcome | Count | % | Leading reasons |
|---|---|---|---|
| BLOCKED (data/warm-up) | 219 | 11.0% | window < 220 bars (deterministic warm-up) |
| NO_SETUP | 1,216 | 60.8% | **STRUCTURE_BREAK_TOO_OLD 757 (37.9%)** · ZONE_INVALIDATED 459 (23.0%) |
| WAIT | 516 | 25.8% | RETEST_PENDING 232 (11.6%) · HTF_H4_OPPOSITE 94 · PRICE_BEYOND_ENTRY_ZONE 77 · HTF_H1_OPPOSITE 64 · EMA_TREND_OPPOSITE 25 · RSI_OUT_OF_RANGE 19 · ADX_BELOW_MIN 5 |
| VALID setups | 48 | 2.4% | BUY 15 · SELL 33 |

Episode funnel: 48 valid bars → **22 distinct setup episodes** (~1 episode / 1.4 trading days) → 15 filled → 13 stop / 2 target (net −254.02; walk-forward PF 0.26). Retest-stage trio (TOO_OLD + ZONE_INVALIDATED + RETEST_PENDING) = 1,448 / 1,999 bars = **72.4%**.

### 4.3 Frozen LIVE windows (committed)

- 2026-10-15 (Phase 10.2/10.3): 41 evaluations ↔ **1 distinct setup** (bearish BOS cluster: WAIT `RETEST_PENDING` ×14+ re-evaluations → NO_SETUP `TOO_OLD` after the window closed — the same transition now seen live). 0 SETUP outcomes, 0 paper rows.
- 2026-10-16 Task-25 window (§3): the reported NO_SETUP is the **same, correct** end-of-window rejection.

### 4.4 Evaluations ≠ opportunities (mandated)

41 evaluations ↔ 1 setup (10.2); 1,999 evaluations ↔ 22 episodes (30-day real data); the 5-minute scheduler re-evaluates the same standing decision candle repeatedly. **All conclusions above are episode-based.**

### 4.5 Scheduler overlap / skipped runs

Architecture: one interval, `SYNC_IN_PROGRESS` refusal, DB-state-only tracker (code-verified §1). In the restored window: 0 overlap indications in surviving logs; post-rebuild #3: scheduler simply OFF (not skipping — disabled by missing env). Duplicate-suppression count: 0 observable (dedup by setup-identity `730259ec…` was live-proven in 10.3-D; current DB empty).

---

## 5. Timeframe and chronology correctness — verified, unchanged

| Requirement | Verification |
|---|---|
| H4/H1 context from fully closed candles only | `causalTrendAt` (`core.ts:131-173`) filters `c.timeUtcSec + tfSec <= asOfUtcSec` before swing detection — future/forming bars cannot leak; service window query forces `isForming: false` (`src/lib/market/service.ts:222`) |
| M15 setup uses a correctly timestamped closed candle | G3 (`core.ts:292-299`) rejects `decisionCloseSec > nowUtcSec` with `FORMING_CANDLE_IN_INPUT` — the forming bar can never be the decision bar |
| M5 confirmation never uses future/forming candles | baseline 9.0.0 has no M5 confirmation stage (single-model M15 design; the M5 stage exists only in the OFFLINE candidate v11 — not wired into live evaluation) |
| Consistent UTC interpretation | all candle times are `candleTimeUtc` ISO-Z; engine math in epoch seconds UTC; display converts to Dhaka label only |
| Close/availability semantics = Phase 10.3-B | `paper.ts` byte-identical to `6419ebd` (verified in 10.3-E; unchanged since) |
| Signal creation/expiry chronology contract | `setup-identity.ts` 0-diff vs `8173751`; `forward.ts` 0-diff vs `7da47ee` (re-verified this audit §1) |
| Repeated scheduler runs never mint new identities for the same setup | setup-identity dedup live-proven in 10.3-D (fingerprint `730259ec7b3616e6` stable across code change); UI shows "মূল্যায়ন-সংখ্যা ≠ স্বতন্ত্র সেটআপ-সংখ্যা" |

**Chronology implementation untouched by this audit (mandate). No defect found in the decision path.**

---

## 6. Test-suite status — 496/499 with a PROVEN test-infrastructure (not production) defect

Full suite re-run this audit: **496 pass / 3 fail** (85,105 expects; the reported "499/499" was true at Task-25 time). The three failures are deterministic and were root-caused by controlled experiment:

| Failing test | File |
|---|---|
| `targeted outcome recorded once; duplicate processing cannot count it twice` | `tests/signal/paper.test.ts:213` |
| `T8 open row re-advanced at the same clock → idempotent observations` | `tests/signal/paper-chronology.test.ts:509` |
| `T10 first-open aggregation … repeats never counted twice` | `tests/signal/paper-chronology.test.ts:568` |

**Root cause (proven, not inferred):** the shared isolated test DB (`db/test-market.db`, rebuilt once per process by `tests/market/helpers/setup.ts`) is polluted across files. `tests/market/quality.test.ts` cleans tables in `beforeEach` but has **no `afterAll` cleanup** — its last test's ~50 synthetic M15 candles (seeded near `FIXED_NOW_SEC`) persist. The third sandbox rebuild changed Bun's file-enumeration order (verified: current order is readdir/inode order, not alphabetical), so `quality.test.ts` now runs BEFORE the paper tests; the leaked bars fall inside T8/T10's walk windows and break observation counts. Empirical proof: `bun test tests/signal/paper.test.ts` alone → **17/17 pass**; `paper-chronology.test.ts` alone → **28/28 pass**; `quality.test.ts` + `paper-chronology.test.ts` together → the exact 2 T-failures reproduce; `paper.test.ts`'s row-count failure reproduces from forward-paper/chronology leftovers. Production code is untouched (tree clean; protocol byte-identical) — **this is a test-hermeticity defect, not a strategy or engine defect.** No fix applied (audit-only); smallest fix documented in §8.

---

## 7. What this audit touched (transparency)

Read-only: git, `.env` (keys only), DB counts, bridge/HTTP probes, dev.log, source files, committed screenshots (vision-extraction). One throwaway read-only Prisma script (`scripts/tmp-audit-db.ts`) created and **deleted**. The UI-audit browser session clicked the GLM verify button once → 1 append-only `SystemEvent` (`GLM_VERIFY_OK`, 28,394 ms) now in the otherwise-empty DB — an ordinary user interaction, disclosed here. No code, schema, config, lock, or protocol change; no commit; no push.

---

## 8. Verdict and the smallest evidence-based next action

### Verdict

> ## NO VALID SETUP IN OBSERVED WINDOW
>
> The reported `NO_SETUP [STRUCTURE_BREAK_TOO_OLD]` is a **genuine, correctly-computed strategy rejection** — a confirmed BOS aged 9 M15 bars (> `maxBarsSinceBreak` = 8) before any retest+confirmation completed, with every data-quality gate (spec, quote, windows, chronology, indicators, source) passing. This exact rejection is the top rejection class in 30 days of verified real data (37.9% of all bars) and the expected behavior of the frozen single-model design (~1 setup episode / 1.4 trading days; the restored live window ≈ 4.5 h ≈ 0.13 expected episodes). No code defect exists in the decision path (§3, §5). The CURRENT total absence of evaluations is **infrastructure** (third sandbox rebuild ~11:51 UTC: bridge disconnected, DB wiped, scheduler off) — classified environment, excluded from strategy conclusions. Separately root-caused: a **test-hermeticity defect** (§6, test-infrastructure only, proven not to touch production).

Not selected: CODE DEFECT (none in decision path; the test defect does not affect live behavior), STRATEGY DESIGN (the design is behaving exactly as frozen and documented — its strictness is a known, separately-candidate-addressed property, not a malfunction), INCONCLUSIVE (the traceable evaluation + frozen funnel are sufficient for the verdict), SAFETY/DATA-INTEGRITY FAIL (all §1 checks pass).

### Smallest evidence-based next actions (in order)

1. **Restore the environment (user action, outside chat):** re-enter the MT5 session keys + bridge token + `MARKET_API_PUBLIC_READS`/`MARKET_SYNC_INTERVAL_MS`/`FORWARD_PAPER_TRACKING` into the gitignored `.env` via the platform mechanism (the audited Task-25 posture), then relaunch via `.zscripts/relaunch-bridge.py` + `relaunch-dev.py`. **Rotate the previously-shared MT5 password and GitHub PAT** (they transited chat once; the standing security policy treats them as exposed until rotated). This restarts the observation window — zero fabricated history.
2. **Fix the test-hermeticity defect (next code phase, not now):** add `afterAll` table cleanup to `tests/market/quality.test.ts` (mirror of `ingestion.test.ts`'s `beforeEach` deletes) and per-test row isolation in the paper DB tests — restoring order-independence and the 499/499 gate.
3. **No strategy/threshold/lock change is warranted by this evidence.** The candidate v11 forward path remains gated on its pre-registered activation pre-conditions (env restored + ≥60-day real-data comparison + user authorization) — unchanged.

---

### Source references (primary)

- `src/lib/signal/core.ts` — gates G2/G3 (283-305), S1/S2 (404-429), S3/S3b (434-448), `causalTrendAt` (131-173)
- `src/lib/signal/service.ts` — pre-core gates (quote/spec/readiness, 154-222)
- `src/lib/config.ts:50-60,157` — four-switch lock, `maxBarsSinceBreak` default 8
- `src/instrumentation.ts:21-114` — single scheduler loop, overlap guard, fail-closed OFF default
- `tests/market/helpers/setup.ts` — isolated shared test DB (once-per-process)
- `tests/market/quality.test.ts:71-75` — `beforeEach`-only cleanup (the leak)
- Frozen evidence: `audit/phase10.1-signal-failure-investigation.md` (30-day funnel), `audit/phase10.2-signal-spec-audit.md`, `audit/phase11a-no-setup-root-cause.md` (prior offline audit), commit `24ca3ab` (live-restore screenshots + worklog)
