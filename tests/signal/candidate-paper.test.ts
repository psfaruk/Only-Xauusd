/**
 * PHASE 11-E — CANDIDATE FORWARD-PAPER TRACKING TESTS.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic CANDIDATE SignalEvaluation rows + synthetic
 * candles on the ISOLATED TEST DATABASE — never real broker data.
 *
 * Pins (protocol audit/phase11-candidate-forward-protocol.md):
 *   · identity dedup: ONE PaperCandidateOutcome row per candidate setup
 *     identity EVER (unique setupFingerprint; repeated evaluations are
 *     suppressed repeats, incl. the P2002 concurrent-race shape)
 *   · walker resolution: target / stop (SL-first incl. collision) /
 *     invalidation (close beyond the per-model invalidation level) / expiry
 *     — the SAME setup-chronology/1 semantics as the baseline walker
 *   · resolved rows are IMMUTABLE — reprocessing never counts twice
 *   · honest expiry with NULL exit/P-L when no observable bars existed
 *   · cost model: observed spread 0.24 + 0.02/side slippage full round trip
 *   · ISOLATION: candidate rows never enter PaperSignalOutcome; baseline
 *     rows never enter PaperCandidateOutcome; each tracker is scoped
 *   · read side: getCandidatePaperStats counts + the pre-registered verdict
 *     (INCOMPLETE below the 20-outcome floor — no claim of any kind)
 *   · SystemEvent audit codes for activations/resolutions (Bengali messages)
 */

import '../market/helpers/setup';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { db } from '@/lib/db';
import { trackPaperSignals } from '@/lib/signal/paper';
import { trackCandidatePaperSignals, getCandidatePaperStats } from '@/lib/signal/candidate-paper';
import { computeCandidateSetupFingerprint } from '@/lib/signal/candidate/identity';
import { CANDIDATE_STRATEGY_VERSION } from '@/lib/signal/candidate/types';
import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';
import {
  candidateForwardActivatedMs,
  evaluateCandidatePaperVerdict,
  candidateStopConditionTriggered,
} from '@/lib/signal/candidate-protocol';
import { FIXED_NOW_SEC } from '../market/helpers/setup';

const SYMBOL = 'XAUUSDm';
const M15 = 900;
/** Candidate protocol activation instant (2026-10-20T15:00:00Z). */
const ACTIVATION_SEC = Math.floor(candidateForwardActivatedMs() / 1000);
/** Fixed tracker clock: 2h after activation — every seeded bar is closed. */
const NOW_SEC = ACTIVATION_SEC + 7200;
const NOW = () => NOW_SEC * 1000;

/** Decision bar: 10 M15 bars before the fixed now. */
const DECISION_SEC = NOW_SEC - 10 * M15;

interface SeedOpts {
  id: string;
  model?: 'A' | 'B' | 'C';
  side?: 'BUY' | 'SELL';
  decisionSec?: number;
  createdAtSec?: number;
  expirySec?: number;
  entryReference?: number;
  stopLoss?: number;
  target?: number;
  invalidationLevel?: number;
  /** Distinct anchor per fixture → distinct candidate setup identity. */
  anchorSec?: number;
  strategyVersion?: string;
  levelsJson?: string | null;
  setupFingerprint?: string | null;
  outcome?: string;
}

function candidateFingerprint(o: SeedOpts): string {
  return computeCandidateSetupFingerprint({
    symbol: SYMBOL,
    timeframe: 'M15',
    model: o.model ?? 'B',
    direction: o.side ?? 'BUY',
    anchorKey: { kind: 'pullback', extremeBarTimeUtcSec: o.anchorSec ?? (o.decisionSec ?? DECISION_SEC) - M15 },
  });
}

