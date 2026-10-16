/**
 * PHASE 10.3-B — PAPER-WALK CHRONOLOGY & LOOK-AHEAD PREVENTION TESTS.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic SignalEvaluation rows + synthetic candles on the
 * ISOLATED TEST DATABASE — never real broker data.
 *
 * Written TEST-FIRST (before the Phase 10.3-B implementation): every test in
 * this file that exercises the creation-time bound FAILS against the Phase
 * 10.3-A walker (it walks pre-creation bars) and must pass after.
 *
 * The Temporal Invariant under test (audit/phase10.3b-paper-walk-chronology.md §2):
 *   · a bar may contribute ONLY IF close > signalCreatedAtUtc   (publication)
 *   ·                     AND  open  < expiryUtc                (expiry window)
 *   ·                     AND  close <= nowUtcSec               (availability)
 *   · ambiguous timestamps / unordered bars / corrupt anchors → FAIL-CLOSED
 *     (row error, no advance, never a resolution on ambiguous data)
 *   · gaps (absent bars) are honest non-observations, never errors
 *
 * Scenario numbering T1..T10 mirrors the user's Phase 10.3-B test list.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { db } from '@/lib/db';
import { resolvePaperOutcome, trackPaperSignals } from '@/lib/signal/paper';
import { applyFirstOpenRule, type ForwardPaperRowInput } from '@/lib/signal/paper-protocol';
import { FIXED_NOW_SEC } from '../market/helpers/setup';

const M15 = 900;

// ---------------------------------------------------------------------------
// Fixtures (synthetic; unique ids/decision times per test → distinct setup
// identities under the Phase 10.3-A fingerprint)
// ---------------------------------------------------------------------------

interface SeedOpts {
  id: string;
  direction?: 'BUY' | 'SELL';
  decisionSec: number;
  /** REQUIRED since 10.3-B: creation instant (normal cadence: decision close
   *  + ~300 s, mirroring the 300 s scheduler; lag scenarios: later). */
  createdAtSec: number;
  entryReference?: number;
  stopLoss?: number;
  target?: number;
  /** Structure-event level = invalidation level. Kept BELOW the SL so the
   *  no-hit fixtures are never invalidated by it, and UNIQUE per test — the
   *  Phase 10.3-A fingerprint includes it, so unique levels guarantee the
   *  synthetic setups never collide with each other nor with the fixtures in
   *  paper.test.ts / setup-identity.test.ts (shared isolated test DB). */
  invalidationLevel: number;
  /** Corruption injection: persist an inconsistent anchor (≠ decision+900). */
  setupKnownAtOverrideSec?: number;
  expiryBars?: number;
}

const DEFAULTS = { entryReference: 2650, stopLoss: 2640, target: 2670 };

