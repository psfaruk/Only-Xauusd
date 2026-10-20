/**
 * Phase 14, Task 34-e — A5 Price Action Agent tests.
 *
 * Every fixture uses hand-swept geometry so the pattern formulas, the
 * 2-per-candle cap, the alphabetical tiebreak, the ATR-gated displacement and
 * the walk window are all pinned exactly. The module header documents the
 * deliberate overlaps (a hammer is always a rejection-wick candidate etc.) —
 * these tests assert the DOCUMENTED deterministic outcome, overlaps included.
 *
 * Fixture bases (open = previous close everywhere, so TR = the exact span):
 *   · WIDE base — span 10, body 9, wicks 0.5 → ATR(14) = 10 exactly; no
 *     pattern fires on a base candle (body 9 < threshold 10).
 *   · MID base — span 3, body 2, wicks 0.5 → clean, no patterns.
 *   · NARROW base — span 2, body 0.5, wicks 0.75 → clean, no patterns.
 */

import { describe, expect, test } from 'bun:test';
import { atrSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { readPriceAction } from '@/lib/signal/ict/agents/price-action';
import type { CandlePatternKind } from '@/lib/signal/ict/types';

const T0 = 1_791_979_200; // regular M5 grid
const TF = 300;

function candle(i: number, o: number, h: number, l: number, c: number): AnalysisCandle {
  return {
    timeUtcSec: T0 + i * TF,
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

/** WIDE base candle: open o → close o+9, span exactly 10, wicks 0.5. */
function wide(i: number, o: number): AnalysisCandle {
  return candle(i, o, o + 9.5, o - 0.5, o + 9);
}

/** MID base candle: open o → close o+2, span exactly 3, wicks 0.5. */
function mid(i: number, o: number): AnalysisCandle {
  return candle(i, o, o + 2.5, o - 0.5, o + 2);
}

/** NARROW base candle: open o → close o+0.5, span exactly 2, wicks 0.75. */
function narrow(i: number, o: number): AnalysisCandle {
  return candle(i, o, o + 1.25, o - 0.75, o + 0.5);
}

/** Chain `count` base candles of the given shape starting at price `start`. */
function chain(count: number, shape: (i: number, o: number) => AnalysisCandle, start: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  let o = start;
  for (let i = 0; i < count; i++) {
    out.push(shape(i, o));
    o = out[out.length - 1].close;
  }
  return out;
}

function kindsOf(read: ReturnType<typeof readPriceAction>): CandlePatternKind[] {
  return read.patterns.map((p) => p.kind);
}

const NO_DISPLACEMENT = { displacementAtr: 1.0, atrPeriod: 14 };

describe('A5 — engulfing patterns', () => {
  test('bullish engulfing on the decision bar (strength 1, body ≥ prev body)', () => {
    // 18 clean WIDE base candles (o→o+9), then a bearish candle 18
    // (open = prev close, body 3, wick geometry → star family, capped to 2),
    // then the bullish engulfing decision candle 19.
    const base = chain(18, wide, 100);
    const o18 = base[17].close;
    const c18 = candle(18, o18, o18 + 7, o18 - 3, o18 - 3); // bearish body 3
    const o19 = c18.close; // = o18 − 3
    const decision = candle(19, o19, o19 + 4, o19 - 1, o18 + 0.5); // bullish body 3.5
    const read = readPriceAction([...base, c18, decision], NO_DISPLACEMENT, 2);

    // Candle 18 fires 3 tied patterns (0.7): BEARISH_PIN, BEARISH_REJECTION_WICK,
    // SHOOTING_STAR — the 2-per-candle cap keeps the alphabetical first two.
    expect(kindsOf(read)).toEqual(['BEARISH_PIN', 'BEARISH_REJECTION_WICK', 'BULLISH_ENGULFING']);

    // Decision bar: engulfing only (wicks 0.5/1.0 too small for anything else,
    // body 3.5 far below the 10.0 displacement threshold).
    expect(read.decisionPattern).not.toBeNull();
    expect(read.decisionPattern?.kind).toBe('BULLISH_ENGULFING');
    expect(read.decisionPattern?.strength).toBe(1); // clamp01(3.5 / 3)
    expect(read.decisionPattern?.candleTimeUtcSec).toBe(decision.timeUtcSec);
  });

  test('bearish engulfing mirror', () => {
    const base = chain(18, wide, 100);
    const o18 = base[17].close;
    const c18 = candle(18, o18, o18 + 3, o18 - 7, o18 + 3); // bullish body 3
    const o19 = c18.close; // = o18 + 3
    const decision = candle(19, o19, o19 + 1, o19 - 4, o18 - 0.5); // bearish body 3.5
    const read = readPriceAction([...base, c18, decision], NO_DISPLACEMENT, 2);

    expect(read.decisionPattern?.kind).toBe('BEARISH_ENGULFING');
    expect(read.decisionPattern?.strength).toBe(1);
  });
});

describe('A5 — hammer / shooting star (documented overlap → cap + tiebreak)', () => {
  test('hammer ties with its rejection wick; alphabetical order keeps the rejection first', () => {
    const base = chain(19, wide, 100);
    const o = base[18].close;
    // body 0.5, lowerWick 1.0 (≥ 2×body), upperWick 0.2 (≤ 0.5×body) → HAMMER;
    // lowerWick 1.0/1.7 = 0.588 < 0.60 → no pin; rejection fires at the same 0.588.
    const decision = candle(19, o, o + 0.7, o - 1, o + 0.5);
    const read = readPriceAction([...base, decision], NO_DISPLACEMENT, 2);

    expect(kindsOf(read)).toEqual(['BULLISH_REJECTION_WICK', 'HAMMER']);
    expect(read.decisionPattern?.kind).toBe('BULLISH_REJECTION_WICK');
    const hammer = read.patterns.find((p) => p.kind === 'HAMMER');
    expect(hammer?.strength).toBeCloseTo(1 / 1.7, 12);
  });

  test('shooting star survives beside its rejection wick when the pin band is missed', () => {
    const base = chain(19, wide, 100);
    const o = base[18].close;
    // body 1, upperWick 2 (≥ 2×body), lowerWick 0.4 (≤ 0.5×body) → SHOOTING_STAR
    // 0.588; upperWick 2/3.4 = 0.588 < 0.60 → no pin; rejection fires at 0.588.
    const decision = candle(19, o, o + 2, o - 1.4, o - 1);
    const read = readPriceAction([...base, decision], NO_DISPLACEMENT, 2);

    expect(kindsOf(read)).toEqual(['BEARISH_REJECTION_WICK', 'SHOOTING_STAR']);
    expect(read.decisionPattern?.kind).toBe('BEARISH_REJECTION_WICK');
  });
});

describe('A5 — pin bars', () => {
  test('bullish pin (0.70 wick dominance) beats its rejection-wick twin alphabetically', () => {
    const base = chain(19, wide, 100);
    const o = base[18].close;
    // body 0.1, lowerWick 1.4, upperWick 0.5 → range 2.0; pin 0.7 (≥ 0.6);
    // hammer needs upperWick ≤ 0.05 → not a hammer; rejection fires at 0.7 too.
    const decision = candle(19, o, o + 0.6, o - 1.4, o + 0.1);
    const read = readPriceAction([...base, decision], NO_DISPLACEMENT, 2);

    expect(kindsOf(read)).toEqual(['BULLISH_PIN', 'BULLISH_REJECTION_WICK']);
    expect(read.decisionPattern?.kind).toBe('BULLISH_PIN');
    expect(read.decisionPattern?.strength).toBeCloseTo(0.7, 12);
  });

  test('bearish pin mirror', () => {
    const base = chain(19, wide, 100);
    const o = base[18].close;
    const decision = candle(19, o, o + 1.4, o - 0.5, o - 0.1);
    const read = readPriceAction([...base, decision], NO_DISPLACEMENT, 2);

    expect(kindsOf(read)).toEqual(['BEARISH_PIN', 'BEARISH_REJECTION_WICK']);
    expect(read.decisionPattern?.kind).toBe('BEARISH_PIN');
  });
});

describe('A5 — inside bar', () => {
  test('a centred contraction candle inside the prior range → INSIDE_BAR only', () => {
    // MID base (span 3, body 2) — the decision candle contracts fully inside
    // candle 18 while keeping its own wicks tiny and centred.
    const base = chain(19, mid, 100);
    const o = base[18].close; // = base[18].open + 2
    const decision = candle(19, o, o + 0.4, o - 0.2, o + 0.2);
    const read = readPriceAction([...base, decision], NO_DISPLACEMENT, 2);

    expect(kindsOf(read)).toEqual(['INSIDE_BAR']);
    expect(read.decisionPattern?.kind).toBe('INSIDE_BAR');
    expect(read.decisionPattern?.strength).toBe(0.5);
  });
});

describe('A5 — ATR-gated displacement', () => {
  test('body ≥ displacementAtr × ATR → BULLISH_DISPLACEMENT with exact strength', () => {
    // NARROW base: every candle spans exactly 2.00 → ATR(14) = 2.00 until the
    // decision candle widens the TR to 3.4, so ATR[19] = (2×13 + 3.4)/14.
    const base = chain(19, narrow, 100);
    const o = base[18].close;
    const decision = candle(19, o, o + 3.2, o - 0.2, o + 3); // body 3, range 3.4

    const atr = atrSeries([...base, decision], 14);
    expect(atr.ok).toBe(true);
    if (!atr.ok) return;
    const atrLast = atr.series.values[19];
    expect(atrLast).not.toBeNull();
    const threshold = 1.0 * (atrLast as number);

    const read = readPriceAction([...base, decision], NO_DISPLACEMENT, 2);
    const displacement = read.patterns.find((p) => p.kind === 'BULLISH_DISPLACEMENT');
    expect(displacement).not.toBeUndefined();
    expect(displacement?.candleTimeUtcSec).toBe(decision.timeUtcSec);
    expect(displacement?.strength).toBe(Math.min(1, Math.max(0, 3 / threshold)));
    // The decision bar is displacement-grade; it also carries the bullish
    // rejection wick (lowerWick 0.2/3.4 → no; upperWick 0.2 → no) — actually
    // wick-free geometry: only the displacement fires on the decision bar.
    expect(read.decisionPattern?.kind).toBe('BULLISH_DISPLACEMENT');
  });

  test('weak body below the ATR threshold → no displacement pattern', () => {
    const base = chain(19, narrow, 100);
    const o = base[18].close;
    const decision = candle(19, o, o + 1.7, o - 0.3, o + 1.5); // body 1.5 < 2.0
    const read = readPriceAction([...base, decision], NO_DISPLACEMENT, 2);
    expect(kindsOf(read).includes('BULLISH_DISPLACEMENT')).toBe(false);
    expect(kindsOf(read).includes('BEARISH_DISPLACEMENT')).toBe(false);
  });
});

describe('A5 — emission discipline', () => {
  test('decisionPattern comes only from the LAST candle, never donated', () => {
    // A strong hammer-shaped candle at index 15, then clean candles after it.
    const base = chain(19, wide, 100);
    const hammered = [...base];
    const o = base[14].close;
    hammered[15] = candle(15, o, o + 0.7, o - 1, o + 0.5); // hammer geometry
    const read = readPriceAction(hammered, NO_DISPLACEMENT, 2);
    // The hammer candle sits inside the walk window (indices 8..19) but is
    // not the decision bar — its patterns exist, the decision pattern is null.
    expect(read.patterns.some((p) => p.candleTimeUtcSec === hammered[15].timeUtcSec)).toBe(true);
    expect(read.decisionPattern).toBeNull();
  });

  test('patterns outside the 12-candle walk window are invisible', () => {
    const base = chain(20, wide, 100);
    const hammered = [...base];
    const o = base[3].close;
    hammered[4] = candle(4, o, o + 0.7, o - 1, o + 0.5); // outside window 8..19
    const read = readPriceAction(hammered, NO_DISPLACEMENT, 2);
    expect(read.patterns).toEqual([]);
    expect(read.decisionPattern).toBeNull();
  });

  test('empty input → honest empty read', () => {
    expect(readPriceAction([], NO_DISPLACEMENT, 2)).toEqual({ patterns: [], decisionPattern: null });
  });

  test('single candle without predecessor → wick geometry only, none here', () => {
    const read = readPriceAction([candle(0, 100, 101, 99.9, 100.5)], NO_DISPLACEMENT, 2);
    expect(read.patterns).toEqual([]);
    expect(read.decisionPattern).toBeNull();
  });

  test('determinism — identical input, identical output', () => {
    const base = chain(18, wide, 100);
    const o18 = base[17].close;
    const c18 = candle(18, o18, o18 + 7, o18 - 3, o18 - 3);
    const decision = candle(19, c18.close, c18.close + 4, c18.close - 1, o18 + 0.5);
    const input = [...base, c18, decision];
    expect(readPriceAction(input, NO_DISPLACEMENT, 2)).toEqual(readPriceAction(input, NO_DISPLACEMENT, 2));
  });
});
