/**
 * Phase 14, Task 34-c — A2 Liquidity Agent tests.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: every candle below is a SYNTHETIC hand-built fixture
 * constructed to exercise specific liquidity paths. They are never presented
 * as broker data.
 *
 * Fixture invariants (hand-verified row by row):
 *   · M5 grid: t = T0 + i·300, tfSec = 300, digits = 2 (canonical text x.xx).
 *   · Every candle spans EXACTLY 2.00 (high − low) and OPENS at the previous
 *     close → every true range is exactly 2.00 → ATR(14) = 2.00 EXACTLY for
 *     any fixture with ≥ 14 candles. Tolerances are therefore exact:
 *     equalLevelAtrTol 0.25 → equal-level band 0.50; touch band 0.10·ATR = 0.20.
 *   · Swing window left = right = 2: a swing at index i is confirmed by the
 *     close of candle i+2, so its pool becomes VISIBLE to candles from
 *     index i+3 onward (the no-look-ahead gate under test below).
 *
 * Fixture layouts (all swing indices verified by hand):
 *   EQ_LOWS  : swing lows 2648.6@5 + 2649.0@10 (within 0.50 → EQL @ 2648.6,
 *              visible from 13) · swing high 2652.2@8 · candle 13 wicks to
 *              2647.9 (through the EQL) and closes 2649.8 back above it
 *              (BULLISH stop hunt) · the sweep wick itself is swing low
 *              2647.9@13. Recovery closes at 2651.4.
 *   EQ_HIGHS : point-mirror of EQ_LOWS (axis 5300) → swing highs 2651.4@5 +
 *              2651.0@10 (EQH @ 2651.4) · swing low 2647.8@8 · candle 13
 *              spikes 2652.1, closes 2650.2 (BEARISH stop hunt) · swing high
 *              2652.1@13. Decision close 2648.6.
 *   UNSWEPT  : single swing high 2652.0@6 (no swing lows at all); candles 9
 *              and 10 retest within 0.20 below the level (touches), candle 8
 *              (2651.95, pre-visibility) must NOT count; price then falls
 *              away — the pool stays unswept above the 2646.6 close.
 *   GUARD_SWING : swing high 2650.0@4 whose confirmation candle (index 6)
 *              carries high EXACTLY at the level and candle 5 sits 0.10
 *              below it — both are at/before the confirmation index and must
 *              neither sweep nor touch the pool.
 *   GUARD_EQH : swing highs 2650.0@4 + 2650.4@10 → EQH @ 2650.4 visible only
 *              from index 13; candles 7 (pierces the FIRST member by 0.30),
 *              8/9 (within 0.10 of the EQH level) and 10 (high exactly at the
 *              level) all precede the merged confirmation — none may sweep or
 *              touch the merged pool. The only legitimate sweep is the
 *              visible sell-side raid at candle 13 (low 2646.6 through
 *              2647.2, close back above).
 *   NO_ATR   : two swing highs 2650.0@3 + 2649.8@7 (0.20 apart — inside the
 *              would-be equal band) but only 12 candles → ATR(14)
 *              unavailable → clustering skipped. With atrPeriod 10 the same
 *              rows produce ATR 2.00 and the highs merge into one EQH.
 *   RAMP     : 16 strictly rising candles — no swing can exist at all.
 */

import { describe, expect, test } from 'bun:test';
import { readLiquidity } from '@/lib/signal/ict/agents/liquidity';
import type { AnalysisCandle } from '@/lib/analysis/types';

const T0 = 1_791_979_200; // Wednesday 2026-10-14T12:00:00Z (fixed test clock, M5-aligned)
const TF = 300; // M5
const DIGITS = 2;

const PARAMS = {
  swingLeft: 2,
  swingRight: 2,
  sweepLookbackBars: 12,
  maxBarsSinceSweep: 8,
  equalLevelAtrTol: 0.25, // × ATR 2.00 → equal-level band 0.50
  atrPeriod: 14,
};

/** One candle as [open, high, low, close]. */
type Row = [number, number, number, number];

