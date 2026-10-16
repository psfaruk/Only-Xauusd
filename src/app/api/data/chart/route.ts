/**
 * GET /api/data/chart — UI-02 chart workspace surface (read-only).
 * ----------------------------------------------------------------------------
 * Returns the persisted, validated candles for ONE timeframe plus the
 * deterministic indicator/structure overlays the terminal chart renders:
 *
 *   · candles            — closed candles ascending; the latest forming bar
 *                          (if stored) is appended LAST and flagged forming=1
 *                          (it is real broker data, never analysed).
 *   · ema 20/50/200      — series computed by the SAME src/lib/analysis
 *                          indicators module the engine uses (closed candles
 *                          only; INSUFFICIENT_DATA → null, never faked).
 *   · swings + BOS/CHoCH — SAME detectSwings/scanStructureEvents/
 *                          buildStructureResult functions the engine uses
 *                          (right-side confirmed only — no look-ahead).
 *   · levels             — last confirmed swing high/low (S/R overlay).
 *
 * Strategy logic is NOT duplicated or altered: this endpoint only calls the
 * existing pure analysis functions with the configured swing window. It is a
 * presentation surface — no signal, no recommendation, nothing executable.
 */

import { z } from 'zod';
import { guardDataApi, jsonError, parseQuery } from '@/lib/api-guard';
import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { loadAnalysisInput } from '@/lib/analysis/persistence';
import { emaSeries } from '@/lib/analysis/indicators';
import { detectSwings, type SwingDetectOptions } from '@/lib/analysis/swings';
import { scanStructureEvents, buildStructureResult, type StructureScanConfig } from '@/lib/analysis/structure';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import { AllowedSymbol, AllowedTimeframe } from '@/lib/market/schemas';

export const dynamic = 'force-dynamic';

const ChartQuerySchema = z
  .object({
    symbol: AllowedSymbol,
    tf: AllowedTimeframe,
    limit: z.coerce.number().int().min(60).max(500).default(300),
  })
  .strict();

