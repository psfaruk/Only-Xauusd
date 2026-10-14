/**
 * XAUUSD AI Trading Agent — Market Data Domain Types (Phase 3)
 * ----------------------------------------------------------------------------
 * Single source of truth for the market-data pipeline's vocabulary:
 * timeframes, quality states, stable error codes, and the Bridge REST contract
 * (identical to the user's v20 `mt5-service` read-only surface — see
 * audit/phase3-audit.md §1.3).
 *
 * READ-ONLY: this module and the whole `src/lib/market/*` layer never define,
 * call or reference order/trade/position operations. Market data in, validated
 * rows out. Nothing else.
 */

// ---------------------------------------------------------------------------
// Timeframes
// ---------------------------------------------------------------------------

/** Supported timeframes → bar duration in seconds. */
export const TIMEFRAME_SECONDS = {
  M5: 300,
  M15: 900,
  H1: 3_600,
  H4: 14_400,
} as const;

export type Timeframe = keyof typeof TIMEFRAME_SECONDS;

export const ALL_TIMEFRAMES: readonly Timeframe[] = ['M5', 'M15', 'H1', 'H4'];

export function isTimeframe(v: unknown): v is Timeframe {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TIMEFRAME_SECONDS, v);
}

// ---------------------------------------------------------------------------
// Quality states (spec Step 5) — a warning must never silently become VALID.
// ---------------------------------------------------------------------------

export type QualityState = 'VALID' | 'WARNING' | 'INVALID' | 'STALE' | 'MISSING' | 'UNAVAILABLE';

/** Severity rank for aggregation — higher wins. */
export const QUALITY_STATE_RANK: Record<QualityState, number> = {
  VALID: 0,
  WARNING: 1,
  STALE: 2,
  MISSING: 3,
  INVALID: 4,
  UNAVAILABLE: 5,
};

export function worstQualityState(states: QualityState[]): QualityState {
  return states.reduce<QualityState>(
    (worst, s) => (QUALITY_STATE_RANK[s] > QUALITY_STATE_RANK[worst] ? s : worst),
    'VALID',
  );
}

/** Per-record validation outcome (persisted on candles/ticks). */
export type ValidationStatus = 'VALID' | 'WARNING' | 'INVALID';

// ---------------------------------------------------------------------------
// Stable machine-readable error codes
// ---------------------------------------------------------------------------

