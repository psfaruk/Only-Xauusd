/**
 * Phase 14, Task 34-g — A10 Confluence Master + scalper integration tests.
 *
 * The golden-path fixture is the PROBE-VERIFIED ICT sequence (probe:
 * scripts/phase14-smc-fixture-probe.ts — same builder, same numbers):
 * 7 net-flat range cycles (EQH 2658.5 / EQL 2649.5 form) → EQL stop-hunt
 * sweep reclaimed → 3-candle bullish displacement (BOS above 2658.5,
 * BULLISH_FVG [2657.5, 2660.5] + BULLISH_OB [2647.5, 2655.5] born) → retrace
 * → bullish rejection-wick decision bar at the FVG inside the London
 * killzone. Verified verdict: BUY, score 78, tier A, zero vetoes.
 */

import { describe, expect, test } from 'bun:test';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { evaluateSmcConfluence, tierForScore } from '@/lib/signal/ict/confluence';
import { defaultSmcSessionConfig } from '@/lib/signal/ict/sessions';
import type { SmcAgentParams } from '@/lib/signal/ict/types';
import { evaluateScalper, scalperSetupFingerprint, suppressSetup } from '@/lib/signal/scalper/core';
import { buildScalperRules } from '@/lib/signal/scalper/rules';
import type { ScalperCoreInput, ScalperRules } from '@/lib/signal/scalper/types';
import type { SignalWindow } from '@/lib/signal/types';

// ---------------------------------------------------------------------------
// The verified fixture
// ---------------------------------------------------------------------------

/** 68-candle M5 grid; decision bar (idx 67) closes 08:00 UTC Wed 2025-01-15. */
const T0 = Date.UTC(2025, 0, 15, 6, 15) / 1000 - 56 * 300;

function buildSeries(): AnalysisCandle[] {
  const rows: Array<[number, number, number, number]> = [];
  let base = 2650.0;
  for (let cycle = 0; cycle < 7; cycle++) {
    for (let k = 0; k < 4; k++) {
      rows.push([base, base + 2.5, base - 0.5, base + 2.0]); // up (span 3)
      base += 2.0;
    }
    for (let k = 0; k < 4; k++) {
      rows.push([base, base + 0.5, base - 2.5, base - 2.0]); // dn (span 3)
      base -= 2.0;
    }
  }
  rows.push(
    [2650.0, 2652.5, 2649.5, 2652.0], // 56 up
    [2652.0, 2654.5, 2651.5, 2654.0], // 57 up
    [2654.0, 2656.5, 2653.5, 2656.0], // 58 up
    [2656.0, 2656.5, 2651.5, 2654.0], // 59 dn
    [2654.0, 2657.0, 2653.5, 2655.5], // 60 up (small)
    [2655.5, 2656.0, 2651.5, 2653.5], // 61 dn (small)
    [2653.5, 2654.0, 2647.5, 2653.0], // 62 SWEEP: pierces EQL 2649.5, closes above
    [2653.0, 2657.5, 2652.5, 2657.0], // 63 DISP up (body 4)
    [2657.0, 2661.5, 2656.5, 2661.0], // 64 DISP up (body 4) — BOS > 2658.5
    [2661.0, 2665.5, 2660.5, 2665.0], // 65 DISP up (body 4) — FVG [2657.5, 2660.5]
    [2665.0, 2665.5, 2660.5, 2661.0], // 66 RETR dn (body 4)
    [2661.0, 2662.1, 2659.6, 2661.6], // 67 DECISION: bullish rejection-wick pin
  );
  return rows.map(([o, h, l, c], i) => ({
    timeUtcSec: T0 + i * 300,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: null,
    openText: String(o),
    highText: String(h),
    lowText: String(l),
    closeText: String(c),
  }));
}

const PARAMS: SmcAgentParams = {
  swingLeft: 3,
  swingRight: 3,
  maxBarsSinceEvent: 20,
  sweepLookbackBars: 30,
  maxBarsSinceSweep: 8,
  equalLevelAtrTol: 0.25,
  obMinDisplacementAtr: 1.0,
  fvgMinGapAtr: 0.2,
  entryToleranceAtr: 0.35,
  slAtrBuffer: 0.35,
  poiMaxTests: 3,
  session: defaultSmcSessionConfig(),
  displacementAtr: 1.0,
  amdLookbackBars: 40,
  amdMinRangeAtr: 2.0,
  minScore: 55,
  directionMargin: 10,
  roundNumberStep: 5,
  keyLevelTolAtr: 0.3,
};

