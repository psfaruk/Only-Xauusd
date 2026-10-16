/**
 * XAUUSD AI Trading Agent — CANDIDATE Strategy Types (Phase 11)
 * ----------------------------------------------------------------------------
 * OFFLINE RESEARCH CODE — hybrid-multimodel-research/11.0.0-candidate.1.
 *
 * This candidate is NOT wired into runSignalEvaluation, the scheduler,
 * persistence, or paper tracking. Activation requires the preregistered
 * protocol (audit/phase11-candidate-forward-protocol.md). The baseline
 * strategy hybrid-structure-retest/9.0.0 and the Phase 10.2 protocol are
 * UNTOUCHED (frozen constants below mirror the spec verbatim:
 * audit/phase11-candidate-strategy-spec.md — chosen a priori, never tuned
 * against results).
 *
 * No orders, no execution, no lock changes. Pure functions only.
 */

import type { SignalEvaluation, SignalLevels, SignalOutcome, SignalReasonCode, SignalWindow, StrategyRules } from '@/lib/signal/types';

export const CANDIDATE_STRATEGY_ID = 'hybrid-multimodel-research';
export const CANDIDATE_STRATEGY_VERSION = `${CANDIDATE_STRATEGY_ID}/11.0.0-candidate.1`;

/** Namespaces the candidate setup identity (NEVER mixes with setup-identity/1). */
export const CANDIDATE_IDENTITY_VERSION = 'candidate-setup-identity/1';

/**
 * Frozen candidate constants (spec §1/§7). ANY change requires a new
 * candidate version string and a new protocol document.
 */
export const CANDIDATE_RULES = {
  /** Model B: M15 bars (incl. decision) searched for the EMA50 pullback. */
  pullbackLookbackBars: 6,
  /** Model B: EMA50 band half-width in ATR multiples (touch + entry zone). */
  pullbackZoneAtr: 0.35,
  /** Model B: a close this deep beyond EMA50 kills the pullback (ATR multiples). */
  pullbackMaxDepthAtr: 1.0,
  /** Model C: M15 bars back that must contain the range-confirming swings. */
  rangeLookbackBars: 96,
  /** Model C: max spread between the last two swing highs (or lows), in ATR multiples. */
  rangeBandAtr: 0.6,
  /** Model C: minimum range height in ATR multiples. */
  rangeMinHeightAtr: 2.0,
  /** Model C: maximum range height in ATR multiples. */
  rangeMaxHeightAtr: 8.0,
  /** Model C: M15 bars (incl. decision) searched for the sweep. */
  sweepLookbackBars: 3,
  /** Model C: minimum wick/close beyond the boundary, in ATR multiples. */
  sweepMinBeyondAtr: 0.1,
  /** M5 confirmation window length (closed M5 bars supplied to the models). */
  m5WindowBars: 30,
} as const;

/** Candidate-only reason codes (baseline codes are reused where the same condition applies). */
export type CandidateExtraReasonCode =
  | 'MODEL_CONFLICT'
  | 'PULLBACK_CONTEXT_NOT_ALIGNED'
  | 'PULLBACK_NO_TOUCH'
  | 'PULLBACK_TOO_DEEP'
  | 'M5_CONFIRMATION_PENDING'
  | 'RANGE_NOT_DETECTED'
  | 'RANGE_SWEEP_PENDING'
  | 'RANGE_RECLAIM_PENDING';

export type CandidateReasonCode = SignalReasonCode | CandidateExtraReasonCode;

/** Stage classes for aggregation when no model emitted (deterministic mapping). */
export const WAIT_CLASS_CODES: readonly CandidateReasonCode[] = [
  'AT_ZONE_BOUNDARY',
  'RETEST_PENDING',
  'HTF_H1_OPPOSITE',
  'HTF_H4_OPPOSITE',
  'EMA_TREND_OPPOSITE',
  'RSI_OUT_OF_RANGE',
  'ADX_BELOW_MIN',
  'SPREAD_TOO_WIDE',
  'PRICE_BEYOND_ENTRY_ZONE',
  'MODEL_CONFLICT',
  'PULLBACK_CONTEXT_NOT_ALIGNED',
  'PULLBACK_NO_TOUCH',
  'M5_CONFIRMATION_PENDING',
  'RANGE_SWEEP_PENDING',
  'RANGE_RECLAIM_PENDING',
] as const;

