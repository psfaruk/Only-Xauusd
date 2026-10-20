/**
 * PHASE 11-E — REAL-DATA Baseline vs Candidate comparison (activation
 * pre-condition §2.2 of audit/phase11-candidate-forward-protocol.md).
 * ----------------------------------------------------------------------------
 * Runs the UNMODIFIED baseline strategy (hybrid-structure-retest/9.0.0) and
 * the candidate (hybrid-multimodel-research/11.0.0-candidate.1) over the
 * REAL verified broker candles currently persisted in the runtime database
 * (largest depth the broker serves: 2000 M15 / 2000 M5 / 2000 H1 / 2000 H4
 * request caps — the bridge API is limit-only, latest-N). Identical harness
 * semantics (equivalence test-pinned), identical costs (entry-side
 * half-spread 0.12 + slippage 0.02 — the same accounting as the established
 * baseline backtest harness) and the same chronological dev/OOS split.
 *
 * *** RESEARCH COMPARISON — NOT A PERFORMANCE CLAIM ***
 * Purpose (protocol §2.2): verify mechanics, availability and reason mix on
 * REAL data before the candidate enters forward observation. Sample sizes
 * are small (single ~30-day M15 window); the pre-registered forward protocol
 * (20-outcome floor, 90 days) is the only basis for any future verdict.
 *
 * Usage: bun run scripts/phase11-real-comparison.ts
 */

import { db } from '../src/lib/db';
import { runComparisonBacktest } from '@/lib/signal/candidate/harness';
import { buildStrategyRules } from '@/lib/signal/rules';
import type { AnalysisCandle } from '@/lib/analysis/types';

interface LoadedTf {
  candles: AnalysisCandle[];
  excluded: number;
  from: string;
  to: string;
}

async function loadTf(tf: 'M5' | 'M15' | 'H1' | 'H4'): Promise<LoadedTf> {
  const rows = await db.marketCandle.findMany({
    where: {
      symbol: 'XAUUSDm',
      timeframe: tf,
      isForming: false,
      validationStatus: { in: ['VALID', 'WARNING'] },
    },
    orderBy: { candleTimeUtc: 'asc' },
  });
  const candles: AnalysisCandle[] = [];
  let excluded = 0;
  for (const r of rows) {
    const o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close);
    if (![o, h, l, c].every((v) => Number.isFinite(v) && v > 0) || h < l) { excluded++; continue; }
    candles.push({
      timeUtcSec: Math.floor(r.candleTimeUtc.getTime() / 1000),
      open: o, high: h, low: l, close: c,
      volume: r.tickVolume ?? null,
      openText: r.open, highText: r.high, lowText: r.low, closeText: r.close,
    });
  }
  return {
    candles,
    excluded,
    from: candles.length ? new Date(candles[0].timeUtcSec * 1000).toISOString() : '—',
    to: candles.length ? new Date(candles[candles.length - 1].timeUtcSec * 1000).toISOString() : '—',
  };
}

function seg(trades: Array<{ segment: string; pnlPrice: number; rMultiple: number }>, segName: 'dev' | 'oos') {
  const t = trades.filter((x) => x.segment === segName);
  if (t.length === 0) return { trades: 0, status: 'EMPTY' };
  const wins = t.filter((x) => x.pnlPrice > 0).length;
  const net = Number(t.reduce((s, x) => s + x.pnlPrice, 0).toFixed(2));
  let equity = 0, peak = 0, dd = 0, streakL = 0, maxL = 0;
  for (const x of t) {
    equity += x.rMultiple;
    peak = Math.max(peak, equity);
    dd = Math.min(dd, equity - peak);
    if (x.pnlPrice <= 0) { streakL++; maxL = Math.max(maxL, streakL); } else streakL = 0;
  }
  return {
    trades: t.length,
    winRate: `${wins}/${t.length} (${((wins / t.length) * 100).toFixed(1)}%)`,
    netPnlPrice: net,
    sumR: Number(equity.toFixed(2)),
    maxDrawdownR: Number(dd.toFixed(2)),
    maxConsecLosses: maxL,
    status: t.length < 10 ? 'SMALL-SAMPLE' : 'OK',
  };
}

