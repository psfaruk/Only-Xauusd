'use client';

/**
 * XAUUSD AI Trading Agent — Chart workspace panel (UI-02).
 * ----------------------------------------------------------------------------
 * Professional candlestick chart on REAL persisted broker candles
 * (/api/data/chart — validated MT5 bridge data; no invented prices).
 *
 *   · Timeframes  : H4 / H1 / M15 / M5 / M1 (backend allowlist; M1 added in
 *                   the Task 29 sell-miss fix — 60s bars, chart granularity)
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
import { AlertTriangle, LineChart, Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CHART_TIMEFRAMES, classifyChartFreshness, type ChartTimeframe } from '@/lib/dashboard/nav';
import { trendBn, directionBn, fmtDhaka } from '@/lib/dashboard/i18n';
import { mergeTickIntoCandles, type ChartCandlePoint } from '@/lib/dashboard/live-candle';
import { TIMEFRAME_SECONDS } from '@/lib/market/types';
import type { ChartDataResponse, MarketStatusResponse } from '@/lib/dashboard/types';
import type { TickStreamTick } from '@/hooks/use-tick-stream';
import { PriceLevelText } from './bits';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

const EMA_COLORS = { ema20: '#fbbf24', ema50: '#fb923c', ema200: '#f472b6' } as const;

/**
 * Task 39 (UI-03) — theme-aware chart chrome. Reads the design tokens from
 * the document root so the chart follows the active sky-terminal theme
 * (dark navy ⇄ clean white). Candle bodies/wicks and EMA lines stay constant
 * (data-encoding colors that read well on both surfaces).
 */
function chartChrome() {
  const v = (name: string, fallback: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const panel = v('--panel', '#111c2e');
  const content = v('--content', '#c3d2e8');
  const muted = v('--muted', '#17253c');
  const mutedFg = v('--muted-foreground', '#9fb0c7');
  const surface = v('--surface', '#162338');
  const border = v('--border', '#26364d');
  return {
    layout: {
      background: { type: ColorType.Solid, color: panel },
      textColor: content,
    },
    grid: {
      vertLines: { color: muted },
      horzLines: { color: muted },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: mutedFg, labelBackgroundColor: surface },
      horzLine: { color: mutedFg, labelBackgroundColor: surface },
    },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border },
  } as const;
}

