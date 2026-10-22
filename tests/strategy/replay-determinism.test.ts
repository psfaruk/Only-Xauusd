/**
 * PHASE 4 — STRATEGY REPLAY DETERMINISM + NO-LOOK-AHEAD TESTS (Task 42-S3).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: fully synthetic candle fixtures — never real broker data.
 * The PURE engines are called directly (windows + nowUtcSec in, evaluation
 * out — no DB, no network, no clock).
 *
 * Pinned properties (master prompt Phase 4 acceptance tests):
 *   1. IDENTICAL market replay + strategy version → IDENTICAL decision output
 *      (byte-identical JSON: fingerprints, reason codes, levels, evidence).
 *   2. NO FUTURE CANDLE can be accessed by the decision function:
 *      · baseline engine — H1/H4 context windows may carry bars that closed
 *        AFTER the decision bar's close (the internal causal filter must
 *        exclude them); mutating those future bars into an adversarial
 *        bearish crash must leave the decision unchanged.
 *      · both engines — a still-forming execution bar (close after the
 *        evaluation instant) is REFUSED (FORMING_CANDLE_IN_INPUT → BLOCKED),
 *        never silently decided upon.
 *   3. The decision depends on the WINDOW CONTENT, not the wall clock: the
 *      same closed window evaluated later in time yields the same decision
 *      (only generatedAtUtc / fingerprints legitimately move).
 *
 * Rules note: the scalper block uses a disclosed TEST VARIANT of the rule set
 * (legacyGate=false, minBarsPerTf=60, windowBars=240) — the same variant family
 * scripts/backtest-scalper.ts uses for its LEGACY scenario. Determinism must
 * hold for ANY rule input; the variant only makes a synthetic SETUP reachable.
 */

// Hermeticity (Task 44 order-dependence fix): imports @/lib/signal/rules and
// @/lib/signal/scalper/rules → @/lib/config. Setup must run FIRST so bun's
// .env auto-load can never poison the process-wide config cache with the
// real MT5_BRIDGE_URL before the fail-closed tests/market/* assertions.
import '../market/helpers/setup';
import { describe, expect, test } from 'bun:test';
import { evaluateSignal } from '@/lib/signal/core';
import { evaluateScalper, scalperSetupFingerprint, setupFingerprintOf } from '@/lib/signal/scalper/core';
import { buildScalperRules } from '@/lib/signal/scalper/rules';
import type { ScalperCoreInput, ScalperEvaluation } from '@/lib/signal/scalper/types';
import { buildStrategyRules } from '@/lib/signal/rules';
import type { SignalEvaluation } from '@/lib/signal/types';
import type { Timeframe } from '@/lib/market/types';
import type { AnalysisCandle } from '@/lib/analysis/types';
import type { SignalWindow } from '@/lib/signal/types';

const M15 = 900;
const M5 = 300;
const M1 = 60;
const H1S = 3600;
const H4S = 14400;
const START = 1_791_000_000;

// ---------------------------------------------------------------------------
// Synthetic fixtures (deterministic generators — same family as
// tests/backtest/engine.test.ts, extended for the scalper TF stack)
// ---------------------------------------------------------------------------

function candle(t: number, o: number, h: number, l: number, c: number): AnalysisCandle {
  return {
    timeUtcSec: t, open: o, high: h, low: l, close: c, volume: null,
    openText: o.toFixed(2), highText: h.toFixed(2), lowText: l.toFixed(2), closeText: c.toFixed(2),
  };
}

function wave(count: number, startSec: number, tfSec: number, base: number, amp: number, period = 16): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = base + amp * Math.sin((2 * Math.PI * i) / period);
    const o = mid - amp * 0.3 * Math.cos((2 * Math.PI * i) / period);
    const c = mid + amp * 0.3 * Math.cos((2 * Math.PI * i) / period);
    const h = Math.max(o, c) + amp * 0.15;
    const l = Math.min(o, c) - amp * 0.15;
    out.push(candle(t, Number(o.toFixed(2)), Number(h.toFixed(2)), Number(l.toFixed(2)), Number(c.toFixed(2))));
  }
  return out;
}

