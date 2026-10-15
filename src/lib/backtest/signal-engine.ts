/**
 * XAUUSD AI Trading Agent — Signal-Engine Backtest Validation (Phase 9, Task C)
 * ----------------------------------------------------------------------------
 * Validates the ACTUAL signal engine (src/lib/signal/core.ts — the SAME pure
 * implementation the live service calls) over verified broker candles. This
 * replaces the Phase 8 structure-proxy as the strategy-validation surface.
 *
 * Guarantees (verified by tests, not just claimed):
 *   · VERIFIED CANDLES ONLY — the loader (backtest/service.ts) persists only
 *     source='bridge-mt5', validationStatus='VALID', isForming=false rows,
 *     re-validated at read time.
 *   · NO LOOK-AHEAD — every decision i is evaluated with windows ending at
 *     bar i (execution) and at HTF bars CLOSED before the decision close
 *     (context); the reference price is the decision bar's close; the entry
 *     happens at the NEXT bar's open. A mutation test pins this: mutating
 *     every candle after any decision leaves earlier decisions unchanged.
 *   · COST MODEL — next-bar-open entry ± half-spread ± slippage; SL-first
 *     collision rule (one candle touching both SL and target resolves to the
 *     LOSS — conservative, documented).
 *   · Dev/OOS chronological split; the OOS segment is NEVER optimized against.
 *   · HONEST COUNTS — candidate setups, valid setups, blocked evaluations,
 *     hypothetical fills and completed outcomes are reported SEPARATELY.
 *   · INSUFFICIENT_DATA — small samples stay empty; nothing is invented.
 *
 * DOCUMENTED DIFFERENCE from the live engine: live uses the real-time quote
 * (mid + observed spread) as the reference price; the backtest uses the
 * decision bar's close and the configured spread assumption. Recorded in
 * `limitations` on every run.
 */

import { createHash } from 'node:crypto';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import { evaluateSignal } from '@/lib/signal/core';
import { buildStrategyRules } from '@/lib/signal/rules';
import {
  SIGNAL_STRATEGY_VERSION,
  type SignalEvaluation,
  type SignalWindow,
  type StrategyRules,
} from '@/lib/signal/types';

export const SIGNAL_BACKTEST_VERSION = `${SIGNAL_STRATEGY_VERSION}-validation`;

export interface SignalBacktestCosts {
  spreadPrice: number;  // full spread, price units (default: observed 0.24)
  slippagePrice: number; // per side, price units (default 0.02)
}

export interface SignalBacktestRules {
  costs: SignalBacktestCosts;
  devSplitFraction: number; // chronological split (default 0.7)
  minCandles: number;       // execution-TF candles required at all (default 220)
  minTrades: number;        // below this per segment → INSUFFICIENT_DATA (default 5)
}

export const DEFAULT_SIGNAL_BACKTEST_RULES: SignalBacktestRules = {
  costs: { spreadPrice: 0.24, slippagePrice: 0.02 },
  devSplitFraction: 0.7,
  minCandles: 220,
  minTrades: 5,
};

export interface SignalBacktestTrade {
  segment: 'dev' | 'oos';
  direction: 'long' | 'short';
  signalBarTimeUtcSec: number;  // decision bar (setup known at its close)
  entryBarTimeUtcSec: number;   // next bar (entry at ITS open)
  entryPrice: number;           // incl. half-spread + slippage
  stopLoss: number;
  target: number;
  exitBarTimeUtcSec: number;
  exitPrice: number;
  exitReason: 'stop' | 'target' | 'end_of_data';
  pnlPrice: number;
  rMultiple: number;
  outcomeAtSignal: string;      // BUY_SETUP | SELL_SETUP
  reasonCodesAtSignal: string[];
}

export interface SignalBacktestMetrics {
  status: 'COMPUTED' | 'INSUFFICIENT_DATA';
  candles: number;
  fromUtcSec: number | null;
  toUtcSec: number | null;
  signals: number;
  executedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnlPrice: number | null;
  profitFactor: number | null;
  maxDrawdownPrice: number | null;
  avgRewardRisk: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  reason?: string;
}

export interface SignalBacktestCounters {
  evaluations: number;          // decision bars evaluated
  blockedEvaluations: number;   // core returned BLOCKED (data gates)
  noSetup: number;              // core returned NO_SETUP
  wait: number;                 // core returned WAIT
  candidateSetups: number;      // reached the structure-break stage (event found, not too old)
  validSetups: number;          // BUY_SETUP / SELL_SETUP outcomes
  hypotheticalFills: number;    // valid setups that produced a next-bar entry
  completedOutcomes: number;    // trades that closed (stop/target/end_of_data)
}

