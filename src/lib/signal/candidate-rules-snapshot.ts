/**
 * XAUUSD AI Trading Agent — Candidate Rules Snapshot (Phase 11-E)
 * ----------------------------------------------------------------------------
 * DETERMINISTIC, VERSIONED, AUDITABLE snapshot of the rules ACTUALLY USED for
 * one CANDIDATE signal evaluation (hybrid-multimodel-research/
 * 11.0.0-candidate.1) — the Phase 10.3-D discipline, namespaced for the
 * candidate per the pre-registered protocol §1:
 *
 *   · candidate rules  = the FROZEN constants of the spec
 *     (src/lib/signal/candidate/types.ts CANDIDATE_RULES — verbatim, chosen
 *     a priori, never tuned against results) + identity/confirmation labels,
 *     provenance 'candidate-constant'.
 *   · baseline rules   = the embedded baseline manifest the candidate shares
 *     (Models A/B/C reuse every baseline gate/level parameter) — the FULL
 *     validated baseline RulesSnapshot from buildRulesSnapshot, embedded
 *     verbatim under baselineRulesSnapshot.
 *   · Stored INSIDE the candidate SignalEvaluation row's `inputSnapshot.rules`
 *     key. Legacy/absent → NOT-RECORDED (never backfilled, never recomputed
 *     from current configuration — the STORED snapshot is the truth).
 *   · `snapshotHash` = sha256, namespaced `candidate-rules-snapshot/1`, over
 *     the WHOLE payload (which transitively protects the embedded baseline
 *     snapshot bytes). INTEGRITY ONLY — implies nothing about broker
 *     verification, and is deliberately separate from the candidate setup
 *     fingerprint, the candidate input fingerprint and the protocol
 *     fingerprint.
 *   · NO timestamps inside the snapshot — the evaluation instant is the row's
 *     own createdAt. Unknown fields (incl. injected timestamps) are rejected
 *     fail-closed by the strict parser.
 *
 * Pure module: no database, no network, no clock, no env reads. The frozen
 * candidate engine modules (candidate/types.ts etc.) are imported read-only.
 */

import { createHash } from 'node:crypto';
import type { StrategyRules } from './types';
import { SIGNAL_STRATEGY_VERSION } from './types';
import { buildRulesSnapshot, type RulesSnapshot, type RuleManifestEntry } from './rules-snapshot';
import {
  CANDIDATE_IDENTITY_VERSION,
  CANDIDATE_RULES,
  CANDIDATE_STRATEGY_VERSION,
} from './candidate/types';

/** Snapshot FORMAT version (bump on any format change — old readers then fail closed). */
export const CANDIDATE_RULES_SNAPSHOT_VERSION = 1;

/** Provenance labels for candidate manifest entries. */
export type CandidateRuleProvenance =
  | 'candidate-constant' // frozen spec constant (candidate/types.ts CANDIDATE_RULES — verbatim)
  | 'candidate-identity' // frozen identity/label constant of the candidate spec
  | 'broker-metadata' // verified SymbolSpec value (digits) — same label as the baseline
  | 'unavailable'; // genuinely not available at evaluation time

/** One candidate manifest entry (own shape — candidate provenance labels). */
export interface CandidateRuleManifestEntry {
  id: string;
  value: number | string | string[] | null; // null ONLY for unavailable entries
  unit: string;
  scope: string;
  source: CandidateRuleProvenance;
}

export interface CandidateRulesSnapshot {
  candidateRulesSnapshotVersion: number;
  candidateVersion: string;
  engineVersion: string;
  symbol: string;
  /** The frozen candidate constants + identity labels. */
  candidateRules: CandidateRuleManifestEntry[];
  /** The embedded baseline snapshot (shared gates/levels) — verbatim, hash-integral. */
  baselineRulesSnapshot: RulesSnapshot;
  snapshotHash: string;
}

