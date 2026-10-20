/**
 * Phase 14, Task 34-f — A6 Momentum Agent tests.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: every candle below is a SYNTHETIC hand-built fixture
 * constructed to exercise specific momentum paths. They are never
 * presented as broker data.
 *
 * Fixture invariants (hand-verified row by row):
 *   · M5 grid: t = T0 + i·300, canonical text x.xx (the agent reads no
 *     text fields — they exist for the AnalysisCandle contract).
 *   · EXACT-ATR TRICK: every ramp candle OPENS at the previous close and
 *     spans EXACTLY its step (full marubozu) → every true range is
 *     exactly the step → on the span-2 ramps ATR(14) = 2.00 EXACTLY, so
 *     displacementAtr 1.0 → threshold 2.00 exact and a full-span body
 *     2.00 yields displacement strength EXACTLY 1 (component exactly ±30).
 *   · RSI exactness: a strictly rising ramp keeps avgLoss EXACTLY 0 →
 *     RSI(14) = 100 exactly; the falling mirror → RSI = 0 exactly; flat
 *     closes → RSI 50 (the locked flat-market convention).
 *   · EMA margins: a perfect linear ramp puts both EMAs on their
 *     steady-state lines from their seed indices (EMA9 = close ∓ 8,
 *     EMA21 = close ∓ 20 for the ±2 ramps) — the 40-bar ramps align
 *     BULL/BEAR by hand-checked margins of 8–20 price units, far beyond
 *     any float noise.
 *
 * Hand-computed mixed fixture (ramp + one −10 marubozu at index 40):
 *   fast[40] = 2671.6 > slow[40] = 2660.909… but close 2670 < fast →
 *   MIXED (EMA 0) · RSI = 2600/36 ≈ 72.222 → +30×31/36 = +930/36 ·
 *   ATR[40] = 36/14 ≈ 2.571 → displacement 10/(36/14) = 35/9 ≈ 3.889 →
 *   −30 · score = 930/36 − 30 = −25/6 ≈ −4.167.
 */

import { describe, expect, test } from 'bun:test';
import { atrSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { readMomentum } from '@/lib/signal/ict/agents/momentum';

const T0 = 1_791_979_200; // Wednesday 2026-10-14T12:00:00Z (fixed test clock, M5-aligned)
const TF = 300; // M5

const PARAMS = {
  emaFastPeriod: 9,
  emaSlowPeriod: 21,
  rsiPeriod: 14,
  atrPeriod: 14,
  displacementAtr: 1.0,
};

/** The honest all-null neutral (locked rule 7). */
const NULL_READ = {
  score: 0,
  emaAligned: null,
  rsi: null,
  atr: null,
  atrRegime: null,
  displacementStrength: null,
};

function candle(i: number, o: number, h: number, l: number, c: number): AnalysisCandle {
  return {
    timeUtcSec: T0 + i * TF,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: null,
    openText: o.toFixed(2),
    highText: h.toFixed(2),
    lowText: l.toFixed(2),
    closeText: c.toFixed(2),
  };
}

/** `count` marubozu candles stepping `step` per bar (span = |step|), open = prev close. */
function ramp(count: number, startIndex: number, start: number, step: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  let o = start;
  for (let i = 0; i < count; i++) {
    const c = o + step;
    out.push(step >= 0 ? candle(startIndex + i, o, c, o, c) : candle(startIndex + i, o, o, c, c));
    o = c;
  }
  return out;
}

/** Flat candles: open = close = level with ±1 wicks → span exactly 2, body 0. */
function flat(count: number, level: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) out.push(candle(i, level, level + 1, level - 1, level));
  return out;
}

describe('A6 momentum — trend alignment and exact scoring', () => {
  test('40-bar +2 ramp → BULL alignment, RSI 100, displacement 1×ATR → score exactly +100', () => {
    const read = readMomentum(ramp(40, 0, 2600, 2), PARAMS);
    expect(read.emaAligned).toBe('BULL');
    expect(read.rsi).toBe(100);
    expect(read.atr).toBe(2);
    expect(read.atrRegime).toBe('NORMAL');
    expect(read.displacementStrength).toBe(1);
    expect(read.score).toBe(100); // 40 (EMA) + 30 (RSI 100) + 30 (body 2 = 1×ATR 2)
  });

  test('40-bar −2 ramp → BEAR mirror, RSI 0 → score exactly −100', () => {
    const read = readMomentum(ramp(40, 0, 2800, -2), PARAMS);
    expect(read.emaAligned).toBe('BEAR');
    expect(read.rsi).toBe(0);
    expect(read.atr).toBe(2);
    expect(read.atrRegime).toBe('NORMAL');
    expect(read.displacementStrength).toBe(1);
    expect(read.score).toBe(-100); // −40 − 30 (RSI 0) − 30 (displacement)
  });

  test('flat market → MIXED alignment (fast = slow = close), RSI 50, zero body → score 0', () => {
    const read = readMomentum(flat(40, 2650), PARAMS);
    expect(read.emaAligned).toBe('MIXED');
    expect(read.rsi).toBe(50);
    expect(read.atr).toBe(2);
    expect(read.atrRegime).toBe('NORMAL');
    expect(read.displacementStrength).toBe(0);
    expect(read.score).toBe(0);
  });

  test('ramp then a drop below the fast EMA → MIXED, RSI vs displacement cancel to a small negative', () => {
    const rows = [...ramp(40, 0, 2600, 2), candle(40, 2680, 2680, 2670, 2670)];
    const read = readMomentum(rows, PARAMS);
    expect(read.emaAligned).toBe('MIXED');
    expect(read.rsi).toBeCloseTo(2600 / 36, 12); // ≈ 72.222 — one −10 delta in a pure +2 ramp
    expect(read.atr).toBeCloseTo(36 / 14, 12); // (2×13 + 10)/14
    expect(read.atrRegime).toBe('NORMAL'); // 2.571 < 1.4 × median 2.8
    expect(read.displacementStrength).toBeCloseTo(35 / 9, 12); // 10 / (36/14), unclamped
    expect(read.score).toBeCloseTo(-25 / 6, 12); // 0 (MIXED) + 930/36 (RSI) − 30 (displacement)
  });
});

