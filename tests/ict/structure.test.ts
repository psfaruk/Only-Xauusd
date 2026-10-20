/**
 * Phase 14, Task 34-b — A1 Structure Agent tests (ict/agents/structure.ts).
 *
 * Deterministic, hand-verified fixtures on a regular M5 grid
 * (t = T0 + i·300, tfSec = 300, digits = 2, swing window left = right = 2).
 * Every fixture is SYNTHETIC — never real broker data. All row prices use
 * exact binary fractions (integers, .25, .5, .75) so every asserted level,
 * equilibrium and canonical text is float-exact.
 *
 * Fixture map (all swing/event indices verified by hand against the locked
 * Phase 4 rules before being pinned here):
 *   uptrend       : 41 candles — pad + five stair-step legs (4×(+5) rise +
 *                    (+8) push, 3×(−4) pullback). Swing highs at the leg tops
 *                    2028.5 / 2044.5 / 2060.5 / 2076.5 (HH…), swing lows at
 *                    the pullback bottoms 2015.5 / 2031.5 / 2047.5 / 2063.5
 *                    (HL…) → trend bullish. Four close-confirmed bullish BOS
 *                    events (candles 14/22/30/38); the last breaks 2076.5 on
 *                    candle 38 → barsSinceEvent = 2. Decision close 2092 is
 *                    beyond the last dealing range high → PREMIUM.
 *   legV(close)   : 39 candles — one V-leg: 16×(+5) up (swing high 2080.5),
 *                    20×(−4) down (swing low 1999.5), then a 3-candle drift
 *                    whose final close is placed inside the dealing range
 *                    1999.5–2080.5 (equilibrium 2040.00): close 2060 →
 *                    PREMIUM, 2020 → DISCOUNT, 2040 → EQUILIBRIUM. The V has
 *                    no close-confirmed break → lastEvent null.
 *   rangeBoard    : 49 candles — flat oscillation. Swing highs 2050.5 → 2060.5
 *                    (HH) + swing lows 1999.5 → 1989.5 (LL) → trend 'range'.
 *                    Events: bullish BOS (close 2055 > 2050.5, candle 30) and
 *                    bearish BOS (close 1995 < 1999.5, candle 44).
 *   equalExtremes : 40 candles — swing high 2160, swing low 2100 (Y), swing
 *                    high 2150, breakdown below 2100 (bearish BOS, candle 30),
 *                    then a retest of 2100 from BELOW as the last swing high
 *                    (X) → lastSwingHigh.price = lastSwingLow.price = 2100 →
 *                    dealingRange must stay NULL — never fabricated from
 *                    equal extremes.
 *   insufficient  : 4 wild candles (< the 5-bar swing window) and the empty
 *                    series → all-null reads with trend 'unclear'.
 */

import { describe, expect, test } from 'bun:test';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { readSmcStructure } from '@/lib/signal/ict/agents/structure';

const T0 = 1_791_979_200; // Wednesday 2026-10-14T12:00:00Z (fixed test clock)
const TF = 300; // M5
const DIGITS = 2;
const PARAMS = { swingLeft: 2, swingRight: 2, maxBarsSinceEvent: 12 };

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Full closed candle on the spec'd shape: *Text = String(value), volume null. */
function candle(t: number, o: number, h: number, l: number, c: number): AnalysisCandle {
  return {
    timeUtcSec: t,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: null,
    openText: String(o),
    highText: String(h),
    lowText: String(l),
    closeText: String(c),
  };
}

/** OHLC rows → candles on the regular M5 grid t = T0 + i·300. */
function series(rows: Array<[number, number, number, number]>): AnalysisCandle[] {
  return rows.map(([o, h, l, c], i) => candle(T0 + i * TF, o, h, l, c));
}

/** Rising candle: closes `step` above the open; wicks +0.5 above / −0.25 below. */
function up(o: number, step: number): [number, number, number, number] {
  const c = o + step;
  return [o, c + 0.5, o - 0.25, c];
}

/** Falling candle: closes `step` below the open; wicks +0.25 above / −0.5 below. */
function down(o: number, step: number): [number, number, number, number] {
  const c = o - step;
  return [o, o + 0.25, c - 0.5, c];
}

/** Monotonic ramp of `count` candles (step > 0 rises, step < 0 falls). */
function ramp(
  from: number,
  step: number,
  count: number,
): { rows: Array<[number, number, number, number]>; lastClose: number } {
  const rows: Array<[number, number, number, number]> = [];
  let o = from;
  for (let i = 0; i < count; i++) {
    rows.push(step >= 0 ? up(o, step) : down(o, -step));
    o += step;
  }
  return { rows, lastClose: o };
}

