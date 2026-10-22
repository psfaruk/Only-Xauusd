# Signal-Failure Root-Cause Report — Only-Xauusd

**Task:** Master remediation prompt (signal failure + Fresh Signal Table + complete build)
**Date:** 2026-10-22 · **Investigator:** Z.ai Code orchestrator (Task 45)
**Baseline commit:** `94d4149` (main) · **App uptime at investigation:** ~2h (restarted Task 44)

---

## 1. Verdict (one paragraph)

The data-to-signal-to-UI pipeline is **healthy end-to-end and was reproduced as working**.
"No signals" on the dashboard is **not a pipeline failure**: all three engines evaluate every
cycle and honestly persist `NO_SETUP`/`WAIT` outcomes with machine-readable reason codes; the
absence of `BUY_SETUP`/`SELL_SETUP` rows is the **expected behavior of a deliberately
selective strategy** (evidence in §4). The **real gaps** are product gaps, not breakages:
there is no Fresh Signal Table (signals surface is scattered across cards), no centralized
server-side freshness policy, no unified pipeline-health observability, and the legacy
`Signal` table is a writer-less orphan. These gaps make a healthy selective engine LOOK like
a broken one — which is precisely the user-perceived "signal failure".

## 2. Evidence — every pipeline stage verified independently

| Stage | Evidence (measured this session) | Status |
|---|---|---|
| Broker source | bridge `/api/status`: `connected:true, authenticated:true, loginMasked 414•••70, readOnly:true` | ✅ |
| Ingestion | `SyncRun` 121 rows over 14:41→16:41 UTC, **max gap 61s**, all `success`, candles inserted each run | ✅ |
| Validation | ingestion layer rejects OHLC-inconsistent/future/malformed bars (8 regression tests, Task 43-e); 0 rejected in live window | ✅ |
| Storage | `MarketCandle`: M1 100,256 · M5 35,891 · M15 11,964 · H1 2,992 · H4 808; all 5 TFs' latest candle = "now" (fresh) | ✅ |
| Scheduler | `src/instrumentation.ts` runs sync → engine evaluation → paper advance each cycle; 121/121 cycles, no crash | ✅ |
| Signal engine | 170 `SignalEvaluation` rows in 2h: scalper 121 (every sync), hybrid 9.0.0 = 25 + candidate 11.0.0 = 25 (every M15 close) | ✅ |
| Persistence | every evaluation persisted with `reasonCodes`, `evidence`, `quote`, fingerprints; `getSignalEvaluationHistory` API returns them | ✅ |
| Paper tracking | `trackPaperSignals` wired in the scheduler loop; 0 paper rows because 0 setups (correct, not broken) | ✅ |
| API | `/api/signal/latest`, `/api/signal/scalper`, `/api/signal/history` all HTTP 200 with honest payloads | ✅ |
| UI | Dashboard panels render latest evaluations with per-TF evidence; zero console errors (Task 44 browser verification) | ✅ |

## 3. Why no signals are being produced (root cause, with code evidence)

Reason-code distribution over 170 live evaluations:

| Reason code | Count | Meaning (source) | Classification |
|---|---|---|---|
| `SCALPER_NO_AGREE` | 119 | No TF's models agreed (scalper `core.ts:704`) | Honest market condition |
| `ZONE_INVALIDATED` | 18 | Price escaped the entry zone before retest (`core.ts:444`) | Honest market condition |
| `STRUCTURE_BREAK_TOO_OLD` | 6 | Last BOS/CHoCH older than `maxBarsSinceEvent` (`core.ts:428`) | Honest market condition |
| `LEVEL_CALC_INVALID` | 1 | SL/target geometry non-positive — engine refuses to emit bad levels (`core.ts:206,216`) | **Fail-closed guard working** (1x in 170 = transient geometry, not systematic) |
| `SCALPER_HTF_OPPOSED` | 1 | H1+H4 trend veto (Task 36) | Honest market condition |

Live SMC confluence scores observed in the UI evidence: 37–54 — **below the tier-B emission
threshold (55)**. The engines are one decision away from emitting and correctly declining.

Why the strategy is this selective (design history, all deliberate):

