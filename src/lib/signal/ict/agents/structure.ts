/**
 * XAUUSD AI Trading Agent — A1 Structure Agent (Phase 14, Task 34-b)
 * ----------------------------------------------------------------------------
 * Pure, deterministic ICT/SMC structure read for the confluence engine. This
 * agent REUSES the locked Phase 4 primitives — it never re-implements swing
 * detection or BOS/CHoCH:
 *
 *   · Swings    : detectSwings(@/lib/analysis/swings) with the agent's
 *                 swingLeft/swingRight — a swing exists only after its
 *                 right-side bars have CLOSED (no look-ahead by construction).
 *   · BOS/CHoCH : scanStructureEvents(@/lib/analysis/structure) — a break is
 *                 confirmed ONLY by a candle CLOSE strictly beyond the level,
 *                 wick-only crossings never confirm, a consumed level never
 *                 re-fires, and events are chronological (seq ↑ with time).
 *   · Trend     : classifyStructure(@/lib/analysis/structure) over ALL
 *                 confirmed swings (HH+HL bullish · LH+LL bearish · HH+LL or
 *                 LH+HL range · anything else unclear — never guessed).
 *
 * LOCKED RULES of this agent (pinned by tests/ict/structure.test.ts):
 *   · trend          — classifyStructure(swings).trend.
 *   · lastEvent      — the LAST event of the chronological scan output (the
 *                      most recent BOS/CHoCH). Null when the analysed window
 *                      produced no event.
 *   · barsSinceEvent — (candles.length − 1) − index of the breaking candle,
 *                      the index located by matching the event's
 *                      breakCandleTimeUtcSec against the series. The RAW
 *                      count is reported: params.maxBarsSinceEvent is
 *                      accepted for interface uniformity (the shared agent
 *                      parameter bundle) but is deliberately NOT applied
 *                      here — freshness weighting belongs to the Confluence
 *                      Master (A10), never hidden inside this read. Null when
 *                      there is no event (or the candle cannot be matched,
 *                      which the current primitives make impossible).
 *   · dealingRange   — LAST confirmed swing high ↔ LAST confirmed swing low
 *                      (the current leg). Requires BOTH to exist AND
 *                      high.price > low.price; equilibrium = (high + low) / 2
 *                      (the ICT 50% of the leg). Null otherwise — a range is
 *                      never fabricated from one side only, nor from equal or
 *                      crossed extremes. All three values keep canonical
 *                      decimal text via toCanonicalPrice(v, digits).
 *   · zone           — where the DECISION bar's close (the LAST candle) sits
 *                      inside the dealing range:
 *                          position = (close − low) / (high − low)
 *                          0.40 ≤ position ≤ 0.60 → EQUILIBRIUM (locked 10%
 *                                                     band around the 50%)
 *                          position > 0.60        → PREMIUM
 *                          position < 0.40        → DISCOUNT
 *                      A close beyond a range extreme still maps to the
 *                      extreme zone (the vocabulary has exactly three zones).
 *                      Null when there is no dealing range.
 *   · Empty input is never fabricated: zero candles → all-null read with
 *     trend 'unclear'. A series shorter than the swing window needs simply
 *     yields no swings and no events, degrading to the same honest shape.
 *
 * PURE: no clock, no DB, no network, no console — deterministic in inputs.
 */

import { detectSwings } from '@/lib/analysis/swings';
import { classifyStructure, scanStructureEvents } from '@/lib/analysis/structure';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { toCanonicalPrice } from '@/lib/market/validation';
import type {
  BreachEvent,
  PremiumDiscountZone,
  SmcDealingRange,
  SmcStructureRead,
} from '@/lib/signal/ict/types';

export function readSmcStructure(
  candles: AnalysisCandle[],
  params: { swingLeft: number; swingRight: number; maxBarsSinceEvent: number },
  tfSec: number,
  digits: number | null,
): SmcStructureRead {
  // Locked rule: no candles at all → nothing may be fabricated.
  if (candles.length === 0) {
    return {
      trend: 'unclear',
      lastEvent: null,
      barsSinceEvent: null,
      dealingRange: null,
      zone: null,
    };
  }

  // Phase 4 primitives are the ONLY swing/structure implementations.
  const { swings } = detectSwings(candles, {
    left: params.swingLeft,
    right: params.swingRight,
    tfSec,
    digits,
  });
  const scan = scanStructureEvents(candles, swings, {
    swingLeft: params.swingLeft,
    swingRight: params.swingRight,
    tfSec,
    digits,
  });
  const cls = classifyStructure(swings);

  // Most recent break = last chronological event (seq increases with time).
  const lastEvent: BreachEvent | null =
    scan.events.length > 0 ? scan.events[scan.events.length - 1] : null;

  // Raw bars between the breaking candle and the decision bar (the LAST
  // candle). maxBarsSinceEvent is intentionally NOT applied here (header).
  let barsSinceEvent: number | null = null;
  if (lastEvent !== null) {
    const breakIndex = candles.findIndex(
      (c) => c.timeUtcSec === lastEvent.breakCandleTimeUtcSec,
    );
    if (breakIndex >= 0) {
      barsSinceEvent = candles.length - 1 - breakIndex;
    }
  }

  // Dealing range of the current leg: last confirmed swing high ↔ low.
  let dealingRange: SmcDealingRange | null = null;
  if (
    cls.lastSwingHigh !== null &&
    cls.lastSwingLow !== null &&
    cls.lastSwingHigh.price > cls.lastSwingLow.price
  ) {
    const high = cls.lastSwingHigh.price;
    const low = cls.lastSwingLow.price;
    const equilibrium = (high + low) / 2;
    dealingRange = {
      high,
      low,
      equilibrium,
      highText: toCanonicalPrice(high, digits).text,
      lowText: toCanonicalPrice(low, digits).text,
      equilibriumText: toCanonicalPrice(equilibrium, digits).text,
    };
  }

  // Premium/discount placement of the DECISION bar's close inside the range.
  let zone: PremiumDiscountZone | null = null;
  if (dealingRange !== null) {
    const close = candles[candles.length - 1].close;
    const position = (close - dealingRange.low) / (dealingRange.high - dealingRange.low);
    if (position > 0.6) {
      zone = 'PREMIUM';
    } else if (position < 0.4) {
      zone = 'DISCOUNT';
    } else {
      zone = 'EQUILIBRIUM'; // locked 10% band around the 50% equilibrium
    }
  }

  return { trend: cls.trend, lastEvent, barsSinceEvent, dealingRange, zone };
}
