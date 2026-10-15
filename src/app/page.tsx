'use client';

/**
 * XAUUSD AI Trading Agent — Phase 1 Dashboard (the only user-visible route)
 * ----------------------------------------------------------------------------
 * Live Phase 1 audit report: environment evidence, architecture, GLM
 * verification (with a live re-verify button), MT5 feasibility, database
 * model map, security & acceptance checklist, and the SystemEvent audit trail.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  Cpu,
  Database,
  FileLock2,
  Globe,
  Languages,
  LineChart,
  Loader2,
  LockKeyhole,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
// Phase 10.3-C — display-only price precision formatter (verified symbol metadata).
import {
  formatPriceLevel,
  formatPriceQuantity,
  priceDisplaySpecFromSymbolSpec,
  type PriceDisplaySpec,
} from '@/lib/market/price-display';

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  phase: number;
  phaseLabel: string;
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

interface EnvCheck {
  id: string;
  group: 'runtime' | 'network' | 'mt5' | 'glm' | 'database';
  label: string;
  evidence: string;
  status: 'pass' | 'warn' | 'fail';
  note?: string;
}

/** Phase 9 — Environment Audit v2 check shape. */
interface AuditCheckV2 {
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

interface AuditResponse {
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

/** Phase 9 — /api/signal/latest response. */
interface SignalLevelsView {
  direction: 'BUY' | 'SELL';
  // Numeric calculation values (frozen geometry — display formats a SEPARATE string)
  entryZoneLow: number;
  entryZoneHigh: number;
  entryReference: number;
  stopLoss: number;
  target: number;
  riskPrice: number;
  rewardPrice: number;
  rewardRiskRatio: number;
  // Stored canonical decimal text (evidence — raw trace for the display layer)
  entryZoneLowText: string;
  entryZoneHighText: string;
  entryReferenceText: string;
  stopLossText: string;
  targetText: string;
}

interface SignalEvidenceView {
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

/** Phase 10.3-D — rules-snapshot manifest entry (as returned by /api/signal/*). */
interface RuleManifestEntryView {
  id: string;
  value: number | string | string[] | null;
  unit: string;
  scope: string;
  source: string;
}

/** Phase 10.3-D — stored rules snapshot read result (present / not-recorded / invalid). */
interface RulesSnapshotView {
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

interface SignalLatestResponse {
  ok: boolean;
  symbol: string;
  signal: {
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
    /** Phase 10.3-A identity — null on legacy/unidentifiable rows (never guessed). */
    setupFingerprint: string | null;
    /** Phase 10.3-D — the STORED rules snapshot (never recomputed from current config). */
    rulesSnapshot: RulesSnapshotView;
    executionLocked: boolean;
    quote: Record<string, unknown> | null;
  } | null;
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

/** Phase 10.3-D — /api/signal/history response (append-only trail + counts). */
interface SignalHistoryEntryView {
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

interface SignalHistoryResponse {
  ok: boolean;
  symbol: string;
  count: number;
  /** All-time counts — evaluations vs DISTINCT logical setups (legacy rows
   *  count as evaluations only, never as setups — no fabricated identities). */
  counts: { totalEvaluations: number; distinctSetups: number } | null;
  outcomeCounts: Record<string, number>;
  history: SignalHistoryEntryView[];
}

/** Phase 9 — /api/chat response. */
interface ChatToolCallView {
  name: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

interface ChatResponse {
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

interface VerifyTest {
  id: string;
  name: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
  sample?: string;
}

interface VerifyResponse {
  verified: boolean;
  model: string;
  totalLatencyMs: number;
  checkedAt: string;
  tests: VerifyTest[];
}

// ---------------------------------------------------------------------------
// Phase 3 — market data API shapes (/api/data/*)
// ---------------------------------------------------------------------------

type QualityState = 'VALID' | 'WARNING' | 'INVALID' | 'STALE' | 'MISSING' | 'UNAVAILABLE';

interface TfReadiness {
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

interface MarketStatusResponse {
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

interface SyncRunSummary {
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

interface QualityIssueRow {
  id: string;
  checkType: string;
  timeframe: string | null;
  severity: string;
  errorCode: string;
  targetTimeUtc: string | null;
  details: { detail?: string };
  checkedAtUtc: string;
}

interface QualityResponse {
  ok: true;
  symbol: string;
  openIssues: QualityIssueRow[];
  generatedAtUtc: string;
}

// Phase 4 — analysis API shapes (/api/analysis/*)
interface AnalysisIndicatorSnapshot {
  period: number;
  warmupBars: number;
  last: { value: number } | null;
}

interface AnalysisTfView {
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

interface AnalysisResultView {
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

/** Phase 8 — /api/data/health response (Data & Signal Health panel). */
interface DataHealthResponse {
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

/** Phase 10.3-C — /api/data/latest response (verified symbol spec for display precision). */
interface DataLatestResponse {
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

/** Phase 8 — /api/backtest/latest response. */
interface BacktestLatestResponse {
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

/** Phase 10 — /api/validation/latest response (strategy validation view). */
interface ValidationSegmentView {
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

interface ValidationLatestResponse {
  ok: boolean;
  validation: {
    id: string;
    createdAt: string;
    symbol: string;
    strategyVersion: string;
    harnessVersion: string;
    status: string;
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
    durationMs: number;
  } | null;
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
}

interface AnalysisLatestResponse {
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

/** Bengali renderings of the stable machine-readable error codes. */
const bnErrorText: Record<string, string> = {
  BRIDGE_NOT_CONFIGURED: 'MT5 ব্রিজ কনফিগার করা হয়নি — MT5_BRIDGE_URL ফাঁকা আছে।',
  BRIDGE_UNREACHABLE: 'ব্রিজ সার্ভারে পৌঁছানো যাচ্ছে না।',
  BRIDGE_TIMEOUT: 'ব্রিজ সময়মতো সাড়া দেয়নি (টাইমআউট)।',
  BRIDGE_AUTH_FAILED: 'ব্রিজ অনুরোধ প্রত্যাখ্যান করেছে (অননুমোদিত)।',
  BRIDGE_RATE_LIMITED: 'ব্রিজের রেট লিমিট ছুঁয়ে গেছে — কিছুক্ষণ পরে আবার চেষ্টা হবে।',
  BRIDGE_BAD_RESPONSE: 'ব্রিজ থেকে প্রত্যাশিত ফরম্যাটে উত্তর আসেনি।',
  BRIDGE_PARTIAL_RESPONSE: 'ব্রিজ আংশিক উত্তর দিয়েছে — কিছু ডেটা পাওয়া যায়নি।',
  SOURCE_DEMO: 'ব্রিজ এখন স্পষ্টভাবে চিহ্নিত ডেমো ডেটা দিচ্ছে — এটি লাইভ বাজার নয়।',
  SOURCE_DISCONNECTED: 'MT5 টার্মিনাল সংযোগ বিচ্ছিন্ন আছে।',
  SYMBOL_NOT_ALLOWED: 'এই সিম্বলটি অনুমোদিত তালিকায় নেই।',
  SYMBOL_NOT_FOUND: 'ব্রিজে এই সিম্বলটি পাওয়া যায়নি।',
  TIMEFRAME_NOT_ALLOWED: 'এই টাইমফ্রেমটি অনুমোদিত তালিকায় নেই।',
  DATA_MISSING: 'প্রয়োজনীয় ডেটা এখনো সংরক্ষিত হয়নি।',
  DATA_STALE: 'সংরক্ষিত ডেটা পুরোনো হয়ে গেছে।',
  TICK_STALE: 'সর্বশেষ টিক পুরোনো হয়ে গেছে।',
  TICK_CROSSED: 'টিকের Bid/Ask অসঙ্গতিপূর্ণ (Ask < Bid)।',
  TICK_NON_POSITIVE: 'টিকের দাম শূন্য বা ঋণাত্মক — প্রত্যাখ্যাত।',
  GAP_POSSIBLE: 'সম্ভবত একটি ক্যান্ডেল অনুপস্থিত — বাজার ছুটি (অজানা সময়সূচি) বা ডেটা ত্রুটি হতে পারে।',
  GAP_MARKET_LIKELY_CLOSED: 'সম্ভাব্য ফাঁক — সম্ভবত বাজার বন্ধ ছিল (উইকেন্ড/বিরতি, আনুমানিক)।',
  SPEC_MISSING: 'সিম্বল স্পেসিফিকেশন এখনো যাচাই করা হয়নি।',
  CANDLE_OHLC_INCONSISTENT: 'ক্যান্ডেলের OHLC মান পরস্পরবিরোধী।',
  CANDLE_NON_FINITE: 'ক্যান্ডেলের দাম সংখ্যা নয় (NaN/অসীম)।',
  CANDLE_NON_POSITIVE: 'ক্যান্ডেলের দাম শূন্য বা ঋণাত্মক।',
  CANDLE_DUPLICATE_KEY: 'একই সময়ের ক্যান্ডেল একাধিকবার এসেছে — ডুপ্লিকেট গণনা করা হয়েছে।',
  CANDLE_OUT_OF_ORDER: 'ক্যান্ডেলগুলো সময় অনুযায়ী সাজানো ছিল না — সাজিয়ে নেওয়া হয়েছে।',
  CANDLE_PRICE_PRECISION_ANOMALY: 'দামে প্রত্যাশিত দশমিক-অঙ্কের চেয়ে বেশি অঙ্ক এসেছে — সতর্কতা সহ সংরক্ষিত।',
  DB_TX_FAILED: 'ডেটাবেস লেনদেন ব্যর্থ হয়েছে।',
  DB_ERROR: 'ডেটাবেস ত্রুটি।',
  SYNC_IN_PROGRESS: 'একটি সিঙ্ক ইতিমধ্যেই চলছে — নতুনটি বাতিল।',
  // Phase 4 (analysis + hardened API)
  MARKET_API_TOKEN_NOT_CONFIGURED: 'DATA_API_TOKEN সেট করা হয়নি — সুরক্ষিত endpoint fail-closedভাবে বন্ধ (এটি ইচ্ছাকৃত, ৫০৩)।',
  BACKFILL_INCOMPLETE: 'ব্যাকফিলের অনুরোধ-করা পরিসর টাইমস্ট্যাম্প-ভিত্তিক যাচাইতে অসম্পূর্ণ — সফল বলা হবে না।',
  DATA_NOT_READY: 'বিশ্লেষণের জন্য ডেটা এখনো প্রস্তুত নয়।',
  DATA_INVALID: 'ডেটা যাচাইয়ে ব্যর্থ — বিশ্লেষণের জন্য অবিশ্বস্ত।',
  DEMO_DATA_BLOCKED: 'ডেমো/মক ডেটা — বিশ্লেষণের জন্য চিরকাল বাতিল (এটি লাইভ বাজার নয়)।',
  INSUFFICIENT_DATA: 'পর্যাপ্ত ইতিহাস নেই — ইন্ডিকেটর ওয়ার্ম-আপের জন্য আরও ক্যান্ডেল দরকার।',
  GAP_IN_ANALYSIS_WINDOW: 'বিশ্লেষণ উইন্ডোর ভেতরে অনুপস্থিত ক্যান্ডেল — অনিরাপদ, তাই বন্ধ।',
  ANALYSIS_ERROR: 'বিশ্লেষণ ইঞ্জিনে অপ্রত্যাশিত ত্রুটি (FAILED)।',
  CLOSURE_GAPS_IN_WINDOW: 'বিশ্লেষণ উইন্ডোতে বাজার-বন্ধের সম্ভাব্য ফাঁক (তথ্য, ব্লক নয়)।',
  STRUCTURE_UNCLEAR: 'কাঠামো অস্পষ্ট — অনুমান করা হয়নি।',
  RSI_FLAT_MARKET: 'সমতল বাজার — RSI সংজ্ঞায়িত ৫০ (সতর্কতা)।',
  ADX_FLAT_MARKET: 'সমতল বাজার — DX সংজ্ঞায়িত ০ (সতর্কতা)।',
  TICK_ZERO_SPREAD: 'টিকের স্প্রেড শূন্য — সতর্কতা সহ রাখা হয়েছে।',
};

function bnForCode(code: string): string {
  return bnErrorText[code] ?? `অজানা সমস্যা (${code})।`;
}

function fmtAge(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec} সেকেন্ড`;
  if (sec < 3600) return `${Math.floor(sec / 60)} মিনিট`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ঘণ্টা`;
  return `${Math.floor(sec / 86400)} দিন`;
}

function qualityStateBadgeClass(state: string): string {
  switch (state) {
    case 'VALID':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400';
    case 'WARNING':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'STALE':
      return 'border-orange-500/40 bg-orange-500/10 text-orange-400';
    case 'MISSING':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'INVALID':
      return 'border-red-600/50 bg-red-600/15 text-red-300';
    default:
      return 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400'; // UNAVAILABLE
  }
}

const qualityStateBn: Record<string, string> = {
  VALID: 'বৈধ',
  WARNING: 'সতর্কতা',
  INVALID: 'অবৈধ',
  STALE: 'পুরোনো',
  MISSING: 'অনুপস্থিত',
  UNAVAILABLE: 'অনুপলব্ধ',
};

function syncStatusBn(status: string): string {
  switch (status) {
    case 'success': return 'সফল';
    case 'partial': return 'আংশিক';
    case 'failed': return 'ব্যর্থ';
    case 'skipped': return 'স্কিপ';
    case 'running': return 'চলছে';
    default: return status;
  }
}

// Phase 4 — analysis renderings
const analysisStatusBn: Record<string, string> = {
  completed: 'সম্পূর্ণ',
  blocked: 'বন্ধ',
  failed: 'ব্যর্থ',
  pending: 'অপেক্ষমাণ',
};

const analysisStatusClass: Record<string, string> = {
  completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  blocked: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  failed: 'border-red-500/40 bg-red-500/10 text-red-300',
  pending: 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400',
};

const trendBn: Record<string, string> = {
  bullish: 'বুলিশ (ঊর্ধ্বমুখী)',
  bearish: 'বিয়ারিশ (নিম্নমুখী)',
  range: 'রেঞ্জ',
  unclear: 'অস্পষ্ট',
};

const directionBn: Record<string, string> = { bullish: 'বুলিশ', bearish: 'বিয়ারিশ' };

const alignmentBn: Record<string, string> = {
  'aligned-bullish': 'সব টাইমফ্রেম ঊর্ধ্বমুখী',
  'aligned-bearish': 'সব টাইমফ্রেম নিম্নমুখী',
  mixed: 'টাইমফ্রেমগুলো একমত নয় (মিশ্র)',
  unclear: 'অস্পষ্ট',
};

function fmtInd(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Phase 10.3-C — price precision display helpers (PRESENTATION ONLY)
// ---------------------------------------------------------------------------
// Precision comes exclusively from verified symbol metadata (SymbolSpec with
// verifiedFields including "digits"). Missing/stale metadata → the RAW stored
// value is shown and flagged — no default precision is ever assumed. An
// off-grid raw value (derived level, Phase 10.2 F1) displays at the verified
// digits with a visible ≈ marker; the raw value stays traceable via tooltip.

/** Price LEVEL (entry/SL/target/quotes/swing prices) at verified digits. */
function PriceLevelText({
  value,
  spec,
  className,
}: {
  value: number | string | null | undefined;
  spec: PriceDisplaySpec;
  className?: string;
}) {
  const r = formatPriceLevel(value, spec);
  return (
    <span
      className={className}
      title={r.text === '—' ? undefined : `raw: ${r.rawText}`}
    >
      {r.text}
      {r.anomaly && r.text !== '—' && (
        <sup
          className="ml-0.5 text-amber-400"
          title="প্রেসিশন-অ্যানোমালি — raw মান broker grid-এ নেই / মেটাডেটা যাচাইকৃত নয়"
          aria-label="precision anomaly"
        >
          ≈
        </sup>
      )}
    </span>
  );
}

/** Price-UNIT quantity (P&L, costs, spread assumptions) at verified digits. */
function PriceQtyText({
  value,
  spec,
  className,
}: {
  value: number | null | undefined;
  spec: PriceDisplaySpec;
  className?: string;
}) {
  const text = formatPriceQuantity(value, spec);
  const raw = value === null || value === undefined || !Number.isFinite(value) ? null : String(value);
  return (
    <span className={className} title={raw !== null && raw !== text ? `raw: ${raw}` : undefined}>
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dhakaDateTime = new Intl.DateTimeFormat('bn-BD', {
  timeZone: 'Asia/Dhaka',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function fmtDhaka(iso: string): string {
  try {
    return dhakaDateTime.format(new Date(iso));
  } catch {
    return iso;
  }
}

function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const groupLabel: Record<EnvCheck['group'], string> = {
  runtime: 'রানটাইম',
  network: 'নেটওয়ার্ক',
  glm: 'GLM',
  mt5: 'MT5',
  database: 'ডেটাবেস',
};

function useDhakaClock(): string | null {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('bn-BD', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
    const tick = () => setNow(fmt.format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function StatusIcon({ status }: { status: 'pass' | 'warn' | 'fail' | 'active' | 'planned' | string }) {
  if (status === 'pass' || status === 'active' || status === 'verified')
    return <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />;
  if (status === 'fail') return <XCircle className="h-4 w-4 text-red-400" aria-hidden />;
  return <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />;
}

/** Phase 9 — audit v2 status icon (six-state model). */
function AuditStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'PASS':
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />;
    case 'WARN':
      return <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />;
    case 'FAIL':
      return <XCircle className="h-4 w-4 text-red-400" aria-hidden />;
    case 'BLOCKED':
      return <AlertTriangle className="h-4 w-4 text-orange-400" aria-hidden />;
    case 'NOT_APPLICABLE':
      return <Circle className="h-4 w-4 text-zinc-500" aria-hidden />;
    default:
      return <Circle className="h-4 w-4 text-zinc-400" aria-hidden />; // NOT_TESTED
  }
}

function auditStatusBadgeClass(status: string): string {
  switch (status) {
    case 'PASS':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400';
    case 'WARN':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'FAIL':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'BLOCKED':
      return 'border-orange-500/40 bg-orange-500/10 text-orange-400';
    case 'NOT_APPLICABLE':
      return 'border-zinc-600/50 bg-zinc-700/20 text-zinc-500';
    default:
      return 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400'; // NOT_TESTED
  }
}

/** Phase 9 — signal outcome renderings. */
const signalOutcomeBn: Record<string, string> = {
  BUY_SETUP: 'BUY সেটআপ (গবেষণা)',
  SELL_SETUP: 'SELL সেটআপ (গবেষণা)',
  WAIT: 'অপেক্ষা (WAIT)',
  NO_SETUP: 'সেটআপ নেই (NO_SETUP)',
  BLOCKED: 'বন্ধ (BLOCKED)',
  FAILED: 'ব্যর্থ (FAILED)',
};

function signalOutcomeBadgeClass(outcome: string): string {
  switch (outcome) {
    case 'BUY_SETUP':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400';
    case 'SELL_SETUP':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'WAIT':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'NO_SETUP':
      return 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400';
    case 'BLOCKED':
      return 'border-orange-500/40 bg-orange-500/10 text-orange-400';
    default:
      return 'border-red-600/50 bg-red-600/15 text-red-300';
  }
}

function levelBadgeClass(level: string): string {
  switch (level) {
    case 'error':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'warn':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'info':
      return 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300';
    default:
      return 'border-zinc-700 bg-zinc-800/50 text-zinc-500';
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Phase1Dashboard() {
  const { toast } = useToast();
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [marketStatus, setMarketStatus] = useState<MarketStatusResponse | null>(null);
  const [marketQuality, setMarketQuality] = useState<QualityResponse | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [analysisLatest, setAnalysisLatest] = useState<AnalysisLatestResponse | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [dataHealth, setDataHealth] = useState<DataHealthResponse | null>(null);
  const [backtestLatest, setBacktestLatest] = useState<BacktestLatestResponse | null>(null);
  const [signalLatest, setSignalLatest] = useState<SignalLatestResponse | null>(null);
  const [signalRunning, setSignalRunning] = useState(false);
  // Phase 10.3-D — evaluation history + counts (evaluations vs distinct setups)
  const [signalHistory, setSignalHistory] = useState<SignalHistoryResponse | null>(null);
  const [validationLatest, setValidationLatest] = useState<ValidationLatestResponse | null>(null);
  // Phase 10.3-C — verified symbol metadata (digits) for price display precision
  const [dataLatest, setDataLatest] = useState<DataLatestResponse | null>(null);
  // Chat state — Phase 9 Task D/E
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string; meta?: ChatResponse | null }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const clock = useDhakaClock();

  const refresh = useCallback(async () => {
    try {
      const [hRes, aRes, mRes, qRes, anRes, dhRes, btRes, sgRes, vlRes, dlRes, shRes] = await Promise.all([
        fetch('/api/health', { cache: 'no-store' }),
        fetch('/api/audit/environment', { cache: 'no-store' }),
        fetch('/api/data/status', { cache: 'no-store' }).catch(() => null),
        fetch('/api/data/quality', { cache: 'no-store' }).catch(() => null),
        fetch('/api/analysis/latest', { cache: 'no-store' }).catch(() => null),
        fetch('/api/data/health?symbol=XAUUSDm', { cache: 'no-store' }).catch(() => null),
        fetch('/api/backtest/latest?symbol=XAUUSDm', { cache: 'no-store' }).catch(() => null),
        fetch('/api/signal/latest?symbol=XAUUSDm', { cache: 'no-store' }).catch(() => null),
        fetch('/api/validation/latest?symbol=XAUUSDm', { cache: 'no-store' }).catch(() => null),
        // Phase 10.3-C — verified SymbolSpec (digits/verifiedFields) for display precision
        fetch('/api/data/latest?symbol=XAUUSDm', { cache: 'no-store' }).catch(() => null),
        // Phase 10.3-D — evaluation history + counts (read-only, existing endpoint)
        fetch('/api/signal/history?symbol=XAUUSDm&limit=20', { cache: 'no-store' }).catch(() => null),
      ]);
      if (!hRes.ok && !aRes.ok) throw new Error('API unreachable');
      if (hRes.ok) setHealth((await hRes.json()) as HealthReport);
      if (aRes.ok) setAudit((await aRes.json()) as AuditResponse);
      if (mRes && mRes.ok) setMarketStatus((await mRes.json()) as MarketStatusResponse);
      if (qRes && qRes.ok) setMarketQuality((await qRes.json()) as QualityResponse);
      if (anRes && anRes.ok) {
        setAnalysisLatest((await anRes.json()) as AnalysisLatestResponse);
        setAnalysisError(null);
      } else if (anRes) {
        // honest fail-closed state (e.g. DATA_API_TOKEN posture) — never guessed
        setAnalysisLatest(null);
        try {
          const b = (await anRes.json()) as { error?: { code?: string } };
          setAnalysisError(b?.error?.code ?? 'UNAVAILABLE');
        } catch {
          setAnalysisError('UNAVAILABLE');
        }
      } else {
        setAnalysisError('NETWORK_ERROR');
      }
      if (dhRes && dhRes.ok) setDataHealth((await dhRes.json()) as DataHealthResponse);
      else setDataHealth(null);
      if (btRes && btRes.ok) setBacktestLatest((await btRes.json()) as BacktestLatestResponse);
      else setBacktestLatest(null);
      if (sgRes && sgRes.ok) setSignalLatest((await sgRes.json()) as SignalLatestResponse);
      else setSignalLatest(null);
      if (vlRes && vlRes.ok) setValidationLatest((await vlRes.json()) as ValidationLatestResponse);
      else setValidationLatest(null);
      if (dlRes && dlRes.ok) setDataLatest((await dlRes.json()) as DataLatestResponse);
      else setDataLatest(null);
      if (shRes && shRes.ok) setSignalHistory((await shRes.json()) as SignalHistoryResponse);
      else setSignalHistory(null);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  // ---------------------------------------------------------------------------
  // Phase 10.3-C — verified price-precision spec (fail-closed when unverified)
  // ---------------------------------------------------------------------------
  const priceSpec = useMemo(
    () => priceDisplaySpecFromSymbolSpec(dataLatest?.spec ?? null),
    [dataLatest],
  );
  /** Live bridge quote digits vs persisted verified spec — visible if inconsistent. */
  const quoteDigitsMismatch =
    dataHealth?.quote.digits != null && priceSpec.verified && dataHealth.quote.digits !== priceSpec.digits;

  const runVerify = useCallback(async () => {
    setVerifying(true);
    try {
      const res = await fetch('/api/ai/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (res.status === 429) {
        const body = (await res.json()) as { message?: string };
        toast({
          title: 'রেট লিমিট',
          description: body.message ?? 'অনুগ্রহ করে কিছুক্ষণ পরে আবার চেষ্টা করুন।',
          variant: 'destructive',
        });
        return;
      }
      const body = (await res.json()) as VerifyResponse;
      setVerifyResult(body);
      if (body.verified) {
        toast({ title: 'GLM যাচাই সফল', description: `মডেল ${body.model} · ${body.totalLatencyMs}ms` });
      } else {
        toast({
          title: 'GLM যাচাই ব্যর্থ',
          description: 'বিস্তারিত GLM ট্যাবে দেখুন।',
          variant: 'destructive',
        });
      }
      await refresh(); // pull fresh health + audit trail rows
    } catch (e) {
      toast({
        title: 'যাচাই চালানো যায়নি',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      });
    } finally {
      setVerifying(false);
    }
  }, [refresh, toast]);

  const runSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const symbol = marketStatus?.symbol ?? 'XAUUSDm';
      const res = await fetch('/api/data/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, mode: 'manual' }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        outcome?: SyncRunSummary & { status: string };
        error?: { code: string; message: string };
      };
      if (res.status === 429) {
        toast({
          title: 'রেট লিমিট',
          description: 'খুব ঘন ঘন সিঙ্ক চালানো হচ্ছে — কিছুক্ষণ পরে চেষ্টা করুন।',
          variant: 'destructive',
        });
      } else if (body.ok && body.outcome?.status === 'success') {
        toast({
          title: 'সিঙ্ক সফল',
          description: `নতুন ${body.outcome.inserted}টি, আপডেট ${body.outcome.updated}টি ক্যান্ডেল।`,
        });
      } else if (body.ok && body.outcome) {
        toast({
          title: `সিঙ্ক ${syncStatusBn(body.outcome.status)}`,
          description: body.outcome.errorCode ? bnForCode(body.outcome.errorCode) : 'কিছু টাইমফ্রেম সম্পূর্ণ হয়নি।',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'সিঙ্ক ব্যর্থ',
          description: body.error ? bnForCode(body.error.code) : 'অজানা ত্রুটি।',
          variant: 'destructive',
        });
      }
      await refresh();
    } catch (e) {
      toast({
        title: 'সিঙ্ক চালানো যায়নি',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      });
    } finally {
      setSyncing(false);
    }
  }, [marketStatus?.symbol, refresh, toast]);

  const runAnalysisNow = useCallback(async () => {
    setAnalysisRunning(true);
    try {
      const symbol = marketStatus?.symbol ?? 'XAUUSDm';
      const res = await fetch('/api/analysis/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        analysis?: { status: string; reasonCodes: string[] };
        error?: { code: string; message: string };
      };
      if (res.status === 401 || res.status === 503) {
        // fail-closed security posture — honest, never bypassed from the UI
        toast({
          title: 'বিশ্লেষণ চালানো যায়নি',
          description: body.error ? bnForCode(body.error.code) : 'সংযোগ বন্ধ।',
          variant: 'destructive',
        });
      } else if (res.status === 500) {
        toast({
          title: 'বিশ্লেষণ ব্যর্থ (FAILED)',
          description: body.error?.message ?? 'অজানা ত্রুটি।',
          variant: 'destructive',
        });
      } else if (body.analysis?.status === 'COMPLETED') {
        toast({ title: 'বিশ্লেষণ সম্পূর্ণ', description: 'কাঠামো ও সূচক হালনাগাদ — বিশ্লেষণ ট্যাবে দেখুন।' });
      } else if (body.analysis?.status === 'BLOCKED') {
        toast({
          title: 'বিশ্লেষণ বন্ধ — সৎ ফলাফল',
          description: body.analysis.reasonCodes.map((c) => bnForCode(c)).join(' '),
          variant: 'destructive',
        });
      }
      await refresh();
    } catch (e) {
      toast({
        title: 'বিশ্লেষণ চালানো যায়নি',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      });
    } finally {
      setAnalysisRunning(false);
    }
  }, [marketStatus?.symbol, refresh, toast]);

  // Phase 9 — trigger a deterministic signal evaluation (token-guarded trigger).
  const runSignalNow = useCallback(async () => {
    setSignalRunning(true);
    try {
      const symbol = marketStatus?.symbol ?? 'XAUUSDm';
      const res = await fetch('/api/signal/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        evaluation?: { outcome: string; reasonCodes: string[] };
        error?: { code: string; message: string };
      };
      if (res.status === 401 || res.status === 503) {
        toast({
          title: 'সিগন্যাল মূল্যায়ন চালানো যায়নি',
          description: body.error ? bnForCode(body.error.code) : 'সংযোগ বন্ধ (fail-closed)।',
          variant: 'destructive',
        });
      } else if (res.status === 500) {
        toast({
          title: 'সিগন্যাল মূল্যায়ন ব্যর্থ (FAILED)',
          description: body.error?.message ?? 'অজানা ত্রুটি।',
          variant: 'destructive',
        });
      } else if (body.evaluation) {
        const outcome = body.evaluation.outcome;
        if (outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP') {
          toast({ title: `সেটআপ পাওয়া গেছে: ${outcome === 'BUY_SETUP' ? 'BUY' : 'SELL'} (গবেষণা সিগন্যাল)`, description: 'সিগন্যাল ট্যাবে সম্পূর্ণ লেভেল দেখুন — কোনো ট্রেড কার্যকর হয়নি।' });
        } else {
          toast({
            title: `ফলাফল: ${outcome}`,
            description: body.evaluation.reasonCodes.map((c) => bnForCode(c)).join(' ') || 'কোনো কারণ-কোড নেই।',
          });
        }
      }
      await refresh();
    } catch (e) {
      toast({
        title: 'সিগন্যাল মূল্যায়ন চালানো যায়নি',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      });
    } finally {
      setSignalRunning(false);
    }
  }, [marketStatus?.symbol, refresh, toast]);

  // Phase 9 — send a chat message to the Bengali agent (allowlisted tools only).
  const sendChatMessage = useCallback(async () => {
    const message = chatInput.trim();
    if (!message || chatSending) return;
    setChatInput('');
    setChatMessages((prev) => [...prev, { role: 'user', content: message }]);
    setChatSending(true);
    try {
      const history = chatMessages
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
      });
      const body = (await res.json()) as ChatResponse;
      if (res.ok && body.ok) {
        setChatMessages((prev) => [...prev, { role: 'assistant', content: body.reply, meta: body }]);
      } else {
        const errText = body.error
          ? `${body.error.code}${body.error.detail ? `: ${body.error.detail}` : ''}`
          : 'অজানা ত্রুটি';
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `দুঃখিত — উত্তর আনা যায়নি (${errText})। আবার চেষ্টা করুন।`, meta: null },
        ]);
      }
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `দুঃখিত — সংযোগ ত্রুটি (${e instanceof Error ? e.message : 'unknown'})।`, meta: null },
      ]);
    } finally {
      setChatSending(false);
    }
  }, [chatInput, chatMessages, chatSending]);

