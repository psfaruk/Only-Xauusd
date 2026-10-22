/**
 * XAUUSD AI Trading Agent — Agent Orchestrator (Phase 7, Task 42-S4)
 * ----------------------------------------------------------------------------
 * A REAL bounded tool-using agent runtime — not a role-playing chatbot.
 *
 *   plan()      deterministic keyword planner (Bengali + English). An unknown
 *               task is BLOCKED 'UNKNOWN_TASK' — a plan is NEVER fabricated.
 *   execute()   steps run SEQUENTIALLY through the allowlisted read-only tool
 *               map. Before every tool call the run row is persisted as
 *               WAITING_FOR_TOOL (+ the step row); after it the bounded result
 *               digest + RUNNING are persisted. Retries: bounded exponential
 *               backoff (tools.ts), attempt-counted against the budget.
 *   verify()    deterministic verification — every FACT in the result must
 *               come from a tool observation (sourceStepId); a fact with no
 *               observation is DROPPED, never invented. The verdict is
 *               computed from step outcomes only.
 *   budgets     stepsMax 6, toolCallsMax 8, wallClockMs 60_000. Exceeding any
 *               budget → BLOCKED 'BUDGET_EXCEEDED' (a run can never loop
 *               forever). Stuck detection: a step still failing after
 *               maxRetries terminates the run honestly.
 *   persistence every state transition is written to the AgentRun row via
 *               Prisma (restart-safe: an interrupted run is listed with its
 *               LAST state — nothing is ever fabricated as completed).
 *
 * LLM usage is OPTIONAL and ADVISORY only: when enabled, ONE final GLM call
 * may summarize the collected observations in Bengali (summaryBn). The model
 * can NEVER add facts — facts come solely from tool observations. GLM failure
 * → summaryBn null and the run still COMPLETES: the deterministic core works
 * without AI.
 *
 * READ-ONLY BY CONSTRUCTION: the default tool map is the 9-tool allowlist in
 * tools.ts (asserted free of any order/execution tool). The tool map, plan and
 * summarizer are injectable so integration tests run a FAKE deterministic
 * environment — no live bridge, no GLM, no network.
 */

import { db } from '@/lib/db';
import { logEvent } from '@/lib/logger';
import { canTransition, isTerminal, transition, type AgentRunStatus, type AgentStepState } from './state-machine';
import {
  assertNoExecutionTools,
  defaultAgentTools,
  executeAgentTool,
  looksLikeExecutionToolName,
  toolArgsDigest,
  toolResultDigest,
  type AgentToolMap,
} from './tools';
import { getAgentRunDto, type AgentRunDto } from './serialize';

export const AGENT_RUNTIME_VERSION = '7.0.0';

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface AgentBudgets {
  stepsMax: number;
  toolCallsMax: number;
  wallClockMs: number;
}

export const DEFAULT_AGENT_BUDGETS: AgentBudgets = {
  stepsMax: 6,
  toolCallsMax: 8,
  wallClockMs: 60_000,
};

export const MIN_TASK_CHARS = 5;
export const MAX_TASK_CHARS = 500;
/** Planner bound: 2-5 typed steps per plan (single-tool categories honestly
 *  produce a 1-step plan; multi-category tasks are capped at MAX_PLAN_STEPS). */
export const MAX_PLAN_STEPS = 5;

// ---------------------------------------------------------------------------
// Plan + result types (the persisted JSON contract)
// ---------------------------------------------------------------------------

export interface PlannedStep {
  stepId: string;
  description: string;
  tool: string;
  status: AgentStepState;
}

export interface AgentFact {
  /** The step whose TOOL OBSERVATION produced this fact — never invented. */
  sourceStepId: string;
  tool: string;
  key: string;
  value: string | number | boolean | null;
}

export interface AgentEvidence {
  stepId: string;
  tool: string;
  ok: boolean;
  digest: string | null;
  retries: number;
  attempts: number;
  durationMs: number;
}

export interface AgentRunResultPayload {
  verdict: string;
  reason: string | null;
  facts: AgentFact[];
  evidence: AgentEvidence[];
  summaryBn: string | null;
}

// ---------------------------------------------------------------------------
// Deterministic planner — Bengali + English keyword mapping
// ---------------------------------------------------------------------------

