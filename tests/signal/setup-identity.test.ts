/**
 * PHASE 10.3-A — SETUP IDENTITY & DEDUPLICATION TESTS.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic SignalEvaluation rows + synthetic candles on the
 * ISOLATED TEST DATABASE — never real broker data. The 11-row same-setup
 * cluster shape mirrors the LIVE cluster observed on 2026-10-15 (one
 * BOS/bearish setup evaluated 11 times across 4 decision candles) — asserted
 * read-only at capture time; reproduced here synthetically for determinism.
 *
 * User-mandated regression scenarios:
 *   S1 same setup, same decision candle, repeated evaluation
 *   S2 concurrent evaluation of the same setup (+ unique-constraint scope)
 *   S3 same setup on a NEW decision candle, still active (walk-anchor proof)
 *   S4 new valid setup after invalidation (new structure event)
 *   S5 BUY vs SELL — separate setup identity
 *   S6 strategy version change — separate setup identity
 *   S7 restart/recovery — duplicate protection survives; resolved immutability
 *   S8 legacy rows untouched + pre-registered aggregation unchanged
 * Plus:
 *   D1 fingerprint determinism & sensitivity (pure)
 *   D2 persisted-vs-recomputed consistency (saveSignalEvaluation path)
 *   D3 fail-closed: unidentifiable setup → no paper row
 *   D4 BEFORE/AFTER deduplication comparison on the SAME persisted dataset
 */

import '../market/helpers/setup';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { db } from '@/lib/db';
import { trackPaperSignals } from '@/lib/signal/paper';
import { saveSignalEvaluation } from '@/lib/signal/persistence';
import {
  SETUP_IDENTITY_VERSION,
  computeSetupFingerprint,
  setupFingerprintFromEvidence,
} from '@/lib/signal/setup-identity';
import { buildStrategyRules } from '@/lib/signal/rules';
import type { SignalReasonCode } from '@/lib/signal/types';
import { getForwardPaperStatus } from '@/lib/signal/forward';
import {
  applyFirstOpenRule,
  computeForwardPaperMetrics,
  evaluateForwardPaperVerdict,
  forwardPaperActivatedMs,
} from '@/lib/signal/paper-protocol';

const SYMBOL = 'XAUUSDm';
const M15 = 900;
const T0 = Math.floor(forwardPaperActivatedMs() / 1000); // 2026-10-15T16:30:00Z
/** Fixed tracker clock: 2h after activation — every seeded bar is closed. */
const NOW_SEC = T0 + 7200;
const NOW = () => NOW_SEC * 1000;
/** Shared decision candles (open times; candle X closes at T0+1800, Y at T0+2700). */
const X = T0 + 900;
const Y = T0 + 1800;
const STRAT_V9 = 'hybrid-structure-retest/9.0.0';
const STRAT_V10 = 'hybrid-structure-retest/10.0.0';

const track = () => trackPaperSignals(db, { symbol: SYMBOL, now: NOW });

interface EventSeed {
  type: string;
  direction: string;
  level: number;
  breakSec: number;
}

interface SeedOpts {
  id: string;
  event: EventSeed;
  side: 'BUY' | 'SELL';
  decisionSec: number;
  createdAtSec: number;
  entryReference: number;
  stopLoss: number;
  target: number;
  strategyVersion?: string;
  /** D3: drop one identity field to make the setup unidentifiable. */
  omit?: 'type' | 'direction' | 'level' | 'breakCandleTimeUtc';
}

async function seedSetupEval(o: SeedOpts): Promise<void> {
  const drop = o.omit;
  const structureEvent: Record<string, unknown> = {
    type: o.event.type,
    direction: o.event.direction,
    level: o.event.level,
    levelText: String(o.event.level),
    breakCandleTimeUtc: new Date(o.event.breakSec * 1000).toISOString(),
    barsSinceBreak: 2,
  };
  if (drop) delete structureEvent[drop];
  const risk = o.side === 'BUY' ? o.entryReference - o.stopLoss : o.stopLoss - o.entryReference;
  // Engine-consistent semantics: the broken structure level IS the row's
  // invalidation level (invalidationLevelOf: structureEvent.level) and the
  // entry-zone lower bound for BUY setups.
  const zoneLow = o.event.level;
  const zoneHigh = o.event.level + 1;
  await db.signalEvaluation.create({
    data: {
      id: o.id,
      engineVersion: '9.0.0',
      strategyVersion: o.strategyVersion ?? STRAT_V9,
      symbol: SYMBOL,
      outcome: o.side === 'BUY' ? 'BUY_SETUP' : 'SELL_SETUP',
      reasonCodes: '[]',
      inputFingerprint: `fp-${o.id}`,
      datasetFingerprint: `dfp-${o.id}`,
      inputSnapshot: '{}',
      evidence: JSON.stringify({
        structureEvent,
        executionWindow: { fromUtc: new Date((o.decisionSec - 300 * M15) * 1000).toISOString(), toUtc: new Date(o.decisionSec * 1000).toISOString(), bars: 300 },
        h1Window: { fromUtc: new Date(o.decisionSec * 1000).toISOString(), toUtc: new Date(o.decisionSec * 1000).toISOString(), bars: 300 },
        h4Window: { fromUtc: new Date(o.decisionSec * 1000).toISOString(), toUtc: new Date(o.decisionSec * 1000).toISOString(), bars: 300 },
      }),
      levels: JSON.stringify({
        direction: o.side,
        entryZoneLow: zoneLow,
        entryZoneHigh: zoneHigh,
        entryReference: o.entryReference,
        stopLoss: o.stopLoss,
        target: o.target,
        riskPrice: risk,
        rewardPrice: Math.abs(o.target - o.entryReference),
        rewardRiskRatio: 2,
        entryZoneLowText: String(zoneLow),
        entryZoneHighText: String(zoneHigh),
        stopLossText: String(o.stopLoss),
        targetText: String(o.target),
        entryReferenceText: String(o.entryReference),
      }),
      decisionCandleTimeUtc: new Date(o.decisionSec * 1000),
      setupKnownAtUtc: new Date((o.decisionSec + M15) * 1000),
      expiryUtc: new Date((o.decisionSec + 12 * M15) * 1000),
      quote: '{}',
      executionLocked: true,
      durationMs: 5,
      createdAt: new Date(o.createdAtSec * 1000),
    },
  });
}

