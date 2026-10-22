/**
 * XAUUSD AI Trading Agent — Backtest service (Phase 8, Task 6)
 * ----------------------------------------------------------------------------
 * Loads ONLY verified broker candles from the DB, runs the simulator, and
 * persists an honest BacktestRun row. Fail-closed: no data → INSUFFICIENT_DATA
 * (never invented metrics). No execution anywhere — this is analysis bookkeeping.
 */

import { db } from '@/lib/db';
import { config } from '@/lib/config';
import type { AnalysisCandle } from '@/lib/analysis/types';
import type { Timeframe } from '@/lib/market/types';
import { TIMEFRAME_SECONDS } from '@/lib/market/types';
import { runBacktest, DEFAULT_RULES, type BacktestResult, type BacktestRules } from './engine';
import { bootstrapR, type BootstrapExpectancy } from './bootstrap';
import {
  buildSampleAdequacyReport,
  sampleAdequacyFromTradeCount,
  type DataRangeUtc,
  type SampleAdequacy,
} from './sample-adequacy';

export interface RunBacktestOptions {
  symbol: string;
  timeframe: Timeframe;
  rules?: Partial<BacktestRules>;
  maxCandles?: number;
}

export interface RunBacktestOutcome {
  runId: string | null;
  status: 'completed' | 'insufficient_data' | 'failed';
  result: BacktestResult | null;
  error: string | null;
}

/** Verified-candles-only loader. Read-time re-validation (Phase 4 loader
 *  semantics): NaN-text, non-positive or OHLC-inconsistent rows are EXCLUDED,
 *  never silently kept. */
export async function loadVerifiedCandles(
  symbol: string,
  timeframe: Timeframe,
  maxCandles: number,
): Promise<{ candles: AnalysisCandle[]; excluded: number; digits: number | null }> {
  const spec = await db.symbolSpec.findUnique({ where: { symbol } });
  const digits = spec?.digits ?? null;

  const rows = await db.marketCandle.findMany({
    where: {
      symbol,
      timeframe,
      isForming: false,          // forming bar is NEVER a completed candle
      validationStatus: 'VALID', // only broker-validated candles
      source: 'bridge-mt5',      // only the authenticated broker feed
    },
    orderBy: { candleTimeUtc: 'asc' },
    take: maxCandles,
  });

  let excluded = 0;
  const candles: AnalysisCandle[] = [];
  for (const r of rows) {
    const o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close);
    const ok =
      [o, h, l, c].every((v) => Number.isFinite(v) && v > 0) &&
      h >= Math.max(o, c) && l <= Math.min(o, c) && h >= l;
    if (!ok) { excluded++; continue; }
    candles.push({
      timeUtcSec: Math.floor(r.candleTimeUtc.getTime() / 1000),
      open: o, high: h, low: l, close: c,
      volume: r.tickVolume ?? null,
      openText: r.open, highText: r.high, lowText: r.low, closeText: r.close,
    });
  }
  return { candles, excluded, digits };
}

