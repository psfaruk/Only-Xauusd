/**
 * AUTOMATED TESTS — CLOSED-CANDLE IMMUTABILITY ON RE-SYNC
 * (Deep-remediation Phase 2, master prompt §Phase 2 task 4 + acceptance test
 * "closed-candle immutability, and idempotent aggregation").
 * ----------------------------------------------------------------------------
 * Proves that re-syncing an already-closed candle NEVER mutates its stored
 * OHLC: a divergent re-delivery from the bridge is ignored and recorded as an
 * auditable CANDLE_CLOSED_REVISION_IGNORED warning, while the legitimate
 * forming → closed transition still writes the bar's FINAL values.
 *
 * This test initially EXPOSED a real ingestion bug (the upsert's update path
 * rewrote OHLC of already-closed rows on every re-delivery) — ingestion.ts
 * was fixed minimally; this file pins the corrected contract.
 *
 * MOCK DISCLOSURE: SYNTHETIC bars from the clearly-labeled local MOCK BRIDGE
 * (tests/market/helpers/mock-bridge.ts) — never real broker data.
 */
import './helpers/setup';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { db } from '@/lib/db';
import { createBridgeClient } from '@/lib/market/bridge-client';
import { runSync } from '@/lib/market/ingestion';
import { TIMEFRAME_SECONDS } from '@/lib/market/types';
import { makeBars, startMockBridge } from './helpers/mock-bridge';
import { FIXED_NOW_SEC, fixedNow } from './helpers/setup';

const M5 = TIMEFRAME_SECONDS.M5;
const SYMBOL = 'XAUUSDm';

let mock: Awaited<ReturnType<typeof startMockBridge>>;

beforeAll(async () => {
  mock = await startMockBridge();
});

afterAll(async () => {
  mock.stop();
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
  await db.dataQualityIssue.deleteMany();
  await db.syncRun.deleteMany();
});

beforeEach(async () => {
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
  await db.dataQualityIssue.deleteMany();
  await db.syncRun.deleteMany();
});

const client = () => createBridgeClient({ baseUrl: mock.url, timeoutMs: 2_000, maxRetries: 0 });
const sync = () => runSync({ bridge: client(), db, now: fixedNow }, { mode: 'manual', symbol: SYMBOL, timeframes: ['M5'] });

