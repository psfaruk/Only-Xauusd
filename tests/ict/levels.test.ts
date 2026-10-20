/**
 * Phase 14, Task 34-e — A4 Key Levels Agent tests.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: every candle below is a SYNTHETIC hand-built fixture
 * constructed to exercise specific key-level paths. They are never presented
 * as broker data.
 *
 * Fixture invariants (hand-verified row by row):
 *   · M5 grid: t = T0 + i·300, digits = 2 (canonical text x.xx).
 *   · Exact-ATR trick (liquidity/poi suites): every candle spans EXACTLY
 *     2.00 (high − low) and OPENS at the previous close → every true range
 *     is exactly 2.00 → ATR(14) = 2.00 EXACTLY for any fixture with
 *     ≥ 14 candles. keyLevelTolAtr 0.25 → touch/cluster band 0.50 EXACT.
 *     Fixtures with fewer than 14 candles carry NO ATR at all (fail-closed
 *     clustering/touches). PD_DAYS spans a synthetic day gap but keeps the
 *     span-2.00 + open-at-previous-close invariants, so its ATR is exact too.
 *   · Swing window left = right = 2: a swing at index i is confirmed by the
 *     close of candle i+2, so its level becomes TOUCHABLE from index i+3 on
 *     (the causal visibility gate pinned by the TOUCH_RES fixture).
 *   · Time placement: the swing/cluster fixtures start 20:55 UTC with
 *     nowUtcSec 23:00–23:55 the SAME UTC day → only candle 0 sits inside a
 *     session envelope (NY [12:00, 21:00) — 1 < 5 candles) and NO candle
 *     belongs to the previous day → no session and no PDH/PDL levels; only
 *     swing + round-number levels can emit. Round numbers are ALWAYS
 *     present (the 2 grid neighbours) in every non-empty read — all
 *     expected arrays below include them.
 *
 * Fixture layouts (every swing index hand-verified with the Phase 4 rules):
 *   TOUCH_RES : single swing high 2656.0@4 (the ONLY swing — the decline
 *               after the retest never bounces). Candles 7 & 8 retest within
 *               0.50 below the level (touch #1 0.40, touch #2 0.30); candle 6
 *               — the CONFIRMATION candle, high 0.10 below the level — is
 *               pre-visibility and must NOT count; candle 5 (0.60 below) sits
 *               outside the band anyway. Decision close 2651.3 → strength
 *               min(90, 40+10×2) + 5 recency = 65.
 *   DESCEND   : 36 marubozu candles in a descending 5-bar cycle ([U,U,D,D,D]
 *               with −2.00 net drift) — 7 swing highs 2658@2 … 2646@32 (2.00
 *               apart → NO clustering) and 6 swing lows 2652@5 … 2642@30 (all
 *               ABOVE the close → no SUPPORT, and 2.00 apart → no DEMAND).
 *               13 confirmed swings total → the first THREE chronological
 *               positions (peaks 2658@2, 2656@7 and trough 2652@5) miss the
 *               last-10 recency window: RESISTANCE 2658/2656 carry strength 40
 *               (no bonus) while 2654…2646 carry 45. Zero post-confirmation
 *               approaches (the next peak always sits 2.00 below). Decision
 *               close 2640.0 — exactly on the round grid (distance tie 5.00 /
 *               5.00 → level-ascending order pins the sort tiebreak).
 *   SUPPLY    : swing highs 2654.0@4 + 2654.3@8 (0.30 ≤ 0.50 band → ONE
 *               cluster) + one swing low 2651.5@6 ABOVE the close (emits
 *               nothing). The cluster emits ONE SUPPLY at the MAX 2654.3,
 *               strength 60 + 8×2 = 76, origin = the EARLIEST member bar; the
 *               two member RESISTANCEs are suppressed. Decision close 2650.4.
 *   DEMAND    : point-mirror of SUPPLY (axis 5300) → swing lows 2646.0@4 +
 *               2645.7@8 → ONE DEMAND at the cluster MIN 2645.7; mirrored
 *               close 2649.6.
 *   PD_DAYS   : 12 candles on 2026-10-14 21:00–21:55 (previous UTC day:
 *               PDH 2654.0@6-high, PDL 2648.6@11-low) + 8 candles on
 *               2026-10-15 21:00–21:35 (current day), nowUtcSec = Oct 15
 *               23:00. Day 2 spikes to 2655.5 — HIGHER than day 1 — and must
 *               NOT become the PDH. Swing high 2654.0@6 lands EXACTLY on the
 *               PDH → the 0.05 different-kind dedup keeps the PDH (80) and
 *               drops the RESISTANCE (65). Late-evening candles → no session
 *               levels.
 *   ASIA      : 8 candles on 2026-10-15 22:00–22:55 (previous day → PDH
 *               2654.8 / PDL 2646.6) + 8 candles on 2026-10-16 00:00–00:35 —
 *               ALL inside the Asia envelope [00:00, 07:00) of the current
 *               day (8 ≥ 5 → Asia session high 2651.0 / low 2645.0).
 *               nowUtcSec = Oct 16 02:00 — INSIDE the still-forming Asia
 *               session, pinning the live-level rule. Swing low 2645.0@9
 *               lands EXACTLY on the session low → dedup keeps SESSION_LOW
 *               (50), drops the SUPPORT (45).
 *   ROUNDS_A  : 6 rising candles (no swing fits the 2/2 window, no ATR) →
 *               close 2662.3 → ONLY the round levels 2660 / 2665.
 *   ROUNDS_B  : same shape closing EXACTLY on the 2660.0 grid point → the
 *               STRICT neighbours 2655 / 2665 (never the close itself).
 */

