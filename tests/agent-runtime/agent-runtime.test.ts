/**
 * PHASE 7 AGENT RUNTIME INTEGRATION TESTS (Task 42-S4).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: everything here runs against a FAKE deterministic tool
 * environment + the ISOLATED TEST DATABASE — never the live bridge, never
 * GLM, never the network. Fake observations are synthetic numbers for
 * automated testing only.
 *
 * Pins (per the Phase 7 architecture contract):
 *   (a) a 'market' task invokes get_latest_quote + get_market_health and
 *       COMPLETES with facts sourced from the fake observations
 *   (b) returned observations influence the result (fake data in facts)
 *   (c) a transient tool failure retries with backoff and completes;
 *       the retries counter is persisted on the step row
 *   (d) a permanent tool failure → BLOCKED with the honest error
 *   (e) budget exhaustion → BLOCKED 'BUDGET_EXCEEDED' (crafted plan)
 *   (f) unknown task → BLOCKED 'UNKNOWN_TASK' (no fabricated plan)
 *   (g) illegal state transitions rejected by the pure state machine (matrix)
 *   (h) persistence: run row + step rows exist in the test DB with correct
 *       statuses, digests and budget counters
 *   (i) NO tool in the agent allowlist can execute an order (the execution
 *       module does not exist; run_risk_check stays excluded)
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import '../market/helpers/setup';
import { db } from '@/lib/db';
import { executeTool } from '@/lib/tools/registry';
import {
  AGENT_RUN_STATUSES,
  LEGAL_TRANSITIONS,
  TERMINAL_STATUSES,
  canTransition,
  isTerminal,
  transition,
} from '@/lib/agent-runtime/state-machine';
import {
  AGENT_TOOL_ALLOWLIST,
  assertNoExecutionTools,
  defaultAgentTools,
  looksLikeExecutionToolName,
  toolArgsDigest,
  toolResultDigest,
  type AgentTool,
  type AgentToolMap,
} from '@/lib/agent-runtime/tools';
import {
  DEFAULT_AGENT_BUDGETS,
  planAgentTask,
  runAgentTask,
  verifyObservations,
  type PlannedStep,
  type StepRecord,
} from '@/lib/agent-runtime/orchestrator';

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Fake deterministic tool environment
// ---------------------------------------------------------------------------

type FakeBehavior = (callNumber: number) => Record<string, unknown> | { __fail: string };

class FakeTool implements AgentTool {
  name: string;
  description = 'fake deterministic test tool (synthetic data — never a real broker value)';
  inputSchema = { type: 'object', properties: {}, required: [] };
  timeoutMs = 2_000;
  maxRetries = 2;
  calls = 0;
  constructor(name: string, private behavior: FakeBehavior) {
    this.name = name;
  }
  async execute(): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
    this.calls += 1;
    const res = this.behavior(this.calls);
    if (res && typeof res === 'object' && '__fail' in res) {
      return { ok: false, error: String(res.__fail) };
    }
    return { ok: true, data: res as Record<string, unknown> };
  }
}

function fakeMap(...tools: AgentTool[]): AgentToolMap {
  return new Map(tools.map((t) => [t.name, t] as const));
}

function marketFakes(): { quote: FakeTool; health: FakeTool } {
  return {
    quote: new FakeTool('get_latest_quote', () => ({
      available: true,
      bid: 2650.1,
      ask: 2650.9,
      spread: 0.8,
      freshness: 'LIVE',
      sourceClass: 'broker',
    })),
    health: new FakeTool('get_market_health', () => ({
      freshness: 'LIVE',
      sourceClass: 'broker',
      connected: true,
      signalPermitted: true,
    })),
  };
}

/** Hermetic task string for DB tests. */
const TASK = 'market status check';

// ---------------------------------------------------------------------------
// (g) Pure state machine — matrix
// ---------------------------------------------------------------------------

