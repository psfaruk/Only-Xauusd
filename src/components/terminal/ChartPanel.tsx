'use client';

/**
 * XAUUSD AI Trading Agent — Chart workspace panel (UI-02).
 * ----------------------------------------------------------------------------
 * Professional candlestick chart on REAL persisted broker candles
 * (/api/data/chart — validated MT5 bridge data; no invented prices).
 *
 *   · Timeframes  : H4 / H1 / M15 / M5 (backend allowlist)
 *   · Overlays    : EMA 20 / 50 / 200 (engine-convention series from the API),
 *                   confirmed swing highs/lows, BOS/CHoCH break markers,
 *                   last swing S/R price lines
 *   · States      : loading, empty, stale (per-TF threshold), disconnected
 *                   (bridge down), error + retry — never a fabricated chart
 *   · Resize      : lightweight-charts autoSize (ResizeObserver) — mobile +
 *                   desktop
 *
 * The forming bar (if stored) is appended last and flagged; indicators and
 * structure are computed by the backend over CLOSED candles only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { AlertTriangle, LineChart, RefreshCw, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CHART_TIMEFRAMES, classifyChartFreshness, type ChartTimeframe } from '@/lib/dashboard/nav';
import { trendBn, directionBn, fmtDhaka } from '@/lib/dashboard/i18n';
import type { ChartDataResponse, MarketStatusResponse } from '@/lib/dashboard/types';
import { PriceLevelText } from './bits';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

const EMA_COLORS = { ema20: '#fbbf24', ema50: '#fb923c', ema200: '#f472b6' } as const;

export function ChartPanel({
  symbol,
  priceSpec,
  marketStatus,
  refreshKey,
  heightClass = 'h-[420px] lg:h-[560px]',
  showSummary = true,
}: {
  symbol: string;
  priceSpec: PriceDisplaySpec;
  marketStatus: MarketStatusResponse | null;
  /** bump to refetch (parent refresh loop). */
  refreshKey: number;
  heightClass?: string;
  showSummary?: boolean;
}) {
  const [tf, setTf] = useState<ChartTimeframe>('M15');
  const [data, setData] = useState<ChartDataResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showEma20, setShowEma20] = useState(true);
  const [showEma50, setShowEma50] = useState(true);
  const [showEma200, setShowEma200] = useState(true);
  const [showSwings, setShowSwings] = useState(true);
  const [showEvents, setShowEvents] = useState(true);
  const [showLevels, setShowLevels] = useState(true);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaRefs = useRef<Record<'ema20' | 'ema50' | 'ema200', ISeriesApi<'Line'> | null>>({
    ema20: null,
    ema50: null,
    ema200: null,
  });
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<unknown[]>([]);

  const disconnected =
    marketStatus !== null &&
    (!marketStatus.bridge.configured ||
      !marketStatus.bridge.reachable ||
      !marketStatus.bridge.status?.connected);

  const load = useCallback(
    async (timeframe: ChartTimeframe) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/data/chart?symbol=${encodeURIComponent(symbol)}&tf=${timeframe}&limit=300`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
          setError(body?.error?.code ?? `HTTP ${res.status}`);
          setData(null);
        } else {
          setData((await res.json()) as ChartDataResponse);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'network error');
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [symbol, refreshKey],
  );

  // Fetch on timeframe / parent-refresh change.
  useEffect(() => {
    void load(tf);
  }, [tf, refreshKey, load]);

  // ---- Chart lifecycle (create once) ----------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#09090b' },
        textColor: '#a1a1aa',
        fontFamily: 'var(--font-bengali), system-ui, sans-serif',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#18181b' },
        horzLines: { color: '#18181b' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#52525b', labelBackgroundColor: '#3f3f46' },
        horzLine: { color: '#52525b', labelBackgroundColor: '#3f3f46' },
      },
      rightPriceScale: { borderColor: '#27272a' },
      timeScale: { borderColor: '#27272a', timeVisible: true, secondsVisible: false, rightOffset: 4 },
      localization: {
        // UTC labels — honest timestamps (Dhaka conversion shown in text UI)
        timeFormatter: (t: Time) => new Date((t as number) * 1000).toISOString().slice(11, 16) + ' UTC',
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#16a34a',
      downColor: '#dc2626',
      borderUpColor: '#16a34a',
      borderDownColor: '#dc2626',
      wickUpColor: '#4ade80',
      wickDownColor: '#f87171',
      priceLineVisible: true,
      priceLineColor: '#fbbf24',
      priceLineStyle: LineStyle.Dotted,
    });

    const mkLine = (color: string) =>
      chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

    emaRefs.current.ema20 = mkLine(EMA_COLORS.ema20);
    emaRefs.current.ema50 = mkLine(EMA_COLORS.ema50);
    emaRefs.current.ema200 = mkLine(EMA_COLORS.ema200);
    markersRef.current = createSeriesMarkers(candleSeries, []);

    chartRef.current = chart;
    candleRef.current = candleSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      emaRefs.current = { ema20: null, ema50: null, ema200: null };
      markersRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  // ---- Data → series ----------------------------------------------------------
  useEffect(() => {
    const candleSeries = candleRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !chart || !data) return;

    const digits = data.digits ?? 2;
    candleSeries.applyOptions({
      priceFormat: { type: 'price', precision: digits, minMove: Math.pow(10, -digits) },
    });

    candleSeries.setData(
      data.candles.map((c) => ({
        time: c.t as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    );

    const emaSeries: Array<[keyof typeof emaRefs.current, Array<{ t: number; v: number }> | null]> = [
      ['ema20', data.ema.ema20],
      ['ema50', data.ema.ema50],
      ['ema200', data.ema.ema200],
    ];
    for (const [key, pts] of emaSeries) {
      const s = emaRefs.current[key];
      if (!s) continue;
      s.setData((pts ?? []).map((p) => ({ time: p.t as UTCTimestamp, value: p.v })));
    }

    // Markers: swings + BOS/CHoCH (time must match an existing candle).
    const candleTimes = new Set(data.candles.map((c) => c.t));
    const markers: SeriesMarker<Time>[] = [];
    if (showEvents) {
      for (const e of data.events) {
        if (!candleTimes.has(e.breakCandleTimeUtcSec)) continue;
        markers.push({
          time: e.breakCandleTimeUtcSec as UTCTimestamp,
          position: e.direction === 'bullish' ? 'belowBar' : 'aboveBar',
          color: e.direction === 'bullish' ? '#22c55e' : '#ef4444',
          shape: e.direction === 'bullish' ? 'arrowUp' : 'arrowDown',
          text: `${e.type} ${e.direction === 'bullish' ? '↑' : '↓'}`,
          size: 1,
        });
      }
    }
    if (showSwings) {
      for (const s of data.swings) {
        if (!candleTimes.has(s.timeUtcSec)) continue;
        markers.push({
          time: s.timeUtcSec as UTCTimestamp,
          position: s.kind === 'high' ? 'aboveBar' : 'belowBar',
          color: s.kind === 'high' ? '#f59e0b' : '#f59e0b',
          shape: s.kind === 'high' ? 'circle' : 'circle',
          text: '',
          size: 0.5,
        });
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    markersRef.current?.setMarkers(markers);

    // S/R price lines (remove old, add current).
    for (const line of priceLinesRef.current) {
      try {
        candleSeries.removePriceLine(line as Parameters<ISeriesApi<'Candlestick'>['removePriceLine']>[0]);
      } catch {
        // chart already disposed
      }
    }
    priceLinesRef.current = [];
    if (showLevels) {
      if (data.levels.lastSwingHigh) {
        priceLinesRef.current.push(
          candleSeries.createPriceLine({
            price: data.levels.lastSwingHigh.price,
            color: '#fbbf24',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'S/R হাই',
          }),
        );
      }
      if (data.levels.lastSwingLow) {
        priceLinesRef.current.push(
          candleSeries.createPriceLine({
            price: data.levels.lastSwingLow.price,
            color: '#fbbf24',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'S/R লো',
          }),
        );
      }
    }

    chart.timeScale().fitContent();
  }, [data, showEma20, showEma50, showEma200, showSwings, showEvents, showLevels]);

  // ---- EMA visibility toggles --------------------------------------------------
  useEffect(() => {
    emaRefs.current.ema20?.applyOptions({ visible: showEma20 && !!data?.ema.ema20 });
    emaRefs.current.ema50?.applyOptions({ visible: showEma50 && !!data?.ema.ema50 });
    emaRefs.current.ema200?.applyOptions({ visible: showEma200 && !!data?.ema.ema200 });
  }, [showEma20, showEma50, showEma200, data]);

  const freshness = classifyChartFreshness(data?.meta);
  const lastCandle = data?.candles.length ? data.candles[data.candles.length - 1] : null;
  const prevCandle = data && data.candles.length > 1 ? data.candles[data.candles.length - 2] : null;
  const changeVsPrev =
    lastCandle && prevCandle ? lastCandle.c - prevCandle.c : null;

  const emaLegend = useMemo(
    () =>
      [
        { key: 'ema20' as const, label: 'EMA 20', show: showEma20, set: setShowEma20, pts: data?.ema.ema20 },
        { key: 'ema50' as const, label: 'EMA 50', show: showEma50, set: setShowEma50, pts: data?.ema.ema50 },
        { key: 'ema200' as const, label: 'EMA 200', show: showEma200, set: setShowEma200, pts: data?.ema.ema200 },
      ].filter((e) => e.pts !== null || e.show),
    [data, showEma20, showEma50, showEma200],
  );

  return (
    <section
      aria-label="XAUUSDm ক্যান্ডেলস্টিক চার্ট"
      className="flex h-full flex-col rounded-xl border border-zinc-800 bg-zinc-900/40"
      data-testid="chart-panel"
    >
      {/* Toolbar: timeframes + toggles */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <div
          className="flex overflow-hidden rounded-lg border border-zinc-700"
          role="tablist"
          aria-label="টাইমফ্রেম নির্বাচন"
        >
          {CHART_TIMEFRAMES.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tf === t}
              data-testid={`tf-${t}`}
              onClick={() => setTf(t)}
              className={`min-w-[44px] px-2.5 py-1.5 font-mono text-xs font-semibold transition-colors ${
                tf === t
                  ? 'bg-amber-500/20 text-amber-300'
                  : 'bg-zinc-900/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {emaLegend.map((e) => (
            <button
              key={e.key}
              type="button"
              onClick={() => e.set(!e.show)}
              data-testid={`toggle-${e.key}`}
              aria-pressed={e.show}
              disabled={!e.pts}
              title={e.pts ? `${e.label} দেখান/লুকান` : `${e.label}: পর্যাপ্ত ইতিহাস নেই (সৎ অবস্থা)`}
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                e.show && e.pts
                  ? 'border-zinc-600 bg-zinc-800/80 text-zinc-200'
                  : 'border-zinc-800 bg-transparent text-zinc-600'
              }`}
            >
              <span
                className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{ backgroundColor: EMA_COLORS[e.key] }}
                aria-hidden
              />
              {e.label}
            </button>
          ))}
          <ToggleChip label="সুইং" active={showSwings} onClick={() => setShowSwings((v) => !v)} dataTestId="toggle-swings" />
          <ToggleChip label="BOS/CHoCH" active={showEvents} onClick={() => setShowEvents((v) => !v)} dataTestId="toggle-events" />
          <ToggleChip label="S/R" active={showLevels} onClick={() => setShowLevels((v) => !v)} dataTestId="toggle-levels" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load(tf)}
            disabled={loading}
            aria-label="চার্ট ডেটা রিফ্রেশ"
            data-testid="chart-refresh"
            className="h-7 w-7 p-0 text-zinc-400 hover:text-amber-300"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          </Button>
        </div>
      </div>

      {/* OHLC legend row (real last candle) */}
      {lastCandle && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 font-mono text-[11px] text-zinc-400" data-testid="chart-legend">
          <span className="text-zinc-500">{new Date(lastCandle.t * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC{lastCandle.forming ? ' · ফর্মিং' : ''}</span>
          <span>O <span className="text-zinc-200">{lastCandle.o.toFixed(priceSpec.verified && data?.digits ? data.digits : 2)}</span></span>
          <span>H <span className="text-zinc-200">{lastCandle.h.toFixed(priceSpec.verified && data?.digits ? data.digits : 2)}</span></span>
          <span>L <span className="text-zinc-200">{lastCandle.l.toFixed(priceSpec.verified && data?.digits ? data.digits : 2)}</span></span>
          <span>C <span className={lastCandle.c >= lastCandle.o ? 'text-emerald-400' : 'text-red-400'}>{lastCandle.c.toFixed(priceSpec.verified && data?.digits ? data.digits : 2)}</span></span>
          {changeVsPrev !== null && (
            <span className={changeVsPrev >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {changeVsPrev >= 0 ? '▲' : '▼'} {Math.abs(changeVsPrev).toFixed(priceSpec.verified && data?.digits ? data.digits : 2)}
            </span>
          )}
        </div>
      )}

      {/* Chart area / states */}
      <div className="relative flex-1">
        <div ref={containerRef} className={`w-full ${heightClass}`} role="img" aria-label={`${symbol} ${tf} ক্যান্ডেলস্টিক চার্ট`} />

        {loading && data === null && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/70">
            <Skeleton className="h-full w-full rounded-none" />
            <span className="absolute text-xs text-zinc-400">ব্রোকার-যাচাইকৃত ক্যান্ডেল লোড হচ্ছে…</span>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/85 p-6 text-center" role="alert">
            <AlertTriangle className="h-8 w-8 text-red-400" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-red-300">চার্ট ডেটা আনা যায়নি</p>
              <p className="mt-1 font-mono text-xs text-zinc-400">{error}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                কোনো ডেটা বানানো হয়নি — সংযোগ ফিরলে আবার চেষ্টা করুন।
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => void load(tf)} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> আবার চেষ্টা করুন
            </Button>
          </div>
        )}

        {!loading && !error && data && freshness === 'empty' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950/85 p-6 text-center" role="status">
            <LineChart className="h-8 w-8 text-zinc-600" aria-hidden />
            <p className="text-sm text-zinc-400">এই টাইমফ্রেমে এখনো কোনো ক্যান্ডেল সংরক্ষিত হয়নি — সৎ খালি অবস্থা।</p>
            <p className="text-[11px] text-zinc-500">শিডিউল্ড সিঙ্ক (প্রতি ৫ মিনিট) ক্যান্ডেল জমালে চার্ট স্বয়ংক্রিয়ভাবে আসবে।</p>
          </div>
        )}

        {data && freshness === 'stale' && (
          <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300" role="status">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            ডেটা পুরোনো (STALE) — শেষ বন্ধ ক্যান্ডেল {data.meta.lastClosedUtcSec ? fmtDhaka(new Date(data.meta.lastClosedUtcSec * 1000).toISOString()) : '—'}
          </div>
        )}

        {disconnected && !error && (
          <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300" role="status">
            <WifiOff className="h-3.5 w-3.5" aria-hidden />
            ব্রিজ সংযোগ বিচ্ছিন্ন — দেখানো ক্যান্ডেলগুলো সংরক্ষিত ইতিহাস (সতেজ নয়)
          </div>
        )}
      </div>

      {/* Structure summary (from the same deterministic engine payload) */}
      {showSummary && data && data.meta.closedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/80 px-3 py-2 text-[11px]" data-testid="chart-summary">
          <Badge
            variant="outline"
            className={
              data.structure.trend === 'bullish'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                : data.structure.trend === 'bearish'
                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                  : 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400'
            }
          >
            {tf} কাঠামো: {trendBn[data.structure.trend] ?? data.structure.trend}
          </Badge>
          <span className="font-mono text-zinc-500">
            {data.structure.highLabel}/{data.structure.lowLabel}
          </span>
          {data.events.length > 0 && (() => {
            const e = data.events[data.events.length - 1];
            return (
              <span className="text-zinc-400">
                সর্বশেষ ইভেন্ট:{' '}
                <span className={e.direction === 'bullish' ? 'text-emerald-400' : 'text-red-400'}>
                  {e.type} {directionBn[e.direction] ?? e.direction}
                </span>{' '}
                @ <PriceLevelText value={e.level} spec={priceSpec} className="font-mono" />
              </span>
            );
          })()}
          {data.levels.lastSwingHigh && (
            <span className="text-zinc-500">
              S/R হাই <PriceLevelText value={data.levels.lastSwingHigh.price} spec={priceSpec} className="font-mono text-zinc-300" />
            </span>
          )}
          {data.levels.lastSwingLow && (
            <span className="text-zinc-500">
              S/R লো <PriceLevelText value={data.levels.lastSwingLow.price} spec={priceSpec} className="font-mono text-zinc-300" />
            </span>
          )}
          <span className="ml-auto text-zinc-600">
            {data.meta.closedCount} বন্ধ ক্যান্ডেল{data.meta.formingIncluded ? ' + ১টি ফর্মিং' : ''}
            {data.meta.insufficient.length > 0 && (
              <span className="ml-1 text-amber-500/80" title="পর্যাপ্ত ইতিহাস নেই — সৎ অবস্থা">
                · {data.meta.insufficient.join('/')} অনুপলব্ধ
              </span>
            )}
          </span>
        </div>
      )}
    </section>
  );
}

function ToggleChip({
  label,
  active,
  onClick,
  dataTestId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  dataTestId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={dataTestId}
      className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
        active
          ? 'border-zinc-600 bg-zinc-800/80 text-zinc-200'
          : 'border-zinc-800 bg-transparent text-zinc-600'
      }`}
    >
      {label}
    </button>
  );
}
