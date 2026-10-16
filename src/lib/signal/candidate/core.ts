/**
 * XAUUSD AI Trading Agent — CANDIDATE Evaluation Core (Phase 11)
 * ----------------------------------------------------------------------------
 * OFFLINE RESEARCH CODE — hybrid-multimodel-research/11.0.0-candidate.1.
 * NOT wired into the live service, the scheduler, persistence, or paper
 * tracking (activation: audit/phase11-candidate-forward-protocol.md).
 *
 * PURE and DETERMINISTIC — same guarantees as the baseline core:
 *   · Only CLOSED candles enter (M5 bars must close by the DECISION close).
 *   · Swings/structure/indicators use the SAME Phase 4 primitives as the
 *     baseline (detectSwings / scanStructureEvents / emaSeries / rsiSeries /
 *     atrSeries / adxSeries / causalTrendAt) — zero reimplementation drift.
 *   · Model A IS the baseline: evaluateCandidate calls the UNMODIFIED
 *     evaluateSignal for Model A, so on identical data Model A's outcome is
 *     provably identical to the baseline's (pinned by test).
 *   · Fail-closed: shared data-gate BLOCKED propagates to the whole candidate
 *     evaluation; models B/C are never evaluated behind a data gate.
 *   · Levels exist ONLY on setup outcomes (shared deriveLevels — strict
 *     ordering, risk > 0, fixed 2R target, spread-adjusted entry).
 *
 * Precedence A > B > C; same-direction losers recorded in suppressedModels;
 * ANY cross-direction disagreement → WAIT [MODEL_CONFLICT]; never a mixed
 * signal, never a probability/confidence score, never an order.
 */

import { createHash } from 'node:crypto';
import { TIMEFRAME_SECONDS } from '@/lib/market/types';
import { detectSwings } from '@/lib/analysis/swings';
import { causalTrendAt, deriveLevels, evaluateSignal } from '@/lib/signal/core';
import { adxSeries, atrSeries, emaSeries, rsiSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle, SignalLevels, SignalOutcome, SignalReasonCode, SignalWindow, StrategyRules } from '@/lib/signal/types';
import {
  CANDIDATE_RULES,
  CANDIDATE_STRATEGY_VERSION,
  NO_SETUP_CLASS_CODES,
  WAIT_CLASS_CODES,
  type CandidateEvaluation,
  type CandidateInput,
  type CandidateLevels,
  type CandidateModelSetup,
  type CandidateReasonCode,
  type CombinedModels,
  type ModelAResult,
  type ModelBResult,
  type ModelCResult,
} from './types';
import { computeCandidateSetupFingerprint } from './identity';

const EXEC_TF_SEC = TIMEFRAME_SECONDS.M15;
const M5_TF_SEC = TIMEFRAME_SECONDS.M5;

// ---------------------------------------------------------------------------
// Candidate input fingerprint (namespaced by the candidate version)
// ---------------------------------------------------------------------------

