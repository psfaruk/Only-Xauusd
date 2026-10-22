/**
 * PHASE 11-E — CANDIDATE RULES SNAPSHOT TESTS (candidate-rules-snapshot/1).
 * ----------------------------------------------------------------------------
 * Pins the Phase 10.3-D discipline, namespaced for the candidate (protocol §1
 * of audit/phase11-candidate-forward-protocol.md):
 *   · build: the frozen CANDIDATE_RULES verbatim + identity labels + the
 *     embedded baseline manifest (via the SAME validated buildRulesSnapshot)
 *   · provenance labels: candidate-constant / candidate-identity /
 *     broker-metadata / unavailable
 *   · deterministic snapshotHash (sha256, candidate-rules-snapshot/1)
 *   · strict parse: present / not-recorded / invalid (unknown fields, wrong
 *     version, value drift vs the frozen constants, hash tampering) — the
 *     STORED snapshot is the truth, never recomputed from current config
 *   · no timestamps inside the snapshot
 */

// Hermeticity (Task 44 order-dependence fix): this file imports
// @/lib/signal/rules → @/lib/config. Without the market setup import FIRST,
// bun's .env auto-load can evaluate @/lib/config with the REAL
// MT5_BRIDGE_URL before tests/market/* runs, poisoning the process-wide
// config cache — the fail-closed api tests would then probe the LIVE bridge
// instead of asserting BRIDGE_NOT_CONFIGURED.
import '../market/helpers/setup';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { buildStrategyRules } from '@/lib/signal/rules';
import { SIGNAL_ENGINE_VERSION, SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';
import { CANDIDATE_RULES, CANDIDATE_STRATEGY_VERSION, CANDIDATE_IDENTITY_VERSION } from '@/lib/signal/candidate/types';
import {
  buildRulesSnapshot,
} from '@/lib/signal/rules-snapshot';
import {
  CANDIDATE_RULES_SNAPSHOT_VERSION,
  buildCandidateRulesSnapshot,
  computeBaselineSnapshotHash,
  parseCandidateRulesSnapshot,
  type CandidateRulesSnapshot,
} from '@/lib/signal/candidate-rules-snapshot';

const SYMBOL = 'XAUUSDm';
const META = { symbol: SYMBOL, engineVersion: SIGNAL_ENGINE_VERSION, digits: 3 };

describe('candidate rules snapshot — build (pure)', () => {
  test('complete valid snapshot: 14 candidate entries + the embedded baseline manifest, frozen values verbatim', () => {
    const rules = buildStrategyRules();
    const built = buildCandidateRulesSnapshot(rules, META);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const snap = built.snapshot;
    expect(snap.candidateRulesSnapshotVersion).toBe(CANDIDATE_RULES_SNAPSHOT_VERSION);
    expect(snap.candidateVersion).toBe(CANDIDATE_STRATEGY_VERSION);
    expect(snap.engineVersion).toBe(SIGNAL_ENGINE_VERSION);
    expect(snap.symbol).toBe(SYMBOL);
    expect(snap.candidateRules).toHaveLength(14);

    const byId = new Map(snap.candidateRules.map((e) => [e.id, e]));
    // Frozen spec constants — verbatim (any drift is a protocol violation).
    expect(byId.get('candidate.m5WindowBars')?.value).toBe(CANDIDATE_RULES.m5WindowBars);
    expect(byId.get('candidate.modelB.pullbackLookbackBars')?.value).toBe(CANDIDATE_RULES.pullbackLookbackBars);
    expect(byId.get('candidate.modelB.pullbackZoneAtr')?.value).toBe(CANDIDATE_RULES.pullbackZoneAtr);
    expect(byId.get('candidate.modelB.pullbackMaxDepthAtr')?.value).toBe(CANDIDATE_RULES.pullbackMaxDepthAtr);
    expect(byId.get('candidate.modelC.rangeLookbackBars')?.value).toBe(CANDIDATE_RULES.rangeLookbackBars);
    expect(byId.get('candidate.modelC.rangeBandAtr')?.value).toBe(CANDIDATE_RULES.rangeBandAtr);
    expect(byId.get('candidate.modelC.rangeMinHeightAtr')?.value).toBe(CANDIDATE_RULES.rangeMinHeightAtr);
    expect(byId.get('candidate.modelC.rangeMaxHeightAtr')?.value).toBe(CANDIDATE_RULES.rangeMaxHeightAtr);
    expect(byId.get('candidate.modelC.sweepLookbackBars')?.value).toBe(CANDIDATE_RULES.sweepLookbackBars);
    expect(byId.get('candidate.modelC.sweepMinBeyondAtr')?.value).toBe(CANDIDATE_RULES.sweepMinBeyondAtr);
    // Identity labels.
    expect(byId.get('candidate.strategyVersion')?.value).toBe(CANDIDATE_STRATEGY_VERSION);
    expect(byId.get('candidate.identityNamespace')?.value).toBe(CANDIDATE_IDENTITY_VERSION);
    expect(byId.get('candidate.confirmationTf')?.value).toBe('M5');
    // Provenance labels.
    expect(byId.get('candidate.m5WindowBars')?.source).toBe('candidate-constant');
    expect(byId.get('candidate.strategyVersion')?.source).toBe('candidate-identity');
    expect(byId.get('symbol.digits')?.value).toBe(3);
    expect(byId.get('symbol.digits')?.source).toBe('broker-metadata');

    // The embedded baseline manifest is the FULL validated baseline snapshot.
    expect(snap.baselineRulesSnapshot.rules).toHaveLength(24);
    expect(snap.baselineRulesSnapshot.strategyVersion).toBe(SIGNAL_STRATEGY_VERSION);
    expect(snap.baselineRulesSnapshot.engineVersion).toBe(SIGNAL_ENGINE_VERSION);
    expect(snap.baselineRulesSnapshot.symbol).toBe(SYMBOL);
    expect(snap.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('deterministic: same inputs → byte-identical snapshot (fixed construction order)', () => {
    const rules = buildStrategyRules();
    const a = buildCandidateRulesSnapshot(rules, META);
    const b = buildCandidateRulesSnapshot(rules, META);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
  });

  test('digits null → symbol.digits unavailable (honest), still builds', () => {
    const built = buildCandidateRulesSnapshot(buildStrategyRules(), { ...META, digits: null });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const digitsEntry = built.snapshot.candidateRules.find((e) => e.id === 'symbol.digits');
    expect(digitsEntry?.value).toBeNull();
    expect(digitsEntry?.source).toBe('unavailable');
  });

  test('foreign baseline version → fail-closed diagnostic (never mislabeled)', () => {
    const foreign = { ...buildStrategyRules(), strategyVersion: 'hybrid-structure-retest/8.8.8' };
    const built = buildCandidateRulesSnapshot(foreign, META);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.diagnostic).toContain('BASELINE_VERSION_MISMATCH');
  });

  test('invalid digits → structured diagnostic (never throws)', () => {
    const built = buildCandidateRulesSnapshot(buildStrategyRules(), { ...META, digits: Number.NaN });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.diagnostic).toContain('symbol.digits');
  });
});

describe('candidate rules snapshot — parse (strict, fail-closed)', () => {
  const built = buildCandidateRulesSnapshot(buildStrategyRules(), META);
  if (!built.ok) throw new Error('fixture must build');
  const snapshot: CandidateRulesSnapshot = built.snapshot;
  const wrap = (rules: unknown) => JSON.stringify({ windows: null, rules });

  test('round-trip: present, hash + embedded baseline hash verified', () => {
    const read = parseCandidateRulesSnapshot(wrap(snapshot));
    expect(read.status).toBe('present');
    if (read.status !== 'present') return;
    expect(read.snapshot.candidateVersion).toBe(CANDIDATE_STRATEGY_VERSION);
    expect(read.snapshot.candidateRules).toHaveLength(14);
    expect(read.snapshot.baselineRulesSnapshot.rules).toHaveLength(24);
    expect(read.snapshot.snapshotHash).toBe(snapshot.snapshotHash);
    expect(JSON.stringify(read.snapshot)).toBe(JSON.stringify(snapshot));
  });

  test('null / absent rules → not-recorded (never fabricated)', () => {
    expect(parseCandidateRulesSnapshot(null)).toEqual({ status: 'not-recorded' });
    expect(parseCandidateRulesSnapshot(JSON.stringify({ windows: null }))).toEqual({ status: 'not-recorded' });
  });

  test('unknown top-level field → invalid (timestamps can never be injected)', () => {
    const tampered = { ...snapshot, generatedAtUtc: '2026-10-20T00:00:00Z' };
    expect(parseCandidateRulesSnapshot(wrap(tampered))).toMatchObject({ status: 'invalid', reason: 'UNKNOWN_FIELD' });
  });

  test('unsupported version → invalid', () => {
    const tampered = { ...snapshot, candidateRulesSnapshotVersion: 2 };
    expect(parseCandidateRulesSnapshot(wrap(tampered))).toMatchObject({ status: 'invalid', reason: 'VERSION_UNSUPPORTED' });
  });

  test('value drift on a frozen candidate constant → invalid (spec verbatim)', () => {
    const entries = snapshot.candidateRules.map((e) =>
      e.id === 'candidate.m5WindowBars' ? { ...e, value: 999 } : e,
    );
    const tampered = { ...snapshot, candidateRules: entries };
    expect(parseCandidateRulesSnapshot(wrap(tampered))).toMatchObject({ status: 'invalid', reason: 'VALUE_DRIFT' });
  });

  test('outer hash tampering → invalid (HASH_MISMATCH)', () => {
    const tampered = { ...snapshot, snapshotHash: '0'.repeat(64) };
    expect(parseCandidateRulesSnapshot(wrap(tampered))).toMatchObject({ status: 'invalid', reason: 'HASH_MISMATCH' });
  });

  test('embedded baseline snapshot tampering → invalid (inner baseline hash catches it first; the outer hash protects the bytes too)', () => {
    const baseline = { ...snapshot.baselineRulesSnapshot, engineVersion: '0.0.0' };
    const tampered = { ...snapshot, baselineRulesSnapshot: baseline };
    const read = parseCandidateRulesSnapshot(wrap(tampered));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    // The inner baseline hash is verified first (BASELINE_HASH_MISMATCH);
    // without it the outer hash would catch the same tamper (HASH_MISMATCH).
    expect(['BASELINE_HASH_MISMATCH', 'HASH_MISMATCH']).toContain(read.reason);
  });

  test('missing candidate entry → invalid (RULE_MISSING)', () => {
    const entries = snapshot.candidateRules.filter((e) => e.id !== 'candidate.modelC.sweepMinBeyondAtr');
    const tampered = { ...snapshot, candidateRules: entries };
    expect(parseCandidateRulesSnapshot(wrap(tampered))).toMatchObject({ status: 'invalid', reason: 'RULE_MISSING' });
  });

  test('write-path diagnostic shape → invalid with the stored diagnostic', () => {
    const json = JSON.stringify({
      windows: null,
      rules: { candidateRulesSnapshotVersion: CANDIDATE_RULES_SNAPSHOT_VERSION, error: 'INVALID_CANDIDATE_RULES_SNAPSHOT', diagnostic: 'META_INVALID:symbol' },
    });
    expect(parseCandidateRulesSnapshot(json)).toMatchObject({ status: 'invalid', reason: 'META_INVALID:symbol' });
  });

  test('computeBaselineSnapshotHash mirrors the rules-snapshot/1 namespace (embedded integrity)', () => {
    // Recompute the embedded baseline hash exactly as rules-snapshot.ts does.
    const b = buildRulesSnapshot(buildStrategyRules(), META);
    if (!b.ok) throw new Error('baseline fixture must build');
    const recomputed = createHash('sha256')
      .update('rules-snapshot/1:')
      .update(JSON.stringify({
        rulesSnapshotVersion: b.snapshot.rulesSnapshotVersion,
        engineVersion: b.snapshot.engineVersion,
        strategyVersion: b.snapshot.strategyVersion,
        symbol: b.snapshot.symbol,
        rules: b.snapshot.rules,
      }))
      .digest('hex');
    expect(computeBaselineSnapshotHash({
      rulesSnapshotVersion: b.snapshot.rulesSnapshotVersion,
      engineVersion: b.snapshot.engineVersion,
      strategyVersion: b.snapshot.strategyVersion,
      symbol: b.snapshot.symbol,
      rules: b.snapshot.rules,
    })).toBe(recomputed);
    expect(recomputed).toBe(b.snapshot.snapshotHash);
  });

  test('no timestamps inside the snapshot (the row owns the instant)', () => {
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain('generatedAtUtc');
    expect(json).not.toContain('createdAt');
    expect(json).not.toContain('validatedAt');
  });
});
