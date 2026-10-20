/**
 * Phase 14, Task 34-d — A3 POI Agent tests.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: every candle below is a SYNTHETIC hand-built fixture
 * constructed to exercise specific POI paths. They are never presented as
 * broker data.
 *
 * Fixture invariants (hand-verified row by row):
 *   · M5 grid: t = T0 + i·300, digits = 2 (canonical text x.xx).
 *   · Every candle spans EXACTLY 2.00 (high − low) and OPENS at the previous
 *     close → every true range is exactly 2.00 → ATR(14) = 2.00 EXACTLY for
 *     any fixture with ≥ 14 candles. Gates are therefore exact:
 *     obMinDisplacementAtr 1.0 → displacement body ≥ 2.00 (only full-span
 *     marubozus qualify, and the marubozu body 2.00 meets the 2.00 gate
 *     exactly); fvgMinGapAtr 0.2 → FVG gap ≥ 0.40.
 *   · ATR(14) carries its first value at INDEX 13, so zones can only be
 *     CREATED from index 13 on (fail-closed warm-up). Every fixture keeps
 *     its pattern-completing candle at index ≥ 13 and creations before
 *     index 13 are impossible by construction.
 *   · All prices sit on the binary-exact quarter grid (x.00/x.25/x.50/x.75)
 *     → every asserted level, gap, body and ratio is float-exact.
 *
 * Fixture layouts (every creation index hand-checked for unintended zones —
 * OB displacement clusters, FVG triples and the top > bottom guard):
 *   BULL_OB  : 12-candle ±0.25 warm-up → red cluster candle 12 (open 2650.00,
 *              low 2648.50) → bullish marubozu candle 13 (body 2.00, close
 *              2651.50 > cluster top 2650.00) → BULLISH_OB [2648.50, 2650.00],
 *              displacementAtr 1.0, fresh.
 *   BEAR_OB  : point-mirror of BULL_OB (axis 5300) → up-cluster candle 12
 *              (close 2650.50, high 2651.50) + bearish marubozu candle 13
 *              (close 2648.50 < cluster bottom 2650.50) → BEARISH_OB
 *              [2650.50, 2651.50].
 *   BULL_FVG : decline/doji warm-up → candle 12 high 2650.00 (FVG c1) →
 *              marubozu candle 13 (FVG c2, body 2.00) → candle 14 low 2650.75
 *              (FVG c3, gap 0.75 ≥ 0.40) → BULLISH_FVG [2650.00, 2650.75],
 *              displacementAtr 1.0 (middle-candle body 2.00 / ATR 2.00).
 *   BEAR_FVG : point-mirror of BULL_FVG → BEARISH_FVG [2649.25, 2650.00]
 *              (candle 12 low 2650.00 > candle 14 high 2649.25, gap 0.75).
 *   MITIGATE : BULL_OB + candle 14 dips low 2649.50 ≤ top 2650.00 and closes
 *              2651.00 ≥ bottom 2648.50 → fresh false, timesTested 1,
 *              mitigatedAtUtcSec set, still active.
 *   VIOLATE  : BULL_OB + candle 14 fades to close 2650.25 (low 2650.25 stays
 *              ABOVE the top → no test) + candle 15 closes 2648.25 < bottom
 *              2648.50 → active false; the read emits no zone at all.
 *   BREAKER  : BULL_OB + dip candle 14' (test 1) + violating candle 15 (close
 *              2648.25 < 2648.50) + reclaim marubozu candle 16 (close 2650.25
 *              > top 2650.00) → kind BULLISH_BREAKER, active again, fresh
 *              false, violatedAtUtcSec consumed (null). NB: candle 16 would
 *              pair with the cluster [14',15] (top 2651.50) — its close never
 *              clears that top, so no second OB appears; the marubozu cluster
 *              ending at candle 13 is degenerate (close == high → top ==
 *              bottom) and is refused by the locked top > bottom guard.
 *   INSIDE   : BULL_OB + candle 14 taps low 2649.75 and CLOSES 2649.75 INSIDE
 *              [2648.50, 2650.00] → the decision close sits inside the zone,
 *              so nearestBullish is that zone ONLY through the inside-rule
 *              (its top 2650.00 is ABOVE the close — the plain at/above rule
 *              would leave nearestBullish null).
 *   WEAK_LEG : BULL_OB with the displacement body cut to 1.75 = 0.875×ATR
 *              (< 1×ATR); the close 2651.25 still clears the cluster top —
 *              geometry qualifies, the body gate refuses → no zone at all.
 *   EXHAUST  : BULL_OB + FOUR tap candles (none ever closes below the zone
 *              bottom) → timesTested 4 > poiMaxTests 3 → exhausted → the
 *              zone vanishes from the read without any violation.
 *   DEDUPE   : BULL_OB + a second displacement marubozu candle 14 (close
 *              2653.50, body 2.00) that re-detects the SAME cluster via the
 *              distance-2 window → refused by the active-duplicate rule;
 *              exactly ONE BULLISH_OB survives (createdAtUtcSec still the
 *              original candle 13) plus the BULLISH_FVG [2650.50, 2651.50]
 *              that candles 12↔14 legitimately leave behind (gap 1.00).
 */

