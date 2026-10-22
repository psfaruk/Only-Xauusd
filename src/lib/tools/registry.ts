/**
 * XAUUSD AI Trading Agent — Allowlisted Tool Registry (Phase 1 → Phase 9, + Phase 7 risk gate)
 * ----------------------------------------------------------------------------
 * THE security boundary between the GLM model and the backend.
 *
 * Rules (enforced in code, not by prompt):
 *  1. The model can only call tools whose `name` exists in this registry.
 *  2. Arguments are validated against each tool's JSON schema before execution.
 *  3. `status: 'planned'` tools are architecturally declared but REFUSED at
 *     runtime until their phase is implemented — the model cannot invoke them.
 *  4. There is no shell access, no raw SQL, no arbitrary network tool, no
 *     filesystem tool and NO EXECUTION TOOL. Only these typed, read-only
 *     functions. The model can never choose an arbitrary symbol (allowlist)
 *     or an external URL (none exists).
 *
 * Active tools: get_system_health, get_market_health, get_latest_quote,
 * get_candle_coverage, get_latest_analysis, get_latest_signal,
 * get_backtest_summary, explain_signal_evidence (Phase 9) and
 * run_risk_check (Phase 7 — deterministic risk gate; analysis + audit-row
 * only, it can NEVER place an order) — all read-only, bounded, allowlisted.
 */

import { collectHealth } from '@/lib/health';
import { config } from '@/lib/config';
import { db } from '@/lib/db';
import { createBridgeClient } from '@/lib/market/bridge-client';
import { quoteIntegrity, auditCandleHistory } from '@/lib/market/integrity';
import { getLatestAnalysisRun } from '@/lib/analysis/persistence';
import { getLatestSignalEvaluation, getSignalEvaluationHistory } from '@/lib/signal/persistence';
import { getLatestBacktest } from '@/lib/backtest/service';
import { runRiskCheck, riskConfigSnapshot } from '@/lib/risk/engine';
import {
  persistRiskCheck,
  approvedToday,
  pendingApprovals,
  sameSetupApprovedToday,
} from '@/lib/risk/service';
import { logEvent } from '@/lib/logger';

import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';

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

/** Hard cap on serialized tool output (protects the model context). */
const MAX_OUTPUT_CHARS = 6_000;

/** Bridge client resolved at CALL time (env read per call — identical to the
 *  frozen config value in production; lets tests inject the mock bridge). */
function callTimeBridge() {
  return createBridgeClient({
    baseUrl: process.env.MT5_BRIDGE_URL || undefined,
    maxRetries: 0,
    timeoutMs: 4_000,
  });
}

function bound<T extends Record<string, unknown>>(payload: T): Record<string, unknown> {
  const s = JSON.stringify(payload);
  if (s.length <= MAX_OUTPUT_CHARS) return payload;
  return { truncated: true, note: `output exceeded ${MAX_OUTPUT_CHARS} chars`, excerpt: s.slice(0, MAX_OUTPUT_CHARS) };
}

/** Resolve an allowlisted symbol from tool args (default = first configured). */
function allowlistedSymbol(raw: unknown): { ok: true; symbol: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, symbol: config.market.symbols[0] ?? 'XAUUSDm' };
  }
  if (typeof raw !== 'string') return { ok: false, error: 'symbol must be a string' };
  if (!config.market.symbols.includes(raw)) {
    return { ok: false, error: `symbol not in allowlist: ${config.market.symbols.join(', ')}` };
  }
  return { ok: true, symbol: raw };
}

const symbolParam = {
  type: 'string',
  description: `Symbol (optional — defaults to ${config.market.symbols[0] ?? 'XAUUSDm'}; must be in the configured allowlist)`,
};

// ---------------------------------------------------------------------------
// Active tools
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
    return bound({
      status: h.status,
      phase: h.phase,
      tradingMode: h.tradingMode,
      executionLocked: h.executionLocked,
      executionReason: h.executionReason,
      uptimeSeconds: h.uptimeSeconds,
      database: h.checks.database,
      glm: h.glm.status,
      market: h.market,
      runtime: h.runtime,
    });
  },
};