async function seedSetup(o: SeedOpts): Promise<void> {
  const dir = o.direction ?? 'BUY';
  const lv = {
    entryReference: o.entryReference ?? DEFAULTS.entryReference,
    stopLoss: o.stopLoss ?? DEFAULTS.stopLoss,
    target: o.target ?? DEFAULTS.target,
    invalidationLevel: o.invalidationLevel,
  };
  const knownSec = o.setupKnownAtOverrideSec ?? o.decisionSec + M15;
  const expirySec = o.decisionSec + M15 + (o.expiryBars ?? 12) * M15;
  const risk = dir === 'BUY' ? lv.entryReference - lv.stopLoss : lv.stopLoss - lv.entryReference;
  await db.signalEvaluation.create({
    data: {
      id: o.id,
      engineVersion: '9.0.0',
      strategyVersion: 'hybrid-structure-retest/9.0.0',
      symbol: 'XAUUSDm',
      outcome: dir === 'BUY' ? 'BUY_SETUP' : 'SELL_SETUP',
      reasonCodes: '[]',
      inputFingerprint: `fp-${o.id}`,
      datasetFingerprint: `dfp-${o.id}`,
      inputSnapshot: '{}',
      evidence: JSON.stringify({
        structureEvent: {
          type: 'BOS',
          direction: dir === 'BUY' ? 'bullish' : 'bearish',
          level: lv.invalidationLevel,
          levelText: String(lv.invalidationLevel),
          breakCandleTimeUtc: new Date((o.decisionSec - 2 * M15) * 1000).toISOString(),
          barsSinceBreak: 2,
        },
        executionWindow: { fromUtc: new Date((o.decisionSec - 300 * M15) * 1000).toISOString(), toUtc: new Date(o.decisionSec * 1000).toISOString(), bars: 300 },
        h1Window: { fromUtc: new Date(o.decisionSec * 1000).toISOString(), toUtc: new Date(o.decisionSec * 1000).toISOString(), bars: 300 },
        h4Window: { fromUtc: new Date(o.decisionSec * 1000).toISOString(), toUtc: new Date(o.decisionSec * 1000).toISOString(), bars: 300 },
      }),
      levels: JSON.stringify({
        direction: dir,
        entryZoneLow: lv.invalidationLevel,
        entryZoneHigh: lv.invalidationLevel + 1,
        entryReference: lv.entryReference,
        stopLoss: lv.stopLoss,
        target: lv.target,
        riskPrice: risk,
        rewardPrice: Math.abs(lv.target - lv.entryReference),
        rewardRiskRatio: 2,
        entryZoneLowText: String(lv.invalidationLevel),
        entryZoneHighText: String(lv.invalidationLevel + 1),
        stopLossText: String(lv.stopLoss),
        targetText: String(lv.target),
        entryReferenceText: String(lv.entryReference),
      }),
      decisionCandleTimeUtc: new Date(o.decisionSec * 1000),
      setupKnownAtUtc: new Date(knownSec * 1000),
      expiryUtc: new Date(expirySec * 1000),
      quote: '{}',
      executionLocked: true,
      durationMs: 5,
      createdAt: new Date(o.createdAtSec * 1000),
    },
  });
}

/** Closed verified M15 bar (synthetic). */
async function seedBar(timeSec: number, o: number, h: number, l: number, c: number, receivedAtSec?: number): Promise<void> {
  await db.marketCandle.create({
    data: {
      symbol: 'XAUUSDm',
      timeframe: 'M15',
      candleTimeUtc: new Date(timeSec * 1000),
      open: String(o), high: String(h), low: String(l), close: String(c),
      source: 'bridge-mt5',
      isForming: false,
      validationStatus: 'VALID',
      receivedAtUtc: new Date((receivedAtSec ?? timeSec + M15) * 1000),
    },
  });
}

/** Pre-create a LEGACY paper row (no setupFingerprint — per-evaluation path). */
async function seedLegacyPaperRow(o: {
  evaluationId: string;
  decisionSec: number;
  createdAtSec: number;
  direction?: 'BUY' | 'SELL';
}): Promise<void> {
  const dir = o.direction ?? 'BUY';
  await db.paperSignalOutcome.create({
    data: {
      signalEvaluationId: o.evaluationId,
      symbol: 'XAUUSDm',
      direction: dir,
      signalCreatedAtUtc: new Date(o.createdAtSec * 1000),
      decisionCandleTimeUtc: new Date(o.decisionSec * 1000),
      setupKnownAtUtc: new Date((o.decisionSec + M15) * 1000),
      expiryUtc: new Date((o.decisionSec + 13 * M15) * 1000),
      datasetFingerprint: null,
      inputFingerprint: `fp-${o.evaluationId}`,
      setupFingerprint: null, // legacy row — never backfilled (Phase 10.3-A)
      sourceCandleRange: '{}',
      entryReference: DEFAULTS.entryReference,
      stopLoss: DEFAULTS.stopLoss,
      target: DEFAULTS.target,
      invalidationLevel: 2645,
      status: 'open',
      modeledCostsPrice: 0.28,
      details: '{}',
    },
  });
}

const track = (nowSec: number) => trackPaperSignals(db, { symbol: 'XAUUSDm', now: () => nowSec * 1000 });

// ---------------------------------------------------------------------------
// Pure resolution walk — chronology bounds (synthetic bars)
// ---------------------------------------------------------------------------

const D = FIXED_NOW_SEC - 20 * M15; // decision bar open
/** Normal-cadence creation: decision close (D+900) + 300 s — the scheduler's
 *  realistic publication delay. First walkable bar closes at D+1800 > C. */
