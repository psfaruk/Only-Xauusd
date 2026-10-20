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
import type { BridgeClient } from '@/lib/market/bridge-client';
import { computeReadiness } from '@/lib/market/quality';
import { defaultMarketSymbol } from '@/lib/market/service';
import type { QuoteIntegrityReport } from '@/lib/market/integrity';
import { SIGNAL_ENGINE_VERSION, type SignalEvaluation, type SignalReasonCode } from './types';
import { evaluateSignal, failedSignalEvaluation } from './core';
import { buildStrategyRules } from './rules';
import { loadSignalWindows, saveSignalEvaluation } from './persistence';
import { trackPaperSignals } from './paper';
import { evaluateCandidate } from './candidate/core';
import { CANDIDATE_RULES, CANDIDATE_STRATEGY_VERSION, type CandidateModel } from './candidate/types';
import {
  loadCandidateM5Window,
  saveCandidateEvaluation,
  windowRangeSummary,
} from './candidate-persistence';
import { trackCandidatePaperSignals } from './candidate-paper';

export interface RunSignalOptions {
  symbol?: string;
  /** Injectable clock (epoch ms) — deterministic tests. */
  now?: () => number;
  /** Injectable bridge client (deterministic tests). Default: the app bridge. */
  bridge?: BridgeClient;
}

/** Phase 11-E: additive summary of the CANDIDATE dual evaluation (research only). */
export interface CandidateRunSummary {
  runId: string | null;
  outcome: SignalEvaluation['outcome'];
  model: CandidateModel | null;
  reasonCodes: string[];
  setupFingerprint: string | null;
  inputFingerprint: string;
}

