'use client';

/**
 * XAUUSD AI Trading Agent — Terminal header (Task 39, UI-03 "Sky Terminal").
 * ----------------------------------------------------------------------------
 * Compact institutional top bar over the SAME real payloads:
 *   Row 1 — brand identity · LIVE/STALE badge · execution badge · Dhaka
 *           clock · global search launcher (Ctrl/⌘K) · theme toggle · chat
 *   Row 2 — quote strip: bid/ask/spread from the verified tick + provenance
 *           + data age ('—' / honest message when unavailable — never
 *           fabricated).
 * The lock badge reflects the backend's own executionLocked flag; the UI
 * can never toggle it.
 */

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Activity, LockKeyhole, MessageCircle, Moon, Search, Sun } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
  onOpenSearch,
}: {
  health: HealthReport | null;
  dataHealth: DataHealthResponse | null;
  priceSpec: PriceDisplaySpec;
  onOpenChat?: () => void;
  chatOpen?: boolean;
  onOpenSearch?: () => void;
}) {
  const clock = useDhakaClockValue();
  const { resolvedTheme, setTheme } = useTheme();
  // Hydration-safe "mounted" flag (server snapshot false, client true) so the
  // theme icon never mismatches SSR output.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  const q = dataHealth?.quote ?? null;

  const freshnessBadge =
    q === null
      ? { cls: 'border-border-strong bg-muted text-content', label: 'ডেটা অবস্থা অজানা' }
      : q.freshness === 'LIVE'
        ? { cls: 'border-up/40 bg-up/10 text-up', label: 'LIVE' }
        : q.freshness === 'STALE'
          ? { cls: 'border-sun/40 bg-sun/10 text-sun', label: 'STALE' }
          : q.freshness === 'DEGRADED'
            ? { cls: 'border-warn/40 bg-warn/10 text-warn', label: 'DEGRADED' }
            : { cls: 'border-down/40 bg-down/10 text-down', label: 'DISCONNECTED' };

  const locked = health?.executionLocked ?? true; // fail-closed display default

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-terminal/95 backdrop-blur supports-[backdrop-filter]:bg-terminal/85">
      <div className="mx-auto w-full max-w-[1600px] px-3 sm:px-4 lg:px-6">
        {/* Row 1 — identity + status + tools */}
        <div className="flex h-12 items-center justify-between gap-2 sm:h-14">
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src="/gold-icon.svg"
              alt="XAUUSD AI Trading Agent logo"
              className="h-7 w-7 shrink-0 sm:h-8 sm:w-8"
            />
            <div className="min-w-0 leading-tight">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-sm font-semibold tracking-tight text-foreground">
                  XAUUSD <span className="text-brand">AI Trading Agent</span>
                </h1>
              </div>
              <p className="hidden truncate text-[10px] text-muted-foreground sm:block">
                {/* Master-audit fix D-D1: GLM has NO signal-review layer — it is
                 * chat commentary + a capability probe only. The deterministic
                 * engine holds sole authority. */}
                ডিটারমিনিস্টিক ইঞ্জিন সর্বোচ্চ কর্তৃত্ব · GLM শুধু ব্যাখ্যাকারী (চ্যাট)
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {/* Global search / command launcher */}
            {onOpenSearch && (
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenSearch}
                aria-label="সার্চ ও কমান্ড প্যালেট খুলুন (Ctrl K)"
                data-testid="header-search-button"
                className="h-8 gap-2 border-border bg-panel/60 text-muted-foreground hover:border-primary/40 hover:text-brand"
              >
                <Search className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden xl:inline">সার্চ…</span>
                <kbd className="hidden rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground xl:inline">
                  ⌘K
                </kbd>
              </Button>
            )}
            {onOpenChat && (
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenChat}
                aria-label="এআই চ্যাট খুলুন"
                data-testid="header-chat-button"
                className={`hidden h-8 gap-1.5 border-border bg-panel/60 text-content hover:border-primary/40 hover:text-brand lg:inline-flex ${
                  chatOpen ? 'border-primary/50 text-brand' : ''
                }`}
              >
                <MessageCircle className="h-3.5 w-3.5" aria-hidden />
                <span>চ্যাট</span>
              </Button>
            )}
            {/* Theme toggle — dark is the primary terminal experience.
             * All resolvedTheme-dependent attributes are mounted-gated so SSR
             * and the first client render match (no hydration mismatch). */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                  aria-label={mounted && resolvedTheme === 'dark' ? 'লাইট থিমে যান' : 'ডার্ক থিমে যান'}
                  data-testid="theme-toggle"
                  className="h-8 w-8 border-border bg-panel/60 p-0 text-content hover:border-primary/40 hover:text-brand"
                >
                  {mounted && resolvedTheme === 'light' ? (
                    <Moon className="h-4 w-4" aria-hidden />
                  ) : (
                    <Sun className="h-4 w-4" aria-hidden />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {mounted && resolvedTheme === 'dark' ? 'লাইট থিম' : 'ডার্ক থিম'}
              </TooltipContent>
            </Tooltip>
            <Badge variant="outline" className={`gap-1.5 ${freshnessBadge.cls}`}>
              <Activity className="h-3 w-3" aria-hidden />
              {freshnessBadge.label}
            </Badge>
            <Badge
              variant="outline"
              className={`gap-1.5 ${
                locked
                  ? 'border-down/40 bg-down/10 text-down'
                  : 'border-warn/40 bg-warn/10 text-warn'
              }`}
              title={health?.executionReason ?? 'Execution locked — read-only by design'}
              data-execution-locked={locked ? 'true' : 'false'}
            >
              <LockKeyhole className="h-3 w-3" aria-hidden />
              <span className="hidden sm:inline">Order Execution:</span>{' '}
              {locked ? 'LOCKED' : 'UNLOCKED (unexpected)'}
            </Badge>
            <span
              className="hidden font-mono text-xs tabular-nums text-muted-foreground md:inline"
              suppressHydrationWarning
              aria-label="ঢাকার সময়"
            >
              ঢাকা {clock ?? '--:--:--'}
            </span>
          </div>
        </div>

        {/* Row 2 — quote strip.
         * Task 40 fix: flex-wrap instead of overflow-x-auto — with the old
         * hidden horizontal scroll the "শেষ ডেটা" age was pushed off-screen
         * on mobile and effectively invisible. Wrapping keeps every quote
         * cell on-screen at every width. */}
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 py-1.5 sm:gap-x-4"
          aria-label="লাইভ কোট"
        >
          <span className="shrink-0 rounded-md border border-sun/30 bg-sun/10 px-2 py-0.5 font-mono text-xs font-semibold text-sun">
            XAUUSDm
          </span>
          {q && q.bid !== null ? (
            <>
              <QuoteCell
                label="Bid"
                value={<PriceLevelText value={q.bid} spec={priceSpec} />}
                cls="text-up"
              />
              <QuoteCell
                label="Ask"
                value={<PriceLevelText value={q.ask} spec={priceSpec} />}
                cls="text-down"
              />
              <QuoteCell
                label="Spread"
                value={<PriceLevelText value={q.spread} spec={priceSpec} />}
                cls="text-foreground/90"
              />
              <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                উৎস {q.sourceLabel}
                {q.server ? ` · ${q.server}` : ''}
              </span>
              <span
                className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground"
                suppressHydrationWarning
              >
                শেষ ডেটা {fmtAge(q.ageSeconds)} আগে
              </span>
            </>
          ) : (
            <span className="shrink-0 py-0.5 text-[11px] text-muted-foreground">
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
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-semibold tabular-nums ${cls}`}>{value}</span>
    </span>
  );
}
