/**
 * POST /api/backtest/run — TRIGGER endpoint (Phase 8, Task 6).
 * ----------------------------------------------------------------------------
 * Runs the historical backtest simulator over VERIFIED persisted broker
 * candles and stores an honest BacktestRun row. Protected like the other
 * triggers (DATA_API_TOKEN ALWAYS — fail-closed 503 when unset).
 *
 * Body: { symbol?, timeframe? } — both allowlisted. READ-ONLY operation:
 * this endpoint computes analysis; it cannot trade (no such code exists).
 */

import { NextResponse } from 'next/server';
import { guardDataApi } from '@/lib/api-guard';
import { config } from '@/lib/config';
import { isTimeframe } from '@/lib/market/types';
import { runBacktestService } from '@/lib/backtest/service';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const guard = guardDataApi(req, 'trigger');
  if (!guard.ok) return guard.response;

  let body: { symbol?: string; timeframe?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body allowed — defaults below */
  }

  const symbol = body.symbol ?? config.market.symbols[0] ?? 'XAUUSDm';
  if (!config.market.symbols.includes(symbol)) {
    return NextResponse.json(
      { ok: false, error: 'SYMBOL_NOT_ALLOWED', detail: `symbol must be one of ${config.market.symbols.join(', ')}` },
      { status: 400 },
    );
  }
  const timeframe = body.timeframe ?? 'H1';
  if (!isTimeframe(timeframe)) {
    return NextResponse.json(
      { ok: false, error: 'TIMEFRAME_NOT_ALLOWED', detail: 'timeframe must be one of M5, M15, H1, H4' },
      { status: 400 },
    );
  }

  const outcome = await runBacktestService({ symbol, timeframe });
  if (outcome.status === 'failed') {
    return NextResponse.json(
      { ok: false, error: 'BACKTEST_ERROR', detail: outcome.error },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    runId: outcome.runId,
    status: outcome.status,
    disclaimer: 'Backtests are simulations, not proof of live profitability.',
    result: outcome.result,
  });
}
