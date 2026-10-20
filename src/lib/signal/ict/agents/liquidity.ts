/**
 * XAUUSD AI Trading Agent — A2 Liquidity Agent (Phase 14, Task 34-c)
 * ----------------------------------------------------------------------------
 * PURE and DETERMINISTIC: closed candles + explicit parameters in → one
 * LiquidityRead out. No clock, no DB, no network, no console — identical
 * input always yields the identical output. Every pool and sweep comes
 * EXCLUSIVELY from the supplied candles; nothing is ever fabricated.
 *
 * DOMAIN — the retail-vs-institutional liquidity model (user directive):
 *   · BUY_SIDE pool  = resting stops ABOVE price (breakout buy stops + stop
 *     losses of short traders). They cluster just above obvious swing HIGHS
 *     and equal highs. SELL_SIDE pool = resting stops BELOW price (sell
 *     stops + long stop losses) under swing LOWS / equal lows. These retail
 *     stop clusters are the fuel institutions harvest ("draw on liquidity").
 *   · BULLISH sweep (stop hunt): a candle whose LOW pierces a SELL_SIDE pool
 *     level while its CLOSE reclaims back ABOVE it — smart money bought the
 *     dip into the resting stops. BEARISH sweep mirrors: HIGH pierces a
 *     BUY_SIDE pool, CLOSE back BELOW — smart money sold into the spike.
 *     Downstream confluence only ever trades WITH the reclaim, never against.
 *
 * IMPLEMENTATION RULES (LOCKED — mirrored by tests/ict/liquidity.test.ts):
 *   1. Swings come from detectSwings (Phase 4 semantics; its informational
 *      warnings are not surfaced — the caller's config governs the window).
 *      A swing — and every pool derived from it — becomes VISIBLE only AFTER
 *      its confirmation candle has closed: the first candle allowed to
 *      interact with the pool is at index swing.index + swingRight + 1 (its
 *      open time is ≥ the swing's confirmedAtUtcSec on a regular grid). No
 *      candle at or before the confirmation index can sweep or touch a pool.
 *   2. ATR = LAST value of atrSeries(candles, atrPeriod) — the decision-bar
 *      ATR, one deterministic scalar used for every tolerance below. If ATR
 *      is unavailable (< atrPeriod candles) it is treated as null: EQH/EQL
 *      clustering is skipped (plain swing pools are still returned) and
 *      touches stay 0 (the touch band is ATR-based).
 *   3. Pools: each swing high → BUY_SIDE pool at the swing price (origin
 *      SWING_HIGH); each swing low → SELL_SIDE pool (origin SWING_LOW).
 *      Equal-level upgrade: ≥2 confirmed swings on one side within
 *      equalLevelAtrTol·ATR of each other merge into ONE pool — EQH at the
 *      cluster MAX, EQL at the cluster MIN. Clustering is deterministic:
 *      swings sorted by price (ties by index), greedy band anchored at the
 *      cluster's lowest price, so every member lies within tol of the anchor
 *      (pairwise spread ≤ tol). A merged pool becomes visible only after its
 *      LAST member's confirmation and carries the EARLIEST member's bar time
 *      as createdAtUtcSec.
 *   4. Swept tracking (causal walk, chronological): the first visible candle
 *      whose high exceeds a BUY_SIDE level (low drops below a SELL_SIDE
 *      level) marks the pool swept at that candle's open time; once swept,
 *      the pool leaves the walk (never re-touched). Touches count visible
 *      candles that came within 0.10·ATR of the level WITHOUT exceeding it.
 *   5. Sweeps (stop hunts): candles inside the last sweepLookbackBars bars ×
 *      pools visible at the candle's time. BUY_SIDE pierce + close back
 *      below → BEARISH sweep (wickBeyond = high − level); SELL_SIDE pierce +
 *      close back above → BULLISH sweep (wickBeyond = level − low). One event
 *      per (candle, pool) pierce — a level may be raided repeatedly. Most
 *      recent first (ties: level ascending), capped at 10. reclaimed is true
 *      by construction. params.maxBarsSinceSweep is accepted for
 *      parameter-bundle symmetry with SmcAgentParams but is deliberately NOT
 *      an emission filter: the read reports every stop hunt inside the
 *      lookback window and each sweep carries barsAgo, so the Confluence
 *      Master applies its own ≤ maxBarsSinceSweep staleness discount.
 *   6. Output: only UNSWEPT pools, sorted by |level − decisionClose|
 *      (decisionClose = last candle close; ties: level ascending), capped at
 *      10. nearestBuySide / nearestSellSide = lowest unswept BUY_SIDE level
 *      strictly ABOVE / highest unswept SELL_SIDE level strictly BELOW the
 *      decision close (computed over the FULL unswept set, not the capped
 *      list). eqhLevel / eqlLevel mirror that for EQH / EQL origins. Every
 *      level carries its canonical decimal text (toCanonicalPrice(v,
 *      digits).text) — persisted evidence never shows a re-rounded price.
 *   7. Empty candle input → empty pools/sweeps and null levels.
 */

