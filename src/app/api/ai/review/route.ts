/**
 * POST /api/ai/review — run the Phase 6 GLM multi-agent review on the latest
 * signal evaluation of a symbol (analyst → critic → risk_reviewer → orchestrator).
 *
 * Body: { symbol?: string, force?: boolean }
 * Guard: trigger bucket (fail-closed posture identical to /api/signal/run).
 *
 * The review is ADVISORY ONLY — it never changes the deterministic signal
 * outcome and never places orders. Results persist in AiReview rows.
 */

import { NextResponse } from 'next/server';
import { guardDataApi, jsonError } from '@/lib/api-guard';
import { runReviewForLatestEvaluation } from '@/lib/ai/multi-agent';
import { defaultMarketSymbol } from '@/lib/market/service';
import { AllowedSymbol } from '@/lib/market/schemas';
import { z } from 'zod';

const BodySchema = z
  .object({
    symbol: AllowedSymbol.optional(),
    force: z.boolean().optional(),
  })
  .strict();

export async function POST(request: Request) {
  const guard = guardDataApi(request, 'trigger');
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'BAD_REQUEST', 'Request body must be valid JSON.');
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      400,
      'BAD_REQUEST',
      `Invalid request body: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const symbol = parsed.data.symbol ?? defaultMarketSymbol();
  const outcome = await runReviewForLatestEvaluation(symbol, { force: parsed.data.force === true });

  return NextResponse.json(
    {
      ok: true,
      ran: outcome.ran,
      reason: outcome.reason,
      review: outcome.result,
      note: 'মাল্টি-এজেন্ট রিভিউ পরামর্শমূলক — নির্ধারিত ইঞ্জিনের ফলাফল কখনো বদলায় না।',
      generatedAtUtc: new Date().toISOString(),
    },
    { status: outcome.ran ? 200 : 200 },
  );
}
