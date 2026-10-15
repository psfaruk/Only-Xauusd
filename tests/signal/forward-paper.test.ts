/**
 * PHASE 10.2 FORWARD PAPER VALIDATION TESTS (DB aggregation + API).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic PaperSignalOutcome rows seeded directly into the
 * ISOLATED TEST DATABASE — never real broker data, no bridge contacted.
 *
 * Pins:
 *   · eligibility: only rows created at/after protocol activation count
 *     (forward-only — nothing historical can inflate the sample)
 *   · first-open rule over DB rows: repeat observations of an open counted
 *     trade are NEVER independent trades
 *   · expired-unobservable rows: disclosed, excluded from metrics, never
 *     invented
 *   · open counted trades surface in progress + recentTrades
 *   · honest empty state: 0 rows → IN_PROGRESS verdict, no metrics, no claim
 *   · GET /api/validation/latest exposes the forwardPaper section
 */

import '../market/helpers/setup';
import { beforeEach, describe, expect, test } from 'bun:test';

import { db } from '@/lib/db';
import { getForwardPaperStatus } from '@/lib/signal/forward';
import { forwardPaperActivatedMs } from '@/lib/signal/paper-protocol';
import { GET } from '@/app/api/validation/latest/route';

const SYMBOL = 'XAUUSDm';
const DAY = 86_400_000;
const MIN = 60_000;
const T0 = forwardPaperActivatedMs();
/** Fixed evaluation clock: 10 days into the 90-day window. */
const NOW = T0 + 10 * DAY;

let counter = 0;

/** Seed one synthetic PaperSignalOutcome row (all times relative to protocol T0). */
async function seed(over: Record<string, unknown> & { atMs: number }): Promise<string> {
  const at = new Date(over.atMs);
  counter += 1;
  const row = await db.paperSignalOutcome.create({
    data: {
      signalEvaluationId: `test-eval-${counter}`,
      symbol: SYMBOL,
      direction: 'BUY',
      signalCreatedAtUtc: at,
      decisionCandleTimeUtc: at,
      setupKnownAtUtc: at,
      expiryUtc: new Date(over.atMs + 12 * 15 * MIN),
      inputFingerprint: 'test-fp',
      sourceCandleRange: '{}',
      entryReference: 2650,
      stopLoss: 2640,
      target: 2670,
      invalidationLevel: 2645,
      status: 'resolved',
      outcome: 'stopped',
      resolvedAtUtc: new Date(over.atMs + 3_600_000),
      resolutionBarTimeUtc: new Date(over.atMs + 3_600_000),
      exitPrice: 2640,
      observations: 4,
      modeledCostsPrice: 0.3,
      grossPnlPrice: -10,
      netPnlPrice: -10.3,
      rMultiple: -1.03,
      ...over,
      atMs: undefined,
    } as never,
  });
  return row.id;
}

const status = () => getForwardPaperStatus(db, SYMBOL, { now: () => NOW });
const req = (url: string) => new Request(`http://localhost:3000${url}`);

beforeEach(async () => {
  await db.paperSignalOutcome.deleteMany();
});

