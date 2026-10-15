/**
 * XAUUSD AI Trading Agent — Paper-Signal Forward Tracking (Phase 10, §7)
 * ----------------------------------------------------------------------------
 * READ-ONLY forward tracking of persisted SETUP evaluations (BUY_SETUP /
 * SELL_SETUP). Records what the price actually DID after each research
 * signal — it can NEVER submit, modify or close a broker order: no such code
 * exists anywhere in this project.
 *
 * Semantics (documented, deterministic):
 *   · ONE row per signal evaluation — unique `signalEvaluationId` makes
 *     duplicate outcome counting IMPOSSIBLE by construction. Resolved rows
 *     are IMMUTABLE and never reprocessed.
 *   · Paper entry = `levels.entryReference` (the spread-adjusted reference
 *     the live engine published at signal time) ± slippage.
 *   · Subsequent CLOSED verified M15 bars (after the decision bar) are walked
 *     chronologically; on each bar, in conservative order:
 *       1. SL touched  → stopped   (loss assumed first — conservative)
 *       2. M15 CLOSE back through the broken level (evidence.structureEvent
 *          .level) → invalidated (exit at that bar's close)
 *       3. TP touched → targeted
 *     SL+TP in one bar → stopped (collision rule, same as the backtests).
 *   · Expiry (`expiryUtc` from the engine) passing without any hit → expired
 *     (exit at the last closed bar's close; null when no bars were available —
 *     never fabricated).
 *   · Costs: the Phase 10 conservative round trip (spread + 2×slippage +
 *     commission, default commission 0) — the same convention as the
 *     validation harness. entryReference already contains the entry-side
 *     half spread; the overlap is knowingly borne (pessimistic, documented).
 *   · Result recorded in R-multiples (net / riskPrice) — no monetary claim.
 */

import type { PrismaClient } from '@prisma/client';
import { baselineCostModel, roundTripCost, type CostModel } from '@/lib/backtest/cost-model';
import type { SignalEvaluation, SignalLevels, SignalEvidence } from './types';

const M15_SEC = 900;

export interface PaperTrackOptions {
  symbol?: string;
  /** Injectable clock (epoch ms) — deterministic tests. */
  now?: () => number;
  costs?: CostModel;
  /** Bound on how many recent setup evaluations to scan (default 200). */
  maxSignals?: number;
  /** Bound on bars examined per signal (default 500 — expiry is ~12 bars). */
  maxBarsPerSignal?: number;
}

export interface PaperTrackResult {
  scanned: number;
  newlyOpened: number;
  advanced: number;
  resolved: { stopped: number; targeted: number; invalidated: number; expired: number };
  skippedResolved: number;
  errors: string[];
}

interface ParsedSetup {
  evaluationId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  createdAt: Date;
  decisionCandleTime: Date;
  setupKnownAt: Date;
  expiry: Date;
  datasetFingerprint: string | null;
  inputFingerprint: string;
  levels: SignalLevels;
  evidence: SignalEvidence | null;
}

function parseSetupRow(row: {
  id: string;
  symbol: string;
  outcome: string;
  createdAt: Date;
  decisionCandleTimeUtc: Date | null;
  setupKnownAtUtc: Date | null;
  expiryUtc: Date | null;
  datasetFingerprint: string | null;
  inputFingerprint: string;
  levels: string | null;
  evidence: string;
}): ParsedSetup | null {
  if (row.outcome !== 'BUY_SETUP' && row.outcome !== 'SELL_SETUP') return null;
  if (!row.levels || !row.decisionCandleTimeUtc || !row.setupKnownAtUtc || !row.expiryUtc) return null;
  let levels: SignalLevels;
  let evidence: SignalEvidence | null = null;
  try {
    levels = JSON.parse(row.levels) as SignalLevels;
    evidence = JSON.parse(row.evidence) as SignalEvidence;
  } catch {
    return null;
  }
  if (!levels || !Number.isFinite(levels.entryReference) || !Number.isFinite(levels.stopLoss) || !Number.isFinite(levels.target)) {
    return null;
  }
  return {
    evaluationId: row.id,
    symbol: row.symbol,
    direction: levels.direction,
    createdAt: row.createdAt,
    decisionCandleTime: row.decisionCandleTimeUtc,
    setupKnownAt: row.setupKnownAtUtc,
    expiry: row.expiryUtc,
    datasetFingerprint: row.datasetFingerprint,
    inputFingerprint: row.inputFingerprint,
    levels,
    evidence,
  };
}

