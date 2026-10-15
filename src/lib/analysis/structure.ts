/**
 * XAUUSD AI Trading Agent — Market Structure & BOS/CHoCH (Phase 4)
 * ----------------------------------------------------------------------------
 * Pure and deterministic. There is no single universally-agreed BOS/CHoCH
 * definition, so the rules below are LOCKED in code, documented in the README,
 * recorded in every persisted calculationConfig, and pinned by tests:
 *
 * Classification (from CONFIRMED swings only):
 *   HH = last swing high above the previous one;  LH = below it;
 *   HL = last swing low above the previous one;    LL = below it.
 *   Equal levels → UNCLEAR (never guessed).
 *   trend: HH+HL → bullish · LH+LL → bearish · HH+LL or LH+HL → range ·
 *   anything else (ties, <2 swings) → unclear.
 *
 * BOS / CHoCH (evaluated candle-by-candle in strict time order — no look-ahead):
 *   · Reference levels are the MOST RECENT confirmed swing high (bullish
 *     side) and swing low (bearish side). A newly confirmed swing REPLACES the
 *     reference on its side. A swing becomes known only at the CLOSE of the
 *     candle that completes its right-side window — a swing can never be
 *     broken by the very candle that confirms it (the swing's window covers
 *     that candle), so there is no paradox and no future information.
 *   · A break is confirmed ONLY by a candle CLOSE strictly beyond the level
 *     (basis: 'close'). A close exactly AT the level is NOT a break. Wick-only
 *     crossings are recorded as unconfirmedCrossings — never events.
 *   · Label: CHoCH when the trend known at the break candle's close was
 *     bearish (bullish break) / bullish (bearish break); otherwise BOS
 *     (continuation, including from an unclear/range trend — deterministic).
 *   · After a confirmed break the level is CONSUMED on that side — the same
 *     level can never produce a second event (duplicate suppression). The
 *     next reference is the next swing confirmed AFTER the breaking candle.
 *   · Every event preserves: broken level (+canonical text), broken swing's
 *     original time, the breaking candle's time, the confirmation instant
 *     (breaking candle open + tf), basis, and the trend at break.
 */

import type {
  AnalysisCandle,
  BreachEvent,
  StructuralTrend,
  StructureResult,
  SwingPairLabel,
  SwingPoint,
  UnconfirmedCrossing,
} from './types';

// ---------------------------------------------------------------------------
// Labels & trend from the last two swings of each kind
// ---------------------------------------------------------------------------

/** Pair label of two consecutive same-kind swings (exported for the Phase 9
 *  signal engine's causal HTF trend — same rule, one implementation). */
export function pairLabel(earlier: SwingPoint | undefined, later: SwingPoint | undefined): SwingPairLabel {
  if (!earlier || !later) return 'UNCLEAR';
  if (later.price > earlier.price) return earlier.kind === 'high' ? 'HH' : 'HL';
  if (later.price < earlier.price) return earlier.kind === 'high' ? 'LH' : 'LL';
  return 'UNCLEAR'; // exact tie — never guessed
}

export function trendFromLabels(highLabel: SwingPairLabel, lowLabel: SwingPairLabel): StructuralTrend {
  if (highLabel === 'UNCLEAR' || lowLabel === 'UNCLEAR') return 'unclear';
  if (highLabel === 'HH' && lowLabel === 'HL') return 'bullish';
  if (highLabel === 'LH' && lowLabel === 'LL') return 'bearish';
  if ((highLabel === 'HH' && lowLabel === 'LL') || (highLabel === 'LH' && lowLabel === 'HL')) return 'range';
  return 'unclear';
}

export interface StructureClassification {
  highLabel: SwingPairLabel;
  lowLabel: SwingPairLabel;
  trend: StructuralTrend;
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
}

/** Final classification over all confirmed swings. */
export function classifyStructure(swings: SwingPoint[]): StructureClassification {
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');
  const lastSwingHigh = highs.length > 0 ? highs[highs.length - 1] : null;
  const lastSwingLow = lows.length > 0 ? lows[lows.length - 1] : null;
  const highLabel = pairLabel(highs[highs.length - 2], highs[highs.length - 1]);
  const lowLabel = pairLabel(lows[lows.length - 2], lows[lows.length - 1]);
  return { highLabel, lowLabel, trend: trendFromLabels(highLabel, lowLabel), lastSwingHigh, lastSwingLow };
}

// ---------------------------------------------------------------------------
// BOS / CHoCH scan (strict time order, no look-ahead)
// ---------------------------------------------------------------------------

export interface StructureScanConfig {
  swingLeft: number;
  swingRight: number;
  tfSec: number;
  digits: number | null;
}

export interface StructureScan {
  events: BreachEvent[];
  unconfirmedCrossings: UnconfirmedCrossing[];
  trendAtEnd: StructuralTrend;
}

