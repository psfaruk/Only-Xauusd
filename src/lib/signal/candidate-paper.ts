/**
 * XAUUSD AI Trading Agent — Candidate Paper Tracking (Phase 11-E activation)
 * ----------------------------------------------------------------------------
 * READ-ONLY forward tracking of persisted CANDIDATE SETUP evaluations
 * (hybrid-multimodel-research/11.0.0-candidate.1, outcomes BUY_SETUP /
 * SELL_SETUP) under the PRE-REGISTERED protocol
 * audit/phase11-candidate-forward-protocol.md. It can NEVER submit, modify
 * or close a broker order: no such code exists anywhere in this project.
 *
 * Semantics mirror the baseline walker (src/lib/signal/paper.ts —
 * setup-chronology/1, Phase 10.3-B) and REUSE its pure walk + P/L functions,
 * so the candidate walk is provably the SAME chronology discipline:
 *   · ONE paper row per candidate setup identity (unique setupFingerprint at
 *     the database level — candidate-setup-identity/1, P2002 suppressed as
 *     the concurrent-race guard). The identity is computed ONCE at evaluation
 *     persistence time (candidate-persistence.ts carries it on the row) and
 *     never recomputed here.
 *   · Resolved rows are IMMUTABLE and never reprocessed.
 *   · A bar contributes only if its close is strictly AFTER the signal
 *     creation instant (publication bound), its open strictly BEFORE expiry,
 *     and it has truly closed. Corrupt/unordered/off-grid bars fail closed;
 *     gaps are honest non-observations.
 *   · Per bar, conservative order: 1. SL touched → stopped  2. M15 CLOSE
 *     beyond the per-model invalidation level → invalidated  3. TP touched →
 *     targeted. SL+TP in one bar → stopped (collision rule).
 *   · Expiry without any hit → expired; exit/P-L honestly NULL when no
 *     observable post-publication bars existed (never fabricated).
 *   · Costs: the SAME Phase 10 conservative round trip as the baseline —
 *     observed spread at signal time + 0.02/side slippage + 0 commission,
 *     applied to every outcome; labels persisted on the row.
 *
 * ISOLATION (protocol §4): candidate rows live in PaperCandidateOutcome — a
 * SEPARATE table from PaperSignalOutcome. The baseline tracker
 * (trackPaperSignals) filters the baseline strategyVersion and can never see
 * candidate rows; this tracker filters the candidate strategyVersion and can
 * never see baseline rows.
 */

import type { PrismaClient } from '@prisma/client';
import { baselineCostModel, roundTripCost, type CostModel } from '@/lib/backtest/cost-model';
import { logEvent } from '@/lib/logger';
import { CANDIDATE_STRATEGY_VERSION, type CandidateModel } from './candidate/types';
import type { CandidateRowEvidence } from './candidate-persistence';
import { resolvePaperOutcome, paperPnl, timingBlockForCreate, timingBlockForRow } from './paper';
import {
  CANDIDATE_FORWARD_ACTIVATED_AT_ISO,
  CANDIDATE_FORWARD_MIN_COMPLETED,
  CANDIDATE_FORWARD_PROTOCOL_ID,
  CANDIDATE_FORWARD_WINDOW_DAYS,
  candidateForwardActivatedMs,
  candidateForwardDeadlineMs,
  candidateStopConditionTriggered,
  evaluateCandidatePaperVerdict,
  type CandidatePaperVerdict,
} from './candidate-protocol';

const M15_SEC = 900;

/** Prisma unique-constraint violation (P2002) — the DB-level race guard. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002' &&
    /unique constraint/i.test(String((err as Error).message))
  );
}

export interface CandidatePaperTrackOptions {
  symbol?: string;
  /** Injectable clock (epoch ms) — deterministic tests. */
  now?: () => number;
  costs?: CostModel;
  /** Bound on how many recent candidate setup evaluations to scan (default 200). */
  maxSignals?: number;
  /** Bound on bars examined per signal (default 500 — expiry is ~12 bars). */
  maxBarsPerSignal?: number;
}