  // Phase 9: audit totals come from the v2 model (audit.totals) — the old
  // environmentChecks aggregation is gone (current vs historical are separate).

  const glmLiveStatus = health?.glm.status ?? 'unverified';

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100 font-sans">
      {/* ---------------------------------------------------------------- Header */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/75">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
          <div className="flex h-16 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <img src="/gold-icon.svg" alt="XAUUSD AI Trading Agent logo" className="h-9 w-9 shrink-0" />
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold sm:text-base text-zinc-50">
                  XAUUSD AI Trading Agent
                  <span className="ml-2 hidden text-xs font-normal text-zinc-400 md:inline">
                    GLM-চালিত হাইব্রিড মার্কেট-স্ট্রাকচার অ্যানালিসিস
                  </span>
                </h1>
                <p className="truncate text-[11px] text-zinc-500">
                  Exness MT5 টার্গেট · ডিটারমিনিস্টিক ইঞ্জিন + AI রিভিউ · Risk Gate সর্বোচ্চ কর্তৃত্ব
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <Badge
                variant="outline"
                className={`gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-400 ${
                  health?.status === 'degraded' ? 'border-amber-500/40 bg-amber-500/10 text-amber-400' : ''
                }`}
              >
                <Activity className="h-3 w-3" aria-hidden />
                {health ? (health.status === 'ok' ? 'সিস্টেম সচল' : 'সতর্কতা প্রয়োজন') : '...'}
              </Badge>
              <span className="hidden text-xs tabular-nums text-zinc-400 sm:inline" suppressHydrationWarning>
                ঢাকা {clock ?? '--:--:--'}
              </span>
              <Badge variant="outline" className="hidden border-amber-500/40 bg-amber-500/10 text-amber-400 md:inline-flex">
                Phase 9 / 12
              </Badge>
            </div>
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------- Main */}
      <main className="flex-1 w-full">
        <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6">
          {/* Read-only banner */}
          <div
            role="alert"
            className="gold-grid-bg flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <FileLock2 className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
              <div>
                <p className="text-sm font-semibold text-amber-200">
                  Read-Only Mode সক্রিয় — কোনো অর্ডার পাঠানো হবে না
                </p>
                <p className="text-xs leading-relaxed text-zinc-400">
                  Phase 9 (সিগন্যাল ইঞ্জিন + বাংলা চ্যাট) পর্যন্ত সবকিছু read-only। Execution কোড-লেভেলে তালাবন্ধ —{' '}
                  {health?.executionReason ?? 'Phase 11 গেটের আগে খোলা যাবে না।'}
                </p>
              </div>
            </div>
            <Badge variant="outline" className="w-fit shrink-0 gap-1.5 border-red-500/40 bg-red-500/10 text-red-400">
              <LockKeyhole className="h-3 w-3" aria-hidden /> Order Execution: LOCKED
            </Badge>
          </div>