import { atrSeries } from '@/lib/analysis/indicators';
import { detectSwings } from '@/lib/analysis/swings';
import type { AnalysisCandle, SwingPoint } from '@/lib/analysis/types';
import { toCanonicalPrice } from '@/lib/market/validation';
import type {
  LiquidityOrigin,
  LiquidityPool,
  LiquidityRead,
  LiquiditySweep,
  PoolSide,
} from '@/lib/signal/ict/types';

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

/** Touch band in ATR multiples — how close an extreme must come to count. */
const TOUCH_TOL_ATR = 0.1;

/** Emission caps (spec: most relevant pools / most recent sweeps). */
const MAX_POOLS = 10;
const MAX_SWEEPS = 10;

// ---------------------------------------------------------------------------
// Internal working model
// ---------------------------------------------------------------------------

/**
 * Pool under construction. `visibleFromIndex` is the causal gate — the first
 * candle index allowed to interact with the pool (last confirmation index +
 * 1). It is stripped before emission.
 */
interface WorkingPool {
  side: PoolSide;
  level: number;
  levelText: string;
  origin: LiquidityOrigin;
  createdAtUtcSec: number;
  visibleFromIndex: number;
  touches: number;
  swept: boolean;
  sweptAtUtcSec: number | null;
}

/**
 * Deterministic greedy clustering: swings sorted by price (ties by index),
 * band anchored at each cluster's lowest price. Every member lies within
 * `tol` of the anchor, so the pairwise spread inside a cluster is ≤ tol.
 */
