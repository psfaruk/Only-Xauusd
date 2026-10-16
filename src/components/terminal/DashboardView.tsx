'use client';

/**
 * XAUUSD AI Trading Agent — Dashboard view (UI-02).
 * ----------------------------------------------------------------------------
 * Mobile "ড্যাশবোর্ড" + desktop right-rail content: market snapshot (tick +
 * per-TF readiness), signal decision (SignalCard) and live system status
 * mini-cards. Every value is bound to a real API payload — NO hardcoded
 * capability claims (fixes audit findings F-05/F-06 from the prior UI audit:
 * the old KPI cards displayed static "Phase-1 era" copy).
 */

import { Bot, Cpu, Database, LockKeyhole, Network, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PriceLevelText } from './bits';
import { SignalCard } from './SignalCard';
import {
  fmtAge,
  fmtDhaka,
  fmtUptime,
  qualityStateBadgeClass,
  qualityStateBn,
  syncStatusBn,
} from '@/lib/dashboard/i18n';
import type {
  DataHealthResponse,
  HealthReport,
  MarketStatusResponse,
  SignalLatestResponse,
} from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

export function MarketSnapshot({
  marketStatus,
  dataHealth,
  priceSpec,
  loading,
  marketError,
}: {
  marketStatus: MarketStatusResponse | null;
  dataHealth: DataHealthResponse | null;
  priceSpec: PriceDisplaySpec;
  loading?: boolean;
  /** Master-audit fix B-D1: API-outage code — rendered as an explicit
   * unavailable banner, NEVER conflated with "no data yet". */
  marketError?: string | null;
}) {
  return (
    <section aria-label="মার্কেট স্ন্যাপশট" className="rounded-xl border border-zinc-800 bg-zinc-900/40" data-testid="market-snapshot">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <Network className="h-4 w-4 text-amber-400" aria-hidden />
        <h2 className="text-sm font-semibold text-zinc-100">মার্কেট স্ন্যাপশট — XAUUSDm</h2>
        {marketStatus && (
          <Badge variant="outline" className={`ml-auto ${qualityStateBadgeClass(marketStatus.readiness.qualityState)}`}>
            {qualityStateBn[marketStatus.readiness.qualityState]}
          </Badge>
        )}
      </div>
      <div className="space-y-3 p-3">
        {marketError && !marketStatus ? (
          <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-2.5 text-xs text-red-300">
            মার্কেট-স্ট্যাটাস API অনুপলব্ধ — <span className="font-mono">{marketError}</span>। এটি "টিক নেই"-এর মতো নয় (fail-closed); সংযোগ ফিরলে ৩০ সেকেন্ডে ডেটা আসবে।
          </p>
        ) : marketStatus?.readiness.tick.bid ? (
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['Bid', marketStatus.readiness.tick.bid, 'text-emerald-400'],
                ['Ask', marketStatus.readiness.tick.ask, 'text-red-400'],
                ['Spread', marketStatus.readiness.tick.spread, 'text-zinc-200'],
              ] as Array<[string, string | null, string]>
            ).map(([k, v, cls]) => (
              <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-center">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</p>
                <p className={`mt-0.5 font-mono text-sm font-semibold ${cls}`}>
                  <PriceLevelText value={v} spec={priceSpec} />
                </p>
              </div>
            ))}
          </div>
        ) : loading ? (
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-zinc-800 p-2.5 text-center text-xs text-zinc-500">
            এখনো কোনো বৈধ টিক সংরক্ষিত হয়নি — কিছু বানানো হয় না।
          </p>
        )}

        {/* Per-TF readiness chips */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(marketStatus?.readiness.timeframes ?? []).map((tf) => (
            <div key={tf.timeframe} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-xs font-semibold text-zinc-100">{tf.timeframe}</span>
                <Badge variant="outline" className={`px-1.5 text-[10px] ${qualityStateBadgeClass(tf.state)}`}>
                  {qualityStateBn[tf.state]}
                </Badge>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                শেষ বন্ধ: {fmtAge(tf.lastClosedCandleAgeSeconds)} আগে
                <br />
                সীমা {fmtAge(tf.stalenessThresholdSeconds)}
              </p>
            </div>
          ))}
        </div>

        {dataHealth?.quote.freshness && (
          <p className="text-[11px] leading-relaxed text-zinc-500">
            কোট সতেজতা: <span className="font-mono text-zinc-300">{dataHealth.quote.freshness}</span> · উৎস{' '}
            <span className="text-zinc-300">{dataHealth.quote.sourceLabel}</span>
            {dataHealth.quote.quoteTimeUtc ? ` · কোট-সময় ${fmtDhaka(dataHealth.quote.quoteTimeUtc)}` : ''}
          </p>
        )}
      </div>
    </section>
  );
}