/** Closed verified M15 bar (synthetic). */
async function seedBar(timeSec: number, o: number, h: number, l: number, c: number): Promise<void> {
  await db.marketCandle.create({
    data: {
      symbol: SYMBOL,
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

const fpOf = (e: EventSeed, strategyVersion = STRAT_V9) =>
  setupFingerprintFromEvidence({
    symbol: SYMBOL,
    timeframe: buildStrategyRules().executionTf,
    strategyVersion,
    evidence: {
      structureEvent: {
        type: e.type,
        direction: e.direction,
        level: e.level,
        breakCandleTimeUtc: new Date(e.breakSec * 1000).toISOString(),
      },
    },
  })!;

beforeEach(async () => {
  await db.paperSignalOutcome.deleteMany();
  await db.signalEvaluation.deleteMany({ where: { symbol: SYMBOL } });
  await db.marketCandle.deleteMany({ where: { symbol: SYMBOL } });
});

// Leave the SHARED test DB pristine for any test file that runs after this
// one (discovery order varies): the D4 cluster (11 evaluations) must never
// leak into another file's isolation assumptions.
afterAll(async () => {
  await db.paperSignalOutcome.deleteMany();
  await db.signalEvaluation.deleteMany({ where: { symbol: SYMBOL } });
  await db.marketCandle.deleteMany({ where: { symbol: SYMBOL } });
});

// ---------------------------------------------------------------------------
// D1 — pure fingerprint determinism, sensitivity, fail-closed identity
// ---------------------------------------------------------------------------

describe('D1 — setup fingerprint determinism & sensitivity (pure)', () => {
  const ev: EventSeed = { type: 'BOS', direction: 'bullish', level: 2650.5, breakSec: T0 };

  test('same identity → identical hash across calls (deterministic)', () => {
    const a = computeSetupFingerprint({ symbol: SYMBOL, timeframe: 'M15', strategyVersion: STRAT_V9, structureEvent: { type: ev.type, direction: ev.direction, level: ev.level, breakCandleTimeUtc: new Date(ev.breakSec * 1000).toISOString() } });
    const b = computeSetupFingerprint({ symbol: SYMBOL, timeframe: 'M15', strategyVersion: STRAT_V9, structureEvent: { type: ev.type, direction: ev.direction, level: ev.level, breakCandleTimeUtc: new Date(ev.breakSec * 1000).toISOString() } });
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // sha256 hex
  });

  test('level change of 1e-9 → different hash (sensitive to the broken level)', () => {
    const base = fpOf(ev);
    const nudged = fpOf({ ...ev, level: ev.level + 1e-9 });
    expect(nudged).not.toBe(base);
  });

  test('different symbol / timeframe / strategyVersion / direction → different hash (S5, S6 pure halves)', () => {
    const base = fpOf(ev);
    expect(fpOf(ev, STRAT_V10)).not.toBe(base); // S6: version change
    expect(
      setupFingerprintFromEvidence({ symbol: 'OTHERm', timeframe: 'M15', strategyVersion: STRAT_V9, evidence: { structureEvent: { type: ev.type, direction: ev.direction, level: ev.level, breakCandleTimeUtc: new Date(ev.breakSec * 1000).toISOString() } } }),
    ).not.toBe(base);
    expect(
      setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: 'M5', strategyVersion: STRAT_V9, evidence: { structureEvent: { type: ev.type, direction: ev.direction, level: ev.level, breakCandleTimeUtc: new Date(ev.breakSec * 1000).toISOString() } } }),
    ).not.toBe(base);
    expect(fpOf({ ...ev, direction: 'bearish' })).not.toBe(base); // S5: BUY vs SELL
  });

  test('new break event (new setup after invalidation — S4 pure half) → different hash', () => {
    const base = fpOf(ev);
    expect(fpOf({ ...ev, breakSec: ev.breakSec + M15 })).not.toBe(base); // new break candle
    expect(fpOf({ ...ev, level: 2638 })).not.toBe(base); // new broken level
  });

  test('incomplete identity → null, never guessed (fail-closed)', () => {
    for (const omit of ['type', 'direction', 'level', 'breakCandleTimeUtc'] as const) {
      const partial: Record<string, unknown> = { type: ev.type, direction: ev.direction, level: ev.level, breakCandleTimeUtc: new Date(ev.breakSec * 1000).toISOString() };
      delete partial[omit === 'breakCandleTimeUtc' ? 'breakCandleTimeUtc' : omit];
      expect(
        setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: 'M15', strategyVersion: STRAT_V9, evidence: { structureEvent: partial } }),
      ).toBeNull();
    }
    expect(setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: 'M15', strategyVersion: STRAT_V9, evidence: null })).toBeNull();
    expect(setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: 'M15', strategyVersion: STRAT_V9, evidence: {} })).toBeNull();
    // non-finite / wrongly-typed level → null
    expect(
      setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: 'M15', strategyVersion: STRAT_V9, evidence: { structureEvent: { type: ev.type, direction: ev.direction, level: Number.NaN, breakCandleTimeUtc: new Date(ev.breakSec * 1000).toISOString() } } }),
    ).toBeNull();
    expect(
      setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: 'M15', strategyVersion: STRAT_V9, evidence: { structureEvent: { type: ev.type, direction: ev.direction, level: '2650.5', breakCandleTimeUtc: new Date(ev.breakSec * 1000).toISOString() } } }),
    ).toBeNull();
  });

  test('identity version is namespaced in the module contract', () => {
    expect(SETUP_IDENTITY_VERSION).toBe('setup-identity/1');
  });
});

