/**
 * XAUUSD AI Trading Agent — Candidate Persistence (Phase 11-E activation)
 * ----------------------------------------------------------------------------
 * Database edge of the CANDIDATE dual evaluation
 * (hybrid-multimodel-research/11.0.0-candidate.1) — the additive Phase 11-E
 * wiring of the pre-registered protocol audit/phase11-candidate-forward-protocol.md.
 *
 *   · loadCandidateM5Window — the M5 confirmation window (candidate-only TF)
 *     through the SAME Phase 4 loader semantics as the baseline windows
 *     (closed VALID/WARNING bars only, read-time re-validation, forming rows
 *     never analysed; window bound = the frozen CANDIDATE_RULES.m5WindowBars).
 *   · saveCandidateEvaluation — append-only candidate SignalEvaluation rows
 *     (strategyVersion = the candidate version, candidate input fingerprint,
 *     candidate-setup-identity/1 setup fingerprint, candidate-rules-snapshot/1
 *     rules snapshot). A NEW row per evaluation — never an update.
 *   · getLatestCandidateEvaluation — the candidate read side (parsed, honest;
 *     absent stays absent).
 *
 * CANNOT-MIX (protocol §4): candidate rows are persisted with the candidate
 * strategyVersion and read ONLY through these candidate-scoped functions;
 * every baseline query surface filters the baseline strategyVersion
 * (persistence.ts read functions default to the baseline). Research only —
 * no order, no execution, no lock change.
 */

import type { PrismaClient } from '@prisma/client';
import { loadAnalysisInput } from '@/lib/analysis/persistence';
import type { TfLoadedData } from '@/lib/analysis/types';
import type { Timeframe } from '@/lib/market/types';
import { CANDIDATE_RULES, CANDIDATE_STRATEGY_VERSION, type CandidateEvaluation, type CandidateModel } from './candidate/types';
import type { SignalLevels, SignalWindow, StrategyRules } from './types';
import {
  CANDIDATE_RULES_SNAPSHOT_VERSION,
  buildCandidateRulesSnapshot,
  parseCandidateRulesSnapshot,
  type CandidateRulesSnapshotRead,
} from './candidate-rules-snapshot';

// ---------------------------------------------------------------------------
// M5 confirmation window (candidate-only input)
// ---------------------------------------------------------------------------

export interface LoadedCandidateM5Window {
  m5: SignalWindow;
  /** True when any loaded M5 row is demo-labelled (candidate skipped, fail-closed). */
  demoRows: boolean;
  formingExcluded: number;
  invalidExcluded: number;
  windowGapsSuspicious: number;
}

/** Load the M5 closed-candle confirmation window (same loader semantics as
 *  the baseline windows; bound = frozen CANDIDATE_RULES.m5WindowBars). */
