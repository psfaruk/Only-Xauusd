/**
 * XAUUSD AI Trading Agent — Signal Evaluation Core (Phase 9, Task B)
 * ----------------------------------------------------------------------------
 * PURE and DETERMINISTIC. No database, no network, no clock reads (the
 * evaluation instant is an explicit input), no LLM. The LIVE service and the
 * BACKTEST both call this ONE implementation — the strategy can never drift
 * between them.
 *
 * Causality (no look-ahead) — by construction:
 *   · Only CLOSED candles enter (windows are ascending closed bars; the
 *     decision bar's close instant must be <= the evaluation instant).
 *   · Swings activate only at their confirmation candle (Phase 4 semantics).
 *   · Structure breaks confirm only on CLOSE (wick crossings never count).
 *   · Indicators are recursive past-only series evaluated at the decision bar.
 *   · Higher-timeframe windows contain only bars CLOSED before the decision
 *     bar's close instant.
 *
 * Fail-closed: any data gate failure → BLOCKED with reason codes and NO
 * levels. Strategy rejections → WAIT / NO_SETUP with reasons. Levels exist
 * ONLY on BUY_SETUP / SELL_SETUP outcomes.
 */

import { createHash } from 'node:crypto';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import { toCanonicalPrice } from '@/lib/market/validation';
import { detectSwings } from '@/lib/analysis/swings';
import { pairLabel, scanStructureEvents, trendFromLabels } from '@/lib/analysis/structure';
import { adxSeries, atrSeries, emaSeries, rsiSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle, BreachEvent, StructuralTrend, SwingPoint } from '@/lib/analysis/types';
import {
  SIGNAL_ENGINE_VERSION,
  SIGNAL_STRATEGY_VERSION,
  type SignalCoreInput,
  type SignalEvaluation,
  type SignalEvidence,
  type SignalLevels,
  type SignalReasonCode,
  type SignalWindow,
  type StrategyRules,
} from './types';

// ---------------------------------------------------------------------------
// Fingerprint — sha256 over canonical input + rules + engine version
// ---------------------------------------------------------------------------

