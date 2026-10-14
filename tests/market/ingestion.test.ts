/**
 * AUTOMATED TESTS — ingestion service (Phase 3, spec Step 8).
 * Cases covered: 4 duplicate upsert idempotency, 12 partial bridge response,
 * 13 bridge timeout + recovery, 14 database transaction failure,
 * 16 bounded historical backfill, 17 no fabricated data when upstream is
 * unavailable — plus demo-source skip, allowlist enforcement, forming-bar
 * persistence, and persisted session-aware gap issues.
 *
 * ALL BRIDGE RESPONSES HERE ARE MOCKS (tests/market/helpers/mock-bridge.ts).
 * Synthetic OHLC values only — never real broker data.
 */
import './helpers/setup';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PrismaClient } from '@prisma/client';

import { db } from '@/lib/db';
import { createBridgeClient } from '@/lib/market/bridge-client';
import { runSync, computeRequestLimit } from '@/lib/market/ingestion';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import { defaultMockState, makeBars, startMockBridge } from './helpers/mock-bridge';
import { FIXED_NOW_SEC, fixedNow } from './helpers/setup';

const M5 = TIMEFRAME_SECONDS.M5;
const SYMBOL = 'XAUUSDm';
const ALL_TFS: Timeframe[] = ['M5', 'M15', 'H1', 'H4'];

let mock: Awaited<ReturnType<typeof startMockBridge>> | null = null;

function mockClient(overrides: Parameters<typeof createBridgeClient>[0] = {}) {
  if (!mock) throw new Error('mock bridge not started');
  return createBridgeClient({
    baseUrl: mock.url,
    token: 'mock-key',
    timeoutMs: 2_000,
    maxRetries: 0,
    ...overrides,
  });
}

function seedCandles(tf: Timeframe, forming = true) {
  const lastOpen = FIXED_NOW_SEC - M5; // newest closed bar 5 minutes ago…
  const bars = makeBars(TIMEFRAME_SECONDS[tf], 100, lastOpen, { forming });
  return { bars, lastOpen };
}

beforeEach(async () => {
  // Isolated data per test (shared schema, cleaned tables).
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
  await db.dataQualityIssue.deleteMany();
  await db.syncRun.deleteMany();
  await db.systemEvent.deleteMany({ where: { category: 'market' } });
});

afterAll(() => {
  mock?.stop();
});

