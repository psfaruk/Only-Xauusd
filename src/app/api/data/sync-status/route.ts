/**
 * GET /api/data/sync-status — ingestion run history (Phase 3).
 * Recent SyncRun records with honest counts and statuses; aggregate totals.
 * Incomplete runs are visible as partial/failed — never reported as success.
 */

import { guardDataApi, jsonError, parseQuery } from '@/lib/api-guard';
import { getSyncStatus } from '@/lib/market/service';
import { SyncStatusQuerySchema } from '@/lib/market/schemas';
import { ErrorCode } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const query = parseQuery(SyncStatusQuerySchema, {
    limit: url.searchParams.get('limit') ?? undefined,
    symbol: url.searchParams.get('symbol') ?? undefined,
  });
  if (!query.ok) return query.response;

  try {
    return Response.json(await getSyncStatus(query.data.limit, query.data.symbol));
  } catch (err) {
    return jsonError(500, ErrorCode.DB_ERROR, err instanceof Error ? err.message : 'database error');
  }
}
