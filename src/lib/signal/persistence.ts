/**
 * XAUUSD AI Trading Agent — Signal Persistence (Phase 9, Task B5)
 * ----------------------------------------------------------------------------
 * Database edge of the signal engine. Loads the closed-candle windows through
 * the Phase 4 analysis loader (identical semantics: forming and INVALID rows
 * are never analysed; read-time re-validation) and saves EVERY evaluation as
 * an append-only SignalEvaluation row — the original result is never
 * overwritten when a new evaluation is generated.
 */

import type { PrismaClient } from '@prisma/client';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import { loadAnalysisInput } from '@/lib/analysis/persistence';
import type { TfLoadedData } from '@/lib/analysis/types';
import type { SignalEvaluation, SignalWindow, StrategyRules } from './types';

export interface LoadedSignalWindows {
  digits: number | null;
  execution: SignalWindow;
  h1: SignalWindow;
  h4: SignalWindow;
  /** True when any loaded row is demo-labelled (blocks before evaluation). */
  demoRows: boolean;
  formingExcluded: number;
  invalidExcluded: number;
  windowGapsSuspicious: number;
}

/** Load the three closed-candle windows (execution + context TFs). */
export async function loadSignalWindows(
  db: PrismaClient,
  symbol: string,
  rules: StrategyRules,
  nowUtcSec: number,
): Promise<LoadedSignalWindows> {
  const tfs: Timeframe[] = [rules.executionTf, ...rules.contextTfs];
  const loaded = await loadAnalysisInput(db, symbol, tfs, {
    maxBarsPerTf: rules.windowBars,
    nowUtcSec,
  });

  const toWindow = (tf: Timeframe, data: TfLoadedData | undefined): SignalWindow => {
    const bounded = data && data.candles.length > rules.windowBars
      ? data.candles.slice(data.candles.length - rules.windowBars)
      : (data?.candles ?? []);
    return { timeframe: tf, candles: bounded, source: data?.source ?? null };
  };

  const execution = toWindow(rules.executionTf, loaded.perTimeframe.get(rules.executionTf));
  const h1 = toWindow('H1', loaded.perTimeframe.get('H1'));
  const h4 = toWindow('H4', loaded.perTimeframe.get('H4'));

  return {
    digits: loaded.digits,
    execution,
    h1,
    h4,
    demoRows: [...loaded.perTimeframe.values()].some((d) => d.demoRows),
    formingExcluded: [...loaded.perTimeframe.values()].reduce((s, d) => s + d.formingExcluded, 0),
    invalidExcluded: [...loaded.perTimeframe.values()].reduce((s, d) => s + d.invalidExcluded, 0),
    windowGapsSuspicious: [...loaded.perTimeframe.values()].reduce((s, d) => s + d.windowGapsSuspicious, 0),
  };
}

export interface SaveSignalEvaluationArgs {
  evaluation: SignalEvaluation;
  quote: Record<string, unknown>;
  durationMs: number;
  startedAtUtc: Date;
}

export interface SavedSignalEvaluation {
  id: string;
  persistedAtUtc: string;
}

/** Append-only persistence — a new row per evaluation, never an update. */
export async function saveSignalEvaluation(
  db: PrismaClient,
  args: SaveSignalEvaluationArgs,
): Promise<SavedSignalEvaluation> {
  const e = args.evaluation;
  const row = await db.signalEvaluation.create({
    data: {
      engineVersion: e.engineVersion,
      strategyVersion: e.strategyVersion,
      symbol: e.symbol,
      outcome: e.outcome,
      reasonCodes: JSON.stringify(e.reasonCodes),
      inputFingerprint: e.inputFingerprint || '',
      datasetFingerprint: e.datasetFingerprint,
      inputSnapshot: JSON.stringify({
        windows: e.evidence
          ? {
              execution: e.evidence.executionWindow,
              h1: e.evidence.h1Window,
              h4: e.evidence.h4Window,
            }
          : null,
        rules: null, // rules snapshot added by the service (kept small)
      }),
      evidence: JSON.stringify(e.evidence ?? {}),
      levels: e.levels ? JSON.stringify(e.levels) : null,
      decisionCandleTimeUtc: e.decisionCandleTimeUtc ? new Date(e.decisionCandleTimeUtc) : null,
      setupKnownAtUtc: e.setupKnownAtUtc ? new Date(e.setupKnownAtUtc) : null,
      expiryUtc: e.expiryUtc ? new Date(e.expiryUtc) : null,
      quote: JSON.stringify(args.quote),
      executionLocked: true, // recorded per row — Phase 9 is read-only by design
      durationMs: args.durationMs,
    },
  });
  return { id: row.id, persistedAtUtc: row.createdAt.toISOString() };
}

/** Latest evaluation for a symbol (parsed, honest — absent stays absent). */
export interface LatestSignalEvaluation {
  id: string;
  createdAt: string;
  outcome: string;
  reasonCodes: string[];
  engineVersion: string;
  strategyVersion: string;
  symbol: string;
  decisionCandleTimeUtc: string | null;
  setupKnownAtUtc: string | null;
  expiryUtc: string | null;
  levels: SignalEvaluation['levels'];
  evidence: SignalEvaluation['evidence'];
  inputFingerprint: string;
  datasetFingerprint: string | null;
  executionLocked: boolean;
  quote: Record<string, unknown> | null;
  durationMs: number | null;
}

function parseLatestRow(row: {
  id: string;
  createdAt: Date;
  outcome: string;
  reasonCodes: string;
  engineVersion: string;
  strategyVersion: string;
  symbol: string;
  decisionCandleTimeUtc: Date | null;
  setupKnownAtUtc: Date | null;
  expiryUtc: Date | null;
  levels: string | null;
  evidence: string;
  inputFingerprint: string;
  datasetFingerprint: string | null;
  executionLocked: boolean;
  quote: string;
  durationMs: number | null;
}): LatestSignalEvaluation {
  const safeParse = <T,>(s: string, fallback: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    outcome: row.outcome,
    reasonCodes: safeParse<string[]>(row.reasonCodes, []),
    engineVersion: row.engineVersion,
    strategyVersion: row.strategyVersion,
    symbol: row.symbol,
    decisionCandleTimeUtc: row.decisionCandleTimeUtc?.toISOString() ?? null,
    setupKnownAtUtc: row.setupKnownAtUtc?.toISOString() ?? null,
    expiryUtc: row.expiryUtc?.toISOString() ?? null,
    levels: row.levels ? safeParse<SignalEvaluation['levels']>(row.levels, null) : null,
    evidence: safeParse<SignalEvaluation['evidence']>(row.evidence, null),
    inputFingerprint: row.inputFingerprint,
    datasetFingerprint: row.datasetFingerprint,
    executionLocked: row.executionLocked,
    quote: safeParse<Record<string, unknown> | null>(row.quote, null),
    durationMs: row.durationMs,
  };
}

export async function getLatestSignalEvaluation(
  db: PrismaClient,
  symbol?: string,
): Promise<LatestSignalEvaluation | null> {
  const row = await db.signalEvaluation
    .findFirst({ where: symbol ? { symbol } : undefined, orderBy: { createdAt: 'desc' } })
    .catch(() => null);
  return row ? parseLatestRow(row) : null;
}

export async function getSignalEvaluationHistory(
  db: PrismaClient,
  symbol?: string,
  limit = 20,
): Promise<LatestSignalEvaluation[]> {
  const rows = await db.signalEvaluation
    .findMany({
      where: symbol ? { symbol } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(1, limit), 100),
    })
    .catch(() => []);
  return rows.map(parseLatestRow);
}