export function ChartPanel({
  symbol,
  priceSpec,
  marketStatus,
  refreshKey,
  heightClass = 'h-[420px] lg:h-[560px]',
  showSummary = true,
  liveTick = null,
}: {
  symbol: string;
  priceSpec: PriceDisplaySpec;
  marketStatus: MarketStatusResponse | null;
  /** bump to refetch (parent refresh loop). */
  refreshKey: number;
  heightClass?: string;
  showSummary?: boolean;
  /** Live broker tick from the read-only tick-stream relay — updates the
   *  forming candle in real time between syncs (presentation-layer only,
   *  never persisted/analysed; server truth replaces it on every refetch). */
  liveTick?: TickStreamTick | null;
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
  /** Task 31-d: the tick-merged last candle for the OHLC legend (client-side
   *  view of the forming bar; reset to server truth on every refetch). */
  const [liveLanded, setLiveLanded] = useState<ChartCandlePoint | null>(null);

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
          // Master-audit fix: a network blackhole must not leave the chart in
          // an endless "loading" frame — bounded client-side timeout.
          signal: AbortSignal.timeout(20_000),
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
    setLiveLanded(null); // server truth replaces any tick-merged view
    void load(tf);
  }, [tf, refreshKey, load]);

  // ---- Task 31-d: LIVE forming candle (tick-stream merge) ---------------------
  // A genuine broker tick (same Exness feed) updates the forming bar in real
  // time: close follows the tick, high/low extend, and a bar-boundary tick
  // rolls a fresh forming candle. PURE presentation — never persisted, never
  // analysed; the 30s refetch + 5-min sync remain the source of truth.
  useEffect(() => {
    const series = candleRef.current;
    if (!series || !data || !liveTick || liveTick.symbol !== symbol) return;
    const tfSec = TIMEFRAME_SECONDS[tf === 'M1' ? 'M1' : tf === 'M5' ? 'M5' : tf === 'M15' ? 'M15' : tf === 'H1' ? 'H1' : 'H4'];
    const res = mergeTickIntoCandles(
      data.candles as ChartCandlePoint[],
      liveTick.mid,
      tfSec,
      Date.parse(liveTick.receivedAtUtc) || Date.now(),
    );
    if (!res.landed) return; // out-of-order/invalid — never fabricated
    series.update({
      time: res.landed.t as UTCTimestamp,
      open: res.landed.o,
      high: res.landed.h,
      low: res.landed.l,
      close: res.landed.c,
    });
    setLiveLanded(res.landed);
  }, [liveTick, data, tf, symbol]);

  // ---- Chart lifecycle (create once) ----------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      ...chartChrome(),
      layout: {
        ...chartChrome().layout,
        fontFamily: 'var(--font-bengali), system-ui, sans-serif',
        attributionLogo: false,
      },
      timeScale: { ...chartChrome().timeScale, timeVisible: true, secondsVisible: false, rightOffset: 4 },
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
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
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

  // ---- Task 39 — theme sync: re-apply chart chrome when the theme flips -----
  // A MutationObserver on <html class> is used deliberately: next-themes
  // flips the class in a PARENT effect (after child effects), so reacting to
  // `resolvedTheme` would read the OLD computed colors. The observer fires
  // AFTER the class mutation, so chartChrome() always reads the live theme.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const apply = () => {
      try {
        chart.applyOptions(chartChrome());
      } catch {
        // chart already disposed during theme transition
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
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
          size: 2,
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
  const lastCandle = liveLanded ?? (data?.candles.length ? data.candles[data.candles.length - 1] : null);
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
      className="flex h-full flex-col rounded-xl border border-border bg-panel"
      data-testid="chart-panel"
    >
      {/* Toolbar: timeframes + toggles */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/80 px-3 py-2">
        <div
          className="flex overflow-hidden rounded-lg border border-border-strong"
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
              className={`min-h-[24px] min-w-[44px] px-2.5 py-1 font-mono text-xs font-semibold transition-colors ${
                tf === t
                  ? 'bg-sun/20 text-sun'
                  : 'bg-panel text-content hover:bg-surface hover:text-foreground/90'
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
              className={`min-h-[24px] rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                e.show && e.pts
                  ? 'border-border-strong bg-surface text-foreground/90'
                  : 'border-border bg-transparent text-muted-foreground'
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
            className="h-7 w-7 p-0 text-content hover:text-sun"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          </Button>
        </div>
      </div>

      {/* OHLC legend row (real last candle; tick-merged when the live stream is flowing) */}
      {lastCandle && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 font-mono text-[11px] text-content" data-testid="chart-legend">
          {liveLanded && (
            <span className="flex items-center gap-1 rounded-full border border-up/40 bg-up/10 px-1.5 py-0.5 text-[9px] font-semibold text-up" title="টিক-স্ট্রিম থেকে রিয়েল-টাইম আপডেট (শুধু প্রেজেন্টেশন — সার্ভার ডেটাই সত্য)">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-up" />
              </span>
              লাইভ
            </span>
          )}
          <span className="text-muted-foreground">{new Date(lastCandle.t * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC{lastCandle.forming ? ' · ফর্মিং' : ''}</span>
          <span>O <span className="text-foreground/90">{lastCandle.o.toFixed(priceSpec.verified && data?.digits ? data.digits : 2)}</span></span>
          <span>H <span className="text-foreground/90">{lastCandle.h.toFixed(priceSpec.verified && data?.digits ? data.digits : 2)}</span></span>
          <span>L <span className="text-foreground/90">{lastCandle.l.toFixed(priceSpec.verified && data?.digits ? data.digits : 2)}</span></span>
          <span>C <span className={lastCandle.c >= lastCandle.o ? 'text-up' : 'text-down'}>{lastCandle.c.toFixed(priceSpec.verified && data?.digits ? data.digits : 2)}</span></span>
          {changeVsPrev !== null && (
            <span className={changeVsPrev >= 0 ? 'text-up' : 'text-down'}>
              {changeVsPrev >= 0 ? '▲' : '▼'} {Math.abs(changeVsPrev).toFixed(priceSpec.verified && data?.digits ? data.digits : 2)}
            </span>
          )}
        </div>
      )}

      {/* Chart area / states */}
      <div className="relative flex-1">
        <div ref={containerRef} className={`w-full ${heightClass}`} role="img" aria-label={`${symbol} ${tf} ক্যান্ডেলস্টিক চার্ট`} />

        {loading && data === null && (
          <div className="absolute inset-0 flex items-center justify-center bg-terminal">
            <Skeleton className="h-full w-full rounded-none" />
            <span className="absolute text-xs text-content">ব্রোকার-যাচাইকৃত ক্যান্ডেল লোড হচ্ছে…</span>
          </div>
        )}

        {/* Master-audit fix (TF-switch stale frame): while RE-loading with a
         * previous TF's chart still on screen, dim it + spinner so the frame
         * is never mistaken for the newly-selected timeframe's data. */}
        {loading && data !== null && (
          <div className="absolute inset-0 flex items-center justify-center bg-terminal" role="status" aria-label="নতুন টাইমফ্রেম লোড হচ্ছে">
            <span className="flex items-center gap-2 rounded-lg border border-border-strong bg-panel px-3 py-2 text-xs text-content">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sun" aria-hidden />
              {tf} ডেটা লোড হচ্ছে…
            </span>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-terminal p-6 text-center" role="alert">
            <AlertTriangle className="h-8 w-8 text-down" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-down">চার্ট ডেটা আনা যায়নি</p>
              <p className="mt-1 font-mono text-xs text-content">{error}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                কোনো ডেটা বানানো হয়নি — সংযোগ ফিরলে আবার চেষ্টা করুন।
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => void load(tf)} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> আবার চেষ্টা করুন
            </Button>
          </div>
        )}

        {!loading && !error && data && freshness === 'empty' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-terminal p-6 text-center" role="status">
            <LineChart className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-sm text-content">এই টাইমফ্রেমে এখনো কোনো ক্যান্ডেল সংরক্ষিত হয়নি — সৎ খালি অবস্থা।</p>
            <p className="text-[11px] text-muted-foreground">শিডিউল্ড সিঙ্ক (প্রতি ৫ মিনিট) ক্যান্ডেল জমালে চার্ট স্বয়ংক্রিয়ভাবে আসবে।</p>
          </div>
        )}

        {data && freshness === 'stale' && (
          <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-lg border border-sun/40 bg-sun/10 px-2.5 py-1.5 text-[11px] text-sun" role="status">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            ডেটা পুরোনো (STALE) — শেষ বন্ধ ক্যান্ডেল {data.meta.lastClosedUtcSec ? fmtDhaka(new Date(data.meta.lastClosedUtcSec * 1000).toISOString()) : '—'}
          </div>
        )}

        {disconnected && !error && (
          <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-lg border border-down/40 bg-down/10 px-2.5 py-1.5 text-[11px] text-down" role="status">
            <WifiOff className="h-3.5 w-3.5" aria-hidden />
            ব্রিজ সংযোগ বিচ্ছিন্ন — দেখানো ক্যান্ডেলগুলো সংরক্ষিত ইতিহাস (সতেজ নয়)
          </div>
        )}
      </div>

      {/* Structure summary (from the same deterministic engine payload) */}
      {showSummary && data && data.meta.closedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/80 px-3 py-2 text-[11px]" data-testid="chart-summary">
          <Badge
            variant="outline"
            className={
              data.structure.trend === 'bullish'
                ? 'border-up/40 bg-up/10 text-up'
                : data.structure.trend === 'bearish'
                  ? 'border-down/40 bg-down/10 text-down'
                  : 'border-border-strong/50 bg-muted text-content'
            }
          >
            {tf} কাঠামো: {trendBn[data.structure.trend] ?? data.structure.trend}
          </Badge>
          <span className="font-mono text-muted-foreground">
            {data.structure.highLabel}/{data.structure.lowLabel}
          </span>
          {data.events.length > 0 && (() => {
            const e = data.events[data.events.length - 1];
            return (
              <span className="text-content">
                সর্বশেষ ইভেন্ট:{' '}
                <span className={e.direction === 'bullish' ? 'text-up' : 'text-down'}>
                  {e.type} {directionBn[e.direction] ?? e.direction}
                </span>{' '}
                @ <PriceLevelText value={e.level} spec={priceSpec} className="font-mono" />
              </span>
            );
          })()}
          {data.levels.lastSwingHigh && (
            <span className="text-muted-foreground">
              S/R হাই <PriceLevelText value={data.levels.lastSwingHigh.price} spec={priceSpec} className="font-mono text-content" />
            </span>
          )}
          {data.levels.lastSwingLow && (
            <span className="text-muted-foreground">
              S/R লো <PriceLevelText value={data.levels.lastSwingLow.price} spec={priceSpec} className="font-mono text-content" />
            </span>
          )}
          <span className="ml-auto text-content">
            {data.meta.closedCount} বন্ধ ক্যান্ডেল{data.meta.formingIncluded ? ' + ১টি ফর্মিং' : ''}
            {data.meta.insufficient.length > 0 && (
              <span className="ml-1 text-sun/80" title="পর্যাপ্ত ইতিহাস নেই — সৎ অবস্থা">
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
      className={`min-h-[24px] rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
        active
          ? 'border-border-strong bg-surface text-foreground/90'
          : 'border-border bg-transparent text-muted-foreground'
      }`}
    >
      {label}
    </button>
  );
}
