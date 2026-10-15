/**
 * XAUUSD AI Trading Agent — Signal Service (Phase 9, Task B4)
 * ----------------------------------------------------------------------------
 * LIVE orchestration of the deterministic signal engine. Fail-closed gates
 * run BEFORE any setup evaluation (spec A → Task B4):
 *
 *   1. Symbol allowlist (defense in depth — the API layer already validates).
 *   2. Quote integrity: the source must be the VERIFIED BROKER FEED — an
 *      authenticated session with a fresh VALID quote (signalPermitted).
 *      A stale relay snapshot can NEVER substitute for live broker data.
 *   3. Verified symbol specification (digits) — without it, level formatting
 *      cannot be trusted and the calculation is BLOCKED, not guessed.
 *   4. Market-data readiness (tick + per-TF freshness, Phase 3 semantics).
 *   5. Demo/synthetic source policy — demo rows BLOCK, never "pass".
 *
 * Every evaluation (BLOCKED included) is persisted append-only with full
 * provenance. Nothing here can execute a trade — no such code exists.
 */

import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { logEvent } from '@/lib/logger';
import { quoteIntegrity } from '@/lib/market/integrity';
import { computeReadiness } from '@/lib/market/quality';
import { defaultMarketSymbol } from '@/lib/market/service';
import type { QuoteIntegrityReport } from '@/lib/market/integrity';
import { SIGNAL_ENGINE_VERSION, type SignalEvaluation, type SignalReasonCode } from './types';
import { evaluateSignal, failedSignalEvaluation } from './core';
import { buildStrategyRules } from './rules';
import { loadSignalWindows, saveSignalEvaluation } from './persistence';

export interface RunSignalOptions {
  symbol?: string;
  /** Injectable clock (epoch ms) — deterministic tests. */
  now?: () => number;
}

export interface SignalRunOutcome {
  runId: string | null;
  outcome: SignalEvaluation['outcome'];
  durationMs: number;
  evaluation: SignalEvaluation;
  quoteReport: QuoteIntegrityReport | null;
}

/** Map integrity blockedReasons → signal reason codes (honest pass-through). */
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

