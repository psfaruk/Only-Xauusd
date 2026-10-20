/**
 * XAUUSD AI Trading Agent — SCALPER Evaluation Core (Phase 12, Task 32)
 * ----------------------------------------------------------------------------
 * PURE and DETERMINISTIC — no database, no network, no clock reads. The live
 * service is the only caller (the strategy is a live scalping surface, not a
 * backtest subject).
 *
 * Causality (no look-ahead) — by construction:
 *   · Only CLOSED candles enter (the decision bar of each TF is its last
 *     closed bar; the close instant must be <= the evaluation instant).
 *   · Indicators are recursive past-only series evaluated at the decision bar.
 *   · The reversal model needs the PREVIOUS bar's RSI extreme + the decision
 *     bar turning back — both fully known at the decision close.
 *
 * OR-logic (user requirement): M15, M5 and M1 are judged INDEPENDENTLY.
 * ANY ONE timeframe agreeing is sufficient — there are NO higher-timeframe
 * gates. When several TFs agree, the FIRST in priority order (M15 → M5 → M1)
 * becomes the source timeframe of the emitted setup.
 *
 * Outcome model (shared with the baseline engine):
 *   BUY_SETUP / SELL_SETUP — one TF agreed + spread gate + tradable levels.
 *   WAIT                   — a TF agreed but the setup was suppressed
 *                            (cooldown / same-bar duplicate) or the spread
 *                            is too wide. Healthy, honest verdicts.
 *   NO_SETUP               — no timeframe agrees right now (SCALPER_NO_AGREE).
 *   BLOCKED                — a data gate failed (fail-closed, no levels).
 */

