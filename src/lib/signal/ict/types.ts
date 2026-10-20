/**
 * XAUUSD AI Trading Agent — ICT/SMC Multi-Agent Confluence Types (Phase 14, Task 34-a)
 * ----------------------------------------------------------------------------
 * Single source of truth for the vocabulary of the ten deterministic
 * specialist agents that power the SMC_CONFLUENCE scalper model.
 *
 * DESIGN CONTRACTS (locked, same discipline as Phase 4/9/12):
 *   · Every agent is a PURE function over CLOSED candles + explicit parameters.
 *     No clock, no DB, no network, no look-ahead — a swing/zone/sweep becomes
 *     visible only after its right-side candles have closed.
 *   · Every numeric level keeps its canonical decimal text (`*Text`) so the
 *     persisted evidence renders the EXACT source price, never a re-rounded one.
 *   · "Retail vs institutional" semantics (user directive): retail stop-loss
 *     clusters sit beyond obvious swing/equal/session levels — they are the
 *     LIQUIDITY big players harvest. The Liquidity Agent maps those pools and
 *     detects sweeps (stop hunts); the Confluence Master only follows price
 *     AFTER the sweep is reclaimed (trading WITH smart money, never against it).
 *   · Weights are exported constants (sum = 100) and are baked into the rules
 *     fingerprint — the LLM can never read or alter them.
 */

import type { BreachEvent, StructuralTrend, SwingPoint } from '@/lib/analysis/types';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Bump on any change to agent rules or output shapes. */
export const SMC_ENGINE_VERSION = '14.0.0';

/** The eight scoring agents + their locked weights (sum = 100). */
export const SMC_AGENT_WEIGHTS = {
  STRUCTURE: 15,
  LIQUIDITY: 20,
  POI: 20,
  KEY_LEVELS: 10,
  PRICE_ACTION: 15,
  MOMENTUM: 10,
  SESSION: 5,
  AMD: 5,
} as const;

export type SmcAgentId = keyof typeof SMC_AGENT_WEIGHTS;

/** Confidence tiers of the confluence score (0–100). */
export type SmcTier = 'A' | 'B' | 'C';

export const SMC_TIER_THRESHOLDS: Readonly<Record<SmcTier, number>> = {
  A: 75, // "sure signal" — near-perfect confluence
  B: 55, // solid confluence — default emission threshold
  C: 40, // borderline — legacy momentum/reversal territory
};

// ---------------------------------------------------------------------------
// A7 — Session / News (ict/sessions.ts)
// ---------------------------------------------------------------------------

export type TradingSession = 'ASIA' | 'LONDON' | 'NEW_YORK' | 'OVERLAP_LDN_NY' | 'OFF_HOURS';

export type KillzoneName = 'LONDON_KZ' | 'NY_KZ';

export interface NewsWindow {
  /** Inclusive start (minutes from 00:00 UTC). */
  fromUtcMin: number;
  /** Exclusive end (minutes from 00:00 UTC). */
  toUtcMin: number;
  label: string; // e.g. 'US data (13:30 UTC envelope)'
}

export interface SessionState {
  /** Evaluation instant (UTC sec) — the engine is deterministic in it. */
  nowUtcSec: number;
  active: TradingSession;
  inKillzone: boolean;
  killzone: KillzoneName | null;
  /** True inside an approximate high-impact news envelope (hard veto). */
  newsBlackout: boolean;
  activeNewsWindow: NewsWindow | null;
  /** Session day-of-week (0=Sun…6=Sat, UTC). Weekend → OFF_HOURS + no killzone. */
  weekday: number;
  noteEn: string;
}

/** Config-driven news windows (approximate scheduled envelopes — honest:
 *  no live economic calendar is claimed). Materialized from config. */
export interface SmcSessionConfig {
  /** London killzone window (UTC minutes from midnight). */
  londonKzFromMin: number;
  londonKzToMin: number;
  /** New York killzone window (UTC minutes from midnight). */
  nyKzFromMin: number;
  nyKzToMin: number;
  /** Approximate high-impact news envelopes (UTC minutes). */
  newsWindows: readonly NewsWindow[];
  /** Minutes before/after a news window that also count as blackout. */
  newsBufferMin: number;
}

// ---------------------------------------------------------------------------
// A1 — Structure (agents/structure.ts)
// ---------------------------------------------------------------------------