describe('A6 momentum — warm-up honesty (never fabricated)', () => {
  test('empty input → the all-null honest neutral', () => {
    expect(readMomentum([], PARAMS)).toEqual(NULL_READ);
  });

  test('5 candles (every indicator in warm-up) → all-null read, score 0', () => {
    expect(readMomentum(ramp(5, 0, 2600, 2), PARAMS)).toEqual(NULL_READ);
  });

  test('12 candles — a lone fast EMA must not produce alignment; nothing scores', () => {
    // EMA9 is warm (values at 8..11) but EMA21/RSI14/ATR14 are not — the
    // half EMA pair yields emaAligned null and the read stays neutral.
    expect(readMomentum(ramp(12, 0, 2600, 2), PARAMS)).toEqual(NULL_READ);
  });

  test('15 candles — RSI lands exactly on the decision bar; ATR median still short → exact 60', () => {
    // RSI(14) first value = index 14 = the decision bar (100); ATR(14) has
    // only 2 non-null values (< 3) → atrRegime null; displacement body 2 =
    // 1×ATR 2 → +30. Slow EMA missing → EMA component 0. Score = 30 + 30.
    const read = readMomentum(ramp(15, 0, 2600, 2), PARAMS);
    expect(read).toEqual({
      score: 60,
      emaAligned: null,
      rsi: 100,
      atr: 2,
      atrRegime: null,
      displacementStrength: 1,
    });
  });

  test('both EMAs unavailable (big periods) → honest neutral: rsi/atr reported, score forced 0', () => {
    const read = readMomentum(ramp(20, 0, 2600, 2), { ...PARAMS, emaFastPeriod: 30, emaSlowPeriod: 50 });
    expect(read).toEqual({
      score: 0, // locked honest neutral — no trend score without the EMA spine
      emaAligned: null,
      rsi: 100, // still reported honestly
      atr: 2,
      atrRegime: 'NORMAL', // 7 non-null ATR values, all 2
      displacementStrength: 1, // real, but it must not leak into the score
    });
  });
});

describe('A6 momentum — ATR regime', () => {
  test('volatility explosion at the end (span 2 ×30 → span 10 ×6) → HIGH', () => {
    const rows = [...ramp(30, 0, 2600, 2), ...ramp(6, 30, 2660, 10)];
    const read = readMomentum(rows, PARAMS);

    const atr = atrSeries(rows, 14);
    expect(atr.ok).toBe(true);
    if (!atr.ok) return;
    const values = atr.series.values.filter((v): v is number => v !== null);
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]; // 23 values (odd) → exact middle
    const atrLast = atr.series.values[rows.length - 1];
    expect(atrLast).not.toBeNull();

    expect(read.atr).toBe(atrLast); // the agent reports the shared indicator value verbatim
    expect(read.atrRegime).toBe('HIGH');
    expect(read.atr).not.toBeNull();
    expect((read.atr as number) > 1.4 * median).toBe(true); // fixture sanity: ≈4.87 > 2.8
  });

  test('quiet tail after a wild start (span 10 ×14 → span 1 ×24) → LOW', () => {
    const rows = [...ramp(14, 0, 2600, 10), ...ramp(24, 14, 2740, 1)];
    const read = readMomentum(rows, PARAMS);

    const atr = atrSeries(rows, 14);
    expect(atr.ok).toBe(true);
    if (!atr.ok) return;
    const values = atr.series.values.filter((v): v is number => v !== null);
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]; // 25 values (odd)
    const atrLast = atr.series.values[rows.length - 1];
    expect(atrLast).not.toBeNull();

    expect(read.atr).toBe(atrLast);
    expect(read.atrRegime).toBe('LOW');
    expect(read.atr).not.toBeNull();
    expect((read.atr as number) < 0.7 * median).toBe(true); // fixture sanity: ≈2.52 < ≈3.29
  });

  test('stable spans → NORMAL', () => {
    const read = readMomentum(ramp(30, 0, 2800, -2), PARAMS);
    expect(read.atr).toBe(2);
    expect(read.atrRegime).toBe('NORMAL'); // ATR = median = 2
  });
});

describe('A6 momentum — determinism', () => {
  test('identical input yields deeply identical reads (bull ramp)', () => {
    const input = ramp(40, 0, 2600, 2);
    expect(readMomentum(input, PARAMS)).toEqual(readMomentum(input, PARAMS));
  });

  test('identical input yields deeply identical reads (mixed drop fixture)', () => {
    const input = [...ramp(40, 0, 2600, 2), candle(40, 2680, 2680, 2670, 2670)];
    expect(readMomentum(input, PARAMS)).toEqual(readMomentum(input, PARAMS));
  });
});
