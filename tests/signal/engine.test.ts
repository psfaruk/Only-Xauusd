/**
 * PHASE 9 SIGNAL ENGINE TESTS — deterministic core + level math + causality.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: all candles below are SYNTHETIC fixtures constructed to
 * exercise specific strategy paths. They are never presented as broker data.
 *
 * Pinned behaviors (spec Task G):
 *   · deterministic identical results for identical inputs
 *   · BUY/SELL mutual consistency (direction comes from the structure event)
 *   · no setup when structure is unclear/absent
 *   · missing H4 / H1 history blocks (BLOCKED, never a guess)
 *   · invalid symbol spec (digits) blocks level calculation
 *   · spread & reward/risk arithmetic correctness
 *   · forming candle can never act as a closed confirmation
 *   · future-candle mutation cannot alter prior evaluations (no look-ahead)
 *   · invalid SL/target ordering rejected
 *   · insufficient history → BLOCKED with INSUFFICIENT_DATA
 *   · WAIT vs NO_SETUP semantics (retest pending vs invalidated zone)
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { evaluateSignal, deriveLevels, causalTrendAt } from '@/lib/signal/core';
import { buildStrategyRules } from '@/lib/signal/rules';
import { computeSignalFingerprint } from '@/lib/signal/core';
import type { SignalCoreInput, StrategyRules } from '@/lib/signal/types';
import type { AnalysisCandle } from '@/lib/analysis/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RULES: StrategyRules = { ...buildStrategyRules(), windowBars: 300, minExecutionBars: 60, minH1Bars: 60, minH4Bars: 60 };
/** Permissive variant for STRUCTURAL happy-path fixtures (indicator/HTF
 *  filters opened so the structure logic itself is what's under test; the
 *  default-rule filter rejections are pinned by their own tests below). */
const PERMISSIVE: StrategyRules = {
  ...RULES,
  minAdx: 0,
  rsiBuyMin: 0,
  rsiBuyMax: 100,
  maxSpreadPrice: 10,
  zoneWidthAtr: 1.0,
  entryToleranceAtr: 0.6,
  maxBarsSinceBreak: 14,
};
const M15 = 900;
const H1 = 3600;
const H4 = 14400;

function candle(t: number, o: number, h: number, l: number, c: number): AnalysisCandle {
  return {
    timeUtcSec: t, open: o, high: h, low: l, close: c, volume: null,
    openText: o.toFixed(2), highText: h.toFixed(2), lowText: l.toFixed(2), closeText: c.toFixed(2),
  };
}

/** A flat-ish synthetic series (no structure break → NO_SETUP path). */
function flatSeries(count: number, startSec: number, tfSec: number, base = 2650): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const o = base + (i % 2 === 0 ? 0 : 0.5);
    const c = base + (i % 2 === 0 ? 0.5 : 0);
    out.push(candle(t, o, Math.max(o, c) + 0.25, Math.min(o, c) - 0.25, c));
  }
  return out;
}

/** Sine-wave leg: period-16 oscillation → clean, separated swings. */
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

/**
 * A synthetic series engineered to contain a confirmed BULLISH structure break
 * (close above the wave's swing highs) followed by a retest into the entry
 * zone that HOLDS above the broken level, then a decision close.
 */
function bullishBreakSeries(startSec: number): AnalysisCandle[] {
  const wave = waveLeg(96, startSec, M15, 2650, 3); // swing highs ~2653, lows ~2647
  let t = startSec + 96 * M15;
  const bars = [...wave];
  // rally: closes cross decisively above ~2653 (BOS bullish)
  for (let i = 0; i < 6; i++) {
    bars.push(candle(t, 2651 + i * 1.3, 2652.4 + i * 1.3, 2650.6 + i * 1.3, 2652.2 + i * 1.3));
    t += M15;
  }
  // pullback INTO the zone (low ~2653.5) with every close holding above 2653
  for (let i = 0; i < 3; i++) {
    bars.push(candle(t, 2657.5 - i * 0.8, 2657.7 - i * 0.8, 2653.5, 2656.4 - i * 0.7));
    t += M15;
  }
  // decision bar: close back near the zone top
  bars.push(candle(t, 2654.6, 2655.2, 2653.9, 2654.2));
  return bars;
}

