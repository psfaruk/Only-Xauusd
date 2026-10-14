/**
 * XAUUSD AI Trading Agent — Analysis Domain Types (Phase 4)
 * ----------------------------------------------------------------------------
 * Single source of truth for the deterministic analysis engine's vocabulary:
 * engine version, statuses, reason codes, swing/structure/indicator types and
 * the versioned output contract.
 *
 * READ-ONLY + ANALYSIS-ONLY: this engine computes technical-analysis
 * snapshots. It NEVER produces a trade signal, an entry, a position size or
 * any execution instruction — signal construction is Phase 5 and does not
 * exist here. The LLM is never asked to calculate or override a deterministic
 * value.
 *
 * Determinism contract: same normalized input + same calculationConfig +
 * same engineVersion → byte-identical output (verified by fingerprint tests).
 */

import type { QualityState, Timeframe } from '@/lib/market/types';

// ---------------------------------------------------------------------------
// Engine identity
// ---------------------------------------------------------------------------

/** Bump on any change to calculation rules or output shape. */
export const ENGINE_VERSION = '4.0.0';

export type AnalysisStatus = 'COMPLETED' | 'BLOCKED' | 'FAILED';

/** DB-level status values (persisted on AnalysisRun.status). */
export type AnalysisRunStatus = 'pending' | 'completed' | 'blocked' | 'failed';

// ---------------------------------------------------------------------------
// Reason codes (typed, stable, machine-readable)
// ---------------------------------------------------------------------------

/**
 * Every code the engine may emit in `reasonCodes`. Convention: market-data
 * family codes reuse the Phase 3 vocabulary (src/lib/market/types.ts) so the
 * two layers stay consistent.
 */
export type AnalysisReasonCode =
  // Gate / allowlists
  | 'SYMBOL_NOT_ALLOWED'
  | 'TIMEFRAME_NOT_ALLOWED'
  // Data availability (fail closed — no data, no analysis)
  | 'DATA_NOT_READY'
  | 'DATA_STALE'
  | 'DATA_MISSING'
  | 'DATA_INVALID'
  | 'DEMO_DATA_BLOCKED'
  | 'SOURCE_DEMO'
  | 'INSUFFICIENT_DATA'
  | 'GAP_IN_ANALYSIS_WINDOW'
  // Bridge family (pass-through of the Phase 3 probe outcome)
  | 'BRIDGE_NOT_CONFIGURED'
  | 'BRIDGE_UNREACHABLE'
  | 'BRIDGE_TIMEOUT'
  | 'BRIDGE_HTTP_ERROR'
  | 'BRIDGE_AUTH_FAILED'
  | 'BRIDGE_BAD_RESPONSE'
  | 'SPEC_MISSING'
  | 'TICK_INVALID'
  | 'TICK_STALE'
  // Engine failure
  | 'ANALYSIS_ERROR';

export type AnalysisWarningCode =
  | 'CLOSURE_GAPS_IN_WINDOW'
  | 'SWING_WINDOW_SHORT'
  | 'STRUCTURE_UNCLEAR'
  | 'RSI_FLAT_MARKET'
  | 'ADX_FLAT_MARKET'
  | 'DI_ZERO_TR'
  | 'INSUFFICIENT_HISTORY_INDICATOR'
  | 'GAP_POSSIBLE';

// ---------------------------------------------------------------------------
// Input candles (loaded from Phase 3 persistence)
// ----------------------------------------------------------------------------

/**
 * One CLOSED candle for analysis. Numeric values are IEEE-754 float64 parsed
 * from the exact canonical decimal text (kept alongside) — deterministic and
 * documented. `*Text` fields are the exact source prices (never rounded).
 */
export interface AnalysisCandle {
  timeUtcSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  openText: string;
  highText: string;
  lowText: string;
  closeText: string;
}

/** Per-timeframe data as loaded by the persistence layer. */
export interface TfLoadedData {
  timeframe: Timeframe;
  candles: AnalysisCandle[]; // ascending by time; closed only
  source: string | null; // row-level provenance, e.g. 'bridge-mt5'
  formingExcluded: number; // forming rows seen in the window (never analysed)
  invalidExcluded: number; // INVALID rows found in the window (defensive; never analysed)
  demoRows: boolean; // any row sourced from a demo-labelled feed
  windowGapsSuspicious: number; // missing grid bars OUTSIDE closure envelopes (in analysis window)
  windowClosureGaps: number; // missing grid bars inside approximate closure envelopes (info)
}

// ---------------------------------------------------------------------------
// Swings
// ----------------------------------------------------------------------------

export interface SwingPoint {
  kind: 'high' | 'low';
  index: number; // candle index in the analysed closed series
  timeUtcSec: number; // ORIGINAL candle open time
  confirmedAtUtcSec: number; // when the right-side window had fully closed
  price: number;
  priceText: string;
}

// ---------------------------------------------------------------------------
// Structure
// ----------------------------------------------------------------------------

export type SwingPairLabel = 'HH' | 'LH' | 'HL' | 'LL' | 'UNCLEAR';
export type StructuralTrend = 'bullish' | 'bearish' | 'range' | 'unclear';

