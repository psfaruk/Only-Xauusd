/**
 * XAUUSD AI Trading Agent — SCALPER Strategy Types (Phase 12, Task 32)
 * ----------------------------------------------------------------------------
 * The user-requested SHORT-TIMEFRAME scalping strategy:
 *
 *   "উচ্চ টাইম ফ্রেম এ ট্রেড করি না … 1 মিনিট, 5 মিনিট 15 মিনিট এই তিনটি
 *    থেকে যে কোনো একটি agree হলেই যেনো সিগন্যাল আসে … প্রতি ঘণ্টায় 5
 *    থেকে 7 টি সিগন্যাল"
 *
 *   → M1 / M5 / M15 evaluated INDEPENDENTLY (OR-logic: ANY ONE timeframe
 *     agreeing is enough — NO higher-timeframe gates), tuned for a target
 *     cadence of 5–7 setups per hour.
 *
 * The engine core is PURE and DETERMINISTIC (same contract as the baseline):
 * closed candles only, explicit evaluation instant, no look-ahead, fail-closed
 * data gates. Suppression (cooldown / same-bar dedup) is applied by the
 * service through the pure `suppressSetup` helper so the core itself never
 * reads the clock or the database twice.
 */

import type { Timeframe } from '@/lib/market/types';
import type { SmcAgentParams, SmcTfSummary } from '../ict/types';
import type { SignalEvaluation, SignalLevels, SignalReasonCode, SignalWindow } from '../types';

export const SCALPER_ENGINE_VERSION = '14.0.0';
export const SCALPER_STRATEGY_ID = 'scalper-m1-m5-m15-or';
export const SCALPER_STRATEGY_VERSION = `${SCALPER_STRATEGY_ID}/${SCALPER_ENGINE_VERSION}`;

/** The three fast timeframes, in EVALUATION PRIORITY order (M15 → M5 → M1). */
export const SCALPER_TIMEFRAMES = ['M15', 'M5', 'M1'] as const;
export type ScalperTf = (typeof SCALPER_TIMEFRAMES)[number];

/** Reason codes unique to the scalper strategy (added to the shared union). */
export type ScalperReasonCode =
  | 'SCALPER_NO_AGREE'
  | 'SCALPER_COOLDOWN'
  | 'SCALPER_DUPLICATE_SETUP'
  | 'SCALPER_LEVELS_INVALID'
  | 'SCALPER_SPREAD_TOO_WIDE'
  | 'SCALPER_SL_TOO_TIGHT'
  | 'SCALPER_HTF_OPPOSED'
  | 'SCALPER_POST_LOSS_COOLDOWN'
  | 'INSUFFICIENT_M1_HISTORY'
  | 'INSUFFICIENT_M5_HISTORY'
  | 'INSUFFICIENT_M15_HISTORY';

/** Phase 14 — the ICT/SMC ten-agent confluence layer (SMC_CONFLUENCE model). */
export interface ScalperSmcRules {
  /** Master switch — when off the legacy models judge alone. */
  enabled: boolean;
  /** News-blackout veto master switch. */
  newsBlackoutEnabled: boolean;
  /** All agent parameters (locked, fingerprinted with every evaluation). */
  params: SmcAgentParams;
  /** Indicator periods shared with the agents (EMA/RSI/ATR). */
  indicatorPeriods: {
    emaFastPeriod: number;
    emaSlowPeriod: number;
    rsiPeriod: number;
    atrPeriod: number;
  };
}

/** Task 36 — higher-timeframe trend intelligence (reverse-vs-continue brain).
 *  The empirical driver: three consecutive auto-trades (2025-10-21) fought a
 *  ~10-point H1 uptrend because M1/M5 judged in isolation. */
export interface ScalperHtfRules {
  /** Master switch — when off the OR-logic of Phase 12 is fully restored. */
  enabled: boolean;
  /** EMA periods for the H1/H4 trend read. */
  emaFastPeriod: number;
  emaSlowPeriod: number;
  /** Minimum closed H1/H4 bars for a trend read (below → null, no veto). */
  minBars: number;
  /** Counter-trend SMC setups still pass at/above this score (tier-A exception). */
  counterTrendMinScore: number;
}