export function scanStructureEvents(candles: AnalysisCandle[], swings: SwingPoint[], cfg: StructureScanConfig): StructureScan {
  const n = candles.length;
  const events: BreachEvent[] = [];
  const crossings: UnconfirmedCrossing[] = [];
  let seq = 0;

  // Activation pointer over swings sorted by confirmation candle index.
  // A swing becomes KNOWN at the close of candle (index + right).
  const byConfirm = [...swings].sort((a, b) => a.index + cfg.swingRight - (b.index + cfg.swingRight) || a.index - b.index);
  let ptr = 0;

  let activeHigh: SwingPoint | null = null; // most recent confirmed swing high
  let activeLow: SwingPoint | null = null; // most recent confirmed swing low
  const lastTwoHighs: SwingPoint[] = [];
  const lastTwoLows: SwingPoint[] = [];
  let trend: StructuralTrend = 'unclear';

  for (let c = 0; c < n; c++) {
    // -- 1) activate swings known at the close of candle c -------------------
    while (ptr < byConfirm.length && byConfirm[ptr].index + cfg.swingRight <= c) {
      const s = byConfirm[ptr];
      ptr += 1;
      if (s.kind === 'high') {
        lastTwoHighs.push(s);
        if (lastTwoHighs.length > 2) lastTwoHighs.shift();
        activeHigh = s; // most recent confirmed swing high is the reference
      } else {
        lastTwoLows.push(s);
        if (lastTwoLows.length > 2) lastTwoLows.shift();
        activeLow = s;
      }
      trend = trendFromLabels(pairLabel(lastTwoHighs[0], lastTwoHighs[1]), pairLabel(lastTwoLows[0], lastTwoLows[1]));
    }

    const close = candles[c].close;

    // -- 2) bullish side: break of the active swing high by CLOSE -----------
    if (activeHigh && close > activeHigh.price) {
      events.push({
        seq: ++seq,
        type: trend === 'bearish' ? 'CHoCH' : 'BOS',
        direction: 'bullish',
        level: activeHigh.price,
        levelText: activeHigh.priceText,
        brokenSwingKind: 'high',
        brokenSwingTimeUtcSec: activeHigh.timeUtcSec,
        breakCandleTimeUtcSec: candles[c].timeUtcSec,
        confirmedAtUtcSec: candles[c].timeUtcSec + cfg.tfSec,
        basis: 'close',
        trendAtBreak: trend,
      });
      activeHigh = null; // consumed — this level can never fire again
    } else if (activeHigh && candles[c].high > activeHigh.price) {
      // wick beyond the level but the close did NOT confirm
      crossings.push({
        direction: 'bullish',
        level: activeHigh.price,
        levelText: activeHigh.priceText,
        candleTimeUtcSec: candles[c].timeUtcSec,
        wickBeyond: candles[c].high - activeHigh.price,
      });
    }

    // -- 3) bearish side: break of the active swing low by CLOSE ------------
    if (activeLow && close < activeLow.price) {
      events.push({
        seq: ++seq,
        type: trend === 'bullish' ? 'CHoCH' : 'BOS',
        direction: 'bearish',
        level: activeLow.price,
        levelText: activeLow.priceText,
        brokenSwingKind: 'low',
        brokenSwingTimeUtcSec: activeLow.timeUtcSec,
        breakCandleTimeUtcSec: candles[c].timeUtcSec,
        confirmedAtUtcSec: candles[c].timeUtcSec + cfg.tfSec,
        basis: 'close',
        trendAtBreak: trend,
      });
      activeLow = null; // consumed
    } else if (activeLow && candles[c].low < activeLow.price) {
      crossings.push({
        direction: 'bearish',
        level: activeLow.price,
        levelText: activeLow.priceText,
        candleTimeUtcSec: candles[c].timeUtcSec,
        wickBeyond: activeLow.price - candles[c].low,
      });
    }
  }

  return { events, unconfirmedCrossings: crossings, trendAtEnd: trend };
}

// ---------------------------------------------------------------------------
// Full per-timeframe structure assembly
// ---------------------------------------------------------------------------

/** Bounded tail of unconfirmed crossings kept in the output (last 20). */
export const MAX_UNCONFIRMED_CROSSINGS = 20;

export function buildStructureResult(
  candles: AnalysisCandle[],
  swings: SwingPoint[],
  scan: StructureScan,
  cfg: StructureScanConfig,
): StructureResult {
  const cls = classifyStructure(swings);
  return {
    swingLeft: cfg.swingLeft,
    swingRight: cfg.swingRight,
    confirmedSwings: swings,
    lastSwingHigh: cls.lastSwingHigh,
    lastSwingLow: cls.lastSwingLow,
    highLabel: cls.highLabel,
    lowLabel: cls.lowLabel,
    trend: cls.trend,
    events: scan.events,
    unconfirmedCrossings: scan.unconfirmedCrossings.slice(-MAX_UNCONFIRMED_CROSSINGS),
  };
}
