# Phase 10 — Backtest Integrity Audit (Pre-Implementation)

- **Code version audited:** `1a93575` (= `origin/main`, verified `git ls-remote` == `git rev-parse HEAD`, clean tree)
- **Audit date:** 2026-10-15 (UTC)
- **Mode:** read-only audit of existing code + live DB — NO strategy behavior was modified for this report
- **Broker session at audit time:** bridge `connected:true, authenticated:true`, source `mt5` (verified via authenticated `/health` call)
- **Statuses:** PASS / FAIL / BLOCKED / NOT TESTED / INCONCLUSIVE (no other words used for verdicts)

---

## 1. Scope and method

Inspected (read-only): `src/lib/signal/{core,rules,service,persistence,types,schemas}.ts`,
`src/lib/backtest/{engine,signal-engine,service}.ts`, `src/lib/analysis/{swings,structure,indicators,engine,persistence}.ts`,
`src/lib/market/{types,ingestion,validation,quality,integrity}.ts`, `prisma/schema.prisma`,
`src/lib/config.ts` (four-switch execution gate), `src/lib/audit/runtime-checks.ts` (execution-lock + read-only-surface checks),
`tests/backtest/engine.test.ts`, `tests/signal/engine.test.ts`, live DB `db/custom.db` (Prisma queries).

The audit deliberately does NOT assume the backtest is correct because 243/243 tests pass —
each claim below was re-derived from source, and live-DB facts were re-queried.

## 2. Candle storage and timestamp conventions — PASS (with one coverage limitation)

- `MarketCandle.candleTimeUtc` = **bar OPEN time, UTC** (bridge normalizes broker→UTC); unique key
  `(symbol, timeframe, candleTimeUtc)`; idempotent upsert (verified in Phase 9.2 live chain: re-sync produced +3/~1833 new rows, 0 duplicates).
- Prices persisted as **canonical decimal TEXT** (no float artifacts); parsed at read time.
- Analysis/backtest loaders take only `isForming:false`, `validationStatus:'VALID'`, `source:'bridge-mt5'`
  and **re-validate OHLC consistency at read time** (bad rows excluded, counted, never silently kept). PASS.
- Decision instant convention: decision bar's close = `timeUtcSec + tfSec` — used consistently by the
  signal core (Gate 3 forming-candle protection) and by the backtests. PASS.
- **Live coverage at audit time (honest counts):** M15 = 2001 bars (2026-09-15 → 2026-10-15, ~30 days),
  H1 = 1000 (2026-08-17 → 2026-10-15), H4 = 1000 (2026-03-03 → 2026-10-15), M5 = 1005 (~4 days).
  H4 is broker-depth-bounded (~2000 bars ≈ 2025-07-16, per Phase 9.2 depth probe; app stores 1000 per request cap).
  **Limitation (not a defect):** total history is SHORT — this bounds every statistical conclusion in Phase 10.
- **Gaps:** no candle is ever fabricated or forward-filled (verified in ingestion + tests). Suspicious gaps
  block LIVE evaluation (`GAP_IN_WINDOW`), but the backtest does not report gap counts inside the simulated window — GAP (documented below, §8-G3).

## 3. Signal engine (hybrid-structure-retest v9.0.0) — causality audit — PASS

- **One pure implementation** (`evaluateSignal`) shared by the live service and both backtests — strategy cannot drift between live and test. PASS.
- **No look-ahead, by construction (re-derived):**
  - execution window ends at the decision bar; `FORMING_CANDLE_IN_INPUT` gate rejects a decision close in the future;
  - swings activate only at the confirmation candle (index+right);
  - structure breaks confirm on **close** (wick crossings never count);
  - EMA/RSI/ATR/ADX are recursive past-only series evaluated at the decision bar;
  - HTF windows contain only bars whose close instant ≤ the decision close (`candles[i].timeUtcSec + tfSec <= asOf`), verified in `htfWindowAsOf` and `causalTrendAt`;
  - entry happens at the **next bar's open** after the signal bar closes.
  - Existing mutation tests pin this for both engines (mutating every candle after a decision leaves earlier trades unchanged). PASS.
- **Entry / SL / TP / invalidation logic:**
  - entry reference = live mid (live) or decision close (backtest) — documented difference, recorded in `limitations` on every run. PASS (disclosed).
  - SL = last confirmed anchor swing ± `slAtrBuffer × ATR`; target = `rewardRisk ×` actual risk; strict ordering validated (`LEVEL_CALC_INVALID` otherwise — never emits broken levels). PASS.
  - zone invalidation = any M15 close back through the broken level → NO_SETUP. PASS.
