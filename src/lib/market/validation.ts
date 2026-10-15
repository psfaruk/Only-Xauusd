/**
 * XAUUSD AI Trading Agent — Deterministic Market-Data Validation (Phase 3)
 * ----------------------------------------------------------------------------
 * Pure, typed, side-effect-free validation functions. No database access, no
 * environment access, no clock reads — time is always an explicit parameter,
 * which makes every function deterministic and unit-testable (spec Step 4).
 *
 * Fail-closed rule: anything that is missing, non-finite, non-positive,
 * logically inconsistent, or from the future is INVALID and must NOT be
 * persisted as confirmed data. Warnings never silently become VALID.
 */

import {
  ErrorCode,
  TIMEFRAME_SECONDS,
  type BridgeBar,
  type BridgeQuote,
  type CandleBatchResult,
  type CandleIssue,
  type MissingCandle,
  type NormalizedCandle,
  type Timeframe,
  type ValidationStatus,
} from './types';
import { classifyMissingCandle } from './sessions';

/** Tolerance for timestamps slightly ahead of "now" (clock skew between services). */
export const FUTURE_TIME_TOLERANCE_SEC = 120;

// ---------------------------------------------------------------------------
// Canonical price text (exact decimal persistence — see schema notes)
// ---------------------------------------------------------------------------

/** Decimal places in a number's shortest round-trip representation. */
export function countDecimals(n: number): number {
  if (!Number.isFinite(n)) return Number.POSITIVE_INFINITY;
  const s = String(n);
  const i = s.indexOf('.');
  if (i < 0) return 0;
  return s.length - i - 1;
}

export interface CanonicalPrice {
  text: string;
  /** true when the value carried more decimals than the verified symbol digits. */
  precisionAnomaly: boolean;
}

/**
 * Canonical decimal text for persistence. With verified `digits`:
 *   · values already within `digits` → zero-padded fixed representation
 *     (2654.3 → "2654.30") — canonical, exact, no float dust;
 *   · values with MORE decimals than the symbol allows are NEVER silently
 *     rounded — kept as-is and flagged (CANDLE_PRICE_PRECISION_ANOMALY),
 *     because altering a price would be inventing data.
 * Without verified digits: shortest round-trip string (deterministic).
 */
export function toCanonicalPrice(value: number, digits: number | null): CanonicalPrice {
  if (!Number.isFinite(value)) return { text: '', precisionAnomaly: true };
  if (digits === null || !Number.isInteger(digits) || digits < 0 || digits > 8) {
    return { text: String(value), precisionAnomaly: false };
  }
  if (countDecimals(value) <= digits) {
    return { text: value.toFixed(digits), precisionAnomaly: false };
  }
  return { text: String(value), precisionAnomaly: true };
}

// ---------------------------------------------------------------------------
// Single candle (bar) validation
// ---------------------------------------------------------------------------

export interface BarValidationContext {
  timeframe: Timeframe;
  /** Current time in UTC seconds — explicit, never Date.now() here. */
  nowUtcSec: number;
  /** Verified symbol digits from broker metadata, or null while unverified. */
  digits: number | null;
}

export interface BarValidation {
  status: ValidationStatus;
  errorCodes: string[];
  normalized: NormalizedCandle | null; // null when INVALID — nothing persisted
}

