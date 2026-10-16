# Phase 11-A / 11-B — NO_SETUP Root-Cause & Correctness Audit

- **Date:** 2026-10-16 (UTC)
- **Repo:** `psfaruk/Xauusd-agent` · branch `main`
- **Audited code HEAD:** `1c74156` (parent `16db957` — the Phase 10.3-D implementation commit; `1c74156` is a platform docs-only commit of the Phase 10.3-E deliverables, no code)
- **Baseline strategy audited:** `hybrid-structure-retest/9.0.0` (`src/lib/signal/rules.ts`, `src/lib/signal/core.ts`)
- **Mode:** audit-first, no strategy/threshold/protocol change in this document's scope

---

## 0. Preflight — verified baseline

| Check | Expected | Actual | Result |
|---|---|---|---|
| Branch | `main` | `main` | PASS |
| HEAD | `16db957` (+10.3-E docs commit) | `1c74156`, parent `16db957`; `git show --stat` = 6 audit PNGs + 10.3-E report + worklog, **no code** | PASS (documented deviation) |
| Working tree | clean | clean | PASS |
| Protocol fingerprint vs `8d94a00` | byte-identical | 0 diff lines: `paper-protocol.ts`, `core.ts`, `rules.ts`, `types.ts`, `src/lib/config.ts`; `forward.ts` 0 vs `7da47ee` | PASS |
| Execution locks | 4/4 locked | no `TRADING_*`/`EXECUTION_*` env keys → defaults; live `/api/health`: `executionLocked: true`, `tradingMode: read_only` | PASS |
| Bridge | read-only | GET-only (405/401 fail-closed live probes pass), MT5 **disconnected** (env rebuild) | PASS (code) / ENV-DOWN (runtime) |
| Runtime DB | — | **empty** (0 evaluations, 0 candles, 0 specs) — sandbox rebuilt 2026-10-16 04:55 UTC; runtime DB is gitignored-by-design and was lost (Phase 10.3-E ENV-1) | RECORDED |
| Scheduler | — | **OFF** (`MARKET_SYNC_INTERVAL_MS`/`MT5_BRIDGE_URL` absent from regenerated `.env`) | RECORDED |
| Tests (baseline) | 444/444 | re-run in Phase 11 final verification (§ of `phase11-baseline-vs-candidate.md`) | deferred |

**Environment classification (per mandate: never a strategy failure):** since the sandbox rebuild there is **no live data at all** — zero evaluations can occur. The current "no signals" state is **INFRASTRUCTURE** (bridge disconnected + scheduler off), classified `environment`, and is excluded from every strategy conclusion below. Restoration requires user env action (Phase 10.3-E §9.1); no credential is handled in chat.

**Data available for this audit:** the runtime DB is empty, so row-level live inventories are impossible. The evidence base is: (a) the **code** (every condition, every reason code, source-referenced), (b) **frozen real-data evidence** committed in `audit/phase10.1-signal-failure-investigation.md` (30 days of verified Exness candles, 1,999 engine evaluations, exact reconciled funnel), (c) **frozen live evidence** committed in `audit/phase10.2-signal-spec-audit.md` + Phase 10.3 reports (41 live evaluations, 2026-10-15). Every number below cites its source; nothing is invented.

---

## 1. The eligibility chain (code inventory)

`evaluateSignal` (`src/lib/signal/core.ts:248-565`) — for a BUY_SETUP/SELL_SETUP, ALL of the following must hold on the same decision bar. Each row: condition → source line → failure code → failure class.