// ---------------------------------------------------------------------------
// S1 — same setup, same decision candle, repeated evaluation
// ---------------------------------------------------------------------------

describe('S1 — same setup, same decision candle, repeated evaluation', () => {
  test('second evaluation is suppressed; the row keeps the FIRST emission\'s geometry', async () => {
    const evA: EventSeed = { type: 'BOS', direction: 'bullish', level: 2650.5, breakSec: T0 };
    // Live-pipeline order: the tracker runs after EVERY evaluation → E1 owns the row.
    await seedSetupEval({ id: 's1-e1', event: evA, side: 'BUY', decisionSec: X, createdAtSec: T0 + 1860, entryReference: 2650, stopLoss: 2640, target: 2670 });
    const first = await track();
    expect(first.newlyOpened).toBe(1);
    expect(first.errors).toEqual([]);

    // Same setup, SAME decision candle, later evaluation instant, slightly
    // different quote (entryReference 2650.7) — must NOT create a second row.
    await seedSetupEval({ id: 's1-e2', event: evA, side: 'BUY', decisionSec: X, createdAtSec: T0 + 2100, entryReference: 2650.7, stopLoss: 2640, target: 2670 });
    const second = await track();
    expect(second.newlyOpened).toBe(0);
    expect(second.duplicatesSuppressed).toBe(1);
    expect(second.errors).toEqual([]);

    const rows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL } });
    expect(rows).toHaveLength(1);
    expect(rows[0].signalEvaluationId).toBe('s1-e1'); // owner = first emission
    expect(rows[0].entryReference).toBe(2650); // E1's geometry frozen — E2's 2650.7 ignored
    expect(rows[0].setupFingerprint).toBe(fpOf(evA));
    expect(rows[0].status).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// S2 — concurrent evaluation of the same setup + unique-constraint scope
// ---------------------------------------------------------------------------

describe('S2 — concurrent evaluation race + unique-constraint scope proof', () => {
  test('two concurrent tracker passes over the same setup → exactly ONE row', async () => {
    const evS2: EventSeed = { type: 'BOS', direction: 'bullish', level: 2711.25, breakSec: T0 };
    await seedSetupEval({ id: 's2-e1', event: evS2, side: 'BUY', decisionSec: X, createdAtSec: T0 + 1860, entryReference: 2650, stopLoss: 2640, target: 2670 });
    await seedSetupEval({ id: 's2-e2', event: evS2, side: 'BUY', decisionSec: X, createdAtSec: T0 + 2100, entryReference: 2650, stopLoss: 2640, target: 2670 });
    const [r1, r2] = await Promise.all([track(), track()]);
    const rows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL } });
    expect(rows).toHaveLength(1); // the DB constraint makes 2 rows impossible
    expect(r1.errors).toEqual([]);
    expect(r2.errors).toEqual([]);
    expect(r1.duplicatesSuppressed + r2.duplicatesSuppressed).toBeGreaterThanOrEqual(1);
    expect(rows[0].setupFingerprint).toBe(fpOf(evS2));
  });

  test('constraint scope: one row per fingerprint value — any evaluation id, any status, ever', async () => {
    const base = {
      symbol: SYMBOL, direction: 'BUY' as const,
      signalCreatedAtUtc: new Date(NOW()), decisionCandleTimeUtc: new Date(X * 1000),
      setupKnownAtUtc: new Date(X * 1000), expiryUtc: new Date((X + 12 * M15) * 1000),
      inputFingerprint: 'probe', sourceCandleRange: '{}',
      entryReference: 2650, stopLoss: 2640, target: 2670, invalidationLevel: 2645,
      status: 'open', modeledCostsPrice: 0.3,
    };
    await db.paperSignalOutcome.create({ data: { ...base, signalEvaluationId: 'probe-a', setupFingerprint: 'fp-s2-probe' } });
    // (a) while OPEN a second row for the same fingerprint is impossible
    try {
      await db.paperSignalOutcome.create({ data: { ...base, signalEvaluationId: 'probe-b', setupFingerprint: 'fp-s2-probe' } });
      expect.unreachable('duplicate accepted while open');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('P2002');
    }
    // (b) after RESOLUTION it stays impossible (ever-semantics)
    await db.paperSignalOutcome.update({
      where: { signalEvaluationId: 'probe-a' },
      data: { status: 'resolved', outcome: 'stopped', resolvedAtUtc: new Date(NOW()), exitPrice: 2640, netPnlPrice: -10.3, rMultiple: -0.86 },
    });
    try {
      await db.paperSignalOutcome.create({ data: { ...base, signalEvaluationId: 'probe-c', setupFingerprint: 'fp-s2-probe' } });
      expect.unreachable('duplicate accepted after resolution');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('P2002');
    }
    // (c) a DIFFERENT fingerprint (a genuinely new setup) is allowed
    await db.paperSignalOutcome.create({ data: { ...base, signalEvaluationId: 'probe-d', setupFingerprint: 'fp-other-probe' } });
    const count = await db.paperSignalOutcome.count({ where: { setupFingerprint: { in: ['fp-s2-probe', 'fp-other-probe'] } } });
    expect(count).toBe(2); // one per value — per-value scope proven
    await db.paperSignalOutcome.deleteMany({ where: { signalEvaluationId: { in: ['probe-a', 'probe-d'] } } });
    expect(await db.paperSignalOutcome.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S3 — same setup on a NEW decision candle, still active
// ---------------------------------------------------------------------------

describe('S3 — same setup, new decision candle, still active', () => {
  test('identity is stable across decision candles; one row advances with its OWN walk anchor', async () => {
    const evS3: EventSeed = { type: 'CHoCH', direction: 'bullish', level: 2660.75, breakSec: T0 };
    // Pure identity assert: same event, different decision candle → same hash.
    const fpE1 = fpOf(evS3);
    // E1 on decision candle X
    await seedSetupEval({ id: 's3-e1', event: evS3, side: 'BUY', decisionSec: X, createdAtSec: T0 + 1860, entryReference: 2650, stopLoss: 2640, target: 2670 });
    const first = await track();
    expect(first.newlyOpened).toBe(1);
    const row1 = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 's3-e1' } });
    expect(row1?.decisionCandleTimeUtc).toEqual(new Date(X * 1000));

    // One bar after X but AT Y's open time (candleTimeUtc === Y): a walk
    // anchored at X includes it; a (wrong) walk anchored at Y would exclude it.
    await seedBar(Y, 2662, 2668, 2655, 2665); // close 2665 ≥ invalidation 2660.75, no SL/TP hit — row stays open

    // E2: the SAME setup, re-evaluated on the NEW decision candle Y.
    await seedSetupEval({ id: 's3-e2', event: evS3, side: 'BUY', decisionSec: Y, createdAtSec: T0 + 2760, entryReference: 2650, stopLoss: 2640, target: 2670 });
    // Identity stability: same evidence identity on both rows → same hash
    const evE2 = await db.signalEvaluation.findUnique({ where: { id: 's3-e2' } });
    const fpE2 = setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: buildStrategyRules().executionTf, strategyVersion: STRAT_V9, evidence: JSON.parse(evE2!.evidence) });
    expect(fpE2).toBe(fpE1);

    const second = await track();
    expect(second.newlyOpened).toBe(0); // still the SAME setup — no second row
    expect(second.duplicatesSuppressed).toBe(1);

    const rows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL } });
    expect(rows).toHaveLength(1);
    expect(rows[0].signalEvaluationId).toBe('s3-e1');
    expect(rows[0].observations).toBe(1); // walk anchored at X (row's own candle) — anchor-drift proof
    expect(rows[0].status).toBe('open');
    expect(rows[0].decisionCandleTimeUtc).toEqual(new Date(X * 1000)); // anchor never moved to Y
  });
});

