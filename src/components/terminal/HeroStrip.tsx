'use client';

/**
 * XAUUSD AI Trading Agent — Market hero strip (Task 39, UI-03).
 * ----------------------------------------------------------------------------
 * Compact hero band that anchors the dashboard workspace: symbol identity,
 * the live bid (verified tick), ask/spread, data freshness and provenance.
 * Every value comes from the real /api/data/health payload — nothing is
 * fabricated; '—' when unavailable. This is presentation over the SAME data
 * the quote strip already shows, organized as the page's visual anchor.
 */

import { Activity, Database, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useDhakaClockValue, PriceLevelText } from './bits';
import { fmtAge } from '@/lib/dashboard/i18n';
import type { DataHealthResponse } from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

export function HeroStrip({
  dataHealth,
  priceSpec,
  loading,
}: {
  dataHealth: DataHealthResponse | null;
  priceSpec: PriceDisplaySpec;
  loading: boolean;
}) {
  const clock = useDhakaClockValue();
  const q = dataHealth?.quote ?? null;
  const hasQuote = q !== null && q.bid !== null;

  const freshness =
    q === null
      ? { cls: 'border-border-strong bg-muted text-content', label: 'ডেটা অবস্থা অজানা' }
      : q.freshness === 'LIVE'
        ? { cls: 'border-up/40 bg-up/10 text-up', label: 'LIVE' }
        : q.freshness === 'STALE'
          ? { cls: 'border-sun/40 bg-sun/10 text-sun', label: 'STALE' }
          : q.freshness === 'DEGRADED'
            ? { cls: 'border-warn/40 bg-warn/10 text-warn', label: 'DEGRADED' }
            : { cls: 'border-down/40 bg-down/10 text-down', label: 'DISCONNECTED' };

  return (
    <section
      aria-label="মার্কেট ওভারভিউ"
      data-testid="hero-strip"
      className="relative overflow-hidden rounded-xl border border-border bg-panel"
    >
      {/* Subtle sky accent — the single decorative gradient on the page */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-primary/10 via-transparent to-transparent"
        aria-hidden
      />
      <div className="relative flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        {/* Left — identity + big price */}
        <div className="flex min-w-0 items-center gap-4">
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-sun/30 bg-sun/10 text-lg font-bold text-sun"
            aria-hidden
          >
            Au
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                XAUUSD<span className="text-brand">m</span>
              </h2>
              <Badge variant="outline" className={`gap-1 ${freshness.cls}`}>
                <Activity className="h-3 w-3" aria-hidden />
                {freshness.label}
              </Badge>
            </div>
            {loading && !hasQuote ? (
              <p className="mt-1 font-mono text-2xl font-semibold text-muted-foreground sm:text-3xl">
                —,———.——
              </p>
            ) : hasQuote ? (
              <p className="mt-1 font-mono text-2xl font-semibold tabular-nums leading-none text-foreground sm:text-3xl">
                <PriceLevelText value={q?.bid ?? null} spec={priceSpec} />
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                {q
                  ? 'এখনো কোনো বৈধ টিক নেই — সংযোগ ফিরলে লাইভ দাম আসবে।'
                  : 'ডেটা-স্বাস্থ্য API অনুপলব্ধ — সৎ খালি অবস্থা।'}
              </p>
            )}
          </div>
        </div>

        {/* Right — quote stats + provenance */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          {hasQuote && (
            <dl className="grid grid-cols-3 gap-3 sm:gap-5">
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Bid
                </dt>
                <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-up">
                  <PriceLevelText value={q?.bid ?? null} spec={priceSpec} />
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Ask
                </dt>
                <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-down">
                  <PriceLevelText value={q?.ask ?? null} spec={priceSpec} />
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Spread
                </dt>
                <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground/90">
                  <PriceLevelText value={q?.spread ?? null} spec={priceSpec} />
                </dd>
              </div>
            </dl>
          )}
          <div className="flex flex-col gap-1 border-t border-border pt-2 text-[11px] text-muted-foreground sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
            {hasQuote && (
              <span className="flex items-center gap-1.5" title="ডেটা উৎস">
                <Database className="h-3 w-3 shrink-0" aria-hidden />
                {q?.sourceLabel ?? '—'}
                {q?.server ? ` · ${q.server}` : ''}
              </span>
            )}
            {hasQuote && (
              <span className="tabular-nums" suppressHydrationWarning>
                শেষ ডেটা {fmtAge(q?.ageSeconds ?? null)} আগে
              </span>
            )}
            <span className="flex items-center gap-1.5 tabular-nums" suppressHydrationWarning>
              <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
              ঢাকা {clock ?? '--:--:--'}
            </span>
          </div>
        </div>
      </div>

      {q?.freshness === 'DISCONNECTED' && (
        <div
          className="relative flex items-center gap-2 border-t border-down/30 bg-down/5 px-4 py-1.5 text-[11px] font-medium text-down"
          role="status"
        >
          <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ব্রিজ সংযোগ বিচ্ছিন্ন — সংযোগ ফিরলে লাইভ কোট স্বয়ংক্রিয়ভাবে আসবে।
        </div>
      )}
    </section>
  );
}
