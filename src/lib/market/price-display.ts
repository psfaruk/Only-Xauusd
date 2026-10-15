/**
 * XAUUSD AI Trading Agent — Price Precision Presentation (Phase 10.3-C).
 * ----------------------------------------------------------------------------
 * A scoped, DETERMINISTIC, DISPLAY-ONLY formatter for price values shown in
 * the dashboard, signal, paper-validation and backtest views.
 *
 * Hard contract (presentation-only — Phase 10.3-C):
 *   · Precision comes ONLY from verified symbol metadata (SymbolSpec with
 *     verifiedFields containing "digits"). If metadata is missing, stale or
 *     inconsistent the formatter FAILS CLOSED: the raw stored representation
 *     is shown and flagged — NO default precision is ever assumed.
 *   · The formatter produces SEPARATE display strings. It never rounds,
 *     overwrites or mutates stored floats, canonical decimal text, strategy
 *     calculations, risk calculations, outcome calculations or verdict
 *     inputs. Those live in their own modules and are byte-frozen.
 *   · A price level whose raw value carries MORE precision than the verified
 *     digits (a derived, off-broker-grid value — Phase 10.2 finding F1) is
 *     displayed at the verified precision BUT flagged as an anomaly with the
 *     raw value preserved in `rawText` for traceability. Anomalies are shown,
 *     never hidden and never auto-corrected.
 *   · Invalid / non-finite / unparseable inputs fail closed: '—' + anomaly.
 *
 * Rounding semantics: ECMAScript `Number.prototype.toFixed(digits)` —
 * deterministic per spec (closest n/10^d; ties pick the larger n; binary
 * representation quirks like (2.675).toFixed(2) === "2.67" are part of the
 * pinned contract, covered by tests/market/price-display.test.ts).
 *
 * This module is PURE: no Date.now(), no randomness, no I/O, no globals —
 * identical inputs always produce identical display strings.
 */

// ---------------------------------------------------------------------------
// Verified precision spec
// ---------------------------------------------------------------------------

/** Cap mirrors the canonical layer's accepted digits range (validation.ts). */
const MAX_VERIFIED_DIGITS = 8;

export interface PriceDisplaySpec {
  /** Verified broker digits for the symbol, or null while unverified. */
  digits: number | null;
  /**
   * True ONLY when digits was actually verified (SymbolSpec.verifiedFields
   * includes "digits" and the value is a valid integer within range).
   */
  verified: boolean;
}

/** Fail-closed spec for missing / stale / unverified symbol metadata. */
export const UNVERIFIED_PRICE_DISPLAY: PriceDisplaySpec = {
  digits: null,
  verified: false,
};

/**
 * Build a display spec from the persisted SymbolSpec row (as returned by
 * /api/data/latest → `spec`). Stale rows (verifiedFields without "digits"),
 * absent rows and implausible digit values all collapse to the unverified,
 * fail-closed spec — the caller can never accidentally format with an
 * assumed precision.
 */
export function priceDisplaySpecFromSymbolSpec(
  spec: { digits: number | null; verifiedFields?: string[] | null } | null | undefined,
): PriceDisplaySpec {
  if (!spec) return UNVERIFIED_PRICE_DISPLAY;
  const digits = spec.digits;
  const verifiedFields = Array.isArray(spec.verifiedFields) ? spec.verifiedFields : [];
  const digitsVerified =
    verifiedFields.includes('digits') &&
    digits !== null &&
    typeof digits === 'number' &&
    Number.isInteger(digits) &&
    digits >= 0 &&
    digits <= MAX_VERIFIED_DIGITS;
  return digitsVerified ? { digits: digits as number, verified: true } : UNVERIFIED_PRICE_DISPLAY;
}

// ---------------------------------------------------------------------------
// Price LEVEL display (entry / SL / target / quotes / swing & structure prices)
// ---------------------------------------------------------------------------

export interface PriceDisplayResult {
  /** The string to render. '—' for absent or invalid values (fail-closed). */
  text: string;
  /**
   * True when the displayed string could NOT be produced with full fidelity:
   *   · raw value is off the verified broker grid (more precision than
   *     digits — a derived level), or
   *   · symbol metadata is unverified (raw shown, precision unknown), or
   *   · the input was invalid / non-finite / unparseable.
   * Anomalies are surfaced to the user — never silently corrected or hidden.
   */
  anomaly: boolean;
  /**
   * The exact raw representation of the input (stored float text or the
   * original string), for tooltips and audit traceability. The display value
   * is always recoverable back to this raw calculation value.
   */
  rawText: string;
}

const ABSENT: PriceDisplayResult = { text: '—', anomaly: false, rawText: '—' };

/**
 * Format a price LEVEL for display at the symbol's verified digits.
 *
 * Accepts either the stored number (levels/quotes numerics) or the stored
 * canonical decimal string (evidence `*Text` fields, persisted tick text) —
 * both are formatted through the same deterministic path.
 */
export function formatPriceLevel(
  value: number | string | null | undefined,
  spec: PriceDisplaySpec,
): PriceDisplayResult {
  if (value === null || value === undefined) return ABSENT;

  let num: number;
  let rawText: string;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return ABSENT;
    rawText = s;
    num = Number(s);
    if (!Number.isFinite(num)) {
      // Unparseable stored text — fail closed, never a guessed price.
      return { text: '—', anomaly: true, rawText };
    }
  } else {
    rawText = String(value);
    num = value;
    if (!Number.isFinite(num)) {
      // NaN / ±Infinity — fail closed.
      return { text: '—', anomaly: true, rawText };
    }
  }

  if (!spec.verified || spec.digits === null) {
    // Missing / stale / unverified metadata: show the RAW representation and
    // flag it. NO default precision is assumed (Phase 10.3-C rule 3).
    return { text: rawText, anomaly: true, rawText };
  }

  const text = num.toFixed(spec.digits);
  // Off-grid detection: the display string re-parses to the same number only
  // when the raw value carried no more precision than the verified digits.
  const onGrid = Number(text) === num;
  return { text, anomaly: !onGrid, rawText };
}

// ---------------------------------------------------------------------------
// Price-UNIT QUANTITY display (P&L, costs, spreads — differences & sums)
// ---------------------------------------------------------------------------

/**
 * Format a price-UNIT quantity (net/gross P&L, cost components, spread
 * assumptions) at the symbol's verified digits. Quantities are legitimately
 * off-grid derived values, so display rounding is normal here and carries no
 * anomaly marker; the raw value stays traceable at the call site.
 *
 * Fail-closed: null/undefined/non-finite → '—'; unverified metadata → the
 * raw value string (never an assumed precision).
 */
export function formatPriceQuantity(
  value: number | null | undefined,
  spec: PriceDisplaySpec,
): string {
  if (value === null || value === undefined) return '—';
  if (!Number.isFinite(value)) return '—';
  if (!spec.verified || spec.digits === null) return String(value);
  return value.toFixed(spec.digits);
}
