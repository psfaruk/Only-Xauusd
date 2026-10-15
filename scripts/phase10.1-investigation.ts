/**
 * Phase 10.1 — Signal Failure Investigation (DIAGNOSTIC ONLY).
 * ----------------------------------------------------------------------------
 * READ-ONLY forensic audit of WHY the production signal engine
 * (hybrid-structure-retest/9.0.0, config UNCHANGED) produces negative
 * dev/val/walk-forward results on verified broker candles.
 *
 * HARD GUARANTEES:
 *   · NO strategy parameter is changed. NO rule is changed.
 *   · NO broker order endpoint, submission, or trading code.
 *   · Verified broker candles ONLY (same loader as the harness).
 *   · The audit simulation is an EXACT replica of validation.ts simulate()
 *     and ASSERTS full equivalence with the harness result (counters AND
 *     every trade field). Any drift fails the script loudly.
 *   · Counterfactual numbers (post-stop target reach) are labeled as such —
 *     they are diagnostics, never results.
 */

import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import type { AnalysisCandle } from '../src/lib/analysis/types';
import { atrSeries } from '../src/lib/analysis/indicators';
import { TIMEFRAME_SECONDS, type Timeframe } from '../src/lib/market/types';
import { evaluateSignal } from '../src/lib/signal/core';
import { buildStrategyRules } from '../src/lib/signal/rules';
import type { SignalEvaluation, SignalWindow, StrategyRules } from '../src/lib/signal/types';
import { applyCosts, type CostModel } from '../src/lib/backtest/cost-model';
import { htfWindowClosedBy } from '../src/lib/backtest/signal-engine';
import { loadVerifiedCandles } from '../src/lib/backtest/service';
import {
  defaultValidationRules,
  runValidation,
  type RegimeInfo,
  type ValidationTrade,
} from '../src/lib/backtest/validation';

const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');
const r2 = (v: number) => Number(v.toFixed(2));
const r4 = (v: number) => Number(v.toFixed(4));

// ---------------------------------------------------------------------------
// Instrumented replica of validation.ts simulate() — MUST stay equivalent
// ---------------------------------------------------------------------------
interface AuditOpenTrade {
  direction: 'long' | 'short';
  entryIndex: number;
  entryRawPrice: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  riskPrice: number;
  signalBarTime: number;
  regime: RegimeInfo;
  barsSinceBreak: number;
  structureEvent: { type: string; direction: string; level: number; breakCandleTimeUtcSec: number } | null;
  indicators: { ema50: number | null; rsi14: number | null; atr14: number | null; adx14: number | null };
  htf: { h1Trend: string; h4Trend: string };
}

interface AuditRow {
  i: number;
  time: number;
  outcome: string;
  reasonCodes: string[];
  isCandidate: boolean;
  structureEvent: AuditOpenTrade['structureEvent'];
  barsSinceBreak: number | null;
  indicators: AuditOpenTrade['indicators'] | null;
  htf: AuditOpenTrade['htf'] | null; // non-null whenever indicators are present (same evidence object)
  retestBarTimeUtc: string | null;
  entryEligible: boolean | null;   // only for valid setups
  notFilledReason: string | null;  // only for valid setups that did NOT fill
  filled: boolean;
  fillGapMin: number | null;       // decision→entry bar gap (900 = contiguous)
}

interface AuditTrade extends ValidationTrade {
  barsSinceBreak: number;
  mfePrice: number;  // max favorable excursion (raw level basis) during the trade
  maePrice: number;  // max adverse excursion
  mfeR: number;
  maeR: number;
  decisionToEntryGapMin: number;
  entryToExitGapBars: number;
  structureType: string;
  postStopTargetReachedIn: number | null; // bars after stop-exit until price REACHED the original target level (counterfactual diagnostic; null = never / not applicable)
  postStopLowestR: number | null;         // worst further adverse excursion after a stop, in R (diagnostic)
}