import { describe, expect, test } from 'bun:test';
import { readKeyLevels } from '@/lib/signal/ict/agents/levels';
import type { AnalysisCandle, } from '@/lib/analysis/types';
import type { KeyLevel } from '@/lib/signal/ict/types';

const TF = 300; // M5
const DIGITS = 2;

const PARAMS = {
  swingLeft: 2,
  swingRight: 2,
  roundNumberStep: 5.0, // XAUUSD psychological grid
  keyLevelTolAtr: 0.25, // × ATR 2.00 → touch/cluster band 0.50 exact
  atrPeriod: 14,
};

// --- time anchors (fixed test clock) -----------------------------------------

const DAY1_START = 1_791_936_000; // 2026-10-14T00:00:00Z (Wednesday)
const T_LATE = DAY1_START + 75_300; // Oct 14 20:55 — only candle 0 inside NY [12:00, 21:00)
const NOW_LATE = DAY1_START + 82_800; // Oct 14 23:00 (same day — no previous-day candles)
const NOW_LATE_2355 = DAY1_START + 86_100; // Oct 14 23:55 (DESCEND: last candle 23:50 closes now)

const DAY2_START = DAY1_START + 86_400; // 2026-10-15
const T_D1_2100 = DAY1_START + 75_600; // Oct 14 21:00 (PD_DAYS day 1)
const T_D2_2100 = DAY2_START + 75_600; // Oct 15 21:00 (PD_DAYS day 2)
const NOW_PD = DAY2_START + 82_800; // Oct 15 23:00 — inside day 2

const DAY3_START = DAY2_START + 86_400; // 2026-10-16
const T_D2_2200 = DAY2_START + 79_200; // Oct 15 22:00 (ASIA previous day)
const T_D3_0000 = DAY3_START; // Oct 16 00:00 (ASIA window start)
const NOW_ASIA = DAY3_START + 7_200; // Oct 16 02:00 — INSIDE the ongoing Asia session

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

/** Rows → closed candles on a regular M5 grid starting at `t0`. */
function grid(rows: Row[], t0: number): AnalysisCandle[] {
  return rows.map(([o, h, l, c], i) => candle(t0 + i * TF, o, h, l, c));
}

/** Point-mirror around `axis` — flips highs↔lows, preserves every invariant. */
function mirror(rows: Row[], axis = 5300): Row[] {
  return rows.map(([o, h, l, c]) => [axis - o, axis - l, axis - h, axis - c]);
}

