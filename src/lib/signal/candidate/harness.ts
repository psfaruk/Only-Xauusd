/**
 * XAUUSD AI Trading Agent — CANDIDATE Comparison Harness (Phase 11)
 * ----------------------------------------------------------------------------
 * OFFLINE RESEARCH CODE. Mirrors the semantics of runSignalBacktest
 * (src/lib/backtest/signal-engine.ts) EXACTLY — rolling causal windows,
 * next-bar-open hypothetical fill ± (half-spread + slippage), SL-first
 * conservative collision, one position at a time, chronological dev/OOS
 * split, end-of-data close. The equivalence is PINNED BY TEST: with the
 * baseline evaluator, this harness reproduces runSignalBacktest's counters
 * and trades byte-for-byte on the same dataset.
 *
 * 'baseline' mode  → evaluates the UNMODIFIED evaluateSignal (9.0.0).
 * 'candidate' mode → evaluates evaluateCandidate (11.0.0-candidate.1) with
 *   the M5 confirmation window; trades carry model tags + candidate setup
 *   fingerprints; counters include per-model setup counts, precedence
 *   suppression, conflicts, and dedup-visible repeat emissions.
 *
 * Walk semantics = BACKTEST semantics (stop/target/end-of-data only). The
 * forward paper walk (invalidation close + chronology bounds) is governed by
 * the preregistered protocol at activation time — not by this harness.
 */

import type { AnalysisCandle } from '@/lib/analysis/types';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import { evaluateSignal } from '@/lib/signal/core';
import { computeDatasetFingerprint } from '@/lib/signal/core';
import { htfWindowClosedBy } from '@/lib/backtest/signal-engine';
import type { SignalWindow, StrategyRules } from '@/lib/signal/types';
import { evaluateCandidate } from './core';
import { CANDIDATE_RULES } from './types';

export interface HarnessCandles {
  execution: AnalysisCandle[]; // M15
  h1: AnalysisCandle[];
  h4: AnalysisCandle[];
  m5: AnalysisCandle[];
}

export interface HarnessCosts {
  spreadPrice: number;
  slippagePrice: number;
}

export interface HarnessTrade {
  segment: 'dev' | 'oos';
  model: 'A' | 'B' | 'C' | null;
  direction: 'long' | 'short';
  signalBarTimeUtcSec: number;
  entryBarTimeUtcSec: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  risk: number;
  exitBarTimeUtcSec: number;
  exitPrice: number;
  exitReason: 'stop' | 'target' | 'end_of_data';
  pnlPrice: number;
  rMultiple: number;
  setupFingerprint: string | null;
  outcomeAtSignal: string;
  reasonCodesAtSignal: string[];
}

export interface HarnessCounters {
  evaluations: number;
  blockedEvaluations: number;
  noSetup: number;
  wait: number;
  /** Total emitted setups (after precedence) — baseline equivalent of validSetups. */
  validSetups: number;
  hypotheticalFills: number;
  completedOutcomes: number;
  /** Candidate-only counters (all zero in baseline mode). */
  setupsByModel: { A: number; B: number; C: number };
  /** Bars where Model A emitted but precedence/conflict produced no setup. */
  modelAValidSuppressed: number;
  /** Same-direction setups suppressed by precedence (A > B > C). */
  suppressedByPrecedence: number;
  /** Bars ending in WAIT [MODEL_CONFLICT]. */
  conflicts: number;
  /** Distinct candidate setup identities ever emitted. */
  distinctCandidateSetups: number;
  /** Emissions whose identity was already emitted before (dedup visibility). */
  repeatEmissions: number;
  reasonCounts: Record<string, number>;
}

export interface ComparisonBacktestOptions {
  mode: 'baseline' | 'candidate';
  costs: HarnessCosts;
  devSplitFraction: number; // default 0.7
  minCandles: number; // default 220
  rules: StrategyRules;
}

export interface ComparisonBacktestResult {
  mode: 'baseline' | 'candidate';
  datasetFingerprint: string;
  counters: HarnessCounters;
  trades: HarnessTrade[];
  /** Decision-bar times where the BASELINE evaluator emitted a setup (both modes). */
  modelAEmissionBars: number[];
  /** In baseline mode: the same list as modelAEmissionBars. */
  validSetupBars: number[];
  devSplitIndex: number;
}

const M15_SEC = TIMEFRAME_SECONDS.M15;
const M5_SEC = TIMEFRAME_SECONDS.M5;