const getMarketHealth: ToolDefinition = {
  name: 'get_market_health',
  description:
    'Data-health of the live market feed: source class (broker/relay/cache/synthetic), freshness (LIVE/STALE/DEGRADED/DISCONNECTED), bid/ask/spread with quote age, and whether signal generation is currently permitted (blockedReasons when not).',
  parameters: { type: 'object', properties: { symbol: symbolParam }, required: [] },
  status: 'active',
  activatesInPhase: 9,
  handler: async (args) => {
    const sym = allowlistedSymbol(args.symbol);
    if (!sym.ok) return { error: sym.error };
    const report = await quoteIntegrity(sym.symbol, { bridge: callTimeBridge() });
    return bound({
      symbol: report.symbol,
      freshness: report.freshness,
      sourceClass: report.sourceClass,
      sourceLabel: report.sourceLabel,
      connected: report.connected,
      authenticated: report.authenticated,
      server: report.server,
      bid: report.bid,
      ask: report.ask,
      spread: report.spread,
      quoteTimeUtc: report.quoteTimeUtc,
      ageSeconds: report.ageSeconds,
      validationStatus: report.validationStatus,
      signalPermitted: report.signalPermitted,
      blockedReasons: report.blockedReasons,
      checkedAtUtc: report.checkedAtUtc,
    });
  },
};

const getLatestQuote: ToolDefinition = {
  name: 'get_latest_quote',
  description:
    'The latest verified broker quote (bid/ask/mid/spread, digits, timestamp, age) for an allowlisted symbol. Returns UNAVAILABLE honestly when no verified quote exists — never an estimated price.',
  parameters: { type: 'object', properties: { symbol: symbolParam }, required: [] },
  status: 'active',
  activatesInPhase: 9,
  handler: async (args) => {
    const sym = allowlistedSymbol(args.symbol);
    if (!sym.ok) return { error: sym.error };
    const report = await quoteIntegrity(sym.symbol, { bridge: callTimeBridge() });
    if (report.validationStatus === 'UNAVAILABLE' || report.bid === null || report.ask === null) {
      return {
        symbol: sym.symbol,
        available: false,
        freshness: report.freshness,
        reason: 'কোনো যাচাইকৃত কোট নেই — আনুমানিক দাম কখনো দেওয়া হয় না।',
        blockedReasons: report.blockedReasons,
      };
    }
    return bound({
      symbol: sym.symbol,
      available: true,
      bid: report.bid,
      ask: report.ask,
      mid: report.mid,
      spread: report.spread,
      digits: report.digits,
      quoteTimeUtc: report.quoteTimeUtc,
      ageSeconds: report.ageSeconds,
      freshness: report.freshness,
      sourceClass: report.sourceClass,
      signalPermitted: report.signalPermitted,
    });
  },
};

const getCandleCoverage: ToolDefinition = {
  name: 'get_candle_coverage',
  description:
    'Verified candle-history coverage per timeframe (M5/M15/H1/H4): closed-candle counts, date ranges, gaps, duplicates, OHLC validity and the honest H4 broker-depth limitation.',
  parameters: { type: 'object', properties: { symbol: symbolParam }, required: [] },
  status: 'active',
  activatesInPhase: 9,
  handler: async (args) => {
    const sym = allowlistedSymbol(args.symbol);
    if (!sym.ok) return { error: sym.error };
    const history = await auditCandleHistory(sym.symbol, config.market.timeframes);
    return bound({
      symbol: history.symbol,
      auditedAtUtc: history.auditedAtUtc,
      timeframes: history.timeframes.map((t) => ({
        timeframe: t.timeframe,
        present: t.present,
        closedCandles: t.closedCount,
        forming: t.formingCount,
        fromUtc: t.earliestCandleUtc,
        toUtc: t.latestCandleUtc,
        qualityState: t.qualityState,
        suspiciousGaps: t.missingOutsideClosure,
        closureGaps: t.closureGaps,
        invalidOhlc: t.invalidOhlc,
        duplicates: t.duplicateTimestamps,
        outOfOrder: t.outOfOrder,
        latestClosedAgeSeconds: t.latestClosedAgeSeconds,
      })),
      h4CoverageNote: history.h4Coverage.coverageNote,
    });
  },
};