/** The locked round-number level (strength 70, no origin, canonical text). */
function roundLevel(level: number): KeyLevel {
  return {
    kind: 'ROUND_NUMBER',
    level,
    levelText: level.toFixed(2),
    strength: 70,
    labelEn: 'Round number',
    labelBn: 'রাউন্ড নাম্বার',
    originUtcSec: null,
  };
}

// --- fixtures ----------------------------------------------------------------

/** Rise to one swing high, two visible retests, then a clean decline. */
const TOUCH_RES: Row[] = [
  // i=0..3 rise into the peak
  [2650.0, 2651.2, 2649.2, 2650.8],
  [2650.8, 2652.0, 2650.0, 2651.6],
  [2651.6, 2653.0, 2651.0, 2652.4],
  [2652.4, 2654.0, 2652.0, 2653.2],
  // i=4 the swing high — 2656.0 (confirmed by candle 6, touchable from 7)
  [2653.2, 2656.0, 2654.0, 2655.2],
  // i=5 fade (0.60 below the level — outside the 0.50 band)
  [2655.2, 2655.4, 2653.4, 2654.0],
  // i=6 CONFIRMATION candle, high 0.10 below the level — PRE-visibility
  [2654.0, 2655.9, 2653.9, 2654.4],
  // i=7..8 the two visible retests (0.40 / 0.30 below → touches 1 and 2)
  [2654.4, 2655.6, 2653.6, 2654.2],
  [2654.2, 2655.7, 2653.7, 2653.9],
  // i=9..17 decline away from the level (never within 0.50 again)
  [2653.9, 2654.9, 2652.9, 2653.5],
  [2653.5, 2654.5, 2652.5, 2653.0],
  [2653.0, 2654.0, 2652.0, 2652.5],
  [2652.5, 2653.5, 2651.5, 2652.0],
  [2652.0, 2653.0, 2651.0, 2651.5],
  [2651.5, 2652.5, 2650.5, 2651.0],
  [2651.0, 2652.0, 2650.0, 2650.5],
  [2650.5, 2651.5, 2649.5, 2650.9],
  [2650.9, 2651.9, 2649.9, 2651.3], // decision close 2651.3
];

/**
 * Descending 5-bar marubozu cycle: peak, D, D, D(trough), U, U(peak)… with a
 * net −2.00 drift per cycle. Peaks 2658@2, 2656@7, 2654@12, 2652@17, 2650@22,
 * 2648@27, 2646@32; troughs 2652@5, 2650@10, 2648@15, 2646@20, 2644@25,
 * 2642@30 (all above the final close 2640.0).
 */
const DESCEND: Row[] = [
  [2656, 2656, 2654, 2654], // 0 D
  [2654, 2656, 2654, 2656], // 1 U
  [2656, 2658, 2656, 2658], // 2 U ← swing high 2658
  [2658, 2658, 2656, 2656], // 3 D
  [2656, 2656, 2654, 2654], // 4 D
  [2654, 2654, 2652, 2652], // 5 D ← swing low 2652
  [2652, 2654, 2652, 2654], // 6 U
  [2654, 2656, 2654, 2656], // 7 U ← swing high 2656
  [2656, 2656, 2654, 2654], // 8 D
  [2654, 2654, 2652, 2652], // 9 D
  [2652, 2652, 2650, 2650], // 10 D ← swing low 2650
  [2650, 2652, 2650, 2652], // 11 U
  [2652, 2654, 2652, 2654], // 12 U ← swing high 2654
  [2654, 2654, 2652, 2652], // 13 D
  [2652, 2652, 2650, 2650], // 14 D
  [2650, 2650, 2648, 2648], // 15 D ← swing low 2648
  [2648, 2650, 2648, 2650], // 16 U
  [2650, 2652, 2650, 2652], // 17 U ← swing high 2652
  [2652, 2652, 2650, 2650], // 18 D
  [2650, 2650, 2648, 2648], // 19 D
  [2648, 2648, 2646, 2646], // 20 D ← swing low 2646
  [2646, 2648, 2646, 2648], // 21 U
  [2648, 2650, 2648, 2650], // 22 U ← swing high 2650
  [2650, 2650, 2648, 2648], // 23 D
  [2648, 2648, 2646, 2646], // 24 D
  [2646, 2646, 2644, 2644], // 25 D ← swing low 2644
  [2644, 2646, 2644, 2646], // 26 U
  [2646, 2648, 2646, 2648], // 27 U ← swing high 2648
  [2648, 2648, 2646, 2646], // 28 D
  [2646, 2646, 2644, 2644], // 29 D
  [2644, 2644, 2642, 2642], // 30 D ← swing low 2642
  [2642, 2644, 2642, 2644], // 31 U
  [2644, 2646, 2644, 2646], // 32 U ← swing high 2646
  [2646, 2646, 2644, 2644], // 33 D
  [2644, 2644, 2642, 2642], // 34 D
  [2642, 2642, 2640, 2640], // 35 D — decision close 2640.0 (on the round grid)
];

