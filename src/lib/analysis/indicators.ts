/**
 * XAUUSD AI Trading Agent — Deterministic Indicators (Phase 4)
 * ----------------------------------------------------------------------------
 * Pure functions. No database, no environment, no clock, no LLM. Same input →
 * same output, always. All conventions are LOCKED and documented per series:
 *
 *  EMA  — seed = SMA of the first `period` closes (first value at index
 *         period-1); then EMA_t = close_t·k + EMA_(t-1)·(1−k), k = 2/(period+1).
 *         Warm-up: `period` bars.
 *  RSI  — Wilder. Deltas from close[i]−close[i−1]; seed avgGain/avgLoss =
 *         mean of the first `period` deltas (first value at index `period`,
 *         i.e. period+1 candles); then Wilder smoothing
 *         avg_t = (avg_(t−1)·(period−1) + x_t)/period.
 *         Edge rules (deterministic): avgLoss = 0 & avgGain > 0 → 100;
 *         avgGain = 0 & avgLoss > 0 → 0; both 0 (perfectly flat) → 50 with
 *         warning RSI_FLAT_MARKET.
 *  ATR  — TR[0] = high−low; TR[i] = max(high−low, |high−close[i−1]|,
 *         |low−close[i−1]|). Seed = SMA of first `period` TRs (first value at
 *         index period−1); then Wilder smoothing. Warm-up: `period` bars.
 *  ADX  — Wilder. +DM/−DM from consecutive highs/lows (index ≥ 1). Smoothed
 *         +DM/−DM/TR seeded with SMA over indices 1..period (first value at
 *         index period); then Wilder. DI± = 100·smoothed±DM/smoothedTR
 *         (smoothedTR = 0 → DI = 0, warning DI_ZERO_TR). DX = 100·|DI+−DI−|/
 *         (DI++DI−) (denominator 0 → DX = 0, warning ADX_FLAT_MARKET). ADX
 *         seeded with SMA of the first `period` DX values (first ADX at index
 *         2·period−1); then Wilder. Warm-up: 2·period bars.
 *
 * Non-finite inputs are rejected with INDICATOR_NON_FINITE — NaN/Infinity can
 * never become a valid output. Full float64 precision is carried internally;
 * rounding is a display concern only (done by the UI, never here).
 */

import type { AnalysisCandle } from './types';

export type IndicatorErrorCode = 'INSUFFICIENT_DATA' | 'INDICATOR_NON_FINITE';

export interface IndicatorWarning {
  code: string;
  note: string;
}

/** A full value series aligned to candle indices (null = warm-up region). */
export interface ComputedSeries {
  period: number;
  fromIndex: number | null; // first index carrying a value; null if none at all
  values: Array<number | null>;
  warnings: IndicatorWarning[];
}

export type SeriesResult = { ok: true; series: ComputedSeries } | { ok: false; error: { code: IndicatorErrorCode; detail: string } };

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

function assertFiniteCandles(candles: Array<Pick<AnalysisCandle, 'high' | 'low' | 'close'>>): string | null {
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)) {
      return `candle[${i}] carries a non-finite price (high=${c.high}, low=${c.low}, close=${c.close})`;
    }
  }
  return null;
}

function sma(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// ---------------------------------------------------------------------------
// EMA
// ---------------------------------------------------------------------------

export const EMA_CONVENTION =
  'EMA(seed=SMA of first period closes, first value at index period-1; k=2/(period+1); EMA_t = close_t*k + EMA_(t-1)*(1-k))';

export function emaSeries(closes: number[], period: number): SeriesResult {
  if (!Number.isInteger(period) || period < 1) {
    return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: `invalid period ${period}` } };
  }
  for (const c of closes) {
    if (!Number.isFinite(c)) return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: 'non-finite close in input' } };
  }
  if (closes.length < period) {
    return { ok: false, error: { code: 'INSUFFICIENT_DATA', detail: `EMA${period} needs ≥${period} closes, got ${closes.length}` } };
  }
  const values: Array<number | null> = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  let prev = sma(closes.slice(0, period)); // seed at index period-1
  if (!Number.isFinite(prev)) {
    return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: 'EMA seed is non-finite' } };
  }
  values[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    if (!Number.isFinite(prev)) {
      return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: `EMA${period} produced a non-finite value at index ${i}` } };
    }
    values[i] = prev;
  }
  return { ok: true, series: { period, fromIndex: period - 1, values, warnings: [] } };
}