export function computeCandidateFingerprint(input: CandidateInput): string {
  const win = (w: SignalWindow) => ({
    tf: w.timeframe,
    source: w.source,
    candles: w.candles.map((c) => [c.timeUtcSec, c.openText, c.highText, c.lowText, c.closeText]),
  });
  const payload = {
    candidateVersion: CANDIDATE_STRATEGY_VERSION,
    symbol: input.symbol,
    digits: input.digits,
    referencePrice: input.referencePrice,
    spreadPrice: input.spreadPrice,
    nowUtcSec: input.nowUtcSec,
    rules: input.rules,
    candidateRules: CANDIDATE_RULES,
    execution: win(input.execution),
    h1: win(input.h1),
    h4: win(input.h4),
    m5: win(input.m5),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for exact-boundary tests)
// ---------------------------------------------------------------------------

export interface PullbackStateArgs {
  candles: AnalysisCandle[];
  emaValues: Array<number | null>;
  atrValues: Array<number | null>;
  decisionIdx: number;
  lookback: number;
  zoneAtr: number;
  maxDepthAtr: number;
  direction: 'BUY' | 'SELL';
}

export interface PullbackStateResult {
  state: 'touch' | 'no_touch' | 'too_deep';
  /** The extreme bar of the pullback (lowest low for BUY / highest high for SELL). */
  extremeBarTimeSec: number | null;
  extremePrice: number | null;
}

/**
 * Model B pullback state over the lookback window (values at bar i are the
 * CAUSAL EMA/ATR at that bar). Depth is checked FIRST (a too-deep close kills
 * the pullback regardless of touches). Touch: BUY low ≤ ema + zone×atr
 * (inclusive); depth: BUY close < ema − depth×atr (strict).
 */
export function pullbackState(args: PullbackStateArgs): PullbackStateResult {
  const from = Math.max(0, args.decisionIdx - args.lookback + 1);
  let extremePrice: number | null = null;
  let extremeBarTimeSec: number | null = null;

  for (let i = from; i <= args.decisionIdx; i++) {
    const ema = args.emaValues[i];
    const atr = args.atrValues[i];
    if (ema === null || atr === null || atr <= 0) continue;
    const bar = args.candles[i];
    // extreme tracking (BUY: lowest low; SELL: highest high) — earliest bar wins ties
    if (extremePrice === null ||
      (args.direction === 'BUY' ? bar.low < extremePrice : bar.high > extremePrice)) {
      extremePrice = args.direction === 'BUY' ? bar.low : bar.high;
      extremeBarTimeSec = bar.timeUtcSec;
    }
  }

  for (let i = from; i <= args.decisionIdx; i++) {
    const ema = args.emaValues[i];
    const atr = args.atrValues[i];
    if (ema === null || atr === null || atr <= 0) continue;
    const bar = args.candles[i];
    const deep = args.direction === 'BUY'
      ? bar.close < ema - args.maxDepthAtr * atr
      : bar.close > ema + args.maxDepthAtr * atr;
    if (deep) return { state: 'too_deep', extremeBarTimeSec, extremePrice };
  }

  for (let i = from; i <= args.decisionIdx; i++) {
    const ema = args.emaValues[i];
    const atr = args.atrValues[i];
    if (ema === null || atr === null || atr <= 0) continue;
    const bar = args.candles[i];
    const touched = args.direction === 'BUY'
      ? bar.low <= ema + args.zoneAtr * atr
      : bar.high >= ema - args.zoneAtr * atr;
    if (touched) return { state: 'touch', extremeBarTimeSec, extremePrice };
  }

  return { state: 'no_touch', extremeBarTimeSec, extremePrice };
}

export interface M5ConfirmArgs {
  m5Candles: AnalysisCandle[];
  direction: 'BUY' | 'SELL';
  asOfSec: number;
}

/**
 * Closed-candle M5 confirmation: the LAST M5 bar CLOSED by asOf (forming bars
 * are excluded) must close in the setup direction (body + higher close than
 * the previous closed M5 bar). Requires ≥ 2 usable bars — fewer is an honest
 * non-confirmation (fail-closed), never a guess.
 */
export function m5Confirmed(args: M5ConfirmArgs): boolean {
  const usable = args.m5Candles.filter((c) => c.timeUtcSec + M5_TF_SEC <= args.asOfSec);
  if (usable.length < 2) return false;
  const last = usable[usable.length - 1];
  const prev = usable[usable.length - 2];
  if (args.direction === 'BUY') {
    return last.close > last.open && last.close > prev.close;
  }
  return last.close < last.open && last.close < prev.close;
}

export interface RangeStateArgs {
  swings: Array<{ kind: 'high' | 'low'; index: number; price: number }>;
  decisionIdx: number;
  swingRight: number;
  atr: number;
  lookback: number;
  bandAtr: number;
  minHeightAtr: number;
  maxHeightAtr: number;
}

export type RangeStateResult = { ok: true; top: number; bottom: number } | { ok: false };

/**
 * Model C range detection: the two most recent CONFIRMED swing highs must sit
 * within bandAtr×ATR of each other (same for lows), their confirmation inside
 * the lookback window; top = min(two highs), bottom = max(two lows); height
 * must be within [minHeightAtr, maxHeightAtr] × ATR (all inclusive).
 */
export function rangeState(args: RangeStateArgs): RangeStateResult {
  const confirmFrom = args.decisionIdx - args.lookback + 1;
  const highs: Array<{ index: number; price: number }> = [];
  const lows: Array<{ index: number; price: number }> = [];
  for (const s of args.swings) {
    const confirmIdx = s.index + args.swingRight;
    if (confirmIdx > args.decisionIdx || confirmIdx < confirmFrom) continue;
    if (s.kind === 'high') highs.push({ index: s.index, price: s.price });
    else lows.push({ index: s.index, price: s.price });
  }
  if (highs.length < 2 || lows.length < 2) return { ok: false };
  // chronological order → last two by index
  highs.sort((a, b) => a.index - b.index);
  lows.sort((a, b) => a.index - b.index);
  const h1 = highs[highs.length - 2];
  const h2 = highs[highs.length - 1];
  const l1 = lows[lows.length - 2];
  const l2 = lows[lows.length - 1];
  const band = args.bandAtr * args.atr;
  if (Math.abs(h1.price - h2.price) > band) return { ok: false };
  if (Math.abs(l1.price - l2.price) > band) return { ok: false };
  const top = Math.min(h1.price, h2.price);
  const bottom = Math.max(l1.price, l2.price);
  const height = top - bottom;
  if (height < args.minHeightAtr * args.atr) return { ok: false };
  if (height > args.maxHeightAtr * args.atr) return { ok: false };
  return { ok: true, top, bottom };
}

export interface SweepStateArgs {
  candles: AnalysisCandle[];
  decisionIdx: number;
  lookback: number;
  /** The swept boundary: range bottom for BUY, range top for SELL. */
  boundary: number;
  atr: number;
  minBeyondAtr: number;
  direction: 'BUY' | 'SELL';
}

export interface SweepStateResult {
  swept: boolean;
  /** The most extreme sweep price (lowest low for BUY / highest high for SELL). */
  extreme: number | null;
  extremeBarTimeSec: number | null;
}

/**
 * Model C sweep: a bar within the lookback took out the boundary by at least
 * minBeyondAtr×ATR (STRICTLY beyond — a touch exactly at the threshold is not
 * a sweep). Extreme = the most extreme sweep price; earliest bar wins ties.
 */
export function sweepState(args: SweepStateArgs): SweepStateResult {
  const from = Math.max(0, args.decisionIdx - args.lookback + 1);
  const threshold = args.direction === 'BUY'
    ? args.boundary - args.minBeyondAtr * args.atr
    : args.boundary + args.minBeyondAtr * args.atr;
  let extreme: number | null = null;
  let extremeBarTimeSec: number | null = null;
  for (let i = from; i <= args.decisionIdx; i++) {
    const bar = args.candles[i];
    const beyond = args.direction === 'BUY' ? bar.low < threshold : bar.high > threshold;
    if (!beyond) continue;
    const price = args.direction === 'BUY' ? bar.low : bar.high;
    if (extreme === null || (args.direction === 'BUY' ? price < extreme : price > extreme)) {
      extreme = price;
      extremeBarTimeSec = bar.timeUtcSec;
    }
  }
  return { swept: extreme !== null, extreme, extremeBarTimeSec };
}

// ---------------------------------------------------------------------------
// Shared context computation (same primitives as the baseline)
// ---------------------------------------------------------------------------

interface ExecContext {
  decisionIdx: number;
  decision: AnalysisCandle;
  decisionCloseSec: number;
  emaValues: Array<number | null>;
  atrValues: Array<number | null>;
  rsiValue: number;
  adxValue: number;
  emaValue: number;
  atrValue: number;
  swings: ReturnType<typeof detectSwings>['swings'];
  h1Trend: ReturnType<typeof causalTrendAt>;
  h4Trend: ReturnType<typeof causalTrendAt>;
}

function execContext(input: CandidateInput, rules: StrategyRules): ExecContext | { error: CandidateReasonCode } {
  const exec = input.execution.candles;
  if (!exec.length) return { error: 'INSUFFICIENT_DATA' };
  const decisionIdx = exec.length - 1;
  const decision = exec[decisionIdx];
  const decisionCloseSec = decision.timeUtcSec + EXEC_TF_SEC;
  const closes = exec.map((c) => c.close);
  const ema = emaSeries(closes, rules.emaPeriod);
  const rsi = rsiSeries(closes, rules.rsiPeriod);
  const atr = atrSeries(exec, rules.atrPeriod);
  const adx = adxSeries(exec, rules.adxPeriod);
  if (!ema.ok || !rsi.ok || !atr.ok || !adx.ok) return { error: 'INDICATOR_WARMUP' };
  const emaValues = ema.series.values;
  const atrValues = atr.series.values;
  const emaValue = emaValues[decisionIdx];
  const atrValue = atrValues[decisionIdx];
  const rsiValue = rsi.series.values[decisionIdx];
  const adxValue = adx.series.values[decisionIdx];
  if (
    emaValue === null || atrValue === null || rsiValue === null || adxValue === null ||
    !Number.isFinite(emaValue) || !Number.isFinite(atrValue) || !Number.isFinite(rsiValue) || !Number.isFinite(adxValue) ||
    atrValue <= 0
  ) {
    return { error: 'INDICATOR_WARMUP' };
  }
  const swingDet = detectSwings(exec, {
    left: rules.swingLeft,
    right: rules.swingRight,
    tfSec: EXEC_TF_SEC,
    digits: input.digits,
  });
  const h1Trend = causalTrendAt(input.h1, rules.swingLeft, rules.swingRight, decisionCloseSec);
  const h4Trend = causalTrendAt(input.h4, rules.swingLeft, rules.swingRight, decisionCloseSec);
  return { decisionIdx, decision, decisionCloseSec, emaValues, atrValues, rsiValue, adxValue, emaValue, atrValue, swings: swingDet.swings, h1Trend, h4Trend };
}

/** Baseline anchor-swing search (identical to core.ts S11). */
function findAnchorSwing(
  swings: ExecContext['swings'],
  decisionIdx: number,
  swingRight: number,
  wantKind: 'low' | 'high',
): { kind: 'high' | 'low'; price: number } | null {
  for (let k = swings.length - 1; k >= 0; k--) {
    const s = swings[k];
    if (s.kind === wantKind && s.index + swingRight <= decisionIdx) {
      return { kind: s.kind, price: s.price };
    }
  }
  return null;
}

function withInvalidation(levels: SignalLevels, invalidationLevel: number): CandidateLevels {
  return { ...levels, invalidationLevel };
}

// ---------------------------------------------------------------------------
// Model B — trend-continuation pullback (spec §1.B)
// ---------------------------------------------------------------------------

export function evaluateModelB(input: CandidateInput): ModelBResult {
  const rules = input.rules;
  const ctx = execContext(input, rules);
  if ('error' in ctx) return { setup: null, stage: ctx.error };

  // 1. H4 AND H1 both aligned with the trade direction (stricter than baseline S6)
  let direction: 'BUY' | 'SELL' | null = null;
  if (ctx.h1Trend === 'bullish' && ctx.h4Trend === 'bullish') direction = 'BUY';
  else if (ctx.h1Trend === 'bearish' && ctx.h4Trend === 'bearish') direction = 'SELL';
  if (!direction) return { setup: null, stage: 'PULLBACK_CONTEXT_NOT_ALIGNED' };
  const isBuy = direction === 'BUY';

  // 2. M15 close on the EMA50 trend side (same convention as baseline S7)
  if (isBuy ? !(ctx.decision.close > ctx.emaValue) : !(ctx.decision.close < ctx.emaValue)) {
    return { setup: null, stage: 'EMA_TREND_OPPOSITE' };
  }

  // 3. Pullback into the EMA50 band within the lookback (depth kills first)
  const pb = pullbackState({
    candles: input.execution.candles,
    emaValues: ctx.emaValues,
    atrValues: ctx.atrValues,
    decisionIdx: ctx.decisionIdx,
    lookback: CANDIDATE_RULES.pullbackLookbackBars,
    zoneAtr: CANDIDATE_RULES.pullbackZoneAtr,
    maxDepthAtr: CANDIDATE_RULES.pullbackMaxDepthAtr,
    direction,
  });
  if (pb.state === 'too_deep') return { setup: null, stage: 'PULLBACK_TOO_DEEP' };
  if (pb.state === 'no_touch') return { setup: null, stage: 'PULLBACK_NO_TOUCH' };
  if (pb.extremeBarTimeSec === null) return { setup: null, stage: 'PULLBACK_NO_TOUCH' };

  // 4. RSI band — same values/semantics as baseline S8
  const rsiOk = isBuy
    ? ctx.rsiValue > rules.rsiBuyMin && ctx.rsiValue < rules.rsiBuyMax
    : ctx.rsiValue < 100 - rules.rsiBuyMin && ctx.rsiValue > 100 - rules.rsiBuyMax;
  if (!rsiOk) return { setup: null, stage: 'RSI_OUT_OF_RANGE' };

  // 5. ADX floor — trend-continuation model keeps the baseline floor (S9)
  if (ctx.adxValue < rules.minAdx) return { setup: null, stage: 'ADX_BELOW_MIN' };

  // 6. Shared spread gate (S5)
  if (input.spreadPrice > rules.maxSpreadPrice) return { setup: null, stage: 'SPREAD_TOO_WIDE' };

  // 7. Entry zone (the EMA band) + live-price proximity (same tolerance as S10)
  const zoneLow = ctx.emaValue - CANDIDATE_RULES.pullbackZoneAtr * ctx.atrValue;
  const zoneHigh = ctx.emaValue + CANDIDATE_RULES.pullbackZoneAtr * ctx.atrValue;
  const tol = rules.entryToleranceAtr * ctx.atrValue;
  const priceOk = input.referencePrice >= zoneLow - tol && input.referencePrice <= zoneHigh + tol;
  if (!priceOk) return { setup: null, stage: 'PRICE_BEYOND_ENTRY_ZONE' };

  // 8. M5 closed-candle confirmation — an EMA touch alone is NEVER a setup
  if (!m5Confirmed({ m5Candles: input.m5.candles, direction, asOfSec: ctx.decisionCloseSec })) {
    return { setup: null, stage: 'M5_CONFIRMATION_PENDING' };
  }

  // 9. Anchor swing (same search as baseline S11)
  const anchor = findAnchorSwing(ctx.swings, ctx.decisionIdx, rules.swingRight, isBuy ? 'low' : 'high');
  if (!anchor) return { setup: null, stage: 'NO_ANCHOR_SWING' };

  // 10. Levels via the SHARED pure helper (strict ordering or nothing)
  const derived = deriveLevels(
    direction,
    anchor.price,
    ctx.atrValue,
    input.referencePrice,
    input.spreadPrice / 2,
    zoneLow,
    zoneHigh,
    input.digits,
    rules,
  );
  if (!derived.ok || !derived.levels) return { setup: null, stage: derived.code ?? 'LEVEL_CALC_INVALID' };

  return {
    setup: {
      model: 'B',
      direction,
      levels: withInvalidation(derived.levels, isBuy ? zoneLow : zoneHigh),
      anchorKey: { kind: 'pullback', extremeBarTimeUtcSec: pb.extremeBarTimeSec },
    },
    stage: null,
  };
}

// ---------------------------------------------------------------------------
// Model C — range sweep & rejection (spec §1.C)
// ---------------------------------------------------------------------------

/** Stage ranking for the reported primary stage (higher = further along). */
const C_STAGE_RANK: Partial<Record<CandidateReasonCode, number>> = {
  RANGE_NOT_DETECTED: 0,
  HTF_H1_OPPOSITE: 1,
  HTF_H4_OPPOSITE: 1,
  RANGE_SWEEP_PENDING: 2,
  RANGE_RECLAIM_PENDING: 3,
  RSI_OUT_OF_RANGE: 4,
  SPREAD_TOO_WIDE: 4,
  PRICE_BEYOND_ENTRY_ZONE: 5,
  M5_CONFIRMATION_PENDING: 6,
  NO_ANCHOR_SWING: 7,
  LEVEL_CALC_INVALID: 7,
};

function evaluateModelCDirection(
  direction: 'BUY' | 'SELL',
  input: CandidateInput,
  ctx: ExecContext,
): { setup: CandidateModelSetup | null; stage: CandidateReasonCode | null } {
  const rules = input.rules;
  const isBuy = direction === 'BUY';

  // 1. Range detection (the model's precondition — before HTF, so a trendless
  //    market reports RANGE_NOT_DETECTED regardless of HTF state)
  const range = rangeState({
    swings: ctx.swings,
    decisionIdx: ctx.decisionIdx,
    swingRight: rules.swingRight,
    atr: ctx.atrValue,
    lookback: CANDIDATE_RULES.rangeLookbackBars,
    bandAtr: CANDIDATE_RULES.rangeBandAtr,
    minHeightAtr: CANDIDATE_RULES.rangeMinHeightAtr,
    maxHeightAtr: CANDIDATE_RULES.rangeMaxHeightAtr,
  });
  if (!range.ok) return { setup: null, stage: 'RANGE_NOT_DETECTED' };

  // 2. HTF filter — same semantics as baseline S6 (NOT opposite; unclear allowed)
  if (isBuy ? ctx.h1Trend === 'bearish' : ctx.h1Trend === 'bullish') return { setup: null, stage: 'HTF_H1_OPPOSITE' };
  if (isBuy ? ctx.h4Trend === 'bearish' : ctx.h4Trend === 'bullish') return { setup: null, stage: 'HTF_H4_OPPOSITE' };

  // 3. Sweep of the boundary (strictly beyond by minBeyondAtr×ATR)
  const sweep = sweepState({
    candles: input.execution.candles,
    decisionIdx: ctx.decisionIdx,
    lookback: CANDIDATE_RULES.sweepLookbackBars,
    boundary: isBuy ? range.bottom : range.top,
    atr: ctx.atrValue,
    minBeyondAtr: CANDIDATE_RULES.sweepMinBeyondAtr,
    direction,
  });
  if (!sweep.swept || sweep.extreme === null || sweep.extremeBarTimeSec === null) {
    return { setup: null, stage: 'RANGE_SWEEP_PENDING' };
  }

  // 4. Confirmed rejection — the decision close is back INSIDE the range
  const inside = ctx.decision.close > range.bottom && ctx.decision.close < range.top;
  if (!inside) return { setup: null, stage: 'RANGE_RECLAIM_PENDING' };

  // 5. Mean-reversion RSI rule (one-sided BY DESIGN for the range model:
  //    BUY rejects a downside sweep from a low-RSI state — a lower bound would
  //    contradict the model. Baseline band still governs Models A/B.)
  const rsiOk = isBuy ? ctx.rsiValue <= rules.rsiBuyMax : ctx.rsiValue >= 100 - rules.rsiBuyMax;
  if (!rsiOk) return { setup: null, stage: 'RSI_OUT_OF_RANGE' };

  // NOTE (documented per-model rule, NOT a removed global filter): Model C
  // applies NO ADX floor — ADX measures trend strength and a range model
  // gated on trend strength would be self-contradictory. The range detector
  // is the regime filter here.

  // 6. Shared spread gate
  if (input.spreadPrice > rules.maxSpreadPrice) return { setup: null, stage: 'SPREAD_TOO_WIDE' };

  // 7. Entry zone just inside the reclaimed boundary + live-price proximity
  const zoneWidth = rules.zoneWidthAtr * ctx.atrValue;
  const zoneLow = isBuy ? range.bottom : range.top - zoneWidth;
  const zoneHigh = isBuy ? range.bottom + zoneWidth : range.top;
  const tol = rules.entryToleranceAtr * ctx.atrValue;
  const priceOk = input.referencePrice >= zoneLow - tol && input.referencePrice <= zoneHigh + tol;
  if (!priceOk) return { setup: null, stage: 'PRICE_BEYOND_ENTRY_ZONE' };

  // 8. M5 closed-candle confirmation — a wick alone is NEVER a trade
  if (!m5Confirmed({ m5Candles: input.m5.candles, direction, asOfSec: ctx.decisionCloseSec })) {
    return { setup: null, stage: 'M5_CONFIRMATION_PENDING' };
  }

  // 9. SL anchored beyond the sweep extreme (shared deriveLevels)
  const derived = deriveLevels(
    direction,
    sweep.extreme,
    ctx.atrValue,
    input.referencePrice,
    input.spreadPrice / 2,
    zoneLow,
    zoneHigh,
    input.digits,
    rules,
  );
  if (!derived.ok || !derived.levels) return { setup: null, stage: derived.code ?? 'LEVEL_CALC_INVALID' };

  return {
    setup: {
      model: 'C',
      direction,
      levels: withInvalidation(derived.levels, isBuy ? range.bottom : range.top),
      anchorKey: {
        kind: 'sweep',
        extremeBarTimeUtcSec: sweep.extremeBarTimeSec,
        boundary: isBuy ? 'bottom' : 'top',
      },
    },
    stage: null,
  };
}

export function evaluateModelC(input: CandidateInput): ModelCResult {
  const rules = input.rules;
  const ctx = execContext(input, rules);
  if ('error' in ctx) {
    return { setups: [], stages: { BUY: ctx.error, SELL: ctx.error }, stage: ctx.error };
  }
  const buySide = evaluateModelCDirection('BUY', input, ctx);
  const sellSide = evaluateModelCDirection('SELL', input, ctx);
  const setups: ModelCResult['setups'] = [];
  if (buySide.setup) setups.push({ direction: 'BUY', setup: buySide.setup });
  if (sellSide.setup) setups.push({ direction: 'SELL', setup: sellSide.setup });
  const stages: ModelCResult['stages'] = { BUY: buySide.stage, SELL: sellSide.stage };
  // Primary stage = the furthest-along side (tie → BUY).
  let primary: CandidateReasonCode | null = null;
  let bestRank = -1;
  for (const dir of ['BUY', 'SELL'] as const) {
    const s = stages[dir];
    if (s === null) continue;
    const rank = C_STAGE_RANK[s] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      primary = s;
    }
  }
  return { setups, stages, stage: primary };
}

