/**
 * PHASE 12 SCALPER ENGINE TESTS — M1/M5/M15 OR-logic deterministic core.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: all candles below are SYNTHETIC fixtures constructed to
 * exercise specific strategy paths. They are never presented as broker data.
 *
 * Pinned behaviors (Task 32):
 *   · determinism — identical inputs → byte-identical evaluation
 *   · OR-logic: ANY ONE timeframe agreeing is enough (no HTF gates)
 *   · momentum model (EMA9/21 + RSI band) BUY/SELL
 *   · reversal model (RSI extreme + turn-back) BUY/SELL
 *   · priority: M15 beats M5 beats M1 as the SOURCE timeframe
 *   · no agreement → NO_SETUP with SCALPER_NO_AGREE
 *   · spread gate → WAIT (SCALPER_SPREAD_TOO_WIDE)
 *   · levels: ordering, R:R arithmetic, expiry per source TF
 *   · fail-closed: forming candle / insufficient history → BLOCKED
 *   · pure suppression: cooldown + duplicate → WAIT with honest codes
 *   · setup fingerprint: same decision bar → same fingerprint
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { computeScalperFingerprint, deriveScalperLevels, evaluateScalper, htfOpposesSetup, readHtfTrend, scalperSetupFingerprint, setupFingerprintOf, suppressSetup } from '@/lib/signal/scalper/core';
import { buildScalperRules } from '@/lib/signal/scalper/rules';
import type { ScalperEvidenceBlock,  ScalperCoreInput, ScalperRules } from '@/lib/signal/scalper/types';
import type { SignalWindow } from '@/lib/signal/types';
import type { AnalysisCandle } from '@/lib/analysis/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// LEGACY MODE for the pinned Phase-12 behaviour tests: the chase guard and
// the HTF gate (Task 36) are OFF here — they have their own describe block
// below with explicitly-enabled rules (the production defaults).
const RULES: ScalperRules = {
  ...buildScalperRules(),
  windowBars: 240,
  minBarsPerTf: 60,
  maxExtensionAtr: 0,
  htf: { ...buildScalperRules().htf, enabled: false },
};

const M1 = 60;
const M5 = 300;
const M15 = 900;
const NOW = 1_800_000_000; // arbitrary fixed evaluation instant (closed-bar safe)

function candle(t: number, o: number, h: number, l: number, c: number): AnalysisCandle {
  return {
    timeUtcSec: t,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: null,
    openText: o.toFixed(2),
    highText: h.toFixed(2),
    lowText: l.toFixed(2),
    closeText: c.toFixed(2),
  };
}

/** Flat oscillation — no momentum, no reversal → NO_SETUP baseline fixture. */
function flatWindow(tfSec: number, count: number, base = 2650): SignalWindow {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = NOW - (count - i) * tfSec;
    const o = base + (i % 2 === 0 ? 0 : 0.3);
    const c = base + (i % 2 === 0 ? 0.3 : 0);
    out.push(candle(t, o, Math.max(o, c) + 0.15, Math.min(o, c) - 0.15, c));
  }
  return { timeframe: tfSec === M1 ? 'M1' : tfSec === M5 ? 'M5' : 'M15', candles: out, source: 'mt5-broker' };
}

/** Up-trend window WITH pullbacks (3 up bars + 1 pullback per cycle) —
 *  EMA9 > EMA21 with RSI held inside the momentum band (not exhausted). */
function upTrendWindow(tfSec: number, count: number, base = 2650, nowSec = NOW): SignalWindow {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = nowSec - (count - i) * tfSec;
    const phase = i % 4;
    const o = base + i * 0.8;
    const c = phase < 3 ? o + 1.2 : o - 0.9; // pullback bar every 4th
    const h = Math.max(o, c) + 0.2;
    const l = Math.min(o, c) - 0.2;
    out.push(candle(t, Number(o.toFixed(2)), Number(h.toFixed(2)), Number(l.toFixed(2)), Number(c.toFixed(2))));
  }
  return { timeframe: tfSec === M1 ? 'M1' : tfSec === M5 ? 'M5' : 'M15', candles: out, source: 'mt5-broker' };
}

