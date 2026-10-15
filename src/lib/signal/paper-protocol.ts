/**
 * XAUUSD AI Trading Agent — Forward Paper Validation Protocol (Phase 10.2)
 * ----------------------------------------------------------------------------
 * PRE-REGISTERED rules for forward paper validation of the PRODUCTION
 * deterministic signal strategy (hybrid-structure-retest — NOTHING about the
 * strategy changes in this phase; strategyVersion stays pinned in
 * src/lib/signal/rules.ts).
 *
 * Pre-registration statement (audit/phase10.2-forward-paper-protocol.md):
 * these constants and rules were fixed and committed BEFORE any forward
 * paper outcome existed — the PaperSignalOutcome table held exactly 0 rows at
 * registration time (verified 2026-10-15T16:16:05Z against the live DB).
 * They exist so the eventual verdict CANNOT be shaped by accumulating
 * results. Amendments are FORBIDDEN by silent edit: a new protocol version
 * string plus full disclosure is required.
 *
 * What this module can never do: place, modify or close a broker order — no
 * such code exists anywhere in this project (four execution locks verified).
 */

// ---------------------------------------------------------------------------
// Pre-registered constants
// ---------------------------------------------------------------------------

export const FORWARD_PAPER_PROTOCOL_VERSION = 'phase10.2-forward-paper/1';
export const FORWARD_PAPER_RULES_VERSION = 'phase10.2-forward-paper-rules/1';

/**
 * Counting starts here. No PaperSignalOutcome rows existed at this moment
 * (table verified empty 2026-10-15T16:16:05Z; the autonomous evaluation loop
 * starts only AFTER this module is deployed, so nothing can pre-date it).
 */
export const FORWARD_PAPER_ACTIVATED_AT_ISO = '2026-10-15T16:30:00Z';

/**
 * Pre-registered interpretability floor — the SAME ≥ 20 completed-trade
 * floor pre-registered in Phase 10 (audit/phase10-backtest-integrity.md §9).
 * Deliberately NOT changed (Phase 10.1 rule: pre-registered OOS sample
 * thresholds stay untouched).
 */
export const FORWARD_PAPER_MIN_COMPLETED_TRADES = 20;

/**
 * Hard observation cap counted from activation. If fewer than the floor of
 * completed trades exist by the deadline → INCONCLUSIVE_TIMEOUT; extending
 * the window or redesigning is a SEPARATE explicit user decision, never a
 * silent rule change.
 */
export const FORWARD_PAPER_OBSERVATION_WINDOW_DAYS = 90;

/**
 * Single best trade may contribute at most 35% of total net wins — the same
 * pre-registered concentration limit as Phase 10.
 */
export const FORWARD_PAPER_MAX_TOP1_NET_SHARE = 0.35;

/**
 * Risk-profile gates (pre-registered BEFORE any forward outcome existed):
 * more than 8 consecutive net losses, OR a net-R drawdown deeper than 10R,
 * makes the evidence INCONCLUSIVE for continuing even if net P/L > 0.
 * (These implement the user's Phase 11 condition: drawdown and consecutive
 * loss acceptability must be DETERMINED in advance — here it is.)
 */
export const FORWARD_PAPER_MAX_CONSECUTIVE_LOSSES = 8;
export const FORWARD_PAPER_MAX_DRAWDOWN_R = 10;

export const FORWARD_PAPER_DISCLAIMER =
  'Forward paper results are NOT a profitability claim and do NOT authorize Phase 11 demo execution. Phase 11 requires separate explicit user authorization plus all five pre-agreed conditions (sufficient independent out-of-sample data, acceptable results under realistic spread/slippage/commission, pre-determined drawdown & consecutive-loss acceptability, forward-vs-backtest consistency, four execution locks intact).';

export function forwardPaperActivatedMs(): number {
  return Date.parse(FORWARD_PAPER_ACTIVATED_AT_ISO);
}

export function forwardPaperDeadlineMs(): number {
  return forwardPaperActivatedMs() + FORWARD_PAPER_OBSERVATION_WINDOW_DAYS * 86_400_000;
}

// ---------------------------------------------------------------------------
// Counting — the pre-registered FIRST-OPEN rule (one-position model)
// ---------------------------------------------------------------------------

/**
 * Minimal, deterministic projection of a PaperSignalOutcome row.
 * Times are epoch milliseconds.
 */
export interface ForwardPaperRowInput {
  id: string;
  direction: string;
  signalCreatedAtMs: number;
  status: string; // 'open' | 'resolved'
  outcome: string | null; // stopped | targeted | invalidated | expired
  netPnlPrice: number | null;
  rMultiple: number | null;
  resolutionBarTimeMs: number | null;
  resolvedAtMs: number | null;
}