describe('closed-candle immutability — re-sync never mutates final OHLC (Phase 2 regression)', () => {
  test('divergent re-delivery of a closed bar is IGNORED + audited; forming→closed still finalizes', async () => {
    // ── Run 1: 99 closed bars + 1 forming bar, canonical synthetic values ──
    const lastOpen = FIXED_NOW_SEC - M5;
    const bars = makeBars(M5, 100, lastOpen, { forming: true });
    mock.state.candles.M5 = bars;
    mock.state.quote = { bid: 2650.1, ask: 2650.5, ts: FIXED_NOW_SEC - 10 };

    const run1 = await sync();
    expect(run1.status).toBe('success');
    expect(run1.inserted).toBe(100);
    expect(run1.updated).toBe(0);

    // Snapshot the stored OHLC of every CLOSED bar (the immutability oracle).
    const storedBefore = await db.marketCandle.findMany({
      where: { symbol: SYMBOL, timeframe: 'M5' },
      orderBy: { candleTimeUtc: 'asc' },
    });
    expect(storedBefore.length).toBe(100);
    const closedBefore = storedBefore.filter((r) => !r.isForming);
    expect(closedBefore.length).toBe(99);
    const beforeByTime = new Map(storedBefore.map((r) => [r.candleTimeUtc.getTime(), r]));

    // ── Run 2: the bridge "revises" history ────────────────────────────────
    //  · closed bar #5  → different OHLC (a coherent shift — a corrupt/late
    //                     revision attempt that still passes OHLC validation)
    //  · closed bar #7  → re-delivered as FORMING with different prices
    //  · last bar       → now CLOSED with its final close (legit transition)
    // All revisions stay OHLC-consistent so they reach the persistence layer
    // (the immutability contract is under test, not the validator).
    const revised = bars.map((b) => ({ ...b }));
    const bar5 = revised[5];
    const bar7 = revised[7];
    const lastBar = revised[revised.length - 1];
    expect(bar5).toBeDefined();
    expect(bar7).toBeDefined();
    revised[5] = { ...bar5, o: bar5.o + 9, h: bar5.h + 9, l: bar5.l + 9, c: bar5.c + 9 };
    revised[7] = { ...bar7, o: bar7.o + 2, h: bar7.h + 2, l: bar7.l + 2, c: bar7.c + 2, f: 1 }; // re-sent as forming
    // Last bar: drop the f:1 flag (explicit reconstruction — a spread would
    // copy it) so it arrives as CLOSED with its final close (still ≤ high).
    revised[revised.length - 1] = {
      t: lastBar.t, o: lastBar.o, h: lastBar.h, l: lastBar.l,
      c: lastBar.o + 1.0, v: lastBar.v,
    };
    mock.state.candles.M5 = revised;

    const run2 = await sync();
    expect(run2.status).toBe('success');
    expect(run2.inserted).toBe(0);
    expect(run2.updated).toBe(100); // receipt refresh + the forming→closed finalize

    // ── The immutability contract ──────────────────────────────────────────
    const storedAfter = await db.marketCandle.findMany({
      where: { symbol: SYMBOL, timeframe: 'M5' },
      orderBy: { candleTimeUtc: 'asc' },
    });
    expect(storedAfter.length).toBe(100);

    for (const row of storedAfter) {
      const before = beforeByTime.get(row.candleTimeUtc.getTime());
      expect(before).toBeDefined();
      if (row.candleTimeUtc.getTime() === lastBar.t * 1000) continue; // legit finalize below
      // EVERY other bar — closed or the attempted "re-forming" — keeps its
      // exact stored OHLC and closed state:
      expect(row.open).toBe(before!.open);
      expect(row.high).toBe(before!.high);
      expect(row.low).toBe(before!.low);
      expect(row.close).toBe(before!.close);
      expect(row.isForming).toBe(before!.isForming);
    }

    // Bar #5: the divergent closed-bar revision was IGNORED (stored kept)…
    const row5 = storedAfter.find((r) => r.candleTimeUtc.getTime() === bar5.t * 1000)!;
    expect(row5.open).toBe(beforeByTime.get(bar5.t * 1000)!.open);
    expect(row5.close).not.toBe((bar5.c + 9).toFixed(2)); // the revision never landed

    // Bar #7: re-delivered "as forming" — stays CLOSED with the original OHLC.
    const row7 = storedAfter.find((r) => r.candleTimeUtc.getTime() === bar7.t * 1000)!;
    expect(row7.isForming).toBe(false);
    expect(row7.close).toBe(beforeByTime.get(bar7.t * 1000)!.close);

    // Last bar: the forming→closed transition DID write the final OHLC.
    const lastRow = storedAfter.find((r) => r.candleTimeUtc.getTime() === lastBar.t * 1000)!;
    expect(lastRow.isForming).toBe(false);
    expect(lastRow.close).toBe((lastBar.o + 1.0).toFixed(2));

    // ── Auditable, never silent ────────────────────────────────────────────
    const issues = await db.dataQualityIssue.findMany({
      where: { symbol: SYMBOL, errorCode: 'CANDLE_CLOSED_REVISION_IGNORED' },
    });
    expect(issues.length).toBe(2); // bar #5 (OHLC revision) + bar #7 (forming re-delivery)
    expect(issues.some((i) => JSON.parse(i.details).detail.includes('different OHLC'))).toBe(true);
    expect(issues.some((i) => JSON.parse(i.details).detail.includes('FORMING'))).toBe(true);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  test('identical re-delivery of closed bars is a pure no-op for OHLC (idempotent aggregation)', async () => {
    const bars = makeBars(M5, 50, FIXED_NOW_SEC - M5, { forming: false }); // all closed
    mock.state.candles.M5 = bars;
    mock.state.quote = { bid: 2650.1, ask: 2650.5, ts: FIXED_NOW_SEC - 10 };

    const run1 = await sync();
    expect(run1.inserted).toBe(50);
    const after1 = await db.marketCandle.findMany({
      where: { symbol: SYMBOL, timeframe: 'M5' },
      orderBy: { candleTimeUtc: 'asc' },
    });

    const run2 = await sync(); // byte-identical bridge response
    expect(run2.status).toBe('success');
    expect(run2.inserted).toBe(0);
    expect(run2.updated).toBe(50); // receipt refresh only — OHLC untouched

    const after2 = await db.marketCandle.findMany({
      where: { symbol: SYMBOL, timeframe: 'M5' },
      orderBy: { candleTimeUtc: 'asc' },
    });
    expect(after2.length).toBe(after1.length);
    for (let i = 0; i < after1.length; i++) {
      expect(after2[i].open).toBe(after1[i].open);
      expect(after2[i].high).toBe(after1[i].high);
      expect(after2[i].low).toBe(after1[i].low);
      expect(after2[i].close).toBe(after1[i].close);
      expect(after2[i].isForming).toBe(after1[i].isForming);
      expect(after2[i].validationStatus).toBe(after1[i].validationStatus);
    }

    // No revision warnings for identical data — silence is correct here.
    const issues = await db.dataQualityIssue.count({
      where: { symbol: SYMBOL, errorCode: 'CANDLE_CLOSED_REVISION_IGNORED' },
    });
    expect(issues).toBe(0);
  });
});