/** Per-evaluation metadata (from the candidate evaluation itself). */
export interface CandidateRulesSnapshotMeta {
  symbol: string;
  engineVersion: string;
  /** Verified broker digits at evaluation time; null = unavailable. */
  digits: number | null;
}

export type CandidateRulesSnapshotBuild =
  | { ok: true; snapshot: CandidateRulesSnapshot }
  | { ok: false; diagnostic: string };

// ---------------------------------------------------------------------------
// Manifest specification — the single source of truth for build AND parse.
// Fixed construction order → stable canonical serialization.
// ---------------------------------------------------------------------------

type CandidateValueKind = 'number' | 'string' | 'digits';

interface CandidateRuleSpec {
  id: string;
  unit: string;
  scope: string;
  source: CandidateRuleProvenance;
  kind: CandidateValueKind;
  value: number | string;
}

const CANDIDATE_RULE_SPECS: readonly CandidateRuleSpec[] = [
  { id: 'candidate.strategyVersion', unit: 'version', scope: 'identity', source: 'candidate-identity', kind: 'string', value: CANDIDATE_STRATEGY_VERSION },
  { id: 'candidate.identityNamespace', unit: 'version', scope: 'identity', source: 'candidate-identity', kind: 'string', value: CANDIDATE_IDENTITY_VERSION },
  { id: 'candidate.confirmationTf', unit: 'timeframe', scope: 'confirmation', source: 'candidate-identity', kind: 'string', value: 'M5' },
  { id: 'candidate.m5WindowBars', unit: 'bars', scope: 'confirmation', source: 'candidate-constant', kind: 'number', value: CANDIDATE_RULES.m5WindowBars },
  { id: 'candidate.modelB.pullbackLookbackBars', unit: 'bars', scope: 'model-b', source: 'candidate-constant', kind: 'number', value: CANDIDATE_RULES.pullbackLookbackBars },
  { id: 'candidate.modelB.pullbackZoneAtr', unit: 'atr_multiple', scope: 'model-b', source: 'candidate-constant', kind: 'number', value: CANDIDATE_RULES.pullbackZoneAtr },
  { id: 'candidate.modelB.pullbackMaxDepthAtr', unit: 'atr_multiple', scope: 'model-b', source: 'candidate-constant', kind: 'number', value: CANDIDATE_RULES.pullbackMaxDepthAtr },
  { id: 'candidate.modelC.rangeLookbackBars', unit: 'bars', scope: 'model-c', source: 'candidate-constant', kind: 'number', value: CANDIDATE_RULES.rangeLookbackBars },
  { id: 'candidate.modelC.rangeBandAtr', unit: 'atr_multiple', scope: 'model-c', source: 'candidate-constant', kind: 'number', value: CANDIDATE_RULES.rangeBandAtr },
  { id: 'candidate.modelC.rangeMinHeightAtr', unit: 'atr_multiple', scope: 'model-c', source: 'candidate-constant', kind: 'number', value: CANDIDATE_RULES.rangeMinHeightAtr },
  { id: 'candidate.modelC.rangeMaxHeightAtr', unit: 'atr_multiple', scope: 'model-c', source: 'candidate-constant', kind: 'number', value: CANDIDATE_RULES.rangeMaxHeightAtr },
  { id: 'candidate.modelC.sweepLookbackBars', unit: 'bars', scope: 'model-c', source: 'candidate-constant', kind: 'number', value: CANDIDATE_RULES.sweepLookbackBars },
  { id: 'candidate.modelC.sweepMinBeyondAtr', unit: 'atr_multiple', scope: 'model-c', source: 'candidate-constant', kind: 'number', value: CANDIDATE_RULES.sweepMinBeyondAtr },
  // Broker-verified metadata (supplied via meta — same label semantics as the baseline).
  { id: 'symbol.digits', unit: 'digits', scope: 'metadata', source: 'broker-metadata', kind: 'digits', value: 0 /* placeholder — replaced from meta */ },
] as const;