/** Two equal-ish swing highs → one SUPPLY cluster; no usable swing lows. */
const SUPPLY: Row[] = [
  [2650.0, 2651.2, 2649.2, 2650.8],
  [2650.8, 2652.0, 2650.0, 2651.6],
  [2651.6, 2652.8, 2650.8, 2652.4],
  [2652.4, 2653.6, 2651.6, 2653.2],
  // i=4 swing high A — 2654.0
  [2653.2, 2654.0, 2652.0, 2653.6],
  [2653.6, 2653.8, 2651.8, 2652.4],
  [2652.4, 2653.5, 2651.5, 2652.0], // i=6 swing low 2651.5 (ABOVE the close — emits nothing)
  [2652.0, 2653.9, 2651.9, 2652.8],
  // i=8 swing high B — 2654.3 (0.30 above A → cluster)
  [2652.8, 2654.3, 2652.3, 2653.6],
  [2653.6, 2654.1, 2652.1, 2652.9],
  [2652.9, 2653.7, 2651.7, 2652.2],
  [2652.2, 2653.3, 2651.3, 2651.8],
  [2651.8, 2652.9, 2650.9, 2651.4],
  [2651.4, 2652.5, 2650.5, 2651.0],
  [2651.0, 2652.1, 2650.1, 2650.6],
  [2650.6, 2651.6, 2649.6, 2650.2],
  [2650.2, 2651.2, 2649.2, 2649.8],
  [2649.8, 2650.8, 2648.8, 2650.4], // decision close 2650.4
];

const DEMAND: Row[] = mirror(SUPPLY);

/** Two UTC days: previous-day candles define PDH/PDL; day 2 spikes higher. */
const PD_DAYS_D1: Row[] = [
  [2650.0, 2651.0, 2649.0, 2650.5],
  [2650.5, 2651.5, 2649.5, 2651.0],
  [2651.0, 2652.0, 2650.0, 2651.5],
  [2651.5, 2652.5, 2650.5, 2652.0],
  [2652.0, 2653.0, 2651.0, 2652.5],
  [2652.5, 2653.5, 2651.5, 2653.0],
  [2653.0, 2654.0, 2652.0, 2653.2], // i=6 day-1 max high 2654.0 → PDH
  [2653.2, 2653.8, 2651.8, 2652.4],
  [2652.4, 2653.0, 2651.0, 2651.6],
  [2651.6, 2652.2, 2650.2, 2650.8],
  [2650.8, 2651.4, 2649.4, 2650.0],
  [2650.0, 2650.6, 2648.6, 2649.2], // i=11 day-1 min low 2648.6 → PDL
];
const PD_DAYS_D2: Row[] = [
  [2649.2, 2650.2, 2648.2, 2649.8], // swing low 2648.2 (synthetic day-gap connect)
  [2649.8, 2651.0, 2649.0, 2650.6],
  [2650.6, 2652.0, 2650.0, 2651.4],
  [2651.4, 2653.5, 2651.5, 2653.0],
  [2653.0, 2655.5, 2653.5, 2654.5], // day-2 spike 2655.5 — NOT the PDH
  [2654.5, 2655.0, 2653.0, 2653.5],
  [2653.5, 2654.0, 2652.0, 2652.5],
  [2652.5, 2653.0, 2651.0, 2651.5], // decision close 2651.5
];