const C_NORMAL = D + M15 + 300;

function bar(k: number, o: number, h: number, l: number, c: number) {
  return { timeUtcSec: D + k * M15, open: o, high: h, low: l, close: c };
}

describe('T1 — bars closing before signal creation are NEVER walked (pure)', () => {
  test('pre-creation SL bar excluded → later TP bar decides (lag scenario)', () => {
    // creation after bar1 closed (bar1 closes D+1800 ≤ C): OLD walker stopped here.
    const created = D + 2 * M15 + 60;
    const bars = [bar(1, 2650, 2652, 2639.5, 2644), // SL touch — PRE-creation, must not count
      bar(2, 2648, 2671, 2647, 2668)];               // TP touch — first post-creation bar
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 13 * M15, FIXED_NOW_SEC, created);
    expect(r.outcome).toBe('targeted');
    expect(r.exitPrice).toBe(2670);
    expect(r.resolutionBarTime).toBe(D + 2 * M15);
    expect(r.observations).toBe(1);
  });

  test('ALL bars pre-creation + expiry passed → expired, exit null (unobservable, never fabricated)', () => {
    const created = D + 5 * M15 + 30;
    const bars = [bar(1, 2650, 2652, 2639.5, 2644), bar(2, 2650, 2652, 2639.5, 2644)];
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 3 * M15, FIXED_NOW_SEC, created);
    expect(r.outcome).toBe('expired');
    expect(r.exitPrice).toBeNull();
    expect(r.observations).toBe(0);
    expect(r.rule).toContain('NO post-signal candles');
  });

  test('normal cadence (creation between decision close and first bar close) → bar1 still walked (no behavior change)', () => {
    const bars = [bar(1, 2650, 2652, 2639.5, 2644)];
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 13 * M15, FIXED_NOW_SEC, C_NORMAL);
    expect(r.outcome).toBe('stopped');
    expect(r.exitPrice).toBe(2640);
    expect(r.observations).toBe(1);
  });
});

describe('T2 — ordering integrity (pure, fail-closed)', () => {
  test('out-of-order bars → throws (never resolves on unreliable ordering)', () => {
    const bars = [bar(2, 2650, 2652, 2649, 2651), bar(1, 2650, 2652, 2649, 2651)];
    expect(() => resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 13 * M15, FIXED_NOW_SEC, C_NORMAL)).toThrow(/chronology/);
  });

  test('duplicate bar timestamps → throws', () => {
    const bars = [bar(1, 2650, 2652, 2649, 2651), bar(1, 2650, 2652, 2649, 2651)];
    expect(() => resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 13 * M15, FIXED_NOW_SEC, C_NORMAL)).toThrow(/chronology/);
  });

  test('timestamp off the M15 UTC grid → throws', () => {
    const bars = [{ timeUtcSec: D + M15 + 37, open: 2650, high: 2652, low: 2649, close: 2651 }];
    expect(() => resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 13 * M15, FIXED_NOW_SEC, C_NORMAL)).toThrow(/chronology/);
  });
});

describe('T3 — first valid candle after creation is selected exactly', () => {
  test('creation mid-first-bar (8 min in) → first bar (closing after creation) is the first walked', () => {
    const created = D + M15 + 480;
    const bars = [bar(1, 2650, 2652, 2639.5, 2644)]; // closes D+1800 > created → walked
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 13 * M15, FIXED_NOW_SEC, created);
    expect(r.outcome).toBe('stopped');
    expect(r.observations).toBe(1);
  });

  test('creation exactly at first bar close → that bar is EXCLUDED (strict >)', () => {
    const created = D + 2 * M15; // == bar1 close instant
    const bars = [bar(1, 2650, 2652, 2639.5, 2644)];
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 13 * M15, D + 3 * M15, created);
    expect(r.outcome).toBe('unresolved'); // expiry not yet passed; bar1 excluded → nothing walked
    expect(r.exitPrice).toBeNull();
    expect(r.observations).toBe(0);
  });

  test('creation 30 s after first bar close → walk starts at bar2', () => {
    const created = D + 2 * M15 + 30;
    const bars = [bar(1, 2650, 2652, 2639.5, 2644), bar(2, 2648, 2671, 2647, 2668)];
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 13 * M15, FIXED_NOW_SEC, created);
    expect(r.outcome).toBe('targeted');
    expect(r.resolutionBarTime).toBe(D + 2 * M15);
    expect(r.observations).toBe(1);
  });
});

