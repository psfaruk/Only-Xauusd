/**
 * XAUUSD AI Trading Agent — Analysis Engine (Phase 4)
 * ----------------------------------------------------------------------------
 * PURE orchestration: gate → swings → structure → indicators → context.
 * No database, no network, no clock (current time is an explicit parameter),
 * no LLM. Same input + config + engineVersion → identical output, verified
 * by the sha256 input fingerprint.
 *
 * Blocked semantics: if ANY requested timeframe (or the tick) fails the
 * readiness gate, the WHOLE run is BLOCKED — the missing timeframe's absence
 * is reported in `readiness`, no fallback trend is fabricated, and structure/
 * indicators are OMITTED entirely (never partially invented).
 *
 * This is a technical-analysis snapshot only — it contains no signal, no
 * direction recommendation and nothing executable. Phase 5 does not exist here.
 */

import { createHash } from 'node:crypto';
import type { ReadinessResult, Timeframe } from '@/lib/market/types';
import {
  ADX_CONVENTION,
  ATR_CONVENTION,
  EMA_CONVENTION,
  RSI_CONVENTION,
  adxSeries,
  atrSeries,
  emaSeries,
  rsiSeries,
  type AdxComputed,
  type ComputedSeries,
} from './indicators';
import { assessTick, assessTimeframe } from './readiness';
import { buildStructureResult, scanStructureEvents } from './structure';
import { detectSwings } from './swings';
import {
  ENGINE_VERSION,
  type AnalysisResult,
  type CalculationConfig,
  type IndicatorSeriesSnapshot,
  type TfLoadedData,
  type TimeframeAnalysis,
  type TimeframeContext,
  type TimeframeReadinessEntry,
} from './types';
import { TIMEFRAME_SECONDS } from '@/lib/market/types';

// ---------------------------------------------------------------------------
// Config construction (validated, persisted with every run)
// ---------------------------------------------------------------------------

export function buildCalculationConfig(cfg: {
  swingLeft: number;
  swingRight: number;
  minBarsPerTf: number;
  maxBarsPerTf: number;
}): CalculationConfig {
  return {
    engineVersion: ENGINE_VERSION,
    swingLeft: cfg.swingLeft,
    swingRight: cfg.swingRight,
    emaPeriods: [20, 50, 200],
    rsiPeriod: 14,
    atrPeriod: 14,
    adxPeriod: 14,
    minBarsPerTf: cfg.minBarsPerTf,
    maxBarsPerTf: cfg.maxBarsPerTf,
    breakBasis: 'close',
    pricePrecision: 'exact-decimal-text-persisted-float64-calculated',
    indicatorConventions: {
      ema: EMA_CONVENTION,
      rsi: RSI_CONVENTION,
      atr: ATR_CONVENTION,
      adx: ADX_CONVENTION,
    },
  };
}

// ---------------------------------------------------------------------------
// Input fingerprint (reproducibility proof)
// ---------------------------------------------------------------------------

/**
 * sha256 over a canonical JSON payload: engineVersion + config + the EXACT
 * decimal-text prices of every candle. Byte-stable: fixed key order, fixed
 * arrays. Same input → same fingerprint; any input change → different hash.
 */