const getLatestAnalysis: ToolDefinition = {
  name: 'get_latest_analysis',
  description:
    'The latest persisted deterministic analysis run (Phase 4 engine): status (COMPLETED/BLOCKED), per-timeframe structure trend (bullish/bearish/range/unclear), BOS/CHoCH counts, reason codes, dataset fingerprint and generated time.',
  parameters: { type: 'object', properties: { symbol: symbolParam }, required: [] },
  status: 'active',
  activatesInPhase: 9,
  handler: async (args) => {
    const sym = allowlistedSymbol(args.symbol);
    if (!sym.ok) return { error: sym.error };
    const run = await getLatestAnalysisRun(db, sym.symbol);
    if (!run) {
      return { available: false, reason: 'কোনো analysis run এখনো হয়নি।' };
    }
    const perTf = run.analysis?.perTimeframe ?? {};
    return bound({
      available: true,
      status: run.status,
      engineVersion: run.engineVersion,
      generatedAtUtc: run.generatedAtUtc,
      inputFingerprint: run.inputFingerprint,
      reasonCodes: run.reasonCodes,
      warnings: run.warnings,
      perTimeframe: Object.fromEntries(
        Object.entries(perTf).map(([tf, a]) => [
          tf,
          {
            trend: a.structure.trend,
            highLabel: a.structure.highLabel,
            lowLabel: a.structure.lowLabel,
            bosCount: a.structure.events.filter((e) => e.type === 'BOS').length,
            chochCount: a.structure.events.filter((e) => e.type === 'CHoCH').length,
            lastEvent: a.structure.events[a.structure.events.length - 1] ?? null,
            candleCount: a.candleCount,
          },
        ]),
      ),
      timeframeContext: run.analysis?.timeframeContext ?? null,
    });
  },
};

const getLatestSignal: ToolDefinition = {
  name: 'get_latest_signal',
  description:
    'The latest deterministic signal evaluation (Phase 9 engine): outcome (BUY_SETUP/SELL_SETUP/WAIT/NO_SETUP/BLOCKED), reason codes, levels (entry zone, SL, target, reward/risk) when a valid setup exists, evidence summary, strategy + engine version and dataset fingerprint.',
  parameters: { type: 'object', properties: { symbol: symbolParam }, required: [] },
  status: 'active',
  activatesInPhase: 9,
  handler: async (args) => {
    const sym = allowlistedSymbol(args.symbol);
    if (!sym.ok) return { error: sym.error };
    const signal = await getLatestSignalEvaluation(db, sym.symbol);
    if (!signal) {
      return { available: false, reason: 'এখনো কোনো signal evaluation হয়নি।' };
    }
    return bound({
      available: true,
      outcome: signal.outcome,
      reasonCodes: signal.reasonCodes,
      engineVersion: signal.engineVersion,
      strategyVersion: signal.strategyVersion,
      decisionCandleTimeUtc: signal.decisionCandleTimeUtc,
      setupKnownAtUtc: signal.setupKnownAtUtc,
      expiryUtc: signal.expiryUtc,
      levels: signal.levels,
      evidence: signal.evidence,
      inputFingerprint: signal.inputFingerprint?.slice(0, 16) ?? null,
      createdAt: signal.createdAt,
      executionLocked: signal.executionLocked,
      note: 'গবেষণা সিগন্যাল — কোনো ট্রেড কার্যকর হয়নি এবং হতে পারে না (read-only সিস্টেম)।',
    });
  },
};

