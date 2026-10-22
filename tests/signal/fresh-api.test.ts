/**
 * FRESH SIGNAL API TESTS (Task 45, Phase 11 — DB-backed, isolated test DB).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: seeds SYNTHETIC evaluation/paper/candle rows (clearly
 * non-real numbers) to exercise /api/signal/fresh end-to-end: filters,
 * pagination, sort determinism, scope separation, the candidate-isolation
 * protocol (§4), status derivation through the API surface, honest empty
 * state, fail-closed validation, and the no-secrets guarantee.
 */

import '../market/helpers/setup';
import { describe, expect, test, beforeAll } from 'bun:test';
import { db } from '@/lib/db';
import { GET } from '@/app/api/signal/fresh/route';
import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';
import { CANDIDATE_STRATEGY_VERSION } from '@/lib/signal/candidate/types';
import { SCALPER_STRATEGY_VERSION } from '@/lib/signal/scalper/types';

const SYMBOL = 'XAUUSDm';
const req = (url: string) =>
  new Request(`http://localhost:3000${url}`, {
    headers: { Origin: 'http://localhost:3000' },
  });

const LEVELS = {
  direction: 'BUY',
  entryZoneLow: 4049.5,
  entryZoneHigh: 4055.2,
  entryReference: 4052.0,
  stopLoss: 4044.0,
  target: 4062.5,
  riskPrice: 8.0,
  rewardPrice: 10.5,
  rewardRiskRatio: 1.3125,
  entryZoneLowText: '4049.500',
  entryZoneHighText: '4055.200',
  stopLossText: '4044.000',
  targetText: '4062.500',
  entryReferenceText: '4052.000',
};

interface SeedOpts {
  id?: string;
  outcome?: string;
  strategy?: string;
  direction?: 'BUY' | 'SELL';
  createdAtMs?: number;
  expiryMs?: number | null;
  evidence?: unknown;
  reasonCodes?: string[];
}

/** Real-time-relative seeding: the service derives freshness from Date.now(),
 *  so seeds are placed relative to the actual test clock (±minutes/hours —
 *  never boundary-exact, so the assertions cannot flake). */
async function seedEval(opts: SeedOpts = {}): Promise<string> {
  const now = Date.now();
  const dir = opts.direction ?? 'BUY';
  const outcome = opts.outcome ?? 'BUY_SETUP';
  const id = opts.id ?? undefined;
  const created = new Date(opts.createdAtMs ?? now - 10 * 60_000);
  const row = await db.signalEvaluation.create({
    data: {
      ...(id ? { id } : {}),
      engineVersion: '9.0.0',
      strategyVersion: opts.strategy ?? SIGNAL_STRATEGY_VERSION,
      symbol: SYMBOL,
      outcome,
      reasonCodes: JSON.stringify(opts.reasonCodes ?? []),
      inputFingerprint: `fp-${Math.random().toString(36).slice(2)}`,
      setupFingerprint: null,
      datasetFingerprint: null,
      inputSnapshot: '{}',
      evidence: JSON.stringify(opts.evidence ?? {}),
      levels: outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP'
        ? JSON.stringify({ ...LEVELS, direction: dir })
        : null,
      decisionCandleTimeUtc: new Date(now - 25 * 60_000),
      setupKnownAtUtc: new Date(now - 25 * 60_000 + 900_000),
      expiryUtc: opts.expiryMs === null ? null : new Date(opts.expiryMs ?? now + 60 * 60_000),
      quote: '{}',
      executionLocked: true,
      durationMs: 42,
      createdAt: created,
    },
  });
  return row.id;
}

