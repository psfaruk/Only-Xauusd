/**
 * Only-Xauusd — Managed-position SIMULATION primitives (backtest-only).
 * ----------------------------------------------------------------------------
 * Pure decision functions that were originally developed inside the Phase 36
 * software position manager (src/lib/execution/position-manager.ts, DELETED
 * in Phase 0 together with the live execution layer). They are preserved
 * here ONLY as backtest-simulation logic: the backtest harness replays how a
 * breakeven / trailing / time-stop manager WOULD have managed each trade.
 *
 * This module has NO network, NO bridge, NO database, NO clock: everything
 * arrives as arguments. It can never place, close or see a real broker
 * position — the live manager loop was removed with the execution module.
 */

export const BREAKEVEN_BUFFER_R = 0.1;
/** Time stop fires only when floating profit is below this R (or, when R is
 *  unavailable, when raw floating PnL is strictly negative). */
export const TIME_STOP_MAX_R = 0.2;
/** XAUUSD contract size: 100 troy ounces per 1.00 lot → $1 price move = $100
 *  per lot. PnL = priceDiff × 100 × lots. */
export const CONTRACT_OZ_PER_LOT = 100;
/** ATR(14) over M1 closed candles — the manager's volatility unit. */
export const ATR_PERIOD = 14;
/** How many closed M1 candles to load for the ATR window. */
export const ATR_LOOKBACK_CANDLES = 30;
/** M1-ATR recompute cache TTL (the loop polls every 5s; ATR needs 30s at most). */
export const ATR_CACHE_MS = 30_000;
/** A quote older than this is STALE → every position HOLDs that poll. */
export const QUOTE_STALE_MS = 10_000;

export type ManagerAction = 'HOLD' | 'CLOSE_BREAKEVEN' | 'CLOSE_TRAIL' | 'CLOSE_TIME_STOP';

export interface ManagedPositionInput {
  positionId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  /** broker open price */
  entryPrice: number;
  /** broker-side hard SL; null = none (risk unit falls back to M1-ATR) */
  stopLoss: number | null;
  /** position open time, UTC ms */
  openTimeMs: number;
  /** broker comment — the bridge does not return one today (passed as null,
   *  kept in the interface for the day it does; see file header). */
  comment: string | null;
  /** the EXIT-side price: bid for BUY, ask for SELL */
  currentPrice: number;
  /** ATR(14) of closed M1 candles, price units; null = unavailable */
  m1Atr: number | null;
  nowMs: number;
}

/** Per-position state carried between polls. `trailActive` is required in
 *  addition to the briefed {bestPrice, breakevenArmed} because "trailing
 *  supersedes breakeven ONCE ACTIVE" is itself state that must survive polls
 *  where floating profit has already fallen below trailAtR. */
export interface ManagedPositionState {
  /** best favorable EXIT-side price seen so far (max for BUY, min for SELL) */
  bestPrice: number;
  /** sticky: armed once floatingR ≥ breakevenAtR */
  breakevenArmed: boolean;
  /** sticky: armed once floatingR ≥ trailAtR (with ATR available) */
  trailActive: boolean;
  lastDecision: ManagerAction | null;
}

export interface ManagerDecision {
  action: ManagerAction;
  /** English audit reason (like the rest of the engine). */
  reasonEn: string;
  /** R multiple of floating profit; null when the risk unit is unavailable
   *  (no usable SL and no M1-ATR) — in that mode only the time stop (by
   *  strictly negative PnL) can ever fire. Documented fallback. */
  floatingR: number | null;
  /** (exitPrice − entry) × 100 × lots (BUY; mirrored for SELL) — gross
   *  price PnL at the current EXIT-side quote. */
  floatingPnlUsd: number;
  /** best favorable exit-side price seen so far (the UPDATED value). */
  bestPrice: number;
}

export interface ManagerThresholds {
  breakevenAtR: number;
  trailAtR: number;
  trailAtrMult: number;
  /** 0 disables the time stop. */
  maxAgeMin: number;
}

/** Thresholds for the backtest simulation. The historical live-manager config
 *  block (config.positionManager) was removed in Phase 0 with the execution
 *  layer; the backtest pins the SAME empirical values the live manager used
 *  (Task 36/37) so replay results stay comparable across versions. */
export function managerThresholdsFromConfig(): ManagerThresholds {
  return {
    breakevenAtR: 1.0,
    trailAtR: 1.5,
    trailAtrMult: 1.0,
    maxAgeMin: 45,
  };
}