/** Documented, configurable scalper rules (persisted with every evaluation). */
export interface ScalperRules {
  strategyVersion: string;
  /** Evaluation timeframes (OR-logic, priority order). */
  timeframes: readonly ScalperTf[];
  /** Closed candles loaded per timeframe. */
  windowBars: number;
  /** Minimum closed bars per TF (indicator warm-up: EMA21+RSI14+ATR14). */
  minBarsPerTf: number;
  /** Fast/slow EMA periods for the momentum model. */
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  atrPeriod: number;
  /** Momentum model RSI acceptance band (BUY side; SELL mirrors). */
  momentumRsiMin: number;
  momentumRsiMax: number;
  /** Reversal model RSI extremes. */
  reversalRsiOversold: number;
  reversalRsiOverbought: number;
  /** SL distance beyond the decision close, in ATR multiples (source TF). */
  slAtrMult: number;
  /** Fixed reward/risk multiple. */
  rewardRisk: number;
  /** Maximum accepted spread in PRICE units. */
  maxSpreadPrice: number;
  /** Minimum SL distance in PRICE units (below this the setup is skipped —
   *  a stop tighter than the spread is not tradable). */
  minStopPrice: number;
  /** Emission cooldown: seconds after an emitted setup before the next one. */
  cooldownSec: number;
  /** Setup expiry per source timeframe, in seconds after the decision close. */
  expirySec: Record<ScalperTf, number>;
  /** Task 36 — anti-chase guard: the momentum model needs the decision close
   *  within this many ATR of the fast EMA (pullback entries, not tops). 0 = off. */
  maxExtensionAtr: number;
  /** Task 36 — post-loss circuit breaker (seconds, service-level). 0 = off. */
  postLossCooldownSec: number;
  /** Task 36 — higher-timeframe trend intelligence. */
  htf: ScalperHtfRules;
  /** Phase 14 — the ICT/SMC confluence layer (SMC_CONFLUENCE model). */
  smc: ScalperSmcRules;
}

/** One timeframe's independent judgement (persisted in the evidence block). */
export interface ScalperTfJudgement {
  timeframe: ScalperTf;
  /** Agreeing direction, or null when this TF does not agree. */
  agree: 'BUY' | 'SELL' | null;
  /** Which model produced the agreement (null when no agreement). */
  model: 'MOMENTUM' | 'REVERSAL' | 'SMC_CONFLUENCE' | null;
  /** Per-TF honest stage code (always present — UI renders all three TFs). */
  stage: 'SMC_BUY' | 'SMC_SELL' | 'MOMENTUM_BUY' | 'MOMENTUM_SELL' | 'REVERSAL_BUY' | 'REVERSAL_SELL' | 'NO_AGREE';
  decisionCandleTimeUtc: string;
  indicators: {
    emaFast: number | null;
    emaSlow: number | null;
    rsi: number | null;
    atr: number | null;
    close: number | null;
  };
  /** Phase 14 — this TF's SMC confluence chip (always present when the SMC
   *  layer is enabled, agree or not — the UI renders score/tier per TF). */
  smc?: SmcTfSummary;
}

/** Pure input for the scalper evaluation core. */
export interface ScalperCoreInput {
  symbol: string;
  digits: number | null;
  m15: SignalWindow;
  m5: SignalWindow;
  m1: SignalWindow;
  /** Task 36 — higher-timeframe context windows (H1/H4 closed candles). Used
   *  by the HTF trend gate (reverse-vs-continue intelligence). Empty windows
   *  are legal (trend reads become null — the veto then never fires). */
  h1: SignalWindow;
  h4: SignalWindow;
  /** Live mid price at the evaluation instant. */
  referencePrice: number;
  /** Spread in PRICE units (observed). */
  spreadPrice: number;
  /** Evaluation instant (UTC sec) — MUST be >= every window's last close. */
  nowUtcSec: number;
  rules: ScalperRules;
}

/** The scalper evaluation reuses the shared SignalEvaluation row shape so it
 *  persists into the SAME append-only SignalEvaluation table (own strategy
 *  version) and renders through the same history surfaces. */
export type ScalperEvaluation = SignalEvaluation;

/** Extra per-evaluation scalper evidence (optional block on SignalEvidence). */
export interface ScalperEvidenceBlock {
  /** The timeframe whose agreement produced the setup (null when suppressed
   *  or when no TF agreed). */
  sourceTimeframe: ScalperTf | null;
  model: 'MOMENTUM' | 'REVERSAL' | 'SMC_CONFLUENCE' | null;
  /** Suppressed direction when cooldown/dedup vetoed an agreeing setup. */
  suppressedDirection: 'BUY' | 'SELL' | null;
  /** All three independent judgements, priority order (M15 → M5 → M1). */
  tfJudgements: ScalperTfJudgement[];
  /** Task 36 — the H1/H4 trend read behind the reverse-vs-continue gate
   *  (nulls when the HTF layer is off or its data is insufficient). */
  htfTrend?: {
    h1: 'bullish' | 'bearish' | 'range' | null;
    h4: 'bullish' | 'bearish' | 'range' | null;
    /** True when an agreeing setup was vetoed for standing against an
     *  aligned H1+H4 trend (the reason the outcome is WAIT). */
    opposed: boolean;
  };
}

/** Derived levels for a scalper setup (same validated shape as baseline). */
export type ScalperLevels = SignalLevels;

export interface ScalperSuppressionState {
  /** True when an emitted setup with this fingerprint already exists. */
  duplicate: boolean;
  /** True when nowUtcSec < the active cooldown instant. */
  cooldownActive: boolean;
}

export interface ScalperServiceOutcome {
  runId: string | null;
  outcome: ScalperEvaluation['outcome'];
  durationMs: number;
  evaluation: ScalperEvaluation;
  quoteReport: unknown | null;
  /** Present when a setup was auto-executed (order attempted). */
  execution?: {
    attempted: boolean;
    code: string;
    message: string;
    lots: number | null;
    executionLogId: string | null;
  } | null;
}
