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
//   phase >= EXECUTION_GATE_PHASE  AND  EXECUTION_ARMED  AND  ALLOW_EXECUTION
//   AND  mode != read_only
// Until then `executionEnabled` is false and every execution path is dead.
// ---------------------------------------------------------------------------

/** The phase at which execution MAY be considered (all four switches must
 * still pass). Exported so the UI/health surface states the SAME gate the
 * lock logic uses (master-audit fix B-D3 — the footer previously hardcoded
 * a different, stale gate number). */
export const EXECUTION_GATE_PHASE = 11;

const phase = Math.max(1, Math.floor(num('TRADING_PHASE', 1)));
const requestedMode = str('TRADING_MODE', 'read_only');
const executionArmed = bool('EXECUTION_ARMED', false);
const allowExecution = bool('ALLOW_EXECUTION', false);
/** Phase 12: AUTO-execution — when true (and the four switches pass), an
 *  actionable signal that passes the risk check is executed IMMEDIATELY
 *  (single attempt) without waiting for a human approval. The risk gate
 *  (lot cap, exposure cap, daily cap, spread) still runs before every order. */
const executionAuto = bool('EXECUTION_AUTO', false);

const validModes = new Set(['read_only', 'demo', 'live']);
const tradingMode = validModes.has(requestedMode) ? requestedMode : 'read_only';

const phaseGatePassed = phase >= EXECUTION_GATE_PHASE;
const executionEnabled =
  phaseGatePassed && executionArmed && allowExecution && tradingMode !== 'read_only';