          {/* KPI cards */}
          <section aria-label="সারসংক্ষেপ" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                key: 'glm',
                icon: Bot,
                title: 'GLM AI Access',
                value: 'glm-4-plus',
                state: glmLiveStatus === 'verified' ? 'verified' : 'pending',
                stateClass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
                lines: ['চ্যাট ✓ বাংলা ✓ টুল-কলিং ✓ (৭২০ms)', `সর্বশেষ যাচাই: ${health?.glm.lastCheckedAt ? fmtDhaka(health.glm.lastCheckedAt) : 'এখনো হয়নি'}`],
              },
              {
                key: 'runtime',
                icon: Cpu,
                title: 'Runtime (Sandbox)',
                value: 'Debian 13 · Node 24',
                state: 'সচল',
                stateClass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
                lines: [
                  `Next.js 16 · Bun ${audit?.live.bun ?? '1.3'} · 2 vCPU`,
                  `আপটাইম ${health ? fmtUptime(health.uptimeSeconds) : '—'} · DB ${health?.checks.database ?? '—'}`,
                ],
              },
              {
                key: 'mt5',
                icon: Network,
                title: 'MT5 Bridge',
                value: marketStatus
                  ? marketStatus.bridge.configured
                    ? marketStatus.bridge.reachable
                      ? `${marketStatus.symbol} · ${marketStatus.bridge.status?.source ?? '…'}`
                      : 'ব্রিজ অনুপলব্ধ'
                    : 'কনফিগার করা হয়নি'
                  : '…',
                state: marketStatus
                  ? marketStatus.bridge.configured
                    ? marketStatus.bridge.reachable && marketStatus.bridge.status?.connected
                      ? marketStatus.bridge.status?.source === 'demo' ? 'ডেমো ফিড' : 'সংযুক্ত'
                      : 'সংযোগ নেই'
                    : 'অনুপলব্ধ'
                  : '…',
                stateClass: marketStatus
                  ? marketStatus.bridge.configured && marketStatus.bridge.reachable && marketStatus.bridge.status?.connected
                    ? marketStatus.bridge.status?.source === 'demo'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                      : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                  : 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400',
                lines: [
                  `ডেটা অবস্থা: ${marketStatus ? qualityStateBn[marketStatus.readiness.qualityState] : '—'} · প্রস্তুত: ${marketStatus?.readiness.ready ? 'হ্যাঁ' : 'না'}`,
                  'ওয়েব-টার্মিনাল প্রোটোকল প্রমাণিত · ব্রিজ বসানো Phase 2-এর কাজ',
                ],
              },
              {
                key: 'exec',
                icon: LockKeyhole,
                title: 'Order Execution',
                value: 'Read-Only',
                state: 'LOCKED',
                stateClass: 'border-red-500/40 bg-red-500/10 text-red-400',
                lines: ['TRADING_PHASE=4 · চার-সুইচ গেট (Phase ≥ 11)', 'Live/Demo অর্ডার: Phase 11+ অনুমোদনসাপেক্ষ'],
              },
            ].map((k, i) => (
              <motion.div
                key={k.key}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: i * 0.06 }}
              >
                <Card className="h-full border-zinc-800 bg-zinc-900/40">
                  <CardContent className="p-4 sm:p-5">
                    {loading && !audit ? (
                      <div className="space-y-3">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-6 w-40" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-2/3" />
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
                            <k.icon className="h-4 w-4 text-amber-400" aria-hidden />
                            {k.title}
                          </span>
                          <Badge variant="outline" className={k.stateClass}>
                            {k.state}
                          </Badge>
                        </div>
                        <p className="mt-2 font-mono text-sm font-semibold text-zinc-50">{k.value}</p>
                        <div className="mt-2 space-y-1">
                          {k.lines.map((line) => (
                            <p key={line} className="text-xs leading-relaxed text-zinc-400">
                              {line}
                            </p>
                          ))}
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </section>

          {loadError && (
            <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
              API লোড করা যায়নি: {loadError} —{' '}
              <Button variant="outline" size="sm" className="ml-2" onClick={() => void refresh()}>
                আবার চেষ্টা করুন
              </Button>
            </div>
          )}

          {/* Report tabs */}
          <Tabs defaultValue="audit" className="space-y-4">
            <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-zinc-900/60 p-1">
              <TabsTrigger value="audit" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">নিরীক্ষণ v2</TabsTrigger>
              <TabsTrigger value="market" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">মার্কেট ডেটা</TabsTrigger>
              <TabsTrigger value="analysis" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">বিশ্লেষণ</TabsTrigger>
              <TabsTrigger value="signal" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">সিগন্যাল</TabsTrigger>
              <TabsTrigger value="validation" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">ভ্যালিডেশন</TabsTrigger>
              <TabsTrigger value="chat" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">চ্যাট</TabsTrigger>
              <TabsTrigger value="dhealth" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">ডেটা স্বাস্থ্য</TabsTrigger>
              <TabsTrigger value="arch" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">আর্কিটেকচার</TabsTrigger>
              <TabsTrigger value="glm" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">GLM যাচাই</TabsTrigger>
              <TabsTrigger value="mt5" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">MT5 প্রতিবেদন</TabsTrigger>
              <TabsTrigger value="db" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">ডেটাবেস</TabsTrigger>
              <TabsTrigger value="sec" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">নিরাপত্তা ও চেকলিস্ট</TabsTrigger>
            </TabsList>

            {/* ------------------------------------------------ Tab: audit (v2) */}
            <TabsContent value="audit" className="space-y-4">
              {/* v2 summary — current vs historical vs not-applicable, separately */}
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    পরিবেশ নিরীক্ষণ v2 — বর্তমান বনাম ঐতিহাসিক প্রমাণ আলাদা
                    {audit && (
                      <span className="flex flex-wrap gap-1.5">
                        <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">বর্তমান: {audit.totals.currentRequired.pass} pass</Badge>
                        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-400">{audit.totals.currentRequired.warn} warn</Badge>
                        <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-400">{audit.totals.currentRequired.fail} fail</Badge>
                        <Badge variant="outline" className="border-orange-500/40 bg-orange-500/10 text-orange-400">{audit.totals.currentRequired.blocked} blocked</Badge>
                        <Badge variant="outline" className="border-zinc-600/50 bg-zinc-700/20 text-zinc-400">{audit.totals.notApplicable} অপ্রযোজ্য</Badge>
                        <Badge variant="outline" className="border-zinc-600/50 bg-zinc-700/20 text-zinc-400">{audit.totals.historical} ঐতিহাসিক</Badge>
                      </span>
                    )}
                  </CardTitle>
                  <p className="text-xs leading-relaxed text-zinc-500">
                    বর্তমান চেকগুলো এই মুহূর্তে চালানো হয়েছে (রিফ্রেশ করলে আবার চলবে){audit ? ` — ${fmtDhaka(audit.generatedAtUtc)}` : ''}
                    {audit?.commit ? ` · commit ${audit.commit}` : ''}। ঐতিহাসিক এন্ট্রিগুলো Phase 1-এর কমান্ড প্রমাণ — মূল টাইমস্ট্যাম্প সহ সংরক্ষিত, রিফ্রেশে পুনরায় চালানো হয় না। NOT_APPLICABLE মানে বর্তমান আর্কিটেকচারে অনাবশ্যক (কোড-পরিদর্শন ভিত্তিক) — পুরনো ব্যর্থতা লুকানোর উপায় নয়।
                  </p>
                </CardHeader>
                <CardContent className="space-y-5 p-4 sm:p-6">
                  {/* Current required checks */}
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-200">বর্তমান প্রয়োজনীয় চেক ({audit?.sections.currentRequired.length ?? 0})</h3>
                      <Badge variant="outline" className="border-zinc-700 bg-zinc-800/50 text-zinc-500">freshness: per-request</Badge>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-zinc-800">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-zinc-800 hover:bg-transparent">
                            <TableHead className="pl-4">অবস্থা</TableHead>
                            <TableHead>চেক</TableHead>
                            <TableHead className="min-w-[240px]">প্রমাণ</TableHead>
                            <TableHead className="min-w-[160px]">সময় / সময়কাল</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(audit?.sections.currentRequired ?? []).map((c) => (
                            <TableRow key={c.id} className="border-zinc-800/70">
                              <TableCell className="pl-4">
                                <span className="flex items-center gap-1.5 whitespace-nowrap">
                                  <AuditStatusIcon status={c.status} />
                                  <Badge variant="outline" className="text-zinc-500">{c.evidenceType}</Badge>
                                </span>
                              </TableCell>
                              <TableCell className="max-w-[320px]">
                                <p className="text-sm font-medium text-zinc-200">{c.description}</p>
                                <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{c.reason}</p>
                              </TableCell>
                              <TableCell className="max-w-[380px] break-words font-mono text-xs text-zinc-400">{c.evidence || '—'}</TableCell>
                              <TableCell className="whitespace-nowrap text-xs text-zinc-500">
                                {c.completedAtUtc ? fmtDhaka(c.completedAtUtc) : '—'}
                                {c.durationMs !== null ? <span className="block text-zinc-600">{c.durationMs}ms</span> : null}
                              </TableCell>
                            </TableRow>
                          ))}
                          {loading && !audit && (
                            <TableRow>
                              <TableCell colSpan={4} className="p-6">
                                <Skeleton className="h-5 w-full" />
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  {/* Not-applicable checks */}
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-200">অপ্রযোজ্য লিগ্যাসি ডিপেন্ডেন্সি ({audit?.sections.notApplicable.length ?? 0})</h3>
                      <Badge variant="outline" className="border-zinc-700 bg-zinc-800/50 text-zinc-500">NOT_APPLICABLE ≠ PASS</Badge>
                    </div>
                    <div className="space-y-2">
                      {(audit?.sections.notApplicable ?? []).map((c) => (
                        <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                          <p className="text-sm font-medium text-zinc-300">
                            <span className="mr-2 text-zinc-500">∅</span>
                            {c.description}
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-zinc-500">{c.reason}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Historical (Phase 1) checks — original timestamps, never re-run */}
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-200">ঐতিহাসিক প্রমাণ — Phase 1 ({audit?.sections.historical.length ?? 0})</h3>
                      <Badge variant="outline" className="border-zinc-700 bg-zinc-800/50 text-zinc-500">freshness: historical-phase1</Badge>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-zinc-800">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-zinc-800 hover:bg-transparent">
                            <TableHead className="pl-4">ফলাফল (তখন)</TableHead>
                            <TableHead>বিষয়</TableHead>
                            <TableHead className="min-w-[240px]">প্রমাণ (মূল কমান্ড আউটপুট)</TableHead>
                            <TableHead>মূল সময়</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(audit?.sections.historical ?? []).map((c) => (
                            <TableRow key={c.id} className="border-zinc-800/70 opacity-80">
                              <TableCell className="pl-4">
                                <span className="flex items-center gap-1.5">
                                  <StatusIcon status={c.status === 'PASS' ? 'pass' : c.status === 'FAIL' ? 'fail' : 'warn'} />
                                  <span className="font-mono text-xs text-zinc-500">{c.status}</span>
                                </span>
                              </TableCell>
                              <TableCell className="max-w-[260px]">
                                <p className="text-sm font-medium text-zinc-300">{c.description}</p>
                                <p className="mt-0.5 text-xs leading-relaxed text-zinc-600">{c.reason}</p>
                              </TableCell>
                              <TableCell className="max-w-[380px] break-words font-mono text-xs text-zinc-500">{c.evidence}</TableCell>
                              <TableCell className="whitespace-nowrap text-xs text-zinc-600">{c.historical ? fmtDhaka(c.historical.performedAtUtc) : '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-zinc-600">
                      Wine ও MetaTrader5 Python প্যাকেজের Phase 1 ব্যর্থতা ঐতিহাসিক সত্য — বর্তমান TypeScript ব্রিজ আর্কিটেকচার এগুলোর উপর নির্ভরশীল নয়, তাই বর্তমান চেকে সেগুলো NOT_APPLICABLE (উপরের সেকশনে কোড-পরিদর্শন প্রমাণ সহ)। কোনো ব্যর্থতা লুকানো হয়নি।
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ------------------------------------------------ Tab: market data (Phase 3) */}
            <TabsContent value="market" className="space-y-4">
              {/* Fail-closed banner */}
              {marketStatus && (!marketStatus.bridge.configured || !marketStatus.bridge.reachable || !marketStatus.bridge.status?.connected) && (
                <div
                  role="alert"
                  className="flex flex-col gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden />
                    <div>
                      <p className="text-sm font-semibold text-red-200">ডেটা পাওয়া যাচ্ছে না</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
                        {marketStatus.bridge.error
                          ? `${bnForCode(marketStatus.bridge.error.code)} `
                          : 'MT5 ব্রিজ এখনো বসানো হয়নি (Phase 2 ডেলিভারেবল)। '}
                        ডেটা পাইপলাইন fail-closed — কোনো ডেটা বানানো হবে না; ব্রিজ সচল হলে স্বয়ংক্রিয়ভাবে যুক্ত হবে।
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline" className="w-fit shrink-0 border-zinc-600/50 bg-zinc-700/20 font-mono text-zinc-400">
                    {marketStatus.bridge.error?.code ?? 'BRIDGE_NOT_DEPLOYED'}
                  </Badge>
                </div>
              )}

              {/* Demo-source banner (clearly labelled) */}
              {marketStatus?.bridge.status?.source === 'demo' && (
                <div
                  role="status"
                  className="flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
                >
                  <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" aria-hidden />
                  <p className="text-xs leading-relaxed text-amber-200">
                    <span className="font-semibold">ডেমো ডেটা চিহ্নিত:</span> ব্রিজ কোনো ক্রেডেনশিয়াল ছাড়া স্পষ্টভাবে লেবেল-করা সিন্থেটিক ফিড দিচ্ছে।
                    এটি লাইভ বাজার নয় — বিশ্লেষণ-প্রস্তুতি কখনোই “প্রস্তুত” হবে না এবং কোনো দাম লাইভ হিসেবে দেখানো হবে না।
                  </p>
                </div>
              )}

              {/* Bridge + tick cards */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <Network className="h-4 w-4 text-amber-400" aria-hidden /> MT5 ব্রিজ সংযোগ
                      {marketStatus?.bridge.status?.source && (
                        <Badge variant="outline" className="font-mono text-[10px] text-zinc-400">source: {marketStatus.bridge.status.source}</Badge>
                      )}
                    </CardTitle>
                    <p className="text-xs text-zinc-500">রিড-ওনলি REST চুক্তি (/health, /api/status, /api/quote, /api/candles) · প্রোব প্রতি ১০ সেকেন্ডে ক্যাশ হয়।</p>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    {([
                      ['কনফিগারড (MT5_BRIDGE_URL)', marketStatus ? (marketStatus.bridge.configured ? 'হ্যাঁ' : 'না') : '—'],
                      ['সার্ভার পৌঁছানো যায়', marketStatus ? (marketStatus.bridge.reachable ? 'হ্যাঁ' : 'না') : '—'],
                      ['MT5 সংযুক্ত', marketStatus?.bridge.status ? (marketStatus.bridge.status.connected ? 'হ্যাঁ' : 'না') : '—'],
                      ['সার্ভার', marketStatus?.bridge.status?.server ?? '—'],
                      ['লেটেন্সি', marketStatus?.bridge.status?.latencyMs != null ? `${marketStatus.bridge.status.latencyMs}ms` : '—'],
                      ['প্রোব সময় (ঢাকা)', marketStatus ? fmtDhaka(marketStatus.bridge.probedAtUtc) : '—'],
                    ] as Array<[string, string]>).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between gap-3 border-b border-zinc-800/60 pb-1.5 last:border-0 last:pb-0">
                        <span className="text-zinc-500">{k}</span>
                        <span className="text-right font-mono text-zinc-200">{v}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <Zap className="h-4 w-4 text-amber-400" aria-hidden /> সর্বশেষ টিক — {marketStatus?.symbol ?? 'XAUUSDm'}
                      {marketStatus?.readiness.tick.state && (
                        <Badge variant="outline" className={qualityStateBadgeClass(marketStatus.readiness.tick.state)}>
                          {qualityStateBn[marketStatus.readiness.tick.state]}
                        </Badge>
                      )}
                    </CardTitle>
                    <p className="text-xs text-zinc-500">প্রতি সিম্বলে একটি স্ন্যাপশট (উচ্চ-ফ্রিকোয়েন্সি টিক ইতিহাস নয় — ইচ্ছাকৃত সীমাবদ্ধতা)।</p>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    {marketStatus?.readiness.tick.bid ? (
                      <>
                        <div className="grid grid-cols-3 gap-2">
                          {([
                            ['Bid', marketStatus.readiness.tick.bid],
                            ['Ask', marketStatus.readiness.tick.ask],
                            ['Spread', marketStatus.readiness.tick.spread],
                          ] as Array<[string, string | null]>).map(([k, v]) => (
                            <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-center">
                              <p className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</p>
                              <p className="mt-0.5 font-mono text-sm text-amber-200">
                                <PriceLevelText value={v} spec={priceSpec} />
                              </p>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-between border-b border-zinc-800/60 pb-1.5 text-zinc-500">
                          <span>টিক সময় (ঢাকা)</span>
                          <span className="font-mono text-zinc-200">{marketStatus.readiness.tick.lastTickTimeUtc ? fmtDhaka(marketStatus.readiness.tick.lastTickTimeUtc) : '—'}</span>
                        </div>
                        <div className="flex items-center justify-between text-zinc-500">
                          <span>ডেটার বয়স</span>
                          <span className="font-mono text-zinc-200">
                            {fmtAge(marketStatus.readiness.tick.ageSeconds)} / সীমা {fmtAge(marketStatus.readiness.tick.stalenessThresholdSeconds)}
                          </span>
                        </div>
                      </>
                    ) : (
                      <p className="rounded-lg border border-dashed border-zinc-800 p-3 text-center text-zinc-500">
                        এখনো কোনো বৈধ টিক সংরক্ষিত হয়নি — ব্রিজ সচল হলে সিঙ্কের পর এখানে আসবে।
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Per-timeframe readiness */}
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <LineChart className="h-4 w-4 text-amber-400" aria-hidden /> টাইমফ্রেম অনুযায়ী ডেটা-গুণমান
                    <Badge variant="outline" className={qualityStateBadgeClass(marketStatus?.readiness.qualityState ?? 'UNAVAILABLE')}>
                      সামগ্রিক: {qualityStateBn[marketStatus?.readiness.qualityState ?? 'UNAVAILABLE']}
                    </Badge>
                  </CardTitle>
                  <p className="text-xs text-zinc-500">
                    ফর্মিং ক্যান্ডেল কখনোই নিশ্চিত ইতিহাস হিসেবে গণ্য হয় না — শুধু বন্ধ (closed) ক্যান্ডেল বিবেচিত। সেশন-সচেতন ফাঁক-স্ক্যান উইকেন্ড/বিরতিকে “সম্ভাব্য বাজার-বন্ধ” হিসেবে দেখায় (আনুমানিক, ব্রোকার-যাচাইকৃত নয়)।
                  </p>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {(marketStatus?.readiness.timeframes ?? []).map((tf) => (
                    <div key={tf.timeframe} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold text-zinc-100">{tf.timeframe}</span>
                        <Badge variant="outline" className={qualityStateBadgeClass(tf.state)}>{qualityStateBn[tf.state]}</Badge>
                      </div>
                      <dl className="mt-2 space-y-1 text-[11px] leading-relaxed text-zinc-400">
                        <div className="flex justify-between gap-2">
                          <dt className="text-zinc-500">শেষ বন্ধ ক্যান্ডেল</dt>
                          <dd className="text-right">{tf.lastClosedCandleTimeUtc ? fmtDhaka(tf.lastClosedCandleTimeUtc) : '—'}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-zinc-500">বয়স / সীমা</dt>
                          <dd className="text-right font-mono">{fmtAge(tf.lastClosedCandleAgeSeconds)} / {fmtAge(tf.stalenessThresholdSeconds)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-zinc-500">স্ক্যান / সন্দেহজনক ফাঁক</dt>
                          <dd className="text-right font-mono">{tf.scannedCandles} / <span className={tf.missingCandles > 0 ? 'text-amber-400' : 'text-zinc-300'}>{tf.missingCandles}</span></dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-zinc-500">সম্ভাব্য বাজার-বন্ধ ফাঁক</dt>
                          <dd className="text-right font-mono text-zinc-400">{tf.possibleClosureGaps}</dd>
                        </div>
                      </dl>
                      {tf.errorCodes.length > 0 && (
                        <p className="mt-2 border-t border-zinc-800/70 pt-1.5 text-[10px] leading-relaxed text-amber-300/80">
                          {tf.errorCodes.map((c) => bnForCode(c)).join(' ')}
                        </p>
                      )}
                    </div>
                  ))}
                  {marketStatus && marketStatus.readiness.timeframes.length === 0 && (
                    <p className="col-span-full rounded-lg border border-dashed border-zinc-800 p-3 text-center text-xs text-zinc-500">
                      কনফিগারকৃত টাইমফ্রেম নেই।
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Readiness verdict + sync */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <ShieldCheck className="h-4 w-4 text-amber-400" aria-hidden /> বিশ্লেষণ-প্রস্তুতি (Data Readiness)
                    </CardTitle>
                    <p className="text-xs text-zinc-500">
                      শুধুই ডেটা-প্রস্তুতি নির্দেশক — <span className="text-zinc-300">কোনো ট্রেড সিগন্যাল নয়</span>। প্রস্তুত না হলে ডাউনস্ট্রিম বিশ্লেষণ স্ট্রাকচার্ড “অনুপলব্ধ” ফল পায় — বানানো ক্যান্ডেল বা জোর করে BUY/SELL কখনোই নয়।
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={(marketStatus?.readiness.ready ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-red-500/40 bg-red-500/10 text-red-400')}>
                        {marketStatus?.readiness.ready ? 'প্রস্তুত (ready)' : 'প্রস্তুত নয় (not ready)'}
                      </Badge>
                      <Badge variant="outline" className={qualityStateBadgeClass(marketStatus?.readiness.qualityState ?? 'UNAVAILABLE')}>
                        quality: {marketStatus?.readiness.qualityState ?? '—'}
                      </Badge>
                      <span className="text-zinc-500">ডেটার বয়স: <span className="font-mono text-zinc-300">{fmtAge(marketStatus?.readiness.dataAgeSeconds)}</span></span>
                    </div>
                    {marketStatus && marketStatus.readiness.errorCodes.length > 0 ? (
                      <ul className="space-y-1">
                        {marketStatus.readiness.errorCodes.map((c) => (
                          <li key={c} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-400">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" aria-hidden />
                            <span>{bnForCode(c)} <span className="font-mono text-zinc-600">[{c}]</span></span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[11px] text-zinc-500">কোনো ত্রুটি কোড নেই — সব টাইমফ্রেম ও টিক সদ্য-সদ্য সতেজ।</p>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <Database className="h-4 w-4 text-amber-400" aria-hidden /> ডেটাবেস সিঙ্ক অবস্থা
                      {marketStatus?.sync.running && (
                        <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">চলছে…</Badge>
                      )}
                    </CardTitle>
                    <p className="text-xs text-zinc-500">আইডেমপোটেন্ট আপসার্ট — একই ক্যান্ডেল দুবার সিঙ্ক করলেও ডুপ্লিকেট রেকর্ড হয় না।</p>
                  </CardHeader>
                  <CardContent className="space-y-3 text-xs">
                    {([
                      ['সর্বশেষ রান', marketStatus?.sync.lastRun],
                      ['সর্বশেষ সফল', marketStatus?.sync.lastSuccess],
                      ['সর্বশেষ ব্যর্থ/আংশিক', marketStatus?.sync.lastFailure],
                    ] as Array<[string, SyncRunSummary | null | undefined]>).map(([label, run]) => (
                      <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-zinc-500">{label}</span>
                          {run ? (
                            <Badge variant="outline" className={run.status === 'success' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : run.status === 'partial' ? 'border-amber-500/40 bg-amber-500/10 text-amber-400' : 'border-red-500/40 bg-red-500/10 text-red-400'}>
                              {syncStatusBn(run.status)}
                            </Badge>
                          ) : (
                            <span className="text-zinc-600">এখনো নেই</span>
                          )}
                        </div>
                        {run && (
                          <p className="mt-1 font-mono text-[10px] leading-relaxed text-zinc-400">
                            {fmtDhaka(run.startedAtUtc)} · {run.mode} · {run.timeframes.join('/')}
                            {' '}· প্রাপ্ত {run.received} · নতুন {run.inserted} · আপডেট {run.updated} · বাতিল {run.rejected} · ডুপ {run.duplicates}
                            {run.durationMs != null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}
                            {run.errorCode ? ` · [${run.errorCode}]` : ''}
                          </p>
                        )}
                      </div>
                    ))}
                    <Button
                      onClick={() => void runSyncNow()}
                      disabled={syncing || !marketStatus}
                      className="w-full gap-2 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                      variant="outline"
                    >
                      {syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                      {syncing ? 'সিঙ্ক চলছে…' : 'এখনই সিঙ্ক করুন (ম্যানুয়াল)'}
                    </Button>
                  </CardContent>
                </Card>
              </div>

              {/* Data-quality issues */}
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden /> ডেটা-গুণমান সমস্যা (খোলা)
                    <Badge variant="outline" className="border-zinc-700 bg-zinc-800/60 text-zinc-400">{marketQuality?.openIssues.length ?? 0} টি</Badge>
                  </CardTitle>
                  <p className="text-xs text-zinc-500">প্রতি সিঙ্ক রানে সীমিত সংখ্যক সমস্যা সংরক্ষিত হয় (ফ্লাড নিয়ন্ত্রণ) — বিস্তারিত নিরাপদ ডায়াগনস্টিক।</p>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="custom-scrollbar max-h-96 overflow-y-auto">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
                        <TableRow className="border-zinc-800 hover:bg-transparent">
                          <TableHead className="pl-4 sm:pl-6">সময় (ঢাকা)</TableHead>
                          <TableHead>মাত্রা</TableHead>
                          <TableHead>কোড</TableHead>
                          <TableHead>টাইমফ্রেম</TableHead>
                          <TableHead className="pr-4 sm:pr-6">বিবরণ</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(marketQuality?.openIssues ?? []).map((i) => (
                          <TableRow key={i.id} className="border-zinc-800/70">
                            <TableCell className="whitespace-nowrap pl-4 text-xs tabular-nums text-zinc-500 sm:pl-6">{fmtDhaka(i.checkedAtUtc)}</TableCell>
                            <TableCell>
                              <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${levelBadgeClass(i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warn' : 'info')}`}>
                                {i.severity}
                              </span>
                            </TableCell>
                            <TableCell className="font-mono text-xs text-amber-300/80">{i.errorCode}</TableCell>
                            <TableCell className="font-mono text-xs text-zinc-400">{i.timeframe ?? '—'}</TableCell>
                            <TableCell className="pr-4 text-xs text-zinc-300 sm:pr-6">{bnForCode(i.errorCode)}{i.details?.detail ? <span className="block text-[10px] text-zinc-500">{i.details.detail}</span> : null}</TableCell>
                          </TableRow>
                        ))}
                        {marketQuality && marketQuality.openIssues.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={5} className="p-6 text-center text-sm text-zinc-500">
                              কোনো খোলা সমস্যা নেই।
                            </TableCell>
                          </TableRow>
                        )}
                        {!marketQuality && (
                          <TableRow>
                            <TableCell colSpan={5} className="p-6">
                              <Skeleton className="h-5 w-full" />
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ------------------------------------------------ Tab: analysis (Phase 4) */}
            <TabsContent value="analysis" className="space-y-4">
              {/* Fail-closed banner (analysis API unavailable) */}
              {analysisError && (
                <div
                  role="alert"
                  className="flex flex-col gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden />
                    <div>
                      <p className="text-sm font-semibold text-red-200">বিশ্লেষণ পরিষেবা এখন অনুপলব্ধ</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{bnForCode(analysisError)}</p>
                    </div>
                  </div>
                  <Badge variant="outline" className="w-fit shrink-0 border-zinc-600/50 bg-zinc-700/20 font-mono text-zinc-400">
                    {analysisError}
                  </Badge>
                </div>
              )}

              {/* Last-run card */}
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <Cpu className="h-4 w-4 text-amber-400" aria-hidden /> ডিটারমিনিস্টিক বিশ্লেষণ ইঞ্জিন
                    {analysisLatest?.latest ? (
                      <Badge variant="outline" className={analysisStatusClass[analysisLatest.latest.status] ?? ''}>
                        {analysisStatusBn[analysisLatest.latest.status] ?? analysisLatest.latest.status}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-zinc-600/50 bg-zinc-700/20 font-mono text-[10px] text-zinc-400">
                        এখনো কোনো রান নেই
                      </Badge>
                    )}
                  </CardTitle>
                  <p className="text-xs text-zinc-500">
                    কাঠামো (সুইং, HH/HL/LH/LL, BOS/CHoCH — ক্লোজ-নিশ্চিত) + সূচক (EMA 20/50/200, RSI 14, ATR 14, ADX 14 — Wilder)।
                    এটি <span className="text-amber-300">কেবল প্রযুক্তিগত বিশ্লেষণ — কোনো ট্রেড সিগন্যাল বা সুপারিশ নয়</span>। সিগন্যাল তৈরি Phase 5-এ হবে, এখানে নয়।
                  </p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {analysisLatest?.latest ? (
                    <>
                      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
                        {([
                          ['ইঞ্জিন', `v${analysisLatest.latest.engineVersion}`],
                          ['সিম্বল', analysisLatest.latest.symbol],
                          ['রানের সময় (ঢাকা)', fmtDhaka(analysisLatest.latest.startedAtUtc)],
                          ['সময়কাল', analysisLatest.latest.durationMs != null ? `${analysisLatest.latest.durationMs}ms` : '—'],
                          ['ফিঙ্গারপ্রিন্ট', analysisLatest.latest.inputFingerprint ? `${analysisLatest.latest.inputFingerprint.slice(0, 12)}…` : '—'],
                          ['টাইমফ্রেম', analysisLatest.latest.timeframes.join('/') || '—'],
                        ] as Array<[string, string]>).map(([k, v]) => (
                          <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                            <p className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</p>
                            <p className="mt-0.5 truncate font-mono text-zinc-200">{v}</p>
                          </div>
                        ))}
                      </div>
                      {analysisLatest.latest.reasonCodes.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {analysisLatest.latest.reasonCodes.map((c) => (
                            <Badge key={c} variant="outline" className="border-red-500/40 bg-red-500/10 font-mono text-[10px] text-red-300">
                              {c}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {analysisLatest.latest.analysis?.status === 'FAILED' && analysisLatest.latest.analysis.failureMessage && (
                        <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-2 font-mono text-[11px] text-red-300">
                          {analysisLatest.latest.analysis.failureMessage}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-zinc-500">এখনো কোনো বিশ্লেষণ চালানো হয়নি — নিচের বাটন দিয়ে চালান।</p>
                  )}

                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <Button onClick={() => void runAnalysisNow()} disabled={analysisRunning} className="gap-2">
                      {analysisRunning ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> চলছে…
                        </>
                      ) : (
                        <>
                          <Cpu className="h-4 w-4" aria-hidden /> বিশ্লেষণ চালান
                        </>
                      )}
                    </Button>
                    <p className="text-[11px] leading-relaxed text-zinc-600">
                      POST /api/analysis/run — সবসময় টোকেন দাবি করে (fail-closed)। ডেটা অবিশ্বস্ত হলে ফলাফল BLOCKED হবে, কখনো বানানো হবে না।
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* BLOCKED: honest verdict, nothing fabricated */}
              {analysisLatest?.latest?.analysis?.status === 'BLOCKED' && (
                <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
                  <p className="text-sm font-semibold text-amber-200">বিশ্লেষণ বন্ধ (BLOCKED) — সৎ ফলাফল</p>
                  <ul className="mt-2 space-y-1 text-xs leading-relaxed text-zinc-300">
                    {analysisLatest.latest.analysis.reasonCodes.map((c) => (
                      <li key={c} className="flex gap-2">
                        <span className="font-mono text-[10px] text-amber-300/80">{c}</span>
                        <span>{bnForCode(c)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-zinc-500">
                    কোনো কাঠামো বা সূচক বানানো হয়নি — ডেটা গেট fail-closed। ব্রিজ সচল ও ডেটা সতেজ হলে পরবর্তী রান সম্পূর্ণ হবে।
                  </p>
                </div>
              )}

              {/* Readiness chips per timeframe */}
              {analysisLatest?.latest?.analysis && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {analysisLatest.latest.analysis.readiness.map((r) => (
                    <Card key={r.timeframe} className="border-zinc-800 bg-zinc-900/40">
                      <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm">
                          <span className="font-mono">{r.timeframe}</span>
                          <Badge variant="outline" className={r.state === 'READY' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-red-500/40 bg-red-500/10 text-red-300'}>
                            {r.state === 'READY' ? 'প্রস্তুত' : 'বন্ধ'}
                          </Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-1.5 text-xs">
                        <div className="flex justify-between">
                          <span className="text-zinc-500">বন্ধ ক্যান্ডেল</span>
                          <span className="font-mono text-zinc-200">{r.closedCandles}/{r.requiredMinBars}</span>
                        </div>
                        {r.errorCodes.slice(0, 3).map((c) => (
                          <p key={c} className="font-mono text-[10px] text-red-300/90">{c}</p>
                        ))}
                        {r.warnings.slice(0, 2).map((w) => (
                          <p key={w} className="font-mono text-[10px] text-amber-300/80">{w}</p>
                        ))}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {/* COMPLETED: structure + indicators per timeframe */}
              {analysisLatest?.latest?.analysis?.status === 'COMPLETED' && analysisLatest.latest.analysis.perTimeframe && (
                <>
                  {analysisLatest.latest.analysis.timeframeContext && (
                    <div className="flex flex-col gap-2 rounded-xl border border-zinc-700/60 bg-zinc-900/60 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-zinc-100">
                          মাল্টি-টাইমফ্রেম প্রসঙ্গ — {alignmentBn[analysisLatest.latest.analysis.timeframeContext.alignment] ?? analysisLatest.latest.analysis.timeframeContext.alignment}
                        </p>
                        <p className="mt-0.5 text-xs text-zinc-400">{analysisLatest.latest.analysis.timeframeContext.note}</p>
                        <p className="mt-1 text-[11px] text-zinc-600">
                          বর্ণনামূলক পর্যবেক্ষণ মাত্র — কোনো সিগন্যাল নয় (descriptive-only-not-a-signal)।
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(analysisLatest.latest.analysis.timeframeContext.trendByTimeframe ?? {}).map(([tf, t]) => (
                          <Badge key={tf} variant="outline" className="font-mono text-[10px] text-zinc-400">
                            {tf}: {String(t)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    {Object.values(analysisLatest.latest.analysis.perTimeframe).map((a) => (
                      <Card key={a.timeframe} className="border-zinc-800 bg-zinc-900/40">
                        <CardHeader className="pb-3">
                          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                            <span className="font-mono">{a.timeframe}</span> কাঠামো
                            <Badge variant="outline" className={
                              a.structure.trend === 'bullish'
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                : a.structure.trend === 'bearish'
                                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                                  : 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400'
                            }>
                              {trendBn[a.structure.trend] ?? a.structure.trend}
                            </Badge>
                            <Badge variant="outline" className="font-mono text-[10px] text-zinc-400">{a.structure.highLabel}</Badge>
                            <Badge variant="outline" className="font-mono text-[10px] text-zinc-400">{a.structure.lowLabel}</Badge>
                          </CardTitle>
                          <p className="text-xs text-zinc-500">
                            {a.candleCount}টি বন্ধ ক্যান্ডেল · সোর্স {a.source} · সুইং উইন্ডো {analysisLatest.latest?.analysis?.calculationConfig.swingLeft}/{analysisLatest.latest?.analysis?.calculationConfig.swingRight}
                          </p>
                        </CardHeader>
                        <CardContent className="space-y-3 text-xs">
                          {/* indicators */}
                          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                            {([
                              ['EMA20', fmtInd(a.indicators.ema20?.last?.value)],
                              ['EMA50', fmtInd(a.indicators.ema50?.last?.value)],
                              ['EMA200', fmtInd(a.indicators.ema200?.last?.value)],
                              ['RSI14', fmtInd(a.indicators.rsi14?.last?.value, 1)],
                              ['ATR14', fmtInd(a.indicators.atr14?.last?.value)],
                              ['ADX14', fmtInd(a.indicators.adx14?.last?.value, 1)],
                            ] as Array<[string, string]>).map(([k, v]) => (
                              <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-center">
                                <p className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</p>
                                <p className="mt-0.5 font-mono text-sm text-amber-200">{v}</p>
                              </div>
                            ))}
                          </div>

                          {/* structure facts */}
                          <div className="space-y-1.5">
                            <div className="flex justify-between border-b border-zinc-800/60 pb-1.5">
                              <span className="text-zinc-500">নিশ্চিত সুইং</span>
                              <span className="font-mono text-zinc-200">{a.structure.confirmedSwings.length}</span>
                            </div>
                            <div className="flex justify-between border-b border-zinc-800/60 pb-1.5">
                              <span className="text-zinc-500">BOS/CHoCH ইভেন্ট</span>
                              <span className="font-mono text-zinc-200">{a.structure.events.length}</span>
                            </div>
                            <div className="flex justify-between border-b border-zinc-800/60 pb-1.5">
                              <span className="text-zinc-500">অ-নিশ্চিত উইক-ক্রসিং</span>
                              <span className="font-mono text-zinc-200">{a.structure.unconfirmedCrossings.length}</span>
                            </div>
                            {a.structure.events.length > 0 && (
                              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                                <p className="text-[10px] uppercase tracking-wide text-zinc-500">সর্বশেষ ইভেন্ট</p>
                                {(() => {
                                  const e = a.structure.events[a.structure.events.length - 1];
                                  return (
                                    <p className="mt-1 font-mono text-[11px] leading-relaxed text-zinc-300">
                                      {e.type} · {directionBn[e.direction] ?? e.direction} · স্তর <PriceLevelText value={e.level ?? e.levelText} spec={priceSpec} /> · ক্লোজ-নিশ্চিত ({e.basis}) ·{' '}
                                      {fmtDhaka(new Date(e.confirmedAtUtcSec * 1000).toISOString())}
                                    </p>
                                  );
                                })()}
                              </div>
                            )}
                            {a.indicatorIssues.length > 0 && (
                              <p className="font-mono text-[10px] text-red-300/90">{a.indicatorIssues.join(' · ')}</p>
                            )}
                            {a.warnings.length > 0 && (
                              <p className="font-mono text-[10px] text-amber-300/80">{a.warnings.join(' · ')}</p>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </>
              )}
            </TabsContent>

            {/* ------------------------------------------------ Tab: signal (Phase 9) */}
            <TabsContent value="signal" className="space-y-4">
              {/* Research-signal disclaimer */}
              <div role="note" className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
                <p className="text-xs leading-relaxed text-zinc-400">
                  সিগন্যাল ইঞ্জিন <span className="font-semibold text-amber-300">নির্ধারিত (deterministic)</span> — LLM এটি বদলাতে পারে না। ফলাফল শুধুমাত্র{' '}
                  <span className="font-semibold text-amber-300">গবেষণা/সিদ্ধান্ত-সহায়তা</span>, কোনো ট্রেড কার্যকর হয়নি এবং এই সিস্টেমে সেই ক্ষমতাই নেই (চার-সুইচ লক সক্রিয়)।
                  BUY_SETUP/SELL_SETUP হলেই লাভের প্রমাণ নয়।
                </p>
              </div>

              {/* Latest evaluation */}
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    সর্বশেষ সিগন্যাল মূল্যায়ন
                    {signalLatest?.signal && (
                      <Badge variant="outline" className={signalOutcomeBadgeClass(signalLatest.signal.outcome)}>
                        {signalOutcomeBn[signalLatest.signal.outcome] ?? signalLatest.signal.outcome}
                      </Badge>
                    )}
                    <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => void runSignalNow()} disabled={signalRunning}>
                      {signalRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Zap className="h-3.5 w-3.5" aria-hidden />}
                      মূল্যায়ন চালান
                    </Button>
                  </CardTitle>
                  <p className="text-xs text-zinc-500">
                    POST /api/signal/run — টোকেন-সুরক্ষিত ট্রিগার (fail-closed)। মূল্যায়ন ইতিহাস append-only — আগের ফলাফল কখনো মুছে বা আপডেট হয় না।
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!signalLatest?.signal && (
                    <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
                      এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি — উপরের বাটন দিয়ে চালান (DATA_API_TOKEN সেট থাকলে টোকেন লাগবে)।
                    </p>
                  )}
                  {signalLatest?.signal && (() => {
                    const s = signalLatest.signal;
                    return (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                            <p className="text-xs text-zinc-500">ইঞ্জিন / কৌশল</p>
                            <p className="mt-1 font-mono text-sm text-zinc-200">{s.engineVersion}</p>
                            <p className="font-mono text-xs text-zinc-500">{s.strategyVersion}</p>
                            <p className="text-xs text-zinc-600">সিম্বল: <span className="font-mono">{s.symbol}</span> · M15</p>
                          </div>
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                            <p className="text-xs text-zinc-500">সিদ্ধান্ত ক্যান্ডেল (M15)</p>
                            <p className="mt-1 text-sm text-zinc-200">{s.decisionCandleTimeUtc ? fmtDhaka(s.decisionCandleTimeUtc) : '—'}</p>
                            <p className="text-xs text-zinc-500">জানা গেছে: {s.setupKnownAtUtc ? fmtDhaka(s.setupKnownAtUtc) : '—'}</p>
                          </div>
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                            <p className="text-xs text-zinc-500">সেটআপ আঙ্গুলছাপ (10.3-A)</p>
                            {s.setupFingerprint ? (
                              <p className="mt-1 break-all font-mono text-xs text-zinc-300" title={s.setupFingerprint}>{s.setupFingerprint.slice(0, 16)}…</p>
                            ) : (
                              <p className="mt-1 text-xs text-zinc-500">আঙ্গুলছাপ নেই (legacy/অ-শনাক্ত)</p>
                            )}
                            <p className="text-xs text-zinc-600">একই লজিক্যাল সেটআপ = একই আঙ্গুলছাপ</p>
                          </div>
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                            <p className="text-xs text-zinc-500">ডেটাসেট ফিঙ্গারপ্রিন্ট</p>
                            <p className="mt-1 break-all font-mono text-xs text-zinc-300">{s.inputFingerprint ? s.inputFingerprint.slice(0, 16) : '—'}</p>
                            <p className="text-xs text-zinc-600">dataset: {s.datasetFingerprint ? s.datasetFingerprint.slice(0, 12) : '—'}</p>
                          </div>
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                            <p className="text-xs text-zinc-500">এক্সিকিউশন লক</p>
                            <p className="mt-1 text-sm text-zinc-200">{s.executionLocked ? 'সক্রিয় (read-only)' : '—'}</p>
                            <p className="text-xs text-zinc-600">
                              মেয়াদ: {s.expiryUtc ? (
                                <>{fmtDhaka(s.expiryUtc)}{new Date(s.expiryUtc).getTime() < Date.now() ? <span className="ml-1 text-amber-400">(মেয়াদোত্তীর্ণ)</span> : null}</>
                              ) : '—'}
                            </p>
                          </div>
                        </div>

                        {/* Reason codes */}
                        {s.reasonCodes.length > 0 && (
                          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                            <p className="text-xs font-semibold text-amber-300">
                              {s.outcome === 'BLOCKED' ? 'ব্লকের কারণ (সৎ, সংকেত নয়):' : 'কারণ-কোড:'}
                            </p>
                            <ul className="mt-1.5 space-y-1">
                              {s.reasonCodes.map((c) => (
                                <li key={c} className="text-xs leading-relaxed text-zinc-400">
                                  <span className="font-mono text-amber-400">{c}</span> — {bnForCode(c)}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Levels — ONLY for setups (Phase 10.3-C: verified-digits display, raw in tooltip) */}
                        {s.levels ? (() => {
                          const lv = s.levels;
                          const lvlZoneLow = formatPriceLevel(lv.entryZoneLow ?? lv.entryZoneLowText, priceSpec);
                          const lvlZoneHigh = formatPriceLevel(lv.entryZoneHigh ?? lv.entryZoneHighText, priceSpec);
                          const lvlSl = formatPriceLevel(lv.stopLoss ?? lv.stopLossText, priceSpec);
                          const lvlTp = formatPriceLevel(lv.target ?? lv.targetText, priceSpec);
                          const lvlRef = formatPriceLevel(lv.entryReference ?? lv.entryReferenceText, priceSpec);
                          const anyLevelAnomaly = [lvlZoneLow, lvlZoneHigh, lvlSl, lvlTp, lvlRef].some((r) => r.anomaly);
                          return (
                          <>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                              <p className="text-xs text-zinc-500">দিক</p>
                              <p className={`mt-1 text-sm font-semibold ${lv.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>
                                {lv.direction === 'BUY' ? 'BUY (লং)' : 'SELL (শর্ট)'}
                              </p>
                            </div>
                            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                              <p className="text-xs text-zinc-500">এন্ট্রি জোন</p>
                              <p className="mt-1 font-mono text-sm text-zinc-200" title={`raw: ${lvlZoneLow.rawText} / ${lvlZoneHigh.rawText}`}>
                                {lvlZoneLow.text}{lvlZoneLow.anomaly && <sup className="ml-0.5 text-amber-400" aria-label="precision anomaly">≈</sup>} – {lvlZoneHigh.text}{lvlZoneHigh.anomaly && <sup className="ml-0.5 text-amber-400" aria-label="precision anomaly">≈</sup>}
                              </p>
                            </div>
                            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                              <p className="text-xs text-zinc-500">স্টপ-লস</p>
                              <p className="mt-1 font-mono text-sm text-red-300" title={`raw: ${lvlSl.rawText}`}>
                                {lvlSl.text}{lvlSl.anomaly && <sup className="ml-0.5 text-amber-400" aria-label="precision anomaly">≈</sup>}
                              </p>
                            </div>
                            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                              <p className="text-xs text-zinc-500">টার্গেট</p>
                              <p className="mt-1 font-mono text-sm text-emerald-300" title={`raw: ${lvlTp.rawText}`}>
                                {lvlTp.text}{lvlTp.anomaly && <sup className="ml-0.5 text-amber-400" aria-label="precision anomaly">≈</sup>}
                              </p>
                            </div>
                            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                              <p className="text-xs text-zinc-500">Reward / Risk</p>
                              <p className="mt-1 font-mono text-sm text-zinc-200">1 : {lv.rewardRiskRatio.toFixed(2)}</p>
                              <p className="text-xs text-zinc-600">
                                রেফারেন্স এন্ট্রি{' '}
                                <span className="font-mono" title={`raw: ${lvlRef.rawText}`}>
                                  {lvlRef.text}{lvlRef.anomaly && <sup className="ml-0.5 text-amber-400" aria-label="precision anomaly">≈</sup>}
                                </span>{' '}
                                (স্প্রেড-সমন্বিত)
                              </p>
                            </div>
                          </div>
                          {(anyLevelAnomaly || !priceSpec.verified) && (
                            <p className="text-[11px] leading-relaxed text-amber-300/80">
                              {priceSpec.verified
                                ? '≈ চিহ্ন: raw গণনা-মান broker grid-এ নেই (derived) — verified digits-এ দেখানো হচ্ছে, raw মান tooltip-এ। সংরক্ষিত মান অপরিবর্তিত।'
                                : 'সিম্বল মেটাডেটা (digits) যাচাইকৃত নয় — কোনো default precision অনুমান না করে raw মান দেখানো হচ্ছে (≈ চিহ্নিত)।'}
                            </p>
                          )}
                          </>
                          );
                        })() : (
                          <p className="text-xs leading-relaxed text-zinc-500">
                            এই ফলাফলে কোনো লেভেল নেই — শুধুমাত্র BUY_SETUP/SELL_SETUP হলে সম্পূর্ণ, যাচাইকৃত লেভেল দেওয়া হয়।
                          </p>
                        )}

                        {/* Evidence */}
                        {s.evidence && (
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                            <p className="text-xs font-semibold text-zinc-400">প্রমাণ (deterministic)</p>
                            <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-zinc-400 sm:grid-cols-2">
                              {s.evidence.structureEvent ? (
                                <p>
                                  স্ট্রাকচার: <span className="font-mono text-zinc-300">{s.evidence.structureEvent.type} {directionBn[s.evidence.structureEvent.direction] ?? s.evidence.structureEvent.direction}</span>{' '}
                                  @ <PriceLevelText value={s.evidence.structureEvent.level ?? s.evidence.structureEvent.levelText} spec={priceSpec} className="font-mono text-zinc-300" /> ({s.evidence.structureEvent.barsSinceBreak} বার আগে, {fmtDhaka(s.evidence.structureEvent.breakCandleTimeUtc)})
                                </p>
                              ) : (
                                <p>স্ট্রাকচার ব্রেক: সাম্প্রতিক কোনো ব্রেক নেই</p>
                              )}
                              {s.evidence.anchorSwing ? (
                                <p>
                                  অ্যাঙ্কর সুইং: <PriceLevelText value={s.evidence.anchorSwing.price ?? s.evidence.anchorSwing.priceText} spec={priceSpec} className="font-mono text-zinc-300" /> ({s.evidence.anchorSwing.kind === 'low' ? 'সুইং লো' : 'সুইং হাই'}, {fmtDhaka(s.evidence.anchorSwing.swingTimeUtc)})
                                </p>
                              ) : (
                                <p>অ্যাঙ্কর সুইং: প্রযোজ্য নয়</p>
                              )}
                              <p>
                                ইন্ডিকেটর (M15): EMA50 <span className="font-mono text-zinc-300">{fmtInd(s.evidence.indicators.ema50)}</span> · RSI{' '}
                                <span className="font-mono text-zinc-300">{fmtInd(s.evidence.indicators.rsi14, 1)}</span> · ATR{' '}
                                <span className="font-mono text-zinc-300">{fmtInd(s.evidence.indicators.atr14)}</span> · ADX{' '}
                                <span className="font-mono text-zinc-300">{fmtInd(s.evidence.indicators.adx14, 1)}</span>
                              </p>
                              <p>
                                HTF প্রসঙ্গ: H1 <span className="font-mono text-zinc-300">{s.evidence.htfContext.h1Trend ? (trendBn[s.evidence.htfContext.h1Trend] ?? s.evidence.htfContext.h1Trend) : '—'}</span> · H4{' '}
                                <span className="font-mono text-zinc-300">{s.evidence.htfContext.h4Trend ? (trendBn[s.evidence.htfContext.h4Trend] ?? s.evidence.htfContext.h4Trend) : '—'}</span>
                              </p>
                              <p>রিটেস্ট বার: {s.evidence.retestBarTimeUtc ? fmtDhaka(s.evidence.retestBarTimeUtc) : 'এখনো হয়নি'}</p>
                              <p>
                                উইন্ডো: M15 {s.evidence.executionWindow.bars} · H1 {s.evidence.h1Window.bars} · H4 {s.evidence.h4Window.bars} ক্যান্ডেল
                              </p>
                            </div>
                          </div>
                        )}

                        {/* Data freshness at evaluation */}
                        {s.quote && (
                          <p className="text-xs text-zinc-500">
                            মূল্যায়নের সময় কোট: {String((s.quote as { freshness?: string }).freshness ?? '—')} · উৎস {String((s.quote as { sourceClass?: string }).sourceClass ?? '—')} ·{' '}
                            <PriceLevelText value={(s.quote as { bid?: string }).bid} spec={priceSpec} className="font-mono" /> / <PriceLevelText value={(s.quote as { ask?: string }).ask} spec={priceSpec} className="font-mono" /> ({String((s.quote as { ageSeconds?: number }).ageSeconds ?? '—')}s আগে)
                          </p>
                        )}

                        {/* Rules manifest — Phase 10.3-D (stored snapshot; 3 honest states) */}
                        {s.rulesSnapshot.status === 'present' && s.rulesSnapshot.snapshot && (() => {
                          const rs = s.rulesSnapshot.snapshot!;
                          const sourceBn: Record<string, string> = {
                            'verified-configuration': 'যাচাইকৃত কনফিগ',
                            'strategy-constant': 'কৌশল-ধ্রুবক',
                            'broker-metadata': 'ব্রোকার মেটাডেটা',
                            unavailable: 'অনুপলব্ধ',
                          };
                          return (
                            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                              <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-zinc-400">
                                নিয়ম-ম্যানিফেস্ট (এই মূল্যায়নে ব্যবহৃত)
                                <Badge variant="outline" className="border-zinc-700 bg-zinc-900 font-mono text-[10px] text-zinc-400">v{rs.rulesSnapshotVersion}</Badge>
                                <span className="break-all font-mono text-[10px] text-zinc-600" title={rs.snapshotHash}>hash {rs.snapshotHash.slice(0, 12)}…</span>
                              </p>
                              <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                                সংরক্ষিত স্ন্যাপশট — পরে কনফিগ বদলালেও এই সারির মান বদলায় না। নিয়ম = চালু থাকা কনফিগারেশন; পাস/ফেল অবস্থা কারণ-কোডে (উপরে)।
                              </p>
                              <div className="mt-2 max-h-64 overflow-y-auto custom-scrollbar space-y-1 pr-1" role="region" aria-label="নিয়ম-ম্যানিফেস্ট তালিকা">
                                {rs.rules.map((entry) => (
                                  <div key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded border border-zinc-800/60 bg-zinc-900/60 px-2 py-1 text-[11px]">
                                    <span className="break-all font-mono text-zinc-400">{entry.id}</span>
                                    <span className="font-mono text-zinc-200">
                                      = {entry.value === null ? 'null' : Array.isArray(entry.value) ? entry.value.join('+') : String(entry.value)}
                                    </span>
                                    <span className="text-zinc-600">{entry.unit}</span>
                                    <span className="ml-auto text-zinc-600" title={`source: ${entry.source}`}>{sourceBn[entry.source] ?? entry.source}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                        {s.rulesSnapshot.status === 'not-recorded' && (
                          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3" role="note">
                            <p className="text-xs text-amber-300">নিয়ম-স্ন্যাপশট: এই মূল্যায়নের জন্য রেকর্ড করা হয়নি (Not recorded for this evaluation)</p>
                            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                              পুরনো (legacy) সারি — 10.3-D-এর আগে নিয়ম শুধু ইনপুট-ফিঙ্গারপ্রিন্টের ভেতরে হ্যাশ আকারে সংরক্ষিত হতো। অনুমান করে বর্তমান কনফিগ দেখানো হয় না; এটি কৌশলের ব্যর্থতাও নয়। নতুন মূল্যায়নে স্বয়ংক্রিয়ভাবে স্ন্যাপশট সংরক্ষিত হবে।
                            </p>
                          </div>
                        )}
                        {s.rulesSnapshot.status === 'invalid' && (
                          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3" role="alert">
                            <p className="text-xs text-red-300">নিয়ম-স্ন্যাপশট অকার্যকর/অসংগত — নিরাপদে প্রত্যাখ্যাত</p>
                            <p className="mt-1 break-all font-mono text-[11px] text-zinc-500">কারণ: {s.rulesSnapshot.reason ?? 'অজানা'}</p>
                            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">এটি কৌশলের ব্যর্থতা নয় — সংরক্ষিত স্ন্যাপশটের গঠন/অখণ্ডতা যাচাইে ব্যর্থ। মূল্যায়নের ফলাফল ও কারণ-কোড অপরিবর্তিত।</p>
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* Backtest comparison (signal-engine strategy only) */}
                  {signalLatest?.backtestComparison && (() => {
                    const bt = signalLatest.backtestComparison;
                    const dev = bt.dev as { status?: string; executedTrades?: number; winRate?: number | null; profitFactor?: number | null; netPnlPrice?: number | null; reason?: string };
                    const oos = bt.oos as { status?: string; executedTrades?: number; winRate?: number | null; profitFactor?: number | null; netPnlPrice?: number | null; reason?: string };
                    return (
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                        <p className="text-xs font-semibold text-zinc-400">
                          সিগন্যাল-ইঞ্জিন backtest তুলনা ({bt.timeframe} · {bt.candleCount} ক্যান্ডেল · {new Date(bt.datasetFromUtc).toISOString().slice(0, 10)} → {new Date(bt.datasetToUtc).toISOString().slice(0, 10)})
                        </p>
                        <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                          <p className="text-zinc-400">
                            Dev: {dev.status === 'COMPUTED' ? `${dev.executedTrades} ট্রেড · উইনরেট ${(dev.winRate ?? 0) * 100}% · PF ${dev.profitFactor ?? '—'} · নিট <PriceQtyText value={dev.netPnlPrice} spec={priceSpec} className="font-mono" />` : `INSUFFICIENT_DATA (${dev.reason ?? ''})`}
                          </p>
                          <p className="text-zinc-400">
                            OOS: {oos.status === 'COMPUTED' ? `${oos.executedTrades} ট্রেড · উইনরেট ${(oos.winRate ?? 0) * 100}% · PF ${oos.profitFactor ?? '—'} · নিট <PriceQtyText value={oos.netPnlPrice} spec={priceSpec} className="font-mono" />` : `INSUFFICIENT_DATA (${oos.reason ?? ''})`}
                          </p>
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-zinc-600">
                          সিমুলেশন — লাভের প্রমাণ নয়। ছোট নমুনা সৎভাবে INSUFFICIENT_DATA। OOS সেগমেন্ট কখনো অপ্টিমাইজের জন্য ব্যবহার হয়নি।
                        </p>
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>

              {/* Recent evaluations — Phase 10.3-D (append-only trail; legacy rows labelled) */}
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                    সাম্প্রতিক মূল্যায়ন (append-only)
                    <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-400">read-only</Badge>
                    {signalHistory?.counts && (
                      <span className="ml-auto text-xs font-normal text-zinc-500">
                        মোট <span className="font-mono text-zinc-300">{signalHistory.counts.totalEvaluations}</span> মূল্যায়ন ·{' '}
                        <span className="font-mono text-zinc-300">{signalHistory.counts.distinctSetups}</span> স্বতন্ত্র সেটআপ
                      </span>
                    )}
                  </CardTitle>
                  <p className="text-xs text-zinc-500">
                    মূল্যায়ন-সংখ্যা ≠ স্বতন্ত্র সেটআপ-সংখ্যা — একই লজিক্যাল সেটআপ বারবার মূল্যায়ন হতে পারে (10.3-A dedup)। আঙুলছাপ-নেই সারি = legacy/অ-শনাক্ত — কোনো আইডি বানানো হয় না।
                  </p>
                </CardHeader>
                <CardContent>
                  {!signalHistory && (
                    <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500">
                      মূল্যায়ন-ইতিহাস এখন লোড করা যায়নি (সৎ খালি)।
                    </p>
                  )}
                  {signalHistory && signalHistory.history.length === 0 && (
                    <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500">
                      এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি — উপরের বাটন দিয়ে চালান।
                    </p>
                  )}
                  {signalHistory && signalHistory.history.length > 0 && (
                    <div className="max-h-72 overflow-y-auto custom-scrollbar space-y-1.5 pr-1" role="region" aria-label="সাম্প্রতিক মূল্যায়ন তালিকা">
                      {signalHistory.history.map((h) => (
                        <div key={h.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                          <span className="text-zinc-400">{fmtDhaka(h.createdAt)}</span>
                          <Badge variant="outline" className={signalOutcomeBadgeClass(h.outcome)}>
                            {signalOutcomeBn[h.outcome] ?? h.outcome}
                          </Badge>
                          {h.reasonCodes.length > 0 && (
                            <span className="break-all font-mono text-[10px] text-zinc-500">{h.reasonCodes.join(', ')}</span>
                          )}
                          {h.setupFingerprint ? (
                            <span className="ml-auto break-all font-mono text-[10px] text-zinc-600" title={h.setupFingerprint}>
                              সেটআপ {h.setupFingerprint.slice(0, 10)}…
                            </span>
                          ) : (
                            <span className="ml-auto text-[10px] text-zinc-600">আঙুলছাপ নেই (legacy/অ-শনাক্ত)</span>
                          )}
                          {h.rulesSnapshot.status === 'not-recorded' && (
                            <span className="text-[10px] text-amber-500/80" title="Not recorded for this evaluation">নিয়ম-রেকর্ড নেই</span>
                          )}
                          {h.rulesSnapshot.status === 'invalid' && (
                            <span className="text-[10px] text-red-400/80" title={`অকার্যকর স্ন্যাপশট: ${h.rulesSnapshot.reason ?? ''}`}>স্ন্যাপশট অকার্যকর</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ------------------------------------------- Tab: validation (Phase 10) */}
            <TabsContent value="validation" className="space-y-4">
              {/* Honest-simulation disclaimer */}
              <div role="note" className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
                <p className="text-xs leading-relaxed text-zinc-400">
                  এটি <span className="font-semibold text-amber-300">Phase 10 কৌশল-ভ্যালিডেশন</span> — যাচাইকৃত ব্রোকার ক্যান্ডেলের ওপর সিমুলেশন, লাভজনকতার প্রমাণ কখনোই নয়। সিদ্ধান্ত নির্ধারিত নিয়মে (pre-registered) — পর্যাপ্ত OOS নমুনা না থাকলে <span className="font-semibold text-amber-300">INCONCLUSIVE</span>। প্যারামিটার কোনো ফলাফল লুকাতে বদলানো হয়নি।
                </p>
              </div>

              {!validationLatest?.validation && (
                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardContent className="p-6">
                    <p className="text-sm text-zinc-400">
                      এখনো কোনো ভ্যালিডেশন রান সংরক্ষিত হয়নি — সৎ খালি অবস্থা। রান তৈরি হলে এখানে dev / validation / OOS ফলাফল আলাদাভাবে দেখা যাবে।
                    </p>
                  </CardContent>
                </Card>
              )}

              {validationLatest?.validation && (() => {
                const v = validationLatest.validation;
                const r = v.result;
                const segLabel: Record<'dev' | 'val' | 'oos', string> = { dev: 'Development (৫০%)', val: 'Validation (২০%)', oos: 'Out-of-Sample (৩০%) — অছুঁয়া' };
                const segBn: Record<'dev' | 'val' | 'oos', string> = { dev: 'ডেভেলপমেন্ট', val: 'ভ্যালিডেশন', oos: 'আউট-অব-স্যাম্পল' };
                const conclusionClass =
                  r.interpretation.conclusion === 'NEGATIVE_AFTER_COSTS'
                    ? 'border-red-500/40 bg-red-500/10 text-red-300'
                    : r.interpretation.conclusion === 'PROMISING_CONTINUE_FORWARD'
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-300';
                const pnlClass = (x: number | null | undefined) => (x === null || x === undefined ? 'text-zinc-500' : x < 0 ? 'text-red-400' : 'text-zinc-200');

                return (
                  <>
                    {/* Interpretation header */}
                    <Card className="border-zinc-800 bg-zinc-900/40">
                      <CardHeader className="pb-3">
                        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                          সামগ্রিক সিদ্ধান্ত (নির্ধারিত নিয়মে)
                          <Badge variant="outline" className={conclusionClass}>{r.interpretation.conclusion}</Badge>
                          <Badge variant="outline" className="ml-auto border-zinc-700 bg-zinc-900 text-zinc-400 font-mono text-[10px]">
                            {v.harnessVersion}
                          </Badge>
                        </CardTitle>
                        <p className="text-xs text-zinc-500">
                          রান: {fmtDhaka(v.createdAt)} · কৌশল <span className="font-mono">{v.strategyVersion}</span> · সময় {v.durationMs}ms
                        </p>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <ul className="space-y-1">
                          {r.interpretation.reasons.map((reason, i) => (
                            <li key={i} className="text-xs leading-relaxed text-zinc-400">· {reason}</li>
                          ))}
                        </ul>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                            <p className="text-xs text-zinc-500">ডেটাসেট ফিঙ্গারপ্রিন্ট</p>
                            <p className="mt-1 break-all font-mono text-xs text-zinc-300">{r.datasetFingerprint.slice(0, 20)}…</p>
                          </div>
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                            <p className="text-xs text-zinc-500">কভারেজ (M15)</p>
                            <p className="mt-1 text-sm text-zinc-200">{fmtDhaka(new Date(r.dataset.fromUtcSec * 1000).toISOString())}</p>
                            <p className="text-xs text-zinc-600">→ {fmtDhaka(new Date(r.dataset.toUtcSec * 1000).toISOString())}</p>
                          </div>
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                            <p className="text-xs text-zinc-500">ক্যান্ডেল (M15/H1/H4)</p>
                            <p className="mt-1 font-mono text-sm text-zinc-200">{r.dataset.executionCandles} / {r.dataset.h1Candles} / {r.dataset.h4Candles}</p>
                          </div>
                          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                            <p className="text-xs text-zinc-500">স্প্রেড অনুমান</p>
                            <p className="mt-1 font-mono text-sm text-amber-300">
                              <PriceQtyText value={r.dataset.observedSpreadPrice} spec={priceSpec} />
                            </p>
                            <p className="text-xs text-zinc-600">বর্তমান পর্যবেক্ষণ — ঐতিহাসিক নয়</p>
                          </div>
                        </div>
                        <p className="text-xs text-zinc-500">
                          কাউন্টার: মূল্যায়ন {r.counters.evaluations} · ব্লকড {r.counters.blockedEvaluations} · NO_SETUP {r.counters.noSetup} · WAIT {r.counters.wait} · ক্যান্ডিডেট {r.counters.candidateSetups} · ভ্যালিড সেটআপ {r.counters.validSetups} · ফিল {r.counters.hypotheticalFills} · সম্পন্ন {r.counters.completedOutcomes}
                        </p>
                      </CardContent>
                    </Card>

                    {/* Three segments */}
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                      {(['dev', 'val', 'oos'] as const).map((key) => {
                        const m = r.segments[key];
                        return (
                          <Card key={key} className="border-zinc-800 bg-zinc-900/40">
                            <CardHeader className="pb-2">
                              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                                {segBn[key]}
                                {m.status === 'INSUFFICIENT_DATA' ? (
                                  <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300">INSUFFICIENT_DATA</Badge>
                                ) : (
                                  <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-400">{m.trades} ট্রেড</Badge>
                                )}
                              </CardTitle>
                              <p className="text-xs text-zinc-500">{segLabel[key]}</p>
                            </CardHeader>
                            <CardContent>
                              {m.status === 'INSUFFICIENT_DATA' ? (
                                <p className="text-xs leading-relaxed text-zinc-400">{m.reason ?? 'নমুনা অপর্যাপ্ত — মেট্রিক বানানো হয়নি।'}</p>
                              ) : (
                                <dl className="space-y-1.5 text-xs">
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">কভারেজ</dt><dd className="text-zinc-300">{m.candles} বার</dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">উইন-রেট</dt><dd className="text-zinc-200">{fmtInd(m.winRate !== null ? m.winRate * 100 : null, 1)}%</dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">গ্রস (খরচ-পূর্ব)</dt><dd className={pnlClass(m.grossPnlPrice)}><PriceQtyText value={m.grossPnlPrice} spec={priceSpec} /></dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">মডেলড খরচ</dt><dd className="text-zinc-400">−<PriceQtyText value={m.costsPrice} spec={priceSpec} /></dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">নেট (খরচ-পর)</dt><dd className={pnlClass(m.netPnlPrice)}><PriceQtyText value={m.netPnlPrice} spec={priceSpec} /></dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">প্রফিট ফ্যাক্টর</dt><dd className="text-zinc-200">{fmtInd(m.profitFactor, 2)}</dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">এক্সপেক্ট্যান্সি / ট্রেড</dt><dd className={pnlClass(m.expectancyPrice)}><PriceQtyText value={m.expectancyPrice} spec={priceSpec} /></dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">গড় R</dt><dd className={pnlClass(m.expectancyR)}>{fmtInd(m.expectancyR, 3)}</dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">সর্বোচ্চ ড্রডাউন</dt><dd className="text-red-400"><PriceQtyText value={m.maxDrawdownPrice} spec={priceSpec} /></dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">সর্বোচ্চ পরপর লস</dt><dd className="text-red-400">{m.maxConsecutiveLosses}</dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">এক্সপোজার</dt><dd className="text-zinc-200">{fmtInd(m.exposurePct, 1)}%</dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">ট্রেড / সপ্তাহ</dt><dd className="text-zinc-200">{fmtInd(m.tradesPerWeek, 2)}</dd></div>
                                  <div className="flex justify-between gap-2"><dt className="text-zinc-500">টপ-১ লাভের অংশ</dt><dd className="text-zinc-200">{fmtInd(m.concentration.top1GrossShare !== null ? m.concentration.top1GrossShare * 100 : null, 1)}%</dd></div>
                                </dl>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>

                    {/* Walk-forward */}
                    <Card className="border-zinc-800 bg-zinc-900/40">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">ওয়াক-ফরোয়ার্ড — ক্রমিক সময়-উইন্ডো</CardTitle>
                        <p className="text-xs leading-relaxed text-zinc-500">{r.walkForward.note}</p>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        <div className="max-h-64 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
                          {r.walkForward.windows.map((w) => (
                            <div key={w.index} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                              <span className="font-mono text-zinc-500">w{w.index}</span>
                              <span className="text-zinc-400">{fmtDhaka(new Date(w.fromUtcSec * 1000).toISOString())} → {fmtDhaka(new Date(w.toUtcSec * 1000).toISOString())}</span>
                              <span className="text-zinc-600">{w.candles} বার</span>
                              {w.metrics.status === 'COMPUTED' ? (
                                <span className="ml-auto flex flex-wrap items-center gap-2">
                                  <span className="text-zinc-300">{w.metrics.trades} ট্রেড</span>
                                  <span className={pnlClass(w.metrics.netPnlPrice)}>নেট <PriceQtyText value={w.metrics.netPnlPrice} spec={priceSpec} /></span>
                                  <span className="text-zinc-400">PF {fmtInd(w.metrics.profitFactor, 2)}</span>
                                </span>
                              ) : (
                                <span className="ml-auto text-amber-400">INSUFFICIENT_DATA ({w.metrics.trades})</span>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs">
                          <span className="text-zinc-400">সমষ্টি: </span>
                          {r.walkForward.aggregate.status === 'COMPUTED' ? (
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-zinc-300">{r.walkForward.aggregate.trades} ট্রেড</span>
                              <span className={pnlClass(r.walkForward.aggregate.netPnlPrice)}>নেট <PriceQtyText value={r.walkForward.aggregate.netPnlPrice} spec={priceSpec} /></span>
                              <span className="text-zinc-400">PF {fmtInd(r.walkForward.aggregate.profitFactor, 2)}</span>
                            </span>
                          ) : (
                            <span className="text-amber-400">INSUFFICIENT_DATA — {r.walkForward.aggregate.reason}</span>
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Sensitivity + Perturbations */}
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <Card className="border-zinc-800 bg-zinc-900/40">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm">খরচ-সংবেদনশীলতা (একই ট্রেড-তালিকা)</CardTitle>
                          <p className="text-xs text-zinc-500">স্প্রেড বাড়ালে ফল কখনো ভালো হয় না — সীমানা পরীক্ষা, পূর্বাভাস নয়।</p>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-1.5">
                            {r.sensitivity.map((s) => (
                              <div key={s.scenario} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                                <span className="font-mono text-zinc-400">{s.scenario}</span>
                                <span className="text-zinc-600">spr <PriceQtyText value={s.spreadPrice} spec={priceSpec} /> / slip <PriceQtyText value={s.slippagePrice} spec={priceSpec} /> / comm <PriceQtyText value={s.commissionPrice} spec={priceSpec} /></span>
                                <span className="ml-auto flex items-center gap-2">
                                  <span className={pnlClass(s.netPnlPrice)}>নেট <PriceQtyText value={s.netPnlPrice} spec={priceSpec} /></span>
                                  <span className="text-zinc-400">PF {fmtInd(s.profitFactor, 2)}</span>
                                  {!s.netPositive && <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-300">ঋণাত্মক</Badge>}
                                </span>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="border-zinc-800 bg-zinc-900/40">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm">প্যারামিটার পার্টার্বেশন — পূর্ণ সেট</CardTitle>
                          <p className="text-xs text-zinc-500">কোনো ভ্যারিয়েন্ট বাছাই করা হয়নি; প্রোডাকশন কনফিগ অপরিবর্তিত।</p>
                        </CardHeader>
                        <CardContent>
                          <div className="max-h-64 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
                            {r.perturbations.map((p, i) => (
                              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                                <span className="font-mono text-zinc-400">{p.param === '(baseline)' ? '(বেসলাইন)' : `${p.param}`}</span>
                                {p.param !== '(baseline)' && <span className="font-mono text-zinc-500">= {p.value}</span>}
                                <span className="ml-auto flex items-center gap-2">
                                  <span className="text-zinc-300">{p.trades} ট্রেড</span>
                                  <span className={pnlClass(p.netPnlPrice)}>নেট <PriceQtyText value={p.netPnlPrice} spec={priceSpec} /></span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    </div>

                    {/* Paper signals */}
                    <Card className="border-zinc-800 bg-zinc-900/40">
                      <CardHeader className="pb-2">
                        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                          ফরোয়ার্ড পেপার-সিগন্যাল ট্র্যাকিং
                          <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-400">read-only</Badge>
                        </CardTitle>
                        <p className="text-xs text-zinc-500">SETUP সিগন্যালের পরে দাম আসলে কী করেছে — ব্রোকার অর্ডার কোথাও নেই (ক্ষমতাই নেই)। প্রতি সিগন্যালে ঠিক একটি ফলাফল — ডুপ্লিকেট অসম্ভব।</p>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {/* Phase 10.3-D — three DIFFERENT counts, never conflated */}
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
                            <p className="text-[11px] text-zinc-500">মোট মূল্যায়ন (সব ফলাফল)</p>
                            <p className="mt-0.5 text-sm font-semibold text-zinc-200">{signalHistory?.counts ? signalHistory.counts.totalEvaluations : '—'}</p>
                          </div>
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
                            <p className="text-[11px] text-zinc-500">স্বতন্ত্র লজিক্যাল সেটআপ</p>
                            <p className="mt-0.5 text-sm font-semibold text-zinc-200">{signalHistory?.counts ? signalHistory.counts.distinctSetups : '—'}</p>
                          </div>
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
                            <p className="text-[11px] text-zinc-500">পেপার-ফলাফল সারি (নিচের গ্রিড)</p>
                            <p className="mt-0.5 text-sm font-semibold text-zinc-200">{validationLatest.paper.total}</p>
                          </div>
                        </div>
                        <p className="text-[11px] leading-relaxed text-zinc-600">
                          তিনটি সংখ্যা আলাদা ধারণা: মূল্যায়ন = append-only ইতিহাসের সারি; স্বতন্ত্র সেটআপ = ইউনিক সেটআপ-আঙ্গুলছাপ (10.3-A); পেপার-ফলাফল = প্রতি সেটআপে ঠিক একটি forward ট্র্যাকিং সারি। পেপার-ফলাফল কখনোই আসল ব্রোকার ট্রেড নয়।
                        </p>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                          {[
                            { label: 'মোট', value: String(validationLatest.paper.total) },
                            { label: 'খোলা', value: String(validationLatest.paper.open) },
                            { label: 'স্টপড', value: String(validationLatest.paper.resolved.stopped) },
                            { label: 'টার্গেটেড', value: String(validationLatest.paper.resolved.targeted) },
                            { label: 'ইনভ্যালিডেড', value: String(validationLatest.paper.resolved.invalidated) },
                            { label: 'এক্সপায়ার্ড', value: String(validationLatest.paper.resolved.expired) },
                            { label: 'গড় R', value: validationLatest.paper.avgR !== null ? fmtInd(validationLatest.paper.avgR, 3) : '—' },
                          ].map((cell) => (
                            <div key={cell.label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
                              <p className="text-[11px] text-zinc-500">{cell.label}</p>
                              <p className="mt-0.5 text-sm font-semibold text-zinc-200">{cell.value}</p>
                            </div>
                          ))}
                        </div>
                        {validationLatest.paper.outcomes.length === 0 ? (
                          <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400">
                            এখনো কোনো SETUP সিগন্যাল হয়নি — ট্র্যাক করার কিছু নেই (সৎ খালি)। সিগন্যাল তৈরি হলে প্রতি ৫ মিনিটের শিডিউল্ড সিঙ্কের পর স্বয়ংক্রিয়ভাবে অনুসরণ হবে।
                          </p>
                        ) : (
                          <div className="max-h-64 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
                            {validationLatest.paper.outcomes.map((o) => (
                              <div key={o.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                                <Badge variant="outline" className={o.direction === 'BUY' ? 'border-emerald-500/40 text-emerald-300' : 'border-red-500/40 text-red-300'}>{o.direction}</Badge>
                                <span className="text-zinc-400">{fmtDhaka(o.signalCreatedAtUtc)}</span>
                                <span className="font-mono text-zinc-500">এন্ট্রি <PriceLevelText value={o.entryReference} spec={priceSpec} /></span>
                                {o.outcome && <Badge variant="outline" className="border-zinc-700 text-zinc-300">{o.outcome}</Badge>}
                                {o.rMultiple !== null && <span className={pnlClass(o.rMultiple)}>R {fmtInd(o.rMultiple, 2)}</span>}
                                <span className="ml-auto text-zinc-600">{o.observations} বার দেখা</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* Warnings + limitations */}
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <Card className="border-amber-500/30 bg-amber-500/5">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm text-amber-300">সতর্কতা</CardTitle>
                        </CardHeader>
                        <CardContent>
                          {r.warnings.length === 0 ? (
                            <p className="text-xs text-zinc-400">কোনো সতর্কতা নেই।</p>
                          ) : (
                            <ul className="max-h-56 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
                              {r.warnings.map((w, i) => (
                                <li key={i} className="text-xs leading-relaxed text-zinc-400">⚠ {w}</li>
                              ))}
                            </ul>
                          )}
                        </CardContent>
                      </Card>
                      <Card className="border-zinc-800 bg-zinc-900/40">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm">পরিচিত সীমাবদ্ধতা</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <ul className="max-h-56 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
                            {r.limitations.map((l, i) => (
                              <li key={i} className="text-xs leading-relaxed text-zinc-500">· {l}</li>
                            ))}
                          </ul>
                        </CardContent>
                      </Card>
                    </div>
                  </>
                );
              })()}

              {/* ---------------- Forward paper validation (Phase 10.2, pre-registered) */}
              {validationLatest?.forwardPaper && (() => {
                const fp = validationLatest.forwardPaper;
                const fpPnl = (x: number | null | undefined) =>
                  x === null || x === undefined ? 'text-zinc-500' : x < 0 ? 'text-red-400' : 'text-zinc-200';
                const verdictBadge =
                  fp.verdict.conclusion === 'NEGATIVE_AFTER_COSTS'
                    ? 'border-red-500/40 bg-red-500/10 text-red-300'
                    : fp.verdict.conclusion === 'PROMISING_CONTINUE_FORWARD'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                      : 'border-zinc-600 bg-zinc-800/60 text-zinc-300';
                const verdictBn: Record<string, string> = {
                  IN_PROGRESS: 'পর্যবেক্ষণ চলছে',
                  INCONCLUSIVE_TIMEOUT: 'সময়সীমা শেষ — অনির্ণীত',
                  NEGATIVE_AFTER_COSTS: 'ঋণাত্মক (খরচ-পরবর্তী)',
                  INCONCLUSIVE_CONCENTRATION: 'অনির্ণীত — ঘনত্ব বেশি',
                  INCONCLUSIVE_DRAWDOWN: 'অনির্ণীত — ঝুঁকি সীমার বাইরে',
                  PROMISING_CONTINUE_FORWARD: 'সামনে এগোনোর প্রমাণ (দাবি নয়)',
                };
                return (
                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-2">
                      <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                        ফরোয়ার্ড পেপার ভ্যালিডেশন — Phase 10.2
                        <Badge variant="outline" className={verdictBadge}>{verdictBn[fp.verdict.conclusion] ?? fp.verdict.conclusion}</Badge>
                        <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-500">প্রি-রেজিস্টার্ড</Badge>
                      </CardTitle>
                      <p className="text-xs text-zinc-500">
                        ফলাফল জমার <span className="text-amber-300">আগেই</span> নিয়ম দৃঢ় করা হয়েছে (first-open গণনা, ২০ ট্রেড ফ্লোর, ৯০ দিন সীমা, ঝুঁকি গেট)। একই সেটআপের পুনরাবৃত্তি পর্যবেক্ষণ কখনো আলাদা ট্রেড নয়। এটি লাভজনকতার দাবি বা ডেমো execution-এর অনুমতি নয়।
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                        {[
                          { label: 'সম্পন্ন ট্রেড', value: `${fp.progress.countedCompleted} / ${fp.protocol.minCompletedTrades}` },
                          { label: 'খোলা', value: String(fp.progress.openCounted) },
                          { label: 'পুনরাবৃত্তি (বাদ)', value: String(fp.progress.repeatObservations) },
                          { label: 'অপর্যবেক্ষিত', value: String(fp.progress.unobservableResolved) },
                          { label: 'অতিবাহিত দিন', value: fmtInd(fp.progress.elapsedDays, 1) },
                          { label: 'অবশিষ্ট দিন', value: fmtInd(fp.progress.daysRemaining, 1) },
                        ].map((cell) => (
                          <div key={cell.label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
                            <p className="text-[11px] text-zinc-500">{cell.label}</p>
                            <p className="mt-0.5 text-sm font-semibold text-zinc-200">{cell.value}</p>
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                        <span>সক্রিয়করণ: <span className="font-mono text-zinc-400">{fmtDhaka(fp.protocol.activatedAtUtc)}</span></span>
                        <span>সময়সীমা: <span className="font-mono text-zinc-400">{fmtDhaka(fp.protocol.deadlineUtc)}</span></span>
                        <span>নিয়ম সংস্করণ: <span className="font-mono text-zinc-400">{fp.protocol.rulesVersion}</span></span>
                      </div>

                      {fp.metrics && (
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
                          {[
                            { label: 'n', value: String(fp.metrics.trades) },
                            { label: 'উইন রেট', value: fmtInd(fp.metrics.winRate !== null ? fp.metrics.winRate * 100 : null, 1) + '%' },
                            { label: 'নেট', value: <PriceQtyText key="net" value={fp.metrics.netPnlPrice} spec={priceSpec} />, cls: fpPnl(fp.metrics.netPnlPrice) },
                            { label: 'PF', value: fmtInd(fp.metrics.profitFactor, 2) },
                            { label: 'গড় R', value: fmtInd(fp.metrics.avgR, 3), cls: fpPnl(fp.metrics.avgR) },
                            { label: 'সর্বোচ্চ ড্রডাউন', value: `${fmtInd(fp.metrics.maxDrawdownR, 2)}R` },
                            { label: 'পরপর লস', value: String(fp.metrics.maxConsecutiveLosses) },
                            { label: 'টপ-১ শেয়ার', value: fp.metrics.top1NetShare !== null ? fmtInd(fp.metrics.top1NetShare * 100, 1) + '%' : '—' },
                          ].map((cell) => (
                            <div key={cell.label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
                              <p className="text-[11px] text-zinc-500">{cell.label}</p>
                              <p className={`mt-0.5 text-sm font-semibold ${cell.cls ?? 'text-zinc-200'}`}>{cell.value}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      <ul className="space-y-1">
                        {fp.verdict.reasons.map((r, i) => (
                          <li key={i} className="text-xs leading-relaxed text-zinc-400">· {r}</li>
                        ))}
                      </ul>

                      {fp.recentTrades.length === 0 ? (
                        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400">
                          এখনো কোনো গণনাকৃত ট্রেড নেই — সৎ খালি অবস্থা। শিডিউল্ড সিঙ্কের পর ইঞ্জিন স্বয়ংক্রিয়ভাবে মূল্যায়ন করছে; SETUP তৈরি হলে এখানে জমতে থাকবে।
                        </p>
                      ) : (
                        <div className="max-h-64 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
                          {fp.recentTrades.map((t) => (
                            <div key={t.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                              <Badge variant="outline" className={t.direction === 'BUY' ? 'border-emerald-500/40 text-emerald-300' : 'border-red-500/40 text-red-300'}>{t.direction}</Badge>
                              <span className="text-zinc-400">{fmtDhaka(t.signalCreatedAtUtc)}</span>
                              <span className="font-mono text-zinc-500">এন্ট্রি <PriceLevelText value={t.entryReference} spec={priceSpec} /></span>
                              {t.status === 'open' ? (
                                <Badge variant="outline" className="border-amber-500/40 text-amber-300">খোলা</Badge>
                              ) : (
                                <>
                                  {t.outcome && <Badge variant="outline" className="border-zinc-700 text-zinc-300">{t.outcome}</Badge>}
                                  {t.rMultiple !== null && <span className={fpPnl(t.rMultiple)}>R {fmtInd(t.rMultiple, 2)}</span>}
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="text-[11px] leading-relaxed text-zinc-600">
                        ⚠ {fp.verdict.disclaimer}
                      </p>
                    </CardContent>
                  </Card>
                );
              })()}
            </TabsContent>

            {/* ------------------------------------------------ Tab: chat (Phase 9) */}
            <TabsContent value="chat" className="space-y-4">
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <Languages className="h-4 w-4 text-amber-400" aria-hidden />
                    বাংলা চ্যাট এজেন্ট — নিরাপদ টুল-ব্যবহার
                  </CardTitle>
                  <p className="text-xs leading-relaxed text-zinc-500">
                    এজেন্ট শুধুমাত্র অনুমোদিত (allowlisted) read-only টুল ব্যবহার করতে পারে — get_market_health, get_latest_quote, get_candle_coverage, get_latest_analysis, get_latest_signal, get_backtest_summary, explain_signal_evidence।
                    LLM সিগন্যাল/লেভেল/ব্লক-স্ট্যাটাস বদলাতে পারে না — deterministic অবস্থা উত্তরের সাথে আলাদাভাবে দেখানো হয়।
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Messages */}
                  <div className="max-h-[26rem] space-y-3 overflow-y-auto custom-scrollbar rounded-lg border border-zinc-800 bg-zinc-950/60 p-4" aria-live="polite">
                    {chatMessages.length === 0 && (
                      <div className="space-y-3 py-6 text-center">
                        <Bot className="mx-auto h-8 w-8 text-zinc-700" aria-hidden />
                        <p className="text-sm text-zinc-500">প্রশ্ন করুন — যেমন:</p>
                        <div className="flex flex-wrap justify-center gap-2">
                          {[
                            'এখন XAUUSDm-এর বাজারের অবস্থা কী?',
                            'M15 ও H1 ট্রেন্ড কী?',
                            'সর্বশেষ সিগন্যাল কেন BLOCKED?',
                            'H4 ইতিহাস কত দিনের?',
                            'সর্বশেষ backtest কী বলছে?',
                          ].map((q) => (
                            <button
                              key={q}
                              type="button"
                              onClick={() => setChatInput(q)}
                              className="rounded-full border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-amber-500/40 hover:text-amber-300"
                            >
                              {q}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {chatMessages.map((m, i) => (
                      <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[85%] rounded-xl border px-3.5 py-2.5 text-sm leading-relaxed ${
                            m.role === 'user'
                              ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                              : 'border-zinc-800 bg-zinc-900/70 text-zinc-200'
                          }`}
                        >
                          <p className="whitespace-pre-wrap">{m.content}</p>
                          {/* Deterministic state block — always separate from LLM text */}
                          {m.role === 'assistant' && m.meta && (
                            <div className="mt-2.5 space-y-1.5 border-t border-zinc-800 pt-2">
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                                নির্ধারিত ডেটা অবস্থা (LLM টেক্সট থেকে আলাদা, সর্বোচ্চ কর্তৃত্ব)
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {m.meta.dataState.quoteFreshness && (
                                  <Badge variant="outline" className={m.meta.dataState.quoteFreshness === 'LIVE' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-amber-500/40 bg-amber-500/10 text-amber-400'}>
                                    কোট: {m.meta.dataState.quoteFreshness}
                                  </Badge>
                                )}
                                {m.meta.dataState.quoteSourceClass && (
                                  <Badge variant="outline" className="border-zinc-700 bg-zinc-800/50 text-zinc-400">
                                    উৎস: {m.meta.dataState.quoteSourceClass}
                                  </Badge>
                                )}
                                {m.meta.dataState.bid && (
                                  <Badge variant="outline" className="border-zinc-700 bg-zinc-800/50 font-mono text-zinc-300">
                                    <PriceLevelText value={m.meta.dataState.bid} spec={priceSpec} /> / <PriceLevelText value={m.meta.dataState.ask} spec={priceSpec} />
                                  </Badge>
                                )}
                                {m.meta.dataState.latestSignalOutcome && (
                                  <Badge variant="outline" className={signalOutcomeBadgeClass(m.meta.dataState.latestSignalOutcome)}>
                                    সিগন্যাল: {m.meta.dataState.latestSignalOutcome}
                                    {m.meta.dataState.latestSignalReasonCodes.length > 0 ? ` (${m.meta.dataState.latestSignalReasonCodes.join(', ')})` : ''}
                                  </Badge>
                                )}
                                {m.meta.toolCalls.length > 0 && (
                                  <Badge variant="outline" className="border-zinc-700 bg-zinc-800/50 text-zinc-500">
                                    টুল: {m.meta.toolCalls.map((t) => `${t.name}${t.ok ? '✓' : '✗'}`).join(' · ')}
                                  </Badge>
                                )}
                                {m.meta.dataState.quoteTimeUtc && (
                                  <span className="text-[10px] text-zinc-600">কোট-সময়: {fmtDhaka(m.meta.dataState.quoteTimeUtc)}</span>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {chatSending && (
                      <div className="flex justify-start">
                        <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3.5 py-2.5 text-sm text-zinc-400">
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                          টুল থেকে যাচাইকৃত ডেটা আনা হচ্ছে…
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Input */}
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void sendChatMessage();
                    }}
                  >
                    <label htmlFor="chat-input" className="sr-only">
                      আপনার প্রশ্ন লিখুন
                    </label>
                    <input
                      id="chat-input"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder="যেমন: এখন XAUUSDm-এর বাজারের অবস্থা কী?"
                      maxLength={2000}
                      className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none"
                    />
                    <Button type="submit" size="sm" disabled={chatSending || chatInput.trim().length === 0} className="gap-1.5">
                      {chatSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Bot className="h-3.5 w-3.5" aria-hidden />}
                      পাঠান
                    </Button>
                  </form>
                  <p className="text-[11px] leading-relaxed text-zinc-600">
                    এজেন্ট কখনো দাম বানিয়ে বলবে না — কোট অনুপলব্ধ থাকলে সেটাই জানাবে। ডেটা STALE/DISCONNECTED হলে ভুয়া "লাইভ" ব্যাজ দেখানো হয় না।
                    প্রতি উত্তরের সাথে টুল-প্রমাণ ও টাইমস্ট্যাম্প থাকে। এই চ্যাট কোনো ট্রেড চালাতে পারে না — সেই ক্ষমতা সিস্টেমে নেই।
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ------------------------------------------ Tab: data & signal health (Phase 8) */}
            <TabsContent value="dhealth" className="space-y-4">
              {!dataHealth ? (
                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardContent className="p-6 text-sm text-zinc-400">
                    ডেটা-স্বাস্থ্য এন্ডপয়েন্ট এখন উপলব্ধ নয় (fail-closed) — কোনো কিছু আন্দাজ করে দেখানো হচ্ছে না।
                  </CardContent>
                </Card>
              ) : (
                <>
                  {/* Connection & quote freshness */}
                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                        লাইভ ফিড ও রিয়েল-টাইম কোট সততা
                        <Badge
                          variant="outline"
                          className={
                            dataHealth.quote.freshness === 'LIVE'
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                              : dataHealth.quote.freshness === 'STALE'
                                ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                                : dataHealth.quote.freshness === 'DEGRADED'
                                  ? 'border-orange-500/40 bg-orange-500/10 text-orange-400'
                                  : 'border-red-500/40 bg-red-500/10 text-red-400'
                          }
                        >
                          {dataHealth.quote.freshness === 'LIVE'
                            ? 'LIVE — সত্যিকারের ব্রোকার ফিড'
                            : dataHealth.quote.freshness === 'STALE'
                              ? 'STALE — পুরনো কোট'
                              : dataHealth.quote.freshness === 'DEGRADED'
                                ? 'DEGRADED — অনির্ভরযোগ্য উৎস'
                                : 'DISCONNECTED — সংযোগ নেই'}
                        </Badge>
                      </CardTitle>
                      <p className="text-xs text-zinc-500">
                        শুধু সফল authenticated সেশন + সাম্প্রতিক বৈধ কোট মিললেই LIVE — শুধু WebSocket খোলা থাকা যথেষ্ট নয়।
                      </p>
                    </CardHeader>
                    <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                        <p className="text-[10px] uppercase tracking-wide text-zinc-500">উৎস (প্রকৃত)</p>
                        <p className="mt-1 text-sm font-medium text-zinc-200">{dataHealth.quote.sourceLabel}</p>
                        <p className="mt-1 text-[10px] text-zinc-500">
                          server: {dataHealth.quote.server ?? '—'} · gateway: {dataHealth.quote.gateway ?? '—'}
                        </p>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                        <p className="text-[10px] uppercase tracking-wide text-zinc-500">XAUUSDm কোট</p>
                        {dataHealth.quote.bid !== null ? (
                          <>
                            <p className="mt-1 font-mono text-sm text-zinc-100">
                              bid <PriceLevelText value={dataHealth.quote.bid} spec={priceSpec} /> / ask <PriceLevelText value={dataHealth.quote.ask} spec={priceSpec} />
                            </p>
                            <p className="mt-1 text-[10px] text-zinc-500">
                              spread <PriceLevelText value={dataHealth.quote.spread} spec={priceSpec} /> · কোট-বয়স {dataHealth.quote.ageSeconds ?? '—'}s · digits {dataHealth.quote.digits ?? '—'}
                            </p>
                          </>
                        ) : (
                          <p className="mt-1 text-sm text-zinc-400">বৈধ কোট নেই (কিছু বানানো হয়নি)</p>
                        )}
                        {quoteDigitsMismatch && (
                          <p className="mt-1 text-[10px] leading-relaxed text-amber-300">
                            ⚠ মেটাডেটা-অসঙ্গতি: লাইভ কোট digits ({dataHealth?.quote.digits}) ≠ যাচাইকৃত SymbolSpec digits ({priceSpec.digits}) — দেখানো হচ্ছে, স্বয়ংক্রিয়ভাবে সংশোধন করা হয়নি।
                          </p>
                        )}
                        <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
                          {priceSpec.verified
                            ? `প্রদর্শন-নির্ভুলতা: যাচাইকৃত digits=${priceSpec.digits} (${dataLatest?.spec?.source ?? 'bridge'}${dataLatest?.spec?.lastVerifiedAtUtc ? `, যাচাই ${fmtDhaka(dataLatest.spec.lastVerifiedAtUtc)}` : ''})`
                            : 'প্রদর্শন-নির্ভুলতা: সিম্বল মেটাডেটা যাচাইকৃত নয় — raw মান দেখানো হচ্ছে (fail-closed)।'}
                        </p>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                        <p className="text-[10px] uppercase tracking-wide text-zinc-500">সংযোগ সত্যতা</p>
                        <p className="mt-1 text-xs text-zinc-300">
                          authenticated: {dataHealth.quote.authenticated ? 'হ্যাঁ ✓' : 'না ✗'} · পুনর্সংযোগ: {dataHealth.quote.reconnects ?? '—'}
                        </p>
                        <p className="mt-1 text-[10px] text-zinc-500">
                          শেষ ত্রুটি: {dataHealth.quote.lastError ?? 'নেই'}
                        </p>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                        <p className="text-[10px] uppercase tracking-wide text-zinc-500">সিগন্যাল গেট</p>
                        <p className={`mt-1 text-sm font-medium ${dataHealth.quote.signalPermitted ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {dataHealth.quote.signalPermitted ? 'অনুমোদিত (সব শর্ত পূরণ)' : 'অবরুদ্ধ (BLOCKED)'}
                        </p>
                        {dataHealth.quote.blockedReasons.length > 0 && (
                          <p className="mt-1 font-mono text-[10px] text-amber-300/80">{dataHealth.quote.blockedReasons.join(' · ')}</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Candle history audit table */}
                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">ক্যানেল-হিস্টোরি নিরীক্ষণ (প্রতি টাইমফ্রেম)</CardTitle>
                      <p className="text-xs text-zinc-500">
                        ডেটাবেসে সংরক্ষিত প্রকৃত ব্রোকার ক্যানেলের যাচাই — অডিট সময় {dataHealth.candleHistory.auditedAtUtc.slice(0, 19).replace('T', ' ')} UTC।
                      </p>
                    </CardHeader>
                    <CardContent className="p-0">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-zinc-800 text-left text-zinc-500">
                              <th className="px-3 py-2">TF</th>
                              <th className="px-3 py-2">কভারেজ (UTC)</th>
                              <th className="px-3 py-2">ক্লোজড</th>
                              <th className="px-3 py-2">ফর্মিং</th>
                              <th className="px-3 py-2">সন্দেহজনক গ্যাপ</th>
                              <th className="px-3 py-2">ওয়াকেন্ড গ্যাপ</th>
                              <th className="px-3 py-2">অবৈধ OHLC</th>
                              <th className="px-3 py-2">ডুপ্লিকেট</th>
                              <th className="px-3 py-2">অবস্থা</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dataHealth.candleHistory.timeframes.map((tf) => (
                              <tr key={tf.timeframe} className="border-b border-zinc-800/50">
                                <td className="px-3 py-2 font-mono font-medium text-zinc-200">{tf.timeframe}</td>
                                <td className="px-3 py-2 text-zinc-400">
                                  {tf.present
                                    ? `${tf.earliestCandleUtc?.slice(0, 10)} → ${tf.latestCandleUtc?.slice(0, 10)}`
                                    : '—'}
                                </td>
                                <td className="px-3 py-2 text-zinc-300">{tf.closedCount}</td>
                                <td className="px-3 py-2 text-zinc-400">{tf.formingCount}</td>
                                <td className={`px-3 py-2 ${tf.missingOutsideClosure > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                  {tf.missingOutsideClosure}
                                </td>
                                <td className="px-3 py-2 text-zinc-500">{tf.closureGaps}</td>
                                <td className={`px-3 py-2 ${tf.invalidOhlc > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{tf.invalidOhlc}</td>
                                <td className={`px-3 py-2 ${tf.duplicateTimestamps > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{tf.duplicateTimestamps}</td>
                                <td className="px-3 py-2">
                                  <Badge
                                    variant="outline"
                                    className={
                                      tf.qualityState === 'VALID'
                                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                        : tf.qualityState === 'WARNING'
                                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                                          : 'border-red-500/40 bg-red-500/10 text-red-400'
                                    }
                                  >
                                    {tf.qualityState}
                                  </Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="border-t border-zinc-800 p-3">
                        <p className="text-xs text-amber-300/90">⚠ H4 সীমা: {dataHealth.candleHistory.h4Coverage.coverageNote}</p>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Signal engine + last sync + backtest */}
                  <div className="grid gap-4 lg:grid-cols-2">
                    <Card className="border-zinc-800 bg-zinc-900/40">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">সিগন্যাল ইঞ্জিন ও শেষ সিঙ্ক</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 text-xs">
                        <div>
                          <p className="text-zinc-500">সর্বশেষ বিশ্লেষণ চলার অবস্থা</p>
                          {analysisLatest?.latest ? (
                            <p className="mt-1 text-zinc-200">
                              {analysisLatest.latest.status === 'BLOCKED' ? 'BLOCKED — অবৈধ/অসম্পূর্ণ ডেটায় সিগন্যাল নয়: ' : 'চলমান: '}
                              <span className="font-mono text-[10px] text-amber-300/80">
                                {analysisLatest.latest.reasonCodes.join(', ') || '—'}
                              </span>
                            </p>
                          ) : (
                            <p className="mt-1 text-zinc-400">এখনো কোনো রান নেই।</p>
                          )}
                        </div>
                        <div>
                          <p className="text-zinc-500">শেষ সফল হিস্ট্রি সিঙ্ক</p>
                          {dataHealth.lastSync ? (
                            <p className="mt-1 text-zinc-300">
                              {dataHealth.lastSync.mode} · {dataHealth.lastSync.status} · +{dataHealth.lastSync.inserted} নতুন · ~{dataHealth.lastSync.updated} আপডেট · উৎস {dataHealth.lastSync.source} ·{' '}
                              {dataHealth.lastSync.startedAtUtc.slice(0, 19).replace('T', ' ')} UTC
                            </p>
                          ) : (
                            <p className="mt-1 text-zinc-400">সিঙ্ক রেকর্ড নেই।</p>
                          )}
                        </div>
                        <div>
                          <p className="text-zinc-500">এক্সিকিউশন লক</p>
                          <p className="mt-1 text-emerald-400">{dataHealth.executionLock.reason}</p>
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="border-zinc-800 bg-zinc-900/40">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">সর্বশেষ ব্যাকটেস্ট (সিমুলেশন — লাভের প্রমাণ নয়)</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2 text-xs">
                        {!backtestLatest?.latest ? (
                          <p className="text-zinc-400">এখনো কোনো ব্যাকটেস্ট রান নেই।</p>
                        ) : (
                          <>
                            <p className="text-zinc-300">
                              {backtestLatest.latest.timeframe} · {backtestLatest.latest.status} · {backtestLatest.latest.dataset.candleCount} ক্যানেল ·{' '}
                              {backtestLatest.latest.dataset.fromUtc.slice(0, 10)} → {backtestLatest.latest.dataset.toUtc.slice(0, 10)}
                            </p>
                            <p className="text-zinc-500">
                              ফিঙ্গারপ্রিন্ট <span className="font-mono text-[10px] text-amber-300/80">{backtestLatest.latest.datasetFingerprint.slice(0, 24)}…</span> · কৌশল {backtestLatest.latest.strategyVersion}
                            </p>
                            {(['dev', 'oos'] as const).map((seg) => {
                              const m = (seg === 'dev' ? backtestLatest.latest!.dev : backtestLatest.latest!.oos) as {
                                status: string; executedTrades?: number; winRate?: number; profitFactor?: number; netPnlPrice?: number; reason?: string;
                              };
                              return (
                                <p key={seg} className="text-zinc-400">
                                  {seg === 'dev' ? 'Dev' : 'Out-of-sample'}:{' '}
                                  {m.status === 'INSUFFICIENT_DATA'
                                    ? `INSUFFICIENT_DATA — ${m.reason ?? 'পর্যাপ্ত ট্রেড নেই'}`
                                    : `${m.executedTrades} ট্রেড · জয়রেট ${m.winRate} · PF ${m.profitFactor} · নিট P&L ${m.netPnlPrice} (মূল্য-একক)`}
                                </p>
                              );
                            })}
                            <p className="text-[10px] text-zinc-500">{backtestLatest.disclaimer}</p>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </>
              )}
            </TabsContent>

            {/* ------------------------------------------------ Tab: architecture */}
            <TabsContent value="arch" className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">সিস্টেম স্তর (উপর থেকে নিচে)</CardTitle>
                    <p className="text-xs text-zinc-500">MT5 ব্রিজ ছাড়া বাকি সব স্তর এই sandbox-এ বাস্তবায়িত।</p>
                  </CardHeader>
                  <CardContent className="space-y-0">
                    {(audit?.architecture ?? []).map((layer, i) => (
                      <div key={layer.id}>
                        <div className="flex gap-3 rounded-lg border border-zinc-800/70 bg-zinc-950/60 p-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/10">
                            {layer.id === 'dashboard' ? <Globe className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'api' ? <Server className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'glm' ? <Bot className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'tools' ? <Wrench className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'engines' ? <Cpu className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'bridge' ? <Network className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'data' ? <Database className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center justify-between gap-1">
                              <p className="text-sm font-semibold text-zinc-100">{layer.title}</p>
                              <Badge variant="outline" className="border-zinc-700 bg-zinc-800/60 text-[10px] text-zinc-400">
                                {layer.phase}
                              </Badge>
                            </div>
                            <p className="mt-0.5 font-mono text-[11px] text-amber-300/80">{layer.tech}</p>
                            <p className="mt-1 text-xs leading-relaxed text-zinc-400">{layer.detail}</p>
                          </div>
                        </div>
                        {i < (audit?.architecture.length ?? 0) - 1 && (
                          <div className="flex justify-center py-1" aria-hidden>
                            <ChevronDown className="h-4 w-4 text-zinc-600" />
                          </div>
                        )}
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <div className="space-y-4">
                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Repository কাঠামো</CardTitle>
                      <p className="text-xs text-zinc-500">Phase 1 ডেলিভারি — প্রতিটি ফাইলের ভূমিকা স্পষ্ট।</p>
                    </CardHeader>
                    <CardContent>
                      <pre className="custom-scrollbar max-h-[320px] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950/80 p-4 font-mono text-[11px] leading-relaxed text-zinc-300">
                        {audit?.repositoryTree ?? ''}
                      </pre>
                    </CardContent>
                  </Card>

                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Tool Registry (Allowlist)</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-xs leading-relaxed text-zinc-400">
                        GLM শুধু অনুমোদিত টুল কল করতে পারে — কোনো shell, SQL বা নেটওয়ার্ক টুল নেই।
                        ভবিষ্যৎ টুল রানটাইমে স্পষ্ট এররসহ প্রত্যাখ্যাত হয়।
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {(audit?.tools.active ?? []).map((t) => (
                          <Badge key={t} variant="outline" className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" aria-hidden /> {t}
                          </Badge>
                        ))}
                        {(audit?.tools.planned ?? []).map((t) => (
                          <Badge key={t.name} variant="outline" className="border-zinc-700 bg-zinc-800/60 text-zinc-400">
                            {t.name} · P{t.phase}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </TabsContent>

            {/* ------------------------------------------------ Tab: GLM verify */}
            <TabsContent value="glm" className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {[
                  {
                    icon: Zap,
                    title: 'Chat Completion',
                    ok: audit?.glm.capabilities.chatCompletion ?? false,
                    detail: 'ইংরেজি টোকেন-টেস্ট রাউন্ড-ট্রিপ',
                  },
                  {
                    icon: Languages,
                    title: 'Bengali Response',
                    ok: audit?.glm.capabilities.bengali ?? false,
                    detail: 'Phase 9-এর বাংলা Chat Agent-এর ভিত্তি',
                  },
                  {
                    icon: Wrench,
                    title: 'Tool Calling',
                    ok: audit?.glm.capabilities.toolCalling ?? false,
                    detail: `Full loop ${audit?.glm.capabilities.toolCallRoundTripMs ?? '—'}ms`,
                  },
                ].map((cap) => (
                  <Card key={cap.title} className="border-zinc-800 bg-zinc-900/40">
                    <CardContent className="flex items-start gap-3 p-4 sm:p-5">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/10">
                        <cap.icon className="h-5 w-5 text-amber-400" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-zinc-100">{cap.title}</p>
                          {cap.ok ? (
                            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">✓ যাচাইকৃত</Badge>
                          ) : (
                            <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-400">✗ ব্যর্থ</Badge>
                          )}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-zinc-400">{cap.detail}</p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">লাইভ পুনঃযাচাই</CardTitle>
                  <p className="text-xs text-zinc-500">
                    স্ট্যাটিক প্রমাণ নয় — বাটন চাপলেই এখনই তিনটি রিয়েল রাউন্ড-ট্রিপ চলে (চ্যাট, বাংলা, টুল-কলিং)।
                    ফল সরাসরি SystemEvent অডিট ট্রেইলে লেখা হয়।
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={() => void runVerify()} disabled={verifying} className="bg-amber-500 text-zinc-950 hover:bg-amber-400">
                      {verifying ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> যাচাই চলছে…
                        </>
                      ) : (
                        <>
                          <Zap className="h-4 w-4" aria-hidden /> GLM লাইভ যাচাই চালান
                        </>
                      )}
                    </Button>
                    <span className="text-xs text-zinc-500">
                      মডেল: <span className="font-mono text-amber-300">{audit?.glm.model ?? 'glm-4-plus'}</span> ·
                      SDK: z-ai-web-dev-sdk (server-side only) · Auth: sandbox-managed — কোনো API key লাগে না
                    </span>
                  </div>

                  {verifyResult && (
                    <div className="space-y-3">
                      <div
                        role="status"
                        className={`rounded-lg border p-3 text-sm ${
                          verifyResult.verified
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                            : 'border-red-500/40 bg-red-500/10 text-red-300'
                        }`}
                      >
                        {verifyResult.verified ? 'সব টেস্ট পাস — ' : 'এক বা একাধিক টেস্ট ব্যর্থ — '}
                        মোট {verifyResult.totalLatencyMs}ms · {fmtDhaka(verifyResult.checkedAt)} (ঢাকা)
                      </div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        {verifyResult.tests.map((t) => (
                          <div key={t.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-semibold text-zinc-200">{t.name}</p>
                              <StatusIcon status={t.ok ? 'pass' : 'fail'} />
                            </div>
                            <p className="mt-1 font-mono text-[11px] text-zinc-500">{t.latencyMs > 0 ? `${t.latencyMs}ms` : '—'}</p>
                            <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{t.detail}</p>
                            {t.sample && (
                              <p className="custom-scrollbar mt-2 max-h-24 overflow-auto rounded border border-zinc-800 bg-zinc-900/60 p-2 font-mono text-[11px] text-amber-200/90">
                                &ldquo;{t.sample}&rdquo;
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <Separator className="bg-zinc-800" />
                  <div className="grid grid-cols-1 gap-3 text-xs text-zinc-400 sm:grid-cols-2">
                    <p>
                      <span className="text-zinc-200">নমুনা রিকোয়েস্ট:</span>{' '}
                      <span className="font-mono text-zinc-500">{audit?.glm.sample.prompt ?? '—'}</span>
                    </p>
                    <p>
                      <span className="text-zinc-200">নমুনা রেসপন্স:</span>{' '}
                      <span className="font-mono text-emerald-400/90">{audit?.glm.sample.response ?? '—'}</span>
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ------------------------------------------------ Tab: MT5 */}
            <TabsContent value="mt5" className="space-y-4">
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    MT5 আর্কিটেকচার প্রতিবেদন
                    {audit?.mt5.currentArchitecture && (
                      <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                        {audit.mt5.currentArchitecture.status === 'deployed-and-verified' ? 'বর্তমান ব্রিজ: স্থাপিত ও যাচাইকৃত' : audit.mt5.currentArchitecture.status}
                      </Badge>
                    )}
                  </CardTitle>
                  <p className="text-xs text-zinc-500">
                    Phase 1-এর সম্ভাব্যতা গবেষণা ঐতিহাসিক সত্য হিসেবে সংরক্ষিত; Phase 8 থেকে বাস্তব সমাধান — সরাসরি TypeScript ওয়েব-টার্মিনাল ব্রিজ — চালু ও লাইভ-যাচাইকৃত।
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {audit?.mt5.currentArchitecture && (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
                      <p className="text-sm font-semibold text-emerald-300">{audit.mt5.currentArchitecture.title}</p>
                      <p className="mt-1.5 text-xs leading-relaxed text-zinc-300">{audit.mt5.currentArchitecture.detail}</p>
                    </div>
                  )}
                  <Separator className="bg-zinc-800" />
                  <p className="text-sm font-semibold text-zinc-100">ঐতিহাসিক গবেষণা — Phase 1 ({audit?.mt5.historicalStudy ? `সমাধান: ${audit.mt5.historicalStudy.supersededBy}` : ''})</p>
                  <ul className="space-y-2">
                    {(audit?.mt5.historicalStudy?.findings ?? audit?.mt5.findings ?? []).map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm leading-relaxed text-zinc-400">
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" aria-hidden />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs leading-relaxed text-emerald-200/80">
                    ব্রিজটি GET-only REST (x-trader-key auth) এবং ওয়েব-টার্মিনাল প্রোটোকলের শুধু মার্কেট-ডেটা কমান্ড নিয়ে কাজ করে — কোনো ট্রেডিং কমান্ড কোডেই নেই (স্ট্যাটিক স্ক্যান-যাচাইকৃত)।
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ------------------------------------------------ Tab: database */}
            <TabsContent value="db" className="space-y-4">
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">ডেটা মডেল (SQLite · Prisma)</CardTitle>
                  <p className="text-xs text-zinc-500">
                    ১৪টি মডেল — ৯টি সচল (Phase 1–9), ১টি অবচিত (Signal → SignalEvaluation), ২টি পরিকল্পিত, ২টি Phase 11 পর্যন্ত তালাবদ্ধ।
                  </p>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-zinc-800 hover:bg-transparent">
                          <TableHead className="pl-4 sm:pl-6">মডেল</TableHead>
                          <TableHead className="min-w-[220px]">উদ্দেশ্য</TableHead>
                          <TableHead>Phase</TableHead>
                          <TableHead className="pr-4 sm:pr-6">অবস্থা</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(audit?.database.models ?? []).map((m) => (
                          <TableRow key={m.name} className="border-zinc-800/70">
                            <TableCell className="pl-4 font-mono text-xs text-zinc-200 sm:pl-6">{m.name}</TableCell>
                            <TableCell className="text-xs text-zinc-400">{m.purpose}</TableCell>
                            <TableCell className="font-mono text-xs text-zinc-500">P{m.phase}</TableCell>
                            <TableCell className="pr-4 sm:pr-6">
                              <Badge
                                variant="outline"
                                className={
                                  m.status === 'active'
                                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                    : m.status === 'locked'
                                      ? 'border-red-500/40 bg-red-500/10 text-red-400'
                                      : m.status === 'superseded'
                                        ? 'border-zinc-700 bg-zinc-800/60 text-zinc-600 line-through'
                                        : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
                                }
                              >
                                {m.status === 'active' ? 'সচল' : m.status === 'locked' ? 'তালাবদ্ধ (Phase 11)' : m.status === 'superseded' ? 'অবচিত' : 'পরিকল্পিত'}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
              <p className="text-xs leading-relaxed text-zinc-500">
                টেকনিক্যাল নোট: SQLite-এ Prisma Json টাইপ নেই, তাই JSON পে-লোড String হিসেবে সংরক্ষিত — schema-তে প্রতিটি মডেলে কমেন্টে ব্যাখ্যা আছে।
                সব মূল্য-ক্যান্ডেল-রেকর্ড symbol+timeframe+timestamp ইউনিক কনস্ট্রেইন্টে আবদ্ধ — ডুপ্লিকেট সিগন্যাল তৈরির পথ বন্ধ।
              </p>
            </TabsContent>

            {/* ------------------------------------------------ Tab: security & checklist */}
            <TabsContent value="sec" className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden /> নিরাপত্তা ব্যবস্থা
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {(audit?.security ?? []).map((s) => (
                      <div key={s.measure} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                        <p className="text-xs font-semibold text-zinc-100">{s.measure}</p>
                        <p className="mt-1 text-xs leading-relaxed text-zinc-400">{s.detail}</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <div className="space-y-4">
                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Phase 1 গ্রহণযোগ্যতা চেকলিস্ট</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2">
                        {(audit?.acceptanceChecklist ?? []).map((c) => (
                          <li key={c.id} className="flex items-start gap-2 text-sm text-zinc-300">
                            {c.done ? (
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                            ) : (
                              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" aria-hidden />
                            )}
                            {c.label}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>

                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden /> ঝুঁকি ও অসমাধান ব্লকার
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-zinc-400">
                        <li>
                          <span className="text-zinc-200">MT5 ব্রিজ বাহ্যিক নির্ভরতা:</span> sandbox-এ MT5 চলবে না (প্রমাণিত)।
                          Phase 2-এর আগে আপনাকে সিদ্ধান্ত নিতে হবে — কোন ব্রিজ অপশন (Linux VPS + Wine / Windows VPS) নেবেন।
                        </li>
                        <li>
                          <span className="text-zinc-200">Sandbox স্থায়িত্ব:</span> এটি কোডিং-রানটাইম, ২৪/৭ ট্রেডিং সার্ভার নয়।
                          চূড়ান্ত ডিপ্লয়মেন্ট (Phase 12) আপনার নিজের Linux VPS-এ হবে।
                        </li>
                        <li>
                          <span className="text-zinc-200">এক-পোর্ট সীমাবদ্ধতা:</span> বাইরের সব সংযোগ গেটওয়ে হয়ে যায়;
                          ব্রিজে যাওয়ার সময় আউটবাউন্ড HTTPS ব্যবহার হবে (নেটওয়ার্ক পরীক্ষায় সমর্থিত)।
                        </li>
                        <li>
                          <span className="text-zinc-200">GLM কোটা/খরচ:</span> স্যান্ডবক্স প্ল্যানের উপর নির্ভরশীল — তাই
                          /api/ai/verify-তে রেট লিমিট (ডিফল্ট ১০ সেকেন্ড) দেওয়া আছে।
                        </li>
                      </ul>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {/* ------------------------------------------------ Audit trail (events) */}
          <Card className="border-zinc-800 bg-zinc-900/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <Terminal className="h-4 w-4 text-amber-400" aria-hidden /> সিস্টেম ইভেন্ট — লাইভ অডিট ট্রেইল
                <Badge variant="outline" className="border-zinc-700 bg-zinc-800/60 text-zinc-400">
                  {health?.auditEventCount ?? audit?.events.length ?? 0} টি
                </Badge>
              </CardTitle>
              <p className="text-xs text-zinc-500">
                SystemEvent টেবিল থেকে সরাসরি (append-only)। GLM যাচাই চালালে এখানে নতুন রেকর্ড যুক্ত হতে দেখবেন।
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="custom-scrollbar max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
                    <TableRow className="border-zinc-800 hover:bg-transparent">
                      <TableHead className="pl-4 sm:pl-6">সময় (ঢাকা)</TableHead>
                      <TableHead>স্তর</TableHead>
                      <TableHead>কোড</TableHead>
                      <TableHead className="min-w-[240px] pr-4 sm:pr-6">বার্তা</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(audit?.events ?? []).map((e) => (
                      <TableRow key={e.id} className="border-zinc-800/70">
                        <TableCell className="whitespace-nowrap pl-4 text-xs tabular-nums text-zinc-500 sm:pl-6">
                          {fmtDhaka(e.createdAt)}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${levelBadgeClass(e.level)}`}
                          >
                            {e.level}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-amber-300/80">{e.code}</TableCell>
                        <TableCell className="pr-4 text-xs text-zinc-300 sm:pr-6">{e.message}</TableCell>
                      </TableRow>
                    ))}
                    {audit && audit.events.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="p-6 text-center text-sm text-zinc-500">
                          এখনো কোনো ইভেন্ট নেই — &ldquo;GLM যাচাই&rdquo; ট্যাব থেকে লাইভ যাচাই চালান।
                        </TableCell>
                      </TableRow>
                    )}
                    {loading && !audit && (
                      <TableRow>
                        <TableCell colSpan={4} className="p-6">
                          <Skeleton className="h-5 w-full" />
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* ---------------------------------------------------------------- Footer */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-4 text-xs text-zinc-500 sm:px-6 md:flex-row md:items-center md:justify-between">
          <p className="flex items-center gap-1.5">
            <LockKeyhole className="h-3.5 w-3.5 text-red-400" aria-hidden />
            XAUUSD AI Trading Agent · Phase 9/12 · Read-Only — কোনো অর্ডার পাঠানো হবে না
          </p>
          <p className="font-mono text-[11px] text-zinc-600">
            Next.js 16 · TypeScript · Prisma/SQLite · z-ai-web-dev-sdk (glm-4-plus)
          </p>
          <p className="text-zinc-600">Live Trading: Phase 12 রিলিজ-গেটের আগে চালু হবে না</p>
        </div>
      </footer>
    </div>
  );
}
