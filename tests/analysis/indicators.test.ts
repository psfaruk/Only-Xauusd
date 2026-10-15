/**
 * AUTOMATED TESTS — Indicators (Phase 4, spec §9 Indicators).
 *
 * Every expected value below is HAND-COMPUTED with the full derivation
 * written in the comments — these are independent reference cases, not
 * re-implementations of the production code.
 *
 * MOCK DISCLOSURE: all price series here are SYNTHETIC test data — never
 * real broker data.
 */
import { describe, expect, test } from 'bun:test';
import {
  adxSeries,
  atrSeries,
  emaSeries,
  rsiSeries,
} from '@/lib/analysis/indicators';
import type { AnalysisCandle } from '@/lib/analysis/types';

const toCandles = (highs: number[], lows: number[]): AnalysisCandle[] =>
  highs.map((h, i) => ({
    timeUtcSec: 1_791_979_200 + i * 300,
    open: lows[i] + (h - lows[i]) * 0.25,
    high: h,
    low: lows[i],
    close: lows[i] + (h - lows[i]) * 0.5,
    volume: null,
    openText: String(lows[i] + (h - lows[i]) * 0.25),
    highText: String(h),
    lowText: String(lows[i]),
    closeText: String(lows[i] + (h - lows[i]) * 0.5),
  }));

// ---------------------------------------------------------------------------
// EMA — hand-computed against the linear ramp 1..N
// ---------------------------------------------------------------------------

describe('indicators — EMA (hand-computed references)', () => {
  test('linear ramp 1..40, period 20: seed SMA = 10.5 exactly; then closed form EMA_n = (n+1) − 9.5', () => {
    // Derivation (k = 2/21):
    //   seed (index 19) = SMA(1..20) = 210/20 = 10.5                     ← exact
    //   EMA at index 20 (close 21) = 10.5 + k·(21 − 10.5)
    //                               = 10.5 + (2/21)·10.5 = 10.5 + 1 = 11.5
    //   On the ramp, close_t − EMA_(t−1) stays 10.5 forever, so every step
    //   adds exactly k·10.5 = 1.0  →  EMA_n = (n+1) − 9.5.
    const closes = Array.from({ length: 40 }, (_, i) => i + 1);
    const r = emaSeries(closes, 20);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.series.values;
    expect(r.series.fromIndex).toBe(19);
    for (let i = 0; i <= 18; i++) expect(v[i]).toBeNull(); // warm-up region
    expect(v[19]).toBe(10.5); // exact — 210/20
    expect(v[20]).toBeCloseTo(11.5, 12);
    expect(v[21]).toBeCloseTo(12.5, 12);
    expect(v[22]).toBeCloseTo(13.5, 12);
    expect(v[25]).toBeCloseTo(16.5, 12); // 26 − 9.5
    expect(v[39]).toBeCloseTo(30.5, 12); // 40 − 9.5 (last bar)
  });

  test('constant series: EMA equals the constant at every value index', () => {
    const closes = new Array(30).fill(2650.32);
    const r = emaSeries(closes, 20);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 19; i < 30; i++) {
      expect(r.series.values[i]).toBeCloseTo(2650.32, 10);
    }
  });

  test('insufficient history → INSUFFICIENT_DATA (needs ≥ 20)', () => {
    const r = emaSeries([1, 2, 3], 20);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INSUFFICIENT_DATA');
    expect(r.error.detail).toContain('≥20');
  });

  test('non-finite close → INDICATOR_NON_FINITE (never a valid output)', () => {
    const closes = Array.from({ length: 25 }, (_, i) => (i === 5 ? Number.NaN : i + 1));
    const r = emaSeries(closes, 20);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INDICATOR_NON_FINITE');
  });
});

// ---------------------------------------------------------------------------
// RSI — hand-computed Wilder references
// ---------------------------------------------------------------------------

