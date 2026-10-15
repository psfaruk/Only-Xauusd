/**
 * XAUUSD AI Trading Agent — Validation Service (Phase 10)
 * ----------------------------------------------------------------------------
 * Loads ONLY verified broker candles from the DB, runs the Phase 10 validation
 * harness and persists an honest ValidationRun row. Fail-closed: insufficient
 * history → status 'insufficient_data' with the full honest result (empty
 * segments, INCONCLUSIVE interpretation) — never invented metrics.
 *
 * Analysis bookkeeping only — no execution anywhere.
 */

import { db } from '@/lib/db';
import { config } from '@/lib/config';
import type { Timeframe } from '@/lib/market/types';
import { loadVerifiedCandles } from './service';
import {
  defaultValidationRules,
  runValidation,
  type ValidationResult,
  type ValidationRules,
} from './validation';

export interface RunValidationOutcome {
  runId: string | null;
  status: 'completed' | 'insufficient_data' | 'failed';
  result: ValidationResult | null;
  error: string | null;
}

/** Last known observation when no live tick is available (labeled in output). */
const FALLBACK_OBSERVED_SPREAD = 0.24;

async function observedSpread(symbol: string): Promise<{ value: number; source: 'live_tick' | 'fallback' }> {
  const tick = await db.marketLatestTick.findUnique({ where: { symbol } }).catch(() => null);
  const s = tick?.spread ? Number(tick.spread) : NaN;
  if (Number.isFinite(s) && s > 0) return { value: s, source: 'live_tick' };
  return { value: FALLBACK_OBSERVED_SPREAD, source: 'fallback' };
}

export async function runValidationService(opts: {
  symbol: string;
  maxCandles?: number;
  now?: () => number;
}): Promise<RunValidationOutcome> {
  const startedAt = Date.now();
  const maxCandles = Math.min(opts.maxCandles ?? 2000, config.market.backfillMaxBars);

  try {
    const strategyConfigModule = await import('@/lib/signal/rules');
    const strategy = strategyConfigModule.buildStrategyRules();
    const [exec, h1, h4, spread] = await Promise.all([
      loadVerifiedCandles(opts.symbol, 'M15' as Timeframe, maxCandles),
      loadVerifiedCandles(opts.symbol, 'H1' as Timeframe, maxCandles),
      loadVerifiedCandles(opts.symbol, 'H4' as Timeframe, maxCandles),
      observedSpread(opts.symbol),
    ]);
    const digits = exec.digits ?? h1.digits ?? h4.digits ?? null;
    const excludedTotal = exec.excluded + h1.excluded + h4.excluded;

    const rules: ValidationRules = defaultValidationRules(spread.value);
    const result = runValidation(
      opts.symbol,
      exec.candles,
      h1.candles,
      h4.candles,
      digits,
      spread.value,
      rules,
      strategy,
    );
    if (spread.source === 'fallback') {
      result.warnings.push(
        `No live tick spread available at run time — using the ${FALLBACK_OBSERVED_SPREAD} fallback observation (labeled assumption).`,
      );
    }
    if (excludedTotal > 0) {
      result.warnings.push(`${excludedTotal} persisted candles failed read-time OHLC re-validation and were excluded.`);
    }

    const status: RunValidationOutcome['status'] =
      result.dataset.executionCandles < rules.minCandles ? 'insufficient_data' : 'completed';

    const run = await db.validationRun.create({
      data: {
        symbol: opts.symbol,
        strategyVersion: result.strategyVersion,
        harnessVersion: result.harnessVersion,
        status,
        datasetFingerprint: result.datasetFingerprint,
        datasetFromUtc: new Date((result.dataset.fromUtcSec || 0) * 1000),
        datasetToUtc: new Date((result.dataset.toUtcSec || 0) * 1000),
        candleCounts: JSON.stringify({ M15: result.dataset.executionCandles, H1: result.dataset.h1Candles, H4: result.dataset.h4Candles }),
        observedSpread: String(spread.value),
        // Trades are bounded in storage (the full trade list lives in the
        // harness result at run time; the persisted copy keeps 500).
        result: JSON.stringify({ ...result, trades: result.trades.slice(0, 500) }),
        limitations: JSON.stringify(result.limitations),
        durationMs: Date.now() - startedAt,
      },
    });

    return { runId: run.id, status, result, error: null };
  } catch (e) {
    return {
      runId: null,
      status: 'failed',
      result: null,
      error: e instanceof Error ? e.message : 'unknown error',
    };
  }
}

export interface LatestValidationRun {
  id: string;
  createdAt: string;
  symbol: string;
  strategyVersion: string;
  harnessVersion: string;
  status: string;
  datasetFingerprint: string;
  dataset: {
    fromUtc: string;
    toUtc: string;
    candleCounts: { M15: number; H1: number; H4: number };
    observedSpread: string;
  };
  result: ValidationResult;
  limitations: string[];
  durationMs: number;
}

export async function getLatestValidation(symbol: string): Promise<LatestValidationRun | null> {
  const row = await db.validationRun
    .findFirst({ where: { symbol }, orderBy: { createdAt: 'desc' } })
    .catch(() => null);
  if (!row) return null;
  let result: ValidationResult;
  try {
    result = JSON.parse(row.result) as ValidationResult;
  } catch {
    return null;
  }
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    symbol: row.symbol,
    strategyVersion: row.strategyVersion,
    harnessVersion: row.harnessVersion,
    status: row.status,
    datasetFingerprint: row.datasetFingerprint,
    dataset: {
      fromUtc: row.datasetFromUtc.toISOString(),
      toUtc: row.datasetToUtc.toISOString(),
      candleCounts: JSON.parse(row.candleCounts) as { M15: number; H1: number; H4: number },
      observedSpread: row.observedSpread,
    },
    result,
    limitations: JSON.parse(row.limitations) as string[],
    durationMs: row.durationMs,
  };
}
