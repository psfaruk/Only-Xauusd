/**
 * XAUUSD AI Trading Agent — A10 Confluence Master (Phase 14, Task 34-g)
 * ----------------------------------------------------------------------------
 * Runs the eight specialist agents over one timeframe's closed candles and
 * fuses their reads into a single weighted confluence verdict.
 *
 * THE ICT/SMC ENTRY RECIPE (user directive — "sure signals, perfect entry"):
 *   1. STRUCTURE    (15) — a recent BOS/CHoCH in the trade direction.
 *   2. LIQUIDITY    (20) — a fresh stop-hunt sweep of the opposing side,
 *                          reclaimed (institutions harvested retail stops).
 *   3. POI          (20) — price at/beside a fresh order block or FVG in the
 *                          direction (the institutional entry footprint).
 *   4. KEY LEVELS   (10) — clear sky to the nearest opposing wall (≥ 0.8 ATR).
 *   5. PRICE ACTION (15) — an engulfing / displacement / pin confirmation on
 *                          the decision bar.
 *   6. MOMENTUM     (10) — EMA/RSI/displacement aligned with the direction.
 *   7. SESSION      ( 5) — inside a London/NY killzone.
 *   8. AMD          ( 5) — a Wyckoff-lite signature (spring/upthrust) or an
 *                          unfolding distribution leg.
 *   Total 100 → tiers: A ≥ 75 ("sure"), B ≥ 55 (default emission bar), C ≥ 40.
 *
 * HARD VETOES (a veto always blocks emission, regardless of score):
 *   · NEWS_BLACKOUT      — inside an approximate high-impact envelope (A7).
 *   · SR_WALL            — an opposing key level closer than 0.8 × ATR.
 *   · MOMENTUM_OPPOSED   — momentum score ≥ 50 AGAINST the direction.
 *   · PRICE_BEYOND_POI   — decision close beyond the POI edge by more than
 *                          entryToleranceAtr × ATR (chasing a run-away zone).
 *   · POI_VIOLATED       — decision close through the POI's invalidation
 *                          side (the zone the setup relies on is broken).
 *
 * DIRECTION RESOLUTION: BUY and SELL are scored independently (each agent
 * awards points to at most one side); the higher total wins, but only with a
 * margin ≥ directionMargin — otherwise NEUTRAL (no direction, no setup).
 *
 * PURITY: every input is a parameter (candles, evaluation instant, params).
 * No clock, no DB, no network, no console — the same input always yields the
 * same verdict. Weights come from SMC_AGENT_WEIGHTS (locked constants baked
 * into the persisted rules fingerprint).
 */

import type { AnalysisCandle } from '@/lib/analysis/types';
import { readAmd } from './agents/amd';
import { readKeyLevels } from './agents/levels';
import { readLiquidity } from './agents/liquidity';
import { readMomentum } from './agents/momentum';
import { readPoi } from './agents/poi';
import { readPriceAction } from './agents/price-action';
import { readSmcStructure } from './agents/structure';
import { readSessionState } from './sessions';
import {
  SMC_AGENT_WEIGHTS,
  SMC_TIER_THRESHOLDS,
  type SmcAgentParams,
  type SmcAgentVote,
  type SmcConfluenceEvidence,
  type SmcTfSummary,
  type SmcTier,
  type SmcVeto,
} from './types';

// ---------------------------------------------------------------------------
// Input / output contracts
// ---------------------------------------------------------------------------

export interface SmcIndicatorPeriods {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  atrPeriod: number;
}

export interface SmcConfluenceInput {
  candles: AnalysisCandle[];
  tfSec: number;
  digits: number | null;
  /** Evaluation instant (UTC sec) — drives the session/news read. */
  nowUtcSec: number;
  params: SmcAgentParams;
  indicatorPeriods: SmcIndicatorPeriods;
  /** Master switch for the news-blackout veto (config-driven). */
  newsBlackoutEnabled: boolean;
}

export interface SmcConfluenceResult {
  evidence: SmcConfluenceEvidence;
  summary: SmcTfSummary;
  /** True when direction resolved + score ≥ minScore + zero vetoes. */
  actionable: boolean;
}

// ---------------------------------------------------------------------------
// Per-direction scoring (BUY shown; SELL is the exact mirror)
// ---------------------------------------------------------------------------

interface DirectionalReads {
  structure: ReturnType<typeof readSmcStructure>;
  liquidity: ReturnType<typeof readLiquidity>;
  poi: ReturnType<typeof readPoi>;
  keyLevels: ReturnType<typeof readKeyLevels>;
  priceAction: ReturnType<typeof readPriceAction>;
  momentum: ReturnType<typeof readMomentum>;
  session: ReturnType<typeof readSessionState>;
  amd: ReturnType<typeof readAmd>;
  decisionClose: number;
  atr: number | null;
}

