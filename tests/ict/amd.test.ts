/**
 * Phase 14, Task 34-f — A8 AMD Agent tests.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: every candle below is a SYNTHETIC hand-built fixture
 * constructed to exercise specific AMD paths. They are never presented
 * as broker data.
 *
 * Fixture invariants (hand-verified row by row):
 *   · M5 grid: t = T0 + i·300, digits = 2 (canonical text x.xx).
 *   · EXACT-ATR TRICK: every RANGE WALK candle OPENS at the previous
 *     close and spans EXACTLY 2.00 (marubozu) → every walk true range is
 *     exactly 2.00. The sweep/breakout tails add TRs of 3–9.5 which lift
 *     ATR(last) to at most ≈2.97 (hand-computed Wilder paths), so the
 *     2×ATR range minimum stays ≤ 5.94 against the height-10 (and
 *     height-12) ranges — every range verdict below is hand-safe; the
 *     THIN fixture keeps ALL TRs at exactly 2.00 → ATR = 2.00 EXACTLY →
 *     minimum height exactly 4.00 vs the crafted height 2.00.
 *   · amdLookbackBars 30 → the window is the last 30 candles; the range
 *     source excludes the window's last 3, so on the 33-row fixtures
 *     the walk's own extremes (2658 / 2648) define the range.
 *
 * Fixture layouts (sweep indices verified by hand):
 *   SPRING    : walk (i=0..29, 2648↔2658) · i=30 dips to 2646 (< 2648)
 *               and closes 2649 (reclaimed) · i=31 confirm 2650 · i=32
 *               decision 2650.5 inside → MANIPULATION / SPRING / BULLISH,
 *               range [2648, 2658] (the tail is excluded from the range).
 *   UPTHRUST  : point-mirror of SPRING (axis 5300) → range [2642, 2652],
 *               i=30 spikes 2654 and rejects 2651 → UPTHRUST / BEARISH.
 *   ACCUMULATE: walk + tail that DIPS BELOW the low (2647) but closes
 *               exactly AT it (2648 — no reclaim → not a spring; pins the
 *               strict reclaim), decision 2650 inside → ACCUMULATION.
 *   DISTRIBUTE: walk + spring at i=30 + four breakout candles to 2661.
 *               35 rows → the spring is 4 bars back = OUTSIDE the last-3
 *               signature window → signature null; close 2661 > rangeHigh
 *               → DISTRIBUTION. NOTE (documented consequence of the
 *               locked rule): only the last 3 candles are excluded from
 *               the range source, so the 4-back spring wick (2646) IS in
 *               it → rangeLow 2646, not 2648.
 *   WHIPSAW   : walk + spring wick 2.5 below (i=30) + upthrust wick 0.5
 *               above (i=31) + decision inside (i=32) → SWEEP_REVERSAL,
 *               the deeper SPRING wick directs → BULLISH.
 *   THIN      : single-candle ±2 oscillation 2649↔2651 → height 2.00 <
 *               2×ATR 2.00 = 4.00 → UNCLEAR with the range still reported.
 *   PRE-WINDOW: 3 wild rows (high 2700 / low 2646) in front of SPRING —
 *               36 rows → the window (last 30) starts after them, so the
 *               read must equal the plain SPRING read byte-for-byte.
 */

import { describe, expect, test } from 'bun:test';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { readAmd } from '@/lib/signal/ict/agents/amd';

const T0 = 1_791_979_200; // Wednesday 2026-10-14T12:00:00Z (fixed test clock, M5-aligned)
const TF = 300; // M5
const DIGITS = 2;