export interface SmcDealingRange {
  high: number;
  low: number;
  /** ICT equilibrium: 50% of the dealing leg. */
  equilibrium: number;
  highText: string;
  lowText: string;
  equilibriumText: string;
}

export type PremiumDiscountZone = 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';

export interface SmcStructureRead {
  /** Structural trend from confirmed swings (Phase 4 semantics). */
  trend: StructuralTrend;
  /** Most recent BOS/CHoCH event (null when the window has none). */
  lastEvent: BreachEvent | null;
  /** Bars between the event's breaking candle and the decision bar. */
  barsSinceEvent: number | null;
  /** Dealing range of the current leg (last major swing high↔low). */
  dealingRange: SmcDealingRange | null;
  /** Where the decision close sits inside the dealing range. */
  zone: PremiumDiscountZone | null;
}

// ---------------------------------------------------------------------------
// A2 — Liquidity (agents/liquidity.ts)
// ---------------------------------------------------------------------------

/** Where the pool came from (all are classic RETAIL stop clusters). */
export type LiquidityOrigin =
  | 'SWING_HIGH'
  | 'SWING_LOW'
  | 'EQH'
  | 'EQL'
  | 'SESSION_HIGH'
  | 'SESSION_LOW';

export type PoolSide = 'BUY_SIDE' | 'SELL_SIDE';

export interface LiquidityPool {
  side: PoolSide; // BUY_SIDE = resting stops ABOVE price (short SLs + buy stops)
  level: number;
  levelText: string;
  origin: LiquidityOrigin;
  createdAtUtcSec: number; // swing/session-bar open time
  /** Approaches that touched within tolerance (more touches = juicier pool). */
  touches: number;
  swept: boolean;
  sweptAtUtcSec: number | null;
}

export interface LiquiditySweep {
  /** BULLISH = sell-side pool swept then price reclaimed above it
   *  (classic stop hunt → smart-money buy). BEARISH mirrors. */
  direction: 'BULLISH' | 'BEARISH';
  origin: LiquidityOrigin;
  level: number;
  levelText: string;
  /** How far the extreme wick went beyond the pool (price units, > 0). */
  wickBeyond: number;
  /** Close of the sweep candle came back to the safe side of the level. */
  reclaimed: boolean;
  sweepCandleTimeUtcSec: number;
  /** Bars between the sweep candle and the decision bar. */
  barsAgo: number;
}

export interface LiquidityRead {
  /** Unswept pools still magnetizing price (nearest first, capped). */
  pools: LiquidityPool[];
  /** Recent sweeps inside the lookback window (most recent first, capped). */
  sweeps: LiquiditySweep[];
  /** Nearest unswept BUY-side level above the decision close (SELL magnet). */
  nearestBuySide: number | null;
  /** Nearest unswept SELL-side level below the decision close (BUY magnet). */
  nearestSellSide: number | null;
  /** Equal-high cluster level above (EQH) / equal-low cluster level below (EQL). */
  eqhLevel: number | null;
  eqlLevel: number | null;
}

// ---------------------------------------------------------------------------
// A3 — POI (agents/poi.ts)
// ---------------------------------------------------------------------------

export type PoiZoneKind =
  | 'BULLISH_OB'
  | 'BEARISH_OB'
  | 'BULLISH_FVG'
  | 'BEARISH_FVG'
  | 'BULLISH_BREAKER'
  | 'BEARISH_BREAKER';

export interface PoiZone {
  kind: PoiZoneKind;
  top: number;
  bottom: number;
  topText: string;
  bottomText: string;
  /** Open time of the candle that created the zone. */
  createdAtUtcSec: number;
  /** Impulse displacement in ATR multiples of the creating leg (zone quality). */
  displacementAtr: number;
  /** True until price returns into the zone the first time. */
  fresh: boolean;
  mitigatedAtUtcSec: number | null;
  /** Times price traded into the zone after creation. */
  timesTested: number;
  /** False once a candle CLOSES through the invalidation side. */
  active: boolean;
  /** Time of the candle that closed through the zone (null while active). */
  violatedAtUtcSec: number | null;
}