describe('T4-availability — a bar cannot be used before it has truly closed', () => {
  test('bar closing after now → skipped even if present', () => {
    const now = D + 2 * M15; // bar2 closes D+2700 > now
    const bars = [bar(1, 2652, 2658, 2650, 2655), bar(2, 2650, 2652, 2639.5, 2644)];
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 13 * M15, now, C_NORMAL);
    expect(r.outcome).toBe('unresolved');
    expect(r.observations).toBe(1); // only bar1
  });

  test('bar closing exactly at now → walked (closed at that instant)', () => {
    const now = D + 2 * M15; // bar1 closes exactly at now
    const bars = [bar(1, 2650, 2652, 2639.5, 2644)];
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, D + 13 * M15, now, C_NORMAL);
    expect(r.outcome).toBe('stopped');
  });
});

describe('T7 — expiry boundary (pure)', () => {
  // window: decision close K=D+900; expiry E=D+13*M15 (12 bars: opens D+900..D+12*M15)
  test('bar OPENING at expiry never walked — cannot stop/target with post-expiry action', () => {
    const E = D + 13 * M15;
    const inWindow = Array.from({ length: 12 }, (_, i) =>
      bar(i + 1, 2650, 2655, 2646, 2652)); // 12 no-hit bars
    const postExpiry = { timeUtcSec: E, open: 2650, high: 2652, low: 2639.5, close: 2644 }; // SL touch, opens AT expiry
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, [...inWindow, postExpiry], E, E + 2 * M15, C_NORMAL);
    expect(r.outcome).toBe('expired'); // NOT stopped — post-expiry bar excluded
    expect(r.exitPrice).toBe(2652);    // exit at the LAST IN-WINDOW close (12th bar)
    expect(r.observations).toBe(12);
  });

  test('12th bar (closing exactly at expiry) IS walked — its range is inside the window', () => {
    const E = D + 13 * M15;
    const bars = [...Array.from({ length: 11 }, (_, i) => bar(i + 1, 2650, 2655, 2646, 2652)),
      bar(12, 2650, 2652, 2639.5, 2644)]; // 12th bar SL touch, closes AT expiry
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, E, E + M15, C_NORMAL);
    expect(r.outcome).toBe('stopped');
    expect(r.resolutionBarTime).toBe(D + 12 * M15);
  });

  test('now < expiry → unresolved even with post-expiry bars present', () => {
    const E = D + 13 * M15;
    const bars = [bar(1, 2652, 2658, 2650, 2655)];
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, E, E - M15, C_NORMAL);
    expect(r.outcome).toBe('unresolved');
  });

  test('now == expiry → expired (>= boundary)', () => {
    const E = D + 13 * M15;
    const bars = [bar(1, 2652, 2658, 2650, 2655)];
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, E, E, C_NORMAL);
    expect(r.outcome).toBe('expired');
    expect(r.exitPrice).toBe(2655);
  });
});

// ---------------------------------------------------------------------------
// DB pipeline — chronology through trackPaperSignals (synthetic rows).
//
// Hermeticity notes (shared isolated test DB — possibly with paper.test.ts /
// setup-identity.test.ts rows when the whole suite runs in one process):
//   · every test uses a PRIVATE decision-time region and unique bar times
//     (never colliding with another test's bars nor with the fixtures in the
//     other signal test files);
//   · every setup carries a UNIQUE structure-event level (fingerprint input);
//   · ALL assertions are ROW-SCOPED (by evaluation id) — pass-level counters
//     (advanced/skippedResolved/errors[]) are never asserted because other
//     tests' rows legitimately appear in the same pass.
// ---------------------------------------------------------------------------

/** Row-scoped helpers: did THIS row error / is it clean in this pass? */
function errorsFor(out: { errors: string[] }, id: string): string[] {
  return out.errors.filter((e) => e.startsWith(`${id}:`));
}