// ---------------------------------------------------------------------------
// S4 — new valid setup after invalidation (new structure event)
// ---------------------------------------------------------------------------

describe('S4 — new valid setup after invalidation', () => {
  test('a NEW structure event gets its own row; first-open classifies it a repeat while the first is open', async () => {
    const evA: EventSeed = { type: 'BOS', direction: 'bullish', level: 2650.5, breakSec: T0 };
    await seedSetupEval({ id: 's4-a', event: evA, side: 'BUY', decisionSec: X, createdAtSec: T0 + 1860, entryReference: 2650, stopLoss: 2640, target: 2670 });
    await track(); // row A open

    // After A's zone is invalidated the engine needs a NEW break — a new event
    // (different level, different break candle, opposite direction) = new setup.
    const evB: EventSeed = { type: 'CHoCH', direction: 'bearish', level: 2638, breakSec: Y };
    await seedSetupEval({ id: 's4-b', event: evB, side: 'SELL', decisionSec: Y, createdAtSec: T0 + 2760, entryReference: 2645, stopLoss: 2655, target: 2625 });
    const second = await track();
    expect(second.newlyOpened).toBe(1); // the genuine new setup is NOT dropped
    expect(second.duplicatesSuppressed).toBe(0);

    const rows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL }, orderBy: { signalCreatedAtUtc: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].setupFingerprint).toBe(fpOf(evA));
    expect(rows[1].setupFingerprint).toBe(fpOf(evB));
    expect(rows[0].setupFingerprint).not.toBe(rows[1].setupFingerprint);

    // Pre-registered aggregation over both rows (both created ≥ activation):
    // A counted+open, B a repeat while A is open — the one-position model.
    const s = await getForwardPaperStatus(db, SYMBOL, { now: NOW });
    expect(s.progress.eligibleRows).toBe(2);
    expect(s.progress.openCounted).toBe(1);
    expect(s.progress.repeatObservations).toBe(1);
    expect(s.progress.countedCompleted).toBe(0);
    expect(s.verdict.conclusion).toBe('IN_PROGRESS');
  });
});

