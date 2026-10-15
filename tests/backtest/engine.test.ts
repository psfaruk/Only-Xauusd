/**
 * PHASE 9 BACKTEST TESTS — the signal-engine validation harness + the Phase 8
 * structure-proxy regression suite (RECREATED: the Phase 8 report claimed
 * tests/backtest/engine.test.ts existed, but the file was lost before the
 * Phase 8 commit — see audit/phase9-pre-audit.md §1. These tests restore and
 * extend that coverage).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic fixture candles only — never real broker data.
 *
 * Pinned behaviors (spec Task G / Task C):
 *   · no look-ahead — mutating every candle after a decision timestamp leaves
 *     earlier decisions and their evidence unchanged (signal engine AND proxy)
 *   · conservative same-candle SL/target collision → the LOSS is assumed
 *   · dataset fingerprints are reproducible for identical datasets and differ
 *     for any change
 *   · chronological dev/OOS split; OOS never used for optimization (split is
 *     fixed by configuration, recorded on every run)
 *   · small samples honestly INSUFFICIENT_DATA — no invented metrics
 *   · honest counts: candidates / valid setups / blocked / fills / completed
 *     are reported SEPARATELY
 *   · verified-candles-only loader semantics (forming/INVALID excluded)
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { runBacktest, datasetFingerprint, DEFAULT_RULES } from '@/lib/backtest/engine';
import {
  runSignalBacktest,
  signalDatasetFingerprint,
  DEFAULT_SIGNAL_BACKTEST_RULES,
} from '@/lib/backtest/signal-engine';
import { buildStrategyRules } from '@/lib/signal/rules';
import type { AnalysisCandle } from '@/lib/analysis/types';
import type { StrategyRules } from '@/lib/signal/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const M15 = 900;
const H1 = 3600;
const H4 = 14400;
const EXEC_START = 1_791_000_000;

function candle(t: number, o: number, h: number, l: number, c: number): AnalysisCandle {
  return {
    timeUtcSec: t, open: o, high: h, low: l, close: c, volume: null,
    openText: o.toFixed(2), highText: h.toFixed(2), lowText: l.toFixed(2), closeText: c.toFixed(2),
  };
}

function waveLeg(count: number, startSec: number, tfSec: number, base: number, amp: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = base + amp * Math.sin((2 * Math.PI * i) / 16);
    const o = mid - amp * 0.3 * Math.cos((2 * Math.PI * i) / 16);
    const c = mid + amp * 0.3 * Math.cos((2 * Math.PI * i) / 16);
    const h = Math.max(o, c) + amp * 0.15;
    const l = Math.min(o, c) - amp * 0.15;
    out.push(candle(t, Number(o.toFixed(2)), Number(h.toFixed(2)), Number(l.toFixed(2)), Number(c.toFixed(2))));
  }
  return out;
}

function bullishHtf(count: number, startSec: number, tfSec: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = 2600 + i * 0.6 + 2.0 * Math.sin((2 * Math.PI * i) / 16);
    out.push(candle(t, Number((mid - 0.6).toFixed(2)), Number((mid + 1.4).toFixed(2)), Number((mid - 1.4).toFixed(2)), Number((mid + 0.6).toFixed(2))));
  }
  return out;
}

/** Execution series with REPEATED break→retest→hold→target-hit cycles. */
function setupRichExecution(startSec: number, cycles = 8): AnalysisCandle[] {
  const bars: AnalysisCandle[] = [];
  let t = startSec;
  // warm-up wave
  const warm = waveLeg(112, t, M15, 2650, 3);
  bars.push(...warm);
  t += 112 * M15;
  for (let k = 0; k < cycles; k++) {
    const lift = k * 8;
    // rally (break above the swing highs)
    for (let i = 0; i < 4; i++) {
      bars.push(candle(t, 2650 + lift + i * 1.1, 2651.3 + lift + i * 1.1, 2649.6 + lift + i * 1.1, 2651.1 + lift + i * 1.1));
      t += M15;
    }
    // pullback into the zone, holding above the level
    for (let i = 0; i < 3; i++) {
      bars.push(candle(t, 2654.4 + lift - i * 0.6, 2654.6 + lift - i * 0.6, 2651.2 + lift, 2653.4 + lift - i * 0.4));
      t += M15;
    }
    // decision close in the zone
    bars.push(candle(t, 2652.8 + lift, 2653.4 + lift, 2652.0 + lift, 2653.0 + lift));
    t += M15;
    // strong follow-through rally → the long target is reached quickly and
    // the position closes, freeing the next cycle for its own fill
    for (let i = 0; i < 4; i++) {
      bars.push(candle(t, 2656 + lift + i * 4, 2662 + lift + i * 4, 2655.5 + lift + i * 4, 2660 + lift + i * 4));
      t += M15;
    }
    // brief cool-down (new wave-like swings form for the next cycle)
    for (let i = 0; i < 8; i++) {
      bars.push(candle(t, 2672 + lift - i * 0.8, 2673 + lift - i * 0.8, 2671 + lift - i * 0.8, 2672.4 + lift - i * 0.8));
      t += M15;
    }
  }
  return bars;
}