function greedyPriceClusters(swings: SwingPoint[], tol: number): SwingPoint[][] {
  const sorted = [...swings].sort((a, b) => a.price - b.price || a.index - b.index);
  const clusters: SwingPoint[][] = [];
  let current: SwingPoint[] = [];
  let anchorPrice = 0;
  for (const s of sorted) {
    if (current.length === 0) {
      current = [s];
      anchorPrice = s.price;
    } else if (s.price - anchorPrice <= tol) {
      current.push(s);
    } else {
      clusters.push(current);
      current = [s];
      anchorPrice = s.price;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * Build the working pools for one swing side. Singletons → plain SWING_HIGH /
 * SWING_LOW pools; clusters of ≥2 (only possible when ATR provided a
 * tolerance) → one EQH pool at the cluster MAX / EQL pool at the cluster MIN,
 * visible only after the LAST member's confirmation, created at the EARLIEST
 * member's bar time.
 */
function poolsFromSwings(
  swings: SwingPoint[],
  kind: 'high' | 'low',
  clusterTol: number | null,
  swingRight: number,
  digits: number | null,
): WorkingPool[] {
  const clusters: SwingPoint[][] =
    clusterTol === null ? swings.map((s) => [s]) : greedyPriceClusters(swings, clusterTol);

  const pools: WorkingPool[] = [];
  for (const members of clusters) {
    const merged = members.length >= 2;
    let level = members[0].price;
    let createdAtUtcSec = members[0].timeUtcSec;
    let lastConfirmationIndex = members[0].index + swingRight;
    for (const m of members) {
      level = kind === 'high' ? Math.max(level, m.price) : Math.min(level, m.price);
      createdAtUtcSec = Math.min(createdAtUtcSec, m.timeUtcSec);
      lastConfirmationIndex = Math.max(lastConfirmationIndex, m.index + swingRight);
    }
    pools.push({
      side: kind === 'high' ? 'BUY_SIDE' : 'SELL_SIDE',
      level,
      levelText: toCanonicalPrice(level, digits).text,
      origin: merged
        ? kind === 'high'
          ? 'EQH'
          : 'EQL'
        : kind === 'high'
          ? 'SWING_HIGH'
          : 'SWING_LOW',
      createdAtUtcSec,
      visibleFromIndex: lastConfirmationIndex + 1,
      touches: 0,
      swept: false,
      sweptAtUtcSec: null,
    });
  }
  return pools;
}

// ---------------------------------------------------------------------------
// The A2 Liquidity Agent read
// ---------------------------------------------------------------------------

/**
 * Map the ICT liquidity landscape of a closed-candle series: retail stop
 * pools (swing + equal-level), their sweep/stop-hunt raids, and the nearest
 * magnets around the decision close. Pure — see the locked rules in the
 * module header.
 */
export function readLiquidity(
  candles: AnalysisCandle[],
  params: {
    swingLeft: number;
    swingRight: number;
    sweepLookbackBars: number;
    maxBarsSinceSweep: number;
    equalLevelAtrTol: number;
    atrPeriod: number;
  },
  tfSec: number,
  digits: number | null,
): LiquidityRead {
  const n = candles.length;
  if (n === 0) {
    return {
      pools: [],
      sweeps: [],
      nearestBuySide: null,
      nearestSellSide: null,
      eqhLevel: null,
      eqlLevel: null,
    };
  }

  const lastIndex = n - 1;
  const decisionClose = candles[lastIndex].close;

  // --- ATR: decision-bar scalar, null when the series cannot warm up -------
  let atr: number | null = null;
  const atrResult = atrSeries(candles, params.atrPeriod);
  if (atrResult.ok) {
    const last = atrResult.series.values[atrResult.series.values.length - 1];
    atr = typeof last === 'number' && Number.isFinite(last) ? last : null;
  }
  const clusterTol = atr === null ? null : params.equalLevelAtrTol * atr;
  const touchTol = atr === null ? null : TOUCH_TOL_ATR * atr;

  // --- swings → pools -------------------------------------------------------
  const detection = detectSwings(candles, {
    left: params.swingLeft,
    right: params.swingRight,
    tfSec,
    digits,
  });
  const swingHighs = detection.swings.filter((s) => s.kind === 'high');
  const swingLows = detection.swings.filter((s) => s.kind === 'low');
  const pools: WorkingPool[] = [
    ...poolsFromSwings(swingHighs, 'high', clusterTol, params.swingRight, digits),
    ...poolsFromSwings(swingLows, 'low', clusterTol, params.swingRight, digits),
  ];

  // --- causal walk: first pierce sweeps the pool, near-misses touch it -----
  for (let j = 0; j < n; j++) {
    const c = candles[j];
    for (const p of pools) {
      if (p.swept || j < p.visibleFromIndex) continue;
      if (p.side === 'BUY_SIDE') {
        if (c.high > p.level) {
          p.swept = true;
          p.sweptAtUtcSec = c.timeUtcSec;
        } else if (touchTol !== null && p.level - c.high <= touchTol) {
          p.touches += 1;
        }
      } else if (c.low < p.level) {
        p.swept = true;
        p.sweptAtUtcSec = c.timeUtcSec;
      } else if (touchTol !== null && c.low - p.level <= touchTol) {
        p.touches += 1;
      }
    }
  }

  // --- sweep scan: wick-and-reclaim stop hunts inside the lookback window --
  const sweeps: LiquiditySweep[] = [];
  const scanFrom = Math.max(0, n - params.sweepLookbackBars);
  for (let j = scanFrom; j <= lastIndex; j++) {
    const c = candles[j];
    for (const p of pools) {
      if (j < p.visibleFromIndex) continue;
      if (p.side === 'BUY_SIDE') {
        if (c.high > p.level && c.close < p.level) {
          sweeps.push({
            direction: 'BEARISH',
            origin: p.origin,
            level: p.level,
            levelText: p.levelText,
            wickBeyond: c.high - p.level,
            reclaimed: true,
            sweepCandleTimeUtcSec: c.timeUtcSec,
            barsAgo: lastIndex - j,
          });
        }
      } else if (c.low < p.level && c.close > p.level) {
        sweeps.push({
          direction: 'BULLISH',
          origin: p.origin,
          level: p.level,
          levelText: p.levelText,
          wickBeyond: p.level - c.low,
          reclaimed: true,
          sweepCandleTimeUtcSec: c.timeUtcSec,
          barsAgo: lastIndex - j,
        });
      }
    }
  }
  sweeps.sort((a, b) => b.sweepCandleTimeUtcSec - a.sweepCandleTimeUtcSec || a.level - b.level);
  const outSweeps = sweeps.slice(0, MAX_SWEEPS);

  // --- emission: unswept pools nearest-first + magnet levels ---------------
  const unswept = pools.filter((p) => !p.swept);
  unswept.sort(
    (a, b) =>
      Math.abs(a.level - decisionClose) - Math.abs(b.level - decisionClose) || a.level - b.level,
  );
  const outPools: LiquidityPool[] = unswept.slice(0, MAX_POOLS).map((p) => ({
    side: p.side,
    level: p.level,
    levelText: p.levelText,
    origin: p.origin,
    createdAtUtcSec: p.createdAtUtcSec,
    touches: p.touches,
    swept: p.swept,
    sweptAtUtcSec: p.sweptAtUtcSec,
  }));

  let nearestBuySide: number | null = null;
  let nearestSellSide: number | null = null;
  let eqhLevel: number | null = null;
  let eqlLevel: number | null = null;
  for (const p of unswept) {
    if (p.side === 'BUY_SIDE' && p.level > decisionClose && (nearestBuySide === null || p.level < nearestBuySide)) {
      nearestBuySide = p.level;
    }
    if (p.side === 'SELL_SIDE' && p.level < decisionClose && (nearestSellSide === null || p.level > nearestSellSide)) {
      nearestSellSide = p.level;
    }
    if (p.origin === 'EQH' && p.level > decisionClose && (eqhLevel === null || p.level < eqhLevel)) {
      eqhLevel = p.level;
    }
    if (p.origin === 'EQL' && p.level < decisionClose && (eqlLevel === null || p.level > eqlLevel)) {
      eqlLevel = p.level;
    }
  }

  return {
    pools: outPools,
    sweeps: outSweeps,
    nearestBuySide,
    nearestSellSide,
    eqhLevel,
    eqlLevel,
  };
}
