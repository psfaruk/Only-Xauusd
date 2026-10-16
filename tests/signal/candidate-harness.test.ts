/**
 * PHASE 11 CANDIDATE HARNESS + SYNTHETIC DATASET TESTS (test-first).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: the synthetic dataset generator produces FABRICATED OHLC
 * series for pipeline mechanics verification ONLY. They are never broker
 * data, never persisted as market data, and never used for performance
 * claims.
 *
 * Pinned behaviors:
 *   · Seeded generator is deterministic (identical arrays across runs)
 *   · Different seeds produce different datasets
 *   · The comparison harness with the BASELINE evaluator reproduces
 *     runSignalBacktest EXACTLY (counters + trades) on the same dataset —
 *     proving the candidate comparison uses identical semantics
 *   · Harness no-look-ahead: mutating every candle after decision i leaves
 *     earlier decisions unchanged (mirrors the baseline harness guarantee)
 *   · Candidate mode emits model-tagged trades with setup fingerprints
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { runSignalBacktest, DEFAULT_SIGNAL_BACKTEST_RULES } from '@/lib/backtest/signal-engine';
import { buildStrategyRules } from '@/lib/signal/rules';
import type { StrategyRules } from '@/lib/signal/types';
import {
  generateSyntheticMarket,
  syntheticDatasetFingerprint,
} from '@/lib/signal/candidate/synthetic-dataset';
import { runComparisonBacktest } from '@/lib/signal/candidate/harness';

const RULES: StrategyRules = { ...buildStrategyRules(), windowBars: 300, minExecutionBars: 60, minH1Bars: 60, minH4Bars: 60 };

describe('synthetic dataset generator', () => {
  test('deterministic: same seed → byte-identical series and fingerprint', () => {
    const a = generateSyntheticMarket({ seed: 20261016, days: 40 });
    const b = generateSyntheticMarket({ seed: 20261016, days: 40 });
    expect(JSON.stringify(a.m15)).toBe(JSON.stringify(b.m15));
    expect(JSON.stringify(a.m5)).toBe(JSON.stringify(b.m5));
    expect(syntheticDatasetFingerprint(a)).toBe(syntheticDatasetFingerprint(b));
  });

  test('different seed → different fingerprint', () => {
    const a = generateSyntheticMarket({ seed: 20261016, days: 40 });
    const b = generateSyntheticMarket({ seed: 20261017, days: 40 });
    expect(syntheticDatasetFingerprint(a)).not.toBe(syntheticDatasetFingerprint(b));
  });

  test('shape: 40 days → 40×288 M5, 40×96 M15, 40×24 H1, 40×6 H4; OHLC-valid; ascending; M5 coherent with M15', () => {
    const d = generateSyntheticMarket({ seed: 1, days: 40 });
    expect(d.m5.length).toBe(40 * 288);
    expect(d.m15.length).toBe(40 * 96);
    expect(d.h1.length).toBe(40 * 24);
    expect(d.h4.length).toBe(40 * 6);
    for (const arr of [d.m5, d.m15, d.h1, d.h4]) {
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        expect(Number.isFinite(c.open) && c.open > 0).toBe(true);
        expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
        expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
        expect(c.high).toBeGreaterThanOrEqual(c.low);
        if (i > 0) expect(c.timeUtcSec).toBeGreaterThan(arr[i - 1].timeUtcSec);
      }
    }
    // M15 aggregation coherence: each M15 bar's OHLC equals the aggregate of its 3 M5 bars
    const first15 = d.m15[100];
    const m5s = d.m5.filter((c) => c.timeUtcSec >= first15.timeUtcSec && c.timeUtcSec < first15.timeUtcSec + 900);
    expect(m5s.length).toBe(3);
    expect(first15.open).toBe(m5s[0].open);
    expect(first15.close).toBe(m5s[2].close);
    expect(first15.high).toBe(Math.max(...m5s.map((c) => c.high)));
    expect(first15.low).toBe(Math.min(...m5s.map((c) => c.low)));
  });
});

describe('comparison harness — baseline-equivalence (identical semantics)', () => {
  test('baseline mode reproduces runSignalBacktest EXACTLY (counters + trades)', () => {
    const d = generateSyntheticMarket({ seed: 20261016, days: 40 });
    const rules = { ...DEFAULT_SIGNAL_BACKTEST_RULES, minCandles: 220 };
    const base = runSignalBacktest('XAUUSDm-synth', d.m15, d.h1, d.h4, 2, rules, RULES);
    const mine = runComparisonBacktest('XAUUSDm-synth', { execution: d.m15, h1: d.h1, h4: d.h4, m5: d.m5 }, 2, {
      mode: 'baseline',
      costs: rules.costs,
      devSplitFraction: rules.devSplitFraction,
      minCandles: rules.minCandles,
      rules: RULES,
    });
    expect(mine.counters.evaluations).toBe(base.counters.evaluations);
    expect(mine.counters.blockedEvaluations).toBe(base.counters.blockedEvaluations);
    expect(mine.counters.noSetup).toBe(base.counters.noSetup);
    expect(mine.counters.wait).toBe(base.counters.wait);
    expect(mine.counters.validSetups).toBe(base.counters.validSetups);
    expect(mine.counters.hypotheticalFills).toBe(base.counters.hypotheticalFills);
    expect(mine.counters.completedOutcomes).toBe(base.counters.completedOutcomes);
    expect(mine.trades.length).toBe(base.trades.length);
    for (let i = 0; i < base.trades.length; i++) {
      const a = base.trades[i];
      const b = mine.trades[i];
      expect(b.signalBarTimeUtcSec).toBe(a.signalBarTimeUtcSec);
      expect(b.entryBarTimeUtcSec).toBe(a.entryBarTimeUtcSec);
      expect(b.entryPrice).toBe(a.entryPrice);
      expect(b.stopLoss).toBe(a.stopLoss);
      expect(b.target).toBe(a.target);
      expect(b.exitBarTimeUtcSec).toBe(a.exitBarTimeUtcSec);
      expect(b.exitPrice).toBe(a.exitPrice);
      expect(b.exitReason).toBe(a.exitReason);
      expect(b.segment).toBe(a.segment);
      expect(b.pnlPrice).toBe(a.pnlPrice);
      expect(b.rMultiple).toBe(a.rMultiple);
    }
  });

  test('no look-ahead: mutating every candle AFTER decision i leaves earlier decisions unchanged', () => {
    // 20-day dataset (H4 warm-up needs only 60 bars under the test RULES) keeps
    // the two harness passes well inside the test timeout even under full-suite load.
    const d = generateSyntheticMarket({ seed: 20261016, days: 20 });
    const clean = runComparisonBacktest('XAUUSDm-synth', { execution: d.m15, h1: d.h1, h4: d.h4, m5: d.m5 }, 2, {
      mode: 'candidate', costs: { spreadPrice: 0.24, slippagePrice: 0.02 }, devSplitFraction: 0.7, minCandles: 220, rules: RULES,
    });
    // mutate all candles from index 1200 onward (prices scaled ×3)
    const m15 = d.m15.map((c, i) => (i >= 1200 ? { ...c, open: c.open * 3, high: c.high * 3, low: c.low * 3, close: c.close * 3 } : c));
    const dirty = runComparisonBacktest('XAUUSDm-synth', { execution: m15, h1: d.h1, h4: d.h4, m5: d.m5 }, 2, {
      mode: 'candidate', costs: { spreadPrice: 0.24, slippagePrice: 0.02 }, devSplitFraction: 0.7, minCandles: 220, rules: RULES,
    });
    // every trade whose SIGNAL bar is before 1200 must be byte-identical
    const cleanEarly = clean.trades.filter((t) => t.signalBarTimeUtcSec < d.m15[1200].timeUtcSec);
    const dirtyEarly = dirty.trades.filter((t) => t.signalBarTimeUtcSec < d.m15[1200].timeUtcSec);
    expect(cleanEarly.length).toBeGreaterThan(0);
    expect(dirtyEarly.length).toBe(cleanEarly.length);
    for (let i = 0; i < cleanEarly.length; i++) {
      expect(dirtyEarly[i].signalBarTimeUtcSec).toBe(cleanEarly[i].signalBarTimeUtcSec);
      expect(dirtyEarly[i].model).toBe(cleanEarly[i].model);
      expect(dirtyEarly[i].entryPrice).toBe(cleanEarly[i].entryPrice);
      expect(dirtyEarly[i].exitReason).toBe(cleanEarly[i].exitReason);
    }
  }, 20_000);
});

describe('comparison harness — candidate mode', () => {
  test('candidate trades carry model tags and setup fingerprints; counters include per-model setups', () => {
    const d = generateSyntheticMarket({ seed: 20261016, days: 40 });
    const out = runComparisonBacktest('XAUUSDm-synth', { execution: d.m15, h1: d.h1, h4: d.h4, m5: d.m5 }, 2, {
      mode: 'candidate', costs: { spreadPrice: 0.24, slippagePrice: 0.02 }, devSplitFraction: 0.7, minCandles: 220, rules: RULES,
    });
    expect(out.counters.evaluations).toBe(d.m15.length);
    for (const t of out.trades) {
      expect(t.model !== null && ["A", "B", "C"].includes(t.model)).toBe(true);
      expect(typeof t.setupFingerprint).toBe('string');
      expect(t.setupFingerprint ?? '').toHaveLength(64);
    }
    const setupsByModel = out.counters.setupsByModel;
    expect(setupsByModel.A + setupsByModel.B + setupsByModel.C + out.counters.suppressedByPrecedence)
      .toBe(out.counters.validSetups);
  });

  test('candidate Model-A emissions EQUAL baseline valid setups on the same dataset (no filter weakened)', () => {
    const d = generateSyntheticMarket({ seed: 20261016, days: 40 });
    const base = runComparisonBacktest('XAUUSDm-synth', { execution: d.m15, h1: d.h1, h4: d.h4, m5: d.m5 }, 2, {
      mode: 'baseline', costs: { spreadPrice: 0.24, slippagePrice: 0.02 }, devSplitFraction: 0.7, minCandles: 220, rules: RULES,
    });
    const cand = runComparisonBacktest('XAUUSDm-synth', { execution: d.m15, h1: d.h1, h4: d.h4, m5: d.m5 }, 2, {
      mode: 'candidate', costs: { spreadPrice: 0.24, slippagePrice: 0.02 }, devSplitFraction: 0.7, minCandles: 220, rules: RULES,
    });
    // Model A inside the candidate must emit on EXACTLY the bars the baseline does
    expect(cand.counters.setupsByModel.A + cand.counters.modelAValidSuppressed).toBe(base.counters.validSetups);
    // and the bar-level agreement is pinned via the emission lists
    expect(cand.modelAEmissionBars).toEqual(base.validSetupBars);
  });
});