export const ErrorCode = {
  // Bridge availability (fail-closed family)
  BRIDGE_NOT_CONFIGURED: 'BRIDGE_NOT_CONFIGURED',
  BRIDGE_UNREACHABLE: 'BRIDGE_UNREACHABLE',
  BRIDGE_TIMEOUT: 'BRIDGE_TIMEOUT',
  BRIDGE_HTTP_ERROR: 'BRIDGE_HTTP_ERROR',
  BRIDGE_AUTH_FAILED: 'BRIDGE_AUTH_FAILED',
  BRIDGE_RATE_LIMITED: 'BRIDGE_RATE_LIMITED',
  BRIDGE_BAD_RESPONSE: 'BRIDGE_BAD_RESPONSE',
  BRIDGE_PARTIAL_RESPONSE: 'BRIDGE_PARTIAL_RESPONSE',

  // Feed source
  SOURCE_DEMO: 'SOURCE_DEMO',
  SOURCE_DISCONNECTED: 'SOURCE_DISCONNECTED',

  // Allowlists
  SYMBOL_NOT_ALLOWED: 'SYMBOL_NOT_ALLOWED',
  SYMBOL_NOT_FOUND: 'SYMBOL_NOT_FOUND',
  TIMEFRAME_NOT_ALLOWED: 'TIMEFRAME_NOT_ALLOWED',

  // Candle validation
  CANDLE_MISSING_FIELDS: 'CANDLE_MISSING_FIELDS',
  CANDLE_NON_FINITE: 'CANDLE_NON_FINITE',
  CANDLE_NON_POSITIVE: 'CANDLE_NON_POSITIVE',
  CANDLE_OHLC_INCONSISTENT: 'CANDLE_OHLC_INCONSISTENT',
  CANDLE_BAD_TIME: 'CANDLE_BAD_TIME',
  CANDLE_DUPLICATE_KEY: 'CANDLE_DUPLICATE_KEY',
  CANDLE_OUT_OF_ORDER: 'CANDLE_OUT_OF_ORDER',
  CANDLE_PRICE_PRECISION_ANOMALY: 'CANDLE_PRICE_PRECISION_ANOMALY',
  CANDLE_FUTURE_TIME: 'CANDLE_FUTURE_TIME',
  FORMING_BAR_STALE: 'FORMING_BAR_STALE',
  CANDLE_SPREAD_UNAVAILABLE: 'CANDLE_SPREAD_UNAVAILABLE',

  // Tick validation
  TICK_INVALID: 'TICK_INVALID',
  TICK_NON_POSITIVE: 'TICK_NON_POSITIVE',
  TICK_CROSSED: 'TICK_CROSSED',
  TICK_ZERO_SPREAD: 'TICK_ZERO_SPREAD',
  TICK_STALE: 'TICK_STALE',
  TICK_BAD_TIME: 'TICK_BAD_TIME',

  // Gaps / staleness / missing
  GAP_POSSIBLE: 'GAP_POSSIBLE',
  GAP_MARKET_LIKELY_CLOSED: 'GAP_MARKET_LIKELY_CLOSED',
  DATA_STALE: 'DATA_STALE',
  DATA_MISSING: 'DATA_MISSING',
  SPEC_MISSING: 'SPEC_MISSING',

  // API surface
  AUTH_MISSING_TOKEN: 'AUTH_MISSING_TOKEN',
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  BAD_REQUEST: 'BAD_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  LIMIT_TOO_LARGE: 'LIMIT_TOO_LARGE',
  RANGE_TOO_LARGE: 'RANGE_TOO_LARGE',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',

  // Storage
  DB_ERROR: 'DB_ERROR',
  DB_TX_FAILED: 'DB_TX_FAILED',
  SYNC_IN_PROGRESS: 'SYNC_IN_PROGRESS',

  // API security posture (Phase 4 hardening — fail closed)
  MARKET_API_TOKEN_NOT_CONFIGURED: 'MARKET_API_TOKEN_NOT_CONFIGURED',

  // Backfill coverage (Phase 4 hardening — range vs received)
  BACKFILL_INCOMPLETE: 'BACKFILL_INCOMPLETE',

  // Analysis engine (Phase 4 — analysis-only, never signals)
  ANALYSIS_ERROR: 'ANALYSIS_ERROR',
  DATA_NOT_READY: 'DATA_NOT_READY',
  DATA_INVALID: 'DATA_INVALID',
  DEMO_DATA_BLOCKED: 'DEMO_DATA_BLOCKED',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------------------------------------------------------------------------
// Bridge REST contract (v20 mt5-service, read-only endpoints only)
// Timestamps arrive as UTC SECONDS (the bridge quantizes broker→UTC offset).
// ---------------------------------------------------------------------------

export type BridgeFeedSource = 'mt5' | 'disconnected' | 'demo';

export interface BridgeHealth {
  ok: boolean;
  service?: string;
  source?: BridgeFeedSource | string;
  connected?: boolean;
  uptime?: number;
}

export interface BridgeStatus {
  connected: boolean;
  source: BridgeFeedSource | string;
  server?: string | null;
  latencyMs?: number | null;
  serverTime?: number;
  offsetSec?: number;
  reason?: string | null;
  symbols?: number;
}

export interface BridgeQuote {
  symbol: string;
  bid: number;
  ask: number;
  mid?: number;
  ts: number; // UTC seconds
  spread?: number; // price units (ask − bid), when supplied
}

export interface BridgeBar {
  t: number; // UTC seconds — bar OPEN time
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number; // tick volume
  f?: number; // 1 = forming (still-open) bar
}

export interface BridgeCandlesResponse {
  symbol: string;
  tf: string;
  digits?: number;
  source: BridgeFeedSource | string;
  bars: BridgeBar[];
}

export interface BridgeSymbolsResponse {
  source: BridgeFeedSource | string;
  list: string[];
}

/** Discriminated result — bridge calls never throw; they fail closed. */
export type BridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; httpStatus?: number } };

