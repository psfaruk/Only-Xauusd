/**
 * GET /api/data/health — Phase 8 Data & Signal Health (READ-ONLY).
 * ----------------------------------------------------------------------------
 * One-stop integrity surface for the dashboard:
 *   · quote integrity (source class, freshness, validation, signal gating)
 *   · candle history audit (per-tf counts, gaps, OHLC re-check, H4 coverage)
 *   · last sync bookkeeping
 *
 * No secrets: broker credentials never appear here (login is masked at the
 * bridge and is not even forwarded). Everything is read-only.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guardDataApi } from '@/lib/api-guard';
import { quoteIntegrity, auditCandleHistory } from '@/lib/market/integrity';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  try {
    const symbol = new URL(req.url).searchParams.get('symbol') ?? config.market.symbols[0] ?? 'XAUUSDm';

    const [quote, history] = await Promise.all([
      quoteIntegrity(symbol),
      auditCandleHistory(symbol, config.market.timeframes),
    ]);

    const lastSync = await db.syncRun.findFirst({
      where: { symbol },
      orderBy: { startedAtUtc: 'desc' },
      select: {
        id: true, mode: true, source: true, status: true,
        startedAtUtc: true, endedAtUtc: true, durationMs: true,
        inserted: true, updated: true, rejected: true, duplicates: true,
        errorCode: true,
      },
    });

    return NextResponse.json({
      ok: true,
      purpose: 'data-and-signal-health-read-only',
      symbol,
      quote,
      candleHistory: history,
      lastSync,
      executionLock: {
        enabled: config.execution.enabled,
        reason: config.execution.reason,
        tradingMode: config.tradingMode,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'DATA_HEALTH_ERROR', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