/** Append a ramp to `rows`, returning its last close for chaining. */
function leg(rows: Array<[number, number, number, number]>, from: number, step: number, count: number): number {
  const r = ramp(from, step, count);
  rows.push(...r.rows);
  return r.lastClose;
}

// --- scenario 1: stair-step uptrend -----------------------------------------

/** 41 candles: pad(4) + 5 legs of [4×(+5), 1×(+8)] up and 3×(−4) pullbacks. */
function buildUptrend(): AnalysisCandle[] {
  const rows: Array<[number, number, number, number]> = [];
  let c = 1980;
  c = leg(rows, c, 5, 4); // pad          → close 2000
  c = leg(rows, c, 5, 4); // U1 body      → close 2020
  c = leg(rows, c, 8, 1); // U1 push      → close 2028  · swing high 2028.5  @ i8
  c = leg(rows, c, -4, 3); // D1          → close 2016  · swing low  2015.5  @ i11
  c = leg(rows, c, 5, 4); // U2 body      → close 2036  · BOS#1 close 2031 > 2028.5 @ i14
  c = leg(rows, c, 8, 1); // U2 push      → close 2044  · swing high 2044.5  @ i16
  c = leg(rows, c, -4, 3); // D2          → close 2032  · swing low  2031.5  @ i19
  c = leg(rows, c, 5, 4); // U3 body      → close 2052  · BOS#2 close 2047 > 2044.5 @ i22
  c = leg(rows, c, 8, 1); // U3 push      → close 2060  · swing high 2060.5  @ i24
  c = leg(rows, c, -4, 3); // D3          → close 2048  · swing low  2047.5  @ i27
  c = leg(rows, c, 5, 4); // U4 body      → close 2068  · BOS#3 close 2063 > 2060.5 @ i30
  c = leg(rows, c, 8, 1); // U4 push      → close 2076  · swing high 2076.5  @ i32
  c = leg(rows, c, -4, 3); // D4          → close 2064  · swing low  2063.5  @ i35
  c = leg(rows, c, 5, 4); // U5 body      → close 2084  · BOS#4 close 2079 > 2076.5 @ i38
  c = leg(rows, c, 8, 1); // decision     → close 2092 (beyond the range high)
  return series(rows);
}

// --- scenario 2: single V-leg with a controlled decision close --------------

/** 39 candles: 16×(+5) up, 20×(−4) down, 2×(+4) drift + decision at `finalClose`. */
function buildLegV(finalClose: number): AnalysisCandle[] {
  const rows: Array<[number, number, number, number]> = [];
  let c = 2000;
  c = leg(rows, c, 5, 16); // rise → close 2080 · swing high 2080.5 @ i15
  c = leg(rows, c, -4, 20); // fall → close 2000 · swing low  1999.5 @ i35
  c = leg(rows, c, 4, 2); // drift → close 2008
  rows.push([c, finalClose + 0.5, c - 0.25, finalClose]); // decision candle
  return series(rows);
}

// --- scenario 3a: flat oscillation (HH + LL conflict) ------------------------

/** 49 candles: 10×(+5), 10×(−5), 12×(+5), 14×(−5), 3×(+5) drift. */
function buildRangeBoard(): AnalysisCandle[] {
  const rows: Array<[number, number, number, number]> = [];
  let c = 2000;
  c = leg(rows, c, 5, 10); // rise → close 2050 · swing high 2050.5 @ i9
  c = leg(rows, c, -5, 10); // fall → close 2000 · swing low  1999.5 @ i19
  c = leg(rows, c, 5, 12); // rise → close 2060 · swing high 2060.5 @ i31 (HH)
  //                            · BOS bullish: close 2055 > 2050.5 @ i30
  c = leg(rows, c, -5, 14); // fall → close 1990 · swing low  1989.5 @ i45 (LL)
  //                            · BOS bearish: close 1995 < 1999.5 @ i44
  c = leg(rows, c, 5, 3); // drift → decision close 2005
  return series(rows);
}

// --- scenario 3b: equal last swing high / swing low --------------------------