- **FAIL-CLOSED:** every data gate failure → BLOCKED with reason codes, no levels. PASS.
- **GAPS found (Phase 10 must add):**
  - **G1 — expiry is computed but never enforced:** `expiryUtc` is persisted, but nothing later checks whether an unresolved setup expired, was invalidated by later price action, hit SL, or hit target. No forward outcome tracking exists.
  - **G2 — no paper-signal outcome pipeline:** `SignalEvaluation` rows are append-only per evaluation, but no component records the SUBSEQUENT price observations / final outcome (unresolved | invalidated | stopped | targeted | expired) with modeled costs and R-multiples.
  - **G3 — duplicate setup counting is possible:** re-running the evaluation for the same decision bar appends a NEW row (append-only by design); nothing dedups by setup identity (decision candle + direction + fingerprint). For outcome tracking this MUST be deduplicated or the same setup could be counted twice.

## 4. Backtest engine and trade accounting — PASS with documented gaps

- Phase 8 proxy (`8.0.0-structure-proxy`) and the Phase 9 signal-engine validation share correct accounting semantics:
  next-bar-open entry, chronological trade sequence, one position at a time, end-of-data close marked `end_of_data` (excluded from nothing, labeled honestly). PASS.
- **Conservative collision rule:** a single candle touching both SL and target resolves to the **LOSS** (SL first) — documented, deterministic, pessimistic, and test-pinned in both engines. PASS.
- **Dev/OOS split:** single chronological 70/30 split by entry index; OOS reported separately; **no parameter optimization exists anywhere** (no tuner code, no selection loop) — the "never optimized against" property holds trivially and by test. PASS.
- **Honest emptiness:** `INSUFFICIENT_DATA` with counts when candles/trades are below minimums — no invented metrics. PASS.
- **GAPS:**
  - **G4 — only TWO segments (dev/OOS):** Phase 10 requires development / validation / untouched-OOS (three-way) plus walk-forward where history suffices. Not implemented yet.
  - **G5 — costs are embedded, not separated:** entry price includes half-spread + slippage, so reported "net" is correct but **gross-before-costs is not reported** (the proxy's `grossPnlPrice` field is actually net; mislabeled). Phase 10 must separate gross vs. costs vs. net explicitly.
  - **G6 — metric gaps:** no expectancy-per-trade in price units (avg R exists), no avg-win/avg-loss on the signal-engine metrics, no exposure (bars-in-market / time), no trade frequency, no per-regime (trend/range, volatility) breakdown, no concentration check (whether few trades produce most profit).
  - **G7 — no walk-forward / sensitivity harness:** no spread-stress grid, no chronological-window robustness, no parameter-perturbation set, no regime segmentation.

## 5. Spread, commission and slippage treatment — PARTIAL / LIMITATIONS

- Current model: fixed `spreadPrice=0.24` (full spread) + `slippagePrice=0.02` per side, charged at entry (half-spread + slip on the correct side) with the exit at the level price — i.e., round-trip cost is effectively spread + 2×slippage. Deterministic and test-pinned (cost monotonicity: wider costs can never improve net P/L). PASS as a model.
- **L1 — no HISTORICAL spread data:** verified live — `MarketCandle.spread` is NULL for **100% of rows** (all four TFs); only the latest tick carries spread (0.240, bridge-mt5). The 0.24 constant is a **current-observation assumption**, NOT verified historical spread. It must be labeled as such and stress-tested (sensitivity scenarios), never presented as historical fact.
- **L2 — commission not modeled:** Exness-MT5Trial6 charges no explicit per-lot commission on XAUUSDm as far as VERIFIED data shows; `SymbolSpec.verifiedFields = ["digits"]` only — commission terms are NOT verified. Default commission = 0 must be an explicit, documented assumption (not a claim), with a configurable field so a verified value can be plugged in later.
- **L3 — no position sizing / monetary P/L:** verified specs contain digits=3 only — NO tickValue, contract size, volumeMin/Max/Step. Monetary P/L conversion is therefore **BLOCKED** (cannot be computed from verified facts). P/L stays in PRICE units and R-multiples; any monetary display must be explicitly labeled as based on UNVERIFIED assumptions or omitted. Phase 10 will keep monetary conversion BLOCKED and document it.

## 6. Dataset fingerprints and reproducibility — PASS

- `datasetFingerprint` = sha256 over symbol|tf|count + exact decimal text + timestamps; `signalDatasetFingerprint` covers M15+H1+H4 jointly; `computeSignalFingerprint` covers the full evaluation input incl. rules + engine version.
- Identity/difference and full-run reproducibility are test-pinned (byte-identical JSON for identical inputs). PASS.
- BacktestRun rows persist fingerprint, rules, metrics, trades (bounded 500), limitations, duration — every result records code version + config. PASS.

## 7. Four execution locks — PASS (all four ENGAGED)

- Gate: `phase >= 11 AND EXECUTION_ARMED AND ALLOW_EXECUTION AND mode != 'read_only'` → `executionEnabled=false`
  (live values: phase=1 read_only mode, EXECUTION_ARMED=false, ALLOW_EXECUTION=false). Runtime check `security.execution-lock` PASS.
- Bridge client exposes ONLY the 5 GET methods (getCandles/getHealth/getQuote/getStatus/getSymbols); bridge process serves GET-only routes with `x-trader-key` auth.
- No order/trade/position code or endpoint exists anywhere (verified by grep + POST-route inventory test). Phase 10 will add NO execution code.

## 8. Consolidated findings

| # | Area | Verdict | Note |
|---|------|---------|------|
| 1 | Candle storage / timestamps / idempotency | PASS | UTC open-time convention consistent end-to-end |
| 2 | Verified-candles-only loading + read-time re-validation | PASS | forming/INVALID/demo excluded everywhere |
| 3 | No look-ahead (signal core + both backtests) | PASS | by construction + mutation tests |
| 4 | HTF alignment without future candles | PASS | close-instant filter verified |
| 5 | Next-bar-open entry | PASS | both engines |
| 6 | SL-first conservative collision rule | PASS | documented + test-pinned |
| 7 | Fail-closed data gates | PASS | BLOCKED with codes, no levels |
| 8 | Dev/OOS chronological split, no optimization | PASS | but only 2 segments (G4) |
| 9 | INSUFFICIENT_DATA honesty | PASS | nothing invented |
| 10 | Dataset fingerprint reproducibility | PASS | identity/diff/repro tests |
| 11 | Fixed spread+slippage cost model | PASS (model) | but L1/L2/L3 limitations |
| 12 | Historical spread data | NOT AVAILABLE | all candle spreads NULL — label assumption, run stress scenarios |
| 13 | Commission model | NOT VERIFIED | configurable, default 0, documented assumption |
| 14 | Position sizing / monetary P/L | BLOCKED | verified spec has digits only |
| 15 | Three-way dev/val/OOS + walk-forward | NOT IMPLEMENTED | G4/G7 — Phase 10 work item |
| 16 | Gross-vs-net cost separation | NOT IMPLEMENTED | G5 — Phase 10 work item |
| 17 | Full metric set (expectancy, exposure, regime, concentration) | NOT IMPLEMENTED | G6 — Phase 10 work item |
| 18 | Signal expiry enforcement | NOT IMPLEMENTED | G1 — Phase 10 work item |
| 19 | Paper-signal forward outcome tracking | NOT IMPLEMENTED | G2 — Phase 10 work item |
| 20 | Duplicate outcome prevention | NOT IMPLEMENTED | G3 — Phase 10 work item |
| 21 | Four execution locks | PASS | all four engaged; no execution code |

## 9. Pre-registered interpretation rules (before any result is produced)

To prevent post-hoc rationalization, these minimum-evidence rules are fixed BEFORE running Phase 10 validations:

1. **Minimum OOS sample:** an OOS/segment verdict is interpretable only with **≥ 20 completed trades** in that segment; 5–19 → reported but flagged thin; < 5 → INSUFFICIENT_DATA (engine-enforced).
2. **Profitability claim requires:** OOS ≥ 20 trades AND OOS net P/L > 0 after modeled costs AND profit factor stable (OOS PF within ~⅓ of dev PF, both computed) AND not driven by concentration (top trade ≤ 35% of gross profit) AND robust to the spread-stress scenario (net still > 0 at stressed costs). Anything less → **INCONCLUSIVE**.
3. **No parameter tuning:** Phase 10 changes NO strategy parameters. Sensitivity runs are reported as a SET (all cells shown), never with a "best" selection.
4. **Collision ambiguity stays conservative:** SL-first assumption remains; its bias direction (pessimistic for P/L) is documented.
5. **Spread assumption is current-observation, not historical** — every table using 0.24 must carry the limitation label; the stressed scenario bounds the risk.

## 10. Verdict

- **Backtest integrity foundation: PASS** — the existing engines are leakage-resistant by construction and test-pinned; the Phase 8→9 honesty chain is intact.
- **Validation completeness: NOT IMPLEMENTED** — Phase 10 must add the three-way split + walk-forward harness, gross/net cost separation with configurable commission, the full metric set, sensitivity/robustness runs, and the paper-signal outcome pipeline with duplicate prevention and expiry enforcement (findings G1–G7, L1–L3).
- No strategy parameter will be changed in Phase 10. No execution code will be added.

— end of audit —