export interface BreachEvent {
  seq: number;
  type: 'BOS' | 'CHoCH';
  direction: 'bullish' | 'bearish';
  level: number;
  levelText: string;
  brokenSwingKind: 'high' | 'low';
  brokenSwingTimeUtcSec: number;
  breakCandleTimeUtcSec: number; // the candle whose CLOSE broke the level
  confirmedAtUtcSec: number; // that candle's close instant (open + tf)
  basis: 'close'; // wick-only crossings NEVER confirm
  trendAtBreak: StructuralTrend;
}

export interface UnconfirmedCrossing {
  direction: 'bullish' | 'bearish';
  level: number;
  levelText: string;
  candleTimeUtcSec: number;
  wickBeyond: number; // how far the wick went beyond the level (price units)
}

export interface StructureResult {
  swingLeft: number;
  swingRight: number;
  confirmedSwings: SwingPoint[];
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
  highLabel: SwingPairLabel;
  lowLabel: SwingPairLabel;
  trend: StructuralTrend;
  events: BreachEvent[];
  unconfirmedCrossings: UnconfirmedCrossing[];
}

// ---------------------------------------------------------------------------
// Indicators
// ----------------------------------------------------------------------------

export interface IndicatorSeriesSnapshot {
  period: number;
  fromIndex: number | null; // first index carrying a value (null = none)
  warmupBars: number; // bars required before the first value
  convention: string; // documented seed/smoothing rule
  last: { index: number; timeUtcSec: number; value: number } | null;
  previous: { index: number; timeUtcSec: number; value: number } | null;
  tail: Array<{ timeUtcSec: number; value: number }>; // last 3 values
}

// ---------------------------------------------------------------------------
// Readiness (per-timeframe gate output)
// ----------------------------------------------------------------------------

export interface TimeframeReadinessEntry {
  timeframe: Timeframe;
  state: 'READY' | 'BLOCKED';
  phase3State: QualityState;
  closedCandles: number;
  requiredMinBars: number;
  errorCodes: string[]; // when BLOCKED — machine-readable reasons
  warnings: string[]; // non-blocking, always visible
}

// ---------------------------------------------------------------------------
// Calculation configuration (persisted with every run)
// ----------------------------------------------------------------------------

export interface CalculationConfig {
  engineVersion: string;
  swingLeft: number;
  swingRight: number;
  emaPeriods: readonly number[];
  rsiPeriod: number;
  atrPeriod: number;
  adxPeriod: number;
  minBarsPerTf: number;
  maxBarsPerTf: number;
  breakBasis: 'close';
  pricePrecision: 'exact-decimal-text-persisted-float64-calculated';
  indicatorConventions: {
    ema: string;
    rsi: string;
    atr: string;
    adx: string;
  };
}

// ---------------------------------------------------------------------------
// Versioned output contract (spec §7)
// ----------------------------------------------------------------------------

export interface TimeframeAnalysis {
  timeframe: Timeframe;
  candleCount: number;
  firstCandleTimeUtc: string;
  lastCandleTimeUtc: string;
  source: string;
  structure: StructureResult;
  indicators: {
    ema20: IndicatorSeriesSnapshot | null;
    ema50: IndicatorSeriesSnapshot | null;
    ema200: IndicatorSeriesSnapshot | null;
    rsi14: IndicatorSeriesSnapshot | null;
    atr14: IndicatorSeriesSnapshot | null;
    adx14: IndicatorSeriesSnapshot | null;
  };
  indicatorIssues: string[]; // e.g. 'INSUFFICIENT_DATA:EMA200'
  warnings: string[];
}

export interface TimeframeContext {
  trendByTimeframe: Record<string, StructuralTrend>;
  alignment: 'aligned-bullish' | 'aligned-bearish' | 'mixed' | 'unclear';
  note: string;
  disclaimer: 'descriptive-only-not-a-signal';
}

export interface AnalysisResult {
  status: AnalysisStatus;
  purpose: 'deterministic-technical-analysis-not-a-signal';
  engineVersion: string;
  symbol: string;
  timeframes: Timeframe[];
  generatedAtUtc: string;
  inputData: {
    perTimeframe: Record<
      string,
      {
        closedCandles: number;
        firstCandleTimeUtc: string | null;
        lastCandleTimeUtc: string | null;
        source: string | null;
        formingExcluded: number;
        invalidExcluded: number;
      }
    >;
    digits: number | null;
  };
  inputFingerprint: string | null; // sha256 over canonical input+config+engineVersion
  readiness: TimeframeReadinessEntry[];
  /** Present only when status = COMPLETED. Never fabricated on BLOCKED. */
  perTimeframe?: Record<string, TimeframeAnalysis>;
  timeframeContext?: TimeframeContext;
  warnings: string[];
  reasonCodes: string[];
  calculationConfig: CalculationConfig;
  /** Present only when status = FAILED — safe, bounded, no stack traces. */
  failureMessage?: string;
}

/** Aggregate payload the API layer returns (run id + persisted row info). */
export interface AnalysisRunPayload {
  ok: true;
  run: {
    id: string;
    status: AnalysisRunStatus;
    persistedAtUtc: string;
    durationMs: number;
  };
  analysis: AnalysisResult;
}