describe('indicators — RSI (hand-computed references)', () => {
  test('alternating ±1: seed 50 exactly; +1 bar → 100·7.5/14; −1 bar → 100·97.5/196', () => {
    // closes alternate 100, 101, 100, … → deltas i=1..14: +1,−1 × 7 each
    //   seed (index 14): avgGain = avgLoss = 0.5 → RSI = 100·0.5/1 = 50  ← exact
    //   index 15 (delta +1): avgGain = (0.5·13+1)/14 = 7.5/14
    //                        avgLoss = (0.5·13+0)/14 = 6.5/14
    //                        RSI = 100·(7.5/14)/((7.5+6.5)/14) = 100·7.5/14 = 53.571428…
    //   index 16 (delta −1): avgGain = (7.5/14·13)/14 = 97.5/196
    //                        avgLoss = (6.5/14·13+1)/14 = 98.5/196
    //                        RSI = 100·97.5/(97.5+98.5) = 9750/196 = 49.744897…
    const closes = Array.from({ length: 20 }, (_, i) => 100 + (i % 2));
    const r = rsiSeries(closes, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.series.values;
    expect(r.series.fromIndex).toBe(14);
    expect(v[14]).toBe(50); // exact
    expect(v[15]).toBeCloseTo((100 * 7.5) / 14, 12); // 53.5714285714…
    expect(v[16]).toBeCloseTo(9750 / 196, 12); // 49.7448979591…
  });

  test('strictly rising → RSI exactly 100 on every value index (avgLoss = 0 branch)', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const r = rsiSeries(closes, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 14; i < 30; i++) expect(r.series.values[i]).toBe(100);
  });

  test('strictly falling → RSI exactly 0 (avgGain = 0 branch)', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 200 - i);
    const r = rsiSeries(closes, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 14; i < 30; i++) expect(r.series.values[i]).toBe(0);
  });

  test('perfectly flat market → RSI 50 with RSI_FLAT_MARKET warning (defined, never guessed)', () => {
    const closes = new Array(30).fill(100);
    const r = rsiSeries(closes, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.series.values[29]).toBe(50);
    expect(r.series.warnings.some((w) => w.code === 'RSI_FLAT_MARKET')).toBe(true);
  });

  test('insufficient → needs ≥ 15 candles', () => {
    const r = rsiSeries(new Array(14).fill(100), 14);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INSUFFICIENT_DATA');
  });
});

// ---------------------------------------------------------------------------
// ATR — hand-computed references
// ---------------------------------------------------------------------------

describe('indicators — ATR (hand-computed references)', () => {
  test('constant true range 2.0 → ATR exactly 2 at every value index', () => {
    // candles: high = 52, low = 50, close = 50 → TR[i] = max(2, |52−50|, 0) = 2
    const candles = toCandles(new Array(20).fill(52), new Array(20).fill(50));
    const r = atrSeries(candles, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.series.fromIndex).toBe(13);
    expect(r.series.values[13]).toBe(2); // seed = SMA(14×2) = 2 exact
    expect(r.series.values[19]).toBe(2); // (2·13+2)/14 = 28/14 = 2 exact
  });

  test('mixed TRs: seed = 29/14, then (29/14·13 + 5)/14 = 447/196', () => {
    // TR series by design (close = 50 CONSTANT, low = 50, high = 50+TR →
    // TR[i] = max(TR_i, |high−pc| = TR_i, 0) = TR_i exactly):
    //   [2,1,3,2,4,1,2,3,1,2,2,1,3,2] (14 values, sum = 29) then TR[14] = 5
    //   seed ATR (index 13) = 29/14 = 2.0714285714…
    //   ATR (index 14) = (29/14·13 + 5)/14 = (377 + 70)/196 = 447/196 = 2.2806122448…
    const trs = [2, 1, 3, 2, 4, 1, 2, 3, 1, 2, 2, 1, 3, 2, 5];
    const candles: AnalysisCandle[] = trs.map((t, i) => ({
      timeUtcSec: 1_791_979_200 + i * 300,
      open: 50,
      high: 50 + t,
      low: 50,
      close: 50, // constant close → pc = 50 → TR[i] = TR_i exactly
      volume: null,
      openText: '50',
      highText: String(50 + t),
      lowText: '50',
      closeText: '50',
    }));
    const r = atrSeries(candles, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.series.values[13]).toBeCloseTo(29 / 14, 12);
    expect(r.series.values[14]).toBeCloseTo(447 / 196, 12);
  });

  test('insufficient → needs ≥ 14', () => {
    const r = atrSeries(toCandles([52], [50]), 14);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INSUFFICIENT_DATA');
  });
});

