/**
 * XAUUSD AI Trading Agent — A8 AMD Agent (Phase 14, Task 34-f)
 * ----------------------------------------------------------------------------
 * PURE and DETERMINISTIC: closed candles + explicit parameters → one
 * AmdRead out. No clock, no DB, no network, no console — identical input
 * always yields the identical output. Every phase call comes
 * EXCLUSIVELY from the supplied candles; nothing is ever fabricated.
 *
 * DOMAIN — the Wyckoff-lite smart-money cycle: institutions ACCUMULATE
 * positions inside a quiet range, then MANIPULATE price beyond a range
 * edge to harvest the retail stops resting there (a SPRING = dip below
 * support that reclaims; an UPTHRUST = spike above resistance that
 * rejects), then DISTRIBUTION of the move unfolds in the breakout
 * direction. This agent classifies the CURRENT state of the last
 * amdLookbackBars candles.
 *
 * LOCKED RULES (pinned by tests/ict/amd.test.ts):
 *   1. WINDOW: the last amdLookbackBars candles (all of them when the
 *      series is shorter; a fractional/negative lookback floors/clamps
 *      to 0 — config clamps anyway). Fewer than 10 candles in the
 *      window, or ATR unavailable, → { phase 'UNCLEAR', signature and
 *      level fields null, noteEn 'insufficient history' }. ATR =
 *      atrSeries over the FULL candle list (the window's own candles
 *      index into the same series), read at the LAST index; a null or
 *      NON-POSITIVE value counts as unavailable (fail-closed: a frozen
 *      ATR cannot size an institutional range — the height minimum
 *      would degenerate to height < 0). The locked sweep conditions
 *      below consume no per-candle ATR — they are strictly geometric;
 *      ATR gates this read only through availability and the range
 *      minimum.
 *   2. RANGE: rangeHigh = max high, rangeLow = min low of the window
 *      EXCLUDING the last 3 candles (the exclusion keeps the
 *      manipulation wick itself from defining the range). Range height
 *      < amdMinRangeAtr × ATR(last) → phase 'UNCLEAR', no signature —
 *      too thin to be an institutional range — but rangeHigh/rangeLow
 *      are STILL reported. (A non-positive amdMinRangeAtr disables the
 *      refusal: the threshold can never exceed a real height.)
 *   3. SPRING: a candle among the last 3 whose low < rangeLow (wick
 *      below the range) AND whose close > rangeLow (reclaimed), AND the
 *      decision close (last candle) > rangeLow → signature 'SPRING',
 *      direction 'BULLISH'. UPTHRUST mirrors: high > rangeHigh AND
 *      close < rangeHigh, AND decision close < rangeHigh → 'UPTHRUST',
 *      'BEARISH'. Every comparison is strict — a touch exactly AT an
 *      edge is not a sweep, a close exactly AT the edge is not a
 *      reclaim/rejection.
 *   4. SWEEP_REVERSAL (whipsaw): when BOTH a spring and an upthrust
 *      exist among the last 3 candles, the signature is
 *      'SWEEP_REVERSAL' carrying the direction of the wick that reached
 *      FARTHER beyond its range edge in price units (exact tie → the
 *      spring side, the alphabetical-first house tiebreak); the whipsaw
 *      is stated in noteEn.
 *   5. PHASE: a sweep signature in the last 3 candles → 'MANIPULATION'
 *      (the stop hunt is happening / just happened — the institutional
 *      trap). No sweep: decision close INSIDE [rangeLow, rangeHigh] →
 *      'ACCUMULATION' (quiet range = institutions building positions);
 *      close strictly outside (above rangeHigh = breakout up, below
 *      rangeLow = breakdown) → 'DISTRIBUTION' (the move away from the
 *      range is unfolding; a sweep older than the last 3 candles no
 *      longer blocks this — the signature window is 3 bars by rule).
 *      Those branches are exhaustive for a finite close; a non-finite
 *      close (impossible with validated candles) falls to a defensive
 *      'UNCLEAR'.
 *   6. noteEn: one honest English sentence describing the
 *      classification; range prices render through toCanonicalPrice(v,
 *      digits) so a note never shows a re-rounded price. The READ
 *      itself carries numbers only — canonical *Text fields are NOT
 *      needed here (the confluence master renders its own evidence).
 *   7. rangeHigh / rangeLow are always the detected values (null only
 *      under rule 1). Empty candle input → the rule-1 shape.
 *
 * params.equalLevelAtrTol is accepted for parameter-bundle symmetry
 * with SmcAgentParams and is deliberately NOT applied: the locked sweep
 * conditions are strictly geometric (range edges are exact min/max,
 * never clustered levels — the A2 Liquidity Agent owns equal-level
 * semantics).
 */

import { atrSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { toCanonicalPrice } from '@/lib/market/validation';
import type { AmdRead } from '@/lib/signal/ict/types';

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

/** Window minimum — fewer candles than this cannot hold a range + sweep. */
const MIN_WINDOW_CANDLES = 10;

/** The sweep-signature window: only the last N candles can sweep. */
const SWEEP_TAIL_CANDLES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical price text for the note (never a re-rounded price). */
function priceText(value: number, digits: number | null): string {
  return toCanonicalPrice(value, digits).text;
}

/** The locked insufficient-history shape (rule 1). */
function insufficientHistory(): AmdRead {
  return {
    phase: 'UNCLEAR',
    signature: null,
    signatureDirection: null,
    rangeHigh: null,
    rangeLow: null,
    noteEn: 'insufficient history',
  };
}

// ---------------------------------------------------------------------------
// The A8 AMD Agent read
// ---------------------------------------------------------------------------

/**
 * Classify the Accumulation → Manipulation → Distribution state of the
 * recent range: spring/upthrust stop-hunt signatures, the detected
 * range edges and the current phase. Pure — see the locked rules in the
 * module header.
 */
export function readAmd(
  candles: AnalysisCandle[],
  params: { amdLookbackBars: number; amdMinRangeAtr: number; atrPeriod: number; equalLevelAtrTol: number },
  digits: number | null,
): AmdRead {
  // Rule 1 — the window and the ATR gate.
  const lookback = Math.max(0, Math.floor(params.amdLookbackBars));
  const windowCount = Math.min(candles.length, lookback);
  if (windowCount < MIN_WINDOW_CANDLES) return insufficientHistory();

  const atrResult = atrSeries(candles, params.atrPeriod);
  if (!atrResult.ok) return insufficientHistory();
  const atrLast = atrResult.series.values[candles.length - 1];
  if (typeof atrLast !== 'number' || !Number.isFinite(atrLast) || atrLast <= 0) {
    return insufficientHistory();
  }

  const window = candles.slice(candles.length - windowCount);
  const rangeSource = window.slice(0, windowCount - SWEEP_TAIL_CANDLES);
  const tail = window.slice(windowCount - SWEEP_TAIL_CANDLES);
  const decisionClose = window[windowCount - 1].close;

  // Rule 2 — the range (last 3 candles excluded so the manipulation wick
  // never defines the range it swept).
  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  for (const c of rangeSource) {
    if (c.high > rangeHigh) rangeHigh = c.high;
    if (c.low < rangeLow) rangeLow = c.low;
  }
  const height = rangeHigh - rangeLow;
  const minRange = params.amdMinRangeAtr * atrLast;
  if (height < minRange) {
    return {
      phase: 'UNCLEAR',
      signature: null,
      signatureDirection: null,
      rangeHigh,
      rangeLow,
      noteEn: `Range ${priceText(rangeLow, digits)}–${priceText(rangeHigh, digits)} height ${priceText(height, digits)} below the ${priceText(minRange, digits)} minimum — too thin for an institutional range`,
    };
  }

  // Rule 3 — sweep candidates among the last 3 candles (strict geometry,
  // gated by the decision close on the safe side of the swept edge).
  let springWick: number | null = null;
  if (decisionClose > rangeLow) {
    for (const c of tail) {
      if (c.low < rangeLow && c.close > rangeLow) {
        const wick = rangeLow - c.low;
        if (springWick === null || wick > springWick) springWick = wick;
      }
    }
  }
  let upthrustWick: number | null = null;
  if (decisionClose < rangeHigh) {
    for (const c of tail) {
      if (c.high > rangeHigh && c.close < rangeHigh) {
        const wick = c.high - rangeHigh;
        if (upthrustWick === null || wick > upthrustWick) upthrustWick = wick;
      }
    }
  }

  // Rule 4 — whipsaw: both edges swept, the farther wick directs.
  if (springWick !== null && upthrustWick !== null) {
    const springDominates = springWick >= upthrustWick; // tie → spring (alphabetical)
    return {
      phase: 'MANIPULATION',
      signature: 'SWEEP_REVERSAL',
      signatureDirection: springDominates ? 'BULLISH' : 'BEARISH',
      rangeHigh,
      rangeLow,
      noteEn: `Whipsaw — both range edges swept within 3 bars; sweep-reversal signature, ${springDominates ? 'bullish' : 'bearish'} (deeper ${springDominates ? 'spring' : 'upthrust'} wick)`,
    };
  }

  // Rule 3 — the clean single-sided signatures.
  if (springWick !== null) {
    return {
      phase: 'MANIPULATION',
      signature: 'SPRING',
      signatureDirection: 'BULLISH',
      rangeHigh,
      rangeLow,
      noteEn: `Spring below ${priceText(rangeLow, digits)} reclaimed — manipulation signature, bullish`,
    };
  }
  if (upthrustWick !== null) {
    return {
      phase: 'MANIPULATION',
      signature: 'UPTHRUST',
      signatureDirection: 'BEARISH',
      rangeHigh,
      rangeLow,
      noteEn: `Upthrust above ${priceText(rangeHigh, digits)} rejected — manipulation signature, bearish`,
    };
  }

  // Rule 5 — no sweep inside the signature window: the close locates the phase.
  if (Number.isFinite(decisionClose)) {
    if (decisionClose >= rangeLow && decisionClose <= rangeHigh) {
      return {
        phase: 'ACCUMULATION',
        signature: null,
        signatureDirection: null,
        rangeHigh,
        rangeLow,
        noteEn: `Close ${priceText(decisionClose, digits)} inside the ${priceText(rangeLow, digits)}–${priceText(rangeHigh, digits)} range with no sweep — accumulation`,
      };
    }
    if (decisionClose > rangeHigh) {
      return {
        phase: 'DISTRIBUTION',
        signature: null,
        signatureDirection: null,
        rangeHigh,
        rangeLow,
        noteEn: `Close ${priceText(decisionClose, digits)} above the ${priceText(rangeHigh, digits)} range high — distribution (breakout up)`,
      };
    }
    return {
      phase: 'DISTRIBUTION',
      signature: null,
      signatureDirection: null,
      rangeHigh,
      rangeLow,
      noteEn: `Close ${priceText(decisionClose, digits)} below the ${priceText(rangeLow, digits)} range low — distribution (breakdown)`,
    };
  }

  // Defensive catch-all — unreachable with validated (finite) candles.
  return {
    phase: 'UNCLEAR',
    signature: null,
    signatureDirection: null,
    rangeHigh,
    rangeLow,
    noteEn: 'Contradictory geometry — classification refused',
  };
}
