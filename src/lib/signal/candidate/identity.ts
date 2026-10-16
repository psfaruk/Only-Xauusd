/**
 * XAUUSD AI Trading Agent — CANDIDATE Setup Identity (Phase 11)
 * ----------------------------------------------------------------------------
 * sha256 over { identityVersion, symbol, timeframe, candidateVersion, model,
 * direction, anchorKey }. The candidate version is INSIDE the payload, so
 * candidate identities can never collide with the baseline namespace
 * (setup-identity/1) — even for the identical structure event (Model A).
 *
 * Dedup semantics (spec §3.5): repeated evaluations of the same anchor →
 * the SAME fingerprint; a new anchor → a new fingerprint. Pure module.
 */

import { createHash } from 'node:crypto';
import { CANDIDATE_IDENTITY_VERSION, CANDIDATE_STRATEGY_VERSION, type CandidateAnchorKey, type CandidateModel } from './types';

export interface CandidateSetupIdentityInput {
  symbol: string;
  timeframe: string;
  model: CandidateModel;
  direction: 'BUY' | 'SELL';
  anchorKey: CandidateAnchorKey;
}

/** Deterministic fingerprint of one candidate setup — same input, same hash. */
export function computeCandidateSetupFingerprint(input: CandidateSetupIdentityInput): string {
  const payload = {
    identityVersion: CANDIDATE_IDENTITY_VERSION,
    symbol: input.symbol,
    timeframe: input.timeframe,
    candidateVersion: CANDIDATE_STRATEGY_VERSION,
    model: input.model,
    direction: input.direction,
    anchorKey: input.anchorKey,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
