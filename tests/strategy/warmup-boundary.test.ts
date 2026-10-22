/**
 * PHASE 4 — INDICATOR WARM-UP BOUNDARY TESTS (Task 42-S3).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic numeric series — never real broker data.
 *
 * Existing coverage NOT duplicated here (see tests/analysis/indicators.test.ts):
 * the INSUFFICIENT_DATA side of each family (one bar short), non-finite input
 * rejection, and hand-computed value references.
 *
 * What this file adds (the boundary + fail-closed seams):
 *   · the warm-up region is EXACTLY null (never garbage, never 0) up to
 *     fromIndex-1, and the first value at fromIndex is finite — for all four
 *     families at their exact minimum sufficient length;
 *   · invalid period inputs are rejected with an explicit error — never a
 *     computed value;
 *   · the BASELINE ENGINE converts warm-up-incomplete indicators into
 *     BLOCKED / INDICATOR_WARMUP with NO levels (fail-closed) — the engine
 *     never decides on partial indicator data.
 */

// Hermeticity (Task 44 order-dependence fix): imports @/lib/signal/rules →
// @/lib/config. Setup must run FIRST so bun's .env auto-load can never
// poison the process-wide config cache with the real MT5_BRIDGE_URL before
// the fail-closed tests/market/* assertions.
import '../market/helpers/setup';
import { describe, expect, test } from 'bun:test';
import { adxSeries, atrSeries, emaSeries, rsiSeries } from '@/lib/analysis/indicators';
import { evaluateSignal } from '@/lib/signal/core';
import { buildStrategyRules } from '@/lib/signal/rules';
import type { Timeframe } from '@/lib/market/types';
import type { AnalysisCandle } from '@/lib/analysis/types';
import type { SignalWindow } from '@/lib/signal/types';

const M15 = 900;
const H1S = 3600;
const H4S = 14400;
const START = 1_791_000_000;

function candle(t: number, o: number, h: number, l: number, c: number): AnalysisCandle {
  return {
    timeUtcSec: t, open: o, high: h, low: l, close: c, volume: null,
    openText: o.toFixed(2), highText: h.toFixed(2), lowText: l.toFixed(2), closeText: c.toFixed(2),
  };
}

/** Strictly ascending 1..n closes with 0.5-high/0.5-low wicks (deterministic). */
function rampBars(n: number, startSec = START, tfSec = M15): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < n; i++) {
    const c = 2600 + i;
    out.push(candle(startSec + i * tfSec, c - 0.5, c + 0.5, c - 1.0, c));
  }
  return out;
}

describe('Phase 4 warm-up — the warm-up region is EXACTLY null, never garbage', () => {
  test('EMA(20): values[..18] null, values[19] finite at the exact minimum length 20', () => {
    const closes = rampBars(20).map((c) => c.close);
    const r = emaSeries(closes, 20);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.series.fromIndex).toBe(19);
    for (let i = 0; i < 19; i++) expect(r.series.values[i]).toBeNull(); // null, not 0/NaN
    const first = r.series.values[19];
    expect(first).not.toBeNull();
    expect(Number.isFinite(first as number)).toBe(true);
    expect(first).toBeCloseTo(2609.5, 10); // SMA(0..19) of 2600..2619
  });

  test('RSI(14): values[..13] null, values[14] finite at the exact minimum length 15', () => {
    const closes = rampBars(15).map((c) => c.close); // strictly rising → RSI 100 branch
    const r = rsiSeries(closes, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.series.fromIndex).toBe(14);
    for (let i = 0; i < 14; i++) expect(r.series.values[i]).toBeNull();
    expect(r.series.values[14]).toBe(100); // strictly rising, avgLoss = 0 → deterministic 100
  });

  test('ATR(14): values[..12] null, values[13] finite at the exact minimum length 14', () => {
    const bars = rampBars(14); // constant TR = 1.5 per bar (high-low) except gaps
    const r = atrSeries(bars, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.series.fromIndex).toBe(13);
    for (let i = 0; i < 13; i++) expect(r.series.values[i]).toBeNull();
    const first = r.series.values[13];
    expect(first).not.toBeNull();
    expect(Number.isFinite(first as number)).toBe(true);
  });

  test('ADX(14): values[..26] null, values[27] finite at the exact minimum length 28', () => {
    const bars = rampBars(28);
    const r = adxSeries(bars, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.series.fromIndex).toBe(27);
    for (let i = 0; i < 27; i++) expect(r.series.values[i]).toBeNull();
    const first = r.series.values[27];
    expect(first).not.toBeNull();
    expect(Number.isFinite(first as number)).toBe(true);
    // ramp: every bar makes a higher high, +DM = TR path → ADX pinned in indicators.test.ts
  });
});

describe('Phase 4 warm-up — invalid periods are rejected, never computed', () => {
  const closes = rampBars(40).map((c) => c.close);
  test('EMA: period 0 / -3 / 2.5 → explicit error, ok:false', () => {
    for (const p of [0, -3, 2.5]) {
      const r = emaSeries(closes, p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INDICATOR_NON_FINITE');
    }
  });
  test('RSI: period 0 → error; ATR: period 0.5 → error; ADX: period -1 → error', () => {
    expect(rsiSeries(closes, 0).ok).toBe(false);
    expect(atrSeries(rampBars(40), 0.5).ok).toBe(false);
    expect(adxSeries(rampBars(40), -1).ok).toBe(false);
  });
});

describe('Phase 4 warm-up — the baseline engine fails CLOSED on incomplete indicators', () => {
  test('a window that passes bar-count gates but cannot warm EMA50 → BLOCKED INDICATOR_WARMUP, no levels', () => {
    // 25 closed M15 bars with minExecutionBars=10 (passes the bar-count gate)
    // but emaPeriod=50 (default) cannot warm — the engine must refuse.
    const exec: AnalysisCandle[] = rampBars(25);
    const rules = {
      ...buildStrategyRules(),
      windowBars: 300,
      minExecutionBars: 10,
      minH1Bars: 10,
      minH4Bars: 10,
      maxSpreadPrice: 10,
    };
    const h1: SignalWindow = { timeframe: 'H1', candles: rampBars(40, START - 40 * H1S, H1S), source: 'bridge-mt5' };
    const h4: SignalWindow = { timeframe: 'H4', candles: rampBars(40, START - 40 * H4S, H4S), source: 'bridge-mt5' };
    const ev = evaluateSignal({
      symbol: 'XAUUSDm',
      digits: 2,
      execution: { timeframe: 'M15' as Timeframe, candles: exec, source: 'bridge-mt5' },
      h1,
      h4,
      referencePrice: exec[exec.length - 1].close,
      spreadPrice: 0.24,
      nowUtcSec: exec[exec.length - 1].timeUtcSec + M15,
      rules,
    });
    expect(ev.outcome).toBe('BLOCKED');
    expect(ev.reasonCodes).toContain('INDICATOR_WARMUP');
    expect(ev.levels).toBeNull(); // never a fabricated level on partial data
  });
});
