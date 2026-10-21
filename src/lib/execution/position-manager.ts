/**
 * XAUUSD AI Trading Agent — Software Position Manager (Task 36)
 * ----------------------------------------------------------------------------
 * The empirical problem this module solves (2025-10-21 evidence): auto-trades
 * opened with 1.5R take-profits that NEVER filled, while open profit swung
 * +1R → 0 → −1R and died at the stop. Nothing managed positions after entry.
 *
 * This manager is a SOFTWARE overlay on top of the broker-side hard stops:
 *   · BREAKEVEN — once floating profit reaches `breakevenAtR`, the position is
 *     armed; if price round-trips back to entry + 0.1×risk-unit, close at
 *     market (bank the move instead of giving it all back).
 *   · TRAILING — once floating profit reaches `trailAtR`, a floor follows the
 *     best favorable price at `trailAtrMult` × M1-ATR; a retrace through the
 *     floor closes at market. Trailing supersedes breakeven once active.
 *   · TIME STOP — a position older than `maxAgeMin` still floating below
 *     0.2R is a dead trade; close it to free the single exposure slot.
 *
 * Safety properties (mirror of the app's execution discipline):
 *   · NEVER modifies the broker-side SL/TP — the unverified SLTP-modify path
 *     is deliberately untouched; the ONLY write action is the PROVEN market
 *     CLOSE (single attempt, never auto-retried on unknown results).
 *   · The broker SL always remains the hard protection underneath.
 *   · Never throws: every per-position path is caught and counted; at most
 *     one error line per position per poll cycle.
 *   · Loss detection feeds the cross-module post-loss cooldown
 *     (src/lib/execution/loss-state.ts): when one of OUR positions is gone
 *     with negative realized PnL (broker SL, manual close, or a managed
 *     close below entry), recordLoss() engages the scalper's pause.
 *
 * "Our positions": the bridge /api/positions payload carries NO comment field
 * (verified: PositionInfo in mini-services/mt5-bridge/src/mt5-client.ts and
 * the app-side BridgePosition in bridge-orders.ts) — the configured
 * positionManager.managedCommentPrefixes cannot be applied today. Honest
 * fallback: every open position on the strict symbol allowlist
 * (config.market.symbols, default XAUUSDm) is managed — this app trades a
 * single watchlist symbol on a dedicated demo account. When the bridge ever
 * exposes comments, tighten this to prefix matching.
 *
 * Part A (decideManagedPosition + friends) is PURE and deterministic —
 * unit-tested in tests/execution/position-manager.test.ts without any
 * DB/network. Part B (runPositionManagerOnce + loop) wires the pure core to
 * the bridge, the DB and the audit trail.
 */

import { config } from '@/lib/config';
import { db } from '@/lib/db';
import { logEvent } from '@/lib/logger';
import {
  closeBridgePosition,
  listBridgePositions,
  type BridgePosition,
} from '@/lib/execution/bridge-orders';
import { recordLoss } from '@/lib/execution/loss-state';
import { createBridgeClient } from '@/lib/market/bridge-client';
import { atrSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle } from '@/lib/analysis/types';

// ---------------------------------------------------------------------------
// Part A — pure decision core (deterministic, no IO)
// ---------------------------------------------------------------------------

/** Named tuning constants (documented, exported for tests + evidence). */

/** Breakeven retrace buffer: close once price falls back to entry ± this
 *  fraction of the risk unit (BUY: entry + 0.1×R; SELL: entry − 0.1×R). */
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

