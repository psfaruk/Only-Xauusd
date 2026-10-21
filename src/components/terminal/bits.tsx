/**
 * XAUUSD AI Trading Agent — Terminal shared JSX bits (UI-02 / UI-03).
 * ----------------------------------------------------------------------------
 * Small presentational helpers moved verbatim from the former page.tsx.
 * Task 39 polish: price bits now force tabular numerals; status icons use the
 * theme-aware terminal tokens; new shared primitives (LevelBox + token badge
 * helpers/icons) give every signal card the same anatomy in dark AND light.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Minus,
  TrendingDown,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import {
  formatPriceLevel,
  formatPriceQuantity,
  type PriceDisplaySpec,
} from '@/lib/market/price-display';

/** Price LEVEL (entry/SL/target/quotes/swing prices) at verified digits. */
export function PriceLevelText({
  value,
  spec,
  className,
}: {
  value: number | string | null | undefined;
  spec: PriceDisplaySpec;
  className?: string;
}) {
  const r = formatPriceLevel(value, spec);
  return (
    <span
      className={`tabular-nums ${className ?? ''}`}
      title={r.text === '—' ? undefined : `raw: ${r.rawText}`}
    >
      {r.text}
      {r.anomaly && r.text !== '—' && (
        <sup
          className="ml-0.5 text-sun"
          title="প্রেসিশন-অ্যানোমালি — raw মান broker grid-এ নেই / মেটাডেটা যাচাইকৃত নয়"
          aria-label="precision anomaly"
        >
          ≈
        </sup>
      )}
    </span>
  );
}

/** Price-UNIT quantity (P&L, costs, spread assumptions) at verified digits. */
export function PriceQtyText({
  value,
  spec,
  className,
}: {
  value: number | null | undefined;
  spec: PriceDisplaySpec;
  className?: string;
}) {
  const text = formatPriceQuantity(value, spec);
  const raw = value === null || value === undefined || !Number.isFinite(value) ? null : String(value);
  return (
    <span className={`tabular-nums ${className ?? ''}`} title={raw !== null && raw !== text ? `raw: ${raw}` : undefined}>
      {text}
    </span>
  );
}

export function StatusIcon({ status }: { status: 'pass' | 'warn' | 'fail' | 'active' | 'planned' | string }) {
  if (status === 'pass' || status === 'active' || status === 'verified')
    return <CheckCircle2 className="h-4 w-4 text-up" aria-hidden />;
  if (status === 'fail') return <XCircle className="h-4 w-4 text-down" aria-hidden />;
  return <AlertTriangle className="h-4 w-4 text-sun" aria-hidden />;
}

/** Phase 9 — audit v2 status icon (six-state model). */
export function AuditStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'PASS':
      return <CheckCircle2 className="h-4 w-4 text-up" aria-hidden />;
    case 'WARN':
      return <AlertTriangle className="h-4 w-4 text-sun" aria-hidden />;
    case 'FAIL':
      return <XCircle className="h-4 w-4 text-down" aria-hidden />;
    case 'BLOCKED':
      return <AlertTriangle className="h-4 w-4 text-warn" aria-hidden />;
    case 'NOT_APPLICABLE':
      return <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />;
    default:
      return <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />; // NOT_TESTED
  }
}

/* ---------------------------------------------------------------------------
 * UI-03 (Task 39) — token-based status badge primitives for the signal
 * cards. These are the presentational twins of the i18n badge-class helpers:
 * every status maps onto the theme-aware terminal tokens so light mode stays
 * readable (the -400 palette is dark-mode-only). Status is NEVER color alone —
 * each badge pairs its token color with the Bengali label + a lucide icon.
 * ------------------------------------------------------------------------- */

/** Signal outcome → token badge classes (BUY/SELL_SETUP, WAIT, NO_SETUP, BLOCKED, FAILED). */
export function outcomeBadgeTokenClass(outcome: string): string {
  switch (outcome) {
    case 'BUY_SETUP':
      return 'border-up/40 bg-up/10 text-up';
    case 'SELL_SETUP':
      return 'border-down/40 bg-down/10 text-down';
    case 'WAIT':
      return 'border-sun/40 bg-sun/10 text-sun';
    case 'NO_SETUP':
      return 'border-border-strong bg-muted text-muted-foreground';
    case 'BLOCKED':
      return 'border-warn/40 bg-warn/10 text-warn';
    default:
      return 'border-down/50 bg-down/10 text-down'; // FAILED / unknown
  }
}

/** Data-quality state → token badge classes (VALID/WARNING/STALE/MISSING/INVALID/UNAVAILABLE). */
export function qualityStateTokenClass(state: string): string {
  switch (state) {
    case 'VALID':
      return 'border-up/40 bg-up/10 text-up';
    case 'WARNING':
      return 'border-sun/40 bg-sun/10 text-sun';
    case 'STALE':
      return 'border-warn/40 bg-warn/10 text-warn';
    case 'MISSING':
      return 'border-down/40 bg-down/10 text-down';
    case 'INVALID':
      return 'border-down/50 bg-down/15 text-down';
    default:
      return 'border-border-strong bg-muted text-muted-foreground'; // UNAVAILABLE
  }
}

/** Directional icon for a signal-outcome badge (pairs with the Bengali label). */
export function OutcomeBadgeIcon({ outcome }: { outcome: string }) {
  switch (outcome) {
    case 'BUY_SETUP':
      return <TrendingUp className="h-3 w-3 shrink-0" aria-hidden />;
    case 'SELL_SETUP':
      return <TrendingDown className="h-3 w-3 shrink-0" aria-hidden />;
    case 'WAIT':
    case 'NO_SETUP':
      return <Minus className="h-3 w-3 shrink-0" aria-hidden />;
    case 'BLOCKED':
      return <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />;
    default:
      return <XCircle className="h-3 w-3 shrink-0" aria-hidden />; // FAILED
  }
}

/** Icon for a data-quality state badge (pairs with the Bengali label). */
export function QualityBadgeIcon({ state }: { state: string }) {
  switch (state) {
    case 'VALID':
      return <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden />;
    case 'WARNING':
      return <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />;
    case 'STALE':
      return <Circle className="h-3 w-3 shrink-0" aria-hidden />;
    case 'MISSING':
    case 'INVALID':
      return <XCircle className="h-3 w-3 shrink-0" aria-hidden />;
    default:
      return <Minus className="h-3 w-3 shrink-0" aria-hidden />; // UNAVAILABLE
  }
}

/** UI-03 — shared level box (দিক / এন্ট্রি / স্টপ-লস / টার্গেট) used by the
 * signal cards: one surface layer below the card panel, tabular numerals. */
export function LevelBox({
  label,
  value,
  cls,
}: {
  label: string;
  value: ReactNode;
  cls?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-2">
      <p className="text-[10px] leading-snug text-muted-foreground">{label}</p>
      <p className={`mt-0.5 break-words font-mono text-xs font-semibold tabular-nums ${cls ?? 'text-foreground/90'}`}>{value}</p>
    </div>
  );
}

/** UI-02 — honest live Dhaka clock (fixed-height to avoid layout shift). */
export function useDhakaClockValue(): string | null {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('bn-BD', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
    const tick = () => setNow(fmt.format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
