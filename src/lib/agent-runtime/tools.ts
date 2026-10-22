/**
 * XAUUSD AI Trading Agent — Agent Tools (Phase 7, Task 42-S4)
 * ----------------------------------------------------------------------------
 * Typed tool layer for the agent runtime. It WRAPS the existing allowlisted
 * registry (src/lib/tools/registry.ts) — it does not re-implement tools — and
 * enforces the agent-specific HARD RULE:
 *
 *   · Only the 9 READ-ONLY observation tools below may ever run inside an
 *     agent run. No order/execution/mutation tool exists (the product is
 *     signal-only; the execution module was deleted in Phase 0).
 *   · run_risk_check is deliberately EXCLUDED from the agent: it writes
 *     RiskCheck audit rows, and agent runs must stay pure reads.
 *   · Every call is bounded (timeout) and retried with bounded exponential
 *     backoff; the attempt count is returned so the orchestrator can persist
 *     honest budget accounting.
 *
 * The tool map is injectable so integration tests can supply a FAKE
 * deterministic tool environment (no live bridge, no GLM, no network).
 */

import { TOOL_REGISTRY, executeTool } from '@/lib/tools/registry';

// ---------------------------------------------------------------------------
// Allowlist — the ONLY tools an agent run may invoke
// ---------------------------------------------------------------------------

export const AGENT_TOOL_ALLOWLIST = [
  'get_system_health',
  'get_market_health',
  'get_latest_quote',
  'get_candle_coverage',
  'get_latest_analysis',
  'get_latest_signal',
  'get_backtest_summary',
  'explain_signal_evidence',
  'get_ai_review',
] as const;

export type AgentToolName = (typeof AGENT_TOOL_ALLOWLIST)[number];

/** Bounded execution parameters (architectural contract). */
export const AGENT_TOOL_TIMEOUT_MS = 8_000;
export const AGENT_TOOL_MAX_RETRIES = 2;
export const RETRY_BACKOFF_BASE_MS = 200; // wait = base * 2^n (200ms, 400ms, ...)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentToolExecuteResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema reused verbatim from the registry. */
  inputSchema: Record<string, unknown>;
  timeoutMs: number;
  maxRetries: number;
  execute(args: Record<string, unknown>): Promise<AgentToolExecuteResult>;
}

export type AgentToolMap = ReadonlyMap<string, AgentTool>;

export interface AgentToolRunOutcome {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  /** Actual execute() invocations performed (1 .. maxRetries + 1). */
  attempts: number;
  /** attempts - 1 — persisted on the AgentStep row. */
  retries: number;
  durationMs: number;
  /** True when an attempt was REFUSED by the budget hook (not a tool failure). */
  budgetExhausted?: boolean;
}

/**
 * Budget hook — invoked before EVERY attempt (including the first). Returning
 * `allowed: false` stops execution immediately with the given reason; the
 * orchestrator uses this to enforce hard tool-call / wall-clock budgets
 * across retries (a retry storm can never outlive the run budget).
 */
export interface AgentToolBudgetHook {
  allowAttempt: (nextAttemptNumber: number) => { allowed: boolean; reason?: string };
}

// ---------------------------------------------------------------------------
// Digests — REDACTED persistence (never raw args / never secrets)
// ---------------------------------------------------------------------------

/** Argument digest: KEY NAMES ONLY — values are never persisted. */
export function toolArgsDigest(args: Record<string, unknown>): string {
  return JSON.stringify({ keys: Object.keys(args).sort() });
}

/** Result digest: first 400 chars of the bounded serialized result. */
export function toolResultDigest(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  try {
    return JSON.stringify(data).slice(0, 400);
  } catch {
    return '(unserializable result)';
  }
}

// ---------------------------------------------------------------------------
// Default tool map — wraps the existing registry
// ---------------------------------------------------------------------------