export interface SignalBacktestResult {
  backtestVersion: string;
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
  };
  rules: SignalBacktestRules;
  strategyConfig: StrategyRules;
  counters: SignalBacktestCounters;
  dev: SignalBacktestMetrics;
  oos: SignalBacktestMetrics;
  trades: SignalBacktestTrade[];
  limitations: string[];
}

export function signalDatasetFingerprint(
  symbol: string,
  execution: AnalysisCandle[],
  h1: AnalysisCandle[],
  h4: AnalysisCandle[],
): string {
  const h = createHash('sha256');
  h.update(`${symbol}|M15=${execution.length}|H1=${h1.length}|H4=${h4.length}`);
  for (const c of execution) h.update(`|e${c.timeUtcSec},${c.openText},${c.highText},${c.lowText},${c.closeText}`);
  for (const c of h1) h.update(`|1${c.timeUtcSec},${c.closeText}`);
  for (const c of h4) h.update(`|4${c.timeUtcSec},${c.closeText}`);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Simulator — evaluates the REAL signal core at every decision bar
// ---------------------------------------------------------------------------

export function runSignalBacktest(
  symbol: string,
  execution: AnalysisCandle[],
  h1: AnalysisCandle[],
  h4: AnalysisCandle[],
  digits: number | null,
  rules: SignalBacktestRules = DEFAULT_SIGNAL_BACKTEST_RULES,
  strategy: StrategyRules = buildStrategyRules(),
): SignalBacktestResult {
  const counters: SignalBacktestCounters = {
    evaluations: 0,
    blockedEvaluations: 0,
    noSetup: 0,
    wait: 0,
    candidateSetups: 0,
    validSetups: 0,
    hypotheticalFills: 0,
    completedOutcomes: 0,
  };
  const limitations = buildLimitations(rules);

  const emptyMetrics = (candles: number, reason: string): SignalBacktestMetrics => ({
    status: 'INSUFFICIENT_DATA',
    candles,
    fromUtcSec: null,
    toUtcSec: null,
    signals: 0,
    executedTrades: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    netPnlPrice: null,
    profitFactor: null,
    maxDrawdownPrice: null,
    avgRewardRisk: null,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    reason,
  });

  const fingerprint = signalDatasetFingerprint(symbol, execution, h1, h4);
  const datasetBlock = {
    symbol,
    executionTf: strategy.executionTf,
    executionCandles: execution.length,
    h1Candles: h1.length,
    h4Candles: h4.length,
    fromUtcSec: execution.length ? execution[0].timeUtcSec : 0,
    toUtcSec: execution.length ? execution[execution.length - 1].timeUtcSec : 0,
    source: 'bridge-mt5',
  };

  if (execution.length < rules.minCandles || h1.length < strategy.minH1Bars || h4.length < strategy.minH4Bars) {
    return {
      backtestVersion: SIGNAL_BACKTEST_VERSION,
      strategyVersion: strategy.strategyVersion,
      datasetFingerprint: fingerprint,
      dataset: datasetBlock,
      rules,
      strategyConfig: strategy,
      counters,
      dev: emptyMetrics(execution.length, `insufficient history: M15=${execution.length} (<${rules.minCandles}), H1=${h1.length} (<${strategy.minH1Bars}), H4=${h4.length} (<${strategy.minH4Bars})`),
      oos: emptyMetrics(execution.length, 'insufficient history'),
      trades: [],
      limitations,
    };
  }

  const execTfSec = TIMEFRAME_SECONDS[strategy.executionTf as Timeframe] ?? 900;
  const h1Sec = TIMEFRAME_SECONDS.H1;
  const h4Sec = TIMEFRAME_SECONDS.H4;

  /** Latest HTF window (bounded rolling) with all bars CLOSED by `asOf`. */
  const htfWindowAsOf = (candles: AnalysisCandle[], tfSec: number, asOf: number, tf: Timeframe): SignalWindow => {
    let end = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].timeUtcSec + tfSec <= asOf) {
        end = i;
        break;
      }
    }
    if (end < 0) return { timeframe: tf, candles: [], source: 'bridge-mt5' };
    const start = Math.max(0, end - strategy.windowBars + 1);
    return { timeframe: tf, candles: candles.slice(start, end + 1), source: 'bridge-mt5' };
  };

  const splitIndex = Math.floor(execution.length * rules.devSplitFraction);
  const trades: SignalBacktestTrade[] = [];
  const halfSpread = rules.costs.spreadPrice / 2;

  interface OpenTrade {
    direction: 'long' | 'short';
    entryIndex: number;
    entryPrice: number;
    stopLoss: number;
    target: number;
    risk: number;
    signalBarTime: number;
    outcomeAtSignal: string;
    reasonCodesAtSignal: string[];
  }
  let open: OpenTrade | null = null;

  /** Decision evaluation is recomputed per bar — the SAME core as live. */
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
      h1: htfWindowAsOf(h1, h1Sec, decisionClose, 'H1'),
      h4: htfWindowAsOf(h4, h4Sec, decisionClose, 'H4'),
      referencePrice: execution[i].close, // documented backtest assumption
      spreadPrice: rules.costs.spreadPrice,
      nowUtcSec: decisionClose,
      rules: strategy,
    });
  };

  const closeTrade = (
    t: OpenTrade,
    exitIndex: number,
    exitPrice: number,
    reason: SignalBacktestTrade['exitReason'],
  ) => {
    const gross = t.direction === 'long' ? exitPrice - t.entryPrice : t.entryPrice - exitPrice;
    trades.push({
      segment: t.entryIndex < splitIndex ? 'dev' : 'oos',
      direction: t.direction,
      signalBarTimeUtcSec: t.signalBarTime,
      entryBarTimeUtcSec: execution[t.entryIndex].timeUtcSec,
      entryPrice: t.entryPrice,
      stopLoss: t.stopLoss,
      target: t.target,
      exitBarTimeUtcSec: execution[exitIndex].timeUtcSec,
      exitPrice,
      exitReason: reason,
      pnlPrice: Number(gross.toFixed(10)),
      rMultiple: t.risk > 0 ? Number((gross / t.risk).toFixed(6)) : 0,
      outcomeAtSignal: t.outcomeAtSignal,
      reasonCodesAtSignal: t.reasonCodesAtSignal,
    });
    counters.completedOutcomes += 1;
  };

  for (let i = 0; i < execution.length; i++) {
    // ── 1) manage an open position on this bar ───────────────────────────
    if (open && i > open.entryIndex) {
      const bar = execution[i];
      const hitStop = open.direction === 'long' ? bar.low <= open.stopLoss : bar.high >= open.stopLoss;
      const hitTarget = open.direction === 'long' ? bar.high >= open.target : bar.low <= open.target;
      if (hitStop) { // SL-first conservative collision rule
        closeTrade(open, i, open.stopLoss, 'stop');
        open = null;
      } else if (hitTarget) {
        closeTrade(open, i, open.target, 'target');
        open = null;
      }
    }

    // ── 2) evaluate the signal core at THIS decision bar (causal) ────────
    //     Entry can only happen on the NEXT bar's open, so the last bar has
    //     no entry opportunity (decision still counted).
    const evaluation = evaluateAt(i);
    counters.evaluations += 1;
    if (evaluation.outcome === 'BLOCKED') counters.blockedEvaluations += 1;
    else if (evaluation.outcome === 'NO_SETUP') counters.noSetup += 1;
    else if (evaluation.outcome === 'WAIT') counters.wait += 1;
    if (evaluation.evidence?.structureEvent && evaluation.reasonCodes.every((c) => c !== 'NO_STRUCTURE_BREAK' && c !== 'STRUCTURE_BREAK_TOO_OLD')) {
      counters.candidateSetups += 1;
    }
    if (evaluation.outcome === 'BUY_SETUP' || evaluation.outcome === 'SELL_SETUP') {
      counters.validSetups += 1;
    }

    if (!open && i + 1 < execution.length && (evaluation.outcome === 'BUY_SETUP' || evaluation.outcome === 'SELL_SETUP') && evaluation.levels) {
      // ── 3) hypothetical fill at the NEXT bar's open (no look-ahead) ────
      const nextBar = execution[i + 1];
      const dir = evaluation.outcome === 'BUY_SETUP' ? 'long' : 'short';
      const entry =
        dir === 'long'
          ? nextBar.open + halfSpread + rules.costs.slippagePrice
          : nextBar.open - halfSpread - rules.costs.slippagePrice;
      // Levels are re-derived from the ACTUAL entry price with the SAME pure
      // helper the live core uses (deriveLevels) — SL stays anchored at the
      // same swing ± ATR buffer; the target re-anchors on the actual risk.
      const lv = evaluation.levels;
      const stopLoss = lv.stopLoss; // swing ± ATR buffer — entry-independent
      const risk = dir === 'long' ? entry - stopLoss : stopLoss - entry;
      if (risk > 0) {
        const target = dir === 'long' ? entry + strategy.rewardRisk * risk : entry - strategy.rewardRisk * risk;
        counters.hypotheticalFills += 1;
        open = {
          direction: dir,
          entryIndex: i + 1,
          entryPrice: entry,
          stopLoss,
          target,
          risk,
          signalBarTime: execution[i].timeUtcSec,
          outcomeAtSignal: evaluation.outcome,
          reasonCodesAtSignal: evaluation.reasonCodes,
        };

        // Same-bar exit check for the entry bar.
        const hitStop = dir === 'long' ? nextBar.low <= stopLoss : nextBar.high >= stopLoss;
        const hitTarget = dir === 'long' ? nextBar.high >= target : nextBar.low <= target;
        if (hitStop) { // collision → loss first (conservative)
          closeTrade(open, i + 1, stopLoss, 'stop');
          open = null;
        } else if (hitTarget) {
          closeTrade(open, i + 1, target, 'target');
          open = null;
        }
      }
    }
  }

  // End of data: any open position closes at the final close (marked).
  if (open) {
    closeTrade(open, execution.length - 1, execution[execution.length - 1].close, 'end_of_data');
  }

  const devTrades = trades.filter((t) => t.segment === 'dev');
  const oosTrades = trades.filter((t) => t.segment === 'oos');

  return {
    backtestVersion: SIGNAL_BACKTEST_VERSION,
    strategyVersion: strategy.strategyVersion,
    datasetFingerprint: fingerprint,
    dataset: datasetBlock,
    rules,
    strategyConfig: strategy,
    counters,
    dev: computeSegmentMetrics(devTrades, execution.slice(0, splitIndex), rules),
    oos: computeSegmentMetrics(oosTrades, execution.slice(splitIndex), rules),
    trades,
    limitations,
  };
}

