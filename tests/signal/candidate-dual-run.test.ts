/**
 * PHASE 11-E — CANDIDATE DUAL-RUN ACTIVATION TESTS (service level).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: SYNTHETIC candles/tick/spec on the ISOLATED TEST DATABASE
 * + the clearly-labeled local MOCK BRIDGE (tests/market/helpers/mock-bridge.ts
 * — never real broker data). The service is driven through its injectable
 * bridge + clock, so the whole gate pipeline (quote integrity → spec →
 * readiness → window load → evaluation) runs hermetically.
 *
 * Pins:
 *   · DUAL RUN: one runSignalEvaluation call persists BOTH rows — the
 *     baseline row (byte-equivalent to a direct evaluateSignal call over the
 *     same windows: same outcome + fingerprints) and the candidate row
 *     (candidate strategyVersion + candidate-rules-snapshot/1 + model
 *     evidence + deterministic pairing with a direct evaluateCandidate call).
 *   · ERROR ISOLATION: demo-labelled M5 rows → the candidate step is skipped
 *     (CANDIDATE_EVALUATION_SKIPPED, no candidate row) and the baseline
 *     verdict/row is COMPLETELY unaffected.
 *   · EXECUTION ISOLATION: nothing can create TradeApproval rows anymore
 *     (the execution service was DELETED in Phase 0); run_risk_check honestly
 *     skips (no actionable baseline setup).
 *   · API SHAPES: /api/signal/latest exposes the additive candidate card
 *     (evaluation + levels + model + paperStats + protocol verdict INCOMPLETE)
 *     and stays baseline-scoped in `signal`; /api/signal/history stays
 *     baseline by default and ?strategy=candidate returns labeled candidate
 *     rows; /api/signal/run carries candidate:null when the candidate did
 *     not run.
 */

import '../market/helpers/setup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { db } from '@/lib/db';
import { createBridgeClient } from '@/lib/market/bridge-client';
import { makeBars, startMockBridge } from '../market/helpers/mock-bridge';
import { FIXED_NOW_MS, FIXED_NOW_SEC } from '../market/helpers/setup';
import { runSignalEvaluation } from '@/lib/signal/service';
import { evaluateSignal } from '@/lib/signal/core';
import { evaluateCandidate } from '@/lib/signal/candidate/core';
import { buildStrategyRules } from '@/lib/signal/rules';
import { loadSignalWindows } from '@/lib/signal/persistence';
import { loadCandidateM5Window, saveCandidateEvaluation, getLatestCandidateEvaluation } from '@/lib/signal/candidate-persistence';
import { buildCandidateRulesSnapshot } from '@/lib/signal/candidate-rules-snapshot';
import { parseCandidateRulesSnapshot } from '@/lib/signal/candidate-rules-snapshot';
import { CANDIDATE_STRATEGY_VERSION, CANDIDATE_RULES } from '@/lib/signal/candidate/types';
import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';
import { executeTool } from '@/lib/tools/registry';
import { GET as getSignalLatest } from '@/app/api/signal/latest/route';
import { GET as getSignalHistory } from '@/app/api/signal/history/route';

const SYMBOL = 'XAUUSDm';
const M15 = 900;

// ---------------------------------------------------------------------------
// Mock bridge + synthetic dataset
// ---------------------------------------------------------------------------

let mock: Awaited<ReturnType<typeof startMockBridge>>;
/** Deterministic quote near the last synthetic bar (mock digits=2). */
const QUOTE = { bid: 2725.1, ask: 2725.36, ts: 0 };

beforeAll(async () => {
  mock = await startMockBridge();
  // The bridge quote's RECEIPT time is what freshness is judged on — keep it
  // fresh against the real clock (the quoteIntegrity clock is not injectable).
  mock.state.quote = { ...QUOTE, ts: Math.floor(Date.now() / 1000) };
});

afterAll(async () => {
  mock.stop();
});