// ---------------------------------------------------------------------------
// Validation structures
// ---------------------------------------------------------------------------

export interface CandleIssue {
  code: string;
  severity: 'warning' | 'error';
  detail: string;
  barTimeUtcSec?: number;
}

export interface NormalizedCandle {
  candleTimeUtcSec: number;
  open: string; // canonical decimal text
  high: string;
  low: string;
  close: string;
  tickVolume: number | null;
  isForming: boolean;
  validationStatus: ValidationStatus;
  errorCodes: string[];
}

export interface CandleBatchResult {
  candles: NormalizedCandle[]; // ascending by time, duplicates removed
  rejected: number;
  duplicates: number;
  issues: CandleIssue[];
  outOfOrder: boolean;
}

export interface MissingCandle {
  expectedTimeUtcSec: number;
  severity: 'info' | 'warning';
  reasonCode: string;
  note: string; // English detail (Bengali rendering happens in the UI layer)
}

// ---------------------------------------------------------------------------
// Analysis-readiness result (spec Step 5) — data readiness ONLY.
// This is explicitly NOT a trade recommendation and must never contain one.
// ---------------------------------------------------------------------------

export interface TimeframeReadiness {
  timeframe: Timeframe;
  state: QualityState;
  lastClosedCandleTimeUtc: string | null;
  lastClosedCandleAgeSeconds: number | null;
  stalenessThresholdSeconds: number;
  scannedCandles: number;
  missingCandles: number; // confirmed-suspicious gaps (outside closure windows)
  possibleClosureGaps: number; // gaps inside approximate closure windows
  errorCodes: string[];
}

export interface TickReadiness {
  state: QualityState;
  bid: string | null;
  ask: string | null;
  spread: string | null;
  lastTickTimeUtc: string | null;
  ageSeconds: number | null;
  stalenessThresholdSeconds: number;
  errorCodes: string[];
}

export interface ReadinessResult {
  ready: boolean;
  purpose: 'data-readiness-only-not-trade-recommendation';
  symbol: string;
  timeframesChecked: Timeframe[];
  source: string | null;
  checkedAtUtc: string;
  lastTickTimeUtc: string | null;
  lastClosedCandleTimeUtc: string | null;
  dataAgeSeconds: number | null;
  qualityState: QualityState;
  errorCodes: string[];
  tick: TickReadiness;
  timeframes: TimeframeReadiness[];
}

/** Structured "unavailable" result handed to downstream analysis (fail-closed). */
export interface UnavailableResult {
  ready: false;
  qualityState: 'UNAVAILABLE';
  errorCodes: string[];
  reason: string;
}

export function unavailableResult(errorCodes: string[], reason: string): UnavailableResult {
  return { ready: false, qualityState: 'UNAVAILABLE', errorCodes, reason };
}

// ---------------------------------------------------------------------------
// Sync run structures
// ---------------------------------------------------------------------------

export type SyncMode = 'manual' | 'scheduled' | 'backfill';
export type SyncStatus = 'running' | 'success' | 'partial' | 'failed' | 'skipped';

export interface SyncOutcome {
  runId: string;
  status: SyncStatus;
  symbol: string;
  timeframes: Timeframe[];
  requested: number;
  received: number;
  inserted: number;
  updated: number;
  rejected: number;
  duplicates: number;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  /** Backfill-only: timestamp-based verification that the requested range is
   * actually covered by persisted candles (Phase 4 hardening — a filled `limit`
   * is never mistaken for a covered range). Null for non-backfill modes. */
  coverage: Array<{
    timeframe: Timeframe;
    expectedBars: number; // grid bars that were due (closed) in [rangeStart, rangeEnd)
    presentBars: number; // of those, actually persisted as closed candles
    missingBars: number; // expected-but-absent OUTSIDE approximate closure windows (suspicious)
    closureGaps: number; // expected-but-absent inside approximate closure envelopes (info)
    complete: boolean; // true only when missingBars === 0
  }> | null;
  perTimeframe: Array<{
    timeframe: Timeframe;
    status: 'success' | 'failed' | 'skipped';
    received: number;
    inserted: number;
    updated: number;
    rejected: number;
    duplicates: number;
    errorCode: string | null;
  }>;
}