| # | Condition | Source (core.ts) | Failure code | Class |
|---|---|---|---|---|
| G0 | Verified symbol spec digits | 271-273 | `SPEC_MISSING` | BLOCKED/data |
| G1 | Finite positive reference price; finite spread | 276-281 | `DATA_INVALID` / `SPREAD_INVALID` | BLOCKED/data |
| G2 | M15 ≥ 220 closed bars; H1 ≥ 220; H4 ≥ 200; ascending; OHLC-consistent | 283-290 (`gateWindow` 103-118) | `INSUFFICIENT_DATA` / `INSUFFICIENT_H1_HISTORY` / `INSUFFICIENT_H4_HISTORY` / `CHRONOLOGY_BROKEN` / `DATA_INVALID` / `DATA_MISSING` | BLOCKED/data |
| G3 | Decision bar fully closed (`close ≤ now`) | 292-299 | `FORMING_CANDLE_IN_INPUT` | BLOCKED/data |
| G4 | Source not demo/synthetic | 301-305 | `SOURCE_DEMO` / `SOURCE_NOT_BROKER` | BLOCKED/data |
| G5 | EMA/RSI/ATR/ADX computable at decision bar | 326-339 | `INDICATOR_WARMUP` | BLOCKED/data |
| S1 | A confirmed close-basis BOS/CHoCH exists, break bar ≤ decision bar | 404-414 | `NO_STRUCTURE_BREAK` | NO_SETUP |
| S2 | Break within last 8 M15 bars (`maxBarsSinceBreak`) | 415-429 | `STRUCTURE_BREAK_TOO_OLD` | NO_SETUP |
| S3 | No close back through the broken level since the break | 434-445 | `ZONE_INVALIDATED` | NO_SETUP |
| S3b | Decision close strictly beyond the level | 446-448 | `AT_ZONE_BOUNDARY` | WAIT |
| S4 | Retest: a bar after the break touched the ATR-scaled entry zone (zone = level +0.5×ATR for BUY; touch = `low ≤ zoneHigh`) | 450-468 | `RETEST_PENDING` | WAIT |
| S5 | Spread ≤ 0.6 price units | 470-473 | `SPREAD_TOO_WIDE` | WAIT |
| S6 | H1 trend not opposite; H4 trend not opposite (swing-structure labels; `unclear` allowed) | 475-483 | `HTF_H1_OPPOSITE` / `HTF_H4_OPPOSITE` | WAIT |
| S7 | M15 close on the EMA50 trend side | 486-489 | `EMA_TREND_OPPOSITE` | WAIT |
| S8 | RSI(14) in band (BUY 40–75, SELL mirrored 25–60) | 490-495 | `RSI_OUT_OF_RANGE` | WAIT |
| S9 | ADX(14) ≥ 15 | 496-498 | `ADX_BELOW_MIN` | WAIT |
| S10 | Live reference price within entry zone ± 0.25×ATR | 500-507 | `PRICE_BEYOND_ENTRY_ZONE` | WAIT |
| S11 | A confirmed anchor swing of the correct kind exists | 510-521 | `NO_ANCHOR_SWING` | NO_SETUP |
| S12 | Level math valid (SL < zone < entry < target ordering, risk > 0) | 533-546 | `LEVEL_CALC_INVALID` | NO_SETUP |

Service-level gates BEFORE the core (`src/lib/signal/service.ts`): symbol allowlist (154, `SYMBOL_NOT_ALLOWED`), live quote integrity (160-176; `QUOTE_UNAVAILABLE`, `QUOTE_STALE`, `NOT_AUTHENTICATED`, `TICK_INVALID`, `SOURCE_NOT_BROKER`, …), verified spec (179-183), readiness incl. tick/per-TF staleness (186-213; `TICK_STALE`, `DATA_STALE`, …), demo rows / suspicious gaps (217-222; `SOURCE_DEMO`, `GAP_IN_WINDOW`). All BLOCKED class = data-quality, **never** strategy failures.

Swing/structure semantics (shared with the Phase 4 analysis engine, `src/lib/analysis/swings.ts`, `structure.ts`): swings confirm at the close of `index+right` (3/3); BOS/CHoCH confirm on **close** through the active swing level (wick-only = unconfirmed crossing, `structure.ts:147-185`); a broken level is consumed and can never re-fire (`activeHigh/activeLow = null`). Higher-timeframe trends are computed causally as-of the decision close (`causalTrendAt`, `core.ts:131-173` — bars not closed by the decision instant are filtered, line 142).

---

## 2. Reason-code inventory — historical evidence

### 2.1 Frozen REAL-DATA evidence: 30 days, 1,999 evaluations (committed, `audit/phase10.1-signal-failure-investigation.md` §2.1)

Dataset: 2026-09-15 → 2026-10-15, verified Exness `bridge-mt5` candles (M15 2000 / H1 999 / H4 999), the SAME `evaluateSignal` core. Funnel reconciles exactly (pinned by a regression test):