const TOOL_STEP_DESCRIPTIONS: Record<string, string> = {
  get_latest_quote: 'সর্বশেষ যাচাইকৃত কোট (bid/ask/spread) সংগ্রহ',
  get_market_health: 'মার্কেট ডেটা স্বাস্থ্য ও ফ্রেশনেস পরীক্ষা',
  get_latest_signal: 'সর্বশেষ deterministic সিগন্যাল ইভ্যালুয়েশন সংগ্রহ',
  explain_signal_evidence: 'সিগন্যালের প্রমাণ-ব্যাখ্যা সংগ্রহ',
  get_latest_analysis: 'সর্বশেষ বিশ্লেষণ রান সংগ্রহ',
  get_backtest_summary: 'সর্বশেষ ব্যাকটেস্ট সারসংক্ষেপ সংগ্রহ',
  get_system_health: 'সিস্টেম স্বাস্থ্য পরীক্ষা',
  get_candle_coverage: 'ক্যান্ডেল-কভারেজ অডিট সংগ্রহ',
  get_ai_review: 'সর্বশেষ GLM মাল্টি-এজেন্ট রিভিউ সংগ্রহ',
};

interface PlannerRule {
  keys: string[];
  tools: string[];
}

const PLANNER_RULES: PlannerRule[] = [
  { keys: ['বাজার', 'market', 'quote'], tools: ['get_latest_quote', 'get_market_health'] },
  { keys: ['সিগন্যাল', 'signal'], tools: ['get_latest_signal', 'explain_signal_evidence'] },
  { keys: ['বিশ্লেষণ', 'analysis'], tools: ['get_latest_analysis'] },
  { keys: ['ব্যাকটেস্ট', 'backtest'], tools: ['get_backtest_summary'] },
  { keys: ['স্বাস্থ্য', 'health', 'সিস্টেম', 'system'], tools: ['get_system_health', 'get_candle_coverage'] },
  { keys: ['রিভিউ', 'review'], tools: ['get_ai_review'] },
];

/**
 * Deterministic task → plan mapping. Returns null for an UNKNOWN task (the
 * caller BLOCKS the run honestly — a plan is never fabricated).
 */
export function planAgentTask(task: string): PlannedStep[] | null {
  const normalized = task.trim().toLowerCase();
  if (!normalized) return null;
  const tools: string[] = [];
  for (const rule of PLANNER_RULES) {
    if (rule.keys.some((k) => normalized.includes(k.toLowerCase()))) {
      for (const t of rule.tools) {
        if (!tools.includes(t)) tools.push(t);
      }
    }
  }
  if (tools.length === 0) return null;
  return tools.slice(0, MAX_PLAN_STEPS).map((tool, i) => ({
    stepId: `step-${i + 1}`,
    description: TOOL_STEP_DESCRIPTIONS[tool] ?? `টুল ${tool} সম্পাদন`,
    tool,
    status: 'PLANNED' as const,
  }));
}

// ---------------------------------------------------------------------------
// Deterministic verification — facts come ONLY from tool observations
// ---------------------------------------------------------------------------

export interface StepRecord {
  stepId: string;
  tool: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  digest: string | null;
  retries: number;
  attempts: number;
  durationMs: number;
}

const MAX_FACTS = 60;
const MAX_FACTS_PER_OBSERVATION = 8;
const MAX_FACT_VALUE_CHARS = 120;

/**
 * Verification pass (pure):
 *   · evidence = every executed step (bounded digests);
 *   · facts = primitive top-level fields of SUCCESSFUL observations only,
 *     each carrying its sourceStepId;
 *   · enforcement: any fact whose (sourceStepId, tool) has no successful
 *     observation is DROPPED — a fact can never exist without an observation.
 */