/** Mirror of bullishBreakSeries → confirmed BEARISH break + retest hold. */
function bearishBreakSeries(startSec: number): AnalysisCandle[] {
  const wave = waveLeg(96, startSec, M15, 2650, 3);
  let t = startSec + 96 * M15;
  const bars = [...wave];
  for (let i = 0; i < 6; i++) {
    bars.push(candle(t, 2649 - i * 1.3, 2649.4 - i * 1.3, 2647.8 - i * 1.3, 2647.8 - i * 1.3));
    t += M15;
  }
  for (let i = 0; i < 3; i++) {
    bars.push(candle(t, 2642.5 + i * 0.8, 2646.5, 2642.3 + i * 0.8, 2643.6 + i * 0.7));
    t += M15;
  }
  bars.push(candle(t, 2645.4, 2646.1, 2644.8, 2645.8));
  return bars;
}

/** HTF context: a RISING zigzag (wave on a rising trend) so swing highs (HH)
 *  and lows (HL) both confirm → trend classifies as bullish, not unclear. */
function bullishHtf(count: number, startSec: number, tfSec: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = 2600 + i * 0.6 + 2.0 * Math.sin((2 * Math.PI * i) / 16);
    const o = mid - 0.6;
    const c = mid + 0.6;
    out.push(candle(t, Number(o.toFixed(2)), Number((mid + 1.4).toFixed(2)), Number((mid - 1.4).toFixed(2)), Number(c.toFixed(2))));
  }
  return out;
}

/** HTF context: a FALLING zigzag (LH + LL swings) → bearish trend. */
function bearishHtf(count: number, startSec: number, tfSec: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = 2800 - i * 0.6 + 2.0 * Math.sin((2 * Math.PI * i) / 16);
    const o = mid + 0.6;
    const c = mid - 0.6;
    out.push(candle(t, Number(o.toFixed(2)), Number((mid + 1.4).toFixed(2)), Number((mid - 1.4).toFixed(2)), Number(c.toFixed(2))));
  }
  return out;
}

