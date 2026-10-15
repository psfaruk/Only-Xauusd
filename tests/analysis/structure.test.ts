/**
 * AUTOMATED TESTS — Swings & Market Structure / BOS / CHoCH (Phase 4, spec §9
 * Structure). Deterministic test fixtures with hand-laid price paths.
 *
 * Every fixture below is SYNTHETIC — never real broker data.
 *
 * Fixture LAYOUT (left = right = 2 swing window, all indices refer to it):
 *   bullish : swing highs 20@7, 26@21 (HH) · swing lows 10@14, 14@28 (HL)
 *             BOS bullish @ close 22 > 20 on candle 21 (trend at break: unclear)
 *             unconfirmed wick crossings on candles 19 & 20
 *   bearish : mirror of bullish (LH + LL → bearish, BOS bearish)
 *   choChUp : LH + LL (bearish), final close 24.5 > 24 on candle 31 → CHoCH bullish
 *   choChDn : mirror of choChUp (HH + HL bullish, final close below → CHoCH bearish)
 *   range   : HH + LL (conflicting) → 'range'
 */
import { describe, expect, test } from 'bun:test';
import { detectSwings } from '@/lib/analysis/swings';
import {
  buildStructureResult,
  classifyStructure,
  scanStructureEvents,
} from '@/lib/analysis/structure';
import type { AnalysisCandle } from '@/lib/analysis/types';

const T0 = 1_791_979_200; // Wednesday 2026-10-14T12:00:00Z (fixed test clock)
const TF = 300; // M5
const DIGITS = 2;

/** Build closed candles from per-candle [high, low] pairs; open/close inside range. */
function mk(hl: Array<[number, number]>): AnalysisCandle[] {
  return hl.map(([h, l], i) => {
    const open = l + (h - l) * 0.25;
    const close = l + (h - l) * 0.5;
    return {
      timeUtcSec: T0 - (hl.length - i) * TF, // ends before the fixed clock
      open,
      high: h,
      low: l,
      close,
      volume: null,
      openText: open.toFixed(DIGITS),
      highText: h.toFixed(DIGITS),
      lowText: l.toFixed(DIGITS),
      closeText: close.toFixed(DIGITS),
    };
  });
}

/** Options for detectSwings (left/right window). */
const SWING = { left: 2, right: 2, tfSec: TF, digits: DIGITS };
/** Options for scanStructureEvents / buildStructureResult. */
const SCAN = { swingLeft: 2, swingRight: 2, tfSec: TF, digits: DIGITS };

// --- bullish fixture ---------------------------------------------------------
const BULL_H: Array<[number, number]> = [
  // idx: 0    1    2    3    4    5    6    7(P1=20)
  [12, 8], [13, 9], [14, 10], [15, 11], [16, 12], [17, 13], [18, 14], [20, 16],
  // 8..14 descent (T1 low 10 @14)
  [19, 15], [18, 14], [17, 13], [16, 12], [15, 11], [14, 11], [12, 10],
  // 15..21 climb (P2 = 26 @21)
  [13, 11], [15, 12], [17, 13], [19, 15], [21, 15], [23, 16], [26, 18],
  // 22..28 descent (T2 = 14 @28)
  [25, 17], [24, 16], [23, 15], [22, 15], [21, 14.8], [20, 14.5], [19, 14],
  // 29..31 rise
  [20, 15], [21, 16], [22, 17],
];

/** Mirror a fixture: new high = 60 − old low, new low = 60 − old high. */
function mirror(hl: Array<[number, number]>): Array<[number, number]> {
  return hl.map(([h, l]) => [60 - l, 60 - h] as [number, number]);
}