const PD_DAYS: AnalysisCandle[] = [
  ...grid(PD_DAYS_D1, T_D1_2100),
  ...grid(PD_DAYS_D2, T_D2_2100),
];

/** Previous-day decline (PDH/PDL) + a current-day Asia window V-bottom. */
const ASIA_D2: Row[] = [
  [2654.0, 2654.8, 2652.8, 2653.2], // previous UTC day (Oct 15) — PDH 2654.8 @ i0 high
  [2653.2, 2653.6, 2651.6, 2652.0],
  [2652.0, 2652.6, 2650.6, 2651.2],
  [2651.2, 2651.8, 2649.8, 2650.4],
  [2650.4, 2651.0, 2649.0, 2649.6],
  [2649.6, 2650.2, 2648.2, 2648.8],
  [2648.8, 2649.4, 2647.4, 2648.0],
  [2648.0, 2648.6, 2646.6, 2647.2], // PDL 2646.6 @ i7 low
];
const ASIA_D3: Row[] = [
  [2647.2, 2647.8, 2645.8, 2646.4], // Oct 16 00:00 — Asia window starts
  [2646.4, 2647.0, 2645.0, 2645.6], // i=9 swing low 2645.0 → session low
  [2645.6, 2647.0, 2645.0, 2646.4], // low ties 2645.0 — the earlier candle wins
  [2646.4, 2647.8, 2645.8, 2647.2],
  [2647.2, 2648.6, 2646.6, 2648.0],
  [2648.0, 2649.4, 2647.4, 2648.8],
  [2648.8, 2650.2, 2648.2, 2649.6],
  [2649.6, 2651.0, 2649.0, 2650.4], // session high 2651.0, decision close 2650.4
];

const ASIA: AnalysisCandle[] = [
  ...grid(ASIA_D2, T_D2_2200),
  ...grid(ASIA_D3, T_D3_0000),
];

/** Six rising candles → nothing but the round-number grid. */
const ROUNDS_A: Row[] = [
  [2658.0, 2659.0, 2657.0, 2658.6],
  [2658.6, 2659.6, 2657.6, 2659.2],
  [2659.2, 2660.2, 2658.2, 2659.8],
  [2659.8, 2660.8, 2658.8, 2660.4],
  [2660.4, 2661.4, 2659.4, 2661.0],
  [2661.0, 2662.5, 2660.5, 2662.3], // decision close 2662.3 (between grid points)
];

const ROUNDS_B: Row[] = [
  [2655.6, 2656.6, 2654.6, 2656.2],
  [2656.2, 2657.2, 2655.2, 2656.8],
  [2656.8, 2657.8, 2655.8, 2657.4],
  [2657.4, 2658.4, 2656.4, 2658.0],
  [2658.0, 2659.0, 2657.0, 2658.6],
  [2658.6, 2660.0, 2658.0, 2660.0], // decision close EXACTLY on the 2660.0 grid point
];

// --- 1. swing resistance with counted touches ----------------------------------

describe('A4 key levels — swing resistance above the close with touches', () => {
  const read = readKeyLevels(grid(TOUCH_RES, T_LATE), PARAMS, DIGITS, NOW_LATE);

  test('full read: two round levels + one RESISTANCE, nearest magnets set', () => {
    expect(read).toEqual({
      levels: [
        roundLevel(2650),
        roundLevel(2655),
        {
          kind: 'RESISTANCE',
          level: 2656,
          levelText: '2656.00',
          strength: 65, // min(90, 40 + 10×2) + 5 recency (the only swing)
          labelEn: 'Swing resistance',
          labelBn: 'সুইং রেজিস্ট্যান্স',
          originUtcSec: T_LATE + 4 * TF,
        },
      ],
      nearestAbove: roundLevel(2655),
      nearestBelow: roundLevel(2650),
    });
  });

  test('touches count only POST-confirmation approaches (candles 7 & 8, not the confirmation candle 6)', () => {
    const res = read.levels.find((l) => l.kind === 'RESISTANCE');
    expect(res).toBeDefined();
    // candle 7 high 2655.6 (−0.40) and candle 8 high 2655.7 (−0.30) touch;
    // candle 6 high 2655.9 (−0.10) precedes visibility (index 7) and must
    // NOT count — pinned by strength 65 = 40 + 10×2 + 5 in the test above.
    expect(res?.strength).toBe(65);
  });

  test('no SUPPORT/SUPPLY/DEMAND/PD/session kinds leak into the read', () => {
    expect(read.levels.map((l) => l.kind)).toEqual(['ROUND_NUMBER', 'ROUND_NUMBER', 'RESISTANCE']);
  });
});