export function SystemMiniCards({
  health,
  marketStatus,
  loading,
  marketError,
}: {
  health: HealthReport | null;
  marketStatus: MarketStatusResponse | null;
  loading?: boolean;
  /** Master-audit fix B-D1: when the status API is down the bridge card
   * says "অজানা" instead of asserting "কনফিগার করা হয়নি" from a null
   * payload (facts were never fetched, not proven absent). */
  marketError?: string | null;
}) {
  const bridge = marketStatus?.bridge;
  const bridgeConnected = bridge?.configured && bridge?.reachable && bridge.status?.connected === true;
  const bridgeUnknown = !marketStatus && !!marketError;

  const cards = [
    {
      key: 'glm',
      icon: Bot,
      title: 'GLM AI',
      value: health?.glm.status ?? '—',
      state:
        health?.glm.status === 'verified'
          ? { label: 'যাচাইকৃত', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' }
          : health?.glm.status === 'failed'
            ? { label: 'ব্যর্থ', cls: 'border-red-500/40 bg-red-500/10 text-red-400' }
            : { label: 'অযাচাইকৃত', cls: 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400' },
      lines: [
        `সর্বশেষ যাচাই: ${health?.glm.lastCheckedAt ? fmtDhaka(health.glm.lastCheckedAt) : 'এখনো হয়নি'}`,
      ],
    },
    {
      key: 'bridge',
      icon: Network,
      title: 'MT5 ব্রিজ',
      value: bridgeUnknown
        ? 'অজানা (স্ট্যাটাস API ডাউন)'
        : !marketStatus
          ? '—'
          : bridgeConnected
            ? (bridge?.status?.server ?? 'সংযুক্ত')
            : bridge?.configured
              ? 'সংযোগ নেই'
              : 'কনফিগার করা হয়নি',
      state: bridgeConnected
        ? { label: bridge?.status?.source === 'demo' ? 'ডেমো ফিড' : 'সংযুক্ত', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' }
        : bridgeUnknown
          ? { label: 'অজানা', cls: 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400' }
          : { label: marketStatus ? 'বিচ্ছিন্ন' : '—', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
      lines: [
        bridge?.status?.latencyMs != null ? `লেটেন্সি ${bridge.status.latencyMs}ms` : 'লেটেন্সি —',
        `সিঙ্ক: ${marketStatus?.sync.lastRun ? syncStatusBn(marketStatus.sync.lastRun.status) : 'এখনো নেই'}${
          marketStatus?.config.syncIntervalMs ? ` · প্রতি ${Math.round(marketStatus.config.syncIntervalMs / 60000)} মিনিটে` : ''
        }`,
      ],
    },
    {
      key: 'db',
      icon: Database,
      title: 'ডেটাবেস',
      value: health?.checks.database === 'ok' ? 'SQLite · সচল' : health ? 'SQLite · ত্রুটি' : '—',
      state:
        health?.checks.database === 'ok'
          ? { label: 'OK', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' }
          : { label: health ? 'FAIL' : '—', cls: 'border-red-500/40 bg-red-500/10 text-red-400' },
      lines: [`আপটাইম ${health ? fmtUptime(health.uptimeSeconds) : '—'}`],
    },
    {
      key: 'lock',
      icon: LockKeyhole,
      title: 'Order Execution',
      // Master-audit fix B-D2: derived from the backend's own flag — the old
      // card was a static string (could not reflect an abnormal unlock).
      value: health ? (health.executionLocked ? 'Read-Only' : '(!) UNLOCKED') : '—',
      state: health?.executionLocked
        ? { label: 'LOCKED', cls: 'border-red-500/40 bg-red-500/10 text-red-400' }
        : health
          ? { label: 'UNLOCKED', cls: 'border-red-600/60 bg-red-600/20 text-red-300' }
          : { label: '—', cls: 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400' },
      lines: [health?.executionReason ?? 'Execution locked — read-only by design.'],
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4" data-testid="system-mini-cards">
      {cards.map((c) => (
        <div key={c.key} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
              <c.icon className="h-3.5 w-3.5 text-amber-400" aria-hidden />
              {c.title}
            </span>
            <Badge variant="outline" className={`px-1.5 text-[10px] ${c.state.cls}`}>
              {c.state.label}
            </Badge>
          </div>
          {loading && !health ? (
            <Skeleton className="mt-2 h-4 w-3/4" />
          ) : (
            <>
              <p className="mt-1.5 truncate font-mono text-xs text-zinc-200">{c.value}</p>
              {c.lines.map((l, i) => (
                <p key={i} className="mt-0.5 truncate text-[10px] leading-relaxed text-zinc-500" title={l}>
                  {l}
                </p>
              ))}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Full dashboard view (mobile) — stacked panels. */
export function DashboardView({
  health,
  marketStatus,
  dataHealth,
  signalLatest,
  signalRunning,
  onRunSignal,
  priceSpec,
  signalError,
  marketError,
  loading,
}: {
  health: HealthReport | null;
  marketStatus: MarketStatusResponse | null;
  dataHealth: DataHealthResponse | null;
  signalLatest: SignalLatestResponse | null;
  signalRunning: boolean;
  onRunSignal: () => void;
  priceSpec: PriceDisplaySpec;
  signalError?: string | null;
  marketError?: string | null;
  loading?: boolean;
}) {
  return (
    <div className="space-y-4">
      {/* Read-only banner — the safety contract stays visible */}
      <div role="note" className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
        <p className="text-[11px] leading-relaxed text-zinc-400">
          <span className="font-semibold text-amber-200">Read-Only টার্মিনাল</span> — বিশ্লেষণ ও গবেষণা-সিগন্যাল ছাড়া কিছু নয়।{' '}
          {health?.executionReason ?? 'চার-সুইচ এক্সিকিউশন লক সক্রিয় — কোনো অর্ডার পাঠানোর ক্ষমতা সিস্টেমে নেই।'}
        </p>
      </div>

      <SignalCard
        signalLatest={signalLatest}
        signalRunning={signalRunning}
        onRunSignal={onRunSignal}
        priceSpec={priceSpec}
        error={signalError}
        loading={loading}
      />
      <MarketSnapshot marketStatus={marketStatus} dataHealth={dataHealth} priceSpec={priceSpec} loading={loading} marketError={marketError} />
      <SystemMiniCards health={health} marketStatus={marketStatus} loading={loading} marketError={marketError} />

      {marketStatus?.sync.lastRun && (
        <Card className="border-zinc-800 bg-zinc-900/40">
          <CardHeader className="px-3 py-2">
            <CardTitle className="flex items-center gap-2 text-xs text-zinc-300">
              <RefreshCw className="h-3.5 w-3.5 text-amber-400" aria-hidden /> সর্বশেষ সিঙ্ক
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0">
            <p className="font-mono text-[11px] leading-relaxed text-zinc-400">
              {fmtDhaka(marketStatus.sync.lastRun.startedAtUtc)} · {marketStatus.sync.lastRun.mode} ·{' '}
              {syncStatusBn(marketStatus.sync.lastRun.status)} · প্রাপ্ত {marketStatus.sync.lastRun.received} · নতুন{' '}
              {marketStatus.sync.lastRun.inserted} · আপডেট {marketStatus.sync.lastRun.updated}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
