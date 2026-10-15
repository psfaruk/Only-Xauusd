/**
 * GET /api/analysis/latest — read-only retrieval of the latest analysis run.
 *
 * Returns the most recent AnalysisRun row (any status — completed, blocked,
 * failed are all reported honestly; a failed/incomplete run is never dressed
 * up as a valid analysis). `analysis` is null when no run exists yet or when
 * the stored result JSON is corrupt (reported as absent — never guessed).
 *
 * Security: READ endpoint — bearer token required when DATA_API_TOKEN is set;
 * when unset, only accessible with the explicit MARKET_API_PUBLIC_READS
 * opt-in (preview dashboards only), otherwise 503 fail closed.
 */

import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { db } from '@/lib/db';
import { getLatestAnalysisRun } from '@/lib/analysis/persistence';
import { AnalysisLatestQuerySchema } from '@/lib/analysis/schemas';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = parseQuery(AnalysisLatestQuerySchema, {
    symbol: url.searchParams.get('symbol') ?? undefined,
  });
  if (!parsed.ok) return parsed.response;

  const latest = await getLatestAnalysisRun(db, parsed.data.symbol ?? undefined);

  return Response.json(
    {
      ok: true,
      latest,
      note: 'The latest run of any status, reported honestly. analysis is null when no run exists yet or the stored result is corrupt — never fabricated.',
      generatedAtUtc: new Date().toISOString(),
    },
    { status: 200 },
  );
}
