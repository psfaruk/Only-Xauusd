/**
 * XAUUSD AI Trading Agent — Rules Snapshot (Phase 10.3-D)
 * ----------------------------------------------------------------------------
 * DETERMINISTIC, VERSIONED, AUDITABLE snapshot of the strategy rules ACTUALLY
 * USED for one signal evaluation. Closes the Phase 9 gap where
 * `inputSnapshot.rules` was persisted as null (the rules were only hash-
 * committed inside inputFingerprint, never readable).
 *
 * Design (audit/phase10.3d-rules-snapshot-observability.md §4):
 *   · Stored INSIDE the existing `inputSnapshot.rules` JSON key — no migration,
 *     no schema change. Legacy rows keep `rules: null` → read as NOT-RECORDED
 *     (never backfilled, never reconstructed — the dashboard says so).
 *   · Compact manifest (24 entries ≈ 2 KB): rule id / actual value / unit /
 *     scope / provenance. No market-data copy, no quotes, no candles, NO
 *     SECRETS (values are the documented, publicly-rendered thresholds).
 *   · NO timestamps inside the snapshot — the evaluation instant is the row's
 *     own createdAt/generatedAtUtc. Unknown fields (incl. injected timestamps)
 *     are rejected fail-closed by the strict parser.
 *   · `snapshotHash` = sha256, namespaced `rules-snapshot/1` — INTEGRITY ONLY.
 *     Deliberately separate from the Phase 10.3-A setup fingerprint,
 *     inputFingerprint and the Phase 10.2 protocol fingerprint. It implies
 *     nothing about authenticity or broker verification.
 *   · Rules are the CONFIGURATION IN FORCE for that evaluation. Whether a rule
 *     passed or failed is the evaluation's reasonCodes surface — a different
 *     concept that the dashboard keeps visibly separate.
 *
 * Pure module: no database, no network, no clock, no env reads.
 */

import { createHash } from 'node:crypto';
import type { StrategyRules } from './types';

/** Snapshot FORMAT version (bump on any format change — old readers then fail closed). */
export const RULES_SNAPSHOT_VERSION = 1;

/** Re-export alias so callers/tests can build modified rule sets without import gymnastics. */
export type StrategyRulesLike = StrategyRules;

export type RuleProvenance =
  | 'verified-configuration' // value from src/lib/config.ts (the verified config)
  | 'strategy-constant' // hard-locked constant in signal/rules.ts|types.ts
  | 'broker-metadata' // verified SymbolSpec value (digits)
  | 'unavailable'; // genuinely not available at evaluation time (digits null)

export interface RuleManifestEntry {
  id: string;
  value: number | string | string[] | null; // null ONLY for unavailable entries
  unit: string;
  scope: string;
  source: RuleProvenance;
}

export interface RulesSnapshot {
  rulesSnapshotVersion: number;
  engineVersion: string;
  strategyVersion: string;
  symbol: string;
  rules: RuleManifestEntry[];
  snapshotHash: string;
}

/** Per-evaluation metadata the snapshot captures (from the evaluation itself). */
export interface RulesSnapshotMeta {
  symbol: string;
  engineVersion: string;
  /** Verified broker digits at evaluation time; null = unavailable (spec missing). */
  digits: number | null;
}

export type RulesSnapshotBuild =
  | { ok: true; snapshot: RulesSnapshot }
  | { ok: false; diagnostic: string };

// ---------------------------------------------------------------------------
// Manifest specification — the single source of truth for build AND parse.
// Fixed construction order → stable canonical serialization.
// ---------------------------------------------------------------------------

type ValueKind = 'number' | 'string' | 'stringArray' | 'digits';

interface RuleSpec {
  id: string;
  unit: string;
  scope: string;
  source: RuleProvenance;
  kind: ValueKind;
  extract: (rules: StrategyRules) => number | string | string[];
}

