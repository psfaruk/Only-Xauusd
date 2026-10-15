/**
 * GET /api/backtest/latest — latest backtest record (READ-ONLY, Phase 8).
 * Returns the most recent BacktestRun for the symbol with its dataset
 * fingerprint, period, dev/OOS metrics and limitations. Honest emptiness:
 * null when none exists.
 */

import { NextResponse } from 'next/server';
import { guardDataApi } from '@/lib/api-guard';
import { config } from '@/lib/config';
import { getLatestBacktest } from '@/lib/backtest/service';

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
    disclaimer: latest
      ? 'Backtests are simulations, not proof of live profitability.'
      : null,
  });
}