// ---------------------------------------------------------------------------
// Precedence, conflict, aggregation (pure — spec §3)
// ---------------------------------------------------------------------------

function extractModelASetup(evaluation: import('@/lib/signal/types').SignalEvaluation): CandidateModelSetup | null {
  if (evaluation.outcome !== 'BUY_SETUP' && evaluation.outcome !== 'SELL_SETUP') return null;
  const se = evaluation.evidence?.structureEvent;
  if (!se) return null;
  return {
    model: 'A',
    direction: evaluation.outcome === 'BUY_SETUP' ? 'BUY' : 'SELL',
    levels: evaluation.levels ? withInvalidation(evaluation.levels, se.level) : null,
    anchorKey: {
      kind: 'structure',
      type: se.type,
      direction: se.direction,
      level: se.level,
      breakCandleTimeUtc: se.breakCandleTimeUtc,
    },
  };
}

export function combineModels(a: ModelAResult, b: ModelBResult, c: ModelCResult): CombinedModels {
  const aEval = a.evaluation;

  // Shared data gates BLOCKED/FAILED → the whole candidate is BLOCKED/FAILED.
  if (aEval.outcome === 'BLOCKED' || aEval.outcome === 'FAILED') {
    return {
      outcome: aEval.outcome,
      reasonCodes: [...aEval.reasonCodes],
      model: null,
      direction: null,
      levels: null,
      setup: null,
      suppressedModels: [],
      conflict: false,
    };
  }

  const aSetup = extractModelASetup(aEval);
  // Model C internally conflicting (both directions valid) = models disagreeing.
  const cInternalConflict = c.setups.length >= 2;

  const emitted: Array<{ model: 'A' | 'B' | 'C'; direction: 'BUY' | 'SELL'; setup: CandidateModelSetup }> = [];
  if (aSetup) emitted.push({ model: 'A', direction: aSetup.direction, setup: aSetup });
  if (b.setup) emitted.push({ model: 'B', direction: b.setup.direction, setup: b.setup });
  for (const s of c.setups) emitted.push({ model: 'C', direction: s.direction, setup: s.setup });

  const directions = new Set(emitted.map((e) => e.direction));
  if (directions.size >= 2 || cInternalConflict) {
    return {
      outcome: 'WAIT',
      reasonCodes: ['MODEL_CONFLICT'],
      model: null,
      direction: null,
      levels: null,
      setup: null,
      suppressedModels: [],
      conflict: true,
    };
  }

  if (directions.size === 1) {
    const direction = [...directions][0] as 'BUY' | 'SELL';
    const same = emitted.filter((e) => e.direction === direction);
    const order: Record<'A' | 'B' | 'C', number> = { A: 0, B: 1, C: 2 };
    same.sort((x, y) => order[x.model] - order[y.model]);
    const winner = same[0];
    return {
      outcome: direction === 'BUY' ? 'BUY_SETUP' : 'SELL_SETUP',
      reasonCodes: [],
      model: winner.model,
      direction,
      levels: winner.setup.levels,
      setup: winner.setup,
      suppressedModels: same.slice(1).map((e) => e.model),
      conflict: false,
    };
  }

  // Nothing emitted → merge per-model stage codes (Model A first — primary).
  const codes: CandidateReasonCode[] = [];
  for (const code of aEval.reasonCodes) codes.push(code);
  if (!b.setup && b.stage) codes.push(b.stage);
  if (c.setups.length === 0 && c.stage) codes.push(c.stage);
  const merged = [...new Set(codes)];
  const anyWait = merged.some((code) => (WAIT_CLASS_CODES as readonly string[]).includes(code));
  return {
    outcome: anyWait ? 'WAIT' : 'NO_SETUP',
    reasonCodes: merged,
    model: null,
    direction: null,
    levels: null,
    setup: null,
    suppressedModels: [],
    conflict: false,
  };
}

