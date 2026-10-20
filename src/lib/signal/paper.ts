/**
 * XAUUSD AI Trading Agent — Paper-Signal Forward Tracking (Phase 10, §7)
 * ----------------------------------------------------------------------------
 * READ-ONLY forward tracking of persisted SETUP evaluations (BUY_SETUP /
 * SELL_SETUP). Records what the price actually DID after each research
 * signal — it can NEVER submit, modify or close a broker order: no such code
 * exists anywhere in this project.
 *
 * Semantics (documented, deterministic):
 *   · Phase 10.3-A: ONE paper row per LOGICAL SETUP (unique setupFingerprint
 *     at the database level — open/counted/resolved all block re-creation).
 *     Repeated evaluations of the same setup (same or different decision
 *     candle, same or different instant) are suppressed repeats. The row is
 *     created by the first-processed evaluation and is immutable thereafter;
 *     every later evaluation of the same setup ADVANCES that same row.
 *   · Legacy rows without a fingerprint keep the per-evaluation path
 *     (findUnique by signalEvaluationId) — never rewritten, never backfilled.
 *   · Resolved rows are IMMUTABLE and never reprocessed.
 *   · Paper entry = `levels.entryReference` (the spread-adjusted reference
 *     the live engine published at signal time) ± slippage.
 *   · Subsequent CLOSED verified M15 bars are walked from the PAPER ROW's OWN
 *     decision candle (Phase 10.3-A: the anchor never drifts to a later
 *     evaluation's decision candle); on each bar, in conservative order:
 *       1. SL touched  → stopped   (loss assumed first — conservative)
 *       2. M15 CLOSE back through the broken level → invalidated
 *       3. TP touched → targeted
 *     SL+TP in one bar → stopped (collision rule, same as the backtests).
 *   · Phase 10.3-B TEMPORAL INVARIANT (setup-chronology/1): a bar may
 *     contribute to the outcome ONLY IF its close instant is strictly AFTER
 *     the row's signalCreatedAtUtc (publication — a bar that closed before
 *     the signal existed is pre-publication information and is NEVER walked),
 *     its open instant is strictly BEFORE expiryUtc (the 12-bar window), and
 *     its close instant is ≤ now (a bar cannot be used before it has truly
 *     closed). Ambiguous timestamps, corrupt anchors or unordered bars →
 *     FAIL-CLOSED (row error, no advance, never a resolution on ambiguous
 *     data). Gaps (absent bars, e.g. the daily break) are honest
 *     non-observations, never errors.
 *   · Expiry passing without any hit → expired (exit at the last closed bar's
 *     close; null when no bars were available — never fabricated).
 *   · Costs: the Phase 10 conservative round trip; result recorded in
 *     R-multiples (net / riskPrice recomputed from the row's own frozen
 *     geometry — the engine's exact risk formula).
 */

import type { PrismaClient } from '@prisma/client';
import { baselineCostModel, roundTripCost, type CostModel } from '@/lib/backtest/cost-model';
import { SIGNAL_STRATEGY_VERSION, type SignalEvaluation, type SignalLevels, type SignalEvidence } from './types';
import { buildStrategyRules } from './rules';
import { setupFingerprintFromEvidence } from './setup-identity';

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
  /** Phase 10.3-A: repeated evaluations of an already-tracked logical setup
 *      — suppressed by the unique setupFingerprint constraint, never a second
 *      paper row (includes the concurrent-race case). */
  duplicatesSuppressed: number;
  errors: string[];
}