export const NO_SETUP_CLASS_CODES: readonly CandidateReasonCode[] = [
  'NO_STRUCTURE_BREAK',
  'STRUCTURE_BREAK_TOO_OLD',
  'ZONE_INVALIDATED',
  'PULLBACK_TOO_DEEP',
  'RANGE_NOT_DETECTED',
  'NO_ANCHOR_SWING',
  'LEVEL_CALC_INVALID',
] as const;

export type CandidateModel = 'A' | 'B' | 'C';

/** Candidate input — the baseline window set PLUS the M5 confirmation window. */
export interface CandidateInput {
  symbol: string;
  digits: number | null;
  execution: SignalWindow; // M15
  h1: SignalWindow;
  h4: SignalWindow;
  /** M5 closed-candle window (confirmation TF — candidate only). */
  m5: SignalWindow;
  referencePrice: number;
  spreadPrice: number;
  nowUtcSec: number;
  /** Baseline rules (Model A + every shared gate/level parameter). */
  rules: StrategyRules;
}

/** Levels + the walk invalidation level (per model, spec §1). */
export interface CandidateLevels extends SignalLevels {
  invalidationLevel: number;
}

/** Deterministic anchor of a candidate setup (dedup key input). */
export type CandidateAnchorKey =
  | { kind: 'structure'; type: string; direction: string; level: number; breakCandleTimeUtc: string }
  | { kind: 'pullback'; extremeBarTimeUtcSec: number }
  | { kind: 'sweep'; extremeBarTimeUtcSec: number; boundary: 'bottom' | 'top' };

export interface CandidateModelSetup {
  model: CandidateModel;
  direction: 'BUY' | 'SELL';
  levels: CandidateLevels | null;
  anchorKey: CandidateAnchorKey;
}

export interface ModelAResult {
  /** The UNMODIFIED baseline evaluation (Model A IS the baseline logic). */
  evaluation: SignalEvaluation;
}

export interface ModelBResult {
  setup: CandidateModelSetup | null;
  stage: CandidateReasonCode | null;
}

export interface ModelCResult {
  setups: Array<{ direction: 'BUY' | 'SELL'; setup: CandidateModelSetup }>;
  /** Per-direction stage codes (which side got how far). */
  stages: { BUY: CandidateReasonCode | null; SELL: CandidateReasonCode | null };
  /** Most-advanced stage across directions (tie → BUY) — the reported code. */
  stage: CandidateReasonCode | null;
}

export interface CombinedModels {
  outcome: SignalOutcome;
  reasonCodes: CandidateReasonCode[];
  model: CandidateModel | null;
  direction: 'BUY' | 'SELL' | null;
  levels: CandidateLevels | null;
  setup: CandidateModelSetup | null;
  suppressedModels: CandidateModel[];
  conflict: boolean;
}

export interface CandidateEvaluation {
  candidateVersion: string;
  engineVersion: string;
  symbol: string;
  purpose: 'research-signal-not-an-execution-instruction';
  outcome: SignalOutcome;
  reasonCodes: CandidateReasonCode[];
  decisionCandleTimeUtc: string | null;
  setupKnownAtUtc: string | null;
  expiryUtc: string | null;
  model: CandidateModel | null;
  direction: 'BUY' | 'SELL' | null;
  levels: CandidateLevels | null;
  setupFingerprint: string | null;
  evidence: {
    modelA: { outcome: SignalOutcome; reasonCodes: SignalReasonCode[] } | null;
    modelB: { setup: boolean; stage: CandidateReasonCode | null } | null;
    modelC: { setups: Array<'BUY' | 'SELL'>; stage: CandidateReasonCode | null } | null;
    suppressedModels: CandidateModel[];
    conflict: boolean;
  } | null;
  inputFingerprint: string;
  datasetFingerprint: string | null;
  generatedAtUtc: string;
}
