/**
 * XAUUSD AI Trading Agent — Deterministic Swing Detection (Phase 4)
 * ----------------------------------------------------------------------------
 * Pure. No side effects. Rules LOCKED (also documented in the README and the
 * persisted calculationConfig):
 *
 *  · A swing requires candles on BOTH sides: `left` closed bars before and
 *    `right` closed bars after the candidate. A swing needing future bars is
 *    confirmed only after the right-side bars have CLOSED — each SwingPoint
 *    preserves its ORIGINAL candle time and the later confirmation instant
 *    (open time of bar index+right + one timeframe).
 *  · Swing HIGH at index i:  high[i] STRICTLY greater than the highs of the
 *    `left` bars before it, and high[i] GREATER-OR-EQUAL to the highs of the
 *    `right` bars after it (asymmetric by design, deterministic).
 *  · Swing LOW at index i:   low[i] strictly lower than the left lows, and
 *    low[i] less-than-or-equal to the right lows.
 *  · TIE RULE (equal neighbouring highs/lows): the EARLIER candle wins. A
 *    later candle with the same high fails the strict-LEFT comparison, so two
 *    adjacent equal highs can never both be swings. Deterministic, tested.
 *  · The currently forming candle is never part of the input (the loader only
 *    supplies closed candles) — no look-ahead by construction. Cutting the
 *    series at any point simply leaves right-side-incomplete swings undetected.
 *  · An outside bar can be both a swing high and a swing low (two points).
 *  · Insufficient history yields an empty list — never a fabricated swing.
 */

import { toCanonicalPrice } from '@/lib/market/validation';
import type { AnalysisCandle, SwingPoint } from './types';

export interface SwingDetectOptions {
  left: number; // bars required LEFT of the candidate (2..8)
  right: number; // bars required RIGHT of the candidate (2..8)
  tfSec: number; // timeframe duration — confirmation instant = (i+right) open + tf
  digits: number | null; // verified symbol digits for canonical level text
}

export interface SwingDetection {
  swings: SwingPoint[]; // chronological by original candle time
  warnings: Array<{ code: string; note: string }>;
}

export function detectSwings(candles: AnalysisCandle[], opts: SwingDetectOptions): SwingDetection {
  const warnings: Array<{ code: string; note: string }> = [];
  const { left, right, tfSec, digits } = opts;

  if (!Number.isInteger(left) || left < 2 || !Number.isInteger(right) || right < 2) {
    warnings.push({ code: 'SWING_WINDOW_SHORT', note: `swing window ${left}/${right} is below the enforced minimum of 2` });
  }

  const n = candles.length;
  const swings: SwingPoint[] = [];

  for (let i = 0; i < n; i++) {
    if (i - left < 0 || i + right > n - 1) continue; // needs candles on both sides

    // --- swing high -----------------------------------------------------
    let isHigh = true;
    for (let j = i - left; j < i; j++) {
      if (!(candles[i].high > candles[j].high)) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      for (let j = i + 1; j <= i + right; j++) {
        if (!(candles[i].high >= candles[j].high)) {
          isHigh = false;
          break;
        }
      }
    }

    // --- swing low -------------------------------------------------------
    let isLow = true;
    for (let j = i - left; j < i; j++) {
      if (!(candles[i].low < candles[j].low)) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      for (let j = i + 1; j <= i + right; j++) {
        if (!(candles[i].low <= candles[j].low)) {
          isLow = false;
          break;
        }
      }
    }

    if (isHigh) {
      swings.push({
        kind: 'high',
        index: i,
        timeUtcSec: candles[i].timeUtcSec,
        confirmedAtUtcSec: candles[i + right].timeUtcSec + tfSec,
        price: candles[i].high,
        priceText: toCanonicalPrice(candles[i].high, digits).text,
      });
    }
    if (isLow) {
      swings.push({
        kind: 'low',
        index: i,
        timeUtcSec: candles[i].timeUtcSec,
        confirmedAtUtcSec: candles[i + right].timeUtcSec + tfSec,
        price: candles[i].low,
        priceText: toCanonicalPrice(candles[i].low, digits).text,
      });
    }
  }

  // Chronological by original time; equal times keep high-before-low order
  // of the same candle (deterministic — matches the push order above).
  swings.sort((a, b) => a.timeUtcSec - b.timeUtcSec || (a.kind === 'high' ? -1 : 1));
  return { swings, warnings };
}