// ---------------------------------------------------------------------------
// RSI (Wilder)
// ---------------------------------------------------------------------------

export const RSI_CONVENTION =
  'RSI(Wilder): seed avgGain/avgLoss = mean of first period deltas (first value at index period, needs period+1 candles); avg_t = (avg_(t-1)*(period-1) + x_t)/period; avgLoss=0&gain>0→100; avgGain=0&loss>0→0; both 0→50 (flat, warning)';

export function rsiSeries(closes: number[], period = 14): SeriesResult {
  for (const c of closes) {
    if (!Number.isFinite(c)) return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: 'non-finite close in input' } };
  }
  if (closes.length < period + 1) {
    return { ok: false, error: { code: 'INSUFFICIENT_DATA', detail: `RSI${period} needs ≥${period + 1} closes, got ${closes.length}` } };
  }
  const values: Array<number | null> = new Array(closes.length).fill(null);
  const warnings: IndicatorWarning[] = [];

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const rsiAt = (ag: number, al: number): { value: number; flat: boolean } => {
    if (al === 0 && ag === 0) return { value: 50, flat: true }; // perfectly flat market
    if (al === 0) return { value: 100, flat: false };
    if (ag === 0) return { value: 0, flat: false };
    return { value: (100 * ag) / (ag + al), flat: false };
  };

  {
    const { value, flat } = rsiAt(avgGain, avgLoss);
    values[period] = value;
    if (flat) warnings.push({ code: 'RSI_FLAT_MARKET', note: `flat market at index ${period} — RSI defined as 50 (neutral)` });
  }

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) {
      return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: `RSI${period} smoothing produced a non-finite value at index ${i}` } };
    }
    const { value, flat } = rsiAt(avgGain, avgLoss);
    values[i] = value;
    if (!Number.isFinite(value)) {
      return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: `RSI${period} produced a non-finite value at index ${i}` } };
    }
    if (flat) warnings.push({ code: 'RSI_FLAT_MARKET', note: `flat market at index ${i} — RSI defined as 50 (neutral)` });
  }

  return { ok: true, series: { period, fromIndex: period, values, warnings } };
}

// ---------------------------------------------------------------------------
// ATR (Wilder)
// ---------------------------------------------------------------------------

export const ATR_CONVENTION =
  'ATR(Wilder): TR[0]=high-low; TR[i]=max(high-low, |high-close[i-1]|, |low-close[i-1]|); seed=SMA of first period TRs (first value at index period-1); ATR_t = (ATR_(t-1)*(period-1) + TR_t)/period';

function trueRanges(candles: Array<Pick<AnalysisCandle, 'high' | 'low' | 'close'>>): number[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(candles[0].high - candles[0].low);
      continue;
    }
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return tr;
}

export function atrSeries(candles: Array<Pick<AnalysisCandle, 'high' | 'low' | 'close'>>, period = 14): SeriesResult {
  const finite = assertFiniteCandles(candles);
  if (finite) return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: finite } };
  if (candles.length < period) {
    return { ok: false, error: { code: 'INSUFFICIENT_DATA', detail: `ATR${period} needs ≥${period} candles, got ${candles.length}` } };
  }
  const tr = trueRanges(candles);
  const values: Array<number | null> = new Array(candles.length).fill(null);
  let prev = sma(tr.slice(0, period));
  if (!Number.isFinite(prev)) {
    return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: 'ATR seed is non-finite' } };
  }
  values[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    if (!Number.isFinite(prev)) {
      return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: `ATR${period} produced a non-finite value at index ${i}` } };
    }
    values[i] = prev;
  }
  return { ok: true, series: { period, fromIndex: period - 1, values, warnings: [] } };
}

// ---------------------------------------------------------------------------
// ADX (Wilder) with directional components
// ---------------------------------------------------------------------------

export const ADX_CONVENTION =
  'ADX(Wilder): +DM/−DM from consecutive highs/lows (index≥1); smoothed +DM/−DM/TR seeded with SMA over indices 1..period (first at index period), then Wilder; DI±=100·s±DM/sTR (sTR=0→0, warning); DX=100·|DI+−DI−|/(DI++DI−) (den 0→0, warning); ADX seed=SMA of first period DX (first at index 2·period−1), then Wilder';

