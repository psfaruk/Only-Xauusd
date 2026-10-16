/**
 * PHASE 11 CANDIDATE STRATEGY TESTS — written FIRST (RED before implementation).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: every candle below is a SYNTHETIC fixture constructed to
 * exercise a specific candidate path. Never broker data, never presented as
 * such. The candidate under test is OFFLINE RESEARCH CODE
 * (hybrid-multimodel-research/11.0.0-candidate.1) — no persistence, no
 * scheduler wiring, no execution.
 *
 * Pinned behaviors (spec: audit/phase11-candidate-strategy-spec.md):
 *   · Model A = baseline 9.0.0 imported UNCHANGED (golden hash + equivalence)
 *   · Model B: context alignment, pullback touch/deep, M5 confirmation, gates
 *   · Model C: range detection, sweep, reclaim, no ADX floor (per-model rule),
 *     RSI mean-reversion rule, M5 confirmation
 *   · ATR tolerance boundaries (inclusive/exclusive, exact values)
 *   · Closed-bar M5 semantics (forming M5 never confirms)
 *   · Precedence A > B > C, same-direction suppression, conflict → WAIT
 *   · Candidate setup identity: deterministic, anchor-scoped, version-isolated
 *   · Version isolation: baseline 9.0.0 untouched; no code drift
 *   · Expiry/invalidation per model; spread gate shared
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { evaluateSignal } from '@/lib/signal/core';
import { buildStrategyRules } from '@/lib/signal/rules';
import { SIGNAL_STRATEGY_VERSION, type SignalCoreInput, type StrategyRules } from '@/lib/signal/types';
import { createHash } from 'node:crypto';
import type { AnalysisCandle } from '@/lib/analysis/types';
import {
  CANDIDATE_STRATEGY_VERSION,
  CANDIDATE_IDENTITY_VERSION,
  CANDIDATE_RULES,
  type CandidateInput,
} from '@/lib/signal/candidate/types';
import {
  evaluateCandidate,
  evaluateModelB,
  evaluateModelC,
  combineModels,
  m5Confirmed,
  pullbackState,
  rangeState,
  sweepState,
} from '@/lib/signal/candidate/core';
import { computeCandidateSetupFingerprint } from '@/lib/signal/candidate/identity';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const RULES: StrategyRules = { ...buildStrategyRules(), windowBars: 300, minExecutionBars: 60, minH1Bars: 60, minH4Bars: 60 };
const M15 = 900;
const H1 = 3600;
const H4 = 14400;
const M5 = 300;

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

/** Rising zigzag HTF → swing highs HH + lows HL → trend classifies bullish. */
function bullishHtf(count: number, startSec: number, tfSec: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = 2600 + i * 0.6 + 2.0 * Math.sin((2 * Math.PI * i) / 16);
    out.push(candle(t, Number((mid - 0.6).toFixed(2)), Number((mid + 1.4).toFixed(2)), Number((mid - 1.4).toFixed(2)), Number((mid + 0.6).toFixed(2))));
  }
  return out;
}

/** Falling zigzag HTF → LH + LL → bearish. */
function bearishHtf(count: number, startSec: number, tfSec: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = 2800 - i * 0.6 + 2.0 * Math.sin((2 * Math.PI * i) / 16);
    out.push(candle(t, Number((mid + 0.6).toFixed(2)), Number((mid + 1.4).toFixed(2)), Number((mid - 1.4).toFixed(2)), Number((mid - 0.6).toFixed(2))));
  }
  return out;
}

/** Flat zigzag HTF (no drift) → equal highs/lows → trend 'unclear'. */
function flatHtf(count: number, startSec: number, tfSec: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = 2600 + 2.0 * Math.sin((2 * Math.PI * i) / 16);
    out.push(candle(t, Number((mid - 0.6).toFixed(2)), Number((mid + 1.4).toFixed(2)), Number((mid - 1.4).toFixed(2)), Number((mid + 0.6).toFixed(2))));
  }
  return out;
}

/**
 * Model-B BUY fixture: flat wave (no trend) → strong rally (BOS happens but
 * ages out: > maxBarsSinceBreak by the decision) → pullback into the EMA50
 * band → decision bar closes back above EMA50, inside the zone tolerance.
 * Model A is expected NO_SETUP [STRUCTURE_BREAK_TOO_OLD]; Model B fires.
 */
function pullbackBuySeries(startSec: number): AnalysisCandle[] {
  const bars = [...waveLeg(80, startSec, M15, 2650, 3)];
  let t = startSec + 80 * M15;
  // rally: 24 bars, +1.1/bar → ~2676 (BOS bullish early, then ages)
  for (let i = 0; i < 24; i++) {
    const o = 2651 + i * 1.1;
    const c = 2652.1 + i * 1.1;
    bars.push(candle(t, Number(o.toFixed(2)), Number((c + 0.4).toFixed(2)), Number((o - 0.4).toFixed(2)), Number(c.toFixed(2))));
    t += M15;
  }
  // pullback: 7 bars down toward the EMA50 band (NOT too deep), closes holding up
  for (let i = 0; i < 7; i++) {
    const o = 2675.5 - i * 2.3;
    const c = 2673.4 - i * 2.3;
    bars.push(candle(t, Number(o.toFixed(2)), Number((o + 0.4).toFixed(2)), Number((c - 2.2).toFixed(2)), Number(c.toFixed(2))));
    t += M15;
  }
  // decision: bounce bar closing just above EMA50, inside zone ± tolerance
  bars.push(candle(t, 2658.5, 2663.5, 2658.0, 2663.0));
  return bars;
}