// ---------------------------------------------------------------------------
// ADX — hand-computed references
// ---------------------------------------------------------------------------

describe('indicators — ADX (hand-computed references)', () => {
  test('constant directional trend (+DM = TR): DI+ = 100, DI− = 0, DX = 100 → ADX exactly 100', () => {
    // Design (d = 1), close = HIGH, open = LOW so that pc = previous high:
    //   candle i: high = 101+i, low = 100+i, close = 101+i
    //   up = 1, down = −1 → +DM = 1, −DM = 0; pc = 100+i → TR = 1
    //   → smoothed +DM = smoothed TR → DI+ = 100·sDM/sTR = 100, DI− = 0
    //   → DX = 100·|100−0|/(100+0) = 100 for every index → ADX = 100 everywhere.
    const n = 32;
    const candles: AnalysisCandle[] = Array.from({ length: n }, (_, i) => ({
      timeUtcSec: 1_791_979_200 + i * 300,
      open: 100 + i,
      high: 101 + i,
      low: 100 + i,
      close: 101 + i, // close at high → pc = previous high → TR = 1
      volume: null,
      openText: String(100 + i),
      highText: String(101 + i),
      lowText: String(100 + i),
      closeText: String(101 + i),
    }));
    const r = adxSeries(candles, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.series.fromIndex).toBe(27); // 2·14 − 1
    expect(r.series.values[27]).toBe(100);
    expect(r.series.values[31]).toBe(100);
    expect(r.series.lastDiPlus).toBe(100);
    expect(r.series.lastDiMinus).toBe(0);
    expect(r.series.warnings.length).toBe(0); // no zero-denominator encountered
  });

  test('flat market: DX 0/0 → 0 with ADX_FLAT_MARKET warning; ADX = 0', () => {
    const candles = toCandles(new Array(32).fill(102), new Array(32).fill(100));
    // identical candles: up = down = 0 → ±DM = 0; TR = 2 → DI± = 0 → DX = 0/0
    const r = adxSeries(candles, 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.series.values[31]).toBe(0);
    expect(r.series.lastDiPlus).toBe(0);
    expect(r.series.lastDiMinus).toBe(0);
    expect(r.series.warnings.some((w) => w.code === 'ADX_FLAT_MARKET')).toBe(true);
  });

  test('insufficient → needs ≥ 28 candles (first ADX at index 27)', () => {
    const r = adxSeries(toCandles(new Array(27).fill(102), new Array(27).fill(100)), 14);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INSUFFICIENT_DATA');
    expect(r.error.detail).toContain('≥28');
  });

  test('non-finite input → INDICATOR_NON_FINITE', () => {
    const highs = new Array(30).fill(102);
    highs[7] = Number.POSITIVE_INFINITY;
    const r = adxSeries(toCandles(highs, new Array(30).fill(100)), 14);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INDICATOR_NON_FINITE');
  });
});

// ---------------------------------------------------------------------------
// Determinism — identical input, identical output
// ---------------------------------------------------------------------------

describe('indicators — stable output for identical input', () => {
  test('all four indicator families are byte-stable across repeated calls', () => {
    const highs = Array.from({ length: 60 }, (_, i) => 100 + (i % 9) + (i % 3));
    const lows = highs.map((h) => h - 4);
    const candles = toCandles(highs, lows);
    const closes = candles.map((c) => c.close);
    const once = JSON.stringify([emaSeries(closes, 20), rsiSeries(closes, 14), atrSeries(candles, 14), adxSeries(candles, 14)]);
    const twice = JSON.stringify([emaSeries(closes, 20), rsiSeries(closes, 14), atrSeries(candles, 14), adxSeries(candles, 14)]);
    expect(once).toBe(twice);
  });
});
