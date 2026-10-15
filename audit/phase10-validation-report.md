# Phase 10 — Strategy Validation Report

- **Code version:** `a36f53a` (harness + tests + dashboard; audit pre-commit `14e2e5f`; starting point `1a93575` = `origin/main`, verified)
- **Run timestamp:** 2026-10-15T13:43:11Z (Dhaka 19:43)
- **Harness:** `10.0.0` · **Strategy:** `hybrid-structure-retest/9.0.0` (unchanged — NO parameter was modified this phase)
- **Data:** verified broker candles ONLY (`source=bridge-mt5`, `validationStatus=VALID`, `isForming=false`, re-validated at read time). ZERO synthetic data in any result below (synthetic fixtures exist only inside clearly-labeled unit tests).
- **Statuses used:** PASS / FAIL / BLOCKED / NOT TESTED / INCONCLUSIVE

---

## 1. What was built (deliverables)

| Deliverable | Status |
|---|---|
| `audit/phase10-backtest-integrity.md` (audit BEFORE any change) | PASS — committed first (`14e2e5f`), 21 findings, 7 gaps (G1–G7) and 3 cost limitations (L1–L3) identified, pre-registered interpretation rules fixed before any result existed |
| Three-way dev/val/OOS split + walk-forward harness | PASS — `src/lib/backtest/validation.ts`; equivalence with the Phase 9 simulator pinned by test |
| Configurable, documented cost model | PASS — `src/lib/backtest/cost-model.ts`; gross vs costs vs net separated; commission configurable (default 0 = assumption); monetary P/L **BLOCKED** (unverified specs) |
| Paper-signal forward tracking | PASS — `src/lib/signal/paper.ts` + `PaperSignalOutcome` model; duplicate-proof (unique key + immutable resolved rows); engine expiry + zone-invalidation enforced |
| Dashboard validation view | PASS — ভ্যালিডেশন tab, INCONCLUSIVE amber styling (never green for positive P/L), browser-verified desktop + mobile |
| Tests | PASS — 285/285 (+42 new), lint clean, tsc clean (app + bridge) |
| Actual backtest outputs from verified data | PASS — §2–§4 below (every run persisted with fingerprint + rules + config) |
| Known limitations & evidence gaps | §8 |

## 2. Signal-engine validation — PRIMARY result (M15 execution, H1/H4 context)

**Every fact recorded per spec:** code `a36f53a` · dataset fingerprint `b2661d3d4b28e9190600fb899bcec60fa63e9350289e5e16114e10780ca32dda` · date range 2026-09-15 19:15 UTC → 2026-10-15 13:00 UTC (30 days) · M15=2000 / H1=999 / H4=999 candles · split dev 50% / val 20% / OOS 30% · costs: spread 0.24 (CURRENT tick observation — **not historical**, per-candle spread is not stored), slippage 0.02/side (assumption), commission 0 (assumption), full round trip = 0.28 price units/trade · P/L unit = price units; R-multiples based on risk from actual entry. Monetary P/L **BLOCKED** (tickValue/contract size unverified).

**Counters:** 2000 evaluations · 219 blocked (warm-up) · 1214 NO_SETUP · 519 WAIT · 1026 candidate setups · 48 valid setups · 15 hypothetical fills · 15 completed outcomes.

| Segment | Trades | Win rate | Gross | Costs | Net | PF | Expectancy/trade | Avg R | Max DD | Max consec. losses | Exposure | Trades/week | Top-1 profit share |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Development (1000 bars) | 6 | 33.3% | −59.58 | 1.68 | **−61.26** | 0.57 | −10.21 | −0.005 | 117.71 | 3 | 33.2% | 2.83 | 60.7% |
| Validation (400 bars) | 5 | 0.0% | −106.94 | 1.40 | **−108.34** | 0.00 | −21.67 | −1.007 | 108.34 | 5 | 19.5% | 5.50 | n/a (0 wins) |
| Out-of-sample (600 bars) | **INSUFFICIENT_DATA** — 4 trades (< 5 floor); metrics NOT invented | | | | | | | | | | | | |

**Walk-forward (sequential 300-bar OOS windows, post-warm-up):** w0 2 trades · w1 1 · w2 3 · w3 4 · w4 3 · w5 1 — every window INSUFFICIENT_DATA (floor 5). **Aggregate: 14 trades, net −229.62, PF 0.26.** No window is net-positive.

