/**
 * XAUUSD AI Trading Agent — Scalper Signal Service (Phase 12, Task 32)
 * ----------------------------------------------------------------------------
 * LIVE orchestration of the deterministic scalper engine. Fail-closed gates
 * (same discipline as the baseline service):
 *
 *   1. Symbol allowlist + scalper master switch.
 *   2. Quote integrity — verified broker feed only.
 *   3. Verified symbol specification (digits).
 *   4. Market-data readiness for M1/M5/M15.
 *   5. Demo/synthetic source policy — demo rows BLOCK.
 *
 * Then: evaluate → apply pure suppression (cooldown / same-bar dedup) →
 * persist append-only → when a setup survived AND auto-execution is armed,
 * hand the signal to the execution pipeline (risk check → single-attempt
 * order). Every step is logged; nothing is ever retried automatically.
 */

import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { logEvent } from '@/lib/logger';
import { quoteIntegrity } from '@/lib/market/integrity';
import type { BridgeClient } from '@/lib/market/bridge-client';
import { computeReadiness } from '@/lib/market/quality';
import { defaultMarketSymbol } from '@/lib/market/service';
import type { QuoteIntegrityReport } from '@/lib/market/integrity';
import type { SignalReasonCode } from './types';
import { evaluateScalper, setupFingerprintOf, suppressSetup } from './scalper/core';
import { buildScalperRules } from './scalper/rules';
import {
  getLatestScalperSetup,
  getRecentScalperSetups,
  getRecentScalperSetupFingerprints,
  loadScalperWindows,
  saveScalperEvaluation,
} from './scalper/persistence';
import { SCALPER_ENGINE_VERSION, SCALPER_STRATEGY_VERSION, type ScalperEvaluation } from './scalper/types';

export interface RunScalperOptions {
  symbol?: string;
  /** Injectable clock (epoch ms) — deterministic tests. */
  now?: () => number;
  /** Injectable bridge client (deterministic tests). */
  bridge?: BridgeClient;
  /** Await the auto-execution hook instead of firing it in the background
   *  (the manual API trigger wants the honest order outcome in its response). */
  awaitExecution?: boolean;
}

export interface ScalperRunOutcome {
  runId: string | null;
  outcome: ScalperEvaluation['outcome'];
  durationMs: number;
  evaluation: ScalperEvaluation;
  quoteReport: QuoteIntegrityReport | null;
  execution?: {
    attempted: boolean;
    code: string;
    message: string;
    lots: number | null;
    executionLogId: string | null;
  } | null;
}

/** Map integrity blockedReasons → signal reason codes (same map as baseline). */
function mapIntegrityCodes(blocked: string[]): SignalReasonCode[] {
  const out: SignalReasonCode[] = [];
  for (const b of blocked) {
    switch (b) {
      case 'BRIDGE_UNREACHABLE':
      case 'SOURCE_DISCONNECTED':
        out.push('QUOTE_UNAVAILABLE', 'DATA_MISSING');
        break;
      case 'NOT_AUTHENTICATED':
        out.push('NOT_AUTHENTICATED', 'SOURCE_NOT_BROKER');
        break;
      case 'SOURCE_RELAY':
      case 'SOURCE_CACHE':
        out.push('SOURCE_NOT_BROKER');
        break;
      case 'SOURCE_SYNTHETIC':
        out.push('SOURCE_NOT_BROKER', 'SOURCE_DEMO');
        break;
      case 'TICK_INVALID':
        out.push('TICK_INVALID');
        break;
      case 'TICK_UNAVAILABLE':
        out.push('QUOTE_UNAVAILABLE');
        break;
      case 'QUOTE_STALE':
        out.push('QUOTE_STALE', 'DATA_STALE');
        break;
      default:
        out.push('DATA_INVALID');
    }
  }
  return [...new Set(out)];
}

