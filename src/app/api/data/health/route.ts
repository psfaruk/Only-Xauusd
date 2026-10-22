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
import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { quoteIntegrity, auditCandleHistory } from '@/lib/market/integrity';
import { computeFreshnessSnapshot } from '@/lib/market/quality';
import { StatusQuerySchema } from '@/lib/market/schemas';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  try {
    // Master-audit fix A5: the symbol used to be accepted unvalidated (an
    // arbitrary symbol silently produced empty data). Now it follows the same
    // allowlist contract as every sibling data route (400 SYMBOL_NOT_ALLOWED).
    const query = parseQuery(StatusQuerySchema, {
      symbol: new URL(req.url).searchParams.get('symbol') ?? undefined,
    });
    if (!query.ok) return query.response;
    const symbol = query.data.symbol ?? config.market.symbols[0] ?? 'XAUUSDm';

    const [quote, history] = await Promise.all([
      quoteIntegrity(symbol),
      auditCandleHistory(symbol, config.market.timeframes),
    ]);

    // Deep-remediation Phase 2: the single authoritative freshness object —
    // source-tick event/receive times, tick age, per-TF closed-candle
    // staleness (LIVE | STALE | NO_DATA), 24h gap count and the one
    // confirmed-signals permission bit (quote integrity + M1/M5/M15 all LIVE).
    // Reuses the quote report above — no second bridge round-trip.
    const freshness = await computeFreshnessSnapshot({
      symbol,
      timeframes: [...config.market.timeframes],
      quoteReport: quote,
    });

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
      freshness,
      candleHistory: history,
      lastSync,
      executionLock: {
        enabled: false,
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
