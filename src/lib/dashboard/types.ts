/**
 * XAUUSD AI Trading Agent — Dashboard API shapes (UI-02 terminal redesign).
 * ----------------------------------------------------------------------------
 * Single source of truth for the frontend's API response contracts. Moved
 * verbatim from the former single-file page.tsx (Phase 1–11 surfaces) plus
 * the UI-02 chart-surface types. These are VIEW types only — every field
 * mirrors what the corresponding /api route actually returns; nothing here
 * is fabricated or defaulted.
 */

// ---------------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------------

export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  phase: number;
  phaseLabel: string;
  /** Phase at which execution MAY be considered (all four switches must pass). */
  executionGatePhase: number;
  tradingMode: string;
  executionLocked: boolean;
  executionReason: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: { database: 'ok' | 'fail'; glm: 'verified' | 'failed' | 'unverified'; executionLock: 'engaged' | 'DANGER' };
  runtime: {
    node: string;
    platform: string;
    cpuCores: number;
    memoryTotalMb: number;
    memoryFreeMb: number;
    processRssMb: number;
  };
  glm: { status: string; lastCheckedAt: string | null };
  auditEventCount: number;
}

export interface EnvCheck {
  id: string;
  group: 'runtime' | 'network' | 'mt5' | 'glm' | 'database';
  label: string;
  evidence: string;
  status: 'pass' | 'warn' | 'fail';
  note?: string;
}

/** Phase 9 — Environment Audit v2 check shape. */
export interface AuditCheckV2 {
  id: string;
  category: string;
  description: string;
  required: boolean;
  expected: string;
  actual: string | null;
  evidenceType: 'STATIC' | 'COMMAND' | 'API_PROBE' | 'LIVE_BROKER' | 'FIXTURE';
  evidenceCommand: string;
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  runtimeIdentity: string | null;
  exitCodeOrHttpStatus: number | null;
  durationMs: number | null;
  evidence: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'BLOCKED' | 'NOT_APPLICABLE' | 'NOT_TESTED';
  reason: string;
  freshnessPolicy: string;
  scope: 'current-required' | 'historical' | 'not-applicable';
  historical?: { phase: number; performedAtUtc: string };
}

export interface AuditResponse {
  ok: boolean;
  model: string;
  generatedAtUtc: string;
  commit: string | null;
  app: { version: string; phase: number; phaseLabel: string; tradingMode: string };
  executionLock: {
    enabled: boolean;
    reason: string;
    switches: { phaseGate: boolean; executionArmed: boolean; allowExecution: boolean; readOnlyMode: boolean };
  };
  checks: AuditCheckV2[];
  totals: {
    currentRequired: { pass: number; warn: number; fail: number; blocked: number; total: number };
    notApplicable: number;
    historical: number;
    notTested: number;
  };
  sections: {
    currentRequired: AuditCheckV2[];
    notApplicable: AuditCheckV2[];
    historical: AuditCheckV2[];
  };
  persistedFacts: {
    lastGlmVerification: { code: string; at: string | null; message: string } | null;
    lastSyncRun: { status: string; at: string | null; source: string | null; inserted: number; updated: number } | null;
    analysisRuns: number;
    backtestRuns: number;
    signalEvaluations: number;
  };
  notes: string[];
  config: {
    version: string;
    phase: number;
    tradingMode: string;
    executionEnabled: boolean;
    executionReason: string;
    symbol: string;
  };
  live: {
    node: string;
    bun: string | null;
    platform: string;
    arch: string;
    cpuCores: number;
    memoryTotalMb: number;
    memoryFreeMb: number;
    uptimeSeconds: number;
    timestamp: string;
  };
  environmentChecks: EnvCheck[];
  glm: {
    sdk: string;
    model: string;
    auth: string;
    verifiedAt: string;
    capabilities: { chatCompletion: boolean; bengali: boolean; toolCalling: boolean; toolCallRoundTripMs: number };
    sample: { prompt: string; response: string };
    liveStatus: { code?: string; at?: string | null; message?: string } | null;
  };
  mt5: {
    currentArchitecture?: { id: string; title: string; detail: string; status: string };
    historicalStudy?: { findings: string[]; supersededBy: string };
    feasibleInSandbox?: boolean;
    findings?: string[];
    bridgeOptions?: { id: string; title: string; detail: string }[];
    phase2Plan?: string[];
  };
  database: {
    provider: string;
    models: { name: string; purpose: string; phase: number; status: string }[];
  };
  tools: { total: number; active: string[]; planned: { name: string; phase: number }[] };
  security: { measure: string; detail: string }[];
  architecture: { id: string; title: string; tech: string; detail: string; phase: string }[];
  repositoryTree: string;
  acceptanceChecklist: { id: string; label: string; done: boolean }[];
  events: { id: string; level: string; category: string; code: string; message: string; createdAt: string }[];
}

