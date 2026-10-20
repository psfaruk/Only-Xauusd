/**
 * XAUUSD AI Trading Agent — Signal Domain Types (Phase 9, Task B)
 * ----------------------------------------------------------------------------
 * Typed outcome model for the DETERMINISTIC signal engine.
 *
 * RESEARCH SIGNALS ONLY — these outcomes must NEVER trigger a broker command.
 * No lot size, no order, no position management exists in this module or
 * anywhere in Phase 9.
 *
 * Outcome semantics (STRICTLY separated — never conflated):
 *   BUY_SETUP / SELL_SETUP — every gate AND every strategy condition passed;
 *                            complete, validated levels are attached.
 *   WAIT                   — inputs are VALID but the strategy does not (yet)
 *                            have a sufficiently strong setup (e.g. retest
 *                            pending, HTF context opposed, price beyond the
 *                            entry zone). The setup may become valid later.
 *   NO_SETUP               — inputs are VALID but the evaluated conditions do
 *                            not produce a setup at all (no current structure
 *                            break, zone invalidated, invalid level math).
 *   BLOCKED                — a required data/safety gate FAILED. No usable
 *                            entry/SL/TP information is emitted.
 *   FAILED                 — exceptional engine error (bounded, safe message).
 */

import type { AnalysisCandle, BreachEvent, StructuralTrend, SwingPoint } from '@/lib/analysis/types';
import type { Timeframe } from '@/lib/market/types';

export const SIGNAL_ENGINE_VERSION = '9.0.0';
export const SIGNAL_STRATEGY_ID = 'hybrid-structure-retest';
export const SIGNAL_STRATEGY_VERSION = `${SIGNAL_STRATEGY_ID}/9.0.0`;

export type SignalOutcome = 'BUY_SETUP' | 'SELL_SETUP' | 'WAIT' | 'BLOCKED' | 'NO_SETUP' | 'FAILED';

/** Machine-readable reason codes (typed, stable). */
export type SignalReasonCode =
  // Phase 14 ICT/SMC confluence codes (smc-confluence model) — emitted by the
  // ten-agent confluence engine alongside the shared gate codes above.
  | 'SMC_NO_CONFLUENCE'
  | 'SMC_BELOW_TIER'
  | 'SMC_NEWS_BLACKOUT'
  | 'SMC_NEUTRAL_MARGIN'
  | 'SMC_LEVELS_INVALID'
  | 'SMC_SL_TOO_TIGHT'
  | 'SMC_TP_TOO_CLOSE'
  | 'SMC_NO_POI'
  | 'SMC_NO_SWEEP'
  | 'SMC_PRICE_BEYOND_POI'
  | 'SMC_POI_VIOLATED'
  | 'SMC_SR_WALL'
  | 'SMC_MOMENTUM_OPPOSED'
  // Phase 12 scalper codes (scalper-m1-m5-m15-or) — the short-timeframe
  // OR-logic strategy emits these alongside the shared gate codes above.
  | 'SCALPER_NO_AGREE'
  | 'SCALPER_COOLDOWN'
  | 'SCALPER_DUPLICATE_SETUP'
  | 'SCALPER_LEVELS_INVALID'
  | 'SCALPER_SPREAD_TOO_WIDE'
  | 'SCALPER_SL_TOO_TIGHT'
  | 'INSUFFICIENT_M1_HISTORY'
  | 'INSUFFICIENT_M5_HISTORY'
  | 'INSUFFICIENT_M15_HISTORY'
  // Gate codes (BLOCKED family)
  | 'SYMBOL_NOT_ALLOWED'
  | 'SPEC_MISSING'
  | 'SOURCE_NOT_BROKER'
  | 'SOURCE_DEMO'
  | 'NOT_AUTHENTICATED'
  | 'QUOTE_STALE'
  | 'QUOTE_UNAVAILABLE'
  | 'TICK_STALE'
  | 'TICK_INVALID'
  | 'SPREAD_INVALID'
  | 'DATA_MISSING'
  | 'DATA_INVALID'
  | 'DATA_STALE'
  | 'INSUFFICIENT_DATA'
  | 'INSUFFICIENT_H1_HISTORY'
  | 'INSUFFICIENT_H4_HISTORY'
  | 'CHRONOLOGY_BROKEN'
  | 'FORMING_CANDLE_IN_INPUT'
  | 'INDICATOR_WARMUP'
  | 'GAP_IN_WINDOW'
  | 'SIGNAL_ERROR'
  // Strategy codes (WAIT / NO_SETUP family)
  | 'NO_STRUCTURE_BREAK'
  | 'STRUCTURE_BREAK_TOO_OLD'
  | 'ZONE_INVALIDATED'
  | 'AT_ZONE_BOUNDARY'
  | 'RETEST_PENDING'
  | 'HTF_H1_OPPOSITE'
  | 'HTF_H4_OPPOSITE'
  | 'EMA_TREND_OPPOSITE'
  | 'RSI_OUT_OF_RANGE'
  | 'ADX_BELOW_MIN'
  | 'SPREAD_TOO_WIDE'
  | 'PRICE_BEYOND_ENTRY_ZONE'
  | 'NO_ANCHOR_SWING'
  | 'LEVEL_CALC_INVALID';

