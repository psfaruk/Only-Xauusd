/**
 * XAUUSD AI Trading Agent — Forward Paper Validation read side (Phase 10.2)
 * ----------------------------------------------------------------------------
 * DB aggregation for the PRE-REGISTERED forward paper protocol
 * (src/lib/signal/paper-protocol.ts — pure, versioned, test-pinned).
 *
 * Loads eligible PaperSignalOutcome rows (created at/after protocol
 * activation, i.e. only TRUE forward observations), applies the first-open
 * one-position counting rule, computes the Phase 10-convention metrics and
 * the pre-registered verdict, and returns a dashboard/API-ready status.
 *
 * READ-ONLY. This can never place, modify or close a broker order — no such
 * code exists anywhere in this project.
 */

import type { PrismaClient } from '@prisma/client';
import {
  FORWARD_PAPER_OBSERVATION_WINDOW_DAYS,
  FORWARD_PAPER_PROTOCOL_VERSION,
  FORWARD_PAPER_RULES_VERSION,
  FORWARD_PAPER_ACTIVATED_AT_ISO,
  FORWARD_PAPER_MIN_COMPLETED_TRADES,
  applyFirstOpenRule,
  computeForwardPaperMetrics,
  evaluateForwardPaperVerdict,
  forwardPaperActivatedMs,
  forwardPaperDeadlineMs,
  type ForwardPaperMetrics,
  type ForwardPaperVerdict,
} from './paper-protocol';

export interface ForwardPaperTradeView {
  id: string;
  direction: string;
  signalCreatedAtUtc: string;
  status: string;
  outcome: string | null;
  entryReference: number;
  exitPrice: number | null;
  netPnlPrice: number | null;
  rMultiple: number | null;
  resolvedAtUtc: string | null;
}

export interface ForwardPaperStatus {
  protocol: {
    version: string;
    rulesVersion: string;
    activatedAtUtc: string;
    deadlineUtc: string;
    minCompletedTrades: number;
    observationWindowDays: number;
  };
  progress: {
    countedCompleted: number;
    openCounted: number;
    repeatObservations: number;
    unobservableResolved: number;
    eligibleRows: number;
    elapsedDays: number;
    daysRemaining: number;
  };
  statusCounts: {
    open: number;
    stopped: number;
    targeted: number;
    invalidated: number;
    expired: number;
    expiredUnobservable: number;
  };
  metrics: ForwardPaperMetrics | null;
  verdict: ForwardPaperVerdict;
  recentTrades: ForwardPaperTradeView[];
}

export interface ForwardPaperStatusOptions {
  /** Injectable clock (epoch ms) — deterministic tests. */
  now?: () => number;
  /** Bound on eligible rows scanned (default 1000). */
  maxRows?: number;
}

/**
 * Pre-registered forward-paper status for a symbol. Every field is derived
 * deterministically from the stored rows + the fixed protocol constants —
 * nothing is invented, open/unobservable outcomes stay honest.
 */
export async function getForwardPaperStatus(
  db: PrismaClient,
  symbol: string,
  opts: ForwardPaperStatusOptions = {},
): Promise<ForwardPaperStatus> {
  const nowMs = opts.now?.() ?? Date.now();
  const maxRows = Math.min(Math.max(10, opts.maxRows ?? 1000), 5000);
  const activatedDate = new Date(forwardPaperActivatedMs());

  const rows = await db.paperSignalOutcome.findMany({
    where: {
      symbol,
      signalCreatedAtUtc: { gte: activatedDate },
    },
    orderBy: [{ signalCreatedAtUtc: 'asc' }, { id: 'asc' }],
    take: maxRows,
  });

  const inputs = rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    signalCreatedAtMs: r.signalCreatedAtUtc.getTime(),
    status: r.status,
    outcome: r.outcome,
    netPnlPrice: r.netPnlPrice,
    rMultiple: r.rMultiple,
    resolutionBarTimeMs: r.resolutionBarTimeUtc?.getTime() ?? null,
    resolvedAtMs: r.resolvedAtUtc?.getTime() ?? null,
  }));

  const { counted, repeats } = applyFirstOpenRule(inputs);

  const openCounted = counted.filter((t) => t.status === 'open').length;
  const completed = counted.filter((t) => t.status === 'resolved' && t.netPnlPrice !== null);
  const unobservableResolved = counted.filter((t) => t.status === 'resolved' && t.netPnlPrice === null).length;

  const metrics = computeForwardPaperMetrics(counted);
  const verdict = evaluateForwardPaperVerdict({
    countedCompleted: completed.length,
    openCounted,
    repeatObservations: repeats.length,
    unobservableResolved,
    metrics,
    nowMs,
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const toView = (id: string): ForwardPaperTradeView => {
    const r = byId.get(id)!;
    return {
      id: r.id,
      direction: r.direction,
      signalCreatedAtUtc: r.signalCreatedAtUtc.toISOString(),
      status: r.status,
      outcome: r.outcome,
      entryReference: r.entryReference,
      exitPrice: r.exitPrice,
      netPnlPrice: r.netPnlPrice,
      rMultiple: r.rMultiple,
      resolvedAtUtc: r.resolvedAtUtc ? r.resolvedAtUtc.toISOString() : null,
    };
  };

  const deadlineMs = forwardPaperDeadlineMs();
  const elapsedDays = Number(Math.max(0, (nowMs - forwardPaperActivatedMs()) / 86_400_000).toFixed(2));
  const daysRemaining = Number(Math.max(0, (deadlineMs - nowMs) / 86_400_000).toFixed(2));

  return {
    protocol: {
      version: FORWARD_PAPER_PROTOCOL_VERSION,
      rulesVersion: FORWARD_PAPER_RULES_VERSION,
      activatedAtUtc: FORWARD_PAPER_ACTIVATED_AT_ISO,
      deadlineUtc: new Date(deadlineMs).toISOString(),
      minCompletedTrades: FORWARD_PAPER_MIN_COMPLETED_TRADES,
      observationWindowDays: FORWARD_PAPER_OBSERVATION_WINDOW_DAYS,
    },
    progress: {
      countedCompleted: completed.length,
      openCounted,
      repeatObservations: repeats.length,
      unobservableResolved,
      eligibleRows: rows.length,
      elapsedDays,
      daysRemaining,
    },
    statusCounts: {
      open: openCounted,
      stopped: counted.filter((t) => t.outcome === 'stopped').length,
      targeted: counted.filter((t) => t.outcome === 'targeted').length,
      invalidated: counted.filter((t) => t.outcome === 'invalidated').length,
      expired: counted.filter((t) => t.outcome === 'expired' && t.netPnlPrice !== null).length,
      expiredUnobservable: counted.filter((t) => t.outcome === 'expired' && t.netPnlPrice === null).length,
    },
    metrics,
    verdict,
    recentTrades: counted
      .slice()
      .reverse()
      .slice(0, 20)
      .map((t) => toView(t.id)),
  };
}
