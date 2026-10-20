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

  // Phase 11 — after an ACTIONABLE outcome: run the deterministic risk gate
  // and (only when the 4-switch lock is armed) create a pending TradeApproval
  // for the human decision. Fire-and-forget, error-isolated — it can never
  // affect the returned verdict. NO order is ever placed here (approvals are
  // decided by POST /api/execution/decide, never automatically).
  if (outcome.outcome === 'BUY_SETUP' || outcome.outcome === 'SELL_SETUP') {
    try {
      const { processActionableSignal } = await import('@/lib/execution/service');
      void processActionableSignal(symbol).catch(() => undefined);
    } catch {
      // the approval pipeline must never break the signal run
    }
  }

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
        note: 'Research signal only — no execution capability exists (four-switch lock engaged).',
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