async function main() {
  const t0 = Date.now();
  const [m15, h1, h4, m5] = await Promise.all([
    loadTf('M15'), loadTf('H1'), loadTf('H4'), loadTf('M5'),
  ]);

  console.log('════════ REAL DATA (verified broker candles, runtime DB) ════════');
  console.log(`M15: ${m15.candles.length} closed (${m15.excluded} excluded) ${m15.from} → ${m15.to}`);
  console.log(`H1 : ${h1.candles.length} closed (${h1.excluded} excluded) ${h1.from} → ${h1.to}`);
  console.log(`H4 : ${h4.candles.length} closed (${h4.excluded} excluded) ${h4.from} → ${h4.to}`);
  console.log(`M5 : ${m5.candles.length} closed (${m5.excluded} excluded) ${m5.from} → ${m5.to}`);
  console.log(`M5 coverage note: bridge API is limit-only (latest-N) — M5 spans ~9-10 days; Models B/C M5-confirmation is unavailable for older M15 decisions (disclosed in the report).`);

  const RULES = { ...buildStrategyRules() };
  const OPTS = {
    costs: { spreadPrice: 0.24, slippagePrice: 0.02 },
    devSplitFraction: 0.7,
    minCandles: 220,
    rules: RULES,
  };

  const baseline = runComparisonBacktest('XAUUSDm', { execution: m15.candles, h1: h1.candles, h4: h4.candles, m5: m5.candles }, 2, { ...OPTS, mode: 'baseline' });
  const candidate = runComparisonBacktest('XAUUSDm', { execution: m15.candles, h1: h1.candles, h4: h4.candles, m5: m5.candles }, 2, { ...OPTS, mode: 'candidate' });

  const aEmissions = candidate.counters.setupsByModel.A + candidate.counters.modelAValidSuppressed;
  const emissionsEqual = aEmissions === baseline.counters.validSetups;
  const barsEqual = JSON.stringify(candidate.modelAEmissionBars) === JSON.stringify(baseline.modelAEmissionBars);

  console.log('\n════════ MODEL-A EQUALITY (no-filter-weakened proof) ════════');
  console.log(`Model-A emissions (candidate mode): ${aEmissions} vs baseline validSetups: ${baseline.counters.validSetups} → ${emissionsEqual ? 'EQUAL ✓' : 'MISMATCH ✗'}`);
  console.log(`Emission bars byte-identical: ${barsEqual ? 'YES ✓' : 'NO ✗'}`);

  console.log('\n════════ BASELINE (hybrid-structure-retest/9.0.0) ════════');
  console.log(JSON.stringify({
    evaluations: baseline.counters.evaluations,
    blocked: baseline.counters.blockedEvaluations,
    noSetup: baseline.counters.noSetup,
    wait: baseline.counters.wait,
    validSetups: baseline.counters.validSetups,
    hypotheticalFills: baseline.counters.hypotheticalFills,
    completedOutcomes: baseline.counters.completedOutcomes,
    dev: seg(baseline.trades, 'dev'),
    oos: seg(baseline.trades, 'oos'),
  }, null, 1));

  console.log('\n════════ CANDIDATE (hybrid-multimodel-research/11.0.0-candidate.1) ════════');
  console.log(JSON.stringify({
    evaluations: candidate.counters.evaluations,
    blocked: candidate.counters.blockedEvaluations,
    noSetup: candidate.counters.noSetup,
    wait: candidate.counters.wait,
    validSetups: candidate.counters.validSetups,
    byModel: candidate.counters.setupsByModel,
    suppressedByPrecedence: candidate.counters.suppressedByPrecedence,
    modelAValidSuppressed: candidate.counters.modelAValidSuppressed,
    conflicts: candidate.counters.conflicts,
    distinctCandidateSetups: candidate.counters.distinctCandidateSetups,
    repeatEmissions: candidate.counters.repeatEmissions,
    hypotheticalFills: candidate.counters.hypotheticalFills,
    completedOutcomes: candidate.counters.completedOutcomes,
    dev: seg(candidate.trades, 'dev'),
    oos: seg(candidate.trades, 'oos'),
  }, null, 1));

  console.log('\n════════ TOP REASON CODES ════════');
  const top = (obj: Record<string, number>) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('baseline :', JSON.stringify(Object.fromEntries(top(baseline.counters.reasonCounts))));
  console.log('candidate:', JSON.stringify(Object.fromEntries(top(candidate.counters.reasonCounts))));

  console.log(`\nDataset fingerprint (baseline harness): ${baseline.datasetFingerprint}`);
  console.log(`Elapsed: ${Date.now() - t0}ms`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
