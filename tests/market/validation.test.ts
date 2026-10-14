/**
 * AUTOMATED TESTS — deterministic validation (Phase 3, spec Step 8).
 * Cases covered here: 1 valid OHLC, 2 invalid OHLC, 3 NaN/Inf/zero/negative,
 * 5 out-of-order, 6 missing-candle detection, 7 market-closure-aware gaps,
 * 8 stale candle/tick thresholds, 9 invalid bid/ask, 11 unsupported
 * symbol/timeframe, plus forming-bar and canonical-price rules.
 *
 * MOCK DATA ONLY — synthetic numbers, never real broker data.
 */
import './helpers/setup';
import { describe, expect, test } from 'bun:test';

import {
  expectedCandleTimes,
  filterAllowedTimeframes,
  findMissingCandles,
  freshnessState,
  isSymbolAllowed,
  toCanonicalPrice,
  validateCandleBar,
  validateCandleBatch,
  validateQuote,
} from '@/lib/market/validation';
import { TIMEFRAME_SECONDS, type BridgeBar } from '@/lib/market/types';
import { FIXED_NOW_SEC } from './helpers/setup';

const M5 = TIMEFRAME_SECONDS.M5;
const ctx = { timeframe: 'M5' as const, nowUtcSec: FIXED_NOW_SEC, digits: 2 };

function bar(overrides: Partial<BridgeBar> = {}): BridgeBar {
  // Structurally valid synthetic bar (t aligned 100 bars back).
  const t = FIXED_NOW_SEC - 100 * M5;
  return { t, o: 2650.1, h: 2652.5, l: 2649.8, c: 2651.2, v: 123, ...overrides };
}

// ---- Case 1: valid OHLC candle ----------------------------------------------
describe('candle validation — valid OHLC', () => {
  test('1. structurally valid bar → VALID with canonical decimal prices', () => {
    const v = validateCandleBar(bar(), ctx);
    expect(v.status).toBe('VALID');
    expect(v.normalized).not.toBeNull();
    expect(v.normalized!.open).toBe('2650.10'); // zero-padded canonical text
    expect(v.normalized!.high).toBe('2652.50');
    expect(v.normalized!.low).toBe('2649.80');
    expect(v.normalized!.close).toBe('2651.20');
    expect(v.normalized!.tickVolume).toBe(123);
    expect(v.normalized!.isForming).toBe(false);
  });

  test('1b. canonical price zero-pads and never invents digits', () => {
    expect(toCanonicalPrice(2654.3, 2).text).toBe('2654.30');
    expect(toCanonicalPrice(2654, 2).text).toBe('2654.00');
    expect(toCanonicalPrice(2654.32, null).text).toBe('2654.32');
  });

  test('1c. high >= max(o,c), low <= min(o,c), low <= high accepted at boundaries', () => {
    const v = validateCandleBar(bar({ o: 10, h: 12, l: 9, c: 11 }), ctx);
    expect(v.status).toBe('VALID');
    const v2 = validateCandleBar(bar({ o: 10, h: 10, l: 10, c: 10 }), ctx); // degenerate but consistent
    expect(v2.status).toBe('VALID');
  });
});

