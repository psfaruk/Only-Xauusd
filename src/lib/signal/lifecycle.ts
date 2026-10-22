/**
 * XAUUSD AI Trading Agent — Signal Lifecycle Contract
 * (Deep-remediation Phase 3: master prompt §PHASE 3 "SIGNAL DATA CONTRACT
 * AND LIFECYCLE").
 * ----------------------------------------------------------------------------
 * Typed, versioned, PURE lifecycle module for every persisted signal
 * evaluation (baseline `hybrid-structure-retest`, candidate and scalper rows
 * alike — they share the SignalEvaluation shape). No database, no clock
 * reads, no I/O: every function is deterministic and side-effect free so the
 * same evaluation always derives the same lifecycle (replay-stable).
 *
 * Lifecycle (master prompt): CANDIDATE → CONFIRMED → ISSUED →
 * EXPIRED / CANCELLED → OUTCOME_RECORDED, with legal transitions enforced in
 * the domain layer — see LEGAL_TRANSITIONS. Illegal transitions can never be
 * forced through this module.
 *
 * Closed-candle basis (why CONFIRMED is honest): every actionable evaluation
 * is computed EXCLUSIVELY from closed candles — the loaders
 * (loadSignalWindows / loadScalperWindows → loadAnalysisInput,
 * src/lib/analysis/persistence.ts:52) query `isForming: false` only, and the
 * engine cores receive those windows as pure inputs. A row that cannot prove
 * its closed-candle basis (no decision candle) is never CONFIRMED.
 *
 * Timestamps: all inputs/outputs are UTC ISO strings (the persistence layer
 * stores DateTime; this module never converts timezones).
 */

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/** Contract version — bump on any semantic change to the rules below. */
export const LIFECYCLE_CONTRACT_VERSION = 'signal-lifecycle/1.0.0';

// ---------------------------------------------------------------------------
// Status + legal transition graph
// ---------------------------------------------------------------------------

export type SignalLifecycleStatus =
  | 'CANDIDATE'
  | 'CONFIRMED'
  | 'ISSUED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'OUTCOME_RECORDED';

/**
 * Legal transitions (master prompt Phase 3: "Enforce legal transitions in the
 * domain/service layer"). Terminal state: OUTCOME_RECORDED.
 *
 * Deliberately ILLEGAL (fail-closed discipline):
 *   · CANDIDATE → ISSUED  — a candidate may never skip the confirmation
 *     checks (closed-candle basis + non-expiry) and be "silently promoted".
 *   · anything → CANDIDATE / CONFIRMED after ISSUED — no resurrection.
 *   · self-transitions — a status change must be a real change.
 */
export const LEGAL_TRANSITIONS: Record<SignalLifecycleStatus, readonly SignalLifecycleStatus[]> = {
  CANDIDATE: ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED: ['ISSUED', 'CANCELLED', 'EXPIRED'],
  ISSUED: ['EXPIRED', 'CANCELLED', 'OUTCOME_RECORDED'],
  EXPIRED: ['OUTCOME_RECORDED'],
  CANCELLED: ['OUTCOME_RECORDED'],
  OUTCOME_RECORDED: [],
};

export function canTransition(from: SignalLifecycleStatus, to: SignalLifecycleStatus): boolean {
  return from !== to && LEGAL_TRANSITIONS[from].includes(to);
}

export type TransitionResult =
  | { ok: true; to: SignalLifecycleStatus }
  | { ok: false; error: 'ILLEGAL_TRANSITION'; detail: string };

/** Pure transition attempt — never mutates, never throws. */
export function transition(from: SignalLifecycleStatus, to: SignalLifecycleStatus): TransitionResult {
  if (canTransition(from, to)) return { ok: true, to };
  return {
    ok: false,
    error: 'ILLEGAL_TRANSITION',
    detail: `${from} → ${to} is not a legal signal-lifecycle transition (${LIFECYCLE_CONTRACT_VERSION}).`,
  };
}

// ---------------------------------------------------------------------------
// Deriving the status of a persisted evaluation
// ---------------------------------------------------------------------------

export interface LifecycleDerivationInput {
  /** SignalEvaluation.outcome (BUY_SETUP | SELL_SETUP | WAIT | NO_SETUP | BLOCKED | FAILED). */
  outcome: string;
  /** The decision candle's OPEN time (UTC ISO) — proof of closed-candle basis. */
  decisionCandleTimeUtc: string | null;
  /** When the setup became known (UTC ISO). */
  setupKnownAtUtc: string | null;
  /** Setup expiry (UTC ISO) — setups always carry one; null on non-setups. */
  expiryUtc: string | null;
  /** Injectable clock (epoch ms) — determinism. */
  now: () => number;
}