/** Down-trend window with pullbacks (mirror of upTrendWindow). */
function downTrendWindow(tfSec: number, count: number, base = 2650): SignalWindow {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = NOW - (count - i) * tfSec;
    const phase = i % 4;
    const o = base - i * 0.8;
    const c = phase < 3 ? o - 1.2 : o + 0.9; // pullback bar every 4th
    const h = Math.max(o, c) + 0.2;
    const l = Math.min(o, c) - 0.2;
    out.push(candle(t, Number(o.toFixed(2)), Number(h.toFixed(2)), Number(l.toFixed(2)), Number(c.toFixed(2))));
  }
  return { timeframe: tfSec === M1 ? 'M1' : tfSec === M5 ? 'M5' : 'M15', candles: out, source: 'mt5-broker' };
}

/** Last close of an upTrendWindow (the live reference anchor). */
function upLastClose(count = 120, base = 2650): number {
  const i = count - 1;
  const o = base + i * 0.8;
  return i % 4 < 3 ? o + 1.2 : o - 0.9;
}

/** Last close of a downTrendWindow. */
function downLastClose(count = 120, base = 2650): number {
  const i = count - 1;
  const o = base - i * 0.8;
  return i % 4 < 3 ? o - 1.2 : o + 0.9;
}

/** Reversal window: long decline into an RSI extreme, then ONE up-close bar
 *  (the decision bar) — the turn-back the reversal model needs. */
function reversalUpWindow(tfSec: number, count: number, base = 2650): SignalWindow {
  const out: AnalysisCandle[] = [];
  const decline = count - 1;
  for (let i = 0; i < decline; i++) {
    const t = NOW - (count - i) * tfSec;
    const o = base - i * 1.1;
    const c = o - 1.0;
    out.push(candle(t, Number(o.toFixed(2)), Number((o + 0.2).toFixed(2)), Number((c - 0.2).toFixed(2)), Number(c.toFixed(2))));
  }
  // Decision bar: bullish close after the oversold extreme.
  const lastOpen = base - decline * 1.1 - 1.0;
  out.push(
    candle(
      NOW - tfSec,
      Number(lastOpen.toFixed(2)),
      Number((lastOpen + 1.6).toFixed(2)),
      Number((lastOpen - 0.2).toFixed(2)),
      Number((lastOpen + 1.4).toFixed(2)),
    ),
  );
  return { timeframe: tfSec === M1 ? 'M1' : tfSec === M5 ? 'M5' : 'M15', candles: out, source: 'mt5-broker' };
}

