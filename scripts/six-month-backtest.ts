/**
 * SIX-MONTH BACKTEST (master prompt Phase 5)
 * ----------------------------------------------------------------------------
 * Runs the REAL signal engine over the six-month broker-verified dataset
 * acquired by scripts/six-month-import.ts (Phase 3). This is the first run
 * in the project's history with more than ~30 days of M15 depth and full
 * six-month M5 confirmation coverage (the limit-only bridge API previously
 * made anything deeper impossible).
 *
 * PRE-REGISTERED DESIGN (fixed BEFORE results are seen — changing any of
 * these after seeing results requires a new versioned report):
 *   · Dataset: every verified closed candle (source='bridge-mt5',
 *     validationStatus='VALID', isForming=false) for M15 execution, H1/H4
 *     context and M5 confirmation, chronological order.
 *   · Baseline strategy: the current production signal core
 *     (hybrid-structure-retest/9.0.0 via runSignalBacktest — unmodified).
 *   · Candidate comparison: the pre-registered candidate
 *     (hybrid-multimodel-research/11.0.0-candidate.1) via the SAME harness
 *     with identical costs — no parameter of either was tuned on this
 *     dataset by this run.
 *   · Split: chronological dev/OOS 70/30 (the project's established,
 *     test-pinned pre-registration; OOS is never optimized against).
 *   · Costs: entry-side half-spread 0.12 + slippage 0.02 per side
 *     (0.24 full spread) — LABELLED ASSUMPTION (historical per-bar spread
 *     is not served by the broker source). Sensitivity band: 0.20 / 0.24 /
 *     0.30 / 0.35.
 *   · Uncertainty: bootstrap CI (1000 iterations, seed 42) over per-trade
 *     R; sample adequacy thresholds <30 / 30–99 / ≥100 trades.
 *
 * PRE-REGISTERED CLASSIFICATION RULES (prompt §5.6 — evaluated on the OOS
 * segment of the BASELINE strategy, applied identically to the candidate):
 *   1. engine INSUFFICIENT_DATA            → INSUFFICIENT_DATA
 *   2. OOS completed trades < 30           → INSUFFICIENT_SAMPLE
 *   3. OOS bootstrap p95 ≤ 0               → REJECTED
 *   4. OOS bootstrap median ≤ 0            → REJECTED
 *   5. otherwise                           → PAPER_FORWARD_REQUIRED
 *   (No historical result can ever produce a "profitable/validated" label —
 *   forward evidence under a pre-registered protocol is the only path.)
 *
 * Usage: bun --env-file=.env scripts/six-month-backtest.ts
 */
import { writeFileSync } from 'node:fs';
import { db } from '../src/lib/db';
import { loadVerifiedCandles } from '../src/lib/backtest/service';
import { runSignalBacktest, DEFAULT_SIGNAL_BACKTEST_RULES } from '../src/lib/backtest/signal-engine';
import { runComparisonBacktest } from '../src/lib/signal/candidate/harness';
import { buildStrategyRules } from '../src/lib/signal/rules';
import { bootstrapR } from '../src/lib/backtest/bootstrap';
import { buildSampleAdequacyReport, type SampleAdequacyReport } from '../src/lib/backtest/sample-adequacy';
import type { AnalysisCandle } from '../src/lib/analysis/types';

const SYMBOL = (process.env.MARKET_SYMBOLS ?? 'XAUUSDm').split(',')[0]?.trim() || 'XAUUSDm';
const MAX_CANDLES = 500_000;
const SPREAD_SCENARIOS = [0.2, 0.24, 0.3, 0.35];

