/**
 * POST /api/signal/run — trigger a DETERMINISTIC signal evaluation (Phase 9).
 *
 * RESEARCH SIGNAL ONLY: the outcome (BUY_SETUP / SELL_SETUP / WAIT / NO_SETUP
 * / BLOCKED) is decision-support information. It NEVER triggers a broker
 * command — no order/trade/position functionality exists anywhere in this
 * codebase, and the four-switch execution lock stays engaged.
 *
 * Security: TRIGGER endpoint — DATA_API_TOKEN ALWAYS required (unset → 503
 * fail closed). The only exception is the explicit preview opt-in
 * MARKET_API_PUBLIC_TRIGGERS=true (Phase 13; broker-read-only ops, tight
 * rate limit still applies). Fail-closed data gates run before any setup is
 * evaluated; BLOCKED is a VALID, honest outcome (HTTP 200).
 *
 * Responses:
 *   200 { ok, run, evaluation, quote }  — evaluation ran (any outcome except FAILED)
 *   500 { ok: false, error, run }       — the evaluation itself FAILED
 *        (code SIGNAL_ERROR, safe bounded message).
 */

import { guardDataApi, jsonError } from '@/lib/api-guard';
import { runSignalEvaluation } from '@/lib/signal/service';
import { signalRunBodySchema } from '@/lib/signal/schemas';
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
    // Master-audit fix A5: malformed JSON used to be swallowed into `{}` and
    // then validated as an empty body. Siblings (sync/analysis) reject with
    // 400 — this route now does the same.
    return jsonError(400, ErrorCode.BAD_REQUEST, 'Invalid request body: malformed JSON.');
  }

  const parsed = signalRunBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return jsonError(
      400,
      ErrorCode.BAD_REQUEST,
      `Invalid request body: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const symbol = parsed.data.symbol ?? 'XAUUSDm';
  const outcome = await runSignalEvaluation({ symbol });

  // Phase 0: the Phase 11 approval pipeline hook was REMOVED with the
  // execution module — this endpoint is research-signal-only by construction.

  if (outcome.outcome === 'FAILED') {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'SIGNAL_ERROR',
          message: outcome.evaluation.failureMessage ?? 'signal evaluation failed',
        },
        run: { id: outcome.runId, status: 'failed', durationMs: outcome.durationMs },
      },
      { status: 500 },
    );
  }

  return Response.json(
    {
      ok: true,
      run: {
        id: outcome.runId,
        status: outcome.outcome,
        durationMs: outcome.durationMs,
      },
      evaluation: outcome.evaluation,
      // Phase 11-E (additive): the CANDIDATE dual evaluation summary of this
      // run — present only when the candidate step ran (baseline windows
      // loaded + FORWARD_PAPER_TRACKING on); null otherwise. Research-only;
      // never affects the baseline verdict above.
      candidate: outcome.candidate ?? null,
      quote: outcome.quoteReport
        ? {
            freshness: outcome.quoteReport.freshness,
            sourceClass: outcome.quoteReport.sourceClass,
            sourceLabel: outcome.quoteReport.sourceLabel,
            bid: outcome.quoteReport.bid,
            ask: outcome.quoteReport.ask,
            spread: outcome.quoteReport.spread,
            ageSeconds: outcome.quoteReport.ageSeconds,
            quoteTimeUtc: outcome.quoteReport.quoteTimeUtc,
          }
        : null,
      executionLock: {
        enabled: false,
        note: 'Research signal only — no execution capability exists (execution code removed in Phase 0).',
      },
    },
    { status: 200 },
  );
}

export async function GET() {
  return Response.json(
    {
      endpoint: '/api/signal/run',
      method: 'POST',
      body: { symbol: 'string, allowlisted (optional — defaults to the first allowlisted symbol)' },
      description:
        'Triggers a DETERMINISTIC signal evaluation (research/decision support only — never an execution instruction). Fail-closed data gates: BLOCKED outcomes carry reason codes. Requires DATA_API_TOKEN (fail closed).',
    },
    { status: 200 },
  );
}