export function verifyObservations(records: StepRecord[]): { facts: AgentFact[]; evidence: AgentEvidence[] } {
  const facts: AgentFact[] = [];
  const evidence: AgentEvidence[] = records.map((r) => ({
    stepId: r.stepId,
    tool: r.tool,
    ok: r.ok,
    digest: r.digest,
    retries: r.retries,
    attempts: r.attempts,
    durationMs: r.durationMs,
  }));

  for (const r of records) {
    if (!r.ok || !r.data) continue;
    let taken = 0;
    for (const [key, value] of Object.entries(r.data)) {
      if (taken >= MAX_FACTS_PER_OBSERVATION || facts.length >= MAX_FACTS) break;
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        facts.push({
          sourceStepId: r.stepId,
          tool: r.tool,
          key: key.slice(0, 40),
          value: typeof value === 'string' ? value.slice(0, MAX_FACT_VALUE_CHARS) : value,
        });
        taken += 1;
      }
    }
  }

  // Enforcement pass — the single authority on "facts need observations".
  const observed = new Set(records.filter((r) => r.ok).map((r) => `${r.stepId}|${r.tool}`));
  const verifiedFacts = facts.filter((f) => observed.has(`${f.sourceStepId}|${f.tool}`));

  return { facts: verifiedFacts, evidence };
}

// ---------------------------------------------------------------------------
// Optional GLM summary (advisory — can NEVER add facts)
// ---------------------------------------------------------------------------

export interface SummaryInput {
  task: string;
  facts: AgentFact[];
  evidence: AgentEvidence[];
}

export type AgentSummarizer = (input: SummaryInput) => Promise<string | null>;

export const MAX_SUMMARY_CHARS = 1_200;
const SUMMARY_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function summaryPrompt(input: SummaryInput): string {
  const factLines = input.facts
    .slice(0, 24)
    .map((f) => `- [${f.sourceStepId} · ${f.tool}] ${f.key} = ${String(f.value)}`)
    .join('\n');
  return `তুমি XAUUSD AI Trading Agent-এর সারসংক্ষেপকারী (read-only গবেষণা সিস্টেম)।

নিচের টুল পর্যবেক্ষণগুলোই একমাত্র সত্যের উৎস। কাজ: "${input.task}" — এই কাজের ফলাফল ৩-৫ বাক্যে সহজ বাংলায় সারসংক্ষেপ করো।

কঠোর নিয়ম:
1. নতুন কোনো সংখ্যা, দাম বা তথ্য বানাবে না — শুধু নিচের পর্যবেক্ষণ থেকে লিখবে।
2. ডেটা অনুপলব্ধ/STALE হলে সেটাই সৎভাবে বলবে।
3. এই সিস্টেম কোনো ট্রেড কার্যকর করে না — "ট্রেড হয়েছে" লিখবে না।
4. শুধু সারসংক্ষেপ লিখবে, নতুন কোনো সিদ্ধান্ত/সিগন্যাল যোগ করবে না।

--- টুল পর্যবেক্ষণ ---
${factLines}`;
}

/**
 * Built-in GLM summarizer (server-side only — same SDK usage pattern as
 * src/lib/ai/multi-agent.ts; imported lazily so tests never touch the SDK).
 * Returns null on ANY failure — the run still completes without it.
 */