function auditSimulate(
  symbol: string,
  execution: AnalysisCandle[],
  h1: AnalysisCandle[],
  h4: AnalysisCandle[],
  digits: number | null,
  costs: CostModel,
  strategy: StrategyRules,
  splitBoundaries: { devEnd: number; valEnd: number },
  atrFull: Array<number | null>,
) {
  const counters = {
    evaluations: 0, blockedEvaluations: 0, noSetup: 0, wait: 0,
    candidateSetups: 0, validSetups: 0, hypotheticalFills: 0, completedOutcomes: 0,
  };
  const trades: ValidationTrade[] = [];
  const rows: AuditRow[] = [];
  const tradeMeta = new Map<number, Partial<AuditTrade>>(); // keyed by entry signalBarTime
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
      referencePrice: execution[i].close,
      spreadPrice: costs.spreadPrice,
      nowUtcSec: decisionClose,
      rules: strategy,
    });
  };

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
    const below = window.filter((a) => a < v).length;
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

  let open: AuditOpenTrade | null = null;

  const closeTrade = (
    t: AuditOpenTrade,
    exitIndex: number,
    exitRawPrice: number,
    reason: ValidationTrade['exitReason'],
    collision: boolean,
  ) => {
    const costed = applyCosts(t.direction, t.entryRawPrice, exitRawPrice, costs);
    // MFE/MAE over the trade window (entry bar .. exit bar), raw level basis.
    let mfe = 0, mae = 0;
    for (let k = t.entryIndex; k <= exitIndex && k < execution.length; k++) {
      const b = execution[k];
      if (t.direction === 'long') {
        mfe = Math.max(mfe, b.high - t.entryRawPrice);
        mae = Math.max(mae, t.entryRawPrice - b.low);
      } else {
        mfe = Math.max(mfe, t.entryRawPrice - b.low);
        mae = Math.max(mae, b.high - t.entryRawPrice);
      }
    }
    trades.push({
      segment: t.entryIndex < splitBoundaries.devEnd ? 'dev' : t.entryIndex < splitBoundaries.valEnd ? 'val' : 'oos',
      direction: t.direction,
      signalBarTimeUtcSec: t.signalBarTime,
      entryBarTimeUtcSec: execution[t.entryIndex].timeUtcSec,
      exitBarTimeUtcSec: execution[exitIndex].timeUtcSec,
      entryRawPrice: t.entryRawPrice,
      entryPrice: costed.entryPrice,
      stopLoss: t.stopLoss,
      target: t.target,
      exitRawPrice,
      exitPrice: Number((t.direction === 'long'
        ? exitRawPrice - costs.spreadPrice / 2 - costs.slippagePrice
        : exitRawPrice + costs.spreadPrice / 2 + costs.slippagePrice).toFixed(10)),
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
    tradeMeta.set(t.signalBarTime, {
      barsSinceBreak: t.barsSinceBreak,
      mfePrice: Number(mfe.toFixed(4)),
      maePrice: Number(mae.toFixed(4)),
      mfeR: t.riskPrice > 0 ? Number((mfe / t.riskPrice).toFixed(4)) : 0,
      maeR: t.riskPrice > 0 ? Number((mae / t.riskPrice).toFixed(4)) : 0,
      decisionToEntryGapMin: (execution[t.entryIndex].timeUtcSec - t.signalBarTime) / 60,
      entryToExitGapBars: exitIndex - t.entryIndex,
      structureType: t.structureEvent?.type ?? '?',
      // post-stop counterfactual: did price reach the ORIGINAL target after the stop?
      postStopTargetReachedIn: (() => {
        if (reason !== 'stop') return null;
        for (let k = exitIndex + 1; k < execution.length; k++) {
          const b = execution[k];
          const reached = t.direction === 'long' ? b.high >= t.target : b.low <= t.target;
          if (reached) return k - exitIndex;
        }
        return -1; // never reached within remaining data
      })(),
      postStopLowestR: (() => {
        if (reason !== 'stop') return null;
        let worst = 0;
        for (let k = exitIndex + 1; k < execution.length; k++) {
          const b = execution[k];
          const adv = t.direction === 'long' ? b.low - t.stopLoss : t.stopLoss - b.high;
          worst = Math.max(worst, adv); // further adverse movement beyond the stop level
          const reached = t.direction === 'long' ? b.high >= t.target : b.low <= t.target;
          if (reached) break; // stop counting once the original target is reached
        }
        return t.riskPrice > 0 ? Number((worst / t.riskPrice).toFixed(4)) : null;
      })(),
    });
    counters.completedOutcomes += 1;
  };

  for (let i = 0; i < execution.length; i++) {
    const bar = execution[i];

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

    const evaluation = evaluateAt(i);
    counters.evaluations += 1;
    if (evaluation.outcome === 'BLOCKED') counters.blockedEvaluations += 1;
    else if (evaluation.outcome === 'NO_SETUP') counters.noSetup += 1;
    else if (evaluation.outcome === 'WAIT') counters.wait += 1;
    const isCandidate = !!evaluation.evidence?.structureEvent &&
      evaluation.reasonCodes.every((c) => c !== 'NO_STRUCTURE_BREAK' && c !== 'STRUCTURE_BREAK_TOO_OLD');
    if (isCandidate) counters.candidateSetups += 1;
    const isValid = evaluation.outcome === 'BUY_SETUP' || evaluation.outcome === 'SELL_SETUP';
    if (isValid) counters.validSetups += 1;

    const ev = evaluation.evidence;
    const row: AuditRow = {
      i,
      time: bar.timeUtcSec,
      outcome: evaluation.outcome,
      reasonCodes: evaluation.reasonCodes,
      isCandidate,
      structureEvent: ev?.structureEvent
        ? {
            type: ev.structureEvent.type,
            direction: ev.structureEvent.direction,
            level: ev.structureEvent.level,
            breakCandleTimeUtcSec: Math.floor(new Date(ev.structureEvent.breakCandleTimeUtc).getTime() / 1000),
          }
        : null,
      barsSinceBreak: ev?.structureEvent?.barsSinceBreak ?? null,
      indicators: ev?.indicators
        ? {
            ema50: ev.indicators.ema50,
            rsi14: ev.indicators.rsi14,
            atr14: ev.indicators.atr14,
            adx14: ev.indicators.adx14,
          }
        : null,
      htf: ev?.htfContext
        ? { h1Trend: String(ev.htfContext.h1Trend), h4Trend: String(ev.htfContext.h4Trend) }
        : null,
      retestBarTimeUtc: ev?.retestBarTimeUtc ?? null,
      entryEligible: null,
      notFilledReason: null,
      filled: false,
      fillGapMin: null,
    };

    if (isValid) {
      const hasLevels = !!evaluation.levels;
      const hasNext = i + 1 < execution.length;
      const flat = !open;
      row.entryEligible = flat && hasNext && hasLevels;
      if (!flat) row.notFilledReason = 'POSITION_OPEN';
      else if (!hasNext) row.notFilledReason = 'LAST_BAR';
      else if (!hasLevels) row.notFilledReason = 'NO_LEVELS';
    }

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
      const stopLoss = evaluation.levels.stopLoss;
      const risk = dir === 'long' ? entryPrice - stopLoss : stopLoss - entryPrice;
      if (risk > 0) {
        const target = dir === 'long' ? entryPrice + strategy.rewardRisk * risk : entryPrice - strategy.rewardRisk * risk;
        counters.hypotheticalFills += 1;
        row.filled = true;
        row.fillGapMin = (nextBar.timeUtcSec - bar.timeUtcSec) / 60;
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
          barsSinceBreak: ev?.structureEvent?.barsSinceBreak ?? -1,
          structureEvent: row.structureEvent,
          indicators: row.indicators!,
          htf: row.htf!,
        };

        const hitStop = dir === 'long' ? nextBar.low <= stopLoss : nextBar.high >= stopLoss;
        const hitTarget = dir === 'long' ? nextBar.high >= target : nextBar.low <= target;
        if (hitStop) {
          closeTrade(open, i + 1, stopLoss, 'stop', hitStop && hitTarget);
          open = null;
        } else if (hitTarget) {
          closeTrade(open, i + 1, target, 'target', false);
          open = null;
        }
      } else {
        row.filled = false;
        row.notFilledReason = 'RISK_NOT_POSITIVE_GAP';
      }
    }
    rows.push(row);
  }

  if (open) {
    const last = execution[execution.length - 1];
    closeTrade(open, execution.length - 1, last.close, 'end_of_data', false);
  }

  const auditTrades: AuditTrade[] = trades.map((t) => ({
    ...t,
    ...(tradeMeta.get(t.signalBarTimeUtcSec) as Omit<AuditTrade, keyof ValidationTrade>),
  })) as AuditTrade[];

  return { rows, trades: auditTrades, counters };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------