const PARAMS = {
  amdLookbackBars: 30,
  amdMinRangeAtr: 2, // × ATR → minimum range height (4.00 on the exact-ATR fixtures)
  atrPeriod: 14,
  equalLevelAtrTol: 0.25, // accepted for bundle symmetry — deliberately unused by A8
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

/** One marubozu leg: `count` candles stepping `step` (span = |step|), open = previous close. */
function leg(count: number, start: number, step: number): Row[] {
  const rows: Row[] = [];
  let o = start;
  for (let i = 0; i < count; i++) {
    const c = o + step;
    rows.push(step >= 0 ? [o, c, o, c] : [o, o, c, c]);
    o = c;
  }
  return rows;
}

/** 5-up/5-down marubozu walk — a quiet range of height 5×step (10 here). */
function rangeWalk(cycles: number, low: number, step: number): Row[] {
  const rows: Row[] = [];
  let level = low;
  for (let k = 0; k < cycles; k++) {
    const up = leg(5, level, step);
    rows.push(...up);
    level = up[up.length - 1][3];
    const down = leg(5, level, -step);
    rows.push(...down);
    level = down[down.length - 1][3];
  }
  return rows;
}

/** Single-candle ±step oscillation between low and low+step (a thin range). */
function oscillate(count: number, low: number, step: number): Row[] {
  const rows: Row[] = [];
  let o = low;
  let up = true;
  for (let i = 0; i < count; i++) {
    const c = up ? o + step : o - step;
    rows.push(up ? [o, c, o, c] : [o, o, c, c]);
    o = c;
    up = !up;
  }
  return rows;
}

// --- fixtures ----------------------------------------------------------------

const SPRING: Row[] = [
  ...rangeWalk(3, 2648, 2), // i=0..29 — 2648 ↔ 2658, every TR exactly 2.00
  // i=30 SPRING — wick 2646 through the 2648 low, close 2649 back inside
  [2648, 2649, 2646, 2649],
  // i=31 confirm — closes 2650, above the reclaimed low
  [2649, 2650.5, 2648.5, 2650],
  // i=32 decision — 2650.5, inside the range
  [2650, 2651, 2649, 2650.5],
];

const UPTHRUST: Row[] = mirror(SPRING); // range [2642, 2652], spike 2654 → reject

const ACCUMULATE: Row[] = [
  ...rangeWalk(3, 2648, 2),
  [2648, 2650, 2648, 2650], // i=30 plain up candle
  [2650, 2650, 2647, 2648], // i=31 dips BELOW the low but closes AT it — no reclaim
  [2648, 2650, 2648, 2650], // i=32 decision — 2650 inside
];

const DISTRIBUTE: Row[] = [
  ...rangeWalk(3, 2648, 2),
  [2648, 2649, 2646, 2649], // i=30 spring — 4 bars back, OUTSIDE the signature window
  [2649, 2652, 2649, 2652], // i=31..34 breakout candles, close 2661 > rangeHigh 2658
  [2652, 2655, 2652, 2655],
  [2655, 2658.5, 2655, 2658.5],
  [2658.5, 2661, 2658.5, 2661],
];

const WHIPSAW: Row[] = [
  ...rangeWalk(3, 2648, 2),
  [2648, 2649, 2645.5, 2649], // i=30 spring — wick 2.5 below the low
  [2649, 2658.5, 2649, 2657], // i=31 upthrust — wick 0.5 above the high
  [2657, 2657.5, 2655.5, 2656], // i=32 decision — inside
];

const THIN: Row[] = [...oscillate(33, 2649, 2)]; // 2649 ↔ 2651, height 2.00

// --- 1. spring below the range low (BULLISH manipulation) ---------------------

describe('A8 AMD — spring below the range low (BULLISH manipulation)', () => {
  const read = readAmd(grid(SPRING), PARAMS, DIGITS);

  test('classifies MANIPULATION with the SPRING signature, bullish', () => {
    expect(read.phase).toBe('MANIPULATION');
    expect(read.signature).toBe('SPRING');
    expect(read.signatureDirection).toBe('BULLISH');
  });

  test('range comes from the walk only — the last 3 candles are excluded', () => {
    // The sweep wick (2646) and the tail highs (2651) must NOT define the range.
    expect(read.rangeHigh).toBe(2658);
    expect(read.rangeLow).toBe(2648);
  });

  test('noteEn states the spring honestly', () => {
    expect(read.noteEn).toBe('Spring below 2648.00 reclaimed — manipulation signature, bullish');
  });
});

// --- 2. upthrust above the range high (BEARISH mirror) ------------------------

describe('A8 AMD — upthrust above the range high (BEARISH mirror)', () => {
  test('point-mirror fixture → MANIPULATION / UPTHRUST / BEARISH with the mirrored range', () => {
    const read = readAmd(grid(UPTHRUST), PARAMS, DIGITS);
    expect(read.phase).toBe('MANIPULATION');
    expect(read.signature).toBe('UPTHRUST');
    expect(read.signatureDirection).toBe('BEARISH');
    expect(read.rangeHigh).toBe(2652);
    expect(read.rangeLow).toBe(2642);
    expect(read.noteEn).toBe('Upthrust above 2652.00 rejected — manipulation signature, bearish');
  });
});

// --- 3. quiet range, close inside (ACCUMULATION) ------------------------------

describe('A8 AMD — quiet range, close inside (ACCUMULATION)', () => {
  test('no sweep and an inside close → ACCUMULATION, no signature; a dip without a reclaim is not a spring', () => {
    const read = readAmd(grid(ACCUMULATE), PARAMS, DIGITS);
    expect(read.phase).toBe('ACCUMULATION');
    expect(read.signature).toBeNull();
    expect(read.signatureDirection).toBeNull();
    expect(read.rangeHigh).toBe(2658);
    expect(read.rangeLow).toBe(2648); // the i=31 dip (2647) is tail — excluded from the range
    expect(read.noteEn).toBe('Close 2650.00 inside the 2648.00–2658.00 range with no sweep — accumulation');
  });
});

// --- 4. breakout after an aged spring (DISTRIBUTION) --------------------------

describe('A8 AMD — breakout after an aged spring (DISTRIBUTION)', () => {
  test('spring 4 bars back + close above the range high → DISTRIBUTION, signature null', () => {
    const read = readAmd(grid(DISTRIBUTE), PARAMS, DIGITS);
    expect(read.phase).toBe('DISTRIBUTION');
    expect(read.signature).toBeNull(); // the signature window is the last 3 candles only
    expect(read.signatureDirection).toBeNull();
    expect(read.rangeHigh).toBe(2658);
    // Locked consequence: only the LAST 3 candles are excluded from the range
    // source, so the 4-back spring wick (2646) legitimately widens rangeLow.
    expect(read.rangeLow).toBe(2646);
    expect(read.noteEn).toBe('Close 2661.00 above the 2658.00 range high — distribution (breakout up)');
  });
});

// --- 5. whipsaw sweeps both edges (SWEEP_REVERSAL) ----------------------------

describe('A8 AMD — whipsaw sweeps both edges (SWEEP_REVERSAL)', () => {
  test('both signatures in the last 3 → the farther wick directs; the whipsaw is noted', () => {
    const read = readAmd(grid(WHIPSAW), PARAMS, DIGITS);
    expect(read.phase).toBe('MANIPULATION');
    expect(read.signature).toBe('SWEEP_REVERSAL');
    expect(read.signatureDirection).toBe('BULLISH'); // spring wick 2.5 > upthrust wick 0.5
    expect(read.rangeHigh).toBe(2658); // both whipsaw wicks excluded from the range
    expect(read.rangeLow).toBe(2648);
    expect(read.noteEn).toBe('Whipsaw — both range edges swept within 3 bars; sweep-reversal signature, bullish (deeper spring wick)');
  });
});

// --- 6. thin range refused but reported ---------------------------------------

describe('A8 AMD — thin range refused but reported', () => {
  test('height 2.00 < 2×ATR 2.00 → UNCLEAR with the detected range still present', () => {
    const read = readAmd(grid(THIN), PARAMS, DIGITS);
    expect(read.phase).toBe('UNCLEAR');
    expect(read.signature).toBeNull();
    expect(read.signatureDirection).toBeNull();
    expect(read.rangeHigh).toBe(2651);
    expect(read.rangeLow).toBe(2649);
    expect(read.noteEn).toBe('Range 2649.00–2651.00 height 2.00 below the 4.00 minimum — too thin for an institutional range');
  });
});

// --- 7. insufficient input (fail closed, never fabricated) --------------------

describe('A8 AMD — insufficient input (fail closed, never fabricated)', () => {
  test('empty candle array → UNCLEAR with nulls', () => {
    expect(readAmd([], PARAMS, DIGITS)).toEqual({
      phase: 'UNCLEAR',
      signature: null,
      signatureDirection: null,
      rangeHigh: null,
      rangeLow: null,
      noteEn: 'insufficient history',
    });
  });

  test('9 candles (< the 10-candle window minimum) → the same honest shape', () => {
    const read = readAmd(grid(oscillate(9, 2649, 2)), PARAMS, DIGITS);
    expect(read.phase).toBe('UNCLEAR');
    expect(read.signature).toBeNull();
    expect(read.signatureDirection).toBeNull();
    expect(read.rangeHigh).toBeNull();
    expect(read.rangeLow).toBeNull();
    expect(read.noteEn).toBe('insufficient history');
  });

  test('12 candles — window large enough but ATR(14) unavailable → the same honest shape', () => {
    const read = readAmd(grid(oscillate(12, 2649, 2)), PARAMS, DIGITS);
    expect(read.phase).toBe('UNCLEAR');
    expect(read.signature).toBeNull();
    expect(read.signatureDirection).toBeNull();
    expect(read.rangeHigh).toBeNull();
    expect(read.rangeLow).toBeNull();
    expect(read.noteEn).toBe('insufficient history');
  });
});

// --- 8. lookahead window boundary ---------------------------------------------

describe('A8 AMD — lookback window boundary', () => {
  test('a wild pre-window candle (high 2700 / low 2646) never leaks into the range', () => {
    // 3 pre-window rows (indices 0..2 of 36) then SPRING unchanged — the last-30
    // window starts at index 6 = SPRING's own window start, so the read must be
    // identical to the plain SPRING read (ATR differs but nothing exposes it).
    const preWindow: Row[] = [
      [2648, 2700, 2646, 2648], // wild wick both ways — must stay invisible
      [2648, 2650, 2648, 2650],
      [2650, 2650, 2648, 2648],
    ];
    const spiked = readAmd(grid([...preWindow, ...SPRING]), PARAMS, DIGITS);
    const plain = readAmd(grid(SPRING), PARAMS, DIGITS);
    expect(spiked).toEqual(plain);
    expect(plain.rangeHigh).toBe(2658); // sanity: not 2700
    expect(plain.rangeLow).toBe(2648); // sanity: not 2646
  });
});

// --- 9. determinism -----------------------------------------------------------

describe('A8 AMD — determinism', () => {
  test('identical input yields deeply identical reads (spring fixture)', () => {
    expect(readAmd(grid(SPRING), PARAMS, DIGITS)).toEqual(readAmd(grid(SPRING), PARAMS, DIGITS));
  });

  test('identical input yields deeply identical reads (whipsaw fixture)', () => {
    expect(readAmd(grid(WHIPSAW), PARAMS, DIGITS)).toEqual(readAmd(grid(WHIPSAW), PARAMS, DIGITS));
  });
});