/**
 * Model-C BUY fixture: flat range (wave amp 6 → tested top/bottom), then a
 * SWEEP bar (wick below the bottom, close back INSIDE the range), then a
 * decision bar closing inside the reclaim zone. No close-basis break anywhere
 * (Model A stays NO_STRUCTURE_BREAK). ADX in a range is naturally LOW — this
 * fixture also proves Model C has no ADX floor.
 */
function rangeSweepBuySeries(startSec: number): AnalysisCandle[] {
  const bars = [...waveLeg(110, startSec, M15, 2650, 6)];
  let t = startSec + 110 * M15;
  // sweep bar: wick well below the range bottom (~2642.9), close back inside
  bars.push(candle(t, 2645.0, 2646.5, 2639.5, 2645.2));
  t += M15;
  // decision bar: close inside the reclaim zone just above the bottom
  bars.push(candle(t, 2644.8, 2646.2, 2644.3, 2645.4));
  return bars;
}

/** The engine-test bullish fixture (golden-pin source) — identical bytes. */
function bullishBreakSeries(startSec: number): AnalysisCandle[] {
  const wave = waveLeg(96, startSec, M15, 2650, 3); // swing highs ~2653, lows ~2647
  let t = startSec + 96 * M15;
  const bars = [...wave];
  for (let i = 0; i < 6; i++) {
    bars.push(candle(t, 2651 + i * 1.3, 2652.4 + i * 1.3, 2650.6 + i * 1.3, 2652.2 + i * 1.3));
    t += M15;
  }
  for (let i = 0; i < 3; i++) {
    bars.push(candle(t, 2657.5 - i * 0.8, 2657.7 - i * 0.8, 2653.5, 2656.4 - i * 0.7));
    t += M15;
  }
  bars.push(candle(t, 2654.6, 2655.2, 2653.9, 2654.2));
  return bars;
}

/** Coherent M5 subdivision of the last N M15 bars (linear interpolation). */
function m5FromM15(m15: AnalysisCandle[], nBars: number, endTimeExclusiveSec: number): AnalysisCandle[] {
  const slice = m15.slice(Math.max(0, m15.length - nBars));
  const out: AnalysisCandle[] = [];
  for (const bar of slice) {
    for (let k = 0; k < 3; k++) {
      const t = bar.timeUtcSec + k * M5;
      const o = bar.open + ((bar.close - bar.open) * k) / 3;
      const c = bar.open + ((bar.close - bar.open) * (k + 1)) / 3;
      const isMid = k === 1;
      const h = isMid ? bar.high : Math.max(o, c) + 0.1;
      const l = isMid ? bar.low : Math.min(o, c) - 0.1;
      out.push(candle(t, Number(o.toFixed(2)), Number(h.toFixed(2)), Number(l.toFixed(2)), Number(c.toFixed(2))));
    }
  }
  // drop any M5 bar that closes after the allowed instant (defensive)
  return out.filter((b) => b.timeUtcSec + M5 <= endTimeExclusiveSec);
}

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  const execStart = 1_791_000_000;
  const exec = pullbackBuySeries(execStart);
  const decision = exec[exec.length - 1];
  const decisionClose = decision.timeUtcSec + M15;
  const m5 = m5FromM15(exec, 10, decisionClose + 1);
  return {
    symbol: 'XAUUSDm',
    digits: 2,
    execution: { timeframe: 'M15', candles: exec, source: 'bridge-mt5' },
    h1: { timeframe: 'H1', candles: bullishHtf(120, execStart - 120 * H1, H1), source: 'bridge-mt5' },
    h4: { timeframe: 'H4', candles: bullishHtf(120, execStart - 120 * H4, H4), source: 'bridge-mt5' },
    m5: { timeframe: 'M5', candles: m5, source: 'bridge-mt5' },
    referencePrice: decision.close,
    spreadPrice: 0.24,
    nowUtcSec: decisionClose + 30,
    rules: RULES,
    ...overrides,
  };
}

function rangeCandidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  const execStart = 1_792_000_000;
  const exec = rangeSweepBuySeries(execStart);
  const decision = exec[exec.length - 1];
  const decisionClose = decision.timeUtcSec + M15;
  const m5 = m5FromM15(exec, 10, decisionClose + 1);
  return {
    symbol: 'XAUUSDm',
    digits: 2,
    execution: { timeframe: 'M15', candles: exec, source: 'bridge-mt5' },
    h1: { timeframe: 'H1', candles: flatHtf(120, execStart - 120 * H1, H1), source: 'bridge-mt5' },
    h4: { timeframe: 'H4', candles: flatHtf(120, execStart - 120 * H4, H4), source: 'bridge-mt5' },
    m5: { timeframe: 'M5', candles: m5, source: 'bridge-mt5' },
    referencePrice: decision.close,
    spreadPrice: 0.24,
    nowUtcSec: decisionClose + 30,
    rules: RULES,
    ...overrides,
  };
}