describe('ingestion — happy path + idempotency (case 4)', () => {
  beforeAll(async () => {
    mock = await startMockBridge();
    const { bars } = seedCandles('M5');
    mock.state.candles.M5 = bars;
    mock.state.quote = { bid: 2650.1, ask: 2650.5, ts: FIXED_NOW_SEC - 10 };
  });

  test('first run inserts; second run with identical bars only updates (idempotent)', async () => {
    const bridge = mockClient();
    const run1 = await runSync({ bridge, db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(run1.status).toBe('success');
    expect(run1.inserted).toBe(100);
    expect(run1.updated).toBe(0);
    expect(await db.marketCandle.count({ where: { symbol: SYMBOL, timeframe: 'M5' } })).toBe(100);

    const run2 = await runSync({ bridge, db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(run2.status).toBe('success');
    expect(run2.inserted).toBe(0);
    expect(run2.updated).toBe(100); // same keys → updates, no duplicates
    expect(await db.marketCandle.count({ where: { symbol: SYMBOL, timeframe: 'M5' } })).toBe(100);

    // Row-level shape: forming stored as forming, closed as closed, exact decimal text.
    const closedRow = await db.marketCandle.findFirstOrThrow({
      where: { symbol: SYMBOL, timeframe: 'M5', isForming: false },
      orderBy: { candleTimeUtc: 'asc' },
    });
    const oldestBar = (mock?.state.candles.M5 ?? [])[0];
    expect(oldestBar).toBeDefined();
    expect(closedRow.candleTimeUtc.getTime()).toBe(oldestBar.t * 1000);
    expect(closedRow.open).toBe(oldestBar.o.toFixed(2));
    expect(closedRow.source).toBe('bridge-mt5');
    expect(closedRow.validationStatus).toBe('VALID');
    const formingRows = await db.marketCandle.count({ where: { symbol: SYMBOL, timeframe: 'M5', isForming: true } });
    expect(formingRows).toBe(1);
  });

  test('latest tick upserted once per symbol; spec stores verified digits', async () => {
    const bridge = mockClient();
    await runSync({ bridge, db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    const tick = await db.marketLatestTick.findUniqueOrThrow({ where: { symbol: SYMBOL } });
    expect(tick.bid).toBe('2650.10');
    expect(tick.ask).toBe('2650.50');
    expect(tick.spread).toBe('0.40');
    expect(tick.spreadPoints).toBe('40.0');
    expect(tick.validationStatus).toBe('VALID');

    const spec = await db.symbolSpec.findUniqueOrThrow({ where: { symbol: SYMBOL } });
    expect(spec.digits).toBe(2);
    expect(JSON.parse(spec.verifiedFields)).toEqual(['digits']); // ONLY verified fields claimed
    expect(spec.point).toBe('0.01'); // derived 10^-digits (documented as derived in meta)
  });
});

describe('ingestion — duplicate keys inside ONE bridge response', () => {
  test('duplicates counted, closed bar wins over forming, single row persisted', async () => {
    mock = mock ?? (await startMockBridge());
    const t = FIXED_NOW_SEC - 5 * M5;
    mock.state.candles.M15 = [
      { t: t - M5 * 2, o: 2650, h: 2651, l: 2649, c: 2650.5, v: 10 },
      { t, o: 2650, h: 2651, l: 2649, c: 2650.5, v: 11, f: 1 }, // duplicate time (forming)
      { t, o: 2650.2, h: 2651.2, l: 2649.2, c: 2650.7, v: 12 }, // duplicate time (closed)
    ];
    const run = await runSync({ bridge: mockClient(), db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M15'] });
    expect(run.status).toBe('success');
    expect(run.duplicates).toBe(1);
    expect(await db.marketCandle.count({ where: { symbol: SYMBOL, timeframe: 'M15' } })).toBe(2);
    const dupRow = await db.marketCandle.findUniqueOrThrow({
      where: { symbol_timeframe_candleTimeUtc: { symbol: SYMBOL, timeframe: 'M15', candleTimeUtc: new Date(t * 1000) } },
    });
    expect(dupRow.isForming).toBe(false); // closed duplicate won deterministically
  });
});

describe('ingestion — partial bridge response (case 12)', () => {
  test('one timeframe failing 503 → run is PARTIAL, never success; others still stored', async () => {
    mock = mock ?? (await startMockBridge());
    const { bars: m5 } = seedCandles('M5');
    const { bars: h1 } = seedCandles('H1');
    mock.state.candles.M5 = m5;
    mock.state.candles.H1 = h1;
    mock.state.failTfs = { H1: 503 };

    const run = await runSync({ bridge: mockClient(), db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5', 'H1'] });
    expect(run.status).toBe('partial');
    expect(run.errorCode).toBe('BRIDGE_HTTP_ERROR');
    const h1Outcome = run.perTimeframe.find((t) => t.timeframe === 'H1');
    expect(h1Outcome?.status).toBe('failed');
    expect(h1Outcome?.errorCode).toBe('BRIDGE_HTTP_ERROR');
    expect(await db.marketCandle.count({ where: { timeframe: 'M5' } })).toBe(100);
    expect(await db.marketCandle.count({ where: { timeframe: 'H1' } })).toBe(0);

    const row = await db.syncRun.findFirstOrThrow({ where: { symbol: SYMBOL }, orderBy: { startedAtUtc: 'desc' } });
    expect(row.status).toBe('partial'); // incomplete runs are never marked successful
    expect(row.errorCode).toBe('BRIDGE_HTTP_ERROR');
  });
});

describe('ingestion — bridge timeout and recovery (case 13)', () => {
  test('candles endpoint slower than timeout → bounded retries fail closed, then recovery succeeds', async () => {
    mock = mock ?? (await startMockBridge());
    const { bars } = seedCandles('M5');
    mock.state.candles.M5 = bars;
    mock.state.failTfs = {};

    // Phase A: candles delayed beyond timeout (120ms), 1 retry → BRIDGE_TIMEOUT.
    mock.state.delayCandlesMs = 500;
    const slowClient = mockClient({ timeoutMs: 120, maxRetries: 1 });
    const failed = await runSync({ bridge: slowClient, db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('BRIDGE_TIMEOUT');
    expect(failed.perTimeframe[0].errorCode).toBe('BRIDGE_TIMEOUT');
    expect(await db.marketCandle.count()).toBe(0); // nothing stored on timeout

    // Phase B: bridge recovers → next run succeeds.
    mock.state.delayCandlesMs = 0;
    const okClient = mockClient({ timeoutMs: 2_000, maxRetries: 1 });
    const recovered = await runSync({ bridge: okClient, db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(recovered.status).toBe('success');
    expect(recovered.inserted).toBe(100);
  });
});

describe('ingestion — database transaction failure (case 14)', () => {
  test('sabotaged $transaction → tf fails with DB_TX_FAILED, nothing persisted, run recorded failed', async () => {
    mock = mock ?? (await startMockBridge());
    const { bars } = seedCandles('M5');
    mock.state.candles.M5 = bars;
    mock.state.failTfs = {};

    const sabotaged = new Proxy(db, {
      get(target, prop) {
        if (prop === '$transaction') {
          return () => Promise.reject(new Error('MOCK simulated transaction failure'));
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as PrismaClient;

    const run = await runSync({ bridge: mockClient(), db: sabotaged, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('DB_TX_FAILED');
    expect(await db.marketCandle.count()).toBe(0); // atomic rollback semantics: nothing stored
    const row = await db.syncRun.findFirstOrThrow({ where: { symbol: SYMBOL }, orderBy: { startedAtUtc: 'desc' } });
    expect(row.status).toBe('failed');
    const issues = await db.dataQualityIssue.findMany({ where: { errorCode: 'DB_TX_FAILED' } });
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

describe('ingestion — bounded historical backfill (case 16)', () => {
  test('range beyond MARKET_BACKFILL_MAX_DAYS is rejected before any fetch', () => {
    const limit = computeRequestLimit(
      {
        mode: 'backfill',
        symbol: SYMBOL,
        timeframes: ['M5'],
        rangeStartUtc: new Date((FIXED_NOW_SEC - 400 * 86_400) * 1000),
        rangeEndUtc: new Date(FIXED_NOW_SEC * 1000),
      },
      'M5',
    );
    expect(limit.error).toBe('RANGE_TOO_LARGE');
    expect(limit.limit).toBe(0);
  });

  test('range exceeding per-symbol bar budget is rejected per timeframe', () => {
    const limit = computeRequestLimit(
      {
        mode: 'backfill',
        symbol: SYMBOL,
        timeframes: ['M5'],
        rangeStartUtc: new Date((FIXED_NOW_SEC - 30 * 86_400) * 1000), // 30 days of M5 = 8640 bars > 5000
        rangeEndUtc: new Date(FIXED_NOW_SEC * 1000),
      },
      'M5',
    );
    expect(limit.error).toBe('RANGE_TOO_LARGE');
  });

  test('valid bounded range runs and honestly records requested vs received', async () => {
    mock = mock ?? (await startMockBridge());
    const { bars } = seedCandles('M5'); // only 100 bars available
    mock.state.candles.M5 = bars;
    mock.state.failTfs = {};
    const run = await runSync(
      { bridge: mockClient(), db, now: fixedNow },
      {
        mode: 'backfill',
        symbol: SYMBOL,
        timeframes: ['M5'],
        rangeStartUtc: new Date((FIXED_NOW_SEC - 86_400) * 1000), // 1 day = 288 M5 bars requested
        rangeEndUtc: new Date(FIXED_NOW_SEC * 1000),
      },
    );
    expect(run.status).toBe('success');
    expect(run.requested).toBe(288);
    expect(run.received).toBe(100); // mock had only 100 — recorded honestly
    expect(run.inserted).toBe(100);
  });

  test('backfill without a range is rejected (BAD_REQUEST)', async () => {
    mock = mock ?? (await startMockBridge());
    const run = await runSync(
      { bridge: mockClient(), db, now: fixedNow },
      { mode: 'backfill', symbol: SYMBOL, timeframes: ['M5'] },
    );
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('BAD_REQUEST');
  });
});

describe('ingestion — upstream unavailable: fail closed, nothing fabricated (case 17)', () => {
  test('unreachable bridge → failed run, zero rows, honest SyncRun + readiness stays unavailable', async () => {
    const deadClient = createBridgeClient({
      baseUrl: 'http://127.0.0.1:9', // closed port — connection refused
      timeoutMs: 300,
      maxRetries: 0,
    });
    const run = await runSync({ bridge: deadClient, db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ALL_TFS });
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('BRIDGE_UNREACHABLE');
    expect(run.received).toBe(0);
    // NOTHING stored — no fabricated candles, ticks or specs:
    expect(await db.marketCandle.count()).toBe(0);
    expect(await db.marketLatestTick.count()).toBe(0);
    expect(await db.symbolSpec.count()).toBe(0);
    const row = await db.syncRun.findFirstOrThrow({ where: { symbol: SYMBOL }, orderBy: { startedAtUtc: 'desc' } });
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('BRIDGE_UNREACHABLE');
  });

  test('bridge auth rejection → BRIDGE_AUTH_FAILED, fail closed', async () => {
    mock = mock ?? (await startMockBridge());
    mock.state.requireKey = true;
    const noKeyClient = mockClient({ token: '' });
    const run = await runSync({ bridge: noKeyClient, db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('BRIDGE_AUTH_FAILED');
    expect(await db.marketCandle.count()).toBe(0);
    mock.state.requireKey = false;
  });
});

describe('ingestion — demo source policy', () => {
  test('demo feed is skipped and labelled unless explicitly opted in', async () => {
    mock = mock ?? (await startMockBridge());
    const { bars } = seedCandles('M5');
    mock.state.candles.M5 = bars;
    mock.state.source = 'demo'; // the bridge's honest demo feed
    const run = await runSync({ bridge: mockClient(), db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(run.status).toBe('skipped');
    expect(run.errorCode).toBe('SOURCE_DEMO');
    expect(await db.marketCandle.count()).toBe(0); // nothing ingested from demo by default
    const row = await db.syncRun.findFirstOrThrow({ where: { symbol: SYMBOL }, orderBy: { startedAtUtc: 'desc' } });
    expect(row.status).toBe('skipped');
    expect(row.errorCode).toBe('SOURCE_DEMO');
    mock.state.source = 'mt5';
  });

  test('disconnected bridge → SOURCE_DISCONNECTED, fail closed', async () => {
    mock = mock ?? (await startMockBridge());
    mock.state.connected = false;
    mock.state.source = 'disconnected';
    const run = await runSync({ bridge: mockClient(), db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('SOURCE_DISCONNECTED');
    expect(await db.marketCandle.count()).toBe(0);
    mock.state.connected = true;
    mock.state.source = 'mt5';
  });
});

describe('ingestion — allowlists and symbol checks', () => {
  test('non-allowlisted symbol is refused and recorded (SYMBOL_NOT_ALLOWED)', async () => {
    mock = mock ?? (await startMockBridge());
    const run = await runSync({ bridge: mockClient(), db, now: fixedNow }, { mode: 'manual', symbol: 'EURUSD', timeframes: ['M5'] });
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('SYMBOL_NOT_ALLOWED');
    expect(run.runId).not.toBe('none');
  });

  test('symbol missing from the bridge → SYMBOL_NOT_FOUND (fail closed)', async () => {
    mock = mock ?? (await startMockBridge());
    mock.state.symbols = ['XAUUSD', 'GOLD']; // XAUUSDm not served
    const run = await runSync({ bridge: mockClient(), db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('SYMBOL_NOT_FOUND');
    mock.state.symbols = defaultMockState().symbols;
  });
});

describe('ingestion — persisted session-aware gap issues', () => {
  test('a weekday hole in the received window records GAP_POSSIBLE issues (bounded)', async () => {
    mock = mock ?? (await startMockBridge());
    // 100 M5 bars ending Wednesday 11:55 UTC, with holes at offsets 10 and 20.
    const bars = makeBars(M5, 100, FIXED_NOW_SEC - M5, { forming: true, holeAtOffsets: [10, 20] });
    mock.state.candles.M5 = bars;
    const run = await runSync({ bridge: mockClient(), db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(run.status).toBe('success');
    const gapIssues = await db.dataQualityIssue.findMany({ where: { errorCode: 'GAP_POSSIBLE' } });
    expect(gapIssues.length).toBe(2); // both weekday holes flagged as possible gaps
    const closedIssues = await db.dataQualityIssue.count({ where: { errorCode: 'GAP_MARKET_LIKELY_CLOSED' } });
    expect(closedIssues).toBe(0); // weekday → not a closure window
  });
});

describe('ingestion — overlap guard', () => {
  test('a second concurrent run is refused with SYNC_IN_PROGRESS (never queued)', async () => {
    mock = mock ?? (await startMockBridge());
    const { bars } = seedCandles('M5');
    mock.state.candles.M5 = bars;
    mock.state.delayCandlesMs = 250; // make the first run slow
    const slowClient = mockClient({ timeoutMs: 2_000, maxRetries: 0 });

    const first = runSync({ bridge: slowClient, db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    const second = await runSync({ bridge: slowClient, db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });
    expect(second.status).toBe('failed');
    expect(second.errorCode).toBe('SYNC_IN_PROGRESS');
    const firstOutcome = await first;
    expect(firstOutcome.status).toBe('success');
    mock.state.delayCandlesMs = 0;
  });
});
