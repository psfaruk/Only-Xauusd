/**
 * AUTOMATED TESTS — Live Data Integrity Monitor (Phase 8, Task 2/3/9).
 * ----------------------------------------------------------------------------
 * Covers: source classification honesty (broker/relay/cache/synthetic),
 * quote freshness transitions (LIVE/STALE/DEGRADED/DISCONNECTED), invalid
 * price rejection, wrong-symbol handling, signal gating, relay-stall and
 * recovery, and candle-history audit (gaps/duplicates/invalid OHLC).
 *
 * MOCK DISCLOSURE: the bridge here is the local mock server with synthetic
 * values — these are NOT real broker data. Fixture tests are kept separate
 * from live-broker verification by design (see audit/phase8-*-report.md).
 */

import './helpers/setup';
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { createBridgeClient } from '@/lib/market/bridge-client';
import { classifySource, quoteIntegrity, auditCandleHistory } from '@/lib/market/integrity';
import { defaultMockState, makeBars, startMockBridge } from './helpers/mock-bridge';
import { db } from '@/lib/db';
import { FIXED_NOW_MS } from './helpers/setup';

let mock: Awaited<ReturnType<typeof startMockBridge>> | null = null;

beforeAll(async () => {
  mock = await startMockBridge();
});
afterAll(() => {
  mock?.stop();
});

const client = () => createBridgeClient({ baseUrl: (mock as unknown as { url: string }).url, timeoutMs: 2000, maxRetries: 0 });
const NOW_SEC = Math.floor(Date.now() / 1000);
// Anchor bar seeding to the REAL clock (auditCandleHistory compares ages
// against Date.now()); the old FIXED_NOW anchor produced artificial STALE.
const SEED_SEC = NOW_SEC - 300; // last bar OPEN — keeps latestClosedAge ~600s < 900s threshold

// ---------------------------------------------------------------------------
// Source classification — honesty rules
// ---------------------------------------------------------------------------

describe('classifySource', () => {
  test('authenticated mt5 session → broker', () => {
    expect(classifySource('mt5', true, '203.0.113.10')).toBe('broker');
  });

  test('mt5 WITHOUT authentication → cache (socket open is NOT a verified feed)', () => {
    expect(classifySource('mt5', false, '203.0.113.10')).toBe('cache');
  });

  test('clearly-labelled demo feed → synthetic (never broker)', () => {
    expect(classifySource('demo', true, null)).toBe('synthetic');
  });

  test('disconnected → unavailable', () => {
    expect(classifySource('disconnected', false, null)).toBe('unavailable');
    expect(classifySource(undefined, false, null)).toBe('unavailable');
  });

  test('unknown label → cache (never upgraded)', () => {
    expect(classifySource('something-else', true, 'x')).toBe('cache');
  });
});

// ---------------------------------------------------------------------------
// Quote integrity — freshness lifecycle
// ---------------------------------------------------------------------------