export interface CandidatePaperTrackResult {
  scanned: number;
  newlyOpened: number;
  advanced: number;
  resolved: { stopped: number; targeted: number; invalidated: number; expired: number };
  skippedResolved: number;
  /** Repeated evaluations of an already-tracked candidate setup identity —
   *  suppressed by the unique constraint, never a second paper row. */
  duplicatesSuppressed: number;
  errors: string[];
}

/** Parsed candidate setup row (fail-closed: anything unusably corrupt → null). */
interface ParsedCandidateSetup {
  evaluationId: string;
  symbol: string;
  model: CandidateModel;
  direction: 'BUY' | 'SELL';
  createdAt: Date;
  decisionCandleTime: Date;
  setupKnownAt: Date;
  expiry: Date;
  datasetFingerprint: string | null;
  inputFingerprint: string;
  setupFingerprint: string;
  entryReference: number;
  stopLoss: number;
  target: number;
  invalidationLevel: number;
  sourceCandleRange: string;
}

function parseCandidateSetupRow(row: {
  id: string;
  symbol: string;
  strategyVersion: string;
  outcome: string;
  createdAt: Date;
  decisionCandleTimeUtc: Date | null;
  setupKnownAtUtc: Date | null;
  expiryUtc: Date | null;
  datasetFingerprint: string | null;
  inputFingerprint: string;
  setupFingerprint: string | null;
  levels: string | null;
  evidence: string;
  inputSnapshot: string;
}): ParsedCandidateSetup | null {
  if (row.outcome !== 'BUY_SETUP' && row.outcome !== 'SELL_SETUP') return null;
  if (!row.levels || !row.decisionCandleTimeUtc || !row.setupKnownAtUtc || !row.expiryUtc) return null;
  if (!row.setupFingerprint) return null; // unidentifiable → fail-closed, never tracked
  let rawLevels: {
    direction?: unknown;
    entryReference?: unknown;
    stopLoss?: unknown;
    target?: unknown;
    invalidationLevel?: unknown;
  };
  let evidence: CandidateRowEvidence | null = null;
  let windows: unknown = null;
  try {
    rawLevels = JSON.parse(row.levels) as typeof rawLevels;
    evidence = JSON.parse(row.evidence) as CandidateRowEvidence;
    const snapshot = JSON.parse(row.inputSnapshot) as { windows?: unknown };
    windows = snapshot.windows ?? null;
  } catch {
    return null;
  }
  const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const entryReference = numOf(rawLevels.entryReference);
  const stopLoss = numOf(rawLevels.stopLoss);
  const target = numOf(rawLevels.target);
  const invalidationLevel = numOf(rawLevels.invalidationLevel);
  if (entryReference === null || stopLoss === null || target === null || invalidationLevel === null) {
    return null;
  }
  const direction: 'BUY' | 'SELL' | null =
    rawLevels.direction === 'BUY' || rawLevels.direction === 'SELL' ? rawLevels.direction : null;
  const model: CandidateModel | null =
    evidence?.model === 'A' || evidence?.model === 'B' || evidence?.model === 'C' ? evidence.model : null;
  if (!direction || !model) return null; // a candidate setup row without model/direction is corrupt — fail closed
  return {
    evaluationId: row.id,
    symbol: row.symbol,
    model,
    direction,
    createdAt: row.createdAt,
    decisionCandleTime: row.decisionCandleTimeUtc,
    setupKnownAt: row.setupKnownAtUtc,
    expiry: row.expiryUtc,
    datasetFingerprint: row.datasetFingerprint,
    inputFingerprint: row.inputFingerprint || '',
    setupFingerprint: row.setupFingerprint,
    entryReference,
    stopLoss,
    target,
    invalidationLevel,
    sourceCandleRange: JSON.stringify(windows),
  };
}