async function seedPaper(
  evaluationId: string,
  status: 'open' | 'resolved',
  outcome: 'stopped' | 'targeted' | 'invalidated' | 'expired' | null,
  lastChecked: boolean,
) {
  const now = Date.now();
  await db.paperSignalOutcome.create({
    data: {
      signalEvaluationId: evaluationId,
      symbol: SYMBOL,
      direction: 'BUY',
      signalCreatedAtUtc: new Date(now - 10 * 60_000),
      decisionCandleTimeUtc: new Date(now - 25 * 60_000),
      setupKnownAtUtc: new Date(now - 10 * 60_000),
      expiryUtc: new Date(now + 60 * 60_000),
      datasetFingerprint: null,
      inputFingerprint: 'fp-x',
      setupFingerprint: null,
      sourceCandleRange: '{}',
      entryReference: 4052.0,
      stopLoss: 4044.0,
      target: 4062.5,
      invalidationLevel: 4040.0,
      status,
      outcome,
      resolvedAtUtc: status === 'resolved' ? new Date(now - 5 * 60_000) : null,
      resolutionBarTimeUtc: null,
      exitPrice: status === 'resolved' ? 4062.5 : null,
      observations: lastChecked ? 3 : 0,
      lastCheckedBarTimeUtc: lastChecked ? new Date(now - 60_000) : null,
      modeledCostsPrice: 0.28,
      grossPnlPrice: null,
      netPnlPrice: null,
      rMultiple: status === 'resolved' ? 1.31 : null,
      details: '{}',
    },
  });
}

/** Closed M15 candle 2 minutes ago → FRESH for M15 (threshold 2700s). */
async function seedFreshCandle(tf = 'M15', ageMs = 2 * 60_000) {
  const open = new Date(Date.now() - ageMs - 900_000);
  await db.marketCandle.create({
    data: {
      symbol: SYMBOL,
      timeframe: tf,
      candleTimeUtc: open,
      open: '4050.000',
      high: '4051.000',
      low: '4049.000',
      close: '4050.500',
      tickVolume: 100,
      source: 'bridge-mt5',
      isForming: false,
      validationStatus: 'VALID',
      receivedAtUtc: new Date(),
    },
  });
}

async function body(res: Response): Promise<any> {
  return res.json();
}

beforeAll(async () => {
  await db.signalEvaluation.deleteMany();
  await db.paperSignalOutcome.deleteMany();
  await db.marketCandle.deleteMany();
  await db.syncRun.deleteMany();
  await db.marketLatestTick.deleteMany();
});

describe('GET /api/signal/fresh — honest empty state', () => {
  test('empty DB → ok, zero rows, full pipeline block, no fabrication', async () => {
    const res = await GET(req('/api/signal/fresh'));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.ok).toBe(true);
    expect(b.scope).toBe('live');
    expect(b.strategy).toBe('product');
    expect(b.total).toBe(0);
    expect(b.rows).toEqual([]);
    expect(b.scanned).toBe(0);
    // pipeline block present: three engines, all honestly never-run
    expect(b.pipeline.engines).toHaveLength(3);
    for (const e of b.pipeline.engines) expect(e.lastEvalAtUtc).toBeNull();
    expect(b.pipeline.dataFreshness.M15.state).toBe('DATA_UNAVAILABLE');
    expect(b.pipeline.paper.open).toBe(0);
    expect(b.policy.note).toContain('server-side');
  });
});

