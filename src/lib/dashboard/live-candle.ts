/**
 * XAUUSD AI Trading Agent — Live forming-candle merge (Task 31-d).
 * ----------------------------------------------------------------------------
 * PURE presentation-layer helper: merges a REAL live broker tick (from the
 * read-only tick-stream relay) into the chart's last candle so the forming
 * bar updates in real time between the 5-minute persisted syncs.
 *
 * Honesty contract:
 *   · The tick is genuine broker data (same Exness feed the bridge serves).
 *   · The merge is CLIENT-SIDE ONLY — it is never persisted, never analysed,
 *     never fed to any engine. The next /api/data/chart fetch (server truth)
 *     fully replaces it.
 *   · An out-of-order or non-finite tick changes NOTHING (fail-closed).
 */

import type { ChartCandlePoint } from '@/lib/dashboard/types';

export type { ChartCandlePoint };

export interface LiveMergeResult {
  /** Merged candle list (new array only when changed; same reference when not). */
  candles: ChartCandlePoint[];
  /** The candle the tick landed in (last candle after merge), null when refused. */
  landed: ChartCandlePoint | null;
  /** True when the tick opened a NEW bar (bar boundary crossed). */
  isNewBar: boolean;
  /** Honest refusal reason (out-of-order tick, bad price, empty chart). */
  refused: string | null;
}

/** Floor an epoch-ms timestamp to the containing bar's open time (UTC sec). */
export function barStartSec(nowMs: number, tfSec: number): number {
  return Math.floor(Math.floor(nowMs / 1000) / tfSec) * tfSec;
}

/**
 * Merge one tick (mid price) into the last chart candle for a timeframe.
 *
 *   · Tick inside the last bar's window → close = mid, high = max, low = min.
 *   · Tick beyond the last bar (new bar opened)  → append a fresh forming
 *     candle {o=h=l=c=mid} at the new bar start.
 *   · Tick older than the last bar / non-finite / empty list → REFUSED
 *     (returns the input array unchanged — never fabricates).
 */
export function mergeTickIntoCandles(
  candles: ChartCandlePoint[],
  mid: number,
  tfSec: number,
  nowMs: number,
): LiveMergeResult {
  if (!Number.isFinite(mid) || mid <= 0) {
    return { candles, landed: null, isNewBar: false, refused: 'invalid-price' };
  }
  if (candles.length === 0) {
    return { candles, landed: null, isNewBar: false, refused: 'empty-chart' };
  }
  const last = candles[candles.length - 1];
  const start = barStartSec(nowMs, tfSec);
  if (start < last.t) {
    // Tick belongs to a bar older than what is on screen — refuse (never
    // rewrite history; server data is the truth for closed bars).
    return { candles, landed: null, isNewBar: false, refused: 'out-of-order' };
  }
  if (start === last.t) {
    const merged: ChartCandlePoint = {
      ...last,
      c: mid,
      h: Math.max(last.h, mid),
      l: Math.min(last.l, mid),
    };
    const next = candles.slice(0, -1);
    next.push(merged);
    return { candles: next, landed: merged, isNewBar: false, refused: null };
  }
  // New bar boundary crossed — append a fresh forming candle from the tick.
  const fresh: ChartCandlePoint = { t: start, o: mid, h: mid, l: mid, c: mid, v: null, forming: true };
  return { candles: [...candles, fresh], landed: fresh, isNewBar: true, refused: null };
}
