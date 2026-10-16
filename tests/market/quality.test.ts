/**
 * AUTOMATED TESTS — data quality & analysis readiness (Phase 3, spec Steps 4-5).
 * Covers: readiness aggregation, per-timeframe staleness, MISSING state,
 * session-aware gap reporting inside the readiness result, demo-source
 * refusal, missing symbol specification, and the downstream fail-closed
 * getAnalysisReadiness contract. Mock/synthetic data only.
 */
import './helpers/setup';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { db } from '@/lib/db';
import { computeReadiness, getAnalysisReadiness } from '@/lib/market/quality';
import { TIMEFRAME_SECONDS } from '@/lib/market/types';
import { makeBars } from './helpers/mock-bridge';
import { FIXED_NOW_MS, FIXED_NOW_SEC } from './helpers/setup';

const SYMBOL = 'XAUUSDm';

async function seedTf(
  timeframe: 'M5' | 'M15' | 'H1' | 'H4',
  opts: { count?: number; lastOpenSec?: number; holes?: number[]; source?: string; forming?: boolean } = {},
) {
  const count = opts.count ?? 50;
  const lastOpenSec = opts.lastOpenSec ?? FIXED_NOW_SEC - TIMEFRAME_SECONDS[timeframe];
  const bars = makeBars(TIMEFRAME_SECONDS[timeframe], count, lastOpenSec, {
    forming: opts.forming ?? true,
    holeAtOffsets: opts.holes,
  });
  for (const b of bars) {
    await db.marketCandle.create({
      data: {
        symbol: SYMBOL,
        timeframe,
        candleTimeUtc: new Date(b.t * 1000),
        open: b.o.toFixed(2),
        high: b.h.toFixed(2),
        low: b.l.toFixed(2),
        close: b.c.toFixed(2),
        tickVolume: b.v ?? null,
        spread: null,
        source: opts.source ?? 'bridge-mt5',
        isForming: b.f === 1,
        validationStatus: 'VALID',
        receivedAtUtc: new Date(FIXED_NOW_MS),
      },
    });
  }
}

async function seedTick(ageSec: number, source = 'bridge-mt5') {
  await db.marketLatestTick.upsert({
    where: { symbol: SYMBOL },
    create: {
      symbol: SYMBOL,
      bid: '2650.10',
      ask: '2650.50',
      spread: '0.40',
      spreadPoints: '40.0',
      tickTimeUtc: new Date((FIXED_NOW_SEC - ageSec) * 1000),
      receivedAtUtc: new Date(FIXED_NOW_MS),
      source,
      validationStatus: 'VALID',
    },
    update: {
      tickTimeUtc: new Date((FIXED_NOW_SEC - ageSec) * 1000),
      source,
    },
  });
}

beforeEach(async () => {
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
  await db.dataQualityIssue.deleteMany();
});

// UI-02 hermeticity fix: bun runs multiple test FILES in one process and the
// execution order follows readdir/inode order (NOT alphabetical) — after a
// sandbox rebuild this file can run BEFORE the signal/paper tests. The
// beforeEach above only cleans between THIS file's tests, so seeded candles
// used to survive into later files' window queries and broke them. Clean the
// shared test DB when this FILE finishes so no rows leak either way.
afterAll(async () => {
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
  await db.dataQualityIssue.deleteMany();
});

describe('readiness — empty database (fail closed)', () => {
  test('no data at all → MISSING everywhere, ready=false, qualityState worst-case', async () => {
    const r = await computeReadiness({ symbol: SYMBOL, now: () => FIXED_NOW_MS });
    expect(r.ready).toBe(false);
    expect(r.qualityState).toBe('MISSING');
    expect(r.timeframes.every((t) => t.state === 'MISSING')).toBe(true);
    expect(r.tick.state).toBe('MISSING');
    expect(r.errorCodes).toContain('DATA_MISSING');
    expect(r.purpose).toBe('data-readiness-only-not-trade-recommendation');
  });
});

describe('readiness — fresh, complete data', () => {
  test('fresh closed candles on all 4 tfs + fresh tick + verified spec → ready=true, VALID', async () => {
    await seedTf('M5');
    await seedTf('M15');
    await seedTf('H1');
    await seedTf('H4');
    await seedTick(10);
    await db.symbolSpec.create({
      data: {
        symbol: SYMBOL, digits: 2, point: '0.01', source: 'bridge-mt5',
        verifiedFields: '["digits"]', lastVerifiedAt: new Date(FIXED_NOW_MS),
      },
    });
    const r = await computeReadiness({ symbol: SYMBOL, now: () => FIXED_NOW_MS });
    expect(r.ready).toBe(true);
    expect(r.qualityState).toBe('VALID');
    expect(r.errorCodes).toEqual([]); // no warnings at all in the perfect case
    expect(r.lastTickTimeUtc).not.toBeNull();
    expect(r.lastClosedCandleTimeUtc).not.toBeNull();
    expect(r.dataAgeSeconds).not.toBeNull();
  });

  test('without a verified spec → SPEC_MISSING stays a visible WARNING (never silently valid)', async () => {
    await seedTf('M5');
    await seedTf('M15');
    await seedTf('H1');
    await seedTf('H4');
    await seedTick(10);
    const r = await computeReadiness({ symbol: SYMBOL, now: () => FIXED_NOW_MS });
    expect(r.ready).toBe(true); // still usable data…
    expect(r.qualityState).toBe('WARNING'); // …but the warning is NOT swallowed
    expect(r.errorCodes).toContain('SPEC_MISSING');
  });
});