describe('getForwardPaperStatus — pre-registered DB aggregation', () => {
  test('honest empty: 0 eligible rows → IN_PROGRESS, no metrics, no claim', async () => {
    const s = await status();
    expect(s.progress.eligibleRows).toBe(0);
    expect(s.progress.countedCompleted).toBe(0);
    expect(s.progress.openCounted).toBe(0);
    expect(s.metrics).toBeNull();
    expect(s.recentTrades).toHaveLength(0);
    expect(s.verdict.conclusion).toBe('IN_PROGRESS');
    expect(s.verdict.reasons.join(' ')).toContain('0/20');
    expect(s.verdict.reasons.join(' ')).toContain('No performance claim');
    expect(s.protocol.version).toBe('phase10.2-forward-paper/1');
    expect(s.protocol.rulesVersion).toBe('phase10.2-forward-paper-rules/1');
    expect(new Date(s.protocol.deadlineUtc).getTime()).toBe(T0 + 90 * DAY);
  });

  test('rows created BEFORE activation are excluded (forward-only counting)', async () => {
    await seed({ atMs: T0 - 60 * MIN, netPnlPrice: 5.2, grossPnlPrice: 5.5, rMultiple: 0.52, outcome: 'targeted', exitPrice: 2670 });
    const s = await status();
    expect(s.progress.eligibleRows).toBe(0);
    expect(s.progress.countedCompleted).toBe(0);
    expect(s.verdict.conclusion).toBe('IN_PROGRESS');
  });

  test('first-open rule: repeat observation while open is NOT an independent trade', async () => {
    // a: counted (stopped, net −10.3), resolution bar at T0+60min
    await seed({ atMs: T0 + 1 * MIN });
    // b: emitted at T0+30min while a was still live → repeat
    await seed({ atMs: T0 + 30 * MIN, netPnlPrice: 6, grossPnlPrice: 6.3, rMultiple: 0.6, outcome: 'targeted', exitPrice: 2670 });
    // c: emitted at T0+120min, after a resolved → new counted trade
    await seed({ atMs: T0 + 120 * MIN, netPnlPrice: 6, grossPnlPrice: 6.3, rMultiple: 0.6, outcome: 'targeted', exitPrice: 2670 });
    const s = await status();
    expect(s.progress.eligibleRows).toBe(3);
    expect(s.progress.countedCompleted).toBe(2);
    expect(s.progress.repeatObservations).toBe(1);
    expect(s.metrics).not.toBeNull();
    expect(s.metrics!.trades).toBe(2);
    expect(s.metrics!.netPnlPrice).toBeCloseTo(-4.3, 3);
    expect(s.statusCounts.stopped).toBe(1);
    expect(s.statusCounts.targeted).toBe(1);
  });

  test('expired-unobservable resolved row: disclosed separately, never in metrics', async () => {
    await seed({
      atMs: T0 + 5 * MIN,
      status: 'resolved',
      outcome: 'expired',
      netPnlPrice: null,
      grossPnlPrice: null,
      rMultiple: null,
      exitPrice: null,
      resolutionBarTimeUtc: null,
      observations: 0,
    });
    const s = await status();
    expect(s.progress.unobservableResolved).toBe(1);
    expect(s.statusCounts.expiredUnobservable).toBe(1);
    expect(s.statusCounts.expired).toBe(0);
    expect(s.metrics).toBeNull();
    expect(s.verdict.conclusion).toBe('IN_PROGRESS');
  });

  test('open counted trade surfaces in openCounted + recentTrades', async () => {
    await seed({
      atMs: T0 + 5 * MIN,
      status: 'open',
      outcome: null,
      netPnlPrice: null,
      grossPnlPrice: null,
      rMultiple: null,
      exitPrice: null,
      resolvedAtUtc: null,
      resolutionBarTimeUtc: null,
      observations: 2,
    });
    const s = await status();
    expect(s.progress.openCounted).toBe(1);
    expect(s.progress.countedCompleted).toBe(0);
    expect(s.recentTrades).toHaveLength(1);
    expect(s.recentTrades[0].status).toBe('open');
    expect(s.verdict.conclusion).toBe('IN_PROGRESS');
  });

  test('IN_PROGRESS carries elapsed/remaining days of the fixed 90-day window', async () => {
    const s = await status();
    expect(s.protocol.observationWindowDays).toBe(90);
    expect(s.progress.elapsedDays).toBeCloseTo(10, 2);
    expect(s.progress.daysRemaining).toBeCloseTo(80, 2);
  });
});

describe('GET /api/validation/latest — forwardPaper section', () => {
  test('exposes protocol + honest IN_PROGRESS verdict alongside the Phase 10 view', async () => {
    const res = await GET(req('/api/validation/latest?symbol=XAUUSDm'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      forwardPaper: {
        protocol: { version: string; rulesVersion: string };
        verdict: { conclusion: string; disclaimer: string };
        progress: { countedCompleted: number };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.forwardPaper.protocol.version).toBe('phase10.2-forward-paper/1');
    expect(body.forwardPaper.protocol.rulesVersion).toBe('phase10.2-forward-paper-rules/1');
    expect(body.forwardPaper.verdict.conclusion).toBe('IN_PROGRESS');
    expect(body.forwardPaper.verdict.disclaimer).toContain('NOT a profitability claim');
    expect(body.forwardPaper.progress.countedCompleted).toBe(0);
  });

  test('counted forward rows flow through the API (repeat stays excluded)', async () => {
    await seed({ atMs: T0 + 1 * MIN });
    await seed({ atMs: T0 + 30 * MIN, netPnlPrice: 6, grossPnlPrice: 6.3, rMultiple: 0.6, outcome: 'targeted', exitPrice: 2670 });
    const res = await GET(req('/api/validation/latest?symbol=XAUUSDm'));
    const body = (await res.json()) as { forwardPaper: { progress: { countedCompleted: number; repeatObservations: number } } };
    expect(body.forwardPaper.progress.countedCompleted).toBe(1);
    expect(body.forwardPaper.progress.repeatObservations).toBe(1);
  });
});
