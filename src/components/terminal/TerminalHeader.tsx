'use client';

/**
 * XAUUSD AI Trading Agent — Terminal header (UI-02).
 * ----------------------------------------------------------------------------
 * Institutional-style top bar: gold XAUUSDm branding, live connection state,
 * bid/ask/spread from the verified tick, last data timestamp, Dhaka clock and
 * the execution-lock badge. Every value comes from real API payloads — '—'
 * when unavailable (never fabricated). The lock badge reflects the backend's
 * own executionLocked flag and can never be toggled from the UI.
 */

import { Activity, LockKeyhole, MessageCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDhakaClockValue, PriceLevelText } from './bits';
import { fmtAge } from '@/lib/dashboard/i18n';
import type { DataHealthResponse, HealthReport } from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

export function TerminalHeader({
  health,
  dataHealth,
  priceSpec,
  onOpenChat,
  chatOpen,
}: {
  health: HealthReport | null;
  dataHealth: DataHealthResponse | null;
  priceSpec: PriceDisplaySpec;
  onOpenChat?: () => void;
  chatOpen?: boolean;
}) {
  const clock = useDhakaClockValue();
  const q = dataHealth?.quote ?? null;

  const freshnessBadge =
    q === null
      ? { cls: 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400', label: 'ডেটা অবস্থা অজানা' }
      : q.freshness === 'LIVE'
        ? { cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400', label: 'LIVE' }
        : q.freshness === 'STALE'
          ? { cls: 'border-amber-500/40 bg-amber-500/10 text-amber-400', label: 'STALE' }
          : q.freshness === 'DEGRADED'
            ? { cls: 'border-orange-500/40 bg-orange-500/10 text-orange-400', label: 'DEGRADED' }
            : { cls: 'border-red-500/40 bg-red-500/10 text-red-400', label: 'DISCONNECTED' };

  const locked = health?.executionLocked ?? true; // fail-closed display default

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/85">
      <div className="mx-auto w-full max-w-[1600px] px-3 sm:px-4 lg:px-6">
        {/* Row 1 — identity + status */}
        <div className="flex h-12 items-center justify-between gap-2 sm:h-14">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/gold-icon.svg" alt="XAUUSD AI Trading Agent logo" className="h-7 w-7 shrink-0 sm:h-8 sm:w-8" />
            <div className="min-w-0 leading-tight">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-sm font-semibold tracking-tight text-zinc-50">
                  XAUUSD <span className="text-amber-400">AI Trading Agent</span>
                </h1>
              </div>
              <p className="hidden truncate text-[10px] text-zinc-500 sm:block">
                ডিটারমিনিস্টিক ইঞ্জিন + GLM রিভিউ · Risk Gate সর্বোচ্চ কর্তৃত্ব
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {onOpenChat && (
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenChat}
                aria-label="এআই চ্যাট খুলুন"
                data-testid="header-chat-button"
                className={`hidden gap-1.5 border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:border-amber-500/40 hover:text-amber-300 lg:inline-flex ${
                  chatOpen ? 'border-amber-500/50 text-amber-300' : ''
                }`}
              >
                <MessageCircle className="h-4 w-4" aria-hidden />
                <span>চ্যাট</span>
              </Button>
            )}
            <Badge variant="outline" className={`gap-1.5 ${freshnessBadge.cls}`}>
              <Activity className="h-3 w-3" aria-hidden />
              {freshnessBadge.label}
            </Badge>
            <Badge
              variant="outline"
              className={`gap-1.5 ${
                locked
                  ? 'border-red-500/40 bg-red-500/10 text-red-400'
                  : 'border-red-600/60 bg-red-600/20 text-red-300 animate-pulse'
              }`}
              title={health?.executionReason ?? 'Execution locked — read-only by design'}
            >
              <LockKeyhole className="h-3 w-3" aria-hidden />
              <span className="hidden sm:inline">Order Execution:</span> LOCKED
            </Badge>
            <span
              className="hidden font-mono text-xs tabular-nums text-zinc-400 md:inline"
              suppressHydrationWarning
              aria-label="ঢাকার সময়"
            >
              ঢাকা {clock ?? '--:--:--'}
            </span>
          </div>
        </div>

        {/* Row 2 — quote strip */}
        <div
          className="flex items-center gap-2 overflow-x-auto border-t border-zinc-800/60 py-1.5 sm:gap-4"
          aria-label="লাইভ কোট"
        >
          <span className="shrink-0 rounded bg-amber-500/15 px-2 py-0.5 font-mono text-xs font-semibold text-amber-300">
            XAUUSDm
          </span>
          {q && q.bid !== null ? (
            <>
              <QuoteCell label="Bid" value={<PriceLevelText value={q.bid} spec={priceSpec} />} cls="text-emerald-400" />
              <QuoteCell label="Ask" value={<PriceLevelText value={q.ask} spec={priceSpec} />} cls="text-red-400" />
              <QuoteCell label="Spread" value={<PriceLevelText value={q.spread} spec={priceSpec} />} cls="text-zinc-300" />
              <span className="hidden shrink-0 text-[11px] text-zinc-500 sm:inline">
                উৎস {q.sourceLabel}
                {q.server ? ` · ${q.server}` : ''}
              </span>
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-500" suppressHydrationWarning>
                শেষ ডেটা {fmtAge(q.ageSeconds)} আগে
              </span>
            </>
          ) : (
            <span className="shrink-0 py-0.5 text-[11px] text-zinc-500">
              {q
                ? 'এখনো কোনো বৈধ টিক নেই — ব্রিজ সংযুক্ত হলে এখানে লাইভ কোট আসবে (কিছু বানানো হয় না)।'
                : 'ডেটা-স্বাস্থ্য API অনুপলব্ধ — কোট দেখানো সম্ভব নয়।'}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

function QuoteCell({ label, value, cls }: { label: string; value: React.ReactNode; cls: string }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      <span className={`font-mono text-sm font-semibold tabular-nums ${cls}`}>{value}</span>
    </span>
  );
}
