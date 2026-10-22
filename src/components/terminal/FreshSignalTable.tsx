'use client';

/**
 * FRESH SIGNAL TABLE — the primary signals surface (Task 45, Phase 3+6).
 * ----------------------------------------------------------------------------
 * Displays REAL persisted signals from /api/signal/fresh (server-side
 * freshness policy). Self-contained data lifecycle:
 *   · own 30s poll with pause/resume + manual refresh;
 *   · AbortController cancels obsolete in-flight requests;
 *   · a monotonic request sequence drops out-of-order responses (no races);
 *   · no state updates after unmount; no duplicate timers.
 *
 * HONESTY CONTRACT (mirrors the API):
 *   · an empty table is rendered as an evidence-backed empty state (pipeline
 *     health: engines cycling, data freshness, top rejection reasons) —
 *     NEVER as fabricated rows;
 *   · every status badge is the server's derived freshness status only;
 *   · SMC score (when present) is a confluence score, NOT a win probability.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ChevronLeft, ChevronRight, Inbox, Pause, Play,
  RefreshCw, Search, SlidersHorizontal, Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { fmtDhaka, fmtInd } from '@/lib/dashboard/i18n';
import type { FreshTableResponse, FreshSignalRowView } from '@/lib/dashboard/types';

/* ---------------------------------------------------------------------------
 * Display helpers (pure; mirrored in tests via the API contract)
 * ------------------------------------------------------------------------- */

type StatusKey = FreshSignalRowView['status'];

const STATUS_BADGE_CLASS: Record<StatusKey, string> = {
  FRESH: 'border-up/40 bg-up/10 text-up',
  PENDING: 'border-sun/40 bg-sun/10 text-sun',
  VALIDATED: 'border-up/40 bg-up/10 text-up',
  STALE: 'border-warn/40 bg-warn/10 text-warn',
  EXPIRED: 'border-border-strong bg-muted text-muted-foreground',
  INVALIDATED: 'border-down/40 bg-down/10 text-down',
  REJECTED: 'border-down/40 bg-down/10 text-down',
  DATA_UNAVAILABLE: 'border-warn/40 bg-warn/10 text-warn',
  ENGINE_ERROR: 'border-down/40 bg-down/10 text-down',
};

const STATUS_BN: Record<StatusKey, string> = {
  FRESH: 'সতেজ', PENDING: 'অপেক্ষমাণ', VALIDATED: 'যাচাইকৃত', STALE: 'স্টেল',
  EXPIRED: 'মেয়াদোত্তীর্ণ', INVALIDATED: 'বাতিল', REJECTED: 'প্রত্যাখ্যাত',
  DATA_UNAVAILABLE: 'ডেটা নেই', ENGINE_ERROR: 'ইঞ্জিন ত্রুটি',
};

const DIRECTION_BN: Record<string, string> = { BUY: 'বাই', SELL: 'সেল' };

function fmtAge(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} সে`;
  if (sec < 3600) return `${Math.floor(sec / 60)} মি`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ঘ`;
  return `${Math.floor(sec / 86400)} দিন`;
}

function fmtPrice(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : fmtInd(v, 3);
}

function strategyShort(v: string): string {
  if (v.startsWith('scalper')) return 'স্ক্যালপার';
  if (v.startsWith('hybrid-multimodel')) return 'ক্যান্ডিডেট';
  return 'বেসলাইন';
}

function tfStateBadgeClass(state: string): string {
  if (state === 'FRESH') return 'border-up/40 bg-up/10 text-up';
  if (state === 'STALE') return 'border-warn/40 bg-warn/10 text-warn';
  return 'border-down/40 bg-down/10 text-down';
}

/* ---------------------------------------------------------------------------
 * Filters model
 * ------------------------------------------------------------------------- */

interface FilterState {
  scope: 'live' | 'archive';
  strategy: 'product' | 'baseline' | 'scalper' | 'candidate' | 'all';
  direction: 'ALL' | 'BUY' | 'SELL';
  timeframe: 'ALL' | 'M1' | 'M5' | 'M15' | 'H1' | 'H4';
  status: 'ALL' | StatusKey;
  sort: 'newest' | 'oldest' | 'timeframe' | 'expiry';
  q: string;
  page: number;
}