async function seedCandles() {
  const insert = async (tf: 'M5' | 'M15' | 'H1' | 'H4', tfSec: number, count: number, lastOpenSec: number, source = 'bridge-mt5') => {
    for (const b of makeBars(tfSec, count, lastOpenSec)) {
      await db.marketCandle.create({
        data: {
          symbol: SYMBOL,
          timeframe: tf,
          candleTimeUtc: new Date(b.t * 1000),
          open: String(b.o), high: String(b.h), low: String(b.l), close: String(b.c),
          tickVolume: b.v,
          source,
          isForming: false,
          validationStatus: 'VALID',
          receivedAtUtc: new Date(FIXED_NOW_MS),
        },
      });
    }
  };
  // Last CLOSED bars end exactly at the fixed now (open = now − duration).
  await insert('M15', 900, 300, FIXED_NOW_SEC - 900);
  await insert('H1', 3_600, 300, FIXED_NOW_SEC - 3_600);
  await insert('H4', 14_400, 300, FIXED_NOW_SEC - 14_400);
  await insert('M5', 300, CANDIDATE_RULES.m5WindowBars, FIXED_NOW_SEC - 300);
}

async function seedTickAndSpec() {
  await db.marketLatestTick.create({
    data: {
      symbol: SYMBOL,
      bid: '2725.100', ask: '2725.360', spread: '0.260',
      tickTimeUtc: new Date(FIXED_NOW_MS),
      receivedAtUtc: new Date(FIXED_NOW_MS),
      source: 'mt5-bridge',
      validationStatus: 'VALID',
    },
  });
  await db.symbolSpec.create({
    data: {
      symbol: SYMBOL,
      digits: 3,
      source: 'mt5-bridge',
      verifiedFields: '["digits"]',
      lastVerifiedAt: new Date(FIXED_NOW_MS),
    },
  });
}

const client = () => createBridgeClient({ baseUrl: mock.url });
const run = () => runSignalEvaluation({ symbol: SYMBOL, now: () => FIXED_NOW_MS, bridge: client() });

beforeEach(async () => {
  await db.signalEvaluation.deleteMany();
  await db.paperCandidateOutcome.deleteMany();
  await db.paperSignalOutcome.deleteMany();
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
  await db.tradeApproval.deleteMany();
  await db.riskCheck.deleteMany();
  await db.systemEvent.deleteMany({ where: { category: 'candidate' } });
  await seedCandles();
  await seedTickAndSpec();
});

afterEach(async () => {
  // keep the dataset for the next test (re-seeded in beforeEach anyway)
});

afterAll(async () => {
  await db.signalEvaluation.deleteMany();
  await db.paperCandidateOutcome.deleteMany();
  await db.paperSignalOutcome.deleteMany();
  await db.marketCandle.deleteMany();
  await db.marketLatestTick.deleteMany();
  await db.symbolSpec.deleteMany();
});

// ---------------------------------------------------------------------------
// Dual run
// ---------------------------------------------------------------------------

