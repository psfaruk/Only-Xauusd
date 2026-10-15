/**
 * POST /api/analysis/run — trigger a deterministic analysis run (Phase 4).
 *
 * ANALYSIS-ONLY: computes a technical-analysis snapshot. It NEVER produces a
 * trade signal, an entry, a position size or any execution instruction — no
 * order/trade/position functionality exists anywhere in this codebase.
 *
 * Security (Phase 4 hardening): TRIGGER endpoints require DATA_API_TOKEN
 * ALWAYS — unset token → 503 MARKET_API_TOKEN_NOT_CONFIGURED (fail closed,
 * no bypass). Heavy rate limiting.
 *
 * Responses:
 *   200 { ok: true, run, analysis }            — analysis ran; analysis.status
 *       is COMPLETED or BLOCKED (blocked is a VALID, honest outcome — data
 *       was unavailable, so nothing was computed).
 *   500 { ok: false, error, run, analysis }    — the run itself FAILED
 *       (code ANALYSIS_ERROR, safe bounded message, no stack trace).
 */

import { guardDataApi, jsonError } from '@/lib/api-guard';
import { runAnalysisService } from '@/lib/analysis/service';
import { AnalysisRunSchema } from '@/lib/analysis/schemas';
import { ErrorCode, type Timeframe } from '@/lib/market/types';

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

  const parsed = AnalysisRunSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      400,
      ErrorCode.BAD_REQUEST,
      `Invalid request body: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const outcome = await runAnalysisService({
    symbol: parsed.data.symbol,
    // The zod layer already enforced the timeframe allowlist; the service
    // re-validates against the live allowlist (defense in depth).
    timeframes: parsed.data.timeframes as Timeframe[] | undefined,
  });

  const payload = {
    ok: outcome.status !== 'FAILED',
    run: {
      id: outcome.runId,
      status: outcome.status,
      durationMs: outcome.durationMs,
    },
    analysis: outcome.result,
  };

  if (outcome.status === 'FAILED') {
    return Response.json(
      {
        ...payload,
        error: {
          code: ErrorCode.ANALYSIS_ERROR,
          message: outcome.result.failureMessage ?? 'analysis failed',
        },
      },
      { status: 500 },
    );
  }
  return Response.json(payload, { status: 200 });
}

export async function GET() {
  return Response.json(
    {
      endpoint: '/api/analysis/run',
      method: 'POST',
      body: {
        symbol: 'string, allowlisted (optional — defaults to the first allowlisted symbol)',
        timeframes: 'array of M5|M15|H1|H4 (optional, max 4, defaults to the configured allowlist)',
      },
      description:
        'Triggers a DETERMINISTIC technical-analysis run (structure + indicators). Analysis-only: no signal, no order, no trade functionality exists. Requires DATA_API_TOKEN (fail closed).',
    },
    { status: 200 },
  );
}
