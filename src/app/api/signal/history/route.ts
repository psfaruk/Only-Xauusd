/**
 * GET /api/signal/history — recent signal evaluations (append-only audit
 * trail). READ-ONLY; bounded (max 100). Honest absence: an empty list when
 * no evaluation has run yet.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { getSignalEvaluationHistory } from '@/lib/signal/persistence';
import { config } from '@/lib/config';
import { signalHistoryQuerySchema } from '@/lib/signal/schemas';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const parsed = parseQuery(signalHistoryQuerySchema, {
    symbol: url.searchParams.get('symbol') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.ok) return parsed.response;
  const symbol = parsed.data.symbol ?? config.market.symbols[0] ?? 'XAUUSDm';

  try {
    const history = await getSignalEvaluationHistory(db, symbol, parsed.data.limit);
    const outcomeCounts = history.reduce<Record<string, number>>((acc, h) => {
      acc[h.outcome] = (acc[h.outcome] ?? 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({
      ok: true,
      symbol,
      count: history.length,
      outcomeCounts,
      history,
      note: 'Append-only trail — earlier evaluations are never overwritten or deleted.',
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL_ERROR', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