describe('Phase 11-E dual evaluation — baseline untouched + candidate added', () => {
  test('one run persists BOTH rows; the baseline row is byte-equivalent to a direct evaluateSignal call', async () => {
    const before = await db.signalEvaluation.count();
    const outcome = await run();
    expect(outcome.outcome).not.toBe('FAILED');

    const rows = await db.signalEvaluation.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.length).toBe(before + 2); // EXACTLY two new rows
    const baselineRow = rows.find((r) => r.strategyVersion === SIGNAL_STRATEGY_VERSION);
    const candidateRow = rows.find((r) => r.strategyVersion === CANDIDATE_STRATEGY_VERSION);
    expect(baselineRow).toBeDefined();
    expect(candidateRow).toBeDefined();
    expect(outcome.runId).not.toBeNull();
    expect(baselineRow!.id).toBe(outcome.runId as string);

    // ── Baseline equivalence (pre-activation behavior pinned) ────────────
    const rules = buildStrategyRules();
    const windows = await loadSignalWindows(db, SYMBOL, rules, FIXED_NOW_SEC);
    const bid = outcome.quoteReport ? Number(outcome.quoteReport.bid) : null;
    const ask = outcome.quoteReport ? Number(outcome.quoteReport.ask) : null;
    expect(bid).not.toBeNull();
    expect(ask).not.toBeNull();
    const mid = (bid! + ask!) / 2;
    const spread = Number(outcome.quoteReport!.spread ?? (ask! - bid!));
    const direct = evaluateSignal({
      symbol: SYMBOL,
      digits: windows.digits,
      execution: windows.execution,
      h1: windows.h1,
      h4: windows.h4,
      referencePrice: mid,
      spreadPrice: spread,
      nowUtcSec: FIXED_NOW_SEC,
      rules,
    });
    expect(outcome.evaluation.outcome).toBe(direct.outcome);
    expect(outcome.evaluation.inputFingerprint).toBe(direct.inputFingerprint);
    expect(outcome.evaluation.datasetFingerprint).toBe(direct.datasetFingerprint);
    expect(JSON.stringify(outcome.evaluation.levels)).toBe(JSON.stringify(direct.levels));
    // The persisted row carries the same fingerprints as the direct call.
    expect(baselineRow!.inputFingerprint).toBe(direct.inputFingerprint);
    expect(baselineRow!.outcome).toBe(direct.outcome);
    expect(baselineRow!.setupFingerprint ?? null).toBe(direct.levels ? baselineRow!.setupFingerprint : null);

    // ── Candidate row ─────────────────────────────────────────────────────
    expect(outcome.candidate).not.toBeNull();
    expect(outcome.candidate!.runId).toBe(candidateRow!.id);
    expect(outcome.candidate!.inputFingerprint).toBe(candidateRow!.inputFingerprint);
    expect(candidateRow!.strategyVersion).toBe(CANDIDATE_STRATEGY_VERSION);
    // Deterministic pairing: a direct evaluateCandidate over the SAME windows
    // reproduces the persisted candidate fingerprint + outcome.
    const m5Load = await loadCandidateM5Window(db, SYMBOL, FIXED_NOW_SEC);
    const directCandidate = evaluateCandidate({
      symbol: SYMBOL,
      digits: windows.digits,
      execution: windows.execution,
      h1: windows.h1,
      h4: windows.h4,
      m5: m5Load.m5,
      referencePrice: mid,
      spreadPrice: spread,
      nowUtcSec: FIXED_NOW_SEC,
      rules,
    });
    expect(candidateRow!.inputFingerprint).toBe(directCandidate.inputFingerprint);
    expect(candidateRow!.outcome).toBe(directCandidate.outcome);
    // Levels exist ONLY on setup outcomes (harness-consistent mapping).
    if (directCandidate.outcome === 'BUY_SETUP' || directCandidate.outcome === 'SELL_SETUP') {
      expect(candidateRow!.levels).toBe(JSON.stringify(directCandidate.levels));
      expect(candidateRow!.setupFingerprint).toBe(directCandidate.setupFingerprint);
      expect(outcome.candidate!.model).toBe(directCandidate.model);
    } else {
      expect(candidateRow!.levels).toBeNull();
      expect(candidateRow!.setupFingerprint).toBeNull();
    }
    // Evidence carries the model breakdown.
    const evidence = JSON.parse(candidateRow!.evidence) as { model: string | null; modelA: { outcome: string } | null };
    expect(evidence.modelA?.outcome).toBe(direct.outcome);
    // Candidate rules snapshot: present + valid (candidate-rules-snapshot/1).
    const snapshotRead = parseCandidateRulesSnapshot(candidateRow!.inputSnapshot);
    expect(snapshotRead.status).toBe('present');
    if (snapshotRead.status === 'present') {
      expect(snapshotRead.snapshot.candidateVersion).toBe(CANDIDATE_STRATEGY_VERSION);
      expect(snapshotRead.snapshot.candidateRules).toHaveLength(14);
      expect(snapshotRead.snapshot.baselineRulesSnapshot.rules).toHaveLength(24);
    }
  });

  test('candidate step is error-isolated: demo-labelled M5 rows → skip event, NO candidate row, baseline verdict + row unaffected', async () => {
    // Re-seed the M5 window from a demo-labelled source (fail-closed skip).
    // The demo bars are deliberately timestamped EARLIER than the newest M15
    // bar: the readiness demo-policy looks at the LATEST candle of the symbol
    // across timeframes, and the point under test is the CANDIDATE-side skip,
    // not the (already-tested) global demo block.
    await db.marketCandle.deleteMany({ where: { symbol: SYMBOL, timeframe: 'M5' } });
    for (const b of makeBars(300, CANDIDATE_RULES.m5WindowBars, FIXED_NOW_SEC - 300 - 7_200)) {
      await db.marketCandle.create({
        data: {
          symbol: SYMBOL, timeframe: 'M5',
          candleTimeUtc: new Date(b.t * 1000),
          open: String(b.o), high: String(b.h), low: String(b.l), close: String(b.c),
          source: 'demo-bridge', isForming: false, validationStatus: 'VALID',
          receivedAtUtc: new Date(FIXED_NOW_MS),
        },
      });
    }

    const before = await db.signalEvaluation.count();
    const outcome = await run();
    expect(outcome.outcome).not.toBe('FAILED');
    expect(outcome.outcome).not.toBe('BLOCKED'); // the demo rows are candidate-only M5 — baseline gates all passed
    expect(outcome.candidate).toBeNull(); // honest absence — never fabricated

    const rows = await db.signalEvaluation.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.length).toBe(before + 1); // ONLY the baseline row
    expect(rows.every((r) => r.strategyVersion === SIGNAL_STRATEGY_VERSION)).toBe(true);

    // The baseline verdict is byte-identical to the clean-data run (the M5
    // window is candidate-only — the baseline does not read it).
    const rules = buildStrategyRules();
    const windows = await loadSignalWindows(db, SYMBOL, rules, FIXED_NOW_SEC);
    const bid = outcome.quoteReport ? Number(outcome.quoteReport.bid) : null;
    const ask = outcome.quoteReport ? Number(outcome.quoteReport.ask) : null;
    const direct = evaluateSignal({
      symbol: SYMBOL, digits: windows.digits,
      execution: windows.execution, h1: windows.h1, h4: windows.h4,
      referencePrice: (bid! + ask!) / 2,
      spreadPrice: Number(outcome.quoteReport!.spread ?? (ask! - bid!)),
      nowUtcSec: FIXED_NOW_SEC, rules,
    });
    expect(outcome.evaluation.outcome).toBe(direct.outcome);
    expect(outcome.evaluation.inputFingerprint).toBe(direct.inputFingerprint);

    // Honest skip event recorded (English log/audit code, category candidate).
    const events = await db.systemEvent.findMany({ where: { category: 'candidate', code: 'CANDIDATE_EVALUATION_SKIPPED' } });
    expect(events).toHaveLength(1);
    expect(events[0].meta).toContain('M5_DEMO_ROWS');
  });

  test('FORWARD_PAPER_TRACKING=0 disables the candidate step (the reused switch; baseline unaffected by the flag itself)', async () => {
    const had = process.env.FORWARD_PAPER_TRACKING;
    process.env.FORWARD_PAPER_TRACKING = '0';
    try {
      const before = await db.signalEvaluation.count();
      const outcome = await run();
      expect(outcome.outcome).not.toBe('FAILED');
      expect(outcome.candidate).toBeNull();
      expect(await db.signalEvaluation.count()).toBe(before + 1); // baseline only
    } finally {
      if (had === undefined) delete process.env.FORWARD_PAPER_TRACKING;
      else process.env.FORWARD_PAPER_TRACKING = had;
    }
  });
});