export async function runBacktestService(opts: RunBacktestOptions): Promise<RunBacktestOutcome> {
  const startedAt = Date.now();
  const rules: BacktestRules = { ...DEFAULT_RULES, ...opts.rules };
  const maxCandles = Math.min(
    opts.maxCandles ?? 2000,
    config.market.backfillMaxBars,
  );

  try {
    const { candles, excluded, digits } = await loadVerifiedCandles(opts.symbol, opts.timeframe, maxCandles);
    const result = runBacktest(
      opts.symbol, opts.timeframe,
      TIMEFRAME_SECONDS[opts.timeframe], candles, digits, rules,
    );
    if (excluded > 0) {
      result.dataset.exclusions.push(`${excluded} persisted candles failed read-time OHLC re-validation and were excluded.`);
    }

    const status: RunBacktestOutcome['status'] =
      candles.length < rules.minCandles ? 'insufficient_data' : 'completed';

    const run = await db.backtestRun.create({
      data: {
        strategyVersion: result.strategyVersion,
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        status,
        datasetFingerprint: result.datasetFingerprint,
        datasetFromUtc: new Date((result.dataset.fromUtcSec || 0) * 1000),
        datasetToUtc: new Date((result.dataset.toUtcSec || 0) * 1000),
        candleCount: result.dataset.candleCount,
        source: result.dataset.source,
        exclusions: JSON.stringify(result.dataset.exclusions),
        rules: JSON.stringify(result.rules),
        devMetrics: JSON.stringify(result.dev),
        oosMetrics: JSON.stringify(result.oos),
        trades: JSON.stringify(result.trades.slice(0, 500)), // bounded
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

export interface LatestBacktestRun {
  id: string;
  createdAt: string;
  strategyVersion: string;
  symbol: string;
  timeframe: string;
  status: string;
  datasetFingerprint: string;
  dataset: {
    fromUtc: string;
    toUtc: string;
    candleCount: number;
    source: string;
    exclusions: string[];
  };
  dev: Record<string, unknown>;
  oos: Record<string, unknown>;
  tradeCount: number;
  limitations: string[];
  rules: Record<string, unknown>;
  /** Phase 5 honesty block (Task 42-S3) — always present. */
  sampleAdequacy: SampleAdequacy;
  uncertaintyNote: string;
  dataRangeUtc: DataRangeUtc | null;
  /** Bootstrap CI over the stored trade list's R-multiples (null when the run
   *  stored no parseable trades — never fabricated). */
  bootstrapCi:
    | (Pick<BootstrapExpectancy, 'iterations' | 'samples' | 'expectancyR' | 'medianExpectancyR' | 'p05ExpectancyR' | 'p95ExpectancyR' | 'note'>)
    | null;
}

/** Parse the stored (bounded) trade JSON defensively — corrupt rows yield []. */
function parseStoredTrades(raw: string): Array<{ rMultiple?: unknown }> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<{ rMultiple?: unknown }>) : [];
  } catch {
    return [];
  }
}

export async function getLatestBacktest(symbol: string): Promise<LatestBacktestRun | null> {
  const row = await db.backtestRun.findFirst({
    where: { symbol },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;

  const trades = parseStoredTrades(row.trades);
  const tradeCount = trades.length;
  const dataRangeUtc: DataRangeUtc = {
    fromUtc: row.datasetFromUtc.toISOString(),
    toUtc: row.datasetToUtc.toISOString(),
  };
  const adequacy = buildSampleAdequacyReport(tradeCount, dataRangeUtc);

  // Bootstrap CI over the stored trade list when the R-multiples are available.
  const rMultiples = trades
    .map((t) => (typeof t.rMultiple === 'number' ? t.rMultiple : Number.NaN))
    .filter((v) => Number.isFinite(v));
  const bootstrapCi =
    rMultiples.length > 0
      ? (() => {
          const b = bootstrapR(rMultiples, 1000, 42);
          return {
            iterations: b.iterations,
            samples: b.samples,
            expectancyR: b.expectancyR,
            medianExpectancyR: b.medianExpectancyR,
            p05ExpectancyR: b.p05ExpectancyR,
            p95ExpectancyR: b.p95ExpectancyR,
            note: b.note,
          };
        })()
      : null;

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    strategyVersion: row.strategyVersion,
    symbol: row.symbol,
    timeframe: row.timeframe,
    status: row.status,
    datasetFingerprint: row.datasetFingerprint,
    dataset: {
      fromUtc: row.datasetFromUtc.toISOString(),
      toUtc: row.datasetToUtc.toISOString(),
      candleCount: row.candleCount,
      source: row.source,
      exclusions: JSON.parse(row.exclusions) as string[],
    },
    dev: JSON.parse(row.devMetrics) as Record<string, unknown>,
    oos: JSON.parse(row.oosMetrics) as Record<string, unknown>,
    tradeCount,
    limitations: JSON.parse(row.limitations) as string[],
    rules: JSON.parse(row.rules) as Record<string, unknown>,
    sampleAdequacy: adequacy.sampleAdequacy,
    uncertaintyNote: adequacy.uncertaintyNote,
    dataRangeUtc: adequacy.dataRangeUtc,
    bootstrapCi,
  };
}

/**
 * Phase 5 honesty block for callers that have NO run at all (null latest):
 * zero trades is INSUFFICIENT_EVIDENCE by definition — the label must still
 * be surfaced, never omitted.
 */
export function emptyBacktestHonestyBlock(): {
  sampleAdequacy: SampleAdequacy;
  tradeCount: number;
  uncertaintyNote: string;
  dataRangeUtc: DataRangeUtc | null;
  bootstrapCi: LatestBacktestRun['bootstrapCi'];
} {
  const adequacy = buildSampleAdequacyReport(0, null);
  return {
    sampleAdequacy: sampleAdequacyFromTradeCount(0),
    tradeCount: 0,
    uncertaintyNote: adequacy.uncertaintyNote,
    dataRangeUtc: null,
    bootstrapCi: null,
  };
}

// ---------------------------------------------------------------------------
// Signal-engine backtest (Phase 9, Task C) — validates the REAL signal core
// ---------------------------------------------------------------------------

import { runSignalBacktest, DEFAULT_SIGNAL_BACKTEST_RULES, type SignalBacktestResult, type SignalBacktestRules } from './signal-engine';
import { buildStrategyRules } from '@/lib/signal/rules';
import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';

export interface RunSignalBacktestOptions {
  symbol: string;
  maxCandles?: number;
  rules?: Partial<SignalBacktestRules>;
}

export interface RunSignalBacktestOutcome {
  runId: string | null;
  status: 'completed' | 'insufficient_data' | 'failed';
  result: SignalBacktestResult | null;
  error: string | null;
}

/** Run the signal-engine validation over verified M15/H1/H4 broker candles. */
export async function runSignalBacktestService(opts: RunSignalBacktestOptions): Promise<RunSignalBacktestOutcome> {
  const startedAt = Date.now();
  const rules: SignalBacktestRules = { ...DEFAULT_SIGNAL_BACKTEST_RULES, ...opts.rules };
  const maxCandles = Math.min(opts.maxCandles ?? 2000, config.market.backfillMaxBars);

  try {
    const strategy = buildStrategyRules();
    const load = async (tf: Timeframe) => loadVerifiedCandles(opts.symbol, tf, maxCandles);
    const [exec, h1, h4] = await Promise.all([load('M15'), load('H1'), load('H4')]);
    const digits = exec.digits ?? h1.digits ?? h4.digits ?? null;
    const excludedTotal = exec.excluded + h1.excluded + h4.excluded;

    const result = runSignalBacktest(
      opts.symbol,
      exec.candles,
      h1.candles,
      h4.candles,
      digits,
      rules,
      strategy,
    );
    if (excludedTotal > 0) {
      result.limitations.push(`${excludedTotal} persisted candles failed read-time OHLC re-validation and were excluded.`);
    }

    const status: RunSignalBacktestOutcome['status'] =
      result.dataset.executionCandles < rules.minCandles ? 'insufficient_data' : 'completed';

    const run = await db.backtestRun.create({
      data: {
        strategyVersion: SIGNAL_STRATEGY_VERSION, // the CURRENT signal-engine strategy
        symbol: opts.symbol,
        timeframe: 'M15+H1+H4',
        status,
        datasetFingerprint: result.datasetFingerprint,
        datasetFromUtc: new Date((result.dataset.fromUtcSec || 0) * 1000),
        datasetToUtc: new Date((result.dataset.toUtcSec || 0) * 1000),
        candleCount: result.dataset.executionCandles,
        source: result.dataset.source,
        exclusions: JSON.stringify(result.limitations),
        rules: JSON.stringify({ backtestRules: result.rules, strategyConfig: result.strategyConfig }),
        devMetrics: JSON.stringify(result.dev),
        oosMetrics: JSON.stringify(result.oos),
        trades: JSON.stringify(result.trades.slice(0, 500)), // bounded
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