/** Pre-registered classification (§5.6). */
function classify(oosTrades: Array<{ rMultiple: number }>, engineStatus: string): {
  classification: 'INSUFFICIENT_DATA' | 'INSUFFICIENT_SAMPLE' | 'REJECTED' | 'PAPER_FORWARD_REQUIRED';
  rule: string;
} {
  if (engineStatus === 'INSUFFICIENT_DATA') {
    return { classification: 'INSUFFICIENT_DATA', rule: 'engine returned INSUFFICIENT_DATA' };
  }
  const completed = oosTrades.filter((t) => Number.isFinite(t.rMultiple));
  if (completed.length < 30) {
    return { classification: 'INSUFFICIENT_SAMPLE', rule: `OOS completed trades ${completed.length} < 30` };
  }
  const boot = bootstrapR(completed.map((t) => t.rMultiple), 1000, 42);
  if (boot.p95ExpectancyR !== null && boot.p95ExpectancyR <= 0) {
    return { classification: 'REJECTED', rule: `OOS bootstrap p95 ${boot.p95ExpectancyR.toFixed(3)}R ≤ 0` };
  }
  if (boot.medianExpectancyR !== null && boot.medianExpectancyR <= 0) {
    return { classification: 'REJECTED', rule: `OOS bootstrap median ${boot.medianExpectancyR.toFixed(3)}R ≤ 0` };
  }
  return { classification: 'PAPER_FORWARD_REQUIRED', rule: 'OOS median > 0 but historical evidence alone never validates a strategy' };
}

