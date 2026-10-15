/**
 * Phase 10.3-C — Price Precision Presentation: regression tests (TEST-FIRST).
 * ----------------------------------------------------------------------------
 * Pins the DISPLAY-ONLY formatter contract (src/lib/market/price-display.ts):
 *
 *   1. Verified digits=2 → two decimal places; digits=3 → three.
 *   2. ECMAScript toFixed rounding boundaries + trailing zeros (pinned exactly).
 *   3. Negative finite input formats deterministically; invalid / non-finite /
 *      unparseable input fails CLOSED ('—' + anomaly) — never a guess.
 *   4. Missing / stale / unverified symbol metadata → the RAW stored
 *      representation is shown and flagged (anomaly) — NO default precision
 *      is ever assumed.
 *   5. Formatting is PURE: the input value/string is never mutated, and an
 *      on-grid value round-trips exactly (Number(display) === raw). The
 *      formatter can only return display strings — it can never feed back
 *      into stored floats, strategy/risk/outcome calculations, or verdicts
 *      (those live in untouched modules proven by the full suite).
 *
 * This file tests PRESENTATION ONLY. It deliberately does NOT test strategy
 * math, SL/TP comparison logic, risk gates, or paper outcome metrics — the
 * pre-existing suites (paper, paper-chronology, setup-identity, backtest,
 * protocol) pin those byte-for-byte and must keep passing unchanged.
 */

import { describe, expect, test } from 'bun:test';

import {
  UNVERIFIED_PRICE_DISPLAY,
  formatPriceLevel,
  formatPriceQuantity,
  priceDisplaySpecFromSymbolSpec,
  type PriceDisplaySpec,
} from '../../src/lib/market/price-display';

// ---------------------------------------------------------------------------
// Spec construction — verified symbol metadata only
// ---------------------------------------------------------------------------

describe('priceDisplaySpecFromSymbolSpec — metadata gate', () => {
  test('S1: verified SymbolSpec (digits + verifiedFields ["digits"]) → verified spec', () => {
    const spec = priceDisplaySpecFromSymbolSpec({ digits: 3, verifiedFields: ['digits'] });
    expect(spec).toEqual({ digits: 3, verified: true });
  });

  test('S2: null/absent spec row → unverified (fail-closed, no default precision)', () => {
    expect(priceDisplaySpecFromSymbolSpec(null)).toEqual(UNVERIFIED_PRICE_DISPLAY);
    expect(priceDisplaySpecFromSymbolSpec(undefined)).toEqual(UNVERIFIED_PRICE_DISPLAY);
  });

  test('S3: row exists but "digits" NOT in verifiedFields (stale/unverified) → unverified', () => {
    const spec = priceDisplaySpecFromSymbolSpec({ digits: 3, verifiedFields: ['point'] });
    expect(spec).toEqual(UNVERIFIED_PRICE_DISPLAY);
    expect(spec.verified).toBe(false);
    expect(spec.digits).toBeNull();
  });

  test('S4: verifiedFields empty array → unverified', () => {
    expect(priceDisplaySpecFromSymbolSpec({ digits: 2, verifiedFields: [] })).toEqual(
      UNVERIFIED_PRICE_DISPLAY,
    );
  });

  test('S5: non-integer / negative / out-of-range digits → unverified even if claimed verified', () => {
    for (const bad of [Number.NaN, -1, 1.5, 9, 100]) {
      const spec = priceDisplaySpecFromSymbolSpec({ digits: bad, verifiedFields: ['digits'] });
      expect(spec).toEqual(UNVERIFIED_PRICE_DISPLAY);
    }
  });

  test('S6: boundary digits 0 and 8 are valid verified precisions', () => {
    expect(priceDisplaySpecFromSymbolSpec({ digits: 0, verifiedFields: ['digits'] })).toEqual({
      digits: 0,
      verified: true,
    });
    expect(priceDisplaySpecFromSymbolSpec({ digits: 8, verifiedFields: ['digits'] })).toEqual({
      digits: 8,
      verified: true,
    });
  });
});

// ---------------------------------------------------------------------------
// formatPriceLevel — verified precision display
// ---------------------------------------------------------------------------

