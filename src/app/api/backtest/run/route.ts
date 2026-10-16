/**
 * POST /api/backtest/run — TRIGGER endpoint (Phase 8, extended Phase 9 Task C).
 * ----------------------------------------------------------------------------
 * Runs a historical backtest over VERIFIED persisted broker candles and
 * stores an honest BacktestRun row. Protected like the other triggers
 * (DATA_API_TOKEN ALWAYS when set; unset → fail-closed 503 unless the
 * explicit MARKET_API_PUBLIC_TRIGGERS=true preview opt-in — Phase 13).
 *
 * Body: { symbol?, timeframe?, strategy? }
 *   · strategy: 'structure-proxy' (Phase 8 single-TF proxy — default) or
 *     'signal-engine' (Phase 9: validates the ACTUAL signal core over
 *     M15+H1+H4 — timeframe is ignored for this strategy).
 *
 * READ-ONLY operation: this endpoint computes analysis; it cannot trade (no
 * such code exists anywhere).
 */

import { NextResponse } from 'next/server';
import { guardDataApi } from '@/lib/api-guard';
import { config } from '@/lib/config';
import { isTimeframe } from '@/lib/market/types';
import { runBacktestService, runSignalBacktestService } from '@/lib/backtest/service';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request) {
  const guard = guardDataApi(req, 'trigger');
  if (!guard.ok) return guard.response;

  let body: { symbol?: string; timeframe?: string; strategy?: string } = {};
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

  const strategy = body.strategy ?? 'structure-proxy';
  if (strategy !== 'structure-proxy' && strategy !== 'signal-engine') {
    return NextResponse.json(
      {
        ok: false,
        error: 'BAD_REQUEST',
        detail: "strategy must be 'structure-proxy' (Phase 8) or 'signal-engine' (Phase 9 validation of the real signal core)",
      },
      { status: 400 },
    );
  }

  if (strategy === 'signal-engine') {
    const outcome = await runSignalBacktestService({ symbol });
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
      strategy: 'signal-engine',
      disclaimer:
        'Backtests are simulations, not proof of live profitability — small samples stay INSUFFICIENT_DATA and are never presented as validation.',
      result: outcome.result,
    });
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
    strategy: 'structure-proxy',
    disclaimer: 'Backtests are simulations, not proof of live profitability.',
    result: outcome.result,
  });
}