export interface PoiRead {
  /** Active zones, nearest-to-price first (capped). */
  zones: PoiZone[];
  /** Nearest active bullish zone AT/BELOW the decision close (BUY entry POI). */
  nearestBullish: PoiZone | null;
  /** Nearest active bearish zone AT/ABOVE the decision close (SELL entry POI). */
  nearestBearish: PoiZone | null;
}

// ---------------------------------------------------------------------------
// A4 — Key Levels (agents/levels.ts)
// ---------------------------------------------------------------------------

export type KeyLevelKind =
  | 'RESISTANCE'
  | 'SUPPORT'
  | 'SUPPLY'
  | 'DEMAND'
  | 'PDH'
  | 'PDL'
  | 'SESSION_HIGH'
  | 'SESSION_LOW'
  | 'ROUND_NUMBER';

export interface KeyLevel {
  kind: KeyLevelKind;
  level: number;
  levelText: string;
  /** 0–100 — recency-weighted touch count + origin bonus (round/PD levels). */
  strength: number;
  labelEn: string;
  labelBn: string;
  originUtcSec: number | null;
}

export interface KeyLevelRead {
  levels: KeyLevel[];
  nearestAbove: KeyLevel | null;
  nearestBelow: KeyLevel | null;
}

// ---------------------------------------------------------------------------
// A5 — Price Action (agents/price-action.ts)
// ---------------------------------------------------------------------------

export type CandlePatternKind =
  | 'BULLISH_ENGULFING'
  | 'BEARISH_ENGULFING'
  | 'HAMMER'
  | 'SHOOTING_STAR'
  | 'BULLISH_PIN'
  | 'BEARISH_PIN'
  | 'INSIDE_BAR'
  | 'BULLISH_DISPLACEMENT'
  | 'BEARISH_DISPLACEMENT'
  | 'BULLISH_REJECTION_WICK'
  | 'BEARISH_REJECTION_WICK';

export interface CandlePattern {
  kind: CandlePatternKind;
  candleTimeUtcSec: number;
  /** 0–1 normalized strength (body/range ratios, wick dominance). */
  strength: number;
  noteEn: string;
}

export interface PriceActionRead {
  /** Patterns in the recent tail (most recent last, capped). */
  patterns: CandlePattern[];
  /** Pattern on the decision bar itself (the confirmation candle). */
  decisionPattern: CandlePattern | null;
}

// ---------------------------------------------------------------------------
// A6 — Momentum (agents/momentum.ts)
// ---------------------------------------------------------------------------

export type AtrRegime = 'LOW' | 'NORMAL' | 'HIGH';

export interface MomentumRead {
  /** Signed score −100…+100 (positive = bullish momentum). */
  score: number;
  emaAligned: 'BULL' | 'BEAR' | 'MIXED' | null;
  rsi: number | null;
  atr: number | null;
  atrRegime: AtrRegime | null;
  /** Decision-bar body in ATR multiples (≥1.0 = displacement-grade). */
  displacementStrength: number | null;
}

// ---------------------------------------------------------------------------
// A8 — AMD: Accumulation → Manipulation → Distribution (agents/amd.ts)
// ---------------------------------------------------------------------------

export type AmdPhase = 'ACCUMULATION' | 'MANIPULATION' | 'DISTRIBUTION' | 'UNCLEAR';

export type AmdSignature = 'SPRING' | 'UPTHRUST' | 'SWEEP_REVERSAL';

export interface AmdRead {
  phase: AmdPhase;
  /** Wyckoff-lite signature found in the recent window (null when none). */
  signature: AmdSignature | null;
  /** Signature direction (SPRING → bullish, UPTHRUST → bearish). */
  signatureDirection: 'BULLISH' | 'BEARISH' | null;
  rangeHigh: number | null;
  rangeLow: number | null;
  noteEn: string;
}

// ---------------------------------------------------------------------------
// A10 — Confluence Master (ict/confluence.ts)
// ---------------------------------------------------------------------------

export type SmcVote = 'BUY' | 'SELL' | 'NEUTRAL';

export interface SmcAgentVote {
  agent: SmcAgentId;
  vote: SmcVote;
  /** This agent's locked max weight (SMC_AGENT_WEIGHTS). */
  weight: number;
  /** Points actually awarded (0…weight). */
  score: number;
  reasonEn: string;
}