export async function glmSummarize(input: SummaryInput): Promise<string | null> {
  try {
    const { default: ZAI } = await import('z-ai-web-dev-sdk');
    const zai = await ZAI.create();
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          {
            role: 'assistant',
            content:
              'তুমি একজন নিয়ম-মেনে-চলা সারসংক্ষেপকারী। শুধু দেওয়া পর্যবেক্ষণ থেকে সারসংক্ষেপ লিখবে — নতুন কোনো তথ্য বা সংখ্যা বানাবে না।',
          },
          { role: 'user', content: summaryPrompt(input) },
        ],
        thinking: { type: 'disabled' },
      }),
      SUMMARY_TIMEOUT_MS,
      'GLM summary',
    );
    const text = completion.choices[0]?.message?.content ?? '';
    const trimmed = text.trim();
    return trimmed ? trimmed.slice(0, MAX_SUMMARY_CHARS) : null;
  } catch {
    return null; // honest degradation — the deterministic core is unaffected
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface RunAgentTaskOptions {
  task: string;
  /** Reuse/adopt an existing CREATED run row (idempotent: a started or
   *  terminal run is returned as-is and never re-executed). */
  runId?: string;
  budgets?: Partial<AgentBudgets>;
  /** Injectable tool map (tests). Default: the 9-tool read-only allowlist. */
  tools?: AgentToolMap;
  /** Injectable crafted plan (tests). Default: planAgentTask(task). */
  plan?: PlannedStep[];
  /** Opt in to the built-in GLM summary (advisory only). Default: false. */
  llmSummary?: boolean;
  /** Injectable summarizer (tests) — a function, or null to disable explicitly.
   *  Overrides llmSummary. */
  summarize?: AgentSummarizer | null;
}

function blockedResult(reason: string, records: StepRecord[]): AgentRunResultPayload {
  const { facts, evidence } = verifyObservations(records);
  return { verdict: 'BLOCKED', reason, facts, evidence, summaryBn: null };
}

/** Run one bounded agent task end-to-end. Never leaves a run "working". */
export async function runAgentTask(opts: RunAgentTaskOptions): Promise<AgentRunDto> {
  const budgets: AgentBudgets = {
    stepsMax: Math.max(1, Math.floor(opts.budgets?.stepsMax ?? DEFAULT_AGENT_BUDGETS.stepsMax)),
    toolCallsMax: Math.max(1, Math.floor(opts.budgets?.toolCallsMax ?? DEFAULT_AGENT_BUDGETS.toolCallsMax)),
    wallClockMs: Math.max(1_000, Math.floor(opts.budgets?.wallClockMs ?? DEFAULT_AGENT_BUDGETS.wallClockMs)),
  };
  const tools = opts.tools ?? defaultAgentTools();
  // Signal-only invariant at the tool boundary — enforced for ANY tool map
  // (injected test maps may use fake names, but never order/execution names).
  for (const name of tools.keys()) {
    if (looksLikeExecutionToolName(name)) {
      throw new Error(`agent tool map violated: '${name}' looks like an execution tool`);
    }
  }
  if (!opts.tools) assertNoExecutionTools(tools); // full default-allowlist assertion

  const rawTask = opts.task.trim().slice(0, MAX_TASK_CHARS);

  // ---- Create or adopt the run row (status CREATED) ------------------------
  let runId = opts.runId ?? null;
  let task = rawTask;
  if (runId) {
    const existing = await db.agentRun.findUnique({ where: { id: runId } });
    if (existing) {
      if (existing.status !== 'CREATED') {
        // Idempotent safety: a started/terminal run is NEVER re-executed.
        const dto = await getAgentRunDto(runId);
        if (dto) return dto;
      }
      task = existing.task;
    } else {
      await db.agentRun.create({
        data: {
          id: runId,
          task,
          status: 'CREATED',
          planJson: '[]',
          stepsMax: budgets.stepsMax,
          toolCallsMax: budgets.toolCallsMax,
        },
      });
    }
  } else {
    const created = await db.agentRun.create({
      data: {
        task,
        status: 'CREATED',
        planJson: '[]',
        stepsMax: budgets.stepsMax,
        toolCallsMax: budgets.toolCallsMax,
      },
    });
    runId = created.id;
  }

  const startWall = Date.now();
  const elapsed = () => Date.now() - startWall;
  let status: AgentRunStatus = 'CREATED';
  let stepsUsed = 0;
  let toolCallsUsed = 0;
  const records: StepRecord[] = [];

  /** Persist a LEGAL state transition (+ patch). Throws on illegal moves. */
  const setStatus = async (to: AgentRunStatus, patch: Record<string, unknown> = {}): Promise<void> => {
    const t = transition(status, to);
    if (!t.ok) throw new Error(`agent run ${runId}: ${t.error}`);
    await db.agentRun.update({
      where: { id: runId! },
      data: { status: to, elapsedMs: elapsed(), ...patch },
    });
    status = to;
  };

  await logEvent({
    level: 'info',
    category: 'app',
    code: 'AGENT_RUN_STARTED',
    message: `Agent run ${runId} started (v${AGENT_RUNTIME_VERSION}): ${task.slice(0, 120)}`,
    meta: { runId, task: task.slice(0, 200), stepsMax: budgets.stepsMax, toolCallsMax: budgets.toolCallsMax },
  });

  try {
    // ---- 1. PLAN -----------------------------------------------------------
    const injectedPlan = opts.plan && opts.plan.length > 0 ? opts.plan : null;
    const plan = injectedPlan ?? planAgentTask(task);

    if (!plan || plan.length === 0) {
      const result: AgentRunResultPayload = {
        verdict: 'BLOCKED',
        reason: 'UNKNOWN_TASK',
        facts: [],
        evidence: [],
        summaryBn: null,
      };
      await setStatus('BLOCKED', {
        errorText: 'UNKNOWN_TASK: planner matched no known task category — no plan was fabricated',
        resultJson: JSON.stringify(result),
        endedAtUtc: new Date(),
      });
      await logEvent({
        level: 'warn',
        category: 'app',
        code: 'AGENT_RUN_BLOCKED',
        message: `Agent run ${runId} BLOCKED (UNKNOWN_TASK): ${task.slice(0, 120)}`,
        meta: { runId, reason: 'UNKNOWN_TASK' },
      });
      return (await getAgentRunDto(runId!))!;
    }

    // Step rows (audit trail — one per planned step, state PLANNED).
    const stepRowIds = new Map<string, string>();
    for (let i = 0; i < plan.length; i++) {
      const row = await db.agentStep.create({
        data: { runId: runId!, seq: i + 1, state: 'PLANNED', toolName: plan[i].tool },
      });
      stepRowIds.set(plan[i].stepId, row.id);
    }
    await setStatus('PLANNED', { planJson: JSON.stringify(plan) });
    await logEvent({
      level: 'info',
      category: 'app',
      code: 'AGENT_RUN_PLANNED',
      message: `Agent run ${runId} planned ${plan.length} step(s): ${plan.map((p) => p.tool).join(', ')}`,
      meta: { runId, steps: plan.map((p) => ({ stepId: p.stepId, tool: p.tool })) },
    });

    // ---- 2. RUN steps sequentially ------------------------------------------
    await setStatus('RUNNING');

    const setStepState = async (
      stepId: string,
      state: AgentStepState,
      patch: Record<string, unknown> = {},
    ): Promise<void> => {
      await db.agentStep.update({
        where: { id: stepRowIds.get(stepId)! },
        data: {
          state,
          ...(state === 'DONE' || state === 'FAILED' || state === 'SKIPPED' ? { endedAtUtc: new Date() } : {}),
          ...patch,
        },
      });
    };
    const setPlanStatus = (stepId: string, st: AgentStepState): void => {
      const s = plan.find((p) => p.stepId === stepId);
      if (s) s.status = st;
    };

    let failedStep: { stepId: string; tool: string; error: string } | null = null;
    let budgetBlocked: string | null = null;

    for (const step of plan) {
      // Step-level budget gates.
      if (stepsUsed + 1 > budgets.stepsMax) {
        budgetBlocked = `BUDGET_EXCEEDED: step budget (${budgets.stepsMax}) exhausted`;
        break;
      }
      if (elapsed() >= budgets.wallClockMs) {
        budgetBlocked = `BUDGET_EXCEEDED: wall-clock budget (${budgets.wallClockMs}ms) exhausted`;
        break;
      }

      stepsUsed += 1;
      await setStepState(step.stepId, 'RUNNING');
      setPlanStatus(step.stepId, 'RUNNING');
      await db.agentRun.update({
        where: { id: runId! },
        data: { stepsUsed, planJson: JSON.stringify(plan), elapsedMs: elapsed() },
      });

      const tool = tools.get(step.tool);
      if (!tool) {
        await setStepState(step.stepId, 'FAILED', { errorText: `TOOL_NOT_AVAILABLE: ${step.tool}` });
        setPlanStatus(step.stepId, 'FAILED');
        failedStep = { stepId: step.stepId, tool: step.tool, error: `TOOL_NOT_AVAILABLE: ${step.tool}` };
        break;
      }

      // BEFORE the tool call: persist WAITING_FOR_TOOL (run + step row).
      await setStatus('WAITING_FOR_TOOL', { planJson: JSON.stringify(plan) });
      await setStepState(step.stepId, 'WAITING_FOR_TOOL', { toolArgsDigest: toolArgsDigest({}) });
      setPlanStatus(step.stepId, 'WAITING_FOR_TOOL');

      // Bounded execution — every ATTEMPT must pass the budget gate.
      const outcome = await executeAgentTool(tool, {}, {
        allowAttempt: () => {
          if (toolCallsUsed + 1 > budgets.toolCallsMax) {
            return {
              allowed: false,
              reason: `BUDGET_EXCEEDED: tool-call budget (${budgets.toolCallsMax}) exhausted`,
            };
          }
          if (elapsed() >= budgets.wallClockMs) {
            return {
              allowed: false,
              reason: `BUDGET_EXCEEDED: wall-clock budget (${budgets.wallClockMs}ms) exhausted`,
            };
          }
          toolCallsUsed += 1;
          return { allowed: true };
        },
      });

      if (outcome.budgetExhausted) {
        budgetBlocked = outcome.error ?? 'BUDGET_EXCEEDED';
        await setStepState(step.stepId, 'SKIPPED', {
          errorText: `${budgetBlocked} — ধাপটি সম্পন্ন হয়নি (রান বাজেট শেষ)`,
          retries: outcome.retries,
        });
        setPlanStatus(step.stepId, 'SKIPPED');
        break;
      }

      const digest = toolResultDigest(outcome.data);
      records.push({
        stepId: step.stepId,
        tool: step.tool,
        ok: outcome.ok,
        data: outcome.data,
        error: outcome.error,
        digest,
        retries: outcome.retries,
        attempts: outcome.attempts,
        durationMs: outcome.durationMs,
      });

      // AFTER the tool call: persist digest + step outcome, run → RUNNING.
      if (outcome.ok) {
        await setStepState(step.stepId, 'DONE', { toolResultDigest: digest, retries: outcome.retries });
        setPlanStatus(step.stepId, 'DONE');
      } else {
        await setStepState(step.stepId, 'FAILED', { errorText: outcome.error, retries: outcome.retries });
        setPlanStatus(step.stepId, 'FAILED');
      }
      await setStatus('RUNNING', { toolCallsUsed, planJson: JSON.stringify(plan) });

      await logEvent({
        level: outcome.ok ? 'info' : 'warn',
        category: 'app',
        code: 'AGENT_TOOL_CALL',
        message: `Agent tool ${step.tool} ${outcome.ok ? 'ok' : 'FAILED'} (attempts ${outcome.attempts}, retries ${outcome.retries}, ${outcome.durationMs}ms)`,
        meta: {
          runId,
          stepId: step.stepId,
          tool: step.tool,
          ok: outcome.ok,
          attempts: outcome.attempts,
          retries: outcome.retries,
          durationMs: outcome.durationMs,
          error: outcome.error ? outcome.error.slice(0, 200) : undefined,
        },
      });

      if (!outcome.ok) {
        failedStep = { stepId: step.stepId, tool: step.tool, error: outcome.error ?? 'tool failed' };
        break; // remaining steps are SKIPPED — the plan is a conjunction
      }
    }

    // Untouched steps (after break) are honestly SKIPPED.
    for (const step of plan) {
      if (step.status === 'PLANNED') {
        await setStepState(step.stepId, 'SKIPPED');
        setPlanStatus(step.stepId, 'SKIPPED');
      }
    }

    // ---- Budget exhaustion → honest BLOCKED (never loops forever) -----------
    if (budgetBlocked) {
      const result = blockedResult('BUDGET_EXCEEDED', records);
      await setStatus('BLOCKED', {
        errorText: budgetBlocked,
        resultJson: JSON.stringify(result),
        endedAtUtc: new Date(),
        toolCallsUsed,
        planJson: JSON.stringify(plan),
      });
      await logEvent({
        level: 'warn',
        category: 'app',
        code: 'AGENT_RUN_BLOCKED',
        message: `Agent run ${runId} BLOCKED (${budgetBlocked}) after ${stepsUsed} step(s), ${toolCallsUsed} tool call(s)`,
        meta: { runId, reason: 'BUDGET_EXCEEDED', stepsUsed, toolCallsUsed, elapsedMs: elapsed() },
      });
      return (await getAgentRunDto(runId!))!;
    }

    // ---- 3. VERIFY ----------------------------------------------------------
    await setStatus('VERIFYING', { toolCallsUsed, planJson: JSON.stringify(plan) });

    if (failedStep) {
      const result = blockedResult('TOOL_FAILED', records);
      const errorText = `TOOL_FAILED: ${failedStep.tool}: ${failedStep.error}`.slice(0, 900);
      await setStatus('BLOCKED', {
        errorText,
        resultJson: JSON.stringify(result),
        endedAtUtc: new Date(),
      });
      await logEvent({
        level: 'warn',
        category: 'app',
        code: 'AGENT_RUN_BLOCKED',
        message: `Agent run ${runId} BLOCKED (TOOL_FAILED: ${failedStep.tool})`,
        meta: { runId, reason: 'TOOL_FAILED', tool: failedStep.tool, stepsUsed, toolCallsUsed },
      });
      return (await getAgentRunDto(runId!))!;
    }

    const { facts, evidence } = verifyObservations(records);
    if (facts.length === 0) {
      const result = blockedResult('NO_OBSERVATIONS', records);
      await setStatus('BLOCKED', {
        errorText: 'NO_OBSERVATIONS: no successful tool observation exists — no fact can be reported',
        resultJson: JSON.stringify(result),
        endedAtUtc: new Date(),
      });
      await logEvent({
        level: 'warn',
        category: 'app',
        code: 'AGENT_RUN_BLOCKED',
        message: `Agent run ${runId} BLOCKED (NO_OBSERVATIONS)`,
        meta: { runId, reason: 'NO_OBSERVATIONS', stepsUsed, toolCallsUsed },
      });
      return (await getAgentRunDto(runId!))!;
    }

    // ---- 4. Optional GLM summary (advisory — can NEVER add facts) -----------
    let summaryBn: string | null = null;
    const summarizer: AgentSummarizer | null =
      opts.summarize !== undefined ? opts.summarize : opts.llmSummary ? glmSummarize : null;
    if (summarizer) {
      const remaining = budgets.wallClockMs - elapsed();
      if (remaining > 1_000) {
        summaryBn = await withTimeout(
          summarizer({ task, facts, evidence }),
          Math.min(SUMMARY_TIMEOUT_MS, remaining),
          'agent summary',
        ).catch(() => null);
      }
      summaryBn = summaryBn && summaryBn.trim() ? summaryBn.trim().slice(0, MAX_SUMMARY_CHARS) : null;
    }

    const result: AgentRunResultPayload = { verdict: 'COMPLETED', reason: null, facts, evidence, summaryBn };
    await setStatus('COMPLETED', {
      resultJson: JSON.stringify(result),
      endedAtUtc: new Date(),
    });
    await logEvent({
      level: 'info',
      category: 'app',
      code: 'AGENT_RUN_COMPLETED',
      message: `Agent run ${runId} COMPLETED — ${facts.length} verified fact(s) from ${records.length} step(s)${summaryBn ? ' (+GLM summary)' : ''}`,
      meta: { runId, facts: facts.length, steps: records.length, stepsUsed, toolCallsUsed, elapsedMs: elapsed() },
    });
    return (await getAgentRunDto(runId!))!;
  } catch (err) {
    // ---- Unexpected exception → honest FAILED (never left "working") --------
    const msg = err instanceof Error ? err.message : String(err);
    if (!isTerminal(status)) {
      try {
        if (canTransition(status, 'FAILED')) {
          const partial = verifyObservations(records);
          await db.agentRun.update({
            where: { id: runId! },
            data: {
              status: 'FAILED',
              errorText: `UNEXPECTED_ERROR: ${msg}`.slice(0, 900),
              resultJson: JSON.stringify({
                verdict: 'FAILED',
                reason: 'UNEXPECTED_ERROR',
                facts: partial.facts,
                evidence: partial.evidence,
                summaryBn: null,
              } satisfies AgentRunResultPayload),
              endedAtUtc: new Date(),
              elapsedMs: elapsed(),
              stepsUsed,
              toolCallsUsed,
            },
          });
        }
      } catch {
        // Persistence failure must not mask the original error — the row
        // keeps its LAST persisted state (restart-safe, never fabricated).
      }
    }
    await logEvent({
      level: 'error',
      category: 'app',
      code: 'AGENT_RUN_FAILED',
      message: `Agent run ${runId} FAILED (unexpected): ${msg.slice(0, 200)}`,
      meta: { runId, stepsUsed, toolCallsUsed },
    });
    const dto = await getAgentRunDto(runId!);
    if (!dto) throw err;
    return dto;
  }
}
