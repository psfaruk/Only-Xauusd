/**
 * XAUUSD AI Trading Agent — Application Configuration (Phase 1)
 * ----------------------------------------------------------------------------
 * Single source of truth for runtime configuration. Reads environment
 * variables, applies trading-safety gates, and exposes a JSON-safe snapshot
 * for API responses. Never logs or exposes secret values.
 */

const VERSION = '0.1.0-phase1';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

// ---------------------------------------------------------------------------
// Trading safety gate — the single most important rule of Phase 1.
// Order execution can only ever be enabled when ALL conditions hold:
//   phase >= 11  AND  EXECUTION_ARMED  AND  ALLOW_EXECUTION  AND  mode != read_only
// Until then `executionEnabled` is false and every execution path is dead.
// ---------------------------------------------------------------------------

const phase = Math.max(1, Math.floor(num('TRADING_PHASE', 1)));
const requestedMode = str('TRADING_MODE', 'read_only');
const executionArmed = bool('EXECUTION_ARMED', false);
const allowExecution = bool('ALLOW_EXECUTION', false);

const validModes = new Set(['read_only', 'demo', 'live']);
const tradingMode = validModes.has(requestedMode) ? requestedMode : 'read_only';

const phaseGatePassed = phase >= 11;
const executionEnabled =
  phaseGatePassed && executionArmed && allowExecution && tradingMode !== 'read_only';

export const config = {
  version: VERSION,
  phase,
  phaseLabel: `Phase ${phase} of 12`,
  tradingMode,
  execution: {
    enabled: executionEnabled,
    // Human-readable reason — surfaced in UI, logs and health checks.
    reason: executionEnabled
      ? 'Execution enabled (phase gate passed).'
      : phaseGatePassed
        ? 'Execution locked: arm switches (EXECUTION_ARMED / ALLOW_EXECUTION) are off.'
        : 'Execution locked: Phase 1 is read-only by design (Phase 11 gate required).',
  },
  symbol: str('TRADING_SYMBOL', 'XAUUSD'),
  glm: {
    model: str('GLM_MODEL', 'glm-4-plus'),
    timeoutMs: num('GLM_TIMEOUT_MS', 30_000),
    maxRetries: num('GLM_MAX_RETRIES', 2),
    minVerifyIntervalMs: num('GLM_MIN_VERIFY_INTERVAL_MS', 10_000),
  },
  bridge: {
    url: process.env.MT5_BRIDGE_URL ?? '',
    timeoutMs: num('MT5_BRIDGE_TIMEOUT_MS', 8_000),
    // Token presence flag only — the value never leaves the server.
    hasToken: Boolean(process.env.MT5_BRIDGE_TOKEN),
  },
  limits: {
    maxEventsReturned: Math.min(Math.max(1, num('MAX_EVENTS_RETURNED', 100)), 500),
  },
} as const;

export type AppConfig = typeof config;

/**
 * JSON-safe snapshot for API responses. Contains no secrets: the bridge
 * token is reduced to a boolean, and no env values other than the explicitly
 * exposed operational flags are included.
 */
export function configSnapshot() {
  return {
    version: config.version,
    phase: config.phase,
    tradingMode: config.tradingMode,
    executionEnabled: config.execution.enabled,
    executionReason: config.execution.reason,
    symbol: config.symbol,
    glm: { model: config.glm.model, timeoutMs: config.glm.timeoutMs, maxRetries: config.glm.maxRetries },
    bridge: { configured: config.bridge.url !== '', timeoutMs: config.bridge.timeoutMs },
    limits: { maxEventsReturned: config.limits.maxEventsReturned },
  };
}