export function validateCandleBar(bar: BridgeBar, ctx: BarValidationContext): BarValidation {
  const errorCodes: string[] = [];
  const push = (c: string) => {
    if (!errorCodes.includes(c)) errorCodes.push(c);
  };

  // 1. Required fields present and numeric.
  const fields: Array<[string, unknown]> = [
    ['t', bar?.t],
    ['o', bar?.o],
    ['h', bar?.h],
    ['l', bar?.l],
    ['c', bar?.c],
  ];
  for (const [name, v] of fields) {
    if (v === undefined || v === null || typeof v !== 'number') {
      push(ErrorCode.CANDLE_MISSING_FIELDS);
      return { status: 'INVALID', errorCodes, normalized: null };
    }
  }

  // 2. Numeric finiteness (NaN / ±Infinity).
  const { t, o, h, l, c } = bar;
  if (![t, o, h, l, c].every((v) => Number.isFinite(v))) {
    push(ErrorCode.CANDLE_NON_FINITE);
    return { status: 'INVALID', errorCodes, normalized: null };
  }

  // 3. Positive prices.
  if (o <= 0 || h <= 0 || l <= 0 || c <= 0) {
    push(ErrorCode.CANDLE_NON_POSITIVE);
  }

  // 4. OHLC logical consistency.
  const highOk = h >= Math.max(o, c);
  const lowOk = l <= Math.min(o, c);
  if (!highOk || !lowOk || !(l <= h)) {
    push(ErrorCode.CANDLE_OHLC_INCONSISTENT);
  }

  // 5. Timestamp sanity (valid UTC epoch seconds, not from the future).
  if (!Number.isFinite(t) || t <= 0) {
    push(ErrorCode.CANDLE_BAD_TIME);
  } else if (t > ctx.nowUtcSec + FUTURE_TIME_TOLERANCE_SEC) {
    push(ErrorCode.CANDLE_FUTURE_TIME);
  }

  if (errorCodes.length > 0) {
    return { status: 'INVALID', errorCodes, normalized: null };
  }

  // 6. Precision anomaly → WARNING (kept, but flagged; never rounded silently).
  const op = toCanonicalPrice(o, ctx.digits);
  const hp = toCanonicalPrice(h, ctx.digits);
  const lp = toCanonicalPrice(l, ctx.digits);
  const cp = toCanonicalPrice(c, ctx.digits);
  if (op.precisionAnomaly || hp.precisionAnomaly || lp.precisionAnomaly || cp.precisionAnomaly) {
    push(ErrorCode.CANDLE_PRICE_PRECISION_ANOMALY);
  }

  // 7. Forming-bar detection — the bridge marks it with f:1; we ALSO compute
  //    it from time so a missing flag can never present a forming bar as closed.
  const tfSec = TIMEFRAME_SECONDS[ctx.timeframe];
  const bridgeSaysForming = bar.f === 1;
  const computedForming = t + tfSec > ctx.nowUtcSec;
  const isForming = bridgeSaysForming || computedForming;

  const tickVolume =
    bar.v !== undefined && bar.v !== null && Number.isFinite(bar.v) && bar.v >= 0
      ? Math.trunc(bar.v)
      : null;

  return {
    status: errorCodes.length > 0 ? 'WARNING' : 'VALID',
    errorCodes,
    normalized: {
      candleTimeUtcSec: Math.trunc(t),
      open: op.text,
      high: hp.text,
      low: lp.text,
      close: cp.text,
      tickVolume,
      isForming,
      validationStatus: errorCodes.length > 0 ? 'WARNING' : 'VALID',
      errorCodes,
    },
  };
}

// ---------------------------------------------------------------------------
// Batch validation: duplicates, ordering, per-bar checks
// ---------------------------------------------------------------------------