describe('readiness — staleness per timeframe', () => {
  test('old M5 candles → STALE for M5 (threshold 3×tf), ready=false', async () => {
    await seedTf('M5', { lastOpenSec: FIXED_NOW_SEC - 3_600 }); // 1h old → beyond 900s
    await seedTf('M15');
    await seedTf('H1');
    await seedTf('H4');
    await seedTick(10);
    const r = await computeReadiness({ symbol: SYMBOL, now: () => FIXED_NOW_MS });
    const m5 = r.timeframes.find((t) => t.timeframe === 'M5')!;
    expect(m5.state).toBe('STALE');
    expect(m5.errorCodes).toContain('DATA_STALE');
    expect(r.ready).toBe(false);
    expect(r.qualityState).toBe('STALE');
  });

  test('stale tick alone (fresh candles) → tick STALE, ready=false', async () => {
    await seedTf('M5');
    await seedTf('M15');
    await seedTf('H1');
    await seedTf('H4');
    await seedTick(600); // 10 min old, threshold 120s
    const r = await computeReadiness({ symbol: SYMBOL, now: () => FIXED_NOW_MS });
    expect(r.tick.state).toBe('STALE');
    expect(r.tick.errorCodes).toContain('TICK_STALE');
    expect(r.ready).toBe(false);
  });
});

describe('readiness — forming candles are never confirmed history', () => {
  test('only forming candles (no closed) → timeframe MISSING despite recent timestamps', async () => {
    // A single forming bar whose period is still open:
    const t = FIXED_NOW_SEC - 60;
    await db.marketCandle.create({
      data: {
        symbol: SYMBOL, timeframe: 'M5', candleTimeUtc: new Date(t * 1000),
        open: '2650.00', high: '2651.00', low: '2649.00', close: '2650.50',
        tickVolume: 5, spread: null, source: 'bridge-mt5', isForming: true,
        validationStatus: 'VALID', receivedAtUtc: new Date(FIXED_NOW_MS),
      },
    });
    await seedTick(10);
    const r = await computeReadiness({ symbol: SYMBOL, now: () => FIXED_NOW_MS });
    const m5 = r.timeframes.find((x) => x.timeframe === 'M5')!;
    expect(m5.state).toBe('MISSING'); // forming bar does NOT count as closed history
    expect(r.ready).toBe(false);
  });
});

describe('readiness — session-aware gap reporting', () => {
  test('weekday hole → missingCandles ≥ 1 with GAP_POSSIBLE; still fresh → WARNING not INVALID', async () => {
    await seedTf('M5', { count: 60, holes: [30] }); // hole ~2.5h ago on Wednesday
    await seedTf('M15');
    await seedTf('H1');
    await seedTf('H4');
    await seedTick(10);
    const r = await computeReadiness({ symbol: SYMBOL, now: () => FIXED_NOW_MS });
    const m5 = r.timeframes.find((t) => t.timeframe === 'M5')!;
    expect(m5.missingCandles).toBe(1);
    expect(m5.errorCodes).toContain('GAP_POSSIBLE');
    expect(m5.state).toBe('WARNING');
    expect(r.ready).toBe(true); // fresh with a flagged warning — warning never silently becomes VALID
    expect(r.qualityState).toBe('WARNING');
  });
});

describe('readiness — demo source is never analysis-ready', () => {
  test('demo-sourced rows → SOURCE_DEMO, ready=false even when fresh', async () => {
    await seedTf('M5', { source: 'bridge-demo' });
    await seedTf('M15', { source: 'bridge-demo' });
    await seedTf('H1', { source: 'bridge-demo' });
    await seedTf('H4', { source: 'bridge-demo' });
    await seedTick(10, 'bridge-demo');
    const r = await computeReadiness({ symbol: SYMBOL, now: () => FIXED_NOW_MS });
    expect(r.errorCodes).toContain('SOURCE_DEMO');
    expect(r.ready).toBe(false);
  });
});

describe('getAnalysisReadiness — downstream fail-closed contract', () => {
  test('not ready → structured UNAVAILABLE result with reason (no fabricated data)', async () => {
    const r = await getAnalysisReadiness({ symbol: SYMBOL, now: () => FIXED_NOW_MS });
    expect(r.ready).toBe(false);
    expect(r.qualityState).toBe('UNAVAILABLE');
    if (!('reason' in r)) throw new Error('expected unavailable shape');
    expect(r.reason).toContain('not analysis-ready');
    expect(Array.isArray(r.errorCodes)).toBe(true);
  });

  test('ready → full readiness result returned', async () => {
    await seedTf('M5');
    await seedTf('M15');
    await seedTf('H1');
    await seedTf('H4');
    await seedTick(10);
    const r = await getAnalysisReadiness({ symbol: SYMBOL, now: () => FIXED_NOW_MS });
    expect(r.ready).toBe(true);
    expect('timeframes' in r && r.timeframes.length).toBe(4);
  });
});
