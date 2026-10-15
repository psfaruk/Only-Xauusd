/**
 * GET /api/signal/history — recent signal evaluations (append-only audit
 * trail). READ-ONLY; bounded (max 100). Honest absence: an empty list when
 * no evaluation has run yet.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { getSignalEvaluationCounts, getSignalEvaluationHistory } from '@/lib/signal/persistence';
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
    // Phase 10.3-D: all-time counts — EVALUATIONS (audit-trail rows) vs
    // DISTINCT LOGICAL SETUPS (non-null setupFingerprint; legacy/
    // unidentifiable rows are counted as evaluations only, never as setups).
    const counts = await getSignalEvaluationCounts(db, symbol);
    return NextResponse.json({
      ok: true,
      symbol,
      count: history.length,
      counts,
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
