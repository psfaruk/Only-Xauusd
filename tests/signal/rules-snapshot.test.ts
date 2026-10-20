/**
 * PHASE 10.3-D — RULES SNAPSHOT PERSISTENCE TESTS (test-first, RED phase).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic StrategyRules values + synthetic SignalEvaluation
 * rows on the ISOLATED TEST DATABASE — never real broker data, never secrets.
 *
 * Coverage (user-mandated matrix):
 *   Snapshot construction & validation
 *     · complete valid snapshot (24 manifest entries)
 *     · missing optional rule (parse: entry dropped → hash mismatch)
 *     · missing required snapshot version (parse)
 *     · unknown rule value (NaN / null-as-NaN / wrong type)
 *     · null versus absent field (rules:null vs key absent vs absent snapshot)
 *     · invalid timestamp (strict shape: unknown fields incl. timestamps rejected)
 *     · NaN and Infinity rejection (build + parse)
 *     · stable canonical serialization
 *     · deterministic repeated construction
 *     · verified / derived / unavailable provenance
 *     · no secret fields in serialized snapshot
 *     · historical snapshot is not recomputed from current rules
 *   Persistence
 *     · new evaluation persists the ACTUAL rules used
 *     · existing historical records remain readable
 *     · legacy rows with null snapshots remain null (never rewritten)
 *     · invalid snapshot handled safely (diagnostic row, verdict intact)
 *     · repeated reads do not mutate the snapshot
 *     · duplicate setup evaluation follows 10.3-A identity semantics
 *     · evaluation counts vs distinct setup counts
 *   API
 *     · /api/signal/latest exposes setupFingerprint + rulesSnapshot
 *     · /api/signal/history exposes counts + per-row snapshot fields
 */

import '../market/helpers/setup';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { db } from '@/lib/db';
import { buildStrategyRules } from '@/lib/signal/rules';
import {
  SIGNAL_ENGINE_VERSION,
  SIGNAL_STRATEGY_VERSION,
  type SignalEvaluation,
  type SignalReasonCode,
} from '@/lib/signal/types';
import {
  saveSignalEvaluation,
  getLatestSignalEvaluation,
  getSignalEvaluationHistory,
  getSignalEvaluationCounts,
} from '@/lib/signal/persistence';

import {
  RULES_SNAPSHOT_VERSION,
  buildRulesSnapshot,
  serializeRulesSnapshot,
  parseRulesSnapshot,
  type RulesSnapshot,
  type StrategyRulesLike,
} from '@/lib/signal/rules-snapshot';

const SYMBOL = 'XAUUSDm';
const M15 = 900;
/** Deterministic timestamps (fixed test clock domain, aligned to M15). */
const T0 = 1_791_979_200; // 2026-10-14T12:00:00Z (helpers/setup FIXED_NOW_SEC)
const NOW = () => T0 * 1000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

const META = { symbol: SYMBOL, engineVersion: SIGNAL_ENGINE_VERSION, digits: 3 };

function syntheticEvaluation(overrides: Partial<SignalEvaluation> = {}): SignalEvaluation {
  return {
    engineVersion: SIGNAL_ENGINE_VERSION,
    strategyVersion: SIGNAL_STRATEGY_VERSION,
    symbol: SYMBOL,
    purpose: 'research-signal-not-an-execution-instruction',
    outcome: 'NO_SETUP',
    reasonCodes: ['NO_STRUCTURE_BREAK'] as SignalReasonCode[],
    decisionCandleTimeUtc: iso(T0 - M15),
    setupKnownAtUtc: iso(T0),
    expiryUtc: null,
    levels: null,
    evidence: null,
    inputFingerprint: 'fp-10.3d',
    datasetFingerprint: null,
    generatedAtUtc: iso(T0),
    ...overrides,
  };
}

/** Valid snapshot JSON wrapper as persisted inside inputSnapshot. */
function inputSnapshotWith(snapshot: RulesSnapshot | null): string {
  return JSON.stringify({ windows: null, rules: snapshot });
}

// ---------------------------------------------------------------------------
// Construction & validation (pure)
// ---------------------------------------------------------------------------