describe('agent run state machine (pure)', () => {
  test('matrix: canTransition/transition agree with LEGAL_TRANSITIONS for every pair', () => {
    for (const from of AGENT_RUN_STATUSES) {
      for (const to of AGENT_RUN_STATUSES) {
        const legal = LEGAL_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(legal);
        const t = transition(from, to);
        expect(t.ok).toBe(legal);
        if (!legal && !t.ok) expect(t.error.length).toBeGreaterThan(0);
      }
    }
  });

  test('documented lifecycle chain is legal', () => {
    const chain: Array<[string, string]> = [
      ['CREATED', 'PLANNED'],
      ['PLANNED', 'RUNNING'],
      ['RUNNING', 'WAITING_FOR_TOOL'],
      ['WAITING_FOR_TOOL', 'RUNNING'],
      ['RUNNING', 'VERIFYING'],
      ['VERIFYING', 'COMPLETED'],
      ['VERIFYING', 'FAILED'],
      ['VERIFYING', 'BLOCKED'],
    ];
    for (const [from, to] of chain) {
      expect(canTransition(from as never, to as never)).toBe(true);
    }
  });

  test('CANCELLED is reachable from any non-terminal state', () => {
    for (const s of AGENT_RUN_STATUSES) {
      expect(canTransition(s, 'CANCELLED')).toBe(!isTerminal(s));
    }
  });

  test('terminal states are immutable — every onward move is rejected', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['BLOCKED', 'CANCELLED', 'COMPLETED', 'FAILED']);
    for (const term of TERMINAL_STATUSES) {
      for (const to of AGENT_RUN_STATUSES) {
        expect(canTransition(term, to)).toBe(false);
      }
    }
    const t = transition('COMPLETED', 'RUNNING');
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toContain('terminal');
  });

  test('illegal transitions are rejected (anti-fabrication)', () => {
    expect(transition('CREATED', 'COMPLETED').ok).toBe(false); // never complete without running
    expect(transition('CREATED', 'RUNNING').ok).toBe(false); // must be planned first
    expect(transition('WAITING_FOR_TOOL', 'PLANNED').ok).toBe(false);
    expect(transition('BLOCKED', 'RUNNING').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deterministic planner
// ---------------------------------------------------------------------------

describe('deterministic planner', () => {
  test('market task (Bengali) → quote + market health', () => {
    const plan = planAgentTask('বাজারের বর্তমান অবস্থা দেখাও');
    expect(plan?.map((p) => p.tool)).toEqual(['get_latest_quote', 'get_market_health']);
    expect(plan?.every((p) => p.status === 'PLANNED' && p.stepId && p.description)).toBe(true);
  });

  test('signal task → latest signal + evidence explanation', () => {
    expect(planAgentTask('সিগন্যাল কী আছে?')?.map((p) => p.tool)).toEqual([
      'get_latest_signal',
      'explain_signal_evidence',
    ]);
    expect(planAgentTask('any signal today?')?.map((p) => p.tool)).toEqual([
      'get_latest_signal',
      'explain_signal_evidence',
    ]);
  });

  test('analysis / backtest / health / review mappings', () => {
    expect(planAgentTask('বিশ্লেষণ দেখাও')?.map((p) => p.tool)).toEqual(['get_latest_analysis']);
    expect(planAgentTask('show the backtest')?.map((p) => p.tool)).toEqual(['get_backtest_summary']);
    expect(planAgentTask('সিস্টেম স্বাস্থ্য কেমন?')?.map((p) => p.tool)).toEqual([
      'get_system_health',
      'get_candle_coverage',
    ]);
    expect(planAgentTask('ai review দেখাও')?.map((p) => p.tool)).toEqual(['get_ai_review']);
  });

  test('multi-category task → deduped multi-step plan, bounded at 5', () => {
    const plan = planAgentTask('market signal analysis backtest health review overview');
    expect(plan).not.toBeNull();
    expect(new Set(plan!.map((p) => p.tool)).size).toBe(plan!.length); // no duplicates
    expect(plan!.length).toBeLessThanOrEqual(5);
  });

  test('unknown task → null (a plan is NEVER fabricated)', () => {
    expect(planAgentTask('quantum banana teleport')).toBeNull();
    expect(planAgentTask('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deterministic verification (pure)
// ---------------------------------------------------------------------------

describe('verifyObservations (pure)', () => {
  test('facts come only from successful observations and carry sourceStepId', () => {
    const records: StepRecord[] = [
      { stepId: 'step-1', tool: 'get_latest_quote', ok: true, data: { bid: 1, nested: { x: 1 }, flag: true }, digest: 'd', retries: 0, attempts: 1, durationMs: 5 },
      { stepId: 'step-2', tool: 'get_market_health', ok: false, error: 'down', digest: null, retries: 2, attempts: 3, durationMs: 9 },
    ];
    const { facts, evidence } = verifyObservations(records);
    expect(facts).toEqual([
      { sourceStepId: 'step-1', tool: 'get_latest_quote', key: 'bid', value: 1 },
      { sourceStepId: 'step-1', tool: 'get_latest_quote', key: 'flag', value: true },
    ]);
    expect(evidence).toHaveLength(2);
    expect(evidence[1].ok).toBe(false);
  });

  test('a fact with no observation is dropped — never invented', () => {
    const records: StepRecord[] = [
      { stepId: 'step-1', tool: 'get_latest_quote', ok: false, error: 'down', digest: null, retries: 2, attempts: 3, durationMs: 9 },
    ];
    const { facts } = verifyObservations(records);
    expect(facts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (i) Signal-only invariants — no order capability anywhere in the agent
// ---------------------------------------------------------------------------

describe('agent allowlist — no execution capability (signal-only)', () => {
  test('the allowlist is exactly the 9 read-only observation tools', () => {
    expect([...AGENT_TOOL_ALLOWLIST]).toHaveLength(9);
    for (const name of AGENT_TOOL_ALLOWLIST) {
      expect(looksLikeExecutionToolName(name)).toBe(false);
    }
  });

  test("run_risk_check is EXCLUDED (it writes audit rows; agent runs stay read-only)", () => {
    expect((AGENT_TOOL_ALLOWLIST as readonly string[]).includes('run_risk_check')).toBe(false);
  });

  test('default agent tool map wraps the registry: 9 tools, no execution tool', () => {
    const map = defaultAgentTools();
    expect(map.size).toBe(9);
    expect(() => assertNoExecutionTools(map)).not.toThrow();
    for (const tool of map.values()) {
      expect(tool.timeoutMs).toBe(8_000);
      expect(tool.maxRetries).toBe(2);
    }
  });

  test('the execution module does not exist on disk', () => {
    expect(existsSync(join(ROOT, 'src', 'lib', 'execution'))).toBe(false);
  });

  test('the underlying registry refuses an order tool name outright', async () => {
    const res = await executeTool('place_order', {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not in allowlist');
  });

  test('runAgentTask REJECTS a tool map containing an execution-looking tool', async () => {
    const evil = new FakeTool('place_order', () => ({}));
    await expect(
      runAgentTask({ task: TASK, tools: fakeMap(evil), summarize: null }),
    ).rejects.toThrow(/execution tool/);
  });

  test('digests never persist argument VALUES (secrets impossible by construction)', () => {
    expect(toolArgsDigest({ symbol: 'XAUUSDm', password: 'super-secret' })).toBe(
      '{"keys":["password","symbol"]}',
    );
    const digest = toolResultDigest({ note: 'x'.repeat(900) });
    expect(digest?.length).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// (a)+(b)+(h) Market task — real tool calls, observations → facts, persistence
// ---------------------------------------------------------------------------

describe('agent run — market task end-to-end (fake tools, test DB)', () => {
  test('(a) invokes get_latest_quote + get_market_health and COMPLETES with sourced facts', async () => {
    const { quote, health } = marketFakes();
    const run = await runAgentTask({ task: TASK, tools: fakeMap(quote, health), summarize: null });

    // Real tool calls occurred (not claimed — counted).
    expect(quote.calls).toBe(1);
    expect(health.calls).toBe(1);

    expect(run.status).toBe('COMPLETED');
    expect(run.result?.verdict).toBe('COMPLETED');
    expect(run.plan.map((p) => p.tool)).toEqual(['get_latest_quote', 'get_market_health']);
    expect(run.errorText).toBeNull();

    // Every fact is sourced from a DONE step of the same tool.
    const doneTools = new Set(run.steps.filter((s) => s.state === 'DONE').map((s) => s.toolName));
    expect(doneTools.size).toBe(2);
    for (const fact of run.result!.facts) {
      expect(doneTools.has(fact.tool)).toBe(true);
      expect(run.plan.some((p) => p.stepId === fact.sourceStepId && p.tool === fact.tool && p.status === 'DONE')).toBe(true);
    }
  });

  test('(b) fake observations influence the result — synthetic values appear in facts', async () => {
    const { quote, health } = marketFakes();
    const run = await runAgentTask({ task: TASK, tools: fakeMap(quote, health), summarize: null });
    const bid = run.result?.facts.find((f) => f.tool === 'get_latest_quote' && f.key === 'bid');
    expect(bid?.value).toBe(2650.1);
    expect(bid?.sourceStepId).toBe('step-1');
    const freshness = run.result?.facts.find((f) => f.tool === 'get_market_health' && f.key === 'freshness');
    expect(freshness?.value).toBe('LIVE');
    expect(run.result?.summaryBn).toBeNull(); // no GLM required — deterministic core
  });

  test('(h) persistence: run + step rows exist in the test DB with correct statuses', async () => {
    const { quote, health } = marketFakes();
    const dto = await runAgentTask({ task: TASK, tools: fakeMap(quote, health), summarize: null });

    const row = await db.agentRun.findUnique({
      where: { id: dto.id },
      include: { steps: { orderBy: { seq: 'asc' } } },
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('COMPLETED');
    expect(row!.steps).toHaveLength(2);
    expect(row!.steps.map((s) => s.state)).toEqual(['DONE', 'DONE']);
    expect(row!.steps.map((s) => s.toolName)).toEqual(['get_latest_quote', 'get_market_health']);
    expect(row!.steps[0].toolArgsDigest).toBe('{"keys":[]}');
    expect(row!.steps[0].toolResultDigest).toContain('bid');
    expect(row!.steps[0].retries).toBe(0);
    expect(row!.stepsUsed).toBe(2);
    expect(row!.toolCallsUsed).toBe(2);
    expect(row!.stepsMax).toBe(DEFAULT_AGENT_BUDGETS.stepsMax);
    expect(row!.toolCallsMax).toBe(DEFAULT_AGENT_BUDGETS.toolCallsMax);
    expect(row!.endedAtUtc).not.toBeNull();
    expect(row!.elapsedMs).toBeGreaterThanOrEqual(0);

    const plan = JSON.parse(row!.planJson) as PlannedStep[];
    expect(plan.map((p) => p.status)).toEqual(['DONE', 'DONE']);
    const result = JSON.parse(row!.resultJson!) as { verdict: string; facts: unknown[] };
    expect(result.verdict).toBe('COMPLETED');
    expect(result.facts.length).toBeGreaterThan(0);

    // Observability: the run left an audit trail (tool calls observable in logs).
    const events = await db.systemEvent.findMany({
      where: { code: { in: ['AGENT_RUN_STARTED', 'AGENT_RUN_PLANNED', 'AGENT_TOOL_CALL', 'AGENT_RUN_COMPLETED'] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    expect(events.some((e) => (e.meta ?? '').includes(dto.id))).toBe(true);
  });

  test('default budgets are persisted on the run row (stepsMax 6 / toolCallsMax 8 / 60s)', async () => {
    const { quote, health } = marketFakes();
    const run = await runAgentTask({ task: TASK, tools: fakeMap(quote, health), summarize: null });
    expect(run.stepsMax).toBe(6);
    expect(run.toolCallsMax).toBe(8);
  });

  test('an injected summarizer only produces summaryBn — it can never alter facts', async () => {
    const { quote, health } = marketFakes();
    const run = await runAgentTask({
      task: TASK,
      tools: fakeMap(quote, health),
      summarize: async () => 'এটি একটি পরামর্শমূলক সারসংক্ষেপ।',
    });
    expect(run.status).toBe('COMPLETED');
    expect(run.result?.summaryBn).toBe('এটি একটি পরামর্শমূলক সারসংক্ষেপ।');
    expect(run.result?.facts.some((f) => f.key === 'bid' && f.value === 2650.1)).toBe(true);
  });

  test('a run executed with default options never touches GLM (llmSummary defaults off)', async () => {
    const { quote, health } = marketFakes();
    const run = await runAgentTask({ task: TASK, tools: fakeMap(quote, health) });
    expect(run.status).toBe('COMPLETED');
    expect(run.result?.summaryBn).toBeNull();
  });

  test('re-running a terminal run id is a no-op (never re-executed)', async () => {
    const { quote, health } = marketFakes();
    const map = fakeMap(quote, health);
    const first = await runAgentTask({ task: TASK, tools: map, summarize: null, runId: 'agent-test-fixed-id' });
    expect(first.status).toBe('COMPLETED');
    const again = await runAgentTask({ task: TASK, tools: map, summarize: null, runId: 'agent-test-fixed-id' });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('COMPLETED');
    expect(quote.calls).toBe(1); // NOT re-executed
  });
});

// ---------------------------------------------------------------------------
// (c) Transient failure — bounded retry with backoff, retries persisted
// ---------------------------------------------------------------------------

describe('agent run — transient tool failure', () => {
  test('fails once, succeeds on retry → COMPLETED; retries counter persisted', async () => {
    const flaky = new FakeTool('get_latest_quote', (n) =>
      n === 1 ? { __fail: 'transient bridge hiccup' } : { available: true, bid: 2650.5 },
    );
    const health = new FakeTool('get_market_health', () => ({ freshness: 'LIVE' }));
    const run = await runAgentTask({ task: TASK, tools: fakeMap(flaky, health), summarize: null });

    expect(flaky.calls).toBe(2); // 1 fail + 1 retry (bounded exponential backoff ran between)
    expect(run.status).toBe('COMPLETED');
    expect(run.result?.facts.some((f) => f.tool === 'get_latest_quote' && f.key === 'bid' && f.value === 2650.5)).toBe(true);

    const flakyStep = run.steps.find((s) => s.toolName === 'get_latest_quote');
    expect(flakyStep?.state).toBe('DONE');
    expect(flakyStep?.retries).toBe(1);

    // Both attempts counted against the tool-call budget (honest accounting)
    // + at least one 200ms backoff elapsed.
    expect(run.toolCallsUsed).toBe(3);
    expect(run.elapsedMs).toBeGreaterThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// (d) Permanent failure → honest BLOCKED
// ---------------------------------------------------------------------------

describe('agent run — permanent tool failure', () => {
  test('tool fails after all retries → BLOCKED with the honest error; later steps SKIPPED', async () => {
    const dead = new FakeTool('get_latest_quote', () => ({ __fail: 'bridge permanently down' }));
    const health = new FakeTool('get_market_health', () => ({ freshness: 'LIVE' }));
    const run = await runAgentTask({ task: TASK, tools: fakeMap(dead, health), summarize: null });

    expect(dead.calls).toBe(3); // 1 + maxRetries(2) — stuck detection terminates honestly
    expect(run.status).toBe('BLOCKED');
    expect(run.result?.verdict).toBe('BLOCKED');
    expect(run.result?.reason).toBe('TOOL_FAILED');
    expect(run.errorText).toContain('TOOL_FAILED');
    expect(run.errorText).toContain('bridge permanently down');

    const failed = run.steps.find((s) => s.toolName === 'get_latest_quote');
    expect(failed?.state).toBe('FAILED');
    expect(failed?.retries).toBe(2);
    expect(failed?.errorText).toContain('bridge permanently down');

    const skipped = run.steps.find((s) => s.toolName === 'get_market_health');
    expect(skipped?.state).toBe('SKIPPED');
    expect(run.toolCallsUsed).toBe(3);
  });

  test('a missing required tool (not in the map) → BLOCKED TOOL_NOT_AVAILABLE', async () => {
    const run = await runAgentTask({
      task: TASK,
      tools: fakeMap(), // empty — the required tool does not exist
      plan: [{ stepId: 'step-1', description: 'd', tool: 'get_latest_quote', status: 'PLANNED' }],
      summarize: null,
    });
    expect(run.status).toBe('BLOCKED');
    expect(run.result?.reason).toBe('TOOL_FAILED');
    expect(run.errorText).toContain('TOOL_NOT_AVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// (e) Budget exhaustion → BLOCKED 'BUDGET_EXCEEDED'
// ---------------------------------------------------------------------------

describe('agent run — budget exhaustion', () => {
  test('crafted plan exceeding toolCallsMax → BLOCKED BUDGET_EXCEEDED (tools all succeed)', async () => {
    const quote = new FakeTool('get_latest_quote', () => ({ bid: 1 }));
    const health = new FakeTool('get_market_health', () => ({ freshness: 'LIVE' }));
    const plan: PlannedStep[] = [
      { stepId: 'step-1', description: 'd1', tool: 'get_latest_quote', status: 'PLANNED' },
      { stepId: 'step-2', description: 'd2', tool: 'get_latest_quote', status: 'PLANNED' },
      { stepId: 'step-3', description: 'd3', tool: 'get_market_health', status: 'PLANNED' },
    ];
    const run = await runAgentTask({
      task: TASK,
      tools: fakeMap(quote, health),
      plan,
      budgets: { toolCallsMax: 2 },
      summarize: null,
    });

    expect(run.status).toBe('BLOCKED');
    expect(run.result?.reason).toBe('BUDGET_EXCEEDED');
    expect(run.errorText).toContain('BUDGET_EXCEEDED');
    expect(run.toolCallsUsed).toBe(2); // exactly the budget — never more
    expect(quote.calls).toBe(2);
    expect(run.steps[2].state).toBe('SKIPPED');
    expect(run.steps[0].state).toBe('DONE');
    expect(run.steps[1].state).toBe('DONE');
  });

  test('crafted plan exceeding stepsMax → BLOCKED BUDGET_EXCEEDED', async () => {
    const quote = new FakeTool('get_latest_quote', () => ({ bid: 1 }));
    const plan: PlannedStep[] = [1, 2, 3].map((i) => ({
      stepId: `step-${i}`,
      description: `d${i}`,
      tool: 'get_latest_quote',
      status: 'PLANNED' as const,
    }));
    const run = await runAgentTask({
      task: TASK,
      tools: fakeMap(quote),
      plan,
      budgets: { stepsMax: 2 },
      summarize: null,
    });
    expect(run.status).toBe('BLOCKED');
    expect(run.result?.reason).toBe('BUDGET_EXCEEDED');
    expect(run.errorText).toContain('step budget');
    expect(run.stepsUsed).toBe(2);
    expect(run.steps.map((s) => s.state)).toEqual(['DONE', 'DONE', 'SKIPPED']);
  });
});

// ---------------------------------------------------------------------------
// (f) Unknown task → BLOCKED 'UNKNOWN_TASK'
// ---------------------------------------------------------------------------

describe('agent run — unknown task', () => {
  test('no planner match → BLOCKED UNKNOWN_TASK, no plan fabricated, no steps', async () => {
    const quote = new FakeTool('get_latest_quote', () => ({ bid: 1 }));
    const run = await runAgentTask({ task: 'quantum banana teleport', tools: fakeMap(quote), summarize: null });

    expect(run.status).toBe('BLOCKED');
    expect(run.result?.reason).toBe('UNKNOWN_TASK');
    expect(run.errorText).toContain('UNKNOWN_TASK');
    expect(run.plan).toEqual([]);
    expect(run.steps).toEqual([]);
    expect(run.stepsUsed).toBe(0);
    expect(run.toolCallsUsed).toBe(0);
    expect(quote.calls).toBe(0); // never invoked — nothing was pretended
    expect(run.result?.facts).toEqual([]);
    expect(run.result?.summaryBn).toBeNull();
  });
});