// --- 2. recency bonus (last 10 confirmed swings) --------------------------------

describe('A4 key levels — recency bonus over 13 confirmed swings', () => {
  const read = readKeyLevels(grid(DESCEND, T_LATE), PARAMS, DIGITS, NOW_LATE_2355);

  test('seven unclustered swing highs above the close, nearest-to-price first', () => {
    expect(read.levels.map((l) => [l.kind, l.level, l.strength])).toEqual([
      ['ROUND_NUMBER', 2635, 70], // close 2640.0 sits ON the grid → 5.00/5.00 tie → level asc
      ['ROUND_NUMBER', 2645, 70],
      ['RESISTANCE', 2646, 45],
      ['RESISTANCE', 2648, 45],
      ['RESISTANCE', 2650, 45],
      ['RESISTANCE', 2652, 45],
      ['RESISTANCE', 2654, 45],
      ['RESISTANCE', 2656, 40], // swing position 2 — OUTSIDE the last-10 window
      ['RESISTANCE', 2658, 40], // swing position 0 — OUTSIDE the last-10 window
    ]);
    expect(read.nearestAbove?.level).toBe(2645);
    expect(read.nearestBelow?.level).toBe(2635);
  });

  test('the oldest peaks miss the +5 recency bonus; every later peak earns it', () => {
    const oldest = read.levels.find((l) => l.level === 2658);
    expect(oldest?.originUtcSec).toBe(T_LATE + 2 * TF); // swing bar time
    expect(oldest?.strength).toBe(40); // 40 + 10×0 touches, NO recency bonus
    const recent = read.levels.find((l) => l.level === 2654);
    expect(recent?.originUtcSec).toBe(T_LATE + 12 * TF);
    expect(recent?.strength).toBe(45); // 40 + 10×0 touches + 5 recency
  });

  test('troughs above the close and 2.00-spaced peaks emit nothing else', () => {
    expect(read.levels.every((l) => l.kind === 'RESISTANCE' || l.kind === 'ROUND_NUMBER')).toBe(true);
  });
});

// --- 3. supply / demand clusters -------------------------------------------------

describe('A4 key levels — swing-high cluster emits ONE SUPPLY at the cluster max', () => {
  const read = readKeyLevels(grid(SUPPLY, T_LATE), PARAMS, DIGITS, NOW_LATE);

  test('full read: the cluster level plus the round grid, nothing else', () => {
    const supply: KeyLevel = {
      kind: 'SUPPLY',
      level: 2654.3, // the cluster MAX (member A 2654.0 + member B 2654.3)
      levelText: '2654.30',
      strength: 76, // 60 + 8 × 2 members
      labelEn: 'Supply zone',
      labelBn: 'সাপ্লাই জোন',
      originUtcSec: T_LATE + 4 * TF, // the EARLIEST member bar
    };
    expect(read).toEqual({
      levels: [roundLevel(2650), supply, roundLevel(2655)],
      nearestAbove: supply,
      nearestBelow: roundLevel(2650),
    });
  });

  test('member RESISTANCE levels are suppressed (no RESISTANCE kind at all)', () => {
    expect(read.levels.some((l) => l.kind === 'RESISTANCE')).toBe(false);
  });
});