export function computeInputFingerprint(
  symbol: string,
  digits: number | null,
  perTimeframe: Map<Timeframe, TfLoadedData>,
  config: CalculationConfig,
): string {
  const tfPayload: Record<string, unknown> = {};
  for (const [tf, data] of [...perTimeframe.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    tfPayload[tf] = {
      source: data.source,
      candles: data.candles.map((c) => [c.timeUtcSec, c.openText, c.highText, c.lowText, c.closeText, c.volume]),
    };
  }
  const payload = {
    engineVersion: config.engineVersion,
    symbol,
    digits,
    swing: { left: config.swingLeft, right: config.swingRight },
    periods: {
      ema: config.emaPeriods,
      rsi: config.rsiPeriod,
      atr: config.atrPeriod,
      adx: config.adxPeriod,
    },
    bars: { min: config.minBarsPerTf, max: config.maxBarsPerTf },
    perTimeframe: tfPayload,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ---------------------------------------------------------------------------
// Indicator snapshot assembly
// ---------------------------------------------------------------------------

function snapshot(series: ComputedSeries, candles: TfLoadedData['candles'], convention: string): IndicatorSeriesSnapshot | null {
  const lastIdx = (() => {
    for (let i = series.values.length - 1; i >= 0; i--) if (series.values[i] !== null) return i;
    return -1;
  })();
  if (lastIdx < 0) return null;
  const prevIdx = (() => {
    for (let i = lastIdx - 1; i >= 0; i--) if (series.values[i] !== null) return i;
    return -1;
  })();
  const valueAt = (i: number) => series.values[i] as number;
  return {
    period: series.period,
    fromIndex: series.fromIndex,
    warmupBars: series.period,
    convention,
    last: { index: lastIdx, timeUtcSec: candles[lastIdx].timeUtcSec, value: valueAt(lastIdx) },
    previous: prevIdx >= 0 ? { index: prevIdx, timeUtcSec: candles[prevIdx].timeUtcSec, value: valueAt(prevIdx) } : null,
    tail: [lastIdx, prevIdx, prevIdx - 1]
      .filter((i) => i >= 0 && series.values[i] !== null)
      .reverse()
      .map((i) => ({ timeUtcSec: candles[i].timeUtcSec, value: valueAt(i) })),
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface EngineInput {
  symbol: string;
  digits: number | null;
  timeframes: Timeframe[];
  perTimeframe: Map<Timeframe, TfLoadedData>;
  phase3: ReadinessResult;
  nowUtcSec: number;
}

export function computeAnalysis(input: EngineInput, config: CalculationConfig): AnalysisResult {
  const readiness: TimeframeReadinessEntry[] = [];
  const resultWarnings: string[] = [];
  const reasonCodes: string[] = [];

  // ---- Tick gate ------------------------------------------------------------
  const tickGate = assessTick(input.phase3.tick);
  for (const w of tickGate.warnings) resultWarnings.push(w);
  for (const e of tickGate.errorCodes) if (!reasonCodes.includes(e)) reasonCodes.push(e);

  // ---- Per-timeframe gates ---------------------------------------------------
  for (const tf of input.timeframes) {
    const loaded = input.perTimeframe.get(tf) ?? null;
    if (!loaded) {
      readiness.push({
        timeframe: tf,
        state: 'BLOCKED',
        phase3State: 'UNAVAILABLE',
        closedCandles: 0,
        requiredMinBars: config.minBarsPerTf,
        errorCodes: ['DATA_NOT_READY', 'DATA_MISSING'],
        warnings: [],
      });
      for (const e of ['DATA_NOT_READY', 'DATA_MISSING']) if (!reasonCodes.includes(e)) reasonCodes.push(e);
      continue;
    }
    const phase3Tf = input.phase3.timeframes.find((t) => t.timeframe === tf) ?? null;
    if (!phase3Tf) {
      readiness.push({
        timeframe: tf,
        state: 'BLOCKED',
        phase3State: 'UNAVAILABLE',
        closedCandles: loaded.candles.length,
        requiredMinBars: config.minBarsPerTf,
        errorCodes: ['DATA_NOT_READY'],
        warnings: [],
      });
      if (!reasonCodes.includes('DATA_NOT_READY')) reasonCodes.push('DATA_NOT_READY');
      continue;
    }
    const entry = assessTimeframe({
      timeframe: tf,
      phase3: phase3Tf,
      loaded,
      requiredMinBars: config.minBarsPerTf,
    });
    readiness.push(entry);
    for (const w of entry.warnings) if (!resultWarnings.includes(w)) resultWarnings.push(w);
    for (const e of entry.errorCodes) if (!reasonCodes.includes(e)) reasonCodes.push(e);
  }

  const allReady = tickGate.ok && readiness.every((r) => r.state === 'READY');

  // ---- Common result scaffolding ---------------------------------------------
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const fingerprint = computeInputFingerprint(input.symbol, input.digits, input.perTimeframe, config);

  const base: AnalysisResult = {
    status: allReady ? 'COMPLETED' : 'BLOCKED',
    purpose: 'deterministic-technical-analysis-not-a-signal',
    engineVersion: config.engineVersion,
    symbol: input.symbol,
    timeframes: [...input.timeframes],
    generatedAtUtc: iso(input.nowUtcSec),
    inputData: {
      perTimeframe: {},
      digits: input.digits,
    },
    inputFingerprint: fingerprint,
    readiness,
    warnings: resultWarnings,
    reasonCodes: allReady ? [] : reasonCodes,
    calculationConfig: config,
  };
  for (const [tf, data] of input.perTimeframe) {
    base.inputData.perTimeframe[tf] = {
      closedCandles: data.candles.length,
      firstCandleTimeUtc: data.candles.length > 0 ? iso(data.candles[0].timeUtcSec) : null,
      lastCandleTimeUtc: data.candles.length > 0 ? iso(data.candles[data.candles.length - 1].timeUtcSec) : null,
      source: data.source,
      formingExcluded: data.formingExcluded,
      invalidExcluded: data.invalidExcluded,
    };
  }

  if (!allReady) {
    // BLOCKED: structure/indicators/context are OMITTED — never fabricated.
    return base;
  }

  // ---- Per-timeframe analysis -------------------------------------------------
  const perTf: Record<string, TimeframeAnalysis> = {};
  const trendByTimeframe: Record<string, TimeframeAnalysis['structure']['trend']> = {};

  for (const tf of input.timeframes) {
    const loaded = input.perTimeframe.get(tf);
    if (!loaded) continue; // unreachable when allReady
    const tfSec = TIMEFRAME_SECONDS[tf];

    // Swings → structure (deterministic, closed candles only).
    const det = detectSwings(loaded.candles, {
      left: config.swingLeft,
      right: config.swingRight,
      tfSec,
      digits: input.digits,
    });
    for (const w of det.warnings) if (!resultWarnings.includes(w.code)) resultWarnings.push(w.code);

    const scan = scanStructureEvents(loaded.candles, det.swings, {
      swingLeft: config.swingLeft,
      swingRight: config.swingRight,
      tfSec,
      digits: input.digits,
    });
    const structure = buildStructureResult(loaded.candles, det.swings, scan, {
      swingLeft: config.swingLeft,
      swingRight: config.swingRight,
      tfSec,
      digits: input.digits,
    });
    if (structure.trend === 'unclear' && !resultWarnings.includes('STRUCTURE_UNCLEAR')) {
      resultWarnings.push('STRUCTURE_UNCLEAR');
    }
    trendByTimeframe[tf] = structure.trend;

    // Indicators (each independent; INSUFFICIENT_DATA recorded, never faked).
    const closes = loaded.candles.map((c) => c.close);
    const indicatorIssues: string[] = [];
    const tfWarnings: string[] = [];

    const ema20 = emaSeries(closes, 20);
    const ema50 = emaSeries(closes, 50);
    const ema200 = emaSeries(closes, 200);
    const rsi14 = rsiSeries(closes, config.rsiPeriod);
    const atr14 = atrSeries(loaded.candles, config.atrPeriod);
    const adx14 = adxSeries(loaded.candles, config.adxPeriod);

    const wrap = (r: { ok: true; series: ComputedSeries } | { ok: false; error: { code: string; detail: string } }, name: string, conv: string) => {
      if (!r.ok) {
        indicatorIssues.push(`${r.error.code}:${name}`);
        return null;
      }
      for (const w of r.series.warnings) if (!tfWarnings.includes(w.code)) tfWarnings.push(w.code);
      return snapshot(r.series, loaded.candles, conv);
    };

    const indicators: TimeframeAnalysis['indicators'] = {
      ema20: wrap(ema20, 'EMA20', EMA_CONVENTION),
      ema50: wrap(ema50, 'EMA50', EMA_CONVENTION),
      ema200: wrap(ema200, 'EMA200', EMA_CONVENTION),
      rsi14: wrap(rsi14, 'RSI14', RSI_CONVENTION),
      atr14: wrap(atr14, 'ATR14', ATR_CONVENTION),
      adx14: wrap(adx14, 'ADX14', ADX_CONVENTION),
    };
    // ADX carries directional components — surface them in the snapshot tail
    // convention text (kept honest: DI values are part of the convention note).
    if (adx14.ok && indicators.adx14) {
      const s = adx14.series as AdxComputed;
      indicators.adx14 = {
        ...indicators.adx14,
        convention: `${ADX_CONVENTION}; last DI+${s.lastDiPlus ?? 'n/a'} DI−${s.lastDiMinus ?? 'n/a'}`,
      };
    }
    for (const w of tfWarnings) if (!resultWarnings.includes(w)) resultWarnings.push(w);

    perTf[tf] = {
      timeframe: tf,
      candleCount: loaded.candles.length,
      firstCandleTimeUtc: iso(loaded.candles[0].timeUtcSec),
      lastCandleTimeUtc: iso(loaded.candles[loaded.candles.length - 1].timeUtcSec),
      source: loaded.source ?? 'unknown',
      structure,
      indicators,
      indicatorIssues,
      warnings: tfWarnings,
    };
  }

  // ---- Multi-timeframe context (descriptive ONLY — never a signal) -----------
  const trends = input.timeframes.map((tf) => trendByTimeframe[tf] ?? 'unclear');
  const allBullish = trends.every((t) => t === 'bullish');
  const allBearish = trends.every((t) => t === 'bearish');
  const anyUnclear = trends.some((t) => t === 'unclear');
  const alignment: TimeframeContext['alignment'] = allBullish
    ? 'aligned-bullish'
    : allBearish
      ? 'aligned-bearish'
      : anyUnclear
        ? 'unclear'
        : 'mixed';
  const context: TimeframeContext = {
    trendByTimeframe,
    alignment,
    note:
      alignment === 'aligned-bullish'
        ? 'All configured timeframes classify as bullish structure (descriptive observation only).'
        : alignment === 'aligned-bearish'
          ? 'All configured timeframes classify as bearish structure (descriptive observation only).'
          : 'Timeframe structures disagree or are unclear (descriptive observation only).',
    disclaimer: 'descriptive-only-not-a-signal',
  };

  return { ...base, perTimeframe: perTf, timeframeContext: context, warnings: resultWarnings };
}

/** FAILED result for exceptional paths — safe, bounded, never fabricated. */
export function failedAnalysisResult(
  symbol: string,
  timeframes: Timeframe[],
  config: CalculationConfig,
  nowUtcSec: number,
  message: string,
): AnalysisResult {
  return {
    status: 'FAILED',
    purpose: 'deterministic-technical-analysis-not-a-signal',
    engineVersion: config.engineVersion,
    symbol,
    timeframes,
    generatedAtUtc: new Date(nowUtcSec * 1000).toISOString(),
    inputData: { perTimeframe: {}, digits: null },
    inputFingerprint: null,
    readiness: [],
    warnings: [],
    reasonCodes: ['ANALYSIS_ERROR'],
    calculationConfig: config,
    failureMessage: message.slice(0, 300),
  };
}