**Cost sensitivity (same trade list, re-accounted):**

| Scenario | Spread | Slippage/side | Commission | Net | PF |
|---|---|---|---|---|---|
| baseline | 0.24 | 0.02 | 0 | **−254.02** | 0.24 |
| stressed | 0.40 | 0.04 | 0 | −257.02 | 0.24 |
| high_stress | 0.60 | 0.06 | 0.05 | −261.37 | 0.23 |

Costs are NOT the problem: gross P/L is −262.13 before any costs — the losses are structural (stops hit), not cost-driven.

**Parameter perturbation SET (13 rows, nothing selected, production config unchanged):** every single perturbation is net-negative — rewardRisk 1.8/2.2 → −262.14/−245.91 · maxBarsSinceBreak 6/10 → −254.02/−254.02 · zoneWidthAtr 0.4/0.6 → −198.76/−241.64 · slAtrBuffer 0.4/0.6 → −247.45/−250.52 · minAdx 12/18 → −254.02/−228.83 · entryToleranceAtr 0.2/0.3 → −240.06/−254.02. The negative result is NOT an artifact of one specific setting.

**Pre-registered interpretation:** **INCONCLUSIVE** — OOS has 4 completed trades, below the pre-registered floor of 20. The measurable evidence (dev, val, all 6 walk-forward windows, all 3 cost scenarios, all 12 perturbations) is consistently NEGATIVE, but the formal verdict stays INCONCLUSIVE because the rules were fixed before the run and the OOS sample cannot support a definitive negative verdict either.

## 3. Phase 8 structure-proxy per timeframe — SECONDARY reference (documented hypothesis, NOT the production engine)

| TF | Candles | Fingerprint | dev trades / PF / net | OOS trades / PF / net |
|---|---|---|---|---|
| M15 | 2000 | `198b838d61d794cf…` | 18 / 0.63 / −150.12 | 7 / 1.13 / +12.05 |
| H1 | 999 | `a0f21182a5405d70…` | 10 / 0.70 / −201.62 | INSUFFICIENT_DATA (3) |
| H4 | 999 | `45b96a69757ec14c…` | 5 / 1.86 / +428.21 | 5 / 2.10 / +262.57 |

The H4 positive cells rest on **5 trades each** — far below any interpretability floor; they are reported for completeness and are explicitly **NOT a profitability claim**. M15/H1 dev periods are negative.

## 4. Paper-signal forward tracking — pipeline PASS, evidence EMPTY (honest)

- Pipeline: verified by 17 tests (stopped/targeted/invalidated/expired/unresolved classification, SL-first collision, duplicate prevention via unique key + immutable resolved rows, expiry enforcement, R-multiple accounting, NO_SETUP never tracked).
- Live state: **0 setups tracked** — the only persisted evaluations so far are 2 NO_SETUP rows (engine currently reports NO_SETUP [STRUCTURE_BREAK_TOO_OLD]). Nothing to fabricate: total=0, open=0.
- Forward cadence: tracking advances automatically after every successful 5-minute scheduled sync and every signal run. Evidence will accumulate as real setups occur.

## 5. Verification executed

- `bun test`: **285/285 pass** (243 pre-existing + 42 new; exit 0)
- `bun run lint`: clean · `tsc --noEmit` (app + bridge): 0 errors
- `bun run build`: **NOT RUN** (sandbox rule — recorded, not claimed)
- Browser E2E (agent-browser): desktop 1280×800 + mobile 390×844 — ভ্যালিডেশন tab renders all sections (interpretation badge, 3 segment cards, 7 honest INSUFFICIENT_DATA blocks, walk-forward, sensitivity, 13-row perturbation set, paper tracking empty state, warnings, limitations); **0 console/page errors**; no horizontal overflow at 390px; footer intact. Screenshots: `audit/phase10-validation-{desktop,mobile}.png`.
- Four execution locks: **untouched and PASS** (phase gate < 11, EXECUTION_ARMED=false, ALLOW_EXECUTION=false, mode=read_only; runtime check security.execution-lock PASS; bridge GET-only; no order/trade/position code or endpoint added anywhere).

## 6. Requirement checklist (spec §1–§10)

