/**
 * XAUUSD AI Trading Agent — A4 Key Levels Agent (Phase 14, Task 34-e)
 * ----------------------------------------------------------------------------
 * PURE and DETERMINISTIC: closed candles + explicit parameters + the
 * evaluation instant (nowUtcSec — a PARAMETER, never a clock read) → one
 * KeyLevelRead out. No DB, no network, no console — identical input always
 * yields the identical output. Every level comes EXCLUSIVELY from the
 * supplied candles; nothing is ever fabricated.
 *
 * DOMAIN — the horizontal levels that act as magnets and walls for price:
 * swing resistance/support, institutional supply/demand clusters, the
 * previous UTC day's high/low (PDH/PDL), session highs/lows and the
 * psychological round-number grid of XAUUSD.
 *
 * LOCKED RULES (pinned by tests/ict/levels.test.ts):
 *   1. SWING LEVELS: every confirmed swing high (detectSwings — Phase 4
 *      semantics, visible only after its right-side bars have closed)
 *      STRICTLY ABOVE the decision close (last candle close) emits one
 *      'RESISTANCE' at swing.price; every confirmed swing low strictly
 *      below emits one 'SUPPORT'. Strength = min(90, 40 + 10 × touches)
 *      + 5 recency bonus when the swing is among the LAST 10 confirmed
 *      swings (the chronological mixed-kind swing list) — max 95. A
 *      TOUCH = a candle AFTER the swing's confirmation (index ≥
 *      swing.index + swingRight + 1 — the same causal visibility gate as
 *      the A2 pools; the right-side window and the confirmation candle
 *      itself never touch their own level) whose relevant extreme comes
 *      within keyLevelTolAtr × ATR of the level WITHOUT crossing it
 *      (crossing is strict: high > level for resistance, low < level for
 *      support; a candle exactly AT the level touches, a crossing candle
 *      never does). Crossing does NOT remove the level — the spec keeps
 *      broken swing levels as (weaker, touch-starved) references.
 *   2. SUPPLY/DEMAND: swing highs clustered by price — greedy clustering,
 *      sorted ascending, band anchored at each cluster's lowest member,
 *      every member within keyLevelTolAtr × ATR of the anchor. A cluster
 *      of ≥ 2 emits ONE 'SUPPLY' level at the cluster MAX (swing lows
 *      mirror into ONE 'DEMAND' at the cluster MIN) with strength
 *      min(95, 60 + 8 × member count) and the EARLIEST member's bar time
 *      as originUtcSec. A swing that belongs to a cluster NEVER also
 *      emits its individual RESISTANCE/SUPPORT level (deduplication).
 *      Clustering needs the ATR band — with ATR unavailable every swing
 *      stays a singleton. Clusters are formed per side from ALL swings
 *      of that side regardless of the decision close (same discipline as
 *      the A2 EQH/EQL pools); the above/below filter applies only to the
 *      singleton RESISTANCE/SUPPORT emission.
 *   3. PDH/PDL: from the candles of the PREVIOUS UTC day
 *      (previousUtcDayStartSec(nowUtcSec) ≤ t < utcDayStartSec(nowUtcSec)):
 *      PDH = max high, PDL = min low. Strength 80, originUtcSec = the
 *      previous-day start. Only when such candles exist — never fabricated.
 *   4. SESSION H/L: for each boundary of sessionBoundariesFor(nowUtcSec)
 *      (ASIA / LONDON / NEW_YORK of the CURRENT UTC day), when ≥ 5
 *      candles carry t ∈ [from, to): SESSION_HIGH = max high and
 *      SESSION_LOW = min low of that window, strength 50, originUtcSec =
 *      the session start. The CURRENT session also counts — its H/L is a
 *      LIVE level while the session is still forming.
 *   5. ROUND NUMBERS: on the roundNumberStep grid, the nearest multiple
 *      STRICTLY above and the nearest STRICTLY below the decision close —
 *      only those two, and only when within 2 × step distance of the
 *      close. Strength 70, originUtcSec null.
 *   6. ATR: the decision-bar ATR (LAST value of atrSeries(candles,
 *      atrPeriod)) is the single scalar behind the touch band and the
 *      clustering band. ATR unavailable (series shorter than the period)
 *      or a non-positive keyLevelTolAtr → NO clustering (singletons
 *      only) and touches stay 0 (the band is ATR-based). A non-positive
 *      ATR likewise disables both.
 *   7. DEDUP: two levels of DIFFERENT kinds within 0.05 price units of
 *      each other collapse into the higher-strength one (equal strength
 *      → the alphabetically-first kind). Same-kind levels never
 *      deduplicate each other. Deterministic walk: candidates ordered by
 *      strength desc, then kind alphabetically, then level ascending; a
 *      candidate is dropped when an already-kept level of a DIFFERENT
 *      kind lies within 0.05 of it.
 *   8. EMISSION: levels sorted by |level − decisionClose| ascending
 *      (ties: level ascending), capped at 14. nearestAbove /
 *      nearestBelow = the closest levels strictly above / strictly below
 *      the decision close, computed over the FULL deduplicated set (not
 *      the capped list — same discipline as the A2 magnets and the A3
 *      nearest POIs). Both null when none exists.
 *   9. Every level carries canonical decimal text via
 *      toCanonicalPrice(v, digits).text — persisted evidence never shows
 *      a re-rounded price. Empty candle input → { levels: [],
 *      nearestAbove: null, nearestBelow: null } — never fabricated.
 *
 * tfSec note: detectSwings requires a grid step for its confirmation
 * instants; those instants are NOT consumed here (this agent's causal
 * gate is index-based), so the step is derived from the first adjacent
 * candle pair (0 for a single candle, which can hold no swing). The
 * derived value never influences the read.
 */