describe('quoteIntegrity', () => {
  test('fresh authenticated broker quote → LIVE, signal permitted, source broker', async () => {
    const state = mock!.state;
    state.source = 'mt5';
    state.connected = true;
    state.authenticated = true;
    state.quoteAgeMs = 1000; // 1s old
    state.quote = { bid: 4145.0, ask: 4145.24, ts: NOW_SEC - 1 };

    const r = await quoteIntegrity('XAUUSDm', { bridge: client() });
    expect(r.freshness).toBe('LIVE');
    expect(r.sourceClass).toBe('broker');
    expect(r.authenticated).toBe(true);
    expect(r.validationStatus).toBe('VALID');
    expect(r.signalPermitted).toBe(true);
    expect(r.blockedReasons).toEqual([]);
    expect(r.bid).toBe('4145.00'); // digits-formatted, exact
    expect(r.spread).toBe('0.24');
  });

  test('stale quote (age > threshold) → STALE, signals blocked', async () => {
    const state = mock!.state;
    state.quoteAgeMs = 300_000; // 5 minutes > 120s threshold
    const r = await quoteIntegrity('XAUUSDm', { bridge: client() });
    expect(r.freshness).toBe('STALE');
    expect(r.signalPermitted).toBe(false);
    expect(r.blockedReasons).toContain('QUOTE_STALE');
    expect(r.issues).toContain('DATA_STALE');
  });

  test('very stale quote (>10× threshold) → DEGRADED', async () => {
    mock!.state.quoteAgeMs = 3_600_000; // 1 hour
    const r = await quoteIntegrity('XAUUSDm', { bridge: client() });
    expect(r.freshness).toBe('DEGRADED');
    expect(r.signalPermitted).toBe(false);
  });

  test('relay stall & recovery: unreachable bridge → DISCONNECTED, then recovers to LIVE', async () => {
    // Stall: point the client at a dead port.
    const dead = createBridgeClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 500, maxRetries: 0 });
    const stalled = await quoteIntegrity('XAUUSDm', { bridge: dead });
    expect(stalled.bridgeReachable).toBe(false);
    expect(stalled.freshness).toBe('DISCONNECTED');
    expect(stalled.signalPermitted).toBe(false);
    expect(stalled.blockedReasons).toContain('BRIDGE_UNREACHABLE');
    expect(stalled.bid).toBeNull(); // nothing fabricated

    // Recovery: the live mock again.
    mock!.state.quoteAgeMs = 500;
    const recovered = await quoteIntegrity('XAUUSDm', { bridge: client() });
    expect(recovered.freshness).toBe('LIVE');
    expect(recovered.signalPermitted).toBe(true);
  });

  test('connected but NOT authenticated → DEGRADED (socket open is not enough)', async () => {
    mock!.state.authenticated = false;
    mock!.state.quoteAgeMs = 1000;
    const r = await quoteIntegrity('XAUUSDm', { bridge: client() });
    expect(r.freshness).toBe('DEGRADED');
    expect(r.sourceClass).toBe('cache');
    expect(r.signalPermitted).toBe(false);
    expect(r.blockedReasons).toContain('NOT_AUTHENTICATED');
    mock!.state.authenticated = true; // restore
  });

  test('demo-labelled feed → synthetic, signals blocked, never "broker"', async () => {
    mock!.state.source = 'demo';
    const r = await quoteIntegrity('XAUUSDm', { bridge: client() });
    expect(r.sourceClass).toBe('synthetic');
    expect(r.freshness).toBe('DISCONNECTED'); // synthetic is never actionable
    expect(r.signalPermitted).toBe(false);
    mock!.state.source = 'mt5'; // restore
  });

  test('invalid prices (crossed bid/ask) → rejected, never replaced', async () => {
    mock!.state.quote = { bid: 4146.0, ask: 4145.0, ts: NOW_SEC }; // ask < bid
    mock!.state.quoteAgeMs = 1000;
    const r = await quoteIntegrity('XAUUSDm', { bridge: client() });
    expect(r.validationStatus).toBe('INVALID');
    expect(r.issues).toContain('TICK_CROSSED');
    expect(r.signalPermitted).toBe(false);
    expect(r.bid).not.toBeNull(); // values are reported honestly, not hidden…
    expect(r.freshness).toBe('DEGRADED'); // …but never treated as actionable
  });

  test('non-positive price → rejected', async () => {
    mock!.state.quote = { bid: -1, ask: 4145.0, ts: NOW_SEC };
    const r = await quoteIntegrity('XAUUSDm', { bridge: client() });
    expect(r.validationStatus).toBe('INVALID');
    expect(r.issues).toContain('TICK_NON_POSITIVE');
  });

  test('no quote at all → honest absence, DATA_MISSING, signals blocked', async () => {
    const prevQuote = mock!.state.quote;
    mock!.state.quote = null;
    const r = await quoteIntegrity('XAUUSDm', { bridge: client() });
    expect(r.validationStatus).toBe('UNAVAILABLE');
    expect(r.bid).toBeNull();
    expect(r.signalPermitted).toBe(false);
    expect(r.blockedReasons).toContain('TICK_UNAVAILABLE');
    mock!.state.quote = prevQuote; // restore
  });

  test('wrong symbol (not served) → quote unavailable, nothing guessed', async () => {
    mock!.state.quote = { bid: 4145.0, ask: 4145.24, ts: NOW_SEC };
    mock!.state.quoteAgeMs = 1000;
    const r = await quoteIntegrity('EURUSD-mock', { bridge: client() });
    expect(r.bid).toBeNull();
    expect(r.validationStatus).toBe('UNAVAILABLE');
    expect(r.signalPermitted).toBe(false);
  });

  test('no credentials leak: the report never contains MT5 secrets', async () => {
    mock!.state.quote = { bid: 4145.0, ask: 4145.24, ts: NOW_SEC };
    mock!.state.quoteAgeMs = 1000;
    const r = await quoteIntegrity('XAUUSDm', { bridge: client() });
    const serialized = JSON.stringify(r);
    // Secret PATTERNS must never appear in integrity output. The literal test
    // values are synthetic stand-ins (real credentials live ONLY in .env).
    const secrets = ['MT5_PASSWORD', 'x-trader-key', 'password', 'login='];
    for (const s of secrets) {
      expect(serialized.toLowerCase().includes(s.toLowerCase())).toBe(false);
    }
    // And the bridge token configured for tests never crosses into reports.
    expect(serialized.includes('mock-key')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Candle history audit (Task 3)
// ---------------------------------------------------------------------------

describe('auditCandleHistory', () => {
  test('clean series → VALID, correct counts, closure-aware gaps', async () => {
    await db.marketCandle.deleteMany();
    // M5 bars for one full day (288 bars), Wednesday, outside closure windows.
    const bars = makeBars(300, 288, SEED_SEC, { forming: false });
    for (const b of bars) {
      await db.marketCandle.create({
        data: {
          symbol: 'XAUUSDm', timeframe: 'M5',
          candleTimeUtc: new Date(b.t * 1000),
          open: b.o.toFixed(2), high: b.h.toFixed(2), low: b.l.toFixed(2), close: b.c.toFixed(2),
          tickVolume: b.v ?? null, spread: null, source: 'bridge-mt5',
          isForming: false, validationStatus: 'VALID',
          receivedAtUtc: new Date(),
        },
      });
    }
    const report = await auditCandleHistory('XAUUSDm', ['M5']);
    const m5 = report.timeframes[0];
    expect(m5.present).toBe(true);
    expect(m5.closedCount).toBe(288);
    expect(m5.duplicateTimestamps).toBe(0);
    expect(m5.invalidOhlc).toBe(0);
    expect(m5.outOfOrder).toBe(0);
    expect(m5.missingOutsideClosure).toBe(0);
    expect(m5.qualityState).toBe('VALID');
    expect(m5.earliestCandleUtc).not.toBeNull();
  });

  // Deterministic clock: closure-window classification is wall-clock dependent
  // (Mon–Thu 20:00–22:00 UTC daily break + Fri/Sat/Sun weekend envelopes).
  // Pin the audit to fixed Wednesday 2026-10-14T12:00:00Z so the seeded gap
  // (Tue 23:45 UTC) is always OUTSIDE every closure envelope — no flakes.
  const AUDIT_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

  test('gap detection: a removed bar outside closure windows → suspicious gap', async () => {
    await db.marketCandle.deleteMany();
    const bars = makeBars(300, 100, AUDIT_NOW_SEC - 28800, { forming: false });
    // Write all bars EXCEPT one in the middle (a genuine gap).
    const gapIdx = 50;
    for (let i = 0; i < bars.length; i++) {
      if (i === gapIdx) continue;
      const b = bars[i];
      await db.marketCandle.create({
        data: {
          symbol: 'XAUUSDm', timeframe: 'M5',
          candleTimeUtc: new Date(b.t * 1000),
          open: b.o.toFixed(2), high: b.h.toFixed(2), low: b.l.toFixed(2), close: b.c.toFixed(2),
          tickVolume: b.v ?? null, spread: null, source: 'bridge-mt5',
          isForming: false, validationStatus: 'VALID',
          receivedAtUtc: new Date(),
        },
      });
    }
    const report = await auditCandleHistory('XAUUSDm', ['M5'], { nowSec: AUDIT_NOW_SEC });
    const m5 = report.timeframes[0];
    expect(m5.closedCount).toBe(99);
    expect(m5.missingOutsideClosure).toBe(1);
    expect(m5.qualityState).toBe('WARNING');
    expect(m5.issues).toContain('GAP_POSSIBLE');
  });

  test('invalid OHLC (high < open) → counted as invalid, quality INVALID', async () => {
    await db.marketCandle.deleteMany();
    const bars = makeBars(300, 50, SEED_SEC - 50 * 300, { forming: false });
    for (const b of bars) {
      const corrupt = b.t === bars[10].t;
      await db.marketCandle.create({
        data: {
          symbol: 'XAUUSDm', timeframe: 'M5',
          candleTimeUtc: new Date(b.t * 1000),
          open: b.o.toFixed(2),
          high: corrupt ? (b.o - 5).toFixed(2) : b.h.toFixed(2), // high < open — invalid
          low: b.l.toFixed(2), close: b.c.toFixed(2),
          tickVolume: b.v ?? null, spread: null, source: 'bridge-mt5',
          isForming: false, validationStatus: 'VALID',
          receivedAtUtc: new Date(),
        },
      });
    }
    const report = await auditCandleHistory('XAUUSDm', ['M5']);
    expect(report.timeframes[0].invalidOhlc).toBe(1);
    expect(report.timeframes[0].qualityState).toBe('INVALID');
  });

  test('missing timeframe entirely → MISSING with DATA_MISSING (never fabricated)', async () => {
    await db.marketCandle.deleteMany();
    const report = await auditCandleHistory('XAUUSDm', ['H4']);
    const h4 = report.timeframes[0];
    expect(h4.present).toBe(false);
    expect(h4.qualityState).toBe('MISSING');
    expect(h4.issues).toContain('DATA_MISSING');
    expect(report.h4Coverage.closedCount).toBe(0);
  });

  test('forming candle counted separately, never as closed history', async () => {
    await db.marketCandle.deleteMany();
    const bars = makeBars(300, 30, SEED_SEC, { forming: true });
    for (const b of bars) {
      await db.marketCandle.create({
        data: {
          symbol: 'XAUUSDm', timeframe: 'M5',
          candleTimeUtc: new Date(b.t * 1000),
          open: b.o.toFixed(2), high: b.h.toFixed(2), low: b.l.toFixed(2), close: b.c.toFixed(2),
          tickVolume: b.v ?? null, spread: null, source: 'bridge-mt5',
          isForming: b.f === 1, validationStatus: 'VALID',
          receivedAtUtc: new Date(),
        },
      });
    }
    const report = await auditCandleHistory('XAUUSDm', ['M5']);
    const m5 = report.timeframes[0];
    expect(m5.formingCount).toBe(1);
    expect(m5.closedCount).toBe(29);
    expect(m5.latestFormingCandleUtc).not.toBeNull();
  });

  test('H4 coverage note never claims "full history"', async () => {
    const report = await auditCandleHistory('XAUUSDm', ['H4']);
    // Absent data says absent; present data must say the range is only what
    // the broker served — neither may claim full history.
    expect(report.h4Coverage.coverageNote).toMatch(/absent|NOT claimed/);
    expect(report.h4Coverage.coverageNote).not.toMatch(/full history (is )?available/i);
  });
});