export async function runSignalEvaluation(opts: RunSignalOptions = {}): Promise<SignalRunOutcome> {
  const startedAt = new Date();
  const nowMs = opts.now ?? Date.now;
  const nowUtcSec = Math.floor(nowMs() / 1000);
  const rules = buildStrategyRules();

  const symbol = opts.symbol ?? defaultMarketSymbol();
  const startedMs = Date.now();

  const persist = async (
    evaluation: SignalEvaluation,
    quote: Record<string, unknown>,
  ): Promise<string | null> => {
    try {
      const saved = await saveSignalEvaluation(db, {
        evaluation,
        quote,
        durationMs: Date.now() - startedMs,
        startedAtUtc: startedAt,
      });
      return saved.id;
    } catch {
      return null; // persistence failure must never mask the verdict
    }
  };

  const blockedOutcome = async (
    codes: SignalReasonCode[],
    quote: Record<string, unknown>,
  ): Promise<SignalRunOutcome> => {
    const evaluation: SignalEvaluation = {
      engineVersion: SIGNAL_ENGINE_VERSION,
      strategyVersion: rules.strategyVersion,
      symbol,
      purpose: 'research-signal-not-an-execution-instruction',
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
    const runId = await persist(evaluation, quote);
    await logEvent({
      level: 'warn',
      category: 'signal',
      code: 'SIGNAL_EVALUATION_BLOCKED',
      message: `Signal ${symbol} BLOCKED: ${evaluation.reasonCodes.join(', ')}`,
      meta: { reasonCodes: evaluation.reasonCodes },
    }).catch(() => undefined);
    return { runId, outcome: 'BLOCKED', durationMs: Date.now() - startedMs, evaluation, quoteReport: null };
  };

  // ── Gate 1: symbol allowlist ─────────────────────────────────────────────
  if (!config.market.symbols.includes(symbol)) {
    return blockedOutcome(['SYMBOL_NOT_ALLOWED'], { note: 'symbol not in allowlist' });
  }

  try {
    // ── Gate 2: live quote integrity (verified broker feed or nothing) ────
    const quoteReport = await quoteIntegrity(symbol);
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

    // ── Gate 3: verified symbol specification ──────────────────────────────
    const spec = await db.symbolSpec.findUnique({ where: { symbol } }).catch(() => null);
    const digits = spec?.digits ?? null;
    if (digits === null) {
      return { ...(await blockedOutcome(['SPEC_MISSING'], minimalQuote)), quoteReport };
    }

    // ── Gate 4: market-data readiness (tick + per-TF freshness) ───────────
    const readiness = await computeReadiness({
      symbol,
      timeframes: [rules.executionTf, ...rules.contextTfs],
      now: () => nowMs(),
    });
    if (!readiness.ready) {
      const codes = readiness.errorCodes
        .map((c): SignalReasonCode => {
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
      const blocked = await blockedOutcome(codes.length ? codes : ['DATA_INVALID'], minimalQuote);
      return { ...blocked, quoteReport };
    }

    // ── Gate 5: load closed-candle windows (Phase 4 loader semantics) ─────
    const windows = await loadSignalWindows(db, symbol, rules, nowUtcSec);
    if (windows.demoRows) {
      return { ...(await blockedOutcome(['SOURCE_DEMO', 'SOURCE_NOT_BROKER'], minimalQuote)), quoteReport };
    }
    if (windows.windowGapsSuspicious > 0) {
      return { ...(await blockedOutcome(['GAP_IN_WINDOW', 'DATA_INVALID'], minimalQuote)), quoteReport };
    }

    // ── Deterministic core evaluation ─────────────────────────────────────
    const bid = quoteReport.bid !== null ? Number(quoteReport.bid) : null;
    const ask = quoteReport.ask !== null ? Number(quoteReport.ask) : null;
    if (bid === null || ask === null) {
      return { ...(await blockedOutcome(['QUOTE_UNAVAILABLE'], minimalQuote)), quoteReport };
    }
    const mid = (bid + ask) / 2;
    const spread = Number(quoteReport.spread ?? (ask - bid));

    const evaluation = evaluateSignal({
      symbol,
      digits: windows.digits,
      execution: windows.execution,
      h1: windows.h1,
      h4: windows.h4,
      referencePrice: mid,
      spreadPrice: spread,
      nowUtcSec,
      rules,
    });

    const runId = await persist(evaluation, minimalQuote);
    await logEvent({
      level:
        evaluation.outcome === 'BUY_SETUP' || evaluation.outcome === 'SELL_SETUP'
          ? 'info'
          : evaluation.outcome === 'FAILED'
            ? 'error'
            : 'info',
      category: 'signal',
      code: `SIGNAL_${evaluation.outcome}`,
      message: `Signal ${symbol} → ${evaluation.outcome}${
        evaluation.reasonCodes.length ? ` [${evaluation.reasonCodes.join(',')}]` : ''
      } fp=${evaluation.inputFingerprint.slice(0, 12)}`,
      meta: {
        outcome: evaluation.outcome,
        reasonCodes: evaluation.reasonCodes,
        fingerprint: evaluation.inputFingerprint,
        executionLocked: true,
      },
    }).catch(() => undefined);

    return {
      runId,
      outcome: evaluation.outcome,
      durationMs: Date.now() - startedMs,
      evaluation,
      quoteReport,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown signal failure';
    const evaluation = failedSignalEvaluation(symbol, nowUtcSec, message);
    const runId = await persist(evaluation, { note: 'exception path' });
    await logEvent({
      level: 'error',
      category: 'signal',
      code: 'SIGNAL_EVALUATION_FAILED',
      message: `Signal ${symbol} failed: ${message.slice(0, 200)}`,
      meta: { errorCode: 'SIGNAL_ERROR' },
    }).catch(() => undefined);
    return { runId, outcome: 'FAILED', durationMs: Date.now() - startedMs, evaluation, quoteReport: null };
  }
}