export async function GET(request: Request) {
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const query = parseQuery(ChartQuerySchema, {
    symbol: url.searchParams.get('symbol') ?? undefined,
    tf: url.searchParams.get('tf') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!query.ok) return query.response;

  const { symbol, tf, limit } = query.data;
  const nowUtcSec = Math.floor(Date.now() / 1000);

  try {
    // Same loader the engine uses: closed, VALID/WARNING rows only, ascending,
    // defensively re-validated at read time. maxBarsPerTf = requested limit.
    const loaded = await loadAnalysisInput(db, symbol, [tf as Timeframe], {
      maxBarsPerTf: limit,
      nowUtcSec,
    });
    const data = loaded.perTimeframe.get(tf as Timeframe);
    const candles = data?.candles ?? [];

    // ---- Forming bar (real, flagged, never analysed) -------------------------
    const formingRow = await db.marketCandle
      .findFirst({
        where: { symbol, timeframe: tf, isForming: true, validationStatus: { in: ['VALID', 'WARNING'] } },
        orderBy: { candleTimeUtc: 'desc' },
      })
      .catch(() => null);
    const lastClosedSec = candles.length > 0 ? candles[candles.length - 1].timeUtcSec : null;
    let formingPoint: { t: number; o: number; h: number; l: number; c: number; v: number | null } | null = null;
    if (
      formingRow &&
      (lastClosedSec === null || formingRow.candleTimeUtc.getTime() / 1000 > lastClosedSec)
    ) {
      const o = Number(formingRow.open);
      const h = Number(formingRow.high);
      const l = Number(formingRow.low);
      const c = Number(formingRow.close);
      if ([o, h, l, c].every((v) => Number.isFinite(v) && v > 0) && h >= Math.max(o, c) && l <= Math.min(o, c) && l <= h) {
        formingPoint = {
          t: Math.floor(formingRow.candleTimeUtc.getTime() / 1000),
          o,
          h,
          l,
          c,
          v: formingRow.tickVolume,
        };
      }
    }

    // ---- EMA overlays (engine conventions; closed candles only) ---------------
    const closes = candles.map((c) => c.close);
    const emaOf = (period: number) => {
      const r = emaSeries(closes, period);
      if (!r.ok) return null;
      const pts: Array<{ t: number; v: number }> = [];
      for (let i = 0; i < candles.length; i++) {
        const v = r.series.values[i];
        if (v !== null && v !== undefined && Number.isFinite(v)) pts.push({ t: candles[i].timeUtcSec, v });
      }
      return pts.length > 0 ? pts : null;
    };

    // ---- Swings + structure (engine functions, configured window) ------------
    const tfSec = TIMEFRAME_SECONDS[tf as Timeframe];
    const det = detectSwings(candles, {
      left: config.analysis.swingLeft,
      right: config.analysis.swingRight,
      tfSec,
      digits: loaded.digits,
    });
    const scan = scanStructureEvents(candles, det.swings, {
      swingLeft: config.analysis.swingLeft,
      swingRight: config.analysis.swingRight,
      tfSec,
      digits: loaded.digits,
    });
    const structure = buildStructureResult(candles, det.swings, scan, {
      swingLeft: config.analysis.swingLeft,
      swingRight: config.analysis.swingRight,
      tfSec,
      digits: loaded.digits,
    });

    // ---- Staleness (per-timeframe configured threshold) ------------------------
    const staleThresholdSec = config.market.staleTfSec[tf as keyof typeof config.market.staleTfSec] ?? 3 * tfSec;
    const stale = lastClosedSec !== null ? nowUtcSec - lastClosedSec > staleThresholdSec : false;

    // ---- Insufficiency notes (honest — never a partial invention) -------------
    const insufficient: string[] = [];
    if (closes.length < 20) insufficient.push('EMA20');
    if (closes.length < 50) insufficient.push('EMA50');
    if (closes.length < 200) insufficient.push('EMA200');

    return Response.json({
      ok: true as const,
      symbol,
      timeframe: tf,
      digits: loaded.digits,
      source: data?.source ?? null,
      generatedAtUtc: new Date().toISOString(),
      candles: [
        ...candles.map((c) => ({
          t: c.timeUtcSec,
          o: c.open,
          h: c.high,
          l: c.low,
          c: c.close,
          v: c.volume,
          forming: false,
        })),
        ...(formingPoint ? [{ ...formingPoint, forming: true }] : []),
      ],
      ema: {
        ema20: emaOf(20),
        ema50: emaOf(50),
        ema200: emaOf(200),
      },
      swings: det.swings.map((s) => ({
        kind: s.kind,
        price: s.price,
        timeUtcSec: s.timeUtcSec,
        confirmedAtUtcSec: s.confirmedAtUtcSec,
      })),
      events: structure.events.map((e) => ({
        type: e.type,
        direction: e.direction,
        level: e.level,
        levelText: e.levelText,
        breakCandleTimeUtcSec: e.breakCandleTimeUtcSec,
        confirmedAtUtcSec: e.confirmedAtUtcSec,
        trendAtBreak: e.trendAtBreak,
      })),
      levels: {
        lastSwingHigh: structure.lastSwingHigh
          ? { price: structure.lastSwingHigh.price, timeUtcSec: structure.lastSwingHigh.timeUtcSec }
          : null,
        lastSwingLow: structure.lastSwingLow
          ? { price: structure.lastSwingLow.price, timeUtcSec: structure.lastSwingLow.timeUtcSec }
          : null,
      },
      structure: { trend: structure.trend, highLabel: structure.highLabel, lowLabel: structure.lowLabel },
      meta: {
        closedCount: candles.length,
        formingIncluded: formingPoint !== null,
        lastClosedUtcSec: lastClosedSec,
        stalenessThresholdSec: staleThresholdSec,
        stale,
        insufficient,
        note: 'Presentation surface over the deterministic analysis engine — structure/swings/EMA use the exact engine functions and configured swing window. Not a signal.',
      },
    });
  } catch (err) {
    return jsonError(500, 'DB_ERROR', err instanceof Error ? err.message : 'database error');
  }
}