/** Thresholds from the app config (clamped there; read once per call). */
export function managerThresholdsFromConfig(): ManagerThresholds {
  return {
    breakevenAtR: config.positionManager.breakevenAtR,
    trailAtR: config.positionManager.trailAtR,
    trailAtrMult: config.positionManager.trailAtrMult,
    maxAgeMin: config.positionManager.maxAgeMin,
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
export interface PositionSnapshot {
  positionId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  entryPrice: number;
  commission: number;
  swap: number;
  /** broker-reported floating PnL (account currency) at the last observation;
   *  null when never seen. */
  lastPnlUsd: number | null;
  /** last observed EXIT-side price (bid for BUY / ask for SELL). */
  lastExitSidePrice: number | null;
}

/**
 * Classify a position that vanished from the broker list (closed by broker
 * SL/TP or manually — the manager cannot distinguish, and says so honestly).
 * Priority of evidence: last broker floating PnL (strict sign); at exactly 0
 * or absent, the last exit-side price vs entry; else UNKNOWN.
 */
export function classifyDisappearance(s: PositionSnapshot): 'LOSS' | 'PROFIT' | 'UNKNOWN' {
  if (s.lastPnlUsd !== null) {
    if (s.lastPnlUsd < 0) return 'LOSS';
    if (s.lastPnlUsd > 0) return 'PROFIT';
  }
  if (s.lastExitSidePrice !== null && Number.isFinite(s.entryPrice) && s.entryPrice > 0) {
    const below = s.direction === 'BUY' ? s.lastExitSidePrice < s.entryPrice : s.lastExitSidePrice > s.entryPrice;
    const above = s.direction === 'BUY' ? s.lastExitSidePrice > s.entryPrice : s.lastExitSidePrice < s.entryPrice;
    if (below) return 'LOSS';
    if (above) return 'PROFIT';
  }
  return 'UNKNOWN';
}

/** Realized-PnL estimate for a disappearance record: broker floating PnL
 *  when seen, else the exit-side price PnL + commission + swap. */
function snapshotRealizedEstimate(s: PositionSnapshot): number {
  if (s.lastPnlUsd !== null && Number.isFinite(s.lastPnlUsd)) return s.lastPnlUsd;
  if (s.lastExitSidePrice !== null && Number.isFinite(s.lastExitSidePrice)) {
    const diff = s.direction === 'BUY' ? s.lastExitSidePrice - s.entryPrice : s.entryPrice - s.lastExitSidePrice;
    return diff * CONTRACT_OZ_PER_LOT * s.lots + s.commission + s.swap;
  }
  return 0;
}

/** Gross price PnL for a fill at `fillPrice` (used for our own closes). */
function fillPnlUsd(direction: 'BUY' | 'SELL', entryPrice: number, fillPrice: number, lots: number): number {
  const diff = direction === 'BUY' ? fillPrice - entryPrice : entryPrice - fillPrice;
  return diff * CONTRACT_OZ_PER_LOT * lots;
}

// ---------------------------------------------------------------------------
// Part B — the runtime loop
// ---------------------------------------------------------------------------

interface TrackedPosition {
  snapshot: PositionSnapshot;
  state: ManagedPositionState;
  /** a close attempt is in flight (accepted, or sent-with-unknown-result) —
   *  never decide again while set (exactly-once close discipline). */
  closeIssued: boolean;
  /** the LOSS/PROFIT outcome was already recorded (our own accepted close) —
   *  the disappearance pass must not double-record it. */
  outcomeRecorded: boolean;
}

/** Module-scoped poll state — survives across requests in this process. */
const tracked = new Map<string, TrackedPosition>();

/** The managed comment prefixes exist in config but the bridge returns no
 *  comment field (see file header) — selection is by symbol allowlist today. */
function isManagedPosition(p: BridgePosition): boolean {
  return config.market.symbols.includes(p.symbol);
}

/** Broker SL → pure-core stopLoss: present AND on the correct side of the
 *  entry; a wrong-side SL is treated as absent (honest, never negative risk). */
function brokerSlOrNull(p: BridgePosition): number | null {
  if (!(p.sl > 0) || !(p.priceOpen > 0)) return null;
  const correctSide = p.direction === 'BUY' ? p.sl < p.priceOpen : p.sl > p.priceOpen;
  return correctSide ? p.sl : null;
}

/** Dedicated bounded quote client for the 5s poll (read-only; the shared
 *  bridgeClient is tuned for the 60s sync path, this one stays snappy). */
const managerQuoteClient = createBridgeClient({ timeoutMs: 4_000, maxRetries: 1 });

interface ExitQuote {
  bid: number;
  ask: number;
  tsSec: number;
}

/** Freshest live quote straight from the bridge session (the DB tick cache
 *  only refreshes on the 60s sync cadence — too coarse for a 5s manager).
 *  Stale (>10s by quote age) or malformed → null (all positions HOLD). */
async function getExitQuote(nowMs: number): Promise<ExitQuote | null> {
  const symbol = config.market.symbols[0] ?? 'XAUUSDm';
  try {
    const res = await managerQuoteClient.getQuote(symbol);
    if (!res.ok) return null;
    const { bid, ask, ts } = res.data;
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid >= ask) return null;
    if (nowMs - ts * 1000 > QUOTE_STALE_MS) return null;
    return { bid, ask, tsSec: ts };
  } catch {
    return null;
  }
}

/** M1 ATR(14) over the last 30 CLOSED candles, cached 30s. Uses the project's
 *  canonical Wilder ATR (src/lib/analysis/indicators.ts) so every engine in
 *  the app shares one ATR convention. Null when insufficient data. */
let atrCache: { atMs: number; value: number | null } | null = null;

async function getM1Atr(nowMs: number): Promise<number | null> {
  if (atrCache !== null && nowMs - atrCache.atMs < ATR_CACHE_MS) return atrCache.value;
  const symbol = config.market.symbols[0] ?? 'XAUUSDm';
  let value: number | null = null;
  try {
    const rows = await db.marketCandle.findMany({
      where: { symbol, timeframe: 'M1', isForming: false, validationStatus: { not: 'INVALID' } },
      orderBy: { candleTimeUtc: 'desc' },
      take: ATR_LOOKBACK_CANDLES,
    });
    const candles: Array<Pick<AnalysisCandle, 'high' | 'low' | 'close'>> = [];
    for (const row of [...rows].reverse()) {
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      if (Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close) && high > 0) {
        candles.push({ high, low, close });
      }
    }
    if (candles.length >= ATR_PERIOD) {
      const res = atrSeries(candles, ATR_PERIOD);
      if (res.ok) {
        for (let i = res.series.values.length - 1; i >= 0; i--) {
          const v = res.series.values[i];
          if (v !== null && Number.isFinite(v) && v > 0) {
            value = v;
            break;
          }
        }
      }
    }
  } catch {
    value = null;
  }
  atrCache = { atMs: nowMs, value };
  return value;
}