import { createHash } from 'node:crypto';
import { TIMEFRAME_SECONDS } from '@/lib/market/types';
import { toCanonicalPrice } from '@/lib/market/validation';
import { atrSeries, emaSeries, rsiSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { evaluateSmcConfluence } from '../ict/confluence';
import { deriveSmcLevels } from '../ict/risk';
import type { SmcConfluenceEvidence } from '../ict/types';
import type { SignalReasonCode, SignalWindow } from '../types';
import type {
  ScalperCoreInput,
  ScalperEvidenceBlock,
  ScalperEvaluation,
  ScalperLevels,
  ScalperReasonCode,
  ScalperRules,
  ScalperTf,
  ScalperTfJudgement,
} from './types';
import { SCALPER_ENGINE_VERSION, SCALPER_STRATEGY_VERSION } from './types';

// NOTE: every scalper-specific reason code is a member of the shared
// SignalReasonCode union (see ../types.ts) — the compiler enforces it.

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function windowPayload(w: SignalWindow): unknown {
  return {
    tf: w.timeframe,
    source: w.source,
    candles: w.candles.map((c) => [c.timeUtcSec, c.openText, c.highText, c.lowText, c.closeText]),
  };
}

export function computeScalperFingerprint(input: ScalperCoreInput): string {
  const payload = {
    engineVersion: SCALPER_ENGINE_VERSION,
    strategyVersion: SCALPER_STRATEGY_VERSION,
    symbol: input.symbol,
    digits: input.digits,
    referencePrice: input.referencePrice,
    spreadPrice: input.spreadPrice,
    nowUtcSec: input.nowUtcSec,
    rules: input.rules,
    m15: windowPayload(input.m15),
    m5: windowPayload(input.m5),
    m1: windowPayload(input.m1),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Logical setup identity — one fingerprint per (symbol, source TF, model,
 * direction, decision bar). Repeated evaluations of the SAME decision bar
 * produce the SAME fingerprint (the dedup key); a new decision bar is a new
 * setup.
 */
export function scalperSetupFingerprint(
  symbol: string,
  sourceTf: ScalperTf,
  model: 'MOMENTUM' | 'REVERSAL' | 'SMC_CONFLUENCE',
  direction: 'BUY' | 'SELL',
  decisionBarTimeUtcSec: number,
): string {
  return createHash('sha256')
    .update(`${SCALPER_STRATEGY_VERSION}|${symbol}|${sourceTf}|${model}|${direction}|${decisionBarTimeUtcSec}`)
    .digest('hex');
}

export function computeScalperDatasetFingerprint(symbol: string, w: SignalWindow): string {
  const h = createHash('sha256');
  h.update(`${symbol}|${w.timeframe}|${w.candles.length}`);
  for (const c of w.candles) {
    h.update(`|${c.timeUtcSec},${c.openText},${c.highText},${c.lowText},${c.closeText}`);
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Window gates (fail-closed)
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

interface TfGateResult {
  ok: boolean;
  codes: SignalReasonCode[];
}

function gateTfWindow(
  w: SignalWindow,
  tf: ScalperTf,
  minBars: number,
  insufficientCode: SignalReasonCode,
  nowUtcSec: number,
): TfGateResult {
  const codes: SignalReasonCode[] = [];
  const tfSec = TIMEFRAME_SECONDS[tf];
  if (!w.candles.length) {
    codes.push('DATA_MISSING', insufficientCode);
    return { ok: false, codes };
  }
  if (!isAscending(w.candles)) codes.push('CHRONOLOGY_BROKEN', 'DATA_INVALID');
  if (!pricesFinite(w.candles)) codes.push('DATA_INVALID');
  if (w.candles.length < minBars) codes.push(insufficientCode, 'INSUFFICIENT_DATA');
  // Forming-candle protection: the last bar must be CLOSED by the evaluation
  // instant (its close instant is open time + tf duration).
  const last = w.candles[w.candles.length - 1];
  if (last.timeUtcSec + tfSec > nowUtcSec) codes.push('FORMING_CANDLE_IN_INPUT', 'DATA_INVALID');
  // Demo/synthetic source policy — demo rows BLOCK, never "pass".
  const src = (w.source ?? '').toLowerCase();
  if (src.includes('demo')) codes.push('SOURCE_DEMO', 'SOURCE_NOT_BROKER');
  return { ok: codes.length === 0, codes };
}

// ---------------------------------------------------------------------------
// Per-timeframe independent judgement
// ---------------------------------------------------------------------------

interface TfEvaluation {
  judgement: ScalperTfJudgement;
  agree: 'BUY' | 'SELL' | null;
  model: 'MOMENTUM' | 'REVERSAL' | 'SMC_CONFLUENCE' | null;
  atr: number | null;
  decisionClose: number | null;
  decisionCloseSec: number;
  /** Phase 14 — the full SMC evidence of this TF (null when the layer is off). */
  smcEvidence: SmcConfluenceEvidence | null;
}

function judgeTf(
  w: SignalWindow,
  tf: ScalperTf,
  rules: ScalperRules,
  digits: number | null,
  nowUtcSec: number,
): TfEvaluation {
  const candles = w.candles;
  const idx = candles.length - 1;
  const decision = candles[idx];
  const decisionCloseSec = decision.timeUtcSec + TIMEFRAME_SECONDS[tf];

  const closes = candles.map((c) => c.close);
  const emaFast = emaSeries(closes, rules.emaFastPeriod);
  const emaSlow = emaSeries(closes, rules.emaSlowPeriod);
  const rsi = rsiSeries(closes, rules.rsiPeriod);
  const atr = atrSeries(candles, rules.atrPeriod);

  const fastVal = emaFast.ok ? emaFast.series.values[idx] : null;
  const slowVal = emaSlow.ok ? emaSlow.series.values[idx] : null;
  const rsiVal = rsi.ok ? rsi.series.values[idx] : null;
  const prevRsiVal = rsi.ok && idx >= 1 ? rsi.series.values[idx - 1] : null;
  const atrVal = atr.ok ? atr.series.values[idx] : null;
  const prevBar = idx >= 1 ? candles[idx - 1] : null;

  const judgement: ScalperTfJudgement = {
    timeframe: tf,
    agree: null,
    model: null,
    stage: 'NO_AGREE',
    decisionCandleTimeUtc: new Date(decision.timeUtcSec * 1000).toISOString(),
    indicators: {
      emaFast: fastVal !== null && Number.isFinite(fastVal) ? fastVal : null,
      emaSlow: slowVal !== null && Number.isFinite(slowVal) ? slowVal : null,
      rsi: rsiVal !== null && Number.isFinite(rsiVal) ? rsiVal : null,
      atr: atrVal !== null && Number.isFinite(atrVal) ? atrVal : null,
      close: decision.close,
    },
  };

  const evaluation: TfEvaluation = {
    judgement,
    agree: null,
    model: null,
    atr: judgement.indicators.atr,
    decisionClose: decision.close,
    decisionCloseSec,
    smcEvidence: null,
  };

  // ── SMC_CONFLUENCE model (Phase 14 — priority: quality first). The
  //    ten-agent confluence runs on this TF's own candles; its summary chip
  //    is attached to the judgement REGARDLESS of agreement (the UI renders
  //    score/tier for every TF). Runs before the indicator warm-up guard —
  //    the SMC agents carry their own fail-closed warm-up handling.
  if (rules.smc.enabled) {
    const smc = evaluateSmcConfluence({
      candles,
      tfSec: TIMEFRAME_SECONDS[tf],
      digits,
      nowUtcSec,
      params: rules.smc.params,
      indicatorPeriods: rules.smc.indicatorPeriods,
      newsBlackoutEnabled: rules.smc.newsBlackoutEnabled,
    });
    evaluation.smcEvidence = smc.evidence;
    judgement.smc = smc.summary;
    if (smc.actionable && smc.evidence.direction !== null) {
      judgement.agree = smc.evidence.direction;
      judgement.model = 'SMC_CONFLUENCE';
      judgement.stage = smc.evidence.direction === 'BUY' ? 'SMC_BUY' : 'SMC_SELL';
      evaluation.agree = smc.evidence.direction;
      evaluation.model = 'SMC_CONFLUENCE';
    }
    // News blackout gates EVERY model on this TF (market-condition veto, not
    // an SMC-specific one) — the legacy momentum/reversal fallbacks stay
    // silent inside the approximate high-impact envelopes too.
    if (rules.smc.newsBlackoutEnabled && smc.evidence.session.newsBlackout) {
      return evaluation;
    }
  }

  // Warm-up guard: without all indicators the legacy models cannot judge.
  // (The SMC model may already have agreed above — then we are done.)
  if (evaluation.agree !== null) {
    return evaluation; // SMC already agreed — legacy models stay silent.
  }
  if (
    fastVal === null || slowVal === null || rsiVal === null || atrVal === null ||
    !Number.isFinite(fastVal) || !Number.isFinite(slowVal) || !Number.isFinite(rsiVal) ||
    !Number.isFinite(atrVal) || atrVal <= 0
  ) {
    return evaluation;
  }

  // ── MOMENTUM model: fast EMA above slow EMA, price riding the fast EMA,
  //    RSI in the healthy-trend band (not exhausted).
  const momentumBuy =
    fastVal > slowVal &&
    decision.close > fastVal &&
    rsiVal >= rules.momentumRsiMin &&
    rsiVal <= rules.momentumRsiMax;
  const momentumSell =
    fastVal < slowVal &&
    decision.close < fastVal &&
    rsiVal <= 100 - rules.momentumRsiMin &&
    rsiVal >= 100 - rules.momentumRsiMax;

  // ── REVERSAL model: previous bar at the RSI extreme, decision bar turning
  //    back (RSI recovering + a directional close). Everything is known at
  //    the decision bar's close.
  const prevRsi = prevRsiVal !== null && Number.isFinite(prevRsiVal) ? prevRsiVal : null;
  const reversalBuy =
    prevRsi !== null &&
    prevRsi <= rules.reversalRsiOversold &&
    rsiVal > prevRsi &&
    decision.close > decision.open;
  const reversalSell =
    prevRsi !== null &&
    prevRsi >= rules.reversalRsiOverbought &&
    rsiVal < prevRsi &&
    decision.close < decision.open;

  // Momentum has priority within a TF (trend-following first).
  if (momentumBuy) {
    judgement.agree = 'BUY';
    judgement.model = 'MOMENTUM';
    judgement.stage = 'MOMENTUM_BUY';
    evaluation.agree = 'BUY';
    evaluation.model = 'MOMENTUM';
  } else if (momentumSell) {
    judgement.agree = 'SELL';
    judgement.model = 'MOMENTUM';
    judgement.stage = 'MOMENTUM_SELL';
    evaluation.agree = 'SELL';
    evaluation.model = 'MOMENTUM';
  } else if (reversalBuy) {
    judgement.agree = 'BUY';
    judgement.model = 'REVERSAL';
    judgement.stage = 'REVERSAL_BUY';
    evaluation.agree = 'BUY';
    evaluation.model = 'REVERSAL';
  } else if (reversalSell) {
    judgement.agree = 'SELL';
    judgement.model = 'REVERSAL';
    judgement.stage = 'REVERSAL_SELL';
    evaluation.agree = 'SELL';
    evaluation.model = 'REVERSAL';
  }
  void prevBar;
  return evaluation;
}

// ---------------------------------------------------------------------------
// Level derivation (spread-aware, ordering-validated — never fabricated)
// ---------------------------------------------------------------------------

export function deriveScalperLevels(
  direction: 'BUY' | 'SELL',
  decisionClose: number,
  atr: number,
  referencePrice: number,
  halfSpread: number,
  digits: number | null,
  rules: ScalperRules,
): { ok: boolean; levels: ScalperLevels | null; code: ScalperReasonCode | null } {
  const entry = direction === 'BUY' ? referencePrice + halfSpread : referencePrice - halfSpread;
  const buffer = rules.slAtrMult * atr;
  const stopLoss = direction === 'BUY' ? decisionClose - buffer : decisionClose + buffer;
  const risk = direction === 'BUY' ? entry - stopLoss : stopLoss - entry;
  if (!(risk > 0) || !Number.isFinite(risk)) {
    return { ok: false, levels: null, code: 'SCALPER_LEVELS_INVALID' };
  }
  if (risk < rules.minStopPrice) {
    return { ok: false, levels: null, code: 'SCALPER_SL_TOO_TIGHT' };
  }
  const target = direction === 'BUY' ? entry + rules.rewardRisk * risk : entry - rules.rewardRisk * risk;
  const reward = direction === 'BUY' ? target - entry : entry - target;

  const ordered =
    direction === 'BUY'
      ? stopLoss < entry && entry < target
      : stopLoss > entry && entry > target;
  if (!ordered || !Number.isFinite(target) || !Number.isFinite(stopLoss)) {
    return { ok: false, levels: null, code: 'SCALPER_LEVELS_INVALID' };
  }

  const fmt = (v: number) => toCanonicalPrice(v, digits).text;
  return {
    ok: true,
    code: null,
    levels: {
      direction,
      // Scalpers enter at the live price — the "zone" is the entry itself
      // (no pullback zone exists in this strategy).
      entryZoneLow: Math.min(entry, entry),
      entryZoneHigh: entry,
      entryReference: entry,
      stopLoss,
      target,
      riskPrice: risk,
      rewardPrice: reward,
      rewardRiskRatio: risk > 0 ? Number((reward / risk).toFixed(6)) : 0,
      entryZoneLowText: fmt(entry),
      entryZoneHighText: fmt(entry),
      stopLossText: fmt(stopLoss),
      targetText: fmt(target),
      entryReferenceText: fmt(entry),
    },
  };
}

// ---------------------------------------------------------------------------
// The evaluation core
// ---------------------------------------------------------------------------

export function evaluateScalper(input: ScalperCoreInput): ScalperEvaluation {
  const rules = input.rules;
  const fingerprint = computeScalperFingerprint(input);
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const purpose = 'live-signal-auto-execution' as const;

  const blocked = (codes: SignalReasonCode[]): ScalperEvaluation => ({
    engineVersion: SCALPER_ENGINE_VERSION,
    strategyVersion: SCALPER_STRATEGY_VERSION,
    symbol: input.symbol,
    purpose,
    outcome: 'BLOCKED',
    reasonCodes: [...new Set(codes)],
    decisionCandleTimeUtc: null,
    setupKnownAtUtc: null,
    expiryUtc: null,
    levels: null,
    evidence: null,
    inputFingerprint: fingerprint,
    datasetFingerprint: null,
    generatedAtUtc: iso(input.nowUtcSec),
  });

  // ── Gate 0: symbol spec ──────────────────────────────────────────────────
  if (input.digits === null || !Number.isInteger(input.digits) || input.digits < 0) {
    return blocked(['SPEC_MISSING']);
  }

  // ── Gate 1: numeric inputs ───────────────────────────────────────────────
  if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0) {
    return blocked(['DATA_INVALID']);
  }
  if (!Number.isFinite(input.spreadPrice) || input.spreadPrice < 0) {
    return blocked(['SPREAD_INVALID']);
  }

  // ── Gate 2: window shape, chronology, warm-up, forming protection ────────
  const gates: Array<[ScalperTf, SignalWindow, SignalReasonCode]> = [
    ['M15', input.m15, 'INSUFFICIENT_M15_HISTORY'],
    ['M5', input.m5, 'INSUFFICIENT_M5_HISTORY'],
    ['M1', input.m1, 'INSUFFICIENT_M1_HISTORY'],
  ];
  const gateCodes: SignalReasonCode[] = [];
  for (const [tf, win, insufficientCode] of gates) {
    const g = gateTfWindow(win, tf, rules.minBarsPerTf, insufficientCode, input.nowUtcSec);
    gateCodes.push(...g.codes);
  }
  if (gateCodes.length > 0) return blocked(gateCodes);

  // ── Independent per-TF judgements (priority M15 → M5 → M1) ──────────────
  const tfEvaluations = gates.map(([tf, win]) => judgeTf(win, tf, rules, input.digits, input.nowUtcSec));
  const judgements = tfEvaluations.map((t) => t.judgement);

  // Best-scoring SMC evidence across TFs — attached to every non-agree
  // outcome for observability (the winning TF's evidence is attached on
  // setups). Null when the SMC layer is disabled.
  const bestSmcEvidence: SmcConfluenceEvidence | null =
    tfEvaluations
      .map((t) => t.smcEvidence)
      .filter((e): e is SmcConfluenceEvidence => e !== null)
      .sort((a, b) => b.totalScore - a.totalScore)[0] ?? null;

  const baseEvidence: ScalperEvidenceBlock = {
    sourceTimeframe: null,
    model: null,
    suppressedDirection: null,
    tfJudgements: judgements,
  };

  const noSetup = (codes: SignalReasonCode[]): ScalperEvaluation => ({
    engineVersion: SCALPER_ENGINE_VERSION,
    strategyVersion: SCALPER_STRATEGY_VERSION,
    symbol: input.symbol,
    purpose,
    outcome: 'NO_SETUP',
    reasonCodes: [...new Set(codes)],
    decisionCandleTimeUtc: tfEvaluations[0]?.judgement.decisionCandleTimeUtc ?? null,
    setupKnownAtUtc: null,
    expiryUtc: null,
    levels: null,
    evidence: {
      structureEvent: null,
      anchorSwing: null,
      indicators: {
        ema50: null,
        rsi14: null,
        atr14: null,
        adx14: null,
      },
      htfContext: { h1Trend: null, h4Trend: null },
      decisionClose: null,
      retestBarTimeUtc: null,
      executionWindow: scalperWindowSummary(input.m15),
      h1Window: scalperWindowSummary(input.m5),
      h4Window: scalperWindowSummary(input.m1),
      scalper: baseEvidence,
      smc: bestSmcEvidence ?? undefined,
    },
    inputFingerprint: fingerprint,
    datasetFingerprint: computeScalperDatasetFingerprint(input.symbol, input.m1),
    generatedAtUtc: iso(input.nowUtcSec),
  });

  // ── OR-logic: the FIRST agreeing timeframe (priority order) wins ────────
  const winner = tfEvaluations.find((t) => t.agree !== null && t.model !== null) ?? null;
  if (!winner || winner.agree === null || winner.model === null) {
    return noSetup(['SCALPER_NO_AGREE']);
  }

  const direction = winner.agree;
  const sourceTf = winner.judgement.timeframe;
  const sourceWindow = gates.find(([tf]) => tf === sourceTf)?.[1] ?? input.m1;
  const decisionCloseSec = winner.decisionCloseSec;

  const evidenceAgree: ScalperEvidenceBlock = {
    ...baseEvidence,
    sourceTimeframe: sourceTf,
    model: winner.model,
  };

  // ── A timeframe agreed + gates passed → SETUP ─────────────────────────
  const finishSetup = (levels: ScalperLevels): ScalperEvaluation => {
    const expirySec = decisionCloseSec + rules.expirySec[sourceTf];
    return {
      engineVersion: SCALPER_ENGINE_VERSION,
      strategyVersion: SCALPER_STRATEGY_VERSION,
      symbol: input.symbol,
      purpose,
      outcome: direction === 'BUY' ? 'BUY_SETUP' : 'SELL_SETUP',
      reasonCodes: [],
      decisionCandleTimeUtc: winner.judgement.decisionCandleTimeUtc,
      setupKnownAtUtc: iso(decisionCloseSec),
      expiryUtc: iso(expirySec),
      levels,
      evidence: {
        structureEvent: null,
        anchorSwing: null,
        indicators: {
          ema50: null,
          rsi14: null,
          atr14: null,
          adx14: null,
        },
        htfContext: { h1Trend: null, h4Trend: null },
        decisionClose: winner.decisionClose,
        retestBarTimeUtc: null,
        executionWindow: scalperWindowSummary(input.m15),
        h1Window: scalperWindowSummary(input.m5),
        h4Window: scalperWindowSummary(input.m1),
        scalper: evidenceAgree,
        smc: winner.smcEvidence ?? bestSmcEvidence ?? undefined,
      },
      inputFingerprint: fingerprint,
      datasetFingerprint: computeScalperDatasetFingerprint(input.symbol, sourceWindow),
      generatedAtUtc: iso(input.nowUtcSec),
    };
  };

  const wait = (codes: SignalReasonCode[], suppressed: 'BUY' | 'SELL' | null): ScalperEvaluation => ({
    engineVersion: SCALPER_ENGINE_VERSION,
    strategyVersion: SCALPER_STRATEGY_VERSION,
    symbol: input.symbol,
    purpose,
    outcome: 'WAIT',
    reasonCodes: [...new Set(codes)],
    decisionCandleTimeUtc: winner.judgement.decisionCandleTimeUtc,
    setupKnownAtUtc: iso(decisionCloseSec),
    expiryUtc: null,
    levels: null,
    evidence: {
      structureEvent: null,
      anchorSwing: null,
      indicators: {
        ema50: null,
        rsi14: null,
        atr14: null,
        adx14: null,
      },
      htfContext: { h1Trend: null, h4Trend: null },
      decisionClose: winner.decisionClose,
      retestBarTimeUtc: null,
      executionWindow: scalperWindowSummary(input.m15),
      h1Window: scalperWindowSummary(input.m5),
      h4Window: scalperWindowSummary(input.m1),
      scalper: { ...evidenceAgree, suppressedDirection: suppressed },
      smc: winner.smcEvidence ?? bestSmcEvidence ?? undefined,
    },
    inputFingerprint: fingerprint,
    datasetFingerprint: computeScalperDatasetFingerprint(input.symbol, sourceWindow),
    generatedAtUtc: iso(input.nowUtcSec),
  });

  // ── Spread gate (checked once a TF agreed — the setup is otherwise real) ─
  if (input.spreadPrice > rules.maxSpreadPrice) {
    return wait(['SCALPER_SPREAD_TOO_WIDE'], direction);
  }

  // ── Level derivation from the SOURCE timeframe ──────────────────────────
  const atrVal = winner.atr;
  const decisionClose = winner.decisionClose;
  if (atrVal === null || decisionClose === null) {
    return wait(['SCALPER_LEVELS_INVALID'], direction);
  }

  // SMC_CONFLUENCE setups derive levels from the ICT reads: POI entry zone,
  // SL beyond the sweep wick / zone extreme, TP at the opposing liquidity.
  if (winner.model === 'SMC_CONFLUENCE' && winner.smcEvidence) {
    const smcEv = winner.smcEvidence;
    const poiZone = direction === 'BUY' ? smcEv.poi.nearestBullish : smcEv.poi.nearestBearish;
    const sweep =
      smcEv.liquidity.sweeps.find((s) =>
        direction === 'BUY' ? s.direction === 'BULLISH' : s.direction === 'BEARISH',
      ) ?? null;
    const opposingLiquidity = direction === 'BUY' ? smcEv.liquidity.nearestBuySide : smcEv.liquidity.nearestSellSide;
    const smcDerived = deriveSmcLevels({
      direction,
      poiZone,
      sweep,
      decisionClose,
      atr: winner.atr,
      referencePrice: input.referencePrice,
      halfSpread: input.spreadPrice / 2,
      digits: input.digits,
      opposingLiquidity,
      rules: {
        slAtrBuffer: rules.smc.params.slAtrBuffer,
        rewardRisk: rules.rewardRisk,
        minStopPrice: rules.minStopPrice,
        entryToleranceAtr: rules.smc.params.entryToleranceAtr,
      },
    });
    if (!smcDerived.ok || !smcDerived.levels) {
      return wait([smcDerived.code === 'OK' ? 'SMC_LEVELS_INVALID' : smcDerived.code], direction);
    }
    return finishSetup(smcDerived.levels);
  }

  const derived = deriveScalperLevels(
    direction,
    decisionClose,
    atrVal,
    input.referencePrice,
    input.spreadPrice / 2,
    input.digits,
    rules,
  );
  if (!derived.ok || !derived.levels) {
    return wait([derived.code ?? 'SCALPER_LEVELS_INVALID'], direction);
  }
  return finishSetup(derived.levels);
}

function scalperWindowSummary(w: SignalWindow): { fromUtc: string; toUtc: string; bars: number } {
  if (!w.candles.length) {
    return { fromUtc: '', toUtc: '', bars: 0 };
  }
  return {
    fromUtc: new Date(w.candles[0].timeUtcSec * 1000).toISOString(),
    toUtc: new Date(w.candles[w.candles.length - 1].timeUtcSec * 1000).toISOString(),
    bars: w.candles.length,
  };
}

// ---------------------------------------------------------------------------
// Pure suppression — applied by the SERVICE (cooldown / same-bar dedup)
// ---------------------------------------------------------------------------

/**
 * Suppress an emitted setup when the service's dedup/cooldown state says so.
 * The result is an honest WAIT carrying WHICH setup was suppressed (the UI
 * shows the direction + source TF) — the audit trail keeps the full evidence.
 * PURE: no clock, no DB — the caller states the suppression facts.
 */
export function suppressSetup(
  evaluation: ScalperEvaluation,
  state: { duplicate: boolean; cooldownActive: boolean },
): ScalperEvaluation {
  if (evaluation.outcome !== 'BUY_SETUP' && evaluation.outcome !== 'SELL_SETUP') {
    return evaluation;
  }
  const codes: SignalReasonCode[] = [];
  if (state.duplicate) codes.push('SCALPER_DUPLICATE_SETUP');
  if (state.cooldownActive) codes.push('SCALPER_COOLDOWN');
  if (!codes.length) return evaluation;

  const suppressedDirection: 'BUY' | 'SELL' =
    evaluation.outcome === 'BUY_SETUP' ? 'BUY' : 'SELL';
  return {
    ...evaluation,
    outcome: 'WAIT',
    reasonCodes: codes,
    levels: null,
    expiryUtc: null,
    evidence: evaluation.evidence
      ? {
          ...evaluation.evidence,
          scalper: evaluation.evidence.scalper
            ? { ...evaluation.evidence.scalper, suppressedDirection }
            : undefined,
        }
      : null,
  };
}

/** The setup fingerprint of an evaluation, recomputed deterministically from
 *  the persisted evidence block (used by the service for dedup). */
export function setupFingerprintOf(evaluation: ScalperEvaluation): string | null {
  const block = evaluation.evidence?.scalper;
  if (
    !block ||
    !block.sourceTimeframe ||
    !block.model ||
    !evaluation.decisionCandleTimeUtc ||
    !evaluation.levels
  ) {
    return null;
  }
  const decisionSec = Math.floor(new Date(evaluation.decisionCandleTimeUtc).getTime() / 1000);
  if (!Number.isFinite(decisionSec)) return null;
  return scalperSetupFingerprint(
    evaluation.symbol,
    block.sourceTimeframe,
    block.model,
    evaluation.levels.direction,
    decisionSec,
  );
}
