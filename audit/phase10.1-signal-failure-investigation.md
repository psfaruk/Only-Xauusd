# Phase 10.1 — XAUUSD Signal Failure Investigation

- **Type:** DIAGNOSTIC ONLY — no strategy parameter changed, no rule changed, no OOS peeking, no fabrication.
- **Code version at start:** local `09bed28` (3 Phase 10 commits verified intact; origin/main = `1a93575`)
- **Strategy under audit:** `hybrid-structure-retest/9.0.0` — config fingerprint recorded below, **UNCHANGED**
- **Data:** verified broker candles ONLY (`source=bridge-mt5`, `validationStatus=VALID`, `isForming=false`)
- **Statuses:** PASS / FAIL / BLOCKED / NOT TESTED / INCONCLUSIVE

---

## 0. Environment recovery before the audit (mandatory context)

A **third sandbox rebuild** occurred before this phase began: `.env` was reset to `DATABASE_URL` only, `db/custom.db` was recreated empty (0 rows everywhere), and the bridge was left disconnected. The three Phase 10 commits were **intact in local git** (working tree clean).

Recovery chain re-executed (same chain as Phase 9.2 §11):

| Step | Result |
|---|---|
| MT5 credentials re-provisioned into `.env` (gitignored, values never printed/logged/committed; source = the user's own chat provision of the demo account) | PASS — password required the exact string as typed by the user, including the trailing character; first variant (without it) was rejected by the broker with `session closed` |
| Bridge restart + session | PASS — `connected:true, authenticated:true, server=Exness-MT5Trial6` (exact match), gateway 47.130.41.116, 355 symbols, `XAUUSDm` resolved, 0 reconnects |
| Fresh bridge token + `DATA_API_TOKEN` (new random values, openssl) | PASS — old values were wiped with the sandbox; app↔bridge pair-consistent |
| Idempotent sync M5/M15/H1/H4 + M15 range backfill to Sep 14 | PASS — 2nd sync run: 3,804 received / 0 inserted / 0 duplicates / 0 rejected (idempotency proven); final coverage M5 999 / M15 1999→2000 / H1 999→1000 / H4 999 (4,996→5,004 candles); 21 genuine M15 gaps (weekends + 75-min daily break) — **nothing fabricated** |
| Analysis / signal / backtest / validation rebuilt as NEW runs | PASS — analysis `completed` (fp `23c7990a…`), signal honest `NO_SETUP [STRUCTURE_BREAK_TOO_OLD]` (CHoCH 36 bars ago > 8), 3 proxy backtests, 1 persisted ValidationRun (fp `eb1d25e7…`) |
| Live tick + scheduled 5-min sync | PASS — quote freshness LIVE, ageSeconds 0, spread 0.240, digits 3 |

**GitHub push: BLOCKED** (see §7). The three Phase 10 commits and this phase's commit remain local and safe.

---

## Task 1 — Baseline and reproducibility: **PASS**

### 1.1 Git state verified

- Actual HEAD at start = `09bed28`, ahead of origin/main by exactly 3 commits (`14e2e5f` audit, `a36f53a` harness, `09bed28` report) — matching the user's description. Working tree clean. **All local commits preserved** (nothing was reset/rebased).
- Pre-push secret scan of the full `1a93575..09bed28` diff: PAT pattern `ghp_…` **0**, MT5 login **0**, password string **0**, order/trade/position submission code in added lines **0** (one doc-only sentence matched "trade sequence" — prose, not code). Four execution locks verified at runtime: `phase=1 (<11)`, `tradingMode=read_only`, `executionLocked=true`, `checks.executionLock=engaged`.

### 1.2 Production strategy config (recorded, unchanged)

`hybrid-structure-retest/9.0.0`: executionTf M15 · context H1+H4 · windowBars 300 · minExecutionBars 220 · minH1Bars 220 · minH4Bars 200 · swing 3/3 · maxBarsSinceBreak 8 · zoneWidthAtr 0.5 · entryToleranceAtr 0.25 · slAtrBuffer 0.5 · rewardRisk 2 · minAdx 15 · rsiBuy 40–75 (SELL mirrored 25–60) · maxSpreadPrice 0.6 · expiryBars 12 · EMA50/RSI14/ATR14/ADX14. Harness `10.0.0`, costs spread 0.24 (current observation, labeled) + slippage 0.02/side (assumption) + commission 0 (assumption) = 0.28 round trip.

### 1.3 Baseline reproduction (same verified dataset depth, same rules)

| Metric | Phase 10 report (`a36f53a`, fp `b2661d3d…`) | Phase 10.1 re-run (fp `eb1d25e7…`) | Match |
|---|---|---|---|
| M15 / H1 / H4 candles | 2000 / 999 / 999 | 1999 / 999 / 999 | ≈ (window rolled +1 candle, see below) |
| evaluations / blocked | 2000 / 219 | 1999 / 219 | ≈ |
| noSetup / wait / candidates | 1214 / 519 / 1026 | 1216 / 516 / 1023 | ≈ |
| **valid setups / fills / completed** | **48 / 15 / 15** | **48 / 15 / 15** | **EXACT** |
| dev trades / net / PF / expR / DD / consecL | 6 / −61.26 / 0.57 / −0.0053 / 117.71 / 3 | 6 / −61.2576 / 0.569 / −0.0053 / 117.7129 / 3 | **EXACT (4 dp)** |
| val trades / net / PF | 5 / −108.34 / 0.00 | 5 / −108.3413 / 0 | **EXACT** |
| OOS | INSUFFICIENT (4) | INSUFFICIENT (4) | **EXACT** |
| walk-forward windows | 2/1/3/4/3/1 trades; agg −229.62 / PF 0.26 | 2/1/3/4/3/1; −229.622 / 0.2604 | **EXACT** |
| sensitivity (base/stress/high) | −254.02 / −257.02 / −261.37 | −254.0242 / −257.0242 / −261.3742 | **EXACT** |
| perturbations (13 rows) | all negative | all negative, same values | **EXACT** |

**Fingerprint mismatch — explained before proceeding:** the broker serves a rolling most-recent-N window. Between the Phase 10 run (Oct 15 13:43 UTC) and this re-run, the M15 window advanced ~1.5 hours (dataset now 2026-09-15 22:00 → 2026-10-15 14:30; the oldest bar from the Phase 10 dataset is no longer servable and one newer bar exists). **The exact Phase 10 dataset bytes cannot be re-fetched from the broker** — this is a data-availability fact, not a reproducibility failure. Reproduction therefore used the same depth (all servable M15 candles ≤ 2000 cap), same loader, same rules — and every counter and every segment metric matched. The **H4 dataset is byte-identical** (fp `45b96a69…` in both runs — no new closed H4 bar in between), which independently pins determinism. A second audit re-run minutes later (one more M15 candle, fp `ac49e52a…`) again produced 48/15/15 with identical trades.

**Baseline reproduction verdict: PASS** — the Phase 10 negative results are reproducible and were not a fluke of one dataset snapshot.

### 1.4 Correction to the Phase 10 report (documentation defect D2, found during audit)

Phase 10 report §2 stated *"gross P/L is −262.13 before any costs."* That number is actually the **rewardRisk=1.8 perturbation NET** (−262.138 in the perturbation set). The true baseline figures (recomputed from the 15 trades and cross-checked against the persisted run): **gross −249.82 · costs 4.20 (15 × 0.28) · net −254.02**. The harness numbers were always correct; only the report sentence quoted the wrong cell. **Conclusion unchanged:** gross losses dominate modeled costs ≈ 60:1. No code change required; corrected here.

---

## Task 2 — Audit of every setup: **PASS (fully reconciled)**

### 2.1 The funnel (all 1,999 evaluations accounted for)

```
evaluations            1999   ─┬─ BLOCKED    219  (window < minExecutionBars 220 — deterministic warm-up)
                             ├─ NO_SETUP  1216  (STRUCTURE_BREAK_TOO_OLD 757 · ZONE_INVALIDATED 459)
                             ├─ WAIT       516  (RETEST_PENDING 232 · HTF_H4_OPPOSITE 94 ·
                             │                 PRICE_BEYOND_ENTRY_ZONE 77 · HTF_H1_OPPOSITE 64 ·
                             │                 EMA_TREND_OPPOSITE 25 · RSI_OUT_OF_RANGE 19 · ADX_BELOW_MIN 5)
                             └─ VALID       48  (BUY 15 · SELL 33)
candidates (event present, not NO_STRUCTURE_BREAK/TOO_OLD) 1023
valid setups                                                 48
entry-eligible (flat + next bar + levels)                    48  ← every valid bar WAS eligible in isolation
fills                                                        15
completed outcomes                                           15  (13 stop · 2 target · 0 end_of_data · 0 collision)
```

The outcome buckets sum exactly to evaluations (pinned by a new regression test).

### 2.2 Why 48 valid setups → only 15 fills (the "33% fill rate" is NOT a defect)

A valid setup is emitted on **every decision bar** whose conditions hold, so one market opportunity produces a *run* of consecutive valid bars. Grouping the 48 valid bars by their structure-break candle:

- **22 distinct setup episodes** (valid-bars-per-episode: min 1, median 2, max 7, total 48)
- **15 episodes filled** (first flat bar after the setup became valid)
- **7 episodes never filled** — every one of their valid bars fell inside an open trade's market window
- **All 33 skipped valid bars have skip reason `POSITION_OPEN`** — zero `LAST_BAR`, zero `NO_LEVELS`, zero `RISK_NOT_POSITIVE_GAP`

**Episode-level fill rate = 15/22 = 68%.** The one-position-at-a-time model (documented since Phase 9) suppresses same-direction re-entries and opposite entries while a trade is open; 526 of 1,999 bars (26.3%) were spent in a position. Example: the Sep 18 12:30 SELL filled and ran 20 bars; the fresh 13:45 SELL episode (different break, level 4353.525) was suppressed for its whole life by that trade. The fill mechanism itself missed **zero** eligible, flat-market setups.

### 2.3 Per-setup record (extract, full table in the run output)

Every one of the 48 valid bars was recorded with: source candle timestamp, direction, timeframe, BOS/CHoCH type + level + bars-since-break, decision-time indicators (EMA50/RSI14/ATR14/ADX14), H1/H4 trend, retest bar, entry eligibility, fill status + reason, and (if filled) the complete exit outcome. The two winners for illustration:

- `2026-09-22 04:15 SELL bsb=1 BOS lvl=4339.31 adx=16.4 rsi=37.1 atr=7.53 h1=range h4=range → FILLED → target +31.80 net, R 1.991`
- `2026-09-23 14:45 SELL bsb=5 BOS lvl=4294.52 adx=42.0 rsi=41.7 h1=bearish h4=bearish → FILLED → target +49.06 net, R 1.994`

---

## Task 3 — Entry and exit mechanics: **PASS — no implementation defect found**

Every mechanism was re-derived from code and re-verified on the live dataset; the audit simulator is an instrumented exact replica of `validation.ts simulate()` and **asserts byte-level equivalence** (counters AND every trade field) with the harness on every run — **PASS** on all runs.

| Mechanism | Verdict | Evidence |
|---|---|---|
| Candle-close vs intrabar timing | PASS | Decision at bar *i*'s close (`nowUtcSec = time+900`); entry at bar *i+1*'s open. `htfWindowClosedBy` includes only HTF bars **fully closed** by the decision close (forming HTF bar excluded). Existing mutation tests + equivalence assertion |
| Entry price & bid/ask side | PASS | MT5 OHLC are bid-based. Long = open + halfSpread + slip (pays ask); short = open − halfSpread − slip (receives bid). Exit symmetric (Phase 10 convention, cost-model.ts, test-pinned) |
| Spread & slippage | PASS (L1/L2 limits) | 0.28 round trip, labeled current-observation/assumption. Total costs 4.20 vs gross −249.82 — **1.7% of the loss** |
| SL/TP distance | PASS | SL = last confirmed anchor swing ± 0.5×ATR (entry-independent); target = 2R from the ACTUAL costed entry. Verified numerically on winners (R 1.991/1.994 ≈ 2 − costs/risk) |
| Risk/reward calc | PASS | risk = costed entry − SL > 0 gate; R = net/risk; winners' R consistent to 3 dp |
| Position sizing / monetary P/L | **BLOCKED** (documented, unchanged) | tickValue/contractSize unverified → price units + R only. No change |
| Same-candle SL/TP collision | PASS | SL-first (conservative) in both simulators + paper pipeline; **0 occurrences** in this dataset |
| Gaps / missing bars / expiry | PASS | No gap fabrication (21 genuine gaps preserved). 1 fill crossed the 75-min daily break (Sep 28) — honest next-bar-open semantics; `risk>0` guard protects against gap-through-stop (new regression test). Setup expiry (12 bars) enforced in the paper pipeline (tests) |
| Duplicate fills / double outcomes | PASS | One position at a time; all (signal, entry) pairs unique; no overlapping market windows (new regression test); paper outcomes unique-keyed |
| Indicator warm-up | PASS | 219 blocked bars = window < 220 (deterministic; EMA50/ADX warm long before) |
| HTF alignment | PASS | Single shared causal implementation exported from signal-engine.ts (no drift by construction) |
| Look-ahead / future-candle leakage | PASS | Mutation test (existing); audit equivalence; decision windows end at bar *i* |

### Defects found during Task 3 (both NON-strategy; both handled)

**D1 — Test-infrastructure hermeticity (FIXED).** Adding `DATA_API_TOKEN` to `.env` (required for the live sync/signal POST endpoints after the rebuild) leaked into the test process: `@prisma/client` **re-loads `.env` when the PrismaClient in `src/lib/db.ts` is instantiated**, and its dotenv-merge restores any key that is *absent* from `process.env` (keys already present are left alone). The test setup deleted the key → Prisma restored it from disk → 10 API tests failed with 401. Fix: `process.env.DATA_API_TOKEN = ''` in `tests/market/helpers/setup.ts` (set-to-empty, the same pattern the Phase 8 fix uses for `MT5_BRIDGE_URL/TOKEN`, with a comment documenting the Prisma behavior). Suite: 279 pass / 10 fail → **289 pass / 0 fail**.

**D2 — Phase 10 report figure (CORRECTED in §1.4).** Narrative misquote; harness data was correct; no code change.

**No defect was found in the signal rules, level derivation, entry/exit simulation, or accounting.** Per the phase rules, no rule was changed and no fix was invented.

---

## Task 4 — Losses by category (sample count ALWAYS shown; small groups labeled INSUFFICIENT_DATA)

15 completed trades: **13 stops (−334.88 net), 2 targets (+80.86 net)** → net −254.02. Every stop resolved at ≈ −1.0R (avg −1.0066R) — risk control behaves exactly as specified.

| Category | n | Win rate | Gross | Net | Avg R |
|---|---|---|---|---|---|
| BUY | 4 | 0% | −92.58 | −93.73 | −1.006 |
| SELL | 11 | 18.2% | −157.25 | −160.33 | −0.461 |
| dev / val / oos | 6 / 5 / 4 | 33% / 0% / 0% | −59.58 / −106.94 / −83.31 | −61.26 / −108.34 / −84.43 | −0.005 / −1.007 / −1.008 |
| exit = stop | 13 | 0% | −331.24 | −334.88 | −1.007 |
| exit = target | 2 | 100% | +81.42 | +80.86 | +1.993 |
| ADX weak (<20) | 7 | 14.3% | −143.20 | −145.16 | −0.578 |
| ADX moderate (20–30) | 7 | 0% | −155.96 | −157.92 | −1.007 |
| ADX strong (>30) | **1** | 100% | +49.34 | +49.06 | +1.994 — **INSUFFICIENT_DATA** |
| H4 bearish / range / bullish | 6 / 8 / **1** | 17% / 12.5% / 0% | −110.34 / −114.35 / −25.13 | — | bullish **INSUFFICIENT_DATA** |
| ATR rank low / mid / high | 5 / 4 / 6 | 20% / 0% / 17% | −31.54 / −103.26 / −115.03 | −32.94 / −104.38 / −116.71 | mixed |
| BOS age 0–2 bars | 13 | 7.7% | −273.83 | −277.47 | −0.776 |
| BOS age 3–4 bars | **1** | 0% | −25.33 | — | **INSUFFICIENT_DATA** |
| BOS age 5–8 bars | **1** | 100% | +49.34 | — | **INSUFFICIENT_DATA** |
| BOS / CHoCH | 11 / 4 | 18% / 0% | −152.16 / −97.66 | −155.24 / −98.78 | — |
| Entry crossed a gap | 1 | 0% | −28.26 | −28.54 | **INSUFFICIENT_DATA** |

### MFE/MAE and post-stop forensics (counterfactual diagnostics — NOT results)

- Average MFE: 0.82R overall; **0.60R on stopped trades**; 2.20R on winners. **7/15 trades reached ≥ +1R favorable excursion at some point** — 5 of them still ended stopped (price ran ~1.05–1.19R in favor, failed to reach the 2R target, then traversed the full stop distance).
- After each of the 13 stops, price continued **at least 0.25R further against the entry** in 13/13 cases (i.e., stops were not "just barely" clipped — the adverse move continued).
- In **7/13 stopped trades, price eventually reached the ORIGINAL 2R target level** (7–520 bars later); 6/13 never did within the data.

**Interpretation (labeled, sample-limited):** the entries are not mechanically wrong — the direction was eventually right in about half the losses — but an immediate post-break retest entry with a swing±0.5×ATR stop and a 2R target requires price to travel twice the stop distance *without first touching the stop*. On this 30-day, mostly range-bound gold tape (XAUUSD ~4370 → ~4150 with repeated failed breakouts in both directions; 459 zone invalidations across the month), M15 noise regularly consumed the full stop distance before any 2R extension. This is **documented strategy behavior in an unfavorable regime**, not an accounting bug. No causal claim is made from the n=1 cells (strong ADX, late retest) — they are explicitly INSUFFICIENT_DATA and were NOT used to select or alter any rule.

---

## Task 5 — Paper-signal observation pipeline: **PASS**

| Requirement | Verdict | Evidence |
|---|---|---|
| Uses only real verified market data | PASS | `trackPaperSignals` reads DB candles (`bridge-mt5`, VALID, closed) + persisted signal evaluations; no synthetic path |
| Immutable signal snapshots | PASS | `PaperSignalOutcome.signalEvaluationId` is `@unique`; resolved rows are never rewritten (test: duplicate processing cannot count twice) |
| Each outcome counted exactly once | PASS | Tests: 'targeted outcome recorded once; duplicate processing cannot count it twice'; repeated observations advance state, never add rows |
| Status separation | PASS | unresolved / stopped / targeted / invalidated / expired — each has dedicated tests (incl. SL-before-invalidation conservative order, expiry with no observable bars → null P/L, never fabricated) |
| Fingerprints + code version preserved | PASS | Schema persists engine/strategy version, dataset + input fingerprints, decision/entry timestamps, R-multiples |
| No broker order anywhere | PASS | Full-repo scans (4 patterns) = 0; bridge is GET-only; four locks engaged; paper module contains no execution code |
| Live state | PASS (honest empty) | 0 tracked setups — the only persisted evaluations are BLOCKED-stale and NO_SETUP rows; NO_SETUP is never tracked (test). Evidence will accumulate as real setups occur. Tracking advances automatically after every signal run and every scheduled sync |

Repeated observations of the same setup are NOT independent trades: the unique evaluation key plus the one-position backtest model (non-overlapping windows, new regression test) guarantee it.

---

## Task 6 — Corrective actions, tests, and verification

### Actions taken (smallest safe corrections only — separated from strategy)

1. **D1 fix** — `tests/market/helpers/setup.ts`: `process.env.DATA_API_TOKEN = ''` + explanatory comment (test hermeticity against Prisma's `.env` re-load). No production code touched.
2. **D2 correction** — documented in §1.4 (report-sentence misquote; harness was correct).
3. **New regression pins** — `tests/backtest/phase10.1-audit.test.ts` (4 tests): funnel conservation; one-position model (no overlapping trades, unique (signal, entry) pairs); entry-gap guard (gap through stop → no fill, never negative risk); byte-identical reproducibility.
4. **Investigation tool** — `scripts/phase10.1-investigation.ts` (read-only; harness-equivalence-asserted on every run; verified broker data only; post-stop counterfactuals explicitly labeled as diagnostics).

**Strategy configuration, signal rules, OOS thresholds, and the four execution locks: UNTOUCHED.**

### Verification executed

- `bun test`: **289/289 pass** (285 pre-existing + 4 new; exit 0) — includes the 42 Phase 10 tests and 17 paper tests
- `bun run lint`: clean · `tsc --noEmit` app: 0 errors · bridge: 0 errors
- `bun run build`: **NOT RUN** (sandbox rule — recorded, not claimed)
- Browser E2E (agent-browser, desktop 1280×800 + mobile 390×844): ভ্যালিডেশন tab renders the reproduced run (INCONCLUSIVE amber badge, dev/val/OOS sections, walk-forward, sensitivity, perturbations, paper empty-state); **0 console/page errors**; no 390px overflow; footer intact; execution lock UI shows LOCKED. Screenshots: `audit/phase10.1-{desktop,mobile}.png`
- Four locks runtime: phase 1 (< 11) · read_only · executionLocked=true · lock engaged

---

## 7. Unresolved questions, limitations, and BLOCKED items

1. **GitHub push BLOCKED.** The sandbox rebuild wiped the one-time credential helper (`/tmp/git-cred-helper.sh`); no authorized GitHub authentication exists in this environment (checked: git config, `~/.git-credentials`, gh CLI, env, /tmp remnants, bash history — none). Per the rules I will **not** ask for a PAT in chat. **All commits are safe locally** (3 Phase 10 + this phase). To unblock: provision the credential through the platform's secure secret mechanism (or re-authorize push the way it was done originally), then `git push origin main` (fast-forward, no force).
2. **Exact Phase 10 dataset bytes are not re-servable** (rolling broker window) — reproduction used identical depth + rules and matched every metric; H4 fingerprint identical. Persisting full raw history beyond the broker window would require a bridge/storage change (candidate for a future phase, not this one).
3. **Sample size remains the binding constraint** — 15 fills / 30 days; OOS verdict stays INCONCLUSIVE (pre-registered floor 20 untouched). M15 history grows ~96 bars/day; the paper tracker accumulates forward evidence automatically.
4. **Spread is a current observation, not historical** (L1); slippage/commission are assumptions (L2); monetary P/L BLOCKED on unverified symbol specs (L3) — all unchanged and labeled.
5. **MT5 password advisory stands** — it transited chat at the user's initiative (demo account); rotate at the user's convenience, and prefer the platform's persistent secret store over `.env` (rebuilds wipe `.env`; this phase had to re-provision it a third time).

## 8. Conclusion

**The failure is real, reproducible, and structural — and it is NOT an implementation defect.** The engine does exactly what its documented rules say, causally and deterministically, with honest accounting: 22 genuine opportunities in 30 days, 15 filled, 13 resolved at −1R stops and 2 at +2R targets, gross losses ~60× the modeled costs, in a regime where immediate-retest entries repeatedly failed to survive M15 noise long enough to reach a 2R target. No rule was tuned, no loss was hidden, no profitability is claimed, and **Phase 11 (demo execution) remains NOT recommended** until the evidence changes — either ≥ 20 OOS trades or accumulated forward paper outcomes justify a different conclusion.

— end of report —