export interface ForwardPaperCounting {
  /** Counted trades — the first observation of each position window. */
  counted: ForwardPaperRowInput[];
  /** Repeat observations of an already-open counted trade — NEVER independent
   *  trades (the user's Phase 10.1 rule, now pre-registered for forward). */
  repeats: ForwardPaperRowInput[];
}

/** When did a counted trade stop occupying the single paper position? */
function tradeEndMs(row: ForwardPaperRowInput): number | null {
  if (row.status !== 'resolved') return null; // still open
  return row.resolutionBarTimeMs ?? row.resolvedAtMs ?? row.signalCreatedAtMs;
}

/**
 * FIRST-OPEN rule (pre-registered): walk rows in chronological order
 * (signalCreatedAtMs, then id). The first row opens the (single) paper
 * position. Every further setup observation that arrives while that position
 * is open — i.e. before its resolution bar/time — is a REPEAT, not a new
 * trade. Once the position resolves, the next setup observation opens a new
 * counted trade. This mirrors EXACTLY the one-position model the Phase 10.1
 * audit verified in the backtests (all 33 skipped fills = POSITION_OPEN), so
 * forward paper results stay comparable with backtest results.
 */
export function applyFirstOpenRule(rows: ForwardPaperRowInput[]): ForwardPaperCounting {
  const sorted = [...rows].sort(
    (a, b) =>
      a.signalCreatedAtMs - b.signalCreatedAtMs ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const counted: ForwardPaperRowInput[] = [];
  const repeats: ForwardPaperRowInput[] = [];
  let openUntilMs: number | null = null; // null = current counted trade still open

  for (const row of sorted) {
    if (counted.length === 0) {
      counted.push(row);
      openUntilMs = tradeEndMs(row);
      continue;
    }
    const stillOpen = openUntilMs === null || openUntilMs >= row.signalCreatedAtMs;
    if (stillOpen) {
      repeats.push(row);
    } else {
      counted.push(row);
      openUntilMs = tradeEndMs(row);
    }
  }
  return { counted, repeats };
}

// ---------------------------------------------------------------------------
// Metrics — SAME conventions as the Phase 10 validation harness
// (src/lib/backtest/validation.ts computeSegmentMetrics / concentrationOf)
// ---------------------------------------------------------------------------

export interface ForwardPaperDirectionStat {
  trades: number;
  wins: number;
  netPnlPrice: number;
}

export interface ForwardPaperMetrics {
  /** Completed counted trades with OBSERVABLE net P/L. */
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnlPrice: number;
  /** Sum of positive net P/L (validation.ts "grossWin" convention). */
  grossWinPrice: number;
  /** |Sum of negative net P/L|. */
  grossLossPrice: number;
  profitFactor: number | null;
  sumR: number;
  avgR: number | null;
  /** Peak-to-trough of cumulative net R — positive magnitude (0 when none). */
  maxDrawdownR: number;
  maxConsecutiveLosses: number;
  /** Best trade's net P/L / total net wins (null when no wins). */
  top1NetShare: number | null;
  byDirection: { BUY: ForwardPaperDirectionStat; SELL: ForwardPaperDirectionStat };
}

/**
 * Metrics over COUNTED trades that completed with observable P/L
 * (status resolved AND netPnlPrice !== null). Open trades and
 * expired-unobservable rows (net P/L honestly null) are EXCLUDED from every
 * metric and disclosed separately — they are never invented.
 */
export function computeForwardPaperMetrics(counted: ForwardPaperRowInput[]): ForwardPaperMetrics | null {
  const completed = counted.filter(
    (t) => t.status === 'resolved' && t.netPnlPrice !== null && t.rMultiple !== null,
  );
  if (completed.length === 0) return null;

  const wins = completed.filter((t) => (t.netPnlPrice ?? 0) > 0);
  const losses = completed.filter((t) => (t.netPnlPrice ?? 0) <= 0);
  const net = completed.reduce((s, t) => s + (t.netPnlPrice ?? 0), 0);
  const grossWin = wins.reduce((s, t) => s + (t.netPnlPrice ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.netPnlPrice ?? 0), 0));
  const sumR = completed.reduce((s, t) => s + (t.rMultiple ?? 0), 0);

  let equity = 0;
  let peak = 0;
  let dd = 0;
  let streakL = 0;
  let maxL = 0;
  for (const t of completed) {
    equity += t.rMultiple ?? 0;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    if ((t.netPnlPrice ?? 0) > 0) {
      streakL = 0;
    } else {
      streakL += 1;
      maxL = Math.max(maxL, streakL);
    }
  }

  const dirStat = (dir: string): ForwardPaperDirectionStat => {
    const rows = completed.filter((t) => t.direction === dir);
    return {
      trades: rows.length,
      wins: rows.filter((t) => (t.netPnlPrice ?? 0) > 0).length,
      netPnlPrice: Number(rows.reduce((s, t) => s + (t.netPnlPrice ?? 0), 0).toFixed(4)),
    };
  };

  return {
    trades: completed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Number((wins.length / completed.length).toFixed(4)),
    netPnlPrice: Number(net.toFixed(4)),
    grossWinPrice: Number(grossWin.toFixed(4)),
    grossLossPrice: Number(grossLoss.toFixed(4)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(4)) : null,
    sumR: Number(sumR.toFixed(4)),
    avgR: Number((sumR / completed.length).toFixed(4)),
    maxDrawdownR: Number(dd.toFixed(4)),
    maxConsecutiveLosses: maxL,
    top1NetShare: grossWin > 0 ? Number((Math.max(...wins.map((t) => t.netPnlPrice ?? 0)) / grossWin).toFixed(4)) : null,
    byDirection: { BUY: dirStat('BUY'), SELL: dirStat('SELL') },
  };
}

