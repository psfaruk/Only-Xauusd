/**
 * PHASE 10 PAPER-SIGNAL TRACKING TESTS.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic SignalEvaluation rows + synthetic candles on the
 * ISOLATED TEST DATABASE — never real broker data.
 *
 * Pins:
 *   · outcome classes: stopped (SL-first, incl. collision), targeted,
 *     invalidated (close back through the broken level), expired (with and
 *     without observable bars), unresolved
 *   · duplicate prevention: exactly ONE row per signal evaluation; resolved
 *     rows are IMMUTABLE — reprocessing never counts an outcome twice
 *   · P/L + R-multiple math under the Phase 10 conservative cost convention
 *   · expiry enforcement (expiryUtc from the engine is honored)
 *   · non-setup outcomes (NO_SETUP etc.) are never tracked
 *   · summary aggregation stays consistent with the stored rows
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { db } from '@/lib/db';
import {
  getPaperSignalSummary,
  paperPnl,
  resolvePaperOutcome,
  trackPaperSignals,
} from '@/lib/signal/paper';
import { FIXED_NOW_SEC } from '../market/helpers/setup';

const M15 = 900;

// ---------------------------------------------------------------------------
// Pure resolution walk (synthetic bars)
// ---------------------------------------------------------------------------

const DECISION_SEC = FIXED_NOW_SEC - 10 * M15; // decision bar 2.5h before the fixed now

function bar(offsetBars: number, o: number, h: number, l: number, c: number) {
  return { timeUtcSec: DECISION_SEC + offsetBars * M15, open: o, high: h, low: l, close: c };
}

describe('paper outcome resolution — pure walk (synthetic bars)', () => {
  // BUY setup: entryReference 2650, SL 2640, target 2670, invalidation 2645.
  test('SL touched → stopped, exit at SL', () => {
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, [bar(1, 2650, 2652, 2639.5, 2644)], DECISION_SEC + 20 * M15, FIXED_NOW_SEC);
    expect(r.outcome).toBe('stopped');
    expect(r.exitPrice).toBe(2640);
    expect(r.collision).toBe(false);
  });

  test('SL and TP touched in ONE bar → stopped with collision=true (conservative)', () => {
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, [bar(1, 2650, 2675, 2635, 2660)], DECISION_SEC + 20 * M15, FIXED_NOW_SEC);
    expect(r.outcome).toBe('stopped');
    expect(r.exitPrice).toBe(2640);
    expect(r.collision).toBe(true);
    expect(r.rule).toContain('conservative collision rule');
  });

  test('close back through the broken level (no SL touch) → invalidated at that close', () => {
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, [bar(1, 2648, 2649, 2644.5, 2644.2)], DECISION_SEC + 20 * M15, FIXED_NOW_SEC);
    expect(r.outcome).toBe('invalidated');
    expect(r.exitPrice).toBe(2644.2);
  });

  test('target touched → targeted at the target level', () => {
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, [bar(1, 2652, 2671, 2651, 2668)], DECISION_SEC + 20 * M15, FIXED_NOW_SEC);
    expect(r.outcome).toBe('targeted');
    expect(r.exitPrice).toBe(2670);
  });

  test('SL checked BEFORE invalidation close in the same bar (conservative order)', () => {
    // low touches SL AND close < invalidation → stopped wins.
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, [bar(1, 2648, 2649, 2639, 2643)], DECISION_SEC + 20 * M15, FIXED_NOW_SEC);
    expect(r.outcome).toBe('stopped');
  });

  test('no hits, expiry not reached → unresolved (open)', () => {
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, [bar(1, 2652, 2658, 2650, 2655)], DECISION_SEC + 20 * M15, DECISION_SEC + 3 * M15);
    expect(r.outcome).toBe('unresolved');
    expect(r.exitPrice).toBeNull();
    expect(r.observations).toBe(1);
  });

  test('no hits, expiry passed → expired at the last closed bar close', () => {
    const bars = [bar(1, 2652, 2658, 2650, 2655), bar(2, 2655, 2659, 2651, 2657)];
    const expiry = DECISION_SEC + 3 * M15;
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, bars, expiry, DECISION_SEC + 10 * M15);
    expect(r.outcome).toBe('expired');
    expect(r.exitPrice).toBe(2657);
    expect(r.observations).toBe(2);
  });

  test('expiry passed with NO observable bars → expired, exit null (never fabricated)', () => {
    const expiry = DECISION_SEC + 3 * M15;
    const r = resolvePaperOutcome('BUY', 2650, 2640, 2670, 2645, [], expiry, DECISION_SEC + 10 * M15);
    expect(r.outcome).toBe('expired');
    expect(r.exitPrice).toBeNull();
    expect(r.rule).toContain('NO post-signal candles');
  });

  test('SELL mirror: target below, SL above, invalidation above', () => {
    const r = resolvePaperOutcome('SELL', 2650, 2660, 2630, 2655, [bar(1, 2650, 2651, 2629, 2640)], DECISION_SEC + 20 * M15, FIXED_NOW_SEC);
    expect(r.outcome).toBe('targeted');
    expect(r.exitPrice).toBe(2630);
  });
});

describe('paper P/L — conservative cost convention', () => {
  test('gross = level-to-reference; net = gross − (spread + 2×slip + commission); R = net / risk', () => {
    const costs = { spreadPrice: 0.24, slippagePrice: 0.02, commissionPrice: 0, labels: [] };
    const p = paperPnl('BUY', 2650, 2670, 12, costs);
    expect(p.grossPrice).toBeCloseTo(20, 10);
    expect(p.costsPrice).toBeCloseTo(0.28, 10);
    expect(p.netPrice).toBeCloseTo(19.72, 10);
    expect(p.rMultiple).toBeCloseTo(19.72 / 12, 6);
  });
});

// ---------------------------------------------------------------------------
// DB pipeline (isolated test DB, synthetic rows)
// ---------------------------------------------------------------------------

interface SetupFixture {
  evaluationId: string;
  decisionSec: number;
}

async function insertSetupEvaluation(opts: {
  id: string;
  direction: 'BUY' | 'SELL';
  entryReference: number;
  stopLoss: number;
  target: number;
  riskPrice: number;
  invalidationLevel: number;
  decisionSec: number;
  expirySec: number;
}): Promise<SetupFixture> {
  const decisionIso = new Date(opts.decisionSec * 1000);
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
        structureEvent: { level: opts.invalidationLevel },
        executionWindow: { fromUtc: new Date((opts.decisionSec - 300 * M15) * 1000).toISOString(), toUtc: decisionIso.toISOString(), bars: 300 },
        h1Window: { fromUtc: decisionIso.toISOString(), toUtc: decisionIso.toISOString(), bars: 300 },
        h4Window: { fromUtc: decisionIso.toISOString(), toUtc: decisionIso.toISOString(), bars: 300 },
      }),
      levels: JSON.stringify({
        direction: opts.direction,
        entryZoneLow: 2649, entryZoneHigh: 2651,
        entryReference: opts.entryReference,
        stopLoss: opts.stopLoss, target: opts.target,
        riskPrice: opts.riskPrice, rewardPrice: 2 * opts.riskPrice, rewardRiskRatio: 2,
        entryZoneLowText: '2649', entryZoneHighText: '2651',
        stopLossText: String(opts.stopLoss), targetText: String(opts.target),
        entryReferenceText: String(opts.entryReference),
      }),
      decisionCandleTimeUtc: decisionIso,
      setupKnownAtUtc: new Date((opts.decisionSec + M15) * 1000),
      expiryUtc: new Date(opts.expirySec * 1000),
      quote: '{}',
      executionLocked: true,
      durationMs: 5,
    },
  });
  return { evaluationId: opts.id, decisionSec: opts.decisionSec };
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

describe('paper tracking pipeline — DB integration (synthetic rows, isolated test DB)', () => {
  test('targeted outcome recorded once; duplicate processing cannot count it twice', async () => {
    const decisionSec = FIXED_NOW_SEC - 10 * M15;
    await insertSetupEvaluation({
      id: 'paper-test-targeted', direction: 'BUY',
      entryReference: 2650, stopLoss: 2640, target: 2670, riskPrice: 12,
      invalidationLevel: 2645,
      decisionSec, expirySec: decisionSec + 12 * M15,
    });
    await insertM15Candle(decisionSec + M15, 2650, 2653, 2649, 2652);
    await insertM15Candle(decisionSec + 2 * M15, 2652, 2671, 2651, 2668); // target touched

    const first = await trackPaperSignals(db, { symbol: 'XAUUSDm', now: () => FIXED_NOW_SEC * 1000 });
    expect(first.scanned).toBe(1);
    expect(first.newlyOpened).toBe(1);
    expect(first.resolved.targeted).toBe(1);

    // Second run: the resolved row must be SKIPPED (immutable) — no double count.
    const second = await trackPaperSignals(db, { symbol: 'XAUUSDm', now: () => FIXED_NOW_SEC * 1000 });
    expect(second.scanned).toBe(1);
    expect(second.skippedResolved).toBe(1);
    expect(second.newlyOpened).toBe(0);
    expect(second.resolved.targeted).toBe(0);

    const rows = await db.paperSignalOutcome.findMany({ where: { symbol: 'XAUUSDm' } });
    expect(rows.length).toBe(1); // exactly ONE row for ONE signal evaluation
    expect(rows[0].status).toBe('resolved');
    expect(rows[0].outcome).toBe('targeted');
    expect(rows[0].exitPrice).toBe(2670);
    expect(rows[0].netPnlPrice).toBeCloseTo(19.72, 6);
    expect(rows[0].rMultiple).toBeCloseTo(19.72 / 12, 4);
    expect(rows[0].observations).toBe(2);
  });

  test('stopped + collision outcome with correct conservative accounting', async () => {
    const decisionSec = FIXED_NOW_SEC - 20 * M15;
    await insertSetupEvaluation({
      id: 'paper-test-stopped', direction: 'BUY',
      entryReference: 2650, stopLoss: 2640, target: 2670, riskPrice: 12,
      invalidationLevel: 2645,
      decisionSec, expirySec: decisionSec + 12 * M15,
    });
    await insertM15Candle(decisionSec + M15, 2650, 2675, 2635, 2660); // both touched → stopped

    const out = await trackPaperSignals(db, { symbol: 'XAUUSDm', now: () => FIXED_NOW_SEC * 1000 });
    expect(out.resolved.stopped).toBe(1);
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'paper-test-stopped' } });
    expect(row?.outcome).toBe('stopped');
    expect(row?.exitPrice).toBe(2640);
    expect(row?.netPnlPrice).toBeCloseTo(-10.28, 6); // 2640 − 2650 − 0.28
    const details = JSON.parse(row?.details ?? '{}') as { collision?: boolean };
    expect(details.collision).toBe(true);
  });

  test('invalidated outcome: M15 close back through the broken level', async () => {
    const decisionSec = FIXED_NOW_SEC - 30 * M15;
    await insertSetupEvaluation({
      id: 'paper-test-invalidated', direction: 'BUY',
      entryReference: 2650, stopLoss: 2640, target: 2670, riskPrice: 12,
      invalidationLevel: 2645,
      decisionSec, expirySec: decisionSec + 12 * M15,
    });
    await insertM15Candle(decisionSec + M15, 2648, 2649, 2644.0, 2644.2); // close < 2645, low > 2640 (valid OHLC)

    const out = await trackPaperSignals(db, { symbol: 'XAUUSDm', now: () => FIXED_NOW_SEC * 1000 });
    expect(out.resolved.invalidated).toBe(1);
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'paper-test-invalidated' } });
    expect(row?.outcome).toBe('invalidated');
    expect(row?.exitPrice).toBeCloseTo(2644.2, 6);
  });

  test('expired with NO observable bars → resolved with null P/L (honest)', async () => {
    const decisionSec = FIXED_NOW_SEC - 40 * M15;
    await insertSetupEvaluation({
      id: 'paper-test-expired-empty', direction: 'BUY',
      entryReference: 2650, stopLoss: 2640, target: 2670, riskPrice: 12,
      invalidationLevel: 2645,
      decisionSec, expirySec: decisionSec + 6 * M15, // long past, no candles inserted
    });
    const out = await trackPaperSignals(db, { symbol: 'XAUUSDm', now: () => FIXED_NOW_SEC * 1000 });
    expect(out.resolved.expired).toBe(1);
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'paper-test-expired-empty' } });
    expect(row?.outcome).toBe('expired');
    expect(row?.exitPrice).toBeNull();
    expect(row?.netPnlPrice).toBeNull();
    expect(row?.rMultiple).toBeNull();
  });

  test('unresolved setup stays open and advances observations on repeated runs', async () => {
    const decisionSec = FIXED_NOW_SEC - 4 * M15;
    const expirySec = decisionSec + 12 * M15; // in the future relative to FIXED_NOW
    await insertSetupEvaluation({
      id: 'paper-test-open', direction: 'BUY',
      entryReference: 2650, stopLoss: 2640, target: 2670, riskPrice: 12,
      invalidationLevel: 2645,
      decisionSec, expirySec,
    });
    await insertM15Candle(decisionSec + M15, 2652, 2658, 2650, 2655); // no hit
    await insertM15Candle(decisionSec + 2 * M15, 2655, 2659, 2651, 2657); // no hit

    const first = await trackPaperSignals(db, { symbol: 'XAUUSDm', now: () => FIXED_NOW_SEC * 1000 });
    expect(first.newlyOpened).toBe(1);
    let row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'paper-test-open' } });
    expect(row?.status).toBe('open');
    expect(row?.observations).toBe(2);

    const second = await trackPaperSignals(db, { symbol: 'XAUUSDm', now: () => FIXED_NOW_SEC * 1000 });
    expect(second.advanced).toBe(1); // re-evaluated idempotently
    expect(second.resolved.targeted + second.resolved.stopped + second.resolved.invalidated + second.resolved.expired).toBe(0);
    row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'paper-test-open' } });
    expect(row?.status).toBe('open'); // STILL unresolved — no fabricated outcome
    expect(row?.observations).toBe(2);
  });

  test('NO_SETUP evaluations are never tracked', async () => {
    await db.signalEvaluation.create({
      data: {
        id: 'paper-test-nosetup',
        engineVersion: '9.0.0',
        strategyVersion: 'hybrid-structure-retest/9.0.0',
        symbol: 'XAUUSDm',
        outcome: 'NO_SETUP',
        reasonCodes: '["NO_STRUCTURE_BREAK"]',
        inputFingerprint: 'fp-nosetup',
        inputSnapshot: '{}',
        evidence: '{}',
        levels: null,
        quote: '{}',
        executionLocked: true,
        durationMs: 5,
      },
    });
    const before = await db.paperSignalOutcome.count();
    await trackPaperSignals(db, { symbol: 'XAUUSDm', now: () => FIXED_NOW_SEC * 1000 });
    const after = await db.paperSignalOutcome.count();
    expect(after).toBe(before); // no new rows from a NO_SETUP evaluation
    const row = await db.paperSignalOutcome.findUnique({ where: { signalEvaluationId: 'paper-test-nosetup' } });
    expect(row).toBeNull(); // never tracked at all
  });

  test('summary aggregates match the stored rows (duplicate-proof counting)', async () => {
    const summary = await getPaperSignalSummary(db, 'XAUUSDm', 50);
    const rows = await db.paperSignalOutcome.findMany({ where: { symbol: 'XAUUSDm' } });
    expect(summary.total).toBe(rows.length);
    const resolved = rows.filter((r) => r.status === 'resolved');
    expect(summary.resolved.stopped).toBe(resolved.filter((r) => r.outcome === 'stopped').length);
    expect(summary.resolved.targeted).toBe(resolved.filter((r) => r.outcome === 'targeted').length);
    expect(summary.resolved.invalidated).toBe(resolved.filter((r) => r.outcome === 'invalidated').length);
    expect(summary.resolved.expired).toBe(resolved.filter((r) => r.outcome === 'expired').length);
    expect(summary.open).toBe(rows.filter((r) => r.status === 'open').length);
    const withPnl = resolved.filter((r) => r.netPnlPrice !== null);
    expect(summary.resolvedWithPnl).toBe(withPnl.length);
    if (withPnl.length) {
      expect(summary.netPnlPrice).toBeCloseTo(
        Number(withPnl.reduce((s, r) => s + (r.netPnlPrice ?? 0), 0).toFixed(4)),
        3,
      );
    }
  });
});