/** Pattern → direction/strength classes for the price-action scoring. */
const STRONG_PATTERNS_BUY = new Set(['BULLISH_ENGULFING', 'BULLISH_DISPLACEMENT']);
const STRONG_PATTERNS_SELL = new Set(['BEARISH_ENGULFING', 'BEARISH_DISPLACEMENT']);
const WEAK_PATTERNS_BUY = new Set(['BULLISH_PIN', 'BULLISH_REJECTION_WICK', 'HAMMER']);
const WEAK_PATTERNS_SELL = new Set(['BEARISH_PIN', 'BEARISH_REJECTION_WICK', 'SHOOTING_STAR']);

function scoreDirection(
  dir: 'BUY' | 'SELL',
  r: DirectionalReads,
  params: SmcAgentParams,
): { votes: SmcAgentVote[]; total: number } {
  const votes: SmcAgentVote[] = [];
  const bullish = dir === 'BUY';
  const atr = r.atr;
  const tol = atr !== null ? params.entryToleranceAtr * atr : 0;

  // ── 1) STRUCTURE (15) ─────────────────────────────────────────────────────
  {
    let score = 0;
    let reason = 'No directional structure event.';
    const ev = r.structure.lastEvent;
    const evMatches = ev !== null && (bullish ? ev.direction === 'bullish' : ev.direction === 'bearish');
    if (evMatches && ev !== null && r.structure.barsSinceEvent !== null) {
      const since = r.structure.barsSinceEvent;
      if (since <= params.maxBarsSinceEvent) {
        score = SMC_AGENT_WEIGHTS.STRUCTURE;
        reason = `${ev.type} ${ev.direction} ${since} bars ago.`;
      } else if (since <= 2 * params.maxBarsSinceEvent) {
        score = Math.round(SMC_AGENT_WEIGHTS.STRUCTURE / 2);
        reason = `${ev.type} ${ev.direction} ${since} bars ago (aging).`;
      } else {
        score = 0;
        reason = `${ev.type} ${ev.direction} too old (${since} bars).`;
      }
    } else if (bullish ? r.structure.trend === 'bullish' : r.structure.trend === 'bearish') {
      score = 5;
      reason = `Trend ${r.structure.trend} without a fresh break.`;
    }
    votes.push({
      agent: 'STRUCTURE',
      vote: score > 0 ? dir : 'NEUTRAL',
      weight: SMC_AGENT_WEIGHTS.STRUCTURE,
      score,
      reasonEn: reason,
    });
  }

  // ── 2) LIQUIDITY (20) ─────────────────────────────────────────────────────
  {
    let score = 0;
    let reason = 'No directional sweep.';
    const matching = r.liquidity.sweeps.filter((s) => (bullish ? s.direction === 'BULLISH' : s.direction === 'BEARISH'));
    const fresh = matching.find((s) => s.barsAgo <= params.maxBarsSinceSweep);
    if (fresh) {
      score = SMC_AGENT_WEIGHTS.LIQUIDITY;
      reason = `${fresh.direction === 'BULLISH' ? 'Sell-side' : 'Buy-side'} liquidity swept ${fresh.barsAgo} bars ago and reclaimed (${fresh.origin} ${fresh.levelText}).`;
    } else {
      const aging = matching.find((s) => s.barsAgo <= 2 * params.maxBarsSinceSweep);
      if (aging) {
        score = Math.round(SMC_AGENT_WEIGHTS.LIQUIDITY / 2);
        reason = `Sweep ${aging.barsAgo} bars ago (aging) at ${aging.levelText}.`;
      } else if (opposingSideDrawExists(r, bullish)) {
        score = 4;
        reason = bullish
          ? 'No sweep yet — unswept sell-side pool below is the draw.'
          : 'No sweep yet — unswept buy-side pool above is the draw.';
      }
    }
    votes.push({
      agent: 'LIQUIDITY',
      vote: score > 0 ? dir : 'NEUTRAL',
      weight: SMC_AGENT_WEIGHTS.LIQUIDITY,
      score,
      reasonEn: reason,
    });
  }

  // ── 3) POI (20) ───────────────────────────────────────────────────────────
  {
    let score = 0;
    let reason = 'No directional POI zone.';
    const zone = bullish ? r.poi.nearestBullish : r.poi.nearestBearish;
    if (zone) {
      const nearEdge = bullish ? zone.top : zone.bottom;
      const distance = Math.abs(r.decisionClose - nearEdge);
      if (r.decisionClose >= zone.bottom - tol && r.decisionClose <= zone.top + tol) {
        score = zone.fresh ? SMC_AGENT_WEIGHTS.POI : 12;
        reason = `Price at the ${zone.kind}${zone.fresh ? ' (fresh)' : ` (tested ${zone.timesTested}×)`} ${zone.bottomText}–${zone.topText}.`;
      } else if (atr !== null && distance <= 2 * atr) {
        score = zone.fresh ? 8 : 4;
        reason = `${zone.kind} ${zone.bottomText}–${zone.topText} sits ${distance.toFixed(2)} away.`;
      } else {
        score = 2;
        reason = `${zone.kind} ${zone.bottomText}–${zone.topText} too far (${distance.toFixed(2)}).`;
      }
    }
    votes.push({
      agent: 'POI',
      vote: score > 0 ? dir : 'NEUTRAL',
      weight: SMC_AGENT_WEIGHTS.POI,
      score,
      reasonEn: reason,
    });
  }

  // ── 4) KEY LEVELS (10) — clear sky to the opposing wall ───────────────────
  {
    let score = 0;
    let reason = 'No opposing level map.';
    const wall = bullish ? r.keyLevels.nearestAbove : r.keyLevels.nearestBelow;
    if (wall === null) {
      score = SMC_AGENT_WEIGHTS.KEY_LEVELS;
      reason = bullish ? 'Clear sky above — no resistance mapped.' : 'Clear sky below — no support mapped.';
    } else if (atr !== null) {
      const distance = Math.abs(wall.level - r.decisionClose);
      if (distance >= 1.5 * atr) {
        score = SMC_AGENT_WEIGHTS.KEY_LEVELS;
        reason = `Nearest ${wall.labelEn} ${wall.levelText} is ${(distance / atr).toFixed(1)}×ATR away.`;
      } else if (distance >= 0.8 * atr) {
        score = 5;
        reason = `Nearest ${wall.labelEn} ${wall.levelText} is close (${(distance / atr).toFixed(1)}×ATR).`;
      } else {
        score = 0;
        reason = `${wall.labelEn} wall at ${wall.levelText} blocks the path.`;
      }
    } else {
      score = 5;
      reason = `Opposing ${wall.labelEn} ${wall.levelText} mapped (ATR unavailable — no distance scoring).`;
    }
    votes.push({
      agent: 'KEY_LEVELS',
      vote: score > 0 ? dir : 'NEUTRAL',
      weight: SMC_AGENT_WEIGHTS.KEY_LEVELS,
      score,
      reasonEn: reason,
    });
  }

  // ── 5) PRICE ACTION (15) — the decision bar's own confirmation ────────────
  {
    let score = 0;
    let reason = 'No decision-bar pattern.';
    const p = r.priceAction.decisionPattern;
    if (p) {
      if ((bullish && STRONG_PATTERNS_BUY.has(p.kind)) || (!bullish && STRONG_PATTERNS_SELL.has(p.kind))) {
        score = SMC_AGENT_WEIGHTS.PRICE_ACTION;
        reason = `${p.kind} on the decision bar (strength ${p.strength.toFixed(2)}).`;
      } else if ((bullish && WEAK_PATTERNS_BUY.has(p.kind)) || (!bullish && WEAK_PATTERNS_SELL.has(p.kind))) {
        score = 8;
        reason = `${p.kind} on the decision bar (strength ${p.strength.toFixed(2)}).`;
      } else if (p.kind === 'INSIDE_BAR') {
        score = 0;
        reason = 'Inside bar — compression, no directional confirmation.';
      } else {
        reason = `${p.kind} points the other way for this direction.`;
      }
    }
    votes.push({
      agent: 'PRICE_ACTION',
      vote: score > 0 ? dir : 'NEUTRAL',
      weight: SMC_AGENT_WEIGHTS.PRICE_ACTION,
      score,
      reasonEn: reason,
    });
  }

  // ── 6) MOMENTUM (10) ──────────────────────────────────────────────────────
  {
    let score = 0;
    let reason = 'Momentum neutral.';
    const m = r.momentum.score;
    const aligned = bullish ? m >= 0 : m <= 0;
    const magnitude = Math.abs(m);
    if (aligned && magnitude >= 40) {
      score = SMC_AGENT_WEIGHTS.MOMENTUM;
      reason = `Momentum ${m.toFixed(0)} aligned.`;
    } else if (aligned && magnitude >= 20) {
      score = 5;
      reason = `Momentum ${m.toFixed(0)} weakly aligned.`;
    } else if (!aligned && magnitude >= 20) {
      reason = `Momentum ${m.toFixed(0)} opposed.`;
    }
    votes.push({
      agent: 'MOMENTUM',
      vote: score > 0 ? dir : 'NEUTRAL',
      weight: SMC_AGENT_WEIGHTS.MOMENTUM,
      score,
      reasonEn: reason,
    });
  }

  // ── 7) SESSION (5) ────────────────────────────────────────────────────────
  {
    let score = 0;
    let reason = 'Off hours.';
    const s = r.session;
    if (s.inKillzone) {
      score = SMC_AGENT_WEIGHTS.SESSION;
      reason = s.killzone === 'LONDON_KZ' ? 'London killzone.' : 'New York killzone.';
    } else if (s.active === 'LONDON' || s.active === 'NEW_YORK' || s.active === 'OVERLAP_LDN_NY') {
      score = 3;
      reason = `${s.active} session.`;
    } else if (s.active === 'ASIA') {
      score = 1;
      reason = 'Asia session (range-bound bias).';
    }
    votes.push({
      agent: 'SESSION',
      vote: score > 0 ? dir : 'NEUTRAL',
      weight: SMC_AGENT_WEIGHTS.SESSION,
      score,
      reasonEn: reason,
    });
  }

  // ── 8) AMD (5) ────────────────────────────────────────────────────────────
  {
    let score = 0;
    let reason = 'No AMD signature.';
    const a = r.amd;
    const sigMatches =
      a.signatureDirection !== null && (bullish ? a.signatureDirection === 'BULLISH' : a.signatureDirection === 'BEARISH');
    if (sigMatches) {
      score = SMC_AGENT_WEIGHTS.AMD;
      reason = `${a.signature} signature (${a.phase.toLowerCase()}).`;
    } else if (
      a.phase === 'DISTRIBUTION' &&
      r.structure.lastEvent !== null &&
      (bullish ? r.structure.lastEvent.direction === 'bullish' : r.structure.lastEvent.direction === 'bearish')
    ) {
      score = 3;
      reason = 'Distribution leg unfolding with directional structure.';
    }
    votes.push({
      agent: 'AMD',
      vote: score > 0 ? dir : 'NEUTRAL',
      weight: SMC_AGENT_WEIGHTS.AMD,
      score,
      reasonEn: reason,
    });
  }

  const total = votes.reduce((s, v) => s + v.score, 0);
  return { votes, total };
}

