/**
 * XAUUSD AI Trading Agent — Candidate Forward-Paper Protocol (Phase 11-E)
 * ----------------------------------------------------------------------------
 * PRE-REGISTERED rules for the forward observation of the CANDIDATE strategy
 * hybrid-multimodel-research/11.0.0-candidate.1. The protocol document is
 * audit/phase11-candidate-forward-protocol.md (fingerprint
 * phase11-candidate-forward/1, pre-registered 2026-10-16 BEFORE any candidate
 * result existed). The constants below implement that document verbatim —
 * they are NOT tunable and NOT derived from any observed result.
 *
 * This module is COMPLETELY SEPARATE from the Phase 10.2 baseline protocol
 * (src/lib/signal/paper-protocol.ts, phase10.2-forward-paper/1): separate
 * table (PaperCandidateOutcome), separate identity namespace
 * (candidate-setup-identity/1), separate verdict state. Nothing here reads
 * or writes any baseline row, and nothing in the baseline reads candidate
 * rows (protocol §4 cannot-mix guarantees).
 *
 * What this module can never do: place, modify or close a broker order — no
 * such code exists anywhere in this project (four execution locks verified).
 * CONTINUE_FORWARD_RESEARCH is explicitly NOT trading authorization, NOT
 * Phase 12, NOT an execution unlock (protocol §6.5).
 */

// ---------------------------------------------------------------------------
// Pre-registered constants (protocol §3/§8 — verbatim)
// ---------------------------------------------------------------------------

export const CANDIDATE_FORWARD_PROTOCOL_ID = 'phase11-candidate-forward/1';

/** Minimum completed-outcome sample — below this the verdict is INCOMPLETE, always. */
export const CANDIDATE_FORWARD_MIN_COMPLETED = 20;

/** Observation window: 90 calendar days from the activation instant. */
export const CANDIDATE_FORWARD_WINDOW_DAYS = 90;

/**
 * The ACTIVATION INSTANT (protocol §2/§3): the moment the candidate was wired
 * into the live read-only research pipeline (Phase 11-E activation record:
 * audit/phase11-activation.md). Counting starts here — nothing before this
 * instant can contribute to the candidate sample (the candidate never
 * persisted anything before activation; the bound is defense in depth).
 */
export const CANDIDATE_FORWARD_ACTIVATED_AT_ISO = '2026-10-20T15:00:00Z';

/** Stopping-condition limits (§5.3 — same risk discipline as the baseline). */
export const CANDIDATE_FORWARD_MAX_CONSECUTIVE_LOSSES = 8;
export const CANDIDATE_FORWARD_MAX_DRAWDOWN_R = 10;

/** Top-1 winner share limit (§6.3). */
export const CANDIDATE_FORWARD_MAX_TOP1_NET_SHARE = 0.35;

export const CANDIDATE_FORWARD_DISCLAIMER =
  'ক্যান্ডিডেট ফলাফল কেবল গবেষণা — এটি কোনো লাভজয়ের দাবি নয় এবং কোনো ট্রেড কার্যকরের অনুমোদন নয়। চারটি এক্সিকিউশন লক যেকোনো ফলাফলেই বন্ধ থাকে। (Candidate forward paper results are research only — NOT a profitability claim and NOT trading authorization; the four execution locks stay locked regardless of any candidate result.)';

export function candidateForwardActivatedMs(): number {
  return Date.parse(CANDIDATE_FORWARD_ACTIVATED_AT_ISO);
}

export function candidateForwardDeadlineMs(): number {
  return candidateForwardActivatedMs() + CANDIDATE_FORWARD_WINDOW_DAYS * 86_400_000;
}

// ---------------------------------------------------------------------------
// Verdict — pre-registered interpretation rules (protocol §6, ordered)
// ---------------------------------------------------------------------------

export type CandidatePaperConclusion =
  | 'INCOMPLETE'
  | 'INCOMPLETE_TIMEOUT'
  | 'NEGATIVE_AFTER_COSTS'
  | 'INCONCLUSIVE_CONCENTRATION'
  | 'INCONCLUSIVE_DRAWDOWN'
  | 'CONTINUE_FORWARD_RESEARCH';