const getBacktestSummary: ToolDefinition = {
  name: 'get_backtest_summary',
  description:
    'The latest backtest of the current signal-engine strategy (and the overall latest run): status, dev/out-of-sample metrics, trade counts, dataset fingerprint and honest limitations. Backtests are simulations, never proof of profitability.',
  parameters: { type: 'object', properties: { symbol: symbolParam }, required: [] },
  status: 'active',
  activatesInPhase: 9,
  handler: async (args) => {
    const sym = allowlistedSymbol(args.symbol);
    if (!sym.ok) return { error: sym.error };
    const latest = await getLatestBacktest(sym.symbol);
    const signalStrategyRun = await db.backtestRun
      .findFirst({
        where: { symbol: sym.symbol, strategyVersion: SIGNAL_STRATEGY_VERSION },
        orderBy: { createdAt: 'desc' },
      })
      .catch(() => null);
    const parse = <T,>(s: string): T => JSON.parse(s) as T;
    return bound({
      available: Boolean(latest),
      disclaimer: 'Backtest হলো সিমুলেশন — লাভজনকতার প্রমাণ নয়। ছোট নমুনা INSUFFICIENT_DATA হিসেবে সৎভাবে রিপোর্ট হয়।',
      signalEngineStrategy: signalStrategyRun
        ? {
            strategyVersion: signalStrategyRun.strategyVersion,
            status: signalStrategyRun.status,
            timeframe: signalStrategyRun.timeframe,
            datasetFromUtc: signalStrategyRun.datasetFromUtc.toISOString(),
            datasetToUtc: signalStrategyRun.datasetToUtc.toISOString(),
            candleCount: signalStrategyRun.candleCount,
            datasetFingerprint: signalStrategyRun.datasetFingerprint.slice(0, 16),
            dev: parse<Record<string, unknown>>(signalStrategyRun.devMetrics),
            oos: parse<Record<string, unknown>>(signalStrategyRun.oosMetrics),
            limitations: parse<string[]>(signalStrategyRun.limitations),
          }
        : null,
      latestOverall: latest
        ? {
            strategyVersion: latest.strategyVersion,
            status: latest.status,
            timeframe: latest.timeframe,
            dev: latest.dev,
            oos: latest.oos,
            tradeCount: latest.tradeCount,
            limitations: latest.limitations,
          }
        : null,
    });
  },
};

const explainSignalEvidence: ToolDefinition = {
  name: 'explain_signal_evidence',
  description:
    'Deterministic evidence breakdown of the latest signal evaluation AND recent history: why the outcome occurred (structure break details, anchor swing, indicator values, HTF context, retest), outcome distribution of recent evaluations, and the exact data freshness at evaluation time.',
  parameters: { type: 'object', properties: { symbol: symbolParam }, required: [] },
  status: 'active',
  activatesInPhase: 9,
  handler: async (args) => {
    const sym = allowlistedSymbol(args.symbol);
    if (!sym.ok) return { error: sym.error };
    const [latest, history] = await Promise.all([
      getLatestSignalEvaluation(db, sym.symbol),
      getSignalEvaluationHistory(db, sym.symbol, 20),
    ]);
    if (!latest) {
      return { available: false, reason: 'এখনো কোনো signal evaluation হয়নি — ব্যাখ্যা করার মতো কিছু নেই।' };
    }
    const outcomeCounts = history.reduce<Record<string, number>>((acc, h) => {
      acc[h.outcome] = (acc[h.outcome] ?? 0) + 1;
      return acc;
    }, {});
    return bound({
      available: true,
      latestOutcome: latest.outcome,
      latestReasonCodes: latest.reasonCodes,
      decisionCandleTimeUtc: latest.decisionCandleTimeUtc,
      structureEvent: latest.evidence?.structureEvent ?? null,
      anchorSwing: latest.evidence?.anchorSwing ?? null,
      indicators: latest.evidence?.indicators ?? null,
      htfContext: latest.evidence?.htfContext ?? null,
      retestBarTimeUtc: latest.evidence?.retestBarTimeUtc ?? null,
      levels: latest.levels,
      quoteAtEvaluation: latest.quote,
      recentHistory: {
        totalEvaluations: history.length,
        outcomeCounts,
        lastFive: history.slice(0, 5).map((h) => ({
          outcome: h.outcome,
          reasonCodes: h.reasonCodes,
          createdAt: h.createdAt,
        })),
      },
      strategyVersion: latest.strategyVersion,
      engineVersion: latest.engineVersion,
      datasetFingerprint: latest.datasetFingerprint?.slice(0, 16) ?? null,
    });
  },
};