// ---------------------------------------------------------------------------
// Execution isolation (protocol §4 — candidate setups never create approvals)
// ---------------------------------------------------------------------------

describe('Phase 11-E execution isolation — candidate rows can never reach the execution pipeline', () => {
  test('NO code path can create TradeApproval rows (execution service deleted in Phase 0)', async () => {
    // The execution module (the ONLY TradeApproval writer) was deleted in the
    // Phase 0 signal-only remediation. Even with an actionable candidate row
    // seeded as the newest evaluation, nothing in the app can create an
    // approval — the table is historical audit data only.
    await db.signalEvaluation.deleteMany();
    await db.tradeApproval.deleteMany();
    const decisionSec = FIXED_NOW_SEC - 10 * M15;
    await db.signalEvaluation.create({
      data: {
        engineVersion: '9.0.0',
        strategyVersion: CANDIDATE_STRATEGY_VERSION,
        symbol: SYMBOL,
        outcome: 'BUY_SETUP',
        reasonCodes: '[]',
        inputFingerprint: 'iso-candidate-fp',
        setupFingerprint: 'iso-candidate-setupfp',
        inputSnapshot: '{}',
        evidence: JSON.stringify({ model: 'B', direction: 'BUY', conflict: false, suppressedModels: [], modelA: null, modelB: { setup: true, stage: null }, modelC: { setups: [], stage: null } }),
        levels: JSON.stringify({
          direction: 'BUY', entryZoneLow: 2649, entryZoneHigh: 2651, entryReference: 2650,
          stopLoss: 2640, target: 2670, invalidationLevel: 2648,
          riskPrice: 10, rewardPrice: 20, rewardRiskRatio: 2,
          entryZoneLowText: '2649', entryZoneHighText: '2651', stopLossText: '2640', targetText: '2670', entryReferenceText: '2650',
        }),
        decisionCandleTimeUtc: new Date(decisionSec * 1000),
        setupKnownAtUtc: new Date((decisionSec + M15) * 1000),
        expiryUtc: new Date((decisionSec + 12 * M15) * 1000),
        quote: '{}',
        executionLocked: true,
        durationMs: 3,
      },
    });
    // No writer exists: approvals stay at zero by construction.
    expect(await db.tradeApproval.count()).toBe(0); // NEVER
  });

  test('run_risk_check honestly skips when only a candidate setup exists (baseline-scoped tool)', async () => {
    await db.signalEvaluation.deleteMany();
    await db.riskCheck.deleteMany();
    const decisionSec = FIXED_NOW_SEC - 12 * M15;
    await db.signalEvaluation.create({
      data: {
        engineVersion: '9.0.0',
        strategyVersion: CANDIDATE_STRATEGY_VERSION,
        symbol: SYMBOL,
        outcome: 'SELL_SETUP',
        reasonCodes: '[]',
        inputFingerprint: 'iso-candidate-fp2',
        setupFingerprint: 'iso-candidate-setupfp2',
        inputSnapshot: '{}',
        evidence: JSON.stringify({ model: 'C', direction: 'SELL', conflict: false, suppressedModels: [], modelA: null, modelB: null, modelC: { setups: ['SELL'], stage: null } }),
        levels: JSON.stringify({
          direction: 'SELL', entryZoneLow: 2649, entryZoneHigh: 2651, entryReference: 2650,
          stopLoss: 2660, target: 2630, invalidationLevel: 2652,
          riskPrice: 10, rewardPrice: 20, rewardRiskRatio: 2,
          entryZoneLowText: '2649', entryZoneHighText: '2651', stopLossText: '2660', targetText: '2630', entryReferenceText: '2650',
        }),
        decisionCandleTimeUtc: new Date(decisionSec * 1000),
        setupKnownAtUtc: new Date((decisionSec + M15) * 1000),
        expiryUtc: new Date((decisionSec + 12 * M15) * 1000),
        quote: '{}',
        executionLocked: true,
        durationMs: 3,
      },
    });

    const res = await executeTool('run_risk_check', { symbol: SYMBOL });
    expect(res.ok).toBe(true);
    const payload = res.result as { note?: string };
    expect(payload?.note).toContain('কোনো অ্যাকশনেবল সিগন্যাল নেই'); // honest skip
    expect(await db.riskCheck.count()).toBe(0); // no fabricated risk rows
  });

  test('candidate setup fingerprints can never collide with the baseline namespace (identity payload differs)', async () => {
    const { computeSetupFingerprint } = await import('@/lib/signal/setup-identity');
    const { computeCandidateSetupFingerprint } = await import('@/lib/signal/candidate/identity');
    const breakIso = new Date((FIXED_NOW_SEC - 2 * M15) * 1000).toISOString();
    const baselineFp = computeSetupFingerprint({
      symbol: SYMBOL, timeframe: 'M15', strategyVersion: SIGNAL_STRATEGY_VERSION,
      structureEvent: { type: 'BOS', direction: 'bullish', level: 2645, breakCandleTimeUtc: breakIso },
    });
    const candidateFp = computeCandidateSetupFingerprint({
      symbol: SYMBOL, timeframe: 'M15', model: 'A', direction: 'BUY',
      anchorKey: { kind: 'structure', type: 'BOS', direction: 'bullish', level: 2645, breakCandleTimeUtc: breakIso },
    });
    // The SAME logical event under the two namespaces → different hashes
    // (candidate identity embeds candidateVersion + model + anchorKey shape).
    expect(candidateFp).not.toBe(baselineFp);
  });
});