function segSummary(trades: Array<{ segment: string; pnlPrice: number; rMultiple: number; exitReason?: string }>, segName: 'dev' | 'oos') {
  const t = trades.filter((x) => x.segment === segName);
  const completed = t.filter((x) => Number.isFinite(x.rMultiple));
  if (!t.length) return { trades: 0, status: 'EMPTY' as const };
  const wins = t.filter((x) => x.pnlPrice > 0).length;
  let equity = 0, peak = 0, dd = 0, streakL = 0, maxL = 0;
  for (const x of t) {
    equity += x.rMultiple;
    peak = Math.max(peak, equity);
    dd = Math.min(dd, equity - peak);
    if (x.pnlPrice <= 0) { streakL += 1; maxL = Math.max(maxL, streakL); } else streakL = 0;
  }
  const grossWin = t.filter((x) => x.pnlPrice > 0).reduce((s, x) => s + x.pnlPrice, 0);
  const grossLoss = Math.abs(t.filter((x) => x.pnlPrice < 0).reduce((s, x) => s + x.pnlPrice, 0));
  return {
    trades: t.length,
    completed: completed.length,
    wins,
    winRate: t.length ? Number((wins / t.length).toFixed(3)) : null,
    netPnlPrice: Number(t.reduce((s, x) => s + x.pnlPrice, 0).toFixed(2)),
    sumR: Number(equity.toFixed(2)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : null,
    maxDrawdownR: Number(dd.toFixed(2)),
    maxConsecutiveLosses: maxL,
    status: t.length < 10 ? ('SMALL_SAMPLE' as const) : ('OK' as const),
  };
}

function adequacy(trades: Array<{ segment: string; rMultiple: number }>, segName: 'dev' | 'oos', from: string, to: string): SampleAdequacyReport {
  const n = trades.filter((x) => x.segment === segName && Number.isFinite(x.rMultiple)).length;
  return buildSampleAdequacyReport(n, { fromUtc: from, toUtc: to });
}

function iso(sec: number | null | undefined): string {
  return sec ? new Date(sec * 1000).toISOString() : '—';
}

async function main() {
  const t0 = Date.now();
  console.log(`[six-month-backtest] start — ${new Date().toISOString()}`);

  // ── dataset (verified broker candles only — the Phase 3 import) ─────────
  const [m15, h1, h4, m5] = await Promise.all([
    loadVerifiedCandles(SYMBOL, 'M15', MAX_CANDLES),
    loadVerifiedCandles(SYMBOL, 'H1', MAX_CANDLES),
    loadVerifiedCandles(SYMBOL, 'H4', MAX_CANDLES),
    loadVerifiedCandles(SYMBOL, 'M5', MAX_CANDLES),
  ]);
  const span = (c: AnalysisCandle[]) =>
    c.length ? `${new Date(c[0].timeUtcSec * 1000).toISOString()} → ${new Date(c[c.length - 1].timeUtcSec * 1000).toISOString()}` : '—';
  console.log(`M15: ${m15.candles.length} closed (${m15.excluded} excluded) ${span(m15.candles)}`);
  console.log(`M5 : ${m5.candles.length} closed (${m5.excluded} excluded) ${span(m5.candles)}`);
  console.log(`H1 : ${h1.candles.length} closed (${h1.excluded} excluded) ${span(h1.candles)}`);
  console.log(`H4 : ${h4.candles.length} closed (${h4.excluded} excluded) ${span(h4.candles)}`);

  if (m15.candles.length < 220) {
    console.error('[six-month-backtest] INSUFFICIENT_DATA — M15 depth below 220. Run scripts/six-month-import.ts first.');
    process.exit(1);
  }

  // ── baseline: the REAL signal core (unmodified) ─────────────────────────
  const rules = { ...DEFAULT_SIGNAL_BACKTEST_RULES };
  const baseline = runSignalBacktest(SYMBOL, m15.candles, h1.candles, h4.candles, m15.digits, rules, buildStrategyRules());

  // ── candidate comparison (pre-registered candidate, identical costs) ────
  const cmpRules = {
    costs: { spreadPrice: 0.24, slippagePrice: 0.02 },
    devSplitFraction: 0.7,
    minCandles: 220,
    rules: { ...buildStrategyRules() },
  };
  const baseCmp = runComparisonBacktest(SYMBOL, { execution: m15.candles, h1: h1.candles, h4: h4.candles, m5: m5.candles }, 2, { ...cmpRules, mode: 'baseline' });
  const candCmp = runComparisonBacktest(SYMBOL, { execution: m15.candles, h1: h1.candles, h4: h4.candles, m5: m5.candles }, 2, { ...cmpRules, mode: 'candidate' });

  // Model-A equality (the no-filter-weakened proof) on six-month data.
  const aEmissions = candCmp.counters.setupsByModel.A + candCmp.counters.modelAValidSuppressed;
  const modelAEquality = {
    candidateModelA: aEmissions,
    baselineValidSetups: baseCmp.counters.validSetups,
    equal: aEmissions === baseCmp.counters.validSetups,
    barsIdentical: JSON.stringify(candCmp.modelAEmissionBars) === JSON.stringify(baseCmp.modelAEmissionBars),
  };

  // ── spread sensitivity (baseline strategy) ──────────────────────────────
  const sensitivity = SPREAD_SCENARIOS.map((spreadPrice) => {
    const r = runSignalBacktest(
      SYMBOL, m15.candles, h1.candles, h4.candles, m15.digits,
      { ...rules, costs: { spreadPrice, slippagePrice: rules.costs.slippagePrice } },
      buildStrategyRules(),
    );
    return {
      spreadPrice,
      devTrades: r.dev.executedTrades,
      oosTrades: r.oos.executedTrades,
      devNetPnlPrice: r.dev.netPnlPrice,
      oosNetPnlPrice: r.oos.netPnlPrice,
      oosSumR: Number(r.trades.filter((t) => t.segment === 'oos').reduce((s, t) => s + t.rMultiple, 0).toFixed(2)),
    };
  });

  // ── uncertainty ─────────────────────────────────────────────────────────
  const fromIso = iso(baseline.dataset.fromUtcSec);
  const toIso = iso(baseline.dataset.toUtcSec);
  const bootAll = bootstrapR(baseline.trades.map((t) => t.rMultiple), 1000, 42);
  const bootOos = bootstrapR(baseline.trades.filter((t) => t.segment === 'oos').map((t) => t.rMultiple), 1000, 42);
  const bootCandOos = bootstrapR(candCmp.trades.filter((t) => t.segment === 'oos').map((t) => t.rMultiple), 1000, 42);
  const adequacyBaseline = {
    dev: adequacy(baseline.trades, 'dev', fromIso, toIso),
    oos: adequacy(baseline.trades, 'oos', fromIso, toIso),
  };

  // ── pre-registered classification ───────────────────────────────────────
  const baselineClass = classify(baseline.trades.filter((t) => t.segment === 'oos'), baseline.oos.status);
  const candidateClass = classify(
    candCmp.trades.filter((t) => t.segment === 'oos'),
    candCmp.trades.length >= (cmpRules.minCandles ?? 220) || candCmp.counters.evaluations > 0 ? 'COMPUTED' : 'INSUFFICIENT_DATA',
  );

  // ── machine-readable results ────────────────────────────────────────────
  const results = {
    generatedAtUtc: new Date().toISOString(),
    preRegisteredDesign: {
      dataset: 'all verified closed broker candles (bridge-mt5, VALID, non-forming)',
      split: 'chronological dev/OOS 70/30',
      costs: { spreadPrice: 0.24, slippagePrice: 0.02, label: 'ASSUMPTION — historical per-bar spread not served by source' },
      bootstrap: { iterations: 1000, seed: 42 },
      classificationRules: [
        'engine INSUFFICIENT_DATA → INSUFFICIENT_DATA',
        'OOS completed trades < 30 → INSUFFICIENT_SAMPLE',
        'OOS bootstrap p95 ≤ 0 → REJECTED',
        'OOS bootstrap median ≤ 0 → REJECTED',
        'otherwise → PAPER_FORWARD_REQUIRED',
      ],
    },
    dataset: {
      symbol: SYMBOL,
      executionTf: 'M15',
      m15: { candles: m15.candles.length, excluded: m15.excluded, from: fromIso, to: toIso },
      m5: { candles: m5.candles.length, excluded: m5.excluded, from: span(m5.candles) },
      h1: { candles: h1.candles.length, excluded: h1.excluded, from: span(h1.candles) },
      h4: { candles: h4.candles.length, excluded: h4.excluded, from: span(h4.candles) },
      fingerprint: baseline.datasetFingerprint,
      digits: m15.digits,
    },
    baseline: {
      strategyVersion: baseline.strategyVersion,
      backtestVersion: baseline.backtestVersion,
      counters: baseline.counters,
      dev: segSummary(baseline.trades, 'dev'),
      oos: segSummary(baseline.trades, 'oos'),
      bootstrapAll: bootAll,
      bootstrapOos: bootOos,
      adequacy: adequacyBaseline,
      classification: baselineClass,
      limitations: baseline.limitations,
    },
    candidate: {
      strategyVersion: '11.0.0-candidate.1 (pre-registered, unmodified)',
      counters: candCmp.counters,
      dev: segSummary(candCmp.trades, 'dev'),
      oos: segSummary(candCmp.trades, 'oos'),
      bootstrapOos: bootCandOos,
      modelAEquality,
      classification: candidateClass,
    },
    spreadSensitivity: sensitivity,
    paperForwardLedger: {
      note: 'The runtime paper-forward ledger was reset by the platform DB wipe on 2026-10-22 — completed forward outcomes = 0 at this run. Forward evidence must re-accumulate under the pre-registered protocol before any reliability claim.',
    },
  };
  writeFileSync('audit/six-month-backtest-results.json', `${JSON.stringify(results, null, 2)}\n`);

  // ── console summary ─────────────────────────────────────────────────────
  console.log('\n════════ BASELINE (real signal core, 6-month dataset) ════════');
  console.log(`counters: ${JSON.stringify(baseline.counters)}`);
  console.log(`dev: ${JSON.stringify(segSummary(baseline.trades, 'dev'))}`);
  console.log(`oos : ${JSON.stringify(segSummary(baseline.trades, 'oos'))}`);
  console.log(`bootstrap OOS: median=${bootOos.medianExpectancyR?.toFixed(3)}R p05=${bootOos.p05ExpectancyR?.toFixed(3)}R p95=${bootOos.p95ExpectancyR?.toFixed(3)}R (${bootOos.samples} samples)`);
  console.log(`CLASSIFICATION (pre-registered): ${baselineClass.classification} — ${baselineClass.rule}`);
  console.log('\n════════ CANDIDATE (pre-registered 11.0.0-candidate.1) ════════');
  console.log(`modelA equality: ${JSON.stringify(modelAEquality)}`);
  console.log(`dev: ${JSON.stringify(segSummary(candCmp.trades, 'dev'))}`);
  console.log(`oos : ${JSON.stringify(segSummary(candCmp.trades, 'oos'))}`);
  console.log(`CLASSIFICATION: ${candidateClass.classification} — ${candidateClass.rule}`);
  console.log(`\nspread sensitivity: ${JSON.stringify(sensitivity)}`);
  console.log(`\n[six-month-backtest] results → audit/six-month-backtest-results.json (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error('[six-month-backtest] fatal:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
