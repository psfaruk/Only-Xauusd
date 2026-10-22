/**
 * PHASE 5 — BACKTEST LATEST HONESTY BLOCK TESTS (Task 42-S3).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic BacktestRun rows on the ISOLATED TEST DATABASE —
 * never real backtest results.
 *
 * Pins the surfaced report contract of /api/backtest/latest (via
 * getLatestBacktest) and the empty fallback:
 *   · sampleAdequacy computed from the stored trade count (12 → INSUFFICIENT,
 *     50 → PRELIMINARY, 150 → ADEQUATE)
 *   · bootstrap CI over the stored trade list's R-multiples (samples === count,
 *     p05 ≤ median ≤ p95, deterministic seed 42)
 *   · dataRangeUtc mirrors the run's dataset window
 *   · corrupt/unparseable trade JSON → tradeCount 0, bootstrapCi null, still
 *     an INSUFFICIENT_EVIDENCE label (fail-closed, never a crash)
 *   · the empty block (no run at all) still carries the label
 */

import { afterAll, describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { db } from '@/lib/db';
import { bootstrapR } from '@/lib/backtest/bootstrap';
import {
  emptyBacktestHonestyBlock,
  getLatestBacktest,
} from '@/lib/backtest/service';

function tradeRow(rMultiple: number) {
  return {
    segment: 'dev' as const,
    direction: 'long' as const,
    signalBarTimeUtcSec: 1_791_000_000,
    entryBarTimeUtcSec: 1_791_000_900,
    entryPrice: 2650.14,
    stopLoss: 2640,
    target: 2670,
    exitBarTimeUtcSec: 1_791_002_700,
    exitPrice: 2670,
    exitReason: 'target' as const,
    pnlPrice: 19.72,
    rMultiple,
    outcomeAtSignal: 'BUY_SETUP',
    reasonCodesAtSignal: [],
  };
}

async function insertRun(opts: { tradesJson: string; createdOffsetMs: number; symbol?: string }) {
  return db.backtestRun.create({
    data: {
      strategyVersion: '8.0.0-structure-proxy',
      symbol: opts.symbol ?? 'XAUUSDm',
      timeframe: 'M15',
      status: 'completed',
      datasetFingerprint: `fp-${opts.createdOffsetMs}`,
      datasetFromUtc: new Date(1_791_000_000_000),
      datasetToUtc: new Date(1_791_100_000_000),
      candleCount: 800,
      source: 'bridge-mt5',
      exclusions: JSON.stringify([]),
      rules: JSON.stringify({ devSplitFraction: 0.7 }),
      devMetrics: JSON.stringify({ status: 'COMPUTED' }),
      oosMetrics: JSON.stringify({ status: 'COMPUTED' }),
      trades: opts.tradesJson,
      limitations: JSON.stringify(['Backtests are simulations.']),
      durationMs: 12,
      createdAt: new Date(Date.now() + opts.createdOffsetMs), // ordering control
    },
  });
}

/** Deterministic mixed R-multiples (seedless arithmetic — fixed list). */
function rList(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(i % 3 === 0 ? -1 : 1.6 + (i % 7) * 0.05);
  }
  return out;
}

afterAll(async () => {
  await db.$disconnect();
});

describe('getLatestBacktest — honesty block on the surfaced report', () => {
  test('12 trades → INSUFFICIENT_EVIDENCE + bootstrap CI over the stored list', async () => {
    const rs = rList(12);
    await insertRun({ tradesJson: JSON.stringify(rs.map(tradeRow)), createdOffsetMs: 1000 });
    const latest = await getLatestBacktest('XAUUSDm');
    expect(latest).not.toBeNull();
    if (!latest) return;
    expect(latest.sampleAdequacy).toBe('INSUFFICIENT_EVIDENCE');
    expect(latest.tradeCount).toBe(12);
    expect(latest.uncertaintyNote).toContain('প্রমাণ নয়');
    expect(latest.dataRangeUtc).toEqual({
      fromUtc: new Date(1_791_000_000_000).toISOString(),
      toUtc: new Date(1_791_100_000_000).toISOString(),
    });
    expect(latest.bootstrapCi).not.toBeNull();
    if (latest.bootstrapCi) {
      expect(latest.bootstrapCi.samples).toBe(12);
      expect(latest.bootstrapCi.p05ExpectancyR!).toBeLessThanOrEqual(latest.bootstrapCi.medianExpectancyR!);
      expect(latest.bootstrapCi.medianExpectancyR!).toBeLessThanOrEqual(latest.bootstrapCi.p95ExpectancyR!);
      // identical to the pure utility over the same list (same seed)
      const pure = bootstrapR(rs, 1000, 42);
      expect(latest.bootstrapCi.p05ExpectancyR).toBe(pure.p05ExpectancyR);
      expect(latest.bootstrapCi.p95ExpectancyR).toBe(pure.p95ExpectancyR);
    }
  });

  test('50 trades → PRELIMINARY; 150 trades → ADEQUATE (latest wins by createdAt)', async () => {
    await insertRun({ tradesJson: JSON.stringify(rList(50).map(tradeRow)), createdOffsetMs: 2000 });
    const mid = await getLatestBacktest('XAUUSDm');
    expect(mid?.sampleAdequacy).toBe('PRELIMINARY');
    expect(mid?.tradeCount).toBe(50);
    expect(mid?.uncertaintyNote).toContain('প্রাথমিক');

    await insertRun({ tradesJson: JSON.stringify(rList(150).map(tradeRow)), createdOffsetMs: 3000 });
    const big = await getLatestBacktest('XAUUSDm');
    expect(big?.sampleAdequacy).toBe('ADEQUATE');
    expect(big?.tradeCount).toBe(150);
    expect(big?.uncertaintyNote).toContain('লাইভ প্রমাণ নয়');
    expect(big?.bootstrapCi?.samples).toBe(150);
  });

  test('corrupt trade JSON → tradeCount 0, bootstrapCi null, label still present (fail-closed)', async () => {
    await insertRun({ tradesJson: '{"corrupt":"not-an-array"}', createdOffsetMs: 4000 });
    const latest = await getLatestBacktest('XAUUSDm');
    expect(latest).not.toBeNull();
    if (!latest) return;
    expect(latest.tradeCount).toBe(0);
    expect(latest.sampleAdequacy).toBe('INSUFFICIENT_EVIDENCE');
    expect(latest.bootstrapCi).toBeNull();
    expect(latest.uncertaintyNote.length).toBeGreaterThan(10);
  });

  test('emptyBacktestHonestyBlock — the no-run fallback still carries the label', () => {
    const block = emptyBacktestHonestyBlock();
    expect(block.sampleAdequacy).toBe('INSUFFICIENT_EVIDENCE');
    expect(block.tradeCount).toBe(0);
    expect(block.dataRangeUtc).toBeNull();
    expect(block.bootstrapCi).toBeNull();
    expect(block.uncertaintyNote).toContain('নমুনা ছোট');
  });
});
