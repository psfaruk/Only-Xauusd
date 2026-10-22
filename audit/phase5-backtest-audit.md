# Phase 5 Audit — Backtest Engine & Statistical Honesty (Task 42-S3)

Scope: master prompt "PHASE 5 — BACKTEST ENGINE AND STATISTICAL HONESTY" (tasks 1–8 + acceptance tests), mapped to file:line evidence; the NEW honesty machinery added by 42-S3 (`sampleAdequacy`, bootstrap CI, fill-discipline tests); the remaining gaps stated plainly.

---

## 1) Existing backtest surfaces — versions, data, costs, splits (never merged)

There are FOUR backtest surfaces in this codebase. Each is a SEPARATE, versioned snapshot; **they are never merged or averaged with each other** — every result carries its own strategy version string and dataset fingerprint:

| Surface | Strategy/version string | Where defined | Data | Costs | Split |
|---|---|---|---|---|---|
| Phase 8 structure-proxy | `8.0.0-structure-proxy` | `src/lib/backtest/engine.ts:46` | verified broker candles only (`src/lib/backtest/service.ts:41-52` — `isForming:false`, `validationStatus:'VALID'`, `source:'bridge-mt5'`, re-validated at read time) | entry next-bar open ± (half-spread + slippage) `engine.ts:272-275`; SL-first collision `engine.ts:256-264` and same-bar entry-bar exit `engine.ts:300-312` | chronological dev/OOS `devSplitFraction 0.7` (`engine.ts:62,79,219`) |
| Phase 9 signal-engine validation | `<SIGNAL_STRATEGY_VERSION>-validation` (`signal-engine.ts:43`) | `src/lib/backtest/signal-engine.ts` | same verified-candles loader over M15+H1+H4 (`service.ts:197-217`) | `DEFAULT_SIGNAL_BACKTEST_RULES` (`signal-engine.ts:57-62`): spread 0.24 (current observation, NOT historical), slippage 0.02/side (assumption) | dev/OOS `devSplitFraction 0.7` (`signal-engine.ts:52,252`) |
| Phase 10 validation harness | strategy version + `harnessVersion` per row | `src/lib/backtest/validation.ts` + `validation-service.ts` (rendered via `/api/validation/latest` in the Analysis/Validation tab) | verified M15/H1/H4 | full separation gross / round-trip costs / net via the configurable `CostModel` (`validation.ts:19-25`) | **three-way** dev 0.5 / val 0.2 / OOS 0.3 (`validation.ts:64-66,93`) + **walk-forward** sequential OOS windows (`validation.ts:85,97` — `testBars:300`, `minTradesPerWindow:5`) |
| Task 38 scalper replay | scenario names, one snapshot per scenario | `scripts/backtest-scalper.ts:456-483` — `CURRENT`, `LEGACY`, `NO-MOMENTUM`, `MOMENTUM-M15-ONLY` as **separate snapshots** (never merged; each prints its own note + rules and writes `audit/backtest-results.json:533-535`) | DB candles (VALID/WARNING), M1 close instants as decision times (`scripts/backtest-scalper.ts:229-231`) | constant 0.30 spread assumption (disclosed `:51-53,536`); next-M1-open entry ± half-spread (`:280`); SL-first on both-hit bars (`:27-29,344-350`) | whole-history replay per scenario (research comparison, not an OOS claim) |

**Cost model (all surfaces):** `src/lib/backtest/cost-model.ts` — verified fact: digits=3 only (`:8-9`); explicit assumptions labeled on every result (`:10-19`): spread 0.24 = CURRENT OBSERVATION (per-candle historical spread is NOT stored — `audit/phase10-backtest-integrity.md` §5 L1), slippage 0.02/side assumption, commission 0 assumption; monetary P/L BLOCKED (unverified tickValue/contract size) — results stay in price units + R (`:17-19`). Execution prices: BUY pays ask+slip, SELL receives bid−slip (`entryExecutionPrice :100-109`); symmetric exit convention (`exitExecutionPrice :113-122`); round trip = spread + 2×slippage + commission (`roundTripCost :125-127`). Stress scenarios (spread ×1.6 min 0.40; ×2.5 min 0.60 + commission) are sensitivity bounds, never selected (`stressCostModels :60-89`).