const PERIODS = { emaFastPeriod: 9, emaSlowPeriod: 21, rsiPeriod: 14, atrPeriod: 14 };

/** 08:15 UTC Wed — London killzone, outside every news envelope. */
const NOW_KZ = T0 + 68 * 300;

function confluenceAt(nowUtcSec: number) {
  return evaluateSmcConfluence({
    candles: buildSeries(),
    tfSec: 300,
    digits: 2,
    nowUtcSec,
    params: PARAMS,
    indicatorPeriods: PERIODS,
    newsBlackoutEnabled: true,
  });
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

describe('tierForScore', () => {
  test('A ≥ 75, B ≥ 55, C ≥ 40, null below', () => {
    expect(tierForScore(100)).toBe('A');
    expect(tierForScore(75)).toBe('A');
    expect(tierForScore(74.9)).toBe('B');
    expect(tierForScore(55)).toBe('B');
    expect(tierForScore(54.9)).toBe('C');
    expect(tierForScore(40)).toBe('C');
    expect(tierForScore(39.9)).toBeNull();
    expect(tierForScore(0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The golden path — full ICT recipe in one verified series
// ---------------------------------------------------------------------------

describe('A10 Confluence Master — golden path', () => {
  const result = confluenceAt(NOW_KZ);
  const e = result.evidence;

  test('verdict: BUY, 78 points, tier A, actionable, zero vetoes', () => {
    expect(e.direction).toBe('BUY');
    expect(e.totalScore).toBe(78);
    expect(e.tier).toBe('A');
    expect(e.vetoes).toEqual([]);
    expect(result.actionable).toBe(true);
    expect(result.summary.direction).toBe('BUY');
    expect(result.summary.score).toBe(78);
  });

  test('all eight agents voted, weights sum to 100, awarded points are exact', () => {
    expect(e.votes).toHaveLength(8);
    expect(e.votes.reduce((s, v) => s + v.weight, 0)).toBe(100);
    const byAgent = new Map(e.votes.map((v) => [v.agent, v.score] as const));
    expect(byAgent.get('STRUCTURE')).toBe(15); // BOS bullish 3 bars ago
    expect(byAgent.get('LIQUIDITY')).toBe(20); // EQL swept 5 bars ago, reclaimed
    expect(byAgent.get('POI')).toBe(12); // at the mitigated BULLISH_FVG
    expect(byAgent.get('KEY_LEVELS')).toBe(5); // round 2665 close but no wall
    expect(byAgent.get('PRICE_ACTION')).toBe(8); // rejection wick on the decision bar
    expect(byAgent.get('MOMENTUM')).toBe(10); // momentum 51 aligned
    expect(byAgent.get('SESSION')).toBe(5); // London killzone
    expect(byAgent.get('AMD')).toBe(3); // distribution + directional structure
  });

  test('evidence carries the institutional reads (EQL sweep, FVG+OB zones, SUPPLY/DEMAND)', () => {
    expect(e.liquidity.sweeps[0]?.direction).toBe('BULLISH');
    expect(e.liquidity.sweeps[0]?.origin).toBe('EQL');
    expect(e.liquidity.sweeps[0]?.levelText).toBe('2649.50');
    expect(e.poi.nearestBullish?.kind).toBe('BULLISH_FVG');
    expect(e.poi.nearestBullish?.bottomText).toBe('2657.50');
    expect(e.poi.nearestBullish?.topText).toBe('2660.50');
    expect(e.poi.zones.some((z) => z.kind === 'BULLISH_OB' && z.bottomText === '2647.50' && z.fresh)).toBe(true);
    expect(e.keyLevels.levels.some((l) => l.kind === 'SUPPLY' && l.levelText === '2658.50')).toBe(true);
    expect(e.keyLevels.levels.some((l) => l.kind === 'DEMAND' && l.levelText === '2649.50')).toBe(true);
    expect(e.structure.lastEvent?.type).toBe('BOS');
    expect(e.structure.lastEvent?.direction).toBe('bullish');
    expect(e.priceAction.decisionPattern?.kind).toBe('BULLISH_REJECTION_WICK');
    expect(e.session.killzone).toBe('LONDON_KZ');
  });

  test('top reasons: the three strongest agreeing agents, strongest first', () => {
    expect(result.summary.topReasons).toHaveLength(3);
    expect(result.summary.topReasons[0]).toContain('liquidity swept');
  });

  test('determinism — identical input, identical verdict', () => {
    expect(confluenceAt(NOW_KZ)).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// Hard vetoes
// ---------------------------------------------------------------------------

describe('A10 Confluence Master — news blackout veto', () => {
  test('the same setup at 13:00 UTC is NOT actionable (NEWS_BLACKOUT)', () => {
    const r = confluenceAt(Date.UTC(2025, 0, 15, 13, 0) / 1000);
    expect(r.evidence.direction).toBe('BUY');
    expect(r.evidence.totalScore).toBe(78);
    expect(r.evidence.vetoes).toContain('NEWS_BLACKOUT');
    expect(r.actionable).toBe(false);
  });

  test('blackout disabled via config — no veto', () => {
    const params = { ...PARAMS, session: { ...PARAMS.session, newsWindows: [] } };
    const r = evaluateSmcConfluence({
      candles: buildSeries(),
      tfSec: 300,
      digits: 2,
      nowUtcSec: Date.UTC(2025, 0, 15, 13, 0) / 1000,
      params,
      indicatorPeriods: PERIODS,
      newsBlackoutEnabled: true,
    });
    expect(r.evidence.vetoes).toEqual([]);
    expect(r.actionable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scalper integration (engine v13) — the SMC_CONFLUENCE model end-to-end
// ---------------------------------------------------------------------------

function windowOf(candles: AnalysisCandle[], timeframe: 'M15' | 'M5' | 'M1'): SignalWindow {
  return { timeframe, candles, source: 'bridge-mt5' };
}

function coreInput(nowUtcSec: number, rules: ScalperRules): ScalperCoreInput {
  const candles = buildSeries();
  return {
    symbol: 'XAUUSDm',
    digits: 2,
    m15: windowOf(candles, 'M15'),
    m5: windowOf(candles, 'M5'),
    m1: windowOf(candles, 'M1'),
    // Task 36 — empty HTF windows: trend reads null, the veto never fires.
    h1: { timeframe: 'H1', candles: [], source: 'bridge-mt5' },
    h4: { timeframe: 'H4', candles: [], source: 'bridge-mt5' },
    referencePrice: candles[candles.length - 1].close,
    spreadPrice: 0.3,
    nowUtcSec,
    rules,
  };
}

/** 08:45 UTC — late enough that the decision bar counts as closed on M15 too. */
const NOW_SCALPER = T0 + 67 * 300 + 900;

describe('scalper v13 — SMC_CONFLUENCE setup emission', () => {
  const rules = buildScalperRules();
  const evaluation = evaluateScalper(coreInput(NOW_SCALPER, rules));

  test('BUY_SETUP emitted by the SMC_CONFLUENCE model from M15 (priority TF)', () => {
    expect(evaluation.outcome).toBe('BUY_SETUP');
    expect(evaluation.reasonCodes).toEqual([]);
    expect(evaluation.evidence?.scalper?.model).toBe('SMC_CONFLUENCE');
    expect(evaluation.evidence?.scalper?.sourceTimeframe).toBe('M15');
    expect(evaluation.evidence?.scalper?.tfJudgements[0]?.stage).toBe('SMC_BUY');
  });

  test('levels derived from the ICT reads: entry zone = the FVG, SL beyond the sweep wick', () => {
    const lv = evaluation.levels;
    expect(lv).not.toBeNull();
    if (!lv) return;
    expect(lv.direction).toBe('BUY');
    expect(lv.entryZoneLowText).toBe('2657.50'); // FVG bottom
    expect(lv.entryZoneHighText).toBe('2660.50'); // FVG top
    expect(lv.stopLoss).toBeLessThan(2647.5); // below the sweep wick low
    expect(lv.stopLoss < lv.entryReference && lv.entryReference < lv.target).toBe(true);
    expect(lv.rewardRiskRatio).toBeCloseTo(1.2, 6); // fixed-RR cap (Task 37: reachable first target; no opposing pool above)
  });

  test('full SMC evidence attached: verdict, EQL sweep, FVG POI, eight votes', () => {
    const smc = evaluation.evidence?.smc;
    expect(smc).toBeDefined();
    if (!smc) return;
    expect(smc.direction).toBe('BUY');
    expect(smc.totalScore).toBe(78);
    expect(smc.tier).toBe('A');
    expect(smc.votes).toHaveLength(8);
    expect(smc.liquidity.sweeps[0]?.origin).toBe('EQL');
    expect(smc.poi.nearestBullish?.kind).toBe('BULLISH_FVG');
  });

  test('per-TF smc chips on all three judgements (score/tier/direction)', () => {
    for (const j of evaluation.evidence?.scalper?.tfJudgements ?? []) {
      expect(j.smc).toBeDefined();
      expect(j.smc?.score).toBe(78);
      expect(j.smc?.tier).toBe('A');
      expect(j.smc?.direction).toBe('BUY');
    }
  });

  test('setup fingerprint is model-aware (SMC_CONFLUENCE identity)', () => {
    const fp = scalperSetupFingerprint('XAUUSDm', 'M15', 'SMC_CONFLUENCE', 'BUY', T0 + 67 * 300);
    expect(fp).toHaveLength(64);
    expect(fp).not.toBe(scalperSetupFingerprint('XAUUSDm', 'M15', 'MOMENTUM', 'BUY', T0 + 67 * 300));
  });

  test('suppression turns the SMC setup into an honest WAIT with the reason code', () => {
    const suppressed = suppressSetup(evaluation, { duplicate: true, cooldownActive: false });
    expect(suppressed.outcome).toBe('WAIT');
    expect(suppressed.reasonCodes).toContain('SCALPER_DUPLICATE_SETUP');
    expect(suppressed.levels).toBeNull();
    expect(suppressed.evidence?.smc?.direction).toBe('BUY'); // evidence survives
  });
});

describe('scalper v13 — news blackout gates every model', () => {
  // Task 38: momentum pinned ON — these tests pin the legacy-fallback
  // mechanics and must not depend on the production kill-switch posture.
  const rules: ScalperRules = {
    ...buildScalperRules(),
    momentumEnabled: true,
    momentumSourceTfOnly: null,
  };

  test('the golden series at 13:00 UTC → NO_SETUP, SMC veto visible, no legacy fallback', () => {
    const evaluation = evaluateScalper(coreInput(Date.UTC(2025, 0, 15, 13, 0) / 1000 + 300, rules));
    expect(evaluation.outcome).toBe('NO_SETUP');
    expect(evaluation.reasonCodes).toContain('SCALPER_NO_AGREE');
    expect(evaluation.evidence?.smc?.vetoes).toContain('NEWS_BLACKOUT');
    // No judgement agreed — the blackout silenced momentum/reversal too.
    for (const j of evaluation.evidence?.scalper?.tfJudgements ?? []) {
      expect(j.agree).toBeNull();
    }
  });

  test('SMC layer disabled → no smc chips, no smc evidence, legacy models judge alone', () => {
    // Legacy-mode rules: the pinned fallback cadence (momentum model) predates
    // the Task-36 chase guard — disable it so this test keeps pinning what it
    // was written to pin (the guard has its own tests in scalper-core.test.ts).
    const disabled: ScalperRules = {
      ...rules,
      smc: { ...rules.smc, enabled: false },
      maxExtensionAtr: 0,
    };
    const evaluation = evaluateScalper(coreInput(NOW_SCALPER, disabled));
    for (const j of evaluation.evidence?.scalper?.tfJudgements ?? []) {
      expect(j.smc).toBeUndefined();
    }
    expect(evaluation.evidence?.smc).toBeUndefined();
    // The golden series also satisfies the legacy momentum model (EMA aligned,
    // RSI 59 in band) — the fallback keeps the cadence honest.
    expect(evaluation.outcome).toBe('BUY_SETUP');
    expect(evaluation.evidence?.scalper?.model).toBe('MOMENTUM');
  });
});