// ---------------------------------------------------------------------------
// /api/signal/*
// ---------------------------------------------------------------------------

export interface SignalLevelsView {
  direction: 'BUY' | 'SELL';
  entryZoneLow: number;
  entryZoneHigh: number;
  entryReference: number;
  stopLoss: number;
  target: number;
  riskPrice: number;
  rewardPrice: number;
  rewardRiskRatio: number;
  entryZoneLowText: string;
  entryZoneHighText: string;
  entryReferenceText: string;
  stopLossText: string;
  targetText: string;
}

export interface SignalEvidenceView {
  structureEvent: {
    type: string;
    direction: string;
    level: number;
    levelText: string;
    breakCandleTimeUtc: string;
    barsSinceBreak: number;
  } | null;
  anchorSwing: { kind: string; price: number; priceText: string; swingTimeUtc: string } | null;
  indicators: { ema50: number | null; rsi14: number | null; atr14: number | null; adx14: number | null };
  htfContext: { h1Trend: string | null; h4Trend: string | null };
  decisionClose: number | null;
  retestBarTimeUtc: string | null;
  executionWindow: { fromUtc: string; toUtc: string; bars: number };
  h1Window: { fromUtc: string; toUtc: string; bars: number };
  h4Window: { fromUtc: string; toUtc: string; bars: number };
}

export interface RuleManifestEntryView {
  id: string;
  value: number | string | string[] | null;
  unit: string;
  scope: string;
  source: string;
}

export interface RulesSnapshotView {
  status: 'present' | 'not-recorded' | 'invalid';
  reason?: string;
  snapshot?: {
    rulesSnapshotVersion: number;
    engineVersion: string;
    strategyVersion: string;
    symbol: string;
    rules: RuleManifestEntryView[];
    snapshotHash: string;
  };
}

export interface SignalEvaluationView {
  id: string;
  createdAt: string;
  outcome: 'BUY_SETUP' | 'SELL_SETUP' | 'WAIT' | 'BLOCKED' | 'NO_SETUP' | 'FAILED';
  reasonCodes: string[];
  engineVersion: string;
  strategyVersion: string;
  symbol: string;
  decisionCandleTimeUtc: string | null;
  setupKnownAtUtc: string | null;
  expiryUtc: string | null;
  levels: SignalLevelsView | null;
  evidence: SignalEvidenceView | null;
  inputFingerprint: string;
  datasetFingerprint: string | null;
  setupFingerprint: string | null;
  rulesSnapshot: RulesSnapshotView;
  executionLocked: boolean;
  quote: Record<string, unknown> | null;
}

export interface SignalLatestResponse {
  ok: boolean;
  symbol: string;
  signal: SignalEvaluationView | null;
  conditions: {
    source: 'evaluation' | 'none';
    headlineBn: string;
    category: 'data-quality' | 'strategy-logic' | null;
    checks: Array<{ id: string; labelBn: string; category: 'data-quality' | 'strategy-logic'; passed: boolean | null; detailBn: string | null }>;
  } | null;
  strategyVersions: { activeLive: string; researchCandidate: string; candidateStatus: string } | null;
  backtestComparison: {
    runId: string;
    createdAt: string;
    strategyVersion: string;
    timeframe: string;
    status: string;
    datasetFingerprint: string;
    datasetFromUtc: string;
    datasetToUtc: string;
    candleCount: number;
    dev: Record<string, unknown>;
    oos: Record<string, unknown>;
    limitations: string[];
  } | null;
  notes: string[];
}