/** Seed one synthetic CANDIDATE setup evaluation row (mirrors paper.test.ts's baseline seeder). */
async function seedCandidateEval(o: SeedOpts): Promise<void> {
  const model = o.model ?? 'B';
  const side = o.side ?? 'BUY';
  const decisionSec = o.decisionSec ?? DECISION_SEC;
  const createdAtSec = o.createdAtSec ?? decisionSec + M15 + 300;
  const expirySec = o.expirySec ?? decisionSec + 12 * M15;
  const entryReference = o.entryReference ?? 2650;
  const stopLoss = o.stopLoss ?? 2640;
  const target = o.target ?? 2670;
  const invalidationLevel = o.invalidationLevel ?? 2645;
  const risk = side === 'BUY' ? entryReference - stopLoss : stopLoss - entryReference;
  await db.signalEvaluation.create({
    data: {
      id: o.id,
      engineVersion: '9.0.0',
      strategyVersion: o.strategyVersion ?? CANDIDATE_STRATEGY_VERSION,
      symbol: SYMBOL,
      outcome: o.outcome ?? (side === 'BUY' ? 'BUY_SETUP' : 'SELL_SETUP'),
      reasonCodes: '[]',
      inputFingerprint: `cfp-${o.id}`,
      datasetFingerprint: `cdfp-${o.id}`,
      setupFingerprint: o.setupFingerprint === undefined ? candidateFingerprint(o) : o.setupFingerprint,
      inputSnapshot: JSON.stringify({
        windows: {
          execution: { fromUtc: new Date((decisionSec - 300 * M15) * 1000).toISOString(), toUtc: new Date(decisionSec * 1000).toISOString(), bars: 300 },
          h1: null, h4: null, m5: null,
        },
      }),
      evidence: JSON.stringify({
        model,
        direction: side,
        conflict: false,
        suppressedModels: [],
        modelA: { outcome: 'WAIT', reasonCodes: ['RETEST_PENDING'] },
        modelB: { setup: model === 'B', stage: null },
        modelC: { setups: [], stage: 'RANGE_NOT_DETECTED' },
      }),
      levels: o.levelsJson === undefined
        ? JSON.stringify({
            direction: side,
            entryZoneLow: invalidationLevel, entryZoneHigh: invalidationLevel + 1,
            entryReference, stopLoss, target,
            invalidationLevel,
            riskPrice: risk, rewardPrice: Math.abs(target - entryReference), rewardRiskRatio: 2,
            entryZoneLowText: String(invalidationLevel), entryZoneHighText: String(invalidationLevel + 1),
            stopLossText: String(stopLoss), targetText: String(target), entryReferenceText: String(entryReference),
          })
        : o.levelsJson,
      decisionCandleTimeUtc: new Date(decisionSec * 1000),
      setupKnownAtUtc: new Date((decisionSec + M15) * 1000),
      expiryUtc: new Date(expirySec * 1000),
      createdAt: new Date(createdAtSec * 1000),
      quote: '{}',
      executionLocked: true,
      durationMs: 4,
    },
  });
}

/** Seed one synthetic BASELINE setup evaluation row (baseline evidence shape — mirrors paper.test.ts). */
async function seedBaselineEval(o: SeedOpts): Promise<void> {
  const side = o.side ?? 'BUY';
  const decisionSec = o.decisionSec ?? DECISION_SEC;
  const createdAtSec = o.createdAtSec ?? decisionSec + M15 + 300;
  const expirySec = o.expirySec ?? decisionSec + 12 * M15;
  const entryReference = o.entryReference ?? 2650;
  const stopLoss = o.stopLoss ?? 2640;
  const target = o.target ?? 2670;
  const invalidationLevel = o.invalidationLevel ?? 2645;
  const risk = side === 'BUY' ? entryReference - stopLoss : stopLoss - entryReference;
  await db.signalEvaluation.create({
    data: {
      id: o.id,
      engineVersion: '9.0.0',
      strategyVersion: SIGNAL_STRATEGY_VERSION,
      symbol: SYMBOL,
      outcome: side === 'BUY' ? 'BUY_SETUP' : 'SELL_SETUP',
      reasonCodes: '[]',
      inputFingerprint: `bfp-${o.id}`,
      datasetFingerprint: `bdfp-${o.id}`,
      setupFingerprint: null, // the baseline tracker derives it from the evidence below
      inputSnapshot: '{}',
      evidence: JSON.stringify({
        structureEvent: {
          type: 'BOS',
          direction: side === 'BUY' ? 'bullish' : 'bearish',
          level: invalidationLevel,
          levelText: String(invalidationLevel),
          breakCandleTimeUtc: new Date((decisionSec - 2 * M15) * 1000).toISOString(),
          barsSinceBreak: 2,
        },
        executionWindow: { fromUtc: new Date((decisionSec - 300 * M15) * 1000).toISOString(), toUtc: new Date(decisionSec * 1000).toISOString(), bars: 300 },
        h1Window: { fromUtc: new Date(decisionSec * 1000).toISOString(), toUtc: new Date(decisionSec * 1000).toISOString(), bars: 300 },
        h4Window: { fromUtc: new Date(decisionSec * 1000).toISOString(), toUtc: new Date(decisionSec * 1000).toISOString(), bars: 300 },
      }),
      levels: JSON.stringify({
        direction: side,
        entryZoneLow: invalidationLevel, entryZoneHigh: invalidationLevel + 1,
        entryReference, stopLoss, target,
        riskPrice: risk, rewardPrice: Math.abs(target - entryReference), rewardRiskRatio: 2,
        entryZoneLowText: String(invalidationLevel), entryZoneHighText: String(invalidationLevel + 1),
        stopLossText: String(stopLoss), targetText: String(target), entryReferenceText: String(entryReference),
      }),
      decisionCandleTimeUtc: new Date(decisionSec * 1000),
      setupKnownAtUtc: new Date((decisionSec + M15) * 1000),
      expiryUtc: new Date(expirySec * 1000),
      createdAt: new Date(createdAtSec * 1000),
      quote: '{}',
      executionLocked: true,
      durationMs: 4,
    },
  });
}

