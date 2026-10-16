/**
 * GET /api/signal/latest — latest persisted signal evaluation + the latest
 * backtest OF THE SIGNAL ENGINE (comparison surface, Phase 9 Task F).
 *
 * READ-ONLY. Honest absence: when no evaluation exists yet, `signal` is null
 * (never a fabricated result). The comparison block reports the latest
 * BacktestRun produced by the CURRENT strategy version only — a proxy-ruleset
 * run is never presented as a signal-engine validation.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { getLatestSignalEvaluation } from '@/lib/signal/persistence';
import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';
import { deriveConditionReport } from '@/lib/signal/conditions';
import { CANDIDATE_STRATEGY_VERSION } from '@/lib/signal/candidate/types';
import { config } from '@/lib/config';
import { signalLatestQuerySchema } from '@/lib/signal/schemas';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const parsed = parseQuery(signalLatestQuerySchema, {
    symbol: url.searchParams.get('symbol') ?? undefined,
  });
  if (!parsed.ok) return parsed.response;
  const symbol = parsed.data.symbol ?? config.market.symbols[0] ?? 'XAUUSDm';

  try {
    const signal = await getLatestSignalEvaluation(db, symbol);

    // Latest backtest run OF THE SIGNAL ENGINE (strategy-version match only).
    const backtestRow = await db.backtestRun
      .findFirst({
        where: { symbol, strategyVersion: SIGNAL_STRATEGY_VERSION },
        orderBy: { createdAt: 'desc' },
      })
      .catch(() => null);
    const backtestComparison = backtestRow
      ? {
          runId: backtestRow.id,
          createdAt: backtestRow.createdAt.toISOString(),
          strategyVersion: backtestRow.strategyVersion,
          timeframe: backtestRow.timeframe,
          status: backtestRow.status,
          datasetFingerprint: backtestRow.datasetFingerprint,
          datasetFromUtc: backtestRow.datasetFromUtc.toISOString(),
          datasetToUtc: backtestRow.datasetToUtc.toISOString(),
          candleCount: backtestRow.candleCount,
          dev: JSON.parse(backtestRow.devMetrics) as Record<string, unknown>,
          oos: JSON.parse(backtestRow.oosMetrics) as Record<string, unknown>,
          limitations: JSON.parse(backtestRow.limitations) as string[],
        }
      : null;

    return NextResponse.json({
      ok: true,
      symbol,
      signal,
      backtestComparison,
      // Phase 11 (section I): read-time derived condition checklist — WHY the
      // latest evaluation did (or did not) produce a signal, per condition,
      // with the strategy-logic vs data-quality split. Derived from the
      // persisted evaluation only (the engine core is untouched).
      conditions: deriveConditionReport(signal ?? null),
      strategyVersions: {
        activeLive: SIGNAL_STRATEGY_VERSION,
        researchCandidate: CANDIDATE_STRATEGY_VERSION,
        candidateStatus: 'offline-research-only (not wired into live evaluation, persistence, or paper tracking; activation gated by audit/phase11-candidate-forward-protocol.md)',
      },
      notes: [
        'Signals are research/decision support only — nothing is ever executed.',
        'The comparison block is the latest backtest run of the CURRENT signal-engine strategy version only.',
      ],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL_ERROR', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
