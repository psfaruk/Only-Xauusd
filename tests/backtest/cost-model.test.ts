/**
 * PHASE 10 COST MODEL TESTS.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic numbers only — never real broker data.
 *
 * Pins:
 *   · execution price formulas (entry pays ask+slip, exit receives bid−slip)
 *   · full round-trip cost accounting (spread + 2×slippage + commission)
 *   · gross vs costs vs net separation (net = gross − round trip)
 *   · cost monotonicity: higher costs can never improve net
 *   · validation rejects malformed models
 *   · the Phase 9 relation: net10 = pnl9 − (halfSpread + slip + commission)
 *   · scenario labels always disclose their assumption status
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import {
  applyCosts,
  baselineCostModel,
  entryExecutionPrice,
  exitExecutionPrice,
  roundTripCost,
  stressCostModels,
  validateCostModel,
} from '@/lib/backtest/cost-model';

describe('phase 10 cost model — execution prices', () => {
  test('BUY entry pays ask + slippage; SELL entry receives bid − slippage', () => {
    const m = baselineCostModel(0.24);
    expect(entryExecutionPrice('long', 2650, m)).toBeCloseTo(2650.14, 10);
    expect(entryExecutionPrice('short', 2650, m)).toBeCloseTo(2649.86, 10);
  });

  test('BUY exit receives bid − slippage; SELL exit pays ask + slippage (symmetric)', () => {
    const m = baselineCostModel(0.24);
    expect(exitExecutionPrice('long', 2660, m)).toBeCloseTo(2659.86, 10);
    expect(exitExecutionPrice('short', 2640, m)).toBeCloseTo(2640.14, 10);
  });

  test('slippage-free model halves only the spread per side', () => {
    const m = { spreadPrice: 0.5, slippagePrice: 0, commissionPrice: 0, labels: [] };
    expect(entryExecutionPrice('long', 100, m)).toBeCloseTo(100.25, 10);
    expect(entryExecutionPrice('short', 100, m)).toBeCloseTo(99.75, 10);
  });
});

describe('phase 10 cost model — breakdown and monotonicity', () => {
  test('round trip = spread + 2×slippage + commission', () => {
    expect(roundTripCost(baselineCostModel(0.24))).toBeCloseTo(0.28, 10);
    expect(roundTripCost({ spreadPrice: 0.6, slippagePrice: 0.06, commissionPrice: 0.05, labels: [] })).toBeCloseTo(0.77, 10);
  });

  test('gross is the unadjusted level-to-open measure; net = gross − round trip', () => {
    const m = baselineCostModel(0.24);
    const r = applyCosts('long', 2650, 2660, m);
    expect(r.grossPrice).toBeCloseTo(10, 10);
    expect(r.costsPrice).toBeCloseTo(0.28, 10);
    expect(r.netPrice).toBeCloseTo(9.72, 10);
    const s = applyCosts('short', 2650, 2640, m);
    expect(s.grossPrice).toBeCloseTo(10, 10);
    expect(s.netPrice).toBeCloseTo(9.72, 10);
  });

  test('higher costs can never improve net (monotonicity)', () => {
    const cheap = applyCosts('long', 2650, 2660, baselineCostModel(0.24));
    const stressed = applyCosts('long', 2650, 2660, { spreadPrice: 0.4, slippagePrice: 0.04, commissionPrice: 0, labels: [] });
    const worst = applyCosts('long', 2650, 2660, { spreadPrice: 0.6, slippagePrice: 0.06, commissionPrice: 0.05, labels: [] });
    expect(cheap.netPrice).toBeGreaterThan(stressed.netPrice);
    expect(stressed.netPrice).toBeGreaterThan(worst.netPrice);
  });

  test('documented relation to the Phase 9 accounting: net10 = pnl9 − (halfSpread + slip + commission)', () => {
    // Phase 9: pnl9 = exitLevel − (rawOpen + halfSpread + slip) for a long.
    const m = baselineCostModel(0.24);
    const rawOpen = 2650, exitLevel = 2660;
    const pnl9 = exitLevel - (rawOpen + m.spreadPrice / 2 + m.slippagePrice);
    const r = applyCosts('long', rawOpen, exitLevel, m);
    expect(r.netPrice).toBeCloseTo(pnl9 - (m.spreadPrice / 2 + m.slippagePrice + m.commissionPrice), 10);
  });

  test('malformed models are rejected with explicit problems', () => {
    expect(validateCostModel(baselineCostModel(0.24))).toEqual([]);
    expect(validateCostModel({ spreadPrice: -1, slippagePrice: 0, commissionPrice: 0, labels: [] }).length).toBeGreaterThan(0);
    expect(validateCostModel({ spreadPrice: 0.2, slippagePrice: Number.NaN, commissionPrice: 0, labels: [] }).length).toBeGreaterThan(0);
  });

  test('stress scenarios: names, ordering and honest labels', () => {
    const scenarios = stressCostModels(0.24);
    expect(scenarios.map((s) => s.name)).toEqual(['baseline', 'stressed', 'high_stress']);
    expect(scenarios[1].model.spreadPrice).toBeGreaterThanOrEqual(0.4);
    expect(scenarios[2].model.spreadPrice).toBeGreaterThanOrEqual(0.6);
    for (const s of scenarios) {
      expect(s.model.labels.length).toBeGreaterThan(0); // assumption always disclosed
    }
    // baseline labels must explicitly say the spread is a CURRENT OBSERVATION
    expect(scenarios[0].model.labels.join(' ')).toContain('CURRENT OBSERVATION');
  });
});