// ---------------------------------------------------------------------------
// S6 — strategy version change (DB half; pure half in D1)
// ---------------------------------------------------------------------------

describe('S6 — strategy version change separates setup identity', () => {
  test('the same event under a new strategyVersion gets its own paper row', async () => {
    const evS6: EventSeed = { type: 'BOS', direction: 'bullish', level: 2725.5, breakSec: T0 };
    await seedSetupEval({ id: 's6-e1', event: evS6, side: 'BUY', decisionSec: X, createdAtSec: T0 + 1860, entryReference: 2650, stopLoss: 2640, target: 2670 });
    await seedSetupEval({ id: 's6-e2', event: evS6, side: 'BUY', decisionSec: X, createdAtSec: T0 + 2100, entryReference: 2650, stopLoss: 2640, target: 2670, strategyVersion: STRAT_V10 });
    const out = await track();
    expect(out.newlyOpened).toBe(2); // different identity → both get rows
    expect(out.duplicatesSuppressed).toBe(0);
    const rows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.signalEvaluationId === 's6-e1')?.setupFingerprint).toBe(fpOf(evS6, STRAT_V9));
    expect(rows.find((r) => r.signalEvaluationId === 's6-e2')?.setupFingerprint).toBe(fpOf(evS6, STRAT_V10));
    expect(rows[0].setupFingerprint).not.toBe(rows[1].setupFingerprint);
  });
});

// ---------------------------------------------------------------------------
// S7 — restart/recovery + resolved immutability
// ---------------------------------------------------------------------------

