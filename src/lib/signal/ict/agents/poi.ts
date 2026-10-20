/**
 * XAUUSD AI Trading Agent — A3 POI Agent (Phase 14, Task 34-d)
 * ----------------------------------------------------------------------------
 * PURE and DETERMINISTIC: closed candles + explicit parameters in → one
 * PoiRead out. No clock, no DB, no network, no console — identical input
 * always yields the identical output. Every zone comes EXCLUSIVELY from the
 * supplied candles; nothing is ever fabricated.
 *
 * DOMAIN — institutional Points of Interest (user directive: POI zones):
 *   · ORDER BLOCK (OB) — the last down candle (or consecutive down-candle
 *     cluster) immediately before a bullish displacement leg that breaks
 *     structure upward. The zone is where institutions left their unfilled
 *     buy orders; price returning into it is the classic pullback entry.
 *     BEARISH OB mirrors (up-candle cluster before a bearish displacement).
 *   · FAIR VALUE GAP (FVG) — a 3-candle imbalance: the middle candle moves
 *     so fast that candle 1's extreme and candle 3's opposite extreme never
 *     overlap, leaving inefficiency the market tends to return and fill.
 *   · BREAKER — an OB that price CLOSED THROUGH (violated) and then returned
 *     and closed back beyond the far side: the institutional trap completed
 *     and the very zone flips polarity. Downstream confluence treats a
 *     breaker as the market admitting the earlier side was wrong.
 *
 * LOCKED RULES (pinned by tests/ict/poi.test.ts):
 *   1. BULLISH_OB geometry: top = OPEN of the FIRST bearish candle of the
 *      cluster, bottom = LOWEST low of the cluster. BEARISH_OB mirrors:
 *      bottom = CLOSE of the FIRST bullish candle of the cluster, top =
 *      HIGHEST high of the cluster. A degenerate/zero-height zone (top ≤
 *      bottom, e.g. from a full-marubozu cluster) is never emitted.
 *   2. Displacement leg (the OB confirmation): a candle whose body is
 *      ≥ obMinDisplacementAtr × ATR, moving in the OB's direction, starting
 *      within the next 1–2 candles after the cluster's last candle (the
 *      candle right at k+1, or k+2 when the in-between bar is not a cluster
 *      candle), and CLOSING strictly beyond the cluster's extreme (bullish:
 *      close > cluster top; bearish: close < cluster bottom). Wick-only
 *      moves never create an OB. displacementAtr = displacement body / ATR.
 *   3. FVG (3-candle pattern): BULLISH_FVG when candle[i-2].high < candle[i].low
 *      (strict) and gap = candle[i].low − candle[i-2].high ≥ fvgMinGapAtr × ATR;
 *      zone = [candle[i-2].high, candle[i].low]. BEARISH_FVG mirrors:
 *      candle[i-2].low > candle[i].high (strict), zone = [candle[i].high,
 *      candle[i-2].low]. The middle candle has NO direction requirement —
 *      the pattern is purely geometric; the zone's displacementAtr reports
 *      the MIDDLE candle's body / ATR (zone-quality information — the gate
 *      is the gap, never the body).
 *   4. ATR gate (fail-closed): ATR = atrSeries(candles, atrPeriod) over the
 *      full window; a zone is qualified with the ATR value AT THE
 *      ZONE-CREATING CANDLE INDEX (the displacement candle for OBs, the 3rd
 *      candle for FVGs — the candle whose CLOSE confirms the pattern).
 *      values[index] unavailable (warm-up / series too short) → creation
 *      skipped, never fabricated. A non-positive ATR, or a configured gate
 *      that multiplies down to ≤ 0, likewise refuses creation — a zero
 *      threshold can never qualify "displacement in ATR multiples".
 *   5. NO LOOK-AHEAD: zones are born inside a single chronological walk. A
 *      zone exists only after its creating candle has CLOSED; only candles
 *      that close AFTER creation may test, violate or flip it. The creating
 *      leg itself never counts as a test. createdAtUtcSec = the creating
 *      candle's OPEN time.
 *   6. MITIGATION (tests): while active, the first later candle that TRADES
 *      INTO the zone without closing through it (bullish: low ≤ top AND
 *      close ≥ bottom; bearish: high ≥ bottom AND close ≤ top) flips
 *      fresh = false, stamps mitigatedAtUtcSec and sets timesTested = 1;
 *      every subsequent re-entry increments timesTested. VIOLATION takes
 *      precedence over mitigation on the same candle — a candle that closes
 *      through the invalidation side never counts as a test.
 *   7. VIOLATION: a candle CLOSES through the invalidation side (bullish:
 *      close < bottom; bearish: close > top) → active = false,
 *      violatedAtUtcSec = that candle's open time. Violated zones leave the
 *      active output entirely.
 *   8. BREAKER: a violated BULLISH_OB that later gets a candle CLOSE back
 *      above its top flips kind → 'BULLISH_BREAKER' (the institutional trap
 *      completed) — same geometry, active = true again, fresh = false,
 *      violatedAtUtcSec = null (the violation was consumed by the flip; the
 *      mitigation history survives). BEARISH mirrors (close back below the
 *      bottom → 'BEARISH_BREAKER'). Only OBs can flip — a violated FVG or
 *      BREAKER is terminal, and an EXHAUSTED zone (rule 9) never
 *      resurrects. The flip candle itself does not count as a test.
 *   9. TESTS CAP: after any increment, timesTested > poiMaxTests →
 *      active = false (exhausted). An exhausted zone keeps
 *      violatedAtUtcSec = null — it was worn out, never closed through.
 *  10. DUPLICATES: a creation is skipped while an ACTIVE zone of the same
 *      kind with identical top AND bottom exists (consecutive
 *      displacement-grade candles must not stack clones of one zone). Dead
 *      (violated/exhausted) zones never block a later, fresh re-creation of
 *      the same levels.
 *  11. EMISSION: zones = ACTIVE zones only, sorted by |zone midpoint −
 *      decision close| ascending (ties: createdAtUtcSec, then top) and
 *      capped at the nearest 12. nearestBullish = the qualifying ACTIVE
 *      bullish-kind zone with the HIGHEST top — the first zone price would
 *      tap on a pullback. A bullish zone qualifies when the decision close
 *      is at/above its top OR inside it, which unions to close ≥ zone.bottom:
 *      a zone entirely above price is never a BUY pullback POI. When the
 *      decision close is INSIDE a bullish zone, that zone IS nearestBullish
 *      (price is already at the POI). nearestBearish mirrors: the qualifying
 *      bearish zone (close ≤ zone.top) with the LOWEST bottom — the first
 *      zone price would tap on a rally. Both are computed over the FULL
 *      active set, not the capped 12-zone list (same discipline as the A2
 *      magnets). Null when none qualifies. All zone prices carry canonical
 *      decimal text via toCanonicalPrice(v, digits).text — persisted
 *      evidence never shows a re-rounded price.
 *  12. Empty candle input (or a series too short for ATR) →
 *      { zones: [], nearestBullish: null, nearestBearish: null } — never
 *      fabricated.
 */

import { atrSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { toCanonicalPrice } from '@/lib/market/validation';
import type { PoiRead, PoiZone, PoiZoneKind } from '@/lib/signal/ict/types';

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

/** Emission cap (spec: the relevant active zones, nearest-to-price first). */
const MAX_ZONES = 12;

// ---------------------------------------------------------------------------
// Internal working model
// ---------------------------------------------------------------------------

/**
 * Zone under construction. `visibleFromIndex` is the causal gate — the first
 * candle index allowed to test/violate/flip the zone (creation index + 1:
 * only candles that close AFTER the zone was confirmed may interact with it).
 * It is stripped before emission.
 */
interface WorkingZone {
  kind: PoiZoneKind;
  top: number;
  bottom: number;
  topText: string;
  bottomText: string;
  createdAtUtcSec: number;
  displacementAtr: number;
  fresh: boolean;
  mitigatedAtUtcSec: number | null;
  timesTested: number;
  active: boolean;
  violatedAtUtcSec: number | null;
  visibleFromIndex: number;
}

function isBullishKind(kind: PoiZoneKind): boolean {
  return kind === 'BULLISH_OB' || kind === 'BULLISH_FVG' || kind === 'BULLISH_BREAKER';
}

/** ATR value at a candle index; null when the series cannot see that far. */
function atrAt(values: Array<number | null> | null, index: number): number | null {
  if (values === null || index < 0 || index >= values.length) return null;
  const v = values[index];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hasActiveDuplicate(
  zones: WorkingZone[],
  kind: PoiZoneKind,
  top: number,
  bottom: number,
): boolean {
  return zones.some((z) => z.active && z.kind === kind && z.top === top && z.bottom === bottom);
}

function makeZone(
  kind: PoiZoneKind,
  top: number,
  bottom: number,
  createdAtUtcSec: number,
  displacementAtr: number,
  createdIndex: number,
  digits: number | null,
): WorkingZone {
  return {
    kind,
    top,
    bottom,
    topText: toCanonicalPrice(top, digits).text,
    bottomText: toCanonicalPrice(bottom, digits).text,
    createdAtUtcSec,
    displacementAtr,
    fresh: true,
    mitigatedAtUtcSec: null,
    timesTested: 0,
    active: true,
    violatedAtUtcSec: null,
    visibleFromIndex: createdIndex + 1,
  };
}

/** Drop the causal-gate field — the emitted evidence shape. */
function stripZone(z: WorkingZone): PoiZone {
  return {
    kind: z.kind,
    top: z.top,
    bottom: z.bottom,
    topText: z.topText,
    bottomText: z.bottomText,
    createdAtUtcSec: z.createdAtUtcSec,
    displacementAtr: z.displacementAtr,
    fresh: z.fresh,
    mitigatedAtUtcSec: z.mitigatedAtUtcSec,
    timesTested: z.timesTested,
    active: z.active,
    violatedAtUtcSec: z.violatedAtUtcSec,
  };
}

// ---------------------------------------------------------------------------
// Pattern creation (both run at the zone-creating candle index)
// ---------------------------------------------------------------------------

/**
 * Last candle of the like-directed cluster for a displacement at `i`:
 * the matching candle at i-1, else the one at i-2, else -1 (no cluster).
 */
function clusterEnd(candles: AnalysisCandle[], i: number, dir: 'down' | 'up'): number {
  if (i < 1) return -1; // nothing can precede the series start
  const a = candles[i - 1];
  if (dir === 'down' ? a.close < a.open : a.close > a.open) return i - 1;
  if (i >= 2) {
    const b = candles[i - 2];
    if (dir === 'down' ? b.close < b.open : b.close > b.open) return i - 2;
  }
  return -1;
}

/** First candle of the maximal like-directed run ending at `k`. */
function clusterStart(candles: AnalysisCandle[], k: number, dir: 'down' | 'up'): number {
  let s = k;
  while (s > 0) {
    const p = candles[s - 1];
    if (dir === 'down' ? p.close < p.open : p.close > p.open) {
      s -= 1;
    } else {
      break;
    }
  }
  return s;
}

/** Order blocks: the like-directed cluster immediately before a displacement. */
function tryCreateOb(
  i: number,
  candles: AnalysisCandle[],
  atr: number,
  minDisplacementAtr: number,
  zones: WorkingZone[],
  digits: number | null,
): void {
  const c = candles[i];
  const body = Math.abs(c.close - c.open);
  const threshold = minDisplacementAtr * atr;
  // Fail-closed: a non-positive gate can never qualify displacement (rule 4).
  if (!(threshold > 0) || body < threshold) return;

  if (c.close > c.open) {
    // BULLISH_OB: down-candle cluster right before the upward displacement.
    const k = clusterEnd(candles, i, 'down');
    if (k < 0) return;
    const s = clusterStart(candles, k, 'down');
    const top = candles[s].open; // open of the FIRST down candle (rule 1)
    let bottom = Number.POSITIVE_INFINITY;
    for (let m = s; m <= k; m++) bottom = Math.min(bottom, candles[m].low);
    if (c.close > top && top > bottom && !hasActiveDuplicate(zones, 'BULLISH_OB', top, bottom)) {
      zones.push(makeZone('BULLISH_OB', top, bottom, c.timeUtcSec, body / atr, i, digits));
    }
    return;
  }

  if (c.close < c.open) {
    // BEARISH_OB mirror: up-candle cluster right before the downward displacement.
    const k = clusterEnd(candles, i, 'up');
    if (k < 0) return;
    const s = clusterStart(candles, k, 'up');
    const bottom = candles[s].close; // close of the FIRST up candle (rule 1)
    let top = Number.NEGATIVE_INFINITY;
    for (let m = s; m <= k; m++) top = Math.max(top, candles[m].high);
    if (c.close < bottom && top > bottom && !hasActiveDuplicate(zones, 'BEARISH_OB', top, bottom)) {
      zones.push(makeZone('BEARISH_OB', top, bottom, c.timeUtcSec, body / atr, i, digits));
    }
  }
}

/** Fair value gaps: the 3-candle imbalance completed at candle i. */
function tryCreateFvg(
  i: number,
  candles: AnalysisCandle[],
  atr: number,
  minGapAtr: number,
  zones: WorkingZone[],
  digits: number | null,
): void {
  if (i < 2) return;
  const threshold = minGapAtr * atr;
  if (!(threshold > 0)) return; // fail-closed (rule 4)
  const c = candles[i];
  const first = candles[i - 2];
  const midBodyAtr = Math.abs(candles[i - 1].close - candles[i - 1].open) / atr;

  // BULLISH_FVG: candle[i-2].high strictly below candle[i].low (rule 3).
  if (first.high < c.low && c.low - first.high >= threshold) {
    if (!hasActiveDuplicate(zones, 'BULLISH_FVG', c.low, first.high)) {
      zones.push(makeZone('BULLISH_FVG', c.low, first.high, c.timeUtcSec, midBodyAtr, i, digits));
    }
  }
  // BEARISH_FVG mirror: candle[i-2].low strictly above candle[i].high.
  if (first.low > c.high && first.low - c.high >= threshold) {
    if (!hasActiveDuplicate(zones, 'BEARISH_FVG', first.low, c.high)) {
      zones.push(makeZone('BEARISH_FVG', first.low, c.high, c.timeUtcSec, midBodyAtr, i, digits));
    }
  }
}

// ---------------------------------------------------------------------------
// Causal state machine
// ---------------------------------------------------------------------------

/** One trade into the zone: first touch mitigates, every touch increments. */
function touchZone(z: WorkingZone, timeUtcSec: number, poiMaxTests: number): void {
  if (z.fresh) {
    z.fresh = false;
    z.mitigatedAtUtcSec = timeUtcSec;
  }
  z.timesTested += 1;
  if (z.timesTested > poiMaxTests) z.active = false; // exhausted (rule 9)
}

/** Apply one CLOSED candle to one zone created before it (rules 6–8). */
function updateZone(z: WorkingZone, c: AnalysisCandle, poiMaxTests: number): void {
  if (!z.active) {
    // Only a VIOLATED OB can resurrect as a BREAKER (rule 8).
    if (z.kind === 'BULLISH_OB' && z.violatedAtUtcSec !== null && c.close > z.top) {
      z.kind = 'BULLISH_BREAKER';
      z.active = true;
      z.fresh = false;
      z.violatedAtUtcSec = null; // consumed by the completed trap
    } else if (z.kind === 'BEARISH_OB' && z.violatedAtUtcSec !== null && c.close < z.bottom) {
      z.kind = 'BEARISH_BREAKER';
      z.active = true;
      z.fresh = false;
      z.violatedAtUtcSec = null;
    }
    return;
  }

  if (isBullishKind(z.kind)) {
    if (c.close < z.bottom) {
      z.active = false; // closed through the invalidation side (rule 7)
      z.violatedAtUtcSec = c.timeUtcSec;
    } else if (c.low <= z.top) {
      touchZone(z, c.timeUtcSec, poiMaxTests); // traded into it, no close through
    }
  } else {
    if (c.close > z.top) {
      z.active = false;
      z.violatedAtUtcSec = c.timeUtcSec;
    } else if (c.high >= z.bottom) {
      touchZone(z, c.timeUtcSec, poiMaxTests);
    }
  }
}

// ---------------------------------------------------------------------------
// The A3 POI Agent read
// ---------------------------------------------------------------------------

/**
 * Map the institutional POI landscape of a closed-candle series: order
 * blocks, fair value gaps and breaker blocks, each with mitigation /
 * violation state, plus the nearest entry POI around the decision close.
 * Pure — see the locked rules in the module header.
 *
 * Exported for the 34-g Confluence Master wiring: the params subset matches
 * the SmcAgentParams fields { obMinDisplacementAtr, fvgMinGapAtr,
 * poiMaxTests, atrPeriod }. tfSec is deliberately NOT a parameter — this
 * agent does no session/bar-length arithmetic.
 */
export function readPoi(
  candles: AnalysisCandle[],
  params: {
    obMinDisplacementAtr: number;
    fvgMinGapAtr: number;
    poiMaxTests: number;
    atrPeriod: number;
  },
  digits: number | null,
): PoiRead {
  const n = candles.length;
  if (n === 0) {
    return { zones: [], nearestBullish: null, nearestBearish: null };
  }

  // ATR over the full window, indexed like the candles (null during warm-up).
  const atrResult = atrSeries(candles, params.atrPeriod);
  const atrValues: Array<number | null> | null = atrResult.ok ? atrResult.series.values : null;

  const zones: WorkingZone[] = [];

  // Single chronological walk: candle i first updates every zone created
  // before it, then the patterns whose CONFIRMING close IS candle i are born
  // (born zones interact only from candle i+1 on — no look-ahead, and the
  // creating leg never tests its own zone).
  for (let i = 0; i < n; i++) {
    for (const z of zones) {
      if (i >= z.visibleFromIndex) updateZone(z, candles[i], params.poiMaxTests);
    }
    const atr = atrAt(atrValues, i);
    if (atr === null || atr <= 0) continue; // fail-closed (rule 4)
    tryCreateOb(i, candles, atr, params.obMinDisplacementAtr, zones, digits);
    tryCreateFvg(i, candles, atr, params.fvgMinGapAtr, zones, digits);
  }

  // --- emission: active zones nearest-to-price first, capped ---------------
  const lastClose = candles[n - 1].close;
  const activeZones = zones.filter((z) => z.active);
  activeZones.sort(
    (a, b) =>
      Math.abs((a.top + a.bottom) / 2 - lastClose) -
        Math.abs((b.top + b.bottom) / 2 - lastClose) ||
      a.createdAtUtcSec - b.createdAtUtcSec ||
      a.top - b.top,
  );
  const strippedAll = activeZones.map(stripZone);

  // Nearest entry POIs over the FULL active set, not the capped list (rule 11).
  let bestBull = -1;
  let bestBear = -1;
  for (let idx = 0; idx < activeZones.length; idx++) {
    const z = activeZones[idx];
    if (isBullishKind(z.kind)) {
      if (lastClose < z.bottom) continue; // entirely above price — never a BUY pullback POI
      const cur = bestBull < 0 ? null : activeZones[bestBull];
      if (cur === null || z.top > cur.top || (z.top === cur.top && z.bottom > cur.bottom)) {
        bestBull = idx; // highest top = first zone tapped on the way down
      }
    } else {
      if (lastClose > z.top) continue; // entirely below price — never a SELL pullback POI
      const cur = bestBear < 0 ? null : activeZones[bestBear];
      if (cur === null || z.bottom < cur.bottom || (z.bottom === cur.bottom && z.top < cur.top)) {
        bestBear = idx; // lowest bottom = first zone tapped on the way up
      }
    }
  }

  return {
    zones: strippedAll.slice(0, MAX_ZONES),
    nearestBullish: bestBull < 0 ? null : strippedAll[bestBull],
    nearestBearish: bestBear < 0 ? null : strippedAll[bestBear],
  };
}
