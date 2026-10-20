/**
 * XAUUSD AI Trading Agent — A5 Price Action Agent (Phase 14, Task 34-e)
 * ----------------------------------------------------------------------------
 * PURE and DETERMINISTIC: closed candles + explicit parameters → one
 * PriceActionRead out. No clock, no DB, no network, no console — identical
 * input always yields the identical output. Every pattern comes
 * EXCLUSIVELY from the supplied candles; nothing is ever fabricated.
 *
 * DOMAIN — the candlestick signatures the confluence master reads as
 * confirmation: engulfings, hammer/shooting-star wicks, pin bars, inside
 * bars, displacement bodies and rejection wicks.
 *
 * LOCKED FORMULAS (pinned by tests/ict/price-action.test.ts):
 *   body = |close − open| · range = high − low ·
 *   upperWick = high − max(open, close) ·
 *   lowerWick = min(open, close) − low.
 *   Wick/range patterns are only evaluated when range > 0 (a zero-range
 *   candle has no wick geometry to read).
 *
 *   · BULLISH_ENGULFING — previous candle bearish (close < open), current
 *     bullish (close > open), current close > previous open, current open
 *     ≤ previous close. strength = clamp01(current body / previous body)
 *     (≥ 1 by construction, so a valid engulfing always scores 1).
 *     BEARISH_ENGULFING mirrors: previous bullish, current bearish,
 *     current close < previous open, current open ≥ previous close.
 *   · HAMMER — lowerWick ≥ 2 × body AND upperWick ≤ 0.5 × body.
 *     strength = clamp01(lowerWick / range). SHOOTING_STAR mirrors:
 *     upperWick ≥ 2 × body AND lowerWick ≤ 0.5 × body, strength =
 *     clamp01(upperWick / range). (Neither carries a direction condition —
 *     a bearish candle with hammer geometry is still a hammer.)
 *   · BULLISH_PIN — lowerWick ≥ 0.60 × range. BEARISH_PIN — upperWick ≥
 *     0.60 × range. strength = clamp01(wick / range).
 *   · INSIDE_BAR — high ≤ previous high AND low ≥ previous low.
 *     strength 0.5 (fixed).
 *   · BULLISH_DISPLACEMENT — body ≥ displacementAtr × ATR(at that
 *     candle's index) AND close > open. strength = clamp01(body /
 *     (displacementAtr × ATR)). BEARISH mirrors (close < open). ATR
 *     unavailable at the index (warm-up) → the displacement patterns are
 *     SKIPPED for that candle — every other pattern needs no ATR.
 *     Fail-closed: a non-positive displacementAtr, a null or non-positive
 *     ATR never qualifies displacement.
 *   · BULLISH_REJECTION_WICK — lowerWick ≥ 0.50 × range AND close ≥
 *     (high + low) / 2. BEARISH mirrors: upperWick ≥ 0.50 × range AND
 *     close ≤ mid. strength = clamp01(wick / range) — the same wick
 *     dominance normalization as the pins (documented choice: the spec
 *     locks every pattern formula except this one).
 *
 * EMISSION: the agent walks the LAST 12 candles (all of them when the
 * series is shorter; candle 0 has no predecessor, so the two-candle
 * patterns simply cannot fire on it). Every pattern that fires on a
 * candle is ranked strength DESC (deterministic tiebreak: pattern kind
 * alphabetically) and AT MOST the 2 strongest are emitted. `patterns` is
 * chronological (oldest first, most recent last; within one candle the
 * ranked order is kept) and capped at the MOST RECENT 12. decisionPattern
 * = the strongest pattern on the LAST candle (null when the decision bar
 * is patternless — earlier candles never donate it).
 *
 * Pattern overlaps are honest and resolved by the cap: a hammer is always
 * a bullish rejection candidate (every hammer closes in the upper half by
 * construction) and usually also a pin; a hammer outside the pin band
 * (wick/range < 0.60) ties with its rejection wick and survives beside it
 * alphabetically. The 2-per-candle cap plus the alphabetical tiebreak
 * make every overlap deterministic.
 *
 * Empty candle input → { patterns: [], decisionPattern: null }.
 */

import { atrSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { toCanonicalPrice } from '@/lib/market/validation';
import type { CandlePattern, CandlePatternKind, PriceActionRead } from '@/lib/signal/ict/types';

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

/** Walk window: the last N closed candles are scanned for patterns. */
const WALK_CANDLES = 12;

/** At most the N strongest patterns are emitted per candle. */
const MAX_PER_CANDLE = 2;

/** The chronological output keeps the most recent N patterns. */
const MAX_PATTERNS = 12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Alphabetical comparison for the deterministic tiebreaks. */
function kindAsc(a: CandlePatternKind, b: CandlePatternKind): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** ATR value at a candle index; null when the series cannot see that far. */
function atrAt(values: Array<number | null> | null, index: number): number | null {
  if (values === null || index < 0 || index >= values.length) return null;
  const v = values[index];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Every pattern that fires on candle i (unranked). The previous candle
 * (i − 1) feeds the engulfing/inside-bar patterns; the ATR at index i
 * gates the displacement patterns; all other formulas are single-candle.
 */
function patternsAt(
  i: number,
  candles: AnalysisCandle[],
  atrValues: Array<number | null> | null,
  displacementAtr: number,
  digits: number | null,
): CandlePattern[] {
  const c = candles[i];
  const t = c.timeUtcSec;
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const mid = (c.high + c.low) / 2;
  const closeText = toCanonicalPrice(c.close, digits).text;
  const out: CandlePattern[] = [];

  // --- two-candle patterns (need the closed predecessor) ---------------------
  if (i >= 1) {
    const p = candles[i - 1];
    const prevBody = Math.abs(p.close - p.open);
    if (p.close < p.open && c.close > c.open && c.close > p.open && c.open <= p.close) {
      out.push({
        kind: 'BULLISH_ENGULFING',
        candleTimeUtcSec: t,
        strength: clamp01(body / prevBody),
        noteEn: `Bullish engulfing — closed at ${closeText} above the prior bearish open.`,
      });
    }
    if (p.close > p.open && c.close < c.open && c.close < p.open && c.open >= p.close) {
      out.push({
        kind: 'BEARISH_ENGULFING',
        candleTimeUtcSec: t,
        strength: clamp01(body / prevBody),
        noteEn: `Bearish engulfing — closed at ${closeText} below the prior bullish open.`,
      });
    }
    if (c.high <= p.high && c.low >= p.low) {
      out.push({
        kind: 'INSIDE_BAR',
        candleTimeUtcSec: t,
        strength: 0.5,
        noteEn: 'Inside bar — range contracted inside the prior candle.',
      });
    }
  }

  // --- single-candle wick geometry (range > 0 guard) -------------------------
  if (range > 0) {
    if (lowerWick >= 2 * body && upperWick <= 0.5 * body) {
      out.push({
        kind: 'HAMMER',
        candleTimeUtcSec: t,
        strength: clamp01(lowerWick / range),
        noteEn: `Hammer — lower wick ≥ 2× body, closed at ${closeText}.`,
      });
    }
    if (upperWick >= 2 * body && lowerWick <= 0.5 * body) {
      out.push({
        kind: 'SHOOTING_STAR',
        candleTimeUtcSec: t,
        strength: clamp01(upperWick / range),
        noteEn: `Shooting star — upper wick ≥ 2× body, closed at ${closeText}.`,
      });
    }
    if (lowerWick >= 0.6 * range) {
      out.push({
        kind: 'BULLISH_PIN',
        candleTimeUtcSec: t,
        strength: clamp01(lowerWick / range),
        noteEn: `Bullish pin bar — lower wick dominance, closed at ${closeText}.`,
      });
    }
    if (upperWick >= 0.6 * range) {
      out.push({
        kind: 'BEARISH_PIN',
        candleTimeUtcSec: t,
        strength: clamp01(upperWick / range),
        noteEn: `Bearish pin bar — upper wick dominance, closed at ${closeText}.`,
      });
    }
    if (lowerWick >= 0.5 * range && c.close >= mid) {
      out.push({
        kind: 'BULLISH_REJECTION_WICK',
        candleTimeUtcSec: t,
        strength: clamp01(lowerWick / range),
        noteEn: `Bullish rejection wick — lower wick rejected, closed at ${closeText}.`,
      });
    }
    if (upperWick >= 0.5 * range && c.close <= mid) {
      out.push({
        kind: 'BEARISH_REJECTION_WICK',
        candleTimeUtcSec: t,
        strength: clamp01(upperWick / range),
        noteEn: `Bearish rejection wick — upper wick rejected, closed at ${closeText}.`,
      });
    }
  }

  // --- displacement (ATR-gated at the candle's own index) --------------------
  const atr = atrAt(atrValues, i);
  const threshold = atr !== null && displacementAtr > 0 ? displacementAtr * atr : null;
  if (threshold !== null) {
    if (body >= threshold && c.close > c.open) {
      out.push({
        kind: 'BULLISH_DISPLACEMENT',
        candleTimeUtcSec: t,
        strength: clamp01(body / threshold),
        noteEn: `Bullish displacement — body ≥ ${displacementAtr}×ATR, closed at ${closeText}.`,
      });
    }
    if (body >= threshold && c.close < c.open) {
      out.push({
        kind: 'BEARISH_DISPLACEMENT',
        candleTimeUtcSec: t,
        strength: clamp01(body / threshold),
        noteEn: `Bearish displacement — body ≥ ${displacementAtr}×ATR, closed at ${closeText}.`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// The A5 Price Action Agent read
// ---------------------------------------------------------------------------

/**
 * Read the candlestick pattern landscape of the recent tail: engulfings,
 * hammer/star wicks, pin bars, inside bars, displacement bodies and
 * rejection wicks, with the decision bar's own pattern called out. Pure —
 * see the locked formulas and emission rules in the module header.
 *
 * Exported for the 34-g Confluence Master wiring: the params subset matches
 * the SmcAgentParams fields { displacementAtr, atrPeriod }.
 */
export function readPriceAction(
  candles: AnalysisCandle[],
  params: { displacementAtr: number; atrPeriod: number },
  digits: number | null,
): PriceActionRead {
  const n = candles.length;
  if (n === 0) {
    return { patterns: [], decisionPattern: null };
  }

  // ATR over the full window, indexed like the candles (null during warm-up).
  const atrResult = atrSeries(candles, params.atrPeriod);
  const atrValues: Array<number | null> | null = atrResult.ok ? atrResult.series.values : null;

  const patterns: CandlePattern[] = [];
  let decisionPattern: CandlePattern | null = null;

  const start = Math.max(0, n - WALK_CANDLES);
  for (let i = start; i < n; i++) {
    const found = patternsAt(i, candles, atrValues, params.displacementAtr, digits);
    if (found.length === 0) continue;
    found.sort((a, b) => b.strength - a.strength || kindAsc(a.kind, b.kind));
    const kept = found.slice(0, MAX_PER_CANDLE);
    for (const p of kept) {
      patterns.push(p);
    }
    if (i === n - 1) {
      decisionPattern = kept[0]; // strongest pattern of the decision bar
    }
  }

  return {
    patterns: patterns.slice(-MAX_PATTERNS),
    decisionPattern,
  };
}