export function runComparisonBacktest(
  symbol: string,
  candles: HarnessCandles,
  digits: number | null,
  opts: ComparisonBacktestOptions,
): ComparisonBacktestResult {
  const rules = opts.rules;
  const { execution, h1, h4, m5 } = candles;
  const counters: HarnessCounters = {
    evaluations: 0,
    blockedEvaluations: 0,
    noSetup: 0,
    wait: 0,
    validSetups: 0,
    hypotheticalFills: 0,
    completedOutcomes: 0,
    setupsByModel: { A: 0, B: 0, C: 0 },
    modelAValidSuppressed: 0,
    suppressedByPrecedence: 0,
    conflicts: 0,
    distinctCandidateSetups: 0,
    repeatEmissions: 0,
    reasonCounts: {},
  };
  const trades: HarnessTrade[] = [];
  const modelAEmissionBars: number[] = [];
  const seenIdentities = new Set<string>();

  const fingerprint = computeDatasetFingerprint(symbol, {
    timeframe: 'M15',
    candles: execution,
    source: 'bridge-mt5',
  });

  const splitIndex = Math.floor(execution.length * opts.devSplitFraction);
  const halfSpread = opts.costs.spreadPrice / 2;

  /** Rolling causal windows at decision bar i — mirrors runSignalBacktest. */
  const evaluateAt = (i: number) => {
    const start = Math.max(0, i - rules.windowBars + 1);
    const execWindow: SignalWindow = {
      timeframe: rules.executionTf as Timeframe,
      candles: execution.slice(start, i + 1),
      source: 'bridge-mt5',
    };
    const decisionClose = execution[i].timeUtcSec + M15_SEC;
    const h1Win = htfWindowClosedBy(h1, TIMEFRAME_SECONDS.H1, decisionClose, 'H1', rules.windowBars);
    const h4Win = htfWindowClosedBy(h4, TIMEFRAME_SECONDS.H4, decisionClose, 'H4', rules.windowBars);
    if (opts.mode === 'baseline') {
      return {
        kind: 'baseline' as const,
        outcome: evaluateSignal({
          symbol, digits,
          execution: execWindow,
          h1: h1Win,
          h4: h4Win,
          referencePrice: execution[i].close, // documented backtest assumption
          spreadPrice: opts.costs.spreadPrice,
          nowUtcSec: decisionClose,
          rules,
        }),
        candidate: null as ReturnType<typeof evaluateCandidate> | null,
      };
    }
    const m5Win = m5WindowClosedBy(m5, decisionClose, CANDIDATE_RULES.m5WindowBars);
    return {
      kind: 'candidate' as const,
      outcome: null,
      candidate: evaluateCandidate({
        symbol, digits,
        execution: execWindow,
        h1: h1Win,
        h4: h4Win,
        m5: m5Win,
        referencePrice: execution[i].close, // SAME assumption as baseline mode
        spreadPrice: opts.costs.spreadPrice,
        nowUtcSec: decisionClose,
        rules,
      }),
    };
  };

  interface OpenTrade {
    direction: 'long' | 'short';
    model: 'A' | 'B' | 'C' | null;
    setupFingerprint: string | null;
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

  const closeTrade = (t: OpenTrade, exitIndex: number, exitPrice: number, reason: HarnessTrade['exitReason']) => {
    const gross = t.direction === 'long' ? exitPrice - t.entryPrice : t.entryPrice - exitPrice;
    trades.push({
      segment: t.entryIndex < splitIndex ? 'dev' : 'oos',
      model: t.model,
      direction: t.direction,
      signalBarTimeUtcSec: t.signalBarTime,
      entryBarTimeUtcSec: execution[t.entryIndex].timeUtcSec,
      entryPrice: t.entryPrice,
      stopLoss: t.stopLoss,
      target: t.target,
      risk: t.risk,
      exitBarTimeUtcSec: execution[exitIndex].timeUtcSec,
      exitPrice,
      exitReason: reason,
      pnlPrice: Number(gross.toFixed(10)),
      rMultiple: t.risk > 0 ? Number((gross / t.risk).toFixed(6)) : 0,
      setupFingerprint: t.setupFingerprint,
      outcomeAtSignal: t.outcomeAtSignal,
      reasonCodesAtSignal: t.reasonCodesAtSignal,
    });
    counters.completedOutcomes += 1;
  };

  if (execution.length >= opts.minCandles) {
    for (let i = 0; i < execution.length; i++) {
      // ── 1) manage an open position on this bar (SL-first conservative) ──
      if (open && i > open.entryIndex) {
        const bar = execution[i];
        const hitStop = open.direction === 'long' ? bar.low <= open.stopLoss : bar.high >= open.stopLoss;
        const hitTarget = open.direction === 'long' ? bar.high >= open.target : bar.low <= open.target;
        if (hitStop) {
          closeTrade(open, i, open.stopLoss, 'stop');
          open = null;
        } else if (hitTarget) {
          closeTrade(open, i, open.target, 'target');
          open = null;
        }
      }

      // ── 2) evaluate at THIS decision bar (causal windows) ──────────────
      const result = evaluateAt(i);
      counters.evaluations += 1;

      let outcome: string;
      let reasonCodes: string[];
      let levelsStopLoss: number | null = null;
      let model: 'A' | 'B' | 'C' | null = null;
      let setupFingerprint: string | null = null;
      let modelAEmitted = false;

      if (result.kind === 'baseline') {
        outcome = result.outcome.outcome;
        reasonCodes = result.outcome.reasonCodes;
        if (outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP') {
          modelAEmitted = true;
          levelsStopLoss = result.outcome.levels?.stopLoss ?? null;
        }
      } else {
        const cand = result.candidate!;
        outcome = cand.outcome;
        reasonCodes = cand.reasonCodes as string[];
        if (cand.evidence?.modelA && (cand.evidence.modelA.outcome === 'BUY_SETUP' || cand.evidence.modelA.outcome === 'SELL_SETUP')) {
          modelAEmitted = true;
        }
        if (outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP') {
          model = cand.model;
          setupFingerprint = cand.setupFingerprint;
          levelsStopLoss = cand.levels?.stopLoss ?? null;
          if (model) counters.setupsByModel[model] += 1;
          if (setupFingerprint) {
            if (seenIdentities.has(setupFingerprint)) counters.repeatEmissions += 1;
            else {
              seenIdentities.add(setupFingerprint);
              counters.distinctCandidateSetups += 1;
            }
          }
          if (cand.evidence?.suppressedModels?.length) counters.suppressedByPrecedence += cand.evidence.suppressedModels.length;
        }
        if (cand.evidence?.conflict) counters.conflicts += 1;
        // Model A emitted but no candidate setup resulted (conflict) — count it
        if (modelAEmitted && !(outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP')) counters.modelAValidSuppressed += 1;
      }

      if (modelAEmitted) modelAEmissionBars.push(execution[i].timeUtcSec);
      if (outcome === 'BLOCKED') counters.blockedEvaluations += 1;
      else if (outcome === 'NO_SETUP') counters.noSetup += 1;
      else if (outcome === 'WAIT') counters.wait += 1;
      if (outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP') counters.validSetups += 1;
      for (const code of reasonCodes) {
        counters.reasonCounts[code] = (counters.reasonCounts[code] ?? 0) + 1;
      }

      // ── 3) hypothetical fill at the NEXT bar's open (no look-ahead) ────
      if (
        !open && i + 1 < execution.length &&
        (outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP') &&
        levelsStopLoss !== null
      ) {
        const nextBar = execution[i + 1];
        const dir = outcome === 'BUY_SETUP' ? 'long' : 'short';
        const entry =
          dir === 'long'
            ? nextBar.open + halfSpread + opts.costs.slippagePrice
            : nextBar.open - halfSpread - opts.costs.slippagePrice;
        const stopLoss = levelsStopLoss; // anchor/sweep ± ATR buffer — entry-independent
        const risk = dir === 'long' ? entry - stopLoss : stopLoss - entry;
        if (risk > 0) {
          const target = dir === 'long' ? entry + rules.rewardRisk * risk : entry - rules.rewardRisk * risk;
          counters.hypotheticalFills += 1;
          open = {
            direction: dir,
            model,
            setupFingerprint,
            entryIndex: i + 1,
            entryPrice: entry,
            stopLoss,
            target,
            risk,
            signalBarTime: execution[i].timeUtcSec,
            outcomeAtSignal: outcome,
            reasonCodesAtSignal: reasonCodes,
          };
          const hitStop = dir === 'long' ? nextBar.low <= stopLoss : nextBar.high >= stopLoss;
          const hitTarget = dir === 'long' ? nextBar.high >= target : nextBar.low <= target;
          if (hitStop) {
            closeTrade(open, i + 1, stopLoss, 'stop');
            open = null;
          } else if (hitTarget) {
            closeTrade(open, i + 1, target, 'target');
            open = null;
          }
        }
      }
    }

    if (open) {
      closeTrade(open, execution.length - 1, execution[execution.length - 1].close, 'end_of_data');
    }
  }

  return {
    mode: opts.mode,
    datasetFingerprint: fingerprint,
    counters,
    trades,
    modelAEmissionBars,
    validSetupBars: modelAEmissionBars,
    devSplitIndex: splitIndex,
  };
}

/** Last N M5 bars fully CLOSED by asOf (forming bars excluded). */
export function m5WindowClosedBy(candles: AnalysisCandle[], asOf: number, windowBars: number): SignalWindow {
  let end = -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].timeUtcSec + M5_SEC <= asOf) {
      end = i;
      break;
    }
  }
  if (end < 0) return { timeframe: 'M5', candles: [], source: 'bridge-mt5' };
  const start = Math.max(0, end - windowBars + 1);
  return { timeframe: 'M5', candles: candles.slice(start, end + 1), source: 'bridge-mt5' };
}