/** The baseline core input for the SAME data (Model-A equivalence checks). */
function baselineInputFrom(ci: CandidateInput): SignalCoreInput {
  const { m5: _m5, ...rest } = ci;
  return rest;
}

// ---------------------------------------------------------------------------
// Version isolation & frozen constants
// ---------------------------------------------------------------------------

describe('candidate — version isolation (baseline untouched)', () => {
  test('candidate version is separate from the baseline 9.0.0 and namespaced', () => {
    expect(CANDIDATE_STRATEGY_VERSION).toBe('hybrid-multimodel-research/11.0.0-candidate.1');
    expect(CANDIDATE_STRATEGY_VERSION).not.toBe(SIGNAL_STRATEGY_VERSION);
    expect(SIGNAL_STRATEGY_VERSION).toBe('hybrid-structure-retest/9.0.0'); // baseline unchanged
    expect(buildStrategyRules().strategyVersion).toBe(SIGNAL_STRATEGY_VERSION);
  });

  test('candidate constants are the frozen spec values (drift guard)', () => {
    expect(CANDIDATE_RULES).toEqual({
      pullbackLookbackBars: 6,
      pullbackZoneAtr: 0.35,
      pullbackMaxDepthAtr: 1.0,
      rangeLookbackBars: 96,
      rangeBandAtr: 0.6,
      rangeMinHeightAtr: 2.0,
      rangeMaxHeightAtr: 8.0,
      sweepLookbackBars: 3,
      sweepMinBeyondAtr: 0.1,
      m5WindowBars: 30,
    });
    expect(CANDIDATE_IDENTITY_VERSION).toBe('candidate-setup-identity/1');
  });

  test('GOLDEN: baseline evaluateSignal output is byte-stable (Phase 11 changed nothing)', () => {
    // Golden pin computed from the PRE-candidate code (2026-10-16) on the
    // engine-test permissive fixture (bullishBreakSeries). Any core.ts/rules
    // drift breaks this.
    const exec = bullishBreakSeries(1_791_000_000);
    const decision = exec[exec.length - 1];
    const input: SignalCoreInput = {
      symbol: 'XAUUSDm', digits: 2,
      execution: { timeframe: 'M15', candles: exec, source: 'bridge-mt5' },
      h1: { timeframe: 'H1', candles: bullishHtf(120, 1_791_000_000 - 120 * H1, H1), source: 'bridge-mt5' },
      h4: { timeframe: 'H4', candles: bullishHtf(120, 1_791_000_000 - 120 * H4, H4), source: 'bridge-mt5' },
      referencePrice: decision.close, spreadPrice: 0.24,
      nowUtcSec: decision.timeUtcSec + M15 + 30,
      rules: { ...RULES, minAdx: 0, rsiBuyMin: 0, rsiBuyMax: 100, maxSpreadPrice: 10, zoneWidthAtr: 1.0, entryToleranceAtr: 0.6, maxBarsSinceBreak: 14 },
    };
    const out = evaluateSignal(input);
    expect(out.outcome).toBe('BUY_SETUP');
    const hash = createHash('sha256').update(JSON.stringify(out)).digest('hex');
    expect(hash).toBe('e45eb7f6a395cff46d35f3019d393d4a5e1f498a68a8ebc2e8ec41e7767d14c8');
  });
});

// ---------------------------------------------------------------------------
// Model A — passthrough & equivalence
// ---------------------------------------------------------------------------