export interface AdxComputed extends ComputedSeries {
  lastDiPlus: number | null;
  lastDiMinus: number | null;
}

export type AdxResult = { ok: true; series: AdxComputed } | { ok: false; error: { code: IndicatorErrorCode; detail: string } };

export function adxSeries(candles: Array<Pick<AnalysisCandle, 'high' | 'low' | 'close'>>, period = 14): AdxResult {
  const finite = assertFiniteCandles(candles);
  if (finite) return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: finite } };
  // First ADX at index 2*period−1 → needs 2*period candles.
  if (candles.length < 2 * period) {
    return { ok: false, error: { code: 'INSUFFICIENT_DATA', detail: `ADX${period} needs ≥${2 * period} candles, got ${candles.length}` } };
  }

  const n = candles.length;
  const tr = trueRanges(candles);

  // Directional movement arrays indexed like candles (0 unused).
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  // Wilder smoothing, seeded with SMA over indices 1..period.
  const warnings: IndicatorWarning[] = [];
  const sTR: number[] = new Array(n).fill(0);
  const sPDM: number[] = new Array(n).fill(0);
  const sMDM: number[] = new Array(n).fill(0);
  {
    let trSum = 0;
    let pSum = 0;
    let mSum = 0;
    for (let i = 1; i <= period; i++) {
      trSum += tr[i];
      pSum += plusDM[i];
      mSum += minusDM[i];
    }
    sTR[period] = trSum / period;
    sPDM[period] = pSum / period;
    sMDM[period] = mSum / period;
  }
  for (let i = period + 1; i < n; i++) {
    sTR[i] = (sTR[i - 1] * (period - 1) + tr[i]) / period;
    sPDM[i] = (sPDM[i - 1] * (period - 1) + plusDM[i]) / period;
    sMDM[i] = (sMDM[i - 1] * (period - 1) + minusDM[i]) / period;
  }

  // DI± and DX series (DX defined from index `period`).
  const dxValues: Array<number | null> = new Array(n).fill(null);
  let lastDiPlus: number | null = null;
  let lastDiMinus: number | null = null;
  for (let i = period; i < n; i++) {
    const str = sTR[i];
    let diPlus: number;
    let diMinus: number;
    if (str === 0) {
      diPlus = 0;
      diMinus = 0;
      warnings.push({ code: 'DI_ZERO_TR', note: `zero true-range at index ${i} — DI± defined as 0` });
    } else {
      diPlus = (100 * sPDM[i]) / str;
      diMinus = (100 * sMDM[i]) / str;
    }
    if (i === n - 1) {
      lastDiPlus = diPlus;
      lastDiMinus = diMinus;
    }
    const den = diPlus + diMinus;
    const dx = den === 0 ? 0 : (100 * Math.abs(diPlus - diMinus)) / den;
    if (den === 0) {
      warnings.push({ code: 'ADX_FLAT_MARKET', note: `DI+ + DI− = 0 at index ${i} — DX defined as 0` });
    }
    if (!Number.isFinite(dx)) {
      return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: `ADX${period} produced a non-finite DX at index ${i}` } };
    }
    dxValues[i] = dx;
  }

  // ADX: seed = SMA of first `period` DX values (indices period..2·period−1).
  const values: Array<number | null> = new Array(n).fill(null);
  const seedSlice: number[] = [];
  for (let i = period; i <= 2 * period - 1; i++) {
    const v = dxValues[i];
    if (v === null) {
      return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: `ADX${period} seed window contains a missing DX at index ${i}` } };
    }
    seedSlice.push(v);
  }
  let prev = sma(seedSlice);
  if (!Number.isFinite(prev)) {
    return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: 'ADX seed is non-finite' } };
  }
  values[2 * period - 1] = prev;
  for (let i = 2 * period; i < n; i++) {
    const dx = dxValues[i];
    if (dx === null) {
      return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: `ADX${period} smoothing hit a missing DX at index ${i}` } };
    }
    prev = (prev * (period - 1) + dx) / period;
    if (!Number.isFinite(prev)) {
      return { ok: false, error: { code: 'INDICATOR_NON_FINITE', detail: `ADX${period} produced a non-finite value at index ${i}` } };
    }
    values[i] = prev;
  }

  return { ok: true, series: { period, fromIndex: 2 * period - 1, values, warnings, lastDiPlus, lastDiMinus } };
}