export const config = {
  version: VERSION,
  phase,
  /** Truthful status label (master-audit fix B-D3). The phase number is a
   * LOCK-GATE value, not roadmap progress — the old "Phase N of 12" framing
   * presented it as a progress bar it never was. */
  phaseLabel: `Phase ${phase} — ${tradingMode === 'read_only' ? 'Read-Only Research' : `${tradingMode} mode`}`,
  executionGatePhase: EXECUTION_GATE_PHASE,
  tradingMode,
  execution: {
    enabled: executionEnabled,
    // Phase 12: auto-execution switch (see above).
    auto: executionEnabled && executionAuto,
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
        : `Execution locked: Phase ${phase} is read-only by design (Phase ${EXECUTION_GATE_PHASE} gate required).`,
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
    /** Strict timeframe allowlist (subset of M1/M5/M15/H1/H4). M1 was added
     *  in the Task 29 sell-miss fix — the bridge always served M1; the app
     *  never asked. Sync/chart/analysis only: the strategy's own TFs
     *  (M15 execution + H1/H4 context) are untouched — signal gates take
     *  their TF list from the rules, never from this allowlist. */
    timeframes: (() => {
      const all = ['M1', 'M5', 'M15', 'H1', 'H4'] as const;
      const requested = csv('MARKET_TIMEFRAMES', 'M1,M5,M15,H1,H4');
      const valid = requested.filter((tf): tf is (typeof all)[number] =>
        (all as readonly string[]).includes(tf),
      );
      return valid.length > 0 ? valid : [...all];
    })(),
    /** Per-timeframe staleness thresholds (seconds) — configurable per tf.
     *  M1 default 420s (NOT 3×duration): the 300s scheduler cadence bounds
     *  honest freshness for a 60s bar — 180s would flap STALE between
     *  5-minute syncs (see audit/sellmiss-root-cause.md §5). */
    staleTickSec: num('MARKET_STALE_TICK_SEC', 120),
    staleTfSec: {
      M1: num('MARKET_STALE_M1_SEC', 420),
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
    /** Phase 12 — the short-timeframe scalper strategy (M1/M5/M15 OR-logic).
     *  All thresholds are clamped; the engine never reads these directly —
     *  buildScalperRules() materializes them into the persisted rules. */
    scalper: {
      /** Master switch for the scalper evaluation loop (scheduler + API). */
      enabled: bool('SCALPER_ENABLED', true),
      /** Closed candles per TF window. */
      windowBars: Math.min(Math.max(60, num('SCALPER_WINDOW_BARS', 240)), 1_000),
      /** Minimum closed bars per TF (EMA21+RSI14+ATR14 warm-up + context). */
      minBarsPerTf: Math.min(Math.max(30, num('SCALPER_MIN_BARS', 60)), 1_000),
      emaFastPeriod: Math.min(Math.max(3, num('SCALPER_EMA_FAST', 9)), 50),
      emaSlowPeriod: Math.min(Math.max(5, num('SCALPER_EMA_SLOW', 21)), 100),
      rsiPeriod: Math.min(Math.max(5, num('SCALPER_RSI_PERIOD', 14)), 50),
      atrPeriod: Math.min(Math.max(5, num('SCALPER_ATR_PERIOD', 14)), 50),
      /** Momentum RSI band (BUY side; SELL mirrors around 50). */
      momentumRsiMin: clampNum('SCALPER_MOMENTUM_RSI_MIN', 52, 40, 70),
      momentumRsiMax: clampNum('SCALPER_MOMENTUM_RSI_MAX', 78, 60, 95),
      /** Reversal RSI extremes. */
      reversalRsiOversold: clampNum('SCALPER_REVERSAL_RSI_OVERSOLD', 32, 10, 45),
      reversalRsiOverbought: clampNum('SCALPER_REVERSAL_RSI_OVERBOUGHT', 68, 55, 90),
      /** SL distance in ATR multiples beyond the decision close. Task 37:
       *  1.2 → 1.5 — gold's M1/M5 noise (spread + micro-wick) regularly
       *  exceeded the old stop; the wider floor survives the noise that
       *  farmed the SL hits (the position manager banks the move instead). */
      slAtrMult: clampNum('SCALPER_SL_ATR_MULT', 1.5, 0.3, 5),
      /** Fixed reward/risk multiple. Task 37: 1.5 → 1.2 — a reachable first
       *  target (the old 1.5R TP rarely filled before a retrace); the trail
       *  (position manager, arms 1.5R) captures anything beyond it. */
      rewardRisk: clampNum('SCALPER_REWARD_RISK', 1.2, 0.5, 5),
      /** Max accepted spread (price units). */
      maxSpreadPrice: clampNum('SCALPER_MAX_SPREAD', 0.6, 0.1, 5),
      /** Minimum SL distance (price units) — below this the setup is skipped. */
      minStopPrice: clampNum('SCALPER_MIN_STOP', 0.5, 0.1, 10),
      /** Emission cooldown in SECONDS (target cadence 5–7 setups/hour). */
      cooldownSec: Math.min(Math.max(60, num('SCALPER_COOLDOWN_SEC', 480)), 3_600),
      /** Setup expiry per source TF, seconds after the decision close. */
      expirySecM1: Math.min(Math.max(300, num('SCALPER_EXPIRY_M1_SEC', 1_800)), 14_400),
      expirySecM5: Math.min(Math.max(300, num('SCALPER_EXPIRY_M5_SEC', 3_600)), 28_800),
      expirySecM15: Math.min(Math.max(600, num('SCALPER_EXPIRY_M15_SEC', 7_200)), 43_200),
      /** ── Task 36 — higher-timeframe trend intelligence (reverse vs continue).
       *  Empirical driver (2025-10-21): three consecutive auto-trades fought a
       *  ~10-point H1 uptrend (SELL@4114.4 → SL, BUY@4119.9 late, BUY@4122.7
       *  top) because M1/M5 judged in isolation. The HTF gate vetoes signals
       *  that stand against an aligned H1+H4 trend UNLESS the SMC confluence
       *  is tier A (a sweep+BOS-confirmed genuine reversal). */
      htfEnabled: bool('SCALPER_HTF_ENABLED', true),
      /** EMA periods for the H1/H4 trend read. */
      htfEmaFastPeriod: Math.min(Math.max(5, num('SCALPER_HTF_EMA_FAST', 20)), 100),
      htfEmaSlowPeriod: Math.min(Math.max(10, num('SCALPER_HTF_EMA_SLOW', 50)), 200),
      /** Minimum closed H1/H4 bars for a trend read (below → trend null, no veto). */
      htfMinBars: Math.min(Math.max(60, num('SCALPER_HTF_MIN_BARS', 120)), 1_000),
      /** SMC tier-A counter-trend setups still pass (the "sure reversal" exception). */
      htfCounterTrendMinScore: clampNum('SCALPER_HTF_COUNTER_MIN_SCORE', 75, 55, 100),
      /** ── Task 36 — anti-chase guard: the momentum model additionally needs
       *  the decision close WITHIN this many ATR of the fast EMA (buy the
       *  pullback, never the top of an extended run). 0 disables the guard. */
      maxExtensionAtr: clampNum('SCALPER_MAX_EXTENSION_ATR', 0.6, 0, 5),
      /** ── Task 36 — post-loss circuit breaker (seconds). A realized loss on
       *  one of OUR positions pauses NEW auto-executions for this long; the
       *  scalper service reports SCALPER_POST_LOSS_COOLDOWN honestly. 0 = off. */
      postLossCooldownSec: Math.min(Math.max(0, num('SCALPER_POST_LOSS_COOLDOWN_SEC', 900)), 7_200),
      /** Task 38 (backtest-driven): momentum reflex kill-switch. The 34h
       *  replay showed M1/M5 micro-trend momentum as the biggest bleeder
       *  (33% win, −8.64R); reversal+SMC carried the book. */
      momentumEnabled: bool('SCALPER_MOMENTUM_ENABLED', true),
      /** Task 38: restrict momentum to ONE source TF (M15 | M5 | M1 | ''). */
      momentumSourceTfOnly: (() => {
        const v = str('SCALPER_MOMENTUM_SOURCE_TF', '');
        return v === 'M15' || v === 'M5' || v === 'M1' ? v : null;
      })(),
    },
    /** Phase 14 — the ICT/SMC ten-agent confluence engine layered onto the
     *  scalper (SMC_CONFLUENCE model). Pure agents never read config directly;
     *  buildScalperRules() materializes these into the persisted rules. */
    smc: {
      /** Master switch for the SMC confluence model (fallback: legacy
       *  momentum/reversal models still judge when off). */
      enabled: bool('SMC_ENABLED', true),
      /** Task 37 structure gate for the legacy reflexes (default ON). */
      legacyGate: bool('SMC_LEGACY_GATE', true),
      /** Swing window (left/right closed bars) for structure/liquidity. */
      swingLeft: Math.min(Math.max(2, num('SMC_SWING_LEFT', 3)), 8),
      swingRight: Math.min(Math.max(2, num('SMC_SWING_RIGHT', 3)), 8),
      /** Max bars between BOS/CHoCH and the decision bar (full points). */
      maxBarsSinceEvent: Math.min(Math.max(2, num('SMC_MAX_BARS_SINCE_EVENT', 20)), 100),
      /** Lookback bars for liquidity sweep detection. */
      sweepLookbackBars: Math.min(Math.max(5, num('SMC_SWEEP_LOOKBACK', 30)), 200),
      /** Max bars between sweep candle and decision bar (full points). */
      maxBarsSinceSweep: Math.min(Math.max(1, num('SMC_MAX_BARS_SINCE_SWEEP', 8)), 50),
      /** Equal-high/low tolerance in ATR multiples. */
      equalLevelAtrTol: clampNum('SMC_EQUAL_TOL_ATR', 0.25, 0.05, 1.5),
      /** Min displacement (ATR mult) for a valid order block. */
      obMinDisplacementAtr: clampNum('SMC_OB_MIN_DISPLACEMENT_ATR', 1.0, 0.2, 5),
      /** FVG minimum gap in ATR multiples. */
      fvgMinGapAtr: clampNum('SMC_FVG_MIN_GAP_ATR', 0.2, 0.05, 2),
      /** POI entry tolerance beyond the zone edge, in ATR multiples. */
      entryToleranceAtr: clampNum('SMC_ENTRY_TOLERANCE_ATR', 0.35, 0.05, 2),
      /** SL buffer beyond sweep wick / POI extreme, in ATR multiples.
       *  Task 37: 0.35 → 0.5 — a touch more room past the structural anchor
       *  so a retest of the swept level does not take the stop out. */
      slAtrBuffer: clampNum('SMC_SL_ATR_BUFFER', 0.5, 0.05, 2),
      /** Max POI tests before the zone is exhausted. */
      poiMaxTests: Math.min(Math.max(1, num('SMC_POI_MAX_TESTS', 3)), 10),
      /** Displacement candle body threshold (ATR mult). */
      displacementAtr: clampNum('SMC_DISPLACEMENT_ATR', 1.0, 0.3, 3),
      /** AMD range lookback bars. */
      amdLookbackBars: Math.min(Math.max(10, num('SMC_AMD_LOOKBACK', 40)), 200),
      /** Min range height in ATR multiples to call it a range. */
      amdMinRangeAtr: clampNum('SMC_AMD_MIN_RANGE_ATR', 2.0, 0.5, 10),
      /** Emission threshold — minimum confluence score (tier B = 55). */
      minScore: clampNum('SMC_MIN_SCORE', 55, 30, 95),
      /** Required BUY-vs-SELL score margin, else NEUTRAL. */
      directionMargin: clampNum('SMC_DIRECTION_MARGIN', 10, 0, 50),
      /** Round-number grid step for XAUUSD (price units). */
      roundNumberStep: clampNum('SMC_ROUND_STEP', 5, 0.5, 50),
      /** Key-level touch tolerance in ATR multiples. */
      keyLevelTolAtr: clampNum('SMC_KEY_LEVEL_TOL_ATR', 0.3, 0.05, 2),
      /** Session/killzone overrides (UTC minutes). */
      londonKzFromMin: Math.min(Math.max(0, num('SMC_LONDON_KZ_FROM_MIN', 420)), 1_439),
      londonKzToMin: Math.min(Math.max(1, num('SMC_LONDON_KZ_TO_MIN', 600)), 1_440),
      nyKzFromMin: Math.min(Math.max(0, num('SMC_NY_KZ_FROM_MIN', 720)), 1_439),
      nyKzToMin: Math.min(Math.max(1, num('SMC_NY_KZ_TO_MIN', 900)), 1_440),
      /** News blackout master switch (envelopes stay approximate either way). */
      newsBlackoutEnabled: bool('SMC_NEWS_BLACKOUT', true),
    },
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
  positionManager: {
    /** ── Task 36 — software position manager (breakeven + trailing + time
     *  stop). Runs inside the app scheduler; uses ONLY verified bridge paths
     *  (positions probe + market CLOSE) — the broker-side SL/TP always remain
     *  the hard protection. Empirical driver: TPs sat at 1.5R and never
     *  filled while open profit swung +1R → 0 → −1R; the manager banks the
     *  move at a trailing floor instead of round-tripping it. */
    enabled: bool('POSITION_MANAGER_ENABLED', true),
    /** Poll cadence for open positions, seconds (2–60). */
    pollSec: Math.min(Math.max(2, num('POSITION_MANAGER_POLL_SEC', 5)), 60),
    /** Move the software stop to entry + spread once floating profit ≥ this R. */
    breakevenAtR: clampNum('POSITION_BREAKEVEN_AT_R', 1.0, 0.3, 5),
    /** Start trailing once floating profit ≥ this R. */
    trailAtR: clampNum('POSITION_TRAIL_AT_R', 1.5, 0.5, 10),
    /** Trailing distance behind the best favorable price, in M1-ATR multiples. */
    trailAtrMult: clampNum('POSITION_TRAIL_ATR_MULT', 1.0, 0.2, 5),
    /** Time stop: close at market when a position is older than this many
     *  minutes AND floating profit < 0.2 R (a dead trade frees the single
     *  exposure slot). 0 disables. */
    maxAgeMin: Math.min(Math.max(0, num('POSITION_MAX_AGE_MIN', 45)), 480),
    /** Only positions whose broker comment starts with these prefixes are managed. */
    managedCommentPrefixes: (process.env.POSITION_MANAGED_PREFIXES ?? 'xau-agent:,xau-auto:')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
  },
  risk: {
    /** Phase 7 deterministic risk gate (src/lib/risk/engine.ts). All values
     *  are clamped so a misconfigured env can never silently disable a limit.
     *  These are SAFETY limits, not strategy thresholds — the LLM can never
     *  see or change them (deterministic engine config only). */
    /** Percent of equity risked per trade (0.1–5, default 1.0). */
    percentPerTrade: clampNum('RISK_PERCENT_PER_TRADE', 1.0, 0.1, 5),
    /** Hard cap on lot size (0.01–10, default 0.10). */
    maxLots: clampNum('RISK_MAX_LOTS', 0.10, 0.01, 10),
    /** Lot floor — computed lots below this FAIL the gate (default 0.01). */
    minLots: clampNum('RISK_MIN_LOTS', 0.01, 0.001, 10),
    /** Max simultaneous open positions (1–10, default 2). */
    maxOpenPositions: clampNum('RISK_MAX_OPEN_POSITIONS', 2, 1, 10),
    /** Max pending approvals awaiting the user (1–10, default 3). */
    maxPendingApprovals: clampNum('RISK_MAX_PENDING_APPROVALS', 3, 1, 10),
    /** Max approved orders per UTC day (1–50, default 6). */
    maxOrdersPerDay: clampNum('RISK_MAX_ORDERS_PER_DAY', 6, 1, 50),
    /** Max accepted spread in PRICE units — deliberately a SEPARATE env from
     *  SIGNAL_MAX_SPREAD so the risk gate stays independent of strategy
     *  tuning (0.1–5, default 0.6). */
    maxSpreadPrice: clampNum('RISK_MAX_SPREAD_PRICE', 0.6, 0.1, 5),
    /** Minimum account equity (0–100000, default 0 = no floor). */
    minEquity: clampNum('RISK_MIN_EQUITY', 0, 0, 100_000),
    /** Lot granularity for flooring computed size (default 0.01). */
    lotStep: clampNum('RISK_LOT_STEP', 0.01, 0.001, 1),
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
    risk: {
      percentPerTrade: config.risk.percentPerTrade,
      maxLots: config.risk.maxLots,
      minLots: config.risk.minLots,
      maxOpenPositions: config.risk.maxOpenPositions,
      maxPendingApprovals: config.risk.maxPendingApprovals,
      maxOrdersPerDay: config.risk.maxOrdersPerDay,
      maxSpreadPrice: config.risk.maxSpreadPrice,
      minEquity: config.risk.minEquity,
      lotStep: config.risk.lotStep,
    },
    limits: { maxEventsReturned: config.limits.maxEventsReturned },
  };
}