describe('T1/T4 (DB) — F4 end-to-end: lagged evaluation + backfilled pre-creation bars', () => {
  test('pre-creation SL bars (backfilled, receivedAt AFTER creation) never resolve the row', async () => {
    const decision = FIXED_NOW_SEC - 60 * M15; // private region
    const created = decision + 4 * M15 + 60;   // lag: bars 1–3 closed before creation
    await seedSetup({ id: 'chron-lag-f4', decisionSec: decision, createdAtSec: created, invalidationLevel: 2601 });
    // bars 1–3 hit SL but ALL closed before creation (receivedAt AFTER creation
    // — simulating the F4 backfill); bar 4 (post-creation) hits TP.
    await seedBar(decision + M15, 2650, 2652, 2635, 2644, created + 400); // pre-creation, backfilled
    await seedBar(decision + 2 * M15, 2650, 2652, 2636, 2644, created + 400); // pre-creation, backfilled
    await seedBar(decision + 3 * M15, 2650, 2652, 2637, 2644, created + 400); // pre-creation, backfilled
    await seedBar(decision + 4 * M15, 2648, 2671, 2647, 2668); // post-creation → TP

    const out = await track(FIXED_NOW_SEC);
    expect(errorsFor(out, 'chron-lag-f4')).toBeEmpty();
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-lag-f4' } });
    expect(row?.status).toBe('resolved');
    expect(row?.outcome).toBe('targeted'); // NOT stopped — pre-creation bars excluded
    expect(row?.exitPrice).toBe(2670);
    expect(row?.resolutionBarTimeUtc?.getTime()).toBe((decision + 4 * M15) * 1000);
    expect(row?.observations).toBe(1); // only the post-creation bar was observed
    expect(row?.netPnlPrice).toBeCloseTo(19.72, 6);
    // the publication bound is documented on the row itself
    const details = JSON.parse(row?.details ?? '{}') as { signalCreatedUtcSec?: number };
    expect(details.signalCreatedUtcSec).toBe(created);
  });
});

describe('T2 (DB) — decision candle is never part of the walk', () => {
  test('a candle AT the decision time (SL touch) does not resolve the row', async () => {
    const decision = FIXED_NOW_SEC - 80 * M15;
    await seedSetup({ id: 'chron-decision-bar', decisionSec: decision, createdAtSec: decision + M15 + 300, invalidationLevel: 2602 });
    await seedBar(decision, 2650, 2652, 2639.5, 2644); // THE decision bar — never walkable
    await seedBar(decision + M15, 2652, 2658, 2650, 2655); // first walkable, no hit
    // private track clock BEFORE the row's expiry (deep-past decision → the
    // row must stay open here, not expire in this pass)
    const out = await track(decision + 5 * M15);
    expect(errorsFor(out, 'chron-decision-bar')).toBeEmpty();
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-decision-bar' } });
    expect(row?.status).toBe('open'); // not stopped by its own decision bar
    expect(row?.observations).toBe(1);
  });
});