/**
 * 40 candles. 20-candle +10/candle staircase lead-in (no swings), then:
 * swing high 2160 @ i23 → swing low 2100 (Y) @ i26 → swing high 2150 @ i29 →
 * breakdown (bearish BOS, close 2095 < 2100 @ i30) → retest of 2100 from
 * below as the LAST swing high (X) @ i35 → rejection to new lows. Ends with
 * lastSwingHigh.price = lastSwingLow.price = 2100 exactly.
 */
function buildEqualExtremes(): AnalysisCandle[] {
  const rows: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 20; i++) {
    const o = 1925 + 10 * i;
    rows.push([o, o + 15, o - 5, o + 5]); // +10/candle staircase, 20-unit range
  }
  rows.push(
    [2115, 2130, 2110, 2120], // i20
    [2125, 2140, 2120, 2130], // i21
    [2135, 2150, 2130, 2140], // i22
    [2145, 2160, 2140, 2150], // i23 ← swing high 2160
    [2145, 2150, 2140, 2145], // i24
    [2135, 2140, 2130, 2135], // i25
    [2105, 2120, 2100, 2110], // i26 ← swing low 2100 (Y)
    [2115, 2130, 2110, 2120], // i27
    [2125, 2140, 2120, 2130], // i28
    [2135, 2150, 2130, 2140], // i29 ← swing high 2150
    [2082.5, 2120, 2070, 2095], // i30 ← breakdown: close 2095 < 2100 → bearish BOS
    [2060, 2090, 2050, 2070], // i31
    [2030, 2060, 2020, 2040], // i32
    [2007.5, 2030, 2000, 2015], // i33
    [1977.5, 2000, 1970, 1985], // i34
    [2047.5, 2100, 2030, 2065], // i35 ← retest of 2100 from below = LAST swing high (X)
    [1967.5, 2080, 1950, 2015], // i36
    [1955, 2050, 1930, 1990], // i37
    [1937.5, 2020, 1910, 1965], // i38
    [1925, 2000, 1900, 1950], // i39 (decision)
  );
  return series(rows);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A1 Structure Agent — readSmcStructure', () => {
  describe('scenario 1: stair-step uptrend with close-confirmed bullish BOS', () => {
    const uptrend = buildUptrend();

    test('trend bullish (HH + HL), last event a bullish BOS on the latest leg top', () => {
      const read = readSmcStructure(uptrend, PARAMS, TF, DIGITS);
      expect(read.trend).toBe('bullish');
      expect(read.lastEvent).not.toBeNull();
      expect(read.lastEvent!.type).toBe('BOS');
      expect(read.lastEvent!.direction).toBe('bullish');
      expect(read.lastEvent!.level).toBe(2076.5);
      expect(read.lastEvent!.levelText).toBe('2076.50');
      expect(read.lastEvent!.breakCandleTimeUtcSec).toBe(uptrend[38].timeUtcSec);
      expect(read.lastEvent!.trendAtBreak).toBe('bullish'); // HH+HL known by then
      expect(read.barsSinceEvent).toBeGreaterThanOrEqual(0);
      expect(read.barsSinceEvent).toBe(2); // decision bar 40 − breaking candle 38
    });

    test('dealing range = last swing high 2076.5 ↔ last swing low 2063.5, equilibrium 2070.00', () => {
      const read = readSmcStructure(uptrend, PARAMS, TF, DIGITS);
      expect(read.dealingRange).toEqual({
        high: 2076.5,
        low: 2063.5,
        equilibrium: 2070,
        highText: '2076.50',
        lowText: '2063.50',
        equilibriumText: '2070.00',
      });
      // decision close 2092 sits beyond the range high → mapped to PREMIUM
      expect(read.zone).toBe('PREMIUM');
    });
  });

  describe('scenario 2: dealing range + premium/discount placement', () => {
    test('decision close 2060 near the range high → PREMIUM', () => {
      const read = readSmcStructure(buildLegV(2060), PARAMS, TF, DIGITS);
      expect(read.dealingRange).toEqual({
        high: 2080.5,
        low: 1999.5,
        equilibrium: 2040,
        highText: '2080.50',
        lowText: '1999.50',
        equilibriumText: '2040.00',
      });
      expect(read.zone).toBe('PREMIUM');
    });

    test('decision close 2020 near the range low → DISCOUNT', () => {
      const read = readSmcStructure(buildLegV(2020), PARAMS, TF, DIGITS);
      expect(read.dealingRange).not.toBeNull();
      expect(read.dealingRange!.high).toBe(2080.5);
      expect(read.dealingRange!.low).toBe(1999.5);
      expect(read.zone).toBe('DISCOUNT');
    });

    test('decision close 2040 at the 50% equilibrium → EQUILIBRIUM', () => {
      const read = readSmcStructure(buildLegV(2040), PARAMS, TF, DIGITS);
      expect(read.dealingRange).not.toBeNull();
      expect(read.dealingRange!.equilibrium).toBe(2040);
      expect(read.zone).toBe('EQUILIBRIUM');
    });

    test('a clean V-leg has no close-confirmed break → lastEvent/barsSinceEvent null', () => {
      const read = readSmcStructure(buildLegV(2040), PARAMS, TF, DIGITS);
      expect(read.lastEvent).toBeNull();
      expect(read.barsSinceEvent).toBeNull();
      expect(read.trend).toBe('unclear'); // one high + one low → labels UNCLEAR
    });
  });

  describe('scenario 3: range board + equal swing extremes', () => {
    test('flat oscillation with HH + LL conflict → trend range (one of range/unclear, never guessed)', () => {
      const read = readSmcStructure(buildRangeBoard(), PARAMS, TF, DIGITS);
      expect(['range', 'unclear']).toContain(read.trend);
      expect(read.trend).toBe('range');
      // last event = the bearish BOS breaking the first swing low on candle 44
      expect(read.lastEvent).not.toBeNull();
      expect(read.lastEvent!.type).toBe('BOS');
      expect(read.lastEvent!.direction).toBe('bearish');
      expect(read.lastEvent!.level).toBe(1999.5);
      expect(read.lastEvent!.levelText).toBe('1999.50');
      expect(read.barsSinceEvent).toBe(4); // decision bar 48 − breaking candle 44
      // dealing range spans the LAST swings 2060.5 ↔ 1989.5; close 2005 → DISCOUNT
      expect(read.dealingRange).toEqual({
        high: 2060.5,
        low: 1989.5,
        equilibrium: 2025,
        highText: '2060.50',
        lowText: '1989.50',
        equilibriumText: '2025.00',
      });
      expect(read.zone).toBe('DISCOUNT');
    });

    test('equal last swing high/low (2100 = 2100) → dealingRange NEVER fabricated, zone null', () => {
      const read = readSmcStructure(buildEqualExtremes(), PARAMS, TF, DIGITS);
      expect(read.trend).toBe('unclear'); // LH high label + single low → UNCLEAR
      expect(read.dealingRange).toBeNull();
      expect(read.zone).toBeNull();
      // the breakdown itself is still honestly recorded:
      expect(read.lastEvent).not.toBeNull();
      expect(read.lastEvent!.type).toBe('BOS');
      expect(read.lastEvent!.direction).toBe('bearish');
      expect(read.lastEvent!.level).toBe(2100);
      expect(read.lastEvent!.levelText).toBe('2100.00');
      expect(read.barsSinceEvent).toBe(9); // decision bar 39 − breaking candle 30
    });
  });

  describe('scenario 4: insufficient history — nothing fabricated', () => {
    test('four wild candles (< the 5-bar swing window) → all-null read, trend unclear', () => {
      const sparse = series([
        [2000, 2010, 1990, 2005],
        [2010, 2020, 2000, 2015],
        [1990, 2000, 1980, 1995],
        [2005, 2015, 1995, 2010],
      ]);
      const read = readSmcStructure(sparse, PARAMS, TF, DIGITS);
      expect(read).toEqual({
        trend: 'unclear',
        lastEvent: null,
        barsSinceEvent: null,
        dealingRange: null,
        zone: null,
      });
    });

    test('empty series → all-null read with trend unclear', () => {
      const read = readSmcStructure([], PARAMS, TF, DIGITS);
      expect(read).toEqual({
        trend: 'unclear',
        lastEvent: null,
        barsSinceEvent: null,
        dealingRange: null,
        zone: null,
      });
    });
  });

  describe('scenario 5: determinism (pure function of inputs)', () => {
    test('same candles + params called twice → deep-equal read', () => {
      const uptrend = buildUptrend();
      const a = readSmcStructure(uptrend, PARAMS, TF, DIGITS);
      const b = readSmcStructure(uptrend, PARAMS, TF, DIGITS);
      expect(a).toEqual(b);
    });

    test('same holds for the zone fixture with the richest output shape', () => {
      const leg = buildLegV(2060);
      expect(readSmcStructure(leg, PARAMS, TF, DIGITS)).toEqual(
        readSmcStructure(leg, PARAMS, TF, DIGITS),
      );
    });
  });
});
