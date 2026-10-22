/**
 * PHASE 5 — NO-LOOK-AHEAD / SAME-BAR-FILL / SPREAD-DIRECTION TESTS (Task 42-S3).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic fixture candles only — never real broker data.
 *
 * Focused honesty suite with EXACT identities (existing regression coverage in
 * tests/backtest/engine.test.ts asserts these properties structurally; this
 * file pins the exact arithmetic and engineered edge cases):
 *
 *   S1 · FILL TIMING — a signal computed at candle C's close can NEVER fill at
 *        C's open or any price known at/before C's close: every fill comes
 *        from the NEXT bar's open (entryBarTime − signalBarTime === tfSec)
 *        shifted by exactly (half-spread + slippage) on the correct side.
 *   S2 · INTRABAR AMBIGUITY — a bar whose range covers BOTH stop and target
 *        resolves CONSERVATIVELY to the LOSS (SL first, exit at the stop
 *        level, rMultiple === −1). No tick data exists anywhere in this
 *        system, so the pessimistic rule is the only honest resolution.
 *   S3 · SPREAD DIRECTION — the spread is always applied AGAINST the entry:
 *        long fills at open + halfSpread + slippage (ask side), short fills at
 *        open − halfSpread − slippage (bid side). Verified on a long dataset
 *        AND its exact price-mirror (which produces the short trades).
 *   S4 · EXIT CONVENTION — Phase 9 simulators exit at the RAW level (no cost
 *        adjustment at exit; the entry already carries half-spread + one
 *        slippage). Documented difference vs the Phase 10 cost model (which
 *        charges the symmetric round trip) — pinned in cost-model.test.ts.
 *
 * All expectations below are FROZEN from probe runs over these deterministic
 * fixtures (documented in audit/phase5-backtest-audit.md).
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { runBacktest, DEFAULT_RULES, type BacktestTrade } from '@/lib/backtest/engine';
import {
  runSignalBacktest,
  DEFAULT_SIGNAL_BACKTEST_RULES,
  type SignalBacktestTrade,
} from '@/lib/backtest/signal-engine';
import { buildStrategyRules } from '@/lib/signal/rules';
import type { StrategyRules } from '@/lib/signal/types';
import type { AnalysisCandle } from '@/lib/analysis/types';

const M15 = 900;
const H1S = 3600;
const H4S = 14400;
const EXEC_START = 1_791_000_000;

// ---------------------------------------------------------------------------
// Fixtures (deterministic generators — same family as engine.test.ts)
// ---------------------------------------------------------------------------

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

function setupRichExecution(startSec: number, cycles = 8): AnalysisCandle[] {
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

/** Exact price mirror around 5300 — every long setup becomes a short setup
 *  (swings, structure, indicators mirror; OHLC validity is preserved). */
function mirror(bars: AnalysisCandle[]): AnalysisCandle[] {
  return bars.map((b) => candle(b.timeUtcSec, 5300 - b.open, 5300 - b.low, 5300 - b.high, 5300 - b.close));
}