import { atrSeries } from '@/lib/analysis/indicators';
import { detectSwings } from '@/lib/analysis/swings';
import type { AnalysisCandle, SwingPoint } from '@/lib/analysis/types';
import { toCanonicalPrice } from '@/lib/market/validation';
import {
  previousUtcDayStartSec,
  sessionBoundariesFor,
  utcDayStartSec,
  type SessionBoundary,
} from '@/lib/signal/ict/sessions';
import type { KeyLevel, KeyLevelKind, KeyLevelRead } from '@/lib/signal/ict/types';

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

/** Emission cap (spec: the most relevant levels, nearest-to-price first). */
const MAX_LEVELS = 14;

/** Different-kind collision band (price units) for the dedup rule. */
const DEDUP_EPS = 0.05;

/** Swings inside the trailing window that earn the +5 recency bonus. */
const RECENT_SWING_WINDOW = 10;

/** Minimum candles inside a session window for its H/L to exist. */
const SESSION_MIN_CANDLES = 5;

/** Round-number grid distance cap, in multiples of the step. */
const ROUND_MAX_STEPS = 2;

// ---------------------------------------------------------------------------
// Locked labels
// ---------------------------------------------------------------------------

const LABELS = {
  RESISTANCE: { en: 'Swing resistance', bn: 'সুইং রেজিস্ট্যান্স' },
  SUPPORT: { en: 'Swing support', bn: 'সুইং সাপোর্ট' },
  SUPPLY: { en: 'Supply zone', bn: 'সাপ্লাই জোন' },
  DEMAND: { en: 'Demand zone', bn: 'ডিমান্ড জোন' },
  PDH: { en: 'Previous day high', bn: 'আগের দিনের হাই' },
  PDL: { en: 'Previous day low', bn: 'আগের দিনের লো' },
  ROUND_NUMBER: { en: 'Round number', bn: 'রাউন্ড নাম্বার' },
} as const;

const SESSION_LABELS: Readonly<
  Record<SessionBoundary['session'], { highEn: string; highBn: string; lowEn: string; lowBn: string }>
