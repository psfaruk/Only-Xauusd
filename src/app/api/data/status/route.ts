/**
 * GET /api/data/status — market-data status snapshot (Phase 3).
 * Bridge connectivity (cached probe), analysis readiness, latest sync runs,
 * and the effective data configuration. Fail-closed: every unavailable piece
 * is reported as UNAVAILABLE/BRIDGE_* — never fabricated.
 */

import { guardDataApi, jsonError, parseQuery } from '@/lib/api-guard';
import { getMarketStatus, defaultMarketSymbol } from '@/lib/market/service';
import { StatusQuerySchema } from '@/lib/market/schemas';
import { ErrorCode } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const query = parseQuery(StatusQuerySchema, { symbol: url.searchParams.get('symbol') ?? undefined });
  if (!query.ok) return query.response;

  try {
    return Response.json(await getMarketStatus(query.data.symbol ?? defaultMarketSymbol()));
  } catch (err) {
    return jsonError(500, ErrorCode.DB_ERROR, err instanceof Error ? err.message : 'database error');
  }
}