async function insertM15Candle(timeSec: number, o: number, h: number, l: number, c: number, source = 'bridge-mt5') {
  await db.marketCandle.create({
    data: {
      symbol: SYMBOL,
      timeframe: 'M15',
      candleTimeUtc: new Date(timeSec * 1000),
      open: String(o), high: String(h), low: String(l), close: String(c),
      source,
      isForming: false,
      validationStatus: 'VALID',
      receivedAtUtc: new Date(timeSec * 1000),
    },
  });
}

const trackCandidate = () => trackCandidatePaperSignals(db, { symbol: SYMBOL, now: NOW });
const trackBaseline = () => trackPaperSignals(db, { symbol: SYMBOL, now: NOW });

beforeEach(async () => {
  await db.paperCandidateOutcome.deleteMany();
  await db.paperSignalOutcome.deleteMany();
  await db.signalEvaluation.deleteMany();
  await db.marketCandle.deleteMany({ where: { timeframe: 'M15' } });
  await db.systemEvent.deleteMany({ where: { category: 'candidate' } });
});

afterAll(async () => {
  await db.paperCandidateOutcome.deleteMany();
  await db.paperSignalOutcome.deleteMany();
  await db.signalEvaluation.deleteMany();
  await db.marketCandle.deleteMany({ where: { timeframe: 'M15' } });
  await db.systemEvent.deleteMany({ where: { category: 'candidate' } });
});