function baseInput(overrides: Partial<ScalperCoreInput> = {}): ScalperCoreInput {
  return {
    symbol: 'XAUUSDm',
    digits: 2,
    m15: flatWindow(M15, 120),
    m5: flatWindow(M5, 120),
    m1: flatWindow(M1, 120),
    // Task 36 — HTF windows default to EMPTY (trend reads null → no veto);
    // the HTF-gate tests override these explicitly.
    h1: { timeframe: 'H1', candles: [], source: 'mt5-broker' },
    h4: { timeframe: 'H4', candles: [], source: 'mt5-broker' },
    referencePrice: 2650.0,
    spreadPrice: 0.2,
    nowUtcSec: NOW,
    rules: RULES,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Determinism + outcome model
// ---------------------------------------------------------------------------

describe('Phase 12 scalper — determinism', () => {
  test('identical inputs → byte-identical evaluations (outcome, codes, fingerprint)', () => {
    const a = evaluateScalper(baseInput());
    const b = evaluateScalper(baseInput());
    expect(a.outcome).toBe(b.outcome);
    expect(a.reasonCodes).toEqual(b.reasonCodes);
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
    expect(JSON.stringify(a.levels)).toBe(JSON.stringify(b.levels));
  });

  test('the evaluation instant is part of the fingerprint (no hidden clock)', () => {
    const a = evaluateScalper(baseInput({ nowUtcSec: NOW }));
    const b = evaluateScalper(baseInput({ nowUtcSec: NOW + 1 }));
    expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
  });
});

describe('Phase 12 scalper — OR-logic', () => {
  test('ONLY M1 agreeing is enough (no HTF gates) — setup fires with source M1', () => {
    const evaluation = evaluateScalper(
      baseInput({ m1: upTrendWindow(M1, 120), referencePrice: upLastClose() }),
    );
    expect(evaluation.outcome).toBe('BUY_SETUP');
    expect(evaluation.evidence?.scalper?.sourceTimeframe).toBe('M1');
    expect(evidenceStage(evaluation, 'M15')).toBe('NO_AGREE');
    expect(evidenceStage(evaluation, 'M5')).toBe('NO_AGREE');
    expect(evidenceStage(evaluation, 'M1')).toBe('MOMENTUM_BUY');
  });

  test('M15 agreeing wins the priority over M5 and M1 (all three agree)', () => {
    const evaluation = evaluateScalper(
      baseInput({
        m15: upTrendWindow(M15, 120),
        m5: upTrendWindow(M5, 120),
        m1: upTrendWindow(M1, 120),
        referencePrice: upLastClose(),
      }),
    );
    expect(evaluation.outcome).toBe('BUY_SETUP');
    expect(evidenceStage(evaluation, 'M15')).toBe('MOMENTUM_BUY');
    expect(evidenceStage(evaluation, 'M5')).toBe('MOMENTUM_BUY');
    expect(evidenceStage(evaluation, 'M1')).toBe('MOMENTUM_BUY');
    expect(evaluation.evidence?.scalper?.sourceTimeframe).toBe('M15');
  });

  test('no timeframe agrees → NO_SETUP with SCALPER_NO_AGREE', () => {
    const evaluation = evaluateScalper(baseInput());
    expect(evaluation.outcome).toBe('NO_SETUP');
    expect(evaluation.reasonCodes).toEqual(['SCALPER_NO_AGREE']);
    for (const tf of ['M15', 'M5', 'M1'] as const) {
      expect(evidenceStage(evaluation, tf)).toBe('NO_AGREE');
    }
  });

  test('momentum SELL fires on a down-trend window (mirrored band)', () => {
    const evaluation = evaluateScalper(
      baseInput({ m5: downTrendWindow(M5, 120), referencePrice: downLastClose() }),
    );
    expect(evaluation.outcome).toBe('SELL_SETUP');
    expect(evaluation.evidence?.scalper?.sourceTimeframe).toBe('M5');
    expect(evidenceStage(evaluation, 'M5')).toBe('MOMENTUM_SELL');
  });

  test('reversal BUY fires after an oversold extreme + turn-back', () => {
    const evaluation = evaluateScalper(
      baseInput({ m1: reversalUpWindow(M1, 120), referencePrice: 2530 }),
    );
    expect(evaluation.outcome).toBe('BUY_SETUP');
    expect(evidenceStage(evaluation, 'M1')).toBe('REVERSAL_BUY');
  });
});

describe('Phase 12 scalper — gates and levels', () => {
  test('spread above the max → WAIT with SCALPER_SPREAD_TOO_WIDE (setup suppressed, not killed)', () => {
    const evaluation = evaluateScalper(
      baseInput({ m1: upTrendWindow(M1, 120), referencePrice: upLastClose(), spreadPrice: 5.0 }),
    );
    expect(evaluation.outcome).toBe('WAIT');
    expect(evaluation.reasonCodes).toContain('SCALPER_SPREAD_TOO_WIDE');
    expect(evaluation.levels).toBeNull();
    expect(evaluation.evidence?.scalper?.suppressedDirection).toBe('BUY');
  });

  test('levels: direction-consistent ordering + fixed reward/risk arithmetic', () => {
    const evaluation = evaluateScalper(
      baseInput({ m1: upTrendWindow(M1, 120), referencePrice: upLastClose() }),
    );
    expect(evaluation.outcome).toBe('BUY_SETUP');
    const l = evaluation.levels;
    expect(l).not.toBeNull();
    if (l) {
      expect(l.direction).toBe('BUY');
      expect(l.stopLoss).toBeLessThan(l.entryReference);
      expect(l.target).toBeGreaterThan(l.entryReference);
      const risk = l.entryReference - l.stopLoss;
      expect(l.rewardPrice).toBeCloseTo(risk * RULES.rewardRisk, 4);
      expect(l.rewardRiskRatio).toBeCloseTo(RULES.rewardRisk, 4);
    }
  });

  test('SL tighter than minStopPrice → WAIT with SCALPER_SL_TOO_TIGHT', () => {
    // A near-flat window yields a tiny ATR → SL below the tradable floor.
    const tiny = flatWindow(M1, 120, 2650);
    // Force agreement impossible? Instead: craft an agreeing window with a
    // microscopic ATR by cloning the flat window and asserting the derivation
    // helper directly (the gate itself is deterministic level math).
    const derived = deriveScalperLevels('BUY', 2650, 0.01, 2650, 0.1, 2, RULES);
    expect(derived.ok).toBe(false);
    expect(derived.code).toBe('SCALPER_SL_TOO_TIGHT');
    void tiny;
  });

  test('expiry is per-source-TF seconds after the decision close', () => {
    const evaluation = evaluateScalper(
      baseInput({ m5: upTrendWindow(M5, 120), referencePrice: upLastClose() }),
    );
    expect(evaluation.outcome).toBe('BUY_SETUP');
    expect(evaluation.evidence?.scalper?.sourceTimeframe).toBe('M5');
    const decisionSec = Math.floor(new Date(evaluation.decisionCandleTimeUtc as string).getTime() / 1000);
    const closeSec = decisionSec + M5;
    const expirySec = Math.floor(new Date(evaluation.expiryUtc as string).getTime() / 1000);
    expect(expirySec).toBe(closeSec + RULES.expirySec.M5);
  });

  test('forming candle in any window → BLOCKED (fail-closed)', () => {
    const m1 = upTrendWindow(M1, 120);
    // Last bar opens AFTER the evaluation instant minus its duration → forming.
    const forming = upTrendWindow(M1, 121);
    forming.candles[forming.candles.length - 1] = candle(
      NOW, 2650, 2651, 2649, 2650.5, // opens exactly at NOW → close is in the future
    );
    const evaluation = evaluateScalper(baseInput({ m1: forming, referencePrice: 2721 }));
    expect(evaluation.outcome).toBe('BLOCKED');
    expect(evaluation.reasonCodes).toContain('FORMING_CANDLE_IN_INPUT');
    void m1;
  });

  test('insufficient history → BLOCKED with per-TF codes', () => {
    const evaluation = evaluateScalper(
      baseInput({ m1: { timeframe: 'M1', candles: flatWindow(M1, 30).candles.slice(0, 30), source: 'mt5-broker' } }),
    );
    expect(evaluation.outcome).toBe('BLOCKED');
    expect(evaluation.reasonCodes).toContain('INSUFFICIENT_M1_HISTORY');
    expect(evaluation.reasonCodes).toContain('INSUFFICIENT_DATA');
  });

  test('demo-labelled source → BLOCKED (never a guess)', () => {
    const demo = flatWindow(M1, 120);
    const evaluation = evaluateScalper(
      baseInput({ m1: { ...demo, source: 'demo-synthetic' } }),
    );
    expect(evaluation.outcome).toBe('BLOCKED');
    expect(evaluation.reasonCodes).toContain('SOURCE_DEMO');
  });
});

// ---------------------------------------------------------------------------
// Pure suppression + identity
// ---------------------------------------------------------------------------

describe('Phase 12 scalper — suppression + setup identity', () => {
  const setupEvaluation = evaluateScalper(
    baseInput({ m1: upTrendWindow(M1, 120), referencePrice: upLastClose() }),
  );

  test('a setup passes through untouched when nothing suppresses it', () => {
    const out = suppressSetup(setupEvaluation, { duplicate: false, cooldownActive: false });
    expect(out.outcome).toBe(setupEvaluation.outcome);
    expect(out.levels).toBe(setupEvaluation.levels);
  });

  test('cooldown suppression → WAIT + SCALPER_COOLDOWN, direction preserved in evidence', () => {
    const out = suppressSetup(setupEvaluation, { duplicate: false, cooldownActive: true });
    expect(out.outcome).toBe('WAIT');
    expect(out.reasonCodes).toEqual(['SCALPER_COOLDOWN']);
    expect(out.levels).toBeNull();
    expect(out.evidence?.scalper?.suppressedDirection).toBe('BUY');
    expect(out.evidence?.scalper?.sourceTimeframe).toBe('M1');
  });

  test('duplicate suppression → WAIT + SCALPER_DUPLICATE_SETUP (both codes when both apply)', () => {
    const both = suppressSetup(setupEvaluation, { duplicate: true, cooldownActive: true });
    expect(both.outcome).toBe('WAIT');
    expect(both.reasonCodes).toEqual(['SCALPER_DUPLICATE_SETUP', 'SCALPER_COOLDOWN']);
  });

  test('non-setup evaluations are never suppressed', () => {
    const noSetup = evaluateScalper(baseInput());
    const out = suppressSetup(noSetup, { duplicate: true, cooldownActive: true });
    expect(out).toBe(noSetup);
  });

  test('setup fingerprint: same decision bar → same fingerprint; new bar → different', () => {
    const fp1 = setupFingerprintOf(setupEvaluation);
    expect(fp1).not.toBeNull();
    const fp2 = setupFingerprintOf(evaluateScalper(baseInput({ m1: upTrendWindow(M1, 120), referencePrice: upLastClose() })));
    expect(fp2).toBe(fp1);
    // Different decision bar (the window ends one bar LATER) → different fingerprint.
    const shifted = upTrendWindow(M1, 121, 2650, NOW + M1);
    const fp3 = setupFingerprintOf(
      evaluateScalper(baseInput({ m1: shifted, referencePrice: upLastClose(121), nowUtcSec: NOW + M1 })),
    );
    expect(fp3).not.toBe(fp1);
  });

  test('scalperSetupFingerprint is deterministic over its explicit inputs', () => {
    const a = scalperSetupFingerprint('XAUUSDm', 'M5', 'MOMENTUM', 'SELL', NOW);
    const b = scalperSetupFingerprint('XAUUSDm', 'M5', 'MOMENTUM', 'SELL', NOW);
    const c = scalperSetupFingerprint('XAUUSDm', 'M5', 'MOMENTUM', 'SELL', NOW + 1);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});


// ---------------------------------------------------------------------------
// Task 36 — trading intelligence (chase guard + HTF reverse-vs-continue gate)
// ---------------------------------------------------------------------------

describe('Task 36 — HTF trend read (readHtfTrend)', () => {
  const htfRules = { ...buildScalperRules().htf, enabled: true };

  test('a rising window (close above both EMAs) reads bullish', () => {
    expect(readHtfTrend(upTrendWindow(3600, 130), htfRules)).toBe('bullish');
  });

  test('a falling window reads bearish', () => {
    expect(readHtfTrend(downTrendWindow(3600, 130), htfRules)).toBe('bearish');
  });

  test('a deep pullback inside an uptrend reads range (close below fast EMA, EMAs still rising)', () => {
    // upTrendWindow's decision close always rides ABOVE EMA20 (bullish); a
    // sharp 3-bar drop pushes the close under the fast EMA while EMA20 stays
    // above EMA50 — the honest "range" read (neither alignment holds).
    const w = upTrendWindow(3600, 130);
    const last = w.candles[w.candles.length - 1];
    const out = [...w.candles];
    for (let k = 1; k <= 3; k++) {
      const o = last.close - (k - 1) * 5;
      const c = o - 5;
      out.push(candle(last.timeUtcSec + k * 3600, o, o + 0.2, c - 0.2, c));
    }
    expect(readHtfTrend({ ...w, candles: out }, htfRules)).toBe('range');
  });

  test('insufficient history reads null (no opinion — the veto never fires)', () => {
    expect(readHtfTrend(upTrendWindow(3600, 30), htfRules)).toBeNull();
  });

  test('disabled layer reads null', () => {
    expect(readHtfTrend(upTrendWindow(3600, 130), { ...htfRules, enabled: false })).toBeNull();
  });
});

describe('Task 36 — htfOpposesSetup (the pure reverse-vs-continue gate)', () => {
  const htf = { ...buildScalperRules().htf, enabled: true, counterTrendMinScore: 75 };
  const bull = 'bullish' as const;
  const bear = 'bearish' as const;

  test('counter-trend SELL against aligned bullish H1+H4 is opposed', () => {
    expect(htfOpposesSetup({ htf, h1Trend: bull, h4Trend: bull, direction: 'SELL', model: 'MOMENTUM', smcScore: null })).toBe(true);
  });

  test('continuation BUY with aligned bullish H1+H4 is fine', () => {
    expect(htfOpposesSetup({ htf, h1Trend: bull, h4Trend: bull, direction: 'BUY', model: 'MOMENTUM', smcScore: null })).toBe(false);
  });

  test('mixed H1/H4 trends never veto', () => {
    expect(htfOpposesSetup({ htf, h1Trend: bull, h4Trend: bear, direction: 'SELL', model: 'MOMENTUM', smcScore: null })).toBe(false);
  });

  test('range or null trend reads never veto', () => {
    expect(htfOpposesSetup({ htf, h1Trend: 'range', h4Trend: 'range', direction: 'SELL', model: 'MOMENTUM', smcScore: null })).toBe(false);
    expect(htfOpposesSetup({ htf, h1Trend: null, h4Trend: bull, direction: 'SELL', model: 'MOMENTUM', smcScore: null })).toBe(false);
  });

  test('tier-A SMC reversal (score >= 75) is the genuine-reversal exception', () => {
    expect(htfOpposesSetup({ htf, h1Trend: bull, h4Trend: bull, direction: 'SELL', model: 'SMC_CONFLUENCE', smcScore: 78 })).toBe(false);
    expect(htfOpposesSetup({ htf, h1Trend: bull, h4Trend: bull, direction: 'SELL', model: 'SMC_CONFLUENCE', smcScore: 74 })).toBe(true);
  });

  test('disabled layer never vetoes', () => {
    expect(htfOpposesSetup({ htf: { ...htf, enabled: false }, h1Trend: bull, h4Trend: bull, direction: 'SELL', model: 'MOMENTUM', smcScore: null })).toBe(false);
  });
});

describe('Task 36 — scalper engine integration (chase guard + HTF veto)', () => {
  const H1 = 3600;
  const H4 = 14400;
  /** Production-posture rules: chase guard ON + HTF gate ON. */
  const T36_RULES: ScalperRules = { ...buildScalperRules(), windowBars: 240, minBarsPerTf: 60 };

  test('chase guard: an EXTENDED run no longer fires the momentum model (no chasing tops)', () => {
    const evaluation = evaluateScalper(
      baseInput({ m1: upTrendWindow(M1, 120), referencePrice: upLastClose(), rules: T36_RULES }),
    );
    // The extended ramp is exactly the 2025-10-21 anti-pattern: the momentum
    // BUY must NOT be the emitting model any more.
    expect(evaluation.evidence?.scalper?.model).not.toBe('MOMENTUM');
    expect(evaluation.outcome === 'BUY_SETUP' && evaluation.evidence?.scalper?.model === 'MOMENTUM').toBe(false);
  });

  test('HTF veto: a counter-trend SELL against aligned bullish H1+H4 becomes WAIT [SCALPER_HTF_OPPOSED]', () => {
    const evaluation = evaluateScalper(
      baseInput({
        m5: downTrendWindow(M5, 120),
        referencePrice: downLastClose(),
        rules: { ...T36_RULES, maxExtensionAtr: 0 }, // isolate the HTF gate
        h1: upTrendWindow(H1, 130),
        h4: upTrendWindow(H4, 130),
      }),
    );
    expect(evaluation.outcome).toBe('WAIT');
    expect(evaluation.reasonCodes).toContain('SCALPER_HTF_OPPOSED');
    expect(evaluation.evidence?.scalper?.suppressedDirection).toBe('SELL');
    expect(evidenceScalper(evaluation)?.htfTrend).toEqual({ h1: 'bullish', h4: 'bullish', opposed: true });
    expect(evaluation.evidence?.htfContext).toEqual({ h1Trend: 'bullish', h4Trend: 'bullish' });
  });

  test('HTF continuation: a with-trend BUY passes the same aligned-bullish context untouched', () => {
    const evaluation = evaluateScalper(
      baseInput({
        m1: upTrendWindow(M1, 120),
        referencePrice: upLastClose(),
        rules: { ...T36_RULES, maxExtensionAtr: 0 }, // isolate the HTF gate
        h1: upTrendWindow(H1, 130),
        h4: upTrendWindow(H4, 130),
      }),
    );
    expect(evaluation.outcome).toBe('BUY_SETUP');
    expect(evidenceScalper(evaluation)?.htfTrend).toEqual({ h1: 'bullish', h4: 'bullish', opposed: false });
  });

  test('empty HTF windows degrade honestly: trend null, no veto (legacy OR-logic intact)', () => {
    const evaluation = evaluateScalper(
      baseInput({
        m5: downTrendWindow(M5, 120),
        referencePrice: downLastClose(),
        rules: { ...T36_RULES, maxExtensionAtr: 0 },
      }),
    );
    expect(evaluation.outcome).toBe('SELL_SETUP');
    expect(evidenceScalper(evaluation)?.htfTrend).toEqual({ h1: null, h4: null, opposed: false });
  });

  test('post-loss suppression: suppressSetup reports SCALPER_POST_LOSS_COOLDOWN', () => {
    const raw = evaluateScalper(
      baseInput({
        m5: downTrendWindow(M5, 120),
        referencePrice: downLastClose(),
        rules: { ...T36_RULES, maxExtensionAtr: 0 },
      }),
    );
    expect(raw.outcome).toBe('SELL_SETUP');
    const suppressed = suppressSetup(raw, { duplicate: false, cooldownActive: false, postLossCooldown: true });
    expect(suppressed.outcome).toBe('WAIT');
    expect(suppressed.reasonCodes).toContain('SCALPER_POST_LOSS_COOLDOWN');
    expect(suppressed.levels).toBeNull();
    expect(suppressed.evidence?.scalper?.suppressedDirection).toBe('SELL');
  });

  test('fingerprint is stable across repeated identical evaluations (determinism, engine 14)', () => {
    const input = baseInput({
      m1: upTrendWindow(M1, 120),
      referencePrice: upLastClose(),
      rules: { ...T36_RULES, maxExtensionAtr: 0 },
      h1: upTrendWindow(H1, 130),
      h4: upTrendWindow(H4, 130),
    });
    expect(computeScalperFingerprint(input)).toBe(computeScalperFingerprint(input));
  });
});

function evidenceScalper(evaluation: { evidence: { scalper?: ScalperEvidenceBlock } | null }): ScalperEvidenceBlock | null | undefined {
  return evaluation.evidence?.scalper;
}

// ---------------------------------------------------------------------------

function evidenceStage(evaluation: { evidence: { scalper?: { tfJudgements: Array<{ timeframe: string; stage: string }> } } | null }, tf: string): string | null {
  return evaluation.evidence?.scalper?.tfJudgements.find((j) => j.timeframe === tf)?.stage ?? null;
}
