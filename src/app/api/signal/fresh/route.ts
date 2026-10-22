/**
 * GET /api/signal/fresh — the Fresh Signal Table feed (Task 45, Phase 3+5).
 * ----------------------------------------------------------------------------
 * Server-side freshness evaluation ONLY (policy: src/lib/signal/freshness).
 * Reads persisted SignalEvaluation + paper ledgers; never fabricates rows.
 * Scope-separated: ?scope=live (default — actionable signals) vs
 * ?scope=archive (full history). Carries the pipeline-health block so the
 * UI can distinguish a HEALTHY SELECTIVE engine (no setup yet, engines
 * cycling, data fresh) from a BROKEN pipeline (stale data, dead engines).
 *
 * Auth: same fail-closed data-API guard as every other signal read.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { config } from '@/lib/config';
import { freshSignalQuerySchema } from '@/lib/signal/schemas';
import { getFreshSignals, getPipelineHealth } from '@/lib/signal/fresh-service';
import { FRESH_SIGNAL_STATUSES, type FreshSignalStatus } from '@/lib/signal/freshness';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const sp = url.searchParams;
  const parsed = parseQuery(freshSignalQuerySchema, {
    symbol: sp.get('symbol') ?? undefined,
    scope: sp.get('scope') ?? undefined,
    strategy: sp.get('strategy') ?? undefined,
    direction: sp.get('direction') ?? undefined,
    timeframe: sp.get('timeframe') ?? undefined,
    status: sp.get('status') ?? undefined,
    fromUtc: sp.get('fromUtc') ?? undefined,
    toUtc: sp.get('toUtc') ?? undefined,
    q: sp.get('q') ?? undefined,
    sort: sp.get('sort') ?? undefined,
    page: sp.get('page') ?? undefined,
    pageSize: sp.get('pageSize') ?? undefined,
  });
  if (!parsed.ok) return parsed.response;

  const symbol = parsed.data.symbol ?? config.market.symbols[0] ?? 'XAUUSDm';
  const statuses = parsed.data.status
    ? (parsed.data.status
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as FreshSignalStatus[])
    : undefined;

  try {
    const [table, pipeline] = await Promise.all([
      getFreshSignals(db, {
        symbol,
        scope: parsed.data.scope,
        strategy: parsed.data.strategy,
        direction: parsed.data.direction,
        timeframe: parsed.data.timeframe,
        statuses,
        fromUtcMs: parsed.data.fromUtc ? Date.parse(parsed.data.fromUtc) : undefined,
        toUtcMs: parsed.data.toUtc ? Date.parse(parsed.data.toUtc) : undefined,
        searchId: parsed.data.q,
        sort: parsed.data.sort,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      }),
      getPipelineHealth(db, symbol),
    ]);

    return NextResponse.json({
      ok: true,
      symbol,
      scope: parsed.data.scope,
      strategy: parsed.data.strategy,
      sort: parsed.data.sort,
      page: table.page,
      pageSize: table.pageSize,
      total: table.total,
      totalPages: table.totalPages,
      scanned: table.scanned,
      rows: table.rows,
      pipeline,
      policy: {
        note: 'freshness evaluated server-side from persisted event timestamps only',
        statuses: FRESH_SIGNAL_STATUSES,
        staleTfSec: config.market.staleTfSec,
      },
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: 'FRESH_TABLE_ERROR',
        detail: e instanceof Error ? e.message : 'unknown error',
      },
      { status: 500 },
    );
  }
}
