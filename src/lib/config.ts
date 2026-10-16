/**
 * XAUUSD AI Trading Agent — Application Configuration (Phase 1)
 * ----------------------------------------------------------------------------
 * Single source of truth for runtime configuration. Reads environment
 * variables, applies trading-safety gates, and exposes a JSON-safe snapshot
 * for API responses. Never logs or exposes secret values.
 */

const VERSION = '0.2.0-phase9';

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

function clampNum(name: string, fallback: number, min: number, max: number): number {
  const v = num(name, fallback);
  return Math.min(Math.max(v, min), max);
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
    // Individual switch states (read-only exposure for audit honesty).
    switches: {
      phaseGatePassed,
      executionArmed,
      allowExecution,
      tradingMode,
    },
    // Human-readable reason — surfaced in UI, logs and health checks.
    reason: executionEnabled
      ? 'Execution enabled (phase gate passed).'
      : phaseGatePassed
        ? 'Execution locked: arm switches (EXECUTION_ARMED / ALLOW_EXECUTION) are off.'
        : `Execution locked: Phase ${phase} is read-only by design (Phase 11 gate required).`,
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
    /** Intended broker server identity (used ONLY for identity verification
     *  in the environment audit — never a secret, never a connection param). */
    expectedServer: str('MT5_SERVER', 'Exness-MT5Trial6'),
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
    /** Optional bearer token — when set, ALL /api/data/* and /api/analysis/*
     * requests require it. WRITE/TRIGGER endpoints (POST) require it ALWAYS
     * (unless the explicit MARKET_API_PUBLIC_TRIGGERS preview opt-in is set —
     * see publicTriggers below). */
    hasToken: Boolean(process.env.DATA_API_TOKEN),
    /** Explicit, opt-in public reads for GET endpoints when DATA_API_TOKEN is
     * unset (default: false = fail closed). Intended for preview/dashboards
     * only — NEVER enable in production (see README §Security). */
    publicReads: bool('MARKET_API_PUBLIC_READS', false),
    /** Explicit, opt-in public TRIGGERS for POST endpoints when DATA_API_TOKEN
     * is unset (default: false = fail closed). Preview/dashboards only — the
     * guarded operations are read-only w.r.t. the broker (sync + deterministic
     * analysis + research signal evaluation; no order code exists), and the
     * tight trigger rate-limit bucket still applies. NEVER enable in
     * production (see README §Security). */
    publicTriggers: bool('MARKET_API_PUBLIC_TRIGGERS', false),
    rateLimitPerMin: Math.min(Math.max(10, num('DATA_API_RATE_LIMIT_PER_MIN', 120)), 600),
  },
  analysis: {
    /** Closed candles loaded per timeframe for one analysis run (bounded). */
    maxBarsPerTf: Math.min(Math.max(60, num('ANALYSIS_MAX_BARS_PER_TF', 300)), 1_000),
    /** Minimum closed candles per timeframe — must cover the longest warm-up
     * (EMA200 seed at index 199, ADX first value at index 27, swing windows).
     * Default 220 = EMA200 warm-up + working room. */
    minBarsPerTf: Math.min(Math.max(60, num('ANALYSIS_MIN_BARS_PER_TF', 220)), 1_000),
    /** Swing detection window: bars required left/right of a candidate. */
    swingLeft: Math.min(Math.max(2, num('ANALYSIS_SWING_LEFT', 3)), 8),
    swingRight: Math.min(Math.max(2, num('ANALYSIS_SWING_RIGHT', 3)), 8),
  },
  signal: {
    /** Deterministic strategy thresholds — documented in src/lib/signal/rules.ts
     *  and persisted with every evaluation. The LLM can NEVER change these. */
    executionTf: 'M15' as const,
    contextTfs: ['H1', 'H4'] as const,
    /** Max M15 bars between the confirmed structure break and the decision bar. */
    maxBarsSinceBreak: Math.min(Math.max(2, num('SIGNAL_MAX_BARS_SINCE_BREAK', 8)), 20),
    /** Entry zone width above/below the broken level, in ATR multiples. */
    zoneWidthAtr: clampNum('SIGNAL_ZONE_WIDTH_ATR', 0.5, 0.1, 2),
    /** Entry-zone proximity tolerance for the live price, in ATR multiples. */
    entryToleranceAtr: clampNum('SIGNAL_ENTRY_TOLERANCE_ATR', 0.25, 0.05, 1),
    /** Stop-loss buffer beyond the anchor swing, in ATR multiples. */
    slAtrBuffer: clampNum('SIGNAL_SL_ATR_BUFFER', 0.5, 0.1, 2),
    /** Fixed reward/risk multiple defining the target. */
    rewardRisk: clampNum('SIGNAL_REWARD_RISK', 2.0, 0.5, 5),
    /** Minimum ADX(14) on the execution TF (trend strength floor). */
    minAdx: clampNum('SIGNAL_MIN_ADX', 15, 0, 50),
    /** RSI(14) acceptance band for BUY (mirror band is used for SELL). */
    rsiBuyMin: clampNum('SIGNAL_RSI_BUY_MIN', 40, 0, 100),
    rsiBuyMax: clampNum('SIGNAL_RSI_BUY_MAX', 75, 0, 100),
    /** Maximum accepted spread in PRICE units (observed XAUUSDm ≈ 0.24). */
    maxSpreadPrice: clampNum('SIGNAL_MAX_SPREAD', 0.6, 0.1, 5),
    /** Setup expiry, in execution-TF bars after the decision candle. */
    expiryBars: Math.min(Math.max(2, num('SIGNAL_EXPIRY_BARS', 12)), 48),
    /** Minimum closed H4 candles required for higher-timeframe context. */
    minH4Bars: Math.min(Math.max(60, num('SIGNAL_MIN_H4_BARS', 200)), 1_000),
    /** Minimum closed H1 candles required for higher-timeframe context. */
    minH1Bars: Math.min(Math.max(60, num('SIGNAL_MIN_H1_BARS', 220)), 1_000),
  },
  chat: {
    /** Bengali Chat Agent bounds (Task D). */
    maxMessageChars: Math.min(Math.max(50, num('CHAT_MAX_MESSAGE_CHARS', 2_000)), 4_000),
    maxHistoryTurns: Math.min(Math.max(2, num('CHAT_MAX_HISTORY_TURNS', 10)), 20),
    maxToolRounds: Math.min(Math.max(1, num('CHAT_MAX_TOOL_ROUNDS', 3)), 5),
    /** Stricter per-IP rate limit for the (costlier) chat endpoint. */
    rateLimitPerMin: Math.min(Math.max(3, num('CHAT_RATE_LIMIT_PER_MIN', 12)), 60),
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
    dataApi: {
      tokenProtected: config.dataApi.hasToken,
      publicReads: config.dataApi.publicReads,
      publicTriggers: config.dataApi.publicTriggers,
      rateLimitPerMin: config.dataApi.rateLimitPerMin,
    },
    limits: { maxEventsReturned: config.limits.maxEventsReturned },
  };
}