describe('GET /api/signal/fresh — seeded lifecycle matrix', () => {
  let freshId: string;
  let pendingId: string;
  let expiredId: string;
  let validatedId: string;
  let rejectedId: string;
  let failedId: string;
  let candidateId: string;
  let scalperId: string;

  beforeAll(async () => {
    await seedFreshCandle('M15');
    await seedFreshCandle('M5');

    freshId = await seedEval({}); // BUY_SETUP, future expiry, paper open+checked
    await seedPaper(freshId, 'open', null, true);

    pendingId = await seedEval({ direction: 'SELL', outcome: 'SELL_SETUP' });
    await seedPaper(pendingId, 'open', null, false); // never checked

    expiredId = await seedEval({ expiryMs: Date.now() - 30 * 60_000 });
    await seedPaper(expiredId, 'open', null, true);

    validatedId = await seedEval({ expiryMs: Date.now() - 30 * 60_000 });
    await seedPaper(validatedId, 'resolved', 'targeted', true);

    rejectedId = await seedEval({ outcome: 'WAIT', reasonCodes: ['ZONE_INVALIDATED'] });
    failedId = await seedEval({ outcome: 'FAILED', reasonCodes: ['SIGNAL_ERROR'] });
    candidateId = await seedEval({ strategy: CANDIDATE_STRATEGY_VERSION });
    scalperId = await seedEval({
      strategy: SCALPER_STRATEGY_VERSION,
      evidence: { scalper: { sourceTimeframe: 'M5' }, smc: { totalScore: 62, tier: 'B' } },
    });
    await seedPaper(scalperId, 'open', null, true);
  });

  test('live scope: exactly the two actionable setups (FRESH + PENDING), joined paper, movement', async () => {
    const b = await body(await GET(req('/api/signal/fresh')));
    expect(b.total).toBe(3); // fresh + pending + scalper
    const byId = new Map(b.rows.map((r: any) => [r.id, r.id]));
    for (const id of [freshId, pendingId, scalperId]) expect(byId.has(id)).toBe(true);
    for (const id of [expiredId, validatedId, rejectedId, failedId, candidateId]) expect(byId.has(id)).toBe(false);

    const fresh = b.rows.find((r: any) => r.id === freshId);
    expect(fresh.status).toBe('FRESH');
    expect(fresh.direction).toBe('BUY');
    expect(fresh.sourceTimeframe).toBe('M15');
    expect(fresh.levels.entryReference).toBe(4052.0);
    expect(fresh.levels.rewardRiskRatio).toBe(1.3125);
    expect(fresh.paper.status).toBe('open');
    expect(fresh.paper.observations).toBe(3);
    // lifecycle timeline: decision → known → evaluated → paper opened (+checked)
    const events = fresh.lifecycle.map((l: any) => l.event);
    expect(events).toEqual(['DECISION_CANDLE', 'SETUP_KNOWN', 'EVALUATED', 'PAPER_OPENED', 'PAPER_CHECKED']);
    expect(fresh.validation.checks.length).toBeGreaterThan(0);
    expect(fresh.currentPrice?.price).toBeGreaterThan(0); // candle fallback price
    expect(typeof fresh.movementPrice).toBe('number');
  });

  test('PENDING derivation surfaces through the API', async () => {
    const b = await body(await GET(req('/api/signal/fresh')));
    const pending = b.rows.find((r: any) => r.id === pendingId);
    expect(pending.status).toBe('PENDING');
    expect(pending.direction).toBe('SELL');
  });

  test('scalper rows carry sourceTimeframe M5 + SMC confluence score (not a win probability)', async () => {
    const b = await body(await GET(req('/api/signal/fresh')));
    const sc = b.rows.find((r: any) => r.id === scalperId);
    expect(sc.sourceTimeframe).toBe('M5');
    expect(sc.smc.score).toBe(62);
    expect(sc.smc.tier).toBe('B');
  });

  test('archive scope: terminal + rejected + failed all visible with correct statuses', async () => {
    const b = await body(await GET(req('/api/signal/fresh?scope=archive&strategy=all')));
    const byId = new Map<string, any>(b.rows.map((r: any) => [r.id as string, r]));
    expect(byId.get(expiredId).status).toBe('EXPIRED');
    expect(byId.get(validatedId).status).toBe('VALIDATED');
    expect(byId.get(rejectedId).status).toBe('REJECTED');
    expect(byId.get(rejectedId).reasonCodes).toEqual(['ZONE_INVALIDATED']);
    expect(byId.get(failedId).status).toBe('ENGINE_ERROR');
    // live-only rows stay visible in the archive too
    expect(byId.get(freshId).status).toBe('FRESH');
    expect(byId.get(candidateId)).toBeTruthy(); // strategy=all includes candidate
  });

  test('candidate isolation (protocol §4): default product scope NEVER leaks candidate rows', async () => {
    const prod = await body(await GET(req('/api/signal/fresh?scope=archive')));
    expect(prod.rows.some((r: any) => r.strategyVersion === CANDIDATE_STRATEGY_VERSION)).toBe(false);
    const cand = await body(await GET(req('/api/signal/fresh?scope=archive&strategy=candidate')));
    expect(cand.rows.every((r: any) => r.strategyVersion === CANDIDATE_STRATEGY_VERSION)).toBe(true);
    expect(cand.total).toBe(1);
  });

  test('direction filter', async () => {
    const buys = await body(await GET(req('/api/signal/fresh?direction=BUY')));
    expect(buys.total).toBe(2); // fresh + scalper (both BUY)
    expect(buys.rows.every((r: any) => r.direction === 'BUY')).toBe(true);
  });

  test('timeframe filter: M5 isolates the scalper row', async () => {
    const b = await body(await GET(req('/api/signal/fresh?timeframe=M5')));
    expect(b.total).toBe(1);
    expect(b.rows[0].id).toBe(scalperId);
  });

  test('status filter', async () => {
    const b = await body(await GET(req('/api/signal/fresh?status=PENDING')));
    expect(b.total).toBe(1);
    expect(b.rows[0].id).toBe(pendingId);
  });

  test('search by signal-id substring', async () => {
    const b = await body(await GET(req(`/api/signal/fresh?q=${freshId.slice(4, 12)}`)));
    expect(b.rows.some((r: any) => r.id === freshId)).toBe(true);
  });

  test('pagination: pageSize=5 splits the archive rows deterministically', async () => {
    const p1 = await body(await GET(req('/api/signal/fresh?scope=archive&strategy=all&pageSize=5')));
    const p2 = await body(await GET(req('/api/signal/fresh?scope=archive&strategy=all&pageSize=5&page=2')));
    expect(p1.rows).toHaveLength(5);
    expect(p1.total).toBe(8);
    expect(p1.totalPages).toBe(2);
    expect(p2.rows).toHaveLength(3);
    expect(p2.page).toBe(2);
    // deterministic newest-first ordering with id tiebreak
    expect(p1.rows[0].createdAtUtc >= p1.rows[1].createdAtUtc).toBe(true);
  });

  test('sort=oldest reverses; sort=timeframe orders M1<M5<M15', async () => {
    const oldest = await body(await GET(req('/api/signal/fresh?sort=oldest')));
    const newest = await body(await GET(req('/api/signal/fresh?sort=newest')));
    expect(oldest.rows[0].id).toBe(newest.rows[newest.rows.length - 1].id);
    const tf = await body(await GET(req('/api/signal/fresh?sort=timeframe')));
    const tfs = tf.rows.map((r: any) => r.sourceTimeframe);
    expect(tfs.indexOf('M5')).toBeLessThan(tfs.indexOf('M15'));
  });

  test('pipeline health reflects seeded state (engines ran, reasons distributed, tick absent)', async () => {
    const b = await body(await GET(req('/api/signal/fresh')));
    const baseline = b.pipeline.engines.find((e: any) => e.strategyVersion === SIGNAL_STRATEGY_VERSION);
    expect(baseline.lastEvalAtUtc).not.toBeNull();
    expect(baseline.lastOutcome).toBe('FAILED'); // newest baseline row is the FAILED seed
    expect(baseline.setups24h).toBe(4); // fresh, pending, expired, validated
    const codes = b.pipeline.reasonDistribution24h.map((r: any) => r.code);
    expect(codes).toContain('ZONE_INVALIDATED');
    expect(b.pipeline.dataFreshness.M15.state).toBe('FRESH');
  });

  test('no secrets in the response payload', async () => {
    const raw = JSON.stringify(await body(await GET(req('/api/signal/fresh?scope=archive&strategy=all'))));
    expect(raw).not.toContain('MT5_PASSWORD');
    expect(raw).not.toContain('MT5_BRIDGE_TOKEN');
    expect(raw).not.toContain('56529050');
    expect(raw).not.toContain('x-trader-key');
  });
});