// ---------------------------------------------------------------------------
// Verdict — pre-registered, ordered, machine-enforced
// ---------------------------------------------------------------------------

export type ForwardPaperConclusion =
  | 'IN_PROGRESS'
  | 'INCONCLUSIVE_TIMEOUT'
  | 'NEGATIVE_AFTER_COSTS'
  | 'INCONCLUSIVE_CONCENTRATION'
  | 'INCONCLUSIVE_DRAWDOWN'
  | 'PROMISING_CONTINUE_FORWARD';

export interface ForwardPaperVerdict {
  conclusion: ForwardPaperConclusion;
  reasons: string[];
  rulesVersion: string;
  disclaimer: string;
}

export interface ForwardPaperVerdictInput {
  countedCompleted: number;
  openCounted: number;
  repeatObservations: number;
  unobservableResolved: number;
  metrics: ForwardPaperMetrics | null;
  nowMs: number;
}

/**
 * Ordered pre-registered rules — the FIRST matching branch wins:
 *
 *   1. countedCompleted < 20:
 *        now < deadline  → IN_PROGRESS (no claim of any kind)
 *        now ≥ deadline  → INCONCLUSIVE_TIMEOUT
 *   2. net P/L ≤ 0 (after modeled costs)          → NEGATIVE_AFTER_COSTS
 *   3. top-1 net-win share > 35%                  → INCONCLUSIVE_CONCENTRATION
 *   4. consecutive losses > 8 OR drawdown > 10R   → INCONCLUSIVE_DRAWDOWN
 *   5. otherwise                                  → PROMISING_CONTINUE_FORWARD
 *
 * PROMISING_CONTINUE_FORWARD is explicitly NOT a profitability claim and NOT
 * Phase 11 authorization — the disclaimer is attached to every verdict.
 */
