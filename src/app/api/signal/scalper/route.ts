/**
 * /api/signal/scalper — the Phase 12 SCALPER strategy surface.
 *
 *   GET  → latest scalper evaluation + setups emitted in the last hour
 *          (the 5–7/hour cadence counter) + recent setups + auto-execution
 *          posture. READ-ONLY, honest absence when nothing ran yet.
 *   POST → trigger ONE evaluation NOW (same deterministic engine + gates as
 *          the scheduler loop; public-trigger posture identical to
 *          /api/signal/run). The response carries the honest auto-execution
 *          outcome when a setup fired and EXECUTION_AUTO is armed.
 */

import { NextResponse } from 'next/server';
import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { config } from '@/lib/config';
import { runScalperEvaluation, scalperRecentSetups } from '@/lib/signal/scalper-service';
import { buildScalperRules } from '@/lib/signal/scalper/rules';
import { SCALPER_STRATEGY_VERSION } from '@/lib/signal/scalper/types';
import { z } from 'zod';
import { signalSymbolSchema } from '@/lib/signal/schemas';

export const dynamic = 'force-dynamic';

const querySchema = z
  .object({
    symbol: signalSymbolSchema.optional(),
  })
  .strict();

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const parsed = parseQuery(querySchema, {
    symbol: url.searchParams.get('symbol') ?? undefined,
  });
  if (!parsed.ok) return parsed.response;
  const symbol = parsed.data.symbol ?? config.market.symbols[0] ?? 'XAUUSDm';

  try {
    const { latest, setupsLastHour, recentSetups } = await scalperRecentSetups(symbol);
    return NextResponse.json({
      ok: true,
      symbol,
      strategyVersion: SCALPER_STRATEGY_VERSION,
      enabled: config.signal.scalper.enabled,
      execution: {
        enabled: config.execution.enabled,
        auto: config.execution.auto,
        mode: config.tradingMode,
      },
      latest,
      setupsLastHour,
      recentSetups: recentSetups.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        outcome: s.outcome,
        reasonCodes: s.reasonCodes,
        decisionCandleTimeUtc: s.decisionCandleTimeUtc,
        expiryUtc: s.expiryUtc,
        levels: s.levels,
        sourceTimeframe: s.evidence?.scalper?.sourceTimeframe ?? null,
        model: s.evidence?.scalper?.model ?? null,
      })),
      rules: buildScalperRules(),
      note: 'Scalper = M1/M5/M15 OR-logic (any ONE timeframe agreeing is enough). When EXECUTION_AUTO is armed, every emitted setup that passes the risk check is executed automatically (single attempt).',
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL_ERROR', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const guard = guardDataApi(req, 'trigger');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const parsed = parseQuery(querySchema, {
    symbol: url.searchParams.get('symbol') ?? undefined,
  });
  if (!parsed.ok) return parsed.response;
  const symbol = parsed.data.symbol ?? config.market.symbols[0] ?? 'XAUUSDm';

  try {
    const run = await runScalperEvaluation({ symbol, awaitExecution: true });
    return NextResponse.json({
      ok: true,
      symbol,
      strategyVersion: SCALPER_STRATEGY_VERSION,
      runId: run.runId,
      outcome: run.outcome,
      durationMs: run.durationMs,
      evaluation: run.evaluation,
      execution: run.execution ?? null,
      note: 'Manual trigger — same deterministic engine and fail-closed gates as the 1-minute scheduler loop.',
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL_ERROR', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