export type SmcVeto =
  | 'NEWS_BLACKOUT'
  | 'SR_WALL'
  | 'PRICE_BEYOND_POI'
  | 'POI_VIOLATED'
  | 'MOMENTUM_OPPOSED'
  | 'SPREAD_WIDE';

export interface SmcConfluenceSummary {
  direction: 'BUY' | 'SELL' | null;
  totalScore: number; // 0–100
  tier: SmcTier | null;
  votes: SmcAgentVote[];
  vetoes: SmcVeto[];
}

/** Full per-timeframe SMC evidence — persisted inside SignalEvidence.smc. */
export interface SmcConfluenceEvidence extends SmcConfluenceSummary {
  structure: SmcStructureRead;
  liquidity: LiquidityRead;
  poi: PoiRead;
  keyLevels: KeyLevelRead;
  priceAction: PriceActionRead;
  momentum: MomentumRead;
  session: SessionState;
  amd: AmdRead;
  /** Decision bar open time (UTC sec) the reads were computed on. */
  decisionCandleTimeUtcSec: number;
}

/** Compact per-TF chip summary (rendered for all three timeframes). */
export interface SmcTfSummary {
  score: number;
  tier: SmcTier | null;
  direction: 'BUY' | 'SELL' | null;
  /** Up to 3 human-readable reasons of the strongest agreeing agents. */
  topReasons: string[];
}

// ---------------------------------------------------------------------------
// A9 — Risk levels (ict/risk.ts) — derives SignalLevels from the SMC reads
// ---------------------------------------------------------------------------

export interface SmcLevelDerivationInput {
  direction: 'BUY' | 'SELL';
  poiZone: PoiZone | null;
  sweep: LiquiditySweep | null;
  decisionClose: number;
  atr: number | null;
  referencePrice: number;
  halfSpread: number;
  digits: number | null;
  /** Opposing liquidity level for the target (null → fixed RR fallback). */
  opposingLiquidity: number | null;
  rules: {
    slAtrBuffer: number;
    rewardRisk: number;
    minStopPrice: number;
    entryToleranceAtr: number;
  };
}

export type SmcLevelCode =
  | 'SMC_LEVELS_INVALID'
  | 'SMC_SL_TOO_TIGHT'
  | 'SMC_TP_TOO_CLOSE'
  | 'OK';

// ---------------------------------------------------------------------------
// Shared agent parameter bundle (materialized from config by the rules module)
// ---------------------------------------------------------------------------

export interface SmcAgentParams {
  /** Swing window for structure/liquidity (left/right closed bars). */
  swingLeft: number;
  swingRight: number;
  /** Max bars between a BOS/CHoCH and the decision bar for full structure points. */
  maxBarsSinceEvent: number;
  /** Lookback bars for sweep detection. */
  sweepLookbackBars: number;
  /** Max bars between sweep candle and decision bar (full liquidity points). */
  maxBarsSinceSweep: number;
  /** Equal-high/low tolerance in ATR multiples (≤ this = "equal"). */
  equalLevelAtrTol: number;
  /** Min displacement (ATR mult) for a valid order block / breaker. */
  obMinDisplacementAtr: number;
  /** FVG gap minimum in ATR multiples. */
  fvgMinGapAtr: number;
  /** POI entry tolerance beyond the zone edge, in ATR multiples. */
  entryToleranceAtr: number;
  /** SL buffer beyond sweep wick / POI extreme, in ATR multiples. */
  slAtrBuffer: number;
  /** Max POI tests before the zone is considered exhausted. */
  poiMaxTests: number;
  /** Session config (killzones + news envelopes). */
  session: SmcSessionConfig;
  /** Candle body/ATR threshold for displacement candles. */
  displacementAtr: number;
  /** AMD range lookback bars. */
  amdLookbackBars: number;
  /** Min range height in ATR multiples to call it a range at all. */
  amdMinRangeAtr: number;
  /** Emission threshold — minimum confluence score for SMC setups. */
  minScore: number;
  /** Required BUY-vs-SELL score margin, else NEUTRAL. */
  directionMargin: number;
  /** Round-number grid step for XAUUSD (price units). */
  roundNumberStep: number;
  /** Key-level touch tolerance in ATR multiples. */
  keyLevelTolAtr: number;
}

// Re-exported for convenience (single import surface for the agents).
export type { BreachEvent, StructuralTrend, SwingPoint };
