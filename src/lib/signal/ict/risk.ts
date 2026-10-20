/**
 * XAUUSD AI Trading Agent — A9 Risk Agent (Phase 14, Task 34-g)
 * ----------------------------------------------------------------------------
 * Derives validated SignalLevels from the SMC reads: entry from the live
 * price at the POI, stop-loss beyond the sweep wick / POI extreme, target at
 * the opposing liquidity pool (draw on liquidity) with a fixed-RR cap and a
 * too-close-magnet rejection.
 *
 * LOCKED RULES (pinned by tests):
 *   · ENTRY  = live reference ± half spread (ask-side for BUY, bid-side for
 *     SELL) — a scalper enters at the market the moment the confluence
 *     clears; the POI zone defines the entry ZONE (rendered), not a limit.
 *   · ENTRY ZONE = the directional POI zone [bottom, top] when one exists
 *     (price is at/beside it by construction — the PRICE_BEYOND_POI veto
 *     already fired otherwise); degenerate [entry, entry] otherwise.
 *   · STOP-LOSS base (BUY): the MINIMUM of {POI bottom, sweep-wick low
 *     (pool level − wickBeyond), decision close}; SELL mirrors with the
 *     MAXIMUM. Buffer = slAtrBuffer × ATR beyond that base. ATR null →
 *     SMC_LEVELS_INVALID (fail-closed — no fabricated volatility).
 *   · TARGET: the nearest OPPOSING liquidity level when it lies ≥ 1.0 × risk
 *     away, capped at entry ± rewardRisk × risk (never chase a distant
 *     magnet beyond the fixed RR); opposing magnet closer than 1.0 × risk →
 *     SMC_TP_TOO_CLOSE (setup skipped — the RR is untradable); no opposing
 *     level → entry ± rewardRisk × risk.
 *   · Validation: risk > 0, risk ≥ minStopPrice (SMC_SL_TOO_TIGHT below it),
 *     strict level ordering, finite values (SMC_LEVELS_INVALID otherwise).
 *     Canonical decimal text on every level.
 */

import { toCanonicalPrice } from '@/lib/market/validation';
import type { SignalLevels } from '../types';
import type { SmcLevelCode, SmcLevelDerivationInput } from './types';

export function deriveSmcLevels(
  input: SmcLevelDerivationInput,
): { ok: boolean; levels: SignalLevels | null; code: SmcLevelCode } {
  const { direction, poiZone, sweep, decisionClose, atr, referencePrice, halfSpread, digits } = input;
  const { slAtrBuffer, rewardRisk, minStopPrice } = input.rules;

  const fail = (code: SmcLevelCode): { ok: boolean; levels: SignalLevels | null; code: SmcLevelCode } => ({
    ok: false,
    levels: null,
    code,
  });

  if (atr === null || !Number.isFinite(atr) || atr <= 0) return fail('SMC_LEVELS_INVALID');
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return fail('SMC_LEVELS_INVALID');
  if (!Number.isFinite(decisionClose) || decisionClose <= 0) return fail('SMC_LEVELS_INVALID');

  const entry = direction === 'BUY' ? referencePrice + halfSpread : referencePrice - halfSpread;

  // ── Stop-loss base: beyond every structural anchor ────────────────────────
  const anchors: number[] = [decisionClose];
  if (poiZone) anchors.push(direction === 'BUY' ? poiZone.bottom : poiZone.top);
  if (sweep) {
    // The sweep wick's extreme beyond the swept pool.
    anchors.push(direction === 'BUY' ? sweep.level - sweep.wickBeyond : sweep.level + sweep.wickBeyond);
  }
  const slBase = direction === 'BUY' ? Math.min(...anchors) : Math.max(...anchors);
  const stopLoss = direction === 'BUY' ? slBase - slAtrBuffer * atr : slBase + slAtrBuffer * atr;

  const risk = direction === 'BUY' ? entry - stopLoss : stopLoss - entry;
  if (!Number.isFinite(risk) || risk <= 0) return fail('SMC_LEVELS_INVALID');
  if (risk < minStopPrice) return fail('SMC_SL_TOO_TIGHT');

  // ── Target: opposing liquidity with the fixed-RR cap ──────────────────────
  const fixedReward = rewardRisk * risk;
  let target: number;
  const opposing = input.opposingLiquidity;
  if (opposing !== null && Number.isFinite(opposing) && opposing > 0) {
    const opposingReward = direction === 'BUY' ? opposing - entry : entry - opposing;
    if (opposingReward < 1.0 * risk) {
      // The magnet sits closer than one risk unit — the trade has no room.
      return fail('SMC_TP_TOO_CLOSE');
    }
    // Cap: never project further than the fixed RR multiple.
    target =
      opposingReward > fixedReward
        ? direction === 'BUY'
          ? entry + fixedReward
          : entry - fixedReward
        : opposing;
  } else {
    target = direction === 'BUY' ? entry + fixedReward : entry - fixedReward;
  }

  const reward = direction === 'BUY' ? target - entry : entry - target;

  const ordered =
    direction === 'BUY' ? stopLoss < entry && entry < target : stopLoss > entry && entry > target;
  if (!ordered || !Number.isFinite(target) || !Number.isFinite(stopLoss) || reward <= 0) {
    return fail('SMC_LEVELS_INVALID');
  }

  // ── Entry zone: the POI when present, degenerate otherwise ────────────────
  const entryZoneLow = poiZone ? Math.min(poiZone.bottom, poiZone.top) : entry;
  const entryZoneHigh = poiZone ? Math.max(poiZone.bottom, poiZone.top) : entry;

  const fmt = (v: number) => toCanonicalPrice(v, digits).text;
  return {
    ok: true,
    code: 'OK',
    levels: {
      direction,
      entryZoneLow,
      entryZoneHigh,
      entryReference: entry,
      stopLoss,
      target,
      riskPrice: risk,
      rewardPrice: reward,
      rewardRiskRatio: risk > 0 ? Number((reward / risk).toFixed(6)) : 0,
      entryZoneLowText: fmt(entryZoneLow),
      entryZoneHighText: fmt(entryZoneHigh),
      stopLossText: fmt(stopLoss),
      targetText: fmt(target),
      entryReferenceText: fmt(entry),
    },
  };
}
