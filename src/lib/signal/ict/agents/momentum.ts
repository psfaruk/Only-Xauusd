/**
 * XAUUSD AI Trading Agent — A6 Momentum Agent (Phase 14, Task 34-f)
 * ----------------------------------------------------------------------------
 * PURE and DETERMINISTIC: closed candles + explicit parameters → one
 * MomentumRead out. No clock, no DB, no network, no console — identical
 * input always yields the identical output. Every value comes
 * EXCLUSIVELY from the supplied candles through the LOCKED Phase 4
 * indicators (emaSeries / rsiSeries / atrSeries — never re-implemented
 * here); nothing is ever fabricated.
 *
 * DOMAIN — the momentum landscape the confluence master reads before
 * committing to a direction: EMA alignment (the trend spine), RSI
 * (stretch or fade), the decision bar's displacement in ATR multiples
 * and the volatility regime the market is currently in.
 *
 * LOCKED RULES (pinned by tests/ict/momentum.test.ts):
 *   1. INDICATORS: emaSeries(closes, emaFastPeriod), emaSeries(closes,
 *      emaSlowPeriod) and rsiSeries(closes, rsiPeriod) over the closes,
 *      atrSeries(candles, atrPeriod) over the candles — every one read
 *      at the LAST index (the decision bar). An indicator in warm-up
 *      (or rejected by its own guards) → its field is null and its
 *      component simply does not contribute; the read degrades
 *      honestly, it never guesses.
 *   2. EMA ALIGNMENT: fast > slow AND close > fast → 'BULL'; fast < slow
 *      AND close < fast → 'BEAR'; both EMAs present but neither
 *      condition → 'MIXED'; EITHER EMA missing → null.
 *   3. HONEST NEUTRAL: when BOTH EMAs are unavailable the score is
 *      forced to 0 with emaAligned null — rsi / atr / atrRegime /
 *      displacementStrength are still reported honestly, but no trend
 *      score is ever fabricated without the trend spine.
 *   4. SCORE COMPOSITION (each component signed, the sum clamped to
 *      [−100, 100], full float64 precision — rounding is a display
 *      concern only, never done here):
 *        · EMA ±40 — 'BULL' +40, 'BEAR' −40, 'MIXED' 0, null 0.
 *        · RSI ±30 — rsi ≥ 55 → +30 × min(1, (rsi − 55)/20);
 *          rsi ≤ 45 → −30 × min(1, (45 − rsi)/20); strictly between 45
 *          and 55 → 0; null → 0. (RSI exactly 55/45 contributes 0,
 *          75/25 reach the full ±30, anything beyond is capped.)
 *        · DISPLACEMENT ±30 — decision-bar body = |close − open|,
 *          direction = close > open ? +1 : close < open ? −1 : 0,
 *          magnitude = min(1, body / (displacementAtr × ATR(last)));
 *          component = 30 × direction × magnitude. Fail-closed (the
 *          same discipline as the A5 displacement): a null or
 *          non-positive ATR, or a non-positive displacementAtr,
 *          contributes exactly 0.
 *   5. ATR REGIME: ATR(last) vs the MEDIAN of the non-null atrSeries
 *      values over the whole window — ATR < 0.7 × median → 'LOW',
 *      ATR > 1.4 × median → 'HIGH', else 'NORMAL'. ATR(last)
 *      unavailable, or fewer than 3 non-null window values → null (the
 *      median of one or two samples is not a regime).
 *   6. DISPLACEMENT STRENGTH: body / (displacementAtr × ATR(last)),
 *      NOT clamped — the raw multiple is reported even when > 1. Null
 *      when ATR is null or ≤ 0, or when displacementAtr ≤ 0 (fail-closed:
 *      the threshold is meaningless — documented extension of the same
 *      A5 discipline that never qualifies displacement on a bad ATR).
 *   7. Empty candle input (and any input where every indicator is in
 *      warm-up) → { score: 0, emaAligned: null, rsi: null, atr: null,
 *      atrRegime: null, displacementStrength: null } — never fabricated.
 *
 * Exported for the 34-g Confluence Master wiring: atrPeriod and
 * displacementAtr match the SmcAgentParams fields; emaFastPeriod /
 * emaSlowPeriod / rsiPeriod are materialized by the rules builder from
 * the scalper indicator config (SCALPER_EMA_FAST / SCALPER_EMA_SLOW /
 * SCALPER_RSI_PERIOD — defaults 9 / 21 / 14, the same spine the legacy
 * momentum model uses).
 */

import { atrSeries, emaSeries, rsiSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle } from '@/lib/analysis/types';
import type { AtrRegime, MomentumRead } from '@/lib/signal/ict/types';

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

/** Score clamp — the locked composition never exceeds ±100 (40+30+30). */
const SCORE_CLAMP = 100;

/** EMA alignment component. */
const EMA_POINTS = 40;

/** RSI component. */
const RSI_POINTS = 30;

/** Displacement component. */
const DISPLACEMENT_POINTS = 30;