/** State for a position on its FIRST poll: the best price seen so far is the
 *  first observed exit-side price (anything before the manager's first look
 *  is invisible — honest limitation, 5s poll cadence bounds it). */
export function initialManagedState(firstExitSidePrice: number): ManagedPositionState {
  return { bestPrice: firstExitSidePrice, breakevenArmed: false, trailActive: false, lastDecision: null };
}

// Deterministic formatting for reasonEn (fixed toFixed(2) everywhere so the
// same inputs always produce byte-identical reasons — the audit trail and the
// determinism tests rely on it).
function fmtR(v: number | null): string {
  return v === null ? 'null' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
}
function fmtUsd(v: number): string {
  return `${v < 0 ? '−' : '+'}$${Math.abs(v).toFixed(2)}`;
}
function fmtPx(v: number): string {
  return v.toFixed(2);
}

/**
 * The pure per-poll decision. Takes the previous state + the current input
 * and returns the NEW state plus the decision for this poll. Fully
 * deterministic: same (prev, input, thresholds) → same output, always.
 */
export function decideManagedPosition(
  prev: ManagedPositionState,
  input: ManagedPositionInput,
  thresholds: ManagerThresholds,
): { state: ManagedPositionState; decision: ManagerDecision } {
  const isBuy = input.direction === 'BUY';

  // 0. Defensive guard — a malformed price can never trigger a close.
  if (
    !Number.isFinite(input.currentPrice) || input.currentPrice <= 0 ||
    !Number.isFinite(input.entryPrice) || input.entryPrice <= 0
  ) {
    return {
      state: { ...prev, lastDecision: 'HOLD' },
      decision: {
        action: 'HOLD',
        reasonEn: 'HOLD: invalid input price (defensive guard) — no action taken',
        floatingR: null,
        floatingPnlUsd: 0,
        bestPrice: prev.bestPrice,
      },
    };
  }

  // 1. Best favorable exit-side price (monotonic: never regresses).
  const bestPrice = isBuy ? Math.max(prev.bestPrice, input.currentPrice) : Math.min(prev.bestPrice, input.currentPrice);

  // 2. Risk unit: |entry − SL| when the broker SL is usable (present, on the
  //    correct side of the entry); else M1-ATR; else null (documented
  //    fallback chain — a wrong-side SL is treated as absent, never negative).
  let riskUnit: number | null = null;
  if (input.stopLoss !== null && Number.isFinite(input.stopLoss) && input.stopLoss > 0) {
    const dist = isBuy ? input.entryPrice - input.stopLoss : input.stopLoss - input.entryPrice;
    if (dist > 0) riskUnit = dist;
  }
  const atr = input.m1Atr !== null && Number.isFinite(input.m1Atr) && input.m1Atr > 0 ? input.m1Atr : null;
  if (riskUnit === null && atr !== null) riskUnit = atr;

  // 3. Floating profit (exit-side) in R and USD.
  const directionProfit = isBuy ? input.currentPrice - input.entryPrice : input.entryPrice - input.currentPrice;
  const floatingR = riskUnit !== null && riskUnit > 0 ? directionProfit / riskUnit : null;
  const floatingPnlUsd = directionProfit * CONTRACT_OZ_PER_LOT * input.lots;
  const ageMs = Math.max(0, input.nowMs - input.openTimeMs);
  const ageMin = ageMs / 60_000;

  // 4/5. Sticky arm flags (arming on this poll is safe: at ≥1.0R the price is
  //     necessarily above the +0.1R breakeven buffer, and at ≥1.5R above a
  //     1×ATR trail floor measured from the running best — same-poll arm+fire
  //     is impossible by construction).
  const breakevenArmed = prev.breakevenArmed || (floatingR !== null && floatingR >= thresholds.breakevenAtR);
  const trailActive = prev.trailActive || (floatingR !== null && floatingR >= thresholds.trailAtR && atr !== null);

  const nextState: ManagedPositionState = {
    bestPrice,
    breakevenArmed,
    trailActive,
    lastDecision: 'HOLD', // replaced below when a trigger fires
  };

  const holdReason = (): string => {
    const floatingTxt = floatingR !== null ? fmtR(floatingR) : `${fmtUsd(floatingPnlUsd)} (R unavailable)`;
    const armedTxt = [
      breakevenArmed ? 'breakeven armed' : `breakeven arm ≥${thresholds.breakevenAtR.toFixed(2)}R`,
      trailActive ? 'trail active' : `trail arm ≥${thresholds.trailAtR.toFixed(2)}R`,
    ].join(', ');
    const ageTxt = thresholds.maxAgeMin > 0 ? `${ageMin.toFixed(1)}/${thresholds.maxAgeMin}min` : `${ageMin.toFixed(1)}min (time stop off)`;
    return `HOLD: floating ${floatingTxt}; pnl ${fmtUsd(floatingPnlUsd)}; ${armedTxt}; age ${ageTxt}; best ${fmtPx(bestPrice)}`;
  };

  // 5. TRAILING — supersedes breakeven once active (needs a usable ATR this
  //    poll to place the floor; an ATR gap degrades honestly to breakeven).
  if (trailActive && atr !== null) {
    const trailStop = isBuy ? bestPrice - thresholds.trailAtrMult * atr : bestPrice + thresholds.trailAtrMult * atr;
    const hit = isBuy ? input.currentPrice <= trailStop : input.currentPrice >= trailStop;
    if (hit) {
      nextState.lastDecision = 'CLOSE_TRAIL';
      return {
        state: nextState,
        decision: {
          action: 'CLOSE_TRAIL',
          reasonEn: `CLOSE_TRAIL: trail active since ≥${thresholds.trailAtR.toFixed(2)}R; floor ${fmtPx(trailStop)} = best ${fmtPx(bestPrice)} − ${thresholds.trailAtrMult}×ATR ${fmtPx(atr)}; price ${fmtPx(input.currentPrice)} hit the floor (floating ${fmtR(floatingR)}, pnl ${fmtUsd(floatingPnlUsd)})`,
          floatingR,
          floatingPnlUsd,
          bestPrice,
        },
      };
    }
  }

  // 4. BREAKEVEN — armed at ≥breakevenAtR; close once price round-trips to
  //    entry + 0.1×risk unit (BUY) / entry − 0.1×risk unit (SELL).
  if (breakevenArmed && riskUnit !== null) {
    const buffer = isBuy
      ? input.entryPrice + BREAKEVEN_BUFFER_R * riskUnit
      : input.entryPrice - BREAKEVEN_BUFFER_R * riskUnit;
    const hit = isBuy ? input.currentPrice <= buffer : input.currentPrice >= buffer;
    if (hit) {
      nextState.lastDecision = 'CLOSE_BREAKEVEN';
      return {
        state: nextState,
        decision: {
          action: 'CLOSE_BREAKEVEN',
          reasonEn: `CLOSE_BREAKEVEN: armed at ≥${thresholds.breakevenAtR.toFixed(2)}R; price ${fmtPx(input.currentPrice)} fell back to the entry±${BREAKEVEN_BUFFER_R}R buffer ${fmtPx(buffer)}; banking the move at market (floating ${fmtR(floatingR)}, pnl ${fmtUsd(floatingPnlUsd)})`,
          floatingR,
          floatingPnlUsd,
          bestPrice,
        },
      };
    }
  }

  // 6. TIME STOP — age > maxAgeMin AND floating < 0.2R (when R is
  //    unavailable — no SL and no ATR — the fallback is RAW negative PnL,
  //    documented honestly; maxAgeMin=0 disables).
  if (thresholds.maxAgeMin > 0 && ageMs > thresholds.maxAgeMin * 60_000) {
    const belowFloor = floatingR !== null ? floatingR < TIME_STOP_MAX_R : floatingPnlUsd < 0;
    if (belowFloor) {
      nextState.lastDecision = 'CLOSE_TIME_STOP';
      return {
        state: nextState,
        decision: {
          action: 'CLOSE_TIME_STOP',
          reasonEn: `CLOSE_TIME_STOP: age ${ageMin.toFixed(1)}min > ${thresholds.maxAgeMin}min with floating ${fmtR(floatingR)} < ${TIME_STOP_MAX_R.toFixed(2)}R floor${floatingR === null ? ` (R unavailable — raw pnl ${fmtUsd(floatingPnlUsd)} < 0)` : ''}; dead trade — closing at market to free the slot`,
          floatingR,
          floatingPnlUsd,
          bestPrice,
        },
      };
    }
  }

  // 7. HOLD.
  return {
    state: nextState,
    decision: {
      action: 'HOLD',
      reasonEn: holdReason(),
      floatingR,
      floatingPnlUsd,
      bestPrice,
    },
  };
}

// ---------------------------------------------------------------------------
// Disappearance classification (pure) — feeds the post-loss cooldown
// ---------------------------------------------------------------------------

/** Last-observed snapshot of a tracked position, kept between polls. */
