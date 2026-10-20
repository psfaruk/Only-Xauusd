/**
 * GET /api/ai/review/latest?symbol=XAUUSDm — latest stored multi-agent review
 * batch (Phase 6): the four agent verdicts + reasoning + the evaluation it
 * refers to. Read bucket guard; honest null when no review exists yet.
 */

import { NextResponse } from 'next/server';
import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { getLatestMultiAgentReview } from '@/lib/ai/multi-agent';
import { defaultMarketSymbol } from '@/lib/market/service';
import { signalLatestQuerySchema } from '@/lib/signal/schemas';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = parseQuery(signalLatestQuerySchema, {
    symbol: url.searchParams.get('symbol') ?? undefined,
  });
  if (!parsed.ok) return parsed.response;

  const symbol = parsed.data.symbol ?? defaultMarketSymbol();
  const review = await getLatestMultiAgentReview(symbol);

  return NextResponse.json({
    ok: true,
    symbol,
    review,
    note: review ? undefined : 'এখনো কোনো মাল্টি-এজেন্ট রিভিউ নেই — POST /api/ai/review দিয়ে চালান।',
    generatedAtUtc: new Date().toISOString(),
  });
}