const DEFAULT_FILTERS: FilterState = {
  scope: 'live', strategy: 'product', direction: 'ALL', timeframe: 'ALL',
  status: 'ALL', sort: 'newest', q: '', page: 1,
};

const STATUS_OPTIONS: StatusKey[] = [
  'FRESH', 'PENDING', 'VALIDATED', 'STALE', 'EXPIRED', 'INVALIDATED',
  'REJECTED', 'DATA_UNAVAILABLE', 'ENGINE_ERROR',
];

const POLL_MS = 30_000;

/* ---------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------- */

export function FreshSignalTable() {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [data, setData] = useState<FreshTableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const [drawerRow, setDrawerRow] = useState<FreshSignalRowView | null>(null);
  /** Monotonic request sequence — only the newest response may set state. */
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const fetchFresh = useCallback(async () => {
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    const p = new URLSearchParams({ symbol: 'XAUUSDm' });
    p.set('scope', filters.scope);
    p.set('strategy', filters.strategy);
    p.set('sort', filters.sort);
    p.set('page', String(filters.page));
    p.set('pageSize', '25');
    if (filters.direction !== 'ALL') p.set('direction', filters.direction);
    if (filters.timeframe !== 'ALL') p.set('timeframe', filters.timeframe);
    if (filters.status !== 'ALL') p.set('status', filters.status);
    if (filters.q.trim().length >= 2) p.set('q', filters.q.trim());
    try {
      const res = await fetch(`/api/signal/fresh?${p.toString()}`, {
        signal: ac.signal,
        headers: { Accept: 'application/json' },
      });
      const body = (await res.json()) as FreshTableResponse & { detail?: string };
      if (!mountedRef.current || seq !== seqRef.current) return; // out-of-order
      if (!res.ok || !body.ok) {
        setError(body.detail ?? body.error ?? `HTTP ${res.status}`);
        setData(null);
      } else {
        setData(body);
        setLastFetchAt(Date.now());
      }
    } catch (e) {
      if (ac.signal.aborted) return; // superseded or unmount — not an error
      if (!mountedRef.current || seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : 'NETWORK_ERROR');
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false);
    }
  }, [filters]);

  // Fetch on mount and whenever filters change.
  useEffect(() => {
    void fetchFresh();
  }, [fetchFresh]);

  // Poll while auto-refresh is on and the tab is visible.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchFresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, fetchFresh]);

  const setFilter = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((f) => ({ ...f, [key]: value, page: key === 'page' ? (value as number) : 1 }));
  };

  const pipeline = data?.pipeline;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const page = data?.page ?? 1;

  const pipelineWarn = useMemo(() => {
    if (!pipeline) return null;
    const dead = pipeline.engines.filter((e) => e.lastEvalAtUtc === null);
    if (dead.length === pipeline.engines.length) return 'কোনো ইঞ্জিন এখনো চলেনি — ডেটা সিঙ্কের অপেক্ষা';
    const staleTfs = Object.entries(pipeline.dataFreshness).filter(([, v]) => v.state !== 'FRESH');
    if (staleTfs.length > 0) return `সতেজতা সমস্যা: ${staleTfs.map(([tf]) => tf).join(', ')}`;
    return null;
  }, [pipeline]);

  return (
    <div className="space-y-4" data-view="fresh-signals">
      {/* ── Header row ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold">ফ্রেশ সিগন্যাল টেবিল</h2>
          <Badge variant="outline" className="border-border bg-panel font-mono text-[10px] text-muted-foreground">
            {filters.scope === 'live' ? 'লাইভ' : 'আর্কাইভ'} · {total} সিগন্যাল
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs"
            onClick={() => setAutoRefresh((v) => !v)}
            aria-pressed={autoRefresh}
            aria-label={autoRefresh ? 'অটো-রিফ্রেশ থামান' : 'অটো-রিফ্রেশ চালু করুন'}
          >
            {autoRefresh ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {autoRefresh ? 'থামান' : 'চালু'}
          </Button>
          <Button
            size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs"
            onClick={() => void fetchFresh()} disabled={loading}
            aria-label="ম্যানুয়াল রিফ্রেশ"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            রিফ্রেশ
          </Button>
          <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
            {lastFetchAt ? `আপডেট ${fmtDhaka(new Date(lastFetchAt).toISOString())}` : '—'}
          </span>
        </div>
      </div>

      {/* ── Pipeline health strip (the "why no signal" observability) ──── */}
      {pipeline && (
        <div className="rounded-xl border border-border bg-panel p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Activity className="h-3.5 w-3.5" aria-hidden /> পাইপলাইন স্বাস্থ্য
            {pipelineWarn && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn">
                <AlertTriangle className="h-3 w-3" aria-hidden /> {pipelineWarn}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
            {Object.entries(pipeline.dataFreshness).map(([tf, v]) => (
              <span key={tf} className="inline-flex items-center gap-1">
                <span className="font-mono text-muted-foreground">{tf}</span>
                <Badge variant="outline" className={cn('px-1 py-0 text-[9px]', tfStateBadgeClass(v.state))}>
                  {v.state === 'FRESH' ? 'সতেজ' : v.state === 'STALE' ? 'স্টেল' : 'নেই'}
                </Badge>
                {v.ageSec !== null && (
                  <span className="font-mono text-[9px] text-muted-foreground">{fmtAge(v.ageSec)}</span>
                )}
              </span>
            ))}
            <span className="text-muted-foreground">·</span>
            {pipeline.engines.map((e) => (
              <span key={e.strategyVersion} className="inline-flex items-center gap-1">
                <span className="text-muted-foreground">{strategyShort(e.strategyVersion)}</span>
                <span className="font-mono text-[10px]">
                  {e.lastEvalAtUtc ? fmtAge((Date.now() - Date.parse(e.lastEvalAtUtc)) / 1000) : '—'}
                </span>
                <span className="text-muted-foreground">আগে</span>
                <span className="font-mono text-[9px] text-muted-foreground">
                  ({e.evals24h} মূল্যায়ন/২৪ঘ, {e.setups24h} সেটআপ)
                </span>
              </span>
            ))}
            {pipeline.tick.mid !== null && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="font-mono">{fmtInd(pipeline.tick.mid, 3)}</span>
              </>
            )}
          </div>
          {pipeline.reasonDistribution24h.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-[10px]">
              <span className="text-muted-foreground">২৪ ঘণ্টার প্রত্যাখ্যান কারণ:</span>
              {pipeline.reasonDistribution24h.slice(0, 6).map((r) => (
                <span key={r.code} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[9px] text-content">
                  {r.code} ×{r.n}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Controls bar ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-panel p-2.5">
        <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <Select value={filters.scope} onValueChange={(v) => setFilter('scope', v as FilterState['scope'])}>
          <SelectTrigger className="h-7 w-[110px] text-xs" aria-label="স্কোপ"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="live" className="text-xs">লাইভ সিগন্যাল</SelectItem>
            <SelectItem value="archive" className="text-xs">আর্কাইভ (সব)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.strategy} onValueChange={(v) => setFilter('strategy', v as FilterState['strategy'])}>
          <SelectTrigger className="h-7 w-[120px] text-xs" aria-label="কৌশল"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="product" className="text-xs">প্রোডাক্ট (ডিফল্ট)</SelectItem>
            <SelectItem value="baseline" className="text-xs">বেসলাইন</SelectItem>
            <SelectItem value="scalper" className="text-xs">স্ক্যালপার</SelectItem>
            <SelectItem value="candidate" className="text-xs">ক্যান্ডিডেট (গবেষণা)</SelectItem>
            <SelectItem value="all" className="text-xs">সব</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.direction} onValueChange={(v) => setFilter('direction', v as FilterState['direction'])}>
          <SelectTrigger className="h-7 w-[90px] text-xs" aria-label="দিক"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL" className="text-xs">সব দিক</SelectItem>
            <SelectItem value="BUY" className="text-xs">বাই</SelectItem>
            <SelectItem value="SELL" className="text-xs">সেল</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.timeframe} onValueChange={(v) => setFilter('timeframe', v as FilterState['timeframe'])}>
          <SelectTrigger className="h-7 w-[90px] text-xs" aria-label="টাইমফ্রেম"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL" className="text-xs">সব TF</SelectItem>
            {['M1', 'M5', 'M15', 'H1', 'H4'].map((tf) => (
              <SelectItem key={tf} value={tf} className="text-xs font-mono">{tf}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={(v) => setFilter('status', v as FilterState['status'])}>
          <SelectTrigger className="h-7 w-[130px] text-xs" aria-label="স্ট্যাটাস"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL" className="text-xs">সব স্ট্যাটাস</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">{STATUS_BN[s]} ({s})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.sort} onValueChange={(v) => setFilter('sort', v as FilterState['sort'])}>
          <SelectTrigger className="h-7 w-[120px] text-xs" aria-label="সাজানো"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="newest" className="text-xs">নতুন আগে</SelectItem>
            <SelectItem value="oldest" className="text-xs">পুরোনো আগে</SelectItem>
            <SelectItem value="timeframe" className="text-xs">টাইমফ্রেম অনুযায়ী</SelectItem>
            <SelectItem value="expiry" className="text-xs">মেয়াদ শীঘ্র আগে</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative min-w-[140px] flex-1 sm:max-w-[220px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={filters.q}
            onChange={(e) => setFilter('q', e.target.value)}
            placeholder="সিগন্যাল আইডি খুঁজুন…"
            className="h-7 pl-7 text-xs"
            aria-label="সিগন্যাল আইডি অনুসন্ধান"
            inputMode="search"
          />
        </div>
      </div>

      {/* ── Error banner ───────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-down/40 bg-down/10 p-3 text-xs text-down" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">সিগন্যাল টেবিল লোড করা যায়নি</p>
            <p className="mt-0.5 font-mono text-[10px] opacity-80">{error}</p>
            <Button size="sm" variant="outline" className="mt-2 h-6 gap-1 px-2 text-[11px]" onClick={() => void fetchFresh()}>
              <RefreshCw className="h-3 w-3" /> আবার চেষ্টা করুন
            </Button>
          </div>
        </div>
      )}

      {/* ── Loading skeleton ───────────────────────────────────────────── */}
      {loading && !data && (
        <div className="space-y-2 rounded-xl border border-border bg-panel p-3">
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      )}

      {/* ── Empty state (evidence-backed, never fabricated) ─────────────── */}
      {!error && data && rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-border-strong bg-surface p-5">
          <div className="flex items-start gap-3">
            <Inbox className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="space-y-2 text-xs leading-relaxed">
              <p className="font-medium">
                {filters.scope === 'live'
                  ? 'এই মুহূর্তে কোনো লাইভ সিগন্যাল নেই'
                  : 'নির্বাচিত ফিল্টারে কোনো সিগন্যাল মেলেনি'}
              </p>
              <p className="text-muted-foreground">
                {data.scanned > 0 ? (
                  <>
                    ইঞ্জিন চলছে — সর্বশেষ {data.scanned} টি মূল্যায়ন স্ক্যান করা হয়েছে, এখনো কোনো
                    সেটআপ শর্ত পূরণ করেনি। এটি কৌশলটির স্বাভাবিক নির্বাচনী ধীরগতি
                    (৬-মাসের ব্যাকটেস্ট অনুযায়ী ≈ দিনে ০.২–০.৪ সেটআপ) — পাইপলাইন ভাঙা নয়।
                  </>
                ) : (
                  'এখনো কোনো মূল্যায়ন রেকর্ড হয়নি — ডেটা সিঙ্ক শুরু হওয়ার অপেক্ষায়।'
                )}
              </p>
              {pipeline && pipeline.reasonDistribution24h.length > 0 && (
                <p className="text-muted-foreground">
                  সাম্প্রতিক প্রত্যাখ্যানের কারণ: {pipeline.reasonDistribution24h.map((r) => `${r.code} (${r.n})`).join(', ')}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">
                সিগন্যাল তৈরি হলে সেটি স্বয়ংক্রিয়ভাবে এই টেবিলে আসবে — কোনো সিগন্যাল কৃত্রিমভাবে তৈরি করা হয় না।
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Desktop table ──────────────────────────────────────────────── */}
      {!error && data && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-panel">
          <table className="w-full min-w-[1180px] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2.5 py-2 font-medium">সিগন্যাল আইডি</th>
                <th className="px-2.5 py-2 font-medium">দিক</th>
                <th className="px-2.5 py-2 font-medium">স্ট্যাটাস</th>
                <th className="px-2.5 py-2 font-medium">এন্ট্রি</th>
                <th className="px-2.5 py-2 font-medium">স্টপ-লস</th>
                <th className="px-2.5 py-2 font-medium">টার্গেট</th>
                <th className="px-2.5 py-2 font-medium">R:R</th>
                <th className="px-2.5 py-2 font-medium">TF</th>
                <th className="px-2.5 py-2 font-medium">কৌশল</th>
                <th className="px-2.5 py-2 font-medium">SMC</th>
                <th className="px-2.5 py-2 font-medium">তৈরি (ঢাকা)</th>
                <th className="px-2.5 py-2 font-medium">ডেটা সময়</th>
                <th className="px-2.5 py-2 font-medium">বয়স</th>
                <th className="px-2.5 py-2 font-medium">মেয়াদ</th>
                <th className="px-2.5 py-2 font-medium">বর্তমান</th>
                <th className="px-2.5 py-2 font-medium">মুভমেন্ট</th>
                <th className="px-2.5 py-2 font-medium">পেপার</th>
                <th className="px-2.5 py-2 font-medium">কারণ</th>
                <th className="px-2.5 py-2 font-medium">বিস্তারিত</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-surface"
                  onClick={() => setDrawerRow(r)}
                >
                  <td className="px-2.5 py-2 font-mono text-[10px] text-muted-foreground">{r.id.slice(-10)}</td>
                  <td className="px-2.5 py-2">
                    {r.direction ? (
                      <Badge variant="outline" className={cn('px-1.5 text-[10px]', r.direction === 'BUY' ? 'border-up/40 bg-up/10 text-up' : 'border-down/40 bg-down/10 text-down')}>
                        {DIRECTION_BN[r.direction]}
                      </Badge>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-2.5 py-2">
                    <Badge variant="outline" className={cn('px-1.5 text-[10px]', STATUS_BADGE_CLASS[r.status])} title={r.statusBn}>
                      {STATUS_BN[r.status]}
                    </Badge>
                  </td>
                  <td className="px-2.5 py-2 font-mono tabular-nums">{fmtPrice(r.levels.entryReference)}</td>
                  <td className="px-2.5 py-2 font-mono tabular-nums text-down">{fmtPrice(r.levels.stopLoss)}</td>
                  <td className="px-2.5 py-2 font-mono tabular-nums text-up">{fmtPrice(r.levels.target)}</td>
                  <td className="px-2.5 py-2 font-mono tabular-nums">{r.levels.rewardRiskRatio !== null ? fmtInd(r.levels.rewardRiskRatio, 2) : '—'}</td>
                  <td className="px-2.5 py-2 font-mono">{r.sourceTimeframe ?? '—'}</td>
                  <td className="px-2.5 py-2">{strategyShort(r.strategyVersion)}</td>
                  <td className="px-2.5 py-2 font-mono tabular-nums">{r.smc ? `${r.smc.score}${r.smc.tier ? `/${r.smc.tier}` : ''}` : '—'}</td>
                  <td className="px-2.5 py-2 whitespace-nowrap text-muted-foreground">{fmtDhaka(r.createdAtUtc)}</td>
                  <td className="px-2.5 py-2 whitespace-nowrap text-muted-foreground">{r.marketDataTimeUtc ? fmtDhaka(r.marketDataTimeUtc) : '—'}</td>
                  <td className="px-2.5 py-2 font-mono">{fmtAge(r.ageSec)}</td>
                  <td className="px-2.5 py-2 whitespace-nowrap text-muted-foreground">{r.expiryUtc ? fmtDhaka(r.expiryUtc) : '—'}</td>
                  <td className="px-2.5 py-2 font-mono tabular-nums">{r.currentPrice ? fmtPrice(r.currentPrice.price) : '—'}</td>
                  <td className="px-2.5 py-2 font-mono tabular-nums">
                    {r.movementPrice !== null ? (
                      <span className={r.movementPrice >= 0 ? 'text-up' : 'text-down'}>
                        {r.movementPrice >= 0 ? '+' : ''}{fmtInd(r.movementPrice, 3)}
                        {r.movementR !== null && <span className="ml-1 text-[9px] opacity-70">({r.movementR >= 0 ? '+' : ''}{fmtInd(r.movementR, 2)}R)</span>}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-2.5 py-2 text-[10px]">
                    {r.paper ? (
                      <span className="font-mono">
                        {r.paper.status === 'open' ? `খোলা (${r.paper.observations})` : (r.paper.outcome ?? 'সমাধান')}
                        {r.paper.rMultiple !== null && <span className="ml-1 opacity-70">({fmtInd(r.paper.rMultiple, 2)}R)</span>}
                      </span>
                    ) : <span className="text-muted-foreground">নেই</span>}
                  </td>
                  <td className="max-w-[160px] truncate px-2.5 py-2 font-mono text-[9px] text-muted-foreground" title={r.reasonSummaryBn}>
                    {r.reasonCodes.length > 0 ? r.reasonCodes.join(', ') : '—'}
                  </td>
                  <td className="px-2.5 py-2">
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={(e) => { e.stopPropagation(); setDrawerRow(r); }}>
                      দেখুন
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Mobile cards ───────────────────────────────────────────────── */}
      {!error && data && rows.length > 0 && (
        <div className="space-y-2 md:hidden">
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setDrawerRow(r)}
              className="w-full rounded-xl border border-border bg-panel p-3 text-left transition-colors hover:bg-surface"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  {r.direction && (
                    <Badge variant="outline" className={cn('px-1.5 text-[10px]', r.direction === 'BUY' ? 'border-up/40 bg-up/10 text-up' : 'border-down/40 bg-down/10 text-down')}>
                      {DIRECTION_BN[r.direction]}
                    </Badge>
                  )}
                  <Badge variant="outline" className={cn('px-1.5 text-[10px]', STATUS_BADGE_CLASS[r.status])}>{STATUS_BN[r.status]}</Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">{r.sourceTimeframe ?? '—'}</span>
                </div>
                <span className="font-mono text-[10px] text-muted-foreground">{fmtAge(r.ageSec)}</span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] tabular-nums">
                <span>এন্ট্রি {fmtPrice(r.levels.entryReference)}</span>
                <span className="text-down">SL {fmtPrice(r.levels.stopLoss)}</span>
                <span className="text-up">TP {fmtPrice(r.levels.target)}</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                <span>{strategyShort(r.strategyVersion)} · {r.id.slice(-8)}</span>
                <span>{r.currentPrice ? fmtPrice(r.currentPrice.price) : '—'}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ── Pagination ─────────────────────────────────────────────────── */}
      {!error && data && total > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-mono text-[10px]">
            পৃষ্ঠা {page}/{totalPages} · মোট {total}
          </span>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={page <= 1}
              onClick={() => setFilter('page', page - 1)} aria-label="আগের পৃষ্ঠা">
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={page >= totalPages}
              onClick={() => setFilter('page', page + 1)} aria-label="পরের পৃষ্ঠা">
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Details drawer ─────────────────────────────────────────────── */}
      <Sheet open={drawerRow !== null} onOpenChange={(open) => { if (!open) setDrawerRow(null); }}>
        <SheetContent side="right" className="w-full overflow-hidden p-0 sm:max-w-md">
          {drawerRow && (
            <>
              <SheetHeader className="border-b border-border px-4 py-3">
                <SheetTitle className="flex flex-wrap items-center gap-2 text-sm">
                  {drawerRow.direction && (
                    <Badge variant="outline" className={cn('text-[10px]', drawerRow.direction === 'BUY' ? 'border-up/40 bg-up/10 text-up' : 'border-down/40 bg-down/10 text-down')}>
                      {DIRECTION_BN[drawerRow.direction]}
                    </Badge>
                  )}
                  <Badge variant="outline" className={cn('text-[10px]', STATUS_BADGE_CLASS[drawerRow.status])}>
                    {STATUS_BN[drawerRow.status]}
                  </Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">{drawerRow.id.slice(-10)}</span>
                </SheetTitle>
              </SheetHeader>
              <ScrollArea className="h-[calc(100dvh-4rem)]">
                <div className="space-y-4 px-4 py-4 text-xs">
                  {/* Status explanation */}
                  <p className="rounded-lg bg-muted p-2.5 leading-relaxed text-content">{drawerRow.statusBn}</p>

                  {/* Levels + calc explanation */}
                  <section aria-label="লেভেল">
                    <h4 className="mb-1.5 font-medium">লেভেল ও হিসাব</h4>
                    <div className="space-y-1 rounded-lg border border-border p-2.5 font-mono tabular-nums">
                      <p>এন্ট্রি রেফারেন্স: {fmtPrice(drawerRow.levels.entryReference)}</p>
                      <p>এন্ট্রি জোন: {fmtPrice(drawerRow.levels.entryZoneLow)} – {fmtPrice(drawerRow.levels.entryZoneHigh)}</p>
                      <p className="text-down">স্টপ-লস: {fmtPrice(drawerRow.levels.stopLoss)} (ঝুঁকি {fmtPrice(drawerRow.levels.riskPrice)})</p>
                      <p className="text-up">টার্গেট: {fmtPrice(drawerRow.levels.target)} (প্রত্যাশা {fmtPrice(drawerRow.levels.rewardPrice)})</p>
                      <p>R:R = {drawerRow.levels.rewardRiskRatio !== null ? fmtInd(drawerRow.levels.rewardRiskRatio, 2) : '—'}</p>
                      <p className="font-sans text-[10px] text-muted-foreground">
                        SL অ্যাঙ্কর-সুইং + ATR বাফারের নিচে; টার্গেট নির্দিষ্ট R মাল্টিপল — ইঞ্জিনের ডকুমেন্টেড নিয়মে হিসাবকৃত।
                      </p>
                    </div>
                  </section>

                  {/* SMC score disclosure */}
                  {drawerRow.smc && (
                    <section aria-label="SMC">
                      <h4 className="mb-1.5 font-medium">SMC কনফ্লুয়েন্স</h4>
                      <p className="rounded-lg border border-border p-2.5">
                        স্কোর <span className="font-mono">{drawerRow.smc.score}</span>
                        {drawerRow.smc.tier && <> · টিয়ার <span className="font-mono">{drawerRow.smc.tier}</span></>}
                        <span className="mt-1 block text-[10px] text-muted-foreground">
                          এটি কনফ্লুয়েন্স স্কোর — জয়ের সম্ভাবনা নয়; কোনো সম্ভাবনা-ক্যালিব্রেশন দাবি করা হয় না।
                        </span>
                      </p>
                    </section>
                  )}

                  {/* Validation: passed/failed filters */}
                  <section aria-label="ভ্যালিডেশন">
                    <h4 className="mb-1.5 font-medium">শর্ত-বাই-শর্ত ভ্যালিডেশন</h4>
                    <p className="mb-1.5 text-[11px] text-muted-foreground">{drawerRow.validation.headlineBn}</p>
                    <ul className="space-y-1">
                      {drawerRow.validation.checks.map((c) => (
                        <li key={c.id} className="flex items-start gap-1.5 rounded-md border border-border/60 px-2 py-1.5">
                          <span aria-hidden className={cn('mt-0.5 font-mono text-[10px]',
                            c.passed === true ? 'text-up' : c.passed === false ? 'text-down' : 'text-muted-foreground')}>
                            {c.passed === true ? '✓' : c.passed === false ? '✗' : '—'}
                          </span>
                          <span className="flex-1">
                            <span className="text-[11px]">{c.labelBn}</span>
                            {c.detailBn && <span className="block text-[10px] text-muted-foreground">{c.detailBn}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>

                  {/* Lifecycle timeline */}
                  <section aria-label="লাইফসাইকেল">
                    <h4 className="mb-1.5 font-medium">সিগন্যাল লাইফসাইকেল টাইমলাইন</h4>
                    <ol className="space-y-1.5 border-l border-border pl-3">
                      {drawerRow.lifecycle.map((ev, i) => (
                        <li key={`${ev.event}-${i}`} className="relative">
                          <span className="absolute -left-[17px] top-1 h-2 w-2 rounded-full border border-border bg-panel" aria-hidden />
                          <p className="font-mono text-[10px] text-muted-foreground">{fmtDhaka(ev.atUtc)} · {ev.event}</p>
                          <p className="text-[11px]">{ev.detailBn}</p>
                        </li>
                      ))}
                    </ol>
                  </section>

                  {/* Paper tracking */}
                  <section aria-label="পেপার">
                    <h4 className="mb-1.5 font-medium">পেপার ট্র্যাকিং (রিড-ওনলি)</h4>
                    {drawerRow.paper ? (
                      <div className="space-y-1 rounded-lg border border-border p-2.5 font-mono text-[11px] tabular-nums">
                        <p>স্ট্যাটাস: {drawerRow.paper.status === 'open' ? 'খোলা' : 'সমাধান'}{drawerRow.paper.outcome ? ` — ${drawerRow.paper.outcome}` : ''}</p>
                        <p>পর্যবেক্ষণ: {drawerRow.paper.observations} বার</p>
                        {drawerRow.paper.exitPrice !== null && <p>এক্সিট: {fmtPrice(drawerRow.paper.exitPrice)}</p>}
                        {drawerRow.paper.rMultiple !== null && <p>ফলাফল: {fmtInd(drawerRow.paper.rMultiple, 2)}R</p>}
                        {drawerRow.paper.netPnlPrice !== null && <p>নিট PnL (মডেলকৃত): {fmtInd(drawerRow.paper.netPnlPrice, 3)}</p>}
                      </div>
                    ) : (
                      <p className="rounded-lg border border-dashed border-border-strong p-2.5 text-[11px] text-muted-foreground">
                        এই মূল্যায়নের জন্য পেপার সারি নেই (শুধু প্রকাশিত সেটআপ ট্র্যাক হয়)।
                      </p>
                    )}
                  </section>

                  {/* Provenance */}
                  <section aria-label="উৎস" className="text-[10px] leading-relaxed text-muted-foreground">
                    <h4 className="mb-1 text-xs font-medium text-content">উৎস ও কৌশল</h4>
                    <p className="font-mono">কৌশল: {drawerRow.strategyVersion}</p>
                    <p className="font-mono">ইঞ্জিন: {drawerRow.engineVersion}</p>
                    <p>ডেটা: Exness MT5 ব্রিজ (রিড-ওনলি) · সিদ্ধান্ত ক্যান্ডেল {drawerRow.decisionCandleTimeUtc ? fmtDhaka(drawerRow.decisionCandleTimeUtc) : '—'}</p>
                    <p>তৈরি: {fmtDhaka(drawerRow.createdAtUtc)} · মেয়াদ: {drawerRow.expiryUtc ? fmtDhaka(drawerRow.expiryUtc) : '—'}</p>
                    <p className="mt-2">
                      সতর্কতা: সিগন্যাল গ্যারান্টিড সঠিক বা লাভজনক নয়। ৬-মাসের out-of-sample ব্যাকটেস্টে উভয় কৌশল প্রত্যাখ্যাত —
                      সিগন্যাল গবেষণা-পর্যবেক্ষণের জন্য।
                    </p>
                  </section>
                </div>
              </ScrollArea>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