export function defaultAgentTools(): AgentToolMap {
  const map = new Map<string, AgentTool>();
  const byName = new Map(TOOL_REGISTRY.map((t) => [t.name, t]));
  for (const name of AGENT_TOOL_ALLOWLIST) {
    const reg = byName.get(name);
    if (!reg || reg.status !== 'active') continue; // honest absence — step fails, never fabricates
    map.set(name, {
      name: reg.name,
      description: reg.description,
      inputSchema: reg.parameters,
      timeoutMs: AGENT_TOOL_TIMEOUT_MS,
      maxRetries: AGENT_TOOL_MAX_RETRIES,
      execute: async (args) => {
        const res = await executeTool(reg.name, args);
        if (res.ok) return { ok: true, data: res.result };
        return { ok: false, error: res.error ?? `${reg.name} failed` };
      },
    });
  }
  assertNoExecutionTools(map);
  return map;
}

// ---------------------------------------------------------------------------
// Safety invariant — no order/execution tool may exist in an agent tool map
// ---------------------------------------------------------------------------

const EXECUTION_TOOL_NAME_PATTERN = /(order|trade|position|execute|execution|deal|approve)/i;

/** True when a tool NAME smells like order/execution capability. */
export function looksLikeExecutionToolName(name: string): boolean {
  return EXECUTION_TOOL_NAME_PATTERN.test(name);
}

/**
 * Throws when a tool map contains anything that smells like order/execution
 * capability. The signal-only product contract is enforced HERE, at the tool
 * boundary — not by prompt.
 */
export function assertNoExecutionTools(map: AgentToolMap): void {
  for (const name of map.keys()) {
    if (looksLikeExecutionToolName(name)) {
      throw new Error(`agent tool allowlist violated: '${name}' looks like an execution tool`);
    }
  }
  if (map.has('run_risk_check')) {
    // Not an execution tool, but excluded by contract: it writes audit rows
    // (agent runs are pure reads).
    throw new Error("agent tool allowlist violated: 'run_risk_check' must stay excluded from agent runs");
  }
}

// ---------------------------------------------------------------------------
// Bounded execution — timeout + bounded retries with exponential backoff
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one agent tool with the full bounded-retry policy:
 *   · up to `tool.maxRetries` retries (maxRetries + 1 attempts total),
 *   · exponential backoff RETRY_BACKOFF_BASE_MS * 2^n between attempts,
 *   · each attempt capped at `tool.timeoutMs`,
 *   · every attempt must first pass the (optional) budget hook.
 * NEVER throws — failures are returned honestly. Stuck detection: a tool that
 * still fails after maxRetries retries reports ok:false and the orchestrator
 * terminates the run (it can never loop forever here).
 */
export async function executeAgentTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  budget?: AgentToolBudgetHook,
): Promise<AgentToolRunOutcome> {
  const startedAt = Date.now();
  const maxAttempts = 1 + Math.max(0, tool.maxRetries);
  let lastError = 'unknown tool error';
  let attempts = 0;

  while (attempts < maxAttempts) {
    // Hard budget gate BEFORE every attempt (first one included).
    if (budget) {
      const gate = budget.allowAttempt(attempts + 1);
      if (!gate.allowed) {
        return {
          ok: false,
          error: gate.reason ?? 'BUDGET_EXCEEDED: attempt refused by run budget',
          attempts,
          retries: Math.max(0, attempts - 1),
          durationMs: Date.now() - startedAt,
          budgetExhausted: true,
        };
      }
    }
    attempts += 1;
    try {
      const res = await withTimeout(tool.execute(args), tool.timeoutMs, `tool ${tool.name}`);
      if (res.ok) {
        return {
          ok: true,
          data: res.data,
          attempts,
          retries: attempts - 1,
          durationMs: Date.now() - startedAt,
        };
      }
      lastError = res.error ?? `${tool.name} failed`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    // Bounded exponential backoff before the next attempt (none after the last).
    if (attempts < maxAttempts) {
      await sleep(RETRY_BACKOFF_BASE_MS * 2 ** (attempts - 1));
    }
  }

  return {
    ok: false,
    error: `${tool.name} failed after ${attempts} attempt(s): ${lastError}`,
    attempts,
    retries: attempts - 1,
    durationMs: Date.now() - startedAt,
  };
}
