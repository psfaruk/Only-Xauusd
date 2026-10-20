/**
 * PHASE 7 RISK SERVICE TESTS — persistence & TradeApproval counting.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: no bridge and no real broker data. All rows are synthetic
 * and live in the ISOLATED test database (tests/market/helpers/setup.ts points
 * DATABASE_URL at db/test-market.db — the real db/custom.db is never touched).
 * RiskCheckResult fixtures come from the REAL deterministic engine (the thing
 * under test is the persistence + counting layer, not the math).
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { db } from '@/lib/db';
import { runRiskCheck } from '@/lib/risk/engine';
import {
  approvedToday,
  getRiskCheckCounts,
  latestRiskCheckForSignal,
  persistRiskCheck,
  pendingApprovals,
  sameSetupApprovedToday,
  startOfUtcDay,
} from '@/lib/risk/service';
import type { RiskCheckResult } from '@/lib/risk/types';

const NOW = new Date('2026-10-20T15:30:45.000Z'); // Tuesday, mid-week UTC day

function passResult(): RiskCheckResult {
  return runRiskCheck({
    signalId: 'sig-svc-1',
    direction: 'BUY',
    entry: 4150,
    stopLoss: 4140,
    takeProfit: 4170,
    symbol: 'XAUUSDm',
    spread: 0.24,
    existingOpenPositions: 0,
    existingPendingApprovals: 0,
    sameSetupApprovedToday: 0,
    equity: 5000,
    balance: 5000,
    symbolDigits: 3,
    tickValuePerLot: 100,
    evaluatedAtUtc: '2026-10-20T15:30:45.000Z',
  });
}

function failResult(): RiskCheckResult {
  return runRiskCheck({
    signalId: 'sig-svc-2',
    direction: 'BUY',
    entry: 4150,
    stopLoss: 4140,
    takeProfit: 4170,
    symbol: 'XAUUSDm',
    spread: 0.24,
    existingOpenPositions: 0,
    existingPendingApprovals: 0,
    sameSetupApprovedToday: 0,
    equity: null, // honest fail-closed path
    balance: null,
    symbolDigits: 3,
    tickValuePerLot: 100,
    evaluatedAtUtc: '2026-10-20T15:30:45.000Z',
  });
}

async function seedApproval(
  signalId: string,
  status: string,
  createdAt: Date,
): Promise<void> {
  await db.tradeApproval.create({
    data: { signalId, status, createdAt, decidedAt: status === 'pending' ? null : createdAt },
  });
}

beforeEach(async () => {
  await db.riskCheck.deleteMany();
  await db.tradeApproval.deleteMany();
});

// File-level cleanup so seeded rows never leak into other test files sharing
// this process (same hermeticity rule as tests/analysis/persistence-api.test.ts).
afterAll(async () => {
  await db.riskCheck.deleteMany();
  await db.tradeApproval.deleteMany();
});

describe('risk service — persistRiskCheck / latestRiskCheckForSignal', () => {
  test('round-trip: persisted row reads back with the parsed checks array', async () => {
    const result = passResult();
    await persistRiskCheck('sig-svc-1', result);
    const stored = await latestRiskCheckForSignal('sig-svc-1');
    expect(stored).not.toBeNull();
    expect(stored!.signalId).toBe('sig-svc-1');
    expect(stored!.passed).toBe(true);
    expect(stored!.checks).toEqual(result.checks); // exact JSON round-trip
    expect(stored!.checks).toHaveLength(9);
    expect(stored!.createdAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('unknown signal → null (absent stays absent, never fabricated)', async () => {
    expect(await latestRiskCheckForSignal('never-seen')).toBeNull();
  });

  test('append-only: multiple checks coexist; latest is the newest row', async () => {
    await persistRiskCheck('sig-svc-1', passResult());
    await new Promise((r) => setTimeout(r, 20)); // distinct createdAt (ms precision)
    await persistRiskCheck('sig-svc-1', failResult());
    const rows = await db.riskCheck.count({ where: { signalId: 'sig-svc-1' } });
    expect(rows).toBe(2); // nothing was overwritten
    const latest = await latestRiskCheckForSignal('sig-svc-1');
    expect(latest!.passed).toBe(false); // newest = the failed one
    // and the older row is still fully intact
    const all = await db.riskCheck.findMany({ where: { signalId: 'sig-svc-1' } });
    expect(all.some((r) => r.passed === true)).toBe(true);
  });

  test('a FAILED result persists honestly (passed=false row, no silent dropping)', async () => {
    await persistRiskCheck('sig-svc-2', failResult());
    const stored = await latestRiskCheckForSignal('sig-svc-2');
    expect(stored!.passed).toBe(false);
    const failedRules = stored!.checks.filter((c) => !c.passed).map((c) => c.rule);
    expect(failedRules).toContain('EQUITY_AVAILABLE');
    expect(failedRules).toContain('LOT_SIZE_COMPUTABLE');
  });
});

describe('risk service — TradeApproval-derived counters', () => {
  test('approvedToday counts ONLY approved rows created since UTC midnight', async () => {
    const today = new Date('2026-10-20T09:00:00.000Z');
    const yesterday = new Date('2026-10-19T23:59:59.000Z');
    await seedApproval('sig-a', 'approved', today); // counts
    await seedApproval('sig-b', 'approved', today); // counts
    await seedApproval('sig-c', 'approved', yesterday); // too old
    await seedApproval('sig-d', 'pending', today); // wrong status
    await seedApproval('sig-e', 'rejected', today); // wrong status
    expect(await approvedToday(NOW)).toBe(2);
  });

  test('sameSetupApprovedToday counts ONLY the given signalId approved today', async () => {
    await seedApproval('sig-a', 'approved', new Date('2026-10-20T08:00:00.000Z'));
    await seedApproval('sig-a', 'approved', new Date('2026-10-20T10:00:00.000Z'));
    await seedApproval('sig-a', 'approved', new Date('2026-10-19T10:00:00.000Z')); // yesterday
    await seedApproval('sig-b', 'approved', new Date('2026-10-20T11:00:00.000Z')); // other setup
    await seedApproval('sig-a', 'pending', new Date('2026-10-20T12:00:00.000Z')); // not approved
    expect(await sameSetupApprovedToday('sig-a', NOW)).toBe(2);
    expect(await sameSetupApprovedToday('sig-b', NOW)).toBe(1);
    expect(await sameSetupApprovedToday('sig-unknown', NOW)).toBe(0);
  });

  test('pendingApprovals counts pending rows across all signals', async () => {
    await seedApproval('sig-a', 'pending', new Date('2026-10-20T08:00:00.000Z'));
    await seedApproval('sig-b', 'pending', new Date('2026-10-18T08:00:00.000Z'));
    await seedApproval('sig-c', 'approved', new Date('2026-10-20T08:00:00.000Z'));
    expect(await pendingApprovals()).toBe(2);
  });

  test('empty TradeApproval table (the Phase 7/9 reality) → honest zeros', async () => {
    expect(await approvedToday(NOW)).toBe(0);
    expect(await pendingApprovals()).toBe(0);
    expect(await sameSetupApprovedToday('any', NOW)).toBe(0);
  });
});

describe('risk service — aggregated counts & helpers', () => {
  test('getRiskCheckCounts aggregates rows + approvals', async () => {
    await persistRiskCheck('sig-1', passResult());
    await new Promise((r) => setTimeout(r, 20));
    await persistRiskCheck('sig-2', passResult());
    await new Promise((r) => setTimeout(r, 20));
    await persistRiskCheck('sig-3', failResult());
    await seedApproval('sig-1', 'approved', new Date('2026-10-20T09:00:00.000Z'));
    await seedApproval('sig-2', 'pending', new Date('2026-10-20T10:00:00.000Z'));
    const counts = await getRiskCheckCounts(NOW);
    expect(counts).toEqual({
      totalRiskChecks: 3,
      passedRiskChecks: 2,
      failedRiskChecks: 1,
      approvedToday: 1,
      pendingApprovals: 1,
    });
  });

  test('startOfUtcDay truncates to UTC midnight', () => {
    expect(startOfUtcDay(NOW).toISOString()).toBe('2026-10-20T00:00:00.000Z');
    // 23:59:59.999 stays on its own day; 00:00:00.000 stays midnight
    expect(startOfUtcDay(new Date('2026-10-20T23:59:59.999Z')).toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(startOfUtcDay(new Date('2026-10-20T00:00:00.000Z')).toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });
});