describe('A4 key levels — swing-low cluster emits ONE DEMAND at the cluster min (mirror)', () => {
  const read = readKeyLevels(grid(DEMAND, T_LATE), PARAMS, DIGITS, NOW_LATE);

  test('full read: the demand level plus the round grid, nothing else', () => {
    const demand: KeyLevel = {
      kind: 'DEMAND',
      level: 2645.7, // the cluster MIN (mirror of the SUPPLY max 2654.3)
      levelText: '2645.70',
      strength: 76,
      labelEn: 'Demand zone',
      labelBn: 'ডিমান্ড জোন',
      originUtcSec: T_LATE + 4 * TF,
    };
    expect(read).toEqual({
      levels: [roundLevel(2650), demand, roundLevel(2645)],
      nearestAbove: roundLevel(2650), // mirrored close 2649.6
      nearestBelow: demand,
    });
  });
});

// --- 4. PDH / PDL from the previous UTC day --------------------------------------

describe('A4 key levels — PDH/PDL come from the PREVIOUS UTC day only', () => {
  const read = readKeyLevels(PD_DAYS, PARAMS, DIGITS, NOW_PD);

  test('PDH/PDL from day 1 — the higher day-2 spike is NOT the PDH', () => {
    const pdh = read.levels.find((l) => l.kind === 'PDH');
    expect(pdh).toEqual({
      kind: 'PDH',
      level: 2654,
      levelText: '2654.00',
      strength: 80,
      labelEn: 'Previous day high',
      labelBn: 'আগের দিনের হাই',
      originUtcSec: DAY1_START, // previous-day start, not a candle time
    });
    expect(read.levels.some((l) => l.kind === 'PDH' && l.level === 2655.5)).toBe(false);
    const pdl = read.levels.find((l) => l.kind === 'PDL');
    expect(pdl).toEqual({
      kind: 'PDL',
      level: 2648.6,
      levelText: '2648.60',
      strength: 80,
      labelEn: 'Previous day low',
      labelBn: 'আগের দিনের লো',
      originUtcSec: DAY1_START,
    });
  });

  test('the 0.05 dedup keeps the PDH (80) and drops the same-price RESISTANCE (65)', () => {
    // swing high 2654.0@6 sits EXACTLY on the PDH — one level survives.
    expect(read.levels.filter((l) => l.level === 2654)).toHaveLength(1);
    expect(read.levels.find((l) => l.level === 2654)?.kind).toBe('PDH');
  });

  test('full emission order (nearest-to-price) and magnets', () => {
    expect(read.levels.map((l) => [l.kind, l.level])).toEqual([
      ['ROUND_NUMBER', 2650], // 1.5 away
      ['PDH', 2654], // 2.5
      ['PDL', 2648.6], // 2.9
      ['SUPPORT', 2648.2], // 3.3 (swing low 2648.2@12, 0 touches → strength 45)
      ['ROUND_NUMBER', 2655], // 3.5
      ['RESISTANCE', 2655.5], // 4.0 (day-2 spike swing, 0 touches → 45)
    ]);
    expect(read.nearestAbove?.level).toBe(2654);
    expect(read.nearestBelow?.level).toBe(2650);
  });
});

// --- 5. session high/low (live current session) -----------------------------------

