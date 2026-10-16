/**
 * PHASE 11 CONDITION-CHECKLIST TESTS (test-first, dashboard observability).
 * ----------------------------------------------------------------------------
 * The checklist is DERIVED AT READ TIME from a persisted evaluation (or its
 * absence) — the engine core (protocol-frozen core.ts) is never touched.
 *
 * Semantics: the engine evaluates its stages IN ORDER and stops at the first
 * failure, so checks DOWNSTREAM of a failed strategy stage are reported as
 * null (পর্যায়ে পৌঁছায়নি) — never as fake passes. Data-quality checks are
 * always derivable from the reason codes. BLOCKED evaluations never blame
 * the strategy (strategy checks null, category data-quality).
 */

import { describe, expect, test } from 'bun:test';
import '../market/helpers/setup';
import { deriveConditionReport } from '@/lib/signal/conditions';
import type { SignalEvaluation } from '@/lib/signal/types';

function evalOf(partial: Partial<SignalEvaluation>): SignalEvaluation {
  return {
    engineVersion: '9.0.0',
    strategyVersion: 'hybrid-structure-retest/9.0.0',
    symbol: 'XAUUSDm',
    purpose: 'research-signal-not-an-execution-instruction',
    outcome: 'WAIT',
    reasonCodes: [],
    decisionCandleTimeUtc: '2026-10-16T12:00:00Z',
    setupKnownAtUtc: '2026-10-16T12:15:00Z',
    expiryUtc: null,
    levels: null,
    evidence: {
      structureEvent: {
        type: 'BOS', direction: 'bearish', level: 4144.821, levelText: '4144.821',
        breakCandleTimeUtc: '2026-10-16T16:00:00Z', barsSinceBreak: 3,
      },
      anchorSwing: null,
      indicators: { ema50: 4148.2, rsi14: 43.1, atr14: 3.9, adx14: 21.4 },
      htfContext: { h1Trend: 'bearish', h4Trend: 'unclear' },
      decisionClose: 4143.9,
      retestBarTimeUtc: '2026-10-16T16:45:00Z',
      executionWindow: { fromUtc: '2026-10-16T06:30:00Z', toUtc: '2026-10-16T16:00:00Z', bars: 300 },
      h1Window: { fromUtc: '2026-10-15T02:00:00Z', toUtc: '2026-10-16T15:00:00Z', bars: 300 },
      h4Window: { fromUtc: '2026-10-11T04:00:00Z', toUtc: '2026-10-16T12:00:00Z', bars: 290 },
    },
    inputFingerprint: 'x'.repeat(64),
    datasetFingerprint: 'y'.repeat(64),
    generatedAtUtc: '2026-10-16T16:23:00Z',
    ...partial,
  };
}