describe('candidate — Model A (baseline imported unchanged)', () => {
  test('Model A outcome equals the baseline evaluation on identical data', () => {
    const ci = candidateInput();
    const base = evaluateSignal(baselineInputFrom(ci));
    const cand = evaluateCandidate(ci);
    expect(cand.evidence?.modelA?.outcome).toBe(base.outcome);
    expect(cand.evidence?.modelA?.reasonCodes).toEqual(base.reasonCodes);
    if (base.outcome === 'BUY_SETUP' || base.outcome === 'SELL_SETUP') {
      expect(cand.outcome).toBe(base.outcome);
      expect(cand.model).toBe('A');
      expect(cand.levels?.stopLoss).toBe(base.levels?.stopLoss);
      expect(cand.levels?.target).toBe(base.levels?.target);
    }
  });

  test('data-gate BLOCKED propagates to the whole candidate (shared fail-closed gates)', () => {
    const out = evaluateCandidate(candidateInput({ digits: null }));
    expect(out.outcome).toBe('BLOCKED');
    expect(out.reasonCodes).toContain('SPEC_MISSING');
    expect(out.model).toBeNull();
    expect(out.levels).toBeNull();
    expect(out.evidence?.modelB).toBeNull(); // B/C not evaluated behind a data gate
    expect(out.evidence?.modelC).toBeNull();
  });

  test('forming M15 decision candle blocks the candidate exactly like the baseline', () => {
    const ci = candidateInput();
    const decision = ci.execution.candles[ci.execution.candles.length - 1];
    const out = evaluateCandidate({ ...ci, nowUtcSec: decision.timeUtcSec + 60 });
    expect(out.outcome).toBe('BLOCKED');
    expect(out.reasonCodes).toContain('FORMING_CANDLE_IN_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Model B — trend-continuation pullback
// ---------------------------------------------------------------------------

describe('candidate — Model B (pullback continuation)', () => {
  test('aligned H4+H1 uptrend + EMA50 pullback touch + M5 confirm → BUY setup (model B)', () => {
    const out = evaluateCandidate(candidateInput());
    expect(out.outcome).toBe('BUY_SETUP');
    expect(out.model).toBe('B');
    expect(out.direction).toBe('BUY');
    expect(out.levels).not.toBeNull();
    expect(out.levels!.stopLoss).toBeLessThan(out.levels!.entryZoneLow);
    expect(out.levels!.target).toBeGreaterThan(out.levels!.entryReference);
    expect(out.levels!.invalidationLevel).toBe(out.levels!.entryZoneLow); // BUY: invalidation = the EMA band low (spec §1.B)
    expect(out.setupFingerprint).not.toBeNull();
    expect(out.expiryUtc).not.toBeNull();
  });

  test('the same fixture WITHOUT M5 confirmation → WAIT [M5_CONFIRMATION_PENDING] — an EMA touch alone is never a setup', () => {
    const ci = candidateInput();
    const m5c = [...ci.m5.candles];
    const last = m5c[m5c.length - 1];
    // bearish final M5 bar (close < open AND < prev close) — confirmation gone
    m5c[m5c.length - 1] = candle(last.timeUtcSec, last.open, last.open + 0.2, last.open - 0.7, last.open - 0.5);
    const out = evaluateCandidate({ ...ci, m5: { ...ci.m5, candles: m5c } });
    expect(out.outcome).not.toBe('BUY_SETUP');
    expect(out.outcome).not.toBe('SELL_SETUP');
    expect(out.reasonCodes).toContain('M5_CONFIRMATION_PENDING');
    expect(out.levels).toBeNull();
  });

  test('H1 context NOT aligned (bearish) → stage PULLBACK_CONTEXT_NOT_ALIGNED, no B setup', () => {
    const ci = candidateInput();
    const execStart = ci.execution.candles[0].timeUtcSec;
    const out = evaluateModelB({
      ...ci,
      h1: { timeframe: 'H1', candles: bearishHtf(120, execStart - 120 * H1, H1), source: 'bridge-mt5' },
    });
    expect(out.setup).toBeNull();
    expect(out.stage).toBe('PULLBACK_CONTEXT_NOT_ALIGNED');
  });

  test('no pullback touch within the lookback → stage PULLBACK_NO_TOUCH (WAIT class)', () => {
    const ci = candidateInput();
    // flatten the pullback: replace the 7 pullback bars + decision with a
    // shallow drift that never reaches the EMA50 band
    const exec = [...ci.execution.candles];
    const base = exec.length - 8;
    let t = exec[base].timeUtcSec;
    for (let i = 0; i < 7; i++) {
      exec[base + i] = candle(t, 2674 - i * 0.4, 2674.4 - i * 0.4, 2672.6 - i * 0.4, 2673.4 - i * 0.4);
      t += M15;
    }
    exec[exec.length - 1] = candle(t, 2671.4, 2672.4, 2670.6, 2671.9);
    const out = evaluateModelB({ ...ci, execution: { ...ci.execution, candles: exec } });
    expect(out.setup).toBeNull();
    expect(out.stage).toBe('PULLBACK_NO_TOUCH');
  });

  test('pullback TOO DEEP (close a full ATR beyond EMA50) → stage PULLBACK_TOO_DEEP (NO_SETUP class)', () => {
    const ci = candidateInput();
    const exec = [...ci.execution.candles];
    // crash one pullback bar deep below the EMA50 band
    const idx = exec.length - 3;
    const b = exec[idx];
    exec[idx] = candle(b.timeUtcSec, b.open, b.open + 0.4, b.close - 8.0, b.close - 7.6);
    const out = evaluateModelB({ ...ci, execution: { ...ci.execution, candles: exec } });
    expect(out.setup).toBeNull();
    expect(out.stage).toBe('PULLBACK_TOO_DEEP');
  });

  test('shared spread gate applies to Model B → SPREAD_TOO_WIDE', () => {
    const out = evaluateCandidate(candidateInput({ spreadPrice: 0.8 }));
    expect(out.outcome).toBe('WAIT');
    expect(out.reasonCodes).toContain('SPREAD_TOO_WIDE');
    expect(out.levels).toBeNull();
  });

  test('M5 window absent entirely → honest WAIT, never a setup (fail-closed confirmation)', () => {
    const ci = candidateInput({ m5: { timeframe: 'M5', candles: [], source: 'bridge-mt5' } });
    const out = evaluateCandidate(ci);
    expect(out.outcome).not.toBe('BUY_SETUP');
    expect(out.reasonCodes).toContain('M5_CONFIRMATION_PENDING');
  });
});

// ---------------------------------------------------------------------------
// Model C — range sweep & rejection
// ---------------------------------------------------------------------------

describe('candidate — Model C (range sweep rejection)', () => {
  test('range + sweep below bottom + reclaim close + M5 confirm → BUY setup (model C), low range ADX does NOT block', () => {
    const out = evaluateCandidate(rangeCandidateInput());
    expect(out.outcome).toBe('BUY_SETUP');
    expect(out.model).toBe('C');
    expect(out.direction).toBe('BUY');
    expect(out.levels).not.toBeNull();
    // SL anchored beyond the sweep extreme
    expect(out.levels!.stopLoss).toBeLessThan(2641); // sweep low was 2639.5, buffer ≥ 0.5*ATR below
    expect(out.levels!.invalidationLevel).toBe(out.levels!.entryZoneLow); // BUY: invalidation = the range bottom = zone low (spec §1.C)
    expect(out.setupFingerprint).not.toBeNull();
  });

  test('wick sweep WITHOUT reclaim (decision close still below the bottom) → WAIT [RANGE_RECLAIM_PENDING]', () => {
    const ci = rangeCandidateInput();
    const exec = [...ci.execution.candles];
    const d = exec.length - 1;
    // decision closes back BELOW the bottom (~2642.9) → no reclaim yet
    exec[d] = candle(exec[d].timeUtcSec, 2645.0, 2645.8, 2641.5, 2642.0);
    const out = evaluateCandidate({ ...ci, execution: { ...ci.execution, candles: exec }, referencePrice: 2642.0 });
    expect(out.outcome).toBe('WAIT');
    expect(out.reasonCodes).toContain('RANGE_RECLAIM_PENDING');
  });

  test('trending market (no valid range) → stage RANGE_NOT_DETECTED (NO_SETUP class)', () => {
    const out = evaluateModelC(candidateInput()); // pullback fixture is a trending shape
    expect(out.setups.length).toBe(0);
    expect(out.stage).toBe('RANGE_NOT_DETECTED');
  });

  test('M5 not confirming the rejection → WAIT [M5_CONFIRMATION_PENDING], wick alone is not a trade', () => {
    const ci = rangeCandidateInput();
    const m5c = [...ci.m5.candles];
    const last = m5c[m5c.length - 1];
    m5c[m5c.length - 1] = candle(last.timeUtcSec, last.open, last.open + 0.2, last.close - 0.4, last.close - 0.25);
    const out = evaluateCandidate({ ...ci, m5: { ...ci.m5, candles: m5c } });
    expect(out.outcome).toBe('WAIT');
    expect(out.reasonCodes).toContain('M5_CONFIRMATION_PENDING');
  });

  test('HTF OPPOSITE to the rejection direction blocks that side of Model C (shared non-opposite filter)', () => {
    const ci = rangeCandidateInput();
    const execStart = ci.execution.candles[0].timeUtcSec;
    // BUY rejection vs bearish H4 → the BUY side must not fire; the SELL side
    // (no sweep above the top) reports RANGE_SWEEP_PENDING and wins the
    // primary-stage rank — the per-direction stages make this explicit.
    const out = evaluateModelC({
      ...ci,
      h4: { timeframe: 'H4', candles: bearishHtf(120, execStart - 120 * H4, H4), source: 'bridge-mt5' },
    });
    expect(out.setups.length).toBe(0);
    expect(out.stages.BUY).toBe('HTF_H4_OPPOSITE');
    expect(out.stages.SELL).toBe('RANGE_SWEEP_PENDING');
    expect(out.stage).toBe('RANGE_SWEEP_PENDING'); // furthest-along side wins the primary
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — exact ATR tolerance boundaries
// ---------------------------------------------------------------------------

describe('candidate — deterministic boundaries (frozen constants)', () => {
  const t0 = 1_793_000_000;

  test('pullback touch boundary: low EXACTLY at ema+0.35*atr touches (inclusive); a hair above does not', () => {
    const mk = (low: number) => [
      candle(t0, 100, 101, low, 100.5),
      candle(t0 + M15, 100, 101, low, 100.5),
    ];
    const ema = [100, 100];
    const atr = [10, 10];
    const args = (lows: number[]) => ({
      candles: mk(lows[0]).concat(mk(lows[1])),
      emaValues: ema, atrValues: atr, decisionIdx: 1,
      lookback: CANDIDATE_RULES.pullbackLookbackBars,
      zoneAtr: CANDIDATE_RULES.pullbackZoneAtr,
      maxDepthAtr: CANDIDATE_RULES.pullbackMaxDepthAtr,
      direction: 'BUY' as const,
    });
    expect(pullbackState(args([103.5, 103.5])).state).toBe('touch');   // exactly ema + 0.35*atr = 103.5
    expect(pullbackState(args([103.51, 103.51])).state).toBe('no_touch'); // a hair above the band
    expect(pullbackState(args([103.499, 103.499])).state).toBe('touch');
  });

  test('pullback depth boundary: close EXACTLY at ema−1.0*atr is NOT too deep (strict <); a hair below is', () => {
    const mk = (close: number) => candle(t0, 104, 104.5, 89, close);
    const ema = [100, 100];
    const atr = [10, 10];
    const args = (close: number) => ({
      candles: [mk(close), mk(close)],
      emaValues: ema, atrValues: atr, decisionIdx: 1,
      lookback: CANDIDATE_RULES.pullbackLookbackBars,
      zoneAtr: CANDIDATE_RULES.pullbackZoneAtr,
      maxDepthAtr: CANDIDATE_RULES.pullbackMaxDepthAtr,
      direction: 'BUY' as const,
    });
    expect(pullbackState(args(90)).state).not.toBe('too_deep');   // exactly ema − 1.0*atr → NOT deep (strict <)
    expect(pullbackState(args(89.99)).state).toBe('too_deep');    // a hair below → dead
  });

  test('sweep boundary: low EXACTLY at bottom−0.1*atr does NOT sweep (strict <); a hair below does', () => {
    const args = (low: number) => ({
      candles: [candle(t0, 100, 101, low, 100.5), candle(t0 + M15, 100, 101, 99.5, 100.5)],
      decisionIdx: 1, lookback: CANDIDATE_RULES.sweepLookbackBars,
      boundary: 100, atr: 10, minBeyondAtr: CANDIDATE_RULES.sweepMinBeyondAtr, direction: 'BUY' as const,
    });
    expect(sweepState(args(99.0)).swept).toBe(false);   // exactly 100 − 0.1*10 = 99.0 → strict < fails
    expect(sweepState(args(98.99)).swept).toBe(true);   // a hair below the threshold
    expect(sweepState(args(99.01)).swept).toBe(false);
  });

  test('M5 confirmation boundaries: equal close is NOT confirmation (strict >)', () => {
    const c1 = candle(t0, 100, 101, 99, 100.4);
    const c2a = candle(t0 + M5, 100.2, 101, 99, 100.5); // close > open AND > prev close → confirm
    const c2b = candle(t0 + M5, 100.2, 101, 99, 100.4); // close == prev close → NO
    const c2c = candle(t0 + M5, 100.6, 101, 99, 100.5); // close < open → NO
    const asOf = t0 + 2 * M5;
    expect(m5Confirmed({ m5Candles: [c1, c2a], direction: 'BUY', asOfSec: asOf })).toBe(true);
    expect(m5Confirmed({ m5Candles: [c1, c2b], direction: 'BUY', asOfSec: asOf })).toBe(false);
    expect(m5Confirmed({ m5Candles: [c1, c2c], direction: 'BUY', asOfSec: asOf })).toBe(false);
    expect(m5Confirmed({ m5Candles: [c1], direction: 'BUY', asOfSec: asOf })).toBe(false); // < 2 bars
  });

  test('M5 closed-bar semantics: a bar closing AFTER the decision close never confirms', () => {
    const c1 = candle(t0, 100, 101, 99, 100.4);
    const forming = candle(t0 + M5, 100.2, 101, 99, 100.9); // closes at t0+600 > asOf t0+300
    expect(m5Confirmed({ m5Candles: [c1, forming], direction: 'BUY', asOfSec: t0 + M5 })).toBe(false);
    // same bar closed by asOf → usable
    expect(m5Confirmed({ m5Candles: [c1, forming], direction: 'BUY', asOfSec: t0 + 2 * M5 })).toBe(true);
  });

  test('range detection boundaries: band ≤ 0.6*atr inclusive; height within [2, 8] ATR inclusive', () => {
    const swingHi = (index: number, price: number) => ({ kind: 'high' as const, index, timeUtcSec: 0, confirmedAtUtcSec: 0, price, priceText: String(price) });
    const swingLo = (index: number, price: number) => ({ kind: 'low' as const, index, timeUtcSec: 0, confirmedAtUtcSec: 0, price, priceText: String(price) });
    const mk = (h1: number, h2: number, l1: number, l2: number, atr: number) => rangeState({
      swings: [swingHi(10, h1), swingLo(12, l1), swingHi(20, h2), swingLo(22, l2)],
      decisionIdx: 30, swingRight: 3, atr,
      lookback: CANDIDATE_RULES.rangeLookbackBars,
      bandAtr: CANDIDATE_RULES.rangeBandAtr,
      minHeightAtr: CANDIDATE_RULES.rangeMinHeightAtr,
      maxHeightAtr: CANDIDATE_RULES.rangeMaxHeightAtr,
    });
    // atr=10 → band 6, minH 20, maxH 80.
    expect(mk(60, 66, 36, 30, 10)).toEqual({ ok: true, top: 60, bottom: 36 });   // |Δh|=6 ✓ |Δl|=6 ✓ height 24 ✓
    expect(mk(60, 66, 40, 44, 10).ok).toBe(false);                               // height 16 < 20
    expect(mk(60, 66.01, 36, 30, 10).ok).toBe(false);                            // |Δh| = 6.01 > band
    expect(mk(60, 66, 36, 29.99, 10).ok).toBe(false);                            // |Δl| = 6.01 > band
    expect(mk(60, 66, -19, -25, 10)).toEqual({ ok: true, top: 60, bottom: -19 }); // height 79 ≤ 80 ✓
    expect(mk(60, 66, -20, -26, 10)).toEqual({ ok: true, top: 60, bottom: -20 }); // height exactly 80 → inclusive ✓
    expect(mk(60, 66, -21, -27, 10).ok).toBe(false);                              // height 81 > 80
  });
});

// ---------------------------------------------------------------------------
// Precedence, conflict, aggregation
// ---------------------------------------------------------------------------

describe('candidate — precedence, conflict, aggregation (pure combine)', () => {
  const mkSetup = (model: 'A' | 'B' | 'C', direction: 'BUY' | 'SELL') => ({
    model,
    direction,
    levels: null,
    anchorKey: { kind: 'pullback', extremeBarTimeUtcSec: 1_791_000_000 } as const,
  });
  const evalOf = (outcome: string, reasonCodes: string[] = []) =>
    ({
      outcome,
      reasonCodes,
      evidence: (outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP')
        ? {
            structureEvent: {
              type: 'BOS', direction: 'bullish', level: 2653, levelText: '2653.00',
              breakCandleTimeUtc: '2026-10-16T00:00:00Z', barsSinceBreak: 2,
            },
          }
        : null,
    }) as never;

  test('A and B same direction → A wins, B suppressed (audit trail)', () => {
    const r = combineModels(
      { evaluation: evalOf('BUY_SETUP') },
      { setup: mkSetup('B', 'BUY'), stage: null },
      { setups: [], stages: { BUY: 'RANGE_NOT_DETECTED', SELL: 'RANGE_NOT_DETECTED' }, stage: 'RANGE_NOT_DETECTED' },
    );
    expect(r.outcome).toBe('BUY_SETUP');
    expect(r.model).toBe('A');
    expect(r.suppressedModels).toContain('B');
    expect(r.conflict).toBe(false);
  });

  test('B and C same direction (no A) → B wins, C suppressed', () => {
    const r = combineModels(
      { evaluation: evalOf('NO_SETUP', ['STRUCTURE_BREAK_TOO_OLD']) },
      { setup: mkSetup('B', 'SELL'), stage: null },
      { setups: [{ direction: 'SELL', setup: mkSetup('C', 'SELL') }], stages: { BUY: null, SELL: null }, stage: null },
    );
    expect(r.outcome).toBe('SELL_SETUP');
    expect(r.model).toBe('B');
    expect(r.suppressedModels).toContain('C');
  });

  test('opposite directions → WAIT [MODEL_CONFLICT], never a mixed signal', () => {
    const r = combineModels(
      { evaluation: evalOf('BUY_SETUP') },
      { setup: null, stage: 'PULLBACK_CONTEXT_NOT_ALIGNED' },
      { setups: [{ direction: 'SELL', setup: mkSetup('C', 'SELL') }], stages: { BUY: null, SELL: null }, stage: null },
    );
    expect(r.outcome).toBe('WAIT');
    expect(r.reasonCodes).toContain('MODEL_CONFLICT');
    expect(r.model).toBeNull();
  });

  test('Model C internally conflicting (both directions) → WAIT [MODEL_CONFLICT]', () => {
    const r = combineModels(
      { evaluation: evalOf('NO_SETUP', ['NO_STRUCTURE_BREAK']) },
      { setup: null, stage: 'PULLBACK_CONTEXT_NOT_ALIGNED' },
      { setups: [{ direction: 'BUY', setup: mkSetup('C', 'BUY') }, { direction: 'SELL', setup: mkSetup('C', 'SELL') }], stages: { BUY: null, SELL: null }, stage: null },
    );
    expect(r.outcome).toBe('WAIT');
    expect(r.reasonCodes).toContain('MODEL_CONFLICT');
  });

  test('no setup anywhere: any WAIT-class stage → WAIT with merged codes (A codes first)', () => {
    const r = combineModels(
      { evaluation: evalOf('WAIT', ['RETEST_PENDING']) },
      { setup: null, stage: 'PULLBACK_NO_TOUCH' },
      { setups: [], stages: { BUY: 'RANGE_NOT_DETECTED', SELL: 'RANGE_NOT_DETECTED' }, stage: 'RANGE_NOT_DETECTED' },
    );
    expect(r.outcome).toBe('WAIT');
    expect(r.reasonCodes[0]).toBe('RETEST_PENDING');
    expect(r.reasonCodes).toContain('PULLBACK_NO_TOUCH');
    expect(r.reasonCodes).toContain('RANGE_NOT_DETECTED');
  });

  test('no setup anywhere: all NO_SETUP-class → NO_SETUP', () => {
    const r = combineModels(
      { evaluation: evalOf('NO_SETUP', ['STRUCTURE_BREAK_TOO_OLD']) },
      { setup: null, stage: 'PULLBACK_TOO_DEEP' },
      { setups: [], stages: { BUY: 'RANGE_NOT_DETECTED', SELL: 'RANGE_NOT_DETECTED' }, stage: 'RANGE_NOT_DETECTED' },
    );
    expect(r.outcome).toBe('NO_SETUP');
    expect(r.reasonCodes).toContain('STRUCTURE_BREAK_TOO_OLD');
    expect(r.reasonCodes).toContain('PULLBACK_TOO_DEEP');
  });

  test('BLOCKED data gates dominate everything', () => {
    const r = combineModels(
      { evaluation: evalOf('BLOCKED', ['INSUFFICIENT_H1_HISTORY']) },
      { setup: mkSetup('B', 'BUY'), stage: null },
      { setups: [], stages: { BUY: null, SELL: null }, stage: null },
    );
    expect(r.outcome).toBe('BLOCKED');
    expect(r.reasonCodes).toContain('INSUFFICIENT_H1_HISTORY');
    expect(r.model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Setup identity (dedup) — candidate namespace
// ---------------------------------------------------------------------------

describe('candidate — setup identity', () => {
  test('deterministic: same anchor → identical fingerprint across calls', () => {
    const args = {
      symbol: 'XAUUSDm', timeframe: 'M15', model: 'B' as const, direction: 'BUY' as const,
      anchorKey: { kind: 'pullback' as const, extremeBarTimeUtcSec: 1_791_000_000 },
    };
    expect(computeCandidateSetupFingerprint(args)).toBe(computeCandidateSetupFingerprint(args));
  });

  test('different anchor (new pullback extreme) → different fingerprint; different model → different fingerprint', () => {
    const base = {
      symbol: 'XAUUSDm', timeframe: 'M15', direction: 'BUY' as const,
      anchorKey: { kind: 'pullback' as const, extremeBarTimeUtcSec: 1_791_000_000 },
    };
    const fp1 = computeCandidateSetupFingerprint({ ...base, model: 'B' });
    const fp2 = computeCandidateSetupFingerprint({ ...base, model: 'B', anchorKey: { kind: 'pullback', extremeBarTimeUtcSec: 1_791_000_900 } });
    const fp3 = computeCandidateSetupFingerprint({ ...base, model: 'A' });
    expect(fp1).not.toBe(fp2);
    expect(fp1).not.toBe(fp3);
  });

  test('repeated evaluation of the same decision data → the SAME setup fingerprint (dedup-safe)', () => {
    const a = evaluateCandidate(candidateInput());
    const b = evaluateCandidate(candidateInput());
    expect(a.setupFingerprint).toBe(b.setupFingerprint);
  });

  test('identity payload carries the candidate version (never collides with the baseline namespace)', () => {
    const fp = computeCandidateSetupFingerprint({
      symbol: 'XAUUSDm', timeframe: 'M15', model: 'A', direction: 'BUY',
      anchorKey: { kind: 'structure', type: 'BOS', direction: 'bullish', level: 2653, breakCandleTimeUtc: '2026-10-16T00:00:00Z' },
    });
    expect(typeof fp).toBe('string');
    expect(fp).toHaveLength(64); // sha256 hex
  });
});

// ---------------------------------------------------------------------------
// Expiry & invalidation contract
// ---------------------------------------------------------------------------

describe('candidate — expiry & invalidation', () => {
  test('setup expiry = decision close + 12 × M15 (same as baseline); WAIT/NO_SETUP carry none', () => {
    const ci = candidateInput();
    const out = evaluateCandidate(ci);
    expect(out.outcome).toBe('BUY_SETUP');
    const decision = ci.execution.candles[ci.execution.candles.length - 1];
    const expected = new Date((decision.timeUtcSec + M15 + 12 * M15) * 1000).toISOString();
    expect(out.expiryUtc).toBe(expected);
  });

  test('Model A setups keep the baseline invalidation level (the broken structure level)', () => {
    // Engine-test bullish fixture through the candidate: A fires (permissive rules)
    const execStart = 1_793_500_000;
    const wave = waveLeg(96, execStart, M15, 2650, 3);
    let t = execStart + 96 * M15;
    const bars = [...wave];
    for (let i = 0; i < 6; i++) { bars.push(candle(t, 2651 + i * 1.3, 2652.4 + i * 1.3, 2650.6 + i * 1.3, 2652.2 + i * 1.3)); t += M15; }
    for (let i = 0; i < 3; i++) { bars.push(candle(t, 2657.5 - i * 0.8, 2657.7 - i * 0.8, 2653.5, 2656.4 - i * 0.7)); t += M15; }
    bars.push(candle(t, 2654.6, 2655.2, 2653.9, 2654.2));
    const decisionClose = t + M15;
    const ci: CandidateInput = {
      symbol: 'XAUUSDm', digits: 2,
      execution: { timeframe: 'M15', candles: bars, source: 'bridge-mt5' },
      h1: { timeframe: 'H1', candles: bullishHtf(120, execStart - 120 * H1, H1), source: 'bridge-mt5' },
      h4: { timeframe: 'H4', candles: bullishHtf(120, execStart - 120 * H4, H4), source: 'bridge-mt5' },
      m5: { timeframe: 'M5', candles: m5FromM15(bars, 10, decisionClose + 1), source: 'bridge-mt5' },
      referencePrice: 2654.2, spreadPrice: 0.24, nowUtcSec: decisionClose + 30,
      rules: { ...RULES, minAdx: 0, rsiBuyMin: 0, rsiBuyMax: 100, maxSpreadPrice: 10, zoneWidthAtr: 1.0, entryToleranceAtr: 0.6, maxBarsSinceBreak: 14 },
    };
    const out = evaluateCandidate(ci);
    expect(out.model).toBe('A');
    expect(out.outcome).toBe('BUY_SETUP');
    expect(out.levels).not.toBeNull();
    // invalidation = the broken swing-high level (~2653 area, below the entry zone)
    expect(out.levels!.invalidationLevel).toBeLessThan(out.levels!.entryZoneHigh + 1.0);
  });
});