describe('S7 — restart/recovery duplicate protection + resolved immutability', () => {
  test('a fresh tracker pass (all state from the DB) never duplicates; a re-emission after resolution never mutates', async () => {
    const evS7: EventSeed = { type: 'BOS', direction: 'bullish', level: 2733.5, breakSec: T0 };
    await seedSetupEval({ id: 's7-e1', event: evS7, side: 'BUY', decisionSec: X, createdAtSec: T0 + 1860, entryReference: 2650, stopLoss: 2640, target: 2670 });
    await track(); // row created

    // ── "restart": a brand-new pass with NO in-memory state. The fingerprint
    // must be recovered from the DB alone.
    const restart = await track();
    expect(restart.newlyOpened).toBe(0); // the evaluationId lookup protects with NO create attempt
    expect(restart.duplicatesSuppressed).toBe(0); // (P2002 is exercised below by the s7-e4 re-emission)
    expect(await db.paperSignalOutcome.count()).toBe(1);

    // Persisted-vs-recomputed consistency across the restart: the row's stored
    // fingerprint equals a fresh computation from the evaluation's evidence.
    const row = await db.paperSignalOutcome.findFirst({ where: { symbol: SYMBOL } });
    const evRow = await db.signalEvaluation.findUnique({ where: { id: 's7-e1' } });
    expect(row?.setupFingerprint).toBe(
      setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: buildStrategyRules().executionTf, strategyVersion: STRAT_V9, evidence: JSON.parse(evRow!.evidence) }),
    );

    // Resolve the row: an SL-touch bar after X.
    await seedBar(T0 + 3600, 2650, 2652, 2639, 2644);
    await track();
    const resolved = await db.paperSignalOutcome.findFirst({ where: { symbol: SYMBOL } });
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.outcome).toBe('stopped');
    const resolvedAt = resolved?.resolvedAtUtc?.toISOString();

    // Re-emission of the SAME setup AFTER resolution (the engine can legitimately
    // re-emit a still-valid event): no second row, no mutation of the resolved row.
    await seedSetupEval({ id: 's7-e4', event: evS7, side: 'BUY', decisionSec: T0 + 4500, createdAtSec: T0 + 4560, entryReference: 2650, stopLoss: 2640, target: 2670 });
    const after = await track();
    expect(after.newlyOpened).toBe(0);
    expect(after.duplicatesSuppressed).toBe(1); // only the s7-e4 create attempt hit P2002
    expect(after.skippedResolved).toBe(2); // s7-e1's resolved row skipped at the top + s7-e4's P2002-found resolved row
    const rows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL } });
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('stopped');
    expect(rows[0].resolvedAtUtc?.toISOString()).toBe(resolvedAt); // immutable — not re-stamped
    expect(rows[0].observations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// S8 — legacy rows + pre-registered aggregation unchanged
// ---------------------------------------------------------------------------

describe('S8 — legacy rows keep the per-evaluation path; aggregation unchanged', () => {
  test('a NULL-fingerprint legacy paper row advances by evaluationId and is never backfilled', async () => {
    const evS8: EventSeed = { type: 'BOS', direction: 'bullish', level: 2744.5, breakSec: T0 };
    await seedSetupEval({ id: 's8-legacy-eval', event: evS8, side: 'BUY', decisionSec: X, createdAtSec: T0 + 1860, entryReference: 2650, stopLoss: 2640, target: 2670 });
    // Seed the paper row DIRECTLY with a NULL fingerprint (pre-10.3-A shape).
    await db.paperSignalOutcome.create({
      data: {
        signalEvaluationId: 's8-legacy-eval', symbol: SYMBOL, direction: 'BUY',
        signalCreatedAtUtc: new Date((T0 + 1860) * 1000),
        decisionCandleTimeUtc: new Date(X * 1000), setupKnownAtUtc: new Date((X + M15) * 1000),
        expiryUtc: new Date((X + 12 * M15) * 1000),
        inputFingerprint: 'legacy-fp', setupFingerprint: null, sourceCandleRange: '{}',
        entryReference: 2650, stopLoss: 2640, target: 2670, invalidationLevel: 2645,
        status: 'open', modeledCostsPrice: 0.3,
      },
    });
    await seedBar(T0 + 1800 + M15, 2652, 2658, 2650, 2655); // one observable bar (no hit vs 2645)
    const out = await track();
    expect(out.newlyOpened).toBe(0); // the legacy row is found by evaluationId
    expect(out.duplicatesSuppressed).toBe(0); // no fingerprint path needed
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 's8-legacy-eval' } });
    expect(row?.setupFingerprint).toBeNull(); // never backfilled, never rewritten
    expect(row?.observations).toBe(1); // advanced on the per-evaluation path
    expect(row?.status).toBe('open');
    expect(await db.paperSignalOutcome.count()).toBe(1); // no duplicate appeared
  });

  test('pre-registered first-open/metrics/verdict unchanged over mixed rows', async () => {
    const evA: EventSeed = { type: 'BOS', direction: 'bullish', level: 2755.5, breakSec: T0 };
    const evB: EventSeed = { type: 'CHoCH', direction: 'bearish', level: 2638, breakSec: Y };
    // Counted trade 1 (resolved, stopped) + a repeat while open + a later new
    // counted trade after the first resolved — mirrors the protocol test suite.
    await seedSetupEval({ id: 's8-a', event: evA, side: 'BUY', decisionSec: X, createdAtSec: T0 + 1860, entryReference: 2650, stopLoss: 2640, target: 2670 });
    await seedBar(T0 + 3600, 2650, 2652, 2639, 2644); // SL touch → row A resolves stopped
    await track();
    // Repeat of A while... A resolved already; use a NEW event B after A resolved:
    await seedSetupEval({ id: 's8-b', event: evB, side: 'SELL', decisionSec: T0 + 4500, createdAtSec: T0 + 4560, entryReference: 2645, stopLoss: 2655, target: 2625 });
    await track();
    // Another repeat evaluation of B (same setup, later candle) — suppressed:
    await seedSetupEval({ id: 's8-b2', event: evB, side: 'SELL', decisionSec: T0 + 5400, createdAtSec: T0 + 5460, entryReference: 2645, stopLoss: 2655, target: 2625 });
    await track();

    const s = await getForwardPaperStatus(db, SYMBOL, { now: NOW });
    expect(s.progress.eligibleRows).toBe(2); // one row per logical setup — no duplicates
    expect(s.progress.countedCompleted).toBe(1); // A completed; B still open
    expect(s.progress.openCounted).toBe(1);
    expect(s.progress.repeatObservations).toBe(0); // same-setup repeats are never even rows now
    expect(s.metrics?.trades).toBe(1);
    expect(s.metrics?.netPnlPrice).toBeCloseTo(-10.28, 4);
    expect(s.metrics?.maxConsecutiveLosses).toBe(1);
    expect(s.verdict.conclusion).toBe('IN_PROGRESS'); // 1 < 20 floor — no claim
    expect(s.verdict.reasons.join(' ')).toContain('No performance claim');

    // The pure pre-registered functions over the same row set stay consistent:
    const rows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL } });
    const inputs = rows.map((r) => ({
      id: r.id, direction: r.direction, signalCreatedAtMs: r.signalCreatedAtUtc.getTime(),
      status: r.status, outcome: r.outcome, netPnlPrice: r.netPnlPrice, rMultiple: r.rMultiple,
      resolutionBarTimeMs: r.resolutionBarTimeUtc?.getTime() ?? null, resolvedAtMs: r.resolvedAtUtc?.getTime() ?? null,
    }));
    const { counted, repeats } = applyFirstOpenRule(inputs);
    expect(counted).toHaveLength(2);
    expect(repeats).toHaveLength(0);
    const metrics = computeForwardPaperMetrics(counted);
    expect(metrics?.netPnlPrice).toBe(s.metrics?.netPnlPrice);
    const verdict = evaluateForwardPaperVerdict({ countedCompleted: 1, openCounted: 1, repeatObservations: 0, unobservableResolved: 0, metrics, nowMs: NOW() });
    expect(verdict.conclusion).toBe(s.verdict.conclusion);
    expect(verdict.rulesVersion).toBe(s.protocol.rulesVersion);
  });
});

// ---------------------------------------------------------------------------
// D2 — persisted vs recomputed consistency (saveSignalEvaluation path)
// ---------------------------------------------------------------------------

