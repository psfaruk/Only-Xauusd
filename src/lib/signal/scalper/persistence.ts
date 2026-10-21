/**
 * XAUUSD AI Trading Agent — Scalper Persistence (Phase 12, Task 32)
 * ----------------------------------------------------------------------------
 * Database edge of the scalper strategy. Persists every evaluation as an
 * append-only SignalEvaluation row (own strategyVersion — same table, same
 * audit discipline as the baseline) and answers the cooldown/dedup/history
 * queries the service needs.
 */

import type { PrismaClient } from '@prisma/client';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import { loadAnalysisInput } from '@/lib/analysis/persistence';
import type { TfLoadedData } from '@/lib/analysis/types';
import type { SignalWindow } from '../types';
import type { ScalperEvaluation, ScalperRules } from './types';
import { SCALPER_STRATEGY_VERSION } from './types';
import { setupFingerprintOf } from './core';

export interface LoadedScalperWindows {
  digits: number | null;
  m15: SignalWindow;
  m5: SignalWindow;
  m1: SignalWindow;
  /** Task 36 — higher-timeframe context windows (empty when H1/H4 have not
   *  been synced yet; the HTF trend read then degrades to null). */
  h1: SignalWindow;
  h4: SignalWindow;
  demoRows: boolean;
  windowGapsSuspicious: number;
}

/** Load the three fast closed-candle windows (M15 / M5 / M1) plus the
 *  higher-timeframe context windows (H1 / H4 — Task 36 trend gate). */
export async function loadScalperWindows(
  db: PrismaClient,
  symbol: string,
  rules: ScalperRules,
  nowUtcSec: number,
): Promise<LoadedScalperWindows> {
  const tfs: Timeframe[] = ['M15', 'M5', 'M1', 'H1', 'H4'];
  const loaded = await loadAnalysisInput(db, symbol, tfs, {
    maxBarsPerTf: rules.windowBars,
    nowUtcSec,
  });

  const toWindow = (tf: Timeframe, data: TfLoadedData | undefined): SignalWindow => {
    const bounded =
      data && data.candles.length > rules.windowBars
        ? data.candles.slice(data.candles.length - rules.windowBars)
        : (data?.candles ?? []);
    return { timeframe: tf, candles: bounded, source: data?.source ?? null };
  };

  return {
    digits: loaded.digits,
    m15: toWindow('M15', loaded.perTimeframe.get('M15')),
    m5: toWindow('M5', loaded.perTimeframe.get('M5')),
    m1: toWindow('M1', loaded.perTimeframe.get('M1')),
    h1: toWindow('H1', loaded.perTimeframe.get('H1')),
    h4: toWindow('H4', loaded.perTimeframe.get('H4')),
    demoRows: [...loaded.perTimeframe.values()].some((d) => d.demoRows),
    windowGapsSuspicious: [...loaded.perTimeframe.values()].reduce(
      (s, d) => s + d.windowGapsSuspicious,
      0,
    ),
  };
}

export interface SaveScalperEvaluationArgs {
  evaluation: ScalperEvaluation;
  quote: Record<string, unknown>;
  durationMs: number;
  rules: ScalperRules;
  digits: number | null;
  /** True when the execution lock blocked order placement for this row. */
  executionLocked: boolean;
}

/** Append-only persistence — a new row per evaluation, never an update. */
export async function saveScalperEvaluation(
  db: PrismaClient,
  args: SaveScalperEvaluationArgs,
): Promise<{ id: string; persistedAtUtc: string }> {
  const e = args.evaluation;
  const setupFingerprint = setupFingerprintOf(e);
  const row = await db.signalEvaluation.create({
    data: {
      engineVersion: e.engineVersion,
      strategyVersion: SCALPER_STRATEGY_VERSION,
      symbol: e.symbol,
      outcome: e.outcome,
      reasonCodes: JSON.stringify(e.reasonCodes),
      inputFingerprint: e.inputFingerprint || '',
      setupFingerprint,
      datasetFingerprint: e.datasetFingerprint,
      inputSnapshot: JSON.stringify({
        scalperRules: args.rules,
        windows: e.evidence
          ? {
              m15: e.evidence.executionWindow,
              h1: e.evidence.h1Window,
              h4: e.evidence.h4Window,
            }
          : null,
      }),
      evidence: JSON.stringify(e.evidence ?? {}),
      levels: e.levels ? JSON.stringify(e.levels) : null,
      decisionCandleTimeUtc: e.decisionCandleTimeUtc ? new Date(e.decisionCandleTimeUtc) : null,
      setupKnownAtUtc: e.setupKnownAtUtc ? new Date(e.setupKnownAtUtc) : null,
      expiryUtc: e.expiryUtc ? new Date(e.expiryUtc) : null,
      quote: JSON.stringify(args.quote),
      executionLocked: args.executionLocked,
      durationMs: args.durationMs,
    },
  });
  return { id: row.id, persistedAtUtc: row.createdAt.toISOString() };
}