function proxyDataset(): AnalysisCandle[] {
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

const COSTS = DEFAULT_SIGNAL_BACKTEST_RULES.costs;
const HALF_OFFSET = COSTS.spreadPrice / 2 + COSTS.slippagePrice; // 0.12 + 0.02

// ---------------------------------------------------------------------------
// Shared exact-identity helpers
// ---------------------------------------------------------------------------

function barAt(bars: AnalysisCandle[], sec: number): AnalysisCandle {
  const b = bars.find((c) => c.timeUtcSec === sec);
  if (!b) throw new Error(`fixture bar ${sec} not found`);
  return b;
}

/** S1: fill timing + S3: spread direction, with EXACT arithmetic. */
function expectNextBarFill(bars: AnalysisCandle[], t: { direction: 'long' | 'short'; signalBarTimeUtcSec: number; entryBarTimeUtcSec: number; entryPrice: number }, tfSec: number) {
  // the fill bar is EXACTLY one bar after the signal bar (never the same bar,
  // never an earlier one — a price known at the decision close cannot be the fill)
  expect(t.entryBarTimeUtcSec - t.signalBarTimeUtcSec).toBe(tfSec);
  const entryBar = barAt(bars, t.entryBarTimeUtcSec);
  const sigBar = barAt(bars, t.signalBarTimeUtcSec);
  if (t.direction === 'long') {
    expect(t.entryPrice).toBeCloseTo(entryBar.open + HALF_OFFSET, 9); // ask + slippage
    expect(t.entryPrice).toBeGreaterThan(entryBar.open);
    // and it is demonstrably NOT the signal bar's own prices
    expect(t.entryPrice).not.toBe(sigBar.open);
    expect(t.entryPrice).not.toBe(sigBar.close);
  } else {
    expect(t.entryPrice).toBeCloseTo(entryBar.open - HALF_OFFSET, 9); // bid − slippage
    expect(t.entryPrice).toBeLessThan(entryBar.open);
    expect(t.entryPrice).not.toBe(sigBar.open);
    expect(t.entryPrice).not.toBe(sigBar.close);
  }
}

/** S2: conservative collision scan — any trade whose exit bar touched BOTH
 *  levels must have resolved to 'stop' (SL first). */
function expectConservativeCollisions(bars: AnalysisCandle[], trades: Array<BacktestTrade | SignalBacktestTrade>) {
  for (const t of trades) {
    const exitBar = barAt(bars, t.exitBarTimeUtcSec);
    const touchedStop = t.direction === 'long' ? exitBar.low <= t.stopLoss : exitBar.high >= t.stopLoss;
    const touchedTarget = t.direction === 'long' ? exitBar.high >= t.target : exitBar.low <= t.target;
    if (touchedStop && touchedTarget) {
      // ambiguity inside one bar → the LOSS is assumed, exit at the stop level
      expect(t.exitReason).toBe('stop');
      expect(t.exitPrice).toBeCloseTo(t.stopLoss, 9);
    }
    if (t.exitReason === 'stop') expect(t.exitPrice).toBeCloseTo(t.stopLoss, 9);
    if (t.exitReason === 'target') expect(t.exitPrice).toBeCloseTo(t.target, 9);
    // exits never precede the entry bar
    expect(t.exitBarTimeUtcSec).toBeGreaterThanOrEqual(t.entryBarTimeUtcSec);
  }
}

// ---------------------------------------------------------------------------
// S1+S3 — signal-engine fills (long dataset + mirrored short dataset)
// ---------------------------------------------------------------------------

describe('S1/S3 — signal-engine backtest: fills come from a LATER bar at the correct spread side', () => {
  const exec = setupRichExecution(EXEC_START);
  const h1 = bullishHtf(Math.ceil((exec.length * M15) / H1S) + 40, EXEC_START - 130 * H1S, H1S);
  const h4 = bullishHtf(160, EXEC_START - 160 * H4S, H4S);

  test('every LONG fill is the next bar\'s open + (half-spread + slippage), exactly', () => {
    const res = runSignalBacktest('XAUUSDm', exec, h1, h4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    expect(res.trades.length).toBeGreaterThan(0);
    expect(res.trades.every((t) => t.direction === 'long')).toBe(true);
    for (const t of res.trades) expectNextBarFill(exec, t, M15);
    expectConservativeCollisions(exec, res.trades);
  });

  test('every SHORT fill (mirrored dataset) is the next bar\'s open − (half-spread + slippage), exactly', () => {
    const mexec = mirror(exec);
    const mh1 = mirror(h1);
    const mh4 = mirror(h4);
    const res = runSignalBacktest('XAUUSDm', mexec, mh1, mh4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    expect(res.trades.length).toBeGreaterThan(0);
    expect(res.trades.every((t) => t.direction === 'short')).toBe(true);
    for (const t of res.trades) expectNextBarFill(mexec, t, M15);
    expectConservativeCollisions(mexec, res.trades);
  });
});

// ---------------------------------------------------------------------------
// S2 — engineered same-entry-bar collision (both levels inside ONE bar)
// ---------------------------------------------------------------------------

describe('S2 — intrabar SL+TP both inside one bar resolves CONSERVATIVELY (SL first)', () => {
  test('signal-engine: an entry bar covering both stop and target closes at the STOP (r = −1)', () => {
    const base = setupRichExecution(EXEC_START);
    const h1 = bullishHtf(Math.ceil((base.length * M15) / H1S) + 40, EXEC_START - 130 * H1S, H1S);
    const h4 = bullishHtf(160, EXEC_START - 160 * H4S, H4S);

    // FROZEN probe fact: the base dataset emits a long setup at signal bar
    // 1791118800 whose hypothetical fill is the NEXT bar 1791119700
    // (open 2659.10, SL 2644.7927, target 2688.1345). Widen THAT entry bar —
    // its own open is untouched, so the decision at the signal bar is unchanged
    // (no look-ahead) — into a bar whose range covers both levels.
    const widened = base.map((b) =>
      b.timeUtcSec === 1791119700
        ? candle(b.timeUtcSec, b.open, 2700, 2640, 2660.2)
        : b,
    );
    const res = runSignalBacktest('XAUUSDm', widened, h1, h4, 2, DEFAULT_SIGNAL_BACKTEST_RULES, SIGNAL_RULES);
    const hit = res.trades.find((t) => t.signalBarTimeUtcSec === 1791118800);
    expect(hit).toBeDefined();
    if (!hit) return;

    // The entry bar covers both levels → the LOSS is assumed, exit at the stop.
    expect(hit.exitReason).toBe('stop');
    expect(hit.exitPrice).toBeCloseTo(hit.stopLoss, 9);
    expect(hit.rMultiple).toBeCloseTo(-1, 9); // a full, single-bar loss — never the target
    // the collision resolved on the ENTRY bar itself (same-bar fill + exit)
    expect(hit.exitBarTimeUtcSec).toBe(hit.entryBarTimeUtcSec);
    // and the entry price is still the untouched next-bar open + costs
    expectNextBarFill(widened, hit, M15);
    expectConservativeCollisions(widened, res.trades);
  });

  test('structure-proxy: an entry bar covering both stop and target closes at the STOP', () => {
    const bars = proxyDataset();
    const res = runBacktest('XAUUSDm', 'M15', M15, bars, 2, DEFAULT_RULES);
    expect(res.trades.length).toBeGreaterThan(0);
    // FROZEN probe fact: first proxy trade fills at bar 1791545400
    // (open 2655.40, SL 2647.6452, target 2671.3295). Widen that bar.
    const widened = bars.map((b) =>
      b.timeUtcSec === 1791545400
        ? candle(b.timeUtcSec, b.open, 2800, 2500, b.open + 0.5)
        : b,
    );
    const res2 = runBacktest('XAUUSDm', 'M15', M15, widened, 2, DEFAULT_RULES);
    const hit = res2.trades.find((t) => t.signalBarTimeUtcSec === 1791544500);
    expect(hit).toBeDefined();
    if (!hit) return;
    expect(hit.exitReason).toBe('stop');
    expect(hit.exitPrice).toBeCloseTo(hit.stopLoss, 9);
    expect(hit.rMultiple).toBeCloseTo(-1, 9);
    expect(hit.exitBarTimeUtcSec).toBe(hit.entryBarTimeUtcSec);
    for (const t of res2.trades) expectNextBarFill(widened, t, M15);
    expectConservativeCollisions(widened, res2.trades);
  });
});

// ---------------------------------------------------------------------------
// S1+S3 — structure-proxy fills
// ---------------------------------------------------------------------------

describe('S1/S3 — structure-proxy backtest: same fill discipline', () => {
  test('every proxy fill is the next bar\'s open ± (half-spread + slippage), exactly', () => {
    const bars = proxyDataset();
    const res = runBacktest('XAUUSDm', 'M15', M15, bars, 2, DEFAULT_RULES);
    expect(res.trades.length).toBeGreaterThan(0);
    for (const t of res.trades) expectNextBarFill(bars, t, M15);
    expectConservativeCollisions(bars, res.trades);
  });
});

// ---------------------------------------------------------------------------
// S4 — documented exit convention
// ---------------------------------------------------------------------------

describe('S4 — exits are at the RAW levels (Phase 9 convention, documented)', () => {
  test('stop exits exit exactly at the stop level; target exits exactly at the target level (no exit-side cost shift)', () => {
    const bars = proxyDataset();
    const res = runBacktest('XAUUSDm', 'M15', M15, bars, 2, DEFAULT_RULES);
    for (const t of res.trades) {
      if (t.exitReason === 'stop') expect(t.exitPrice).toBeCloseTo(t.stopLoss, 9);
      if (t.exitReason === 'target') expect(t.exitPrice).toBeCloseTo(t.target, 9);
    }
  });
});