> = {
  ASIA: {
    highEn: 'Asia session high',
    highBn: 'এশিয়ান সেশন হাই',
    lowEn: 'Asia session low',
    lowBn: 'এশিয়ান সেশন লো',
  },
  LONDON: {
    highEn: 'London session high',
    highBn: 'লন্ডন সেশন হাই',
    lowEn: 'London session low',
    lowBn: 'লন্ডন সেশন লো',
  },
  NEW_YORK: {
    highEn: 'New York session high',
    highBn: 'নিউ ইয়র্ক সেশন হাই',
    lowEn: 'New York session low',
    lowBn: 'নিউ ইয়র্ক সেশন লো',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLevel(
  kind: KeyLevelKind,
  level: number,
  strength: number,
  labelEn: string,
  labelBn: string,
  originUtcSec: number | null,
  digits: number | null,
): KeyLevel {
  return {
    kind,
    level,
    levelText: toCanonicalPrice(level, digits).text,
    strength,
    labelEn,
    labelBn,
    originUtcSec,
  };
}

/**
 * Deterministic greedy clustering (same algorithm as the A2 equal-level
 * pools): swings sorted by price (ties by index), band anchored at each
 * cluster's lowest price. Every member lies within `tol` of the anchor, so
 * the pairwise spread inside a cluster is ≤ tol.
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
 * Emit the swing-derived levels of ONE side: clusters of ≥ 2 → SUPPLY/DEMAND
 * (all swings of the side participate); singletons → RESISTANCE/SUPPORT only
 * when strictly above/below the decision close. Touches are counted with the
 * causal visibility gate (rule 1).
 */
function emitSwingSideLevels(
  sideSwings: SwingPoint[],
  side: 'high' | 'low',
  band: number | null,
  swingRight: number,
  recentSwings: ReadonlySet<SwingPoint>,
  candles: AnalysisCandle[],
  decisionClose: number,
  digits: number | null,
  levels: KeyLevel[],
): void {
  const clusters: SwingPoint[][] =
    band === null ? sideSwings.map((s) => [s]) : greedyPriceClusters(sideSwings, band);

  for (const members of clusters) {
    if (members.length >= 2) {
      // One SUPPLY at the cluster MAX / DEMAND at the cluster MIN (rule 2).
      let level = members[0].price;
      let originUtcSec = members[0].timeUtcSec;
      for (const m of members) {
        level = side === 'high' ? Math.max(level, m.price) : Math.min(level, m.price);
        originUtcSec = Math.min(originUtcSec, m.timeUtcSec);
      }
      const labels = side === 'high' ? LABELS.SUPPLY : LABELS.DEMAND;
      levels.push(
        makeLevel(
          side === 'high' ? 'SUPPLY' : 'DEMAND',
          level,
          Math.min(95, 60 + 8 * members.length),
          labels.en,
          labels.bn,
          originUtcSec,
          digits,
        ),
      );
      continue; // clustered swings never emit individual levels (rule 2)
    }

    const s = members[0];
    if (side === 'high' && !(s.price > decisionClose)) continue; // only above the close
    if (side === 'low' && !(s.price < decisionClose)) continue; // only below the close

    // Touches: post-confirmation approaches within the band, never a cross.
    let touches = 0;
    if (band !== null) {
      const firstVisible = s.index + swingRight + 1;
      for (let j = firstVisible; j < candles.length; j++) {
        const c = candles[j];
        if (side === 'high') {
          if (c.high > s.price) continue; // crossed the level — not a touch
          if (s.price - c.high <= band) touches += 1;
        } else {
          if (c.low < s.price) continue;
          if (c.low - s.price <= band) touches += 1;
        }
      }
    }
    const strength = Math.min(90, 40 + 10 * touches) + (recentSwings.has(s) ? 5 : 0);
    const labels = side === 'high' ? LABELS.RESISTANCE : LABELS.SUPPORT;
    levels.push(
      makeLevel(
        side === 'high' ? 'RESISTANCE' : 'SUPPORT',
        s.price,
        strength,
        labels.en,
        labels.bn,
        s.timeUtcSec,
        digits,
      ),
    );
  }
}

/** The two nearest round-number grid neighbors of the decision close (rule 5). */
function emitRoundLevels(
  decisionClose: number,
  step: number,
  digits: number | null,
  levels: KeyLevel[],
): void {
  if (!Number.isFinite(step) || step <= 0) return; // no grid — never fabricated
  const k = Math.floor(decisionClose / step);
  let below = k * step;
  if (below >= decisionClose) below -= step; // strictly below the close
  let above = k * step;
  if (above <= decisionClose) above += step; // strictly above the close
  if (above - decisionClose <= ROUND_MAX_STEPS * step) {
    levels.push(
      makeLevel('ROUND_NUMBER', above, 70, LABELS.ROUND_NUMBER.en, LABELS.ROUND_NUMBER.bn, null, digits),
    );
  }
  if (decisionClose - below <= ROUND_MAX_STEPS * step) {
    levels.push(
      makeLevel('ROUND_NUMBER', below, 70, LABELS.ROUND_NUMBER.en, LABELS.ROUND_NUMBER.bn, null, digits),
    );
  }
}

/** Alphabetical comparison for the deterministic tiebreaks. */
function kindAsc(a: KeyLevelKind, b: KeyLevelKind): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// The A4 Key Levels Agent read
// ---------------------------------------------------------------------------

/**
 * Map the horizontal key-level landscape around the decision close: swing
 * S/R, supply/demand clusters, PDH/PDL, session H/L and the round-number
 * grid. Pure — see the locked rules in the module header.
 *
 * Exported for the 34-g Confluence Master wiring: the params subset matches
 * the SmcAgentParams fields { swingLeft, swingRight, roundNumberStep,
 * keyLevelTolAtr, atrPeriod }.
 */
export function readKeyLevels(
  candles: AnalysisCandle[],
  params: {
    swingLeft: number;
    swingRight: number;
    roundNumberStep: number;
    keyLevelTolAtr: number;
    atrPeriod: number;
  },
  digits: number | null,
  nowUtcSec: number,
): KeyLevelRead {
  const n = candles.length;
  if (n === 0) {
    return { levels: [], nearestAbove: null, nearestBelow: null };
  }

  const decisionClose = candles[n - 1].close;

  // --- ATR: decision-bar scalar behind the touch/cluster band (rule 6) -----
  let atr: number | null = null;
  const atrResult = atrSeries(candles, params.atrPeriod);
  if (atrResult.ok) {
    const last = atrResult.series.values[atrResult.series.values.length - 1];
    atr = typeof last === 'number' && Number.isFinite(last) && last > 0 ? last : null;
  }
  const band = atr !== null && params.keyLevelTolAtr > 0 ? params.keyLevelTolAtr * atr : null;

  // --- swings → S/R + SUPPLY/DEMAND (rules 1–2) -----------------------------
  const tfSec = n >= 2 ? candles[1].timeUtcSec - candles[0].timeUtcSec : 0; // header note
  const detection = detectSwings(candles, {
    left: params.swingLeft,
    right: params.swingRight,
    tfSec,
    digits,
  });
  const swings = detection.swings;
  const recentSwings = new Set<SwingPoint>(swings.slice(Math.max(0, swings.length - RECENT_SWING_WINDOW)));

  const levels: KeyLevel[] = [];
  emitSwingSideLevels(
    swings.filter((s) => s.kind === 'high'),
    'high',
    band,
    params.swingRight,
    recentSwings,
    candles,
    decisionClose,
    digits,
    levels,
  );
  emitSwingSideLevels(
    swings.filter((s) => s.kind === 'low'),
    'low',
    band,
    params.swingRight,
    recentSwings,
    candles,
    decisionClose,
    digits,
    levels,
  );

  // --- PDH/PDL from the previous UTC day (rule 3) ---------------------------
  const dayStart = utcDayStartSec(nowUtcSec);
  const prevDayStart = previousUtcDayStartSec(nowUtcSec);
  const prevDayCandles = candles.filter(
    (c) => c.timeUtcSec >= prevDayStart && c.timeUtcSec < dayStart,
  );
  if (prevDayCandles.length > 0) {
    let pdh = prevDayCandles[0].high;
    let pdl = prevDayCandles[0].low;
    for (const c of prevDayCandles) {
      pdh = Math.max(pdh, c.high);
      pdl = Math.min(pdl, c.low);
    }
    levels.push(makeLevel('PDH', pdh, 80, LABELS.PDH.en, LABELS.PDH.bn, prevDayStart, digits));
    levels.push(makeLevel('PDL', pdl, 80, LABELS.PDL.en, LABELS.PDL.bn, prevDayStart, digits));
  }

  // --- session H/L of the current UTC day (rule 4) --------------------------
  for (const b of sessionBoundariesFor(nowUtcSec)) {
    const inWindow = candles.filter((c) => c.timeUtcSec >= b.fromUtcSec && c.timeUtcSec < b.toUtcSec);
    if (inWindow.length < SESSION_MIN_CANDLES) continue;
    let hi = inWindow[0].high;
    let lo = inWindow[0].low;
    for (const c of inWindow) {
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
    }
    const labels = SESSION_LABELS[b.session];
    levels.push(makeLevel('SESSION_HIGH', hi, 50, labels.highEn, labels.highBn, b.fromUtcSec, digits));
    levels.push(makeLevel('SESSION_LOW', lo, 50, labels.lowEn, labels.lowBn, b.fromUtcSec, digits));
  }

  // --- round-number grid (rule 5) --------------------------------------------
  emitRoundLevels(decisionClose, params.roundNumberStep, digits, levels);

  // --- dedup: different kinds within 0.05 keep the stronger (rule 7) --------
  const ordered = [...levels].sort(
    (a, b) => b.strength - a.strength || kindAsc(a.kind, b.kind) || a.level - b.level,
  );
  const kept: KeyLevel[] = [];
  for (const cand of ordered) {
    const clash = kept.some(
      (k) => k.kind !== cand.kind && Math.abs(k.level - cand.level) <= DEDUP_EPS,
    );
    if (!clash) kept.push(cand);
  }

  // --- emission: nearest-to-price first, capped; magnets over the full set --
  kept.sort(
    (a, b) =>
      Math.abs(a.level - decisionClose) - Math.abs(b.level - decisionClose) || a.level - b.level,
  );

  let nearestAbove: KeyLevel | null = null;
  let nearestBelow: KeyLevel | null = null;
  for (const l of kept) {
    if (l.level > decisionClose && (nearestAbove === null || l.level < nearestAbove.level)) {
      nearestAbove = l;
    }
    if (l.level < decisionClose && (nearestBelow === null || l.level > nearestBelow.level)) {
      nearestBelow = l;
    }
  }

  return {
    levels: kept.slice(0, MAX_LEVELS),
    nearestAbove,
    nearestBelow,
  };
}