describe('D2 — persistence writes the same fingerprint the tracker recomputes', () => {
  test('SETUP evaluation row gets a fingerprint identical to a fresh recomputation', async () => {
    const evaluation = {
      engineVersion: '9.0.0',
      strategyVersion: STRAT_V9,
      symbol: SYMBOL,
      purpose: 'research-signal-not-an-execution-instruction' as const,
      outcome: 'BUY_SETUP' as const,
      reasonCodes: [],
      decisionCandleTimeUtc: new Date(X * 1000).toISOString(),
      setupKnownAtUtc: new Date((X + M15) * 1000).toISOString(),
      expiryUtc: new Date((X + 12 * M15) * 1000).toISOString(),
      levels: { direction: 'BUY' as const, entryZoneLow: 2649, entryZoneHigh: 2651, entryReference: 2650, stopLoss: 2640, target: 2670, riskPrice: 10, rewardPrice: 20, rewardRiskRatio: 2, entryZoneLowText: '2649', entryZoneHighText: '2651', stopLossText: '2640', targetText: '2670', entryReferenceText: '2650' },
      evidence: {
        structureEvent: { type: 'BOS' as const, direction: 'bullish' as const, level: 2650.5, levelText: '2650.5', breakCandleTimeUtc: new Date(T0 * 1000).toISOString(), barsSinceBreak: 2 },
        anchorSwing: null, indicators: { ema50: 50, rsi14: 60, atr14: 2, adx14: 20 }, htfContext: { h1Trend: 'unclear' as const, h4Trend: 'unclear' as const },
        decisionClose: 2650, retestBarTimeUtc: null,
        executionWindow: { fromUtc: new Date(T0 * 1000).toISOString(), toUtc: new Date(X * 1000).toISOString(), bars: 300 },
        h1Window: { fromUtc: new Date(T0 * 1000).toISOString(), toUtc: new Date(T0 * 1000).toISOString(), bars: 300 },
        h4Window: { fromUtc: new Date(T0 * 1000).toISOString(), toUtc: new Date(T0 * 1000).toISOString(), bars: 300 },
      },
      inputFingerprint: 'fp-d2',
      datasetFingerprint: 'dfp-d2',
      generatedAtUtc: new Date(NOW()).toISOString(),
    };
    const saved = await saveSignalEvaluation(db, {
      evaluation, quote: {}, durationMs: 5, startedAtUtc: new Date(NOW()), executionTimeframe: 'M15',
      // Phase 10.3-D (fixture update, disclosed): the ACTUAL rules + verified
      // digits now persist as a rules snapshot inside inputSnapshot.
      rules: buildStrategyRules(), digits: 3,
    });
    const row = await db.signalEvaluation.findUnique({ where: { id: saved.id } });
    const recomputed = setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: 'M15', strategyVersion: STRAT_V9, evidence: JSON.parse(row!.evidence) });
    expect(row?.setupFingerprint ?? null).toBe(recomputed);
    expect(row?.setupFingerprint ?? null).toBe(
      computeSetupFingerprint({ symbol: SYMBOL, timeframe: 'M15', strategyVersion: STRAT_V9, structureEvent: { type: 'BOS', direction: 'bullish', level: 2650.5, breakCandleTimeUtc: new Date(T0 * 1000).toISOString() } }),
    );
    // The tracker agrees with the persisted column (they dedupe consistently):
    const evRow = await db.signalEvaluation.findUnique({ where: { id: saved.id } });
    expect(setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: buildStrategyRules().executionTf, strategyVersion: evRow!.strategyVersion, evidence: JSON.parse(evRow!.evidence) })).toBe(row?.setupFingerprint ?? null);
    await db.signalEvaluation.delete({ where: { id: saved.id } });
  });

  test('a NO_STRUCTURE_BREAK row (no event) persists a NULL fingerprint — honest absence', async () => {
    const evaluation = {
      engineVersion: '9.0.0', strategyVersion: STRAT_V9, symbol: SYMBOL,
      purpose: 'research-signal-not-an-execution-instruction' as const,
      outcome: 'NO_SETUP' as const, reasonCodes: ['NO_STRUCTURE_BREAK'] as SignalReasonCode[],
      decisionCandleTimeUtc: new Date(X * 1000).toISOString(),
      setupKnownAtUtc: new Date((X + M15) * 1000).toISOString(),
      expiryUtc: null, levels: null,
      evidence: { structureEvent: null, anchorSwing: null, indicators: { ema50: 50, rsi14: 60, atr14: 2, adx14: 20 }, htfContext: { h1Trend: 'unclear' as const, h4Trend: 'unclear' as const }, decisionClose: 2650, retestBarTimeUtc: null, executionWindow: { fromUtc: new Date(T0 * 1000).toISOString(), toUtc: new Date(X * 1000).toISOString(), bars: 300 }, h1Window: { fromUtc: new Date(T0 * 1000).toISOString(), toUtc: new Date(T0 * 1000).toISOString(), bars: 300 }, h4Window: { fromUtc: new Date(T0 * 1000).toISOString(), toUtc: new Date(T0 * 1000).toISOString(), bars: 300 } },
      inputFingerprint: 'fp-d2b', datasetFingerprint: null, generatedAtUtc: new Date(NOW()).toISOString(),
    };
    const saved = await saveSignalEvaluation(db, {
      evaluation, quote: {}, durationMs: 5, startedAtUtc: new Date(NOW()), executionTimeframe: 'M15',
      rules: buildStrategyRules(), digits: 3, // Phase 10.3-D fixture update (disclosed)
    });
    const row = await db.signalEvaluation.findUnique({ where: { id: saved.id } });
    expect(row?.setupFingerprint ?? null).toBeNull();
    await db.signalEvaluation.delete({ where: { id: saved.id } });
  });
});

// ---------------------------------------------------------------------------
// D3 — fail-closed: unidentifiable setup
// ---------------------------------------------------------------------------

