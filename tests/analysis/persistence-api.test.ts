/**
 * AUTOMATED TESTS — Analysis Persistence & API (Phase 4, spec §9 Persistence/API).
 *
 * MOCK DISCLOSURE: all data is SYNTHETIC (no bridge contacted anywhere).
 * Failure injection is done by replacing db.marketCandle.findMany with a
 * synchronously-throwing function — a real fault path, not a mocked verdict.
 */
import '../market/helpers/setup';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { db } from '@/lib/db';
import { runAnalysisService } from '@/lib/analysis/service';
import { failedAnalysisResult } from '@/lib/analysis/engine';
import { saveAnalysisRun } from '@/lib/analysis/persistence';
import { buildCalculationConfig } from '@/lib/analysis/engine';
import type { Timeframe } from '@/lib/market/types';
import { TIMEFRAME_SECONDS } from '@/lib/market/types';
import { makeBars } from '../market/helpers/mock-bridge';
import { FIXED_NOW_MS, FIXED_NOW_SEC, fixedNow } from '../market/helpers/setup';

const SYMBOL = 'XAUUSDm';
const req = (url: string, init?: RequestInit) => new Request(`http://localhost:3000${url}`, init);

async function seedReady(tf: Timeframe = 'M5') {
  const bars = makeBars(TIMEFRAME_SECONDS[tf], 240, FIXED_NOW_SEC - TIMEFRAME_SECONDS[tf], {});
  await db.marketCandle.createMany({
    data: bars.map((b) => ({
      symbol: SYMBOL,
      timeframe: tf,
      candleTimeUtc: new Date(b.t * 1000),
      open: b.o.toFixed(2),
      high: b.h.toFixed(2),
      low: b.l.toFixed(2),
      close: b.c.toFixed(2),
      tickVolume: b.v ?? null,
      spread: null,
      source: 'bridge-mt5',
      isForming: false,
      validationStatus: 'VALID',
      receivedAtUtc: new Date(FIXED_NOW_MS),
    })),
  });
  await db.marketLatestTick.upsert({
    where: { symbol: SYMBOL },
    create: {
      symbol: SYMBOL,
      bid: '2650.10',
      ask: '2650.50',
      spread: '0.40',
      spreadPoints: '40.0',
      tickTimeUtc: new Date((FIXED_NOW_SEC - 10) * 1000),
      receivedAtUtc: new Date(FIXED_NOW_MS),
      source: 'bridge-mt5',
      validationStatus: 'VALID',
    },
    update: {},
  });
  await db.symbolSpec.upsert({
    where: { symbol: SYMBOL },
    create: {
      symbol: SYMBOL,
      digits: 2,
      point: '0.01',
      source: 'bridge-mt5',
      verifiedFields: JSON.stringify(['digits']),
      meta: null,
      lastVerifiedAt: new Date(FIXED_NOW_MS),
    },
    update: {},
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

// UI-02 hermeticity fix: file-level cleanup so seeded rows never leak into
// other test files sharing this process (bun file order = readdir/inode
// order, not alphabetical — see tests/market/quality.test.ts note).
afterAll(async () => {
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
  await db.dataQualityIssue.deleteMany();
  await db.syncRun.deleteMany();
  await db.analysisRun.deleteMany();
  await db.systemEvent.deleteMany({ where: { category: 'analysis' } });
});

// ---------------------------------------------------------------------------
// Input fingerprint & reproducibility
// ---------------------------------------------------------------------------

describe('analysis — input fingerprint reproducibility', () => {
  test('same input + config + engineVersion → identical fingerprint and identical result', async () => {
    await seedReady();
    const a = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    const b = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(a.status).toBe('COMPLETED');
    expect(b.status).toBe('COMPLETED');
    expect(a.result.inputFingerprint).toBe(b.result.inputFingerprint);
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result)); // byte-identical
    expect(a.runId).not.toBe(b.runId); // two distinct honest rows
  });

  test('changed input → different fingerprint (the hash is not decorative)', async () => {
    await seedReady();
    const first = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(first.status).toBe('COMPLETED');
    // mutate one candle's close — keep the row OHLC-valid (close := its own low)
    const some = await db.marketCandle.findFirst({ where: { symbol: SYMBOL, timeframe: 'M5' } });
    await db.marketCandle.update({ where: { id: some!.id }, data: { close: some!.low } });
    const second = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    expect(second.status).toBe('COMPLETED');
    expect(second.result.inputFingerprint).not.toBe(first.result.inputFingerprint);
  });

  test('ascending order guaranteed: first candle < last candle in the loaded window', async () => {
    await seedReady();
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
    const io = outcome.result.inputData.perTimeframe.M5;
    expect(io.firstCandleTimeUtc! < io.lastCandleTimeUtc!).toBe(true);
  });

  test('duplicate (symbol, timeframe, time) is structurally impossible — DB unique key', async () => {
    await seedReady();
    let err: unknown;
    try {
      await db.marketCandle.createMany({
        data: [
          {
            symbol: SYMBOL,
            timeframe: 'M5',
            candleTimeUtc: new Date((FIXED_NOW_SEC - 999 * 300) * 1000),
            open: '1.00',
            high: '2.00',
            low: '0.50',
            close: '1.50',
            source: 'bridge-mt5',
            isForming: false,
            validationStatus: 'VALID',
            receivedAtUtc: new Date(FIXED_NOW_MS),
          },
          {
            symbol: SYMBOL,
            timeframe: 'M5',
            candleTimeUtc: new Date((FIXED_NOW_SEC - 999 * 300) * 1000), // SAME key
            open: '1.00',
            high: '2.00',
            low: '0.50',
            close: '1.50',
            source: 'bridge-mt5',
            isForming: false,
            validationStatus: 'VALID',
            receivedAtUtc: new Date(FIXED_NOW_MS),
          },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/UNIQUE/i); // “UNIQUE constraint failed: …”
  });
});

// ---------------------------------------------------------------------------
// AnalysisRun states — completed / blocked / failed
// ---------------------------------------------------------------------------

describe('analysis — AnalysisRun states are recorded honestly', () => {
  test('FAILED run: injected synchronous DB fault → status failed, bounded message, no stack trace', async () => {
    await seedReady();
    const orig = db.marketCandle.findMany.bind(db.marketCandle);
    (db.marketCandle as unknown as { findMany: unknown }).findMany = () => {
      throw new Error('injected DB fault (test)');
    };
    try {
      const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow });
      expect(outcome.status).toBe('FAILED');
      expect(outcome.result.reasonCodes).toEqual(['ANALYSIS_ERROR']);
      expect(outcome.result.failureMessage).toBe('injected DB fault (test)');
      expect(outcome.result.failureMessage!.length).toBeLessThanOrEqual(300); // bounded
      expect(outcome.result.failureMessage).not.toMatch(/at .*\(/); // no stack frames leaked
      expect(outcome.result.inputFingerprint).toBeNull();

      const row = await db.analysisRun.findFirst({ orderBy: { startedAt: 'desc' } });
      expect(row?.status).toBe('failed'); // recorded as a FAILURE — never “completed”
      expect(JSON.parse(row?.reasonCodes ?? '[]')).toEqual(['ANALYSIS_ERROR']);
      const audit = await db.systemEvent.findFirst({ where: { category: 'analysis', code: 'ANALYSIS_RUN_FAILED' } });
      expect(audit).not.toBeNull();
    } finally {
      (db.marketCandle as unknown as { findMany: unknown }).findMany = orig;
    }
  });

  test('FAILED run maps to HTTP 500 ANALYSIS_ERROR on the API surface', async () => {
    await seedReady();
    const orig = db.marketCandle.findMany.bind(db.marketCandle);
    (db.marketCandle as unknown as { findMany: unknown }).findMany = () => {
      throw new Error('injected DB fault (test)');
    };
    process.env.DATA_API_TOKEN = 'test-secret-token-123';
    try {
      const { POST } = await import('@/app/api/analysis/run/route');
      const res = await POST(
        req('/api/analysis/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-token-123' },
          body: JSON.stringify({ timeframes: ['M5'] }),
        }),
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { ok: boolean; error: { code: string; message: string }; analysis: { status: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('ANALYSIS_ERROR');
      expect(body.analysis.status).toBe('FAILED');
    } finally {
      (db.marketCandle as unknown as { findMany: unknown }).findMany = orig;
      delete process.env.DATA_API_TOKEN;
    }
  });

  test('failedAnalysisResult + saveAnalysisRun persist the failure contract', async () => {
    const cfg = buildCalculationConfig({ swingLeft: 3, swingRight: 3, minBarsPerTf: 220, maxBarsPerTf: 300 });
    const result = failedAnalysisResult(SYMBOL, ['M5'], cfg, FIXED_NOW_SEC, 'boom '.repeat(100));
    expect(result.failureMessage!.length).toBeLessThanOrEqual(300);
    const saved = await saveAnalysisRun(db, {
      result,
      inputSnapshot: { note: 'failed before snapshot — no input' },
      durationMs: 3,
      startedAtUtc: new Date(FIXED_NOW_MS),
    });
    const row = await db.analysisRun.findUnique({ where: { id: saved.id } });
    expect(row?.status).toBe('failed');
    expect(row?.inputFingerprint).toBeNull();
    expect(row?.completedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// API surface — auth, validation, blocked-through-HTTP
// ---------------------------------------------------------------------------

describe('analysis — POST /api/analysis/run', () => {
  test('without DATA_API_TOKEN the POST NEVER runs (fail closed, even with public reads ON)', async () => {
    const hadToken = process.env.DATA_API_TOKEN;
    const hadFlag = process.env.MARKET_API_PUBLIC_READS;
    delete process.env.DATA_API_TOKEN;
    process.env.MARKET_API_PUBLIC_READS = 'true'; // reads may be open — POSTs must not be
    try {
      const { POST } = await import('@/app/api/analysis/run/route');
      const res = await POST(
        req('/api/analysis/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeframes: ['M5'] }),
        }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('MARKET_API_TOKEN_NOT_CONFIGURED');
      // and no run row was created:
      expect(await db.analysisRun.count()).toBe(0);
    } finally {
      if (hadToken === undefined) delete process.env.DATA_API_TOKEN;
      else process.env.DATA_API_TOKEN = hadToken;
      if (hadFlag === undefined) delete process.env.MARKET_API_PUBLIC_READS;
      else process.env.MARKET_API_PUBLIC_READS = hadFlag;
    }
  });

  test('authed request against empty DB → HTTP 200 with analysis.status BLOCKED (the honest verdict)', async () => {
    process.env.DATA_API_TOKEN = 'test-secret-token-123';
    try {
      const { POST } = await import('@/app/api/analysis/run/route');
      const res = await POST(
        req('/api/analysis/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-token-123' },
          body: JSON.stringify({ timeframes: ['M5', 'H1'] }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        run: { id: string; status: string };
        analysis: { status: string; reasonCodes: string[]; perTimeframe?: unknown };
      };
      expect(body.ok).toBe(true);
      expect(body.analysis.status).toBe('BLOCKED');
      expect(body.analysis.reasonCodes.length).toBeGreaterThan(0);
      expect(body.analysis.perTimeframe).toBeUndefined(); // nothing fabricated
      expect(await db.analysisRun.count()).toBe(1);
    } finally {
      delete process.env.DATA_API_TOKEN;
    }
  });

  test('wrong bearer → 401 AUTH_INVALID_TOKEN', async () => {
    process.env.DATA_API_TOKEN = 'test-secret-token-123';
    try {
      const { POST } = await import('@/app/api/analysis/run/route');
      const res = await POST(
        req('/api/analysis/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
          body: JSON.stringify({ timeframes: ['M5'] }),
        }),
      );
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_INVALID_TOKEN');
    } finally {
      delete process.env.DATA_API_TOKEN;
    }
  });

  test('invalid payload (bad timeframe / bad symbol) → 400; no run executed', async () => {
    process.env.DATA_API_TOKEN = 'test-secret-token-123';
    try {
      const { POST } = await import('@/app/api/analysis/run/route');
      for (const bad of [{ timeframes: ['M7'] }, { symbol: 'GOLD' }, { timeframes: [] }, { extra: 1 }]) {
        const res = await POST(
          req('/api/analysis/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-token-123' },
            body: JSON.stringify(bad),
          }),
        );
        expect(res.status).toBe(400);
      }
      expect(await db.analysisRun.count()).toBe(0);
    } finally {
      delete process.env.DATA_API_TOKEN;
    }
  });
});

describe('analysis — GET /api/analysis/latest', () => {
  test('returns the latest run of any status, honestly labelled', async () => {
    await seedReady();
    await runAnalysisService({ timeframes: ['M5'], now: fixedNow }); // completed
    const { GET } = await import('@/app/api/analysis/latest/route');
    const res = await GET(req('/api/analysis/latest'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      latest: {
        id: string;
        status: string;
        reasonCodes: string[];
        inputFingerprint: string | null;
        analysis: { status: string; engineVersion: string } | null;
      } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.latest?.status).toBe('completed');
    expect(body.latest?.analysis?.engineVersion).toBe('4.0.0');
    expect(body.latest?.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('no runs yet → latest is null (never fabricated)', async () => {
    const { GET } = await import('@/app/api/analysis/latest/route');
    const res = await GET(req('/api/analysis/latest'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; latest: unknown };
    expect(body.latest).toBeNull();
  });

  test('token set → GET requires the bearer (401 without)', async () => {
    process.env.DATA_API_TOKEN = 'test-secret-token-123';
    try {
      const { GET } = await import('@/app/api/analysis/latest/route');
      const res = await GET(req('/api/analysis/latest'));
      expect(res.status).toBe(401);
    } finally {
      delete process.env.DATA_API_TOKEN;
    }
  });
});

// ---------------------------------------------------------------------------
// Static guarantees — no trading side effects anywhere in the analysis layer
// ---------------------------------------------------------------------------

describe('analysis — no trading/order side effects (static guarantee)', () => {
  test('src/lib/analysis contains no BUY/SELL/order/position/lot language', () => {
    const dir = '/home/z/my-project/src/lib/analysis';
    const files: string[] = [];
    (function walk(d: string) {
      for (const e of readdirSync(d)) {
        const full = join(d, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (e.endsWith('.ts')) files.push(full);
      }
    })(dir);
    expect(files.length).toBeGreaterThanOrEqual(8);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/\b(BUY|SELL|placeOrder|sendOrder|openTrade|closeTrade|modifyOrder|positionId|lotSize|lot_size)\b/.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the AnalysisRun result of a blocked run never contains fabricated structure', async () => {
    // (re-asserted at the persistence layer, not just in-memory)
    const outcome = await runAnalysisService({ timeframes: ['M5'], now: fixedNow }); // empty DB
    expect(outcome.status).toBe('BLOCKED');
    const row = await db.analysisRun.findFirst({ orderBy: { startedAt: 'desc' } });
    const parsed = JSON.parse(row?.result ?? '{}');
    expect(parsed.perTimeframe).toBeUndefined();
    expect(parsed.timeframeContext).toBeUndefined();
    expect(parsed.status).toBe('BLOCKED');
  });
});
