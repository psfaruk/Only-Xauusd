/**
 * AUTOMATED TESTS — historical range import (Phase 3, six-month acquisition).
 * Cases covered: happy-path import with fingerprint, forming-bar drop,
 * invalid-bar rejection, closed-row immutability on re-import (idempotency),
 * bridge failure with honest partial stats, M5 window-alignment guard, and
 * session-aware gap accounting (weekend closure envelope + pre-history depth
 * limit) — the manifest-critical coverage fields.
 *
 * ALL DEPENDENCIES ARE FAKES: the bridge client is an in-process stub and the
 * "database" is a Map-backed object injected through the module's
 * `HistoricalImportDb` seam (`as unknown as PrismaClient` convention — see
 * tests/market/ingestion.test.ts). No real bridge, no real database, and the
 * OHLC numbers below are synthetic fixtures — never real broker data.
 *
 * CLOCK NOTE: importHistoryRange reads the REAL clock (Date.now) to reject
 * future bars and detect forming ones — it is NOT parameterised like
 * runSync's `now`. Fixtures are therefore anchored to the real current time
 * (and the weekend scenario uses the most recent COMPLETED Fri→Mon window in
 * the real past; a future-dated "Saturday" would be rejected as
 * CANDLE_FUTURE_TIME before gap accounting could run).
 */
import './helpers/setup';
import { describe, expect, test } from 'bun:test';

import { datasetFingerprint } from '@/lib/backtest/engine';
import type { BridgeClient } from '@/lib/market/bridge-client';
import {
  importHistoryRange,
  type HistoricalImportDb,
} from '@/lib/market/historical-import';
import type { BridgeBar, BridgeCandlesRangeResponse, BridgeResult } from '@/lib/market/types';

const SYMBOL = 'XAUUSDm';

// ---------------------------------------------------------------------------
// Fakes (injected through the module's seams — never the real ones)
// ---------------------------------------------------------------------------

type RangeParams = Parameters<BridgeClient['getCandlesRange']>[0];
type RangeOutcome = BridgeResult<BridgeCandlesRangeResponse>;

/** In-process bridge stub: records every range call, answers from a handler. */
function makeFakeBridge(handler: (p: RangeParams, callIndex: number) => RangeOutcome) {
  const calls: RangeParams[] = [];
  const client: Pick<BridgeClient, 'getCandlesRange'> = {
    getCandlesRange: async (p) => {
      const idx = calls.length;
      calls.push(p);
      return handler(p, idx);
    },
  };
  return { client, calls };
}

function rangeOk(fromUtcSec: number, toUtcSec: number, bars: BridgeBar[], digits = 3): RangeOutcome {
  return {
    ok: true,
    data: {
      symbol: SYMBOL,
      tf: 'M5',
      digits,
      source: 'mt5',
      fromUtc: fromUtcSec,
      toUtc: toUtcSec,
      paginated: false,
      bars,
    },
  };
}

interface FakeCandleRow {
  symbol: string;
  timeframe: string;
  candleTimeUtc: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  tickVolume: number | null;
  spread: string | null;
  source: string;
  isForming: boolean;
  validationStatus: string;
  receivedAtUtc: Date;
}

/** Map-backed marketCandle stand-in: findMany / createMany / updateMany —
 *  exactly the surface importHistoryRange touches. updateMany mirrors the
 *  real contract: ONLY receivedAtUtc may move on an existing closed row. */
