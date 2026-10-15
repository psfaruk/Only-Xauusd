/**
 * AUTOMATED TESTS — Analysis Readiness Gate (Phase 4, spec §9 Readiness).
 * Exercises the full service path (Phase 3 quality → loader → gate) against
 * the isolated test database with the fixed clock.
 *
 * MOCK DISCLOSURE: every candle/tick below is SYNTHETIC (makeBars helper) —
 * never real broker data. No bridge is contacted at any point.
 */
import '../market/helpers/setup';
import { beforeEach, describe, expect, test } from 'bun:test';

import { db } from '@/lib/db';
import { runAnalysisService } from '@/lib/analysis/service';
import type { Timeframe } from '@/lib/market/types';
import { TIMEFRAME_SECONDS } from '@/lib/market/types';
import { makeBars } from '../market/helpers/mock-bridge';
import { FIXED_NOW_MS, FIXED_NOW_SEC, fixedNow } from '../market/helpers/setup';

const SYMBOL = 'XAUUSDm';
const ALL_TFS: Timeframe[] = ['M5', 'M15', 'H1', 'H4'];

// ---------------------------------------------------------------------------
// Seed helpers (SYNTHETIC data only)
// ---------------------------------------------------------------------------

interface SeedOpts {
  source?: string;
  formingLast?: boolean;
  holeAtBarAgo?: number;
  count?: number;
  lastOpenSec?: number;
  status?: 'VALID' | 'WARNING' | 'INVALID';
  nanRow?: boolean;
}

async function seedTf(tf: Timeframe, o: SeedOpts = {}) {
  const count = o.count ?? 240;
  const lastOpen = o.lastOpenSec ?? FIXED_NOW_SEC - TIMEFRAME_SECONDS[tf];
  const bars = makeBars(TIMEFRAME_SECONDS[tf], count, lastOpen, {
    forming: o.formingLast ?? false,
    holeAtOffsets: o.holeAtBarAgo !== undefined ? [o.holeAtBarAgo] : [],
  });
  await db.marketCandle.createMany({
    data: bars.map((b) => ({
      symbol: SYMBOL,
      timeframe: tf,
      candleTimeUtc: new Date(b.t * 1000),
      open: b.o.toFixed(2),
      high: b.h.toFixed(2),
      low: b.l.toFixed(2),
      close: o.nanRow === true ? 'NaN' : b.c.toFixed(2), // corrupt-text injection
      tickVolume: b.v ?? null,
      spread: null,
      source: o.source ?? 'bridge-mt5',
      isForming: b.f === 1,
      validationStatus: o.status ?? 'VALID',
      receivedAtUtc: new Date(FIXED_NOW_MS),
    })),
  });
  if (o.nanRow === true) {
    // one extra row whose decimal text is corrupt ('NaN') — re-validation must
    // exclude it and block, never feed NaN into the engine.
    await db.marketCandle.create({
      data: {
        symbol: SYMBOL,
        timeframe: tf,
        candleTimeUtc: new Date((lastOpen + TIMEFRAME_SECONDS[tf]) * 1000),
        open: '2650.00',
        high: '2650.00',
        low: '2649.00',
        close: 'NaN',
        tickVolume: null,
        spread: null,
        source: 'bridge-mt5',
        isForming: false,
        validationStatus: 'VALID',
        receivedAtUtc: new Date(FIXED_NOW_MS),
      },
    });
  }
}

async function seedTick(ageSec = 10) {
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
      source: 'bridge-mt5',
      validationStatus: 'VALID',
    },
    update: {
      bid: '2650.10',
      ask: '2650.50',
      tickTimeUtc: new Date((FIXED_NOW_SEC - ageSec) * 1000),
      receivedAtUtc: new Date(FIXED_NOW_MS),
      source: 'bridge-mt5',
      validationStatus: 'VALID',
    },
  });
}

async function seedSpec() {
  await db.symbolSpec.upsert({
    where: { symbol: SYMBOL },
    create: {
      symbol: SYMBOL,
      digits: 2,
      point: '0.01',
      source: 'bridge-mt5',
      verifiedFields: JSON.stringify(['digits']),
      meta: JSON.stringify({ note: 'test spec (synthetic)' }),
      lastVerifiedAt: new Date(FIXED_NOW_MS),
    },
    update: { digits: 2, lastVerifiedAt: new Date(FIXED_NOW_MS) },
  });
}