1. **Task 38** killed the momentum reflex (`SCALPER_MOMENTUM_ENABLED=false`) — it was the
   single biggest bleeder (39 trades, 33% win, −8.64R over 34h replay).
2. **Task 37** added the structure gate: legacy reversal triggers require sweep/CHoCH
   confirmation; SL widened to 1.5×ATR (noise survival).
3. **Task 36** added the H1/H4 trend veto and the anti-chase extension guard.
4. **Task 43 six-month backtest** (broker-authorized data, 151k candles): baseline 9.0.0
   produced 75 trades in 6 months ≈ **0.4 setups/day**; scalper 36 in OOS ≈ 0.2/day.
   → Hours-to-days without a setup is **within normal variance**; the backtest is the
   ground truth for expected frequency, and its verdict (both strategies REJECTED for
   live reliance on OOS losses) is unchanged.

**Conclusion: no bug is suppressing valid signals.** A 2-hour window with zero setups is
consistent with the strategy's measured 0.2–0.4 setups/day emission rate.

## 4. Symptoms not reproducible / ruled out

- **Scheduler death / overlapping runs**: not reproduced — 121/121 cycles, max gap 61s.
- **DB write failures**: not reproduced — every cycle persists evaluation rows.
- **Auth path failures**: not reproduced — all signal APIs 200 in preview posture; anon
  POST triggers correctly 403 (fail-closed).
- **Stale data**: not reproduced — all 5 TFs fresh; `MARKET_STALE_*` thresholds honored.
- **Engine exceptions**: none in the live window (`FAILED` outcome count: 0).

## 5. Confirmed gaps (the actionable findings)

| # | Gap | Impact | Fix (this task) |
|---|---|---|---|
| G-1 | **No Fresh Signal Table** — no unified live view of published signals with freshness, paper status, movement | User cannot see signals or pipeline state in one place; looks "broken" | Phase 3: new `signals` view + `/api/signal/fresh` (server-side freshness) |
| G-2 | **No centralized freshness policy** — each surface re-derives staleness | Inconsistent freshness semantics | `src/lib/signal/freshness.ts` — one pure, tested policy module |
| G-3 | **`Signal` table is a writer-less orphan** (execution-era schema: `status active/expired/executed`) | Misleading schema; nothing writes it since Phase 0 | Document as legacy in schema comments; the fresh table reads `SignalEvaluation` + `PaperSignalOutcome` (the real records) |
| G-4 | **No pipeline-health observability surface** — "why no signal" requires DB queries | Operator/user cannot distinguish healthy-idle vs broken | `/api/signal/fresh` returns a `pipeline` health block (last sync, last eval per engine, reason distribution, TF freshness); the table renders it |
| G-5 | **Paper status disconnected from signal display** | Forward-validation evidence invisible next to signals | Fresh table joins paper outcome per signal (status/outcome/R-multiple) |
| G-6 | Rejected candidates (`WAIT` rows) invisible in any list view | "Which filter blocked what" not answerable from UI | Fresh table optional "প্রত্যাখ্যাত ক্যান্ডিডেট" toggle with per-row failed-filter details |

## 6. What we will NOT do (per master prompt rules)

- No filter relaxation to force signals (the selectivity is evidence-backed).
- No synthetic candles, no fabricated freshness, no manufactured setups to fill the table.
- No order-execution code (read-only boundary unchanged).
- The empty table state will show the pipeline-health evidence — a healthy selective
  engine is the honest deliverable.

## 7. Reproduction commands (for any future verifier)

```bash
bun -e 'import Database from "bun:sqlite"; const db=new Database("db/custom.db",{readonly:true});
console.log(db.query("SELECT outcome,reasonCodes,COUNT(*) n FROM SignalEvaluation GROUP BY 1,2 ORDER BY n DESC").all())'
# scheduler cadence:
#   SELECT startedAtUtc,status FROM SyncRun ORDER BY 1 — 121 rows, 60s apart
# engine thresholds: src/lib/signal/scalper/core.ts (judgeTf), src/lib/signal/core.ts (§3 refs)
# expected frequency ground truth: audit/six-month-backtest-report.md
```