export async function loadCandidateM5Window(
  db: PrismaClient,
  symbol: string,
  nowUtcSec: number,
): Promise<LoadedCandidateM5Window> {
  const loaded = await loadAnalysisInput(db, symbol, ['M5'] as Timeframe[], {
    maxBarsPerTf: CANDIDATE_RULES.m5WindowBars,
    nowUtcSec,
  });
  const data: TfLoadedData | undefined = loaded.perTimeframe.get('M5');
  const candles = data?.candles ?? [];
  // Same bound discipline as loadSignalWindows (defensive double-bound).
  const bounded = candles.length > CANDIDATE_RULES.m5WindowBars
    ? candles.slice(candles.length - CANDIDATE_RULES.m5WindowBars)
    : candles;
  return {
    m5: { timeframe: 'M5', candles: bounded, source: data?.source ?? null },
    demoRows: data?.demoRows ?? false,
    formingExcluded: data?.formingExcluded ?? 0,
    invalidExcluded: data?.invalidExcluded ?? 0,
    windowGapsSuspicious: data?.windowGapsSuspicious ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Write side — append-only candidate evaluation rows
// ---------------------------------------------------------------------------

export interface SaveCandidateEvaluationArgs {
  evaluation: CandidateEvaluation;
  quote: Record<string, unknown>;
  durationMs: number;
  startedAtUtc: Date;
  /** The baseline rules the candidate embedded (Models A/B/C share them). */
  rules: StrategyRules;
  /** Verified broker digits at evaluation time; null = unavailable. */
  digits: number | null;
  /** Window RANGE summaries persisted for provenance (same shape as the baseline rows). */
  windows: {
    execution: { fromUtc: string; toUtc: string; bars: number } | null;
    h1: { fromUtc: string; toUtc: string; bars: number } | null;
    h4: { fromUtc: string; toUtc: string; bars: number } | null;
    m5: { fromUtc: string; toUtc: string; bars: number } | null;
  };
}

export interface SavedCandidateEvaluation {
  id: string;
  persistedAtUtc: string;
}

/** Window range summary from a loaded window (never the full candle arrays). */
export function windowRangeSummary(w: SignalWindow): { fromUtc: string; toUtc: string; bars: number } | null {
  if (!w.candles.length) return null;
  return {
    fromUtc: new Date(w.candles[0].timeUtcSec * 1000).toISOString(),
    toUtc: new Date(w.candles[w.candles.length - 1].timeUtcSec * 1000).toISOString(),
    bars: w.candles.length,
  };
}

/** The candidate evidence JSON persisted on the row (model breakdown). */
export interface CandidateRowEvidence {
  model: CandidateModel | null;
  direction: 'BUY' | 'SELL' | null;
  conflict: boolean;
  suppressedModels: CandidateModel[];
  modelA: { outcome: string; reasonCodes: string[] } | null;
  modelB: { setup: boolean; stage: string | null } | null;
  modelC: { setups: Array<'BUY' | 'SELL'>; stage: string | null } | null;
}

/** Append-only persistence of one candidate evaluation — a new row per run. */
export async function saveCandidateEvaluation(
  db: PrismaClient,
  args: SaveCandidateEvaluationArgs,
): Promise<SavedCandidateEvaluation> {
  const e = args.evaluation;
  if (e.candidateVersion !== CANDIDATE_STRATEGY_VERSION) {
    // Fail-closed: a foreign candidate version must never be persisted under
    // this wiring (new candidate version ⇒ new protocol ⇒ new wiring review).
    throw new Error(`candidate persistence refused: evaluation version ${e.candidateVersion} ≠ wired version ${CANDIDATE_STRATEGY_VERSION}`);
  }

  // candidate-rules-snapshot/1 (protocol §1). Build failure → structured
  // diagnostic on the row (never throws — persistence must not mask the
  // verdict). Legacy/absent reads as NOT-RECORDED, never backfilled.
  const rulesBuild = buildCandidateRulesSnapshot(args.rules, {
    symbol: e.symbol,
    engineVersion: e.engineVersion,
    digits: args.digits,
  });

  const evidence: CandidateRowEvidence = {
    model: e.model,
    direction: e.direction,
    conflict: e.evidence?.conflict ?? false,
    suppressedModels: e.evidence?.suppressedModels ?? [],
    modelA: e.evidence?.modelA
      ? { outcome: e.evidence.modelA.outcome, reasonCodes: [...e.evidence.modelA.reasonCodes] }
      : null,
    modelB: e.evidence?.modelB
      ? { setup: e.evidence.modelB.setup, stage: e.evidence.modelB.stage }
      : null,
    modelC: e.evidence?.modelC
      ? { setups: [...e.evidence.modelC.setups], stage: e.evidence.modelC.stage }
      : null,
  };

  const row = await db.signalEvaluation.create({
    data: {
      engineVersion: e.engineVersion,
      strategyVersion: CANDIDATE_STRATEGY_VERSION,
      symbol: e.symbol,
      outcome: e.outcome,
      reasonCodes: JSON.stringify(e.reasonCodes),
      // Candidate input fingerprint (computeCandidateFingerprint — namespaced
      // by the candidate version; distinct from the baseline fingerprint).
      inputFingerprint: e.inputFingerprint || '',
      // candidate-setup-identity/1 (payload includes the candidate version ⇒
      // cross-namespace collision with setup-identity/1 is impossible).
      setupFingerprint: e.setupFingerprint,
      datasetFingerprint: e.datasetFingerprint,
      inputSnapshot: JSON.stringify({
        windows: args.windows,
        rules: rulesBuild.ok
          ? rulesBuild.snapshot
          : {
              candidateRulesSnapshotVersion: CANDIDATE_RULES_SNAPSHOT_VERSION,
              error: 'INVALID_CANDIDATE_RULES_SNAPSHOT',
              diagnostic: rulesBuild.diagnostic,
            },
      }),
      evidence: JSON.stringify(evidence),
      // Levels ONLY on setup outcomes (CandidateLevels — includes the
      // per-model invalidationLevel; harness-consistent mapping).
      levels: e.levels ? JSON.stringify(e.levels) : null,
      decisionCandleTimeUtc: e.decisionCandleTimeUtc ? new Date(e.decisionCandleTimeUtc) : null,
      setupKnownAtUtc: e.setupKnownAtUtc ? new Date(e.setupKnownAtUtc) : null,
      expiryUtc: e.expiryUtc ? new Date(e.expiryUtc) : null,
      quote: JSON.stringify(args.quote),
      executionLocked: true, // research only — recorded per row, like the baseline
      durationMs: args.durationMs,
    },
  });
  return { id: row.id, persistedAtUtc: row.createdAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Read side — latest candidate evaluation (parsed, honest)
// ---------------------------------------------------------------------------

export interface LatestCandidateEvaluation {
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
  /** CandidateLevels on setup outcomes (includes invalidationLevel); null otherwise. */
  levels: (SignalLevels & { invalidationLevel: number }) | null;
  model: CandidateModel | null;
  direction: 'BUY' | 'SELL' | null;
  evidence: CandidateRowEvidence | null;
  inputFingerprint: string;
  datasetFingerprint: string | null;
  setupFingerprint: string | null;
  /** The STORED candidate rules snapshot (present / not-recorded / invalid). */
  rulesSnapshot: CandidateRulesSnapshotRead;
  executionLocked: boolean;
  quote: Record<string, unknown> | null;
  durationMs: number | null;
}

function parseCandidateRow(row: {
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
  inputSnapshot: string;
  executionLocked: boolean;
  quote: string;
  durationMs: number | null;
}): LatestCandidateEvaluation {
  const safeParse = <T,>(s: string, fallback: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  const evidence = safeParse<CandidateRowEvidence | null>(row.evidence, null);
  const rawLevels = row.levels
    ? safeParse<SignalLevels & { invalidationLevel?: unknown } | null>(row.levels, null)
    : null;
  const levels: (SignalLevels & { invalidationLevel: number }) | null =
    rawLevels && Number.isFinite(rawLevels.entryReference) && Number.isFinite(rawLevels.stopLoss) && Number.isFinite(rawLevels.target) && Number.isFinite(rawLevels.invalidationLevel)
      ? (rawLevels as SignalLevels & { invalidationLevel: number })
      : null;
  const model: CandidateModel | null =
    evidence?.model === 'A' || evidence?.model === 'B' || evidence?.model === 'C' ? evidence.model : null;
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
    levels,
    model,
    direction: evidence?.direction === 'BUY' || evidence?.direction === 'SELL' ? evidence.direction : null,
    evidence,
    inputFingerprint: row.inputFingerprint,
    datasetFingerprint: row.datasetFingerprint,
    setupFingerprint: row.setupFingerprint ?? null,
    rulesSnapshot: parseCandidateRulesSnapshot(row.inputSnapshot),
    executionLocked: row.executionLocked,
    quote: safeParse<Record<string, unknown> | null>(row.quote, null),
    durationMs: row.durationMs,
  };
}

/** Latest CANDIDATE evaluation for a symbol (candidate-scoped by construction). */
export async function getLatestCandidateEvaluation(
  db: PrismaClient,
  symbol?: string,
): Promise<LatestCandidateEvaluation | null> {
  const row = await db.signalEvaluation
    .findFirst({
      where: {
        strategyVersion: CANDIDATE_STRATEGY_VERSION,
        ...(symbol ? { symbol } : {}),
      },
      orderBy: { createdAt: 'desc' },
    })
    .catch(() => null);
  return row ? parseCandidateRow(row) : null;
}

/** Recent candidate evaluations (bounded, ascending-free — newest first). */
export async function getCandidateEvaluationHistory(
  db: PrismaClient,
  symbol?: string,
  limit = 20,
): Promise<LatestCandidateEvaluation[]> {
  const rows = await db.signalEvaluation
    .findMany({
      where: {
        strategyVersion: CANDIDATE_STRATEGY_VERSION,
        ...(symbol ? { symbol } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(1, limit), 100),
    })
    .catch(() => []);
  return rows.map(parseCandidateRow);
}