/** Invalid level = the broken structure level (zone-invalidation close rule). */
function invalidationLevelOf(setup: ParsedSetup): number {
  return setup.evidence?.structureEvent?.level ?? setup.levels.entryZoneLow;
}

interface CandleBar {
  timeUtcSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface AdvanceResult {
  outcome: 'stopped' | 'targeted' | 'invalidated' | 'expired' | 'unresolved';
  exitPrice: number | null;
  resolutionBarTime: number | null;
  observations: number;
  collision: boolean;
  rule: string;
}

/**
 * Pure resolution walk over subsequent closed bars. Exposed for unit tests
 * (synthetic fixtures only — clearly labeled, never broker data).
 */
export function resolvePaperOutcome(
  direction: 'BUY' | 'SELL',
  entryReference: number,
  stopLoss: number,
  target: number,
  invalidationLevel: number,
  bars: CandleBar[], // CLOSED bars strictly AFTER the decision bar, ascending
  expiryUtcSec: number,
  nowUtcSec: number,
): AdvanceResult {
  let collision = false;
  let lastClose: number | null = null;
  let lastTime: number | null = null;

  for (const bar of bars) {
    lastClose = bar.close;
    lastTime = bar.timeUtcSec;
    const hitStop = direction === 'BUY' ? bar.low <= stopLoss : bar.high >= stopLoss;
    const hitTarget = direction === 'BUY' ? bar.high >= target : bar.low <= target;
    const closeInvalidated = direction === 'BUY' ? bar.close < invalidationLevel : bar.close > invalidationLevel;

    if (hitStop) {
      // SL-first conservative rule — same as both backtest engines.
      collision = hitStop && hitTarget;
      return {
        outcome: 'stopped',
        exitPrice: stopLoss,
        resolutionBarTime: bar.timeUtcSec,
        observations: bars.indexOf(bar) + 1,
        collision,
        rule: collision
          ? 'stop and target both touched in one bar → LOSS assumed (conservative collision rule)'
          : 'stop-loss touched',
      };
    }
    if (closeInvalidated) {
      return {
        outcome: 'invalidated',
        exitPrice: bar.close,
        resolutionBarTime: bar.timeUtcSec,
        observations: bars.indexOf(bar) + 1,
        collision: false,
        rule: 'M15 close back through the broken level — zone invalidated (engine rule)',
      };
    }
    if (hitTarget) {
      return {
        outcome: 'targeted',
        exitPrice: target,
        resolutionBarTime: bar.timeUtcSec,
        observations: bars.indexOf(bar) + 1,
        collision: false,
        rule: 'target touched',
      };
    }
  }

  if (nowUtcSec >= expiryUtcSec) {
    return {
      outcome: 'expired',
      exitPrice: lastClose, // null when no bars were available — never fabricated
      resolutionBarTime: lastTime,
      observations: bars.length,
      collision: false,
      rule: lastClose === null
        ? 'expiry passed with NO post-signal candles available — outcome unobservable, P/L stays null'
        : 'expiry passed without stop/target/invalidation — exit at last closed bar close',
    };
  }

  return {
    outcome: 'unresolved',
    exitPrice: null,
    resolutionBarTime: null,
    observations: bars.length,
    collision: false,
    rule: 'open — no stop/target/invalidation yet, expiry not passed',
  };
}

/** Paper P/L under the Phase 10 conservative cost convention. */
export function paperPnl(
  direction: 'BUY' | 'SELL',
  entryReference: number,
  exitPrice: number,
  riskPrice: number,
  costs: CostModel,
): { grossPrice: number; costsPrice: number; netPrice: number; rMultiple: number } {
  const gross = direction === 'BUY' ? exitPrice - entryReference : entryReference - exitPrice;
  const costsPrice = roundTripCost(costs);
  const net = gross - costsPrice;
  return {
    grossPrice: Number(gross.toFixed(10)),
    costsPrice: Number(costsPrice.toFixed(10)),
    netPrice: Number(net.toFixed(10)),
    rMultiple: riskPrice > 0 ? Number((net / riskPrice).toFixed(6)) : 0,
  };
}

/**
 * Advance paper tracking for all recent SETUP evaluations of a symbol.
 * Safe to call repeatedly (idempotent per signal: resolved rows are skipped;
 * open rows only advance). Errors are collected, never thrown.
 */
export async function trackPaperSignals(
  db: PrismaClient,
  opts: PaperTrackOptions = {},
): Promise<PaperTrackResult> {
  const nowMs = opts.now ?? Date.now;
  const nowUtcSec = Math.floor(nowMs() / 1000);
  const costs = opts.costs ?? baselineCostModel(0.24);
  const maxSignals = Math.min(Math.max(1, opts.maxSignals ?? 200), 1000);
  const maxBarsPerSignal = Math.min(Math.max(10, opts.maxBarsPerSignal ?? 500), 2000);

  const result: PaperTrackResult = {
    scanned: 0,
    newlyOpened: 0,
    advanced: 0,
    resolved: { stopped: 0, targeted: 0, invalidated: 0, expired: 0 },
    skippedResolved: 0,
    errors: [],
  };

  const rows = await db.signalEvaluation.findMany({
    where: {
      ...(opts.symbol ? { symbol: opts.symbol } : {}),
      outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] },
      levels: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: maxSignals,
  });

