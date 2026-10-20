/**
 * Live forming-candle merge — pure helper tests (Task 31-d).
 * Presentation-layer only: the merge must NEVER fabricate, never rewrite a
 * closed bar, and always defer to server truth on the next fetch.
 */

import { describe, expect, test } from 'bun:test';
import { barStartSec, mergeTickIntoCandles, type ChartCandlePoint } from '@/lib/dashboard/live-candle';

const M15 = 900;
const M1 = 60;

function base(): ChartCandlePoint[] {
  // bar open times are exact multiples of the 15m grid (900s)
  return [
    { t: 90_000, o: 4100, h: 4110, l: 4090, c: 4105, v: null, forming: false },
    { t: 90_000 + M15, o: 4105, h: 4120, l: 4100, c: 4118, v: null, forming: true },
  ];
}

describe('live candle merge (Task 31-d)', () => {
  test('barStartSec floors to the bar open time', () => {
    // 12:34:56 UTC on a 15m chart → bar opens 12:30:00
    expect(barStartSec(Date.UTC(2026, 9, 20, 12, 34, 56), M15)).toBe(Math.floor(Date.UTC(2026, 9, 20, 12, 30, 0) / 1000));
    expect(barStartSec(Date.UTC(2026, 9, 20, 12, 30, 0), M15)).toBe(Math.floor(Date.UTC(2026, 9, 20, 12, 30, 0) / 1000));
    expect(barStartSec(Date.UTC(2026, 9, 20, 12, 0, 1), M1)).toBe(Math.floor(Date.UTC(2026, 9, 20, 12, 0, 0) / 1000));
  });

  test('tick inside the forming bar updates close and extends high/low', () => {
    const candles = base();
    const last = candles[candles.length - 1];
    const nowMs = (last.t + M15 - 60) * 1000; // inside the last bar
    const res = mergeTickIntoCandles(candles, 4125.5, M15, nowMs);
    expect(res.refused).toBeNull();
    expect(res.isNewBar).toBe(false);
    expect(res.landed).not.toBeNull();
    expect(res.landed!.c).toBe(4125.5);
    expect(res.landed!.h).toBe(4125.5); // new high
    expect(res.landed!.l).toBe(4100); // low unchanged
    expect(res.landed!.o).toBe(4105); // open NEVER changes
    expect(res.candles.length).toBe(2);
    // input not mutated (purity)
    expect(candles[candles.length - 1].c).toBe(4118);
  });

  test('tick below the current low extends the low only', () => {
    const candles = base();
    const last = candles[candles.length - 1];
    const nowMs = (last.t + 60) * 1000;
    const res = mergeTickIntoCandles(candles, 4095, M15, nowMs);
    expect(res.landed!.c).toBe(4095);
    expect(res.landed!.l).toBe(4095);
    expect(res.landed!.h).toBe(4120);
  });

  test('tick after the bar boundary opens a NEW forming candle from the tick', () => {
    const candles = base();
    const last = candles[candles.length - 1];
    const nowMs = (last.t + M15 + 30) * 1000; // 30s into the NEXT bar
    const res = mergeTickIntoCandles(candles, 4130, M15, nowMs);
    expect(res.refused).toBeNull();
    expect(res.isNewBar).toBe(true);
    expect(res.candles.length).toBe(3);
    const fresh = res.candles[2];
    expect(fresh.t).toBe(last.t + M15);
    expect(fresh.o).toBe(4130);
    expect(fresh.h).toBe(4130);
    expect(fresh.l).toBe(4130);
    expect(fresh.c).toBe(4130);
    expect(fresh.forming).toBe(true);
    // prior bars untouched
    expect(res.candles[1].c).toBe(4118);
  });

  test('out-of-order tick (older than the last bar) is refused, array unchanged by reference', () => {
    const candles = base();
    const last = candles[candles.length - 1];
    const nowMs = (last.t - 5) * 1000; // clock says an older bar
    const res = mergeTickIntoCandles(candles, 4100, M15, nowMs);
    expect(res.refused).toBe('out-of-order');
    expect(res.landed).toBeNull();
    expect(res.candles).toBe(candles); // same reference — nothing changed
  });

  test('non-finite / non-positive price is refused (never fabricated)', () => {
    const candles = base();
    const last = candles[candles.length - 1];
    const nowMs = (last.t + 60) * 1000;
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -4100]) {
      const res = mergeTickIntoCandles(candles, bad, M15, nowMs);
      expect(res.refused).toBe('invalid-price');
      expect(res.candles).toBe(candles);
    }
  });

  test('empty chart refuses honestly', () => {
    const res = mergeTickIntoCandles([], 4100, M15, Date.now());
    expect(res.refused).toBe('empty-chart');
    expect(res.candles).toEqual([]);
  });

  test('M1 granularity rolls a new bar every 60s', () => {
    const t0 = 300_000; // multiple of 60
    const candles: ChartCandlePoint[] = [{ t: t0, o: 4100, h: 4101, l: 4099, c: 4100.5, v: null, forming: true }];
    const res = mergeTickIntoCandles(candles, 4102, M1, (t0 + 61) * 1000);
    expect(res.isNewBar).toBe(true);
    expect(res.candles[1].t).toBe(t0 + 60); // floor((t0+61)/60)*60
    expect(res.candles[1].o).toBe(4102);
  });
});