beforeEach(async () => {
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
  await db.dataQualityIssue.deleteMany();
  await db.syncRun.deleteMany();
  await db.analysisRun.deleteMany();
  await db.systemEvent.deleteMany({ where: { category: 'analysis' } });
});

// ---------------------------------------------------------------------------
// The golden path
// ---------------------------------------------------------------------------

describe('readiness — valid closed-candle data → COMPLETED', () => {
  test('all four timeframes analysed; structure + indicators + context present; persisted honestly', async () => {
    for (const tf of ALL_TFS) await seedTf(tf);
    await seedTick();
    await seedSpec();

    const outcome = await runAnalysisService({ now: fixedNow });
    expect(outcome.status).toBe('COMPLETED');
    const r = outcome.result;

    expect(r.status).toBe('COMPLETED');
    expect(r.purpose).toBe('deterministic-technical-analysis-not-a-signal');
    expect(r.engineVersion).toBe('4.0.0');
    expect(r.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(r.calculationConfig.engineVersion).toBe('4.0.0');
    expect(r.calculationConfig.breakBasis).toBe('close');

    for (const tf of ALL_TFS) {
      expect(r.readiness.find((x) => x.timeframe === tf)?.state).toBe('READY');
      const a = r.perTimeframe?.[tf];
      expect(a).toBeDefined();
      expect(a!.candleCount).toBe(240);
      expect(a!.structure.trend).toBeTruthy();
      expect(a!.structure.events).toBeDefined();
      expect(a!.indicators.ema20?.last?.value).toBeDefined();
      expect(a!.indicators.ema50?.last?.value).toBeDefined();
      expect(a!.indicators.ema200?.last?.value).toBeDefined();
      expect(a!.indicators.ema200?.warmupBars).toBe(200);
      const rsi = a!.indicators.rsi14?.last?.value;
      expect(rsi).toBeGreaterThanOrEqual(0);
      expect(rsi!).toBeLessThanOrEqual(100);
      expect(a!.indicators.atr14?.last?.value).toBeGreaterThan(0);
      const adx = a!.indicators.adx14?.last?.value;
      expect(adx).toBeGreaterThanOrEqual(0);
      expect(adx!).toBeLessThanOrEqual(100);
      expect(a!.indicatorIssues).toEqual([]);
    }

    // Multi-timeframe context is descriptive ONLY — no signal language.
    expect(r.timeframeContext?.disclaimer).toBe('descriptive-only-not-a-signal');
    expect(['aligned-bullish', 'aligned-bearish', 'mixed', 'unclear']).toContain(r.timeframeContext?.alignment ?? '(none)');

    // Honest persistence.
    const row = await db.analysisRun.findFirst({ where: { id: outcome.runId ?? undefined } });
    expect(row?.status).toBe('completed');
    expect(row?.inputFingerprint).toBe(r.inputFingerprint);
    const inputSnap = JSON.parse(row?.input ?? '{}');
    expect(inputSnap.perTimeframe.M5.candles.length).toBe(240);
    expect(inputSnap.perTimeframe.M5.candles[0].o).toMatch(/^\d+\.\d{2}$/); // exact decimal text
    const audit = await db.systemEvent.findFirst({ where: { category: 'analysis', code: 'ANALYSIS_RUN_COMPLETED' } });
    expect(audit).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Blocked paths — no data, no analysis. Ever.
// ---------------------------------------------------------------------------

describe('readiness — blocked paths (fail closed)', () => {
  test('empty database → BLOCKED DATA_MISSING; nothing fabricated', async () => {
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('DATA_MISSING');
    expect(outcome.result.perTimeframe).toBeUndefined(); // structure NEVER invented
    expect(outcome.result.timeframeContext).toBeUndefined();
    const row = await db.analysisRun.findFirst({ orderBy: { startedAt: 'desc' } });
    expect(row?.status).toBe('blocked');
  });

  test('stale tick → BLOCKED DATA_STALE + TICK_STALE', async () => {
    await seedTf('M5');
    await seedTick(3600); // 1 h old ≫ 120 s threshold
    await seedSpec();
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('DATA_STALE');
    expect(outcome.result.reasonCodes).toContain('TICK_STALE');
  });

  test('stale candles → BLOCKED DATA_STALE (candles 2 h old ≫ 900 s threshold)', async () => {
    await seedTf('M5', { lastOpenSec: FIXED_NOW_SEC - 7200 });
    await seedTick();
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('DATA_STALE');
  });

  test('demo-labelled source → BLOCKED DEMO_DATA_BLOCKED + SOURCE_DEMO (both layers agree)', async () => {
    await seedTf('M5', { source: 'bridge-demo' });
    await seedTick();
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('DEMO_DATA_BLOCKED');
    expect(outcome.result.reasonCodes).toContain('SOURCE_DEMO');
  });

  test('insufficient warm-up history (100 < 220) → BLOCKED INSUFFICIENT_DATA', async () => {
    await seedTf('M5', { count: 100 });
    await seedTick();
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('INSUFFICIENT_DATA');
    const entry = outcome.result.readiness.find((x) => x.timeframe === 'M5');
    expect(entry?.closedCandles).toBe(100);
    expect(entry?.requiredMinBars).toBe(220);
  });

  test('hole in the analysis window (Wednesday morning) → BLOCKED GAP_IN_ANALYSIS_WINDOW', async () => {
    await seedTf('M5', { holeAtBarAgo: 50 }); // ≈ Wed 07:45 — outside closure envelopes
    await seedTick();
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('GAP_IN_ANALYSIS_WINDOW');
    expect(outcome.result.reasonCodes).toContain('DATA_INVALID');
  });

  test('pre-existing INVALID row → BLOCKED DATA_INVALID (defensive; never analysed)', async () => {
    await seedTf('M5');
    await db.marketCandle.create({
      data: {
        symbol: SYMBOL,
        timeframe: 'M5',
        candleTimeUtc: new Date((FIXED_NOW_SEC - 600 * 300) * 1000), // far outside the window
        open: '1.00',
        high: '2.00',
        low: '0.50',
        close: '1.50',
        source: 'bridge-mt5',
        isForming: false,
        validationStatus: 'INVALID',
        receivedAtUtc: new Date(FIXED_NOW_MS),
      },
    });
    await seedTick();
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('DATA_INVALID');
    const entry = outcome.result.readiness.find((x) => x.timeframe === 'M5');
    expect(entry?.errorCodes).toContain('DATA_INVALID');
  });

  test("corrupt 'NaN' decimal text → BLOCKED DATA_INVALID (read-time re-validation)", async () => {
    await seedTf('M5', { nanRow: true });
    await seedTick();
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('DATA_INVALID');
  });

  test('forming candle excluded from the window (and the run still completes)', async () => {
    await seedTf('M5', { count: 241, formingLast: true });
    await seedTick();
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.result.inputData.perTimeframe.M5.formingExcluded).toBe(1);
    expect(outcome.result.inputData.perTimeframe.M5.closedCandles).toBe(240); // 241 − 1 forming
  });

  test('unsupported symbol → BLOCKED SYMBOL_NOT_ALLOWED (defense in depth)', async () => {
    const outcome = await runAnalysisService({ symbol: 'GOLD', now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('SYMBOL_NOT_ALLOWED');
  });

  test('unsupported timeframe → BLOCKED TIMEFRAME_NOT_ALLOWED', async () => {
    const outcome = await runAnalysisService({ timeframes: ['M7' as Timeframe], now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('TIMEFRAME_NOT_ALLOWED');
  });

  test('missing higher timeframe: H1 absent → BLOCKED; absence reported per timeframe', async () => {
    await seedTf('M5');
    await seedTick();
    const outcome = await runAnalysisService({ timeframes: ['M5', 'H1'], now: fixedNow });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.result.reasonCodes).toContain('DATA_MISSING');
    const m5 = outcome.result.readiness.find((x) => x.timeframe === 'M5');
    const h1 = outcome.result.readiness.find((x) => x.timeframe === 'H1');
    expect(m4State(m5)).toBe('READY');
    expect(m4State(h1)).toBe('BLOCKED');
    expect(h1?.errorCodes).toContain('DATA_MISSING');
    expect(outcome.result.perTimeframe).toBeUndefined(); // NO partial analysis was fabricated
  });
});

function m4State(entry: { state: string } | undefined): string {
  return entry?.state ?? 'MISSING-ENTRY';
}
