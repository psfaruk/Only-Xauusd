/**
 * XAUUSD AI Trading Agent — Application Configuration (Phase 1)
 * ----------------------------------------------------------------------------
 * Single source of truth for runtime configuration. Reads environment
 * variables, applies trading-safety gates, and exposes a JSON-safe snapshot
 * for API responses. Never logs or exposes secret values.
 */

const VERSION = '0.1.0-phase3';

function csv(name: string, fallback: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback.split(',').map((s) => s.trim()).filter(Boolean);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

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
    url: (process.env.MT5_BRIDGE_URL ?? '').replace(/\/+$/, ''),
    timeoutMs: num('MT5_BRIDGE_TIMEOUT_MS', 8_000),
    maxRetries: Math.min(Math.max(0, num('MT5_BRIDGE_MAX_RETRIES', 2)), 5),
    // Token presence flag only — the value never leaves the server.
    hasToken: Boolean(process.env.MT5_BRIDGE_TOKEN),
  },
  market: {
    /** Strict symbol allowlist — anything else is rejected (SYMBOL_NOT_ALLOWED). */
    symbols: csv('MARKET_SYMBOLS', 'XAUUSDm'),
    /** Strict timeframe allowlist (subset of M5/M15/H1/H4). */
    timeframes: (() => {
      const all = ['M5', 'M15', 'H1', 'H4'] as const;
      const requested = csv('MARKET_TIMEFRAMES', 'M5,M15,H1,H4');
      const valid = requested.filter((tf): tf is (typeof all)[number] =>
        (all as readonly string[]).includes(tf),
      );
      return valid.length > 0 ? valid : [...all];
    })(),
    /** Per-timeframe staleness thresholds (seconds) — configurable per tf. */
    staleTickSec: num('MARKET_STALE_TICK_SEC', 120),
    staleTfSec: {
      M5: num('MARKET_STALE_M5_SEC', 3 * 300),
      M15: num('MARKET_STALE_M15_SEC', 3 * 900),
      H1: num('MARKET_STALE_H1_SEC', 3 * 3_600),
      H4: num('MARKET_STALE_H4_SEC', 3 * 14_400),
    },
    /** Bounded fetch limits. */
    maxCandlesPerRequest: Math.min(Math.max(50, num('MARKET_MAX_CANDLES_PER_REQUEST', 500)), 1_000),
    backfillMaxBars: Math.min(Math.max(100, num('MARKET_BACKFILL_MAX_BARS', 5_000)), 20_000),
    backfillMaxDays: Math.min(Math.max(1, num('MARKET_BACKFILL_MAX_DAYS', 30)), 365),
    /** Demo-source ingestion opt-in (default: skip and record SOURCE_DEMO). */
    ingestDemo: bool('MARKET_INGEST_DEMO', false),
    /** Scheduled sync interval; 0 = OFF (default). */
    syncIntervalMs: Math.max(0, num('MARKET_SYNC_INTERVAL_MS', 0)),
    maxIssuesPerRun: Math.min(Math.max(5, num('MARKET_MAX_ISSUES_PER_RUN', 50)), 200),
  },
  dataApi: {
    /** Optional bearer token — when set, ALL /api/data/* require it. */
    hasToken: Boolean(process.env.DATA_API_TOKEN),
    rateLimitPerMin: Math.min(Math.max(10, num('DATA_API_RATE_LIMIT_PER_MIN', 120)), 600),
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
    bridge: {
      configured: config.bridge.url !== '',
      timeoutMs: config.bridge.timeoutMs,
      maxRetries: config.bridge.maxRetries,
    },
    market: {
      symbols: config.market.symbols,
      timeframes: config.market.timeframes,
      staleTickSec: config.market.staleTickSec,
      staleTfSec: config.market.staleTfSec,
      ingestDemo: config.market.ingestDemo,
      syncIntervalMs: config.market.syncIntervalMs,
      maxCandlesPerRequest: config.market.maxCandlesPerRequest,
      backfillMaxBars: config.market.backfillMaxBars,
      backfillMaxDays: config.market.backfillMaxDays,
    },
    dataApi: { tokenProtected: config.dataApi.hasToken, rateLimitPerMin: config.dataApi.rateLimitPerMin },
    limits: { maxEventsReturned: config.limits.maxEventsReturned },
  };
}