export interface SignalHistoryEntryView {
  id: string;
  createdAt: string;
  outcome: string;
  reasonCodes: string[];
  engineVersion: string;
  strategyVersion: string;
  setupFingerprint: string | null;
  rulesSnapshot: RulesSnapshotView;
  executionLocked: boolean;
}

export interface SignalHistoryResponse {
  ok: boolean;
  symbol: string;
  count: number;
  counts: { totalEvaluations: number; distinctSetups: number } | null;
  outcomeCounts: Record<string, number>;
  history: SignalHistoryEntryView[];
}

// ---------------------------------------------------------------------------
// /api/chat + /api/ai/verify
// ---------------------------------------------------------------------------

export interface ChatToolCallView {
  name: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface ChatResponse {
  ok: boolean;
  reply: string;
  toolCalls: ChatToolCallView[];
  evidence: { tool: string; facts: Record<string, unknown> }[];
  dataState: {
    quoteFreshness: string | null;
    quoteSourceClass: string | null;
    bid: string | null;
    ask: string | null;
    quoteTimeUtc: string | null;
    latestSignalOutcome: string | null;
    latestSignalReasonCodes: string[];
  };
  limitations: string[];
  model: string;
  totalDurationMs: number;
  error?: { code: string; detail?: string };
}

/** UI-02 — chat message with error/retry tracking (no fabricated success). */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  meta?: ChatResponse | null;
  /** true when this assistant bubble is an honest failure notice (retryable). */
  isError?: boolean;
}

export interface VerifyTest {
  id: string;
  name: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
  sample?: string;
}

export interface VerifyResponse {
  verified: boolean;
  model: string;
  totalLatencyMs: number;
  checkedAt: string;
  tests: VerifyTest[];
}

// ---------------------------------------------------------------------------
// /api/data/* (Phase 3 / 8 / 10.3-C)
// ---------------------------------------------------------------------------

export type QualityState = 'VALID' | 'WARNING' | 'INVALID' | 'STALE' | 'MISSING' | 'UNAVAILABLE';

export interface TfReadiness {
  timeframe: string;
  state: QualityState;
  lastClosedCandleTimeUtc: string | null;
  lastClosedCandleAgeSeconds: number | null;
  stalenessThresholdSeconds: number;
  scannedCandles: number;
  missingCandles: number;
  possibleClosureGaps: number;
  errorCodes: string[];
}