describe('T5 (DB) — missing bars are honest; corrupt data fails closed', () => {
  test('gap in the window (missing bar) → no error, fewer observations, honest expiry exit', async () => {
    const decision = FIXED_NOW_SEC - 100 * M15;
    await seedSetup({ id: 'chron-gap', decisionSec: decision, createdAtSec: decision + M15 + 300, expiryBars: 3, invalidationLevel: 2603 });
    await seedBar(decision + M15, 2652, 2658, 2650, 2655); // bar 1
    // bar 2 MISSING (gap — e.g. daily break)
    await seedBar(decision + 3 * M15, 2653, 2659, 2651, 2657); // bar 3
    const out = await track(FIXED_NOW_SEC); // now ≫ expiry
    expect(errorsFor(out, 'chron-gap')).toBeEmpty();
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-gap' } });
    expect(row?.status).toBe('resolved');
    expect(row?.outcome).toBe('expired');
    expect(row?.observations).toBe(2); // honest non-observation of the gap
    expect(row?.exitPrice).toBe(2657); // last AVAILABLE close
    expect(row?.netPnlPrice).toBeCloseTo(6.72, 6); // 2657 − 2650 − 0.28
  });

  test('misaligned candle timestamp (off M15 grid) → row error, no advance, stays open', async () => {
    const decision = FIXED_NOW_SEC - 120 * M15;
    await seedSetup({ id: 'chron-misaligned', decisionSec: decision, createdAtSec: decision + M15 + 300, invalidationLevel: 2604 });
    await db.marketCandle.create({
      data: {
        symbol: 'XAUUSDm', timeframe: 'M15',
        candleTimeUtc: new Date((decision + M15 + 37) * 1000), // NOT grid-aligned
        open: '2650', high: '2652', low: '2649', close: '2651',
        source: 'bridge-mt5', isForming: false, validationStatus: 'VALID',
        receivedAtUtc: new Date((decision + 2 * M15) * 1000),
      },
    });
    const out = await track(FIXED_NOW_SEC);
    expect(errorsFor(out, 'chron-misaligned').length).toBeGreaterThan(0);
    expect(errorsFor(out, 'chron-misaligned')[0]).toContain('chronology');
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-misaligned' } });
    expect(row?.status).toBe('open'); // fail-closed — never resolved on ambiguous data
    expect(row?.observations).toBe(0);
  });

  test('paper row with setupKnownAt ≠ decision+900 (corrupt anchor) → row error, no advance', async () => {
    const decision = FIXED_NOW_SEC - 140 * M15;
    await seedSetup({
      id: 'chron-bad-anchor', decisionSec: decision,
      createdAtSec: decision + M15 + 300,
      setupKnownAtOverrideSec: decision + 800, // inconsistent with the M15 grid
      invalidationLevel: 2605,
    });
    const out = await track(FIXED_NOW_SEC);
    expect(errorsFor(out, 'chron-bad-anchor').length).toBeGreaterThan(0);
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-bad-anchor' } });
    expect(row?.status).toBe('open');
    expect(row?.observations).toBe(0);
  });

  test('creation BEFORE the setup was knowable (createdAt < setupKnownAt) → row error, no advance', async () => {
    const decision = FIXED_NOW_SEC - 160 * M15;
    await seedSetup({
      id: 'chron-pre-known', decisionSec: decision,
      createdAtSec: decision + 800, // < setupKnownAt (decision+900) — impossible chronology
      invalidationLevel: 2606,
    });
    const out = await track(FIXED_NOW_SEC);
    expect(errorsFor(out, 'chron-pre-known').length).toBeGreaterThan(0);
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-pre-known' } });
    expect(row?.status).toBe('open');
    expect(row?.observations).toBe(0);
  });
});

describe('T6 (DB) — a resolved row is never re-walked (evaluationId path; fingerprint-path immutability pinned in setup-identity.test.ts)', () => {
  test('later pass after resolution → immutable row, no second outcome', async () => {
    const decision = FIXED_NOW_SEC - 180 * M15;
    await seedSetup({ id: 'chron-repeat-1', decisionSec: decision, createdAtSec: decision + M15 + 300, invalidationLevel: 2607 });
    await seedSetup({ id: 'chron-repeat-2', decisionSec: decision + 3 * M15, createdAtSec: decision + 6 * M15, invalidationLevel: 2608 });
    await seedBar(decision + M15, 2650, 2652, 2639.5, 2644); // SL → resolves stopped (row 1)

    await track(FIXED_NOW_SEC);
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-repeat-1' } });
    expect(row?.status).toBe('resolved');
    expect(row?.outcome).toBe('stopped');
    const frozen = { outcome: row?.outcome, exit: row?.exitPrice, resolvedAt: row?.resolvedAtUtc?.getTime() };

    const second = await track(FIXED_NOW_SEC + 3600); // restart/recovery pass, later clock
    expect(errorsFor(second, 'chron-repeat-1')).toBeEmpty();
    const after = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-repeat-1' } });
    expect(after?.outcome).toBe(frozen.outcome);
    expect(after?.exitPrice).toBe(frozen.exit);
    expect(after?.resolvedAtUtc?.getTime()).toBe(frozen.resolvedAt);
  });
});

