/**
 * GET /api/data/latest — latest validated tick + verified symbol spec (Phase 3).
 * Exactly one tick snapshot per symbol; no high-frequency tick history by
 * design. When no valid quote has been received, tick is null — fail closed.
 */

import { guardDataApi, jsonError, parseQuery } from '@/lib/api-guard';
import { getLatestTick, defaultMarketSymbol } from '@/lib/market/service';
import { LatestQuerySchema } from '@/lib/market/schemas';
import { ErrorCode } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const query = parseQuery(LatestQuerySchema, { symbol: url.searchParams.get('symbol') ?? undefined });
  if (!query.ok) return query.response;

  try {
    return Response.json(await getLatestTick(query.data.symbol ?? defaultMarketSymbol()));
  } catch (err) {
    return jsonError(500, ErrorCode.DB_ERROR, err instanceof Error ? err.message : 'database error');
  }
}