describe('rules snapshot — construction (pure)', () => {
  test('complete valid snapshot: 24 manifest entries, correct values from the rules actually passed', () => {
    const rules = buildStrategyRules();
    const built = buildRulesSnapshot(rules, META);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const snap = built.snapshot;
    expect(snap.rulesSnapshotVersion).toBe(RULES_SNAPSHOT_VERSION);
    expect(snap.engineVersion).toBe(SIGNAL_ENGINE_VERSION);
    expect(snap.strategyVersion).toBe(rules.strategyVersion);
    expect(snap.symbol).toBe(SYMBOL);
    expect(snap.rules).toHaveLength(24);

    const byId = new Map(snap.rules.map((e) => [e.id, e]));
    // Values are the ACTUAL configured values (spot checks across every unit/scope):
    expect(byId.get('strategy.version')?.value).toBe(rules.strategyVersion);
    expect(byId.get('signal.executionTf')?.value).toBe(rules.executionTf);
    expect(byId.get('signal.contextTfs')?.value).toEqual([...rules.contextTfs]);
    expect(byId.get('analysis.windowBars')?.value).toBe(rules.windowBars);
    expect(byId.get('signal.maxBarsSinceBreak')?.value).toBe(rules.maxBarsSinceBreak);
    expect(byId.get('signal.zoneWidthAtr')?.value).toBe(rules.zoneWidthAtr);
    expect(byId.get('signal.slAtrBuffer')?.value).toBe(rules.slAtrBuffer);
    expect(byId.get('signal.rewardRisk')?.value).toBe(rules.rewardRisk);
    expect(byId.get('signal.minAdx')?.value).toBe(rules.minAdx);
    expect(byId.get('signal.rsiBuyMin')?.value).toBe(rules.rsiBuyMin);
    expect(byId.get('signal.rsiBuyMax')?.value).toBe(rules.rsiBuyMax);
    expect(byId.get('signal.maxSpreadPrice')?.value).toBe(rules.maxSpreadPrice);
    expect(byId.get('signal.expiryBars')?.value).toBe(rules.expiryBars);
    expect(byId.get('indicator.emaPeriod')?.value).toBe(rules.emaPeriod);
    expect(byId.get('indicator.atrPeriod')?.value).toBe(rules.atrPeriod);
    expect(byId.get('symbol.digits')?.value).toBe(3);
    // Units and scopes are declared (spot checks):
    expect(byId.get('signal.maxBarsSinceBreak')?.unit).toBe('bars');
    expect(byId.get('signal.zoneWidthAtr')?.unit).toBe('atr_multiple');
    expect(byId.get('signal.rewardRisk')?.unit).toBe('r_multiple');
    expect(byId.get('signal.maxSpreadPrice')?.unit).toBe('price');
    expect(byId.get('signal.expiryBars')?.scope).toBe('expiry');
    expect(byId.get('indicator.emaPeriod')?.scope).toBe('indicator');
    expect(byId.get('symbol.digits')?.scope).toBe('metadata');
  });

  test('provenance: verified-configuration, strategy-constant, broker-metadata all present and correct', () => {
    const built = buildRulesSnapshot(buildStrategyRules(), META);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const byId = new Map(built.snapshot.rules.map((e) => [e.id, e]));
    expect(byId.get('signal.maxBarsSinceBreak')?.source).toBe('verified-configuration');
    expect(byId.get('indicator.emaPeriod')?.source).toBe('strategy-constant');
    expect(byId.get('strategy.version')?.source).toBe('strategy-constant');
    expect(byId.get('symbol.digits')?.source).toBe('broker-metadata');
  });

  test('unavailable provenance: digits=null (spec missing) is recorded honestly, not guessed', () => {
    const built = buildRulesSnapshot(buildStrategyRules(), { ...META, digits: null });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const digitsEntry = built.snapshot.rules.find((e) => e.id === 'symbol.digits');
    expect(digitsEntry?.value).toBeNull();
    expect(digitsEntry?.source).toBe('unavailable');
  });

  test('deterministic repeated construction: byte-identical serialization + identical hash', () => {
    const rules = buildStrategyRules();
    const a = buildRulesSnapshot(rules, META);
    const b = buildRulesSnapshot(rules, META);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(serializeRulesSnapshot(a.snapshot)).toBe(serializeRulesSnapshot(b.snapshot));
    expect(a.snapshot.snapshotHash).toBe(b.snapshot.snapshotHash);
    expect(a.snapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('stable canonical serialization: fixed key order (pinned spot check)', () => {
    const built = buildRulesSnapshot(buildStrategyRules(), META);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const json = serializeRulesSnapshot(built.snapshot);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    // Top-level key order is fixed by construction:
    expect(Object.keys(parsed)).toEqual([
      'rulesSnapshotVersion', 'engineVersion', 'strategyVersion', 'symbol', 'rules', 'snapshotHash',
    ]);
    // Entry key order is fixed by construction:
    const entry = (parsed.rules as Array<Record<string, unknown>>)[0];
    expect(Object.keys(entry)).toEqual(['id', 'value', 'unit', 'scope', 'source']);
  });

  test('a changed rule value changes the hash (integrity sensitivity)', () => {
    const rulesA = buildStrategyRules();
    const rulesB: StrategyRulesLike = { ...rulesA, maxBarsSinceBreak: rulesA.maxBarsSinceBreak + 1 };
    const a = buildRulesSnapshot(rulesA, META);
    const b = buildRulesSnapshot(rulesB as never, META);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.snapshot.snapshotHash).not.toBe(b.snapshot.snapshotHash);
  });

  test('a changed digits value changes the snapshot (per-evaluation metadata captured)', () => {
    const rules = buildStrategyRules();
    const a = buildRulesSnapshot(rules, META);
    const b = buildRulesSnapshot(rules, { ...META, digits: 2 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.snapshot.snapshotHash).not.toBe(b.snapshot.snapshotHash);
  });

  test('NaN rule value rejected at build (fail-closed diagnostic)', () => {
    const broken = { ...buildStrategyRules(), rewardRisk: Number.NaN } as never;
    const built = buildRulesSnapshot(broken, META);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.diagnostic).toBeTruthy();
  });

  test('Infinity rule value rejected at build', () => {
    const broken = { ...buildStrategyRules(), minAdx: Number.POSITIVE_INFINITY } as never;
    const built = buildRulesSnapshot(broken, META);
    expect(built.ok).toBe(false);
  });

  test('missing rule field (undefined) rejected at build', () => {
    const rules = buildStrategyRules() as unknown as Record<string, unknown>;
    delete rules.maxBarsSinceBreak;
    const built = buildRulesSnapshot(rules as never, META);
    expect(built.ok).toBe(false);
  });

  test('non-integer / negative digits rejected at build', () => {
    expect(buildRulesSnapshot(buildStrategyRules(), { ...META, digits: Number.NaN }).ok).toBe(false);
    expect(buildRulesSnapshot(buildStrategyRules(), { ...META, digits: -1 }).ok).toBe(false);
    expect(buildRulesSnapshot(buildStrategyRules(), { ...META, digits: 2.5 }).ok).toBe(false);
  });

  test('no secret fields in the serialized snapshot', () => {
    const built = buildRulesSnapshot(buildStrategyRules(), META);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const json = serializeRulesSnapshot(built.snapshot);
    expect(json).not.toMatch(/token|password|secret|credential|api[_-]?key|mt5_|bridge_|login/i);
    const keys = JSON.parse(json) as unknown;
    expect(typeof keys).toBe('object');
  });

  test('snapshot versions come from the EVALUATION, not from "current" constants', () => {
    const historical: StrategyRulesLike = { ...buildStrategyRules(), strategyVersion: 'hybrid-structure-retest/8.8.8' };
    const built = buildRulesSnapshot(historical as never, { ...META, engineVersion: '8.8.0' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.snapshot.strategyVersion).toBe('hybrid-structure-retest/8.8.8');
    expect(built.snapshot.engineVersion).toBe('8.8.0');
  });
});

// ---------------------------------------------------------------------------
// Parse (read boundary) — null vs absent vs malformed vs contradictory
// ---------------------------------------------------------------------------

describe('rules snapshot — parse (read boundary)', () => {
  const built = buildRulesSnapshot(buildStrategyRules(), META);
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error('fixture snapshot must build');
  const snapshot = built.snapshot;
  const validWrapper = inputSnapshotWith(snapshot);

  test('valid snapshot round-trips to present, hash-verified', () => {
    const read = parseRulesSnapshot(validWrapper);
    expect(read.status).toBe('present');
    if (read.status !== 'present') return;
    expect(read.snapshot.snapshotHash).toBe(snapshot.snapshotHash);
    expect(read.snapshot.rules).toHaveLength(24);
  });

  test('legacy row: rules:null → not-recorded (never reconstructed)', () => {
    const read = parseRulesSnapshot('{"windows":null,"rules":null}');
    expect(read.status).toBe('not-recorded');
  });

  test('legacy row: rules key ABSENT → not-recorded', () => {
    const read = parseRulesSnapshot('{"windows":null}');
    expect(read.status).toBe('not-recorded');
  });

  test('null input snapshot (defensive) → not-recorded', () => {
    expect(parseRulesSnapshot(null).status).toBe('not-recorded');
  });

  test('malformed JSON → invalid with safe reason', () => {
    const read = parseRulesSnapshot('{"windows":null,"rules":');
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBeTruthy();
    expect(read.reason).not.toMatch(/token|password|secret/i);
  });

  test('missing required snapshot version → invalid', () => {
    const noVersion = { ...(snapshot as unknown as Record<string, unknown>) };
    delete noVersion.rulesSnapshotVersion;
    const read = parseRulesSnapshot(JSON.stringify({ windows: null, rules: noVersion }));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBe('VERSION_MISSING');
  });

  test('unsupported snapshot version → invalid (fail-closed, no guessed rendering)', () => {
    const future = { ...(snapshot as unknown as Record<string, unknown>), rulesSnapshotVersion: RULES_SNAPSHOT_VERSION + 1 };
    const read = parseRulesSnapshot(JSON.stringify({ windows: null, rules: future }));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBe('VERSION_UNSUPPORTED');
  });

  test('unknown rule value: JSON null where a number belongs (NaN/Infinity survivor) → invalid NON_FINITE_VALUE', () => {
    const entries = snapshot.rules.map((e) => ({ ...e }));
    const idx = entries.findIndex((e) => e.id === 'signal.rewardRisk');
    (entries[idx] as { value: unknown }).value = null; // what JSON.stringify(NaN) produces
    const tampered = rehash({ ...snapshot, rules: entries });
    const read = parseRulesSnapshot(inputSnapshotWith(tampered));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBe('NON_FINITE_VALUE');
  });

  test('wrong value type (string where a number belongs) → invalid', () => {
    const entries = snapshot.rules.map((e) => ({ ...e }));
    const idx = entries.findIndex((e) => e.id === 'signal.minAdx');
    (entries[idx] as { value: unknown }).value = 'fifteen';
    const tampered = rehash({ ...snapshot, rules: entries });
    const read = parseRulesSnapshot(inputSnapshotWith(tampered));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBe('VALUE_TYPE_INVALID');
  });

  test('missing rule entry (dropped from manifest) → invalid', () => {
    const entries = snapshot.rules.slice(0, 23); // drop one entry
    const tampered = rehash({ ...snapshot, rules: entries });
    const read = parseRulesSnapshot(inputSnapshotWith(tampered));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBe('RULE_MISSING');
  });

  test('unknown rule id → invalid', () => {
    const entries = snapshot.rules.map((e) => ({ ...e }));
    (entries[0] as { id: string }).id = 'signal.madeUpRule';
    const tampered = rehash({ ...snapshot, rules: entries });
    const read = parseRulesSnapshot(inputSnapshotWith(tampered));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBe('UNKNOWN_RULE_ID');
  });

  test('duplicate rule id → invalid', () => {
    const entries = [...snapshot.rules, { ...snapshot.rules[0] }];
    const tampered = rehash({ ...snapshot, rules: entries });
    const read = parseRulesSnapshot(inputSnapshotWith(tampered));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBe('DUPLICATE_RULE_ID');
  });

  test('tampered value WITHOUT rehash → invalid HASH_MISMATCH (integrity detection)', () => {
    const entries = snapshot.rules.map((e) => ({ ...e }));
    const idx = entries.findIndex((e) => e.id === 'signal.maxBarsSinceBreak');
    (entries[idx] as { value: number }).value = 99;
    const tampered = { ...snapshot, rules: entries }; // hash left stale on purpose
    const read = parseRulesSnapshot(inputSnapshotWith(tampered));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBe('HASH_MISMATCH');
  });

  test('invalid timestamp / unknown top-level field (e.g. injected capturedAtUtc) → invalid', () => {
    const withTs = { ...(snapshot as unknown as Record<string, unknown>), capturedAtUtc: 'not-a-real-date' };
    const read = parseRulesSnapshot(JSON.stringify({ windows: null, rules: withTs }));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBe('UNKNOWN_FIELD');
  });

  test('contradictory provenance (digits value present but source "unavailable") → invalid', () => {
    const entries = snapshot.rules.map((e) => ({ ...e }));
    const idx = entries.findIndex((e) => e.id === 'symbol.digits');
    (entries[idx] as { source: string }).source = 'unavailable'; // value is 3, not null
    const tampered = rehash({ ...snapshot, rules: entries });
    const read = parseRulesSnapshot(inputSnapshotWith(tampered));
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toBe('PROVENANCE_CONTRADICTION');
  });

  test('write-path diagnostic shape parses to invalid with the recorded diagnostic', () => {
    const diagnostic = JSON.stringify({
      rulesSnapshotVersion: RULES_SNAPSHOT_VERSION,
      error: 'INVALID_RULES_SNAPSHOT',
      diagnostic: 'NON_FINITE_VALUE:signal.rewardRisk',
    });
    const read = parseRulesSnapshot(`{"windows":null,"rules":${diagnostic}}`);
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toContain('NON_FINITE_VALUE');
  });

  test('hash is NOT the setup fingerprint and NOT the input fingerprint (namespaced separation)', () => {
    // The snapshot hash must not accidentally equal a sha256 of raw rule JSON
    // without the namespace (spot check: different payload → different hash).
    const rebuilt = buildRulesSnapshot(buildStrategyRules(), META);
    if (!rebuilt.ok) throw new Error('fixture');
    const unNamespaced = createHash('sha256').update(JSON.stringify(snapshot.rules)).digest('hex');
    expect(rebuilt.snapshot.snapshotHash).not.toBe(unNamespaced);
  });
});

/** Rebuild the hash over a mutated snapshot so only the targeted defect fails. */
function rehash(snap: RulesSnapshot): RulesSnapshot {
  const payload = {
    rulesSnapshotVersion: snap.rulesSnapshotVersion,
    engineVersion: snap.engineVersion,
    strategyVersion: snap.strategyVersion,
    symbol: snap.symbol,
    rules: snap.rules,
  };
  const snapshotHash = createHash('sha256')
    .update(`rules-snapshot/${RULES_SNAPSHOT_VERSION}:`)
    .update(JSON.stringify(payload))
    .digest('hex');
  return { ...snap, snapshotHash };
}

// ---------------------------------------------------------------------------
// Persistence (isolated test DB)
// ---------------------------------------------------------------------------

/** Evidence WITH a structure event — setup-identifiable (10.3-A). */
const EVIDENCE_WITH_EVENT = {
  structureEvent: { type: 'BOS' as const, direction: 'bullish' as const, level: 2650.5, levelText: '2650.5', breakCandleTimeUtc: iso(T0 - 5 * M15), barsSinceBreak: 2 },
  anchorSwing: null,
  indicators: { ema50: 50, rsi14: 60, atr14: 2, adx14: 20 },
  htfContext: { h1Trend: 'unclear' as const, h4Trend: 'unclear' as const },
  decisionClose: 2650, retestBarTimeUtc: null,
  executionWindow: { fromUtc: iso(T0 - 300 * M15), toUtc: iso(T0 - M15), bars: 300 },
  h1Window: { fromUtc: iso(T0 - 300 * 3600), toUtc: iso(T0 - 3600), bars: 300 },
  h4Window: { fromUtc: iso(T0 - 300 * 14400), toUtc: iso(T0 - 14400), bars: 300 },
};

describe('rules snapshot — persistence (integration)', () => {
  test('new evaluation persists the ACTUAL rules used (values match the rules object)', async () => {
    const rules = buildStrategyRules();
    const evaluation = syntheticEvaluation();
    const saved = await saveSignalEvaluation(db, {
      evaluation,
      quote: { symbol: SYMBOL },
      durationMs: 4,
      startedAtUtc: new Date(NOW()),
      executionTimeframe: 'M15',
      rules,
      digits: 3,
    });
    const row = await db.signalEvaluation.findUnique({ where: { id: saved.id } });
    expect(row).toBeTruthy();
    const read = parseRulesSnapshot(row!.inputSnapshot);
    expect(read.status).toBe('present');
    if (read.status !== 'present') return;
    const byId = new Map(read.snapshot.rules.map((e) => [e.id, e.value]));
    expect(byId.get('signal.maxBarsSinceBreak')).toBe(rules.maxBarsSinceBreak);
    expect(byId.get('signal.rewardRisk')).toBe(rules.rewardRisk);
    expect(byId.get('signal.expiryBars')).toBe(rules.expiryBars);
    expect(byId.get('symbol.digits')).toBe(3);
    expect(read.snapshot.strategyVersion).toBe(rules.strategyVersion);
    await db.signalEvaluation.delete({ where: { id: saved.id } });
  });

  test('getLatestSignalEvaluation exposes setupFingerprint + parsed rulesSnapshot', async () => {
    const evaluation = syntheticEvaluation({
      outcome: 'NO_SETUP',
      evidence: EVIDENCE_WITH_EVENT,
    });
    const saved = await saveSignalEvaluation(db, {
      evaluation,
      quote: {},
      durationMs: 4,
      startedAtUtc: new Date(NOW()),
      executionTimeframe: 'M15',
      rules: buildStrategyRules(),
      digits: 3,
    });
    const latest = await getLatestSignalEvaluation(db, SYMBOL);
    expect(latest?.id).toBe(saved.id);
    expect(latest?.rulesSnapshot.status).toBe('present');
    expect(typeof latest?.setupFingerprint).toBe('string');
    await db.signalEvaluation.delete({ where: { id: saved.id } });
  });

  test('legacy row (rules:null) remains readable and NOT-recorded — and stays null in the DB', async () => {
    await db.signalEvaluation.deleteMany(); // row-order isolation: this test owns "latest"
    const legacy = await db.signalEvaluation.create({
      data: {
        engineVersion: SIGNAL_ENGINE_VERSION,
        strategyVersion: SIGNAL_STRATEGY_VERSION,
        symbol: SYMBOL,
        outcome: 'WAIT',
        reasonCodes: JSON.stringify(['RETEST_PENDING']),
        inputFingerprint: 'fp-legacy',
        setupFingerprint: null,
        inputSnapshot: JSON.stringify({ windows: null, rules: null }),
        evidence: JSON.stringify({}),
        levels: null,
        quote: JSON.stringify({}),
        executionLocked: true,
        createdAt: new Date(NOW()),
      },
    });
    const latest = await getLatestSignalEvaluation(db, SYMBOL);
    expect(latest?.id).toBe(legacy.id);
    expect(latest?.rulesSnapshot.status).toBe('not-recorded');
    expect(latest?.setupFingerprint).toBeNull();
    // Read must NOT rewrite the row (re-read → byte-identical stored snapshot):
    const rowAfter = await db.signalEvaluation.findUnique({ where: { id: legacy.id } });
    expect(rowAfter?.inputSnapshot).toBe(JSON.stringify({ windows: null, rules: null }));
    await db.signalEvaluation.delete({ where: { id: legacy.id } });
  });

  test('repeated reads do not mutate the snapshot (read-path purity)', async () => {
    const saved = await saveSignalEvaluation(db, {
      evaluation: syntheticEvaluation(),
      quote: {},
      durationMs: 4,
      startedAtUtc: new Date(NOW()),
      executionTimeframe: 'M15',
      rules: buildStrategyRules(),
      digits: 3,
    });
    const row1 = await db.signalEvaluation.findUnique({ where: { id: saved.id } });
    const read1 = parseRulesSnapshot(row1!.inputSnapshot);
    await getLatestSignalEvaluation(db, SYMBOL);
    await getSignalEvaluationHistory(db, SYMBOL, 5);
    const row2 = await db.signalEvaluation.findUnique({ where: { id: saved.id } });
    expect(row2!.inputSnapshot).toBe(row1!.inputSnapshot);
    const read2 = parseRulesSnapshot(row2!.inputSnapshot);
    expect(read1.status).toBe('present');
    expect(read2.status).toBe('present');
    if (read1.status === 'present' && read2.status === 'present') {
      expect(serializeRulesSnapshot(read2.snapshot)).toBe(serializeRulesSnapshot(read1.snapshot));
    }
    await db.signalEvaluation.delete({ where: { id: saved.id } });
  });

  test('historical snapshot is NOT recomputed from current rules (stored truth wins)', async () => {
    await db.signalEvaluation.deleteMany(); // row-order isolation: this test owns "latest"
    // A valid snapshot built from DIFFERENT (historical) rules:
    const historical: StrategyRulesLike = {
      ...buildStrategyRules(),
      maxBarsSinceBreak: 99,
      rewardRisk: 3.5,
      strategyVersion: 'hybrid-structure-retest/8.8.8',
    };
    const built = buildRulesSnapshot(historical as never, { ...META, digits: 2 });
    if (!built.ok) throw new Error('fixture must build');
    const row = await db.signalEvaluation.create({
      data: {
        engineVersion: '8.8.0',
        strategyVersion: 'hybrid-structure-retest/8.8.8',
        symbol: SYMBOL,
        outcome: 'WAIT',
        reasonCodes: JSON.stringify(['RETEST_PENDING']),
        inputFingerprint: 'fp-historical',
        setupFingerprint: null,
        inputSnapshot: inputSnapshotWith(built.snapshot),
        evidence: JSON.stringify({}),
        levels: null,
        quote: JSON.stringify({}),
        executionLocked: true,
        createdAt: new Date(NOW()),
      },
    });
    // Phase 11-E: getLatestSignalEvaluation DEFAULTS to the baseline strategy
    // version — the 8.8.8 row must NOT surface through the default (baseline
    // isolation). The any-strategy read (explicit null) is the opt-in that
    // still returns it, proving the STORED snapshot is the truth.
    const baselineScoped = await getLatestSignalEvaluation(db, SYMBOL);
    expect(baselineScoped?.id ?? null).not.toBe(row.id);
    const latest = await getLatestSignalEvaluation(db, SYMBOL, null);
    expect(latest?.id).toBe(row.id);
    expect(latest?.rulesSnapshot.status).toBe('present');
    if (latest?.rulesSnapshot.status !== 'present') return;
    const byId = new Map(latest.rulesSnapshot.snapshot.rules.map((e) => [e.id, e.value]));
    // Stored values — NOT the current buildStrategyRules() values (8 / 2.0 / 9.0.0):
    expect(byId.get('signal.maxBarsSinceBreak')).toBe(99);
    expect(byId.get('signal.rewardRisk')).toBe(3.5);
    expect(latest.rulesSnapshot.snapshot.strategyVersion).toBe('hybrid-structure-retest/8.8.8');
    expect(byId.get('symbol.digits')).toBe(2);
    await db.signalEvaluation.delete({ where: { id: row.id } });
  });

  test('invalid rules at save time → structured diagnostic persisted, verdict intact, row saved', async () => {
    const broken = { ...buildStrategyRules(), rewardRisk: Number.NaN } as never;
    const saved = await saveSignalEvaluation(db, {
      evaluation: syntheticEvaluation({ outcome: 'BLOCKED', reasonCodes: ['SPEC_MISSING'] }),
      quote: {},
      durationMs: 4,
      startedAtUtc: new Date(NOW()),
      executionTimeframe: 'M15',
      rules: broken,
      digits: null,
    });
    expect(saved.id).toBeTruthy(); // persistence failure never masks the verdict
    const row = await db.signalEvaluation.findUnique({ where: { id: saved.id } });
    expect(row?.outcome).toBe('BLOCKED');
    const read = parseRulesSnapshot(row!.inputSnapshot);
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.reason).toContain('NON_FINITE_VALUE');
    await db.signalEvaluation.delete({ where: { id: saved.id } });
  });

  test('duplicate setup evaluation: two rows, SAME setupFingerprint (10.3-A semantics preserved)', async () => {
    const evidence = {
      structureEvent: { type: 'BOS' as const, direction: 'bullish' as const, level: 2650.5, levelText: '2650.5', breakCandleTimeUtc: iso(T0 - 5 * M15), barsSinceBreak: 2 },
      anchorSwing: null,
      indicators: { ema50: 50, rsi14: 60, atr14: 2, adx14: 20 },
      htfContext: { h1Trend: 'unclear' as const, h4Trend: 'unclear' as const },
      decisionClose: 2650, retestBarTimeUtc: null,
      executionWindow: { fromUtc: iso(T0 - 300 * M15), toUtc: iso(T0 - M15), bars: 300 },
      h1Window: { fromUtc: iso(T0 - 300 * 3600), toUtc: iso(T0 - 3600), bars: 300 },
      h4Window: { fromUtc: iso(T0 - 300 * 14400), toUtc: iso(T0 - 14400), bars: 300 },
    };
    const first = await saveSignalEvaluation(db, {
      evaluation: syntheticEvaluation({ outcome: 'WAIT', reasonCodes: ['RETEST_PENDING'], evidence }),
      quote: {}, durationMs: 4, startedAtUtc: new Date(NOW()), executionTimeframe: 'M15',
      rules: buildStrategyRules(), digits: 3,
    });
    const second = await saveSignalEvaluation(db, {
      evaluation: syntheticEvaluation({ outcome: 'WAIT', reasonCodes: ['RETEST_PENDING'], evidence }),
      quote: {}, durationMs: 4, startedAtUtc: new Date(NOW()), executionTimeframe: 'M15',
      rules: buildStrategyRules(), digits: 3,
    });
    const rows = await db.signalEvaluation.findMany({
      where: { id: { in: [first.id, second.id] } },
    });
    expect(rows).toHaveLength(2); // append-only audit trail — both rows exist
    expect(rows[0].setupFingerprint).toBe(rows[1].setupFingerprint); // same logical setup
    expect(rows[0].setupFingerprint).toBeTruthy();
    // Both carry the rules snapshot:
    for (const r of rows) expect(parseRulesSnapshot(r.inputSnapshot).status).toBe('present');
    await db.signalEvaluation.deleteMany({ where: { id: { in: [first.id, second.id] } } });
  });

  test('counts: evaluation count vs DISTINCT setup count vs null-fingerprint rows', async () => {
    await db.signalEvaluation.deleteMany();
    const mk = async (fp: string | null) => {
      const saved = await saveSignalEvaluation(db, {
        evaluation: syntheticEvaluation(),
        quote: {}, durationMs: 1, startedAtUtc: new Date(NOW()), executionTimeframe: 'M15',
        rules: buildStrategyRules(), digits: 3,
      });
      await db.signalEvaluation.update({ where: { id: saved.id }, data: { setupFingerprint: fp } });
      return saved.id;
    };
    const ids = [await mk('fp-A'), await mk('fp-A'), await mk('fp-B'), await mk(null)];
    const counts = await getSignalEvaluationCounts(db, SYMBOL);
    expect(counts).toEqual({ totalEvaluations: 4, distinctSetups: 2 });
    await db.signalEvaluation.deleteMany({ where: { id: { in: ids } } });
  });

  test('history rows expose setupFingerprint + rulesSnapshot per entry', async () => {
    const saved = await saveSignalEvaluation(db, {
      evaluation: syntheticEvaluation(),
      quote: {}, durationMs: 1, startedAtUtc: new Date(NOW()), executionTimeframe: 'M15',
      rules: buildStrategyRules(), digits: 3,
    });
    const history = await getSignalEvaluationHistory(db, SYMBOL, 10);
    const entry = history.find((h) => h.id === saved.id);
    expect(entry).toBeTruthy();
    expect(entry?.rulesSnapshot.status).toBe('present');
    expect('setupFingerprint' in (entry ?? {})).toBe(true);
    await db.signalEvaluation.delete({ where: { id: saved.id } });
  });
});

// ---------------------------------------------------------------------------
// API routes (GET-only, additive fields)
// ---------------------------------------------------------------------------

describe('rules snapshot — API surface (additive, read-only)', () => {
  const req = (url: string) => new Request(`http://localhost:3000${url}`);

  test('GET /api/signal/latest returns setupFingerprint + rulesSnapshot on the signal', async () => {
    await db.signalEvaluation.deleteMany();
    const saved = await saveSignalEvaluation(db, {
      evaluation: syntheticEvaluation({ outcome: 'WAIT', reasonCodes: ['RETEST_PENDING'], evidence: EVIDENCE_WITH_EVENT }),
      quote: {}, durationMs: 1, startedAtUtc: new Date(NOW()), executionTimeframe: 'M15',
      rules: buildStrategyRules(), digits: 3,
    });
    const { GET } = await import('@/app/api/signal/latest/route');
    const res = await GET(req(`/api/signal/latest?symbol=${SYMBOL}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signal: { id: string; setupFingerprint: string | null; rulesSnapshot: { status: string } } | null;
    };
    expect(body.signal?.id).toBe(saved.id);
    expect(typeof body.signal?.setupFingerprint).toBe('string');
    expect(body.signal?.rulesSnapshot.status).toBe('present');
    await db.signalEvaluation.delete({ where: { id: saved.id } });
  });

  test('GET /api/signal/history returns counts (evaluations vs distinct setups) + snapshot fields', async () => {
    await db.signalEvaluation.deleteMany();
    const rules = buildStrategyRules();
    const mk = async (fp: string | null) => {
      const saved = await saveSignalEvaluation(db, {
        evaluation: syntheticEvaluation(),
        quote: {}, durationMs: 1, startedAtUtc: new Date(NOW()), executionTimeframe: 'M15',
        rules, digits: 3,
      });
      await db.signalEvaluation.update({ where: { id: saved.id }, data: { setupFingerprint: fp } });
    };
    await mk('fp-A'); await mk('fp-A'); await mk(null);
    const { GET } = await import('@/app/api/signal/history/route');
    const res = await GET(req(`/api/signal/history?symbol=${SYMBOL}&limit=10`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      counts: { totalEvaluations: number; distinctSetups: number };
      history: Array<{ rulesSnapshot: { status: string }; setupFingerprint: string | null }>;
    };
    expect(body.count).toBe(3);
    expect(body.counts.totalEvaluations).toBe(3);
    expect(body.counts.distinctSetups).toBe(1);
    expect(body.history.every((h) => 'rulesSnapshot' in h && 'setupFingerprint' in h)).toBe(true);
    await db.signalEvaluation.deleteMany();
  });
});