describe('D3 — unidentifiable setup → no paper row (fail-closed)', () => {
  test('incomplete structure-event identity → error recorded, row never created', async () => {
    const evD3: EventSeed = { type: 'BOS', direction: 'bullish', level: 2766.5, breakSec: T0 };
    await seedSetupEval({ id: 'd3-broken', event: evD3, side: 'BUY', decisionSec: X, createdAtSec: T0 + 1860, entryReference: 2650, stopLoss: 2640, target: 2670, omit: 'breakCandleTimeUtc' });
    const out = await track();
    expect(out.newlyOpened).toBe(0);
    expect(out.duplicatesSuppressed).toBe(0);
    expect(out.errors.some((e) => e.includes('unidentifiable setup'))).toBe(true);
    expect(await db.paperSignalOutcome.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D4 — BEFORE/AFTER comparison on the SAME persisted dataset
// ---------------------------------------------------------------------------

describe('D4 — before/after deduplication comparison (same persisted dataset)', () => {
  test('11 evaluations of one setup (the live-cluster shape): 11 rows → 1 row; identical verdict inputs', async () => {
    const evD4: EventSeed = { type: 'BOS', direction: 'bullish', level: 2777.5, breakSec: T0 };
    // 6 evaluations on decision candle X + 5 on decision candle Y — the exact
    // shape of the live 2026-10-15 cluster (multiple instants per candle,
    // multiple candles per setup). Identical geometry across the cluster:
    // isolates the row-count effect from quote noise.
    const cluster: Array<{ id: string; decisionSec: number; createdAtSec: number }> = [];
    let n = 0;
    for (let i = 0; i < 6; i++) { const id = `d4-e${++n}`; cluster.push({ id, decisionSec: X, createdAtSec: T0 + 1860 + i * 40 }); }
    for (let i = 0; i < 5; i++) { const id = `d4-e${++n}`; cluster.push({ id, decisionSec: Y, createdAtSec: T0 + 2760 + i * 40 }); }
    for (const c of cluster) {
      await seedSetupEval({ id: c.id, event: evD4, side: 'BUY', decisionSec: c.decisionSec, createdAtSec: c.createdAtSec, entryReference: 2650, stopLoss: 2640, target: 2670 });
    }
    // The resolution bar (SL touch) — the single pass processes all 11 rows:
    await seedBar(T0 + 3600, 2650, 2652, 2639, 2644);

    const out = await track();
    expect(out.newlyOpened).toBe(1);
    expect(out.duplicatesSuppressed).toBe(10);

    // ── AFTER: the actual DB state (what Phase 10.3-A persists) ──────────
    const afterRows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL } });
    expect(afterRows).toHaveLength(1); // 11 raw evaluations → 1 deduped setup row
    expect(afterRows[0].status).toBe('resolved');
    expect(afterRows[0].outcome).toBe('stopped');
    const afterStatus = await getForwardPaperStatus(db, SYMBOL, { now: NOW });
    expect(afterStatus.progress.eligibleRows).toBe(1);
    expect(afterStatus.progress.countedCompleted).toBe(1);
    expect(afterStatus.progress.repeatObservations).toBe(0);
    expect(afterStatus.metrics?.trades).toBe(1);
    expect(afterStatus.metrics?.netPnlPrice).toBeCloseTo(-10.28, 4); // 2640−2650−0.28
    expect(afterStatus.metrics?.avgR).toBeCloseTo(-10.28 / 10, 6); // risk = 2650-2640 = 10 (geometry recomputed)

    // ── BEFORE (simulated): the pre-10.3-A per-evaluation algorithm would have
    // persisted ONE ROW PER EVALUATION (audit F3's documented behavior). The
    // pure pre-registered aggregation runs over that row set unchanged.
    const simulatedBefore = cluster.map((c) => ({
      id: c.id,
      direction: 'BUY',
      signalCreatedAtMs: c.createdAtSec * 1000,
      status: 'resolved',
      outcome: 'stopped',
      netPnlPrice: -10.28,
      rMultiple: -10.28 / 10,
      resolutionBarTimeMs: (T0 + 3600) * 1000, // every walk resolves at the same SL bar
      resolvedAtMs: (T0 + 4500) * 1000,
    }));
    const before = applyFirstOpenRule(simulatedBefore);
    expect(before.counted).toHaveLength(1); // identical counted trade…
    expect(before.repeats).toHaveLength(10); // …and 10 disclosed repeat observations
    const beforeMetrics = computeForwardPaperMetrics(before.counted);
    expect(beforeMetrics?.trades).toBe(afterStatus.metrics?.trades);
    expect(beforeMetrics?.netPnlPrice).toBeCloseTo(afterStatus.metrics?.netPnlPrice ?? 0, 4);
    expect(beforeMetrics?.avgR).toBeCloseTo(afterStatus.metrics?.avgR ?? 0, 6);
    expect(beforeMetrics?.maxDrawdownR).toBe(afterStatus.metrics?.maxDrawdownR);
    const beforeVerdict = evaluateForwardPaperVerdict({
      countedCompleted: beforeMetrics ? 1 : 0,
      openCounted: 0,
      repeatObservations: before.repeats.length,
      unobservableResolved: 0,
      metrics: beforeMetrics,
      nowMs: NOW(),
    });
    expect(beforeVerdict.conclusion).toBe(afterStatus.verdict.conclusion); // IN_PROGRESS both
    expect(beforeVerdict.rulesVersion).toBe(afterStatus.verdict.rulesVersion);
    // The difference in VERDICT INPUTS is exactly the repeat disclosure:
    // countedCompleted 1 = 1, metrics identical; repeatObservations 10 → 0.
    expect(before.repeats.length).toBe(10);
    expect(afterStatus.progress.repeatObservations).toBe(0);
  });
});