describe('structure — swing detection (deterministic)', () => {
  test('bullish fixture: exactly 2 swing highs (20@7, 26@21) and 2 swing lows (10@14, 14@28)', () => {
    const candles = mk(BULL_H);
    const det = detectSwings(candles, SWING);
    const highs = det.swings.filter((s) => s.kind === 'high');
    const lows = det.swings.filter((s) => s.kind === 'low');
    expect(highs.map((s) => [s.index, s.price])).toEqual([[7, 20], [21, 26]]);
    expect(lows.map((s) => [s.index, s.price])).toEqual([[14, 10], [28, 14]]);
  });

  test('swing confirmation delay: P1 needs candles through index 9; confirmedAt = candle(9).open + tf', () => {
    const full = mk(BULL_H);
    const at9 = detectSwings(full.slice(0, 10), SWING); // indices 0..9 → P1 confirmed
    expect(at9.swings.some((s) => s.kind === 'high' && s.index === 7)).toBe(true);
    const at8 = detectSwings(full.slice(0, 9), SWING); // indices 0..8 → right window incomplete
    expect(at8.swings.length).toBe(0); // NOTHING is fabricated without the right-side bars
    const p1 = detectSwings(full, SWING).swings.find((s) => s.index === 7 && s.kind === 'high');
    expect(p1).toBeDefined();
    expect(p1!.confirmedAtUtcSec).toBe(full[9].timeUtcSec + TF); // close of candle 9
    expect(p1!.timeUtcSec).toBe(full[7].timeUtcSec); // ORIGINAL candle time preserved
    expect(p1!.priceText).toBe('20.00'); // canonical decimal text with verified digits
  });

  test('equal-high tie: the EARLIER candle wins; the later equal high is suppressed', () => {
    // highs: [5,8,10,10,8,5] → swing high only at index 2 (10 ≥ right equal 10);
    // index 3 (also 10) fails the STRICT-left test (10 > 10 is false).
    const candles = mk([[5, 3], [8, 6], [10, 8], [10, 8], [8, 6], [5, 3]]);
    const det = detectSwings(candles, SWING);
    const highs = det.swings.filter((s) => s.kind === 'high');
    expect(highs.map((s) => s.index)).toEqual([2]);
  });

  test('equal-low tie: the EARLIER candle wins on the low side too', () => {
    // lows: [15,12,10,10,12,15] → swing low only at index 2 (10 ≤ right equal 10).
    const candles = mk([[17, 15], [14, 12], [12, 10], [12, 10], [14, 12], [17, 15]]);
    const det = detectSwings(candles, SWING);
    const lows = det.swings.filter((s) => s.kind === 'low');
    expect(lows.map((s) => s.index)).toEqual([2]);
  });

  test('no look-ahead: a swing needing future bars simply does not exist', () => {
    const full = mk(BULL_H);
    const cut = full.slice(0, 20); // ends at idx19 — P2@21 and T2@28 not yet confirmable
    const det = detectSwings(cut, SWING);
    expect(det.swings.some((s) => s.index === 21)).toBe(false);
    expect(det.swings.some((s) => s.index === 28)).toBe(false);
    expect(det.swings.some((s) => s.index === 7)).toBe(true); // the past is intact
  });
});

describe('structure — classification (HH / HL / LH / LL / range / unclear)', () => {
  test('bullish fixture → HH + HL → trend bullish', () => {
    const det = detectSwings(mk(BULL_H), SWING);
    const cls = classifyStructure(det.swings);
    expect(cls.highLabel).toBe('HH');
    expect(cls.lowLabel).toBe('HL');
    expect(cls.trend).toBe('bullish');
  });

  test('bearish fixture (mirror) → LH + LL → trend bearish', () => {
    const det = detectSwings(mk(mirror(BULL_H)), SWING);
    const cls = classifyStructure(det.swings);
    expect(cls.highLabel).toBe('LH');
    expect(cls.lowLabel).toBe('LL');
    expect(cls.trend).toBe('bearish');
  });

  test('range fixture: HH + LL (conflicting) → trend range', () => {
    // bullish fixture with T2 pushed BELOW T1 (8 < 10): highs still HH, lows LL.
    const rangeH = BULL_H.map(([h, l], i) => (i === 28 ? ([19, 8] as [number, number]) : ([h, l] as [number, number])));
    const det = detectSwings(mk(rangeH), SWING);
    const cls = classifyStructure(det.swings);
    expect(cls.highLabel).toBe('HH');
    expect(cls.lowLabel).toBe('LL');
    expect(cls.trend).toBe('range');
  });

  test('insufficient swings → UNCLEAR labels, trend unclear (never guessed)', () => {
    const det = detectSwings(mk(BULL_H).slice(0, 12), SWING); // only P1 + T1
    const cls = classifyStructure(det.swings);
    expect(cls.highLabel).toBe('UNCLEAR'); // one high only
    expect(cls.lowLabel).toBe('UNCLEAR');
    expect(cls.trend).toBe('unclear');
  });
});

