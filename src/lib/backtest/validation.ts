/**
 * XAUUSD AI Trading Agent — Strategy Validation Harness (Phase 10)
 * ----------------------------------------------------------------------------
 * Validates the REAL deterministic signal engine (src/lib/signal/core.ts —
 * the same pure implementation the live service calls) with:
 *
 *   · THREE-WAY chronological split — development / validation / untouched
 *     out-of-sample (the OOS segment is NEVER optimized against; no optimizer
 *     exists anywhere in this codebase).
 *   · WALK-FORWARD — sequential out-of-sample test windows across the whole
 *     post-warm-up history. Because the strategy has NO tunable parameters
 *     fitted on data (all thresholds are fixed, documented configuration),
 *     "walk-forward" here means stability across sequential time windows,
 *     honestly reported as a SET — never a selection.
 *   · FULL COST SEPARATION — gross (level-to-open, no adjustments), modeled
 *     round-trip costs, and net, via the configurable CostModel. Phase 10
 *     charges the symmetric full round trip (spread + 2×slippage + commission)
 *     — MORE conservative than the Phase 9 simulator (see cost-model.ts).
 *   · FULL METRIC SET — win rate, profit factor, expectancy (price + R),
 *     avg win/loss, max drawdown, max consecutive losses, exposure, trade
 *     frequency, concentration, per-direction and per-regime breakdowns.
 *   · SENSITIVITY — spread/slippage/commission stress scenarios (pure
 *     re-accounting of the SAME trade list; the strategy input spread is held
 *     at the observed baseline — a real wide-spread environment would produce
 *     FEWER signals via the spread gate, never better results).
 *   · PARAMETER PERTURBATIONS — small ±perturbations of the documented
 *     configuration, reported as a complete SET. The production configuration
 *     is NEVER changed and no perturbed result is ever selected.
 *   · PRE-REGISTERED INTERPRETATION — the conclusion rules were fixed in
 *     audit/phase10-backtest-integrity.md §9 BEFORE any result was produced.
 *
 * Honesty guarantees:
 *   · INSUFFICIENT_DATA everywhere a sample is too small — nothing invented.
 *   · Verified broker candles only (loader semantics pinned since Phase 8).
 *   · No look-ahead: the simulation loop mirrors the Phase 9 semantics
 *     exactly (next-bar-open entry, SL-first collision); equivalence with the
 *     Phase 9 simulator is pinned by test.
 *   · This is a SIMULATION. It is never proof of live profitability.
 */

import type { AnalysisCandle } from '@/lib/analysis/types';
import { atrSeries } from '@/lib/analysis/indicators';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import { evaluateSignal } from '@/lib/signal/core';
import { buildStrategyRules } from '@/lib/signal/rules';
import { SIGNAL_STRATEGY_VERSION, type SignalEvaluation, type SignalWindow, type StrategyRules } from '@/lib/signal/types';
import {
  applyCosts,
  baselineCostModel,
  roundTripCost,
  stressCostModels,
  validateCostModel,
  type CostModel,
} from './cost-model';
import { htfWindowClosedBy, signalDatasetFingerprint, type SignalBacktestCounters } from './signal-engine';

export const VALIDATION_HARNESS_VERSION = '10.0.0';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ValidationSplit {
  /** First fraction of the dataset = development (default 0.5). */
  devFraction: number;
  /** Next fraction = validation (default 0.2). OOS = 1 − dev − val (default 0.3). */
  valFraction: number;
}

export interface WalkForwardConfig {
  /** Bars per sequential out-of-sample test window (default 300 = ~3 days of M15). */
  testBars: number;
  /** Below this completed-trades count a window reports INSUFFICIENT_DATA (default 5). */
  minTradesPerWindow: number;
}

export interface ValidationRules {
  costs: CostModel;
  split: ValidationSplit;
  minCandles: number;
  /** Engine honesty floor per segment (default 5). */
  minTrades: number;
  /** Pre-registered interpretability floor (default 20; audit §9 rule 1). */
  minInterpretableTrades: number;
  walkForward: WalkForwardConfig;
  /** Include the ±parameter perturbation set (default true). */
  includePerturbations: boolean;
}

