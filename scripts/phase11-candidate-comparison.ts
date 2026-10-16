/**
 * PHASE 11 — Baseline vs Candidate comparison (OFFLINE, read-only research).
 * ----------------------------------------------------------------------------
 * Runs the UNMODIFIED baseline strategy (hybrid-structure-retest/9.0.0) and
 * the candidate (hybrid-multimodel-research/11.0.0-candidate.1) over ONE
 * frozen SYNTHETIC dataset with IDENTICAL harness semantics (equivalence is
 * pinned by tests/signal/candidate-harness.test.ts), identical costs
 * (entry-side half-spread 0.12 + slippage 0.02; exit at level — the same
 * accounting as the established baseline backtest harness) and the same
 * chronological dev/OOS split.
 *
 * *** SYNTHETIC DATA — NOT A PERFORMANCE CLAIM ***
 * The dataset is FABRICATED (seeded generator). These numbers verify
 * MECHANICS and BEHAVIOR (availability, reason mix, dedup, conflict handling,
 * Model-A equality) only. Real-data comparison is a documented activation
 * pre-condition (audit/phase11-candidate-forward-protocol.md §2).
 *
 * Usage: bun run scripts/phase11-candidate-comparison.ts [days] [seed]
 */

import { runComparisonBacktest } from '@/lib/signal/candidate/harness';
import { generateSyntheticMarket, syntheticDatasetFingerprint } from '@/lib/signal/candidate/synthetic-dataset';
import { buildStrategyRules } from '@/lib/signal/rules';

const days = Number(process.argv[2] ?? 60);
const seed = Number(process.argv[3] ?? 20261016);

const RULES = { ...buildStrategyRules() };
const OPTS = {
  costs: { spreadPrice: 0.24, slippagePrice: 0.02 },
  devSplitFraction: 0.7,
  minCandles: 220,
  rules: RULES,
};

const t0 = Date.now();
const data = generateSyntheticMarket({ seed, days });
const fingerprint = syntheticDatasetFingerprint(data);
const harnessCandles = { execution: data.m15, h1: data.h1, h4: data.h4, m5: data.m5 };

const baseline = runComparisonBacktest('XAUUSDm-synth', harnessCandles, 2, { ...OPTS, mode: 'baseline' });
const candidate = runComparisonBacktest('XAUUSDm-synth', harnessCandles, 2, { ...OPTS, mode: 'candidate' });
const elapsed = Date.now() - t0;

// ── Model-A equality (the no-filter-weakened proof) ────────────────────────
const aEmissions = candidate.counters.setupsByModel.A + candidate.counters.modelAValidSuppressed;
const emissionsEqual = aEmissions === baseline.counters.validSetups;
const barsEqual = JSON.stringify(candidate.modelAEmissionBars) === JSON.stringify(baseline.modelAEmissionBars);

// ── Segment metrics (mirrors computeSegmentMetrics semantics) ───────────────
function seg(trades: typeof baseline.trades, seg: 'dev' | 'oos') {
  const t = trades.filter((x) => x.segment === seg);
  if (t.length === 0) return { trades: 0, status: 'EMPTY' };
  const wins = t.filter((x) => x.pnlPrice > 0).length;
  const losses = t.length - wins;
  const net = Number(t.reduce((s, x) => s + x.pnlPrice, 0).toFixed(2));
  const grossWin = t.filter((x) => x.pnlPrice > 0).reduce((s, x) => s + x.pnlPrice, 0);
  const grossLoss = Math.abs(t.filter((x) => x.pnlPrice <= 0).reduce((s, x) => s + x.pnlPrice, 0));
  let equity = 0, peak = 0, dd = 0, maxL = 0, streakL = 0;
  for (const x of t) {
    equity += x.pnlPrice;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    streakL = x.pnlPrice > 0 ? 0 : streakL + 1;
    maxL = Math.max(maxL, streakL);
  }
  return {
    trades: t.length, wins, losses,
    winRate: Number(((wins / t.length) * 100).toFixed(1)),
    net,
    pf: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(3)) : null,
    maxDD: Number(dd.toFixed(2)),
    avgR: Number((t.reduce((s, x) => s + x.rMultiple, 0) / t.length).toFixed(3)),
    maxConsecLosses: maxL,
    status: t.length < 5 ? 'INSUFFICIENT_DATA (<5)' : 'COMPUTED',
  };
}

function exitMix(trades: typeof baseline.trades) {
  const by: Record<string, number> = {};
  for (const t of trades) by[t.exitReason] = (by[t.exitReason] ?? 0) + 1;
  return by;
}

const report = {
  meta: {
    SYNTHETIC: true,
    disclaimer: 'SYNTHETIC dataset — mechanics/behavior comparison ONLY. NOT a performance claim. Real-data comparison is an activation pre-condition (phase11-candidate-forward-protocol §2).',
    seed, days,
    datasetFingerprint: fingerprint,
    bars: { m5: data.m5.length, m15: data.m15.length, h1: data.h1.length, h4: data.h4.length },
    regimes: data.regimes.map((r) => `${r.kind}[${r.fromM5}-${r.toM5}]`),
    costs: OPTS.costs,
    costsNote: 'entry-side half-spread + slippage per fill; exit at level — identical to the established baseline backtest harness semantics (equivalence-test-pinned)',
    devSplitFraction: OPTS.devSplitFraction,
    elapsedMs: elapsed,
  },
  modelAEquality: {
    baselineValidSetups: baseline.counters.validSetups,
    candidateModelAEmissions: aEmissions,
    emissionsEqual,
    emissionBarsByteIdentical: barsEqual,
    verdict: emissionsEqual && barsEqual ? 'PROVEN — Model A unchanged inside the candidate (no filter weakened)' : 'MISMATCH — INVESTIGATE',
  },
  baseline: {
    strategyVersion: 'hybrid-structure-retest/9.0.0',
    counters: baseline.counters,
    exitMix: exitMix(baseline.trades),
    dev: seg(baseline.trades, 'dev'),
    oos: seg(baseline.trades, 'oos'),
  },
  candidate: {
    strategyVersion: 'hybrid-multimodel-research/11.0.0-candidate.1',
    counters: candidate.counters,
    exitMix: exitMix(candidate.trades),
    dev: seg(candidate.trades, 'dev'),
    oos: seg(candidate.trades, 'oos'),
    tradesByModel: {
      A: candidate.trades.filter((t) => t.model === 'A').length,
      B: candidate.trades.filter((t) => t.model === 'B').length,
      C: candidate.trades.filter((t) => t.model === 'C').length,
    },
    distinctSetupIdentities: candidate.counters.distinctCandidateSetups,
    repeatEmissionsSuppressedByDedup: candidate.counters.repeatEmissions,
  },
};

console.log(JSON.stringify(report, null, 2));