**Reproducibility:** every run stores a dataset fingerprint (sha256 over exact decimal text + timestamps — `engine.ts:145-156`, `signal-engine.ts:158-170`), the full rules JSON, and the limitations list; `tests/backtest/engine.test.ts` pins full-run reproducibility (identical dataset + rules → identical result JSON) and fingerprint sensitivity.

## 2) No look-ahead / same-bar fills — verified behavior (and the new tests that pin it)

Audited in `src/lib/backtest/signal-engine.ts` + `engine.ts`; **behavior confirmed conservative — no fix was needed**:

- **Fill timing:** a signal computed at candle C's close fills at the NEXT bar's open ± (half-spread + slippage) — `signal-engine.ts:347-374` (`nextBar.open + halfSpread + slippage` for long, mirrored for short; `entryIndex: i + 1`), `engine.ts:267-298`. The last bar has no entry opportunity (`signal-engine.ts:333-334`). Pinned EXACTLY by the NEW `tests/backtest/no-lookahead.test.ts` (S1/S3): `entryBarTimeUtcSec − signalBarTimeUtcSec === 900` for every trade and `entryPrice === entryBar.open ± 0.14` to 1e-9 — the fill can never come from the decision bar's own prices.
- **Intrabar SL+TP ambiguity:** SL-first, always. `signal-engine.ts:323` (`if (hitStop)` before `else if (hitTarget)`), same-bar entry-bar collision `:379`, `engine.ts:256-264,305-311`. No tick data exists anywhere in this system, so the pessimistic rule is the only honest resolution; it is documented in every limitations list (`signal-engine.ts:418`, `engine.ts:348`). Pinned by the NEW S2 tests with engineered both-touched bars (exit at the stop level, `rMultiple === −1`).
- **Spread direction:** always applied against the entry — long at ask+slip, short at bid−slip. Pinned in S1/S3 on a long dataset AND its exact price-mirror (which produces the short trades), plus the pre-existing `tests/backtest/cost-model.test.ts`.
- **Look-ahead mutation tests** (mutate every candle after a decision → earlier decisions byte-identical): pre-existing in `tests/backtest/engine.test.ts`; the same invariant at the pure-engine level is now pinned by `tests/strategy/replay-determinism.test.ts`.

## 3) NEW honesty machinery (42-S3)