describe('GET /api/signal/fresh — fail-closed validation', () => {
  test('invalid status value → 400', async () => {
    const res = await GET(req('/api/signal/fresh?status=BOGUS'));
    expect(res.status).toBe(400);
  });
  test('non-allowlisted symbol → 400', async () => {
    const res = await GET(req('/api/signal/fresh?symbol=EURUSDm'));
    expect(res.status).toBe(400);
  });
  test('page 0 → 400', async () => {
    const res = await GET(req('/api/signal/fresh?page=0'));
    expect(res.status).toBe(400);
  });
  test('pageSize above 100 → 400 (bounded)', async () => {
    const res = await GET(req('/api/signal/fresh?pageSize=500'));
    expect(res.status).toBe(400);
  });
  test('single-char search (below the 2-char floor) → 400', async () => {
    const res = await GET(req('/api/signal/fresh?q=a'));
    expect(res.status).toBe(400);
  });
  test('unknown query parameters are IGNORED (app convention: routes cherry-pick allowlisted keys)', async () => {
    // Consistency with /api/signal/history & friends: the route passes only
    // the named keys into the strict zod schema; anything else in the URL is
    // dropped and can never inject a value.
    const res = await GET(req('/api/signal/fresh?limit=10&evil=INJECT'));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.ok).toBe(true);
    expect(b.pageSize).toBe(25); // untouched default
  });
});