import { describe, expect, test } from 'bun:test';
import { readPoi } from '@/lib/signal/ict/agents/poi';
import type { AnalysisCandle } from '@/lib/analysis/types';

const T0 = 1_791_979_200; // Wednesday 2026-10-14T12:00:00Z (fixed test clock, M5-aligned)
const TF = 300; // M5
const DIGITS = 2;

const PARAMS = {
  obMinDisplacementAtr: 1.0, // × ATR 2.00 → displacement body ≥ 2.00 (exact)
  fvgMinGapAtr: 0.2, // × ATR 2.00 → FVG gap ≥ 0.40
  poiMaxTests: 3, // 4th test exhausts a zone (pinned by the EXHAUST fixture)
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

/** Point-mirror around `axis` — flips direction, preserves every invariant. */
function mirror(rows: Row[], axis = 5300): Row[] {
  return rows.map(([o, h, l, c]) => [axis - o, axis - l, axis - h, axis - c]);
}

// --- fixtures ----------------------------------------------------------------

/** Alternating ±0.25 warm-up, one red cluster candle, one displacement marubozu. */
const BULL_OB: Row[] = [
  // i=0..11 — ATR warm-up: alternating ±0.25 bodies around 2650, span 2.00 each
  [2650.00, 2650.25, 2648.25, 2649.75], // 0 bearish 0.25
  [2649.75, 2650.00, 2648.00, 2650.00], // 1 bullish 0.25
  [2650.00, 2650.25, 2648.25, 2649.75], // 2
  [2649.75, 2650.00, 2648.00, 2650.00], // 3
  [2650.00, 2650.25, 2648.25, 2649.75], // 4
  [2649.75, 2650.00, 2648.00, 2650.00], // 5
  [2650.00, 2650.25, 2648.25, 2649.75], // 6
  [2649.75, 2650.00, 2648.00, 2650.00], // 7
  [2650.00, 2650.25, 2648.25, 2649.75], // 8
  [2649.75, 2650.00, 2648.00, 2650.00], // 9
  [2650.00, 2650.25, 2648.25, 2649.75], // 10
  [2649.75, 2650.00, 2648.00, 2650.00], // 11
  // i=12 — the DOWN cluster (single red candle): open 2650.00, low 2648.50
  [2650.00, 2650.50, 2648.50, 2649.50], // bearish 0.50
  // i=13 — bullish displacement: full-span marubozu body 2.00 = 1×ATR,
  //        close 2651.50 > cluster top 2650.00 → BULLISH_OB born
  [2649.50, 2651.50, 2649.50, 2651.50],
];

const BEAR_OB: Row[] = mirror(BULL_OB);

/** Decline → dojis → small step; FVG candles 12/13/14 complete at index 14. */
const BULL_FVG: Row[] = [
  // i=0..7 — steady −0.25 decline (closes 2649.75 … 2648.00), span 2.00 each
  [2650.00, 2650.25, 2648.25, 2649.75], // 0
  [2649.75, 2650.00, 2648.00, 2649.50], // 1
  [2649.50, 2649.75, 2647.75, 2649.25], // 2
  [2649.25, 2649.50, 2647.50, 2649.00], // 3
  [2649.00, 2649.25, 2647.25, 2648.75], // 4
  [2648.75, 2649.00, 2647.00, 2648.50], // 5
  [2648.50, 2648.75, 2646.75, 2648.25], // 6
  [2648.25, 2648.50, 2646.50, 2648.00], // 7
  // i=8..10 — flat dojis at 2648.00
  [2648.00, 2649.00, 2647.00, 2648.00], // 8
  [2648.00, 2649.00, 2647.00, 2648.00], // 9
  [2648.00, 2649.00, 2647.00, 2648.00], // 10
  // i=11 — small bullish step (kills the distance-2 cluster path of candle 13)
  [2648.00, 2650.00, 2648.00, 2648.50], // bullish 0.50
  // i=12 — FVG candle 1: high 2650.00
  [2648.50, 2650.00, 2648.00, 2649.50], // bullish 1.00
  // i=13 — FVG candle 2: strong up marubozu body 2.00 (also kills candle-13 OB:
  //        neither candle 12 nor candle 11 is a down candle → no cluster)
  [2649.50, 2651.50, 2649.50, 2651.50],
  // i=14 — FVG candle 3: low 2650.75 → gap 0.75 ≥ 0.40 → BULLISH_FVG born
  [2651.50, 2652.75, 2650.75, 2651.75], // bullish 0.25
];

const BEAR_FVG: Row[] = mirror(BULL_FVG);

/** BULL_OB + a dip that trades into the zone without closing through it. */
const MITIGATE: Row[] = [
  ...BULL_OB,
  // i=14 — dips low 2649.50 ≤ top 2650.00, closes 2651.00 ≥ bottom 2648.50
  [2651.50, 2651.50, 2649.50, 2651.00], // bearish 0.50
];

/** BULL_OB + a fade (no touch) + a close through the invalidation side. */
const VIOLATE: Row[] = [
  ...BULL_OB,
  // i=14 — fades to close 2650.25; low 2650.25 stays ABOVE the top → no test
  [2651.50, 2652.25, 2650.25, 2650.25], // bearish 1.25
  // i=15 — marubozu closes 2648.25 < bottom 2648.50 → VIOLATION
  [2650.25, 2650.25, 2648.25, 2648.25], // bearish 2.00
];

/** BULL_OB + dip (test 1) + violation + reclaim → BREAKER flip. */
const BREAKER: Row[] = [
  ...BULL_OB,
  // i=14' — dips low 2649.50 ≤ top → first test (timesTested 1)
  [2651.50, 2651.50, 2649.50, 2650.25], // bearish 1.25
  // i=15 — closes 2648.25 < bottom 2648.50 → VIOLATION
  [2650.25, 2650.25, 2648.25, 2648.25], // bearish 2.00
  // i=16 — marubozu closes 2650.25 > top 2650.00 → BULLISH_BREAKER flip
  [2648.25, 2650.25, 2648.25, 2650.25], // bullish 2.00
];

/** BULL_OB + a tap whose close lands INSIDE the zone. */
const INSIDE: Row[] = [
  ...BULL_OB,
  // i=14 — taps low 2649.75 (test 1) and CLOSES 2649.75 inside [2648.50, 2650.00]
  [2651.50, 2651.75, 2649.75, 2649.75], // bearish 1.75
];

/** BULL_OB with the displacement body cut below the gate. */
const WEAK_LEG: Row[] = [
  ...BULL_OB.slice(0, 13),
  // i=13 — body 1.75 = 0.875×ATR < 1×ATR: geometry qualifies (close 2651.25
  //        > cluster top 2650.00) but the displacement gate refuses
  [2649.50, 2651.50, 2649.50, 2651.25], // bullish 1.75
];

/** BULL_OB + FOUR taps (never a close below the bottom) → exhausted. */
const EXHAUST: Row[] = [
  ...BULL_OB,
  [2651.50, 2651.50, 2649.50, 2651.00], // 14 — tap 1 (low 2649.50)
  [2651.00, 2651.75, 2649.75, 2650.75], // 15 — tap 2
  [2650.75, 2651.75, 2649.75, 2650.50], // 16 — tap 3
  [2650.50, 2651.75, 2649.75, 2650.25], // 17 — tap 4 > poiMaxTests 3 → exhausted
];

/** BULL_OB + a second displacement marobozu re-detecting the same cluster. */
const DEDUPE: Row[] = [
  ...BULL_OB,
  // i=14 — another marubozu (body 2.00, close 2653.50 > cluster top via the
  //        distance-2 window: candle 12 is the down candle, candle 13 is not)
  [2651.50, 2653.50, 2651.50, 2653.50], // bullish 2.00
];

// --- 1. bullish order block ---------------------------------------------------

describe('A3 POI — bullish order block (cluster + displacement)', () => {
  const read = readPoi(grid(BULL_OB), PARAMS, DIGITS);

  test('emits exactly one fresh BULLISH_OB with cluster geometry and displacementAtr 1', () => {
    expect(read.zones).toHaveLength(1);
    expect(read.zones[0]).toEqual({
      kind: 'BULLISH_OB',
      top: 2650.00, // open of the FIRST (only) down candle of the cluster
      bottom: 2648.50, // lowest low of the cluster
      topText: '2650.00',
      bottomText: '2648.50',
      createdAtUtcSec: T0 + 13 * TF, // the displacement candle's open time
      displacementAtr: 1, // body 2.00 / ATR 2.00
      fresh: true,
      mitigatedAtUtcSec: null,
      timesTested: 0, // the creating leg itself never counts as a test
      active: true,
      violatedAtUtcSec: null,
    });
  });

  test('nearestBullish is the OB (decision close 2651.50 above its top); nearestBearish null', () => {
    expect(read.nearestBullish).toEqual(read.zones[0]);
    expect(read.nearestBearish).toBeNull();
  });
});

// --- 2. bearish order block (mirror) ------------------------------------------

describe('A3 POI — bearish order block (mirror)', () => {
  const read = readPoi(grid(BEAR_OB), PARAMS, DIGITS);

  test('emits exactly one fresh BEARISH_OB with mirrored cluster geometry', () => {
    expect(read.zones).toHaveLength(1);
    expect(read.zones[0]).toEqual({
      kind: 'BEARISH_OB',
      top: 2651.50, // highest high of the up-cluster
      bottom: 2650.50, // close of the FIRST (only) up candle of the cluster
      topText: '2651.50',
      bottomText: '2650.50',
      createdAtUtcSec: T0 + 13 * TF,
      displacementAtr: 1,
      fresh: true,
      mitigatedAtUtcSec: null,
      timesTested: 0,
      active: true,
      violatedAtUtcSec: null,
    });
  });

  test('nearestBearish is the OB (decision close 2648.50 below its bottom); nearestBullish null', () => {
    expect(read.nearestBearish).toEqual(read.zones[0]);
    expect(read.nearestBullish).toBeNull();
  });
});

// --- 3. fair value gaps --------------------------------------------------------

describe('A3 POI — fair value gaps (3-candle imbalance)', () => {
  test('BULLISH_FVG zone [candle1.high, candle3.low], displacementAtr from the middle candle', () => {
    const read = readPoi(grid(BULL_FVG), PARAMS, DIGITS);
    expect(read.zones).toHaveLength(1);
    expect(read.zones[0]).toEqual({
      kind: 'BULLISH_FVG',
      top: 2650.75, // candle 14 low
      bottom: 2650.00, // candle 12 high
      topText: '2650.75',
      bottomText: '2650.00',
      createdAtUtcSec: T0 + 14 * TF, // the 3rd candle's open time
      displacementAtr: 1, // middle candle body 2.00 / ATR 2.00
      fresh: true,
      mitigatedAtUtcSec: null,
      timesTested: 0,
      active: true,
      violatedAtUtcSec: null,
    });
    // decision close 2651.75 sits above the zone top — plain pullback POI
    expect(read.nearestBullish).toEqual(read.zones[0]);
    expect(read.nearestBearish).toBeNull();
  });

  test('BEARISH_FVG mirror zone [candle3.high, candle1.low]', () => {
    const read = readPoi(grid(BEAR_FVG), PARAMS, DIGITS);
    expect(read.zones).toHaveLength(1);
    expect(read.zones[0]).toEqual({
      kind: 'BEARISH_FVG',
      top: 2650.00, // candle 12 low
      bottom: 2649.25, // candle 14 high
      topText: '2650.00',
      bottomText: '2649.25',
      createdAtUtcSec: T0 + 14 * TF,
      displacementAtr: 1, // middle candle body 2.00 / ATR 2.00
      fresh: true,
      mitigatedAtUtcSec: null,
      timesTested: 0,
      active: true,
      violatedAtUtcSec: null,
    });
    expect(read.nearestBearish).toEqual(read.zones[0]);
    expect(read.nearestBullish).toBeNull();
  });
});

// --- 4. mitigation -------------------------------------------------------------

describe('A3 POI — mitigation (first trade into the zone)', () => {
  const read = readPoi(grid(MITIGATE), PARAMS, DIGITS);

  test('the dip flips fresh, stamps mitigatedAtUtcSec and counts timesTested 1', () => {
    expect(read.zones).toHaveLength(1);
    const z = read.zones[0];
    expect(z.kind).toBe('BULLISH_OB');
    expect(z.fresh).toBe(false);
    expect(z.timesTested).toBe(1);
    expect(z.mitigatedAtUtcSec).toBe(T0 + 14 * TF);
    expect(z.active).toBe(true); // 1 ≤ poiMaxTests 3 — not exhausted
    expect(z.violatedAtUtcSec).toBeNull();
    expect(z.top).toBe(2650.00);
    expect(z.bottomText).toBe('2648.50');
  });

  test('the mitigated zone is still the BUY pullback POI', () => {
    expect(read.nearestBullish).toEqual(read.zones[0]);
    expect(read.nearestBearish).toBeNull();
  });
});

// --- 5. violation --------------------------------------------------------------

describe('A3 POI — violation (close through the invalidation side)', () => {
  test('a close below the OB bottom kills the zone — the read emits nothing', () => {
    const read = readPoi(grid(VIOLATE), PARAMS, DIGITS);
    // zones carries ACTIVE zones only, so a violated zone vanishes from the
    // output (length 0 pins that the violation branch actually fired — a
    // still-active zone would appear here). The BREAKER test below proves
    // the same violated zone can resurrect, i.e. the violation really happened.
    expect(read).toEqual({ zones: [], nearestBullish: null, nearestBearish: null });
  });
});

// --- 6. breaker flip -----------------------------------------------------------

describe('A3 POI — breaker flip (violated OB reclaimed)', () => {
  const read = readPoi(grid(BREAKER), PARAMS, DIGITS);

  test('the violated OB returns as BULLISH_BREAKER, active again, fresh false', () => {
    expect(read.zones).toHaveLength(1);
    expect(read.zones[0]).toEqual({
      kind: 'BULLISH_BREAKER',
      top: 2650.00, // geometry survives the flip
      bottom: 2648.50,
      topText: '2650.00',
      bottomText: '2648.50',
      createdAtUtcSec: T0 + 13 * TF, // birth time survives the flip
      displacementAtr: 1,
      fresh: false, // the pre-violation dip at candle 14' (test 1)
      mitigatedAtUtcSec: T0 + 14 * TF,
      timesTested: 1, // the violating and flip candles never count as tests
      active: true,
      violatedAtUtcSec: null, // consumed by the completed trap
    });
  });

  test('the breaker is the BUY pullback POI (close 2650.25 above its top)', () => {
    expect(read.nearestBullish).toEqual(read.zones[0]);
    expect(read.nearestBearish).toBeNull();
  });
});

// --- 7. price inside the zone (nearest resolution) ------------------------------

describe('A3 POI — decision close inside the zone (nearest resolution)', () => {
  const read = readPoi(grid(INSIDE), PARAMS, DIGITS);

  test('a decision close INSIDE the bullish zone makes it nearestBullish', () => {
    // close 2649.75 sits inside [2648.50, 2650.00]; the zone's top 2650.00 is
    // ABOVE the close, so ONLY the inside-rule can return it — the plain
    // "top at/below the close" rule would leave nearestBullish null.
    expect(read.nearestBullish).not.toBeNull();
    expect(read.nearestBullish?.kind).toBe('BULLISH_OB');
    expect(read.nearestBullish?.top).toBe(2650.00);
    expect(read.nearestBullish).toEqual(read.zones[0]);
    expect(read.nearestBearish).toBeNull();
  });

  test('the deciding candle tapped and closed inside — counted as its first test', () => {
    expect(read.zones).toHaveLength(1);
    expect(read.zones[0].fresh).toBe(false);
    expect(read.zones[0].timesTested).toBe(1);
    expect(read.zones[0].mitigatedAtUtcSec).toBe(T0 + 14 * TF);
    expect(read.zones[0].active).toBe(true);
    expect(read.zones[0].violatedAtUtcSec).toBeNull();
  });
});

// --- 8. insufficient input + determinism ----------------------------------------

describe('A3 POI — insufficient input (fail empty, never fabricate)', () => {
  test('empty candle array → empty read', () => {
    expect(readPoi([], PARAMS, DIGITS)).toEqual({
      zones: [],
      nearestBullish: null,
      nearestBearish: null,
    });
  });

  test('12 candles (< atrPeriod) → no ATR anywhere → empty read', () => {
    const read = readPoi(grid(BULL_OB.slice(0, 12)), PARAMS, DIGITS);
    expect(read).toEqual({ zones: [], nearestBullish: null, nearestBearish: null });
  });
});

describe('A3 POI — determinism', () => {
  test('identical input yields deeply identical reads (bullish OB fixture)', () => {
    const a = readPoi(grid(BULL_OB), PARAMS, DIGITS);
    const b = readPoi(grid(BULL_OB), PARAMS, DIGITS);
    expect(a).toEqual(b);
  });

  test('identical input yields deeply identical reads (breaker fixture)', () => {
    const a = readPoi(grid(BREAKER), PARAMS, DIGITS);
    const b = readPoi(grid(BREAKER), PARAMS, DIGITS);
    expect(a).toEqual(b);
  });
});

// --- 9. displacement gate --------------------------------------------------------

describe('A3 POI — displacement gate (weak leg)', () => {
  test('a body of 1.75 (0.875×ATR < 1×ATR) creates NO zone', () => {
    const read = readPoi(grid(WEAK_LEG), PARAMS, DIGITS);
    // geometry alone would qualify (close 2651.25 > cluster top 2650.00) —
    // only the body gate refuses, so nothing at all is emitted.
    expect(read).toEqual({ zones: [], nearestBullish: null, nearestBearish: null });
  });
});

// --- 10. tests cap ----------------------------------------------------------------

describe('A3 POI — tests cap (exhausted zone)', () => {
  test('four taps (never a close below the bottom) exhaust the zone — empty read', () => {
    const read = readPoi(grid(EXHAUST), PARAMS, DIGITS);
    // None of the four tap candles closes below the bottom, so the VIOLATION
    // branch can never fire here: zones = [] pins the TESTS-CAP branch.
    expect(read).toEqual({ zones: [], nearestBullish: null, nearestBearish: null });
  });
});

// --- 11. duplicate suppression ------------------------------------------------------

describe('A3 POI — duplicate suppression (consecutive displacement marubozus)', () => {
  const read = readPoi(grid(DEDUPE), PARAMS, DIGITS);

  test('exactly ONE BULLISH_OB survives with its ORIGINAL birth time', () => {
    // candle 14 re-detects the same cluster via the distance-2 window — the
    // active-duplicate rule must refuse the clone.
    const obs = read.zones.filter((z) => z.kind === 'BULLISH_OB');
    expect(obs).toHaveLength(1);
    expect(obs[0]).toEqual({
      kind: 'BULLISH_OB',
      top: 2650.00,
      bottom: 2648.50,
      topText: '2650.00',
      bottomText: '2648.50',
      createdAtUtcSec: T0 + 13 * TF, // the ORIGINAL displacement, not candle 14
      displacementAtr: 1,
      fresh: true, // candle 14 flies over the zone (low 2651.50 > top) → no test
      mitigatedAtUtcSec: null,
      timesTested: 0,
      active: true,
      violatedAtUtcSec: null,
    });
  });

  test('the two marubozus also leave one BULLISH_FVG — nearest by midpoint first', () => {
    // candles 12↔14 (high 2650.50 vs low 2651.50, gap 1.00 ≥ 0.40) leave a
    // legitimate imbalance; the read carries both zones, FVG nearest to the
    // 2653.50 decision close (|2651.00 − 2653.50| = 2.50 vs |2649.25 − 2653.50| = 4.25).
    expect(read.zones).toHaveLength(2);
    expect(read.zones[0]).toEqual({
      kind: 'BULLISH_FVG',
      top: 2651.50,
      bottom: 2650.50,
      topText: '2651.50',
      bottomText: '2650.50',
      createdAtUtcSec: T0 + 14 * TF,
      displacementAtr: 1, // middle candle 13 body 2.00 / ATR 2.00
      fresh: true,
      mitigatedAtUtcSec: null,
      timesTested: 0,
      active: true,
      violatedAtUtcSec: null,
    });
    expect(read.zones[1].kind).toBe('BULLISH_OB');
    // highest top wins the BUY pullback POI: the FVG (top 2651.50)
    expect(read.nearestBullish).toEqual(read.zones[0]);
    expect(read.nearestBearish).toBeNull();
  });
});