export interface CandidatePaperVerdict {
  conclusion: CandidatePaperConclusion;
  reasons: string[];
  protocolId: string;
  disclaimer: string;
}

/** The pure inputs the verdict needs — a projection of PaperCandidateOutcome rows. */
export interface CandidatePaperVerdictInput {
  /** Resolved rows with OBSERVABLE net P/L (exitPrice and netPnlPrice non-null). */
  completedOutcomes: Array<{ netPnlPrice: number; rMultiple: number }>;
  openRows: number;
  unobservableExpired: number;
  nowMs: number;
}

/**
 * Ordered pre-registered rules — the FIRST matching branch wins:
 *
 *   1. completed < 20:
 *        now < deadline  → INCOMPLETE (no claim of any kind)
 *        now ≥ deadline  → INCOMPLETE_TIMEOUT
 *   2. net P/L ≤ 0 (after modeled costs)          → NEGATIVE_AFTER_COSTS
 *   3. top-1 net-win share > 35%                  → INCONCLUSIVE_CONCENTRATION
 *   4. consecutive losses > 8 OR drawdown > 10R   → INCONCLUSIVE_DRAWDOWN
 *   5. otherwise                                  → CONTINUE_FORWARD_RESEARCH
 *
 * The §5.3 STOPPING condition (8 consecutive completed losses or cumulative
 * drawdown > 10R halts the observation) is surfaced separately by the caller
 * (stopConditionTriggered) — it is an action instruction for the operator,
 * not the sample verdict.
 */