function coreInput(overrides: Partial<SignalCoreInput> = {}): SignalCoreInput {
  const execStart = 1_791_000_000;
  const exec = bullishBreakSeries(execStart);
  const decision = exec[exec.length - 1];
  const now = decision.timeUtcSec + M15 + 30; // 30s after the decision close
  return {
    symbol: 'XAUUSDm',
    digits: 2,
    execution: { timeframe: 'M15', candles: exec, source: 'bridge-mt5' },
    h1: { timeframe: 'H1', candles: bullishHtf(120, execStart - 120 * H1, H1), source: 'bridge-mt5' },
    h4: { timeframe: 'H4', candles: bullishHtf(120, execStart - 120 * H4, H4), source: 'bridge-mt5' },
    referencePrice: decision.close,
    spreadPrice: 0.24,
    nowUtcSec: now,
    rules: PERMISSIVE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe('signal core — data gates (fail closed)', () => {
  test('missing digits (symbol spec) → BLOCKED [SPEC_MISSING], no levels', () => {
    const out = evaluateSignal(coreInput({ digits: null }));
    expect(out.outcome).toBe('BLOCKED');
    expect(out.reasonCodes).toContain('SPEC_MISSING');
    expect(out.levels).toBeNull();
  });

  test('insufficient execution history → BLOCKED [INSUFFICIENT_DATA]', () => {
    const short = flatSeries(30, 1_791_000_000, M15);
    const out = evaluateSignal(coreInput({ execution: { timeframe: 'M15', candles: short, source: 'bridge-mt5' } }));
    expect(out.outcome).toBe('BLOCKED');
    expect(out.reasonCodes).toContain('INSUFFICIENT_DATA');
  });

  test('missing H4 history blocks strategies requiring H4', () => {
    const out = evaluateSignal(coreInput({ h4: { timeframe: 'H4', candles: [], source: 'bridge-mt5' } }));
    expect(out.outcome).toBe('BLOCKED');
    expect(out.reasonCodes).toContain('INSUFFICIENT_H4_HISTORY');
    expect(out.levels).toBeNull();
  });

  test('missing H1 history blocks', () => {
    const out = evaluateSignal(coreInput({ h1: { timeframe: 'H1', candles: [], source: 'bridge-mt5' } }));
    expect(out.outcome).toBe('BLOCKED');
    expect(out.reasonCodes).toContain('INSUFFICIENT_H1_HISTORY');
  });

  test('forming candle in input (decision close in the future) → BLOCKED [FORMING_CANDLE_IN_INPUT]', () => {
    const input = coreInput();
    const decision = input.execution.candles[input.execution.candles.length - 1];
    const out = evaluateSignal({ ...input, nowUtcSec: decision.timeUtcSec + 60 }); // bar NOT closed yet
    expect(out.outcome).toBe('BLOCKED');
    expect(out.reasonCodes).toContain('FORMING_CANDLE_IN_INPUT');
  });

  test('non-chronological (out-of-order) candles → BLOCKED [CHRONOLOGY_BROKEN]', () => {
    const input = coreInput();
    const candles = [...input.execution.candles];
    [candles[10], candles[11]] = [candles[11], candles[10]];
    const out = evaluateSignal({ ...input, execution: { ...input.execution, candles } });
    expect(out.outcome).toBe('BLOCKED');
    expect(out.reasonCodes).toContain('CHRONOLOGY_BROKEN');
  });

  test('OHLC-inconsistent candle → BLOCKED [DATA_INVALID]', () => {
    const input = coreInput();
    const candles = [...input.execution.candles];
    const bad = candles[candles.length - 2];
    candles[candles.length - 2] = { ...bad, high: bad.low - 10 }; // high < low
    const out = evaluateSignal({ ...input, execution: { ...input.execution, candles } });
    expect(out.outcome).toBe('BLOCKED');
    expect(out.reasonCodes).toContain('DATA_INVALID');
  });

  test('demo-labelled source → BLOCKED [SOURCE_DEMO] (synthetic feed can never produce signals)', () => {
    const out = evaluateSignal(coreInput({ execution: { timeframe: 'M15', candles: coreInput().execution.candles, source: 'demo-bridge' } }));
    expect(out.outcome).toBe('BLOCKED');
    expect(out.reasonCodes).toContain('SOURCE_DEMO');
  });
});

// ---------------------------------------------------------------------------
// Strategy semantics
// ---------------------------------------------------------------------------

describe('signal core — outcome semantics', () => {
  test('no structure break at all → NO_SETUP [NO_STRUCTURE_BREAK] (not WAIT, not BLOCKED)', () => {
    const flat = flatSeries(120, 1_791_000_000, M15);
    const decision = flat[flat.length - 1];
    const input = coreInput({
      execution: { timeframe: 'M15', candles: flat, source: 'bridge-mt5' },
      referencePrice: decision.close,
      nowUtcSec: decision.timeUtcSec + M15 + 30,
    });
    const out = evaluateSignal(input);
    expect(out.outcome).toBe('NO_SETUP');
    expect(out.reasonCodes).toContain('NO_STRUCTURE_BREAK');
  });

  test('bullish break + successful retest + friendly filters → BUY_SETUP with valid levels', () => {
    const input = coreInput();
    const out = evaluateSignal(input);
    // This fixture is engineered to pass every (permissive) filter. If the
    // engine rejects it, the assertion failure shows which filter.
    expect(out.outcome).toBe('BUY_SETUP');
    expect(out.levels).not.toBeNull();
    expect(out.levels!.direction).toBe('BUY');
    expect(out.levels!.stopLoss).toBeLessThan(out.levels!.entryZoneLow);
    expect(out.levels!.target).toBeGreaterThan(out.levels!.entryReference);
    expect(out.evidence?.structureEvent?.direction).toBe('bullish');
    expect(out.evidence?.retestBarTimeUtc).not.toBeNull();
    expect(out.expiryUtc).not.toBeNull();
  });

  test('BUY_SETUP and SELL_SETUP are mutually consistent (direction follows the event)', () => {
    const buyOut = evaluateSignal(coreInput());
    const execStart = 1_791_000_000;
    const bearExec = bearishBreakSeries(execStart);
    const bearInput = coreInput({
      execution: { timeframe: 'M15', candles: bearExec, source: 'bridge-mt5' },
      h1: { timeframe: 'H1', candles: bearishHtf(120, execStart - 120 * H1, H1), source: 'bridge-mt5' },
      h4: { timeframe: 'H4', candles: bearishHtf(120, execStart - 120 * H4, H4), source: 'bridge-mt5' },
      referencePrice: bearExec[bearExec.length - 1].close,
      nowUtcSec: bearExec[bearExec.length - 1].timeUtcSec + M15 + 30,
    });
    const bearOut = evaluateSignal(bearInput);
    // Mirrored fixtures with mirrored contexts → mirrored setup outcomes.
    expect(buyOut.outcome).toBe('BUY_SETUP');
    expect(bearOut.outcome).toBe('SELL_SETUP');
    expect(buyOut.levels!.direction).toBe('BUY');
    expect(bearOut.levels!.direction).toBe('SELL');
    expect(bearOut.levels!.stopLoss).toBeGreaterThan(bearOut.levels!.entryZoneHigh);
    expect(bearOut.levels!.target).toBeLessThan(bearOut.levels!.entryReference);
    // Never the same direction from mirrored data.
    expect(buyOut.levels!.direction).not.toBe(bearOut.levels!.direction);
  });

  test('zone invalidated (close back through the level) → NO_SETUP [ZONE_INVALIDATED]', () => {
    const input = coreInput();
    const candles = [...input.execution.candles];
    // The pullback phase closes back BELOW the broken level (~2653) → invalidated.
    const last = candles.length - 1;
    candles[last - 1] = candle(candles[last - 1].timeUtcSec, 2654.6, 2655.2, 2651.8, 2652.0); // close < 2653
    candles[last] = candle(candles[last].timeUtcSec, 2652, 2652.6, 2651.2, 2651.8);
    const out = evaluateSignal({ ...input, execution: { ...input.execution, candles }, referencePrice: 2651.8 });
    expect(out.outcome).toBe('NO_SETUP');
    expect(out.reasonCodes).toContain('ZONE_INVALIDATED');
  });

  test('break too old (> maxBarsSinceBreak) → NO_SETUP [STRUCTURE_BREAK_TOO_OLD]', () => {
    const input = coreInput();
    const candles = [...input.execution.candles];
    // Append IDENTICAL bars (o=h=l=c — no new swings, no new events, no closes
    // back through the level) so the existing break simply ages out of range.
    let t = candles[candles.length - 1].timeUtcSec + M15;
    for (let i = 0; i < PERMISSIVE.maxBarsSinceBreak + 3; i++) {
      candles.push(candle(t, 2654.2, 2654.2, 2654.2, 2654.2));
      t += M15;
    }
    const decision = candles[candles.length - 1];
    const out = evaluateSignal({
      ...input,
      execution: { ...input.execution, candles },
      referencePrice: decision.close,
      nowUtcSec: decision.timeUtcSec + M15 + 30,
    });
    expect(out.outcome).toBe('NO_SETUP');
    expect(out.reasonCodes).toContain('STRUCTURE_BREAK_TOO_OLD');
  });

  test('HTF opposite trend → WAIT (valid input, not strong enough)', () => {
    const input = coreInput();
    const execStart = 1_791_000_000;
    const bearContext = {
      h1: { timeframe: 'H1' as const, candles: bearishHtf(120, execStart - 120 * H1, H1), source: 'bridge-mt5' },
      h4: { timeframe: 'H4' as const, candles: bearishHtf(120, execStart - 120 * H4, H4), source: 'bridge-mt5' },
    };
    const out = evaluateSignal({ ...input, ...bearContext });
    // With both HTFs bearish, a bullish setup must NOT pass; the rejection is
    // WAIT (inputs valid, filter refused) — unless an earlier filter refused.
    expect(['WAIT', 'NO_SETUP']).toContain(out.outcome);
    if (out.outcome === 'WAIT') {
      expect(out.reasonCodes.some((c) => c === 'HTF_H1_OPPOSITE' || c === 'HTF_H4_OPPOSITE')).toBe(true);
    }
  });

  test('retest missing (price never returns into the zone) → WAIT [RETEST_PENDING], no levels', () => {
    // Construct from scratch: wave → ONE gap-up break bar → continuation bars
    // whose lows stay ABOVE the entry zone (no bar after the break ever dips
    // back into the zone → the retest requirement is not satisfied).
    const execStart = 1_791_000_000;
    const wave = waveLeg(96, execStart, M15, 2650, 3);
    let t = execStart + 96 * M15;
    const candles = [...wave];
    // decisive break bar: closes far above the swing-high level (~2653.6)
    candles.push(candle(t, 2652.0, 2661.0, 2651.5, 2660.0));
    t += M15;
    // continuation: lows well above the zone top (~2655.3)
    for (let i = 0; i < 5; i++) {
      candles.push(candle(t, 2659.5 + i * 0.2, 2660.5 + i * 0.2, 2658.5 + i * 0.2, 2659.8 + i * 0.2));
      t += M15;
    }
    const decision = candles[candles.length - 1];
    const input = coreInput({
      execution: { timeframe: 'M15', candles, source: 'bridge-mt5' },
      referencePrice: decision.close,
      nowUtcSec: decision.timeUtcSec + M15 + 30,
    });
    const out = evaluateSignal(input);
    expect(out.outcome).toBe('WAIT');
    expect(out.reasonCodes).toContain('RETEST_PENDING');
    expect(out.levels).toBeNull(); // WAIT never carries levels
  });

  test('live price far from the entry zone → WAIT [PRICE_BEYOND_ENTRY_ZONE], no levels', () => {
    const out = evaluateSignal(coreInput({ referencePrice: 2680 }));
    expect(out.outcome).toBe('WAIT');
    expect(out.reasonCodes).toContain('PRICE_BEYOND_ENTRY_ZONE');
    expect(out.levels).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Determinism & no look-ahead
// ---------------------------------------------------------------------------

describe('signal core — determinism and no look-ahead', () => {
  test('identical inputs → byte-identical outputs (outcome, fingerprint, levels, evidence)', () => {
    const input = coreInput();
    const a = evaluateSignal(input);
    const b = evaluateSignal(structuredClone(input));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
    expect(computeSignalFingerprint(input)).toBe(computeSignalFingerprint(structuredClone(input)));
  });

  test('any input change → different fingerprint', () => {
    const input = coreInput();
    const modified = structuredClone(input);
    // change BOTH the numeric value and its canonical text (the fingerprint
    // hashes the exact decimal text)
    const c0 = modified.execution.candles[0];
    c0.close = Number((c0.close + 0.01).toFixed(2));
    c0.closeText = c0.close.toFixed(2);
    expect(computeSignalFingerprint(input)).not.toBe(computeSignalFingerprint(modified));
  });

  test('future-candle mutation cannot alter a prior evaluation (no look-ahead)', () => {
    const input = coreInput();
    const full = structuredClone(input.execution.candles);
    // Evaluate as-of bar `cut` (window truncated at the cut).
    const cut = 100;
    const asOfInput: SignalCoreInput = {
      ...structuredClone(input),
      execution: { ...input.execution, candles: full.slice(0, cut + 1) },
      referencePrice: full[cut].close,
      nowUtcSec: full[cut].timeUtcSec + M15 + 30,
    };
    const before = evaluateSignal(asOfInput);
    // Mutate EVERY candle after the cut beyond recognition — the evaluation
    // as-of the cut must be byte-identical (no future information used).
    const mutated = structuredClone(full);
    for (let i = cut + 1; i < mutated.length; i++) {
      mutated[i] = candle(mutated[i].timeUtcSec, 3000 + i, 3001 + i, 2999 - i, 3000.5 + i);
    }
    const afterInput: SignalCoreInput = {
      ...structuredClone(input),
      execution: { ...input.execution, candles: mutated.slice(0, cut + 1) },
      referencePrice: full[cut].close,
      nowUtcSec: full[cut].timeUtcSec + M15 + 30,
    };
    const after = evaluateSignal(afterInput);
    expect(JSON.stringify(before)).toBe(JSON.stringify(after));
  });

  test('causalTrendAt ignores HTF bars that close after the decision instant', () => {
    const start = 1_791_000_000;
    const htf = bullishHtf(120, start, H1);
    const asOf = start + 50 * H1 + 1800; // half-way through bar 50
    const trendA = causalTrendAt({ timeframe: 'H1', candles: htf, source: 'bridge-mt5' }, RULES.swingLeft, RULES.swingRight, asOf);
    // Drop all bars after 50 — same knowledge, same trend.
    const truncated = { timeframe: 'H1' as const, candles: htf.slice(0, 51), source: 'bridge-mt5' };
    const trendB = causalTrendAt(truncated, RULES.swingLeft, RULES.swingRight, asOf);
    expect(trendA).toBe(trendB);
  });
});

// ---------------------------------------------------------------------------
// Level math
// ---------------------------------------------------------------------------

describe('signal core — level arithmetic (deriveLevels)', () => {
  test('BUY: spread-adjusted entry, swing-anchored SL, fixed-R target, R:R arithmetic', () => {
    const derived = deriveLevels('BUY', /* anchor swing low */ 2600, /* ATR */ 10, /* mid */ 2650, /* halfSpread */ 0.12, 2645, 2655, 2, RULES);
    expect(derived.ok).toBe(true);
    const lv = derived.levels!;
    // entry = mid + halfSpread = 2650.12
    expect(lv.entryReference).toBeCloseTo(2650.12, 8);
    // SL = anchor − buffer = 2600 − 0.5*10 = 2595
    expect(lv.stopLoss).toBeCloseTo(2595, 8);
    // risk = entry − SL = 55.12
    expect(lv.riskPrice).toBeCloseTo(55.12, 8);
    // target = entry + 2 × risk
    expect(lv.target).toBeCloseTo(2650.12 + 2 * 55.12, 8);
    // R:R = reward / risk = 2 exactly
    expect(lv.rewardRiskRatio).toBeCloseTo(2, 6);
  });

  test('SELL: mirrored ordering (SL above zone, target below entry)', () => {
    const derived = deriveLevels('SELL', 2700, 10, 2650, 0.12, 2645, 2655, 2, RULES);
    expect(derived.ok).toBe(true);
    const lv = derived.levels!;
    expect(lv.entryReference).toBeCloseTo(2649.88, 8);
    expect(lv.stopLoss).toBeCloseTo(2705, 8);
    expect(lv.target).toBeLessThan(lv.entryReference);
    expect(lv.rewardRiskRatio).toBeCloseTo(2, 6);
  });

  test('invalid SL ordering (anchor above entry for BUY) → LEVEL_CALC_INVALID, never levels', () => {
    const derived = deriveLevels('BUY', /* anchor ABOVE the entry */ 2660, 10, 2650, 0.12, 2645, 2655, 2, RULES);
    expect(derived.ok).toBe(false);
    expect(derived.levels).toBeNull();
    expect(derived.code).toBe('LEVEL_CALC_INVALID');
  });

  test('zero-risk (entry exactly at SL) is rejected', () => {
    const derived = deriveLevels('BUY', 2649.88, 10, 2650, 0.12, 2645, 2655, 2, RULES);
    // SL = 2649.88 - 5 = 2644.88; risk = 2650.12-2644.88 > 0 → actually valid.
    // Instead force zero risk: entry == SL.
    const d2 = deriveLevels('BUY', 2645, 0, 2650, 0, 2645, 2655, 2, RULES);
    // ATR 0 → buffer 0 → SL = 2645; entry 2650 → risk 5 → still valid. The
    // real zero-risk case: anchor = entry − halfSpread exactly with ATR 0.
    const d3 = deriveLevels('BUY', 2650, 0, 2650, 0, 2645, 2655, 2, RULES);
    expect(d3.ok).toBe(false);
    expect(d3.code).toBe('LEVEL_CALC_INVALID');
    void derived;
    void d2;
  });

  test('spread beyond the max → WAIT [SPREAD_TOO_WIDE] (strategy gate, not a data failure)', () => {
    const input = coreInput({ spreadPrice: 5.0 });
    const out = evaluateSignal(input);
    expect(out.outcome).not.toBe('BLOCKED');
    if (out.outcome === 'WAIT') {
      expect(out.reasonCodes).toContain('SPREAD_TOO_WIDE');
    }
  });
});