function refreshSnapshot(t: TrackedPosition, p: BridgePosition, exitSidePrice: number): void {
  if (p.lots > 0) t.snapshot.lots = p.lots;
  t.snapshot.commission = Number.isFinite(p.commission) ? p.commission : 0;
  t.snapshot.swap = Number.isFinite(p.swap) ? p.swap : 0;
  if (Number.isFinite(p.profit)) t.snapshot.lastPnlUsd = p.profit;
  if (Number.isFinite(exitSidePrice) && exitSidePrice > 0) t.snapshot.lastExitSidePrice = exitSidePrice;
}

const CLOSE_EVENT_CODE: Record<Exclude<ManagerAction, 'HOLD'>, string> = {
  CLOSE_BREAKEVEN: 'POSITION_BREAKEVEN_CLOSED',
  CLOSE_TRAIL: 'POSITION_TRAIL_CLOSED',
  CLOSE_TIME_STOP: 'POSITION_TIME_STOP_CLOSED',
};

const CLOSE_EVENT_LABEL: Record<Exclude<ManagerAction, 'HOLD'>, string> = {
  CLOSE_BREAKEVEN: 'breakeven banked',
  CLOSE_TRAIL: 'trail floor hit',
  CLOSE_TIME_STOP: 'time stop (dead trade freed)',
};

/**
 * One manager poll. Never throws. Returns honest counts:
 *   managed — positions under management this poll (including held ones),
 *   closed  — closes ACCEPTED by the bridge this poll,
 *   errors  — bounded error count (one line per position per poll).
 */
