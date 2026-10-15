/**
 * PHASE 10.2 FORWARD PAPER PROTOCOL TESTS (PURE RULES).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: purely synthetic rows/numbers exercising the
 * PRE-REGISTERED protocol rules — no database, no bridge, never real broker
 * data. These tests pin the rules so they cannot silently drift after
 * outcomes start accumulating.
 *
 * Pins:
 *   · first-open rule: repeat observations of an open counted trade are
 *     NEVER independent trades; a new counted trade opens only after the
 *     previous one resolved
 *   · still-open counted trade blocks everything after it
 *   · chronological ordering incl. id tie-break
 *   · metrics conventions identical to the Phase 10 harness (PF, drawdown,
 *     consecutive losses, top-1 concentration, by-direction)
 *   · unobservable (null P/L) rows never enter metrics
 *   · all six verdict branches + deadline arithmetic
 */

import { describe, expect, test } from 'bun:test';
import {
  FORWARD_PAPER_ACTIVATED_AT_ISO,
  FORWARD_PAPER_MAX_CONSECUTIVE_LOSSES,
  FORWARD_PAPER_MAX_DRAWDOWN_R,
  FORWARD_PAPER_MAX_TOP1_NET_SHARE,
  FORWARD_PAPER_MIN_COMPLETED_TRADES,
  FORWARD_PAPER_OBSERVATION_WINDOW_DAYS,
  FORWARD_PAPER_RULES_VERSION,
  applyFirstOpenRule,
  computeForwardPaperMetrics,
  evaluateForwardPaperVerdict,
  forwardPaperActivatedMs,
  forwardPaperDeadlineMs,
  type ForwardPaperRowInput,
} from '@/lib/signal/paper-protocol';

const DAY = 86_400_000;
const T0 = forwardPaperActivatedMs();

