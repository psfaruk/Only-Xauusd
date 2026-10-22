/**
 * PHASE 6 — PAPER TIMING CAPTURE + LATENCY STATS TESTS (Task 42-S3).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic SignalEvaluation/PaperSignalOutcome rows on the
 * ISOLATED TEST DATABASE — never real broker data.
 *
 * Pins:
 *   · NEW rows persist an end-to-end timing block inside `details` (additive
 *     JSON meta — schema untouched): decisionCandleCloseAtUtc / detectedAtUtc /
 *     trackedAtUtc
 *   · the timing block SURVIVES the advance-update rewrite (recomputed exactly
 *     from the row's own columns — never lost, never drifted)
 *   · getPaperSignalSummary surfaces decisionLatencyMs (median/p95 of
 *     detectedAt − candleClose) and trackedLatencyMs (median/p95 of
 *     trackedAt − detectedAt)
 *   · HISTORICAL HONESTY: rows created BEFORE this change (no timing block in
 *     details) still contribute to the latency stats — the three instants are
 *     pre-existing columns, so there is NO historical gap for the statistics
 *   · computePaperTimingStats pure edges: empty → nulls, negative deltas →
 *     invalidRows (defensive), exact percentile arithmetic
 */

import { afterAll, describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { db } from '@/lib/db';
import {
  computePaperTimingStats,
  getPaperSignalSummary,
  trackPaperSignals,
  type PaperTimingSourceRow,
} from '@/lib/signal/paper';
import { FIXED_NOW_SEC } from '../market/helpers/setup';

const M15 = 900;

afterAll(async () => {
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// Pure stats
// ---------------------------------------------------------------------------

describe('computePaperTimingStats — pure latency arithmetic', () => {
  function row(knownSec: number, detectedSec: number, trackedSec: number): PaperTimingSourceRow {
    return {
      setupKnownAtUtc: new Date(knownSec * 1000),
      signalCreatedAtUtc: new Date(detectedSec * 1000),
      createdAt: new Date(trackedSec * 1000),
    };
  }

  test('median/p95 of decisionLatency and trackedLatency (nearest-rank)', () => {
    const base = 1_791_000_000;
    // decisionLatency: 300s, 300s, 600s → median 300000, p95 600000
    // trackedLatency: 1s, 2s, 9s → median 2000, p95 9000
    const stats = computePaperTimingStats([
      row(base, base + 300, base + 301),
      row(base, base + 300, base + 302),
      row(base, base + 600, base + 609),
    ]);
    expect(stats.decisionLatencyMs.count).toBe(3);
    expect(stats.decisionLatencyMs.medianMs).toBe(300_000);
    expect(stats.decisionLatencyMs.p95Ms).toBe(600_000);
    expect(stats.trackedLatencyMs.count).toBe(3);
    expect(stats.trackedLatencyMs.medianMs).toBe(2_000);
    expect(stats.trackedLatencyMs.p95Ms).toBe(9_000);
    expect(stats.invalidRows).toBe(0);
  });

  test('empty input → nulls with count 0 (never fabricated)', () => {
    const stats = computePaperTimingStats([]);
    expect(stats.decisionLatencyMs.count).toBe(0);
    expect(stats.decisionLatencyMs.medianMs).toBeNull();
    expect(stats.decisionLatencyMs.p95Ms).toBeNull();
    expect(stats.trackedLatencyMs.medianMs).toBeNull();
  });

  test('negative deltas (chronologically impossible) → invalidRows, skipped', () => {
    const base = 1_791_000_000;
    const stats = computePaperTimingStats([
      row(base, base - 10, base + 5), // detected BEFORE the candle closed — impossible
    ]);
    expect(stats.invalidRows).toBe(1);
    expect(stats.decisionLatencyMs.count).toBe(0);
    expect(stats.decisionLatencyMs.medianMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DB pipeline — timing block capture + survival across advances
// ---------------------------------------------------------------------------

async function insertSetupEvaluation(opts: {
  id: string;
  direction: 'BUY' | 'SELL';
  decisionSec: number;
  createdAtSec: number;
  expirySec: number;
}) {
  const decisionIso = new Date(opts.decisionSec * 1000);
  const breakIso = new Date((opts.decisionSec - 2 * M15) * 1000);
  await db.signalEvaluation.create({
    data: {
      id: opts.id,
      engineVersion: '9.0.0',
      strategyVersion: 'hybrid-structure-retest/9.0.0',
      symbol: 'XAUUSDm',
      outcome: opts.direction === 'BUY' ? 'BUY_SETUP' : 'SELL_SETUP',
      reasonCodes: '[]',
      inputFingerprint: `fp-${opts.id}`,
      datasetFingerprint: `dfp-${opts.id}`,
      inputSnapshot: '{}',
      evidence: JSON.stringify({
        structureEvent: {
          type: 'BOS',
          direction: opts.direction === 'BUY' ? 'bullish' : 'bearish',
          level: 2645,
          levelText: '2645',
          breakCandleTimeUtc: breakIso.toISOString(),
          barsSinceBreak: 2,
        },
        executionWindow: { fromUtc: decisionIso.toISOString(), toUtc: decisionIso.toISOString(), bars: 300 },
        h1Window: { fromUtc: decisionIso.toISOString(), toUtc: decisionIso.toISOString(), bars: 300 },
        h4Window: { fromUtc: decisionIso.toISOString(), toUtc: decisionIso.toISOString(), bars: 300 },
      }),
      levels: JSON.stringify({
        direction: opts.direction,
        entryZoneLow: 2649, entryZoneHigh: 2651,
        entryReference: 2650,
        stopLoss: 2640, target: 2670,
        riskPrice: 10, rewardPrice: 20, rewardRiskRatio: 2,
        entryZoneLowText: '2649', entryZoneHighText: '2651',
        stopLossText: '2640', targetText: '2670', entryReferenceText: '2650',
      }),
      decisionCandleTimeUtc: decisionIso,
      createdAt: new Date(opts.createdAtSec * 1000),
      setupKnownAtUtc: new Date((opts.decisionSec + M15) * 1000),
      expiryUtc: new Date(opts.expirySec * 1000),
      quote: '{}',
      executionLocked: true,
      durationMs: 5,
    },
  });
}

async function insertM15Candle(timeSec: number, o: number, h: number, l: number, c: number) {
  await db.marketCandle.create({
    data: {
      symbol: 'XAUUSDm',
      timeframe: 'M15',
      candleTimeUtc: new Date(timeSec * 1000),
      open: String(o), high: String(h), low: String(l), close: String(c),
      source: 'bridge-mt5',
      isForming: false,
      validationStatus: 'VALID',
      receivedAtUtc: new Date(timeSec * 1000),
    },
  });
}

describe('paper timing — capture on create, survival across advances (DB)', () => {
  test('a new paper row persists details.timing and keeps it through the advance rewrite', async () => {
    const decisionSec = FIXED_NOW_SEC - 4 * M15; // within its 12-bar expiry at FIXED_NOW
    // detection 300 s after the candle close (the scheduler's normal cadence)
    const createdAtSec = decisionSec + M15 + 300;
    await insertSetupEvaluation({
      id: 'timing-capture-1',
      direction: 'BUY',
      decisionSec,
      createdAtSec,
      expirySec: decisionSec + 12 * M15,
    });
    // a post-publication bar that touches the target (walked only in pass 2)
    await insertM15Candle(decisionSec + 2 * M15, 2652, 2671, 2651, 2668);

    // PASS 1 at exactly the detection instant: the row is CREATED (timing
    // block from the injectable clock) and NOT yet advanced (now == createSec).
    const pass1 = await trackPaperSignals(db, {
      symbol: 'XAUUSDm',
      now: () => createdAtSec * 1000,
    });
    expect(pass1.newlyOpened).toBe(1);

    const created = await db.paperSignalOutcome.findUnique({
      where: { signalEvaluationId: 'timing-capture-1' },
    });
    expect(created).not.toBeNull();
    if (!created) return;
    const details = JSON.parse(created.details ?? '{}') as {
      timing?: { decisionCandleCloseAtUtc?: string; detectedAtUtc?: string; trackedAtUtc?: string };
    };
    expect(details.timing).toBeDefined();
    expect(details.timing?.decisionCandleCloseAtUtc).toBe(new Date((decisionSec + M15) * 1000).toISOString());
    expect(details.timing?.detectedAtUtc).toBe(new Date(createdAtSec * 1000).toISOString());
    expect(details.timing?.trackedAtUtc).toBe(new Date(createdAtSec * 1000).toISOString());

    // PASS 2 (15 min later): the walk resolves the row → the update REWRITES
    // details — the timing block must survive, now exact from the row's own
    // columns (trackedAtUtc = the row's DB-assigned createdAt).
    await trackPaperSignals(db, { symbol: 'XAUUSDm', now: () => FIXED_NOW_SEC * 1000 });

    const advanced = await db.paperSignalOutcome.findUnique({
      where: { signalEvaluationId: 'timing-capture-1' },
    });
    expect(advanced?.status).toBe('resolved');
    expect(advanced?.outcome).toBe('targeted');
    const details2 = JSON.parse(advanced?.details ?? '{}') as {
      timing?: { decisionCandleCloseAtUtc?: string; detectedAtUtc?: string; trackedAtUtc?: string };
      resolutionRule?: string;
    };
    expect(details2.resolutionRule).toBeDefined(); // the rewrite happened
    expect(details2.timing).toBeDefined(); // and the timing survived it
    expect(details2.timing?.decisionCandleCloseAtUtc).toBe(new Date((decisionSec + M15) * 1000).toISOString());
    expect(details2.timing?.detectedAtUtc).toBe(new Date(createdAtSec * 1000).toISOString());
    expect(details2.timing?.trackedAtUtc).toBe(advanced?.createdAt.toISOString());
  });

  test('summary surfaces decisionLatencyMs/trackedLatencyMs computed from stored rows', async () => {
    const summary = await getPaperSignalSummary(db, 'XAUUSDm', 50);
    // the row from the previous test: decisionLatency = 300 000 ms exactly
    expect(summary.timing.decisionLatencyMs.count).toBe(1);
    expect(summary.timing.decisionLatencyMs.medianMs).toBe(300_000);
    expect(summary.timing.decisionLatencyMs.p95Ms).toBe(300_000);
    expect(summary.outcomes[0]?.setupKnownAtUtc).toBeDefined();
    expect(summary.outcomes[0]?.trackedAtUtc).toBeDefined();
  });
});

describe('paper timing — historical rows (pre-42-S3, no details.timing) are still computable', () => {
  test('old-style rows contribute to the latency stats via their columns', async () => {
    const base = FIXED_NOW_SEC - 100 * M15;
    // Three old-style paper rows inserted DIRECTLY (as if created before this
    // change): no timing block in details, chosen createdAt offsets.
    for (let i = 0; i < 3; i++) {
      const decisionSec = base + i * 20 * M15;
      await db.paperSignalOutcome.create({
        data: {
          signalEvaluationId: `legacy-timing-${i}`,
          symbol: 'XAUUSDm',
          direction: 'BUY',
          signalCreatedAtUtc: new Date((decisionSec + M15 + 120 + i * 60) * 1000), // detected +120s/+180s/+240s
          decisionCandleTimeUtc: new Date(decisionSec * 1000),
          setupKnownAtUtc: new Date((decisionSec + M15) * 1000),
          expiryUtc: new Date((decisionSec + 12 * M15) * 1000),
          datasetFingerprint: null,
          inputFingerprint: `fp-legacy-${i}`,
          setupFingerprint: null, // legacy rows carry NULL fingerprints
          sourceCandleRange: '{}',
          entryReference: 2650,
          stopLoss: 2640,
          target: 2670,
          invalidationLevel: 2645,
          status: 'resolved',
          outcome: 'targeted',
          resolvedAtUtc: new Date((decisionSec + 3 * M15) * 1000),
          resolutionBarTimeUtc: new Date((decisionSec + 3 * M15) * 1000),
          exitPrice: 2670,
          observations: 2,
          lastCheckedBarTimeUtc: new Date((decisionSec + 3 * M15) * 1000),
          modeledCostsPrice: 0.28,
          grossPnlPrice: 20,
          netPnlPrice: 19.72,
          rMultiple: 1.972,
          details: JSON.stringify({ costLabels: [] }), // NO timing block
          createdAt: new Date((decisionSec + M15 + 120 + i * 60 + 45) * 1000), // tracked 45s after detection
          updatedAt: new Date((decisionSec + 3 * M15) * 1000),
        },
      });
    }

    const summary = await getPaperSignalSummary(db, 'XAUUSDm', 200);
    // decisionLatency values seen: 300000 (test row) + 120000/180000/240000 (legacy)
    // → sorted [120,180,240,300]k → nearest-rank median (n=4, idx 1) = 180000,
    // p95 (idx ceil(.95·4)−1 = 3) = 300000
    expect(summary.timing.decisionLatencyMs.count).toBe(4);
    expect(summary.timing.decisionLatencyMs.medianMs).toBe(180_000);
    expect(summary.timing.decisionLatencyMs.p95Ms).toBe(300_000);
    // trackedLatency values: (test row ≈ real wall clock — excluded from the
    // hand-check) legacy rows: 45000 each → median 45000
    expect(summary.timing.trackedLatencyMs.medianMs).toBe(45_000);
    // the legacy rows' details carry NO timing block — and still counted
    const legacyRow = summary.outcomes.find((o) => o.signalEvaluationId === 'legacy-timing-0');
    expect(legacyRow?.details?.timing).toBeUndefined();
  });
});