export interface SyncRunSummary {
  id: string;
  mode: string;
  source: string;
  symbol: string;
  timeframes: string[];
  status: string;
  startedAtUtc: string;
  endedAtUtc: string | null;
  durationMs: number | null;
  requested: number;
  received: number;
  inserted: number;
  updated: number;
  rejected: number;
  duplicates: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface MarketStatusResponse {
  ok: true;
  symbol: string;
  bridge: {
    configured: boolean;
    reachable: boolean;
    probedAtUtc: string;
    health: { ok: boolean; service: string | null; connected: boolean | null; uptimeSec: number | null } | null;
    status: { connected: boolean; source: string; server: string | null; latencyMs: number | null; reason: string | null } | null;
    error: { code: string; message: string } | null;
  };
  readiness: {
    ready: boolean;
    symbol: string;
    timeframesChecked: string[];
    source: string | null;
    checkedAtUtc: string;
    lastTickTimeUtc: string | null;
    lastClosedCandleTimeUtc: string | null;
    dataAgeSeconds: number | null;
    qualityState: QualityState;
    errorCodes: string[];
    tick: {
      state: QualityState;
      bid: string | null;
      ask: string | null;
      spread: string | null;
      lastTickTimeUtc: string | null;
      ageSeconds: number | null;
      stalenessThresholdSeconds: number;
      errorCodes: string[];
    };
    timeframes: TfReadiness[];
  };
  sync: {
    running: boolean;
    lastRun: SyncRunSummary | null;
    lastSuccess: SyncRunSummary | null;
    lastFailure: SyncRunSummary | null;
  };
  config: {
    symbols: string[];
    timeframes: string[];
    staleTickSec: number;
    staleTfSec: Record<string, number>;
    ingestDemo: boolean;
    syncIntervalMs: number;
  };
  generatedAtUtc: string;
}

export interface QualityIssueRow {
  id: string;
  checkType: string;
  timeframe: string | null;
  severity: string;
  errorCode: string;
  targetTimeUtc: string | null;
  details: { detail?: string };
  checkedAtUtc: string;
}

export interface QualityResponse {
  ok: true;
  symbol: string;
  openIssues: QualityIssueRow[];
  generatedAtUtc: string;
}

// ---------------------------------------------------------------------------
// /api/analysis/* (Phase 4)
// ---------------------------------------------------------------------------

export interface AnalysisIndicatorSnapshot {
  period: number;
  warmupBars: number;
  last: { value: number } | null;
}

export interface AnalysisTfView {
  timeframe: string;
  candleCount: number;
  source: string;
  structure: {
    trend: string;
    highLabel: string;
    lowLabel: string;
    confirmedSwings: unknown[];
    events: Array<{
      type: string;
      direction: string;
      level: number;
      levelText: string;
      confirmedAtUtcSec: number;
      basis: string;
      trendAtBreak: string;
    }>;
    unconfirmedCrossings: unknown[];
  };
  indicators: {
    ema20: AnalysisIndicatorSnapshot | null;
    ema50: AnalysisIndicatorSnapshot | null;
    ema200: AnalysisIndicatorSnapshot | null;
    rsi14: AnalysisIndicatorSnapshot | null;
    atr14: AnalysisIndicatorSnapshot | null;
    adx14: AnalysisIndicatorSnapshot | null;
  };
  indicatorIssues: string[];
  warnings: string[];
}

export interface AnalysisResultView {
  status: 'COMPLETED' | 'BLOCKED' | 'FAILED';
  purpose: string;
  engineVersion: string;
  symbol: string;
  generatedAtUtc: string;
  inputFingerprint: string | null;
  reasonCodes: string[];
  warnings: string[];
  calculationConfig: { swingLeft: number; swingRight: number; breakBasis: string; emaPeriods: number[] };
  inputData: {
    perTimeframe: Record<string, { closedCandles: number; formingExcluded: number; lastCandleTimeUtc: string | null }>;
    digits: number | null;
  };
  readiness: Array<{
    timeframe: string;
    state: 'READY' | 'BLOCKED';
    closedCandles: number;
    requiredMinBars: number;
    errorCodes: string[];
    warnings: string[];
  }>;
  perTimeframe?: Record<string, AnalysisTfView>;
  timeframeContext?: { alignment: string; note: string; disclaimer: string; trendByTimeframe?: Record<string, string> };
  failureMessage?: string;
}

export interface AnalysisLatestResponse {
  ok: true;
  latest: {
    id: string;
    symbol: string;
    engineVersion: string;
    status: string;
    timeframes: string[];
    reasonCodes: string[];
    warnings: string[];
    inputFingerprint: string | null;
    generatedAtUtc: string | null;
    startedAtUtc: string;
    completedAtUtc: string | null;
    durationMs: number | null;
    analysis: AnalysisResultView | null;
  } | null;
  generatedAtUtc: string;
}

// ---------------------------------------------------------------------------
// /api/data/health (Phase 8) + /api/data/latest (10.3-C)
// ---------------------------------------------------------------------------

export interface DataHealthResponse {
  ok: boolean;
  symbol: string;
  quote: {
    bridgeReachable: boolean;
    connected: boolean;
    authenticated: boolean;
    server: string | null;
    gateway: string | null;
    sourceClass: 'broker' | 'relay' | 'cache' | 'synthetic' | 'unavailable';
    sourceLabel: string;
    bid: string | null;
    ask: string | null;
    mid: string | null;
    spread: string | null;
    digits: number | null;
    quoteTimeUtc: string | null;
    receivedAtUtc: string | null;
    ageSeconds: number | null;
    stalenessThresholdSeconds: number;
    freshness: 'LIVE' | 'STALE' | 'DEGRADED' | 'DISCONNECTED';
    reconnects: number | null;
    lastError: string | null;
    validationStatus: string;
    signalPermitted: boolean;
    blockedReasons: string[];
  };
  candleHistory: {
    auditedAtUtc: string;
    timeframes: Array<{
      timeframe: string;
      present: boolean;
      source: string | null;
      earliestCandleUtc: string | null;
      latestCandleUtc: string | null;
      closedCount: number;
      formingCount: number;
      duplicateTimestamps: number;
      invalidOhlc: number;
      outOfOrder: number;
      missingOutsideClosure: number;
      closureGaps: number;
      gapRatio: number | null;
      latestClosedAgeSeconds: number | null;
      stalenessThresholdSeconds: number;
      qualityState: string;
      issues: string[];
    }>;
    h4Coverage: { earliestUtc: string | null; latestUtc: string | null; closedCount: number; coverageNote: string };
    notes: string[];
  };
  lastSync: {
    id: string; mode: string; source: string; status: string;
    startedAtUtc: string; endedAtUtc: string | null; durationMs: number | null;
    inserted: number; updated: number; rejected: number; duplicates: number;
    errorCode: string | null;
  } | null;
  executionLock: { enabled: boolean; reason: string; tradingMode: string };
}

export interface DataLatestResponse {
  ok: boolean;
  symbol: string;
  spec: {
    digits: number | null;
    point: string | null;
    tickSize: string | null;
    source: string;
    verifiedFields: string[];
    lastVerifiedAtUtc: string;
  } | null;
}

// ---------------------------------------------------------------------------
// /api/backtest/latest + /api/validation/latest (Phases 9–10)
// ---------------------------------------------------------------------------

export interface BacktestLatestResponse {
  ok: boolean;
  latest: {
    id: string;
    createdAt: string;
    strategyVersion: string;
    symbol: string;
    timeframe: string;
    status: string;
    datasetFingerprint: string;
    dataset: { fromUtc: string; toUtc: string; candleCount: number; source: string; exclusions: string[] };
    dev: Record<string, unknown>;
    oos: Record<string, unknown>;
    tradeCount: number;
    limitations: string[];
    rules: Record<string, unknown>;
  } | null;
  disclaimer: string | null;
}

export interface ValidationSegmentView {
  status: string;
  candles: number;
  fromUtcSec: number | null;
  toUtcSec: number | null;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossPnlPrice: number | null;
  costsPrice: number | null;
  netPnlPrice: number | null;
  profitFactor: number | null;
  expectancyPrice: number | null;
  expectancyR: number | null;
  avgWinPrice: number | null;
  avgLossPrice: number | null;
  maxDrawdownPrice: number | null;
  maxConsecutiveLosses: number;
  exposurePct: number | null;
  tradesPerWeek: number | null;
  concentration: { top1GrossShare: number | null; top3GrossShare: number | null };
  reason?: string;
}

export interface ValidationLatestResponse {
  ok: boolean;
  validation: {
    id: string;
    createdAt: string;
    symbol: string;
    strategyVersion: string;
    harnessVersion: string;
    status: string;
    durationMs: number;
    datasetFingerprint: string;
    dataset: {
      fromUtc: string;
      toUtc: string;
      candleCounts: { M15: number; H1: number; H4: number };
      observedSpread: string;
    };
    result: {
      datasetFingerprint: string;
      dataset: {
        executionCandles: number;
        h1Candles: number;
        h4Candles: number;
        fromUtcSec: number;
        toUtcSec: number;
        observedSpreadPrice: number;
        splitFractions: { dev: number; val: number; oos: number };
      };
      counters: {
        evaluations: number;
        blockedEvaluations: number;
        noSetup: number;
        wait: number;
        candidateSetups: number;
        validSetups: number;
        hypotheticalFills: number;
        completedOutcomes: number;
      };
      segments: { dev: ValidationSegmentView; val: ValidationSegmentView; oos: ValidationSegmentView };
      walkForward: {
        windows: Array<{
          index: number;
          fromUtcSec: number;
          toUtcSec: number;
          candles: number;
          metrics: ValidationSegmentView;
        }>;
        aggregate: ValidationSegmentView;
        note: string;
      };
      sensitivity: Array<{
        scenario: string;
        spreadPrice: number;
        slippagePrice: number;
        commissionPrice: number;
        trades: number;
        netPnlPrice: number;
        profitFactor: number | null;
        netPositive: boolean;
        labels: string[];
      }>;
      perturbations: Array<{
        param: string;
        value: number;
        baselineValue: number;
        trades: number;
        netPnlPrice: number;
        profitFactor: number | null;
      }>;
      warnings: string[];
      limitations: string[];
      interpretation: {
        conclusion: 'INCONCLUSIVE' | 'NEGATIVE_AFTER_COSTS' | 'PROMISING_CONTINUE_FORWARD';
        reasons: string[];
        rulesVersion: string;
      };
    };
    limitations: string[];
    paper: {
      total: number;
      open: number;
      resolved: { stopped: number; targeted: number; invalidated: number; expired: number };
      resolvedWithPnl: number;
      wins: number;
      losses: number;
      netPnlPrice: number | null;
      sumR: number | null;
      avgR: number | null;
      outcomes: Array<{
        id: string;
        direction: string;
        signalCreatedAtUtc: string;
        expiryUtc: string;
        status: string;
        outcome: string | null;
        entryReference: number;
        stopLoss: number;
        target: number;
        exitPrice: number | null;
        observations: number;
        netPnlPrice: number | null;
        rMultiple: number | null;
      }>;
    };
    forwardPaper: {
      protocol: {
        version: string;
        rulesVersion: string;
        activatedAtUtc: string;
        deadlineUtc: string;
        minCompletedTrades: number;
        observationWindowDays: number;
      };
      progress: {
        countedCompleted: number;
        openCounted: number;
        repeatObservations: number;
        unobservableResolved: number;
        eligibleRows: number;
        elapsedDays: number;
        daysRemaining: number;
      };
      statusCounts: {
        open: number;
        stopped: number;
        targeted: number;
        invalidated: number;
        expired: number;
        expiredUnobservable: number;
      };
      metrics: null | {
        trades: number;
        wins: number;
        losses: number;
        winRate: number | null;
        netPnlPrice: number;
        profitFactor: number | null;
        sumR: number;
        avgR: number | null;
        maxDrawdownR: number;
        maxConsecutiveLosses: number;
        top1NetShare: number | null;
        byDirection: {
          BUY: { trades: number; wins: number; netPnlPrice: number };
          SELL: { trades: number; wins: number; netPnlPrice: number };
        };
      };
      verdict: {
        conclusion: string;
        reasons: string[];
        rulesVersion: string;
        disclaimer: string;
      };
      recentTrades: Array<{
        id: string;
        direction: string;
        signalCreatedAtUtc: string;
        status: string;
        outcome: string | null;
        entryReference: number;
        exitPrice: number | null;
        netPnlPrice: number | null;
        rMultiple: number | null;
        resolvedAtUtc: string | null;
      }>;
    };
    disclaimer: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// UI-02 — /api/data/chart (chart workspace surface)
// ---------------------------------------------------------------------------

/** One real OHLC candle. `forming` flags the live, still-open bar (never analysed). */
export interface ChartCandlePoint {
  t: number; // UTC seconds (candle open)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
  forming: boolean;
}

export interface ChartEmaPoint {
  t: number;
  v: number;
}

export interface ChartSwingMarker {
  kind: 'high' | 'low';
  price: number;
  timeUtcSec: number;
  confirmedAtUtcSec: number;
}

export interface ChartStructureEvent {
  type: 'BOS' | 'CHoCH';
  direction: 'bullish' | 'bearish';
  level: number;
  levelText: string;
  breakCandleTimeUtcSec: number;
  confirmedAtUtcSec: number;
  trendAtBreak: string;
}

export interface ChartDataResponse {
  ok: true;
  symbol: string;
  timeframe: string;
  digits: number | null;
  source: string | null;
  generatedAtUtc: string;
  candles: ChartCandlePoint[];
  ema: {
    ema20: ChartEmaPoint[] | null;
    ema50: ChartEmaPoint[] | null;
    ema200: ChartEmaPoint[] | null;
  };
  swings: ChartSwingMarker[];
  events: ChartStructureEvent[];
  levels: {
    lastSwingHigh: { price: number; timeUtcSec: number } | null;
    lastSwingLow: { price: number; timeUtcSec: number } | null;
  };
  structure: { trend: string; highLabel: string; lowLabel: string };
  meta: {
    closedCount: number;
    formingIncluded: boolean;
    lastClosedUtcSec: number | null;
    stalenessThresholdSec: number;
    stale: boolean;
    insufficient: string[];
    note: string;
  };
}

// ---------------------------------------------------------------------------
// Phase 6 — GLM multi-agent review (advisory, never changes the signal)
// ---------------------------------------------------------------------------

export interface AiReviewAgent {
  agent: string;
  verdict: 'approve' | 'reject' | 'wait' | string;
  reasoning: string;
  createdAtUtc: string;
  modelOk: boolean | null;
}

export interface AiReviewLatestResponse {
  ok: true;
  symbol: string;
  review: {
    batchId: string;
    evaluationId: string | null;
    evaluationOutcome: string | null;
    ranAtUtc: string;
    degraded: boolean | null;
    agents: AiReviewAgent[];
    orchestrator: AiReviewAgent | null;
  } | null;
  note?: string;
  generatedAtUtc: string;
}

export interface AiReviewRunResponse {
  ok: boolean;
  ran: boolean;
  reason: string;
  review: {
    batchId: string;
    evaluationOutcome: string;
    degraded: boolean;
    orchestrator: { verdict: string; reasoning: string };
    agents: Array<{ agent: string; verdict: string; reasoning: string; modelOk: boolean }>;
  } | null;
  generatedAtUtc: string;
}

// ---------------------------------------------------------------------------
// Phase 11 — approval-based execution state
// ---------------------------------------------------------------------------

export interface ExecutionApproval {
  id: string;
  signalId: string;
  status: string;
  note: string | null;
  createdAtUtc: string;
  decidedAtUtc: string | null;
  expiresAtUtc: string | null;
  direction: 'BUY' | 'SELL' | null;
  lots: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskPassed: boolean | null;
}

export interface ExecutionPosition {
  positionId: string;
  orderId: string;
  timeCreateUtcSec: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  priceOpen: number;
  sl: number;
  tp: number;
  profit: number;
  commission: number;
  swap: number;
}

export interface ExecutionLogEntry {
  id: string;
  signalId: string;
  status: string;
  createdAtUtc: string;
  request: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface ExecutionStateResponse {
  ok: true;
  state: {
    executionEnabled: boolean;
    executionReason: string;
    switches: {
      phaseGatePassed: boolean;
      executionArmed: boolean;
      allowExecution: boolean;
      tradingMode: string;
    };
    bridge: {
      reachable: boolean;
      connected: boolean;
      authenticated: boolean;
      ordersEnabled: boolean;
      accountEquity: number | null;
      accountBalance: number | null;
      accountCurrency: string | null;
      server: string | null;
    };
    approvals: ExecutionApproval[];
    positions: ExecutionPosition[];
    positionsError: string | null;
    logs: ExecutionLogEntry[];
    approvalTtlMin: number;
    generatedAtUtc: string;
  };
}

export interface ExecutionDecisionResponse {
  ok: boolean;
  code: string;
  message: string;
  executionLogId: string | null;
  generatedAtUtc: string;
}