describe('T7 (DB) — expiry boundary through the pipeline', () => {
  test('bar opening AT expiry (SL touch) cannot resolve; row expires at the in-window close', async () => {
    const decision = FIXED_NOW_SEC - 200 * M15;
    const E = decision + 13 * M15;
    await seedSetup({ id: 'chron-expiry-edge', decisionSec: decision, createdAtSec: decision + M15 + 300, invalidationLevel: 2609 });
    for (let i = 1; i <= 12; i++) {
      await seedBar(decision + i * M15, 2650, 2655, 2646, i === 12 ? 2655 : 2652); // 12 no-hit bars
    }
    await seedBar(E, 2650, 2652, 2639.5, 2644); // opens AT expiry — post-expiry SL touch
    const out = await track(FIXED_NOW_SEC); // now ≫ expiry
    expect(errorsFor(out, 'chron-expiry-edge')).toBeEmpty();
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-expiry-edge' } });
    expect(row?.status).toBe('resolved');
    expect(row?.outcome).toBe('expired'); // NOT stopped by the post-expiry bar
    expect(row?.exitPrice).toBe(2655);    // the 12th (last in-window) bar's close
    expect(row?.observations).toBe(12);
    expect(row?.lastCheckedBarTimeUtc?.getTime()).toBe((decision + 12 * M15) * 1000); // last WALKED bar
  });
});

describe('T8 (DB) — restart/recovery never re- or mis-resolves', () => {
  test('resolved row stays byte-stable across later passes with NEW bars', async () => {
    const decision = FIXED_NOW_SEC - 220 * M15;
    await seedSetup({ id: 'chron-restart', decisionSec: decision, createdAtSec: decision + M15 + 300, invalidationLevel: 2610 });
    await seedBar(decision + M15, 2650, 2652, 2639.5, 2644); // SL at bar 1
    const t1 = FIXED_NOW_SEC - 10 * M15; // private clock region: after bar 1 closed
    await track(t1);
    const row1 = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-restart' } });
    expect(row1?.outcome).toBe('stopped');

    // "restart": later clock + a NEW bar that would have hit TP (must not matter)
    await seedBar(decision + 2 * M15, 2648, 2671, 2647, 2668);
    const out2 = await track(t1 + 2 * M15);
    expect(errorsFor(out2, 'chron-restart')).toBeEmpty();
    const row2 = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-restart' } });
    expect(row2?.outcome).toBe('stopped');
    expect(row2?.exitPrice).toBe(row1?.exitPrice);
    expect(row2?.resolvedAtUtc?.getTime()).toBe(row1?.resolvedAtUtc?.getTime());
    expect(row2?.resolutionBarTimeUtc?.getTime()).toBe(row1?.resolutionBarTimeUtc?.getTime());
    expect(row2?.netPnlPrice).toBe(row1?.netPnlPrice);
  });

  test('open row re-advanced at the same clock → idempotent observations, no double resolution', async () => {
    const decision = FIXED_NOW_SEC - 7 * M15; // expiry (FN+6·M15) far after the private clock below
    await seedSetup({ id: 'chron-open-idem', decisionSec: decision, createdAtSec: decision + M15 + 300, invalidationLevel: 2611 });
    await seedBar(decision + M15, 2652, 2658, 2650, 2655);   // opens FN−6·M15, closes FN−5·M15
    await seedBar(decision + 2 * M15, 2655, 2659, 2651, 2657); // opens FN−5·M15, closes FN−4·M15
    // Private track clock = FN−4·M15: both seeded bars are closed and walkable,
    // and the fetch window (open ≤ now) cannot reach any other test's bars in
    // the shared DB — hermetic even in a full-suite run.
    const now = decision + 3 * M15;
    const a = await track(now);
    expect(errorsFor(a, 'chron-open-idem')).toBeEmpty();
    const rowA = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-open-idem' } });
    expect(rowA?.status).toBe('open');
    expect(rowA?.observations).toBe(2);

    const b = await track(now); // same clock — idempotent
    expect(errorsFor(b, 'chron-open-idem')).toBeEmpty();
    const rowB = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-open-idem' } });
    expect(rowB?.status).toBe('open');
    expect(rowB?.observations).toBe(2); // no double-counted observations
  });
});