const CANDIDATE_SPEC_BY_ID = new Map(CANDIDATE_RULE_SPECS.map((s) => [s.id, s]));
const CANDIDATE_DIGITS_ID = 'symbol.digits';

// ---------------------------------------------------------------------------
// Hash — integrity only, namespaced, separate from every other fingerprint.
// Mirrors the rules-snapshot/1 construction (sha256 over
// "<namespace>:<canonical JSON payload>") with the candidate namespace.
// ---------------------------------------------------------------------------

function computeCandidateSnapshotHash(payload: {
  candidateRulesSnapshotVersion: number;
  candidateVersion: string;
  engineVersion: string;
  symbol: string;
  candidateRules: CandidateRuleManifestEntry[];
  baselineRulesSnapshot: RulesSnapshot;
}): string {
  return createHash('sha256')
    .update(`candidate-rules-snapshot/${CANDIDATE_RULES_SNAPSHOT_VERSION}:`)
    .update(JSON.stringify(payload))
    .digest('hex');
}

/** Mirrors rules-snapshot/1's internal hash so the EMBEDDED baseline snapshot
 *  can be integrity-checked at parse time without importing private state. */
export function computeBaselineSnapshotHash(payload: {
  rulesSnapshotVersion: number;
  engineVersion: string;
  strategyVersion: string;
  symbol: string;
  rules: RuleManifestEntry[];
}): string {
  return createHash('sha256')
    .update('rules-snapshot/1:')
    .update(JSON.stringify(payload))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Build (write side)
// ---------------------------------------------------------------------------

/**
 * Build the deterministic snapshot of the rules ACTUALLY USED for one
 * CANDIDATE evaluation: the frozen candidate constants + the embedded
 * baseline manifest. Total function: validation failures return a structured
 * diagnostic (never throws — persistence must never mask the verdict).
 */
export function buildCandidateRulesSnapshot(
  rules: StrategyRules,
  meta: CandidateRulesSnapshotMeta,
): CandidateRulesSnapshotBuild {
  if (typeof meta.symbol !== 'string' || meta.symbol.length === 0) {
    return { ok: false, diagnostic: 'META_INVALID:symbol' };
  }
  if (typeof meta.engineVersion !== 'string' || meta.engineVersion.length === 0) {
    return { ok: false, diagnostic: 'META_INVALID:engineVersion' };
  }
  if (meta.digits !== null && (typeof meta.digits !== 'number' || !Number.isInteger(meta.digits) || meta.digits < 0 || !Number.isFinite(meta.digits))) {
    return { ok: false, diagnostic: 'NON_FINITE_VALUE:symbol.digits' };
  }
  if (rules.strategyVersion !== SIGNAL_STRATEGY_VERSION) {
    // The candidate embeds the CURRENT baseline rules; a foreign baseline
    // version would silently mislabel the snapshot — refuse (fail-closed).
    return { ok: false, diagnostic: `BASELINE_VERSION_MISMATCH:${rules.strategyVersion}` };
  }

  // The embedded baseline snapshot — built through the SAME validated path
  // the baseline rows use (Phase 10.3-D), never reassembled by hand.
  const baselineBuild = buildRulesSnapshot(rules, {
    symbol: meta.symbol,
    engineVersion: meta.engineVersion,
    digits: meta.digits,
  });
  if (!baselineBuild.ok) {
    return { ok: false, diagnostic: `BASELINE_SNAPSHOT_INVALID:${baselineBuild.diagnostic}` };
  }

  const entries: CandidateRuleManifestEntry[] = [];
  for (const spec of CANDIDATE_RULE_SPECS) {
    if (spec.kind === 'digits') {
      entries.push({
        id: spec.id,
        value: meta.digits,
        unit: spec.unit,
        scope: spec.scope,
        source: meta.digits === null ? 'unavailable' : 'broker-metadata',
      });
      continue;
    }
    const value = spec.value;
    if (spec.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, diagnostic: `NON_FINITE_VALUE:${spec.id}` };
      }
    } else if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, diagnostic: `VALUE_TYPE_INVALID:${spec.id}` };
    }
    entries.push({
      id: spec.id,
      value,
      unit: spec.unit,
      scope: spec.scope,
      source: spec.source,
    });
  }

  const payload = {
    candidateRulesSnapshotVersion: CANDIDATE_RULES_SNAPSHOT_VERSION,
    candidateVersion: CANDIDATE_STRATEGY_VERSION,
    engineVersion: meta.engineVersion,
    symbol: meta.symbol,
    candidateRules: entries,
    baselineRulesSnapshot: baselineBuild.snapshot,
  };
  return {
    ok: true,
    snapshot: { ...payload, snapshotHash: computeCandidateSnapshotHash(payload) },
  };
}