/** Documented, configurable strategy rules (persisted with every evaluation). */
export interface StrategyRules {
  strategyVersion: string;
  executionTf: Timeframe;
  contextTfs: readonly Timeframe[];
  /** Rolling closed-candle window per timeframe. */
  windowBars: number;
  /** Minimum closed bars on the execution TF (covers EMA200 + ADX warm-up). */
  minExecutionBars: number;
  minH1Bars: number;
  minH4Bars: number;
  /** Swing detection window (Phase 4 semantics). */
  swingLeft: number;
  swingRight: number;
  /** Max bars between the confirmed break and the decision bar. */
  maxBarsSinceBreak: number;
  /** Entry zone width beyond the broken level, in ATR multiples. */
  zoneWidthAtr: number;
  /** Live-price proximity tolerance for the entry zone, in ATR multiples. */
  entryToleranceAtr: number;
  /** SL buffer beyond the anchor swing, in ATR multiples. */
  slAtrBuffer: number;
  /** Fixed reward/risk multiple defining the target. */
  rewardRisk: number;
  /** Minimum ADX(14) on the execution TF. */
  minAdx: number;
  /** RSI(14) acceptance band for BUY (SELL uses the mirrored band). */
  rsiBuyMin: number;
  rsiBuyMax: number;
  /** Maximum accepted spread in PRICE units. */
  maxSpreadPrice: number;
  /** Setup expiry in execution-TF bars after the decision candle. */
  expiryBars: number;
  /** Indicator periods (Phase 4 conventions — locked). */
  emaPeriod: number;
  rsiPeriod: number;
  atrPeriod: number;
  adxPeriod: number;
}

/** One closed-candle window (ascending, closed bars only). */
export interface SignalWindow {
  timeframe: Timeframe;
  candles: AnalysisCandle[];
  source: string | null;
}

/** Pure input for the evaluation core (live service and backtest both use it). */
export interface SignalCoreInput {
  symbol: string;
  digits: number | null;
  execution: SignalWindow; // M15 (execution TF)
  h1: SignalWindow;
  h4: SignalWindow;
  /** Reference price for entry-zone proximity + level anchoring.
   *  LIVE: current mid. BACKTEST: the decision bar's close. */
  referencePrice: number;
  /** Spread in PRICE units. LIVE: observed. BACKTEST: configured assumption. */
  spreadPrice: number;
  /** Evaluation instant (UTC sec) — MUST be >= the decision bar's close. */
  nowUtcSec: number;
  rules: StrategyRules;
}

/** Validated levels — attached ONLY to setup outcomes. */
export interface SignalLevels {
  direction: 'BUY' | 'SELL';
  entryZoneLow: number;
  entryZoneHigh: number;
  entryReference: number; // spread-adjusted reference entry (ask-side for BUY)
  stopLoss: number;
  target: number;
  riskPrice: number;
  rewardPrice: number;
  rewardRiskRatio: number;
  entryZoneLowText: string;
  entryZoneHighText: string;
  stopLossText: string;
  targetText: string;
  entryReferenceText: string;
}

/** Deterministic evidence behind the evaluation (persisted). */
export interface SignalEvidence {
  structureEvent: {
    type: BreachEvent['type'];
    direction: 'bullish' | 'bearish';
    level: number;
    levelText: string;
    breakCandleTimeUtc: string;
    barsSinceBreak: number;
  } | null;
  anchorSwing: {
    kind: 'high' | 'low';
    price: number;
    priceText: string;
    swingTimeUtc: string;
    confirmedAtUtc: string;
  } | null;
  indicators: {
    ema50: number | null;
    rsi14: number | null;
    atr14: number | null;
    adx14: number | null;
  };
  htfContext: {
    h1Trend: StructuralTrend | null;
    h4Trend: StructuralTrend | null;
  };
  decisionClose: number | null;
  retestBarTimeUtc: string | null;
  executionWindow: { fromUtc: string; toUtc: string; bars: number };
  h1Window: { fromUtc: string; toUtc: string; bars: number };
  h4Window: { fromUtc: string; toUtc: string; bars: number };
  /** Phase 12 scalper evidence — present only on scalper-strategy rows
   *  (source timeframe, model, per-TF judgements). Optional + additive:
   *  baseline and candidate rows never carry it. */
  scalper?: import('./scalper/types').ScalperEvidenceBlock;
  /** Phase 14 ICT/SMC confluence evidence — full ten-agent breakdown of the
   *  SOURCE timeframe's reads (or the best-scoring TF when nothing agreed).
   *  Optional + additive; old rows never carry it. */
  smc?: import('./ict/types').SmcConfluenceEvidence;
}

export interface SignalEvaluation {
  engineVersion: string;
  strategyVersion: string;
  symbol: string;
  /** Baseline/candidate rows are research signals; scalper rows (Phase 12)
   *  are live trading instructions driven to the auto-execution pipeline. */
  purpose: 'research-signal-not-an-execution-instruction' | 'live-signal-auto-execution';
  outcome: SignalOutcome;
  reasonCodes: SignalReasonCode[];
  decisionCandleTimeUtc: string | null;
  setupKnownAtUtc: string | null;
  expiryUtc: string | null;
  /** Present ONLY for BUY_SETUP / SELL_SETUP. */
  levels: SignalLevels | null;
  /** Present for every non-FAILED outcome (never fabricated). */
  evidence: SignalEvidence | null;
  inputFingerprint: string;
  datasetFingerprint: string | null;
  generatedAtUtc: string;
  failureMessage?: string;
}

// Re-exported for convenience (single import surface for consumers).
export type { AnalysisCandle, BreachEvent, StructuralTrend, SwingPoint };