| Outcome | Count | % of 1,999 | Reason breakdown (count, %) |
|---|---|---|---|
| BLOCKED | 219 | 11.0% | window < `minExecutionBars` 220 — deterministic warm-up (all data-class) |
| NO_SETUP | 1,216 | 60.8% | `STRUCTURE_BREAK_TOO_OLD` **757 (37.9%)** · `ZONE_INVALIDATED` **459 (23.0%)** |
| WAIT | 516 | 25.8% | `RETEST_PENDING` **232 (11.6%)** · `HTF_H4_OPPOSITE` 94 (4.7%) · `PRICE_BEYOND_ENTRY_ZONE` 77 (3.9%) · `HTF_H1_OPPOSITE` 64 (3.2%) · `EMA_TREND_OPPOSITE` 25 (1.3%) · `RSI_OUT_OF_RANGE` 19 (1.0%) · `ADX_BELOW_MIN` 5 (0.3%) |
| **VALID setups** | **48** | **2.4%** | BUY 15 · SELL 33 |

Episode view: 48 valid bars group into **22 distinct setup episodes** (median 2 valid bars each) → 15 filled (one-position-at-a-time suppressed 7 episodes whole-life; fill mechanism missed **zero** eligible flat-market setups) → 15 completed outcomes: **13 stop-loss, 2 target** (gross −249.82, costs 4.20, net −254.02; walk-forward aggregate 14 trades, net −229.62, PF 0.26 — every window negative).

**Cadence derived from real data: one setup episode per ≈1.4 trading days; the retest-stage trio (`TOO_OLD` + `ZONE_INVALIDATED` + `RETEST_PENDING`) accounts for 1,448 of 1,999 bars = 72.4%.**

### 2.2 Frozen LIVE evidence: 2026-10-15, ≈4.5 h of live observation (committed, Phase 10.2/10.3 reports)

- 41 evaluations total, **0 SETUP outcomes ever, 0 paper outcomes ever** (10.3-D final counts strip: evaluations 41 / distinct setups 1 / paper rows 0).
- At the 10.2 audit checkpoint (10 rows): **2 BLOCKED** (`TICK_STALE` — DB-readiness layer while the bridge quote was LIVE; honest dual-layer disagreement), **6 NO_SETUP**, **2 WAIT**.
- The ONE logical opportunity: a bearish **BOS @ 4144.821, break candle 16:00Z**, evaluated 14+ times across decision candles 16:00/16:15/16:30/16:45 (10.2 report F3, 10.3-A cluster analysis). Early evaluations: **WAIT `RETEST_PENDING`** (correct — price never pulled back into the zone); after 8 bars: **NO_SETUP `STRUCTURE_BREAK_TOO_OLD`** (correct — the retest window closed; phase 10 report live-confirmed this exact transition).
- Per-row inventory (evaluation IDs, per-row timestamps): **no longer reconstructable** — the runtime DB was lost in the sandbox rebuild (gitignored by design; Phase 10.3-E DATA-1). The committed reports preserve the aggregate counts, the cluster structure, and representative rows cited above. Nothing in this audit depends on the lost rows.

### 2.3 Evaluations vs unique setups (mandated verification)

41 live evaluations ≠ 41 opportunities. Evidence: one BOS cluster produced 14+ evaluation rows (scheduler re-evaluates every 300 s while the same decision candle stands; 10.2 report: decision 16:00 evaluated 16:23+16:26, decision 16:15 ×3, 16:30 ×2…). Distinct setups = **1**; distinct SETUP outcomes = **0**. In the real-data backtest, 1,999 evaluations ↔ 22 episodes. **Every conclusion in this audit is episode-based, not evaluation-based.**

### 2.4 Current-environment inventory (post-rebuild)

0 evaluations since 2026-10-16 04:55 UTC (scheduler off, no data). All data APIs fail closed (`MARKET_API_TOKEN_NOT_CONFIGURED`); the dashboard shows honest empty states. **Classified environment/infrastructure — not counted as strategy behavior.**

---

## 3. Top rejection reasons (ranked, real-data evidence, with implementing code)