function makeFakeDb(seed: FakeCandleRow[] = []) {
  const key = (symbol: string, timeframe: string, candleTimeUtc: Date) =>
    `${symbol}|${timeframe}|${candleTimeUtc.getTime()}`;
  const rows = new Map<string, FakeCandleRow>();
  for (const r of seed) rows.set(key(r.symbol, r.timeframe, r.candleTimeUtc), { ...r });

  const calls = { findMany: 0, createMany: 0, updateMany: 0 };
  const createManyBatches: FakeCandleRow[][] = [];

  const marketCandle = {
    async findMany(args: { where?: { symbol?: string; timeframe?: string; candleTimeUtc?: { in?: Date[] } } }) {
      calls.findMany += 1;
      const inMs = new Set((args.where?.candleTimeUtc?.in ?? []).map((d) => d.getTime()));
      const out: Array<{ candleTimeUtc: Date; open: string; high: string; low: string; close: string }> = [];
      for (const r of rows.values()) {
        if (r.symbol !== args.where?.symbol || r.timeframe !== args.where?.timeframe) continue;
        if (!inMs.has(r.candleTimeUtc.getTime())) continue;
        out.push({ candleTimeUtc: r.candleTimeUtc, open: r.open, high: r.high, low: r.low, close: r.close });
      }
      return out;
    },
    async createMany(args: { data: FakeCandleRow[] }) {
      calls.createMany += 1;
      createManyBatches.push(args.data);
      let count = 0;
      for (const row of args.data) {
        const k = key(row.symbol, row.timeframe, row.candleTimeUtc);
        if (!rows.has(k)) {
          rows.set(k, row);
          count += 1;
        }
      }
      return { count };
    },
    async updateMany(args: { where?: { symbol?: string; timeframe?: string; candleTimeUtc?: { in?: Date[] } } }) {
      calls.updateMany += 1;
      const inMs = new Set((args.where?.candleTimeUtc?.in ?? []).map((d) => d.getTime()));
      let touched = 0;
      for (const [k, r] of rows) {
        if (r.symbol !== args.where?.symbol || r.timeframe !== args.where?.timeframe) continue;
        if (!inMs.has(r.candleTimeUtc.getTime())) continue;
        rows.set(k, { ...r, receivedAtUtc: new Date() }); // receipt bookkeeping ONLY
        touched += 1;
      }
      return { count: touched };
    },
  };

  return {
    db: { marketCandle } as unknown as HistoricalImportDb,
    rows,
    calls,
    createManyBatches,
    rowAt: (symbol: string, timeframe: string, tSec: number) =>
      rows.get(key(symbol, timeframe, new Date(tSec * 1000))),
  };
}

/** Synthetic valid bar — OHLC always consistent and within 3 decimals
 *  (digits fixture = 3), so canonical text is exactly value.toFixed(3). */
function genBar(t: number, i: number, opts: { forming?: boolean; ohlc?: [number, number, number, number] } = {}): BridgeBar {
  const v = 10 + i;
  if (opts.ohlc) {
    const [o, h, l, c] = opts.ohlc;
    return opts.forming ? { t, o, h, l, c, v, f: 1 } : { t, o, h, l, c, v };
  }
  const o = 2650 + (i % 7) * 0.125;
  const c = o + 0.25;
  const h = Math.max(o, c) + 0.125;
  const l = Math.min(o, c) - 0.125;
  return opts.forming ? { t, o, h, l, c, v, f: 1 } : { t, o, h, l, c, v };
}

/** Real-clock anchor: an M5-aligned instant 1h in the past (closed bars,
 *  outside the future-rejection window, whatever the wall-clock time of day). */
function recentAlignedBase(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / 300) * 300 - 3_600;
}

/** Most recent COMPLETED Fri 12:00 → Mon 12:00 UTC window (grid-aligned by
 *  construction — 12:00 UTC and whole-day offsets are multiples of 300s).
 *  At the time of writing this selects Sat 2026-10-17; it self-adjusts to the
 *  latest past weekend whenever the suite runs. */
function recentWeekendWindow(): { fri: number; sat: number; mon: number } {
  const cutoffMs = Date.now() - 7_200_000; // stay 2h behind the live edge
  const d = new Date(cutoffMs);
  let monMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7), 12, 0, 0);
  if (monMs > cutoffMs) monMs -= 7 * 86_400_000;
  const mon = monMs / 1000;
  return { fri: mon - 3 * 86_400, sat: mon - 2 * 86_400, mon };
}

// ---------------------------------------------------------------------------
// (a) Happy path
// ---------------------------------------------------------------------------