describe('A4 key levels — Asia session H/L as LIVE levels of the current session', () => {
  const read = readKeyLevels(ASIA, PARAMS, DIGITS, NOW_ASIA);

  test('Asia session high/low with Bengali labels, strength 50, session-start origin', () => {
    expect(read.levels.find((l) => l.kind === 'SESSION_HIGH')).toEqual({
      kind: 'SESSION_HIGH',
      level: 2651,
      levelText: '2651.00',
      strength: 50,
      labelEn: 'Asia session high',
      labelBn: 'এশিয়ান সেশন হাই',
      originUtcSec: DAY3_START, // Asia window start = current-day 00:00 UTC
    });
    expect(read.levels.find((l) => l.kind === 'SESSION_LOW')).toEqual({
      kind: 'SESSION_LOW',
      level: 2645,
      levelText: '2645.00',
      strength: 50,
      labelEn: 'Asia session low',
      labelBn: 'এশিয়ান সেশন লো',
      originUtcSec: DAY3_START,
    });
  });

  test('nowUtcSec 02:00 sits INSIDE the still-forming Asia session — the levels are live', () => {
    // 8 candles inside [00:00, 07:00) ≥ 5 → emitted even though the session
    // has hours left (the locked live-level rule).
    expect(NOW_ASIA).toBeLessThan(DAY3_START + 7 * 3600);
    expect(read.levels.some((l) => l.kind === 'SESSION_HIGH')).toBe(true);
  });

  test('London/NY windows hold no candles → no other session levels; PDH/PDL from Oct 15', () => {
    expect(read.levels.filter((l) => l.kind === 'SESSION_HIGH' || l.kind === 'SESSION_LOW')).toHaveLength(2);
    expect(read.levels.find((l) => l.kind === 'PDH')?.level).toBe(2654.8);
    expect(read.levels.find((l) => l.kind === 'PDL')?.level).toBe(2646.6);
  });

  test('full emission order and magnets (the swing low 2645.0 is absorbed by the session low)', () => {
    expect(read.levels.map((l) => [l.kind, l.level])).toEqual([
      ['ROUND_NUMBER', 2650], // 0.4 away from the close 2650.4
      ['SESSION_HIGH', 2651], // 0.6
      ['PDL', 2646.6], // 3.8
      ['PDH', 2654.8], // 4.4
      ['ROUND_NUMBER', 2655], // 4.6
      ['SESSION_LOW', 2645], // 5.4 — dedup kept it over the same-price SUPPORT (45)
    ]);
    expect(read.levels.filter((l) => l.level === 2645)).toHaveLength(1); // SUPPORT dropped
    expect(read.nearestAbove?.level).toBe(2651);
    expect(read.nearestBelow?.level).toBe(2650);
  });
});

// --- 6. round numbers --------------------------------------------------------------

describe('A4 key levels — round-number grid neighbours of the decision close', () => {
  test('close 2662.3 with step 5 → 2660 below / 2665 above, nothing else', () => {
    const read = readKeyLevels(grid(ROUNDS_A, T_D1_2100), PARAMS, DIGITS, NOW_LATE);
    expect(read).toEqual({
      levels: [roundLevel(2660), roundLevel(2665)],
      nearestAbove: roundLevel(2665),
      nearestBelow: roundLevel(2660),
    });
  });

  test('close exactly ON the grid point → the STRICT neighbours 2655 / 2665', () => {
    const read = readKeyLevels(grid(ROUNDS_B, T_D1_2100), PARAMS, DIGITS, NOW_LATE);
    expect(read).toEqual({
      levels: [roundLevel(2655), roundLevel(2665)], // 5.00/5.00 tie → level ascending
      nearestAbove: roundLevel(2665),
      nearestBelow: roundLevel(2655),
    });
  });
});

// --- 7. insufficient input (fail empty, never fabricate) ---------------------------

describe('A4 key levels — insufficient input (fail empty, never fabricate)', () => {
  test('empty candle array → empty levels, null magnets', () => {
    const read = readKeyLevels([], PARAMS, DIGITS, NOW_LATE);
    expect(read).toEqual({ levels: [], nearestAbove: null, nearestBelow: null });
  });

  test('three candles (< swing window, < ATR period) → only the round grid degrades through', () => {
    const read = readKeyLevels(grid(TOUCH_RES.slice(0, 3), T_LATE), PARAMS, DIGITS, NOW_LATE);
    expect(read).toEqual({
      levels: [roundLevel(2650), roundLevel(2655)], // close 2652.4
      nearestAbove: roundLevel(2655),
      nearestBelow: roundLevel(2650),
    });
  });
});

// --- 8. determinism -----------------------------------------------------------------

describe('A4 key levels — determinism', () => {
  test('identical input yields deeply identical reads (touch fixture)', () => {
    const a = readKeyLevels(grid(TOUCH_RES, T_LATE), PARAMS, DIGITS, NOW_LATE);
    const b = readKeyLevels(grid(TOUCH_RES, T_LATE), PARAMS, DIGITS, NOW_LATE);
    expect(a).toEqual(b);
  });

  test('identical input yields deeply identical reads (PD/day-gap fixture)', () => {
    const a = readKeyLevels(PD_DAYS, PARAMS, DIGITS, NOW_PD);
    const b = readKeyLevels(PD_DAYS, PARAMS, DIGITS, NOW_PD);
    expect(a).toEqual(b);
  });
});