| Rank | Reason | Count (30d) | % of all bars | Implementing code | Stage |
|---|---|---|---|---|---|
| 1 | `STRUCTURE_BREAK_TOO_OLD` — break exists, retest never came within 8 bars (2 h) | 757 | 37.9% | `core.ts:415-429` (`maxBarsSinceBreak=8`, `config.ts` SIGNAL_MAX_BARS_SINCE_BREAK) | strategy |
| 2 | `ZONE_INVALIDATED` — post-break close back through the level (break failed) | 459 | 23.0% | `core.ts:434-445` | strategy |
| 3 | `RETEST_PENDING` — break fresh, retest not yet arrived | 232 | 11.6% | `core.ts:450-468` | strategy |
| 4 | Warm-up BLOCKED (window < 220 bars) | 219 | 11.0% | `core.ts:283-290` | data (deterministic) |
| 5 | `HTF_H4_OPPOSITE` + `HTF_H1_OPPOSITE` | 94 + 64 | 7.9% | `core.ts:475-483` + `causalTrendAt` 131-173 | strategy |
| 6 | `PRICE_BEYOND_ENTRY_ZONE` — live price > 0.25×ATR from the zone | 77 | 3.9% | `core.ts:500-507` | strategy |
| 7 | `EMA_TREND_OPPOSITE` / `RSI_OUT_OF_RANGE` / `ADX_BELOW_MIN` | 25/19/5 | 2.5% | `core.ts:486-498` | strategy |
| 8 | `SPREAD_TOO_WIDE` | 0 | 0% | `core.ts:470-473` | strategy |

---

## 4. Phase 11-B — correctness audit (the ten hypotheses)

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| 1 | Genuine lack of valid market structure | **NO (not the general case)** | Real data: 1,023 of 1,999 bars (51%) had a fresh-enough break; structure detection is not the bottleneck. Live 4.5 h: exactly one structure event existed — a genuine short-window scarcity, not a detection failure. |
| 2 | A strategy rule too restrictive | **YES — by design, not defect** | The conjunction S1-S12 leaves 2.4% of bars valid (48/1999) and ~1 episode / 1.4 days. Dominant rejections are the retest-window trio (72.4%). All thresholds documented + persisted (rules snapshot, 10.3-D); no threshold was ever tuned post-hoc (Phase 10 pre-registration). |
| 3 | Incorrect swing or structure detection | **NO** | Phase 4 semantics: activation-pointer confirmation, close-basis breaks, consumed levels (`structure.ts:103-199`); 25 engine tests + analysis structure tests pin behavior; Phase 10.1 equivalence audit reproduced the exact funnel from independent code; funnel sums reconcile to the bar. |
| 4 | Retest logic requiring an unrealistic exact price | **NO** | Retest = touch of an ATR-scaled zone: BUY zone = `[level, level + 0.5×ATR]`, touch = `low ≤ zoneHigh` (`core.ts:451-461`); plus live-price tolerance 0.25×ATR (S10). No exact-price equality anywhere in the chain. |
| 5 | Incorrect candle timestamp or closed-bar semantics | **NO** | Forming-candle guard (`core.ts:292-299`); decision close = open+900 enforced ≤ now; HTF windows contain only bars closed before the decision close (`htfWindowClosedBy`, `signal-engine.ts:139`; `causalTrendAt` filter `core.ts:142`); paper-walk chronology invariant setup-chronology/1 (10.3-B, 28 tests). |
| 6 | Stale or missing market data | **NO — and correctly classified** | Staleness produces BLOCKED (data), never NO_SETUP: 2 live `TICK_STALE` BLOCKED rows prove the fail-closed split; the current bridge outage produces zero evaluations (fail-closed), not fake NO_SETUP. |
| 7 | A spread/volatility filter | **NO (marginal)** | `SPREAD_TOO_WIDE` never fired in 30 days (0.24 vs 0.6 limit); ADX floor blocked 5 bars (0.3%); RSI 19; EMA 25. Combined ≤ 2.5%. Not the bottleneck. |
| 8 | Timeframe synchronization issue | **NO** | HTF trends are computed as-of the decision close from bars closed by then (causal filter, `core.ts:142`); no cross-TF future leakage (backtest mutation test pins it). |
| 9 | A duplicate setup correctly suppressed | **NO hidden signals** | Suppression exists only at the paper layer (one row per setup, 10.3-A) — 0 SETUPs ever existed to suppress. All 41 evaluations are persisted, none dropped; the 14× cluster is repeated evaluation of ONE opportunity (§2.3). |
| 10 | Dashboard/persistence defect hiding an existing signal | **NO** | Phase 10.2 spec-audit field matrix + 10.3-D observability verification: every outcome/reason/evidence persisted append-only and rendered; counts strip separates evaluations/setups/paper. The dashboard showed exactly what the engine produced. |

