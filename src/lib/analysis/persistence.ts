/**
 * XAUUSD AI Trading Agent — Analysis Persistence (Phase 4)
 * ----------------------------------------------------------------------------
 * Database edge of the engine. The loader supplies the exact closed-candle
 * window per timeframe (forming and INVALID rows are never analysed); the
 * saver records honest, reproducible AnalysisRun rows:
 *
 *   · status: completed | blocked | failed (+ pending reserved; never used
 *     to present an unfinished run as valid).
 *   · The EXACT normalized input snapshot is persisted (canonical decimal
 *     text prices) alongside the sha256 input fingerprint, the calculation
 *     config and the full deterministic result.
 *   · Failures are recorded as failures — never silently marked completed.
 */

import type { PrismaClient } from '@prisma/client';
import { findMissingCandles } from '@/lib/market/validation';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import type { AnalysisResult, TfLoadedData } from './types';

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface LoadedAnalysisInput {
  digits: number | null;
  perTimeframe: Map<Timeframe, TfLoadedData>;
}

export interface LoadOptions {
  maxBarsPerTf: number; // bounded window (config.analysis.maxBarsPerTf)
  nowUtcSec: number; // explicit clock — no Date.now() here
}

export async function loadAnalysisInput(
  db: PrismaClient,
  symbol: string,
  timeframes: Timeframe[],
  opts: LoadOptions,
): Promise<LoadedAnalysisInput> {
  const spec = await db.symbolSpec.findUnique({ where: { symbol } }).catch(() => null);
  const digits = spec?.digits ?? null;

  const perTimeframe = new Map<Timeframe, TfLoadedData>();

  for (const tf of timeframes) {
    const tfSec = TIMEFRAME_SECONDS[tf];

    // Latest N closed, non-INVALID candles (ascending).
    const rowsDesc = await db.marketCandle
      .findMany({
        where: { symbol, timeframe: tf, isForming: false, validationStatus: { in: ['VALID', 'WARNING'] } },
        orderBy: { candleTimeUtc: 'desc' },
        take: opts.maxBarsPerTf,
      })
      .catch(() => []);
    const rows = [...rowsDesc].reverse();

    // Row-level facts (bounded, honest).
    const formingExcluded = await db.marketCandle
      .count({ where: { symbol, timeframe: tf, isForming: true } })
      .catch(() => 0);
    let invalidExcluded = await db.marketCandle
      .count({ where: { symbol, timeframe: tf, validationStatus: 'INVALID' } })
      .catch(() => 0);

    // Defensive re-validation at READ time (defense in depth): a row whose
    // decimal text cannot parse to a finite, positive, OHLC-consistent price
    // is excluded and counted — it can never enter the analysis window.
    const accepted: TfLoadedData['candles'] = [];
    for (const r of rows) {
      const o = Number(r.open);
      const h = Number(r.high);
      const l = Number(r.low);
      const c = Number(r.close);
      const ok =
        [o, h, l, c].every((v) => Number.isFinite(v) && v > 0) &&
        h >= Math.max(o, c) &&
        l <= Math.min(o, c) &&
        l <= h;
      if (!ok) {
        invalidExcluded += 1;
        continue;
      }
      accepted.push({
        timeUtcSec: Math.floor(r.candleTimeUtc.getTime() / 1000),
        open: o,
        high: h,
        low: l,
        close: c,
        volume: r.tickVolume,
        openText: r.open,
        highText: r.high,
        lowText: r.low,
        closeText: r.close,
      });
    }
    const candles = accepted;

    // In-window continuity scan (session-aware, reusing Phase 3 logic).
    let windowGapsSuspicious = 0;
    let windowClosureGaps = 0;
    if (candles.length >= 2) {
      const times = candles.map((c) => c.timeUtcSec);
      const gaps = findMissingCandles(times, {
        timeframe: tf,
        fromUtcSec: times[0],
        toUtcSec: times[times.length - 1] + tfSec,
        nowUtcSec: opts.nowUtcSec,
        maxGaps: 500,
      });
      for (const g of gaps) {
        if (g.severity === 'warning') windowGapsSuspicious += 1;
        else windowClosureGaps += 1;
      }
    }

    const source = rows.length > 0 ? rows[rows.length - 1].source : null;
    const demoRows = rows.some((r) => r.source.includes('demo'));

    perTimeframe.set(tf, {
      timeframe: tf,
      candles,
      source,
      formingExcluded,
      invalidExcluded,
      demoRows,
      windowGapsSuspicious,
      windowClosureGaps,
    });
  }

  return { digits, perTimeframe };
}