describe('historical-import — happy path import (case a)', () => {
  test('2 closed M5 bars in one range response → inserted, fingerprinted, digits verified from bridge', async () => {
    const t0 = recentAlignedBase();
    const bars: BridgeBar[] = [
      { t: t0, o: 2650.123, h: 2651.456, l: 2649.789, c: 2650.987, v: 120 },
      { t: t0 + 300, o: 2650.987, h: 2652.111, l: 2650.5, c: 2651.777, v: 98 },
    ];
    const { client, calls } = makeFakeBridge((p) => rangeOk(p.fromUtcSec, p.toUtcSec, bars, 3));
    const fdb = makeFakeDb();

    const outcome = await importHistoryRange(client, fdb.db, {
      symbol: SYMBOL,
      timeframe: 'M5',
      fromUtcSec: t0,
      toUtcSec: t0 + 600,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    const s = outcome.stats;

    expect(s.barsInserted).toBe(2);
    expect(s.barsFormingDropped).toBe(0);
    expect(s.missingSlots).toBe(0);
    expect(s.barsRejectedInvalid).toBe(0);
    expect(s.barsDuplicateInStream).toBe(0);
    expect(s.barsAlreadyPresent).toBe(0);
    expect(s.requests).toBe(1); // one range response covered the window
    expect(s.barsReceived).toBe(2);
    expect(calls.length).toBe(1);

    // Broker-verified digits (3) came from the bridge response, and every
    // persisted price is canonical 3-decimal text — never float dust.
    expect(s.digits).toBe(3);
    expect(s.digitsSource).toContain('bridge');
    const r1 = fdb.rowAt(SYMBOL, 'M5', t0);
    const r2 = fdb.rowAt(SYMBOL, 'M5', t0 + 300);
    expect(r1?.open).toBe('2650.123');
    expect(r1?.high).toBe('2651.456');
    expect(r1?.low).toBe('2649.789');
    expect(r1?.close).toBe('2650.987');
    expect(r1?.isForming).toBe(false);
    expect(r1?.validationStatus).toBe('VALID');
    expect(r1?.source).toBe('bridge-mt5');
    expect(r2?.low).toBe('2650.500');
    expect(fdb.rows.size).toBe(2);
    expect(fdb.calls.updateMany).toBe(0); // nothing pre-existing → no receipt refresh

    // Fingerprint: 64-hex sha256 over the imported CLOSED set, IDENTICAL to
    // what the backtest loader computes from the same canonical text.
    expect(s.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(s.fingerprint).toBe(
      datasetFingerprint(SYMBOL, 'M5', [
        { timeUtcSec: t0, openText: '2650.123', highText: '2651.456', lowText: '2649.789', closeText: '2650.987' },
        { timeUtcSec: t0 + 300, openText: '2650.987', highText: '2652.111', lowText: '2650.500', closeText: '2651.777' },
      ]),
    );

    // Manifest-critical coverage fields exist and are honest for a full window.
    expect(typeof s.expectedSlots).toBe('number');
    expect(s.expectedSlots).toBe(2);
    expect(typeof s.preHistorySlots).toBe('number');
    expect(s.preHistorySlots).toBe(0);
    expect(Array.isArray(s.missingExamples)).toBe(true);
    expect(s.missingExamples).toEqual([]);
    expect(s.earliestBarUtcSec).toBe(t0);
    expect(s.latestBarUtcSec).toBe(t0 + 300);
    expect(s.validationIssues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) Forming bars are dropped — history is CLOSED bars only
// ---------------------------------------------------------------------------

describe('historical-import — forming bar dropped (case b)', () => {
  test('bridge-flagged forming bar (f:1) is never persisted and is counted, not hidden', async () => {
    const t0 = recentAlignedBase();
    const bars: BridgeBar[] = [
      genBar(t0, 0),
      genBar(t0 + 300, 1),
      genBar(t0 + 600, 2, { forming: true }), // still-open bar — must NOT enter history
    ];
    const { client } = makeFakeBridge((p) => rangeOk(p.fromUtcSec, p.toUtcSec, bars, 3));
    const fdb = makeFakeDb();

    const outcome = await importHistoryRange(client, fdb.db, {
      symbol: SYMBOL, timeframe: 'M5', fromUtcSec: t0, toUtcSec: t0 + 900,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.stats.barsFormingDropped).toBe(1);
    expect(outcome.stats.barsInserted).toBe(2);
    expect(outcome.stats.barsReceived).toBe(3);
    // The forming slot left NO row behind…
    expect(fdb.rowAt(SYMBOL, 'M5', t0 + 600)).toBeUndefined();
    expect(fdb.rows.size).toBe(2);
    // …and the closed neighbours persisted normally.
    expect(fdb.rowAt(SYMBOL, 'M5', t0)?.open).toBe('2650.000');
    expect(fdb.rowAt(SYMBOL, 'M5', t0 + 300)?.open).toBe('2650.125');
  });
});

// ---------------------------------------------------------------------------
// (c) Invalid bars are rejected, never persisted
// ---------------------------------------------------------------------------

describe('historical-import — invalid bar rejected (case c)', () => {
  test('high < low bar fails OHLC consistency → rejected, reported in validationIssues, not stored', async () => {
    const t0 = recentAlignedBase();
    const bars: BridgeBar[] = [
      genBar(t0, 0),
      genBar(t0 + 300, 1, { ohlc: [2650, 2651, 2652, 2650.5] }), // low 2652 > high 2651 — impossible bar
      genBar(t0 + 600, 2),
    ];
    const { client } = makeFakeBridge((p) => rangeOk(p.fromUtcSec, p.toUtcSec, bars, 3));
    const fdb = makeFakeDb();

    const outcome = await importHistoryRange(client, fdb.db, {
      symbol: SYMBOL, timeframe: 'M5', fromUtcSec: t0, toUtcSec: t0 + 900,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    const s = outcome.stats;
    expect(s.barsRejectedInvalid).toBe(1);
    expect(s.barsInserted).toBe(2);
    expect(s.validationIssues.length).toBeGreaterThan(0);
    const ohlcIssue = s.validationIssues.find((v) => v.code === 'CANDLE_OHLC_INCONSISTENT');
    expect(ohlcIssue).toBeDefined();
    expect(ohlcIssue?.count).toBeGreaterThanOrEqual(1);
    expect(ohlcIssue?.exampleBarTimeUtcSec).toBe(t0 + 300);
    // The impossible bar never reached storage:
    expect(fdb.rowAt(SYMBOL, 'M5', t0 + 300)).toBeUndefined();
    expect(fdb.rows.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (d) Idempotency / closed-row immutability
// ---------------------------------------------------------------------------

describe('historical-import — idempotency & closed-row immutability (case d)', () => {
  test('re-delivered closed bar with DIFFERENT OHLC → divergence counted, stored row NEVER rewritten', async () => {
    const t0 = recentAlignedBase();
    // Already-persisted CLOSED row at T (synthetic fixture values):
    const fdb = makeFakeDb([
      {
        symbol: SYMBOL,
        timeframe: 'M5',
        candleTimeUtc: new Date(t0 * 1000),
        open: '100',
        high: '110',
        low: '90',
        close: '105',
        tickVolume: 42,
        spread: null,
        source: 'bridge-mt5',
        isForming: false,
        validationStatus: 'VALID',
        receivedAtUtc: new Date(0),
      },
    ]);
    // The bridge re-delivers the SAME time T with different OHLC:
    const bars: BridgeBar[] = [genBar(t0, 0, { ohlc: [100.123, 120.456, 90.789, 115.123] })];
    const { client } = makeFakeBridge((p) => rangeOk(p.fromUtcSec, p.toUtcSec, bars, 3));

    const outcome = await importHistoryRange(client, fdb.db, {
      symbol: SYMBOL, timeframe: 'M5', fromUtcSec: t0, toUtcSec: t0 + 300,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    const s = outcome.stats;

    // Divergence detected and SAMPLED (stored vs incoming canonical text)…
    expect(s.divergences).toBe(1);
    expect(s.divergenceExamples[0]).toEqual({
      barTimeUtcSec: t0,
      stored: '100/110/90/105',
      incoming: '100.123/120.456/90.789/115.123',
    });
    // …counted as already-present…
    expect(s.barsAlreadyPresent).toBe(1);
    // …and NOTHING was inserted — createMany was never invoked at all.
    expect(s.barsInserted).toBe(0);
    expect(fdb.calls.createMany).toBe(0);
    expect(fdb.createManyBatches).toEqual([]);
    // The stored closed row is immutable: only its receipt timestamp moved.
    const stored = fdb.rowAt(SYMBOL, 'M5', t0);
    expect(stored?.open).toBe('100');
    expect(stored?.high).toBe('110');
    expect(stored?.low).toBe('90');
    expect(stored?.close).toBe('105');
    expect(stored?.tickVolume).toBe(42);
    expect(stored?.isForming).toBe(false);
    expect(fdb.calls.updateMany).toBe(1); // receipt refresh ran — bookkeeping only
    expect(fdb.rows.size).toBe(1);        // no duplicate row either
  });
});

// ---------------------------------------------------------------------------
// (e) Bridge failure → honest partial stats, no crash
// ---------------------------------------------------------------------------

describe('historical-import — bridge failure mid-run (case e)', () => {
  test('first range call fails (BRIDGE_TIMEOUT) → ok:false, error code surfaced, partial stats intact', async () => {
    const t0 = recentAlignedBase();
    const { client, calls } = makeFakeBridge(() => ({
      ok: false,
      error: { code: 'BRIDGE_TIMEOUT', message: 'x' },
    }));
    const fdb = makeFakeDb();

    const outcome = await importHistoryRange(client, fdb.db, {
      symbol: SYMBOL, timeframe: 'M5', fromUtcSec: t0, toUtcSec: t0 + 600,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.error.code).toBe('BRIDGE_TIMEOUT');
    // Partial stats are returned so already-acquired coverage is never hidden:
    const partial = outcome.error.partialStats;
    expect(partial).toBeDefined();
    expect(partial?.requests).toBe(0);
    expect(partial?.barsReceived).toBe(0);
    expect(partial?.barsInserted).toBe(0);
    expect(partial?.fingerprint).toBeNull();
    expect(partial?.digits).toBeNull();
    expect(partial?.digitsSource).toBe('unverified');
    // One bridge attempt, and the DB was never touched (no half-writes):
    expect(calls.length).toBe(1);
    expect(fdb.calls.findMany).toBe(0);
    expect(fdb.calls.createMany).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (f) Window alignment guard
// ---------------------------------------------------------------------------

describe('historical-import — window alignment guard (case f)', () => {
  test('fromUtcSec off the M5 grid → BAD_RANGE before ANY bridge or DB call', async () => {
    const t0 = recentAlignedBase();
    const { client, calls } = makeFakeBridge((p) => rangeOk(p.fromUtcSec, p.toUtcSec, [], 3));
    const fdb = makeFakeDb();

    const outcome = await importHistoryRange(client, fdb.db, {
      symbol: SYMBOL,
      timeframe: 'M5',
      fromUtcSec: t0 + 37, // NOT a multiple of 300
      toUtcSec: t0 + 600,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected BAD_RANGE');
    expect(outcome.error.code).toBe('BAD_RANGE');
    expect(calls.length).toBe(0);       // zero bridge traffic…
    expect(fdb.calls.findMany).toBe(0); // …and zero DB reads/writes.
    expect(fdb.calls.createMany).toBe(0);

    // Same guard for a misaligned right edge, and for an inverted window:
    const badTo = await importHistoryRange(client, fdb.db, {
      symbol: SYMBOL, timeframe: 'M5', fromUtcSec: t0, toUtcSec: t0 + 600 + 1,
    });
    expect(badTo.ok).toBe(false);
    if (badTo.ok) throw new Error('expected BAD_RANGE (to)');
    expect(badTo.error.code).toBe('BAD_RANGE');

    const inverted = await importHistoryRange(client, fdb.db, {
      symbol: SYMBOL, timeframe: 'M5', fromUtcSec: t0 + 600, toUtcSec: t0,
    });
    expect(inverted.ok).toBe(false);
    if (inverted.ok) throw new Error('expected BAD_RANGE (inverted)');
    expect(inverted.error.code).toBe('BAD_RANGE');
    expect(calls.length).toBe(0); // still zero bridge calls across all three
  });
});

// ---------------------------------------------------------------------------
// (g) Session-aware gap accounting (weekend envelope) + pre-history depth
// ---------------------------------------------------------------------------

describe('historical-import — gap accounting over a weekend (case g)', () => {
  test('Saturday/Sunday slots with no bars are closure-classified, NOT reported as real gaps', async () => {
    const { fri, sat, mon } = recentWeekendWindow();
    // Sanity: real calendar days, grid-aligned window (computed via Date.UTC).
    expect(new Date(fri * 1000).getUTCDay()).toBe(5); // Friday
    expect(new Date(sat * 1000).getUTCDay()).toBe(6); // Saturday
    expect(new Date(mon * 1000).getUTCDay()).toBe(1); // Monday
    expect(fri % 300).toBe(0);
    expect(mon % 300).toBe(0);

    // Bars for Friday 12:00–19:55 and Monday 00:00–11:55 ONLY — nothing
    // Saturday, nothing Sunday (the whole weekend is a hole in the feed).
    const bars: BridgeBar[] = [];
    let i = 0;
    for (let t = fri; t < fri + 8 * 3_600; t += 300) bars.push(genBar(t, i++)); // 96 Friday bars
    for (let t = mon - 12 * 3_600; t < mon; t += 300) bars.push(genBar(t, i++)); // 144 Monday bars
    expect(bars.length).toBe(240);

    const { client } = makeFakeBridge((p) => rangeOk(p.fromUtcSec, p.toUtcSec, bars, 3));
    const fdb = makeFakeDb();

    const outcome = await importHistoryRange(client, fdb.db, {
      symbol: SYMBOL, timeframe: 'M5', fromUtcSec: fri, toUtcSec: mon,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    const s = outcome.stats;

    // Full 3-day M5 grid requested: 72h × 12 bars/h = 864 expected slots.
    expect(s.expectedSlots).toBe(864);
    expect(s.barsReceived).toBe(240);
    expect(s.barsInserted).toBe(240);
    // The 624 absent slots (Fri 20:00–24:00 + all Saturday + all Sunday) fall
    // inside the approximate weekend envelope → closure, never a "real" gap:
    expect(s.closureSlots).toBe(48 + 288 + 288); // Fri-evening + Saturday + Sunday
    expect(s.missingSlots).toBe(0); // Saturday slots are closure-classified — no false gaps
    expect(s.preHistorySlots).toBe(0); // earliest bar sits at the window start
    expect(s.missingExamples).toEqual([]);
    expect(s.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(s.earliestBarUtcSec).toBe(fri);
    expect(s.latestBarUtcSec).toBe(mon - 300);
  });

  test('slots before the earliest served bar are pre-history (broker depth limit), not gaps', async () => {
    const { fri, mon } = recentWeekendWindow();
    // Broker serves NOTHING before Monday 00:00 — the whole Friday half of
    // the window is beyond its history depth:
    const bars: BridgeBar[] = [];
    let i = 0;
    for (let t = mon - 12 * 3_600; t < mon; t += 300) bars.push(genBar(t, i++)); // 144 Monday bars

    const { client } = makeFakeBridge((p) => rangeOk(p.fromUtcSec, p.toUtcSec, bars, 3));
    const fdb = makeFakeDb();

    const outcome = await importHistoryRange(client, fdb.db, {
      symbol: SYMBOL, timeframe: 'M5', fromUtcSec: fri, toUtcSec: mon,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    const s = outcome.stats;
    expect(s.expectedSlots).toBe(864);
    expect(s.barsInserted).toBe(144);
    expect(s.earliestBarUtcSec).toBe(mon - 12 * 3_600);
    // Friday 12:00–19:55 = 96 non-closure slots BEFORE the earliest served
    // bar → honest "pre-history" accounting, still zero invented gaps:
    expect(s.preHistorySlots).toBe(96);
    expect(s.closureSlots).toBe(48 + 288 + 288); // Fri evening + Sat + Sun envelopes
    expect(s.missingSlots).toBe(0);
    expect(s.missingExamples).toEqual([]);
    expect(fdb.rows.size).toBe(144);
  });
});
