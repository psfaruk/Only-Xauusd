/**
 * XAUUSD AI Trading Agent — Analysis Service (Phase 4)
 * ----------------------------------------------------------------------------
 * Thin orchestration for the /api/analysis/* surface, mirroring the Phase 3
 * market service pattern: routes stay thin; the service loads through Phase 3
 * persistence, runs the DETERMINISTIC engine (no LLM anywhere in this path),
 * persists an honest AnalysisRun row and writes the audit trail.
 *
 * Fail-closed rules:
 *   · No data / stale / demo / invalid / under warm-up → BLOCKED result,
 *     persisted as 'blocked', never presented as a completed analysis.
 *   · Exceptions → FAILED result with a safe bounded message (no stack
 *     traces), persisted as 'failed'.
 *   · Symbol/timeframe allowlists enforced again here (defense in depth).
 */

import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { logEvent } from '@/lib/logger';
import { computeReadiness } from '@/lib/market/quality';
import { defaultMarketSymbol } from '@/lib/market/service';
import type { ReadinessResult, Timeframe } from '@/lib/market/types';
import {
  buildCalculationConfig,
  computeAnalysis,
  failedAnalysisResult,
} from './engine';
import {
  buildInputSnapshot,
  loadAnalysisInput,
  saveAnalysisRun,
} from './persistence';
import { ENGINE_VERSION, type AnalysisResult, type CalculationConfig } from './types';

export interface RunAnalysisOptions {
  symbol?: string;
  timeframes?: Timeframe[];
  /** Injectable clock (epoch ms) — deterministic tests. */
  now?: () => number;
}

export interface RunAnalysisOutcome {
  runId: string | null;
  status: AnalysisResult['status'];
  durationMs: number;
  result: AnalysisResult;
}

const calcConfig: CalculationConfig = buildCalculationConfig({
  swingLeft: config.analysis.swingLeft,
  swingRight: config.analysis.swingRight,
  minBarsPerTf: config.analysis.minBarsPerTf,
  maxBarsPerTf: config.analysis.maxBarsPerTf,
});

export async function runAnalysisService(opts: RunAnalysisOptions = {}): Promise<RunAnalysisOutcome> {
  const startedAt = new Date();
  const nowMs = opts.now ?? Date.now;
  const nowUtcSec = Math.floor(nowMs() / 1000);

  const symbol = opts.symbol ?? defaultMarketSymbol();
  const requested = opts.timeframes ?? (config.market.timeframes as readonly Timeframe[]);
  const timeframes = [...new Set(requested)].filter((tf) =>
    (config.market.timeframes as readonly string[]).includes(tf),
  );

  // Allowlist (defense in depth — the API layer already validates).
  if (!config.market.symbols.includes(symbol) || timeframes.length === 0) {
    const result: AnalysisResult = {
      status: 'BLOCKED',
      purpose: 'deterministic-technical-analysis-not-a-signal',
      engineVersion: ENGINE_VERSION,
      symbol,
      timeframes,
      generatedAtUtc: new Date(nowUtcSec * 1000).toISOString(),
      inputData: { perTimeframe: {}, digits: null },
      inputFingerprint: null,
      readiness: [],
      warnings: [],
      reasonCodes: !config.market.symbols.includes(symbol) ? ['SYMBOL_NOT_ALLOWED'] : ['TIMEFRAME_NOT_ALLOWED'],
      calculationConfig: calcConfig,
    };
    const outcome: RunAnalysisOutcome = { runId: null, status: 'BLOCKED', durationMs: 0, result };
    // Persist the honest blocked run (bookkeeping must not mask the verdict).
    try {
      const saved = await saveAnalysisRun(db, {
        result,
        inputSnapshot: { note: 'blocked before load — no input snapshot' },
        durationMs: 0,
        startedAtUtc: startedAt,
      });
      outcome.runId = saved.id;
    } catch {
      // persistence failure must not mask the verdict
    }
    await logEvent({
      level: 'warn',
      category: 'analysis',
      code: 'ANALYSIS_RUN_BLOCKED',
      message: `Analysis ${symbol} blocked before load: ${result.reasonCodes.join(', ')}`,
      meta: { reasonCodes: result.reasonCodes },
    }).catch(() => undefined);
    return outcome;
  }

  try {
    // Phase 3 readiness (freshness + session-aware gaps + demo policy).
    const phase3: ReadinessResult = await computeReadiness({ symbol, timeframes, now: () => nowMs() });

    // Loader: exact closed-candle window per timeframe.
    const loaded = await loadAnalysisInput(db, symbol, timeframes, {
      maxBarsPerTf: config.analysis.maxBarsPerTf,
      nowUtcSec,
    });

    // Deterministic engine.
    const result = computeAnalysis(
      {
        symbol,
        digits: loaded.digits,
        timeframes,
        perTimeframe: loaded.perTimeframe,
        phase3,
        nowUtcSec,
      },
      calcConfig,
    );

    const durationMs = Date.now() - startedAt.getTime();
    const inputSnapshot = buildInputSnapshot(loaded, symbol);
    let runId: string | null = null;
    try {
      const saved = await saveAnalysisRun(db, { result, inputSnapshot, durationMs, startedAtUtc: startedAt });
      runId = saved.id;
    } catch {
      // persistence failure must not mask the verdict
    }

    await logEvent({
      level: result.status === 'COMPLETED' ? 'info' : result.status === 'BLOCKED' ? 'warn' : 'error',
      category: 'analysis',
      code: `ANALYSIS_RUN_${result.status}`,
      message: `Analysis ${symbol} [${timeframes.join('/')}] → ${result.status}${
        result.reasonCodes.length > 0 ? ` [${result.reasonCodes.join(',')}]` : ''
      }${result.inputFingerprint ? ` fp=${result.inputFingerprint.slice(0, 12)}` : ''}`,
      meta: {
        status: result.status,
        reasonCodes: result.reasonCodes,
        fingerprint: result.inputFingerprint,
        candles: Object.fromEntries(
          timeframes.map((tf) => {
            const d = loaded.perTimeframe.get(tf);
            return [tf, d ? d.candles.length : 0];
          }),
        ),
      },
    }).catch(() => undefined);

    return { runId, status: result.status, durationMs, result };
  } catch (err) {
    // Exceptional path — FAILED with a safe, bounded message (never a stack trace).
    const message = err instanceof Error ? err.message : 'unknown analysis failure';
    const result = failedAnalysisResult(symbol, timeframes, calcConfig, nowUtcSec, message);
    const durationMs = Date.now() - startedAt.getTime();
    let runId: string | null = null;
    try {
      const saved = await saveAnalysisRun(db, {
        result,
        inputSnapshot: { note: 'failed before snapshot — no input' },
        durationMs,
        startedAtUtc: startedAt,
      });
      runId = saved.id;
    } catch {
      // bookkeeping failure must not mask the failure
    }
    await logEvent({
      level: 'error',
      category: 'analysis',
      code: 'ANALYSIS_RUN_FAILED',
      message: `Analysis ${symbol} failed: ${message.slice(0, 200)}`,
      meta: { errorCode: 'ANALYSIS_ERROR' },
    }).catch(() => undefined);
    return { runId, status: 'FAILED', durationMs, result };
  }
}
