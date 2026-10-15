/**
 * AUTOMATED TESTS — Data API routes (Phase 3, spec Step 8).
 * Cases covered: 15 authentication failure, 11 unsupported symbol/timeframe
 * via the HTTP surface, bounded query limits/ranges, forming-candle
 * exclusion, and 18 the NO-TRADING-ENDPOINT guarantee (static scan).
 *
 * Route handlers are invoked directly with crafted Request objects against
 * the isolated test DB. No real bridge involved — status responses use the
 * fail-closed path (bridge not configured in the test environment).
 */
import './helpers/setup';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { db } from '@/lib/db';
import { FIXED_NOW_SEC, FIXED_NOW_MS } from './helpers/setup';
import { makeBars } from './helpers/mock-bridge';

const SYMBOL = 'XAUUSDm';
const req = (url: string, init?: RequestInit) => new Request(`http://localhost:3000${url}`, init);

async function seedCandles() {
  await db.marketCandle.deleteMany();
  const bars = makeBars(300, 30, FIXED_NOW_SEC - 300, { forming: true });
  for (const b of bars) {
    await db.marketCandle.create({
      data: {
        symbol: SYMBOL,
        timeframe: 'M5',
        candleTimeUtc: new Date(b.t * 1000),
        open: b.o.toFixed(2),
        high: b.h.toFixed(2),
        low: b.l.toFixed(2),
        close: b.c.toFixed(2),
        tickVolume: b.v ?? null,
        spread: null,
        source: 'bridge-mt5',
        isForming: b.f === 1,
        validationStatus: 'VALID',
        receivedAtUtc: new Date(FIXED_NOW_MS),
      },
    });
  }
  return bars;
}