// ---------------------------------------------------------------------------
// Parse (read boundary) — strict, fail-closed, never throws
// ---------------------------------------------------------------------------

export type CandidateRulesSnapshotRead =
  | { status: 'present'; snapshot: CandidateRulesSnapshot }
  | { status: 'not-recorded' } // rules key null/absent — honestly absent
  | { status: 'invalid'; reason: string }; // malformed/contradictory — safe diagnostic

const CANDIDATE_ALLOWED_TOP_KEYS = new Set([
  'candidateRulesSnapshotVersion', 'candidateVersion', 'engineVersion', 'symbol', 'candidateRules', 'baselineRulesSnapshot', 'snapshotHash',
]);
const BASELINE_ALLOWED_TOP_KEYS = new Set([
  'rulesSnapshotVersion', 'engineVersion', 'strategyVersion', 'symbol', 'rules', 'snapshotHash',
]);
const ENTRY_KEYS = ['id', 'value', 'unit', 'scope', 'source'];
const HEX64 = /^[0-9a-f]{64}$/;

function candidateInvalid(reason: string): CandidateRulesSnapshotRead {
  return { status: 'invalid', reason };
}

/**
 * Parse a candidate row's `inputSnapshot` JSON (the WHOLE column value) into
 * a CandidateRulesSnapshotRead. Never recomputes anything from current
 * configuration — the STORED snapshot is the truth.
 */