// ---------------------------------------------------------------------------
// Phase 7 — deterministic risk gate (ACTIVE)
// ----------------------------------------------------------------------------
// Analysis + audit ONLY: computes what the clamped safety limits would allow
// for the latest directional setup and persists a RiskCheck row. It has NO
// order capability — the four-switch execution lock is untouched and no
// execution code exists anywhere.
// ---------------------------------------------------------------------------

/** Standard XAUUSD contract value: 1.00 lot = 100 oz, so a $1.00 price move
 *  = $100 P/L per lot in account currency. The broker-verified tick/volume
 *  spec is NOT part of the current read-only bridge contract (SymbolSpec
 *  verifiedFields = ['digits'] only — see src/lib/market/ingestion.ts), so
 *  this standard contract-size constant is used and DISCLOSED in every
 *  result payload. To be replaced by the verified spec when the bridge
 *  exposes one. */
const XAUUSD_TICK_VALUE_PER_LOT = 100;

const runRiskCheckTool: ToolDefinition = {
  name: 'run_risk_check',
  description:
    'Deterministic risk gate (Phase 7) for the latest BUY/SELL setup signal: position size computed from equity and stop distance under clamped safety limits (percent risk, lot cap/floor, spread, exposure, pending-approval, daily-order and duplicate protection) — every rule reported pass/fail with detail, persisted as a RiskCheck audit row. সীমার বাইরে কিছু হলে fail-closed। এটি বিশ্লেষণ ও অডিট রেকর্ড — কোনো অর্ডার কার্যকর করে না।',
  parameters: { type: 'object', properties: { symbol: symbolParam }, required: [] },
  status: 'active',
  activatesInPhase: 7,
  handler: async (args) => {
    const sym = allowlistedSymbol(args.symbol);
    if (!sym.ok) return { error: sym.error };

    const evaluatedAtUtc = new Date().toISOString();

    // Latest DIRECTIONAL setup evaluation only — WAIT/NO_SETUP/BLOCKED carry
    // no levels, so the risk gate honestly does not apply to them.
    // Phase 11-E isolation: strictly BASELINE-scoped — candidate setup rows
    // (hybrid-multimodel-research/…) can never feed the risk gate.
    const signal = await db.signalEvaluation
      .findFirst({
        where: {
          symbol: sym.symbol,
          strategyVersion: SIGNAL_STRATEGY_VERSION,
          outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] },
          levels: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      })
      .catch(() => null);

    if (!signal || !signal.levels) {
      await logEvent({
        level: 'info',
        category: 'risk',
        code: 'RISK_CHECK_SKIPPED_NO_SETUP',
        message: `Risk check skipped for ${sym.symbol}: no actionable BUY/SELL setup evaluation exists`,
        meta: { symbol: sym.symbol },
      }).catch(() => undefined);
      return bound({
        note: 'কোনো অ্যাকশনেবল সিগন্যাল নেই — রিস্ক চেক প্রযোজ্য নয়',
        symbol: sym.symbol,
        checkedAtUtc: evaluatedAtUtc,
      });
    }

    // Levels JSON parse — malformed payloads degrade to NaN and the engine
    // fails the level checks honestly (never a guessed number).
    type SetupLevels = {
      direction?: unknown;
      entryReference?: unknown;
      stopLoss?: unknown;
      target?: unknown;
    };
    let parsedLevels: SetupLevels | null = null;
    try {
      parsedLevels = JSON.parse(signal.levels) as SetupLevels;
    } catch {
      parsedLevels = null;
    }
    const numOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);
    const direction: 'BUY' | 'SELL' = signal.outcome === 'SELL_SETUP' ? 'SELL' : 'BUY';
    const entry = numOf(parsedLevels?.entryReference);
    const stopLoss = numOf(parsedLevels?.stopLoss);
    const takeProfit = numOf(parsedLevels?.target);

    // Current verified spread (integrity monitor = the single honest quote
    // source). Unavailable → NaN → the engine fails SPREAD_WITHIN_LIMIT.
    const report = await quoteIntegrity(sym.symbol, { bridge: callTimeBridge() });
    const spread = report.spread !== null ? Number(report.spread) : Number.NaN;

    // TradeApproval-derived counters (Phase 11 table — empty and honestly 0
    // until approvals exist). openPositions uses the simplified approvedToday
    // count per the Phase 7 spec; Phase 11 will supply real position counts.
    const [openPositions, pending, sameSetup, spec] = await Promise.all([
      approvedToday(),
      pendingApprovals(),
      sameSetupApprovedToday(signal.id),
      db.symbolSpec.findUnique({ where: { symbol: sym.symbol } }).catch(() => null),
    ]);

    // Read-only bridge /api/status carries the live account financial state
    // (balance/equity — observation only). When reachable it feeds the risk
    // gate real numbers; otherwise equity/balance stay honestly null and
    // EQUITY_AVAILABLE fails closed. (Phase 0: the old bridge-orders client
    // was deleted with the execution layer; the read-only market bridge
    // client serves the same fields.)
    const accountRes = await callTimeBridge()
      .getStatus()
      .catch(() => null);
    const equity: number | null = accountRes?.ok ? accountRes.data?.accountEquity ?? null : null;
    const balance: number | null = accountRes?.ok ? accountRes.data?.accountBalance ?? null : null;

    const result = runRiskCheck({
      signalId: signal.id,
      direction,
      entry,
      stopLoss,
      takeProfit,
      symbol: signal.symbol,
      spread,
      existingOpenPositions: openPositions,
      existingPendingApprovals: pending,
      sameSetupApprovedToday: sameSetup,
      equity,
      balance,
      symbolDigits: spec?.digits ?? null,
      tickValuePerLot: XAUUSD_TICK_VALUE_PER_LOT,
      evaluatedAtUtc,
    });

    // Append-only audit row + SystemEvent trail (both fire-and-forget
    // failures never mask the returned verdict).
    await persistRiskCheck(signal.id, result).catch(() => undefined);
    const failedRules = result.checks.filter((c) => !c.passed).map((c) => c.rule);
    await logEvent({
      level: result.passed ? 'info' : 'warn',
      category: 'risk',
      code: result.passed ? 'RISK_CHECK_PASSED' : 'RISK_CHECK_FAILED',
      message: `Risk check ${result.passed ? 'PASSED' : 'FAILED'} for ${signal.symbol} signal ${signal.id}${result.lotSize !== null ? ` (lot ${result.lotSize})` : ''}${failedRules.length > 0 ? ` [${failedRules.join(',')}]` : ''}`,
      meta: {
        symbol: signal.symbol,
        signalId: signal.id,
        passed: result.passed,
        lotSize: result.lotSize,
        failedRules,
      },
    }).catch(() => undefined);

    return bound({
      symbol: signal.symbol,
      signalId: signal.id,
      signalOutcome: signal.outcome,
      direction,
      levels: { entry, stopLoss, takeProfit },
      spread,
      passed: result.passed,
      lotSize: result.lotSize,
      checks: result.checks,
      evaluatedAtUtc: result.evaluatedAtUtc,
      accountEquity: result.accountEquity,
      accountBalance: result.accountBalance,
      riskAmount: result.riskAmount,
      stopDistance: result.stopDistance,
      config: riskConfigSnapshot(),
      notes: [
        'ইকুইটি তথ্য অনুপলব্ধ — বর্তমান read-only ব্রিজ কন্ট্র্যাক্টে অ্যাকাউন্ট এন্ডপয়েন্ট নেই; EQUITY_AVAILABLE সৎভাবে fail-closed।',
        `tickValuePerLot = ${XAUUSD_TICK_VALUE_PER_LOT} — স্ট্যান্ডার্ড XAUUSD কন্ট্র্যাক্ট (১০০ আউন্স) থেকে নেওয়া; ব্রোকার-যাচাইকৃত টিক স্পেসিফিকেশন ব্রিজে নেই।`,
        'গবেষণা রিস্ক চেক — কোনো অর্ডার কার্যকর হয়নি এবং হতে পারে না (read-only সিস্টেম)।',
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// Planned tools — refused at runtime until their phase lands
// ----------------------------------------------------------------------------
// Phase 7 activated `run_risk_check` (2026-10-20, Task 30-a): no planned
// tools remain in the registry. The `planned` status + runtime refusal stay
// part of the architecture — future phases re-add entries here.
// ---------------------------------------------------------------------------

const getAiReview: ToolDefinition = {
  name: 'get_ai_review',
  description:
    'Phase 6 GLM মাল্টি-এজেন্ট রিভিউর সর্বশেষ ফলাফল: analyst/critic/risk_reviewer এজেন্টদের রায় ও ব্যাখ্যা, orchestrator-এর চূড়ান্ত সারসংক্ষেপ, এবং কোন সিগন্যাল ইভ্যালুয়েশনের উপর রিভিউটি হয়েছে। রিভিউ পরামর্শমূলক — নির্ধারিত ইঞ্জিনের ফলাফল বদলায় না। চালাতে ব্যবহারকারীকে বলবে Signals ট্যাবের রিভিউ বাটন চাপতে (POST /api/ai/review)।',
  parameters: { type: 'object', properties: { symbol: symbolParam }, required: [] },
  status: 'active',
  activatesInPhase: 6,
  handler: async (args) => {
    const sym = allowlistedSymbol(args.symbol);
    if (!sym.ok) return { error: sym.error };
    const { getLatestMultiAgentReview } = await import('@/lib/ai/multi-agent');
    const review = await getLatestMultiAgentReview(sym.symbol);
    if (!review) {
      return bound({
        available: false,
        reason: 'এখনো কোনো মাল্টি-এজেন্ট রিভিউ হয়নি — Signals ট্যাব থেকে রিভিউ চালান বা POST /api/ai/review কল করুন।',
      });
    }
    return bound({
      available: true,
      batchId: review.batchId,
      ranAtUtc: review.ranAtUtc,
      evaluationId: review.evaluationId,
      evaluationOutcome: review.evaluationOutcome,
      degraded: review.degraded,
      orchestrator: review.orchestrator,
      agents: review.agents,
      note: 'রিভিউ পরামর্শমূলক (advisory) — নির্ধারিত ইঞ্জিনের ফলাফলই প্রামাণ্য।',
    });
  },
};

const plannedTools: ToolDefinition[] = [];

export const TOOL_REGISTRY: ToolDefinition[] = [
  getSystemHealth,
  getMarketHealth,
  getLatestQuote,
  getCandleCoverage,
  getLatestAnalysis,
  getLatestSignal,
  getBacktestSummary,
  explainSignalEvidence,
  runRiskCheckTool,
  getAiReview,
  ...plannedTools,
];

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
    if (result && typeof result === 'object' && 'error' in result) {
      // Handler-level validation refusal (e.g. symbol not in allowlist) —
      // surfaced to the model as an honest tool error, never silently dropped.
      return { ok: false, tool: name, error: `${name}: ${String(result.error)}` };
    }
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