export function defaultValidationRules(observedSpreadPrice: number): ValidationRules {
  return {
    costs: baselineCostModel(observedSpreadPrice),
    split: { devFraction: 0.5, valFraction: 0.2 },
    minCandles: 220,
    minTrades: 5,
    minInterpretableTrades: 20,
    walkForward: { testBars: 300, minTradesPerWindow: 5 },
    includePerturbations: true,
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type Segment = 'dev' | 'val' | 'oos';

export interface RegimeInfo {
  /** H4 structural trend at the decision bar (bullish/bearish/range_or_unclear). */
  h4Trend: 'bullish' | 'bearish' | 'range_or_unclear' | 'unknown';
  /** ADX(14) class at the decision bar. */
  adxClass: 'weak' | 'moderate' | 'strong' | 'unknown';
  /** ATR(14) rank within its trailing 200-bar window (terciles). */
  atrRank: 'low' | 'mid' | 'high' | 'unknown';
}

export interface ValidationTrade {
  segment: Segment;
  direction: 'long' | 'short';
  signalBarTimeUtcSec: number;
  entryBarTimeUtcSec: number;
  exitBarTimeUtcSec: number;
  /** Raw next-bar open (the unadjusted entry reference). */
  entryRawPrice: number;
  /** Executed entry (± half-spread ± slippage). */
  entryPrice: number;
  stopLoss: number;
  target: number;
  /** Raw exit level (stop/target/final close — no adjustments). */
  exitRawPrice: number;
  /** Executed exit (∓ half-spread ∓ slippage). */
  exitPrice: number;
  exitReason: 'stop' | 'target' | 'end_of_data';
  /** True when the exit bar's range touched BOTH stop and target (SL-first rule applied). */
  collision: boolean;
  grossPrice: number;
  costsPrice: number;
  netPrice: number;
  riskPrice: number;
  rMultiple: number;
  barsInMarket: number;
  regime: RegimeInfo;
}

export interface RegimeBreakdown {
  trades: number;
  netPnlPrice: number;
  winRate: number | null;
}

export interface SegmentMetrics {
  status: 'COMPUTED' | 'INSUFFICIENT_DATA';
  candles: number;
  fromUtcSec: number | null;
  toUtcSec: number | null;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossPnlPrice: number | null;
  costsPrice: number | null;
  netPnlPrice: number | null;
  profitFactor: number | null;
  expectancyPrice: number | null;
  expectancyR: number | null;
  avgWinPrice: number | null;
  avgLossPrice: number | null;
  maxDrawdownPrice: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  exposurePct: number | null;
  tradesPerWeek: number | null;
  concentration: { top1GrossShare: number | null; top3GrossShare: number | null };
  byDirection: { long: RegimeBreakdown; short: RegimeBreakdown };
  byH4Trend: { trend: RegimeBreakdown; range: RegimeBreakdown };
  byVolatility: { low: RegimeBreakdown; mid: RegimeBreakdown; high: RegimeBreakdown };
  byAdx: { weak: RegimeBreakdown; moderate: RegimeBreakdown; strong: RegimeBreakdown };
  reason?: string;
}

export interface WalkForwardWindow {
  index: number;
  fromUtcSec: number;
  toUtcSec: number;
  candles: number;
  metrics: SegmentMetrics;
}

export interface SensitivityRow {
  scenario: string;
  spreadPrice: number;
  slippagePrice: number;
  commissionPrice: number;
  trades: number;
  netPnlPrice: number;
  profitFactor: number | null;
  netPositive: boolean;
  labels: string[];
}

export interface PerturbationRow {
  param: string;
  value: number;
  baselineValue: number;
  trades: number;
  netPnlPrice: number;
  profitFactor: number | null;
}

export interface Interpretation {
  /** Pre-registered conclusion (audit/phase10-backtest-integrity.md §9). */
  conclusion: 'INCONCLUSIVE' | 'NEGATIVE_AFTER_COSTS' | 'PROMISING_CONTINUE_FORWARD';
  reasons: string[];
  rulesVersion: string;
}

export interface ValidationResult {
  harnessVersion: string;
  strategyVersion: string;
  datasetFingerprint: string;
  dataset: {
    symbol: string;
    executionTf: string;
    executionCandles: number;
    h1Candles: number;
    h4Candles: number;
    fromUtcSec: number;
    toUtcSec: number;
    source: string;
    observedSpreadPrice: number;
    splitFractions: { dev: number; val: number; oos: number };
  };
  rules: ValidationRules;
  strategyConfig: StrategyRules;
  counters: SignalBacktestCounters;
  segments: Record<Segment, SegmentMetrics>;
  trades: ValidationTrade[];
  walkForward: {
    windows: WalkForwardWindow[];
    aggregate: SegmentMetrics;
    note: string;
  };
  sensitivity: SensitivityRow[];
  perturbations: PerturbationRow[];
  warnings: string[];
  limitations: string[];
  interpretation: Interpretation;
}

// ---------------------------------------------------------------------------
// Simulation (mirrors Phase 9 semantics; equivalence pinned by test)
// ---------------------------------------------------------------------------

interface SimTrade {
  segment: Segment;
  direction: 'long' | 'short';
  signalBarTime: number;
  entryIndex: number;
  entryRawPrice: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  exitIndex: number;
  exitRawPrice: number;
  exitReason: ValidationTrade['exitReason'];
  collision: boolean;
  grossPrice: number;
  costsPrice: number;
  netPrice: number;
  riskPrice: number;
  rMultiple: number;
  barsInMarket: number;
  regime: RegimeInfo;
}

interface SimOutcome {
  trades: SimTrade[];
  counters: SignalBacktestCounters;
}

function emptyCounters(): SignalBacktestCounters {
  return {
    evaluations: 0,
    blockedEvaluations: 0,
    noSetup: 0,
    wait: 0,
    candidateSetups: 0,
    validSetups: 0,
    hypotheticalFills: 0,
    completedOutcomes: 0,
  };
}

function simulate(
  symbol: string,
  execution: AnalysisCandle[],
  h1: AnalysisCandle[],
  h4: AnalysisCandle[],
  digits: number | null,
  costs: CostModel,
  strategy: StrategyRules,
  splitBoundaries: { devEnd: number; valEnd: number },
  atrFull: Array<number | null>,
): SimOutcome {
  const counters = emptyCounters();
  const trades: SimTrade[] = [];
  const execTfSec = TIMEFRAME_SECONDS[strategy.executionTf as Timeframe] ?? 900;
  const halfSpread = costs.spreadPrice / 2;

  const evaluateAt = (i: number): SignalEvaluation => {
    const start = Math.max(0, i - strategy.windowBars + 1);
    const execWindow: SignalWindow = {
      timeframe: strategy.executionTf as Timeframe,
      candles: execution.slice(start, i + 1),
      source: 'bridge-mt5',
    };
    const decisionClose = execution[i].timeUtcSec + execTfSec;
    return evaluateSignal({
      symbol,
      digits,
      execution: execWindow,
      h1: htfWindowClosedBy(h1, TIMEFRAME_SECONDS.H1, decisionClose, 'H1', strategy.windowBars),
      h4: htfWindowClosedBy(h4, TIMEFRAME_SECONDS.H4, decisionClose, 'H4', strategy.windowBars),
      referencePrice: execution[i].close, // documented backtest assumption (live uses the real-time quote)
      spreadPrice: costs.spreadPrice,     // strategy input held at the observed baseline
      nowUtcSec: decisionClose,
      rules: strategy,
    });
  };

  /** ATR tercile rank within the trailing 200 bars (causal). */
  const atrRankAt = (i: number): RegimeInfo['atrRank'] => {
    const v = atrFull[i];
    if (v === null || !Number.isFinite(v)) return 'unknown';
    const from = Math.max(0, i - 199);
    const window: number[] = [];
    for (let k = from; k <= i; k++) {
      const a = atrFull[k];
      if (a !== null && Number.isFinite(a)) window.push(a);
    }
    if (window.length < 20) return 'unknown';
    const below = window.filter((a) => a < v).length; // strict rank of v in its trailing window
    const pct = below / window.length;
    if (pct < 1 / 3) return 'low';
    if (pct < 2 / 3) return 'mid';
    return 'high';
  };

  const regimeAt = (ev: SignalEvaluation, i: number): RegimeInfo => {
    const adx = ev.evidence?.indicators.adx14 ?? null;
    const adxClass: RegimeInfo['adxClass'] =
      adx === null || !Number.isFinite(adx) ? 'unknown' : adx < 20 ? 'weak' : adx <= 30 ? 'moderate' : 'strong';
    const t = ev.evidence?.htfContext.h4Trend ?? null;
    const h4Trend: RegimeInfo['h4Trend'] =
      t === 'bullish' || t === 'bearish' ? t : t === null ? 'unknown' : 'range_or_unclear';
    return { h4Trend, adxClass, atrRank: atrRankAt(i) };
  };

  interface OpenTrade {
    direction: 'long' | 'short';
    entryIndex: number;
    entryRawPrice: number;
    entryPrice: number;
    stopLoss: number;
    target: number;
    riskPrice: number;
    signalBarTime: number;
    regime: RegimeInfo;
  }
  let open: OpenTrade | null = null;

  const closeTrade = (
    t: OpenTrade,
    exitIndex: number,
    exitRawPrice: number,
    reason: ValidationTrade['exitReason'],
    collision: boolean,
  ): void => {
    const costed = applyCosts(t.direction, t.entryRawPrice, exitRawPrice, costs);
    trades.push({
      segment: t.entryIndex < splitBoundaries.devEnd ? 'dev' : t.entryIndex < splitBoundaries.valEnd ? 'val' : 'oos',
      direction: t.direction,
      signalBarTime: t.signalBarTime,
      entryIndex: t.entryIndex,
      entryRawPrice: t.entryRawPrice,
      entryPrice: costed.entryPrice,
      stopLoss: t.stopLoss,
      target: t.target,
      exitIndex,
      exitRawPrice,
      exitReason: reason,
      collision,
      grossPrice: costed.grossPrice,
      costsPrice: costed.costsPrice,
      netPrice: costed.netPrice,
      riskPrice: t.riskPrice,
      rMultiple: t.riskPrice > 0 ? Number((costed.netPrice / t.riskPrice).toFixed(6)) : 0,
      barsInMarket: exitIndex - t.entryIndex + 1,
      regime: t.regime,
    });
    counters.completedOutcomes += 1;
  };

  for (let i = 0; i < execution.length; i++) {
    const bar = execution[i];

    // ── 1) manage an open position (SL-first conservative collision) ──────
    if (open && i > open.entryIndex) {
      const hitStop = open.direction === 'long' ? bar.low <= open.stopLoss : bar.high >= open.stopLoss;
      const hitTarget = open.direction === 'long' ? bar.high >= open.target : bar.low <= open.target;
      if (hitStop) {
        closeTrade(open, i, open.stopLoss, 'stop', hitStop && hitTarget);
        open = null;
      } else if (hitTarget) {
        closeTrade(open, i, open.target, 'target', false);
        open = null;
      }
    }

    // ── 2) evaluate the REAL signal core at this decision bar ─────────────
    const evaluation = evaluateAt(i);
    counters.evaluations += 1;
    if (evaluation.outcome === 'BLOCKED') counters.blockedEvaluations += 1;
    else if (evaluation.outcome === 'NO_SETUP') counters.noSetup += 1;
    else if (evaluation.outcome === 'WAIT') counters.wait += 1;
    if (
      evaluation.evidence?.structureEvent &&
      evaluation.reasonCodes.every((c) => c !== 'NO_STRUCTURE_BREAK' && c !== 'STRUCTURE_BREAK_TOO_OLD')
    ) {
      counters.candidateSetups += 1;
    }
    if (evaluation.outcome === 'BUY_SETUP' || evaluation.outcome === 'SELL_SETUP') counters.validSetups += 1;

    // ── 3) hypothetical fill at the NEXT bar's open (no look-ahead) ───────
    if (
      !open &&
      i + 1 < execution.length &&
      (evaluation.outcome === 'BUY_SETUP' || evaluation.outcome === 'SELL_SETUP') &&
      evaluation.levels
    ) {
      const nextBar = execution[i + 1];
      const dir = evaluation.outcome === 'BUY_SETUP' ? 'long' : 'short';
      const entryPrice =
        dir === 'long'
          ? nextBar.open + halfSpread + costs.slippagePrice
          : nextBar.open - halfSpread - costs.slippagePrice;
      const stopLoss = evaluation.levels.stopLoss; // swing ± ATR buffer — entry-independent
      const risk = dir === 'long' ? entryPrice - stopLoss : stopLoss - entryPrice;
      if (risk > 0) {
        const target = dir === 'long' ? entryPrice + strategy.rewardRisk * risk : entryPrice - strategy.rewardRisk * risk;
        counters.hypotheticalFills += 1;
        open = {
          direction: dir,
          entryIndex: i + 1,
          entryRawPrice: nextBar.open,
          entryPrice,
          stopLoss,
          target,
          riskPrice: risk,
          signalBarTime: execution[i].timeUtcSec,
          regime: regimeAt(evaluation, i),
        };

        const hitStop = dir === 'long' ? nextBar.low <= stopLoss : nextBar.high >= stopLoss;
        const hitTarget = dir === 'long' ? nextBar.high >= target : nextBar.low <= target;
        if (hitStop) { // collision → loss first (conservative)
          closeTrade(open, i + 1, stopLoss, 'stop', hitStop && hitTarget);
          open = null;
        } else if (hitTarget) {
          closeTrade(open, i + 1, target, 'target', false);
          open = null;
        }
      }
    }
  }

  if (open) {
    const last = execution[execution.length - 1];
    closeTrade(open, execution.length - 1, last.close, 'end_of_data', false);
  }

  return { trades, counters };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function breakdown(trades: ValidationTrade[]): RegimeBreakdown {
  if (!trades.length) return { trades: 0, netPnlPrice: 0, winRate: null };
  const wins = trades.filter((t) => t.netPrice > 0).length;
  return {
    trades: trades.length,
    netPnlPrice: Number(trades.reduce((s, t) => s + t.netPrice, 0).toFixed(4)),
    winRate: Number((wins / trades.length).toFixed(4)),
  };
}

function concentrationOf(trades: ValidationTrade[]): { top1GrossShare: number | null; top3GrossShare: number | null } {
  const wins = trades.filter((t) => t.netPrice > 0).sort((a, b) => b.netPrice - a.netPrice);
  const totalWin = wins.reduce((s, t) => s + t.netPrice, 0);
  if (totalWin <= 0 || !wins.length) return { top1GrossShare: null, top3GrossShare: null };
  const top3 = wins.slice(0, 3).reduce((s, t) => s + t.netPrice, 0);
  return {
    top1GrossShare: Number((wins[0].netPrice / totalWin).toFixed(4)),
    top3GrossShare: Number((top3 / totalWin).toFixed(4)),
  };
}

function computeSegmentMetrics(
  trades: ValidationTrade[],
  segmentCandles: AnalysisCandle[],
  minTrades: number,
  tfSec: number,
): SegmentMetrics {
  const empty: SegmentMetrics = {
    status: 'INSUFFICIENT_DATA',
    candles: segmentCandles.length,
    fromUtcSec: segmentCandles.length ? segmentCandles[0].timeUtcSec : null,
    toUtcSec: segmentCandles.length ? segmentCandles[segmentCandles.length - 1].timeUtcSec : null,
    trades: trades.length,
    wins: 0,
    losses: 0,
    winRate: null,
    grossPnlPrice: null,
    costsPrice: null,
    netPnlPrice: null,
    profitFactor: null,
    expectancyPrice: null,
    expectancyR: null,
    avgWinPrice: null,
    avgLossPrice: null,
    maxDrawdownPrice: null,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    exposurePct: null,
    tradesPerWeek: null,
    concentration: { top1GrossShare: null, top3GrossShare: null },
    byDirection: { long: breakdown([]), short: breakdown([]) },
    byH4Trend: { trend: breakdown([]), range: breakdown([]) },
    byVolatility: { low: breakdown([]), mid: breakdown([]), high: breakdown([]) },
    byAdx: { weak: breakdown([]), moderate: breakdown([]), strong: breakdown([]) },
    reason: `only ${trades.length} trades (< ${minTrades}) — metrics are NOT invented`,
  };
  if (trades.length < minTrades) return empty;

  const wins = trades.filter((t) => t.netPrice > 0);
  const losses = trades.filter((t) => t.netPrice <= 0);
  const gross = trades.reduce((s, t) => s + t.grossPrice, 0);
  const costs = trades.reduce((s, t) => s + t.costsPrice, 0);
  const net = trades.reduce((s, t) => s + t.netPrice, 0);
  const grossWin = wins.reduce((s, t) => s + t.netPrice, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPrice, 0));

  let equity = 0;
  let peak = 0;
  let dd = 0;
  let streakW = 0;
  let streakL = 0;
  let maxW = 0;
  let maxL = 0;
  for (const t of trades) {
    equity += t.netPrice;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    if (t.netPrice > 0) {
      streakW += 1;
      streakL = 0;
    } else {
      streakL += 1;
      streakW = 0;
    }
    maxW = Math.max(maxW, streakW);
    maxL = Math.max(maxL, streakL);
  }

  const spanSec = segmentCandles.length > 1
    ? segmentCandles[segmentCandles.length - 1].timeUtcSec - segmentCandles[0].timeUtcSec
    : tfSec;
  const weeks = Math.max(spanSec / 604_800, 1 / 6048); // never below ~1 minute
  const barsInMarket = trades.reduce((s, t) => s + t.barsInMarket, 0);

  return {
    status: 'COMPUTED',
    candles: segmentCandles.length,
    fromUtcSec: segmentCandles.length ? segmentCandles[0].timeUtcSec : null,
    toUtcSec: segmentCandles.length ? segmentCandles[segmentCandles.length - 1].timeUtcSec : null,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Number((wins.length / trades.length).toFixed(4)),
    grossPnlPrice: Number(gross.toFixed(4)),
    costsPrice: Number(costs.toFixed(4)),
    netPnlPrice: Number(net.toFixed(4)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(4)) : null,
    expectancyPrice: Number((net / trades.length).toFixed(4)),
    expectancyR: Number((trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length).toFixed(4)),
    avgWinPrice: wins.length ? Number((grossWin / wins.length).toFixed(4)) : null,
    avgLossPrice: losses.length ? Number((-grossLoss / losses.length).toFixed(4)) : null,
    maxDrawdownPrice: Number(dd.toFixed(4)),
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
    exposurePct: segmentCandles.length
      ? Number(((barsInMarket / segmentCandles.length) * 100).toFixed(2))
      : null,
    tradesPerWeek: Number((trades.length / weeks).toFixed(4)),
    concentration: concentrationOf(trades),
    byDirection: {
      long: breakdown(trades.filter((t) => t.direction === 'long')),
      short: breakdown(trades.filter((t) => t.direction === 'short')),
    },
    byH4Trend: {
      trend: breakdown(trades.filter((t) => t.regime.h4Trend === 'bullish' || t.regime.h4Trend === 'bearish')),
      range: breakdown(trades.filter((t) => t.regime.h4Trend === 'range_or_unclear' || t.regime.h4Trend === 'unknown')),
    },
    byVolatility: {
      low: breakdown(trades.filter((t) => t.regime.atrRank === 'low')),
      mid: breakdown(trades.filter((t) => t.regime.atrRank === 'mid')),
      high: breakdown(trades.filter((t) => t.regime.atrRank === 'high')),
    },
    byAdx: {
      weak: breakdown(trades.filter((t) => t.regime.adxClass === 'weak')),
      moderate: breakdown(trades.filter((t) => t.regime.adxClass === 'moderate')),
      strong: breakdown(trades.filter((t) => t.regime.adxClass === 'strong')),
    },
  };
}

// ---------------------------------------------------------------------------
// Sensitivity (pure re-accounting of the SAME trade list)
// ---------------------------------------------------------------------------

function sensitivityRows(trades: ValidationTrade[], observedSpread: number): SensitivityRow[] {
  const scenarios = stressCostModels(observedSpread);
  return scenarios.map(({ name, model }) => {
    let net = 0;
    let grossWin = 0;
    let grossLoss = 0;
    for (const t of trades) {
      const costed = applyCosts(t.direction, t.entryRawPrice, t.exitRawPrice, model);
      net += costed.netPrice;
      if (costed.netPrice > 0) grossWin += costed.netPrice;
      else grossLoss += Math.abs(costed.netPrice);
    }
    return {
      scenario: name,
      spreadPrice: model.spreadPrice,
      slippagePrice: model.slippagePrice,
      commissionPrice: model.commissionPrice,
      trades: trades.length,
      netPnlPrice: Number(net.toFixed(4)),
      profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(4)) : null,
      netPositive: net > 0,
      labels: model.labels,
    };
  });
}

// ---------------------------------------------------------------------------
// Parameter perturbations (reported as a SET — never selected)
// ---------------------------------------------------------------------------

interface PerturbationSpec {
  param: keyof Pick<StrategyRules, 'rewardRisk' | 'maxBarsSinceBreak' | 'zoneWidthAtr' | 'slAtrBuffer' | 'minAdx' | 'entryToleranceAtr'>;
  values: number[];
}

function perturbationSpecs(strategy: StrategyRules): PerturbationSpec[] {
  return [
    { param: 'rewardRisk', values: [round2(strategy.rewardRisk * 0.9), round2(strategy.rewardRisk * 1.1)] },
    { param: 'maxBarsSinceBreak', values: [Math.max(2, strategy.maxBarsSinceBreak - 2), strategy.maxBarsSinceBreak + 2] },
    { param: 'zoneWidthAtr', values: [round2(strategy.zoneWidthAtr * 0.8), round2(strategy.zoneWidthAtr * 1.2)] },
    { param: 'slAtrBuffer', values: [round2(strategy.slAtrBuffer * 0.8), round2(strategy.slAtrBuffer * 1.2)] },
    { param: 'minAdx', values: [Math.max(0, strategy.minAdx - 3), strategy.minAdx + 3] },
    { param: 'entryToleranceAtr', values: [round2(strategy.entryToleranceAtr * 0.8), round2(strategy.entryToleranceAtr * 1.2)] },
  ];
}

function round2(v: number): number {
  return Number(v.toFixed(4));
}

// ---------------------------------------------------------------------------
// Pre-registered interpretation (audit/phase10-backtest-integrity.md §9)
// ---------------------------------------------------------------------------

export function evaluateInterpretation(
  oos: SegmentMetrics,
  sensitivity: SensitivityRow[],
  minInterpretableTrades: number,
): Interpretation {
  const reasons: string[] = [];
  const rulesVersion = 'pre-registered-rules/1 (audit/phase10-backtest-integrity.md §9)';

  if (oos.status !== 'COMPUTED' || oos.trades < minInterpretableTrades) {
    reasons.push(
      `OOS sample = ${oos.trades} completed trades (< ${minInterpretableTrades} required) — below the pre-registered interpretability floor.`,
    );
    return { conclusion: 'INCONCLUSIVE', reasons, rulesVersion };
  }

  const baseline = sensitivity.find((s) => s.scenario === 'baseline') ?? null;
  const stressed = sensitivity.find((s) => s.scenario === 'stressed') ?? null;
  const highStress = sensitivity.find((s) => s.scenario === 'high_stress') ?? null;

  if ((oos.netPnlPrice ?? 0) <= 0) {
    reasons.push(
      `OOS net P/L after modeled costs = ${oos.netPnlPrice} (≤ 0) with ${oos.trades} trades — negative out-of-sample result.`,
    );
    return { conclusion: 'NEGATIVE_AFTER_COSTS', reasons, rulesVersion };
  }

  if (baseline && !baseline.netPositive) {
    reasons.push('Baseline cost scenario is not net-positive — result is not robust to its own cost assumptions.');
    return { conclusion: 'NEGATIVE_AFTER_COSTS', reasons, rulesVersion };
  }

  if (stressed && !stressed.netPositive) {
    reasons.push(
      `Stressed cost scenario (spread ${stressed.spreadPrice}) turns net P/L negative (${stressed.netPnlPrice}) — not robust to spread widening.`,
    );
    return { conclusion: 'INCONCLUSIVE', reasons, rulesVersion };
  }

  const top1 = oos.concentration.top1GrossShare ?? 0;
  if (top1 > 0.35) {
    reasons.push(
      `Single best trade contributes ${(top1 * 100).toFixed(1)}% of gross profit (> 35% pre-registered limit) — concentration too high.`,
    );
    return { conclusion: 'INCONCLUSIVE', reasons, rulesVersion };
  }

  reasons.push(
    `OOS ${oos.trades} trades ≥ ${minInterpretableTrades}, net ${oos.netPnlPrice} > 0 after modeled costs, PF ${oos.profitFactor}.`,
  );
  if (stressed) reasons.push(`Stressed scenario stays net-positive (${stressed.netPnlPrice}).`);
  if (highStress) {
    reasons.push(
      highStress.netPositive
        ? `High-stress scenario stays net-positive (${highStress.netPnlPrice}).`
        : `High-stress scenario turns negative (${highStress.netPnlPrice}) — disclosed; interpretation stays cautious.`,
    );
  }
  reasons.push('Evidence supports CONTINUING FORWARD PAPER TESTING — this is NOT a profitability claim.');
  return { conclusion: 'PROMISING_CONTINUE_FORWARD', reasons, rulesVersion };
}

// ---------------------------------------------------------------------------
// The harness entry point
// ---------------------------------------------------------------------------

export function runValidation(
  symbol: string,
  execution: AnalysisCandle[],
  h1: AnalysisCandle[],
  h4: AnalysisCandle[],
  digits: number | null,
  observedSpreadPrice: number,
  rules: ValidationRules = defaultValidationRules(observedSpreadPrice),
  strategy: StrategyRules = buildStrategyRules(),
): ValidationResult {
  const costProblems = validateCostModel(rules.costs);
  if (costProblems.length) {
    throw new Error(`invalid cost model: ${costProblems.join('; ')}`);
  }
  if (rules.split.devFraction + rules.split.valFraction >= 0.85) {
    throw new Error('split must leave at least 15% untouched out-of-sample');
  }

  const warnings: string[] = [];
  const atrFullRes = atrSeries(execution, strategy.atrPeriod);
  const atrFull = atrFullRes.ok ? atrFullRes.series.values : execution.map(() => null);

  const fingerprint = signalDatasetFingerprint(symbol, execution, h1, h4);
  const devEnd = Math.floor(execution.length * rules.split.devFraction);
  const valEnd = Math.floor(execution.length * (rules.split.devFraction + rules.split.valFraction));

  const datasetBlock = {
    symbol,
    executionTf: strategy.executionTf,
    executionCandles: execution.length,
    h1Candles: h1.length,
    h4Candles: h4.length,
    fromUtcSec: execution.length ? execution[0].timeUtcSec : 0,
    toUtcSec: execution.length ? execution[execution.length - 1].timeUtcSec : 0,
    source: 'bridge-mt5',
    observedSpreadPrice,
    splitFractions: {
      dev: Number(rules.split.devFraction.toFixed(4)),
      val: Number(rules.split.valFraction.toFixed(4)),
      oos: Number((1 - rules.split.devFraction - rules.split.valFraction).toFixed(4)),
    },
  };

  const insufficientOverall =
    execution.length < rules.minCandles || h1.length < strategy.minH1Bars || h4.length < strategy.minH4Bars;

  const execTfSec = TIMEFRAME_SECONDS[strategy.executionTf as Timeframe] ?? 900;

  const emptyMetrics = (reason: string): SegmentMetrics => ({
    ...computeSegmentMetrics([], execution.slice(0, 0), 1, execTfSec),
    status: 'INSUFFICIENT_DATA',
    reason,
  });

  if (insufficientOverall) {
    const reason = `insufficient history: M15=${execution.length} (<${rules.minCandles}), H1=${h1.length} (<${strategy.minH1Bars}), H4=${h4.length} (<${strategy.minH4Bars})`;
    warnings.push(reason);
    return {
      harnessVersion: VALIDATION_HARNESS_VERSION,
      strategyVersion: strategy.strategyVersion,
      datasetFingerprint: fingerprint,
      dataset: datasetBlock,
      rules,
      strategyConfig: strategy,
      counters: emptyCounters(),
      segments: { dev: emptyMetrics(reason), val: emptyMetrics(reason), oos: emptyMetrics(reason) },
      trades: [],
      walkForward: { windows: [], aggregate: emptyMetrics(reason), note: 'not run — insufficient history' },
      sensitivity: [],
      perturbations: [],
      warnings,
      limitations: buildLimitations(rules, observedSpreadPrice),
      interpretation: {
        conclusion: 'INCONCLUSIVE',
        reasons: [reason],
        rulesVersion: 'pre-registered-rules/1 (audit/phase10-backtest-integrity.md §9)',
      },
    };
  }

  // ── Baseline simulation ──────────────────────────────────────────────────
  const sim = simulate(symbol, execution, h1, h4, digits, rules.costs, strategy, { devEnd, valEnd }, atrFull);

  const toValidationTrade = (t: SimTrade): ValidationTrade => ({
    segment: t.segment,
    direction: t.direction,
    signalBarTimeUtcSec: t.signalBarTime,
    entryBarTimeUtcSec: execution[t.entryIndex].timeUtcSec,
    exitBarTimeUtcSec: execution[t.exitIndex].timeUtcSec,
    entryRawPrice: t.entryRawPrice,
    entryPrice: t.entryPrice,
    stopLoss: t.stopLoss,
    target: t.target,
    exitRawPrice: t.exitRawPrice,
    exitPrice: Number(
      (t.direction === 'long'
        ? t.exitRawPrice - rules.costs.spreadPrice / 2 - rules.costs.slippagePrice
        : t.exitRawPrice + rules.costs.spreadPrice / 2 + rules.costs.slippagePrice
      ).toFixed(10),
    ),
    exitReason: t.exitReason,
    collision: t.collision,
    grossPrice: t.grossPrice,
    costsPrice: t.costsPrice,
    netPrice: t.netPrice,
    riskPrice: t.riskPrice,
    rMultiple: t.rMultiple,
    barsInMarket: t.barsInMarket,
    regime: t.regime,
  });

  const trades = sim.trades.map(toValidationTrade);
  const segments: Record<Segment, SegmentMetrics> = {
    dev: computeSegmentMetrics(trades.filter((t) => t.segment === 'dev'), execution.slice(0, devEnd), rules.minTrades, execTfSec),
    val: computeSegmentMetrics(trades.filter((t) => t.segment === 'val'), execution.slice(devEnd, valEnd), rules.minTrades, execTfSec),
    oos: computeSegmentMetrics(trades.filter((t) => t.segment === 'oos'), execution.slice(valEnd), rules.minTrades, execTfSec),
  };

  // ── Walk-forward: sequential OOS windows over the post-warm-up history ──
  const firstEvaluable = Math.min(strategy.windowBars - 1, execution.length - 1);
  const windows: WalkForwardWindow[] = [];
  const testBars = Math.max(50, rules.walkForward.testBars);
  const simIndexInWindow = (k: number, start: number, end: number): boolean => {
    const entryIdx = sim.trades[k]?.entryIndex ?? -1;
    return entryIdx >= start && entryIdx < end;
  };
  for (let start = firstEvaluable, w = 0; start < execution.length; start += testBars, w++) {
    const end = Math.min(start + testBars, execution.length);
    const windowTrades = trades.filter((_, k) => simIndexInWindow(k, start, end));
    windows.push({
      index: w,
      fromUtcSec: execution[start].timeUtcSec,
      toUtcSec: execution[end - 1].timeUtcSec,
      candles: end - start,
      metrics: computeSegmentMetrics(windowTrades, execution.slice(start, end), rules.walkForward.minTradesPerWindow, execTfSec),
    });
  }
  const wfTrades = trades.filter((_, k) => (sim.trades[k]?.entryIndex ?? -1) >= firstEvaluable);
  const walkForwardAggregate = computeSegmentMetrics(
    wfTrades,
    execution.slice(firstEvaluable),
    rules.minTrades,
    execTfSec,
  );

  // ── Sensitivity (same trade list, re-accounted) ──────────────────────────
  const sensitivity = sensitivityRows(trades, rules.costs.spreadPrice);
  const stressedRow = sensitivity.find((s) => s.scenario === 'stressed');
  if (stressedRow && !stressedRow.netPositive && (segments.oos.netPnlPrice ?? 0) > 0) {
    warnings.push('OOS net-positive under baseline costs but NEGATIVE under the stressed cost scenario — cost assumption is decision-relevant.');
  }

  // ── Parameter perturbation SET (never selected) ──────────────────────────
  const perturbations: PerturbationRow[] = [];
  if (rules.includePerturbations) {
    const baseNet = Number(trades.reduce((s, t) => s + t.netPrice, 0).toFixed(4));
    const baseWins = trades.filter((t) => t.netPrice > 0);
    const baseLossesAbs = Math.abs(trades.filter((t) => t.netPrice <= 0).reduce((s, t) => s + t.netPrice, 0));
    const baseWinSum = baseWins.reduce((s, t) => s + t.netPrice, 0);
    perturbations.push({
      param: '(baseline)',
      value: 0,
      baselineValue: 0,
      trades: trades.length,
      netPnlPrice: baseNet,
      profitFactor: baseLossesAbs > 0 ? Number((baseWinSum / baseLossesAbs).toFixed(4)) : null,
    });
    for (const spec of perturbationSpecs(strategy)) {
      for (const value of spec.values) {
        const perturbed: StrategyRules = { ...strategy, [spec.param]: value };
        const pSim = simulate(symbol, execution, h1, h4, digits, rules.costs, perturbed, { devEnd, valEnd }, atrFull);
        const pTrades = pSim.trades.map(toValidationTrade);
        const net = pTrades.reduce((s, t) => s + t.netPrice, 0);
        const winSum = pTrades.filter((t) => t.netPrice > 0).reduce((s, t) => s + t.netPrice, 0);
        const lossAbs = Math.abs(pTrades.filter((t) => t.netPrice <= 0).reduce((s, t) => s + t.netPrice, 0));
        perturbations.push({
          param: String(spec.param),
          value,
          baselineValue: strategy[spec.param] as number,
          trades: pTrades.length,
          netPnlPrice: Number(net.toFixed(4)),
          profitFactor: lossAbs > 0 ? Number((winSum / lossAbs).toFixed(4)) : null,
        });
      }
    }
  }

  // ── Warnings ─────────────────────────────────────────────────────────────
  const collisionCount = trades.filter((t) => t.collision).length;
  if (collisionCount > 0) {
    warnings.push(
      `${collisionCount} trade(s) resolved by the conservative SL-first collision rule (stop and target touched in one candle) — P/L is biased DOWNWARD by this assumption.`,
    );
  }
  const eodCount = trades.filter((t) => t.exitReason === 'end_of_data').length;
  if (eodCount > 0) {
    warnings.push(`${eodCount} trade(s) closed at end-of-data (still open when history ended) — outcome forced, not signal-driven.`);
  }
  if (datasetBlock.toUtcSec > 0 && Date.now() / 1000 - datasetBlock.toUtcSec > 6 * 3600) {
    warnings.push('Dataset ends more than 6 hours before the validation run — sync before interpreting.');
  }
  if (segments.oos.status !== 'COMPUTED') {
    warnings.push(`OOS segment: ${segments.oos.reason ?? 'INSUFFICIENT_DATA'}`);
  }
  if (segments.val.status !== 'COMPUTED') {
    warnings.push(`Validation segment: ${segments.val.reason ?? 'INSUFFICIENT_DATA'}`);
  }

  return {
    harnessVersion: VALIDATION_HARNESS_VERSION,
    strategyVersion: strategy.strategyVersion,
    datasetFingerprint: fingerprint,
    dataset: datasetBlock,
    rules,
    strategyConfig: strategy,
    counters: sim.counters,
    segments,
    trades,
    walkForward: {
      windows,
      aggregate: walkForwardAggregate,
      note:
        'Parameter-free strategy: walk-forward = stability across sequential out-of-sample windows (no optimization exists to walk forward). All windows reported as a SET — nothing selected.',
    },
    sensitivity,
    perturbations,
    warnings,
    limitations: buildLimitations(rules, observedSpreadPrice),
    interpretation: evaluateInterpretation(segments.oos, sensitivity, rules.minInterpretableTrades),
  };
}

function buildLimitations(rules: ValidationRules, observedSpread: number): string[] {
  return [
    'Backtests are simulations over verified broker candles — NEVER proof of live profitability.',
    `Spread (${rules.costs.spreadPrice}) is a CURRENT OBSERVATION (${observedSpread} at harness run time), NOT historical spread — per-candle spread is not stored by the bridge.`,
    'Slippage and commission are ASSUMPTIONS (see cost model labels) — not verified broker facts.',
    'Phase 10 charges the symmetric full round trip (spread + 2×slippage + commission) — more conservative than the Phase 9 simulator (half-spread + 1×slippage).',
    'Monetary P/L and position sizing are BLOCKED: tickValue/contract size are not verified — results stay in price units and R-multiples.',
    'Entries assume next-bar-open fills; real fills can differ.',
    'When one candle touches both stop and target, the LOSS is assumed (conservative rule).',
    'The out-of-sample segment was NEVER optimized against (no optimizer exists in this codebase).',
    'Small samples stay INSUFFICIENT_DATA — no metric is invented for thin segments.',
    'H4 history is broker-bounded (~2000 bars depth; app stores 1000 per request cap) — long-horizon statistics are limited by that depth.',
    `Perturbation results (if present) are a robustness SET over the FIXED configuration — the production strategy parameters are unchanged and no perturbed variant is selected.`,
  ];
}