/**
 * Advance candidate paper tracking for all recent CANDIDATE SETUP evaluations
 * of a symbol. Safe to call repeatedly (idempotent per identity: resolved
 * rows are skipped; open rows only advance). Errors are collected, never
 * thrown. Candidate-scoped by construction (strategyVersion filter).
 */
export async function trackCandidatePaperSignals(
  db: PrismaClient,
  opts: CandidatePaperTrackOptions = {},
): Promise<CandidatePaperTrackResult> {
  const nowMs = opts.now ?? Date.now;
  const nowUtcSec = Math.floor(nowMs() / 1000);
  const costs = opts.costs ?? baselineCostModel(0.24);
  const maxSignals = Math.min(Math.max(1, opts.maxSignals ?? 200), 1000);
  const maxBarsPerSignal = Math.min(Math.max(10, opts.maxBarsPerSignal ?? 500), 2000);

  const result: CandidatePaperTrackResult = {
    scanned: 0,
    newlyOpened: 0,
    advanced: 0,
    resolved: { stopped: 0, targeted: 0, invalidated: 0, expired: 0 },
    skippedResolved: 0,
    duplicatesSuppressed: 0,
    errors: [],
  };

  // Candidate-scoped query (protocol §4 cannot-mix): ONLY candidate rows.
  const rows = await db.signalEvaluation.findMany({
    where: {
      ...(opts.symbol ? { symbol: opts.symbol } : {}),
      strategyVersion: CANDIDATE_STRATEGY_VERSION,
      outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] },
      levels: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: maxSignals,
  });

  for (const row of rows) {
    try {
      const setup = parseCandidateSetupRow(row);
      if (!setup) continue;
      result.scanned += 1;

      // ── Identity dedup: ONE paper row per candidate setup identity EVER ──
      let paper = await db.paperCandidateOutcome.findUnique({
        where: { candidateEvaluationId: setup.evaluationId },
      });
      if (paper && paper.status === 'resolved') {
        result.skippedResolved += 1; // immutable outcome — never re-walked
        continue;
      }

      if (!paper) {
        // The identity was computed at evaluation persistence time
        // (candidate-setup-identity/1) — carried on the row, never recomputed.
        try {
          paper = await db.paperCandidateOutcome.create({
            data: {
              candidateEvaluationId: setup.evaluationId,
              symbol: setup.symbol,
              model: setup.model,
              candidateVersion: CANDIDATE_STRATEGY_VERSION,
              direction: setup.direction,
              signalCreatedAtUtc: setup.createdAt,
              decisionCandleTimeUtc: setup.decisionCandleTime,
              setupKnownAtUtc: setup.setupKnownAt,
              expiryUtc: setup.expiry,
              datasetFingerprint: setup.datasetFingerprint,
              inputFingerprint: setup.inputFingerprint,
              setupFingerprint: setup.setupFingerprint,
              sourceCandleRange: setup.sourceCandleRange,
              entryReference: setup.entryReference,
              stopLoss: setup.stopLoss,
              target: setup.target,
              invalidationLevel: setup.invalidationLevel,
              status: 'open',
              modeledCostsPrice: roundTripCost(costs),
              details: JSON.stringify({
                costLabels: costs.labels,
                // Phase 6 (42-S3): same end-to-end timing capture as the
                // baseline ledger (additive JSON meta — schema untouched).
                timing: timingBlockForCreate(
                  { setupKnownAt: setup.setupKnownAt, createdAt: setup.createdAt },
                  nowMs(),
                ),
              }),
            },
          });
          result.newlyOpened += 1;
          await logEvent({
            level: 'info',
            category: 'candidate',
            code: 'CANDIDATE_PAPER_OPENED',
            message: `ক্যান্ডিডেট পেপার পজিশন খোলা হয়েছে — ${setup.symbol} ${setup.direction} (মডেল ${setup.model}, রিসার্চ-অনলি; কোনো অর্ডার নয়)।`,
            meta: {
              symbol: setup.symbol,
              model: setup.model,
              direction: setup.direction,
              setupFingerprint: setup.setupFingerprint,
              strategyVersion: CANDIDATE_STRATEGY_VERSION,
              executionLocked: true,
            },
          }).catch(() => undefined);
        } catch (createErr) {
          if (isUniqueViolation(createErr)) {
            // The SAME candidate setup identity already has its ONE paper row
            // (concurrent race or repeated evaluation) — never a second row.
            result.duplicatesSuppressed += 1;
            paper = await db.paperCandidateOutcome.findUnique({
              where: { setupFingerprint: setup.setupFingerprint },
            });
            if (!paper) continue; // vanished mid-pass — skip honestly
            if (paper.status === 'resolved') {
              result.skippedResolved += 1;
              continue;
            }
          } else {
            throw createErr;
          }
        }
      }

      // ── Advance: the paper row's OWN frozen geometry ────────────────────
      const decisionSec = Math.floor(paper.decisionCandleTimeUtc.getTime() / 1000);
      const knownSec = Math.floor(paper.setupKnownAtUtc.getTime() / 1000);
      const createSec = Math.floor(paper.signalCreatedAtUtc.getTime() / 1000);
      const expirySec = Math.floor(paper.expiryUtc.getTime() / 1000);

      // Chronology integrity — FAIL-CLOSED (same checks as the baseline walker).
      if (createSec < knownSec) {
        result.errors.push(
          `${row.id}: candidate paper-walk chronology: signalCreatedAtUtc (${createSec}) < setupKnownAtUtc (${knownSec}) — creation predates the knowable setup (fail-closed, no advance)`,
        );
        continue;
      }
      if (knownSec !== decisionSec + M15_SEC) {
        result.errors.push(
          `${row.id}: candidate paper-walk chronology: setupKnownAtUtc ≠ decisionCandleTimeUtc + 900s (${knownSec} vs ${decisionSec + M15_SEC}) — corrupt anchor (fail-closed, no advance)`,
        );
        continue;
      }
      if (nowUtcSec <= createSec) {
        result.advanced += 1;
        continue; // nothing can have closed after the publication instant yet
      }

      const lowerOpenMs = Math.max(
        paper.decisionCandleTimeUtc.getTime(),
        paper.signalCreatedAtUtc.getTime() - M15_SEC * 1000,
      );
      const candleRows = await db.marketCandle.findMany({
        where: {
          symbol: paper.symbol,
          timeframe: 'M15',
          isForming: false,
          validationStatus: 'VALID',
          source: 'bridge-mt5',
          candleTimeUtc: {
            gt: new Date(lowerOpenMs),
            lt: paper.expiryUtc,
            lte: new Date(nowUtcSec * 1000),
          },
        },
        orderBy: { candleTimeUtc: 'asc' },
        take: maxBarsPerSignal,
      });
      const bars: Array<{ timeUtcSec: number; open: number; high: number; low: number; close: number }> = [];
      for (const c of candleRows) {
        const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
        if (![o, h, l, cl].every((v) => Number.isFinite(v) && v > 0)) continue; // re-validated at read time
        if (!(h >= Math.max(o, cl) && l <= Math.min(o, cl) && h >= l)) continue;
        bars.push({ timeUtcSec: Math.floor(c.candleTimeUtc.getTime() / 1000), open: o, high: h, low: l, close: cl });
      }

      // The SAME pure walker as the baseline (setup-chronology/1) — reused,
      // not reimplemented: identical temporal bounds, conservative ordering,
      // collision rule and honest null-exit expiry.
      const adv = resolvePaperOutcome(
        paper.direction === 'BUY' ? 'BUY' : 'SELL',
        paper.entryReference,
        paper.stopLoss,
        paper.target,
        paper.invalidationLevel,
        bars,
        expirySec,
        nowUtcSec,
        createSec,
      );

      const update: Record<string, unknown> = {
        observations: adv.observations,
        lastCheckedBarTimeUtc: adv.lastWalkedBarTime !== null ? new Date(adv.lastWalkedBarTime * 1000) : null,
        details: JSON.stringify({
          costLabels: costs.labels,
          resolutionRule: adv.rule,
          collision: adv.collision,
          signalCreatedUtcSec: createSec,
          walkLowerBoundOpenUtcSec: Math.floor(lowerOpenMs / 1000),
          // Phase 6 (42-S3): timing carried forward on every advance —
          // recomputed from the row's own columns (exact).
          timing: timingBlockForRow(paper),
        }),
      };

      // riskPrice recomputed from the row's own frozen geometry.
      const riskPrice =
        paper.direction === 'BUY'
          ? paper.entryReference - paper.stopLoss
          : paper.stopLoss - paper.entryReference;

      let resolvedNow: 'stopped' | 'targeted' | 'invalidated' | 'expired' | null = null;
      let resolvedNet: number | null = null;
      let resolvedR: number | null = null;

      if (adv.outcome !== 'unresolved' && adv.exitPrice !== null) {
        const pnl = paperPnl(
          paper.direction === 'BUY' ? 'BUY' : 'SELL',
          paper.entryReference,
          adv.exitPrice,
          riskPrice,
          costs,
        );
        Object.assign(update, {
          status: 'resolved',
          outcome: adv.outcome,
          resolvedAtUtc: new Date(nowMs()),
          resolutionBarTimeUtc: adv.resolutionBarTime !== null ? new Date(adv.resolutionBarTime * 1000) : null,
          exitPrice: adv.exitPrice,
          grossPnlPrice: pnl.grossPrice,
          netPnlPrice: pnl.netPrice,
          rMultiple: pnl.rMultiple,
        });
        resolvedNow = adv.outcome;
        resolvedNet = pnl.netPrice;
        resolvedR = pnl.rMultiple;
        result.resolved[adv.outcome] += 1;
      } else if (adv.outcome === 'expired') {
        // expiry with NO observable bars — resolved, P/L honestly null
        Object.assign(update, {
          status: 'resolved',
          outcome: 'expired',
          resolvedAtUtc: new Date(nowMs()),
          resolutionBarTimeUtc: null,
          exitPrice: null,
          grossPnlPrice: null,
          netPnlPrice: null,
          rMultiple: null,
        });
        resolvedNow = 'expired';
        result.resolved.expired += 1;
      }

      await db.paperCandidateOutcome.update({
        where: { id: paper.id },
        data: update,
      });
      result.advanced += 1;

      if (resolvedNow !== null) {
        await logEvent({
          level: resolvedNow === 'targeted' ? 'info' : 'warn',
          category: 'candidate',
          code: 'CANDIDATE_PAPER_RESOLVED',
          message: `ক্যান্ডিডেট পেপার ফলাফল: ${paper.symbol} ${paper.direction} (মডেল ${paper.model}) → ${resolvedNow}${
            resolvedNet !== null && resolvedR !== null
              ? ` (${resolvedNet >= 0 ? '+' : ''}${resolvedNet.toFixed(4)} / ${resolvedR >= 0 ? '+' : ''}${resolvedR.toFixed(4)}R)`
              : ' (পর্যবেক্ষণযোগ্য ক্যান্ডেল ছিল না — P/L অজানা)'
          } — রিসার্চ-অনলি, কোনো অর্ডার নয়।`,
          meta: {
            symbol: paper.symbol,
            model: paper.model,
            direction: paper.direction,
            outcome: resolvedNow,
            netPnlPrice: resolvedNet,
            rMultiple: resolvedR,
            strategyVersion: CANDIDATE_STRATEGY_VERSION,
          },
        }).catch(() => undefined);
      }
    } catch (err) {
      result.errors.push(`${row.id}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Read side (candidate card / API — protocol §7 reporting path)
// ---------------------------------------------------------------------------

export interface CandidatePaperStats {
  /** All candidate paper rows for the symbol created at/after activation (forward-only). */
  total: number;
  open: number;
  resolved: { stopped: number; targeted: number; invalidated: number; expired: number };
  /** Resolved rows with OBSERVABLE net P/L (expired-unobservable excluded, disclosed). */
  completedOutcomes: number;
  unobservableExpired: number;
  netPnlPrice: number | null;
  sumR: number | null;
  verdict: CandidatePaperVerdict;
  /** Protocol §5.3 stopping condition state (8 consecutive losses / >10R drawdown). */
  stopCondition: { triggered: boolean; reason: string | null };
  protocol: {
    id: string;
    candidateVersion: string;
    activatedAtUtc: string;
    deadlineUtc: string;
    windowDays: number;
    minCompleted: number;
  };
}

/**
 * Candidate forward-paper stats for a symbol: counts by status/outcome from
 * PaperCandidateOutcome + the pre-registered protocol verdict (INCOMPLETE
 * until ≥ 20 completed outcomes — no performance claim of any kind below the
 * floor). Forward-only: rows created before the activation instant never
 * count (defense in depth — none can exist).
 */
export async function getCandidatePaperStats(
  db: PrismaClient,
  symbol?: string,
  opts: { now?: () => number } = {},
): Promise<CandidatePaperStats> {
  const nowMs = opts.now?.() ?? Date.now();
  const activatedDate = new Date(candidateForwardActivatedMs());

  const rows = await db.paperCandidateOutcome
    .findMany({
      where: {
        ...(symbol ? { symbol } : {}),
        signalCreatedAtUtc: { gte: activatedDate },
      },
      orderBy: { signalCreatedAtUtc: 'asc' },
      take: 5000,
    })
    .catch(() => []);

  const resolvedRows = rows.filter((r) => r.status === 'resolved');
  const completed = resolvedRows.filter((r) => r.netPnlPrice !== null && r.rMultiple !== null);
  const unobservableExpired = resolvedRows.filter((r) => r.outcome === 'expired' && r.netPnlPrice === null).length;

  const completedOutcomes = completed.map((r) => ({ netPnlPrice: r.netPnlPrice as number, rMultiple: r.rMultiple as number }));
  const verdict = evaluateCandidatePaperVerdict({
    completedOutcomes,
    openRows: rows.filter((r) => r.status === 'open').length,
    unobservableExpired,
    nowMs,
  });
  const stop = candidateStopConditionTriggered(completedOutcomes);

  return {
    total: rows.length,
    open: rows.filter((r) => r.status === 'open').length,
    resolved: {
      stopped: resolvedRows.filter((r) => r.outcome === 'stopped').length,
      targeted: resolvedRows.filter((r) => r.outcome === 'targeted').length,
      invalidated: resolvedRows.filter((r) => r.outcome === 'invalidated').length,
      expired: resolvedRows.filter((r) => r.outcome === 'expired').length,
    },
    completedOutcomes: completed.length,
    unobservableExpired,
    netPnlPrice: completed.length ? Number(completed.reduce((s, r) => s + (r.netPnlPrice ?? 0), 0).toFixed(4)) : null,
    sumR: completed.length ? Number(completed.reduce((s, r) => s + (r.rMultiple ?? 0), 0).toFixed(4)) : null,
    verdict,
    stopCondition: stop,
    protocol: {
      id: CANDIDATE_FORWARD_PROTOCOL_ID,
      candidateVersion: CANDIDATE_STRATEGY_VERSION,
      activatedAtUtc: CANDIDATE_FORWARD_ACTIVATED_AT_ISO,
      deadlineUtc: new Date(candidateForwardDeadlineMs()).toISOString(),
      windowDays: CANDIDATE_FORWARD_WINDOW_DAYS,
      minCompleted: CANDIDATE_FORWARD_MIN_COMPLETED,
    },
  };
}
