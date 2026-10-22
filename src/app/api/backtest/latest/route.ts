/**
 * GET /api/backtest/latest — latest backtest record (READ-ONLY, Phase 8).
 * Returns the most recent BacktestRun for the symbol with its dataset
 * fingerprint, period, dev/OOS metrics and limitations. Honest emptiness:
 * null when none exists.
 */

import { NextResponse } from 'next/server';
import { guardDataApi } from '@/lib/api-guard';
import { config } from '@/lib/config';
import { emptyBacktestHonestyBlock, getLatestBacktest } from '@/lib/backtest/service';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  const symbol = new URL(req.url).searchParams.get('symbol') ?? config.market.symbols[0] ?? 'XAUUSDm';
  if (!config.market.symbols.includes(symbol)) {
    return NextResponse.json(
      { ok: false, error: 'SYMBOL_NOT_ALLOWED', detail: `symbol must be one of ${config.market.symbols.join(', ')}` },
      { status: 400 },
    );
  }

  const latest = await getLatestBacktest(symbol);
  return NextResponse.json({
    ok: true,
    symbol,
    latest,
    // Phase 5 honesty block (Task 42-S3): ALWAYS present, even when no run
    // exists — a missing run is INSUFFICIENT_EVIDENCE by definition, and the
    // label must never silently disappear from the surface.
    ...(latest
      ? {
          sampleAdequacy: latest.sampleAdequacy,
          tradeCount: latest.tradeCount,
          uncertaintyNote: latest.uncertaintyNote,
          dataRangeUtc: latest.dataRangeUtc,
          bootstrapCi: latest.bootstrapCi,
        }
      : emptyBacktestHonestyBlock()),
    disclaimer: latest
      ? 'Backtests are simulations, not proof of live profitability.'
      : null,
  });
}
