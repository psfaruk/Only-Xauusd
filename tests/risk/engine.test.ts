/**
 * PHASE 7 RISK ENGINE TESTS — deterministic position-sizing gate.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: no DB, no bridge, no clock — the engine is PURE and every
 * input below is synthetic. The RISK_* env is pinned to defaults by
 * tests/market/helpers/setup.ts, so these tests are hermetic (they can never
 * depend on a developer .env).
 *
 * Pinned config under test (defaults):
 *   percentPerTrade 1.0 · maxLots 0.10 · minLots 0.01 · maxOpenPositions 2
 *   maxPendingApprovals 3 · maxOrdersPerDay 6 · maxSpreadPrice 0.6
 *   minEquity 0 · lotStep 0.01
 *
 * Reference math (BUY happy path): equity 5000 → riskAmount 50;
 * stopDistance 10; rawLot = 50 / (10 × 100) = 0.05 lots.
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { runRiskCheck, riskConfigSnapshot } from '@/lib/risk/engine';
import type { RiskCheckInput } from '@/lib/risk/types';

const EVALUATED_AT = '2026-10-20T12:00:00.000Z';

function baseInput(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    signalId: 'sig-test-1',
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
    evaluatedAtUtc: EVALUATED_AT,
    ...overrides,
  };
}

function rule(result: ReturnType<typeof runRiskCheck>, name: string) {
  return result.checks.find((c) => c.rule === name);
}

describe('risk engine — happy path (BUY & SELL)', () => {
  test('BUY: all 9 rules pass, lot computed exactly (0.05), amounts surfaced', () => {
    const r = runRiskCheck(baseInput());
    expect(r.passed).toBe(true);
    expect(r.lotSize).toBe(0.05);
    expect(r.riskAmount).toBe(50);
    expect(r.stopDistance).toBe(10);
    expect(r.accountEquity).toBe(5000);
    expect(r.accountBalance).toBe(5000);
    expect(r.evaluatedAtUtc).toBe(EVALUATED_AT);
    expect(r.checks).toHaveLength(9);
    expect(r.checks.every((c) => c.passed)).toBe(true);
    // exact rule set + order (audit-stable)
    expect(r.checks.map((c) => c.rule)).toEqual([
      'EQUITY_AVAILABLE',
      'STOP_DISTANCE_VALID',
      'LOT_SIZE_COMPUTABLE',
      'LOT_WITHIN_CAP',
      'SPREAD_WITHIN_LIMIT',
      'EXPOSURE_LIMIT',
      'PENDING_APPROVAL_LIMIT',
      'DAILY_ORDER_LIMIT',
      'DUPLICATE_PROTECTION',
    ]);
  });

  test('SELL: direction-consistent levels pass and produce the same lot math', () => {
    const r = runRiskCheck(
      baseInput({ direction: 'SELL', entry: 4150, stopLoss: 4160, takeProfit: 4130 }),
    );
    expect(r.passed).toBe(true);
    expect(r.lotSize).toBe(0.05);
    expect(r.stopDistance).toBe(10);
  });

  test('lot capped at RISK_MAX_LOTS when equity would allow more (capping noted, still PASS)', () => {
    // equity 20000 → riskAmount 200 → rawLot 0.2 → capped to 0.10
    const r = runRiskCheck(baseInput({ equity: 20000, balance: 20000 }));
    expect(r.passed).toBe(true);
    expect(r.lotSize).toBe(0.1);
    expect(r.riskAmount).toBe(200);
    const computable = rule(r, 'LOT_SIZE_COMPUTABLE');
    expect(computable?.passed).toBe(true);
    expect(computable?.detail).toContain('ক্যাপ');
    expect(rule(r, 'LOT_WITHIN_CAP')?.passed).toBe(true);
  });

  test('lot exactly at the cap is NOT capped (boundary: rawLot == maxLots)', () => {
    // equity 10000 → riskAmount 100 → rawLot exactly 0.10 (FP-safe flooring)
    const r = runRiskCheck(baseInput({ equity: 10000, balance: 10000 }));
    expect(r.passed).toBe(true);
    expect(r.lotSize).toBe(0.1);
    expect(rule(r, 'LOT_SIZE_COMPUTABLE')?.detail).not.toContain('ক্যাপ');
  });
});

describe('risk engine — stop-distance & level validation (fail-closed)', () => {
  test('zero stop distance (entry === SL) FAILs STOP_DISTANCE_VALID and yields no lot', () => {
    const r = runRiskCheck(baseInput({ stopLoss: 4150 }));
    expect(r.passed).toBe(false);
    expect(r.lotSize).toBeNull();
    const sd = rule(r, 'STOP_DISTANCE_VALID');
    expect(sd?.passed).toBe(false);
    expect(sd?.detail).toContain('শূন্য');
    expect(rule(r, 'LOT_SIZE_COMPUTABLE')?.passed).toBe(false);
    expect(rule(r, 'LOT_WITHIN_CAP')?.passed).toBe(false);
    expect(r.stopDistance).toBeNull();
  });

  test('BUY with SL above entry (wrong side) FAILs with direction-inconsistency detail', () => {
    const r = runRiskCheck(baseInput({ stopLoss: 4160 }));
    expect(r.passed).toBe(false);
    expect(rule(r, 'STOP_DISTANCE_VALID')?.passed).toBe(false);
    expect(rule(r, 'STOP_DISTANCE_VALID')?.detail).toContain('অসঙ্গত');
    expect(r.lotSize).toBeNull();
  });

  test('SELL with SL below entry (wrong side) FAILs', () => {
    const r = runRiskCheck(
      baseInput({ direction: 'SELL', stopLoss: 4140, takeProfit: 4130 }),
    );
    expect(r.passed).toBe(false);
    expect(rule(r, 'STOP_DISTANCE_VALID')?.passed).toBe(false);
  });

  test('BUY with TP below entry (TP on wrong side) FAILs', () => {
    const r = runRiskCheck(baseInput({ takeProfit: 4130 }));
    expect(r.passed).toBe(false);
    expect(rule(r, 'STOP_DISTANCE_VALID')?.passed).toBe(false);
    expect(rule(r, 'STOP_DISTANCE_VALID')?.detail).toContain('অসঙ্গত');
  });

  test('non-finite levels FAIL honestly (no guessed numbers)', () => {
    const r = runRiskCheck(baseInput({ entry: Number.NaN, stopLoss: Number.POSITIVE_INFINITY }));
    expect(r.passed).toBe(false);
    expect(rule(r, 'STOP_DISTANCE_VALID')?.passed).toBe(false);
    expect(r.lotSize).toBeNull();
  });
});

describe('risk engine — equity & tick value (fail-closed on missing data)', () => {
  test('equity null FAILs EQUITY_AVAILABLE (ইকুইটি অনুপলব্ধ) and blocks lot computation', () => {
    const r = runRiskCheck(baseInput({ equity: null, balance: null }));
    expect(r.passed).toBe(false);
    const eq = rule(r, 'EQUITY_AVAILABLE');
    expect(eq?.passed).toBe(false);
    expect(eq?.detail).toContain('ইকুইটি তথ্য অনুপলব্ধ');
    expect(rule(r, 'LOT_SIZE_COMPUTABLE')?.passed).toBe(false);
    expect(r.lotSize).toBeNull();
    expect(r.riskAmount).toBeNull();
    expect(r.accountEquity).toBeNull();
  });

  test('equity below RISK_MIN_EQUITY (negative equity, floor 0) FAILs', () => {
    const r = runRiskCheck(baseInput({ equity: -50, balance: -50 }));
    expect(r.passed).toBe(false);
    expect(rule(r, 'EQUITY_AVAILABLE')?.passed).toBe(false);
    expect(rule(r, 'EQUITY_AVAILABLE')?.detail).toContain('সর্বনিম্ন সীমা');
  });

  test('tickValuePerLot null / 0 FAILs LOT_SIZE_COMPUTABLE honestly', () => {
    for (const bad of [null, 0, -100, Number.NaN]) {
      const r = runRiskCheck(baseInput({ tickValuePerLot: bad }));
      expect(r.passed).toBe(false);
      const c = rule(r, 'LOT_SIZE_COMPUTABLE');
      expect(c?.passed).toBe(false);
      expect(c?.detail).toContain('tickValuePerLot');
      expect(r.lotSize).toBeNull();
    }
  });
});

describe('risk engine — lot floor & step rounding', () => {
  test('computed lot below RISK_MIN_LOTS FAILs with the computed value in the detail', () => {
    // equity 1000 → riskAmount 10 → rawLot 10/(50×100) = 0.002 → floor 0.00 < 0.01
    const r = runRiskCheck(baseInput({ equity: 1000, balance: 1000, stopLoss: 4100, takeProfit: 4200 }));
    expect(r.passed).toBe(false);
    const c = rule(r, 'LOT_SIZE_COMPUTABLE');
    expect(c?.passed).toBe(false);
    expect(c?.detail).toContain('সর্বনিম্ন লট');
    expect(c?.detail).toContain('0.002'); // the raw computed value is disclosed
    expect(r.lotSize).toBeNull();
    expect(r.riskAmount).toBe(10);
  });

  test('lot floored DOWN to RISK_LOT_STEP (0.05555 → 0.05, never rounded up)', () => {
    // equity 5555 → riskAmount 55.55 → rawLot 0.05555 → floor 0.05
    const r = runRiskCheck(baseInput({ equity: 5555, balance: 5555 }));
    expect(r.lotSize).toBe(0.05);
    expect(r.passed).toBe(true);
  });

  test('lot step rounding is FP-safe (rawLot 0.0833… → 0.08; rawLot 0.0999… → 0.09)', () => {
    const a = runRiskCheck(baseInput({ stopLoss: 4144, takeProfit: 4162 }));
    expect(a.lotSize).toBe(0.08); // 50 / (6 × 100) = 0.08333… → floored down, under the cap
    const b = runRiskCheck(baseInput({ equity: 9999, balance: 9999 }));
    expect(b.lotSize).toBe(0.09); // 99.99 / (10 × 100) = 0.09999 → floored down (NOT rounded to 0.1)
  });
});

describe('risk engine — spread & limit checks', () => {
  test('spread above RISK_MAX_SPREAD_PRICE FAILs (lot still computed & disclosed)', () => {
    const r = runRiskCheck(baseInput({ spread: 0.9 }));
    expect(r.passed).toBe(false);
    const sp = rule(r, 'SPREAD_WITHIN_LIMIT');
    expect(sp?.passed).toBe(false);
    expect(sp?.detail).toContain('0.9');
    // checks 1–3 passed → the honest computed lot is still surfaced
    expect(r.lotSize).toBe(0.05);
  });

  test('unavailable spread (NaN) FAILs honestly — never treated as zero', () => {
    const r = runRiskCheck(baseInput({ spread: Number.NaN }));
    expect(r.passed).toBe(false);
    expect(rule(r, 'SPREAD_WITHIN_LIMIT')?.passed).toBe(false);
    expect(rule(r, 'SPREAD_WITHIN_LIMIT')?.detail).toContain('অনুপলব্ধ');
  });

  test('EXPOSURE_LIMIT fails at the cap (2 open positions) and passes below it', () => {
    const fail = runRiskCheck(baseInput({ existingOpenPositions: 2 }));
    expect(rule(fail, 'EXPOSURE_LIMIT')?.passed).toBe(false);
    expect(fail.passed).toBe(false);
    const ok = runRiskCheck(baseInput({ existingOpenPositions: 1 }));
    expect(rule(ok, 'EXPOSURE_LIMIT')?.passed).toBe(true);
    expect(ok.passed).toBe(true);
  });

  test('PENDING_APPROVAL_LIMIT fails at the cap (3 pending)', () => {
    const r = runRiskCheck(baseInput({ existingPendingApprovals: 3 }));
    expect(rule(r, 'PENDING_APPROVAL_LIMIT')?.passed).toBe(false);
    expect(r.passed).toBe(false);
  });

  test('DAILY_ORDER_LIMIT fails at the cap (6 approved today)', () => {
    const r = runRiskCheck(baseInput({ sameSetupApprovedToday: 6 }));
    expect(rule(r, 'DAILY_ORDER_LIMIT')?.passed).toBe(false);
    expect(rule(r, 'DUPLICATE_PROTECTION')?.passed).toBe(false);
    expect(r.passed).toBe(false);
  });

  test('DUPLICATE_PROTECTION fails when the SAME setup was already approved today (count 1)', () => {
    const r = runRiskCheck(baseInput({ sameSetupApprovedToday: 1 }));
    const dup = rule(r, 'DUPLICATE_PROTECTION');
    expect(dup?.passed).toBe(false);
    expect(dup?.detail).toContain('ডুপ্লিকেট');
    // the daily LIMIT itself is still fine (1 < 6) — the rules are separate
    expect(rule(r, 'DAILY_ORDER_LIMIT')?.passed).toBe(true);
    expect(r.passed).toBe(false);
  });
});

describe('risk engine — determinism & purity', () => {
  test('identical input → byte-identical result (no hidden state, no clock)', () => {
    const a = runRiskCheck(baseInput());
    const b = runRiskCheck(baseInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('the engine never reads the clock: evaluatedAtUtc comes from the input (absent → empty)', () => {
    const { evaluatedAtUtc, ...without } = baseInput();
    void evaluatedAtUtc;
    const r = runRiskCheck(without);
    expect(r.evaluatedAtUtc).toBe('');
    expect(r.passed).toBe(true); // the check itself still runs deterministically
  });

  test('riskConfigSnapshot is JSON-safe and exposes all 9 clamped knobs', () => {
    const snap = riskConfigSnapshot();
    expect(snap).toEqual({
      percentPerTrade: 1.0,
      maxLots: 0.1,
      minLots: 0.01,
      maxOpenPositions: 2,
      maxPendingApprovals: 3,
      maxOrdersPerDay: 6,
      maxSpreadPrice: 0.6,
      minEquity: 0,
      lotStep: 0.01,
    });
    expect(() => JSON.stringify(snap)).not.toThrow();
  });
});