// ---------------------------------------------------------------------------
// The candidate evaluation entry point
// ---------------------------------------------------------------------------

export function evaluateCandidate(input: CandidateInput): CandidateEvaluation {
  const fingerprint = computeCandidateFingerprint(input);
  const iso = (sec: number) => new Date(sec * 1000).toISOString();

  // Model A — the UNMODIFIED baseline core (shared data gates included).
  const { m5: _m5, ...baselineShaped } = input;
  const aEval = evaluateSignal(baselineShaped);
  const a: ModelAResult = { evaluation: aEval };

  const base = {
    candidateVersion: CANDIDATE_STRATEGY_VERSION,
    engineVersion: aEval.engineVersion,
    symbol: input.symbol,
    purpose: 'research-signal-not-an-execution-instruction' as const,
    inputFingerprint: fingerprint,
    generatedAtUtc: iso(input.nowUtcSec),
  };

  // Shared data gates failed → BLOCKED/FAILED for the whole candidate; B/C
  // are never evaluated behind a data gate.
  if (aEval.outcome === 'BLOCKED' || aEval.outcome === 'FAILED') {
    return {
      ...base,
      outcome: aEval.outcome,
      reasonCodes: [...aEval.reasonCodes],
      decisionCandleTimeUtc: null,
      setupKnownAtUtc: null,
      expiryUtc: null,
      model: null,
      direction: null,
      levels: null,
      setupFingerprint: null,
      evidence: {
        modelA: { outcome: aEval.outcome, reasonCodes: [...aEval.reasonCodes] },
        modelB: null,
        modelC: null,
        suppressedModels: [],
        conflict: false,
      },
      datasetFingerprint: null,
    };
  }

  const b = evaluateModelB(input);
  const c = evaluateModelC(input);
  const combined = combineModels(a, b, c);

  let setupFingerprint: string | null = null;
  if (combined.setup) {
    setupFingerprint = computeCandidateSetupFingerprint({
      symbol: input.symbol,
      timeframe: input.rules.executionTf,
      model: combined.setup.model,
      direction: combined.setup.direction,
      anchorKey: combined.setup.anchorKey,
    });
  }

  // Expiry only on setups — identical formula to the baseline (12 M15 bars
  // from the decision close). WAIT/NO_SETUP carry null (baseline semantics).
  const decisionTimeSec = input.execution.candles[input.execution.candles.length - 1].timeUtcSec;
  const decisionCloseSec = decisionTimeSec + EXEC_TF_SEC;
  const isSetup = combined.outcome === 'BUY_SETUP' || combined.outcome === 'SELL_SETUP';
  const expiryUtc = isSetup ? iso(decisionCloseSec + input.rules.expiryBars * EXEC_TF_SEC) : null;

  return {
    ...base,
    outcome: combined.outcome,
    reasonCodes: combined.reasonCodes,
    decisionCandleTimeUtc: aEval.decisionCandleTimeUtc,
    setupKnownAtUtc: aEval.setupKnownAtUtc,
    expiryUtc,
    model: combined.model,
    direction: combined.direction,
    levels: combined.levels,
    setupFingerprint,
    evidence: {
      modelA: { outcome: aEval.outcome, reasonCodes: [...aEval.reasonCodes] },
      modelB: { setup: b.setup !== null, stage: b.stage },
      modelC: { setups: c.setups.map((s) => s.direction), stage: c.stage },
      suppressedModels: combined.suppressedModels,
      conflict: combined.conflict,
    },
    datasetFingerprint: aEval.datasetFingerprint,
  };
}

// Re-exported for consumers/tests (single import surface).
export { CANDIDATE_RULES, CANDIDATE_STRATEGY_VERSION, NO_SETUP_CLASS_CODES, WAIT_CLASS_CODES };
export type { CandidateInput, CandidateReasonCode, CombinedModels, ModelAResult, ModelBResult, ModelCResult };
