/**
 * XAUUSD AI Trading Agent — Setup Identity (Phase 10.3-A)
 * ----------------------------------------------------------------------------
 * DETERMINISTIC identity of a logical market setup, shared by ONE code path
 * for both persistence layers:
 *
 *   · saveSignalEvaluation  → persists it on SignalEvaluation rows (trace tag;
 *     repeated evaluations remain the append-only audit trail — NOT unique).
 *   · trackPaperSignals      → persists it on PaperSignalOutcome rows with a
 *     database-level UNIQUE constraint (ONE paper row per logical setup ever).
 *
 * Identity definition (design note: audit/phase10.3a-setup-identity-design.md):
 *   sha256 over { identityVersion, symbol, timeframe, strategyVersion,
 *                 setup: { type, direction, level, breakCandleTimeUtc } }
 *
 * DELIBERATELY EXCLUDED (variable per evaluation — including any of them would
 * disable deduplication): decisionCandleTimeUtc, barsSinceBreak, evaluation
 * instant, quote (bid/ask/spread), indicators, anchor swing, derived levels,
 * outcome/reason codes. The SAME logical setup legitimately spans multiple
 * decision candles and evaluation instants (live proof: one BOS/bearish setup
 * evaluated 11 times across 4 decision candles on 2026-10-15).
 *
 * identityVersion: if this identity definition ever needs to change, the
 * version string MUST be bumped — rows hashed under different versions never
 * dedupe (disclosed residual risk, never a silent edit).
 *
 * Pure module: no database, no network, no clock. The strategy engine core is
 * untouched — the fingerprint is derived OUTSIDE evaluateSignal.
 */

import { createHash } from 'node:crypto';

/** Namespaces the identity definition (bump on any definition change). */
export const SETUP_IDENTITY_VERSION = 'setup-identity/1';

/** The structure-event identity — the four fields uniquely identify one event. */
export interface SetupStructureEventIdentity {
  type: string; // 'BOS' | 'CHoCH' (engine evidence values)
  direction: string; // 'bullish' | 'bearish' (engine evidence values)
  level: number;
  breakCandleTimeUtc: string;
}

export interface SetupIdentityInput {
  symbol: string;
  timeframe: string;
  strategyVersion: string;
  structureEvent: SetupStructureEventIdentity;
}

/** Deterministic fingerprint of a logical setup — same input, same hash. */
export function computeSetupFingerprint(input: SetupIdentityInput): string {
  const payload = {
    identityVersion: SETUP_IDENTITY_VERSION,
    symbol: input.symbol,
    timeframe: input.timeframe,
    strategyVersion: input.strategyVersion,
    setup: {
      type: input.structureEvent.type,
      direction: input.structureEvent.direction,
      level: input.structureEvent.level,
      breakCandleTimeUtc: input.structureEvent.breakCandleTimeUtc,
    },
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Evidence shape needed for the identity (structural subset of SignalEvidence). */
export interface SetupFingerprintEvidenceLike {
  structureEvent: SetupStructureEventIdentity | null;
}

/**
 * Fingerprint from a (possibly parsed-from-JSON) evidence object.
 * Returns null when the identity is incomplete — NEVER guessed. Callers treat
 * null as "unidentifiable setup" (fail-closed: no paper row, no dedup key).
 */
export function setupFingerprintFromEvidence(args: {
  symbol: string;
  timeframe: string;
  strategyVersion: string;
  evidence: unknown;
}): string | null {
  const ev = args.evidence;
  if (!ev || typeof ev !== 'object') return null;
  const se = (ev as { structureEvent?: unknown }).structureEvent;
  if (!se || typeof se !== 'object') return null;
  const s = se as Record<string, unknown>;
  const type = s.type;
  const direction = s.direction;
  const level = s.level;
  const breakCandleTimeUtc = s.breakCandleTimeUtc;
  if (typeof type !== 'string' || type.length === 0) return null;
  if (typeof direction !== 'string' || direction.length === 0) return null;
  if (typeof level !== 'number' || !Number.isFinite(level)) return null;
  if (typeof breakCandleTimeUtc !== 'string' || breakCandleTimeUtc.length === 0) return null;
  return computeSetupFingerprint({
    symbol: args.symbol,
    timeframe: args.timeframe,
    strategyVersion: args.strategyVersion,
    structureEvent: { type, direction, level, breakCandleTimeUtc },
  });
}