describe('structure — BOS / CHoCH events (close-confirmed, no duplicates)', () => {
  test('bullish BOS: close 22 > 20 on candle 21; wick-only crossings at 19/20 stay unconfirmed', () => {
    const candles = mk(BULL_H);
    const det = detectSwings(candles, SWING);
    const scan = scanStructureEvents(candles, det.swings, SCAN);
    const st = buildStructureResult(candles, det.swings, scan, SCAN);

    expect(st.events.length).toBe(1);
    const e = st.events[0];
    expect(e.type).toBe('BOS'); // trend at break was unclear (only P1+T1 known) → continuation label
    expect(e.direction).toBe('bullish');
    expect(e.level).toBe(20);
    expect(e.levelText).toBe('20.00');
    expect(e.basis).toBe('close');
    expect(e.breakCandleTimeUtcSec).toBe(candles[21].timeUtcSec);
    expect(e.confirmedAtUtcSec).toBe(candles[21].timeUtcSec + TF);
    expect(e.brokenSwingKind).toBe('high');
    expect(e.trendAtBreak).toBe('unclear');

    // Wick-only false breaks (candles 19, 20 poked above 20 but closed below):
    const bullCross = st.unconfirmedCrossings.filter((c) => c.direction === 'bullish');
    expect(bullCross.map((c) => c.candleTimeUtcSec)).toEqual([candles[19].timeUtcSec, candles[20].timeUtcSec]);
  });

  test('bearish BOS (mirror fixture): close below the mirrored swing low on candle 21', () => {
    const candles = mk(mirror(BULL_H));
    const det = detectSwings(candles, SWING);
    const scan = scanStructureEvents(candles, det.swings, SCAN);
    expect(scan.events.length).toBe(1);
    const e = scan.events[0];
    expect(e.type).toBe('BOS');
    expect(e.direction).toBe('bearish');
    expect(e.level).toBe(40); // 60 − 20 (mirror of P1)
    expect(e.basis).toBe('close');
  });

  test('bullish CHoCH: LH + LL (bearish) then close 24.5 > 24 on candle 31', () => {
    // choChUp fixture: P1 30@7, T1 10@14, P2 24@21 (LH), T2 8@28 (LL) →
    // bearish trend; then the tail closes at 24.5, above P2 → CHoCH bullish.
    const CHOCH_UP: Array<[number, number]> = [
      // 0..7 climb to P1 = 30
      [22, 18], [23, 19], [24, 20], [25, 21], [26, 22], [27, 23], [28, 24], [30, 26],
      // 8..14 descent (T1 = 10 @14)
      [29, 25], [28, 24], [27, 23], [26, 22], [25, 21], [24, 20], [22, 10],
      // 15..21 climb to P2 = 24
      [17, 11], [18, 12], [19, 13], [20, 14], [21, 15], [22, 16], [24, 18],
      // 22..28 descent (T2 = 8 @28)
      [23, 17], [22, 16], [21, 15], [20, 14], [19, 13], [18, 12], [17, 8],
      // 29..31 tail closing above P2
      [27, 18], [28, 19], [29, 20],
    ];
    const candles = mk(CHOCH_UP);
    const det = detectSwings(candles, SWING);
    const cls = classifyStructure(det.swings);
    expect(cls.highLabel).toBe('LH');
    expect(cls.lowLabel).toBe('LL');
    expect(cls.trend).toBe('bearish');

    const scan = scanStructureEvents(candles, det.swings, SCAN);
    expect(scan.events.length).toBe(1);
    const e = scan.events[0];
    expect(e.type).toBe('CHoCH'); // bearish trend at break + bullish close-break
    expect(e.direction).toBe('bullish');
    expect(e.level).toBe(24);
    expect(e.breakCandleTimeUtcSec).toBe(candles[31].timeUtcSec);
    expect(e.trendAtBreak).toBe('bearish');

    // wick-only pokes before the confirmed close-break:
    const bullCross = scan.unconfirmedCrossings.filter((c) => c.direction === 'bullish');
    expect(bullCross.map((c) => c.candleTimeUtcSec)).toEqual([candles[29].timeUtcSec, candles[30].timeUtcSec]);
  });

  test('bearish CHoCH (mirror): bullish trend, final close below the mirrored level', () => {
    // Mirror of the choChUp fixture: HH + HL (bullish), then the mirrored tail
    // close (60 − 24.5 = 35.5) breaks BELOW the mirrored P2 level (60 − 24 = 36).
    const chochUp: Array<[number, number]> = [
      [22, 18], [23, 19], [24, 20], [25, 21], [26, 22], [27, 23], [28, 24], [30, 26],
      [29, 25], [28, 24], [27, 23], [26, 22], [25, 21], [24, 20], [22, 10],
      [17, 11], [18, 12], [19, 13], [20, 14], [21, 15], [22, 16], [24, 18],
      [23, 17], [22, 16], [21, 15], [20, 14], [19, 13], [18, 12], [17, 8],
      [27, 18], [28, 19], [29, 20],
    ];
    const candles = mk(mirror(chochUp));
    const det = detectSwings(candles, SWING);
    const cls = classifyStructure(det.swings);
    expect(cls.trend).toBe('bullish'); // mirror of LH+LL = HH+HL
    const scan = scanStructureEvents(candles, det.swings, SCAN);
    expect(scan.events.length).toBe(1);
    const e = scan.events[0];
    expect(e.type).toBe('CHoCH');
    expect(e.direction).toBe('bearish'); // close 60−24.5=35.5 < mirror level 60−24=36
    expect(e.level).toBe(36);
    expect(e.trendAtBreak).toBe('bullish');
  });

  test('duplicate suppression: level 20 fires exactly once despite later closes > 20', () => {
    const candles = mk(BULL_H);
    const det = detectSwings(candles, SWING);
    const scan = scanStructureEvents(candles, det.swings, SCAN);
    // candle 22 closes at 21 (> 20) but P1 was already consumed → no second event.
    expect(scan.events.filter((e) => e.level === 20).length).toBe(1);
    expect(scan.events.length).toBe(1);
    // and P2 (26) is never broken (closes ≤ 19.5 afterwards):
    expect(scan.events.some((e) => e.level === 26)).toBe(false);
  });

  test('no future information leakage: truncating before the break removes the event', () => {
    const full = mk(BULL_H);
    const detFull = detectSwings(full, SWING);
    const cut = full.slice(0, 21); // ends at idx20 — the break candle 21 is in the FUTURE
    const detCut = detectSwings(cut, SWING);
    const scanCut = scanStructureEvents(cut, detCut.swings, SCAN);
    expect(scanCut.events.length).toBe(0); // no event without the breaking candle
    const scanFull = scanStructureEvents(full, detFull.swings, SCAN);
    expect(scanFull.events.length).toBe(1); // the SAME data plus the future candle → event exists
  });

  test('a close exactly AT the level is NOT a break (strict inequality)', () => {
    // Candle 21 is patched to [26, 14] → close = 14 + (26−14)·0.5 = 20.00 EXACTLY
    // at the P1 level (20). That close must NOT confirm a break; the honest
    // record is an unconfirmed wick crossing. The level is then legitimately
    // broken one candle later by candle 22 (close 21 > 20).
    const fixture = BULL_H.map(([h, l], i) => (i === 21 ? ([26, 14] as [number, number]) : ([h, l] as [number, number])));
    const candles = mk(fixture);
    expect(candles[21].close).toBe(20); // exactly at the level, not beyond it

    // Truncated AFTER candle 21 (indices 0..21): the exact-at-level close
    // produced NO event — only the wick crossing is recorded.
    const cut = candles.slice(0, 22);
    const detCut = detectSwings(cut, SWING);
    const scanCut = scanStructureEvents(cut, detCut.swings, SCAN);
    expect(scanCut.events.length).toBe(0);
    expect(scanCut.unconfirmedCrossings.some((c) => c.direction === 'bullish' && c.candleTimeUtcSec === cut[21].timeUtcSec)).toBe(true);

    // Full fixture: exactly ONE event for level 20 — confirmed by candle 22
    // (the first close STRICTLY beyond the level), never by candle 21.
    const det = detectSwings(candles, SWING);
    const scan = scanStructureEvents(candles, det.swings, SCAN);
    const level20 = scan.events.filter((e) => e.level === 20);
    expect(level20.length).toBe(1);
    expect(level20[0].breakCandleTimeUtcSec).toBe(candles[22].timeUtcSec);
    expect(level20[0].breakCandleTimeUtcSec === candles[21].timeUtcSec).toBe(false);
  });
});
