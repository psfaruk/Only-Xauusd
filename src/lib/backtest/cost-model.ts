/**
 * XAUUSD AI Trading Agent — Configurable Cost Model (Phase 10, §3)
 * ----------------------------------------------------------------------------
 * ONE documented, configurable cost model used by the Phase 10 validation
 * harness. Nothing here is presented as a verified broker fact unless it
 * actually is.
 *
 * VERIFIED FACTS (SymbolSpec, bridge-reported):
 *   · digits = 3 for XAUUSDm (the ONLY verified spec field).
 * UNVERIFIED — EXPLICIT ASSUMPTIONS (labeled on every result that uses them):
 *   · spreadPrice baseline 0.24 = CURRENT OBSERVATION (latest tick at harness
 *     run time), NOT historical spread — per-candle historical spread is not
 *     stored by the bridge (audit/phase10-backtest-integrity.md §5, L1).
 *   · slippagePrice per side = assumption (default 0.02).
 *   · commissionPricePerRoundTrip = 0 by default: no explicit commission is
 *     VERIFIED for this account type (spread-included pricing ASSUMED).
 *   · Position sizing / monetary P/L: BLOCKED — tickValue, contract size and
 *     volume constraints are NOT verified, so P/L stays in PRICE units and
 *     R-multiples. No monetary figure is ever produced from unverified specs.
 *
 * PHASE 10 EXECUTION CONVENTION (more conservative than Phase 9, documented):
 *   · entry execution = next bar's open ± (half-spread + slippage)  [same as Phase 9]
 *   · exit execution  = SL/target level ∓ (half-spread + slippage)  [NEW: Phase 9
 *     exited at the raw level, embedding only half-spread + 1×slippage in total;
 *     Phase 10 charges the SYMMETRIC full round trip: spread + 2×slippage + commission]
 *   · grossPrice = level-to-open P/L with NO cost adjustments (clean mid measure)
 *   · netPrice   = grossPrice − round-trip costs (always ≤ Phase 9 P/L for the
 *     same trade, given equal spread/slippage inputs — pinned by test)
 *
 * Deterministic: same inputs → same outputs, always.
 */

export interface CostModel {
  /** Full bid/ask spread in PRICE units (round trip). */
  spreadPrice: number;
  /** Extra slippage per side (entry and exit), PRICE units. */
  slippagePrice: number;
  /** Explicit commission per round trip in PRICE units (default 0 —
   *  assumption, not a verified broker fact). */
  commissionPrice: number;
  /** Provenance labels rendered with every result using this model. */
  labels: string[];
}

/** Baseline: current-observation spread + assumed slippage + assumed zero commission. */
export function baselineCostModel(observedSpreadPrice: number): CostModel {
  return {
    spreadPrice: observedSpreadPrice,
    slippagePrice: 0.02,
    commissionPrice: 0,
    labels: [
      `spread=${observedSpreadPrice} is a CURRENT OBSERVATION, not historical spread (per-candle spread is not stored)`,
      'slippage=0.02/side is an ASSUMPTION, not a verified fill study',
      'commission=0 is an ASSUMPTION (no verified commission schedule; spread-included pricing assumed)',
    ],
  };
}

/** Stressed scenarios — conservative sensitivity bounds (documented, never selected). */
export function stressCostModels(observedSpreadPrice: number): Array<{ name: string; model: CostModel }> {
  return [
    {
      name: 'baseline',
      model: baselineCostModel(observedSpreadPrice),
    },
    {
      name: 'stressed',
      model: {
        spreadPrice: Math.max(observedSpreadPrice * 1.6, 0.4),
        slippagePrice: 0.04,
        commissionPrice: 0,
        labels: [
          'STRESSED scenario: spread ×1.6 (min 0.40) + slippage 0.04/side — sensitivity bound, not a forecast',
        ],
      },
    },
    {
      name: 'high_stress',
      model: {
        spreadPrice: Math.max(observedSpreadPrice * 2.5, 0.6),
        slippagePrice: 0.06,
        commissionPrice: 0.05,
        labels: [
          'HIGH-STRESS scenario: spread ×2.5 (min 0.60) + slippage 0.06/side + commission 0.05 — worst-case bound, not a forecast',
        ],
      },
    },
  ];
}

export function validateCostModel(m: CostModel): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(m.spreadPrice) || m.spreadPrice < 0) problems.push('spreadPrice must be a finite number >= 0');
  if (!Number.isFinite(m.slippagePrice) || m.slippagePrice < 0) problems.push('slippagePrice must be a finite number >= 0');
  if (!Number.isFinite(m.commissionPrice) || m.commissionPrice < 0) problems.push('commissionPrice must be a finite number >= 0');
  return problems;
}

/** Execution price for an entry: BUY pays ask + slippage; SELL receives bid − slippage. */
export function entryExecutionPrice(
  direction: 'long' | 'short',
  rawOpenPrice: number,
  m: CostModel,
): number {
  const halfSpread = m.spreadPrice / 2;
  return direction === 'long'
    ? rawOpenPrice + halfSpread + m.slippagePrice
    : rawOpenPrice - halfSpread - m.slippagePrice;
}

/** Execution price for an exit at a raw level: SELL receives bid − slippage;
 *  BUY-cover pays ask + slippage. (Symmetric to the entry side.) */
export function exitExecutionPrice(
  direction: 'long' | 'short',
  rawLevelPrice: number,
  m: CostModel,
): number {
  const halfSpread = m.spreadPrice / 2;
  return direction === 'long'
    ? rawLevelPrice - halfSpread - m.slippagePrice
    : rawLevelPrice + halfSpread + m.slippagePrice;
}

/** Total round-trip modeled cost in PRICE units for one trade. */
export function roundTripCost(m: CostModel): number {
  return m.spreadPrice + 2 * m.slippagePrice + m.commissionPrice;
}

export interface CostedTradePnl {
  entryPrice: number;
  exitPrice: number;
  /** Level-to-open P/L with NO cost adjustments (clean gross measure). */
  grossPrice: number;
  /** Full round-trip modeled cost. */
  costsPrice: number;
  /** grossPrice − costsPrice. */
  netPrice: number;
}

/**
 * Full cost breakdown for a completed trade. The raw prices are the unadjusted
 * bar open (entry) and the SL/target level (exit); execution prices, gross,
 * costs and net are derived — kept SEPARATE so results can show before/after
 * costs honestly.
 */
export function applyCosts(
  direction: 'long' | 'short',
  rawOpenPrice: number,
  rawExitLevelPrice: number,
  m: CostModel,
): CostedTradePnl {
  const entryPrice = entryExecutionPrice(direction, rawOpenPrice, m);
  const exitPrice = exitExecutionPrice(direction, rawExitLevelPrice, m);
  const grossPrice = direction === 'long' ? rawExitLevelPrice - rawOpenPrice : rawOpenPrice - rawExitLevelPrice;
  const costsPrice = roundTripCost(m);
  return {
    entryPrice: Number(entryPrice.toFixed(10)),
    exitPrice: Number(exitPrice.toFixed(10)),
    grossPrice: Number(grossPrice.toFixed(10)),
    costsPrice: Number(costsPrice.toFixed(10)),
    netPrice: Number((grossPrice - costsPrice).toFixed(10)),
  };
}