/** The exact normalized input snapshot persisted for reproducibility. */
export function buildInputSnapshot(loaded: LoadedAnalysisInput, symbol: string): Record<string, unknown> {
  const perTimeframe: Record<string, unknown> = {};
  for (const [tf, data] of loaded.perTimeframe) {
    perTimeframe[tf] = {
      source: data.source,
      formingExcluded: data.formingExcluded,
      invalidExcluded: data.invalidExcluded,
      candles: data.candles.map((c) => ({
        t: c.timeUtcSec,
        o: c.openText,
        h: c.highText,
        l: c.lowText,
        c: c.closeText,
        v: c.volume,
      })),
    };
  }
  return { symbol, digits: loaded.digits, perTimeframe };
}

// ---------------------------------------------------------------------------
// Saver
// ---------------------------------------------------------------------------

export interface SaveAnalysisRunArgs {
  result: AnalysisResult;
  inputSnapshot: Record<string, unknown>;
  durationMs: number;
  startedAtUtc: Date;
}

export interface SavedAnalysisRun {
  id: string;
  status: string;
  persistedAtUtc: string;
}

export async function saveAnalysisRun(db: PrismaClient, args: SaveAnalysisRunArgs): Promise<SavedAnalysisRun> {
  const statusMap: Record<string, string> = {
    COMPLETED: 'completed',
    BLOCKED: 'blocked',
    FAILED: 'failed',
  };
  const status = statusMap[args.result.status] ?? 'failed';
  const completedAt = new Date();
  const row = await db.analysisRun.create({
    data: {
      symbol: args.result.symbol,
      engineVersion: args.result.engineVersion,
      timeframes: JSON.stringify(args.result.timeframes),
      input: JSON.stringify(args.inputSnapshot),
      result: JSON.stringify(args.result),
      status,
      reasonCodes: JSON.stringify(args.result.reasonCodes),
      warnings: JSON.stringify(args.result.warnings),
      inputFingerprint: args.result.inputFingerprint,
      calculationConfig: JSON.stringify(args.result.calculationConfig),
      generatedAtUtc: args.result.generatedAtUtc ? new Date(args.result.generatedAtUtc) : null,
      durationMs: args.durationMs,
      startedAt: args.startedAtUtc,
      completedAt,
    },
  });
  return { id: row.id, status: row.status, persistedAtUtc: completedAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Latest-run retrieval (GET /api/analysis/latest)
// ---------------------------------------------------------------------------

export interface LatestAnalysisRow {
  id: string;
  symbol: string;
  engineVersion: string;
  status: string;
  timeframes: string[];
  reasonCodes: string[];
  warnings: string[];
  inputFingerprint: string | null;
  generatedAtUtc: string | null;
  startedAtUtc: string;
  completedAtUtc: string | null;
  durationMs: number | null;
  analysis: AnalysisResult | null; // parsed deterministic result
}

export async function getLatestAnalysisRun(
  db: PrismaClient,
  symbol?: string,
): Promise<LatestAnalysisRow | null> {
  const row = await db.analysisRun
    .findFirst({
      where: symbol ? { symbol } : undefined,
      orderBy: { startedAt: 'desc' },
    })
    .catch(() => null);
  if (!row) return null;

  let analysis: AnalysisResult | null = null;
  try {
    analysis = JSON.parse(row.result) as AnalysisResult;
  } catch {
    analysis = null; // a corrupt result JSON is reported as absent — never guessed
  }

  const parseJsonArray = (s: string | null): string[] => {
    if (!s) return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  };

  return {
    id: row.id,
    symbol: row.symbol,
    engineVersion: row.engineVersion,
    status: row.status,
    timeframes: parseJsonArray(row.timeframes),
    reasonCodes: parseJsonArray(row.reasonCodes),
    warnings: parseJsonArray(row.warnings),
    inputFingerprint: row.inputFingerprint,
    generatedAtUtc: row.generatedAtUtc ? row.generatedAtUtc.toISOString() : null,
    startedAtUtc: row.startedAt.toISOString(),
    completedAtUtc: row.completedAt ? row.completedAt.toISOString() : null,
    durationMs: row.durationMs,
    analysis,
  };
}