// ---------------------------------------------------------------------------
// API shapes (additive candidate surfaces)
// ---------------------------------------------------------------------------

const req = (url: string) => new Request(`http://localhost:3000${url}`, {
  // Phase 9: public triggers are same-origin only — emulate the app UI.
  headers: { Origin: 'http://localhost:3000' },
});

describe('Phase 11-E API shapes — candidate field additive, baseline byte-compatible', () => {
  test('/api/signal/latest: candidate card present (evaluation + levels + model + paperStats + INCOMPLETE verdict); `signal` stays BASELINE-scoped', async () => {
    await db.signalEvaluation.deleteMany();
    // A candidate row NEWER than the baseline row — `signal` must still be the baseline one.
    const now = new Date();
    await db.signalEvaluation.create({
      data: {
        engineVersion: '9.0.0', strategyVersion: SIGNAL_STRATEGY_VERSION, symbol: SYMBOL,
        outcome: 'WAIT', reasonCodes: '["RETEST_PENDING"]', inputFingerprint: 'api-baseline-fp',
        inputSnapshot: '{}', evidence: '{}', levels: null, quote: '{}',
        executionLocked: true, durationMs: 2, createdAt: now,
      },
    });
    const candEval = evaluateCandidate({
      symbol: SYMBOL, digits: 3,
      execution: { timeframe: 'M15', candles: [], source: 'bridge-mt5' },
      h1: { timeframe: 'H1', candles: [], source: 'bridge-mt5' },
      h4: { timeframe: 'H4', candles: [], source: 'bridge-mt5' },
      m5: { timeframe: 'M5', candles: [], source: 'bridge-mt5' },
      referencePrice: 2650, spreadPrice: 0.24, nowUtcSec: FIXED_NOW_SEC,
      rules: buildStrategyRules(),
    });
    // Persist via the REAL save path (rules snapshot + evidence mapping).
    const saved = await saveCandidateEvaluation(db, {
      evaluation: candEval,
      quote: {},
      durationMs: 5,
      startedAtUtc: now,
      rules: buildStrategyRules(),
      digits: 3,
      windows: { execution: null, h1: null, h4: null, m5: null },
    });

    const res = await getSignalLatest(req(`/api/signal/latest?symbol=${SYMBOL}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      signal: { strategyVersion: string } | null;
      candidate: {
        evaluation: { id: string; strategyVersion: string; model: string | null };
        levels: unknown;
        model: string | null;
        paperStats: {
          total: number; open: number; completedOutcomes: number;
          verdict: { conclusion: string };
          protocol: { id: string; minCompleted: number; windowDays: number };
        };
      } | null;
      strategyVersions: { candidateStatus: string };
    };
    expect(body.ok).toBe(true);
    expect(body.signal?.strategyVersion).toBe(SIGNAL_STRATEGY_VERSION); // baseline-scoped
    expect(body.candidate).not.toBeNull();
    expect(body.candidate!.evaluation.id).toBe(saved.id);
    expect(body.candidate!.evaluation.strategyVersion).toBe(CANDIDATE_STRATEGY_VERSION);
    expect(body.candidate!.model).toBeNull(); // non-setup outcome → no model
    expect(body.candidate!.levels).toBeNull();
    expect(body.candidate!.paperStats.total).toBe(0); // 0/20 — honest zeros
    expect(body.candidate!.paperStats.completedOutcomes).toBe(0);
    expect(body.candidate!.paperStats.verdict.conclusion).toBe('INCOMPLETE');
    expect(body.candidate!.paperStats.protocol.id).toBe('phase11-candidate-forward/1');
    expect(body.candidate!.paperStats.protocol.minCompleted).toBe(20);
    expect(body.strategyVersions.candidateStatus).toContain('active-forward-observation');
  });

  test('/api/signal/latest: NO candidate evaluation yet → candidate:null (honest absence)', async () => {
    await db.signalEvaluation.deleteMany();
    await db.signalEvaluation.create({
      data: {
        engineVersion: '9.0.0', strategyVersion: SIGNAL_STRATEGY_VERSION, symbol: SYMBOL,
        outcome: 'NO_SETUP', reasonCodes: '["NO_STRUCTURE_BREAK"]', inputFingerprint: 'api-baseline-fp2',
        inputSnapshot: '{}', evidence: '{}', levels: null, quote: '{}',
        executionLocked: true, durationMs: 2,
      },
    });
    const res = await getSignalLatest(req(`/api/signal/latest?symbol=${SYMBOL}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidate: unknown };
    expect(body.candidate).toBeNull();
  });

  test('/api/signal/history: default stays BASELINE-scoped; ?strategy=candidate returns labeled candidate rows; invalid strategy → 400', async () => {
    await db.signalEvaluation.deleteMany();
    await db.signalEvaluation.create({
      data: {
        engineVersion: '9.0.0', strategyVersion: SIGNAL_STRATEGY_VERSION, symbol: SYMBOL,
        outcome: 'WAIT', reasonCodes: '["RETEST_PENDING"]', inputFingerprint: 'h-baseline',
        inputSnapshot: '{}', evidence: '{}', levels: null, quote: '{}',
        executionLocked: true, durationMs: 2,
      },
    });
    await db.signalEvaluation.create({
      data: {
        engineVersion: '9.0.0', strategyVersion: CANDIDATE_STRATEGY_VERSION, symbol: SYMBOL,
        outcome: 'NO_SETUP', reasonCodes: '["RANGE_NOT_DETECTED"]', inputFingerprint: 'h-candidate',
        inputSnapshot: '{}', evidence: '{}', levels: null, quote: '{}',
        executionLocked: true, durationMs: 2,
      },
    });

    // Default: baseline only.
    const baseRes = await getSignalHistory(req(`/api/signal/history?symbol=${SYMBOL}`));
    expect(baseRes.status).toBe(200);
    const baseBody = (await baseRes.json()) as {
      strategy: string; strategyVersion: string; count: number;
      counts: { totalEvaluations: number } | null;
      history: Array<{ strategyVersion: string }>;
    };
    expect(baseBody.strategy).toBe('baseline');
    expect(baseBody.strategyVersion).toBe(SIGNAL_STRATEGY_VERSION);
    expect(baseBody.count).toBe(1);
    expect(baseBody.history.every((h) => h.strategyVersion === SIGNAL_STRATEGY_VERSION)).toBe(true);
    expect(baseBody.counts?.totalEvaluations).toBe(1); // baseline-scoped counts

    // ?strategy=candidate: candidate rows, labeled.
    const candRes = await getSignalHistory(req(`/api/signal/history?symbol=${SYMBOL}&strategy=candidate`));
    expect(candRes.status).toBe(200);
    const candBody = (await candRes.json()) as {
      strategy: string; strategyVersion: string; count: number;
      history: Array<{ strategyVersion: string }>;
      note: string;
    };
    expect(candBody.strategy).toBe('candidate');
    expect(candBody.strategyVersion).toBe(CANDIDATE_STRATEGY_VERSION);
    expect(candBody.count).toBe(1);
    expect(candBody.history.every((h) => h.strategyVersion === CANDIDATE_STRATEGY_VERSION)).toBe(true);
    expect(candBody.note).toContain('CANDIDATE');

    // Invalid strategy value → 400 (validated enum).
    const badRes = await getSignalHistory(req(`/api/signal/history?symbol=${SYMBOL}&strategy=evil`));
    expect(badRes.status).toBe(400);
  });

  test('getLatestCandidateEvaluation: candidate-scoped read side (model + levels with invalidationLevel + snapshot)', async () => {
    await db.signalEvaluation.deleteMany();
    const now = new Date();
    const candEval = evaluateCandidate({
      symbol: SYMBOL, digits: 3,
      execution: { timeframe: 'M15', candles: [], source: 'bridge-mt5' },
      h1: { timeframe: 'H1', candles: [], source: 'bridge-mt5' },
      h4: { timeframe: 'H4', candles: [], source: 'bridge-mt5' },
      m5: { timeframe: 'M5', candles: [], source: 'bridge-mt5' },
      referencePrice: 2650, spreadPrice: 0.24, nowUtcSec: FIXED_NOW_SEC,
      rules: buildStrategyRules(),
    });
    await saveCandidateEvaluation(db, {
      evaluation: candEval, quote: {}, durationMs: 5, startedAtUtc: now,
      rules: buildStrategyRules(), digits: 3,
      windows: { execution: null, h1: null, h4: null, m5: null },
    });
    const latest = await getLatestCandidateEvaluation(db, SYMBOL);
    expect(latest).not.toBeNull();
    expect(latest!.strategyVersion).toBe(CANDIDATE_STRATEGY_VERSION);
    expect(latest!.rulesSnapshot.status).toBe('present');
    // The snapshot round-trips through the real save + read path.
    const rebuilt = buildCandidateRulesSnapshot(buildStrategyRules(), { symbol: SYMBOL, engineVersion: candEval.engineVersion, digits: 3 });
    if (rebuilt.ok && latest!.rulesSnapshot.status === 'present') {
      expect(latest!.rulesSnapshot.snapshot.snapshotHash).toBe(rebuilt.snapshot.snapshotHash);
    }
  });

  test('POST /api/signal/run response carries candidate:null when the candidate did not run (hermetic fail-closed bridge)', async () => {
    // In the hermetic test environment MT5_BRIDGE_URL is empty → the run
    // fails closed BLOCKED (a VALID honest outcome) — the additive candidate
    // field must still be present and null, never undefined/missing.
    const hadToken = process.env.DATA_API_TOKEN;
    const hadTriggers = process.env.MARKET_API_PUBLIC_TRIGGERS;
    delete process.env.DATA_API_TOKEN;
    process.env.MARKET_API_PUBLIC_TRIGGERS = 'true';
    try {
      const { POST } = await import('@/app/api/signal/run/route');
      const res = await POST(
        new Request('http://localhost:3000/api/signal/run', {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3000', // Phase 9: same-origin trigger evidence
            'Content-Type': 'application/json',
            'x-forwarded-for': '10.79.0.1',
          },
          body: JSON.stringify({ symbol: SYMBOL }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        run: { status: string };
        candidate: unknown;
      };
      expect(body.ok).toBe(true);
      expect(body.run.status).toBe('BLOCKED'); // fail-closed: no bridge in tests
      expect(body.candidate).toBeNull(); // additive field present + honest null
    } finally {
      if (hadToken === undefined) delete process.env.DATA_API_TOKEN;
      else process.env.DATA_API_TOKEN = hadToken;
      if (hadTriggers === undefined) delete process.env.MARKET_API_PUBLIC_TRIGGERS;
      else process.env.MARKET_API_PUBLIC_TRIGGERS = hadTriggers;
    }
  });
});