describe('GET /api/data/candles', () => {
  test('returns seeded CLOSED candles ascending; forming excluded by default', async () => {
    const bars = await seedCandles();
    const { GET } = await import('@/app/api/data/candles/route');
    const res = await GET(req(`/api/data/candles?symbol=${SYMBOL}&tf=M5&limit=50`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number; candles: Array<{ candleTimeUtc: string; open: string; isForming: boolean }> };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(bars.length - 1); // forming bar excluded
    expect(body.candles.every((c) => c.isForming === false)).toBe(true);
    expect(body.candles[0].candleTimeUtc < body.candles[body.candles.length - 1].candleTimeUtc).toBe(true);
    expect(body.candles[0].open).toBe(bars[0].o.toFixed(2)); // exact decimal text
  });

  test('includeForming=true surfaces the clearly-marked forming bar', async () => {
    await seedCandles();
    const { GET } = await import('@/app/api/data/candles/route');
    const res = await GET(req(`/api/data/candles?symbol=${SYMBOL}&tf=M5&limit=50&includeForming=true`));
    const body = (await res.json()) as { count: number; candles: Array<{ isForming: boolean }> };
    expect(body.count).toBe(30);
    expect(body.candles.some((c) => c.isForming === true)).toBe(true);
  });

  test('11. unsupported symbol → 400 with stable code (allowlist enforced)', async () => {
    const { GET } = await import('@/app/api/data/candles/route');
    const res = await GET(req('/api/data/candles?symbol=EURUSD&tf=M5'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message?: string; detail?: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message ?? body.error.detail ?? '').toContain('allowlist');
  });

  test('11b. unsupported timeframe → 400', async () => {
    const { GET } = await import('@/app/api/data/candles/route');
    const res = await GET(req(`/api/data/candles?symbol=${SYMBOL}&tf=D1`));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message?: string; detail?: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message ?? body.error.detail ?? '').toContain('timeframe');
  });

  test('limit above 1000 → 400 (bounded)', async () => {
    const { GET } = await import('@/app/api/data/candles/route');
    const res = await GET(req(`/api/data/candles?symbol=${SYMBOL}&tf=M5&limit=5000`));
    expect(res.status).toBe(400);
  });

  test('range over 90 days → 400 (bounded)', async () => {
    const { GET } = await import('@/app/api/data/candles/route');
    const from = new Date(FIXED_NOW_MS - 91 * 86_400_000).toISOString();
    const to = new Date(FIXED_NOW_MS).toISOString();
    const res = await GET(req(`/api/data/candles?symbol=${SYMBOL}&tf=M5&from=${from}&to=${to}`));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('90 days');
  });
});

describe('GET /api/data/status & /api/data/quality (fail-closed path)', () => {
  test('status reports bridge not configured and readiness NOT ready — never fabricated', async () => {
    const { GET } = await import('@/app/api/data/status/route');
    const res = await GET(req('/api/data/status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      bridge: { configured: boolean; reachable: boolean; error: { code: string } | null };
      readiness: { ready: boolean; qualityState: string; purpose: string };
    };
    expect(body.ok).toBe(true);
    expect(body.bridge.configured).toBe(false);
    expect(body.bridge.reachable).toBe(false);
    expect(body.bridge.error?.code).toBe('BRIDGE_NOT_CONFIGURED');
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.purpose).toBe('data-readiness-only-not-trade-recommendation');
  });

  test('quality returns readiness + thresholds + bounded open issues', async () => {
    const { GET } = await import('@/app/api/data/quality/route');
    const res = await GET(req('/api/data/quality'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; thresholds: { timeframes: Record<string, number> }; openIssues: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.thresholds.timeframes.M5).toBeGreaterThan(0);
    expect(Array.isArray(body.openIssues)).toBe(true);
  });
});

describe('GET /api/data/sync-status & /api/data/latest', () => {
  test('sync-status returns run history and aggregates', async () => {
    await db.syncRun.deleteMany();
    await db.syncRun.create({
      data: {
        mode: 'manual', source: 'none', symbol: SYMBOL, timeframes: '["M5"]',
        status: 'failed', errorCode: 'BRIDGE_NOT_CONFIGURED', errorMessage: 'test',
      },
    });
    const { GET } = await import('@/app/api/data/sync-status/route');
    const res = await GET(req('/api/data/sync-status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runs: Array<{ status: string }>; aggregates: { total: number } };
    expect(body.ok).toBe(true);
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].status).toBe('failed');
    expect(body.aggregates.total).toBe(1);
  });

  test('latest returns null tick honestly when none stored', async () => {
    await db.marketLatestTick.deleteMany();
    // Phase 8 isolation fix: earlier tests in this file seed SymbolSpec rows;
    // this case asserts the "nothing stored" state, so clear the spec table
    // too — otherwise the test is order-dependent.
    await db.symbolSpec.deleteMany();
    const { GET } = await import('@/app/api/data/latest/route');
    const res = await GET(req('/api/data/latest'));
    const body = (await res.json()) as { ok: boolean; tick: unknown; spec: unknown };
    expect(body.ok).toBe(true);
    expect(body.tick).toBeNull();
    expect(body.spec).toBeNull();
  });
});

describe('POST /api/data/sync (case 15-adjacent + validation)', () => {
  // Phase 4 hardening: POST triggers require DATA_API_TOKEN ALWAYS. These
  // route-level tests set the token so the guard passes and the ORIGINAL
  // validation/fail-closed behavior below the guard is still exercised.
  const TOKEN = 'test-secret-token-123';
  /** Merge extra headers with the Authorization header. */
  const authed = (headers: Record<string, string> = {}): { headers: Record<string, string> } => ({
    headers: { ...headers, Authorization: `Bearer ${TOKEN}` },
  });

  test('unauthenticated POST is refused before any work (fail closed, no bypass)', async () => {
    const hadToken = process.env.DATA_API_TOKEN;
    const hadFlag = process.env.MARKET_API_PUBLIC_READS;
    delete process.env.DATA_API_TOKEN;
    process.env.MARKET_API_PUBLIC_READS = 'true'; // even with public reads ON…
    try {
      const { POST } = await import('@/app/api/data/sync/route');
      const res = await POST(
        req('/api/data/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: SYMBOL, mode: 'manual' }),
        }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; error: { code: string; message?: string; detail?: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('MARKET_API_TOKEN_NOT_CONFIGURED');
    } finally {
      if (hadToken === undefined) delete process.env.DATA_API_TOKEN;
      else process.env.DATA_API_TOKEN = hadToken;
      if (hadFlag === undefined) delete process.env.MARKET_API_PUBLIC_READS;
      else process.env.MARKET_API_PUBLIC_READS = hadFlag;
    }
  });

  test('invalid body (bad timeframe) → 400; no run executed', async () => {
    process.env.DATA_API_TOKEN = TOKEN;
    try {
      const { POST } = await import('@/app/api/data/sync/route');
      const res = await POST(
        req('/api/data/sync', {
          method: 'POST',
          ...authed({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ symbol: SYMBOL, timeframes: ['M7'], mode: 'manual' }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: { code: string; message?: string; detail?: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('BAD_REQUEST');
    } finally {
      delete process.env.DATA_API_TOKEN;
    }
  });

  test('fail-closed: bridge not configured → 503 with structured outcome', async () => {
    process.env.DATA_API_TOKEN = TOKEN;
    try {
      const { POST } = await import('@/app/api/data/sync/route');
      const res = await POST(
        req('/api/data/sync', {
          method: 'POST',
          ...authed({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ symbol: SYMBOL, mode: 'manual' }),
        }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; outcome: { status: string; errorCode: string } };
      expect(body.ok).toBe(true);
      expect(body.outcome.status).toBe('failed');
      expect(body.outcome.errorCode).toBe('BRIDGE_NOT_CONFIGURED');
    } finally {
      delete process.env.DATA_API_TOKEN;
    }
  });
});

describe('case 15 — authentication (DATA_API_TOKEN, Phase 4 hardened posture)', () => {
  test('missing token → 401 AUTH_MISSING_TOKEN; wrong token → 401 AUTH_INVALID_TOKEN; valid → 200', async () => {
    process.env.DATA_API_TOKEN = 'test-secret-token-123';
    try {
      const { GET } = await import('@/app/api/data/status/route');

      const noAuth = await GET(req('/api/data/status'));
      expect(noAuth.status).toBe(401);
      expect(((await noAuth.json()) as { error: { code: string } }).error.code).toBe('AUTH_MISSING_TOKEN');

      const wrongAuth = await GET(req('/api/data/status', { headers: { Authorization: 'Bearer wrong-token' } }));
      expect(wrongAuth.status).toBe(401);
      expect(((await wrongAuth.json()) as { error: { code: string } }).error.code).toBe('AUTH_INVALID_TOKEN');

      const goodAuth = await GET(req('/api/data/status', { headers: { Authorization: 'Bearer test-secret-token-123' } }));
      expect(goodAuth.status).toBe(200);
    } finally {
      delete process.env.DATA_API_TOKEN;
    }
  });

  test('token unset + no public-reads opt-in → reads fail closed 503 (new default posture)', async () => {
    const hadToken = process.env.DATA_API_TOKEN;
    const hadFlag = process.env.MARKET_API_PUBLIC_READS;
    delete process.env.DATA_API_TOKEN;
    delete process.env.MARKET_API_PUBLIC_READS;
    try {
      const { GET } = await import('@/app/api/data/status/route');
      const res = await GET(req('/api/data/status'));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; error: { code: string; message?: string; detail?: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('MARKET_API_TOKEN_NOT_CONFIGURED');
    } finally {
      if (hadToken === undefined) delete process.env.DATA_API_TOKEN;
      else process.env.DATA_API_TOKEN = hadToken;
      if (hadFlag === undefined) delete process.env.MARKET_API_PUBLIC_READS;
      else process.env.MARKET_API_PUBLIC_READS = hadFlag;
    }
  });

  test('token unset + explicit MARKET_API_PUBLIC_READS=true → reads open (documented opt-in)', async () => {
    const hadToken = process.env.DATA_API_TOKEN;
    const hadFlag = process.env.MARKET_API_PUBLIC_READS;
    delete process.env.DATA_API_TOKEN;
    process.env.MARKET_API_PUBLIC_READS = 'true';
    try {
      const { GET } = await import('@/app/api/data/status/route');
      const res = await GET(req('/api/data/status'));
      expect(res.status).toBe(200);
    } finally {
      if (hadToken === undefined) delete process.env.DATA_API_TOKEN;
      else process.env.DATA_API_TOKEN = hadToken;
      if (hadFlag === undefined) delete process.env.MARKET_API_PUBLIC_READS;
      else process.env.MARKET_API_PUBLIC_READS = hadFlag;
    }
  });
});

describe('case 18 — NO trading/order endpoints exist (static guarantee)', () => {
  function walkRoutes(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkRoutes(full, acc);
      else if (entry === 'route.ts') acc.push(full);
    }
    return acc;
  }

  test('no API route path mentions orders/trades/positions/execution', () => {
    const routes = walkRoutes('/home/z/my-project/src/app/api');
    expect(routes.length).toBeGreaterThan(5); // sanity: we did scan
    const forbidden = /(order|trade|trading|position|close|modify|pending|connect|execution)/i;
    const offenders = routes.filter((r) => forbidden.test(r.replace('/home/z/my-project/src/app/api', '')));
    expect(offenders).toEqual([]);
  });

  test('no route source contains order-submission code', () => {
    const routes = walkRoutes('/home/z/my-project/src/app/api');
    const patterns = [/ORDER_TYPE_/i, /positions_add/i, /trade_action/i, /OrderSend/i, /\/api\/trader\//];
    const offenders: string[] = [];
    for (const r of routes) {
      const src = readFileSync(r, 'utf8');
      if (patterns.some((p) => p.test(src))) offenders.push(r);
    }
    expect(offenders).toEqual([]);
  });

  test('bridge client exposes ONLY read-only methods', async () => {
    const mod = await import('@/lib/market/bridge-client');
    const client = mod.createBridgeClient({ baseUrl: 'http://127.0.0.1:1' });
    const methods = Object.keys(client);
    expect(methods.sort()).toEqual(['getCandles', 'getHealth', 'getQuote', 'getStatus', 'getSymbols']);
  });

  test('the tools registry still has only the read-only health tool active', async () => {
    const { toolSpecs } = await import('@/lib/tools/registry');
    const active = toolSpecs(false).map((t) => t.function.name);
    expect(active).toEqual(['get_system_health']);
  });
});