  for (const row of rows) {
    try {
      const setup = parseSetupRow(row);
      if (!setup) continue;
      result.scanned += 1;

      const existing = await db.paperSignalOutcome.findUnique({
        where: { signalEvaluationId: setup.evaluationId },
      });
      if (existing && existing.status === 'resolved') {
        result.skippedResolved += 1; // DUPLICATE PREVENTION — immutable outcome
        continue;
      }

      if (!existing) {
        await db.paperSignalOutcome.create({
          data: {
            signalEvaluationId: setup.evaluationId,
            symbol: setup.symbol,
            direction: setup.direction,
            signalCreatedAtUtc: setup.createdAt,
            decisionCandleTimeUtc: setup.decisionCandleTime,
            setupKnownAtUtc: setup.setupKnownAt,
            expiryUtc: setup.expiry,
            datasetFingerprint: setup.datasetFingerprint,
            inputFingerprint: setup.inputFingerprint || '',
            sourceCandleRange: JSON.stringify({
              execution: setup.evidence?.executionWindow ?? null,
              h1: setup.evidence?.h1Window ?? null,
              h4: setup.evidence?.h4Window ?? null,
            }),
            entryReference: setup.levels.entryReference,
            stopLoss: setup.levels.stopLoss,
            target: setup.levels.target,
            invalidationLevel: invalidationLevelOf(setup),
            status: 'open',
            modeledCostsPrice: roundTripCost(costs),
            details: JSON.stringify({ costLabels: costs.labels }),
          },
        });
        result.newlyOpened += 1;
      }

      // ── Advance: load subsequent CLOSED verified M15 bars ──────────────
      const decisionSec = Math.floor(setup.decisionCandleTime.getTime() / 1000);
      const expirySec = Math.floor(setup.expiry.getTime() / 1000);
      const uptoSec = Math.min(expirySec, nowUtcSec);
      if (uptoSec <= decisionSec) {
        result.advanced += 1;
        continue; // nothing observable yet
      }
      const candleRows = await db.marketCandle.findMany({
        where: {
          symbol: setup.symbol,
          timeframe: 'M15',
          isForming: false,
          validationStatus: 'VALID',
          source: 'bridge-mt5',
          candleTimeUtc: { gt: setup.decisionCandleTime, lte: new Date(uptoSec * 1000) },
        },
        orderBy: { candleTimeUtc: 'asc' },
        take: maxBarsPerSignal,
      });
      const bars: CandleBar[] = [];
      for (const c of candleRows) {
        const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
        if (![o, h, l, cl].every((v) => Number.isFinite(v) && v > 0)) continue; // re-validated at read time
        if (!(h >= Math.max(o, cl) && l <= Math.min(o, cl) && h >= l)) continue;
        bars.push({ timeUtcSec: Math.floor(c.candleTimeUtc.getTime() / 1000), open: o, high: h, low: l, close: cl });
      }

      const adv = resolvePaperOutcome(
        setup.direction,
        setup.levels.entryReference,
        setup.levels.stopLoss,
        setup.levels.target,
        invalidationLevelOf(setup),
        bars,
        expirySec,
        nowUtcSec,
      );

      const update: Record<string, unknown> = {
        observations: adv.observations,
        lastCheckedBarTimeUtc: bars.length ? new Date(bars[bars.length - 1].timeUtcSec * 1000) : null,
        details: JSON.stringify({
          costLabels: costs.labels,
          resolutionRule: adv.rule,
          collision: adv.collision,
        }),
      };

      if (adv.outcome !== 'unresolved' && adv.exitPrice !== null) {
        const pnl = paperPnl(setup.direction, setup.levels.entryReference, adv.exitPrice, setup.levels.riskPrice, costs);
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
        result.resolved.expired += 1;
      }

      await db.paperSignalOutcome.update({
        where: { signalEvaluationId: setup.evaluationId },
        data: update,
      });
      result.advanced += 1;
    } catch (err) {
      result.errors.push(`${row.id}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Read side (dashboard / API)
// ---------------------------------------------------------------------------

export interface PaperOutcomeRow {
  id: string;
  signalEvaluationId: string;
  symbol: string;
  direction: string;
  signalCreatedAtUtc: string;
  decisionCandleTimeUtc: string;
  expiryUtc: string;
  status: string;
  outcome: string | null;
  entryReference: number;
  stopLoss: number;
  target: number;
  invalidationLevel: number;
  exitPrice: number | null;
  observations: number;
  netPnlPrice: number | null;
  rMultiple: number | null;
  details: Record<string, unknown> | null;
}

export interface PaperSummary {
  total: number;
  open: number;
  resolved: { stopped: number; targeted: number; invalidated: number; expired: number };
  resolvedWithPnl: number;
  wins: number;
  losses: number;
  netPnlPrice: number | null;
  sumR: number | null;
  avgR: number | null;
  outcomes: PaperOutcomeRow[];
}

export async function getPaperSignalSummary(
  db: PrismaClient,
  symbol?: string,
  limit = 50,
): Promise<PaperSummary> {
  const rows = await db.paperSignalOutcome.findMany({
    where: symbol ? { symbol } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(1, limit), 200),
  });

  const outcomes: PaperOutcomeRow[] = rows.map((r) => {
    let details: Record<string, unknown> | null = null;
    try {
      details = r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null;
    } catch {
      details = null;
    }
    return {
      id: r.id,
      signalEvaluationId: r.signalEvaluationId,
      symbol: r.symbol,
      direction: r.direction,
      signalCreatedAtUtc: r.signalCreatedAtUtc.toISOString(),
      decisionCandleTimeUtc: r.decisionCandleTimeUtc.toISOString(),
      expiryUtc: r.expiryUtc.toISOString(),
      status: r.status,
      outcome: r.outcome,
      entryReference: r.entryReference,
      stopLoss: r.stopLoss,
      target: r.target,
      invalidationLevel: r.invalidationLevel,
      exitPrice: r.exitPrice,
      observations: r.observations,
      netPnlPrice: r.netPnlPrice,
      rMultiple: r.rMultiple,
      details,
    };
  });

  const resolvedRows = rows.filter((r) => r.status === 'resolved');
  const withPnl = resolvedRows.filter((r) => r.netPnlPrice !== null);
  const wins = withPnl.filter((r) => (r.netPnlPrice ?? 0) > 0);
  const losses = withPnl.filter((r) => (r.netPnlPrice ?? 0) <= 0);
  const sumR = withPnl.reduce((s, r) => s + (r.rMultiple ?? 0), 0);

  return {
    total: rows.length,
    open: rows.filter((r) => r.status === 'open').length,
    resolved: {
      stopped: resolvedRows.filter((r) => r.outcome === 'stopped').length,
      targeted: resolvedRows.filter((r) => r.outcome === 'targeted').length,
      invalidated: resolvedRows.filter((r) => r.outcome === 'invalidated').length,
      expired: resolvedRows.filter((r) => r.outcome === 'expired').length,
    },
    resolvedWithPnl: withPnl.length,
    wins: wins.length,
    losses: losses.length,
    netPnlPrice: withPnl.length ? Number(withPnl.reduce((s, r) => s + (r.netPnlPrice ?? 0), 0).toFixed(4)) : null,
    sumR: withPnl.length ? Number(sumR.toFixed(4)) : null,
    avgR: withPnl.length ? Number((sumR / withPnl.length).toFixed(4)) : null,
    outcomes,
  };
}