const RULE_SPECS: readonly RuleSpec[] = [
  { id: 'strategy.version', unit: 'version', scope: 'identity', source: 'strategy-constant', kind: 'string', extract: (r) => r.strategyVersion },
  { id: 'signal.executionTf', unit: 'timeframe', scope: 'eligibility', source: 'strategy-constant', kind: 'string', extract: (r) => r.executionTf },
  { id: 'signal.contextTfs', unit: 'timeframes', scope: 'eligibility', source: 'strategy-constant', kind: 'stringArray', extract: (r) => [...r.contextTfs] },
  { id: 'analysis.windowBars', unit: 'bars', scope: 'window', source: 'verified-configuration', kind: 'number', extract: (r) => r.windowBars },
  { id: 'analysis.minExecutionBars', unit: 'bars', scope: 'eligibility', source: 'verified-configuration', kind: 'number', extract: (r) => r.minExecutionBars },
  { id: 'signal.minH1Bars', unit: 'bars', scope: 'eligibility', source: 'verified-configuration', kind: 'number', extract: (r) => r.minH1Bars },
  { id: 'signal.minH4Bars', unit: 'bars', scope: 'eligibility', source: 'verified-configuration', kind: 'number', extract: (r) => r.minH4Bars },
  { id: 'analysis.swingLeft', unit: 'bars', scope: 'eligibility', source: 'verified-configuration', kind: 'number', extract: (r) => r.swingLeft },
  { id: 'analysis.swingRight', unit: 'bars', scope: 'eligibility', source: 'verified-configuration', kind: 'number', extract: (r) => r.swingRight },
  { id: 'signal.maxBarsSinceBreak', unit: 'bars', scope: 'eligibility', source: 'verified-configuration', kind: 'number', extract: (r) => r.maxBarsSinceBreak },
  { id: 'signal.zoneWidthAtr', unit: 'atr_multiple', scope: 'entry', source: 'verified-configuration', kind: 'number', extract: (r) => r.zoneWidthAtr },
  { id: 'signal.entryToleranceAtr', unit: 'atr_multiple', scope: 'entry', source: 'verified-configuration', kind: 'number', extract: (r) => r.entryToleranceAtr },
  { id: 'signal.slAtrBuffer', unit: 'atr_multiple', scope: 'risk', source: 'verified-configuration', kind: 'number', extract: (r) => r.slAtrBuffer },
  { id: 'signal.rewardRisk', unit: 'r_multiple', scope: 'risk', source: 'verified-configuration', kind: 'number', extract: (r) => r.rewardRisk },
  { id: 'signal.minAdx', unit: 'adx', scope: 'eligibility', source: 'verified-configuration', kind: 'number', extract: (r) => r.minAdx },
  { id: 'signal.rsiBuyMin', unit: 'rsi', scope: 'eligibility', source: 'verified-configuration', kind: 'number', extract: (r) => r.rsiBuyMin },
  { id: 'signal.rsiBuyMax', unit: 'rsi', scope: 'eligibility', source: 'verified-configuration', kind: 'number', extract: (r) => r.rsiBuyMax },
  { id: 'signal.maxSpreadPrice', unit: 'price', scope: 'eligibility', source: 'verified-configuration', kind: 'number', extract: (r) => r.maxSpreadPrice },
  { id: 'signal.expiryBars', unit: 'bars', scope: 'expiry', source: 'verified-configuration', kind: 'number', extract: (r) => r.expiryBars },
  { id: 'indicator.emaPeriod', unit: 'period', scope: 'indicator', source: 'strategy-constant', kind: 'number', extract: (r) => r.emaPeriod },
  { id: 'indicator.rsiPeriod', unit: 'period', scope: 'indicator', source: 'strategy-constant', kind: 'number', extract: (r) => r.rsiPeriod },
  { id: 'indicator.atrPeriod', unit: 'period', scope: 'indicator', source: 'strategy-constant', kind: 'number', extract: (r) => r.atrPeriod },
  { id: 'indicator.adxPeriod', unit: 'period', scope: 'indicator', source: 'strategy-constant', kind: 'number', extract: (r) => r.adxPeriod },
  // Broker-verified metadata (NOT a StrategyRules field — supplied via meta):
  { id: 'symbol.digits', unit: 'digits', scope: 'metadata', source: 'broker-metadata', kind: 'digits', extract: () => 0 /* placeholder — replaced from meta */ },
] as const;

const SPEC_BY_ID = new Map(RULE_SPECS.map((s) => [s.id, s]));
const DIGITS_ID = 'symbol.digits';

// ---------------------------------------------------------------------------
// Hash — integrity only, namespaced, separate from every other fingerprint
// ---------------------------------------------------------------------------

