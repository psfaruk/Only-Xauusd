/**
 * AUTOMATED TESTS — STALE DATA SUPPRESSES CONFIRMED SIGNALS
 * (Deep-remediation Phase 2, master prompt §Phase 2 task 6 + acceptance test
 * "Stale data blocks confirmed signals").
 * ----------------------------------------------------------------------------
 * Regression proof at the SERVICE level: when the persisted M1/M5/M15 closed
 * candles are older than the per-TF staleness thresholds, the scalper
 * evaluation is BLOCKED with DATA_STALE-family reason codes and NO emitted
 * setup row is persisted — no fabricated signal can ever reach a consumer.
 *
 * MOCK DISCLOSURE: SYNTHETIC candles/tick/spec on the ISOLATED TEST DATABASE
 * + the clearly-labeled local MOCK BRIDGE (tests/market/helpers/mock-bridge.ts
 * — never real broker data). The scalper service is driven through its
 * injectable bridge + clock (runScalperEvaluation opts.now), so the whole
 * gate pipeline runs hermetically. The quote-integrity clock is NOT
 * injectable, so the mock quote is kept fresh against the REAL clock while
 * the candle/tick staleness is judged against the FIXED test clock.
 */
import './helpers/setup';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { db } from '@/lib/db';
import { createBridgeClient } from '@/lib/market/bridge-client';
import { makeBars, startMockBridge } from './helpers/mock-bridge';
import { FIXED_NOW_MS, FIXED_NOW_SEC } from './helpers/setup';
import { runScalperEvaluation } from '@/lib/signal/scalper-service';
import { SCALPER_STRATEGY_VERSION } from '@/lib/signal/scalper/types';

const SYMBOL = 'XAUUSDm';

let mock: Awaited<ReturnType<typeof startMockBridge>>;

/** Deterministic fresh quote (mock digits=2). `ts`/receipt are judged by the
 *  REAL clock inside quoteIntegrity, so refresh them at call time. */
function freshMockQuote() {
  const nowSec = Math.floor(Date.now() / 1000);
  mock.state.quote = { bid: 2725.1, ask: 2725.36, ts: nowSec };
  mock.state.quoteAgeMs = 0; // receivedAtMs = Date.now() → LIVE, permitted
}

beforeAll(async () => {
  mock = await startMockBridge();
});

afterAll(async () => {
  mock.stop();
  await db.signalEvaluation.deleteMany();
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
});

async function seedCandles(tfs: Array<{ tf: 'M1' | 'M5' | 'M15' | 'H1' | 'H4'; tfSec: number; count: number; lastOpenSec: number }>) {
  for (const { tf, tfSec, count, lastOpenSec } of tfs) {
    for (const b of makeBars(tfSec, count, lastOpenSec)) {
      await db.marketCandle.create({
        data: {
          symbol: SYMBOL,
          timeframe: tf,
          candleTimeUtc: new Date(b.t * 1000),
          open: String(b.o), high: String(b.h), low: String(b.l), close: String(b.c),
          tickVolume: b.v,
          source: 'bridge-mt5',
          isForming: false,
          validationStatus: 'VALID',
          receivedAtUtc: new Date(FIXED_NOW_MS),
        },
      });
    }
  }
}

async function seedTickAndSpec() {
  await db.marketLatestTick.create({
    data: {
      symbol: SYMBOL,
      bid: '2725.100', ask: '2725.360', spread: '0.260',
      tickTimeUtc: new Date(FIXED_NOW_MS),
      receivedAtUtc: new Date(FIXED_NOW_MS),
      source: 'mt5-bridge',
      validationStatus: 'VALID',
    },
  });
  await db.symbolSpec.create({
    data: {
      symbol: SYMBOL,
      digits: 3,
      source: 'mt5-bridge',
      verifiedFields: '["digits"]',
      lastVerifiedAt: new Date(FIXED_NOW_MS),
    },
  });
}

const client = () => createBridgeClient({ baseUrl: mock.url });
const run = () => runScalperEvaluation({ symbol: SYMBOL, now: () => FIXED_NOW_MS, bridge: client() });

const emittedSetupCount = () =>
  db.signalEvaluation.count({
    where: { symbol: SYMBOL, strategyVersion: SCALPER_STRATEGY_VERSION, outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] } },
  });

beforeEach(async () => {
  await db.signalEvaluation.deleteMany();
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
  freshMockQuote();
});

