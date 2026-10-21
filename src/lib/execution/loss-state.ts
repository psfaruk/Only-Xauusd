/**
 * XAUUSD AI Trading Agent — cross-module post-loss cooldown state (Task 36).
 * ----------------------------------------------------------------------------
 * WRITER: the position manager (src/lib/execution/position-manager.ts) —
 *   records a loss the moment it detects one of OUR positions closed with a
 *   negative realized PnL (broker SL, or a managed close below entry).
 *
 * READER: the scalper service — refuses to auto-execute a NEW setup while the
 *   cooldown window is active (SCALPER_POST_LOSS_COOLDOWN). The purpose is to
 *   break the empirically observed revenge-trade loop (Task 36 evidence:
 *   2025-10-21 — SELL stopped at 4118.8, BUY re-entered 84 s later at 4119.9,
 *   then ANOTHER BUY at 4122.7 while the market trended up ~10 points: three
 *   consecutive losses chasing one move).
 *
 * Process-local in-memory state (single Next.js server process, single symbol
 * strategy) — deliberately NOT persisted: a server restart clears the pause,
 * which is the honest behaviour for a soft circuit breaker. Every transition
 * is still written to the SystemEvent audit trail by the writer.
 */

/** Module-scoped state — survives across requests, cleared on process restart. */
let lastLossAtMs: number | null = null;
let lastLossMeta: { positionId: string; direction: string; realizedPnlUsd: number } | null = null;

export interface LossRecord {
  positionId: string;
  direction: string;
  /** Realized PnL in USD (negative for a loss — the writer only records losses). */
  realizedPnlUsd: number;
  closedAtMs: number;
}

/** Record a realized loss (writer: position manager only). */
export function recordLoss(rec: LossRecord): void {
  lastLossAtMs = rec.closedAtMs;
  lastLossMeta = {
    positionId: rec.positionId,
    direction: rec.direction,
    realizedPnlUsd: rec.realizedPnlUsd,
  };
}

/**
 * Is the post-loss cooldown active at `nowMs`? Pure — the caller supplies the
 * clock so tests stay deterministic.
 */
export function lossCooldownActive(nowMs: number, cooldownSec: number): boolean {
  if (lastLossAtMs === null || cooldownSec <= 0) return false;
  return nowMs - lastLossAtMs < cooldownSec * 1000;
}

/** Seconds remaining in the active cooldown (0 when inactive) — for evidence/UI. */
export function lossCooldownRemainingSec(nowMs: number, cooldownSec: number): number {
  if (!lossCooldownActive(nowMs, cooldownSec)) return 0;
  return Math.ceil((lastLossAtMs! + cooldownSec * 1000 - nowMs) / 1000);
}

/** Read the last recorded loss (observability; null when none). */
export function lastLoss(): LossRecord | null {
  if (lastLossAtMs === null || lastLossMeta === null) return null;
  return { ...lastLossMeta, closedAtMs: lastLossAtMs };
}

/** Test/reset hook — NEVER call from production code paths. */
export function resetLossStateForTests(): void {
  lastLossAtMs = null;
  lastLossMeta = null;
}
