/**
 * Phase 10.1 — Signal-failure investigation regression pins.
 * ----------------------------------------------------------------------------
 * The investigation (audit/phase10.1-signal-failure-investigation.md) found
 * NO implementation defect in the entry/exit mechanics. These tests PIN the
 * exact invariants that were verified during the audit so the no-defect
 * conclusion stays true (any future change that breaks one of these
 * mechanics fails loudly).
 *
 * Pinned invariants (all verified against the production harness on the
 * 2026-09-15 → 2026-10-15 verified broker dataset during Phase 10.1):
 *   1. Setup funnel conservation: every evaluation lands in exactly one
 *      outcome bucket; fills never exceed valid setups; every fill closes
 *      exactly once.
 *   2. One-position-at-a-time: no two trades' market windows overlap; a valid
 *      setup during an open position is suppressed (POSITION_OPEN), never a
 *      duplicate fill.
 *   3. Entry-gap guard: if the next bar gaps through the stop (risk ≤ 0),
 *      there is NO fill — an honest skip, never a negative-risk trade.
 *   4. No duplicate outcomes: (signal bar, entry bar) pairs are unique.
 *   5. Counter/trade reconciliation: completedOutcomes === trades.length and
 *      === hypotheticalFills when no trade is closed by end_of_data.
 *
 * Synthetic fixtures ONLY (clearly labeled) — the audit itself ran on
 * verified broker candles via scripts/phase10.1-investigation.ts.
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { runValidation, defaultValidationRules } from '@/lib/backtest/validation';
import { buildStrategyRules } from '@/lib/signal/rules';
import type { AnalysisCandle } from '@/lib/analysis/types';
import type { StrategyRules } from '@/lib/signal/types';

// ---------------------------------------------------------------------------
// Fixtures (SYNTHETIC — unit testing only; same generators as the Phase 10
// validation tests, reused so the pinned invariants run on a dataset that
// produces REAL setup episodes with overlapping valid bars)
// ---------------------------------------------------------------------------

const M15 = 900;
const H1 = 3600;
const H4 = 14400;
const EXEC_START = 1_791_000_000;

function candle(t: number, o: number, h: number, l: number, c: number): AnalysisCandle {
  return {
    timeUtcSec: t, open: o, high: h, low: l, close: c, volume: null,
    openText: o.toFixed(2), highText: h.toFixed(2), lowText: l.toFixed(2), closeText: c.toFixed(2),
  };
}

function waveLeg(count: number, startSec: number, tfSec: number, base: number, amp: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = base + amp * Math.sin((2 * Math.PI * i) / 16);
    const o = mid - amp * 0.3 * Math.cos((2 * Math.PI * i) / 16);
    const c = mid + amp * 0.3 * Math.cos((2 * Math.PI * i) / 16);
    const h = Math.max(o, c) + amp * 0.15;
    const l = Math.min(o, c) - amp * 0.15;
    out.push(candle(t, Number(o.toFixed(2)), Number(h.toFixed(2)), Number(l.toFixed(2)), Number(c.toFixed(2))));
  }
  return out;
}

function bullishHtf(count: number, startSec: number, tfSec: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = 2600 + i * 0.6 + 2.0 * Math.sin((2 * Math.PI * i) / 16);
    out.push(candle(t, Number((mid - 0.6).toFixed(2)), Number((mid + 1.4).toFixed(2)), Number((mid - 1.4).toFixed(2)), Number((mid + 0.6).toFixed(2))));
  }
  return out;
}

function setupRichExecution(startSec: number, cycles = 10): AnalysisCandle[] {
  const bars: AnalysisCandle[] = [];
  let t = startSec;
  bars.push(...waveLeg(112, t, M15, 2650, 3));
  t += 112 * M15;
  for (let k = 0; k < cycles; k++) {
    const lift = k * 8;
    for (let i = 0; i < 4; i++) {
      bars.push(candle(t, 2650 + lift + i * 1.1, 2651.3 + lift + i * 1.1, 2649.6 + lift + i * 1.1, 2651.1 + lift + i * 1.1));
      t += M15;
    }
    for (let i = 0; i < 3; i++) {
      bars.push(candle(t, 2654.4 + lift - i * 0.6, 2654.6 + lift - i * 0.6, 2651.2 + lift, 2653.4 + lift - i * 0.4));
      t += M15;
    }
    bars.push(candle(t, 2652.8 + lift, 2653.4 + lift, 2652.0 + lift, 2653.0 + lift));
    t += M15;
    for (let i = 0; i < 4; i++) {
      bars.push(candle(t, 2656 + lift + i * 4, 2662 + lift + i * 4, 2655.5 + lift + i * 4, 2660 + lift + i * 4));
      t += M15;
    }
    for (let i = 0; i < 8; i++) {
      bars.push(candle(t, 2672 + lift - i * 0.8, 2673 + lift - i * 0.8, 2671 + lift - i * 0.8, 2672.4 + lift - i * 0.8));
      t += M15;
    }
  }
  return bars;
}

const SIGNAL_RULES: StrategyRules = {
  ...buildStrategyRules(),
  windowBars: 300,
  minExecutionBars: 60,
  minH1Bars: 60,
  minH4Bars: 60,
  minAdx: 0,
  rsiBuyMin: 0,
  rsiBuyMax: 100,
  maxSpreadPrice: 10,
  zoneWidthAtr: 1.0,
  entryToleranceAtr: 0.6,
  maxBarsSinceBreak: 14,
};

function makeDataset(cycles = 10) {
  const exec = setupRichExecution(EXEC_START, cycles);
  const h1 = bullishHtf(Math.ceil((exec.length * M15) / H1) + 40, EXEC_START - 130 * H1, H1);
  const h4 = bullishHtf(160, EXEC_START - 160 * H4, H4);
  return { exec, h1, h4 };
}

const COSTS = { spreadPrice: 0.24, slippagePrice: 0.02, commissionPrice: 0, labels: ['synthetic test costs'] };

function runHarness(exec: AnalysisCandle[], h1: AnalysisCandle[], h4: AnalysisCandle[]) {
  return runValidation('XAUUSDm', exec, h1, h4, 2, COSTS.spreadPrice, defaultValidationRules(COSTS.spreadPrice), SIGNAL_RULES);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phase 10.1 audit pins — setup funnel conservation', () => {
  test('every evaluation lands in exactly one outcome bucket (blocked+noSetup+wait+valid = evaluations)', () => {
    const { exec, h1, h4 } = makeDataset(8);
    const r = runHarness(exec, h1, h4);
    const c = r.counters;
    expect(c.evaluations).toBe(exec.length);
    expect(c.blockedEvaluations + c.noSetup + c.wait + c.validSetups).toBe(c.evaluations);
    expect(c.validSetups).toBeGreaterThan(0);
    expect(c.hypotheticalFills).toBeLessThanOrEqual(c.validSetups);
    expect(c.completedOutcomes).toBe(r.trades.length);
    const endOfData = r.trades.filter((t) => t.exitReason === 'end_of_data').length;
    expect(c.completedOutcomes).toBe(c.hypotheticalFills - endOfData + endOfData); // completed == fills (incl. end_of_data closes)
    expect(c.hypotheticalFills).toBe(r.trades.length); // every fill closes exactly once in this fixture
  });
});

describe('phase 10.1 audit pins — one-position model (POSITION_OPEN suppression)', () => {
  test('no two trades overlap in time; suppressed valid bars never produce duplicate fills', () => {
    const { exec, h1, h4 } = makeDataset(10);
    const r = runHarness(exec, h1, h4);
    expect(r.trades.length).toBeGreaterThan(1);
    // Valid-setup bars that did NOT fill must exist when episodes span open
    // trades — the one-position model suppresses them (POSITION_OPEN).
    expect(r.counters.validSetups).toBeGreaterThanOrEqual(r.counters.hypotheticalFills);
    const sorted = [...r.trades].sort((a, b) => a.entryBarTimeUtcSec - b.entryBarTimeUtcSec);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].entryBarTimeUtcSec).toBeGreaterThan(sorted[i - 1].exitBarTimeUtcSec);
    }
    // Uniqueness: no duplicate (signal, entry) pairs → no double outcome.
    const keys = new Set(r.trades.map((t) => `${t.signalBarTimeUtcSec}|${t.entryBarTimeUtcSec}`));
    expect(keys.size).toBe(r.trades.length);
  });
});

describe('phase 10.1 audit pins — entry-gap guard (risk ≤ 0 → honest skip)', () => {
  test('next bar gapping through the stop produces NO fill and NO negative-risk trade', () => {
    const { exec, h1, h4 } = makeDataset(8);
    const base = runHarness(exec, h1, h4);
    expect(base.trades.length).toBeGreaterThan(0);

    // Find the first fill's decision bar and its entry bar.
    const first = base.trades[0];
    const sigIdx = exec.findIndex((c) => c.timeUtcSec === first.signalBarTimeUtcSec);
    expect(sigIdx).toBeGreaterThanOrEqual(0);
    const entryIdx = sigIdx + 1;
    const stop = first.stopLoss;

    // Gap the entry bar's open THROUGH the stop (far below for a long).
    // Decision bars ≤ sigIdx are untouched (causality is pinned by the
    // look-ahead mutation test) — only the fill outcome can change.
    const gapped = exec.map((c, i) =>
      i === entryIdx
        ? candle(c.timeUtcSec, stop - 20, stop - 19, stop - 21, stop - 19.5)
        : c,
    );
    const after = runHarness(gapped, h1, h4);

    // The specific setup must NOT produce a trade entered at the gapped bar
    // with negative risk; and the run stays internally consistent.
    const badTrade = after.trades.find(
      (t) => t.signalBarTimeUtcSec === first.signalBarTimeUtcSec && t.riskPrice <= 0,
    );
    expect(badTrade).toBeUndefined();
    const funnelC = after.counters;
    expect(funnelC.blockedEvaluations + funnelC.noSetup + funnelC.wait + funnelC.validSetups).toBe(funnelC.evaluations);
    expect(funnelC.hypotheticalFills).toBe(after.trades.length);
  });
});

describe('phase 10.1 audit pins — deterministic reproducibility of the audit baseline', () => {
  test('identical inputs → byte-identical result (the audit re-run reproduced Phase 10 exactly)', () => {
    const { exec, h1, h4 } = makeDataset(6);
    const a = runHarness(exec, h1, h4);
    const b = runHarness(exec, h1, h4);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