describe('T9 (DB) — frozen setup geometry is never altered by the walk', () => {
  test('after advance + resolution every frozen field equals its creation-time value', async () => {
    const decision = FIXED_NOW_SEC - 240 * M15;
    const created = decision + M15 + 300;
    await seedSetup({ id: 'chron-geometry', decisionSec: decision, createdAtSec: created, invalidationLevel: 2612 });
    await seedBar(decision + M15, 2650, 2671, 2647, 2668); // TP → targeted
    await track(FIXED_NOW_SEC);
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-geometry' } });
    expect(row?.entryReference).toBe(2650);
    expect(row?.stopLoss).toBe(2640);
    expect(row?.target).toBe(2670);
    expect(row?.invalidationLevel).toBe(2612);
    expect(row?.decisionCandleTimeUtc.getTime()).toBe(decision * 1000);
    expect(row?.setupKnownAtUtc.getTime()).toBe((decision + M15) * 1000);
    expect(row?.expiryUtc.getTime()).toBe((decision + 13 * M15) * 1000);
    expect(row?.signalCreatedAtUtc.getTime()).toBe(created * 1000);
  });
});

describe('T10 (DB) — legacy rows (per-evaluation path) & Phase 10.2 aggregation', () => {
  test('legacy row without fingerprint walks identically (normal cadence, same outcome)', async () => {
    const decision = FIXED_NOW_SEC - 260 * M15;
    const created = decision + M15 + 300;
    await seedSetup({ id: 'chron-legacy-eval', decisionSec: decision, createdAtSec: created, invalidationLevel: 2613 });
    await seedLegacyPaperRow({ evaluationId: 'chron-legacy-eval', decisionSec: decision, createdAtSec: created });
    await seedBar(decision + M15, 2650, 2652, 2639.5, 2644); // SL at bar 1
    const out = await track(FIXED_NOW_SEC);
    expect(errorsFor(out, 'chron-legacy-eval')).toBeEmpty();
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'chron-legacy-eval' } });
    expect(row?.setupFingerprint).toBeNull(); // legacy row — never backfilled
    expect(row?.status).toBe('resolved');
    expect(row?.outcome).toBe('stopped'); // same outcome the fingerprint path produces
    expect(row?.exitPrice).toBe(2640);
    expect(row?.observations).toBe(1);
  });

  test('first-open aggregation over chronology-correct rows: repeats never counted twice', async () => {
    // S1 (created first) stays OPEN → occupies the single paper position;
    // S2, S3 are created while S1 is open → repeats, never independent trades.
    const d1 = FIXED_NOW_SEC - 8 * M15; // expiry FN+5·M15 > now → S1 open
    await seedSetup({ id: 'chron-agg-s1', decisionSec: d1, createdAtSec: d1 + M15 + 300, invalidationLevel: 2614 });
    await seedBar(d1 + M15, 2652, 2658, 2650, 2655); // no hit → S1 stays open
    const d2 = FIXED_NOW_SEC - 6 * M15;
    await seedSetup({ id: 'chron-agg-s2', decisionSec: d2, createdAtSec: d2 + M15 + 300, invalidationLevel: 2615 });
    const d3 = FIXED_NOW_SEC - 5 * M15;
    await seedSetup({ id: 'chron-agg-s3', decisionSec: d3, createdAtSec: d3 + M15 + 300, invalidationLevel: 2616 });
    await track(FIXED_NOW_SEC);

    const rows = await db.paperSignalOutcome.findMany({
      where: { signalEvaluationId: { in: ['chron-agg-s1', 'chron-agg-s2', 'chron-agg-s3'] } },
    });
    expect(rows.length).toBe(3);
    const inputs: ForwardPaperRowInput[] = rows.map((r) => ({
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
    expect(counted.length).toBe(1); // S1 opens the position
    expect(repeats.length).toBe(2); // S2 + S3 are repeats while S1 is open
  });
});

// UI-02 hermeticity fix: file-level cleanup — bun runs multiple test files in
// ONE process in readdir/inode order (not alphabetical), so seeded rows used
// to survive into later files and break their window/row-count assertions.
afterAll(async () => {
  await db.marketCandle.deleteMany();
  await db.signalEvaluation.deleteMany();
  await db.paperSignalOutcome.deleteMany();
});
