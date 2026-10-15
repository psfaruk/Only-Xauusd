/**
 * XAUUSD AI Trading Agent — Data Quality & Analysis-Readiness (Phase 3)
 * ----------------------------------------------------------------------------
 * Computes the machine-readable analysis-readiness result (spec Step 5):
 *
 *   ready, symbol, timeframes_checked, last_tick_time_utc,
 *   last_closed_candle_time_utc, data_age_seconds, quality_state, error_codes
 *
 * This result is for DATA READINESS ONLY — it is never a trade recommendation
 * and contains none. If data is not ready, downstream analysis must receive
 * the structured result and refuse to run — no fabricated candles, no forced
 * signals (enforced by the ready flag, not by convention).
 *
 * Freshness thresholds are configurable per timeframe (config.market.staleTfSec,
 * defaults 3× the bar duration; tick threshold config.market.staleTickSec).
 * The latest FORMING candle is always excluded — only closed bars count.
 */

import { db } from '@/lib/db';
import { config } from '@/lib/config';
import {
  ErrorCode,
  TIMEFRAME_SECONDS,
  worstQualityState,
  type QualityState,
  type ReadinessResult,
  type Timeframe,
  type TimeframeReadiness,
  type TickReadiness,
} from './types';
import { ageSeconds, findMissingCandles, freshnessState } from './validation';

export interface ReadinessOptions {
  symbol: string;
  /** Timeframes to check (default: the configured allowlist). */
  timeframes?: Timeframe[];
  /** Injectable clock (epoch ms) — deterministic tests. */
  now?: () => number;
  /** How many recent CLOSED candles per timeframe feed the gap scan. */
  scanWindowBars?: number;
}