function computeSnapshotHash(payload: {
  rulesSnapshotVersion: number;
  engineVersion: string;
  strategyVersion: string;
  symbol: string;
  rules: RuleManifestEntry[];
}): string {
  return createHash('sha256')
    .update(`rules-snapshot/${RULES_SNAPSHOT_VERSION}:`)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Build (write side)
// ---------------------------------------------------------------------------

/**
 * Build the deterministic snapshot of the rules ACTUALLY USED for one
 * evaluation. Total function: validation failures return a structured
 * diagnostic (never throws — persistence must never mask the verdict).
 */
export function buildRulesSnapshot(rules: StrategyRules, meta: RulesSnapshotMeta): RulesSnapshotBuild {
  if (typeof meta.symbol !== 'string' || meta.symbol.length === 0) {
    return { ok: false, diagnostic: 'META_INVALID:symbol' };
  }
  if (typeof meta.engineVersion !== 'string' || meta.engineVersion.length === 0) {
    return { ok: false, diagnostic: 'META_INVALID:engineVersion' };
  }
  if (meta.digits !== null && (typeof meta.digits !== 'number' || !Number.isInteger(meta.digits) || meta.digits < 0 || !Number.isFinite(meta.digits))) {
    return { ok: false, diagnostic: 'NON_FINITE_VALUE:symbol.digits' };
  }

  const entries: RuleManifestEntry[] = [];
  for (const spec of RULE_SPECS) {
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
    const extracted = spec.extract(rules);
    if (spec.kind === 'number') {
      if (typeof extracted !== 'number' || !Number.isFinite(extracted)) {
        return { ok: false, diagnostic: `NON_FINITE_VALUE:${spec.id}` };
      }
    } else if (spec.kind === 'string') {
      if (typeof extracted !== 'string' || extracted.length === 0) {
        return { ok: false, diagnostic: `VALUE_TYPE_INVALID:${spec.id}` };
      }
    } else {
      if (
        !Array.isArray(extracted) ||
        extracted.length === 0 ||
        extracted.some((v) => typeof v !== 'string' || v.length === 0)
      ) {
        return { ok: false, diagnostic: `VALUE_TYPE_INVALID:${spec.id}` };
      }
    }
    entries.push({
      id: spec.id,
      value: extracted as number | string | string[],
      unit: spec.unit,
      scope: spec.scope,
      source: spec.source,
    });
  }

  const strategyVersion = entries.find((e) => e.id === 'strategy.version')?.value;
  if (typeof strategyVersion !== 'string') {
    return { ok: false, diagnostic: 'VALUE_TYPE_INVALID:strategy.version' };
  }

  const payload = {
    rulesSnapshotVersion: RULES_SNAPSHOT_VERSION,
    engineVersion: meta.engineVersion,
    strategyVersion,
    symbol: meta.symbol,
    rules: entries,
  };
  return {
    ok: true,
    snapshot: { ...payload, snapshotHash: computeSnapshotHash(payload) },
  };
}

/** Canonical serialization (fixed key order by construction — single build path). */
export function serializeRulesSnapshot(snapshot: RulesSnapshot): string {
  return JSON.stringify(snapshot);
}

// ---------------------------------------------------------------------------
// Parse (read boundary) — strict, fail-closed, never throws
// ---------------------------------------------------------------------------

export type RulesSnapshotRead =
  | { status: 'present'; snapshot: RulesSnapshot }
  | { status: 'not-recorded' } // legacy row: rules null/absent — honestly absent
  | { status: 'invalid'; reason: string }; // malformed/contradictory — safe diagnostic

const ALLOWED_TOP_KEYS = new Set([
  'rulesSnapshotVersion', 'engineVersion', 'strategyVersion', 'symbol', 'rules', 'snapshotHash',
]);
const ENTRY_KEYS = ['id', 'value', 'unit', 'scope', 'source'];
const HEX64 = /^[0-9a-f]{64}$/;

function invalid(reason: string): RulesSnapshotRead {
  return { status: 'invalid', reason };
}

/**
 * Parse `inputSnapshot` JSON (the WHOLE column value) into a RulesSnapshotRead.
 * Distinguishes: legacy not-recorded, write-path diagnostics, malformed data,
 * contradictory provenance, and hash/integrity failures. Never recomputes
 * anything from current configuration — the STORED snapshot is the truth.
 */
export function parseRulesSnapshot(inputSnapshotJson: string | null): RulesSnapshotRead {
  if (inputSnapshotJson === null) return { status: 'not-recorded' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputSnapshotJson);
  } catch {
    return invalid('MALFORMED_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'not-recorded' };
  }
  const rules = (parsed as Record<string, unknown>).rules;
  if (rules === undefined || rules === null) return { status: 'not-recorded' };
  if (typeof rules !== 'object' || Array.isArray(rules)) return invalid('SNAPSHOT_NOT_OBJECT');

  const r = rules as Record<string, unknown>;

  // Write-path diagnostic shape (produced when build validation failed at save time).
  if (typeof r.error === 'string') {
    if (r.error === 'INVALID_RULES_SNAPSHOT' && typeof r.diagnostic === 'string') {
      return invalid(r.diagnostic);
    }
    return invalid('MALFORMED_SNAPSHOT');
  }

  // Strict shape: unknown fields (incl. injected timestamps) fail closed.
  for (const key of Object.keys(r)) {
    if (!ALLOWED_TOP_KEYS.has(key)) return invalid('UNKNOWN_FIELD');
  }

  const version = r.rulesSnapshotVersion;
  if (typeof version !== 'number' || !Number.isFinite(version)) return invalid('VERSION_MISSING');
  if (version !== RULES_SNAPSHOT_VERSION) return invalid('VERSION_UNSUPPORTED');

  if (typeof r.engineVersion !== 'string' || r.engineVersion.length === 0) return invalid('FIELD_INVALID:engineVersion');
  if (typeof r.strategyVersion !== 'string' || r.strategyVersion.length === 0) return invalid('FIELD_INVALID:strategyVersion');
  if (typeof r.symbol !== 'string' || r.symbol.length === 0) return invalid('FIELD_INVALID:symbol');

  const manifest = r.rules;
  if (!Array.isArray(manifest)) return invalid('FIELD_INVALID:rules');

  const seen = new Set<string>();
  const entries: RuleManifestEntry[] = [];
  for (const raw of manifest) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalid('ENTRY_SHAPE_INVALID');
    const e = raw as Record<string, unknown>;
    const keys = Object.keys(e);
    if (keys.length !== ENTRY_KEYS.length || ENTRY_KEYS.some((k) => !(k in e))) {
      return invalid('ENTRY_SHAPE_INVALID');
    }
    const id = e.id;
    if (typeof id !== 'string') return invalid('ENTRY_SHAPE_INVALID');
    const spec = SPEC_BY_ID.get(id);
    if (!spec) return invalid('UNKNOWN_RULE_ID');
    if (seen.has(id)) return invalid('DUPLICATE_RULE_ID');
    seen.add(id);

    const value = e.value;
    if (spec.kind === 'digits') {
      if (value === null) {
        if (e.source !== 'unavailable') return invalid('PROVENANCE_CONTRADICTION');
      } else if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0) {
        if (e.source !== 'broker-metadata') return invalid('PROVENANCE_CONTRADICTION');
      } else {
        return invalid('NON_FINITE_VALUE');
      }
    } else if (spec.kind === 'number') {
      if (value === null) return invalid('NON_FINITE_VALUE'); // JSON.stringify(NaN/Infinity) === null
      if (typeof value !== 'number') return invalid('VALUE_TYPE_INVALID');
      if (!Number.isFinite(value)) return invalid('NON_FINITE_VALUE');
    } else if (spec.kind === 'string') {
      if (typeof value !== 'string' || value.length === 0) return invalid('VALUE_TYPE_INVALID');
    } else {
      if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || v.length === 0)) {
        return invalid('VALUE_TYPE_INVALID');
      }
    }

    if (e.unit !== spec.unit || e.scope !== spec.scope) return invalid('ENTRY_META_MISMATCH');
    if (e.source !== spec.source && spec.kind !== 'digits') return invalid('PROVENANCE_CONTRADICTION');

    entries.push({
      id,
      value: value as number | string | string[] | null,
      unit: spec.unit,
      scope: spec.scope,
      source: e.source as RuleProvenance,
    });
  }

  // Completeness: every known rule must be present.
  for (const spec of RULE_SPECS) {
    if (!seen.has(spec.id)) return invalid('RULE_MISSING');
  }

  // Integrity: 64-hex format + recomputed hash over the parsed payload.
  const storedHash = r.snapshotHash;
  if (typeof storedHash !== 'string' || !HEX64.test(storedHash)) return invalid('HASH_FORMAT_INVALID');
  const recomputed = computeSnapshotHash({
    rulesSnapshotVersion: version,
    engineVersion: r.engineVersion,
    strategyVersion: r.strategyVersion,
    symbol: r.symbol,
    rules: entries,
  });
  if (recomputed !== storedHash) return invalid('HASH_MISMATCH');

  return {
    status: 'present',
    snapshot: {
      rulesSnapshotVersion: version,
      engineVersion: r.engineVersion,
      strategyVersion: r.strategyVersion,
      symbol: r.symbol,
      rules: entries,
      snapshotHash: storedHash,
    },
  };
}