const ACTIONABLE_OUTCOMES: readonly string[] = ['BUY_SETUP', 'SELL_SETUP'];

/**
 * Derive the lifecycle status of a PERSISTED evaluation:
 *
 *   EXPIRED    — expiryUtc exists and is in the past (a stale setup is never
 *                displayed as current — regardless of outcome).
 *   CONFIRMED  — actionable (BUY_SETUP/SELL_SETUP), based on a closed
 *                decision candle (decisionCandleTimeUtc present — see the
 *                closed-candle basis note above), not expired, and carries an
 *                expiry (without one, timeliness cannot be proven → fail
 *                closed to CANDIDATE, never a fabricated CONFIRMED).
 *   CANDIDATE  — everything else: WAIT / NO_SETUP / BLOCKED / FAILED rows and
 *                actionable rows that cannot prove closed-candle basis or
 *                timeliness. (In this read-only product nothing is ever
 *                ISSUED to a broker — ISSUED is reachable only through the
 *                explicit transition() path, never by derivation.)
 */
export function deriveLifecycleStatus(evaluation: LifecycleDerivationInput): SignalLifecycleStatus {
  const nowMs = evaluation.now();

  // An expiry is only trustworthy when it parses; NaN means absent/corrupt.
  const expiryMs = evaluation.expiryUtc !== null ? Date.parse(evaluation.expiryUtc) : Number.NaN;
  const expiryProvable = Number.isFinite(expiryMs);

  // 1) Expiry first: an expired setup is expired, whatever else it was.
  if (expiryProvable && expiryMs < nowMs) return 'EXPIRED';

  // 2) Actionable + closed-candle-based + provably timely → CONFIRMED.
  const actionable = ACTIONABLE_OUTCOMES.includes(evaluation.outcome);
  const closedCandleBasis = evaluation.decisionCandleTimeUtc !== null;
  if (actionable && closedCandleBasis && expiryProvable) return 'CONFIRMED';

  // 3) Fail closed: candidate until proven otherwise.
  return 'CANDIDATE';
}

// ---------------------------------------------------------------------------
// Canonical dedupe key (idempotency: retries/reloads never repeat an alert)
// ---------------------------------------------------------------------------

export interface DedupeKeyInput {
  symbol: string;
  strategyVersion: string;
  /** Phase 10.3-A logical setup identity (null on legacy/unidentifiable rows). */
  setupFingerprint: string | null;
  decisionCandleTimeUtc: string | null;
}

/**
 * Canonical dedupe key: `symbol|strategyVersion|setupFingerprint|
 * decisionCandleTimeUtc`. Same logical setup → same key (retry/reload
 * deduplication); ANY differing component → different key. Null components
 * use stable placeholders (a null setupFingerprint is never guessed).
 */
export function signalDedupeKey(evaluation: DedupeKeyInput): string {
  return [
    evaluation.symbol,
    evaluation.strategyVersion,
    evaluation.setupFingerprint ?? 'no-setup-fingerprint',
    evaluation.decisionCandleTimeUtc ?? 'no-decision-candle',
  ].join('|');
}

// ---------------------------------------------------------------------------
// Confidence honesty
// ---------------------------------------------------------------------------

/**
 * The confidence vocabulary of this product. The ICT/SMC confluence layer
 * carries a weighted evidence score with tiers A/B/C
 * (SMC_TIER_THRESHOLDS, src/lib/signal/ict/types.ts) — a heuristic
 * confluence measure, NOT a statistically calibrated probability. No
 * calibration study exists, so 'PROBABILITY' is never emitted.
 */
export type ConfidenceType = 'EVIDENCE_SCORE';

/** Machine-readable honesty bit: false until a calibration study lands. */
export const CONFIDENCE_CALIBRATED = false as const;

/**
 * Label the confidence concept behind a tier/score. Until the scores are
 * calibrated and validated against realized outcomes, every tier maps to
 * 'EVIDENCE_SCORE' — the single place to change if calibration ever happens.
 */
export function confidenceLabel(_tier?: string | null): ConfidenceType {
  void _tier; // tiers exist (A/B/C) but none is a probability — see above.
  return 'EVIDENCE_SCORE';
}
