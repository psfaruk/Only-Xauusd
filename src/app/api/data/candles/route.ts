/**
 * GET /api/data/candles — validated market candles (Phase 3).
 * Strict symbol/timeframe allowlists, bounded limit (≤1000) and range (≤90d),
 * UTC ISO-8601 timestamps, exact decimal price strings. Forming candles are
 * EXCLUDED by default — they are never confirmed historical data.
 */

import { guardDataApi, jsonError, parseQuery } from '@/lib/api-guard';
import { getCandles } from '@/lib/market/service';
import { CandlesQuerySchema } from '@/lib/market/schemas';
import { ErrorCode } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const query = parseQuery(CandlesQuerySchema, {
    symbol: url.searchParams.get('symbol') ?? undefined,
    tf: url.searchParams.get('tf') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    includeForming: url.searchParams.get('includeForming') ?? undefined,
  });
  if (!query.ok) return query.response;

  try {
    return Response.json(await getCandles(query.data));
  } catch (err) {
    return jsonError(500, ErrorCode.DB_ERROR, err instanceof Error ? err.message : 'database error');
  }
}