function candle(t: number, o: number, h: number, l: number, c: number): AnalysisCandle {
  return {
    timeUtcSec: t,
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

/** Rows → closed candles on the regular M5 grid. */
function grid(rows: Row[]): AnalysisCandle[] {
  return rows.map(([o, h, l, c], i) => candle(T0 + i * TF, o, h, l, c));
}

/** Point-mirror around `axis` — flips highs↔lows, preserves every invariant. */
function mirror(rows: Row[], axis = 5300): Row[] {
  return rows.map(([o, h, l, c]) => [axis - o, axis - l, axis - h, axis - c]);
}

// --- fixtures ----------------------------------------------------------------

/** Downtrend into a double-bottom base; candle 13 raids both lows. */
const EQ_LOWS: Row[] = [
  // i=0..4 decline
  [2654.0, 2654.2, 2652.2, 2653.2],
  [2653.2, 2653.4, 2651.4, 2652.4],
  [2652.4, 2652.6, 2650.6, 2651.6],
  [2651.6, 2651.8, 2649.8, 2650.8],
  [2650.8, 2651.0, 2649.0, 2650.0],
  // i=5 swing low #1 — 2648.6
  [2650.0, 2650.6, 2648.6, 2649.6],
  // i=6..8 bounce (swing high 2652.2 @8)
  [2649.6, 2651.0, 2649.0, 2650.4],
  [2650.4, 2651.8, 2649.8, 2651.2],
  [2651.2, 2652.2, 2650.2, 2651.6],
  // i=9..12 roll into swing low #2 — 2649.0 @10 (0.40 above #1 → EQL @ 2648.6)
  [2651.6, 2652.0, 2650.0, 2650.8],
  [2650.8, 2651.0, 2649.0, 2650.0],
  [2650.0, 2651.2, 2649.2, 2649.4],
  [2649.4, 2651.0, 2649.0, 2649.0],
  // i=13 STOP HUNT: wick 2647.9 through the EQL, close 2649.8 back above it
  [2649.0, 2649.9, 2647.9, 2649.8],
  // i=14..16 recovery (the sweep wick itself becomes swing low 2647.9 @13)
  [2649.8, 2651.4, 2649.4, 2650.6],
  [2650.6, 2651.9, 2649.9, 2651.1],
  [2651.1, 2651.4, 2649.4, 2651.4],
];

const EQ_HIGHS: Row[] = mirror(EQ_LOWS);

/** Rise to a single peak, two visible retests, then a clean sell-off. */
const UNSWEPT: Row[] = [
  // i=0..5 rise into the peak
  [2648.0, 2649.2, 2647.2, 2648.8],
  [2648.8, 2650.4, 2648.4, 2649.4],
  [2649.4, 2651.0, 2649.0, 2650.0],
  [2650.0, 2651.6, 2649.6, 2650.4],
  [2650.4, 2651.8, 2649.8, 2650.8],
  [2650.8, 2651.9, 2649.9, 2651.0],
  // i=6 the swing high — 2652.0 (pool visible to candles from i=9 on)
  [2651.0, 2652.0, 2650.0, 2650.8],
  // i=7..8 fade (i=8 high 2651.95 is inside the touch band but PRE-visibility)
  [2650.8, 2651.9, 2649.9, 2650.4],
  [2650.4, 2651.95, 2649.95, 2650.6],
  // i=9..10 retest — both within 0.20 below the level (touches 1 and 2)
  [2650.6, 2651.9, 2649.9, 2650.2],
  [2650.2, 2651.85, 2649.85, 2650.0],
  // i=11..16 sell-off away from the pool (no further approaches)
  [2650.0, 2650.6, 2648.6, 2649.2],
  [2649.2, 2649.8, 2647.8, 2648.4],
  [2648.4, 2649.0, 2647.0, 2647.6],
  [2647.6, 2648.2, 2646.2, 2646.8],
  [2646.8, 2647.8, 2645.8, 2646.2],
  [2646.2, 2647.4, 2645.4, 2646.6],
];

/** Swing high confirmed late; candles 5 and 6 sit at/near the level. */
const GUARD_SWING: Row[] = [
  // i=0..3 rise
  [2646.0, 2647.2, 2645.2, 2646.8],
  [2646.8, 2648.0, 2646.0, 2647.6],
  [2647.6, 2649.0, 2647.0, 2648.4],
  [2648.4, 2649.9, 2647.9, 2649.0],
  // i=4 the swing high — 2650.0 (confirmation candle = i=6, visible from i=7)
  [2649.0, 2650.0, 2648.0, 2649.4],
  // i=5 within the touch band (−0.10) — BEFORE confirmation, must not touch
  [2649.4, 2649.9, 2647.9, 2649.0],
  // i=6 CONFIRMATION candle with high EXACTLY at the level — must not touch
  [2649.0, 2650.0, 2648.0, 2649.2],
  // i=7..15 decline (first visible candle i=7 stays outside the touch band)
  [2649.2, 2649.6, 2647.6, 2648.4],
  [2648.4, 2648.8, 2646.8, 2647.6],
  [2647.6, 2648.0, 2646.0, 2646.8],
  [2646.8, 2647.2, 2645.2, 2646.0],
  [2646.0, 2646.4, 2644.4, 2645.2],
  [2645.2, 2645.8, 2643.8, 2644.6],
  [2644.6, 2645.2, 2643.2, 2644.0],
  [2644.0, 2645.4, 2643.4, 2644.4],
  [2644.4, 2645.6, 2643.6, 2644.8],
];

/** Two equal highs confirmed 6 bars apart; a pierce sits between them. */
const GUARD_EQH: Row[] = [
  // i=0..3 rise
  [2646.0, 2647.2, 2645.2, 2646.8],
  [2646.8, 2648.0, 2646.0, 2647.6],
  [2647.6, 2649.0, 2647.0, 2648.4],
  [2648.4, 2649.9, 2647.9, 2649.2],
  // i=4 swing high #1 — 2650.0 (confirmed at i=6)
  [2649.2, 2650.0, 2648.0, 2649.4],
  // i=5..6 dip (right window of swing #1)
  [2649.4, 2649.9, 2647.9, 2648.6],
  [2648.6, 2649.2, 2647.2, 2648.6],
  // i=7 PIERCES member #1 (high 2650.3 > 2650.0, close 2649.6 < 2650.0) —
  //    the merged EQH is not visible yet, so this must NOT sweep/touch it
  [2648.6, 2650.3, 2648.3, 2649.6],
  // i=8..9 near-touches of the EQH level (2650.35 / 2650.3 vs 2650.4) — pre-visibility
  [2649.6, 2650.35, 2648.35, 2649.0],
  [2649.0, 2650.3, 2648.3, 2649.2],
  // i=10 swing high #2 — 2650.4 (0.40 above #1 → EQH @ 2650.4, visible from i=13)
  [2649.2, 2650.4, 2648.4, 2649.6],
  // i=11..16 decline away (visible candles never approach 2650.4 again)
  [2649.6, 2650.0, 2648.0, 2648.8],
  [2648.8, 2649.4, 2647.4, 2648.2],
  // i=13 visible raid of the swing low 2647.2 (wick 2646.6, close 2647.4)
  [2648.2, 2648.6, 2646.6, 2647.4],
  [2647.4, 2647.8, 2645.8, 2646.6],
  [2646.6, 2647.0, 2645.0, 2645.8],
  [2645.8, 2647.2, 2645.2, 2646.2],
];

/** 12 candles (ATR(14) unavailable) with two near-equal swing highs. */
const NO_ATR: Row[] = [
  [2646.0, 2647.2, 2645.2, 2646.8],
  [2646.8, 2648.0, 2646.0, 2647.6],
  [2647.6, 2649.4, 2647.4, 2648.4],
  // i=3 swing high #1 — 2650.0
  [2648.4, 2650.0, 2648.0, 2649.0],
  [2649.0, 2649.9, 2647.9, 2648.2],
  // i=5 swing low — 2647.2
  [2648.2, 2649.2, 2647.2, 2647.4],
  [2647.4, 2649.3, 2647.3, 2648.6],
  // i=7 swing high #2 — 2649.8 (0.20 below #1, inside the would-be equal band)
  [2648.6, 2649.8, 2647.8, 2649.0],
  [2649.0, 2649.4, 2647.4, 2648.2],
  // i=9 sweeps the swing low (wick 2646.6, close 2647.4 back above)
  [2648.2, 2648.6, 2646.6, 2647.4],
  [2647.4, 2647.8, 2645.8, 2646.6],
  [2646.6, 2647.4, 2645.4, 2647.0],
];

/** 16 strictly rising candles (highs and lows both monotone up) — no swings. */
const RAMP: Row[] = [
  [2648.0, 2649.7, 2647.7, 2648.6],
  [2648.6, 2650.3, 2648.3, 2649.2],
  [2649.2, 2650.9, 2648.9, 2649.8],
  [2649.8, 2651.5, 2649.5, 2650.4],
  [2650.4, 2652.1, 2650.1, 2651.0],
  [2651.0, 2652.7, 2650.7, 2651.6],
  [2651.6, 2653.3, 2651.3, 2652.2],
  [2652.2, 2653.9, 2651.9, 2652.8],
  [2652.8, 2654.5, 2652.5, 2653.4],
  [2653.4, 2655.1, 2653.1, 2654.0],
  [2654.0, 2655.7, 2653.7, 2654.6],
  [2654.6, 2656.3, 2654.3, 2655.2],
  [2655.2, 2656.9, 2654.9, 2655.8],
  [2655.8, 2657.5, 2655.5, 2656.4],
  [2656.4, 2658.1, 2656.1, 2657.0],
  [2657.0, 2658.7, 2656.7, 2657.6],
];

// --- 1. equal lows swept and reclaimed → BULLISH sweep -----------------------

describe('A2 liquidity — equal lows swept and reclaimed (BULLISH stop hunt)', () => {
  const read = readLiquidity(grid(EQ_LOWS), PARAMS, TF, DIGITS);

  test('emits exactly one BULLISH EQL sweep with wick, reclaim and barsAgo', () => {
    expect(read.sweeps).toHaveLength(1);
    const s = read.sweeps[0];
    expect(s.direction).toBe('BULLISH');
    expect(s.origin).toBe('EQL');
    expect(s.level).toBe(2648.6);
    expect(s.levelText).toBe('2648.60');
    expect(s.wickBeyond).toBeGreaterThan(0);
    expect(s.wickBeyond).toBeCloseTo(0.7, 6); // 2648.6 − 2647.9
    expect(s.reclaimed).toBe(true);
    expect(s.sweepCandleTimeUtcSec).toBe(T0 + 13 * TF);
    expect(s.barsAgo).toBe(3); // candle 13 of 0..16
  });

  test('consumes the swept EQL pool — only unswept pools survive, nearest first', () => {
    expect(read.pools).toHaveLength(2);
    expect(read.pools.some((p) => p.origin === 'EQL')).toBe(false); // swept → excluded
    expect(read.pools[0]).toEqual({
      side: 'BUY_SIDE',
      level: 2652.2,
      levelText: '2652.20',
      origin: 'SWING_HIGH',
      createdAtUtcSec: T0 + 8 * TF,
      touches: 0,
      swept: false,
      sweptAtUtcSec: null,
    });
    expect(read.pools[1]).toEqual({
      side: 'SELL_SIDE',
      level: 2647.9, // the sweep wick itself became a fresh swing low
      levelText: '2647.90',
      origin: 'SWING_LOW',
      createdAtUtcSec: T0 + 13 * TF,
      touches: 0,
      swept: false,
      sweptAtUtcSec: null,
    });
  });

  test('magnet levels: nearest sides set, no eqh/eql (the EQL was swept)', () => {
    expect(read.nearestBuySide).toBe(2652.2);
    expect(read.nearestSellSide).toBe(2647.9);
    expect(read.eqhLevel).toBeNull();
    expect(read.eqlLevel).toBeNull();
  });
});

// --- 2. equal highs spiked and rejected → BEARISH sweep (mirror) -------------

describe('A2 liquidity — equal highs spiked and rejected (BEARISH stop hunt)', () => {
  const read = readLiquidity(grid(EQ_HIGHS), PARAMS, TF, DIGITS);

  test('emits exactly one BEARISH EQH sweep (point-mirror fixture)', () => {
    expect(read.sweeps).toHaveLength(1);
    const s = read.sweeps[0];
    expect(s.direction).toBe('BEARISH');
    expect(s.origin).toBe('EQH');
    expect(s.level).toBe(2651.4);
    expect(s.levelText).toBe('2651.40');
    expect(s.wickBeyond).toBeGreaterThan(0);
    expect(s.wickBeyond).toBeCloseTo(0.7, 6); // 2652.1 − 2651.4
    expect(s.reclaimed).toBe(true);
    expect(s.sweepCandleTimeUtcSec).toBe(T0 + 13 * TF);
    expect(s.barsAgo).toBe(3);
  });

  test('unswept pools and magnets mirror the bullish case', () => {
    expect(read.pools).toHaveLength(2);
    expect(read.pools.some((p) => p.origin === 'EQH')).toBe(false); // swept → excluded
    expect(read.pools[0]).toEqual({
      side: 'SELL_SIDE',
      level: 2647.8,
      levelText: '2647.80',
      origin: 'SWING_LOW',
      createdAtUtcSec: T0 + 8 * TF,
      touches: 0,
      swept: false,
      sweptAtUtcSec: null,
    });
    expect(read.pools[1]).toEqual({
      side: 'BUY_SIDE',
      level: 2652.1, // the sweep spike itself became a fresh swing high
      levelText: '2652.10',
      origin: 'SWING_HIGH',
      createdAtUtcSec: T0 + 13 * TF,
      touches: 0,
      swept: false,
      sweptAtUtcSec: null,
    });
    expect(read.nearestBuySide).toBe(2652.1);
    expect(read.nearestSellSide).toBe(2647.8);
    expect(read.eqhLevel).toBeNull(); // the EQH was swept — no longer a magnet
    expect(read.eqlLevel).toBeNull();
  });
});

// --- 3. unswept buy-side pool with counted touches ---------------------------

describe('A2 liquidity — unswept buy-side pool with touches', () => {
  const read = readLiquidity(grid(UNSWEPT), PARAMS, TF, DIGITS);

  test('single swing-high pool stays unswept above price', () => {
    expect(read.pools).toHaveLength(1);
    expect(read.pools[0]).toEqual({
      side: 'BUY_SIDE',
      level: 2652.0,
      levelText: '2652.00',
      origin: 'SWING_HIGH',
      createdAtUtcSec: T0 + 6 * TF,
      touches: 2,
      swept: false,
      sweptAtUtcSec: null,
    });
  });

  test('counts only VISIBLE approaches within 0.10·ATR (candles 9 & 10, not pre-visibility candle 8)', () => {
    // candle 9 high 2651.9 (−0.10) and candle 10 high 2651.85 (−0.15) touch;
    // candle 8 high 2651.95 (−0.05) precedes the pool's visibility (index 9)
    // and must NOT be counted — asserted via touches: 2 in the test above.
    expect(read.pools[0].touches).toBe(2);
  });

  test('no sweeps in a pool-respecting decline; nearestBuySide is the pool level', () => {
    expect(read.sweeps).toHaveLength(0);
    expect(read.nearestBuySide).toBe(2652.0);
    expect(read.nearestSellSide).toBeNull(); // no sell-side pool exists at all
    expect(read.eqhLevel).toBeNull();
    expect(read.eqlLevel).toBeNull();
  });
});

// --- 4. look-ahead guard (confirmation visibility gate) ----------------------

describe('A2 liquidity — no look-ahead (confirmation visibility gate)', () => {
  test('a candle at/before the swing confirmation index can neither sweep nor touch the pool', () => {
    const read = readLiquidity(grid(GUARD_SWING), PARAMS, TF, DIGITS);
    expect(read.sweeps).toHaveLength(0);
    const buy = read.pools.find((p) => p.side === 'BUY_SIDE');
    expect(buy).toEqual({
      side: 'BUY_SIDE',
      level: 2650.0,
      levelText: '2650.00',
      origin: 'SWING_HIGH',
      createdAtUtcSec: T0 + 4 * TF,
      touches: 0, // candle 5 (−0.10) and the confirmation candle 6 (at the
      // level) are both at/before confirmation index 6 → no touch, no sweep
      swept: false,
      sweptAtUtcSec: null,
    });
    expect(read.nearestBuySide).toBe(2650.0);
  });

  test('a merged EQH pool becomes visible only after its LAST member confirms', () => {
    const read = readLiquidity(grid(GUARD_EQH), PARAMS, TF, DIGITS);
    // The EQH survived untouched: FOUR pre-visibility candles (7 pierce of the
    // first member, 8/9/10 at/near the merged level) must not sweep or touch.
    expect(read.pools).toHaveLength(1);
    expect(read.pools[0]).toEqual({
      side: 'BUY_SIDE',
      level: 2650.4,
      levelText: '2650.40',
      origin: 'EQH',
      createdAtUtcSec: T0 + 4 * TF, // earliest member bar
      touches: 0,
      swept: false,
      sweptAtUtcSec: null,
    });
    expect(read.eqhLevel).toBe(2650.4);
    expect(read.nearestBuySide).toBe(2650.4);
    expect(read.nearestSellSide).toBeNull(); // the sell-side pool was swept at 13
    // the ONLY sweep is the legitimate visible sell-side raid at candle 13 —
    // the candle-7 pierce of the first member's level must NOT produce one
    expect(read.sweeps).toHaveLength(1);
    expect(read.sweeps[0].direction).toBe('BULLISH');
    expect(read.sweeps[0].origin).toBe('SWING_LOW');
    expect(read.sweeps[0].level).toBe(2647.2);
    expect(read.sweeps[0].sweepCandleTimeUtcSec).toBe(T0 + 13 * TF);
    expect(read.sweeps[0].barsAgo).toBe(3);
  });
});

// --- ATR gating of equal-level clustering ------------------------------------

describe('A2 liquidity — ATR gating of equal-level clustering', () => {
  const rows = grid(NO_ATR);

  test('ATR unavailable (< atrPeriod candles) → clustering skipped, plain swing pools still returned', () => {
    const read = readLiquidity(rows, PARAMS, TF, DIGITS); // 12 candles < ATR period 14
    expect(read.pools).toHaveLength(2);
    expect(read.pools.map((p) => p.origin)).toEqual(['SWING_HIGH', 'SWING_HIGH']);
    expect(read.pools.map((p) => p.level)).toEqual([2649.8, 2650.0]); // nearest-first
    expect(read.pools.every((p) => p.touches === 0 && p.swept === false)).toBe(true);
    expect(read.nearestBuySide).toBe(2649.8);
    expect(read.eqhLevel).toBeNull();
    // sweeps still work without ATR — the sell-side raid at candle 9 stands
    expect(read.sweeps).toHaveLength(1);
    expect(read.sweeps[0].direction).toBe('BULLISH');
    expect(read.sweeps[0].origin).toBe('SWING_LOW');
    expect(read.sweeps[0].level).toBe(2647.2);
    expect(read.sweeps[0].barsAgo).toBe(2);
  });

  test('same rows with ATR available → the two highs merge into one EQH at the cluster max', () => {
    const read = readLiquidity(rows, { ...PARAMS, atrPeriod: 10 }, TF, DIGITS); // ATR = 2.00
    expect(read.pools).toHaveLength(1);
    expect(read.pools[0]).toEqual({
      side: 'BUY_SIDE',
      level: 2650.0, // cluster MAX of {2650.0, 2649.8}
      levelText: '2650.00',
      origin: 'EQH',
      createdAtUtcSec: T0 + 3 * TF, // earliest member bar
      touches: 0,
      swept: false,
      sweptAtUtcSec: null,
    });
    expect(read.eqhLevel).toBe(2650.0);
    expect(read.nearestBuySide).toBe(2650.0);
  });
});

// --- 5. insufficient input (fail empty, never fabricate) ---------------------

describe('A2 liquidity — insufficient input (fail empty, never fabricate)', () => {
  test('empty candle array → empty pools/sweeps, all levels null', () => {
    const read = readLiquidity([], PARAMS, TF, DIGITS);
    expect(read).toEqual({
      pools: [],
      sweeps: [],
      nearestBuySide: null,
      nearestSellSide: null,
      eqhLevel: null,
      eqlLevel: null,
    });
  });

  test('three candles (< swing window and ATR period) → empty pools/sweeps, nulls', () => {
    const read = readLiquidity(grid(EQ_LOWS.slice(0, 3)), PARAMS, TF, DIGITS);
    expect(read.pools).toHaveLength(0);
    expect(read.sweeps).toHaveLength(0);
    expect(read.nearestBuySide).toBeNull();
    expect(read.nearestSellSide).toBeNull();
    expect(read.eqhLevel).toBeNull();
    expect(read.eqlLevel).toBeNull();
  });

  test('16-candle monotone ramp (no swing can exist) → empty pools/sweeps, nulls', () => {
    const read = readLiquidity(grid(RAMP), PARAMS, TF, DIGITS);
    expect(read.pools).toHaveLength(0);
    expect(read.sweeps).toHaveLength(0);
    expect(read.nearestBuySide).toBeNull();
    expect(read.nearestSellSide).toBeNull();
    expect(read.eqhLevel).toBeNull();
    expect(read.eqlLevel).toBeNull();
  });
});

// --- 6. determinism -----------------------------------------------------------

describe('A2 liquidity — determinism', () => {
  test('identical input yields deeply identical reads (EQL sweep fixture)', () => {
    const a = readLiquidity(grid(EQ_LOWS), PARAMS, TF, DIGITS);
    const b = readLiquidity(grid(EQ_LOWS), PARAMS, TF, DIGITS);
    expect(a).toEqual(b);
  });

  test('identical input yields deeply identical reads (EQH guard fixture)', () => {
    const a = readLiquidity(grid(GUARD_EQH), PARAMS, TF, DIGITS);
    const b = readLiquidity(grid(GUARD_EQH), PARAMS, TF, DIGITS);
    expect(a).toEqual(b);
  });
});
