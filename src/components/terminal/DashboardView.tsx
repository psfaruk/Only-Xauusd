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

import { AlertTriangle, Bot, CheckCircle2, Database, LockKeyhole, Minus, Network, RefreshCw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PriceLevelText, QualityBadgeIcon, qualityStateTokenClass } from './bits';
import { CandidateSignalCard } from './CandidateSignalCard';
import { SignalCard } from './SignalCard';
import {
  fmtAge,
  fmtDhaka,
  fmtUptime,
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
import type { TickStreamState } from '@/hooks/use-tick-stream';

export function MarketSnapshot({
  marketStatus,
  dataHealth,
  priceSpec,
  loading,
  marketError,
  tickStream,
}: {
  marketStatus: MarketStatusResponse | null;
  dataHealth: DataHealthResponse | null;
  priceSpec: PriceDisplaySpec;
  loading?: boolean;
  /** Master-audit fix B-D1: API-outage code — rendered as an explicit
   * unavailable banner, NEVER conflated with "no data yet". */
  marketError?: string | null;
  /** Task 29-c: live tick-stream overlay. When the socket stream is live its
   *  tick is shown ("লাইভ স্ট্রিম" badge); a down/absent stream falls back to
   *  the 20s poll values — never fabricated, never both-claimed. */
  tickStream?: TickStreamState | null;
}) {
  const liveTick = tickStream?.status === 'live' && tickStream.tick ? tickStream.tick : null;
  const pollTick = marketStatus?.readiness?.tick ?? null;
  const bidValue = liveTick ? String(liveTick.bid) : (pollTick?.bid ?? null);
  const askValue = liveTick ? String(liveTick.ask) : (pollTick?.ask ?? null);
  const spreadValue = liveTick ? liveTick.spread.toFixed(liveTick.digits ?? 3) : (pollTick?.spread ?? null);
  // Phase 8 (42-S5) — stale-quote honesty on the snapshot itself. The badge
  // is driven by the payload's own freshness marker (never an invented
  // threshold): STALE/DEGRADED quotes get the warn 'পুরনো ডেটা' chip so a
  // non-live quote is visually distinct from a live one.
  const quoteFreshness = dataHealth?.quote?.freshness ?? null;
  const staleBadge =
    quoteFreshness === 'STALE' || quoteFreshness === 'DEGRADED'
      ? { cls: 'border-warn/40 bg-warn/10 text-warn', label: 'পুরনো ডেটা' }
      : quoteFreshness === 'DISCONNECTED'
        ? { cls: 'border-down/40 bg-down/10 text-down', label: 'কোট বিচ্ছিন্ন' }
        : null;
  return (
    <section aria-label="মার্কেট স্ন্যাপশট" className="rounded-xl border border-border bg-panel" data-testid="market-snapshot">
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Network className="h-4 w-4 shrink-0 text-sun" aria-hidden />
        <h2 className="min-w-0 text-sm font-semibold text-foreground">মার্কেট স্ন্যাপশট — XAUUSDm</h2>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {staleBadge && (
            <Badge
              variant="outline"
              className={`text-[11px] ${staleBadge.cls}`}
              data-testid="market-stale-badge"
              title="কোট সতেজতা পে-লোড থেকে (STALE/DEGRADED/DISCONNECTED) — কোনো থ্রেশহোল্ড বানানো হয়নি"
            >
              <AlertTriangle className="h-3 w-3" aria-hidden />
              {staleBadge.label}
            </Badge>
          )}
          {marketStatus && (
            <Badge variant="outline" className={`text-[11px] ${qualityStateTokenClass(marketStatus.readiness.qualityState)}`}>
              <QualityBadgeIcon state={marketStatus.readiness.qualityState} />
              {qualityStateBn[marketStatus.readiness.qualityState]}
            </Badge>
          )}
          {liveTick && (
            <Badge
              variant="outline"
              data-testid="market-live-badge"
              className="border-up/40 bg-up/10 text-[11px] text-up"
            >
              <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-up" aria-hidden />
              লাইভ স্ট্রিম
            </Badge>
          )}
        </div>
      </div>
      <div className="space-y-4 p-4">
        {marketError && !marketStatus ? (
          <p role="alert" className="rounded-lg border border-down/40 bg-down/10 p-3 text-xs leading-relaxed text-down">
            মার্কেট-স্ট্যাটাস API অনুপলব্ধ — <span className="font-mono">{marketError}</span>। এটি "টিক নেই"-এর মতো নয় (fail-closed); সংযোগ ফিরলে ৩০ সেকেন্ডে ডেটা আসবে।
          </p>
        ) : bidValue ? (
          <div className="grid grid-cols-3 gap-2" data-testid="market-tick-grid">
            {(
              [
                ['Bid', bidValue, 'text-up'],
                ['Ask', askValue, 'text-down'],
                ['Spread', spreadValue, 'text-foreground/90'],
              ] as Array<[string, string | null, string]>
            ).map(([k, v, cls]) => (
              <div key={k} className="min-w-0 rounded-lg border border-border bg-surface p-2 text-center">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{k}</p>
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
          <p className="rounded-lg border border-dashed border-border p-3 text-center text-xs leading-relaxed text-muted-foreground">
            এখনো কোনো বৈধ টিক সংরক্ষিত হয়নি — কিছু বানানো হয় না।
          </p>
        )}

        {/* Per-TF readiness chips (M1..H4 — 5 TFs since Task 29). Capped at
            3 columns: the desktop right rail is only 380px wide, so a 5-up
            row would crush the Bengali staleness lines (Task 39 fix). */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {(marketStatus?.readiness.timeframes ?? []).map((tf) => (
            <div key={tf.timeframe} className="min-w-0 rounded-lg border border-border bg-surface p-2">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-1.5 gap-y-0.5">
                <span className="shrink-0 font-mono text-xs font-semibold text-foreground">{tf.timeframe}</span>
                <Badge variant="outline" className={`min-w-0 break-words text-[11px] ${qualityStateTokenClass(tf.state)}`}>
                  <QualityBadgeIcon state={tf.state} />
                  {qualityStateBn[tf.state]}
                </Badge>
              </div>
              <p className="mt-1 break-words text-[10px] leading-relaxed text-muted-foreground">
                শেষ বন্ধ: {fmtAge(tf.lastClosedCandleAgeSeconds)} আগে
                <br />
                সীমা {fmtAge(tf.stalenessThresholdSeconds)}
              </p>
            </div>
          ))}
        </div>

        {dataHealth?.quote.freshness && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            কোট সতেজতা: <span className="font-mono text-content">{dataHealth.quote.freshness}</span> · উৎস{' '}
            <span className="text-content">{dataHealth.quote.sourceLabel}</span>
            {dataHealth.quote.quoteTimeUtc ? ` · কোট-সময় ${fmtDhaka(dataHealth.quote.quoteTimeUtc)}` : ''}
            {dataHealth.quote.ageSeconds != null
              ? ` · বয়স ${fmtAge(dataHealth.quote.ageSeconds)}`
              : ''}
          </p>
        )}
        {liveTick && (
          <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="market-live-line">
            লাইভ স্ট্রিম: সিকোয়েন্স <span className="font-mono text-content">{liveTick.serviceSeq}</span> · রিলে বিলম্ব{' '}
            <span className="font-mono text-content">{liveTick.bridgeLatencyMs}ms</span> · কোট-সময়{' '}
            <span className="font-mono text-content">{fmtDhaka(liveTick.quoteTimeUtc)}</span> — স্ট্রিম বিচ্ছিন্ন হলে ২০-সেকেন্ড পোলই এখতেব রাখে।
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
      state: (
        health?.glm.status === 'verified'
          ? { label: 'যাচাইকৃত', cls: 'border-up/40 bg-up/10 text-up', Icon: CheckCircle2 }
          : health?.glm.status === 'failed'
            ? { label: 'ব্যর্থ', cls: 'border-down/40 bg-down/10 text-down', Icon: XCircle }
            : { label: 'অযাচাইকৃত', cls: 'border-border-strong/50 bg-muted text-content', Icon: Minus }
      ) as { label: string; cls: string; Icon: typeof Minus },
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
      state: (
        bridgeConnected
          ? { label: bridge?.status?.source === 'demo' ? 'ডেমো ফিড' : 'সংযুক্ত', cls: 'border-up/40 bg-up/10 text-up', Icon: CheckCircle2 }
          : bridgeUnknown
            ? { label: 'অজানা', cls: 'border-border-strong/50 bg-muted text-content', Icon: Minus }
            : { label: marketStatus ? 'বিচ্ছিন্ন' : '—', cls: 'border-sun/40 bg-sun/10 text-sun', Icon: AlertTriangle }
      ) as { label: string; cls: string; Icon: typeof Minus },
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
      state: (
        health?.checks.database === 'ok'
          ? { label: 'OK', cls: 'border-up/40 bg-up/10 text-up', Icon: CheckCircle2 }
          : { label: health ? 'FAIL' : '—', cls: 'border-down/40 bg-down/10 text-down', Icon: XCircle }
      ) as { label: string; cls: string; Icon: typeof Minus },
      lines: [`আপটাইম ${health ? fmtUptime(health.uptimeSeconds) : '—'}`],
    },
    {
      key: 'lock',
      icon: LockKeyhole,
      title: 'অর্ডার লক',
      // Master-audit fix B-D2: derived from the backend's own flag — the old
      // card was a static string (could not reflect an abnormal unlock).
      // Phase 8 (42-S5): signal-only copy — an (impossible) unlock reads as
      // an honest warning, never as live trading.
      value: health ? (health.executionLocked ? 'Read-Only' : 'আনলকড (অপ্রত্যাশিত)') : '—',
      state: (
        health?.executionLocked
          ? { label: 'LOCKED', cls: 'border-up/40 bg-up/10 text-up', Icon: CheckCircle2 }
          : health
            ? { label: 'UNLOCKED', cls: 'border-warn/40 bg-warn/10 text-warn', Icon: AlertTriangle }
            : { label: '—', cls: 'border-border-strong/50 bg-muted text-content', Icon: Minus }
      ) as { label: string; cls: string; Icon: typeof Minus },
      lines: [health?.executionReason ?? 'সিগনাল-অনলি মোড — অর্ডার কোড সরানো হয়েছে (read-only)।'],
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4" data-testid="system-mini-cards">
      {cards.map((c) => (
        <div key={c.key} className="min-w-0 rounded-xl border border-border bg-panel p-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="flex min-w-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <c.icon className="h-3.5 w-3.5 shrink-0 text-sun" aria-hidden />
              {c.title}
            </span>
            <Badge variant="outline" className={`text-[11px] ${c.state.cls}`}>
              <c.state.Icon className="h-3 w-3" aria-hidden />
              {c.state.label}
            </Badge>
          </div>
          {loading && !health ? (
            <Skeleton className="mt-2 h-4 w-3/4" />
          ) : (
            <>
              <p className="mt-1.5 truncate font-mono text-xs text-foreground/90" title={c.value}>
                {c.value}
              </p>
              {c.lines.map((l, i) => (
                <p key={i} className="mt-0.5 truncate text-[10px] leading-relaxed text-muted-foreground" title={l}>
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
  tickStream,
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
  /** Live tick-stream (Task 29-c) — forwarded to MarketSnapshot; a down
   *  stream falls back to the 20s poll, never fabricates. */
  tickStream: TickStreamState | null;
}) {
  return (
    <div className="space-y-4">
      {/* Signal-only posture banner — honest state from the backend flag.
       * Phase 0 hard-locked execution by construction (order code deleted,
       * pinned by regression tests), so the locked branch is the real one;
       * the impossible-unlocked branch renders an honest WARNING and never
       * promises order execution (no such surface exists anymore). */}
      <div role="note" className="flex items-start gap-2.5 rounded-xl border border-up/30 bg-up/5 p-4">
        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden />
        <p className="min-w-0 break-words text-[11px] leading-relaxed text-content">
          {health && !health.executionLocked ? (
            <>
              <span className="font-semibold text-warn">অপ্রত্যাশিত আনলক অবস্থা</span> — এই অ্যাপ
              সিগনাল-অনলি; অর্ডার কোড সরানো আছে, তাই এটি সতর্কতা মাত্র। {health.executionReason}
            </>
          ) : (
            <>
              <span className="font-semibold text-sun">রিড-ওনলি মোড</span> — বিশ্লেষণ ও সিগনাল গবেষণা ছাড়া কিছু নয়।{' '}
              {health?.executionReason ?? 'সিগনাল-অনলি মোড — অর্ডার কোড সরানো হয়েছে (read-only)।'}
            </>
          )}
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
      {/* Phase 11-E — the research candidate card sits directly UNDER the
       * baseline card, clearly labeled গবেষণা and never merged into it. */}
      <CandidateSignalCard
        signalLatest={signalLatest}
        priceSpec={priceSpec}
        error={signalError}
        loading={loading}
      />
      <MarketSnapshot marketStatus={marketStatus} dataHealth={dataHealth} priceSpec={priceSpec} loading={loading} marketError={marketError} tickStream={tickStream} />
      <SystemMiniCards health={health} marketStatus={marketStatus} loading={loading} marketError={marketError} />

      {marketStatus?.sync.lastRun && (
        <section
          aria-label="সর্বশেষ সিঙ্ক"
          className="rounded-xl border border-border bg-panel"
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <RefreshCw className="h-4 w-4 shrink-0 text-sun" aria-hidden />
            <h2 className="min-w-0 text-sm font-semibold text-foreground">সর্বশেষ সিঙ্ক</h2>
          </div>
          <div className="p-4">
            <p className="break-words font-mono text-[11px] leading-relaxed text-content">
              {fmtDhaka(marketStatus.sync.lastRun.startedAtUtc)} · {marketStatus.sync.lastRun.mode} ·{' '}
              {syncStatusBn(marketStatus.sync.lastRun.status)} · প্রাপ্ত {marketStatus.sync.lastRun.received} · নতুন{' '}
              {marketStatus.sync.lastRun.inserted} · আপডেট {marketStatus.sync.lastRun.updated}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