- **`src/lib/backtest/sample-adequacy.ts`** — `sampleAdequacy` label computed from the trade count: `< 30 → INSUFFICIENT_EVIDENCE`, `30–99 → PRELIMINARY`, `≥ 100 → ADEQUATE` (`sampleAdequacyFromTradeCount`, thresholds `:11-14`), each with a Bengali uncertainty note (`SAMPLE_ADEQUACY_NOTES :17-22` — e.g. "নমুনা ছোট (< ৩০ ট্রেড) — ফলাফল পরিসংখ্যানগতভাবে প্রমাণ নয়"). These floors are deliberately harsher than the engines' internal `minTrades=5` (which only refuses to invent numbers — this label refuses to lend them meaning).
- **`src/lib/backtest/bootstrap.ts`** — `bootstrapR(samples, iterations=1000, seed=42)` (pure, deterministic mulberry32 PRNG): bootstrap distribution of the mean expectancy in R → median + p05/p95 (nearest-rank, documented method); non-finite inputs dropped and disclosed; empty → nulls. Pinned by `tests/backtest/bootstrap.test.ts` (determinism, frozen exact values, degenerate cases).
- **Wiring:** `/api/backtest/latest?symbol=…` now always carries `sampleAdequacy`, `tradeCount`, `uncertaintyNote`, `dataRangeUtc` and `bootstrapCi` — both when a run exists (`getLatestBacktest`, `src/lib/backtest/service.ts:172-232`, computed from the stored trade list's R-multiples) and when none exists (`emptyBacktestHonestyBlock :239-254` — a missing run is INSUFFICIENT_EVIDENCE by definition; the label never silently disappears). Pinned by `tests/backtest/latest-honesty.test.ts` (12/50/150-trade thresholds, corrupt-JSON fail-closed, empty fallback).
- Engine-level small-sample honesty (pre-existing, kept): per-segment `INSUFFICIENT_DATA` with "metrics are NOT invented" (`engine.ts:461-467`, `signal-engine.ts:447-453`).

## 4) Acceptance tests (master prompt) → status

- *Backtest reproducible from stored code/version, data fingerprint, parameters* — SATISFIED (fingerprints + full rules JSON per run; `tests/backtest/engine.test.ts` "full-run reproducibility").
- *Synthetic scenarios catch look-ahead, same-bar fill, spread omission, intrabar-order ambiguity* — SATISFIED NOW via `tests/backtest/no-lookahead.test.ts` (fill timing, both-touched bars, spread direction, exit convention) — these existed only structurally before.
- *No strategy receives "validated" from a handful of trades* — SATISFIED: `sampleAdequacy` floors (new), per-segment `minTrades`, the Phase 10 pre-registered interpretation floor (`validation.ts:688-735` — OOS `< minInterpretableTrades` ⇒ no interpretable verdict), and the candidate protocol floor (20 completed outcomes, `src/lib/signal/candidate-protocol.ts:30-31`).

## 5) Bugs found / fixed

**None in the engines.** The audited behaviors were already conservative and causal; the tests now pin them exactly. (One draft-test arithmetic error — a percentile hand-math mistake — was caught by the test run itself and fixed before commit; no production code touched.)

## 6) Gaps left open (honest)

- **Historical spread per candle is not stored** (`cost-model.ts:11-14`): the spread gate in backtests uses the observed baseline — a real wide-spread environment would produce FEWER signals than simulated (conservative direction, but an assumption). Fixing it requires the bridge to persist per-candle spread — bridge/market layer, owner 42-S2.
- **No tick data** → intrabar SL/TP ordering stays pessimistic (SL-first) everywhere; documented in every limitations list. Tick-resolution fills would need a tick store that does not exist.
- **Walk-forward** exists only in the Phase 10 validation harness (`validation.ts:85,97`, rendered via `/api/validation/latest` in the Analysis/Validation tab), not in the Phase 8/9 report surfaces; the scalper replay (`scripts/backtest-scalper.ts`) is a whole-history comparison, explicitly NOT an OOS claim.
- **OOS untouched status:** the three-way split guard exists (`validation.ts:766` rejects dev+val ≥ 0.85; `:7-14` documents "OOS NEVER optimized against; no optimizer exists anywhere"). There is no parameter optimizer in the codebase at all — nothing can tune against the final test set; but there is also no automated alarm that re-runs OOS after any strategy-version bump. The version-bump discipline (strategy changes create a new version and restart prospective evidence) is enforced socially via the version strings, not mechanically.
- **`sampleAdequacy` is computed on the LATEST run only** (`getLatestBacktest`) — the historical run table is not aggregated; a viewer must check each run's own trade count (surfaced per run as before via `dev`/`oos` metrics).

## 7) New/changed files for Phase 5

- NEW `src/lib/backtest/bootstrap.ts`, `src/lib/backtest/sample-adequacy.ts`.
- CHANGED `src/lib/backtest/service.ts` (honesty block on `LatestBacktestRun` + `emptyBacktestHonestyBlock`; additive fields only), `src/app/api/backtest/latest/route.ts` (always-on label; additive).
- NEW `tests/backtest/no-lookahead.test.ts` (6), `tests/backtest/bootstrap.test.ts` (10), `tests/backtest/sample-adequacy.test.ts` (7), `tests/backtest/latest-honesty.test.ts` (4).