/** The latest EMITTED scalper setup row (BUY_SETUP/SELL_SETUP) — the cooldown
 *  anchor. Null when no setup has ever been emitted. */
export interface LatestScalperSetup {
  id: string;
  createdAtUtcSec: number;
  setupFingerprint: string | null;
}

export async function getLatestScalperSetup(
  db: PrismaClient,
  symbol: string,
): Promise<LatestScalperSetup | null> {
  const row = await db.signalEvaluation
    .findFirst({
      where: {
        symbol,
        strategyVersion: SCALPER_STRATEGY_VERSION,
        outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, setupFingerprint: true },
    })
    .catch(() => null);
  if (!row) return null;
  return {
    id: row.id,
    createdAtUtcSec: Math.floor(row.createdAt.getTime() / 1000),
    setupFingerprint: row.setupFingerprint ?? null,
  };
}

/** Distinct setup fingerprints emitted in the recent past (bounded window —
 *  the same-bar dedup set). `sinceUtcSec` is the lower bound. */
export async function getRecentScalperSetupFingerprints(
  db: PrismaClient,
  symbol: string,
  sinceUtcSec: number,
): Promise<Set<string>> {
  const rows = await db.signalEvaluation
    .findMany({
      where: {
        symbol,
        strategyVersion: SCALPER_STRATEGY_VERSION,
        outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] },
        createdAt: { gte: new Date(sinceUtcSec * 1000) },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { setupFingerprint: true },
    })
    .catch(() => []);
  const out = new Set<string>();
  for (const r of rows) {
    if (r.setupFingerprint) out.add(r.setupFingerprint);
  }
  return out;
}

/** Latest scalper evaluation row (any outcome), parsed for the API/UI. */
export interface LatestScalperEvaluation {
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
  levels: ScalperEvaluation['levels'];
  evidence: ScalperEvaluation['evidence'];
  inputFingerprint: string;
  datasetFingerprint: string | null;
  setupFingerprint: string | null;
  executionLocked: boolean;
  durationMs: number | null;
}

type RawRow = {
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
  setupFingerprint: string | null;
  executionLocked: boolean;
  durationMs: number | null;
};

export function parseScalperRow(row: RawRow): LatestScalperEvaluation {
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
    levels: row.levels ? safeParse<ScalperEvaluation['levels']>(row.levels, null) : null,
    evidence: safeParse<ScalperEvaluation['evidence']>(row.evidence, null),
    inputFingerprint: row.inputFingerprint,
    datasetFingerprint: row.datasetFingerprint,
    setupFingerprint: row.setupFingerprint ?? null,
    executionLocked: row.executionLocked,
    durationMs: row.durationMs,
  };
}

export async function getLatestScalperEvaluation(
  db: PrismaClient,
  symbol: string,
): Promise<LatestScalperEvaluation | null> {
  const row = await db.signalEvaluation
    .findFirst({
      where: { symbol, strategyVersion: SCALPER_STRATEGY_VERSION },
      orderBy: { createdAt: 'desc' },
    })
    .catch(() => null);
  return row ? parseScalperRow(row) : null;
}

/** Recent EMITTED setups (for the UI's last-hour strip + hourly counter). */
export async function getRecentScalperSetups(
  db: PrismaClient,
  symbol: string,
  sinceUtcSec: number,
  limit = 20,
): Promise<LatestScalperEvaluation[]> {
  const rows = await db.signalEvaluation
    .findMany({
      where: {
        symbol,
        strategyVersion: SCALPER_STRATEGY_VERSION,
        outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] },
        createdAt: { gte: new Date(sinceUtcSec * 1000) },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(1, limit), 100),
    })
    .catch(() => []);
  return rows.map(parseScalperRow);
}

/** Duration of one source-TF bar (tests + service diagnostics). */
export function scalperTfSec(tf: 'M15' | 'M5' | 'M1'): number {
  return TIMEFRAME_SECONDS[tf];
}