export function validateCandleBatch(bars: BridgeBar[], ctx: BarValidationContext): CandleBatchResult {
  const issues: CandleIssue[] = [];
  const byTime = new Map<number, NormalizedCandle>();
  let rejected = 0;
  let duplicates = 0;
  let outOfOrder = false;

  let prevT = Number.NEGATIVE_INFINITY;
  for (const bar of Array.isArray(bars) ? bars : []) {
    if (typeof bar?.t === 'number' && Number.isFinite(bar.t)) {
      if (bar.t < prevT) outOfOrder = true; // not strictly ascending
      prevT = bar.t;
    }

    const v = validateCandleBar(bar, ctx);
    if (v.status === 'INVALID' || !v.normalized) {
      rejected += 1;
      for (const code of v.errorCodes) {
        issues.push({
          code,
          severity: 'error',
          detail: `Bar rejected: ${code}`,
          barTimeUtcSec: typeof bar?.t === 'number' && Number.isFinite(bar.t) ? Math.trunc(bar.t) : undefined,
        });
      }
      continue;
    }

    const key = v.normalized.candleTimeUtcSec;
    const existing = byTime.get(key);
    if (existing) {
      duplicates += 1;
      issues.push({
        code: ErrorCode.CANDLE_DUPLICATE_KEY,
        severity: 'warning',
        detail: `Duplicate bar time ${key} in one bridge response.`,
        barTimeUtcSec: key,
      });
      // Deterministic resolution: a CLOSED bar always beats a FORMING one;
      // otherwise the first occurrence wins.
      if (existing.isForming && !v.normalized.isForming) {
        byTime.set(key, v.normalized);
      }
      continue;
    }
    byTime.set(key, v.normalized);

    if (v.status === 'WARNING') {
      for (const code of v.errorCodes) {
        issues.push({
          code,
          severity: 'warning',
          detail: `Bar kept with warning: ${code}`,
          barTimeUtcSec: key,
        });
      }
    }
  }

  if (outOfOrder) {
    issues.push({
      code: ErrorCode.CANDLE_OUT_OF_ORDER,
      severity: 'warning',
      detail: 'Bridge returned bars not in ascending time order — batch sorted before persisting.',
    });
  }

  // Ascending by time — deterministic output order.
  const candles = [...byTime.values()].sort((a, b) => a.candleTimeUtcSec - b.candleTimeUtcSec);

  return { candles, rejected, duplicates, issues, outOfOrder };
}

// ---------------------------------------------------------------------------
// Expected-candle grid & session-aware gap detection
// ---------------------------------------------------------------------------

/** TF-aligned grid [floor(from/tf)*tf, toSec) — bounded by the caller. */
export function expectedCandleTimes(fromUtcSec: number, toUtcSec: number, timeframe: Timeframe): number[] {
  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const out: number[] = [];
  let t = Math.floor(fromUtcSec / tfSec) * tfSec;
  if (t < fromUtcSec) t += tfSec;
  for (; t < toUtcSec; t += tfSec) out.push(t);
  return out;
}

export interface GapScanOptions {
  timeframe: Timeframe;
  fromUtcSec: number;
  toUtcSec: number;
  /** Current time — grid points at/after "now" are not yet due, never missing. */
  nowUtcSec: number;
  /** Cap on classified gaps returned, to bound work on pathological inputs. */
  maxGaps?: number;
}

/**
 * Find expected-but-absent candles and classify each with session awareness.
 * Gaps inside approximate closure envelopes → info (possible closure).
 * Gaps outside → warning (possible defect / unknown holiday).
 */