export function evaluateForwardPaperVerdict(input: ForwardPaperVerdictInput): ForwardPaperVerdict {
  const reasons: string[] = [];
  const { countedCompleted, openCounted, repeatObservations, unobservableResolved, metrics, nowMs } = input;
  const deadlineMs = forwardPaperDeadlineMs();

  if (countedCompleted < FORWARD_PAPER_MIN_COMPLETED_TRADES) {
    if (nowMs >= deadlineMs) {
      reasons.push(
        `Observation window elapsed: ${countedCompleted} completed trades (< ${FORWARD_PAPER_MIN_COMPLETED_TRADES} required) by the ${FORWARD_PAPER_OBSERVATION_WINDOW_DAYS}-day deadline.`,
      );
      if (openCounted > 0) reasons.push(`${openCounted} counted trade(s) still open — they resolve but cannot unlock a verdict alone.`);
      if (repeatObservations > 0) reasons.push(`${repeatObservations} repeat observation(s) excluded by the first-open rule (one-position model).`);
      if (unobservableResolved > 0) reasons.push(`${unobservableResolved} resolved trade(s) with unobservable P/L (expired without post-signal candles) — excluded, never invented.`);
      reasons.push('Next step (user decision, not automatic): extend the window under a NEW protocol version, or redesign the strategy. Phase 11 stays locked.');
      return { conclusion: 'INCONCLUSIVE_TIMEOUT', reasons, rulesVersion: FORWARD_PAPER_RULES_VERSION, disclaimer: FORWARD_PAPER_DISCLAIMER };
    }
    const daysRemaining = Math.max(0, (deadlineMs - nowMs) / 86_400_000);
    reasons.push(
      `Forward paper observation in progress: ${countedCompleted}/${FORWARD_PAPER_MIN_COMPLETED_TRADES} completed counted trades; ${daysRemaining.toFixed(1)} day(s) of the ${FORWARD_PAPER_OBSERVATION_WINDOW_DAYS}-day window remain.`,
    );
    if (openCounted > 0) reasons.push(`${openCounted} counted trade(s) currently open.`);
    if (repeatObservations > 0) reasons.push(`${repeatObservations} repeat observation(s) excluded by the first-open rule — the same setup is never counted twice.`);
    if (unobservableResolved > 0) reasons.push(`${unobservableResolved} resolved trade(s) with unobservable P/L — excluded from metrics, never invented.`);
    reasons.push('No performance claim is made below the pre-registered sample floor.');
    return { conclusion: 'IN_PROGRESS', reasons, rulesVersion: FORWARD_PAPER_RULES_VERSION, disclaimer: FORWARD_PAPER_DISCLAIMER };
  }

  // countedCompleted ≥ floor → metrics must exist (guarded defensively)
  if (!metrics || metrics.trades !== countedCompleted) {
    reasons.push('Internal inconsistency: completed trades ≥ floor but metrics are missing/mismatched — refusing to interpret.');
    return { conclusion: 'INCONCLUSIVE_TIMEOUT', reasons, rulesVersion: FORWARD_PAPER_RULES_VERSION, disclaimer: FORWARD_PAPER_DISCLAIMER };
  }

  if (metrics.netPnlPrice <= 0) {
    reasons.push(
      `Forward paper net P/L after modeled costs = ${metrics.netPnlPrice} (≤ 0) across ${metrics.trades} completed trades — negative forward out-of-sample result.`,
    );
    return { conclusion: 'NEGATIVE_AFTER_COSTS', reasons, rulesVersion: FORWARD_PAPER_RULES_VERSION, disclaimer: FORWARD_PAPER_DISCLAIMER };
  }

  if (metrics.top1NetShare !== null && metrics.top1NetShare > FORWARD_PAPER_MAX_TOP1_NET_SHARE) {
    reasons.push(
      `Single best trade contributes ${(metrics.top1NetShare * 100).toFixed(1)}% of net wins (> ${FORWARD_PAPER_MAX_TOP1_NET_SHARE * 100}% pre-registered limit) — concentration too high.`,
    );
    return { conclusion: 'INCONCLUSIVE_CONCENTRATION', reasons, rulesVersion: FORWARD_PAPER_RULES_VERSION, disclaimer: FORWARD_PAPER_DISCLAIMER };
  }

  if (
    metrics.maxConsecutiveLosses > FORWARD_PAPER_MAX_CONSECUTIVE_LOSSES ||
    metrics.maxDrawdownR > FORWARD_PAPER_MAX_DRAWDOWN_R
  ) {
    reasons.push(
      `Risk profile outside pre-registered acceptability: ${metrics.maxConsecutiveLosses} consecutive losses (max ${FORWARD_PAPER_MAX_CONSECUTIVE_LOSSES}), drawdown ${metrics.maxDrawdownR}R (max ${FORWARD_PAPER_MAX_DRAWDOWN_R}R) — even though net P/L = ${metrics.netPnlPrice} > 0.`,
    );
    return { conclusion: 'INCONCLUSIVE_DRAWDOWN', reasons, rulesVersion: FORWARD_PAPER_RULES_VERSION, disclaimer: FORWARD_PAPER_DISCLAIMER };
  }

  reasons.push(
    `Forward paper: ${metrics.trades} completed trades ≥ ${FORWARD_PAPER_MIN_COMPLETED_TRADES} floor, net ${metrics.netPnlPrice} > 0 after modeled costs, PF ${metrics.profitFactor ?? '—'}, avgR ${metrics.avgR}, drawdown ${metrics.maxDrawdownR}R, ${metrics.maxConsecutiveLosses} consecutive losses.`,
  );
  reasons.push('Evidence supports CONTINUING forward paper / reviewing the Phase 11 gate — this is NOT a profitability claim and NOT Phase 11 authorization.');
  return { conclusion: 'PROMISING_CONTINUE_FORWARD', reasons, rulesVersion: FORWARD_PAPER_RULES_VERSION, disclaimer: FORWARD_PAPER_DISCLAIMER };
}