// ---- Case 2: invalid OHLC ----------------------------------------------------
describe('candle validation — invalid OHLC', () => {
  test('2. high below open/close → INVALID + CANDLE_OHLC_INCONSISTENT', () => {
    const v = validateCandleBar(bar({ o: 2650, h: 2640, l: 2645, c: 2648 }), ctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('CANDLE_OHLC_INCONSISTENT');
    expect(v.normalized).toBeNull(); // never persisted
  });

  test('2b. low above open/close → INVALID', () => {
    const v = validateCandleBar(bar({ o: 2650, h: 2660, l: 2655, c: 2652 }), ctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('CANDLE_OHLC_INCONSISTENT');
  });

  test('2c. low above high → INVALID', () => {
    const v = validateCandleBar(bar({ o: 2650, h: 2651, l: 2652, c: 2650.5 }), ctx);
    expect(v.status).toBe('INVALID');
  });

  test('2d. missing required fields → INVALID + CANDLE_MISSING_FIELDS', () => {
    const bad = { t: FIXED_NOW_SEC - M5, o: 1, h: 2, l: 0.5, c: 1.5 } as BridgeBar;
    const v = validateCandleBar({ ...bad, h: undefined as unknown as number }, ctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('CANDLE_MISSING_FIELDS');
  });
});

// ---- Case 3: NaN / infinite / zero / negative prices -------------------------
describe('candle validation — non-finite and non-positive prices', () => {
  test('3a. NaN price → INVALID + CANDLE_NON_FINITE', () => {
    const v = validateCandleBar(bar({ h: Number.NaN }), ctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('CANDLE_NON_FINITE');
  });

  test('3b. +Infinity price → INVALID', () => {
    const v = validateCandleBar(bar({ c: Number.POSITIVE_INFINITY }), ctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('CANDLE_NON_FINITE');
  });

  test('3c. zero price → INVALID + CANDLE_NON_POSITIVE', () => {
    const v = validateCandleBar(bar({ o: 0 }), ctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('CANDLE_NON_POSITIVE');
  });

  test('3d. negative price → INVALID + CANDLE_NON_POSITIVE', () => {
    const v = validateCandleBar(bar({ l: -5 }), ctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('CANDLE_NON_POSITIVE');
  });

  test('3e. bad/zero/negative timestamp → INVALID (NaN is NON_FINITE; 0/negative is BAD_TIME)', () => {
    expect(validateCandleBar(bar({ t: 0 }), ctx).errorCodes).toContain('CANDLE_BAD_TIME');
    expect(validateCandleBar(bar({ t: -100 }), ctx).errorCodes).toContain('CANDLE_BAD_TIME');
    expect(validateCandleBar(bar({ t: Number.NaN }), ctx).errorCodes).toContain('CANDLE_NON_FINITE');
  });

  test('3f. future-dated bar beyond tolerance → INVALID + CANDLE_FUTURE_TIME', () => {
    const v = validateCandleBar(bar({ t: FIXED_NOW_SEC + 60 * 60 }), ctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('CANDLE_FUTURE_TIME');
  });
});

// ---- Forming bar handling (never confirmed history) ---------------------------
describe('forming candle handling', () => {
  test('bridge flag f:1 marks the bar forming', () => {
    const v = validateCandleBar(bar({ t: FIXED_NOW_SEC - 60, f: 1 }), ctx);
    expect(v.normalized!.isForming).toBe(true);
  });

  test('computed forming: bar whose period is not over yet is forming even WITHOUT f', () => {
    const v = validateCandleBar(bar({ t: FIXED_NOW_SEC - 60 }), ctx); // M5 bar 1 min ago → still open
    expect(v.normalized!.isForming).toBe(true);
  });

  test('closed bar: period fully in the past is NOT forming', () => {
    const v = validateCandleBar(bar({ t: FIXED_NOW_SEC - 10 * M5 }), ctx);
    expect(v.normalized!.isForming).toBe(false);
  });
});

// ---- Precision anomaly (never silently rounded) -------------------------------
describe('price precision', () => {
  test('3-decimal price on a 2-digit symbol → WARNING + kept verbatim (not rounded)', () => {
    const v = validateCandleBar(bar({ o: 2650.125 }), ctx);
    expect(v.status).toBe('WARNING');
    expect(v.errorCodes).toContain('CANDLE_PRICE_PRECISION_ANOMALY');
    expect(v.normalized!.open).toBe('2650.125'); // exact as received — never altered
  });
});

// ---- Case 4/5-adjacent: batch duplicates & ordering ---------------------------
describe('batch validation — duplicates and ordering', () => {
  const closedT = FIXED_NOW_SEC - 10 * M5;
  const bars: BridgeBar[] = [
    bar({ t: closedT, o: 1, h: 2, l: 0.5, c: 1.5 }),
    bar({ t: closedT - M5, o: 1, h: 2, l: 0.5, c: 1.5 }), // out of order (earlier after later)
    bar({ t: closedT, o: 1.1, h: 2, l: 0.5, c: 1.6, f: 1 }), // duplicate time (forming)
  ];

  test('duplicates counted once, closed bar beats forming, output sorted ascending', () => {
    const r = validateCandleBatch(bars, ctx);
    expect(r.duplicates).toBe(1);
    expect(r.outOfOrder).toBe(true);
    expect(r.candles.length).toBe(2);
    expect(r.candles[0].candleTimeUtcSec).toBe(closedT - M5);
    expect(r.candles[1].candleTimeUtcSec).toBe(closedT);
    expect(r.candles[1].isForming).toBe(false); // closed duplicate won
    expect(r.issues.some((i) => i.code === 'CANDLE_DUPLICATE_KEY')).toBe(true);
    expect(r.issues.some((i) => i.code === 'CANDLE_OUT_OF_ORDER')).toBe(true);
  });

  test('rejected bars are counted, not persisted', () => {
    const r = validateCandleBatch([bar({ h: Number.NaN }), bar()], ctx);
    expect(r.rejected).toBe(1);
    expect(r.candles.length).toBe(1);
  });
});

// ---- Cases 6 & 7: missing candles + market-closure awareness ------------------
describe('missing candle detection with session awareness', () => {
  const from = FIXED_NOW_SEC - 20 * M5;

  test('6. a hole in the grid is detected as missing', () => {
    const present = expectedCandleTimes(from, FIXED_NOW_SEC, 'M5').filter((t) => t !== from + 5 * M5);
    const missing = findMissingCandles(present, {
      timeframe: 'M5',
      fromUtcSec: from,
      toUtcSec: FIXED_NOW_SEC,
      nowUtcSec: FIXED_NOW_SEC,
    });
    expect(missing.length).toBe(1);
    expect(missing[0].expectedTimeUtcSec).toBe(from + 5 * M5);
  });

  test('7a. gap on a Saturday → GAP_MARKET_LIKELY_CLOSED (info, not a defect)', () => {
    // 2026-10-17 is a Saturday. Build a Friday→Sunday window with a hole on Saturday.
    const sat = Date.UTC(2026, 9, 17, 14, 0, 0) / 1000; // Sat 14:00 UTC
    const missing = findMissingCandles([], {
      timeframe: 'H1',
      fromUtcSec: sat - 3600,
      toUtcSec: sat + 3600,
      nowUtcSec: sat + 7200,
    });
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((m) => m.reasonCode === 'GAP_MARKET_LIKELY_CLOSED' && m.severity === 'info')).toBe(true);
  });

  test('7b. gap mid-Tuesday → GAP_POSSIBLE (warning — unknown holiday or defect)', () => {
    // FIXED_NOW_SEC is Wednesday 12:00 UTC; scan back over Tuesday with a hole.
    const tue = FIXED_NOW_SEC - 86_400; // Tuesday 12:00 UTC
    const present = expectedCandleTimes(tue - 4 * 3600, tue + 4 * 3600, 'H1').filter((t) => t !== tue);
    const missing = findMissingCandles(present, {
      timeframe: 'H1',
      fromUtcSec: tue - 4 * 3600,
      toUtcSec: tue + 4 * 3600,
      nowUtcSec: FIXED_NOW_SEC,
    });
    expect(missing.length).toBe(1);
    expect(missing[0].reasonCode).toBe('GAP_POSSIBLE');
    expect(missing[0].severity).toBe('warning');
  });

  test('7c. gaps at/after "now" are never reported (not yet due)', () => {
    const from = FIXED_NOW_SEC - 3600;
    const grid = expectedCandleTimes(from, FIXED_NOW_SEC + 3600, 'M5');
    const present = grid.filter((t) => t < FIXED_NOW_SEC); // everything already due is present
    const missing = findMissingCandles(present, {
      timeframe: 'M5',
      fromUtcSec: from,
      toUtcSec: FIXED_NOW_SEC + 3600,
      nowUtcSec: FIXED_NOW_SEC,
    });
    expect(missing.length).toBe(0); // future grid points are not missing
  });
});

// ---- Case 8: staleness thresholds --------------------------------------------
describe('staleness thresholds (configurable per timeframe)', () => {
  test('fresh data → VALID, old data → STALE, absent → MISSING', () => {
    expect(freshnessState(FIXED_NOW_SEC - 60, FIXED_NOW_SEC, 900)).toBe('VALID');
    expect(freshnessState(FIXED_NOW_SEC - 901, FIXED_NOW_SEC, 900)).toBe('STALE');
    expect(freshnessState(null, FIXED_NOW_SEC, 900)).toBe('MISSING');
    expect(freshnessState(FIXED_NOW_SEC + 500, FIXED_NOW_SEC, 900)).toBe('STALE'); // future-dated: untrustworthy
  });
});

// ---- Case 9: tick validation ---------------------------------------------------
describe('tick (quote) validation', () => {
  const tctx = { nowUtcSec: FIXED_NOW_SEC, digits: 2 };

  test('valid bid/ask → VALID, spread computed, spreadPoints derived from verified digits', () => {
    const v = validateQuote({ symbol: 'XAUUSDm', bid: 2650.1, ask: 2650.5, ts: FIXED_NOW_SEC - 5 }, tctx);
    expect(v.status).toBe('VALID');
    expect(v.normalized!.spread).toBe('0.40');
    expect(v.normalized!.spreadPoints).toBe('40.0');
  });

  test('9a. ask < bid → INVALID + TICK_CROSSED', () => {
    const v = validateQuote({ symbol: 'XAUUSDm', bid: 2650.5, ask: 2650.1, ts: FIXED_NOW_SEC - 5 }, tctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('TICK_CROSSED');
    expect(v.normalized).toBeNull();
  });

  test('9b. zero/negative bid or ask → INVALID + TICK_NON_POSITIVE', () => {
    expect(validateQuote({ symbol: 'XAUUSDm', bid: 0, ask: 1, ts: FIXED_NOW_SEC }, tctx).errorCodes).toContain('TICK_NON_POSITIVE');
    expect(validateQuote({ symbol: 'XAUUSDm', bid: 1, ask: -2, ts: FIXED_NOW_SEC }, tctx).errorCodes).toContain('TICK_NON_POSITIVE');
  });

  test('9c. NaN bid → INVALID + TICK_INVALID', () => {
    const v = validateQuote({ symbol: 'XAUUSDm', bid: Number.NaN, ask: 1, ts: FIXED_NOW_SEC }, tctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('TICK_INVALID');
  });

  test('9d. zero spread → WARNING (kept, flagged — never silently valid)', () => {
    const v = validateQuote({ symbol: 'XAUUSDm', bid: 2650.1, ask: 2650.1, ts: FIXED_NOW_SEC - 5 }, tctx);
    expect(v.status).toBe('WARNING');
    expect(v.errorCodes).toContain('TICK_ZERO_SPREAD');
  });

  test('9e. future-dated tick → INVALID + TICK_BAD_TIME', () => {
    const v = validateQuote({ symbol: 'XAUUSDm', bid: 2650.1, ask: 2650.2, ts: FIXED_NOW_SEC + 600 }, tctx);
    expect(v.status).toBe('INVALID');
    expect(v.errorCodes).toContain('TICK_BAD_TIME');
  });
});

// ---- Case 11: allowlists --------------------------------------------------------
describe('symbol/timeframe allowlists', () => {
  test('only allowlisted symbols pass', () => {
    expect(isSymbolAllowed('XAUUSDm', ['XAUUSDm'])).toBe(true);
    expect(isSymbolAllowed('EURUSD', ['XAUUSDm'])).toBe(false);
    expect(isSymbolAllowed(undefined, ['XAUUSDm'])).toBe(false);
  });

  test('only allowlisted timeframes pass; invalid ones rejected explicitly', () => {
    const r = filterAllowedTimeframes(['M5', 'M7', 'D1', 'H4'], ['M5', 'M15', 'H1', 'H4']);
    expect(r.valid).toEqual(['M5', 'H4']);
    expect(r.rejected).toEqual(['M7', 'D1']);
  });
});