describe('candidate paper tracker — identity dedup + walker resolution (DB)', () => {
  test('targeted outcome recorded once; repeated track calls → ONE row (identity dedup), immutability after resolution', async () => {
    await seedCandidateEval({ id: 'cp-targeted', anchorSec: DECISION_SEC - 3 * M15 });
    await insertM15Candle(DECISION_SEC + M15, 2650, 2653, 2649, 2652);
    await insertM15Candle(DECISION_SEC + 2 * M15, 2652, 2671, 2651, 2668); // target touched

    const first = await trackCandidate();
    expect(first.scanned).toBe(1);
    expect(first.newlyOpened).toBe(1);
    expect(first.resolved.targeted).toBe(1);

    const second = await trackCandidate();
    expect(second.scanned).toBe(1);
    expect(second.skippedResolved).toBe(1); // immutable — no double count
    expect(second.newlyOpened).toBe(0);
    expect(second.resolved.targeted).toBe(0);

    const rows = await db.paperCandidateOutcome.findMany({ where: { symbol: SYMBOL } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('resolved');
    expect(rows[0].outcome).toBe('targeted');
    expect(rows[0].exitPrice).toBe(2670);
    expect(rows[0].model).toBe('B');
    expect(rows[0].candidateVersion).toBe(CANDIDATE_STRATEGY_VERSION);
    expect(rows[0].setupFingerprint).toBe(candidateFingerprint({ id: 'cp-targeted', anchorSec: DECISION_SEC - 3 * M15 }));
    // Cost model math: gross = 2670 − 2650 = 20; costs = 0.24 + 2×0.02 = 0.28.
    expect(rows[0].modeledCostsPrice).toBeCloseTo(0.28, 10);
    expect(rows[0].grossPnlPrice).toBeCloseTo(20, 10);
    expect(rows[0].netPnlPrice).toBeCloseTo(19.72, 6);
    expect(rows[0].rMultiple).toBeCloseTo(19.72 / 10, 4); // risk = 2650−2640
    expect(rows[0].observations).toBe(2);
  });

  test('stopped with collision → conservative loss first (same rule as the baseline walker)', async () => {
    await seedCandidateEval({ id: 'cp-stopped', anchorSec: DECISION_SEC - 4 * M15 });
    await insertM15Candle(DECISION_SEC + M15, 2650, 2675, 2635, 2660); // both touched
    const out = await trackCandidate();
    expect(out.resolved.stopped).toBe(1);
    const row = await db.paperCandidateOutcome.findUnique({ where: { candidateEvaluationId: 'cp-stopped' } });
    expect(row?.outcome).toBe('stopped');
    expect(row?.exitPrice).toBe(2640);
    expect(row?.netPnlPrice).toBeCloseTo(-10.28, 6); // 2640−2650 = −10 gross, −0.28 costs
    let details: { collision?: boolean } = {};
    try { details = JSON.parse(row?.details ?? '{}') as typeof details; } catch { /* honest default */ }
    expect(details.collision).toBe(true);
  });

  test('invalidation: M15 close beyond the per-model invalidation level → invalidated at that close', async () => {
    await seedCandidateEval({ id: 'cp-invalidated', anchorSec: DECISION_SEC - 5 * M15, invalidationLevel: 2645 });
    // OHLC-consistent: low 2644.0 ≤ close 2644.2 (a close below the low would
    // be rejected by the read-time re-validation, by design).
    await insertM15Candle(DECISION_SEC + M15, 2648, 2649, 2644.0, 2644.2); // close < invalidation (BUY), low > SL
    const out = await trackCandidate();
    expect(out.resolved.invalidated).toBe(1);
    const row = await db.paperCandidateOutcome.findUnique({ where: { candidateEvaluationId: 'cp-invalidated' } });
    expect(row?.outcome).toBe('invalidated');
    expect(row?.exitPrice).toBe(2644.2);
    expect(row?.netPnlPrice).toBeCloseTo(2644.2 - 2650 - 0.28, 6);
  });

  test('expiry without hits → expired at the last closed bar close; NO bars → honest NULL exit/P-L', async () => {
    await seedCandidateEval({ id: 'cp-expired', anchorSec: DECISION_SEC - 6 * M15, expirySec: DECISION_SEC + 3 * M15 });
    await insertM15Candle(DECISION_SEC + M15, 2652, 2658, 2650, 2655);
    await insertM15Candle(DECISION_SEC + 2 * M15, 2655, 2659, 2651, 2657);
    let out = await trackCandidate();
    expect(out.resolved.expired).toBe(1);
    let row = await db.paperCandidateOutcome.findUnique({ where: { candidateEvaluationId: 'cp-expired' } });
    expect(row?.outcome).toBe('expired');
    expect(row?.exitPrice).toBe(2657);
    expect(row?.netPnlPrice).toBeCloseTo(2657 - 2650 - 0.28, 6);

    // Honest unobservable case: a decision anchor FAR in the past whose walk
    // window contains no candles at all (the bars above are past its expiry).
    const farDecision = DECISION_SEC - 20 * M15;
    await seedCandidateEval({ id: 'cp-expired-null', anchorSec: farDecision - 5 * M15, decisionSec: farDecision, expirySec: farDecision + 3 * M15 });
    out = await trackCandidate();
    expect(out.resolved.expired).toBe(1); // only the new row resolves in this pass
    row = await db.paperCandidateOutcome.findUnique({ where: { candidateEvaluationId: 'cp-expired-null' } });
    expect(row?.outcome).toBe('expired');
    expect(row?.exitPrice).toBeNull();
    expect(row?.netPnlPrice).toBeNull();
    expect(row?.rMultiple).toBeNull();
    let details: { resolutionRule?: string } = {};
    try { details = JSON.parse(row?.details ?? '{}') as typeof details; } catch { /* honest default */ }
    expect(details.resolutionRule).toContain('unobservable');
  });

  test('repeat evaluation of the SAME candidate identity → duplicatesSuppressed, never a second row', async () => {
    const anchor = DECISION_SEC - 8 * M15;
    // Two evaluation rows, SAME anchor → SAME candidate setup identity.
    await seedCandidateEval({ id: 'cp-dup-1', anchorSec: anchor, createdAtSec: DECISION_SEC + M15 + 300 });
    await seedCandidateEval({ id: 'cp-dup-2', anchorSec: anchor, createdAtSec: DECISION_SEC + M15 + 600 });
    await insertM15Candle(DECISION_SEC + M15, 2652, 2658, 2650, 2655);
    const out = await trackCandidate();
    expect(out.scanned).toBe(2);
    expect(out.newlyOpened).toBe(1); // ONE row per identity EVER
    expect(out.duplicatesSuppressed).toBe(1);
    expect(await db.paperCandidateOutcome.count()).toBe(1);
  });

  test('unidentifiable candidate setup (null fingerprint) → fail-closed, no paper row', async () => {
    await seedCandidateEval({ id: 'cp-unidentifiable', anchorSec: DECISION_SEC - 9 * M15, setupFingerprint: null });
    const out = await trackCandidate();
    expect(out.scanned).toBe(0); // parse fails closed before any DB write
    expect(await db.paperCandidateOutcome.count()).toBe(0);
  });

  test('SystemEvent audit codes written for activation + resolution (Bengali messages)', async () => {
    await seedCandidateEval({ id: 'cp-audit', anchorSec: DECISION_SEC - 10 * M15 });
    await insertM15Candle(DECISION_SEC + M15, 2652, 2671, 2651, 2668); // target
    await trackCandidate();
    const events = await db.systemEvent.findMany({
      where: { category: 'candidate', code: { in: ['CANDIDATE_PAPER_OPENED', 'CANDIDATE_PAPER_RESOLVED'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(events[0].code).toBe('CANDIDATE_PAPER_OPENED');
    expect(events[0].message).toContain('ক্যান্ডিডেট পেপার পজিশন');
    expect(events[1].code).toBe('CANDIDATE_PAPER_RESOLVED');
    expect(events[1].message).toContain('ক্যান্ডিডেট পেপার ফলাফল');
    expect(events[1].message).toContain('targeted');
  });

  test('pre-publication bars never contribute (setup-chronology/1 publication bound)', async () => {
    // creation = decisionClose + 300 (the normal scheduler cadence).
    await seedCandidateEval({ id: 'cp-pub-bound', anchorSec: DECISION_SEC - 11 * M15, createdAtSec: DECISION_SEC + M15 + 300 });
    // A bar whose close is at/before the publication instant — it touches the
    // STOP and must NEVER contribute (pre-publication information).
    await insertM15Candle(DECISION_SEC, 2650, 2655, 2630, 2650); // low 2630 ≤ SL 2640
    // A post-publication bar that touches the target — the ONLY walkable bar.
    await insertM15Candle(DECISION_SEC + M15, 2652, 2675, 2651, 2670);
    const out = await trackCandidate();
    expect(out.resolved.targeted).toBe(1); // NOT stopped — the pre-publication bar was excluded
    expect(out.resolved.stopped).toBe(0);
    const row = await db.paperCandidateOutcome.findUnique({ where: { candidateEvaluationId: 'cp-pub-bound' } });
    expect(row?.observations).toBe(1);
  });
});

describe('candidate paper tracker — ISOLATION (protocol §4 cannot-mix)', () => {
  test('candidate actionable rows NEVER enter PaperSignalOutcome; the baseline tracker ignores them', async () => {
    await seedCandidateEval({ id: 'iso-cand', anchorSec: DECISION_SEC - 12 * M15 });
    await insertM15Candle(DECISION_SEC + M15, 2652, 2671, 2651, 2668);
    const baselineOut = await trackBaseline();
    expect(baselineOut.scanned).toBe(0);
    expect(baselineOut.newlyOpened).toBe(0);
    expect(await db.paperSignalOutcome.count()).toBe(0); // NEVER

    const candidateOut = await trackCandidate();
    expect(candidateOut.newlyOpened).toBe(1);
    expect(await db.paperCandidateOutcome.count()).toBe(1);
  });

  test('baseline actionable rows NEVER enter PaperCandidateOutcome; the candidate tracker ignores them', async () => {
    await seedBaselineEval({ id: 'iso-base', anchorSec: DECISION_SEC - 13 * M15 });
    await insertM15Candle(DECISION_SEC + M15, 2652, 2671, 2651, 2668);
    const candidateOut = await trackCandidate();
    expect(candidateOut.scanned).toBe(0);
    expect(await db.paperCandidateOutcome.count()).toBe(0); // NEVER

    const baselineOut = await trackBaseline();
    expect(baselineOut.newlyOpened).toBe(1);
    expect(await db.paperSignalOutcome.count()).toBe(1);
  });

  test('candidate setup fingerprints can never collide with the baseline namespace (different identity payload)', async () => {
    const candidateFp = candidateFingerprint({ id: 'x', anchorSec: DECISION_SEC - 14 * M15 });
    // Baseline fingerprint over the SAME logical event (computeSetupFingerprint equivalent shape).
    const { computeSetupFingerprint } = await import('@/lib/signal/setup-identity');
    const baselineFp = computeSetupFingerprint({
      symbol: SYMBOL,
      timeframe: 'M15',
      strategyVersion: SIGNAL_STRATEGY_VERSION,
      structureEvent: { type: 'BOS', direction: 'bullish', level: 2645, breakCandleTimeUtc: new Date((DECISION_SEC - M15) * 1000).toISOString() },
    });
    expect(candidateFp).not.toBe(baselineFp);
    expect(candidateFp).toHaveLength(64);
    expect(baselineFp).toHaveLength(64);
  });
});

describe('candidate paper read side — stats + pre-registered verdict', () => {
  test('honest empty: 0 rows → INCOMPLETE, no metrics, protocol info reported', async () => {
    const stats = await getCandidatePaperStats(db, SYMBOL, { now: NOW });
    expect(stats.total).toBe(0);
    expect(stats.completedOutcomes).toBe(0);
    expect(stats.netPnlPrice).toBeNull();
    expect(stats.verdict.conclusion).toBe('INCOMPLETE');
    expect(stats.verdict.protocolId).toBe('phase11-candidate-forward/1');
    expect(stats.protocol.activatedAtUtc).toBe('2026-10-20T15:00:00Z');
    expect(stats.protocol.minCompleted).toBe(20);
    expect(stats.protocol.windowDays).toBe(90);
    expect(new Date(stats.protocol.deadlineUtc).getTime()).toBe(candidateForwardActivatedMs() + 90 * 86_400_000);
  });

  test('counts by status/outcome aggregate from PaperCandidateOutcome; forward-only counting', async () => {
    // Seed PaperCandidateOutcome rows DIRECTLY (mirrors the baseline
    // forward-paper test pattern) — the read side is under test here.
    const mk = async (over: Record<string, unknown> & { atSec: number; fp: string }) => {
      const at = new Date(over.atSec * 1000);
      const { atSec: _atSec, fp, ...rest } = over;
      void _atSec;
      await db.paperCandidateOutcome.create({
        data: {
          candidateEvaluationId: `stats-${fp}`,
          symbol: SYMBOL, model: 'B', candidateVersion: CANDIDATE_STRATEGY_VERSION, direction: 'BUY',
          signalCreatedAtUtc: at, decisionCandleTimeUtc: at, setupKnownAtUtc: at,
          expiryUtc: new Date((over.atSec + 12 * M15) * 1000),
          inputFingerprint: `fp-${fp}`, setupFingerprint: `sfp-${fp}`, sourceCandleRange: '{}',
          entryReference: 2650, stopLoss: 2640, target: 2670, invalidationLevel: 2645,
          modeledCostsPrice: 0.28,
          ...rest,
        } as never,
      });
    };
    // A row created BEFORE activation must never count (defense in depth).
    await mk({ atSec: ACTIVATION_SEC - 3600, fp: 'pre', status: 'resolved', outcome: 'stopped', exitPrice: 2640, resolvedAtUtc: new Date(NOW_SEC * 1000), observations: 1, grossPnlPrice: -10, netPnlPrice: -10.28, rMultiple: -1.028 });
    // Eligible rows: one open + one targeted + one expired-unobservable.
    await mk({ atSec: ACTIVATION_SEC + 60, fp: 'open', status: 'open', observations: 0 });
    await mk({ atSec: ACTIVATION_SEC + 120, fp: 'win', status: 'resolved', outcome: 'targeted', exitPrice: 2670, resolvedAtUtc: new Date(NOW_SEC * 1000), observations: 2, grossPnlPrice: 20, netPnlPrice: 19.72, rMultiple: 1.972 });
    await mk({ atSec: ACTIVATION_SEC + 180, fp: 'nulobs', status: 'resolved', outcome: 'expired', exitPrice: null, resolvedAtUtc: new Date(NOW_SEC * 1000), observations: 0, grossPnlPrice: null, netPnlPrice: null, rMultiple: null });

    const stats = await getCandidatePaperStats(db, SYMBOL, { now: NOW });
    expect(stats.total).toBe(3); // pre-activation row excluded
    expect(stats.open).toBe(1);
    expect(stats.resolved.targeted).toBe(1);
    expect(stats.resolved.expired).toBe(1);
    expect(stats.completedOutcomes).toBe(1); // targeted only (expired-unobservable excluded)
    expect(stats.unobservableExpired).toBe(1);
    expect(stats.netPnlPrice).toBeCloseTo(19.72, 4);
    expect(stats.sumR).toBeCloseTo(1.972, 4);
    expect(stats.verdict.conclusion).toBe('INCOMPLETE'); // 1/20 — no claim of any kind
    expect(stats.verdict.reasons.join(' ')).toContain('1/20');
    expect(stats.stopCondition.triggered).toBe(false);
  });

  test('verdict rules (pure): ≥20 floor, net≤0, concentration, drawdown, continue', () => {
    const mk = (net: number, r: number) => ({ netPnlPrice: net, rMultiple: r });
    const nowMs = candidateForwardActivatedMs() + 10 * 86_400_000;

    // Below floor, before deadline → INCOMPLETE.
    expect(
      evaluateCandidatePaperVerdict({ completedOutcomes: [mk(5, 0.5)], openRows: 0, unobservableExpired: 0, nowMs }).conclusion,
    ).toBe('INCOMPLETE');
    // Below floor, past deadline → INCOMPLETE_TIMEOUT.
    expect(
      evaluateCandidatePaperVerdict({ completedOutcomes: [], openRows: 0, unobservableExpired: 0, nowMs: candidateForwardActivatedMs() + 91 * 86_400_000 }).conclusion,
    ).toBe('INCOMPLETE_TIMEOUT');
    // ≥20, net ≤ 0 → NEGATIVE_AFTER_COSTS.
    expect(
      evaluateCandidatePaperVerdict({ completedOutcomes: Array.from({ length: 20 }, () => mk(-1, -1)), openRows: 0, unobservableExpired: 0, nowMs }).conclusion,
    ).toBe('NEGATIVE_AFTER_COSTS');
    // ≥20, net > 0 but one winner > 35% of wins → INCONCLUSIVE_CONCENTRATION.
    const concentrated = [mk(100, 10), ...Array.from({ length: 19 }, () => mk(1, 0.1))];
    expect(
      evaluateCandidatePaperVerdict({ completedOutcomes: concentrated, openRows: 0, unobservableExpired: 0, nowMs }).conclusion,
    ).toBe('INCONCLUSIVE_CONCENTRATION');
    // ≥20, net > 0, diversified, 8+ consecutive losses → INCONCLUSIVE_DRAWDOWN.
    const streaky = [...Array.from({ length: 13 }, () => mk(5, 0.5)), ...Array.from({ length: 8 }, () => mk(-1, -0.1))];
    expect(
      evaluateCandidatePaperVerdict({ completedOutcomes: streaky, openRows: 0, unobservableExpired: 0, nowMs }).conclusion,
    ).toBe('INCONCLUSIVE_DRAWDOWN');
    // All gates passed → CONTINUE_FORWARD_RESEARCH (explicitly NOT authorization).
    // 14 wins + 6 losses: no loss streak ≥ 8, drawdown 1.2R < 10R, top-1 share 1/14.
    const healthy = [...Array.from({ length: 14 }, () => mk(5, 0.5)), ...Array.from({ length: 6 }, () => mk(-2, -0.2))];
    const verdict = evaluateCandidatePaperVerdict({ completedOutcomes: healthy, openRows: 0, unobservableExpired: 0, nowMs });
    expect(verdict.conclusion).toBe('CONTINUE_FORWARD_RESEARCH');
    expect(verdict.reasons.join(' ')).toContain('NOT trading authorization');
    // §5.3 stopping condition: 8 consecutive completed losses.
    expect(candidateStopConditionTriggered(Array.from({ length: 8 }, () => mk(-1, -1))).triggered).toBe(true);
    expect(candidateStopConditionTriggered(healthy).triggered).toBe(false);
  });
});
