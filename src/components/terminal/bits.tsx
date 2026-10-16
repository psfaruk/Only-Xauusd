/**
 * XAUUSD AI Trading Agent — Terminal shared JSX bits (UI-02).
 * ----------------------------------------------------------------------------
 * Small presentational helpers moved verbatim from the former page.tsx.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Circle } from 'lucide-react';
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
      className={className}
      title={r.text === '—' ? undefined : `raw: ${r.rawText}`}
    >
      {r.text}
      {r.anomaly && r.text !== '—' && (
        <sup
          className="ml-0.5 text-amber-400"
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
    <span className={className} title={raw !== null && raw !== text ? `raw: ${raw}` : undefined}>
      {text}
    </span>
  );
}

export function StatusIcon({ status }: { status: 'pass' | 'warn' | 'fail' | 'active' | 'planned' | string }) {
  if (status === 'pass' || status === 'active' || status === 'verified')
    return <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />;
  if (status === 'fail') return <XCircle className="h-4 w-4 text-red-400" aria-hidden />;
  return <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />;
}

/** Phase 9 — audit v2 status icon (six-state model). */
export function AuditStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'PASS':
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />;
    case 'WARN':
      return <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />;
    case 'FAIL':
      return <XCircle className="h-4 w-4 text-red-400" aria-hidden />;
    case 'BLOCKED':
      return <AlertTriangle className="h-4 w-4 text-orange-400" aria-hidden />;
    case 'NOT_APPLICABLE':
      return <Circle className="h-4 w-4 text-zinc-500" aria-hidden />;
    default:
      return <Circle className="h-4 w-4 text-zinc-400" aria-hidden />; // NOT_TESTED
  }
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