interface ParsedSetup {
  evaluationId: string;
  symbol: string;
  strategyVersion: string;
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
  strategyVersion: string;
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
    strategyVersion: row.strategyVersion,
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
  /** Phase 10.3-B: the newest bar actually WALKED (post-publication,
   *  pre-expiry, closed) — null when none qualified. */
  lastWalkedBarTime: number | null;
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
  /** Signal-creation instant (epoch sec) — the publication lower bound
   *  (Phase 10.3-B). Bars closing at/before this instant are pre-publication
   *  and can never contribute to the outcome. */
  signalCreatedUtcSec: number,
): AdvanceResult {
  // ▫▫ Chronology integrity — fail-closed on unreliable ordering ▫▫▫▫▫▫▫▫▫▫
  // A bar sequence that is not strictly ascending, duplicate-free and
  // M15-grid aligned means the timestamps cannot be trusted: refuse to walk
  // (throw → the caller records a row error and leaves the row untouched).
  let prevSec: number | null = null;
  for (const b of bars) {
    if (!Number.isInteger(b.timeUtcSec) || b.timeUtcSec <= 0 || b.timeUtcSec % M15_SEC !== 0) {
      throw new Error(`paper-walk chronology: bar time ${b.timeUtcSec} is not on the M15 UTC grid`);
    }
    if (prevSec !== null && b.timeUtcSec <= prevSec) {
      throw new Error(`paper-walk chronology: bar order not strictly ascending (${prevSec} → ${b.timeUtcSec})`);
    }
    prevSec = b.timeUtcSec;
  }

  let collision = false;
  let lastClose: number | null = null;
  let lastTime: number | null = null;
  let walked = 0;

  for (const bar of bars) {
    const closeSec = bar.timeUtcSec + M15_SEC;
    // ▫▫ Phase 10.3-B temporal invariant — availability bounds ▫▫▫▫▫▫▫▫
    if (closeSec <= signalCreatedUtcSec) continue; // pre-publication bar — excluded
    if (bar.timeUtcSec >= expiryUtcSec) continue;   // post-expiry bar — excluded
    if (closeSec > nowUtcSec) continue;             // not truly closed at walk time
    walked += 1;
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
        lastWalkedBarTime: bar.timeUtcSec,
        observations: walked,
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
        lastWalkedBarTime: bar.timeUtcSec,
        observations: walked,
        collision: false,
        rule: 'M15 close back through the broken level — zone invalidated (engine rule)',
      };
    }
    if (hitTarget) {
      return {
        outcome: 'targeted',
        exitPrice: target,
        resolutionBarTime: bar.timeUtcSec,
        lastWalkedBarTime: bar.timeUtcSec,
        observations: walked,
        collision: false,
        rule: 'target touched',
      };
    }
  }

  if (nowUtcSec >= expiryUtcSec) {
    return {
      outcome: 'expired',
      exitPrice: lastClose, // null when no post-publication bars were available — never fabricated
      resolutionBarTime: lastTime,
      lastWalkedBarTime: lastTime,
      observations: walked,
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
    lastWalkedBarTime: lastTime,
    observations: walked,
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
    duplicatesSuppressed: 0,
    errors: [],
  };

  const rows = await db.signalEvaluation.findMany({
    where: {
      ...(opts.symbol ? { symbol: opts.symbol } : {}),
      // Phase 11-E isolation (protocol §4): the BASELINE tracker is strictly
      // baseline-scoped — candidate setup rows (hybrid-multimodel-research/
      // 11.0.0-candidate.1) can NEVER enter PaperSignalOutcome. Candidate
      // forward tracking lives in candidate-paper.ts / PaperCandidateOutcome.
      strategyVersion: SIGNAL_STRATEGY_VERSION,
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

      // ── Phase 10.3-A: setup-identity deduplication ────────────────────
      // Per-evaluation link first (legacy rows keep this path untouched).
      let paper = await db.paperSignalOutcome.findUnique({
        where: { signalEvaluationId: setup.evaluationId },
      });
      if (paper && paper.status === 'resolved') {
        result.skippedResolved += 1; // DUPLICATE PREVENTION — immutable outcome
        continue;
      }

      if (!paper) {
        // Compute the logical setup identity from the row's OWN evidence and
        // strategy version (deterministic; NULL = unidentifiable → fail-closed,
        // never a guessed identity, never a second paper row).
        const setupFingerprint = setupFingerprintFromEvidence({
          symbol: setup.symbol,
          timeframe: buildStrategyRules().executionTf,
          strategyVersion: setup.strategyVersion,
          evidence: setup.evidence,
        });
        if (setupFingerprint === null) {
          result.errors.push(
            `${row.id}: unidentifiable setup — no paper row (fail-closed: incomplete structure-event identity)`,
          );
          continue;
        }
        try {
          paper = await db.paperSignalOutcome.create({
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
              setupFingerprint,
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
        } catch (createErr) {
          if (isUniqueViolation(createErr)) {
            // The SAME logical setup already has its ONE paper row (concurrent
            // race or repeated evaluation) — never a second row, never an error.
            result.duplicatesSuppressed += 1;
            paper = await db.paperSignalOutcome.findUnique({
              where: { setupFingerprint },
            });
            if (!paper) continue; // vanished mid-pass — skip honestly
            if (paper.status === 'resolved') {
              // Immutable after resolution — same protection as the
              // per-evaluation path; a re-emission can never re-walk or
              // re-stamp a resolved row.
              result.skippedResolved += 1;
              continue;
            }
          } else {
            throw createErr;
          }
        }
      }

      // ── Advance: the paper row's OWN frozen geometry ────────────────
      // (anchor = the row's decision candle — never a later evaluation's).
      const decisionSec = Math.floor(paper.decisionCandleTimeUtc.getTime() / 1000);
      const knownSec = Math.floor(paper.setupKnownAtUtc.getTime() / 1000);
      const createSec = Math.floor(paper.signalCreatedAtUtc.getTime() / 1000);
      const expirySec = Math.floor(paper.expiryUtc.getTime() / 1000);

      // ── Phase 10.3-B: chronology integrity — FAIL-CLOSED ─────────────
      // The frozen anchors must be internally consistent before anything is
      // walked. A row whose creation predates its own setup-known instant, or
      // whose anchors violate the engine formula (knownAt = decisionOpen+900),
      // has ambiguous timestamps: record a row error and NEVER advance it.
      if (createSec < knownSec) {
        result.errors.push(
          `${row.id}: paper-walk chronology: signalCreatedAtUtc (${createSec}) < setupKnownAtUtc (${knownSec}) — creation predates the knowable setup (fail-closed, no advance)`,
        );
        continue;
      }
      if (knownSec !== decisionSec + M15_SEC) {
        result.errors.push(
          `${row.id}: paper-walk chronology: setupKnownAtUtc ≠ decisionCandleTimeUtc + 900s (${knownSec} vs ${decisionSec + M15_SEC}) — corrupt anchor (fail-closed, no advance)`,
        );
        continue;
      }
      if (nowUtcSec <= createSec) {
        result.advanced += 1;
        continue; // nothing can have closed after the publication instant yet
      }

      // Phase 10.3-B temporal bounds (bar-open instants):
      //   lower: open > decisionOpen (never the decision bar itself) AND
      //          open > creation − 900  ⟺  close > creation (publication)
      //   upper: open < expiry (only the 12-bar window) AND open ≤ now.
      // resolvePaperOutcome independently enforces the same bounds — the
      // query bound keeps the fetch minimal; the pure function is the
      // authoritative guard (defense in depth, directly unit-tested).
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
      const bars: CandleBar[] = [];
      for (const c of candleRows) {
        const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
        if (![o, h, l, cl].every((v) => Number.isFinite(v) && v > 0)) continue; // re-validated at read time
        if (!(h >= Math.max(o, cl) && l <= Math.min(o, cl) && h >= l)) continue;
        bars.push({ timeUtcSec: Math.floor(c.candleTimeUtc.getTime() / 1000), open: o, high: h, low: l, close: cl });
      }

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
        // last bar actually WALKED (post-publication, pre-expiry, closed) —
        // never a fetched-but-excluded bar
        lastCheckedBarTimeUtc: adv.lastWalkedBarTime !== null ? new Date(adv.lastWalkedBarTime * 1000) : null,
        details: JSON.stringify({
          costLabels: costs.labels,
          resolutionRule: adv.rule,
          collision: adv.collision,
          // Phase 10.3-B: the publication bound is documented on the row
          signalCreatedUtcSec: createSec,
          walkLowerBoundOpenUtcSec: Math.floor(lowerOpenMs / 1000),
        }),
      };

      // riskPrice recomputed from the row's own frozen geometry — the
      // engine's exact risk formula (entryReference − stopLoss | mirrored).
      const riskPrice =
        paper.direction === 'BUY'
          ? paper.entryReference - paper.stopLoss
          : paper.stopLoss - paper.entryReference;

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
        where: { id: paper.id },
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