export function findMissingCandles(
  presentTimesUtcSec: number[],
  opts: GapScanOptions,
): MissingCandle[] {
  const present = new Set(presentTimesUtcSec.map((t) => Math.trunc(t)));
  const missing: MissingCandle[] = [];
  const max = opts.maxGaps ?? 500;
  for (const expected of expectedCandleTimes(opts.fromUtcSec, opts.toUtcSec, opts.timeframe)) {
    if (expected >= opts.nowUtcSec) break; // not due yet
    if (present.has(expected)) continue;
    missing.push(classifyMissingCandle(expected));
    if (missing.length >= max) break;
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Freshness / staleness (thresholds are parameters — configurable per caller)
// ---------------------------------------------------------------------------

export type FreshnessState = 'VALID' | 'STALE' | 'MISSING';

export function freshnessState(
  lastDataTimeUtcSec: number | null,
  nowUtcSec: number,
  staleAfterSec: number,
): FreshnessState {
  if (lastDataTimeUtcSec === null || !Number.isFinite(lastDataTimeUtcSec)) return 'MISSING';
  const age = nowUtcSec - lastDataTimeUtcSec;
  if (age < -FUTURE_TIME_TOLERANCE_SEC) return 'STALE'; // future-dated data is not trustworthy
  return age <= staleAfterSec ? 'VALID' : 'STALE';
}

export function ageSeconds(lastDataTimeUtcSec: number, nowUtcSec: number): number {
  return Math.max(0, nowUtcSec - lastDataTimeUtcSec);
}

// ---------------------------------------------------------------------------
// Tick (quote) validation
// ---------------------------------------------------------------------------

export interface TickValidationContext {
  nowUtcSec: number;
  digits: number | null;
}

export interface NormalizedTick {
  bid: string;
  ask: string;
  spread: string; // price units — always computed ourselves from ask − bid
  spreadPoints: string | null; // only when point is calculable from verified digits
  tickTimeUtcSec: number;
}

export interface TickValidation {
  status: ValidationStatus;
  errorCodes: string[];
  normalized: NormalizedTick | null; // null when INVALID
}

export function validateQuote(quote: BridgeQuote, ctx: TickValidationContext): TickValidation {
  const errorCodes: string[] = [];
  const push = (c: string) => {
    if (!errorCodes.includes(c)) errorCodes.push(c);
  };

  if (
    quote === null ||
    typeof quote !== 'object' ||
    typeof quote.bid !== 'number' ||
    typeof quote.ask !== 'number' ||
    typeof quote.ts !== 'number'
  ) {
    push(ErrorCode.TICK_INVALID);
    return { status: 'INVALID', errorCodes, normalized: null };
  }

  const { bid, ask, ts } = quote;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(ts)) {
    push(ErrorCode.TICK_INVALID);
  } else {
    if (bid <= 0 || ask <= 0) push(ErrorCode.TICK_NON_POSITIVE);
    if (ask < bid) push(ErrorCode.TICK_CROSSED);
    if (ask === bid) push(ErrorCode.TICK_ZERO_SPREAD);
    if (ts <= 0) push(ErrorCode.TICK_BAD_TIME);
    else if (ts > ctx.nowUtcSec + FUTURE_TIME_TOLERANCE_SEC) push(ErrorCode.TICK_BAD_TIME);
  }

  if (errorCodes.some((c) => c !== ErrorCode.TICK_ZERO_SPREAD)) {
    return { status: 'INVALID', errorCodes, normalized: null };
  }

  // Spread is a DERIVED quantity (ask − bid computed by us, not a
  // broker-reported price) — float subtraction can carry binary dust
  // (2650.5 − 2650.1 = 0.39999…), so we round it deterministically to the
  // symbol's verified digits. Broker-reported prices are NEVER rounded.
  const spreadNum = ask - bid;
  const spread =
    ctx.digits !== null && Number.isInteger(ctx.digits)
      ? spreadNum.toFixed(ctx.digits)
      : String(spreadNum);
  const bp = toCanonicalPrice(bid, ctx.digits);
  const ap = toCanonicalPrice(ask, ctx.digits);
  let spreadPoints: string | null = null;
  if (ctx.digits !== null && ctx.digits >= 0 && ctx.digits <= 8) {
    const point = Math.pow(10, -ctx.digits);
    spreadPoints = (spreadNum / point).toFixed(1); // points with 0.1 resolution
  }

  return {
    status: errorCodes.length > 0 ? 'WARNING' : 'VALID',
    errorCodes,
    normalized: {
      bid: bp.text,
      ask: ap.text,
      spread,
      spreadPoints,
      tickTimeUtcSec: Math.trunc(ts),
    },
  };
}

// ---------------------------------------------------------------------------
// Allowlist checks (strict — reject anything not explicitly allowed)
// ---------------------------------------------------------------------------

export function isSymbolAllowed(symbol: unknown, allowlist: readonly string[]): boolean {
  return typeof symbol === 'string' && allowlist.includes(symbol);
}

export function filterAllowedTimeframes(
  requested: readonly unknown[],
  allowlist: readonly Timeframe[],
): { valid: Timeframe[]; rejected: string[] } {
  const valid: Timeframe[] = [];
  const rejected: string[] = [];
  for (const tf of requested) {
    if (typeof tf === 'string' && (allowlist as readonly string[]).includes(tf) && TIMEFRAME_SECONDS[tf as Timeframe] !== undefined) {
      if (!valid.includes(tf as Timeframe)) valid.push(tf as Timeframe);
    } else {
      rejected.push(String(tf));
    }
  }
  return { valid, rejected };
}
