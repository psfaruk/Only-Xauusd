/**
 * XAUUSD AI Trading Agent — Agent Run State Machine (Phase 7, Task 42-S4)
 * ----------------------------------------------------------------------------
 * PURE module (no I/O, no DB, no clock). Defines the legal lifecycle of an
 * agent task run:
 *
 *   CREATED → PLANNED → RUNNING → (WAITING_FOR_TOOL ↔ RUNNING)* → VERIFYING
 *           → COMPLETED | FAILED | BLOCKED
 *   CANCELLED reachable from ANY non-terminal state.
 *
 * Honest-exit edges: a run may terminate BLOCKED/FAILED directly from any
 * non-terminal state (unknown task at inception, budget exhaustion mid-run,
 * unexpected exception). A run may NEVER leave a terminal state — that is the
 * anti-fabrication guarantee (a completed/blocked run is immutable).
 *
 * Step states (per AgentStep row): PLANNED → RUNNING → WAITING_FOR_TOOL →
 * DONE | FAILED; SKIPPED for steps never executed after an earlier failure.
 */

export const AGENT_RUN_STATUSES = [
  'CREATED',
  'PLANNED',
  'RUNNING',
  'WAITING_FOR_TOOL',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
]);

/**
 * The complete legal transition matrix. Everything not listed is illegal and
 * is rejected by `canTransition`/`transition`.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  CREATED: ['PLANNED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  PLANNED: ['RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  RUNNING: ['WAITING_FOR_TOOL', 'VERIFYING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  WAITING_FOR_TOOL: ['RUNNING', 'VERIFYING', 'FAILED', 'BLOCKED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: [],
};

export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: AgentRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(from: AgentRunStatus, to: AgentRunStatus): boolean {
  if (!isAgentRunStatus(from) || !isAgentRunStatus(to)) return false;
  if (isTerminal(from)) return false; // terminal states are immutable
  return LEGAL_TRANSITIONS[from].includes(to);
}

export type TransitionResult =
  | { ok: true; from: AgentRunStatus; to: AgentRunStatus }
  | { ok: false; from: AgentRunStatus; to: AgentRunStatus; error: string };

/** Pure transition attempt — the single authority on legality. */
export function transition(from: AgentRunStatus, to: AgentRunStatus): TransitionResult {
  if (!isAgentRunStatus(from)) {
    return { ok: false, from, to, error: `unknown run status: ${String(from)}` };
  }
  if (!isAgentRunStatus(to)) {
    return { ok: false, from, to, error: `unknown run status: ${String(to)}` };
  }
  if (!canTransition(from, to)) {
    return {
      ok: false,
      from,
      to,
      error: isTerminal(from)
        ? `illegal transition: '${from}' is terminal and can never move to '${to}'`
        : `illegal transition: ${from} → ${to}`,
    };
  }
  return { ok: true, from, to };
}

// ---------------------------------------------------------------------------
// Step states
// ---------------------------------------------------------------------------

export const AGENT_STEP_STATES = [
  'PLANNED',
  'RUNNING',
  'WAITING_FOR_TOOL',
  'DONE',
  'FAILED',
  'SKIPPED',
] as const;

export type AgentStepState = (typeof AGENT_STEP_STATES)[number];

export const TERMINAL_STEP_STATES: ReadonlySet<AgentStepState> = new Set([
  'DONE',
  'FAILED',
  'SKIPPED',
]);

export function isAgentStepState(value: unknown): value is AgentStepState {
  return typeof value === 'string' && (AGENT_STEP_STATES as readonly string[]).includes(value);
}
