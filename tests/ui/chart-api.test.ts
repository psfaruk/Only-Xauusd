/**
 * UI-02 FOCUSED TESTS — /api/data/chart (chart workspace data surface).
 * Covers: guard fail-closed posture, query validation (symbol/tf/limit),
 * closed-candle ordering + flagged forming bar, EMA series computed by the
 * ENGINE convention over CLOSED candles only (forming excluded), honest
 * INSUFFICIENT_DATA for EMA200 when history is short, and structure/levels
 * presence. Mock/synthetic OHLC data only — never real broker data.
 */
import '../market/helpers/setup';
import { afterAll, describe, expect, test } from 'bun:test';

import { db } from '@/lib/db';
import { makeBars } from '../market/helpers/mock-bridge';
import { FIXED_NOW_MS, FIXED_NOW_SEC } from '../market/helpers/setup';

const SYMBOL = 'XAUUSDm';
const req = (url: string, init?: RequestInit) => new Request(`http://localhost:3000${url}`, init);

const M15_SEC = 900;

/** 150 CLOSED M15 bars ending just before "now" (plus one forming bar newer). */
async function seedM15() {
  await db.marketCandle.deleteMany();
  const bars = makeBars(M15_SEC, 151, FIXED_NOW_SEC - M15_SEC, { forming: true });
  // makeBars marks the LAST bar forming; keep it as the single forming row.
  for (const b of bars) {
    await db.marketCandle.create({
      data: {
        symbol: SYMBOL,
        timeframe: 'M15',
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

afterAll(async () => {
  await db.marketCandle.deleteMany();
});

describe('GET /api/data/chart', () => {
  test('returns validated closed candles ascending, forming flagged LAST', async () => {
    const bars = await seedM15();
    const { GET } = await import('@/app/api/data/chart/route');
    const res = await GET(req(`/api/data/chart?symbol=${SYMBOL}&tf=M15&limit=300`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      candles: Array<{ t: number; forming: boolean }>;
      meta: { closedCount: number; formingIncluded: boolean };
    };
    expect(body.ok).toBe(true);

    const forming = body.candles.filter((c) => c.forming);
    expect(forming.length).toBeLessThanOrEqual(1);
    if (forming.length === 1) {
      expect(body.candles[body.candles.length - 1].forming).toBe(true); // last only
    }
    const closed = body.candles.filter((c) => !c.forming);
    expect(closed.length).toBe(bars.length - 1);
    expect(body.meta.closedCount).toBe(closed.length);
    expect(body.meta.formingIncluded).toBe(forming.length === 1);
    // ascending order
    for (let i = 1; i < body.candles.length; i++) {
      expect(body.candles[i].t).toBeGreaterThan(body.candles[i - 1].t);
    }
  });

  test('EMA series follow the engine convention over CLOSED candles only', async () => {
    await seedM15();
    const { GET } = await import('@/app/api/data/chart/route');
    const res = await GET(req(`/api/data/chart?symbol=${SYMBOL}&tf=M15&limit=300`));
    const body = (await res.json()) as {
      ema: {
        ema20: Array<{ t: number; v: number }> | null;
        ema50: Array<{ t: number; v: number }> | null;
        ema200: Array<{ t: number; v: number }> | null;
      };
      candles: Array<{ t: number; forming: boolean }>;
      meta: { insufficient: string[] };
    };

    const closed = body.candles.filter((c) => !c.forming);
    expect(closed.length).toBe(150);

    // EMA20 first value at index 19 → 150 - 19 = 131 points
    expect(body.ema.ema20).not.toBeNull();
    expect(body.ema.ema20!.length).toBe(150 - 19);
    // EMA50 first value at index 49 → 101 points
    expect(body.ema.ema50).not.toBeNull();
    expect(body.ema.ema50!.length).toBe(150 - 49);
    // 150 closed bars < EMA200 warm-up → honest null, never fabricated
    expect(body.ema.ema200).toBeNull();
    expect(body.meta.insufficient).toContain('EMA200');

    // EMAs must never extend onto the forming bar.
    const lastClosedT = closed[closed.length - 1].t;
    const formingT = body.candles[body.candles.length - 1].forming
      ? body.candles[body.candles.length - 1].t
      : null;
    if (formingT !== null) {
      expect(body.ema.ema20![body.ema.ema20!.length - 1].t).toBe(lastClosedT);
      expect(body.ema.ema50![body.ema.ema50!.length - 1].t).toBe(lastClosedT);
    }
  });

  test('structure, levels and staleness meta are present (engine functions)', async () => {
    await seedM15();
    const { GET } = await import('@/app/api/data/chart/route');
    const res = await GET(req(`/api/data/chart?symbol=${SYMBOL}&tf=M15&limit=300`));
    const body = (await res.json()) as {
      structure: { trend: string; highLabel: string; lowLabel: string };
      swings: Array<{ kind: string }>;
      events: Array<{ type: string }>;
      levels: { lastSwingHigh: { price: number } | null; lastSwingLow: { price: number } | null };
      meta: { stale: boolean; stalenessThresholdSec: number; lastClosedUtcSec: number | null };
    };
    expect(['bullish', 'bearish', 'range', 'unclear']).toContain(body.structure.trend);
    expect(['HH', 'LH', 'HL', 'LL', 'UNCLEAR']).toContain(body.structure.highLabel);
    expect(Array.isArray(body.swings)).toBe(true);
    expect(body.swings.every((s) => s.kind === 'high' || s.kind === 'low')).toBe(true);
    expect(body.events.every((e) => e.type === 'BOS' || e.type === 'CHoCH')).toBe(true);
    expect(body.levels).toHaveProperty('lastSwingHigh');
    expect(body.levels).toHaveProperty('lastSwingLow');
    expect(body.meta.stalenessThresholdSec).toBeGreaterThan(0);
    expect(body.meta.lastClosedUtcSec).not.toBeNull();
    expect(typeof body.meta.stale).toBe('boolean');
  });

  test('query validation: unsupported timeframe / symbol / limit rejected (400)', async () => {
    const { GET } = await import('@/app/api/data/chart/route');
    expect((await GET(req(`/api/data/chart?symbol=${SYMBOL}&tf=M30`))).status).toBe(400);
    expect((await GET(req(`/api/data/chart?symbol=EURUSD&tf=M15`))).status).toBe(400);
    expect((await GET(req(`/api/data/chart?symbol=${SYMBOL}&tf=M15&limit=10`))).status).toBe(400);
    expect((await GET(req(`/api/data/chart?symbol=${SYMBOL}&tf=M15&limit=9999`))).status).toBe(400);
  });

  test('guard is fail-closed when public reads are disabled (503)', async () => {
    await seedM15();
    const { GET } = await import('@/app/api/data/chart/route');
    const prev = process.env.MARKET_API_PUBLIC_READS;
    process.env.MARKET_API_PUBLIC_READS = 'false';
    try {
      const res = await GET(req(`/api/data/chart?symbol=${SYMBOL}&tf=M15`));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('MARKET_API_TOKEN_NOT_CONFIGURED');
    } finally {
      process.env.MARKET_API_PUBLIC_READS = prev ?? 'true';
    }
  });
});
