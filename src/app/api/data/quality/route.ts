/**
 * GET /api/data/quality — data-quality report (Phase 3).
 * Analysis-readiness result, per-timeframe states and staleness thresholds,
 * session-aware gap findings, and open DataQualityIssue records (bounded).
 * Data readiness only — never a trade recommendation.
 */

import { guardDataApi, jsonError, parseQuery } from '@/lib/api-guard';
import { getQualityReport, defaultMarketSymbol } from '@/lib/market/service';
import { QualityQuerySchema } from '@/lib/market/schemas';
import { ErrorCode } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const query = parseQuery(QualityQuerySchema, { symbol: url.searchParams.get('symbol') ?? undefined });
  if (!query.ok) return query.response;

  try {
    const limitRaw = url.searchParams.get('issues');
    const limit = limitRaw ? Math.min(Math.max(1, Number(limitRaw) || 50), 200) : 50;
    return Response.json(await getQualityReport(query.data.symbol ?? defaultMarketSymbol(), limit));
  } catch (err) {
    return jsonError(500, ErrorCode.DB_ERROR, err instanceof Error ? err.message : 'database error');
  }
}