export function parseCandidateRulesSnapshot(inputSnapshotJson: string | null): CandidateRulesSnapshotRead {
  if (inputSnapshotJson === null) return { status: 'not-recorded' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputSnapshotJson);
  } catch {
    return candidateInvalid('MALFORMED_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'not-recorded' };
  }
  const rules = (parsed as Record<string, unknown>).rules;
  if (rules === undefined || rules === null) return { status: 'not-recorded' };
  if (typeof rules !== 'object' || Array.isArray(rules)) return candidateInvalid('SNAPSHOT_NOT_OBJECT');

  const r = rules as Record<string, unknown>;

  // Write-path diagnostic shape (produced when build validation failed at save time).
  if (typeof r.error === 'string') {
    if (r.error === 'INVALID_CANDIDATE_RULES_SNAPSHOT' && typeof r.diagnostic === 'string') {
      return candidateInvalid(r.diagnostic);
    }
    return candidateInvalid('MALFORMED_SNAPSHOT');
  }

  // Strict shape: unknown fields (incl. injected timestamps) fail closed.
  for (const key of Object.keys(r)) {
    if (!CANDIDATE_ALLOWED_TOP_KEYS.has(key)) return candidateInvalid('UNKNOWN_FIELD');
  }

  const version = r.candidateRulesSnapshotVersion;
  if (typeof version !== 'number' || !Number.isFinite(version)) return candidateInvalid('VERSION_MISSING');
  if (version !== CANDIDATE_RULES_SNAPSHOT_VERSION) return candidateInvalid('VERSION_UNSUPPORTED');

  if (typeof r.candidateVersion !== 'string' || r.candidateVersion !== CANDIDATE_STRATEGY_VERSION) {
    return candidateInvalid('FIELD_INVALID:candidateVersion');
  }
  if (typeof r.engineVersion !== 'string' || r.engineVersion.length === 0) return candidateInvalid('FIELD_INVALID:engineVersion');
  if (typeof r.symbol !== 'string' || r.symbol.length === 0) return candidateInvalid('FIELD_INVALID:symbol');

  // ── candidate manifest ────────────────────────────────────────────────
  const manifest = r.candidateRules;
  if (!Array.isArray(manifest)) return candidateInvalid('FIELD_INVALID:candidateRules');
  const seen = new Set<string>();
  const entries: CandidateRuleManifestEntry[] = [];
  for (const raw of manifest) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return candidateInvalid('ENTRY_SHAPE_INVALID');
    const e = raw as Record<string, unknown>;
    const keys = Object.keys(e);
    if (keys.length !== ENTRY_KEYS.length || ENTRY_KEYS.some((k) => !(k in e))) {
      return candidateInvalid('ENTRY_SHAPE_INVALID');
    }
    const id = e.id;
    if (typeof id !== 'string') return candidateInvalid('ENTRY_SHAPE_INVALID');
    const spec = CANDIDATE_SPEC_BY_ID.get(id);
    if (!spec) return candidateInvalid('UNKNOWN_RULE_ID');
    if (seen.has(id)) return candidateInvalid('DUPLICATE_RULE_ID');
    seen.add(id);

    const value = e.value;
    if (spec.kind === 'digits') {
      if (value === null) {
        if (e.source !== 'unavailable') return candidateInvalid('PROVENANCE_CONTRADICTION');
      } else if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0) {
        if (e.source !== 'broker-metadata') return candidateInvalid('PROVENANCE_CONTRADICTION');
      } else {
        return candidateInvalid('NON_FINITE_VALUE');
      }
    } else if (spec.kind === 'number') {
      if (value === null) return candidateInvalid('NON_FINITE_VALUE');
      if (typeof value !== 'number') return candidateInvalid('VALUE_TYPE_INVALID');
      if (!Number.isFinite(value)) return candidateInvalid('NON_FINITE_VALUE');
      if (value !== spec.value) return candidateInvalid('VALUE_DRIFT'); // frozen constants must match the spec verbatim
    } else {
      if (typeof value !== 'string' || value.length === 0) return candidateInvalid('VALUE_TYPE_INVALID');
      if (value !== spec.value) return candidateInvalid('VALUE_DRIFT'); // frozen constants must match the spec verbatim
    }

    if (e.unit !== spec.unit || e.scope !== spec.scope) return candidateInvalid('ENTRY_META_MISMATCH');
    if (e.source !== spec.source && spec.kind !== 'digits') return candidateInvalid('PROVENANCE_CONTRADICTION');

    entries.push({
      id,
      value: value as number | string | string[] | null,
      unit: spec.unit,
      scope: spec.scope,
      source: e.source as CandidateRuleProvenance,
    });
  }
  for (const spec of CANDIDATE_RULE_SPECS) {
    if (!seen.has(spec.id)) return candidateInvalid('RULE_MISSING');
  }

  // ── embedded baseline snapshot (structural + own-hash integrity) ──────
  const b = r.baselineRulesSnapshot;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return candidateInvalid('FIELD_INVALID:baselineRulesSnapshot');
  const bs = b as Record<string, unknown>;
  for (const key of Object.keys(bs)) {
    if (!BASELINE_ALLOWED_TOP_KEYS.has(key)) return candidateInvalid('BASELINE_UNKNOWN_FIELD');
  }
  if (typeof bs.rulesSnapshotVersion !== 'number' || !Number.isFinite(bs.rulesSnapshotVersion)) return candidateInvalid('BASELINE_VERSION_MISSING');
  if (bs.rulesSnapshotVersion !== 1) return candidateInvalid('BASELINE_VERSION_UNSUPPORTED');
  if (typeof bs.engineVersion !== 'string' || bs.engineVersion.length === 0) return candidateInvalid('BASELINE_FIELD_INVALID:engineVersion');
  if (typeof bs.strategyVersion !== 'string' || bs.strategyVersion !== SIGNAL_STRATEGY_VERSION) return candidateInvalid('BASELINE_FIELD_INVALID:strategyVersion');
  if (typeof bs.symbol !== 'string' || bs.symbol.length === 0) return candidateInvalid('BASELINE_FIELD_INVALID:symbol');
  if (!Array.isArray(bs.rules) || bs.rules.length === 0) return candidateInvalid('BASELINE_FIELD_INVALID:rules');
  const baselineEntries: RuleManifestEntry[] = [];
  for (const raw of bs.rules) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return candidateInvalid('BASELINE_ENTRY_SHAPE_INVALID');
    const e = raw as Record<string, unknown>;
    const keys = Object.keys(e);
    if (keys.length !== ENTRY_KEYS.length || ENTRY_KEYS.some((k) => !(k in e))) return candidateInvalid('BASELINE_ENTRY_SHAPE_INVALID');
    if (typeof e.id !== 'string' || e.id.length === 0) return candidateInvalid('BASELINE_ENTRY_SHAPE_INVALID');
    if (typeof e.unit !== 'string' || typeof e.scope !== 'string' || typeof e.source !== 'string') return candidateInvalid('BASELINE_ENTRY_SHAPE_INVALID');
    if (e.value !== null && typeof e.value !== 'number' && typeof e.value !== 'string' && !Array.isArray(e.value)) {
      return candidateInvalid('BASELINE_VALUE_TYPE_INVALID');
    }
    baselineEntries.push({
      id: e.id,
      value: e.value as number | string | string[] | null,
      unit: e.unit,
      scope: e.scope,
      source: e.source as RuleManifestEntry['source'],
    });
  }
  if (typeof bs.snapshotHash !== 'string' || !HEX64.test(bs.snapshotHash)) return candidateInvalid('BASELINE_HASH_FORMAT_INVALID');
  const baselineHashRecomputed = computeBaselineSnapshotHash({
    rulesSnapshotVersion: bs.rulesSnapshotVersion as number,
    engineVersion: bs.engineVersion as string,
    strategyVersion: bs.strategyVersion as string,
    symbol: bs.symbol as string,
    rules: baselineEntries,
  });
  if (baselineHashRecomputed !== bs.snapshotHash) return candidateInvalid('BASELINE_HASH_MISMATCH');

  const baselineSnapshot: RulesSnapshot = {
    rulesSnapshotVersion: bs.rulesSnapshotVersion as number,
    engineVersion: bs.engineVersion as string,
    strategyVersion: bs.strategyVersion as string,
    symbol: bs.symbol as string,
    rules: baselineEntries,
    snapshotHash: bs.snapshotHash as string,
  };

  // ── outer integrity: 64-hex + recomputed hash over the whole payload ──
  const storedHash = r.snapshotHash;
  if (typeof storedHash !== 'string' || !HEX64.test(storedHash)) return candidateInvalid('HASH_FORMAT_INVALID');
  const recomputed = computeCandidateSnapshotHash({
    candidateRulesSnapshotVersion: version,
    candidateVersion: r.candidateVersion as string,
    engineVersion: r.engineVersion as string,
    symbol: r.symbol as string,
    candidateRules: entries,
    baselineRulesSnapshot: baselineSnapshot,
  });
  if (recomputed !== storedHash) return candidateInvalid('HASH_MISMATCH');

  return {
    status: 'present',
    snapshot: {
      candidateRulesSnapshotVersion: version,
      candidateVersion: r.candidateVersion as string,
      engineVersion: r.engineVersion as string,
      symbol: r.symbol as string,
      candidateRules: entries,
      baselineRulesSnapshot: baselineSnapshot,
      snapshotHash: storedHash,
    },
  };
}