export async function runPositionManagerOnce(
  opts: { now?: () => number } = {},
): Promise<{ managed: number; closed: number; errors: number }> {
  const now = opts.now ?? Date.now;
  const summary = { managed: 0, closed: 0, errors: 0 };
  if (!config.positionManager.enabled) return summary;

  // ---- 1. Positions (single attempt, fail-closed; on failure we skip the
  //         disappearance pass too — a fetch failure is indistinguishable
  //         from "all closed" and must never fabricate outcomes).
  let positions: BridgePosition[];
  try {
    const res = await listBridgePositions();
    if (!res.ok || res.data === null) {
      summary.errors += 1;
      await logEvent({
        level: 'warn',
        category: 'position-manager',
        code: 'POSITION_MANAGER_ERROR',
        message: `positions fetch failed (${res.errorCode ?? 'unknown'}) — poll skipped, disappearance detection not run (a failed fetch is indistinguishable from 'all closed')`,
        meta: { errorCode: res.errorCode, errorMessage: res.errorMessage },
      });
      return summary;
    }
    positions = res.data.filter(isManagedPosition);
  } catch (err) {
    summary.errors += 1;
    await logEvent({
      level: 'warn',
      category: 'position-manager',
      code: 'POSITION_MANAGER_ERROR',
      message: `positions fetch crashed: ${err instanceof Error ? err.message : 'unknown'}`,
    });
    return summary;
  }

  summary.managed = positions.length;
  const nowMs = now();

  // ---- 2. Disappearance pass — positions gone from the broker list.
  const currentIds = new Set(positions.map((p) => p.positionId));
  for (const [id, t] of Array.from(tracked.entries())) {
    if (currentIds.has(id)) continue;
    tracked.delete(id);
    if (t.outcomeRecorded) continue; // our own accepted close already recorded
    const outcome = classifyDisappearance(t.snapshot);
    if (outcome === 'LOSS') {
      const realized = snapshotRealizedEstimate(t.snapshot);
      recordLoss({ positionId: id, direction: t.snapshot.direction, realizedPnlUsd: realized, closedAtMs: nowMs });
      await logEvent({
        level: 'warn',
        category: 'position-manager',
        code: 'POSITION_CLOSED_LOSS',
        message: `Position ${id} (${t.snapshot.direction} ${t.snapshot.lots} lots) closed at a LOSS outside the manager (broker SL or manual): realized ≈ ${realized.toFixed(2)} USD — post-loss cooldown engaged for new auto-entries`,
        meta: {
          positionId: id,
          direction: t.snapshot.direction,
          realizedPnlUsd: realized,
          lastPnlUsd: t.snapshot.lastPnlUsd,
          lastExitSidePrice: t.snapshot.lastExitSidePrice,
          entryPrice: t.snapshot.entryPrice,
        },
      });
    } else if (outcome === 'PROFIT') {
      await logEvent({
        level: 'info',
        category: 'position-manager',
        code: 'POSITION_CLOSED_PROFIT',
        message: `Position ${id} (${t.snapshot.direction}) closed at a PROFIT outside the manager (broker TP or manual): last observed PnL ${fmtUsd(t.snapshot.lastPnlUsd ?? 0)}`,
        meta: { positionId: id, direction: t.snapshot.direction, lastPnlUsd: t.snapshot.lastPnlUsd },
      });
    } else {
      await logEvent({
        level: 'info',
        category: 'position-manager',
        code: 'POSITION_CLOSED_UNKNOWN',
        message: `Position ${id} (${t.snapshot.direction}) disappeared with UNKNOWN outcome (no PnL snapshot, exit price at entry) — nothing fabricated, no cooldown engaged`,
        meta: { positionId: id, direction: t.snapshot.direction },
      });
    }
  }

  // ---- 3. Live quote (freshest source: the bridge session itself).
  const quote = await getExitQuote(now());
  if (quote === null) {
    summary.errors += 1;
    await logEvent({
      level: 'warn',
      category: 'position-manager',
      code: 'POSITION_MANAGER_ERROR',
      message: `live quote unavailable or stale > ${Math.round(QUOTE_STALE_MS / 1000)}s — all ${summary.managed} position(s) HOLD this poll (fail-closed, no blind closes)`,
      meta: { managed: summary.managed },
    });
    return summary;
  }

  // ---- 4. M1 ATR (cached; null is a degraded mode, not an error — the pure
  //         core documents the fallback in every reason string).
  const m1Atr = await getM1Atr(now());
  const thresholds = managerThresholdsFromConfig();

  // ---- 5. Per-position decisions.
  for (const p of positions) {
    try {
      if (!(p.priceOpen > 0) || !(p.lots > 0) || !(p.timeCreateUtcSec > 0)) {
        summary.errors += 1;
        await logEvent({
          level: 'warn',
          category: 'position-manager',
          code: 'POSITION_MANAGER_ERROR',
          message: `position ${p.positionId} malformed (priceOpen=${p.priceOpen}, lots=${p.lots}, timeCreate=${p.timeCreateUtcSec}) — skipped this poll`,
          meta: { positionId: p.positionId },
        });
        continue;
      }

      const exitPrice = p.direction === 'BUY' ? quote.bid : quote.ask;
      let t = tracked.get(p.positionId);
      if (t === undefined) {
        t = {
          snapshot: {
            positionId: p.positionId,
            symbol: p.symbol,
            direction: p.direction,
            lots: p.lots,
            entryPrice: p.priceOpen,
            commission: p.commission,
            swap: p.swap,
            lastPnlUsd: Number.isFinite(p.profit) ? p.profit : null,
            lastExitSidePrice: exitPrice,
          },
          state: initialManagedState(exitPrice),
          closeIssued: false,
          outcomeRecorded: false,
        };
        tracked.set(p.positionId, t);
      } else {
        refreshSnapshot(t, p, exitPrice);
      }

      // A close is in flight (accepted or unknown) — refresh the snapshot
      // only; never double-fire a close.
      if (t.closeIssued) continue;

      const input: ManagedPositionInput = {
        positionId: p.positionId,
        symbol: p.symbol,
        direction: p.direction,
        lots: p.lots,
        entryPrice: p.priceOpen,
        stopLoss: brokerSlOrNull(p),
        openTimeMs: p.timeCreateUtcSec * 1000,
        comment: null, // the bridge returns no comment field (file header)
        currentPrice: exitPrice,
        m1Atr,
        nowMs: now(),
      };
      const { state, decision } = decideManagedPosition(t.state, input, thresholds);
      t.state = state;
      if (decision.action === 'HOLD') continue;

      // ---- 6. CLOSE at market — the proven bridge path, SINGLE ATTEMPT.
      const res = await closeBridgePosition(p.positionId);
      const accepted = res.ok && res.data?.accepted === true;
      const logStatus = !res.ok
        ? res.errorCode === 'BRIDGE_TIMEOUT'
          ? 'sent'
          : 'failed'
        : accepted
          ? 'filled'
          : 'rejected';

      const execLogId = await db.executionLog
        .create({
          data: {
            signalId: 'position-manager',
            request: JSON.stringify({
              action: 'MANAGE_CLOSE',
              code: decision.action,
              positionId: p.positionId,
              reason: decision.reasonEn,
              floatingR: decision.floatingR,
              floatingPnlUsd: decision.floatingPnlUsd,
              bestPrice: decision.bestPrice,
            }),
            result: JSON.stringify(
              res.ok
                ? res.data?.raw ?? { ok: false }
                : { ok: false, errorCode: res.errorCode, errorMessage: res.errorMessage },
            ),
            status: logStatus,
          },
        })
        .then((row) => row.id)
        .catch(() => null);

      if (accepted) {
        summary.closed += 1;
        t.closeIssued = true;
        t.outcomeRecorded = true;
        const fillPrice = res.data?.price ?? exitPrice;
        // Realized estimate: gross close-price PnL + broker commission + swap
        // from the last position record (the close outcome carries no PnL).
        const realized = fillPnlUsd(p.direction, p.priceOpen, fillPrice, p.lots) + p.commission + p.swap;
        await logEvent({
          level: 'info',
          category: 'position-manager',
          code: CLOSE_EVENT_CODE[decision.action],
          message: `Position ${p.positionId} (${p.direction} ${p.lots} lots) closed by the manager — ${CLOSE_EVENT_LABEL[decision.action]} @ ${fmtPx(fillPrice)}; realized ≈ ${realized.toFixed(2)} USD (${fmtUsd(realized)}); floating was ${fmtR(decision.floatingR)}, best ${fmtPx(decision.bestPrice)}`,
          meta: {
            positionId: p.positionId,
            action: decision.action,
            reason: decision.reasonEn,
            fillPrice,
            realizedPnlUsd: realized,
            floatingR: decision.floatingR,
            bestPrice: decision.bestPrice,
            executionLogId: execLogId,
          },
        });
        if (realized <= 0) {
          // A managed close below entry is still a realized loss — the
          // post-loss cooldown must engage (loss-state.ts contract).
          recordLoss({ positionId: p.positionId, direction: p.direction, realizedPnlUsd: realized, closedAtMs: now() });
          await logEvent({
            level: 'warn',
            category: 'position-manager',
            code: 'POSITION_CLOSED_LOSS',
            message: `Managed close of ${p.positionId} realized NEGATIVE (${realized.toFixed(2)} USD) — post-loss cooldown engaged for new auto-entries`,
            meta: { positionId: p.positionId, realizedPnlUsd: realized, action: decision.action },
          });
        }
      } else if (res.ok && !accepted) {
        // Broker rejected — safe to retry next poll (a close reduces exposure;
        // unlike OPEN orders, a re-attempt can never double a position).
        summary.errors += 1;
        await logEvent({
          level: 'warn',
          category: 'position-manager',
          code: 'POSITION_MANAGER_ERROR',
          message: `broker rejected the managed close of ${p.positionId} (retcode ${res.data?.retcode ?? '?'}) — retrying next poll`,
          meta: { positionId: p.positionId, retcode: res.data?.retcode ?? null },
        });
      } else if (res.errorCode === 'BRIDGE_TIMEOUT') {
        // Sent with unknown result — exactly-once discipline: never re-fire;
        // the outcome is classified from the snapshot when it disappears.
        t.closeIssued = true;
        summary.errors += 1;
        await logEvent({
          level: 'warn',
          category: 'position-manager',
          code: 'POSITION_MANAGER_ERROR',
          message: `managed close of ${p.positionId} sent but result UNKNOWN (timeout) — no second attempt (exactly-once); outcome will be classified from the next positions poll`,
          meta: { positionId: p.positionId, decision: decision.action },
        });
      } else {
        summary.errors += 1;
        await logEvent({
          level: 'warn',
          category: 'position-manager',
          code: 'POSITION_MANAGER_ERROR',
          message: `managed close of ${p.positionId} failed (${res.errorCode ?? 'unknown'}) — retrying next poll`,
          meta: { positionId: p.positionId, errorCode: res.errorCode, errorMessage: res.errorMessage },
        });
      }
    } catch (err) {
      // One error line per position per poll (by construction: single
      // try/catch around this position's whole path).
      summary.errors += 1;
      await logEvent({
        level: 'warn',
        category: 'position-manager',
        code: 'POSITION_MANAGER_ERROR',
        message: `managing ${p.positionId} failed: ${err instanceof Error ? err.message : 'unknown'}`,
        meta: { positionId: p.positionId },
      });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

let loopTimer: ReturnType<typeof setInterval> | null = null;
let loopInFlight = false;

/** Start the poll loop (idempotent). interval = pollSec, overlap-guarded,
 *  .unref()'d so it never keeps the process alive, silent while disabled. */
export function startPositionManagerLoop(): void {
  if (loopTimer !== null) return;
  const periodMs = Math.max(2, config.positionManager.pollSec) * 1000;
  loopTimer = setInterval(() => {
    if (!config.positionManager.enabled) return; // silent skip
    if (loopInFlight) return;
    loopInFlight = true;
    void runPositionManagerOnce()
      .catch(() => undefined) // runOnce never throws; belt and braces
      .finally(() => {
        loopInFlight = false;
      });
  }, periodMs);
  (loopTimer as { unref?: () => void }).unref?.();
  console.log(
    `[position-manager] loop started — every ${Math.round(periodMs / 1000)}s (breakeven ≥${config.positionManager.breakevenAtR}R, trail ≥${config.positionManager.trailAtR}R at ${config.positionManager.trailAtrMult}×ATR, time stop ${config.positionManager.maxAgeMin > 0 ? `${config.positionManager.maxAgeMin}min` : 'off'})`,
  );
}

/** Test-only hook: stop the loop (never called from production paths). */
export function stopPositionManagerLoopForTests(): void {
  if (loopTimer !== null) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  loopInFlight = false;
}

/** Test-only hook: drop all poll state (tracked positions). */
export function resetPositionManagerStateForTests(): void {
  tracked.clear();
  atrCache = null;
}