describe('formatPriceLevel — verified digits', () => {
  const d2: PriceDisplaySpec = { digits: 2, verified: true };
  const d3: PriceDisplaySpec = { digits: 3, verified: true };

  test('L1: verified digits=2 → exactly two decimal places', () => {
    expect(formatPriceLevel(4144.82, d2).text).toBe('4144.82');
    expect(formatPriceLevel(4144.8, d2).text).toBe('4144.80'); // trailing zero kept
    expect(formatPriceLevel(4144, d2).text).toBe('4144.00');
  });

  test('L2: verified digits=3 → exactly three decimal places (XAUUSDm reality)', () => {
    expect(formatPriceLevel(4144.821, d3).text).toBe('4144.821');
    expect(formatPriceLevel(4144.82, d3).text).toBe('4144.820');
    expect(formatPriceLevel(4144.8, d3).text).toBe('4144.800');
    expect(formatPriceLevel(10, d3).text).toBe('10.000');
  });

  test('L3: on-grid value → NO anomaly, display round-trips to the raw number', () => {
    const r = formatPriceLevel(4144.821, d3);
    expect(r.anomaly).toBe(false);
    expect(Number(r.text)).toBe(4144.821);
    expect(r.rawText).toBe('4144.821');
  });

  test('L4: off-grid DERIVED level (Phase 10.2 F1) → digits display + anomaly flagged, raw preserved for trace', () => {
    const raw = 4393.396214351791; // persisted backtest stopLoss on a 3-digit symbol
    const r = formatPriceLevel(raw, d3);
    expect(r.text).toBe('4393.396');
    expect(r.anomaly).toBe(true); // NEVER silently corrected or hidden
    expect(r.rawText).toBe('4393.396214351791');
    expect(Number(r.text)).not.toBe(raw); // display is rounded — trace stays via rawText
  });

  test('L5: rounding boundaries pinned to ECMAScript toFixed semantics (documented, deterministic)', () => {
    // Binary-representation quirks are part of the deterministic contract:
    expect(formatPriceLevel(4393.3965, d3).text).toBe('4393.396');
    expect(formatPriceLevel(2.675, d2).text).toBe('2.67');
    expect(formatPriceLevel(1.005, d2).text).toBe('1.00');
    expect(formatPriceLevel(8.999, d2).text).toBe('9.00'); // carry boundary
    expect(formatPriceLevel(0.5, { digits: 0, verified: true }).text).toBe('1'); // half → larger n
    expect(formatPriceLevel(2.5, { digits: 0, verified: true }).text).toBe('3');
  });

  test('L6: trailing zeros are shown, never stripped (precision is information)', () => {
    expect(formatPriceLevel(4144.5, d2).text).toBe('4144.50');
    expect(formatPriceLevel(4144.5, d3).text).toBe('4144.500');
    expect(formatPriceLevel(0.1, d2).text).toBe('0.10');
    expect(formatPriceLevel(1, d2).text).toBe('1.00');
  });

  test('L7: negative finite input formats deterministically (formatter is presentation, not validation)', () => {
    const r = formatPriceLevel(-1234.5, d2);
    expect(r.text).toBe('-1234.50');
    expect(r.anomaly).toBe(false);
  });

  test('L8: negative off-grid input → digits display + anomaly', () => {
    const r = formatPriceLevel(-0.30000000000000004, d2);
    expect(r.text).toBe('-0.30');
    expect(r.anomaly).toBe(true);
    expect(r.rawText).toBe('-0.30000000000000004');
  });

  test('L9: null / undefined → honest absence, no anomaly', () => {
    expect(formatPriceLevel(null, d3)).toEqual({ text: '—', anomaly: false, rawText: '—' });
    expect(formatPriceLevel(undefined, d3)).toEqual({ text: '—', anomaly: false, rawText: '—' });
  });

  test('L10: non-finite numbers fail CLOSED — em-dash + anomaly, never a fabricated price', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = formatPriceLevel(bad, d3);
      expect(r.text).toBe('—');
      expect(r.anomaly).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// formatPriceLevel — string inputs (stored canonical decimal TEXT)
// ---------------------------------------------------------------------------

describe('formatPriceLevel — canonical string inputs (stored evidence text)', () => {
  const d3: PriceDisplaySpec = { digits: 3, verified: true };

  test('T1: on-grid canonical string (broker candle / swing price) → unchanged text, no anomaly', () => {
    const r = formatPriceLevel('4144.821', d3);
    expect(r.text).toBe('4144.821');
    expect(r.anomaly).toBe(false);
    expect(r.rawText).toBe('4144.821');
  });

  test('T2: off-grid canonical string (derived level, full float text) → rounded display + anomaly + raw kept', () => {
    const r = formatPriceLevel('4393.396214351791', d3);
    expect(r.text).toBe('4393.396');
    expect(r.anomaly).toBe(true);
    expect(r.rawText).toBe('4393.396214351791');
  });

  test('T3: empty / whitespace-only string → honest absence', () => {
    expect(formatPriceLevel('', d3).text).toBe('—');
    expect(formatPriceLevel('   ', d3).text).toBe('—');
    expect(formatPriceLevel('   ', d3).anomaly).toBe(false);
  });

  test('T4: non-numeric string fails CLOSED — em-dash + anomaly', () => {
    const r = formatPriceLevel('not-a-price', d3);
    expect(r.text).toBe('—');
    expect(r.anomaly).toBe(true);
    expect(r.rawText).toBe('not-a-price');
  });

  test('T5: string with MORE trailing zeros than digits is still the same value → on-grid', () => {
    const r = formatPriceLevel('4144.8210', d3);
    expect(r.text).toBe('4144.821');
    expect(r.anomaly).toBe(false);
  });

  test('T6: stored tick/quote strings pass through the same verified-precision path', () => {
    const r = formatPriceLevel('2650.123', d3);
    expect(r.text).toBe('2650.123');
    expect(r.anomaly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatPriceLevel — missing / stale metadata (fail-closed presentation)
// ---------------------------------------------------------------------------

describe('formatPriceLevel — unverified metadata fail-closed', () => {
  const unverified = UNVERIFIED_PRICE_DISPLAY;

  test('M1: numeric input with unverified spec → RAW representation shown + anomaly (NO default precision)', () => {
    const r = formatPriceLevel(4393.396214351791, unverified);
    expect(r.text).toBe('4393.396214351791'); // raw, never rounded to an assumed 2 or 3
    expect(r.anomaly).toBe(true);
  });

  test('M2: string input with unverified spec → the stored string is displayed verbatim + anomaly', () => {
    const r = formatPriceLevel('4144.821', unverified);
    expect(r.text).toBe('4144.821');
    expect(r.anomaly).toBe(true); // flagged: precision could not be verified
  });

  test('M3: unverified spec never invents digits — on-grid-looking values still get flagged', () => {
    const r = formatPriceLevel(4144.82, unverified);
    expect(r.text).toBe('4144.82');
    expect(r.anomaly).toBe(true);
  });

  test('M4: null value stays absent even with unverified spec', () => {
    expect(formatPriceLevel(null, unverified).text).toBe('—');
    expect(formatPriceLevel(null, unverified).anomaly).toBe(false);
  });

  test('M5: unverified + non-finite → em-dash + anomaly (fail-closed twice over)', () => {
    const r = formatPriceLevel(Number.NaN, unverified);
    expect(r.text).toBe('—');
    expect(r.anomaly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatPriceQuantity — price-UNIT aggregates (P&L, costs, spreads)
// ---------------------------------------------------------------------------

describe('formatPriceQuantity — price-unit quantities', () => {
  const d3: PriceDisplaySpec = { digits: 3, verified: true };

  test('Q1: null/undefined → honest absence', () => {
    expect(formatPriceQuantity(null, d3)).toBe('—');
    expect(formatPriceQuantity(undefined, d3)).toBe('—');
  });

  test('Q2: non-finite fails closed → em-dash', () => {
    expect(formatPriceQuantity(Number.NaN, d3)).toBe('—');
    expect(formatPriceQuantity(Number.POSITIVE_INFINITY, d3)).toBe('—');
  });

  test('Q3: verified digits → quantity displayed at the same verified precision', () => {
    expect(formatPriceQuantity(12.34567, d3)).toBe('12.346');
    expect(formatPriceQuantity(-3.2, d3)).toBe('-3.200');
    expect(formatPriceQuantity(0, d3)).toBe('0.000');
  });

  test('Q4: unverified spec → raw value string, never an assumed precision', () => {
    expect(formatPriceQuantity(12.34567, UNVERIFIED_PRICE_DISPLAY)).toBe('12.34567');
  });
});

// ---------------------------------------------------------------------------
// Purity / immutability — internal values are never touched
// ---------------------------------------------------------------------------

describe('formatting purity — internal values unchanged before/after', () => {
  const d3: PriceDisplaySpec = { digits: 3, verified: true };

  test('P1: numeric input object is never mutated (primitive pass-through)', () => {
    const raw = 4393.396214351791;
    const before = raw;
    const r = formatPriceLevel(raw, d3);
    expect(raw).toBe(before); // identical reference value — nothing was overwritten
    expect(r.rawText).toBe(String(before));
  });

  test('P2: string input is never mutated and rawText preserves it EXACTLY', () => {
    const stored = '4393.396214351791';
    const r = formatPriceLevel(stored, d3);
    expect(stored).toBe('4393.396214351791');
    expect(r.rawText).toBe(stored);
  });

  test('P3: on-grid display round-trips to the internal value exactly (traceability both ways)', () => {
    for (const v of [4144.821, 2650.123, 0.001, 10, 4144.82]) {
      const r = formatPriceLevel(v, d3);
      expect(r.anomaly).toBe(false);
      expect(Number(r.text)).toBe(v);
    }
  });

  test('P4: off-grid display is rounded but the raw calculation value remains recoverable from rawText', () => {
    const raw = 4393.396214351791;
    const r = formatPriceLevel(raw, d3);
    expect(Number(r.rawText)).toBe(raw); // raw calculation value fully recoverable
    expect(r.text).not.toBe(r.rawText); // display is a SEPARATE string — stored value untouched
  });

  test('P5: the spec object itself is never mutated by formatting', () => {
    const spec: PriceDisplaySpec = { digits: 3, verified: true };
    formatPriceLevel(4144.821, spec);
    formatPriceQuantity(1.5, spec);
    formatPriceLevel('4144.821', spec);
    expect(spec).toEqual({ digits: 3, verified: true });
  });

  test('P6: formatter output is a STRING — it cannot numerically feed back into calculations', () => {
    const r = formatPriceLevel(4393.396214351791, d3);
    expect(typeof r.text).toBe('string');
    expect(typeof r.rawText).toBe('string');
    // A caller would have to explicitly re-parse; the formatter never returns
    // a number that could silently replace a stored float.
  });
});

// ---------------------------------------------------------------------------
// Cross-invariant with the canonical price layer (display must not corrupt it)
// ---------------------------------------------------------------------------

describe('canonical layer coexistence', () => {
  test('X1: display formatter matches toCanonicalPrice text for on-grid broker prices', async () => {
    const { toCanonicalPrice } = await import('../../src/lib/market/validation');
    const d3: PriceDisplaySpec = { digits: 3, verified: true };
    for (const v of [4144.821, 2650.123, 0.001]) {
      const canonical = toCanonicalPrice(v, 3);
      expect(canonical.precisionAnomaly).toBe(false);
      const display = formatPriceLevel(v, d3);
      expect(display.text).toBe(canonical.text); // identical for broker-grid prices
      expect(display.anomaly).toBe(false);
    }
  });

  test('X2: for the off-grid derived value, display rounds but canonical text stays raw (both honest)', async () => {
    const { toCanonicalPrice } = await import('../../src/lib/market/validation');
    const raw = 4393.396214351791;
    const canonical = toCanonicalPrice(raw, 3);
    expect(canonical.precisionAnomaly).toBe(true); // canonical layer: anomaly FLAG, no rounding
    expect(canonical.text).toBe('4393.396214351791');
    const display = formatPriceLevel(raw, { digits: 3, verified: true });
    expect(display.text).toBe('4393.396'); // display layer: rounds + flags + keeps raw
    expect(display.rawText).toBe(canonical.text); // traceability to the stored evidence text
  });
});