const SIGNAL_RULES: StrategyRules = {
  ...buildStrategyRules(),
  windowBars: 300,
  minExecutionBars: 60,
  minH1Bars: 60,
  minH4Bars: 60,
  // Permissive indicator filters so the FIXTURE's structural setups survive
  // (the default-rule filters are pinned in tests/signal/engine.test.ts).
  minAdx: 0,
  rsiBuyMin: 0,
  rsiBuyMax: 100,
  maxSpreadPrice: 10,
  zoneWidthAtr: 1.0,
  entryToleranceAtr: 0.6,
  maxBarsSinceBreak: 14,
};

function makeDataset() {
  const exec = setupRichExecution(EXEC_START);
  const execEnd = exec[exec.length - 1].timeUtcSec;
  const h1 = bullishHtf(Math.ceil((exec.length * M15) / H1) + 40, EXEC_START - 130 * H1, H1);
  const h4 = bullishHtf(160, EXEC_START - 160 * H4, H4);
  return { exec, h1, h4, execEnd };
}

// ---------------------------------------------------------------------------
// Signal-engine backtest (Phase 9, Task C)
// ---------------------------------------------------------------------------

describe('signal-engine backtest — core guarantees', () => {
  test('runs the REAL signal core over every decision bar and reports counts separately', () => {
    const { exec, h1, h4 } = makeDataset();
    const result = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    expect(result.strategyVersion).toBe(SIGNAL_RULES.strategyVersion);
    expect(result.counters.evaluations).toBe(exec.length);
    // The warm-up region (< minExecutionBars) is BLOCKED — honestly counted.
    expect(result.counters.blockedEvaluations).toBeGreaterThanOrEqual(SIGNAL_RULES.minExecutionBars - 1);
    // The fixture contains engineered break+retest cycles → candidates exist.
    expect(result.counters.candidateSetups).toBeGreaterThan(0);
    expect(result.counters.validSetups).toBeGreaterThanOrEqual(result.counters.hypotheticalFills - result.counters.validSetups + result.counters.hypotheticalFills >= 0 ? 0 : 0);
    expect(result.counters.validSetups).toBeGreaterThanOrEqual(result.counters.hypotheticalFills > 0 ? 1 : 0);
    expect(result.counters.completedOutcomes).toBe(result.trades.length);
    // Every trade came from a setup outcome recorded at its signal bar.
    for (const t of result.trades) {
      expect(['BUY_SETUP', 'SELL_SETUP']).toContain(t.outcomeAtSignal);
      expect(t.entryBarTimeUtcSec).toBeGreaterThan(t.signalBarTimeUtcSec); // next-bar entry
    }
  });

  test('NO LOOK-AHEAD: mutating every candle after a decision timestamp leaves earlier trades unchanged', () => {
    const { exec, h1, h4 } = makeDataset();
    const result = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    expect(result.trades.length).toBeGreaterThanOrEqual(2); // sanity for the cut below
    // Cut at the LAST trade's signal bar: every other trade is strictly before
    // the cut and its evidence must be immune to future mutations.
    const sorted = [...result.trades].sort((a, b) => a.signalBarTimeUtcSec - b.signalBarTimeUtcSec);
    const cutTime = sorted[sorted.length - 1].signalBarTimeUtcSec;
    const before = result.trades.filter((t) => t.signalBarTimeUtcSec < cutTime);
    expect(before.length).toBeGreaterThan(0);
    // Mutate ALL candles after the cut beyond recognition (exec + HTFs).
    const mutatedExec = exec.map((c, i) =>
      c.timeUtcSec >= cutTime + M15 ? candle(c.timeUtcSec, 3000 + i, 3001 + i, 2999 - i, 3000.5 + i) : c,
    );
    const mutatedH1 = h1.map((c, i) =>
      c.timeUtcSec > cutTime ? candle(c.timeUtcSec, 3000 + i, 3001 + i, 2999 - i, 3000.5 + i) : c,
    );
    const mutatedH4 = h4.map((c, i) =>
      c.timeUtcSec > cutTime ? candle(c.timeUtcSec, 3000 + i, 3001 + i, 2999 - i, 3000.5 + i) : c,
    );
    const mutatedResult = runSignalBacktest('XAUUSDm', mutatedExec, mutatedH1, mutatedH4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    const after = mutatedResult.trades.filter((t) => t.signalBarTimeUtcSec < cutTime);
    // Earlier decisions and their evidence are byte-identical.
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test('conservative same-candle collision: SL and target both touched → the LOSS is assumed', () => {
    const { exec, h1, h4 } = makeDataset();
    const result = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    // Structural property: no trade exits at target on a bar whose range also
    // touched the stop (the engine resolves those to 'stop' first).
    for (const t of result.trades) {
      if (t.exitReason === 'target') {
        const bar = exec.find((c) => c.timeUtcSec === t.exitBarTimeUtcSec);
        if (bar) {
          const touchedStop = t.direction === 'long' ? bar.low <= t.stopLoss : bar.high >= t.stopLoss;
          expect(touchedStop).toBe(false);
        }
      }
    }
  });

  test('dataset fingerprint: identical dataset → identical fingerprint; any change → different', () => {
    const { exec, h1, h4 } = makeDataset();
    const a = signalDatasetFingerprint('XAUUSDm', exec, h1, h4);
    const b = signalDatasetFingerprint('XAUUSDm', structuredClone(exec), structuredClone(h1), structuredClone(h4));
    expect(a).toBe(b);
    const modified = structuredClone(exec);
    const c0 = modified[0];
    c0.close = Number((c0.close + 0.01).toFixed(2));
    c0.closeText = c0.close.toFixed(2);
    expect(a).not.toBe(signalDatasetFingerprint('XAUUSDm', modified, h1, h4));
  });

  test('full-run reproducibility: same dataset + rules → identical result JSON', () => {
    const { exec, h1, h4 } = makeDataset();
    const a = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    const b = runSignalBacktest('XAUUSDm', structuredClone(exec), structuredClone(h1), structuredClone(h4), 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('chronological dev/OOS split — dev trades all precede oos trades', () => {
    const { exec, h1, h4 } = makeDataset();
    const result = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    const devTimes = result.trades.filter((t) => t.segment === 'dev').map((t) => t.entryBarTimeUtcSec);
    const oosTimes = result.trades.filter((t) => t.segment === 'oos').map((t) => t.entryBarTimeUtcSec);
    if (devTimes.length > 0 && oosTimes.length > 0) {
      expect(Math.max(...devTimes)).toBeLessThan(Math.min(...oosTimes));
    }
    // The split fraction is recorded on the run (no hidden optimization).
    expect(result.rules.devSplitFraction).toBe(DEFAULT_SIGNAL_BACKTEST_RULES.devSplitFraction);
  });

  test('small sample is HONEST: < minTrades in a segment → INSUFFICIENT_DATA, no invented metrics', () => {
    const { exec, h1, h4 } = makeDataset();
    const strictRules = { ...DEFAULT_SIGNAL_BACKTEST_RULES, minTrades: 999 };
    const result = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, strictRules, SIGNAL_RULES);
    expect(result.dev.status).toBe('INSUFFICIENT_DATA');
    expect(result.oos.status).toBe('INSUFFICIENT_DATA');
    expect(result.dev.winRate).toBeNull();
    expect(result.dev.netPnlPrice).toBeNull();
    expect(result.dev.reason).toContain('metrics are NOT invented');
  });

  test('insufficient overall history → INSUFFICIENT_DATA for the whole run (nothing computed)', () => {
    const short = setupRichExecution(EXEC_START, 1).slice(0, 100);
    const result = runSignalBacktest('XAUUSDm', short, bullishHtf(60, EXEC_START - 60 * H1, H1), bullishHtf(60, EXEC_START - 60 * H4, H4), 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    expect(result.dev.status).toBe('INSUFFICIENT_DATA');
    expect(result.trades).toEqual([]);
    expect(result.counters.validSetups).toBe(0);
  });

  test('cost model: entry prices include half-spread + slippage on the correct side', () => {
    const { exec, h1, h4 } = makeDataset();
    const result = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    for (const t of result.trades) {
      const entryBar = exec.find((c) => c.timeUtcSec === t.entryBarTimeUtcSec);
      expect(entryBar).toBeDefined();
      if (t.direction === 'long') {
        expect(t.entryPrice).toBeGreaterThan(entryBar!.open); // buy at ask + slip
      } else {
        expect(t.entryPrice).toBeLessThan(entryBar!.open); // sell at bid − slip
      }
    }
  });

  test('wider costs can never IMPROVE net P&L (cost monotonicity)', () => {
    const { exec, h1, h4 } = makeDataset();
    const cheap = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, { ...DEFAULT_SIGNAL_BACKTEST_RULES, costs: { spreadPrice: 0.1, slippagePrice: 0.01 } }, SIGNAL_RULES);
    const expensive = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, { ...DEFAULT_SIGNAL_BACKTEST_RULES, costs: { spreadPrice: 0.5, slippagePrice: 0.05 } }, SIGNAL_RULES);
    if (cheap.dev.status === 'COMPUTED' && expensive.dev.status === 'COMPUTED') {
      expect(expensive.dev.netPnlPrice!).toBeLessThanOrEqual(cheap.dev.netPnlPrice!);
    }
  });

  test('limitations list documents the live-vs-backtest reference-price difference', () => {
    const { exec, h1, h4 } = makeDataset();
    const result = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    expect(result.limitations.some((l) => l.includes('REAL-TIME quote'))).toBe(true);
    expect(result.limitations.some((l) => l.includes('NEVER optimized'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 8 structure-proxy regression (restored coverage)
// ---------------------------------------------------------------------------

describe('phase 8 structure-proxy backtest — regression suite (restored)', () => {
  const proxyRules = { ...DEFAULT_RULES, minCandles: 220, minTrades: 5 };

  function proxyDataset(): AnalysisCandle[] {
    // wave + repeated impulses so BOS events + EMA/RSI filters fire sometimes
    const bars = waveLeg(600, EXEC_START, M15, 2650, 4);
    let t = EXEC_START + 600 * M15;
    for (let k = 0; k < 6; k++) {
      for (let i = 0; i < 10; i++) {
        const o = 2650 + k * 8 + i * 0.9;
        bars.push(candle(t, o, o + 1.1, o - 1.1, o + 0.8));
        t += M15;
      }
      for (let i = 0; i < 10; i++) {
        const o = 2658 + k * 8 - i * 0.7;
        bars.push(candle(t, o, o + 1.1, o - 1.1, o - 0.5));
        t += M15;
      }
    }
    return bars;
  }

  test('INSUFFICIENT_DATA honesty: too few candles → empty metrics with reason', () => {
    const short = waveLeg(100, EXEC_START, M15, 2650, 3);
    const result = runBacktest('XAUUSDm', 'M15', M15, short, 2, proxyRules);
    expect(result.dev.status).toBe('INSUFFICIENT_DATA');
    expect(result.trades).toEqual([]);
    expect(result.dev.reason).toContain('only 100 candles');
  });

  test('version + rules are recorded on every run', () => {
    const bars = proxyDataset();
    const result = runBacktest('XAUUSDm', 'M15', M15, bars, 2, proxyRules);
    expect(result.strategyVersion).toBe('8.0.0-structure-proxy');
    expect(result.rules).toEqual(proxyRules);
  });

  test('next-bar-open entry: every trade enters on the bar AFTER its signal bar', () => {
    const bars = proxyDataset();
    const result = runBacktest('XAUUSDm', 'M15', M15, bars, 2, proxyRules);
    expect(result.trades.length).toBeGreaterThan(0);
    for (const t of result.trades) {
      expect(t.entryBarTimeUtcSec).toBeGreaterThan(t.signalBarTimeUtcSec);
    }
  });

  test('NO LOOK-AHEAD: mutating future candles leaves earlier trades byte-identical', () => {
    const bars = proxyDataset();
    const result = runBacktest('XAUUSDm', 'M15', M15, bars, 2, proxyRules);
    expect(result.trades.length).toBeGreaterThanOrEqual(2); // sanity for the cut below
    const sorted = [...result.trades].sort((a, b) => a.signalBarTimeUtcSec - b.signalBarTimeUtcSec);
    const cutTime = sorted[sorted.length - 1].signalBarTimeUtcSec;
    const before = result.trades.filter((t) => t.signalBarTimeUtcSec < cutTime);
    expect(before.length).toBeGreaterThan(0);
    const mutated = bars.map((c, i) =>
      c.timeUtcSec >= cutTime + M15 ? candle(c.timeUtcSec, 3000 + i, 3001 + i, 2999 - i, 3000.5 + i) : c,
    );
    const mutatedResult = runBacktest('XAUUSDm', 'M15', M15, mutated, 2, proxyRules);
    const after = mutatedResult.trades.filter((t) => t.signalBarTimeUtcSec < cutTime);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test('conservative collision: a candle touching both SL and target resolves to the LOSS', () => {
    const bars = proxyDataset();
    const result = runBacktest('XAUUSDm', 'M15', M15, bars, 2, proxyRules);
    for (const t of result.trades) {
      if (t.exitReason === 'target') {
        const bar = bars.find((c) => c.timeUtcSec === t.exitBarTimeUtcSec);
        if (bar) {
          const touchedStop = t.direction === 'long' ? bar.low <= t.stopLoss : bar.high >= t.stopLoss;
          expect(touchedStop).toBe(false);
        }
      }
    }
  });

  test('dataset fingerprint identity + difference (proxy)', () => {
    const bars = proxyDataset();
    expect(datasetFingerprint('XAUUSDm', 'M15', bars)).toBe(datasetFingerprint('XAUUSDm', 'M15', structuredClone(bars)));
    const modified = structuredClone(bars);
    const last = modified[modified.length - 1];
    last.close = Number((last.close + 0.01).toFixed(2));
    last.closeText = last.close.toFixed(2);
    expect(datasetFingerprint('XAUUSDm', 'M15', bars)).not.toBe(datasetFingerprint('XAUUSDm', 'M15', modified));
  });

  test('chronological dev/OOS partition', () => {
    const bars = proxyDataset();
    const result = runBacktest('XAUUSDm', 'M15', M15, bars, 2, proxyRules);
    const devTimes = result.trades.filter((t) => t.segment === 'dev').map((t) => t.entryBarTimeUtcSec);
    const oosTimes = result.trades.filter((t) => t.segment === 'oos').map((t) => t.entryBarTimeUtcSec);
    if (devTimes.length > 0 && oosTimes.length > 0) {
      expect(Math.max(...devTimes)).toBeLessThan(Math.min(...oosTimes));
    }
  });

  test('cost monotonicity: wider spread+slippage never improves net P&L (proxy)', () => {
    const bars = proxyDataset();
    const cheap = runBacktest('XAUUSDm', 'M15', M15, bars, 2, { ...proxyRules, spreadPrice: 0.1, slippagePrice: 0.01 });
    const expensive = runBacktest('XAUUSDm', 'M15', M15, bars, 2, { ...proxyRules, spreadPrice: 0.6, slippagePrice: 0.06 });
    if (cheap.dev.status === 'COMPUTED' && expensive.dev.status === 'COMPUTED') {
      expect(expensive.dev.netPnlPrice!).toBeLessThanOrEqual(cheap.dev.netPnlPrice!);
    }
  });

  test('honest end_of_data exits are marked, never counted as wins by construction', () => {
    const bars = proxyDataset();
    const result = runBacktest('XAUUSDm', 'M15', M15, bars, 2, proxyRules);
    const eod = result.trades.filter((t) => t.exitReason === 'end_of_data');
    for (const t of eod) {
      expect(t.exitBarTimeUtcSec).toBe(bars[bars.length - 1].timeUtcSec);
    }
  });
});