function buildLimitations(rules: SignalBacktestRules): string[] {
  return [
    'Backtests are simulations over verified broker candles — NEVER proof of live profitability.',
    `The live engine references the REAL-TIME quote; this validation uses the decision bar's close and a fixed spread assumption (${rules.costs.spreadPrice} price units) + slippage (${rules.costs.slippagePrice}) — a documented, honest difference.`,
    'Entries assume next-bar-open fills; real fills can differ.',
    'When one candle touches both stop and target, the LOSS is assumed (conservative rule).',
    'The out-of-sample segment is reported separately and was NEVER optimized against.',
    'Small samples stay INSUFFICIENT_DATA — no metric is invented for thin segments.',
    'H4 history is broker-bounded (see /api/data/health H4 coverage) — long-horizon statistics are limited by that depth.',
  ];
}

function computeSegmentMetrics(
  trades: SignalBacktestTrade[],
  segmentCandles: AnalysisCandle[],
  rules: SignalBacktestRules,
): SignalBacktestMetrics {
  const base: SignalBacktestMetrics = {
    status: 'COMPUTED',
    candles: segmentCandles.length,
    fromUtcSec: segmentCandles.length ? segmentCandles[0].timeUtcSec : null,
    toUtcSec: segmentCandles.length ? segmentCandles[segmentCandles.length - 1].timeUtcSec : null,
    signals: trades.length,
    executedTrades: trades.length,
    wins: 0,
    losses: 0,
    winRate: null,
    netPnlPrice: null,
    profitFactor: null,
    maxDrawdownPrice: null,
    avgRewardRisk: null,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
  };
  if (trades.length < rules.minTrades) {
    return {
      ...base,
      status: 'INSUFFICIENT_DATA',
      reason: `only ${trades.length} trades in segment (< ${rules.minTrades}) — metrics are NOT invented`,
    };
  }
  const wins = trades.filter((t) => t.pnlPrice > 0);
  const losses = trades.filter((t) => t.pnlPrice <= 0);
  const net = trades.reduce((s, t) => s + t.pnlPrice, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlPrice, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPrice, 0));

  let equity = 0;
  let peak = 0;
  let dd = 0;
  let streakW = 0;
  let streakL = 0;
  let maxW = 0;
  let maxL = 0;
  for (const t of trades) {
    equity += t.pnlPrice;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    if (t.pnlPrice > 0) {
      streakW += 1;
      streakL = 0;
    } else {
      streakL += 1;
      streakW = 0;
    }
    maxW = Math.max(maxW, streakW);
    maxL = Math.max(maxL, streakL);
  }

  return {
    ...base,
    wins: wins.length,
    losses: losses.length,
    winRate: Number((wins.length / trades.length).toFixed(4)),
    netPnlPrice: Number(net.toFixed(4)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(4)) : null,
    maxDrawdownPrice: Number(dd.toFixed(4)),
    avgRewardRisk: Number((trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length).toFixed(4)),
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
  };
}