function rising(count: number, startSec: number, tfSec: number, base: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * tfSec;
    const mid = base + i * 0.6 + 2.0 * Math.sin((2 * Math.PI * i) / 16);
    out.push(candle(t, Number((mid - 0.6).toFixed(2)), Number((mid + 1.4).toFixed(2)), Number((mid - 1.4).toFixed(2)), Number((mid + 0.6).toFixed(2))));
  }
  return out;
}

function setupRichExecution(startSec: string | number, cycles = 3): AnalysisCandle[] {
  const start = Number(startSec);
  const bars: AnalysisCandle[] = [];
  let t = start;
  bars.push(...wave(112, t, M15, 2650, 3));
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

// ── Baseline (hybrid-structure-retest) dataset: one fixed window per TF ──────
const exec = setupRichExecution(START, 3);
const h1 = rising(Math.ceil((exec.length * M15) / H1S) + 40, START - 130 * H1S, H1S, 2600);
const h4 = rising(160, START - 160 * H4S, H4S, 2600);

const SIGNAL_RULES = {
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

/** The frozen baseline decision: setupRichExecution produces BUY_SETUP at the
 *  decision bar opening at this instant (probe-frozen; see audit/phase4-strategy-audit.md). */
const BASELINE_DECISION_SEC = 1791118800; // = START + 132 × 900 (decision bar index 132)
const BASELINE_DECISION_IDX = 132;

function windowAsOf(bars: AnalysisCandle[], tf: Timeframe, tfSec: number, asOf: number, windowBars: number): SignalWindow {
  let end = -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].timeUtcSec + tfSec <= asOf) { end = i; break; }
  }
  if (end < 0) return { timeframe: tf, candles: [], source: 'bridge-mt5' };
  const start = Math.max(0, end - windowBars + 1);
  return { timeframe: tf, candles: bars.slice(start, end + 1), source: 'bridge-mt5' };
}

function baselineInput(nowUtcSec = BASELINE_DECISION_SEC + M15) {
  const i = BASELINE_DECISION_IDX;
  const start = Math.max(0, i - SIGNAL_RULES.windowBars + 1);
  return {
    symbol: 'XAUUSDm',
    digits: 2,
    execution: { timeframe: 'M15' as const, candles: exec.slice(start, i + 1), source: 'bridge-mt5' },
    h1: windowAsOf(h1, 'H1', H1S, BASELINE_DECISION_SEC + M15, 200),
    h4: windowAsOf(h4, 'H4', H4S, BASELINE_DECISION_SEC + M15, 150),
    referencePrice: exec[i].close,
    spreadPrice: 0.24,
    nowUtcSec,
    rules: { ...SIGNAL_RULES },
  };
}

// ── Scalper dataset: M1 wave + oversold descent + green turn bar ────────────
function m1Series(): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  let t = START;
  out.push(...wave(960, t, M1, 2650, 4));
  t += 960 * M1;
  for (let i = 0; i < 16; i++) {
    const o = 2650 - i * 1.2;
    out.push(candle(t, o, o + 0.6, o - 1.8, o - 1.2));
    t += M1;
  }
  out.push(candle(t, 2630.8, 2633.4, 2630.2, 2632.6));
  return out;
}
const m1 = m1Series();
const scalperSpanSec = m1[m1.length - 1].timeUtcSec + M1 - START;
const m5 = wave(Math.ceil(scalperSpanSec / M5) + 4, START, M5, 2650, 5);
const m15 = wave(Math.ceil(scalperSpanSec / M15) + 8, START, M15, 2650, 6);
const sh1 = rising(Math.ceil(scalperSpanSec / H1S) + 140, START - 140 * H1S, H1S, 2600);
const sh4 = rising(180, START - 180 * H4S, H4S, 2600);