export async function runScalperEvaluation(opts: RunScalperOptions = {}): Promise<ScalperRunOutcome> {
  const startedMs = Date.now();
  const nowMs = opts.now ?? Date.now;
  const nowUtcSec = Math.floor(nowMs() / 1000);
  const rules = buildScalperRules();
  const symbol = opts.symbol ?? defaultMarketSymbol();

  const persist = async (
    evaluation: ScalperEvaluation,
    quote: Record<string, unknown>,
    digits: number | null = null,
  ): Promise<string | null> => {
    try {
      const saved = await saveScalperEvaluation(db, {
        evaluation,
        quote,
        durationMs: Date.now() - startedMs,
        rules,
        digits,
        executionLocked: !config.execution.enabled,
      });
      return saved.id;
    } catch {
      return null; // persistence failure must never mask the verdict
    }
  };

  const blockedOutcome = async (
    codes: SignalReasonCode[],
    quote: Record<string, unknown>,
    digits: number | null = null,
  ): Promise<ScalperRunOutcome> => {
    const evaluation: ScalperEvaluation = {
      engineVersion: SCALPER_ENGINE_VERSION,
      strategyVersion: SCALPER_STRATEGY_VERSION,
      symbol,
      purpose: 'live-signal-auto-execution',
      outcome: 'BLOCKED',
      reasonCodes: [...new Set(codes)],
      decisionCandleTimeUtc: null,
      setupKnownAtUtc: null,
      expiryUtc: null,
      levels: null,
      evidence: null,
      inputFingerprint: '',
      datasetFingerprint: null,
      generatedAtUtc: new Date(nowUtcSec * 1000).toISOString(),
    };
    const runId = await persist(evaluation, quote, digits);
    await logEvent({
      level: 'warn',
      category: 'scalper',
      code: 'SCALPER_EVALUATION_BLOCKED',
      message: `Scalper ${symbol} BLOCKED: ${evaluation.reasonCodes.join(', ')}`,
      meta: { reasonCodes: evaluation.reasonCodes, strategyVersion: SCALPER_STRATEGY_VERSION },
    }).catch(() => undefined);
    return { runId, outcome: 'BLOCKED', durationMs: Date.now() - startedMs, evaluation, quoteReport: null };
  };

  // ── Gate 0: scalper master switch ────────────────────────────────────────
  if (!config.signal.scalper.enabled) {
    return {
      runId: null,
      outcome: 'BLOCKED',
      durationMs: 0,
      evaluation: {
        engineVersion: SCALPER_ENGINE_VERSION,
        strategyVersion: SCALPER_STRATEGY_VERSION,
        symbol,
        purpose: 'live-signal-auto-execution',
        outcome: 'BLOCKED',
        reasonCodes: ['SIGNAL_ERROR'],
        failureMessage: 'scalper disabled (SCALPER_ENABLED=0)',
        decisionCandleTimeUtc: null,
        setupKnownAtUtc: null,
        expiryUtc: null,
        levels: null,
        evidence: null,
        inputFingerprint: '',
        datasetFingerprint: null,
        generatedAtUtc: new Date(nowUtcSec * 1000).toISOString(),
      },
      quoteReport: null,
    };
  }

  // ── Gate 1: symbol allowlist ─────────────────────────────────────────────
  if (!config.market.symbols.includes(symbol)) {
    return blockedOutcome(['SYMBOL_NOT_ALLOWED'], { note: 'symbol not in allowlist' });
  }

  try {
    // ── Gate 2: live quote integrity ──────────────────────────────────────
    const quoteReport = await quoteIntegrity(symbol, opts.bridge ? { bridge: opts.bridge } : {});
    const minimalQuote: Record<string, unknown> = {
      symbol: quoteReport.symbol,
      freshness: quoteReport.freshness,
      sourceClass: quoteReport.sourceClass,
      sourceLabel: quoteReport.sourceLabel,
      bid: quoteReport.bid,
      ask: quoteReport.ask,
      spread: quoteReport.spread,
      ageSeconds: quoteReport.ageSeconds,
      quoteTimeUtc: quoteReport.quoteTimeUtc,
      checkedAtUtc: quoteReport.checkedAtUtc,
    };
    if (!quoteReport.signalPermitted) {
      const blocked = await blockedOutcome(mapIntegrityCodes(quoteReport.blockedReasons), minimalQuote);
      return { ...blocked, quoteReport };
    }

    // ── Gate 3: verified symbol specification ─────────────────────────────
    const spec = await db.symbolSpec.findUnique({ where: { symbol } }).catch(() => null);
    const digits = spec?.digits ?? null;
    if (digits === null) {
      return { ...(await blockedOutcome(['SPEC_MISSING'], minimalQuote, digits)), quoteReport };
    }

    // ── Gate 4: market-data readiness for the three fast TFs ──────────────
    const readiness = await computeReadiness({
      symbol,
      timeframes: ['M1', 'M5', 'M15'],
      now: () => nowMs(),
    });
    if (!readiness.ready) {
      const codes = readiness.errorCodes.map((c): SignalReasonCode => {
        switch (c) {
          case 'DATA_MISSING':
          case 'DATA_STALE':
          case 'DATA_INVALID':
          case 'TICK_STALE':
          case 'TICK_INVALID':
            return c as SignalReasonCode;
          case 'TICK_ZERO_SPREAD':
            return 'SPREAD_INVALID';
          case 'SPEC_MISSING':
            return 'SPEC_MISSING';
          case 'SOURCE_DEMO':
            return 'SOURCE_DEMO';
          default:
            return 'DATA_INVALID';
        }
      });
      const blocked = await blockedOutcome(codes.length ? codes : ['DATA_INVALID'], minimalQuote, digits);
      return { ...blocked, quoteReport };
    }

    // ── Gate 5: load closed-candle windows ────────────────────────────────
    const windows = await loadScalperWindows(db, symbol, rules, nowUtcSec);
    if (windows.demoRows) {
      return { ...(await blockedOutcome(['SOURCE_DEMO', 'SOURCE_NOT_BROKER'], minimalQuote, digits)), quoteReport };
    }
    if (windows.windowGapsSuspicious > 0) {
      return { ...(await blockedOutcome(['GAP_IN_WINDOW', 'DATA_INVALID'], minimalQuote, digits)), quoteReport };
    }

    // ── Deterministic core evaluation ─────────────────────────────────────
    const bid = quoteReport.bid !== null ? Number(quoteReport.bid) : null;
    const ask = quoteReport.ask !== null ? Number(quoteReport.ask) : null;
    if (bid === null || ask === null) {
      return { ...(await blockedOutcome(['QUOTE_UNAVAILABLE'], minimalQuote, digits)), quoteReport };
    }
    const mid = (bid + ask) / 2;
    const spread = Number(quoteReport.spread ?? (ask - bid));

    const rawEvaluation = evaluateScalper({
      symbol,
      digits: windows.digits,
      m15: windows.m15,
      m5: windows.m5,
      m1: windows.m1,
      referencePrice: mid,
      spreadPrice: spread,
      nowUtcSec,
      rules,
    });

    // ── Pure suppression: cooldown + same-bar dedup (DB state → facts) ────
    const [latestSetup, recentFingerprints] = await Promise.all([
      getLatestScalperSetup(db, symbol),
      getRecentScalperSetupFingerprints(db, symbol, nowUtcSec - Math.max(rules.expirySec.M15, 2 * rules.cooldownSec)),
    ]);
    const evaluationFingerprint = setupFingerprintOf(rawEvaluation);
    const duplicate =
      evaluationFingerprint !== null &&
      (recentFingerprints.has(evaluationFingerprint) ||
        (latestSetup?.setupFingerprint !== null &&
          latestSetup?.setupFingerprint !== undefined &&
          latestSetup.setupFingerprint === evaluationFingerprint));
    const cooldownActive =
      latestSetup !== null &&
      latestSetup.createdAtUtcSec + rules.cooldownSec > nowUtcSec &&
      !duplicate; // a duplicate is reported as a duplicate, not as cooldown

    const evaluation = suppressSetup(rawEvaluation, { duplicate, cooldownActive });

    const runId = await persist(evaluation, minimalQuote, windows.digits);
    await logEvent({
      level:
        evaluation.outcome === 'BUY_SETUP' || evaluation.outcome === 'SELL_SETUP'
          ? 'info'
          : 'info',
      category: 'scalper',
      code: `SCALPER_${evaluation.outcome}`,
      message: `Scalper ${symbol} → ${evaluation.outcome}${
        evaluation.reasonCodes.length ? ` [${evaluation.reasonCodes.join(',')}]` : ''
      }${evaluation.evidence?.scalper?.sourceTimeframe ? ` src=${evaluation.evidence.scalper.sourceTimeframe}` : ''} fp=${evaluation.inputFingerprint.slice(0, 12)}`,
      meta: {
        outcome: evaluation.outcome,
        reasonCodes: evaluation.reasonCodes,
        strategyVersion: SCALPER_STRATEGY_VERSION,
        sourceTimeframe: evaluation.evidence?.scalper?.sourceTimeframe ?? null,
        fingerprint: evaluation.inputFingerprint,
      },
    }).catch(() => undefined);

    // ── Auto-execution hook (setup survived + execution armed) ────────────
    let execution: ScalperRunOutcome['execution'] = null;
    if (
      (evaluation.outcome === 'BUY_SETUP' || evaluation.outcome === 'SELL_SETUP') &&
      config.execution.enabled &&
      config.execution.auto &&
      runId !== null
    ) {
      const runExecution = async (): Promise<ScalperRunOutcome['execution']> => {
        try {
          const { processActionableSignal } = await import('@/lib/execution/service');
          const res = await processActionableSignal(symbol, { strategyVersion: SCALPER_STRATEGY_VERSION });
          return res.execution
            ? { ...res.execution }
            : {
                attempted: false,
                code: 'SKIPPED',
                message: res.reason,
                lots: null,
                executionLogId: null,
              };
        } catch (err) {
          await logEvent({
            level: 'error',
            category: 'scalper',
            code: 'SCALPER_EXECUTION_HOOK_ERROR',
            message: `Scalper execution hook failed for ${symbol}: ${err instanceof Error ? err.message : 'unknown'}`,
          }).catch(() => undefined);
          return null;
        }
      };
      if (opts.awaitExecution) {
        execution = await runExecution();
      } else {
        void runExecution().catch(() => undefined);
      }
    }

    return {
      runId,
      outcome: evaluation.outcome,
      durationMs: Date.now() - startedMs,
      evaluation,
      quoteReport,
      execution,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown scalper failure';
    const evaluation: ScalperEvaluation = {
      engineVersion: SCALPER_ENGINE_VERSION,
      strategyVersion: SCALPER_STRATEGY_VERSION,
      symbol,
      purpose: 'live-signal-auto-execution',
      outcome: 'FAILED',
      reasonCodes: ['SIGNAL_ERROR'],
      decisionCandleTimeUtc: null,
      setupKnownAtUtc: null,
      expiryUtc: null,
      levels: null,
      evidence: null,
      inputFingerprint: '',
      datasetFingerprint: null,
      generatedAtUtc: new Date(nowUtcSec * 1000).toISOString(),
      failureMessage: message.slice(0, 300),
    };
    const runId = await persist(evaluation, { note: 'exception path' });
    await logEvent({
      level: 'error',
      category: 'scalper',
      code: 'SCALPER_EVALUATION_FAILED',
      message: `Scalper ${symbol} failed: ${message.slice(0, 200)}`,
      meta: { errorCode: 'SIGNAL_ERROR' },
    }).catch(() => undefined);
    return { runId, outcome: 'FAILED', durationMs: Date.now() - startedMs, evaluation, quoteReport: null };
  }
}

/** Recent emitted setups in the last hour (UI strip + hourly counter). */
export async function scalperRecentSetups(symbol?: string) {
  const sym = symbol ?? defaultMarketSymbol();
  const nowUtcSec = Math.floor(Date.now() / 1000);
  const hourAgoUtcSec = nowUtcSec - 3_600;
  const [setups, latest] = await Promise.all([
    getRecentScalperSetups(db, sym, hourAgoUtcSec, 20),
    import('./scalper/persistence').then((m) => m.getLatestScalperEvaluation(db, sym)),
  ]);
  return { latest, setupsLastHour: setups.length, recentSetups: setups };
}