function toSec(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

export async function computeReadiness(opts: ReadinessOptions): Promise<ReadinessResult> {
  const nowMs = opts.now ?? Date.now;
  const nowSec = Math.floor(nowMs() / 1000);
  const timeframes = opts.timeframes ?? (config.market.timeframes as readonly Timeframe[]);
  const scanWindow = Math.min(Math.max(20, opts.scanWindowBars ?? 100), 500);
  const checkedAtUtc = new Date(nowMs()).toISOString();

  // ---- Tick ---------------------------------------------------------------
  const tickRow = await db.marketLatestTick.findUnique({ where: { symbol: opts.symbol } }).catch(() => null);
  const tick: TickReadiness = (() => {
    if (!tickRow) {
      return {
        state: 'MISSING',
        bid: null,
        ask: null,
        spread: null,
        lastTickTimeUtc: null,
        ageSeconds: null,
        stalenessThresholdSeconds: config.market.staleTickSec,
        errorCodes: [ErrorCode.DATA_MISSING],
      };
    }
    const tickSec = toSec(tickRow.tickTimeUtc);
    const codes: string[] = [];
    let state: QualityState = freshnessState(tickSec, nowSec, config.market.staleTickSec);
    if (tickRow.validationStatus === 'INVALID') {
      state = 'INVALID';
      codes.push(ErrorCode.TICK_INVALID);
    } else if (tickRow.validationStatus === 'WARNING') {
      state = state === 'VALID' ? 'WARNING' : state;
      codes.push(ErrorCode.TICK_ZERO_SPREAD);
    }
    if (state === 'STALE') codes.push(ErrorCode.TICK_STALE, ErrorCode.DATA_STALE);
    if (state === 'MISSING') codes.push(ErrorCode.DATA_MISSING);
    return {
      state,
      bid: tickRow.bid,
      ask: tickRow.ask,
      spread: tickRow.spread,
      lastTickTimeUtc: tickRow.tickTimeUtc.toISOString(),
      ageSeconds: ageSeconds(tickSec, nowSec),
      stalenessThresholdSeconds: config.market.staleTickSec,
      errorCodes: [...new Set(codes)],
    };
  })();

  // ---- Symbol specification (verified values only) --------------------------
  const spec = await db.symbolSpec.findUnique({ where: { symbol: opts.symbol } }).catch(() => null);
  const specMissing = spec === null;

  // ---- Per-timeframe closed candles + gap scan ------------------------------
  const tfResults: TimeframeReadiness[] = [];
  for (const tf of timeframes) {
    const thresholdSec = config.market.staleTfSec[tf] ?? 3 * TIMEFRAME_SECONDS[tf];
    const closed = await db.marketCandle
      .findMany({
        where: { symbol: opts.symbol, timeframe: tf, isForming: false },
        orderBy: { candleTimeUtc: 'desc' },
        take: scanWindow,
        select: { candleTimeUtc: true, validationStatus: true, source: true },
      })
      .catch(() => []);

    const codes: string[] = [];
    if (closed.length === 0) {
      tfResults.push({
        timeframe: tf,
        state: 'MISSING',
        lastClosedCandleTimeUtc: null,
        lastClosedCandleAgeSeconds: null,
        stalenessThresholdSeconds: thresholdSec,
        scannedCandles: 0,
        missingCandles: 0,
        possibleClosureGaps: 0,
        errorCodes: [ErrorCode.DATA_MISSING],
      });
      continue;
    }

    const lastClosedSec = toSec(closed[0].candleTimeUtc);
    let state: QualityState = freshnessState(lastClosedSec, nowSec, thresholdSec);
    if (closed[0].validationStatus === 'WARNING' && state === 'VALID') state = 'WARNING';
    if (state === 'STALE') codes.push(ErrorCode.DATA_STALE);

    // Session-aware gap scan across the scanned window (closed bars only).
    const present = closed.map((c) => toSec(c.candleTimeUtc)).sort((a, b) => a - b);
    const gaps = findMissingCandles(present, {
      timeframe: tf,
      fromUtcSec: present[0],
      toUtcSec: present[present.length - 1] + TIMEFRAME_SECONDS[tf],
      nowUtcSec: nowSec,
      maxGaps: 200,
    });
    const suspicious = gaps.filter((g) => g.severity === 'warning').length;
    const likelyClosed = gaps.length - suspicious;
    if (suspicious > 0) {
      codes.push(ErrorCode.GAP_POSSIBLE);
      if (state === 'VALID') state = 'WARNING';
    }

    tfResults.push({
      timeframe: tf,
      state,
      lastClosedCandleTimeUtc: closed[0].candleTimeUtc.toISOString(),
      lastClosedCandleAgeSeconds: ageSeconds(lastClosedSec, nowSec),
      stalenessThresholdSeconds: thresholdSec,
      scannedCandles: closed.length,
      missingCandles: suspicious,
      possibleClosureGaps: likelyClosed,
      errorCodes: [...new Set(codes)],
    });
  }

  // ---- Demo-source policy: demo data is NEVER analysis-ready -----------------
  const demoSourced =
    (tickRow?.source ?? '').includes('demo') ||
    tfResults.length > 0
      ? (
          await db.marketCandle
            .findFirst({
              where: { symbol: opts.symbol },
              orderBy: { candleTimeUtc: 'desc' },
              select: { source: true },
            })
            .catch(() => null)
        )?.source.includes('demo') ?? false
      : false;

  const qualityState = worstQualityState([
    tick.state,
    ...tfResults.map((t) => t.state),
    ...(specMissing ? (['WARNING'] as QualityState[]) : []),
  ]);

  const errorCodes = [
    ...new Set([
      ...tick.errorCodes,
      ...tfResults.flatMap((t) => t.errorCodes),
      ...(specMissing ? [ErrorCode.SPEC_MISSING] : []),
      ...(demoSourced ? [ErrorCode.SOURCE_DEMO] : []),
    ]),
  ];

  // ready = every checked timeframe AND the tick are present & fresh
  // (VALID, or at most WARNING — warnings stay visible, never "VALID").
  const perTfOk = tfResults.every((t) => t.state === 'VALID' || t.state === 'WARNING');
  const tickOk = tick.state === 'VALID' || tick.state === 'WARNING';
  const ready = perTfOk && tickOk && !demoSourced && tfResults.length > 0;

  const lastClosedTimes = tfResults
    .map((t) => t.lastClosedCandleTimeUtc)
    .filter((v): v is string => v !== null)
    .map((v) => Math.floor(new Date(v).getTime() / 1000));
  const newestDataSec = Math.max(
    ...(lastClosedTimes.length > 0 ? lastClosedTimes : [Number.NEGATIVE_INFINITY]),
    tick.lastTickTimeUtc ? Math.floor(new Date(tick.lastTickTimeUtc).getTime() / 1000) : Number.NEGATIVE_INFINITY,
  );

  return {
    ready,
    purpose: 'data-readiness-only-not-trade-recommendation',
    symbol: opts.symbol,
    timeframesChecked: [...timeframes],
    source: tickRow?.source ?? null,
    checkedAtUtc,
    lastTickTimeUtc: tick.lastTickTimeUtc,
    lastClosedCandleTimeUtc:
      lastClosedTimes.length > 0 ? new Date(Math.max(...lastClosedTimes) * 1000).toISOString() : null,
    dataAgeSeconds: Number.isFinite(newestDataSec) ? Math.max(0, nowSec - newestDataSec) : null,
    qualityState,
    errorCodes,
    tick,
    timeframes: tfResults,
  };
}

/**
 * Downstream-analysis gate: returns the readiness result when data is ready,
 * otherwise a structured UNAVAILABLE result. Callers must NEVER bypass this
 * and must never fabricate candles or force a signal when it refuses.
 */
export async function getAnalysisReadiness(
  opts: ReadinessOptions,
): Promise<ReadinessResult | { ready: false; qualityState: 'UNAVAILABLE'; errorCodes: string[]; reason: string }> {
  const result = await computeReadiness(opts);
  if (result.ready) return result;
  return {
    ready: false,
    qualityState: 'UNAVAILABLE',
    errorCodes: result.errorCodes,
    reason: `Market data for ${opts.symbol} is not analysis-ready (state: ${result.qualityState}). Analysis must NOT run.`,
  };
}