describe('condition checklist derivation', () => {
  test('no evaluation at all → source none, zero checks, honest headline (never a strategy failure)', () => {
    const r = deriveConditionReport(null);
    expect(r.source).toBe('none');
    expect(r.checks).toEqual([]);
    expect(r.category).toBeNull();
    expect(r.headlineBn.length).toBeGreaterThan(0);
  });

  test('WAIT [RETEST_PENDING]: strategy-logic category; retest failed; structure+zone passed with detail; downstream checks null (not evaluated)', () => {
    const ev = evalOf({ outcome: 'WAIT', reasonCodes: ['RETEST_PENDING'] });
    ev.evidence!.retestBarTimeUtc = null;
    const r = deriveConditionReport(ev);
    expect(r.source).toBe('evaluation');
    expect(r.category).toBe('strategy-logic');
    expect(r.checks.find((c) => c.id === 'retest')?.passed).toBe(false);
    const structure = r.checks.find((c) => c.id === 'structure');
    expect(structure?.passed).toBe(true);
    expect(structure?.detailBn).toContain('BOS');
    expect(r.checks.find((c) => c.id === 'zone')?.passed).toBe(true);
    // downstream of the failed stage: honestly not evaluated
    expect(r.checks.find((c) => c.id === 'spread')?.passed).toBeNull();
    expect(r.checks.find((c) => c.id === 'htf')?.passed).toBeNull();
    expect(r.checks.find((c) => c.id === 'indicators')?.passed).toBeNull();
    expect(r.checks.find((c) => c.id === 'proximity')?.passed).toBeNull();
    expect(r.checks.find((c) => c.id === 'levels')?.passed).toBeNull();
  });

  test('BLOCKED [TICK_STALE]: data-quality category; data check fails; strategy checks are null (not evaluated)', () => {
    const r = deriveConditionReport(
      evalOf({ outcome: 'BLOCKED', reasonCodes: ['TICK_STALE' as never, 'DATA_STALE'], evidence: null, decisionCandleTimeUtc: null, setupKnownAtUtc: null }),
    );
    expect(r.category).toBe('data-quality');
    const dataChecks = r.checks.filter((c) => c.category === 'data-quality');
    expect(dataChecks.length).toBeGreaterThan(0);
    expect(dataChecks.some((c) => c.passed === false)).toBe(true);
    const strategyChecks = r.checks.filter((c) => c.category === 'strategy-logic');
    expect(strategyChecks.length).toBeGreaterThan(0);
    for (const c of strategyChecks) expect(c.passed).toBeNull();
  });

  test('NO_SETUP [NO_STRUCTURE_BREAK]: strategy-logic; structure check failed; everything downstream null', () => {
    const r = deriveConditionReport(
      evalOf({ outcome: 'NO_SETUP', reasonCodes: ['NO_STRUCTURE_BREAK'], evidence: { ...evalOf({}).evidence!, structureEvent: null, retestBarTimeUtc: null } }),
    );
    expect(r.category).toBe('strategy-logic');
    expect(r.checks.find((c) => c.id === 'structure')?.passed).toBe(false);
    expect(r.checks.find((c) => c.id === 'zone')?.passed).toBeNull();
  });

  test('NO_SETUP [STRUCTURE_BREAK_TOO_OLD]: structure check failed (stale event), detail explains staleness', () => {
    const r = deriveConditionReport(evalOf({ outcome: 'NO_SETUP', reasonCodes: ['STRUCTURE_BREAK_TOO_OLD'] }));
    const structure = r.checks.find((c) => c.id === 'structure');
    expect(structure?.passed).toBe(false);
    expect(structure?.detailBn).toContain('পুরোনো');
  });

  test('NO_SETUP [ZONE_INVALIDATED]: structure passed, zone failed', () => {
    const r = deriveConditionReport(evalOf({ outcome: 'NO_SETUP', reasonCodes: ['ZONE_INVALIDATED'] }));
    expect(r.checks.find((c) => c.id === 'structure')?.passed).toBe(true);
    expect(r.checks.find((c) => c.id === 'zone')?.passed).toBe(false);
    expect(r.checks.find((c) => c.id === 'retest')?.passed).toBeNull();
  });

  test('BUY_SETUP: every strategy check passed, category strategy-logic, levels check true', () => {
    const r = deriveConditionReport(
      evalOf({
        outcome: 'BUY_SETUP',
        reasonCodes: [],
        levels: {
          direction: 'BUY', entryZoneLow: 4140, entryZoneHigh: 4142, entryReference: 4141.2,
          stopLoss: 4135.5, target: 4150.2, riskPrice: 5.7, rewardPrice: 9.0, rewardRiskRatio: 2,
          entryZoneLowText: '4140.000', entryZoneHighText: '4142.000', stopLossText: '4135.500',
          targetText: '4150.200', entryReferenceText: '4141.200',
        },
        evidence: { ...evalOf({}).evidence!, anchorSwing: { kind: 'low', price: 4138, priceText: '4138.000', swingTimeUtc: '2026-10-16T14:00:00Z', confirmedAtUtc: '2026-10-16T14:45:00Z' } },
      }),
    );
    expect(r.category).toBe('strategy-logic');
    for (const c of r.checks) {
      if (c.category === 'strategy-logic') expect(c.passed).toBe(true);
    }
    expect(r.checks.find((c) => c.id === 'levels')?.passed).toBe(true);
  });

  test('indicator check fails on ADX_BELOW_MIN (retest had passed) and reports the observed values', () => {
    const r = deriveConditionReport(evalOf({ outcome: 'WAIT', reasonCodes: ['ADX_BELOW_MIN'] }));
    const ind = r.checks.find((c) => c.id === 'indicators');
    expect(ind?.passed).toBe(false);
    expect(ind?.detailBn).toContain('21.4'); // the observed ADX value is in the detail
    expect(r.checks.find((c) => c.id === 'retest')?.passed).toBe(true);
  });

  test('HTF check fails on HTF_H4_OPPOSITE and reports both trend states', () => {
    const r = deriveConditionReport(evalOf({ outcome: 'WAIT', reasonCodes: ['HTF_H4_OPPOSITE'] }));
    const htf = r.checks.find((c) => c.id === 'htf');
    expect(htf?.passed).toBe(false);
    expect(htf?.detailBn).toContain('বিয়ারিশ');
    expect(r.checks.find((c) => c.id === 'spread')?.passed).toBe(true); // upstream passed
  });

  test('every baseline reason code maps to exactly one failed check (coverage matrix)', () => {
    const codeToCheck: Array<[string, string]> = [
      ['SPEC_MISSING', 'spec'], ['DATA_INVALID', 'windows'], ['INSUFFICIENT_DATA', 'windows'],
      ['INSUFFICIENT_H1_HISTORY', 'windows'], ['INSUFFICIENT_H4_HISTORY', 'windows'],
      ['CHRONOLOGY_BROKEN', 'windows'], ['FORMING_CANDLE_IN_INPUT', 'windows'], ['SOURCE_DEMO', 'windows'],
      ['INDICATOR_WARMUP', 'windows'], ['GAP_IN_WINDOW', 'windows'], ['QUOTE_STALE', 'quote'],
      ['QUOTE_UNAVAILABLE', 'quote'], ['TICK_STALE', 'quote'], ['TICK_INVALID', 'quote'],
      ['NOT_AUTHENTICATED', 'quote'], ['SPREAD_INVALID', 'quote'],
      ['NO_STRUCTURE_BREAK', 'structure'], ['STRUCTURE_BREAK_TOO_OLD', 'structure'],
      ['ZONE_INVALIDATED', 'zone'], ['RETEST_PENDING', 'retest'], ['SPREAD_TOO_WIDE', 'spread'],
      ['HTF_H1_OPPOSITE', 'htf'], ['HTF_H4_OPPOSITE', 'htf'], ['EMA_TREND_OPPOSITE', 'indicators'],
      ['RSI_OUT_OF_RANGE', 'indicators'], ['ADX_BELOW_MIN', 'indicators'],
      ['PRICE_BEYOND_ENTRY_ZONE', 'proximity'], ['NO_ANCHOR_SWING', 'levels'], ['LEVEL_CALC_INVALID', 'levels'],
    ];
    for (const [code, checkId] of codeToCheck) {
      const ev = evalOf({ outcome: 'WAIT', reasonCodes: [code as never] });
      if (code === 'RETEST_PENDING') ev.evidence!.retestBarTimeUtc = null;
      if (code === 'NO_STRUCTURE_BREAK') ev.evidence = { ...ev.evidence!, structureEvent: null, retestBarTimeUtc: null };
      const r = deriveConditionReport(ev);
      const check = r.checks.find((c) => c.id === checkId);
      expect(`${code} → ${checkId}`).toBeTruthy();
      expect(check).toBeDefined();
      expect(check?.passed).toBe(false);
    }
  });

  test('derivation is pure: repeated calls return identical results', () => {
    const e = evalOf({ outcome: 'WAIT', reasonCodes: ['RETEST_PENDING'] });
    expect(JSON.stringify(deriveConditionReport(e))).toBe(JSON.stringify(deriveConditionReport(e)));
  });
});