export function evaluateCandidatePaperVerdict(input: CandidatePaperVerdictInput): CandidatePaperVerdict {
  const reasons: string[] = [];
  const deadlineMs = candidateForwardDeadlineMs();
  const completed = input.completedOutcomes;
  const floor = CANDIDATE_FORWARD_MIN_COMPLETED;

  if (completed.length < floor) {
    if (input.nowMs >= deadlineMs) {
      reasons.push(
        `Observation window elapsed: ${completed.length} completed candidate outcomes (< ${floor} required) by the ${CANDIDATE_FORWARD_WINDOW_DAYS}-day deadline.`,
      );
      if (input.openRows > 0) reasons.push(`${input.openRows} candidate paper row(s) still open — they resolve but cannot unlock a verdict alone.`);
      if (input.unobservableExpired > 0) reasons.push(`${input.unobservableExpired} resolved row(s) with unobservable P/L (expired without post-signal candles) — excluded, never invented.`);
      reasons.push('Next step (user decision, not automatic): extend the window under a NEW protocol version, or stop the candidate. Execution stays locked.');
      return { conclusion: 'INCOMPLETE_TIMEOUT', reasons, protocolId: CANDIDATE_FORWARD_PROTOCOL_ID, disclaimer: CANDIDATE_FORWARD_DISCLAIMER };
    }
    const daysRemaining = Math.max(0, (deadlineMs - input.nowMs) / 86_400_000);
    reasons.push(
      `Candidate forward observation in progress: ${completed.length}/${floor} completed outcomes; ${daysRemaining.toFixed(1)} day(s) of the ${CANDIDATE_FORWARD_WINDOW_DAYS}-day window remain.`,
    );
    if (input.openRows > 0) reasons.push(`${input.openRows} candidate paper row(s) currently open.`);
    if (input.unobservableExpired > 0) reasons.push(`${input.unobservableExpired} resolved row(s) with unobservable P/L — excluded from metrics, never invented.`);
    reasons.push('No performance claim is made below the pre-registered sample floor.');
    return { conclusion: 'INCOMPLETE', reasons, protocolId: CANDIDATE_FORWARD_PROTOCOL_ID, disclaimer: CANDIDATE_FORWARD_DISCLAIMER };
  }

  const net = completed.reduce((s, t) => s + t.netPnlPrice, 0);
  if (net <= 0) {
    reasons.push(`Candidate net P/L after modeled costs = ${net.toFixed(4)} (≤ 0) across ${completed.length} completed outcomes — negative forward result.`);
    return { conclusion: 'NEGATIVE_AFTER_COSTS', reasons, protocolId: CANDIDATE_FORWARD_PROTOCOL_ID, disclaimer: CANDIDATE_FORWARD_DISCLAIMER };
  }

  const wins = completed.filter((t) => t.netPnlPrice > 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnlPrice, 0);
  const top1Share = grossWin > 0 ? Math.max(...wins.map((t) => t.netPnlPrice)) / grossWin : 0;
  if (top1Share > CANDIDATE_FORWARD_MAX_TOP1_NET_SHARE) {
    reasons.push(
      `Single best outcome contributes ${(top1Share * 100).toFixed(1)}% of net wins (> ${CANDIDATE_FORWARD_MAX_TOP1_NET_SHARE * 100}% pre-registered limit) — concentration too high.`,
    );
    return { conclusion: 'INCONCLUSIVE_CONCENTRATION', reasons, protocolId: CANDIDATE_FORWARD_PROTOCOL_ID, disclaimer: CANDIDATE_FORWARD_DISCLAIMER };
  }

  let equity = 0;
  let peak = 0;
  let dd = 0;
  let streak = 0;
  let maxStreak = 0;
  for (const t of completed) {
    equity += t.rMultiple;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    if (t.netPnlPrice > 0) {
      streak = 0;
    } else {
      streak += 1;
      maxStreak = Math.max(maxStreak, streak);
    }
  }
  // §6.4: "8+ consecutive losses or > 10R drawdown" — the candidate protocol
  // counts 8 itself as the limit (unlike the baseline's strictly-more-than-8
  // wording; both pre-registered in their own protocol documents).
  if (maxStreak >= CANDIDATE_FORWARD_MAX_CONSECUTIVE_LOSSES || dd > CANDIDATE_FORWARD_MAX_DRAWDOWN_R) {
    reasons.push(
      `Risk profile outside pre-registered acceptability: ${maxStreak} consecutive losses (limit ${CANDIDATE_FORWARD_MAX_CONSECUTIVE_LOSSES}), drawdown ${dd.toFixed(2)}R (limit ${CANDIDATE_FORWARD_MAX_DRAWDOWN_R}R) — even though net P/L > 0.`,
    );
    return { conclusion: 'INCONCLUSIVE_DRAWDOWN', reasons, protocolId: CANDIDATE_FORWARD_PROTOCOL_ID, disclaimer: CANDIDATE_FORWARD_DISCLAIMER };
  }

  reasons.push(
    `All pre-registered interpretation gates passed across ${completed.length} completed outcomes (net ${net.toFixed(4)} after modeled costs, top-1 share ${(top1Share * 100).toFixed(1)}%, max drawdown ${dd.toFixed(2)}R).`,
  );
  reasons.push('CONTINUE_FORWARD_RESEARCH is research continuation only — NOT trading authorization and NOT an execution unlock.');
  return { conclusion: 'CONTINUE_FORWARD_RESEARCH', reasons, protocolId: CANDIDATE_FORWARD_PROTOCOL_ID, disclaimer: CANDIDATE_FORWARD_DISCLAIMER };
}

/**
 * Protocol §5.3 stopping condition: 8 consecutive completed losses OR
 * cumulative drawdown > 10R → the observation ENDS with a final report
 * (risk discipline is NOT relaxed for the candidate).
 */
export function candidateStopConditionTriggered(completedOutcomes: Array<{ netPnlPrice: number; rMultiple: number }>): { triggered: boolean; reason: string | null } {
  let equity = 0;
  let peak = 0;
  let streak = 0;
  for (const t of completedOutcomes) {
    equity += t.rMultiple;
    peak = Math.max(peak, equity);
    if (t.netPnlPrice > 0) {
      streak = 0;
    } else {
      streak += 1;
      if (streak >= CANDIDATE_FORWARD_MAX_CONSECUTIVE_LOSSES) {
        return { triggered: true, reason: `${streak} consecutive completed losses (≥ ${CANDIDATE_FORWARD_MAX_CONSECUTIVE_LOSSES}) — pre-registered stopping condition §5.3.` };
      }
    }
    if (peak - equity > CANDIDATE_FORWARD_MAX_DRAWDOWN_R) {
      return { triggered: true, reason: `Cumulative drawdown ${(peak - equity).toFixed(2)}R > ${CANDIDATE_FORWARD_MAX_DRAWDOWN_R}R — pre-registered stopping condition §5.3.` };
    }
  }
  return { triggered: false, reason: null };
}