| Spec | Verdict |
|---|---|
| §1 Audit before implementation | PASS (committed before any change) |
| §2 Look-ahead / leakage prevention | PASS (re-derived + regression tests: no-look-ahead mutation, HTF alignment, forming-candle gates, chronological exits, SL-first collision, strict splits, no fabricated gap fills) |
| §3 Realistic cost model | PASS with L1–L3 limitations (spread = current observation labeled; commission = assumption; monetary P/L BLOCKED) |
| §4 Walk-forward + OOS per timeframe | PASS mechanics; results INSUFFICIENT_DATA / INCONCLUSIVE (30 days of M15 history is too short — honestly reported) |
| §5 Metrics | PASS (full set incl. expectancy, avg win/loss, exposure, frequency, regimes, concentration; units documented) |
| §6 Robustness & sensitivity | PASS executed; conclusion INCONCLUSIVE (all measurable cells negative) |
| §7 Forward paper tracking | PASS pipeline; 0 outcomes yet (honest empty) |
| §8 Dashboard validation view | PASS (browser-verified; INCONCLUSIVE amber, never green for P/L) |
| §9 Tests & safety | PASS (285/285; no execution code; four locks intact) |
| §10 Deliverables & status honesty | PASS (this report; every result carries version/fingerprint/config/range/costs/metrics/sample) |

## 7. Decision after Phase 10 (pre-agreed framework, applied)

1. **পর্যাপ্ত প্রমাণ + স্থিতিশীল ফল?** NO — OOS 4 trades (< 20 floor) → the "continue longer forward paper testing" branch is NOT unlocked by positive evidence.
2. **নেতিবাচক ফল?** The measurable evidence IS negative (dev −61.26, val −108.34, walk-forward aggregate −229.62, all scenarios and perturbations negative). Per the framework: the next step is **investigation of the signal rules and risk assumptions** (why: 48 valid setups → only 15 fills, 33%/0% win rates, average R negative, gross losses dominate costs). NO parameter was tuned to hide losses, and none will be.
3. **অপর্যাপ্ত OOS data?** YES — formal verdict **INCONCLUSIVE**. Action: keep collecting history (M15 depth grows ~96 bars/day; H4 is broker-bounded at ~2000 bars) and let the paper tracker accumulate real forward outcomes.
4. **Data/backtest integrity failure?** NO — integrity audit passed; the harness is leakage-resistant and equivalence-pinned.
5. **Phase 11 (demo order execution)?** **NOT RECOMMENDED NOW** — agreed with the user's guidance: do not proceed to Phase 11 before evidence-based results exist. Current evidence does not justify execution of any kind.

## 8. Known limitations and unresolved evidence gaps

1. **History depth** — 30 days of M15 (2000 bars) cannot produce a 20-trade OOS sample at this signal frequency (~0.75 fills/day). Verdict will remain INCONCLUSIVE until months of history or forward paper outcomes accumulate.
2. **Spread is a current observation, not historical** (bridge does not store per-candle spread) — labeled everywhere; stress scenarios bound the risk. Historical spread capture would require a bridge/data change (candidate for a future phase).
3. **Slippage (0.02/side) and commission (0) are assumptions**, not verified fill studies — labeled in every result.
4. **Monetary P/L and position sizing BLOCKED** — SymbolSpec has only `digits=3` verified; tickValue/contractSize/volume constraints unknown → results stay in price units + R-multiples.
5. **H4 depth is broker-bounded** (~2000 bars ≈ back to 2025-07-16; app stores 1000 per request cap) — long-horizon statistics remain limited.
6. **Walk-forward is window-stability, not optimization walk-forward** — the strategy has no data-fitted parameters; this is documented in every run's `walkForward.note`.
7. **Entry collision ambiguity** — when one candle touches both SL and target, the LOSS is assumed (pessimistic bias, documented; 0 such trades occurred in the live run).
8. **Paper-signal entry reference differs from backtest next-bar-open** — the paper pipeline tracks the engine's published entryReference (live parity); documented in `paper.ts`.

## 9. Security advisories (user-directed)

- **Rotate the MT5 password** — it transited the chat when the user provisioned credentials (demo account). The password is stored ONLY in `.env` (gitignored, never printed/logged/committed) but should still be rotated at the user's convenience.
- **Sandbox rebuilds wipe `.env`** — prefer the platform's persistent secret settings for credentials when available; if a rebuild happens, re-provision credentials and re-run the Phase 9.2 recovery chain, then re-run this validation.

— end of report —