describe('stale market data suppresses confirmed scalper signals (Phase 2 regression)', () => {
  test('all three fast TFs stale (2h old closes vs M1 threshold 420s) → BLOCKED + DATA_STALE, no setup row', async () => {
    // Last closed M1 bar closed ~2h before the injected now — far beyond the
    // 420s M1 / 900s M5 / 2700s M15 staleness thresholds.
    const staleLastOpen = FIXED_NOW_SEC - 7_200;
    await seedCandles([
      { tf: 'M1', tfSec: 60, count: 120, lastOpenSec: staleLastOpen },
      { tf: 'M5', tfSec: 300, count: 120, lastOpenSec: staleLastOpen },
      { tf: 'M15', tfSec: 900, count: 120, lastOpenSec: staleLastOpen },
      { tf: 'H1', tfSec: 3_600, count: 60, lastOpenSec: FIXED_NOW_SEC - 3_600 },
      { tf: 'H4', tfSec: 14_400, count: 60, lastOpenSec: FIXED_NOW_SEC - 14_400 },
    ]);
    await seedTickAndSpec();

    const setupsBefore = await emittedSetupCount();
    const outcome = await run();

    expect(outcome.outcome).toBe('BLOCKED');
    // DATA_STALE-family reason codes (the readiness gate maps per-TF STALE
    // states to DATA_STALE).
    expect(outcome.evaluation.reasonCodes).toContain('DATA_STALE');
    expect(outcome.evaluation.levels).toBeNull();
    expect(outcome.evaluation.evidence).toBeNull();

    // The blocked verdict is persisted append-only (audit trail) — but NO
    // emitted-setup row may exist.
    expect(await emittedSetupCount()).toBe(setupsBefore); // 0 — nothing emitted
    const persisted = await db.signalEvaluation.findMany({
      where: { symbol: SYMBOL, strategyVersion: SCALPER_STRATEGY_VERSION },
    });
    expect(persisted.length).toBe(1);
    expect(persisted[0].outcome).toBe('BLOCKED');
    expect(JSON.parse(persisted[0].reasonCodes)).toContain('DATA_STALE');
    expect(persisted[0].levels).toBeNull();
  });

  test('a SINGLE stale timeframe (M1) still blocks — readiness requires all checked TFs fresh', async () => {
    // M5/M15 fresh; M1 last close 2h old → beyond the 420s M1 threshold.
    await seedCandles([
      { tf: 'M1', tfSec: 60, count: 120, lastOpenSec: FIXED_NOW_SEC - 7_200 },
      { tf: 'M5', tfSec: 300, count: 120, lastOpenSec: FIXED_NOW_SEC - 300 },
      { tf: 'M15', tfSec: 900, count: 120, lastOpenSec: FIXED_NOW_SEC - 900 },
      { tf: 'H1', tfSec: 3_600, count: 60, lastOpenSec: FIXED_NOW_SEC - 3_600 },
      { tf: 'H4', tfSec: 14_400, count: 60, lastOpenSec: FIXED_NOW_SEC - 14_400 },
    ]);
    await seedTickAndSpec();

    const outcome = await run();
    expect(outcome.outcome).toBe('BLOCKED');
    expect(outcome.evaluation.reasonCodes).toContain('DATA_STALE');
    expect(await emittedSetupCount()).toBe(0);
  });

  test('control: the SAME pipeline with fresh windows passes the data gates (no DATA_STALE block)', async () => {
    // Fresh closed bars on every TF (last close exactly at the injected now)
    // — the run must get PAST the readiness gate; whatever the deterministic
    // engine concludes (setup / wait / no-setup on synthetic data), it is not
    // a data-stale BLOCKED. Proves the two cases above block because of
    // staleness, not because of seeding artifacts.
    await seedCandles([
      { tf: 'M1', tfSec: 60, count: 120, lastOpenSec: FIXED_NOW_SEC - 60 },
      { tf: 'M5', tfSec: 300, count: 120, lastOpenSec: FIXED_NOW_SEC - 300 },
      { tf: 'M15', tfSec: 900, count: 120, lastOpenSec: FIXED_NOW_SEC - 900 },
      { tf: 'H1', tfSec: 3_600, count: 60, lastOpenSec: FIXED_NOW_SEC - 3_600 },
      { tf: 'H4', tfSec: 14_400, count: 60, lastOpenSec: FIXED_NOW_SEC - 14_400 },
    ]);
    await seedTickAndSpec();

    const outcome = await run();
    expect(outcome.outcome).not.toBe('BLOCKED');
    expect(outcome.evaluation.reasonCodes).not.toContain('DATA_STALE');
    // Whatever was emitted, it was a genuine engine verdict with evidence.
    expect(outcome.evaluation.evidence).not.toBeNull();
  });
});
