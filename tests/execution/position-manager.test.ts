/**
 * Task 36 — software position manager: PURE decision-core tests.
 *
 * Scope: decideManagedPosition + classifyDisappearance only — no DB, no
 * network, no bridge. The runtime loop (runPositionManagerOnce) is covered
 * by live behaviour + the audit trail, not by unit tests.
 *
 * Fixture conventions (mirrors the user's live evidence, 2025-10-21):
 *   entry 4120.00, broker SL 4117.00 → risk unit R = 3.00 price units,
 *   XAUUSD 100oz/lot, 0.10 lots → $1 price move = $10 PnL. The exit-side
 *   price is fed directly (bid for BUY, ask for SELL — the loop maps it).
 */

import { describe, expect, test } from 'bun:test';
import {
  BREAKEVEN_BUFFER_R,
  CONTRACT_OZ_PER_LOT,
  TIME_STOP_MAX_R,
  classifyDisappearance,
  decideManagedPosition,
  initialManagedState,
  type ManagedPositionInput,
  type ManagedPositionState,
  type ManagerThresholds,
  type PositionSnapshot,
} from '@/lib/execution/position-manager';

const TH: ManagerThresholds = { breakevenAtR: 1.0, trailAtR: 1.5, trailAtrMult: 1.0, maxAgeMin: 45 };
const NOW = 1_700_000_000_000; // fixed clock — full determinism

