/**
 * PHASE 10 VALIDATION HARNESS TESTS.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic fixture candles only — never real broker data.
 *
 * Pins:
 *   · equivalence with the Phase 9 simulator (same trade list; documented
 *     P/L relation net10 = pnl9 − (halfSpread + slip + commission))
 *   · three-way dev/val/OOS chronological isolation (no overlap; OOS last)
 *   · no look-ahead (future-candle mutation leaves earlier trades unchanged)
 *   · walk-forward windows: contiguous, non-overlapping, full coverage
 *   · sensitivity monotonicity on the SAME trade list
 *   · perturbation SET completeness (nothing selected; config unchanged)
 *   · pre-registered interpretation branches
 *   · insufficient-data blocking + honest INCONCLUSIVE
 *   · conservative SL-first collision flagged on the trade
 *   · full-run reproducibility (byte-identical result)
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { runSignalBacktest, DEFAULT_SIGNAL_BACKTEST_RULES } from '@/lib/backtest/signal-engine';
import { runBacktest, DEFAULT_RULES } from '@/lib/backtest/engine';
import {
  defaultValidationRules,
  evaluateInterpretation,
  runValidation,
  type SegmentMetrics,
  type SensitivityRow,
} from '@/lib/backtest/validation';
import { buildStrategyRules } from '@/lib/signal/rules';
import type { AnalysisCandle } from '@/lib/analysis/types';
import type { StrategyRules } from '@/lib/signal/types';

// ---------------------------------------------------------------------------
// Fixtures (SYNTHETIC — unit testing only)
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
function setupRichExecution(startSec: number, cycles = 10): AnalysisCandle[] {
  const bars: AnalysisCandle[] = [];
  let t = startSec;
  bars.push(...waveLeg(112, t, M15, 2650, 3));
  t += 112 * M15;
  for (let k = 0; k < cycles; k++) {
    const lift = k * 8;
    for (let i = 0; i < 4; i++) {
      bars.push(candle(t, 2650 + lift + i * 1.1, 2651.3 + lift + i * 1.1, 2649.6 + lift + i * 1.1, 2651.1 + lift + i * 1.1));
      t += M15;
    }
    for (let i = 0; i < 3; i++) {
      bars.push(candle(t, 2654.4 + lift - i * 0.6, 2654.6 + lift - i * 0.6, 2651.2 + lift, 2653.4 + lift - i * 0.4));
      t += M15;
    }
    bars.push(candle(t, 2652.8 + lift, 2653.4 + lift, 2652.0 + lift, 2653.0 + lift));
    t += M15;
    for (let i = 0; i < 4; i++) {
      bars.push(candle(t, 2656 + lift + i * 4, 2662 + lift + i * 4, 2655.5 + lift + i * 4, 2660 + lift + i * 4));
      t += M15;
    }
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
  minAdx: 0,
  rsiBuyMin: 0,
  rsiBuyMax: 100,
  maxSpreadPrice: 10,
  zoneWidthAtr: 1.0,
  entryToleranceAtr: 0.6,
  maxBarsSinceBreak: 14,
};

function makeDataset(cycles = 10) {
  const exec = setupRichExecution(EXEC_START, cycles);
  const h1 = bullishHtf(Math.ceil((exec.length * M15) / H1) + 40, EXEC_START - 130 * H1, H1);
  const h4 = bullishHtf(160, EXEC_START - 160 * H4, H4);
  return { exec, h1, h4 };
}

const COSTS = { spreadPrice: 0.24, slippagePrice: 0.02, commissionPrice: 0, labels: ['synthetic test costs'] };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phase 10 validation harness — equivalence with the Phase 9 simulator', () => {
  test('same trade list (bars, direction, SL, reason); net = Phase9 pnl − (halfSpread + slip + commission)', () => {
    const { exec, h1, h4 } = makeDataset(10);
    const p9 = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    const p10 = runValidation('XAUUSDm', exec, h1, h4, 2, 0.24, {
      costs: COSTS,
      split: { devFraction: 0.7, valFraction: 0.0 },
      minCandles: 220,
      minTrades: 5,
      minInterpretableTrades: 20,
      walkForward: { testBars: 300, minTradesPerWindow: 5 },
      includePerturbations: false,
    }, SIGNAL_RULES);

    expect(p10.trades.length).toBe(p9.trades.length);
    expect(p10.trades.length).toBeGreaterThan(0);
    const halfSpreadPlusSlipPlusComm = COSTS.spreadPrice / 2 + COSTS.slippagePrice + COSTS.commissionPrice;
    for (let i = 0; i < p10.trades.length; i++) {
      const a = p9.trades[i];
      const b = p10.trades[i];
      expect(b.signalBarTimeUtcSec).toBe(a.signalBarTimeUtcSec);
      expect(b.entryBarTimeUtcSec).toBe(a.entryBarTimeUtcSec);
      expect(b.exitBarTimeUtcSec).toBe(a.exitBarTimeUtcSec);
      expect(b.direction).toBe(a.direction);
      expect(b.stopLoss).toBeCloseTo(a.stopLoss, 10);
      expect(b.exitReason).toBe(a.exitReason);
      expect(b.netPrice).toBeCloseTo(a.pnlPrice - halfSpreadPlusSlipPlusComm, 8);
    }
  });
});

describe('phase 10 validation harness — three-way split isolation', () => {
  test('dev ≤ val ≤ oos chronologically with no overlap; segments partition all trades', () => {
    const { exec, h1, h4 } = makeDataset(10);
    const r = runValidation('XAUUSDm', exec, h1, h4, 2, 0.24, {
      costs: COSTS,
      split: { devFraction: 0.5, valFraction: 0.2 },
      minCandles: 220,
      minTrades: 2,
      minInterpretableTrades: 20,
      walkForward: { testBars: 300, minTradesPerWindow: 2 },
      includePerturbations: false,
    }, SIGNAL_RULES);

    const segOf = (t: (typeof r.trades)[number]) => t.segment;
    const dev = r.trades.filter((t) => segOf(t) === 'dev');
    const val = r.trades.filter((t) => segOf(t) === 'val');
    const oos = r.trades.filter((t) => segOf(t) === 'oos');
    expect(dev.length + val.length + oos.length).toBe(r.trades.length);

    if (dev.length && val.length) {
      expect(Math.max(...dev.map((t) => t.entryBarTimeUtcSec))).toBeLessThan(Math.min(...val.map((t) => t.entryBarTimeUtcSec)));
    }
    if (val.length && oos.length) {
      expect(Math.max(...val.map((t) => t.entryBarTimeUtcSec))).toBeLessThan(Math.min(...oos.map((t) => t.entryBarTimeUtcSec)));
    }
    if (dev.length && oos.length) {
      expect(Math.max(...dev.map((t) => t.entryBarTimeUtcSec))).toBeLessThan(Math.min(...oos.map((t) => t.entryBarTimeUtcSec)));
    }
    // OOS is the LAST 30% of the dataset by construction.
    expect(r.dataset.splitFractions.dev + r.dataset.splitFractions.val + r.dataset.splitFractions.oos).toBeCloseTo(1, 6);
    expect(r.dataset.splitFractions.oos).toBeGreaterThanOrEqual(0.15);
  });

  test('OOS metrics derive ONLY from OOS trades (recomputed independently)', () => {
    const { exec, h1, h4 } = makeDataset(10);
    const r = runValidation('XAUUSDm', exec, h1, h4, 2, 0.24, {
      costs: COSTS,
      split: { devFraction: 0.5, valFraction: 0.2 },
      minCandles: 220,
      minTrades: 2,
      minInterpretableTrades: 20,
      walkForward: { testBars: 300, minTradesPerWindow: 2 },
      includePerturbations: false,
    }, SIGNAL_RULES);
    const oosTrades = r.trades.filter((t) => t.segment === 'oos');
    if (r.segments.oos.status === 'COMPUTED') {
      const net = oosTrades.reduce((s, t) => s + t.netPrice, 0);
      expect(r.segments.oos.netPnlPrice).toBeCloseTo(Number(net.toFixed(4)), 3);
      expect(r.segments.oos.trades).toBe(oosTrades.length);
    } else {
      expect(oosTrades.length).toBeLessThan(2);
    }
  });
});

describe('phase 10 validation harness — no look-ahead', () => {
  test('mutating every candle AFTER a decision timestamp leaves earlier trades unchanged', () => {
    const { exec, h1, h4 } = makeDataset(8);
    const rules = {
      costs: COSTS,
      split: { devFraction: 0.5, valFraction: 0.2 },
      minCandles: 220,
      minTrades: 2,
      minInterpretableTrades: 20,
      walkForward: { testBars: 300, minTradesPerWindow: 2 },
      includePerturbations: false,
    };
    const base = runValidation('XAUUSDm', exec, h1, h4, 2, 0.24, rules, SIGNAL_RULES);
    expect(base.trades.length).toBeGreaterThan(0);

    // Mutate every candle from the FIRST trade's exit onward (future knowledge).
    const cutIdx = exec.findIndex((c) => c.timeUtcSec === base.trades[0].exitBarTimeUtcSec);
    expect(cutIdx).toBeGreaterThan(0);
    const mutated = exec.map((c, i) =>
      i >= cutIdx ? candle(c.timeUtcSec, c.open + 5, c.high + 7, c.low - 7, c.close + 5) : c,
    );
    const after = runValidation('XAUUSDm', mutated, h1, h4, 2, 0.24, rules, SIGNAL_RULES);
    // The first trade must be byte-identical (it closed before any mutation).
    expect(after.trades[0]).toEqual(base.trades[0]);
  });
});

describe('phase 10 validation harness — walk-forward mechanics', () => {
  test('windows are contiguous, non-overlapping and cover the post-warm-up history', () => {
    const { exec, h1, h4 } = makeDataset(60); // long history → multiple windows
    const r = runValidation('XAUUSDm', exec, h1, h4, 2, 0.24, {
      costs: COSTS,
      split: { devFraction: 0.5, valFraction: 0.2 },
      minCandles: 220,
      minTrades: 2,
      minInterpretableTrades: 20,
      walkForward: { testBars: 300, minTradesPerWindow: 2 },
      includePerturbations: false,
    }, SIGNAL_RULES);

    expect(r.walkForward.windows.length).toBeGreaterThan(1);
    for (let i = 1; i < r.walkForward.windows.length; i++) {
      const prev = r.walkForward.windows[i - 1];
      const cur = r.walkForward.windows[i];
      expect(cur.fromUtcSec).toBeGreaterThan(prev.toUtcSec); // no overlap
    }
    const last = r.walkForward.windows[r.walkForward.windows.length - 1];
    expect(last.toUtcSec).toBe(exec[exec.length - 1].timeUtcSec); // full coverage
    // thin windows stay INSUFFICIENT_DATA — nothing invented
    for (const w of r.walkForward.windows) {
      if (w.metrics.status === 'INSUFFICIENT_DATA') {
        expect(w.metrics.trades).toBeLessThan(2);
        expect(w.metrics.netPnlPrice).toBeNull();
      }
    }
  });
});

describe('phase 10 validation harness — sensitivity and perturbations', () => {
  const rules = {
    costs: COSTS,
    split: { devFraction: 0.5, valFraction: 0.2 },
    minCandles: 220,
    minTrades: 2,
    minInterpretableTrades: 20,
    walkForward: { testBars: 300, minTradesPerWindow: 2 },
    includePerturbations: true,
  };

  test('sensitivity: same trade count, monotone net (baseline > stressed > high_stress)', () => {
    const { exec, h1, h4 } = makeDataset(8);
    const r = runValidation('XAUUSDm', exec, h1, h4, 2, 0.24, rules, SIGNAL_RULES);
    expect(r.sensitivity.map((s) => s.scenario)).toEqual(['baseline', 'stressed', 'high_stress']);
    for (const s of r.sensitivity) expect(s.trades).toBe(r.trades.length);
    expect(r.sensitivity[0].netPnlPrice).toBeGreaterThan(r.sensitivity[1].netPnlPrice);
    expect(r.sensitivity[1].netPnlPrice).toBeGreaterThan(r.sensitivity[2].netPnlPrice);
    // baseline row must equal the segment-sum of trade nets
    const netAll = r.trades.reduce((s, t) => s + t.netPrice, 0);
    expect(r.sensitivity[0].netPnlPrice).toBeCloseTo(Number(netAll.toFixed(4)), 3);
  });

  test('perturbation set: baseline + 12 rows over 6 params; production config unchanged; nothing selected', () => {
    const { exec, h1, h4 } = makeDataset(8);
    const r = runValidation('XAUUSDm', exec, h1, h4, 2, 0.24, rules, SIGNAL_RULES);
    expect(r.perturbations[0].param).toBe('(baseline)');
    const params = new Set(r.perturbations.slice(1).map((p) => p.param));
    expect(params).toEqual(new Set(['rewardRisk', 'maxBarsSinceBreak', 'zoneWidthAtr', 'slAtrBuffer', 'minAdx', 'entryToleranceAtr']));
    expect(r.perturbations.length).toBe(13);
    // the persisted strategy config is EXACTLY the input rules — unchanged
    expect(r.strategyConfig).toEqual(SIGNAL_RULES);
  });
});

describe('phase 10 validation harness — collision, reproducibility, insufficient data', () => {
  test('SL+TP both touched in the entry bar → stopped with collision=true (conservative)', () => {
    // Take the WORKING fixture (known to produce trades), then mutate the
    // FIRST trade's entry bar into a violent bar whose range spans both its
    // stop-loss and its target. Opens/closes are untouched, so the signal
    // itself is unchanged — only the entry bar's extremes trigger both exits.
    const { exec, h1, h4 } = makeDataset(8);
    const rules = {
      costs: COSTS,
      split: { devFraction: 0.5, valFraction: 0.2 },
      minCandles: 220,
      minTrades: 1,
      minInterpretableTrades: 20,
      walkForward: { testBars: 300, minTradesPerWindow: 1 },
      includePerturbations: false,
    };
    const base = runValidation('XAUUSDm', exec, h1, h4, 2, 0.24, rules, SIGNAL_RULES);
    expect(base.trades.length).toBeGreaterThan(0);
    const first = base.trades[0];
    const violent = exec.map((c) =>
      c.timeUtcSec === first.entryBarTimeUtcSec
        ? candle(c.timeUtcSec, c.open, Math.max(c.high, first.target + 1), Math.min(c.low, first.stopLoss - 1), c.close)
        : c,
    );
    const r = runValidation('XAUUSDm', violent, h1, h4, 2, 0.24, rules, SIGNAL_RULES);
    expect(r.trades.length).toBeGreaterThan(0);
    const collided = r.trades.find((tr) => tr.exitReason === 'stop' && tr.collision);
    expect(collided).toBeDefined();
    expect(collided?.exitBarTimeUtcSec).toBe(first.entryBarTimeUtcSec); // resolved on the entry bar itself
    expect(collided?.exitRawPrice).toBeCloseTo(first.stopLoss, 10); // the LOSS side is taken
  });

  test('full-run reproducibility: identical inputs → byte-identical JSON', () => {
    const { exec, h1, h4 } = makeDataset(6);
    const rules = {
      costs: COSTS,
      split: { devFraction: 0.5, valFraction: 0.2 },
      minCandles: 220,
      minTrades: 2,
      minInterpretableTrades: 20,
      walkForward: { testBars: 300, minTradesPerWindow: 2 },
      includePerturbations: false,
    };
    const a = runValidation('XAUUSDm', structuredClone(exec), structuredClone(h1), structuredClone(h4), 2, 0.24, rules, SIGNAL_RULES);
    const b = runValidation('XAUUSDm', structuredClone(exec), structuredClone(h1), structuredClone(h4), 2, 0.24, rules, SIGNAL_RULES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('insufficient history → INSUFFICIENT_DATA everywhere + honest INCONCLUSIVE', () => {
    const short = setupRichExecution(EXEC_START, 1).slice(0, 60);
    const h1 = bullishHtf(80, EXEC_START - 90 * H1, H1);
    const h4 = bullishHtf(90, EXEC_START - 90 * H4, H4);
    const r = runValidation('XAUUSDm', short, h1, h4, 2, 0.24, defaultValidationRules(0.24), SIGNAL_RULES);
    expect(r.segments.dev.status).toBe('INSUFFICIENT_DATA');
    expect(r.segments.val.status).toBe('INSUFFICIENT_DATA');
    expect(r.segments.oos.status).toBe('INSUFFICIENT_DATA');
    expect(r.trades).toEqual([]);
    expect(r.walkForward.windows).toEqual([]);
    expect(r.sensitivity).toEqual([]);
    expect(r.interpretation.conclusion).toBe('INCONCLUSIVE');
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('phase 10 — pre-registered interpretation rules', () => {
  const base: SegmentMetrics = {
    status: 'COMPUTED', candles: 600, fromUtcSec: 0, toUtcSec: 1,
    trades: 25, wins: 12, losses: 13, winRate: 0.48,
    grossPnlPrice: 100, costsPrice: 7, netPnlPrice: 93, profitFactor: 1.2,
    expectancyPrice: 3.7, expectancyR: 0.11, avgWinPrice: 20, avgLossPrice: -12,
    maxDrawdownPrice: 40, maxConsecutiveWins: 4, maxConsecutiveLosses: 5,
    exposurePct: 20, tradesPerWeek: 5,
    concentration: { top1GrossShare: 0.2, top3GrossShare: 0.5 },
    byDirection: { long: { trades: 13, netPnlPrice: 50, winRate: 0.5 }, short: { trades: 12, netPnlPrice: 43, winRate: 0.46 } },
    byH4Trend: { trend: { trades: 15, netPnlPrice: 70, winRate: 0.5 }, range: { trades: 10, netPnlPrice: 23, winRate: 0.44 } },
    byVolatility: { low: { trades: 8, netPnlPrice: 30, winRate: 0.5 }, mid: { trades: 9, netPnlPrice: 33, winRate: 0.5 }, high: { trades: 8, netPnlPrice: 30, winRate: 0.44 } },
    byAdx: { weak: { trades: 8, netPnlPrice: 30, winRate: 0.5 }, moderate: { trades: 9, netPnlPrice: 33, winRate: 0.5 }, strong: { trades: 8, netPnlPrice: 30, winRate: 0.44 } },
  };

  const sens = (netPositive: boolean): SensitivityRow[] => [
    { scenario: 'baseline', spreadPrice: 0.24, slippagePrice: 0.02, commissionPrice: 0, trades: 25, netPnlPrice: netPositive ? 93 : -10, profitFactor: netPositive ? 1.2 : 0.9, netPositive, labels: [] },
    { scenario: 'stressed', spreadPrice: 0.4, slippagePrice: 0.04, commissionPrice: 0, trades: 25, netPnlPrice: netPositive ? 80 : -20, profitFactor: 1.1, netPositive, labels: [] },
    { scenario: 'high_stress', spreadPrice: 0.6, slippagePrice: 0.06, commissionPrice: 0.05, trades: 25, netPnlPrice: netPositive ? 60 : -30, profitFactor: 1.0, netPositive, labels: [] },
  ];

  test('OOS below the interpretability floor → INCONCLUSIVE', () => {
    const thin = { ...base, trades: 19 };
    expect(evaluateInterpretation(thin, sens(true), 20).conclusion).toBe('INCONCLUSIVE');
  });

  test('OOS COMPUTED with ≥20 trades but net ≤ 0 → NEGATIVE_AFTER_COSTS', () => {
    const neg = { ...base, netPnlPrice: -50 };
    expect(evaluateInterpretation(neg, sens(false), 20).conclusion).toBe('NEGATIVE_AFTER_COSTS');
  });

  test('positive OOS but stressed scenario negative → INCONCLUSIVE', () => {
    const mixed: SensitivityRow[] = [
      sens(true)[0],
      { ...sens(true)[1], netPnlPrice: -5, netPositive: false },
      sens(true)[2],
    ];
    expect(evaluateInterpretation(base, mixed, 20).conclusion).toBe('INCONCLUSIVE');
  });

  test('positive OOS but top-1 trade > 35% of gross profit → INCONCLUSIVE (concentration)', () => {
    const concentrated = { ...base, concentration: { top1GrossShare: 0.5, top3GrossShare: 0.8 } };
    expect(evaluateInterpretation(concentrated, sens(true), 20).conclusion).toBe('INCONCLUSIVE');
  });

  test('sufficient OOS + robust to stress + not concentrated → PROMISING_CONTINUE_FORWARD (NOT a profitability claim)', () => {
    const verdict = evaluateInterpretation(base, sens(true), 20);
    expect(verdict.conclusion).toBe('PROMISING_CONTINUE_FORWARD');
    expect(verdict.reasons.join(' ')).toContain('NOT a profitability claim');
  });
});

describe('phase 10 — Phase 8 proxy regression still intact (no drift)', () => {
  test('structure-proxy engine still runs and stays honest on short data', () => {
    const short = setupRichExecution(EXEC_START, 1).slice(0, 60);
    const r = runBacktest('XAUUSDm', 'M15', M15, short, 2, DEFAULT_RULES);
    expect(r.dev.status).toBe('INSUFFICIENT_DATA');
    expect(r.oos.status).toBe('INSUFFICIENT_DATA');
  });
});
