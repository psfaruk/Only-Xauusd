/**
 * GET /api/signal/history — recent signal evaluations (append-only audit
 * trail). READ-ONLY; bounded (max 100). Honest absence: an empty list when
 * no evaluation has run yet.
 *
 * Phase 11-E (additive): default stays BASELINE-scoped (protocol §4 — the
 * candidate can never leak into the default surface). `?strategy=candidate`
 * (validated enum) returns the CANDIDATE dual-evaluation rows, labeled via
 * `strategy` + `strategyVersion` in the response.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { getSignalEvaluationCounts, getSignalEvaluationHistory } from '@/lib/signal/persistence';
import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';
import { CANDIDATE_STRATEGY_VERSION } from '@/lib/signal/candidate/types';
import { config } from '@/lib/config';
import { signalHistoryQuerySchema } from '@/lib/signal/schemas';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const parsed = parseQuery(signalHistoryQuerySchema, {
    symbol: url.searchParams.get('symbol') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    strategy: url.searchParams.get('strategy') ?? undefined,
  });
  if (!parsed.ok) return parsed.response;
  const symbol = parsed.data.symbol ?? config.market.symbols[0] ?? 'XAUUSDm';
  const strategyVersion = parsed.data.strategy === 'candidate' ? CANDIDATE_STRATEGY_VERSION : SIGNAL_STRATEGY_VERSION;

  try {
    const history = await getSignalEvaluationHistory(db, symbol, parsed.data.limit, strategyVersion);
    const outcomeCounts = history.reduce<Record<string, number>>((acc, h) => {
      acc[h.outcome] = (acc[h.outcome] ?? 0) + 1;
      return acc;
    }, {});
    // Phase 10.3-D: all-time counts — EVALUATIONS (audit-trail rows) vs
    // DISTINCT LOGICAL SETUPS (non-null setupFingerprint; legacy/
    // unidentifiable rows are counted as evaluations only, never as setups).
    // Counts are scoped to the SAME strategy as the listed rows.
    const counts = await getSignalEvaluationCounts(db, symbol, strategyVersion);
    return NextResponse.json({
      ok: true,
      symbol,
      // Phase 11-E: explicit strategy label — 'baseline' (default) or
      // 'candidate'; every row in `history` belongs to this strategy.
      strategy: parsed.data.strategy,
      strategyVersion,
      count: history.length,
      counts,
      outcomeCounts,
      history,
      note:
        parsed.data.strategy === 'candidate'
          ? 'Append-only CANDIDATE trail (research-only forward observation, phase11-candidate-forward/1 — never an execution instruction).'
          : 'Append-only trail — earlier evaluations are never overwritten or deleted.',
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL_ERROR', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