function opposingSideDrawExists(r: DirectionalReads, bullish: boolean): boolean {
  return bullish ? r.liquidity.nearestSellSide !== null : r.liquidity.nearestBuySide !== null;
}

// ---------------------------------------------------------------------------
// Vetoes for a resolved direction
// ---------------------------------------------------------------------------

function collectVetoes(
  dir: 'BUY' | 'SELL',
  r: DirectionalReads,
  params: SmcAgentParams,
  newsBlackoutEnabled: boolean,
): SmcVeto[] {
  const vetoes: SmcVeto[] = [];
  const bullish = dir === 'BUY';
  const atr = r.atr;
  const tol = atr !== null ? params.entryToleranceAtr * atr : 0;

  if (newsBlackoutEnabled && r.session.newsBlackout) vetoes.push('NEWS_BLACKOUT');

  if (atr !== null) {
    const wall = bullish ? r.keyLevels.nearestAbove : r.keyLevels.nearestBelow;
    if (wall !== null && Math.abs(wall.level - r.decisionClose) < 0.8 * atr) {
      vetoes.push('SR_WALL');
    }
  }

  const m = r.momentum.score;
  const opposed = bullish ? m <= -50 : m >= 50;
  if (opposed) vetoes.push('MOMENTUM_OPPOSED');

  const zone = bullish ? r.poi.nearestBullish : r.poi.nearestBearish;
  if (zone && atr !== null) {
    if (bullish && r.decisionClose > zone.top + tol) vetoes.push('PRICE_BEYOND_POI');
    if (!bullish && r.decisionClose < zone.bottom - tol) vetoes.push('PRICE_BEYOND_POI');
    if (bullish && r.decisionClose < zone.bottom - tol) vetoes.push('POI_VIOLATED');
    if (!bullish && r.decisionClose > zone.top + tol) vetoes.push('POI_VIOLATED');
  }

  return [...new Set(vetoes)];
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

export function tierForScore(score: number): SmcTier | null {
  if (score >= SMC_TIER_THRESHOLDS.A) return 'A';
  if (score >= SMC_TIER_THRESHOLDS.B) return 'B';
  if (score >= SMC_TIER_THRESHOLDS.C) return 'C';
  return null;
}

// ---------------------------------------------------------------------------
// The Confluence Master evaluation (one timeframe)
// ---------------------------------------------------------------------------

export function evaluateSmcConfluence(input: SmcConfluenceInput): SmcConfluenceResult {
  const { candles, params, indicatorPeriods, digits, nowUtcSec, tfSec } = input;
  const n = candles.length;
  const decisionClose = n > 0 ? candles[n - 1].close : 0;

  // ── Run the eight specialist agents ───────────────────────────────────────
  const structure = readSmcStructure(
    candles,
    { swingLeft: params.swingLeft, swingRight: params.swingRight, maxBarsSinceEvent: params.maxBarsSinceEvent },
    tfSec,
    digits,
  );
  const liquidity = readLiquidity(
    candles,
    {
      swingLeft: params.swingLeft,
      swingRight: params.swingRight,
      sweepLookbackBars: params.sweepLookbackBars,
      maxBarsSinceSweep: params.maxBarsSinceSweep,
      equalLevelAtrTol: params.equalLevelAtrTol,
      atrPeriod: indicatorPeriods.atrPeriod,
    },
    tfSec,
    digits,
  );
  const poi = readPoi(
    candles,
    {
      obMinDisplacementAtr: params.obMinDisplacementAtr,
      fvgMinGapAtr: params.fvgMinGapAtr,
      poiMaxTests: params.poiMaxTests,
      atrPeriod: indicatorPeriods.atrPeriod,
    },
    digits,
  );
  const keyLevels = readKeyLevels(
    candles,
    {
      swingLeft: params.swingLeft,
      swingRight: params.swingRight,
      roundNumberStep: params.roundNumberStep,
      keyLevelTolAtr: params.keyLevelTolAtr,
      atrPeriod: indicatorPeriods.atrPeriod,
    },
    digits,
    nowUtcSec,
  );
  const priceAction = readPriceAction(
    candles,
    { displacementAtr: params.displacementAtr, atrPeriod: indicatorPeriods.atrPeriod },
    digits,
  );
  const momentum = readMomentum(candles, {
    emaFastPeriod: indicatorPeriods.emaFastPeriod,
    emaSlowPeriod: indicatorPeriods.emaSlowPeriod,
    rsiPeriod: indicatorPeriods.rsiPeriod,
    atrPeriod: indicatorPeriods.atrPeriod,
    displacementAtr: params.displacementAtr,
  });
  const session = readSessionState(nowUtcSec, params.session);
  const amd = readAmd(
    candles,
    {
      amdLookbackBars: params.amdLookbackBars,
      amdMinRangeAtr: params.amdMinRangeAtr,
      atrPeriod: indicatorPeriods.atrPeriod,
      equalLevelAtrTol: params.equalLevelAtrTol,
    },
    digits,
  );

  const reads: DirectionalReads = {
    structure,
    liquidity,
    poi,
    keyLevels,
    priceAction,
    momentum,
    session,
    amd,
    decisionClose,
    atr: momentum.atr,
  };

  // ── Score both directions independently ───────────────────────────────────
  const buy = scoreDirection('BUY', reads, params);
  const sell = scoreDirection('SELL', reads, params);

  const leader: 'BUY' | 'SELL' = buy.total >= sell.total ? 'BUY' : 'SELL';
  const leaderVotes = leader === 'BUY' ? buy.votes : sell.votes;
  const totalScore = Math.max(buy.total, sell.total);
  const margin = Math.abs(buy.total - sell.total);
  const direction = margin >= params.directionMargin ? leader : null;

  const vetoes =
    direction !== null
      ? collectVetoes(direction, reads, params, input.newsBlackoutEnabled)
      : collectVetoes(leader, reads, params, input.newsBlackoutEnabled);

  const tier = tierForScore(totalScore);

  const evidence: SmcConfluenceEvidence = {
    direction,
    totalScore,
    tier,
    votes: leaderVotes,
    vetoes,
    structure,
    liquidity,
    poi,
    keyLevels,
    priceAction,
    momentum,
    session,
    amd,
    decisionCandleTimeUtcSec: n > 0 ? candles[n - 1].timeUtcSec : 0,
  };

  const topReasons = [...leaderVotes]
    .filter((v) => v.score > 0)
    .sort((a, b) => b.score - a.score || a.agent.localeCompare(b.agent))
    .slice(0, 3)
    .map((v) => v.reasonEn);

  const summary: SmcTfSummary = {
    score: totalScore,
    tier,
    direction,
    topReasons,
  };

  const actionable = direction !== null && totalScore >= params.minScore && vetoes.length === 0;

  return { evidence, summary, actionable };
}
