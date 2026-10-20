/**
 * XAUUSD AI Trading Agent — Risk Domain Types (Phase 7)
 * ----------------------------------------------------------------------------
 * Typed contract for the DETERMINISTIC risk gate. The engine that consumes
 * these types is pure: it never reads the clock, the DB or the network, and
 * the LLM is never asked to compute any of these numbers.
 *
 * RESEARCH/SAFETY GATE ONLY — a RiskCheckResult can never place an order.
 * It answers ONE question honestly: "IF this setup were taken, how much
 * position size would the limits allow?" Every failed check fails CLOSED.
 */

/** One named rule outcome inside a risk evaluation (audit-friendly). */
export interface RiskCheckDetail {
  /** Stable machine-readable rule id (e.g. EQUITY_AVAILABLE). */
  rule: string;
  passed: boolean;
  /** Human-readable explanation (Bengali, numbers embedded verbatim). */
  detail: string;
}

/** Full deterministic outcome of the risk gate for one signal. */
export interface RiskCheckResult {
  /** True ONLY when every rule passed (fail-closed conjunction). */
  passed: boolean;
  /** Position size in lots, or null when not computable (checks 1–3 gate). */
  lotSize: number | null;
  checks: RiskCheckDetail[];
  /** Evaluation instant (UTC ISO) — SUPPLIED BY THE CALLER; the engine never
   *  reads the clock (determinism requirement). */
  evaluatedAtUtc: string;
  accountEquity: number | null;
  accountBalance: number | null;
  /** equity × percentPerTrade / 100 — null when equity is unavailable. */
  riskAmount: number | null;
  /** |entry − stopLoss| in PRICE units — null when levels are invalid. */
  stopDistance: number | null;
}

/** Pure input for the risk engine. Every number is supplied by the caller
 *  (tool layer / service layer); the engine computes, it never fetches. */
export interface RiskCheckInput {
  /** SignalEvaluation id of the setup being risk-checked. */
  signalId: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  symbol: string;
  /** Current verified spread in PRICE units. NaN = honestly unavailable. */
  spread: number;
  /** Open exposure count supplied by the caller (simplified: approvals in
   *  the last UTC day — Phase 11 will supply real position counts). */
  existingOpenPositions: number;
  existingPendingApprovals: number;
  /** Approvals of THIS SAME setup (signalId) within the current UTC day. */
  sameSetupApprovedToday: number;
  /** Broker account equity in account currency — null = unavailable
   *  (the current bridge contract exposes no account endpoint). */
  equity: number | null;
  balance: number | null;
  symbolDigits: number | null;
  /** Value of a 1.00-lot position moving 1.0 price unit, in account
   *  currency (XAUUSD standard contract: 100 oz → 100 per $1 move per lot).
   *  Caller-supplied so the engine stays pure; null/≤0 fails honestly. */
  tickValuePerLot: number | null;
  /** Evaluation instant (UTC ISO). Supplied by the caller — REQUIRED for a
   *  meaningful audit row; the engine never calls Date.now() itself. */
  evaluatedAtUtc?: string;
}

/** Read-back shape of a persisted RiskCheck row (parsed, honest). */
export interface StoredRiskCheck {
  id: string;
  signalId: string;
  passed: boolean;
  checks: RiskCheckDetail[];
  createdAtUtc: string;
}

/** Aggregated counts for observability + the daily-limit checks. */
export interface RiskCheckCounts {
  totalRiskChecks: number;
  passedRiskChecks: number;
  failedRiskChecks: number;
  /** TradeApproval rows with status='approved' created since UTC midnight. */
  approvedToday: number;
  /** TradeApproval rows currently in status='pending'. */
  pendingApprovals: number;
}