const SCALPER_RULES = {
  ...buildScalperRules(),
  minBarsPerTf: 60,
  windowBars: 240,
  smc: { ...buildScalperRules().smc, legacyGate: false },
};

const SCALPER_DECISION_SEC = m1[m1.length - 1].timeUtcSec; // last M1 bar open
const SCALPER_NOW_SEC = SCALPER_DECISION_SEC + M1;          // its close instant

function scalperInput(nowUtcSec = SCALPER_NOW_SEC): ScalperCoreInput {
  return {
    symbol: 'XAUUSDm',
    digits: 2,
    m15: windowAsOf(m15, 'M15', M15, nowUtcSec, SCALPER_RULES.windowBars),
    m5: windowAsOf(m5, 'M5', M5, nowUtcSec, SCALPER_RULES.windowBars),
    m1: windowAsOf(m1, 'M1', M1, nowUtcSec, SCALPER_RULES.windowBars),
    h1: windowAsOf(sh1, 'H1', H1S, nowUtcSec, SCALPER_RULES.windowBars),
    h4: windowAsOf(sh4, 'H4', H4S, nowUtcSec, SCALPER_RULES.windowBars),
    referencePrice: m1[m1.length - 1].close,
    spreadPrice: 0.3,
    nowUtcSec,
    rules: { ...SCALPER_RULES },
  };
}

// ---------------------------------------------------------------------------
// Decision views — the decision + its CAUSAL evidence. Fields that legitimately
// depend on nowUtcSec or on raw input bytes (generatedAtUtc, inputFingerprint,
// raw window-shape summaries) are excluded by design and documented per test.
// ---------------------------------------------------------------------------

function decisionView(ev: SignalEvaluation) {
  return {
    outcome: ev.outcome,
    reasonCodes: ev.reasonCodes,
    decisionCandleTimeUtc: ev.decisionCandleTimeUtc,
    setupKnownAtUtc: ev.setupKnownAtUtc,
    expiryUtc: ev.expiryUtc,
    levels: ev.levels,
    datasetFingerprint: ev.datasetFingerprint,
    causalEvidence: ev.evidence
      ? {
          htfContext: ev.evidence.htfContext,
          structureEvent: ev.evidence.structureEvent,
          indicators: ev.evidence.indicators,
          decisionClose: ev.evidence.decisionClose,
        }
      : null,
  };
}

function scalperDecisionView(ev: ScalperEvaluation) {
  return {
    outcome: ev.outcome,
    reasonCodes: ev.reasonCodes,
    decisionCandleTimeUtc: ev.decisionCandleTimeUtc,
    setupKnownAtUtc: ev.setupKnownAtUtc,
    expiryUtc: ev.expiryUtc,
    levels: ev.levels,
    datasetFingerprint: ev.datasetFingerprint,
    causalEvidence: ev.evidence?.scalper ?? null,
  };
}

// ---------------------------------------------------------------------------
// 1) Replay determinism — identical inputs → byte-identical outputs
// ---------------------------------------------------------------------------