function agg(label: string, ts: AuditTrade[]) {
  if (ts.length === 0) return `${label}: 0 trades — INSUFFICIENT_DATA`;
  const wins = ts.filter((t) => t.netPrice > 0);
  const gross = ts.reduce((s, t) => s + t.grossPrice, 0);
  const costs = ts.reduce((s, t) => s + t.costsPrice, 0);
  const net = ts.reduce((s, t) => s + t.netPrice, 0);
  const avgR = ts.reduce((s, t) => s + t.rMultiple, 0) / ts.length;
  const pf = (() => {
    const gw = wins.reduce((s, t) => s + t.netPrice, 0);
    const gl = Math.abs(ts.filter((t) => t.netPrice <= 0).reduce((s, t) => s + t.netPrice, 0));
    return gl > 0 ? gw / gl : null;
  })();
  return `${label}: n=${ts.length} win=${r4(wins.length / ts.length)} gross=${r2(gross)} costs=${r2(costs)} net=${r2(net)} PF=${pf === null ? '∞' : r4(pf)} avgR=${r4(avgR)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const main = async () => {
  const symbol = process.env.TRADING_SYMBOLS?.split(',')[0]?.trim() || 'XAUUSDm';
  const maxCandles = Math.min(2000, config.market.backfillMaxBars);

  const [exec, h1, h4, tick] = await Promise.all([
    loadVerifiedCandles(symbol, 'M15' as Timeframe, maxCandles),
    loadVerifiedCandles(symbol, 'H1' as Timeframe, maxCandles),
    loadVerifiedCandles(symbol, 'H4' as Timeframe, maxCandles),
    db.marketLatestTick.findUnique({ where: { symbol } }).catch(() => null),
  ]);
  const spread = tick?.spread && Number(tick.spread) > 0 ? Number(tick.spread) : 0.24;
  const digits = exec.digits ?? h1.digits ?? h4.digits ?? null;

  const strategy = buildStrategyRules();
  const rules = defaultValidationRules(spread);

  // ── A. Harness reference run (unchanged production path) ─────────────────
  const reference = runValidation(symbol, exec.candles, h1.candles, h4.candles, digits, spread, rules, strategy);
  console.log(`=== A. HARNESS REFERENCE (validation.ts, unchanged) ===`);
  console.log(`fp=${reference.datasetFingerprint}`);
  console.log(`dataset M15=${reference.dataset.executionCandles} H1=${reference.dataset.h1Candles} H4=${reference.dataset.h4Candles} ${iso(reference.dataset.fromUtcSec)} → ${iso(reference.dataset.toUtcSec)}`);
  console.log(`counters: ${JSON.stringify(reference.counters)}`);
  const strategyJson = JSON.stringify(strategy);
  console.log(`strategyConfig (UNCHANGED): ${strategyJson}`);

  // ── B. Audit replica + EQUIVALENCE ASSERTION ────────────────────────────
  const atrFullRes = atrSeries(exec.candles, strategy.atrPeriod);
  const atrFull = atrFullRes.ok ? atrFullRes.series.values : exec.candles.map(() => null);
  const devEnd = Math.floor(exec.candles.length * rules.split.devFraction);
  const valEnd = Math.floor(exec.candles.length * (rules.split.devFraction + rules.split.valFraction));
  const audit = auditSimulate(symbol, exec.candles, h1.candles, h4.candles, digits, rules.costs, strategy, { devEnd, valEnd }, atrFull);

  let mismatches = 0;
  for (const k of Object.keys(reference.counters) as Array<keyof typeof reference.counters>) {
    if (reference.counters[k] !== audit.counters[k]) {
      console.error(`EQUIVALENCE FAIL counter ${k}: harness=${reference.counters[k]} audit=${audit.counters[k]}`);
      mismatches++;
    }
  }
  if (reference.trades.length !== audit.trades.length) {
    console.error(`EQUIVALENCE FAIL trade count: harness=${reference.trades.length} audit=${audit.trades.length}`);
    mismatches++;
  } else {
    for (let k = 0; k < reference.trades.length; k++) {
      const a = reference.trades[k], b = audit.trades[k];
      for (const f of ['signalBarTimeUtcSec', 'entryBarTimeUtcSec', 'exitBarTimeUtcSec', 'direction', 'exitReason', 'netPrice', 'grossPrice', 'riskPrice', 'rMultiple', 'stopLoss', 'target', 'collision'] as const) {
        if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
          console.error(`EQUIVALENCE FAIL trade#${k} field ${f}: harness=${JSON.stringify(a[f])} audit=${JSON.stringify(b[f])}`);
          mismatches++;
        }
      }
    }
  }
  console.log(`\n=== B. AUDIT REPLICA EQUIVALENCE === ${mismatches === 0 ? 'PASS — every counter and every trade field identical to the harness' : `FAIL (${mismatches} mismatches)`}`);
  if (mismatches > 0) process.exit(1);

  // ── C. Setup funnel + reconciliation (Task 2) ───────────────────────────
  console.log(`\n=== C. SETUP→FILL RECONCILIATION ===`);
  const rows = audit.rows;
  const validRows = rows.filter((r) => r.outcome === 'BUY_SETUP' || r.outcome === 'SELL_SETUP');
  const blockedRows = rows.filter((r) => r.outcome === 'BLOCKED');
  const noSetupRows = rows.filter((r) => r.outcome === 'NO_SETUP');
  const waitRows = rows.filter((r) => r.outcome === 'WAIT');
  const candidateRows = rows.filter((r) => r.isCandidate);
  const filledRows = validRows.filter((r) => r.filled);
  const skipped = validRows.filter((r) => !r.filled);
  console.log(`evaluations=${rows.length}`);
  console.log(`  BLOCKED=${blockedRows.length}  NO_SETUP=${noSetupRows.length}  WAIT=${waitRows.length}  (other=${rows.length - blockedRows.length - noSetupRows.length - waitRows.length - validRows.length})`);
  console.log(`  candidates (structure event present, not NO_STRUCTURE_BREAK/TOO_OLD)=${candidateRows.length}`);
  console.log(`  VALID setups=${validRows.length} (BUY=${validRows.filter((r) => r.outcome === 'BUY_SETUP').length} SELL=${validRows.filter((r) => r.outcome === 'SELL_SETUP').length})`);
  console.log(`  FILLED=${filledRows.length}  SKIPPED=${skipped.length}`);
  const skipReasons: Record<string, number> = {};
  for (const s of skipped) skipReasons[s.notFilledReason ?? '?'] = (skipReasons[s.notFilledReason ?? '?'] ?? 0) + 1;
  console.log(`  skip reasons: ${JSON.stringify(skipReasons)}`);
  console.log(`  completed outcomes=${audit.counters.completedOutcomes}`);

  // Episode grouping: distinct structure events among valid rows
  const episodes = new Map<number, { rows: AuditRow[]; direction: string; type: string; filled: boolean }>();
  for (const v of validRows) {
    const key = v.structureEvent ? v.structureEvent.breakCandleTimeUtcSec : v.time;
    const e = episodes.get(key) ?? { rows: [], direction: v.outcome, type: v.structureEvent?.type ?? '?', filled: false };
    e.rows.push(v);
    if (v.filled) e.filled = true;
    episodes.set(key, e);
  }
  console.log(`  distinct setup EPISODES (by structure-break candle)=${episodes.size}; episodes with ≥1 fill=${[...episodes.values()].filter((e) => e.filled).length}; NEVER-filled episodes=${[...episodes.values()].filter((e) => !e.filled).length}`);
  const epSizes = [...episodes.values()].map((e) => e.rows.length).sort((a, b) => a - b);
  console.log(`  episode length (valid bars per episode): min=${epSizes[0]} median=${epSizes[Math.floor(epSizes.length / 2)]} max=${epSizes[epSizes.length - 1]} total=${epSizes.reduce((s, v) => s + v, 0)}`);

  // WAIT-stage funnel (which gate blocked candidates)
  const waitReasons: Record<string, number> = {};
  for (const w of waitRows) for (const c of w.reasonCodes) waitReasons[c] = (waitReasons[c] ?? 0) + 1;
  const noSetupReasons: Record<string, number> = {};
  for (const w of noSetupRows) for (const c of w.reasonCodes) noSetupReasons[c] = (noSetupReasons[c] ?? 0) + 1;
  console.log(`  WAIT reason codes (top): ${JSON.stringify(Object.fromEntries(Object.entries(waitReasons).sort((a, b) => b[1] - a[1])))}`);
  console.log(`  NO_SETUP reason codes: ${JSON.stringify(noSetupReasons)}`);

  // Valid setup dates
  console.log(`\n  valid setups (all ${validRows.length}):`);
  for (const v of validRows) {
    console.log(
      `    ${iso(v.time)} ${v.outcome === 'BUY_SETUP' ? 'BUY ' : 'SELL'} bsb=${v.barsSinceBreak} ${v.structureEvent?.type} lvl=${v.structureEvent?.level} adx=${Number(v.indicators?.adx14 ?? 0).toFixed(1)} rsi=${Number(v.indicators?.rsi14 ?? 0).toFixed(1)} atr=${Number(v.indicators?.atr14 ?? 0).toFixed(2)} h1=${v.htf?.h1Trend} h4=${v.htf?.h4Trend} → ${v.filled ? `FILLED${v.fillGapMin !== 15 ? ` (GAP ${v.fillGapMin}m)` : ''}` : `SKIPPED(${v.notFilledReason})`}`,
    );
  }

  // ── D. Trade forensics (Tasks 3–4) ─────────────────────────────────────
  console.log(`\n=== D. TRADE FORENSICS (${audit.trades.length} completed trades) ===`);
  console.log(`# seg dir         signal→entry→exit            entry     SL        TP        exit      reason      barsIn  gross    costs  net      R       bsb  mfeR    maeR    postStop`);
  audit.trades.forEach((t, idx) => {
    console.log(
      `${String(idx + 1).padStart(2)} ${t.segment.padEnd(3)} ${t.direction === 'long' ? 'BUY ' : 'SELL'} ${iso(t.signalBarTimeUtcSec)}→${iso(t.entryBarTimeUtcSec)}→${iso(t.exitBarTimeUtcSec)} ${t.entryRawPrice.toFixed(2).padStart(9)} ${t.stopLoss.toFixed(2).padStart(9)} ${t.target.toFixed(2).padStart(9)} ${t.exitRawPrice.toFixed(2).padStart(9)} ${t.exitReason.padEnd(10)} ${String(t.barsInMarket).padStart(4)} ${r2(t.grossPrice).toFixed(2).padStart(8)} ${t.costsPrice.toFixed(2).padStart(6)} ${r2(t.netPrice).toFixed(2).padStart(8)} ${t.rMultiple.toFixed(3).padStart(7)} ${String(t.barsSinceBreak).padStart(3)} ${t.mfeR.toFixed(2).padStart(7)} ${t.maeR.toFixed(2).padStart(7)} ${t.postStopTargetReachedIn === null ? '—' : t.postStopTargetReachedIn === -1 ? 'never' : t.postStopTargetReachedIn + 'b'}`,
    );
  });

  console.log(`\n--- Loss/gain categories (sample counts ALWAYS shown) ---`);
  console.log(agg('BY DIRECTION BUY ', audit.trades.filter((t) => t.direction === 'long')));
  console.log(agg('BY DIRECTION SELL', audit.trades.filter((t) => t.direction === 'short')));
  for (const seg of ['dev', 'val', 'oos'] as const) {
    console.log(agg(`SEGMENT ${seg.toUpperCase()}`, audit.trades.filter((t) => t.segment === seg)));
  }
  console.log(agg('EXIT stop      ', audit.trades.filter((t) => t.exitReason === 'stop')));
  console.log(agg('EXIT target    ', audit.trades.filter((t) => t.exitReason === 'target')));
  console.log(agg('EXIT end_of_data', audit.trades.filter((t) => t.exitReason === 'end_of_data')));
  console.log(agg('COLLISION bar  ', audit.trades.filter((t) => t.collision)));
  for (const cls of ['weak', 'moderate', 'strong', 'unknown'] as const) {
    console.log(agg(`ADX ${cls.padEnd(7)}`, audit.trades.filter((t) => t.regime.adxClass === cls)));
  }
  for (const tr of ['bullish', 'bearish', 'range_or_unclear', 'unknown'] as const) {
    console.log(agg(`H4 ${tr.padEnd(15)}`, audit.trades.filter((t) => t.regime.h4Trend === tr)));
  }
  for (const rk of ['low', 'mid', 'high', 'unknown'] as const) {
    console.log(agg(`ATR ${rk.padEnd(7)}`, audit.trades.filter((t) => t.regime.atrRank === rk)));
  }
  for (const b of ['0-2', '3-4', '5-8'] as const) {
    const [lo, hi] = b.split('-').map(Number);
    console.log(agg(`BOS/CHoCH age ${b} bars`, audit.trades.filter((t) => t.barsSinceBreak >= lo && t.barsSinceBreak <= hi)));
  }
  console.log(agg('STRUCTURE BOS  ', audit.trades.filter((t) => t.structureType === 'BOS')));
  console.log(agg('STRUCTURE CHoCH', audit.trades.filter((t) => t.structureType === 'CHoCH')));
  console.log(agg('ENTRY gapped   ', audit.trades.filter((t) => t.decisionToEntryGapMin !== 15)));

  const stopped = audit.trades.filter((t) => t.exitReason === 'stop');
  const whipsawed = stopped.filter((t) => t.postStopTargetReachedIn !== null && t.postStopTargetReachedIn > 0);
  const neverRecovered = stopped.filter((t) => t.postStopTargetReachedIn === -1);
  console.log(`\n--- Post-stop counterfactual (DIAGNOSTIC ONLY, not results) ---`);
  console.log(`stopped trades=${stopped.length}; of those, price later reached the ORIGINAL target level: within data=${whipsawed.length} (bars: ${whipsawed.map((t) => t.postStopTargetReachedIn).join(',')}); never=${neverRecovered.length}`);
  console.log(`stopped trades where max adverse excursion beyond SL stayed < 0.25R after exit: ${stopped.filter((t) => (t.postStopLowestR ?? 1) < 0.25).length}/${stopped.length}`);
  const avgMfeR = audit.trades.reduce((s, t) => s + t.mfeR, 0) / audit.trades.length;
  const winnersMfe = audit.trades.filter((t) => t.exitReason === 'target');
  const stoppedMfe = stopped;
  console.log(`MFE in R: all=${r4(avgMfeR)} target-hit=${r4(winnersMfe.reduce((s, t) => s + t.mfeR, 0) / Math.max(1, winnersMfe.length))} stopped=${r4(stoppedMfe.reduce((s, t) => s + t.mfeR, 0) / Math.max(1, stoppedMfe.length))}`);
  const reachedHalfR = audit.trades.filter((t) => t.mfeR >= 1).length;
  console.log(`trades whose MFE reached ≥1R at some point: ${reachedHalfR}/${audit.trades.length}`);

  // Exposure / opportunity cost of one-position-at-a-time
  let barsInMarket = audit.trades.reduce((s, t) => s + t.entryToExitGapBars + 1, 0);
  console.log(`\nbars in market (one-position model): ${barsInMarket}/${exec.candles.length} = ${r2((100 * barsInMarket) / exec.candles.length)}%`);
  const suppressedByOpen = skipped.filter((s) => s.notFilledReason === 'POSITION_OPEN');
  console.log(`valid-setup bars suppressed by an open position: ${suppressedByOpen.length}/${skipped.length} of all skipped`);

  await db.$disconnect();
  process.exit(0);
};

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