export function computeSignalFingerprint(input: SignalCoreInput): string {
  const win = (w: SignalWindow) => ({
    tf: w.timeframe,
    source: w.source,
    candles: w.candles.map((c) => [c.timeUtcSec, c.openText, c.highText, c.lowText, c.closeText]),
  });
  const payload = {
    engineVersion: SIGNAL_ENGINE_VERSION,
    strategyVersion: input.rules.strategyVersion,
    symbol: input.symbol,
    digits: input.digits,
    referencePrice: input.referencePrice,
    spreadPrice: input.spreadPrice,
    nowUtcSec: input.nowUtcSec,
    rules: input.rules,
    execution: win(input.execution),
    h1: win(input.h1),
    h4: win(input.h4),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Dataset fingerprint over the execution-TF window (comparison with backtests). */
export function computeDatasetFingerprint(symbol: string, window: SignalWindow): string {
  const h = createHash('sha256');
  h.update(`${symbol}|${window.timeframe}|${window.candles.length}`);
  for (const c of window.candles) {
    h.update(`|${c.timeUtcSec},${c.openText},${c.highText},${c.lowText},${c.closeText}`);
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Window validation (data gates)
// ---------------------------------------------------------------------------

function isAscending(candles: AnalysisCandle[]): boolean {
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].timeUtcSec <= candles[i - 1].timeUtcSec) return false;
  }
  return true;
}

function pricesFinite(candles: AnalysisCandle[]): boolean {
  return candles.every((c) =>
    [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close) &&
    c.high >= c.low,
  );
}

interface WindowGate {
  ok: boolean;
  codes: SignalReasonCode[];
}

function gateWindow(
  w: SignalWindow,
  tfSec: number,
  minBars: number,
  insufficientCode: SignalReasonCode,
): WindowGate {
  const codes: SignalReasonCode[] = [];
  if (!w.candles.length) {
    codes.push('DATA_MISSING', insufficientCode);
    return { ok: false, codes };
  }
  if (!isAscending(w.candles)) codes.push('CHRONOLOGY_BROKEN', 'DATA_INVALID');
  if (!pricesFinite(w.candles)) codes.push('DATA_INVALID');
  if (w.candles.length < minBars) codes.push(insufficientCode, 'INSUFFICIENT_DATA');
  return { ok: codes.length === 0, codes };
}

// ---------------------------------------------------------------------------
// Causal higher-timeframe trend (Phase 4 activation semantics, windowed)
// ---------------------------------------------------------------------------

/**
 * Trend classification of a CLOSED higher-timeframe window, as knowable at
 * `asOfUtcSec`: walks the window's bars with the same activation-pointer
 * logic as scanStructureEvents (a swing becomes known at the close of candle
 * index+right) and classifies from the last two confirmed swings of each
 * side (pairLabel + trendFromLabels — the exported Phase 4 primitives).
 */
export function causalTrendAt(
  window: SignalWindow,
  swingLeft: number,
  swingRight: number,
  asOfUtcSec: number,
): StructuralTrend | null {
  const tfSec = TIMEFRAME_SECONDS[window.timeframe];
  const candles = window.candles;
  if (!candles.length) return null;

  // Confirm the window itself only contains bars closed by asOfUtcSec.
  const usable = candles.filter((c) => c.timeUtcSec + tfSec <= asOfUtcSec);
  if (!usable.length) return null;

  const det = detectSwings(usable, { left: swingLeft, right: swingRight, tfSec, digits: null });
  const byConfirm = [...det.swings].sort(
    (a, b) => a.index + swingRight - (b.index + swingRight) || a.index - b.index,
  );

  let ptr = 0;
  const lastTwoHighs: SwingPoint[] = [];
  const lastTwoLows: SwingPoint[] = [];
  let trend: StructuralTrend = 'unclear';

  for (let c = 0; c < usable.length; c++) {
    while (ptr < byConfirm.length && byConfirm[ptr].index + swingRight <= c) {
      const s = byConfirm[ptr];
      ptr += 1;
      if (s.kind === 'high') {
        lastTwoHighs.push(s);
        if (lastTwoHighs.length > 2) lastTwoHighs.shift();
      } else {
        lastTwoLows.push(s);
        if (lastTwoLows.length > 2) lastTwoLows.shift();
      }
      trend = trendFromLabels(
        pairLabel(lastTwoHighs[0], lastTwoHighs[1]),
        pairLabel(lastTwoLows[0], lastTwoLows[1]),
      );
    }
  }
  return trend;
}

// ---------------------------------------------------------------------------
// Level derivation (ONE implementation — used by live core AND backtest)
// ---------------------------------------------------------------------------

export interface DerivedLevels {
  ok: boolean;
  levels: SignalLevels | null;
  code: SignalReasonCode | null;
}

/**
 * Spread-aware level math. entryRef = reference ± half-spread (BUY pays the
 * ask side). SL anchors at the anchor swing ± ATR buffer. Target = fixed R
 * multiple of the ACTUAL risk. Ordering is validated — a broken ordering
 * NEVER produces levels.
 */
export function deriveLevels(
  direction: 'BUY' | 'SELL',
  anchorSwingPrice: number,
  atr: number,
  referencePrice: number,
  halfSpread: number,
  zoneLow: number,
  zoneHigh: number,
  digits: number | null,
  rules: StrategyRules,
): DerivedLevels {
  const entryRef = direction === 'BUY' ? referencePrice + halfSpread : referencePrice - halfSpread;
  const buffer = rules.slAtrBuffer * atr;
  const stopLoss = direction === 'BUY' ? anchorSwingPrice - buffer : anchorSwingPrice + buffer;
  const risk = direction === 'BUY' ? entryRef - stopLoss : stopLoss - entryRef;
  if (!(risk > 0)) return { ok: false, levels: null, code: 'LEVEL_CALC_INVALID' };
  const target = direction === 'BUY' ? entryRef + rules.rewardRisk * risk : entryRef - rules.rewardRisk * risk;
  const reward = direction === 'BUY' ? target - entryRef : entryRef - target;

  // Strict ordering (BUY: SL < zoneLow <= entryRef < target; SELL mirrored).
  const ordered =
    direction === 'BUY'
      ? stopLoss < zoneLow && entryRef > zoneLow && entryRef < target && target > zoneLow
      : stopLoss > zoneHigh && entryRef < zoneHigh && entryRef > target && target < zoneHigh;
  if (!ordered || !Number.isFinite(target) || !Number.isFinite(stopLoss)) {
    return { ok: false, levels: null, code: 'LEVEL_CALC_INVALID' };
  }

  const fmt = (v: number) => toCanonicalPrice(v, digits).text;
  return {
    ok: true,
    code: null,
    levels: {
      direction,
      entryZoneLow: zoneLow,
      entryZoneHigh: zoneHigh,
      entryReference: entryRef,
      stopLoss,
      target,
      riskPrice: risk,
      rewardPrice: reward,
      rewardRiskRatio: risk > 0 ? Number((reward / risk).toFixed(6)) : 0,
      entryZoneLowText: fmt(zoneLow),
      entryZoneHighText: fmt(zoneHigh),
      stopLossText: fmt(stopLoss),
      targetText: fmt(target),
      entryReferenceText: fmt(entryRef),
    },
  };
}

// ---------------------------------------------------------------------------
// The evaluation core
// ---------------------------------------------------------------------------

const EXEC_TF_SEC = TIMEFRAME_SECONDS.M15;

export function evaluateSignal(input: SignalCoreInput): SignalEvaluation {
  const rules = input.rules;
  const fingerprint = computeSignalFingerprint(input);
  const iso = (sec: number) => new Date(sec * 1000).toISOString();

  const blocked = (codes: SignalReasonCode[], evidence: SignalEvidence | null = null): SignalEvaluation => ({
    engineVersion: SIGNAL_ENGINE_VERSION,
    strategyVersion: SIGNAL_STRATEGY_VERSION,
    symbol: input.symbol,
    purpose: 'research-signal-not-an-execution-instruction',
    outcome: 'BLOCKED',
    reasonCodes: [...new Set(codes)],
    decisionCandleTimeUtc: null,
    setupKnownAtUtc: null,
    expiryUtc: null,
    levels: null,
    evidence,
    inputFingerprint: fingerprint,
    datasetFingerprint: null,
    generatedAtUtc: iso(input.nowUtcSec),
  });

  // ── Gate 0: symbol spec ─────────────────────────────────────────────────
  if (input.digits === null || !Number.isInteger(input.digits) || input.digits < 0) {
    return blocked(['SPEC_MISSING']);
  }

  // ── Gate 1: numeric inputs ──────────────────────────────────────────────
  if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0) {
    return blocked(['DATA_INVALID']);
  }
  if (!Number.isFinite(input.spreadPrice) || input.spreadPrice < 0) {
    return blocked(['SPREAD_INVALID']);
  }

  // ── Gate 2: window shape, chronology, warm-up, H4 coverage ─────────────
  const execGate = gateWindow(input.execution, EXEC_TF_SEC, rules.minExecutionBars, 'INSUFFICIENT_DATA');
  const h1Gate = gateWindow(input.h1, TIMEFRAME_SECONDS.H1, rules.minH1Bars, 'INSUFFICIENT_H1_HISTORY');
  const h4Gate = gateWindow(input.h4, TIMEFRAME_SECONDS.H4, rules.minH4Bars, 'INSUFFICIENT_H4_HISTORY');
  const gateCodes = [...execGate.codes, ...h1Gate.codes, ...h4Gate.codes];
  if (gateCodes.length > 0) {
    return blocked(gateCodes);
  }

  // ── Gate 3: forming-candle protection ───────────────────────────────────
  const exec = input.execution.candles;
  const decision = exec[exec.length - 1];
  const decisionIdx = exec.length - 1;
  const decisionCloseSec = decision.timeUtcSec + EXEC_TF_SEC;
  if (decisionCloseSec > input.nowUtcSec) {
    return blocked(['FORMING_CANDLE_IN_INPUT', 'DATA_INVALID']);
  }

  // ── Gate 4: demo/synthetic source policy ────────────────────────────────
  const src = (input.execution.source ?? '').toLowerCase();
  if (src.includes('demo')) {
    return blocked(['SOURCE_DEMO', 'SOURCE_NOT_BROKER']);
  }

  // ── Causal computations on the execution window ────────────────────────
  const swingDet = detectSwings(exec, {
    left: rules.swingLeft,
    right: rules.swingRight,
    tfSec: EXEC_TF_SEC,
    digits: input.digits,
  });
  const structure = scanStructureEvents(exec, swingDet.swings, {
    swingLeft: rules.swingLeft,
    swingRight: rules.swingRight,
    tfSec: EXEC_TF_SEC,
    digits: input.digits,
  });

  const closes = exec.map((c) => c.close);
  const ema = emaSeries(closes, rules.emaPeriod);
  const rsi = rsiSeries(closes, rules.rsiPeriod);
  const atr = atrSeries(exec, rules.atrPeriod);
  const adx = adxSeries(exec, rules.adxPeriod);
  if (!ema.ok || !rsi.ok || !atr.ok || !adx.ok) {
    return blocked(['INDICATOR_WARMUP', 'INSUFFICIENT_DATA']);
  }
  const emaVal = ema.series.values[decisionIdx];
  const rsiVal = rsi.series.values[decisionIdx];
  const atrVal = atr.series.values[decisionIdx];
  const adxVal = adx.series.values[decisionIdx];
  if (
    emaVal === null || rsiVal === null || atrVal === null || adxVal === null ||
    !Number.isFinite(emaVal) || !Number.isFinite(rsiVal) || !Number.isFinite(atrVal) || !Number.isFinite(adxVal) ||
    atrVal <= 0
  ) {
    return blocked(['INDICATOR_WARMUP', 'DATA_INVALID']);
  }

  // ── Higher-timeframe context (causal, as-of the decision close) ────────
  const h1Trend = causalTrendAt(input.h1, rules.swingLeft, rules.swingRight, decisionCloseSec);
  const h4Trend = causalTrendAt(input.h4, rules.swingLeft, rules.swingRight, decisionCloseSec);

  const baseEvidence: SignalEvidence = {
    structureEvent: null,
    anchorSwing: null,
    indicators: { ema50: emaVal, rsi14: rsiVal, atr14: atrVal, adx14: adxVal },
    htfContext: { h1Trend, h4Trend },
    decisionClose: decision.close,
    retestBarTimeUtc: null,
    executionWindow: {
      fromUtc: iso(exec[0].timeUtcSec),
      toUtc: iso(decision.timeUtcSec),
      bars: exec.length,
    },
    h1Window: {
      fromUtc: iso(input.h1.candles[0].timeUtcSec),
      toUtc: iso(input.h1.candles[input.h1.candles.length - 1].timeUtcSec),
      bars: input.h1.candles.length,
    },
    h4Window: {
      fromUtc: iso(input.h4.candles[0].timeUtcSec),
      toUtc: iso(input.h4.candles[input.h4.candles.length - 1].timeUtcSec),
      bars: input.h4.candles.length,
    },
  };

  const wait = (codes: SignalReasonCode[], evidence: SignalEvidence): SignalEvaluation => ({
    engineVersion: SIGNAL_ENGINE_VERSION,
    strategyVersion: SIGNAL_STRATEGY_VERSION,
    symbol: input.symbol,
    purpose: 'research-signal-not-an-execution-instruction',
    outcome: 'WAIT',
    reasonCodes: [...new Set(codes)],
    decisionCandleTimeUtc: iso(decision.timeUtcSec),
    setupKnownAtUtc: iso(decisionCloseSec),
    expiryUtc: null,
    levels: null,
    evidence,
    inputFingerprint: fingerprint,
    datasetFingerprint: computeDatasetFingerprint(input.symbol, input.execution),
    generatedAtUtc: iso(input.nowUtcSec),
  });

  const noSetup = (codes: SignalReasonCode[], evidence: SignalEvidence): SignalEvaluation => ({
    engineVersion: SIGNAL_ENGINE_VERSION,
    strategyVersion: SIGNAL_STRATEGY_VERSION,
    symbol: input.symbol,
    purpose: 'research-signal-not-an-execution-instruction',
    outcome: 'NO_SETUP',
    reasonCodes: [...new Set(codes)],
    decisionCandleTimeUtc: iso(decision.timeUtcSec),
    setupKnownAtUtc: iso(decisionCloseSec),
    expiryUtc: null,
    levels: null,
    evidence,
    inputFingerprint: fingerprint,
    datasetFingerprint: computeDatasetFingerprint(input.symbol, input.execution),
    generatedAtUtc: iso(input.nowUtcSec),
  });

  // ── Strategy step 1: the most recent confirmed break ───────────────────
  const eventsUpToDecision = structure.events.filter(
    (e) => e.breakCandleTimeUtcSec <= decision.timeUtcSec,
  );
  if (eventsUpToDecision.length === 0) {
    return noSetup(['NO_STRUCTURE_BREAK'], baseEvidence);
  }
  const event = eventsUpToDecision[eventsUpToDecision.length - 1] as BreachEvent;
  const breakIdx = exec.findIndex((c) => c.timeUtcSec === event.breakCandleTimeUtcSec);
  if (breakIdx < 0) {
    return noSetup(['NO_STRUCTURE_BREAK'], baseEvidence);
  }
  const barsSinceBreak = decisionIdx - breakIdx;
  const evidence: SignalEvidence = {
    ...baseEvidence,
    structureEvent: {
      type: event.type,
      direction: event.direction,
      level: event.level,
      levelText: event.levelText,
      breakCandleTimeUtc: iso(event.breakCandleTimeUtcSec),
      barsSinceBreak,
    },
  };
  if (barsSinceBreak > rules.maxBarsSinceBreak) {
    return noSetup(['STRUCTURE_BREAK_TOO_OLD'], evidence);
  }

  const isBuy = event.direction === 'bullish';
  const direction: 'BUY' | 'SELL' = isBuy ? 'BUY' : 'SELL';

  // ── Strategy step 2: zone validity (no close back through the level) ───
  let zoneInvalidated = false;
  for (let i = breakIdx + 1; i <= decisionIdx; i++) {
    const c = exec[i];
    if (isBuy ? c.close < event.level : c.close > event.level) {
      zoneInvalidated = true;
      break;
    }
  }
  if (zoneInvalidated) {
    return noSetup(['ZONE_INVALIDATED'], evidence);
  }
  if (isBuy ? decision.close <= event.level : decision.close >= event.level) {
    return wait(['AT_ZONE_BOUNDARY'], evidence);
  }

  // ── Strategy step 3: entry zone + retest requirement ───────────────────
  const zoneLow = isBuy ? event.level : event.level - rules.zoneWidthAtr * atrVal;
  const zoneHigh = isBuy ? event.level + rules.zoneWidthAtr * atrVal : event.level;
  let retestTime: number | null = null;
  for (let i = breakIdx + 1; i <= decisionIdx; i++) {
    const c = exec[i];
    const touched = isBuy ? c.low <= zoneHigh : c.high >= zoneLow;
    if (touched) {
      retestTime = c.timeUtcSec;
      break; // earliest retest bar (deterministic)
    }
  }
  const evidenceWithRetest: SignalEvidence = {
    ...evidence,
    retestBarTimeUtc: retestTime !== null ? iso(retestTime) : null,
  };
  if (retestTime === null) {
    return wait(['RETEST_PENDING'], evidenceWithRetest);
  }

  // ── Strategy step 4: spread gate ────────────────────────────────────────
  if (input.spreadPrice > rules.maxSpreadPrice) {
    return wait(['SPREAD_TOO_WIDE'], evidenceWithRetest);
  }

  // ── Strategy step 5: higher-timeframe filter (NOT a vote) ──────────────
  const htfOpposite = (trend: StructuralTrend | null): boolean =>
    trend === (isBuy ? 'bearish' : 'bullish');
  if (htfOpposite(h1Trend)) {
    return wait(['HTF_H1_OPPOSITE'], evidenceWithRetest);
  }
  if (htfOpposite(h4Trend)) {
    return wait(['HTF_H4_OPPOSITE'], evidenceWithRetest);
  }

  // ── Strategy step 6: indicator filters ──────────────────────────────────
  const emaOk = isBuy ? decision.close > emaVal : decision.close < emaVal;
  if (!emaOk) {
    return wait(['EMA_TREND_OPPOSITE'], evidenceWithRetest);
  }
  const rsiOk = isBuy
    ? rsiVal > rules.rsiBuyMin && rsiVal < rules.rsiBuyMax
    : rsiVal < 100 - rules.rsiBuyMin && rsiVal > 100 - rules.rsiBuyMax;
  if (!rsiOk) {
    return wait(['RSI_OUT_OF_RANGE'], evidenceWithRetest);
  }
  if (adxVal < rules.minAdx) {
    return wait(['ADX_BELOW_MIN'], evidenceWithRetest);
  }

  // ── Strategy step 7: live price must be inside/near the entry zone ─────
  const tol = rules.entryToleranceAtr * atrVal;
  const priceOk = isBuy
    ? input.referencePrice >= zoneLow - tol && input.referencePrice <= zoneHigh + tol
    : input.referencePrice <= zoneHigh + tol && input.referencePrice >= zoneLow - tol;
  if (!priceOk) {
    return wait(['PRICE_BEYOND_ENTRY_ZONE'], evidenceWithRetest);
  }

  // ── Strategy step 8: anchor swing + level derivation ───────────────────
  const wantKind: 'low' | 'high' = isBuy ? 'low' : 'high';
  let anchor: SwingPoint | null = null;
  for (let k = swingDet.swings.length - 1; k >= 0; k--) {
    const s = swingDet.swings[k];
    if (s.kind === wantKind && s.index + rules.swingRight <= decisionIdx) {
      anchor = s;
      break;
    }
  }
  if (!anchor) {
    return noSetup(['NO_ANCHOR_SWING'], evidenceWithRetest);
  }
  const evidenceFull: SignalEvidence = {
    ...evidenceWithRetest,
    anchorSwing: {
      kind: anchor.kind,
      price: anchor.price,
      priceText: anchor.priceText,
      swingTimeUtc: iso(anchor.timeUtcSec),
      confirmedAtUtc: iso(anchor.confirmedAtUtcSec),
    },
  };

  const derived = deriveLevels(
    direction,
    anchor.price,
    atrVal,
    input.referencePrice,
    input.spreadPrice / 2,
    zoneLow,
    zoneHigh,
    input.digits,
    rules,
  );
  if (!derived.ok || !derived.levels) {
    return noSetup([derived.code ?? 'LEVEL_CALC_INVALID'], evidenceFull);
  }

  // ── All gates and conditions passed → SETUP ────────────────────────────
  const expirySec = decisionCloseSec + rules.expiryBars * EXEC_TF_SEC;
  return {
    engineVersion: SIGNAL_ENGINE_VERSION,
    strategyVersion: SIGNAL_STRATEGY_VERSION,
    symbol: input.symbol,
    purpose: 'research-signal-not-an-execution-instruction',
    outcome: isBuy ? 'BUY_SETUP' : 'SELL_SETUP',
    reasonCodes: [],
    decisionCandleTimeUtc: iso(decision.timeUtcSec),
    setupKnownAtUtc: iso(decisionCloseSec),
    expiryUtc: iso(expirySec),
    levels: derived.levels,
    evidence: evidenceFull,
    inputFingerprint: fingerprint,
    datasetFingerprint: computeDatasetFingerprint(input.symbol, input.execution),
    generatedAtUtc: iso(input.nowUtcSec),
  };
}

/** FAILED result for exceptional paths — safe, bounded, never fabricated. */
export function failedSignalEvaluation(
  symbol: string,
  nowUtcSec: number,
  message: string,
): SignalEvaluation {
  return {
    engineVersion: SIGNAL_ENGINE_VERSION,
    strategyVersion: SIGNAL_STRATEGY_VERSION,
    symbol,
    purpose: 'research-signal-not-an-execution-instruction',
    outcome: 'FAILED',
    reasonCodes: ['SIGNAL_ERROR'],
    decisionCandleTimeUtc: null,
    setupKnownAtUtc: null,
    expiryUtc: null,
    levels: null,
    evidence: null,
    inputFingerprint: '',
    datasetFingerprint: null,
    generatedAtUtc: new Date(nowUtcSec * 1000).toISOString(),
    failureMessage: message.slice(0, 300),
  };
}