describe('Phase 4 — replay determinism (identical inputs → identical decision)', () => {
  test('baseline evaluateSignal: SETUP with levels reproduces byte-identically', () => {
    const a = evaluateSignal(baselineInput());
    const b = evaluateSignal(baselineInput());
    expect(a.outcome).toBe('BUY_SETUP'); // the frozen decision is a real setup
    expect(a.levels).not.toBeNull();
    expect(a.reasonCodes).toEqual([]);
    // FULL object byte-identity — fingerprints, reason codes, levels, evidence.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
    expect(a.datasetFingerprint).toBe(b.datasetFingerprint);
  });

  test('baseline evaluateSignal: an arbitrary mid-cycle decision reproduces byte-identically', () => {
    const i = 124; // mid-cycle bar (any honest outcome class is fine here)
    const start = Math.max(0, i - SIGNAL_RULES.windowBars + 1);
    const now = exec[i].timeUtcSec + M15;
    const mk = () => evaluateSignal({
      symbol: 'XAUUSDm',
      digits: 2,
      execution: { timeframe: 'M15' as const, candles: exec.slice(start, i + 1), source: 'bridge-mt5' },
      h1: windowAsOf(h1, 'H1', H1S, now, 200),
      h4: windowAsOf(h4, 'H4', H4S, now, 150),
      referencePrice: exec[i].close,
      spreadPrice: 0.24,
      nowUtcSec: now,
      rules: { ...SIGNAL_RULES },
    });
    const a = mk();
    const b = mk();
    expect(['WAIT', 'NO_SETUP', 'BUY_SETUP', 'SELL_SETUP', 'BLOCKED']).toContain(a.outcome);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('scalper evaluateScalper: SETUP with levels reproduces byte-identically', () => {
    const a = evaluateScalper(scalperInput());
    const b = evaluateScalper(scalperInput());
    expect(a.outcome).toBe('BUY_SETUP'); // frozen: M1 REVERSAL agreement
    expect(a.levels).not.toBeNull();
    expect(a.evidence?.scalper?.sourceTimeframe).toBe('M1');
    expect(a.evidence?.scalper?.model).toBe('REVERSAL');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
  });
});

// ---------------------------------------------------------------------------
// 2) No-look-ahead — the decision function cannot read future candles
// ---------------------------------------------------------------------------

describe('Phase 4 — no future candle can be accessed by the decision function', () => {
  test('baseline: MUTATED future H1/H4 bars (closed after the decision) leave the decision unchanged', () => {
    const clean = evaluateSignal(baselineInput());
    expect(clean.outcome).toBe('BUY_SETUP');

    // Adversarial future bars: a hard bearish crash on H1 and H4 AFTER the
    // decision close. If the engine ever read them, the causal H1/H4 trend
    // would flip bearish → the setup would be suppressed (HTF_H1_OPPOSITE /
    // HTF_H4_OPPOSITE) or the evidence would change. It must not.
    const decisionClose = BASELINE_DECISION_SEC + M15;
    const futureH1: AnalysisCandle[] = [];
    for (let i = 0; i < 12; i++) {
      futureH1.push(candle(decisionClose + i * H1S, 2400 - i * 8, 2401 - i * 8, 2390 - i * 8, 2395 - i * 8));
    }
    const futureH4: AnalysisCandle[] = [];
    for (let i = 0; i < 6; i++) {
      futureH4.push(candle(decisionClose + i * H4S, 2350 - i * 15, 2352 - i * 15, 2330 - i * 15, 2340 - i * 15));
    }

    const mutated = evaluateSignal({
      ...baselineInput(),
      // windows deliberately carry the future bars — the engine must filter
      h1: { timeframe: 'H1', candles: [...windowAsOf(h1, 'H1', H1S, decisionClose, 200).candles, ...futureH1], source: 'bridge-mt5' },
      h4: { timeframe: 'H4', candles: [...windowAsOf(h4, 'H4', H4S, decisionClose, 150).candles, ...futureH4], source: 'bridge-mt5' },
    });

    // The DECISION is unchanged. (The raw input fingerprint legitimately
    // differs — it honestly records that the input bytes differed.)
    expect(decisionView(mutated)).toEqual(decisionView(clean));
    expect(mutated.outcome).toBe('BUY_SETUP');
    expect(mutated.levels).toEqual(clean.levels);
    expect(mutated.inputFingerprint).not.toBe(clean.inputFingerprint); // input differed
  });

  test('baseline: a still-forming execution bar is REFUSED, never decided upon', () => {
    const formingBar = candle(BASELINE_DECISION_SEC + M15, 2653.0, 2662.0, 2652.5, 2661.0);
    const formingBarClose = formingBar.timeUtcSec + M15; // strictly after now
    const ev = evaluateSignal({
      ...baselineInput(),
      execution: {
        timeframe: 'M15',
        candles: [...exec.slice(0, BASELINE_DECISION_IDX + 1), formingBar],
        source: 'bridge-mt5',
      },
      nowUtcSec: formingBarClose - 1, // the appended bar has NOT closed yet
    });
    expect(ev.outcome).toBe('BLOCKED');
    expect(ev.reasonCodes).toContain('FORMING_CANDLE_IN_INPUT');
    expect(ev.levels).toBeNull(); // fail-closed: no levels from a forming bar
  });

  test('scalper: a still-forming M1 bar is REFUSED (BLOCKED, FORMING_CANDLE_IN_INPUT)', () => {
    const forming = candle(SCALPER_DECISION_SEC + M1, 2632.6, 2634.0, 2631.9, 2633.5);
    const ev = evaluateScalper({
      ...scalperInput(),
      m1: { timeframe: 'M1', candles: [...windowAsOf(m1, 'M1', M1, SCALPER_NOW_SEC, SCALPER_RULES.windowBars).candles, forming], source: 'bridge-mt5' },
      nowUtcSec: SCALPER_NOW_SEC, // the appended bar's close is now+60s — forming
    });
    expect(ev.outcome).toBe('BLOCKED');
    expect(ev.reasonCodes).toContain('FORMING_CANDLE_IN_INPUT');
    expect(ev.levels).toBeNull();
  });

  test('scalper: a still-forming M15 bar is REFUSED as well (per-TF gate)', () => {
    const forming = candle(SCALPER_DECISION_SEC + M15, 2651.0, 2653.0, 2650.0, 2652.0);
    const ev = evaluateScalper({
      ...scalperInput(),
      m15: { timeframe: 'M15', candles: [...windowAsOf(m15, 'M15', M15, SCALPER_NOW_SEC, SCALPER_RULES.windowBars).candles, forming], source: 'bridge-mt5' },
      nowUtcSec: SCALPER_NOW_SEC,
    });
    expect(ev.outcome).toBe('BLOCKED');
    expect(ev.reasonCodes).toContain('FORMING_CANDLE_IN_INPUT');
  });
});

// ---------------------------------------------------------------------------
// 3) Decision depends on window CONTENT, not the wall clock
// ---------------------------------------------------------------------------

describe('Phase 4 — the same closed window decided later in time yields the same decision', () => {
  test('baseline: nowUtcSec +900s later → identical decision (only generatedAtUtc/fingerprint move)', () => {
    const early = evaluateSignal(baselineInput());
    const later = evaluateSignal(baselineInput(BASELINE_DECISION_SEC + 2 * M15)); // 15 min later
    expect(decisionView(later)).toEqual(decisionView(early));
    expect(later.generatedAtUtc).not.toBe(early.generatedAtUtc); // honestly stamped
    expect(later.inputFingerprint).not.toBe(early.inputFingerprint); // nowUtcSec is hashed
  });

  test('scalper: the setup-identity fingerprint (dedup key) is stable across later instants', () => {
    // SAME closed windows (frozen at SCALPER_NOW_SEC), only the wall clock moves.
    const early = evaluateScalper(scalperInput());
    const later = evaluateScalper({ ...scalperInput(), nowUtcSec: SCALPER_NOW_SEC + 600 });
    expect(scalperDecisionView(later)).toEqual(scalperDecisionView(early));
    // The logical setup identity (the service's dedup key) does not move.
    expect(setupFingerprintOf(later)).toBe(setupFingerprintOf(early));
    expect(setupFingerprintOf(later)).toBe(
      scalperSetupFingerprint('XAUUSDm', 'M1', 'REVERSAL', 'BUY', SCALPER_DECISION_SEC),
    );
  });
});