export interface SignalRunOutcome {
  runId: string | null;
  outcome: SignalEvaluation['outcome'];
  durationMs: number;
  evaluation: SignalEvaluation;
  quoteReport: QuoteIntegrityReport | null;
  /** Phase 11-E: the candidate dual evaluation summary — present only when
   *  the candidate step ran (baseline windows loaded + candidate switch on).
   *  Absent ⇒ no candidate row was written for this run. Never affects the
   *  baseline verdict, response codes, or any baseline consumer. */
  candidate?: CandidateRunSummary | null;
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
    /** Verified digits at evaluation time (null when the spec was never
     *  verified — e.g. pre-gate-3 blocks; recorded honestly as unavailable). */
    digits: number | null = null,
  ): Promise<string | null> => {
    try {
      const saved = await saveSignalEvaluation(db, {
        evaluation,
        quote,
        durationMs: Date.now() - startedMs,
        startedAtUtc: startedAt,
        executionTimeframe: rules.executionTf,
        // Phase 10.3-D: the ACTUAL rules object used for this evaluation run.
        rules,
        digits,
      });
      return saved.id;
    } catch {
      return null; // persistence failure must never mask the verdict
    }
  };

  /** Phase 10: advance read-only paper tracking after every evaluation run.
   *  Fire-and-forget, error-isolated — can never affect the verdict.
   *  Phase 11-E: the candidate tracker advances alongside (same discipline). */
  const advancePaperTracking = () => {
    void trackPaperSignals(db, { symbol, now: nowMs }).catch(() => undefined);
    void trackCandidatePaperSignals(db, { symbol, now: nowMs }).catch(() => undefined);
  };

  const blockedOutcome = async (
    codes: SignalReasonCode[],
    quote: Record<string, unknown>,
    digits: number | null = null,
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
    const runId = await persist(evaluation, quote, digits);
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

    // ── Gate 3: verified symbol specification ──────────────────────────────
    const spec = await db.symbolSpec.findUnique({ where: { symbol } }).catch(() => null);
    const digits = spec?.digits ?? null;
    if (digits === null) {
      return { ...(await blockedOutcome(['SPEC_MISSING'], minimalQuote, digits)), quoteReport };
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
      const blocked = await blockedOutcome(codes.length ? codes : ['DATA_INVALID'], minimalQuote, digits);
      return { ...blocked, quoteReport };
    }

    // ── Gate 5: load closed-candle windows (Phase 4 loader semantics) ─────
    const windows = await loadSignalWindows(db, symbol, rules, nowUtcSec);
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

    const runId = await persist(evaluation, minimalQuote, windows.digits);
    advancePaperTracking();
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

    // ── Phase 11-E: CANDIDATE dual evaluation (research-only) ────────────
    // Runs when (and only when) the shared windows loaded successfully
    // (baseline passed gates 1-5 — we are past all of them here). The SAME
    // windows / mid / spread / nowUtcSec the baseline used are passed to
    // evaluateCandidate (deterministic pairing); the candidate adds the M5
    // confirmation window. EVERYTHING here is error-isolated: a candidate
    // failure NEVER changes the baseline outcome, response codes, or paper
    // tracking above. The FORWARD_PAPER_TRACKING switch is REUSED (no new
    // switch): it governs the whole forward-paper research loop — baseline
    // autonomous evaluation + candidate dual evaluation + both trackers.
    let candidate: CandidateRunSummary | null = null;
    if (process.env.FORWARD_PAPER_TRACKING !== '0') {
      try {
        const m5Load = await loadCandidateM5Window(db, symbol, nowUtcSec);
        if (m5Load.demoRows) {
          await logEvent({
            level: 'warn',
            category: 'candidate',
            code: 'CANDIDATE_EVALUATION_SKIPPED',
            message: `Candidate evaluation skipped for ${symbol}: demo-labelled rows in the M5 confirmation window (fail-closed — no candidate row written).`,
            meta: { symbol, reason: 'M5_DEMO_ROWS' },
          }).catch(() => undefined);
        } else if (m5Load.windowGapsSuspicious > 0) {
          await logEvent({
            level: 'warn',
            category: 'candidate',
            code: 'CANDIDATE_EVALUATION_SKIPPED',
            message: `Candidate evaluation skipped for ${symbol}: suspicious gaps in the M5 confirmation window (fail-closed — no candidate row written).`,
            meta: { symbol, reason: 'M5_WINDOW_GAPS', gaps: m5Load.windowGapsSuspicious },
          }).catch(() => undefined);
        } else {
          const candidateEvaluation = evaluateCandidate({
            symbol,
            digits: windows.digits,
            execution: windows.execution,
            h1: windows.h1,
            h4: windows.h4,
            m5: m5Load.m5,
            referencePrice: mid,
            spreadPrice: spread,
            nowUtcSec,
            rules,
          });
          const candidateSaved = await saveCandidateEvaluation(db, {
            evaluation: candidateEvaluation,
            quote: minimalQuote,
            durationMs: Date.now() - startedMs,
            startedAtUtc: startedAt,
            rules,
            digits: windows.digits,
            windows: {
              execution: windowRangeSummary(windows.execution),
              h1: windowRangeSummary(windows.h1),
              h4: windowRangeSummary(windows.h4),
              m5: windowRangeSummary(m5Load.m5),
            },
          });
          candidate = {
            runId: candidateSaved.id,
            outcome: candidateEvaluation.outcome,
            model: candidateEvaluation.model,
            reasonCodes: [...candidateEvaluation.reasonCodes],
            setupFingerprint: candidateEvaluation.setupFingerprint,
            inputFingerprint: candidateEvaluation.inputFingerprint,
          };
          await logEvent({
            level: 'info',
            category: 'candidate',
            code: `CANDIDATE_${candidateEvaluation.outcome}`,
            message: `Candidate ${symbol} → ${candidateEvaluation.outcome}${
              candidateEvaluation.reasonCodes.length ? ` [${candidateEvaluation.reasonCodes.join(',')}]` : ''
            }${candidateEvaluation.model ? ` model=${candidateEvaluation.model}` : ''} fp=${candidateEvaluation.inputFingerprint.slice(0, 12)}`,
            meta: {
              outcome: candidateEvaluation.outcome,
              model: candidateEvaluation.model,
              reasonCodes: candidateEvaluation.reasonCodes,
              fingerprint: candidateEvaluation.inputFingerprint,
              strategyVersion: CANDIDATE_STRATEGY_VERSION,
              m5WindowBars: CANDIDATE_RULES.m5WindowBars,
              executionLocked: true,
            },
          }).catch(() => undefined);
        }
      } catch (candErr) {
        // Error-isolated by contract: log honestly, never touch the baseline.
        await logEvent({
          level: 'error',
          category: 'candidate',
          code: 'CANDIDATE_EVALUATION_FAILED',
          message: `Candidate evaluation failed for ${symbol}: ${
            candErr instanceof Error ? candErr.message.slice(0, 200) : 'unknown error'
          } (baseline verdict unaffected).`,
          meta: { symbol, strategyVersion: CANDIDATE_STRATEGY_VERSION },
        }).catch(() => undefined);
      }
    }

    return {
      runId,
      outcome: evaluation.outcome,
      durationMs: Date.now() - startedMs,
      evaluation,
      quoteReport,
      candidate,
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