/** RSI scaling edges: 55→75 maps to 0→+30, 45→25 maps to 0→−30. */
const RSI_BULL_EDGE = 55;
const RSI_BEAR_EDGE = 45;
const RSI_FULL_SPAN = 20;

/** ATR regime multipliers against the window median. */
const ATR_LOW_MULT = 0.7;
const ATR_HIGH_MULT = 1.4;

/** Non-null ATR values the regime median needs before it means anything. */
const ATR_MEDIAN_MIN_VALUES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The last value of a series; null when absent or non-finite. */
function lastValue(values: Array<number | null>): number | null {
  if (values.length === 0) return null;
  const v = values[values.length - 1];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Standard median (odd → middle, even → mean of the two middles). */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// The A6 Momentum Agent read
// ---------------------------------------------------------------------------

/**
 * Read the momentum landscape of the decision bar: EMA alignment, RSI,
 * the decision-bar displacement in ATR multiples and the ATR regime,
 * composed into one signed score −100…+100 (positive = bullish). Pure —
 * see the locked rules in the module header.
 */
export function readMomentum(
  candles: AnalysisCandle[],
  params: { emaFastPeriod: number; emaSlowPeriod: number; rsiPeriod: number; atrPeriod: number; displacementAtr: number },
): MomentumRead {
  const n = candles.length;
  if (n === 0) {
    // Locked rule 7 — nothing may be fabricated.
    return { score: 0, emaAligned: null, rsi: null, atr: null, atrRegime: null, displacementStrength: null };
  }

  const closes = candles.map((c) => c.close);
  const decision = candles[n - 1];

  const fastResult = emaSeries(closes, params.emaFastPeriod);
  const slowResult = emaSeries(closes, params.emaSlowPeriod);
  const rsiResult = rsiSeries(closes, params.rsiPeriod);
  const atrResult = atrSeries(candles, params.atrPeriod);

  const fastValues = fastResult.ok ? fastResult.series.values : null;
  const slowValues = slowResult.ok ? slowResult.series.values : null;
  const rsiValues = rsiResult.ok ? rsiResult.series.values : null;
  const atrValues = atrResult.ok ? atrResult.series.values : null;

  const emaFast = fastValues !== null ? lastValue(fastValues) : null;
  const emaSlow = slowValues !== null ? lastValue(slowValues) : null;
  const rsi = rsiValues !== null ? lastValue(rsiValues) : null;
  const atr = atrValues !== null ? lastValue(atrValues) : null;

  // Rule 2 — alignment over the EMA pair (either missing → null).
  let emaAligned: MomentumRead['emaAligned'] = null;
  if (emaFast !== null && emaSlow !== null) {
    if (emaFast > emaSlow && decision.close > emaFast) emaAligned = 'BULL';
    else if (emaFast < emaSlow && decision.close < emaFast) emaAligned = 'BEAR';
    else emaAligned = 'MIXED';
  }

  // Rule 5 — regime vs the window median.
  let atrRegime: AtrRegime | null = null;
  if (atrValues !== null && atr !== null) {
    const windowAtrs = atrValues.filter((v): v is number => v !== null && Number.isFinite(v));
    const median = medianOf(windowAtrs);
    if (windowAtrs.length >= ATR_MEDIAN_MIN_VALUES && median !== null) {
      if (atr < ATR_LOW_MULT * median) atrRegime = 'LOW';
      else if (atr > ATR_HIGH_MULT * median) atrRegime = 'HIGH';
      else atrRegime = 'NORMAL';
    }
  }

  // Rules 4/6 — decision-bar displacement in ATR multiples.
  const body = Math.abs(decision.close - decision.open);
  const direction = decision.close > decision.open ? 1 : decision.close < decision.open ? -1 : 0;
  const threshold = atr !== null && atr > 0 && params.displacementAtr > 0 ? params.displacementAtr * atr : null;
  const displacementStrength = threshold !== null ? body / threshold : null;
  const displacementComponent =
    threshold !== null ? DISPLACEMENT_POINTS * direction * Math.min(1, body / threshold) : 0;

  // Rule 4 — RSI component (45–55 dead band, linear to the edges, capped).
  let rsiComponent = 0;
  if (rsi !== null) {
    if (rsi >= RSI_BULL_EDGE) rsiComponent = RSI_POINTS * Math.min(1, (rsi - RSI_BULL_EDGE) / RSI_FULL_SPAN);
    else if (rsi <= RSI_BEAR_EDGE) rsiComponent = -RSI_POINTS * Math.min(1, (RSI_BEAR_EDGE - rsi) / RSI_FULL_SPAN);
  }

  const emaComponent = emaAligned === 'BULL' ? EMA_POINTS : emaAligned === 'BEAR' ? -EMA_POINTS : 0;

  // Rule 3 — honest neutral when the whole EMA pair is unavailable.
  const bothEmasMissing = emaFast === null && emaSlow === null;
  const score = bothEmasMissing
    ? 0
    : Math.max(-SCORE_CLAMP, Math.min(SCORE_CLAMP, emaComponent + rsiComponent + displacementComponent));

  return { score, emaAligned, rsi, atr, atrRegime, displacementStrength };
}