/** Synthetic counted-trade-shaped row (times relative to protocol T0). */
function row(over: Partial<ForwardPaperRowInput> & { id: string }): ForwardPaperRowInput {
  return {
    direction: 'BUY',
    signalCreatedAtMs: T0 + DAY,
    status: 'resolved',
    outcome: 'stopped',
    netPnlPrice: -1.5,
    rMultiple: -1.0,
    resolutionBarTimeMs: T0 + DAY + 3_600_000,
    resolvedAtMs: T0 + DAY + 3_600_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// First-open rule
// ---------------------------------------------------------------------------

describe('applyFirstOpenRule — pre-registered one-position model', () => {
  test('repeat observation while the counted trade is open → NOT a new trade', () => {
    const a = row({ id: 'a', signalCreatedAtMs: T0 + 60_000, resolutionBarTimeMs: T0 + 3_600_000 });
    const b = row({ id: 'b', signalCreatedAtMs: T0 + 120_000 }); // 2 min later, a still live
    const c = row({ id: 'c', signalCreatedAtMs: T0 + 180_000 }); // still live
    const { counted, repeats } = applyFirstOpenRule([a, b, c]);
    expect(counted.map((t) => t.id)).toEqual(['a']);
    expect(repeats.map((t) => t.id)).toEqual(['b', 'c']);
  });

  test('setup AFTER the resolution → new counted trade', () => {
    const a = row({ id: 'a', signalCreatedAtMs: T0 + 60_000, resolutionBarTimeMs: T0 + 3_600_000 });
    const b = row({ id: 'b', signalCreatedAtMs: T0 + 3_600_001 }); // one ms after a resolved
    const { counted, repeats } = applyFirstOpenRule([a, b]);
    expect(counted.map((t) => t.id)).toEqual(['a', 'b']);
    expect(repeats).toHaveLength(0);
  });

  test('setup exactly AT the resolution time → still a repeat (≥ boundary)', () => {
    const a = row({ id: 'a', signalCreatedAtMs: T0 + 60_000, resolutionBarTimeMs: T0 + 3_600_000 });
    const b = row({ id: 'b', signalCreatedAtMs: T0 + 3_600_000 });
    const { counted, repeats } = applyFirstOpenRule([a, b]);
    expect(counted.map((t) => t.id)).toEqual(['a']);
    expect(repeats.map((t) => t.id)).toEqual(['b']);
  });

  test('a still-OPEN counted trade blocks every later row', () => {
    const a = row({ id: 'a', status: 'open', outcome: null, netPnlPrice: null, rMultiple: null, resolutionBarTimeMs: null, resolvedAtMs: null });
    const b = row({ id: 'b', signalCreatedAtMs: a.signalCreatedAtMs + DAY });
    const c = row({ id: 'c', signalCreatedAtMs: a.signalCreatedAtMs + 5 * DAY });
    const { counted, repeats } = applyFirstOpenRule([a, b, c]);
    expect(counted.map((t) => t.id)).toEqual(['a']);
    expect(repeats.map((t) => t.id)).toEqual(['b', 'c']);
  });

  test('unsorted input is ordered chronologically (id tie-break)', () => {
    const a1 = row({ id: 'a1', signalCreatedAtMs: T0 + 60_000, resolutionBarTimeMs: T0 + 3_600_000 });
    const a2 = row({ id: 'a2', signalCreatedAtMs: T0 + 60_000, resolutionBarTimeMs: T0 + 3_600_000 }); // same ms → tie
    const b = row({ id: 'b', signalCreatedAtMs: T0 + 3_600_001 });
    const { counted, repeats } = applyFirstOpenRule([b, a2, a1]); // deliberately shuffled
    expect(counted.map((t) => t.id)).toEqual(['a1', 'b']); // a1 wins the tie
    expect(repeats.map((t) => t.id)).toEqual(['a2']);
  });

  test('resolution falls back to resolvedAtMs when resolutionBarTimeMs is null', () => {
    const a = row({ id: 'a', signalCreatedAtMs: T0 + 60_000, resolutionBarTimeMs: null, resolvedAtMs: T0 + 7_200_000 });
    const b = row({ id: 'b', signalCreatedAtMs: T0 + 7_199_999 }); // 1 ms before a's fallback end
    const { counted, repeats } = applyFirstOpenRule([a, b]);
    expect(counted.map((t) => t.id)).toEqual(['a']);
    expect(repeats.map((t) => t.id)).toEqual(['b']);
  });

  test('empty input → empty counting', () => {
    const { counted, repeats } = applyFirstOpenRule([]);
    expect(counted).toHaveLength(0);
    expect(repeats).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Metrics (Phase 10 harness conventions)
// ---------------------------------------------------------------------------

describe('computeForwardPaperMetrics — conventions pinned to Phase 10', () => {
  test('known set: net, PF, avgR, drawdown, consecutive losses, top-1 share, by-direction', () => {
    // R sequence: +2, -1, -1, -1, +2  → net +1, PF 4/3, avgR +0.2
    // cumulative R: 2, 1, 0, -1, 1  → drawdown 3 (peak 2 → trough -1)
    // consecutive losses: 3
    // net wins: 2 winners; price nets: +6, -3, -3, -3, +6 → top1 share 6/12 = 0.5
    const trades: ForwardPaperRowInput[] = [
      row({ id: '1', direction: 'BUY', netPnlPrice: 6, rMultiple: 2, outcome: 'targeted' }),
      row({ id: '2', direction: 'SELL', netPnlPrice: -3, rMultiple: -1 }),
      row({ id: '3', direction: 'BUY', netPnlPrice: -3, rMultiple: -1 }),
      row({ id: '4', direction: 'SELL', netPnlPrice: -3, rMultiple: -1 }),
      row({ id: '5', direction: 'BUY', netPnlPrice: 6, rMultiple: 2, outcome: 'targeted' }),
    ];
    const m = computeForwardPaperMetrics(trades);
    expect(m).not.toBeNull();
    expect(m!.trades).toBe(5);
    expect(m!.wins).toBe(2);
    expect(m!.losses).toBe(3);
    expect(m!.winRate).toBe(0.4);
    expect(m!.netPnlPrice).toBe(3);
    expect(m!.grossWinPrice).toBe(12);
    expect(m!.grossLossPrice).toBe(9);
    expect(m!.profitFactor).toBe(Number((12 / 9).toFixed(4)));
    expect(m!.sumR).toBe(1);
    expect(m!.avgR).toBe(0.2);
    expect(m!.maxDrawdownR).toBe(3);
    expect(m!.maxConsecutiveLosses).toBe(3);
    expect(m!.top1NetShare).toBe(0.5);
    expect(m!.byDirection.BUY).toEqual({ trades: 3, wins: 2, netPnlPrice: 9 });
    expect(m!.byDirection.SELL).toEqual({ trades: 2, wins: 0, netPnlPrice: -6 });
  });

  test('open rows and null-P/L (unobservable) rows are EXCLUDED', () => {
    const trades: ForwardPaperRowInput[] = [
      row({ id: '1', netPnlPrice: 6, rMultiple: 2 }),
      row({ id: '2', status: 'open', outcome: null, netPnlPrice: null, rMultiple: null, resolutionBarTimeMs: null, resolvedAtMs: null }),
      row({ id: '3', status: 'resolved', outcome: 'expired', netPnlPrice: null, rMultiple: null, resolutionBarTimeMs: null, resolvedAtMs: T0 + 10 * DAY }),
    ];
    const m = computeForwardPaperMetrics(trades);
    expect(m!.trades).toBe(1);
    expect(m!.netPnlPrice).toBe(6);
  });

  test('no completed trades → null (metrics are never invented)', () => {
    expect(computeForwardPaperMetrics([])).toBeNull();
    expect(
      computeForwardPaperMetrics([row({ id: 'x', status: 'open', outcome: null, netPnlPrice: null, rMultiple: null })]),
    ).toBeNull();
  });

  test('no losses → PF null (division never fabricated), top-1 share 1.0 for a single winner', () => {
    const m = computeForwardPaperMetrics([row({ id: '1', netPnlPrice: 5, rMultiple: 2, outcome: 'targeted' })]);
    expect(m!.profitFactor).toBeNull();
    expect(m!.top1NetShare).toBe(1);
    expect(m!.maxConsecutiveLosses).toBe(0);
    expect(m!.maxDrawdownR).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Verdict — ordered pre-registered branches
// ---------------------------------------------------------------------------

describe('evaluateForwardPaperVerdict — ordered pre-registered branches', () => {
  const base = {
    openCounted: 0,
    repeatObservations: 0,
    unobservableResolved: 0,
  };

  test('below floor, before deadline → IN_PROGRESS with honest no-claim reason', () => {
    const v = evaluateForwardPaperVerdict({
      ...base,
      countedCompleted: 3,
      metrics: null,
      nowMs: T0 + 10 * DAY,
    });
    expect(v.conclusion).toBe('IN_PROGRESS');
    expect(v.rulesVersion).toBe(FORWARD_PAPER_RULES_VERSION);
    expect(v.reasons.join(' ')).toContain('3/20');
    expect(v.reasons.join(' ')).toContain('No performance claim');
    expect(v.disclaimer).toContain('NOT a profitability claim');
  });

  test('below floor, past deadline → INCONCLUSIVE_TIMEOUT with user-decision next step', () => {
    const v = evaluateForwardPaperVerdict({
      ...base,
      countedCompleted: 11,
      metrics: null,
      nowMs: forwardPaperDeadlineMs() + 1,
    });
    expect(v.conclusion).toBe('INCONCLUSIVE_TIMEOUT');
    expect(v.reasons.join(' ')).toContain('user decision');
  });

  test('at floor with net ≤ 0 → NEGATIVE_AFTER_COSTS (even at exactly 0)', () => {
    const m = computeForwardPaperMetrics(
      Array.from({ length: FORWARD_PAPER_MIN_COMPLETED_TRADES }, (_, i) =>
        row({ id: String(i), netPnlPrice: -1.5, rMultiple: -1 }),
      ),
    );
    const v = evaluateForwardPaperVerdict({ ...base, countedCompleted: 20, metrics: m, nowMs: T0 + 30 * DAY });
    expect(v.conclusion).toBe('NEGATIVE_AFTER_COSTS');
  });

  test('net > 0 but top-1 share > 35% → INCONCLUSIVE_CONCENTRATION', () => {
    // 20 winners of +0.1 each and… make ONE huge winner: 19 × +0.1 + 1 × +100
    const trades = Array.from({ length: 20 }, (_, i) =>
      row({ id: String(i), netPnlPrice: i === 0 ? 100 : 0.1, rMultiple: i === 0 ? 2 : 0.01, outcome: 'targeted' }),
    );
    const m = computeForwardPaperMetrics(trades);
    expect(m!.top1NetShare!).toBeGreaterThan(FORWARD_PAPER_MAX_TOP1_NET_SHARE);
    const v = evaluateForwardPaperVerdict({ ...base, countedCompleted: 20, metrics: m, nowMs: T0 + 30 * DAY });
    expect(v.conclusion).toBe('INCONCLUSIVE_CONCENTRATION');
  });

  test('net > 0, diversified, but 9 consecutive losses → INCONCLUSIVE_DRAWDOWN', () => {
    const trades: ForwardPaperRowInput[] = [];
    for (let i = 0; i < 9; i++) trades.push(row({ id: `l${i}`, netPnlPrice: -0.5, rMultiple: -1 }));
    for (let i = 0; i < 11; i++) trades.push(row({ id: `w${i}`, netPnlPrice: 2, rMultiple: 2, outcome: 'targeted' }));
    const m = computeForwardPaperMetrics(trades);
    expect(m!.netPnlPrice).toBeGreaterThan(0);
    expect(m!.maxConsecutiveLosses).toBe(9);
    const v = evaluateForwardPaperVerdict({ ...base, countedCompleted: 20, metrics: m, nowMs: T0 + 30 * DAY });
    expect(v.conclusion).toBe('INCONCLUSIVE_DRAWDOWN');
  });

  test('net > 0, diversified, drawdown deeper than 10R → INCONCLUSIVE_DRAWDOWN', () => {
    const trades: ForwardPaperRowInput[] = [];
    for (let i = 0; i < 12; i++) trades.push(row({ id: `l${i}`, netPnlPrice: -2, rMultiple: -1.5 })); // dd 18R
    for (let i = 0; i < 8; i++) trades.push(row({ id: `w${i}`, netPnlPrice: 6, rMultiple: 3, outcome: 'targeted' }));
    const m = computeForwardPaperMetrics(trades);
    expect(m!.maxDrawdownR).toBeGreaterThan(FORWARD_PAPER_MAX_DRAWDOWN_R);
    const v = evaluateForwardPaperVerdict({ ...base, countedCompleted: 20, metrics: m, nowMs: T0 + 30 * DAY });
    expect(v.conclusion).toBe('INCONCLUSIVE_DRAWDOWN');
  });

  test('all gates passed → PROMISING_CONTINUE_FORWARD — explicitly NOT Phase 11 authorization', () => {
    // 20 trades: 8 losses −1.5 (spread out), 12 wins +2 — diversified enough
    const trades: ForwardPaperRowInput[] = [];
    for (let i = 0; i < 20; i++) {
      const win = i % 5 !== 4; // every 5th a loss → max 1 consecutive loss
      trades.push(row({ id: String(i), netPnlPrice: win ? 2 : -1.5, rMultiple: win ? 2 : -1, outcome: win ? 'targeted' : 'stopped' }));
    }
    const m = computeForwardPaperMetrics(trades);
    const v = evaluateForwardPaperVerdict({ ...base, countedCompleted: 20, metrics: m, nowMs: T0 + 30 * DAY });
    expect(v.conclusion).toBe('PROMISING_CONTINUE_FORWARD');
    expect(v.disclaimer).toContain('do NOT authorize Phase 11');
  });

  test('deadline = activation + exactly 90 days', () => {
    expect(forwardPaperDeadlineMs()).toBe(
      Date.parse(FORWARD_PAPER_ACTIVATED_AT_ISO) + FORWARD_PAPER_OBSERVATION_WINDOW_DAYS * DAY,
    );
  });

  test('pre-registered constants are the documented values (drift guard)', () => {
    expect(FORWARD_PAPER_MIN_COMPLETED_TRADES).toBe(20);
    expect(FORWARD_PAPER_OBSERVATION_WINDOW_DAYS).toBe(90);
    expect(FORWARD_PAPER_MAX_TOP1_NET_SHARE).toBe(0.35);
    expect(FORWARD_PAPER_MAX_CONSECUTIVE_LOSSES).toBe(8);
    expect(FORWARD_PAPER_MAX_DRAWDOWN_R).toBe(10);
    expect(FORWARD_PAPER_RULES_VERSION).toBe('phase10.2-forward-paper-rules/1');
  });
});
