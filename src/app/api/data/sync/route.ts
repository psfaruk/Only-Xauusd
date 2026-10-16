/**
 * POST /api/data/sync — trigger a market-data sync run (Phase 3).
 *
 * READ-ONLY data ingestion: pulls candles/ticks from the bridge and writes
 * validated rows to the local database. It NEVER places, modifies or closes
 * orders — no such functionality exists in this codebase.
 *
 * Body: { symbol, timeframes?, mode: "manual"|"backfill", rangeStartUtc?, rangeEndUtc? }
 * Backfill ranges are bounded (MARKET_BACKFILL_MAX_DAYS / _MAX_BARS).
 * Heavily rate-limited; bearer-gated when DATA_API_TOKEN is configured
 * (Phase 13 preview opt-in: MARKET_API_PUBLIC_TRIGGERS=true opens triggers
 * only when no token is set — broker-read-only, still rate-limited).
 */

import { guardDataApi, jsonError } from '@/lib/api-guard';
import { triggerSync } from '@/lib/market/service';
import { SyncTriggerSchema } from '@/lib/market/schemas';
import { ErrorCode } from '@/lib/market/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  const guard = guardDataApi(request, 'trigger');
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, ErrorCode.BAD_REQUEST, 'Request body must be valid JSON.');
  }

  const parsed = SyncTriggerSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      400,
      ErrorCode.BAD_REQUEST,
      `Invalid request body: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  try {
    const result = await triggerSync(parsed.data);
    return Response.json(result, { status: result.outcome.status === 'success' ? 200 : 503 });
  } catch (err) {
    return jsonError(500, ErrorCode.DB_ERROR, err instanceof Error ? err.message : 'sync failed');
  }
}

export async function GET() {
  return Response.json(
    {
      endpoint: '/api/data/sync',
      method: 'POST',
      body: {
        symbol: 'string (allowlisted, e.g. XAUUSDm)',
        timeframes: 'array of M5|M15|H1|H4 (optional, defaults to configured allowlist)',
        mode: '"manual" | "backfill"',
        rangeStartUtc: 'UTC ISO-8601 (required for backfill)',
        rangeEndUtc: 'UTC ISO-8601 (required for backfill)',
      },
      description: 'Triggers a read-only market-data sync run. No order/trade functionality exists.',
    },
    { status: 200 },
  );
}