function input(over: Partial<ManagedPositionInput>): ManagedPositionInput {
  return {
    positionId: 'pos-1',
    symbol: 'XAUUSDm',
    direction: 'BUY',
    lots: 0.1,
    entryPrice: 4120.0,
    stopLoss: 4117.0,
    openTimeMs: NOW - 5 * 60_000, // 5 min old by default
    comment: null,
    currentPrice: 4120.0,
    m1Atr: 1.2,
    nowMs: NOW,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Breakeven: ride to +1.2R, round-trip to entry+0.1R
// ---------------------------------------------------------------------------
describe('breakeven banks the round-trip', () => {
  test('BUY +1.2R arms, falling back to entry+0.10R closes CLOSE_BREAKEVEN', () => {
    // Poll A — +1.2R: arms the breakeven, no close yet.
    const a = decideManagedPosition(initialManagedState(4123.0), input({ currentPrice: 4123.6 }), TH);
    expect(a.decision.action).toBe('HOLD');
    expect(a.state.breakevenArmed).toBe(true);
    expect(a.decision.floatingR).toBeCloseTo(1.2, 10);
    expect(a.decision.floatingPnlUsd).toBeCloseTo(3.6 * CONTRACT_OZ_PER_LOT * 0.1, 10);
    expect(a.decision.bestPrice).toBe(4123.6);

    // Poll B — price falls back to exactly entry + 0.1R = 4120.30 → close.
    const b = decideManagedPosition(a.state, input({ currentPrice: 4120.3 }), TH);
    expect(b.decision.action).toBe('CLOSE_BREAKEVEN');
    expect(b.state.breakevenArmed).toBe(true);
    expect(b.decision.floatingR).toBeCloseTo(BREAKEVEN_BUFFER_R, 10);
    expect(b.decision.floatingPnlUsd).toBeCloseTo(0.3 * CONTRACT_OZ_PER_LOT * 0.1, 10);
    expect(b.decision.bestPrice).toBe(4123.6); // monotonic best
    expect(b.decision.reasonEn).toContain('CLOSE_BREAKEVEN');
  });

  test('never armed below 1.0R — the retrace to entry does NOT close', () => {
    const a = decideManagedPosition(initialManagedState(4120.5), input({ currentPrice: 4120.9 }), TH); // +0.3R
    expect(a.decision.action).toBe('HOLD');
    expect(a.state.breakevenArmed).toBe(false);
    const b = decideManagedPosition(a.state, input({ currentPrice: 4120.0 }), TH); // at entry
    expect(b.decision.action).toBe('HOLD');
  });
});

// ---------------------------------------------------------------------------
// 2. Trailing
// ---------------------------------------------------------------------------
describe('trailing stop follows the best price', () => {
  test('BUY +1.6R activates the trail; a 1×ATR retrace from best closes CLOSE_TRAIL', () => {
    // Poll A — +1.6R: trail arms. Floor = best 4124.80 − 1.0×ATR 1.20 = 4123.60;
    // price 4124.80 is above the floor → hold.
    const a = decideManagedPosition(initialManagedState(4120.0), input({ currentPrice: 4124.8 }), TH);
    expect(a.decision.action).toBe('HOLD');
    expect(a.state.trailActive).toBe(true);
    expect(a.state.breakevenArmed).toBe(true);
    expect(a.decision.bestPrice).toBe(4124.8);

    // Poll B — retrace to exactly best − 1×ATR = 4123.60 → trail fires.
    const b = decideManagedPosition(a.state, input({ currentPrice: 4123.6 }), TH);
    expect(b.decision.action).toBe('CLOSE_TRAIL');
    expect(b.decision.floatingR).toBeCloseTo(1.2, 10);
    expect(b.decision.reasonEn).toContain('CLOSE_TRAIL');
    expect(b.decision.reasonEn).toContain('4123.60');
  });

  test('trail supersedes breakeven when both triggers are true', () => {
    // Poll A — +2.0R: trail + breakeven both armed; best 4126.00.
    const a = decideManagedPosition(initialManagedState(4120.0), input({ currentPrice: 4126.0 }), TH);
    expect(a.decision.action).toBe('HOLD');
    expect(a.state.trailActive).toBe(true);

    // Poll B — price 4120.20: BELOW the breakeven buffer 4120.30 AND below the
    // trail floor 4124.80. The trail wins (supersedes breakeven once active).
    const b = decideManagedPosition(a.state, input({ currentPrice: 4120.2 }), TH);
    expect(b.decision.action).toBe('CLOSE_TRAIL');
    expect(b.decision.action).not.toBe('CLOSE_BREAKEVEN');
  });

  test('a smaller retrace than mult×ATR does NOT fire the trail', () => {
    const a = decideManagedPosition(initialManagedState(4120.0), input({ currentPrice: 4124.8 }), TH);
    expect(a.decision.action).toBe('HOLD');
    // Retrace 0.5×ATR → price 4124.20 > floor 4123.60 → still hold.
    const b = decideManagedPosition(a.state, input({ currentPrice: 4124.2 }), TH);
    expect(b.decision.action).toBe('HOLD');
    expect(b.decision.bestPrice).toBe(4124.8);
  });
});

// ---------------------------------------------------------------------------
// 3. bestPrice monotonicity (SELL mirror)
// ---------------------------------------------------------------------------
describe('bestPrice is monotonic (SELL mirror)', () => {
  const sell = (over: Partial<ManagedPositionInput>) =>
    input({ direction: 'SELL', stopLoss: 4123.0, ...over });

  test('SELL: best (lowest) price never regresses when price rises', () => {
    // Poll A — SELL +1.33R (ask falls to 4116.00): breakeven arms, best = 4116.
    const a = decideManagedPosition(initialManagedState(4119.0), sell({ currentPrice: 4116.0 }), TH);
    expect(a.decision.action).toBe('HOLD');
    expect(a.state.breakevenArmed).toBe(true);
    expect(a.decision.bestPrice).toBe(4116.0);
    expect(a.decision.floatingR).toBeCloseTo(4 / 3, 10);

    // Poll B — price rises to 4119.00: best stays 4116.00 (min), no close yet
    // (buffer for SELL = entry − 0.1R = 4119.70; 4119.00 is still below it).
    const b = decideManagedPosition(a.state, sell({ currentPrice: 4119.0 }), TH);
    expect(b.decision.action).toBe('HOLD');
    expect(b.decision.bestPrice).toBe(4116.0);

    // Poll C — price 4119.80 ≥ buffer 4119.70 → CLOSE_BREAKEVEN, best STILL 4116.
    const c = decideManagedPosition(b.state, sell({ currentPrice: 4119.8 }), TH);
    expect(c.decision.action).toBe('CLOSE_BREAKEVEN');
    expect(c.decision.bestPrice).toBe(4116.0);
    expect(c.decision.floatingR).toBeCloseTo(0.2 / 3, 4); // (4120−4119.8)/3 ≈ +0.067R
  });
});

// ---------------------------------------------------------------------------
// 4. Time stop
// ---------------------------------------------------------------------------
describe('time stop frees dead trades', () => {
  const oldAge = 46 * 60_000;
  const dead = (over: Partial<ManagedPositionInput>) =>
    input({ openTimeMs: NOW - oldAge, currentPrice: 4120.15, ...over }); // +0.05R

  test('age 46min with floating +0.05R → CLOSE_TIME_STOP', () => {
    const r = decideManagedPosition(initialManagedState(4120.15), dead({}), TH);
    expect(r.decision.action).toBe('CLOSE_TIME_STOP');
    expect(r.decision.reasonEn).toContain('CLOSE_TIME_STOP');
    expect(r.decision.reasonEn).toContain('46.0min');
  });

  test('fresh position (5min) with the same PnL → HOLD', () => {
    const r = decideManagedPosition(initialManagedState(4120.15), input({ currentPrice: 4120.15 }), TH);
    expect(r.decision.action).toBe('HOLD');
  });

  test('maxAgeMin=0 disables the time stop (age 46min → HOLD)', () => {
    const r = decideManagedPosition(initialManagedState(4120.15), dead({}), { ...TH, maxAgeMin: 0 });
    expect(r.decision.action).toBe('HOLD');
  });

  test('age 46min but floating +0.5R (≥ the 0.2R floor) → HOLD (not dead)', () => {
    const r = decideManagedPosition(initialManagedState(4121.5), dead({ currentPrice: 4121.5 }), TH);
    expect(r.decision.action).toBe('HOLD');
  });

  test('R unavailable (no SL, no ATR): age 46min + negative PnL → CLOSE_TIME_STOP', () => {
    const r = decideManagedPosition(
      initialManagedState(4120.5),
      dead({ stopLoss: null, m1Atr: null, currentPrice: 4119.5 }), // −$5 raw
      TH,
    );
    expect(r.decision.action).toBe('CLOSE_TIME_STOP');
    expect(r.decision.floatingR).toBeNull();
    expect(r.decision.floatingPnlUsd).toBeCloseTo(-0.5 * CONTRACT_OZ_PER_LOT * 0.1, 10);
    expect(r.decision.reasonEn).toContain('R unavailable');
  });

  test('R unavailable + positive PnL at 46min → HOLD (fallback needs negative PnL)', () => {
    const r = decideManagedPosition(
      initialManagedState(4120.5),
      dead({ stopLoss: null, m1Atr: null, currentPrice: 4120.5 }), // +$5 raw
      TH,
    );
    expect(r.decision.action).toBe('HOLD');
  });
});

// ---------------------------------------------------------------------------
// 5. Risk-unit fallbacks
// ---------------------------------------------------------------------------
describe('risk unit fallbacks', () => {
  test('SL null → risk unit from M1-ATR; full breakeven cycle works', () => {
    // ATR 2.50 → R = 2.50. +1.0R = 4122.50 arms the breakeven.
    const a = decideManagedPosition(
      initialManagedState(4120.0),
      input({ stopLoss: null, m1Atr: 2.5, currentPrice: 4122.5 }),
      TH,
    );
    expect(a.decision.action).toBe('HOLD');
    expect(a.state.breakevenArmed).toBe(true);
    expect(a.decision.floatingR).toBeCloseTo(1.0, 10);

    // Buffer = entry + 0.1×2.50 = 4120.25 → close there.
    const b = decideManagedPosition(a.state, input({ stopLoss: null, m1Atr: 2.5, currentPrice: 4120.25 }), TH);
    expect(b.decision.action).toBe('CLOSE_BREAKEVEN');
  });

  test('SL null AND ATR null → floatingR null, HOLD, no crash', () => {
    const r = decideManagedPosition(
      initialManagedState(4121.0),
      input({ stopLoss: null, m1Atr: null, currentPrice: 4121.0 }),
      TH,
    );
    expect(r.decision.action).toBe('HOLD');
    expect(r.decision.floatingR).toBeNull();
    expect(r.decision.floatingPnlUsd).toBeCloseTo(1.0 * CONTRACT_OZ_PER_LOT * 0.1, 10);
    expect(r.decision.bestPrice).toBe(4121.0);
    expect(r.state.breakevenArmed).toBe(false);
    expect(r.state.trailActive).toBe(false);
  });

  test('wrong-side SL (above entry for BUY) is treated as absent → ATR fallback', () => {
    const r = decideManagedPosition(
      initialManagedState(4120.0),
      input({ stopLoss: 4125.0, m1Atr: 2.5, currentPrice: 4122.5 }),
      TH,
    );
    expect(r.decision.floatingR).toBeCloseTo(1.0, 10); // from ATR 2.5, not the wrong-side SL
  });
});

// ---------------------------------------------------------------------------
// 6. Disappearance classification (feeds the post-loss cooldown)
// ---------------------------------------------------------------------------
describe('classifyDisappearance', () => {
  const base: PositionSnapshot = {
    positionId: 'pos-1',
    symbol: 'XAUUSDm',
    direction: 'BUY',
    lots: 0.1,
    entryPrice: 4120.0,
    commission: 0,
    swap: 0,
    lastPnlUsd: null,
    lastExitSidePrice: null,
  };

  test('negative PnL → LOSS', () => {
    expect(classifyDisappearance({ ...base, lastPnlUsd: -12.5 })).toBe('LOSS');
  });
  test('positive PnL → PROFIT', () => {
    expect(classifyDisappearance({ ...base, lastPnlUsd: 9.4 })).toBe('PROFIT');
  });
  test('zero PnL + last exit below entry (BUY) → LOSS (price evidence)', () => {
    expect(classifyDisappearance({ ...base, lastPnlUsd: 0, lastExitSidePrice: 4119.0 })).toBe('LOSS');
  });
  test('zero PnL + last exit above entry (BUY) → PROFIT', () => {
    expect(classifyDisappearance({ ...base, lastPnlUsd: 0, lastExitSidePrice: 4121.0 })).toBe('PROFIT');
  });
  test('no PnL, no price → UNKNOWN', () => {
    expect(classifyDisappearance({ ...base })).toBe('UNKNOWN');
  });
  test('SELL mirror: no PnL, last exit above entry → LOSS', () => {
    expect(
      classifyDisappearance({ ...base, direction: 'SELL', lastExitSidePrice: 4121.0 }),
    ).toBe('LOSS');
  });
  test('SELL mirror: no PnL, last exit below entry → PROFIT', () => {
    expect(
      classifyDisappearance({ ...base, direction: 'SELL', lastExitSidePrice: 4119.0 }),
    ).toBe('PROFIT');
  });
});

// ---------------------------------------------------------------------------
// 7. Determinism
// ---------------------------------------------------------------------------
describe('determinism', () => {
  test('same inputs → same decision + state (two runs deep-equal)', () => {
    const prev: ManagedPositionState = initialManagedState(4120.5);
    const inp: ManagedPositionInput = input({ currentPrice: 4124.8, openTimeMs: NOW - 12 * 60_000 });
    const run1 = decideManagedPosition(prev, inp, TH);
    const run2 = decideManagedPosition(prev, inp, TH);
    expect(run1).toEqual(run2);

    // A second poll with a trigger price also deterministic.
    const t1 = decideManagedPosition(run1.state, input({ currentPrice: 4123.6 }), TH);
    const t2 = decideManagedPosition(run2.state, input({ currentPrice: 4123.6 }), TH);
    expect(t1).toEqual(t2);
    expect(t1.decision.reasonEn).toBe(t2.decision.reasonEn);
  });

  test('constant sanity: buffer and time-stop floor match the spec', () => {
    expect(BREAKEVEN_BUFFER_R).toBe(0.1);
    expect(TIME_STOP_MAX_R).toBe(0.2);
    expect(CONTRACT_OZ_PER_LOT).toBe(100);
  });
});
