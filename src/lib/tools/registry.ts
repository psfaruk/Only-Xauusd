/**
 * XAUUSD AI Trading Agent — Allowlisted Tool Registry (Phase 1)
 * ----------------------------------------------------------------------------
 * THE security boundary between the GLM model and the backend.
 *
 * Rules (enforced in code, not by prompt):
 *  1. The model can only call tools whose `name` exists in this registry.
 *  2. Arguments are validated against each tool's JSON schema before execution.
 *  3. `status: 'planned'` tools are architecturally declared but REFUSED at
 *     runtime until their phase is implemented — the model cannot invoke them.
 *  4. There is no shell access, no raw SQL, no network tool. Only these
 *     typed functions.
 */

import { collectHealth } from '@/lib/health';
import { config } from '@/lib/config';

export type ToolStatus = 'active' | 'planned';

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (OpenAI function-calling style). */
  parameters: Record<string, unknown>;
  status: ToolStatus;
  activatesInPhase: number;
  handler?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Active tools (Phase 1)
// ---------------------------------------------------------------------------

const getSystemHealth: ToolDefinition = {
  name: 'get_system_health',
  description:
    'Live system health of the XAUUSD Trading Agent backend: status, phase, DB state, uptime, memory, execution lock flag and latest GLM verification.',
  parameters: { type: 'object', properties: {}, required: [] },
  status: 'active',
  activatesInPhase: 1,
  handler: async () => {
    const h = await collectHealth();
    return {
      status: h.status,
      phase: h.phase,
      tradingMode: h.tradingMode,
      executionLocked: h.executionLocked,
      uptimeSeconds: h.uptimeSeconds,
      database: h.checks.database,
      glm: h.glm.status,
      runtime: h.runtime,
    };
  },
};

// ---------------------------------------------------------------------------
// Planned tools — declared for architecture transparency, refused at runtime.
// ---------------------------------------------------------------------------

const planned = (
  name: string,
  description: string,
  activatesInPhase: number,
  parameters: Record<string, unknown> = { type: 'object', properties: {}, required: [] },
): ToolDefinition => ({
  name,
  description,
  parameters,
  status: 'planned',
  activatesInPhase,
});

const plannedTools: ToolDefinition[] = [
  planned(
    'get_market_snapshot',
    'Live bid/ask/spread for the configured symbol from the MT5 bridge (Phase 2).',
    2,
    {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
  ),
  planned(
    'get_candles',
    'Historical OHLC candles for a symbol and timeframe (Phase 2).',
    2,
    {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        timeframe: { type: 'string', enum: ['M5', 'M15', 'H1', 'H4'] },
        limit: { type: 'number', minimum: 1, maximum: 1000 },
      },
      required: ['symbol', 'timeframe', 'limit'],
    },
  ),
  planned('calculate_indicators', 'Deterministic EMA/RSI/ATR/ADX computation (Phase 4).', 4, {
    type: 'object',
    properties: {
      symbol: { type: 'string' },
      timeframe: { type: 'string', enum: ['M5', 'M15', 'H1', 'H4'] },
    },
    required: ['symbol', 'timeframe'],
  }),
  planned('analyze_market_structure', 'Swing highs/lows, BOS/CHoCH, S/R zones (Phase 4).', 4, {
    type: 'object',
    properties: { symbol: { type: 'string' } },
    required: ['symbol'],
  }),
  planned('build_trade_setup', 'Deterministic entry/SL/TP setup builder (Phase 5).', 5, {
    type: 'object',
    properties: { symbol: { type: 'string' } },
    required: ['symbol'],
  }),
  planned('validate_trade_setup', 'Re-validates a setup against current prices (Phase 5).', 5, {
    type: 'object',
    properties: { setupId: { type: 'string' } },
    required: ['setupId'],
  }),
  planned('run_risk_check', 'Deterministic risk gate: lot size, exposure, limits (Phase 7).', 7, {
    type: 'object',
    properties: { setupId: { type: 'string' } },
    required: ['setupId'],
  }),
  planned('get_signal_history', 'Past signals with outcomes (Phase 5).', 5, {
    type: 'object',
    properties: { symbol: { type: 'string' }, limit: { type: 'number' } },
    required: ['symbol'],
  }),
];

export const TOOL_REGISTRY: ToolDefinition[] = [getSystemHealth, ...plannedTools];

const byName = new Map(TOOL_REGISTRY.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Argument validation — minimal JSON-Schema subset check (type + required).
// ---------------------------------------------------------------------------

function validateArgs(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (schema.type !== 'object') return { ok: false, error: 'tool schema must be object' };
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const required = (schema.required ?? []) as string[];

  for (const key of Object.keys(args)) {
    if (!(key in props)) return { ok: false, error: `unknown argument: ${key}` };
  }
  for (const key of required) {
    if (args[key] === undefined) return { ok: false, error: `missing required argument: ${key}` };
  }
  for (const [key, val] of Object.entries(args)) {
    const expected = props[key]?.type;
    if (!expected) continue;
    const actual = Array.isArray(val) ? 'array' : typeof val;
    if (expected === 'integer' && !Number.isInteger(val)) {
      return { ok: false, error: `argument ${key} must be an integer` };
    }
    if (['string', 'number', 'boolean', 'object', 'array'].includes(expected) && actual !== expected) {
      return { ok: false, error: `argument ${key} must be of type ${expected} (got ${actual})` };
    }
  }
  return { ok: true, value: args };
}

export interface ToolExecutionResult {
  ok: boolean;
  tool?: string;
  result?: Record<string, unknown>;
  error?: string;
}

/** The ONLY entry point the GLM layer may use to run a tool. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const tool = byName.get(name);
  if (!tool) {
    return { ok: false, error: `tool not in allowlist: ${name}` };
  }
  if (tool.status !== 'active' || !tool.handler) {
    return {
      ok: false,
      error: `tool ${name} is planned for phase ${tool.activatesInPhase} and is not executable yet`,
    };
  }
  const checked = validateArgs(args, tool.parameters);
  if (!checked.ok) return { ok: false, error: `invalid arguments for ${name}: ${checked.error}` };
  try {
    const result = await tool.handler(args);
    return { ok: true, tool: name, result };
  } catch (err) {
    return { ok: false, error: `tool ${name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** OpenAI-style tool specs for the model context (active tools only, by default). */
export function toolSpecs(includePlanned = false) {
  return TOOL_REGISTRY.filter((t) => includePlanned || t.status === 'active').map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: `${t.description} [${t.status === 'active' ? 'ACTIVE' : `PLANNED phase ${t.activatesInPhase}`} — current phase ${config.phase}]`,
      parameters: t.parameters,
    },
  }));
}