**No implementation defect was found. No fix is required.** (The one historical display-level nuance — 15-decimal derived levels — was already presentation-fixed in 10.3-C; the F1 finding of the 10.2 audit.)

---

## 5. Root-cause statement

1. **Primary (live):** the live observation window (~4.5 h) was far shorter than the strategy's real cadence (~1 setup episode per 1.4 trading days). Expected episodes in 4.5 h ≈ 0.13. Zero setups is the statistically expected outcome, not a malfunction. The single opportunity that did exist was handled **correctly**: WAIT `RETEST_PENDING` while the retest was possible, then NO_SETUP `STRUCTURE_BREAK_TOO_OLD` when the 8-bar window closed.
2. **Secondary (current, environment):** since the sandbox rebuild there is no data at all (bridge disconnected, scheduler off) — the user currently receives no signals because nothing can be evaluated. Infrastructure, not strategy.
3. **Tertiary (design):** the strategy is a **single-model, strict-conjunction design** (BOS/CHoCH + retest-within-2h + HTF + triple indicator + proximity gates). It is intentionally selective — and its historical filled outcomes were **structurally negative** (13 stop / 2 target, PF 0.26, gross-dominated losses; Phase 10.1: implementation-correct, edge-negative). So "more signals" alone is NOT the goal; **additional independently-confirmed entry models with unchanged risk discipline** is the evidence-supported direction.

## 6. Candidate justification (gate for Phase 11-C)

The audit demonstrates the strategy is **too restrictive/incomplete for the availability objective** (one model; 72% of bars rejected at the retest stage; no pullback-continuation model; no range model) **without any implementation defect** (11-B: all ten hypotheses cleared). Per the Phase 11 mandate this justifies a **separately versioned candidate** — never a silent change to 9.0.0:

- **Model A** = the baseline 9.0.0 logic, imported unchanged (controlled comparison: candidate Model A emissions must equal baseline emissions on identical data).
- **Model B** = H4+H1-aligned trend-continuation pullback with M5 closed-candle confirmation.
- **Model C** = range sweep-and-rejection with confirmed reclaim and M5 confirmation.
- Precedence A > B > C, conflict → WAIT, per-model setup identity, full risk/confirmation gates per model. No baseline filter is weakened; Models B/C carry their own complete confirmation chains (spec: `audit/phase11-candidate-strategy-spec.md`).

## 7. Limitations

- Row-level live inventory (evaluation IDs per row) is impossible post-rebuild (runtime DB lost; §2.2). Aggregates and cluster structure are preserved in committed reports and cited.
- No live forward evidence can exist in the current environment (disconnected). The candidate's comparison (11-D) therefore runs on a **clearly-labeled synthetic frozen dataset** for *behavioral/mechanical* comparison only — no performance claim is possible or made. Real-data historical comparison is a documented activation pre-condition (11-E protocol).

---

## 8. Phase 11 final verdict

**CANDIDATE READY FOR FORWARD PAPER TESTING** — with explicit, documented limitations:

1. **Ready means:** the candidate (`hybrid-multimodel-research/11.0.0-candidate.1`) is implemented, deterministic, offline-only, and mechanically proven (55 new tests; harness equivalence and Model-A equality pinned byte-level); the separate preregistered protocol (`audit/phase11-candidate-forward-protocol.md`) defines every activation gate; baseline 9.0.0 is untouched and byte-stable (golden pin).
2. **NOT ready to activate yet — three protocol pre-conditions remain:** (a) environment restored (bridge + scheduler), (b) the real-data historical comparison (≥ 60 days of verified broker candles — IMPOSSIBLE in the current environment: no real candles exist post-rebuild), (c) explicit user authorization.
3. **NO live forward validation has started** and none is claimed. No performance claim exists anywhere in Phase 11 (the synthetic comparison is mechanics-only).
4. Root cause status: **documented with evidence, NO implementation defect** — the zero-SETUP experience was (i) a statistically expected short-window outcome (~1 episode per 1.4 days vs a 4.5-hour live window), (ii) a strict single-model design (documented, intentional, historically lossy), and (iii) since the sandbox rebuild, a total infrastructure outage (bridge disconnected — never a strategy failure).
