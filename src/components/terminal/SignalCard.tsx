'use client';

/**
 * XAUUSD AI Trading Agent — Signal decision card (UI-02).
 * ----------------------------------------------------------------------------
 * Compact, always-honest rendering of the LATEST persisted signal evaluation
 * (BUY / SELL / WAIT / NO_SETUP / BLOCKED / FAILED). Levels (entry zone, SL,
 * target, R:R) render ONLY when the evaluation actually produced them. This
 * is research/decision-support — never an execution instruction.
 */

import { CheckCircle2, Loader2, Minus, XCircle, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LevelBox, OutcomeBadgeIcon, PriceLevelText, outcomeBadgeTokenClass } from './bits';
import { bnForCode, fmtDhaka, signalOutcomeBn } from '@/lib/dashboard/i18n';
import type { SignalLatestResponse } from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

export function SignalCard({
  signalLatest,
  signalRunning,
  onRunSignal,
  priceSpec,
  error,
  loading,
  compact = false,
}: {
  signalLatest: SignalLatestResponse | null;
  signalRunning: boolean;
  onRunSignal: () => void;
  priceSpec: PriceDisplaySpec;
  /** API-unavailable code (honest banner, NOT conflated with "no data yet"). */
  error?: string | null;
  loading?: boolean;
  compact?: boolean;
}) {
  const s = signalLatest?.signal ?? null;
  const cond = signalLatest?.conditions ?? null;
  const passedCount = cond?.checks.filter((c) => c.passed === true).length ?? null;
  const failedCount = cond?.checks.filter((c) => c.passed === false).length ?? null;

  return (
    <section
      aria-label="সর্বশেষ সিগন্যাল সিদ্ধান্ত"
      className="flex flex-col rounded-xl border border-border bg-panel"
      data-testid="signal-card"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Zap className="h-4 w-4 shrink-0 text-sun" aria-hidden />
        <h2 className="min-w-0 text-sm font-semibold text-foreground">সর্বশেষ সিগন্যাল সিদ্ধান্ত</h2>
        {s && (
          <Badge variant="outline" className={`ml-auto text-[11px] ${outcomeBadgeTokenClass(s.outcome)}`}>
            <OutcomeBadgeIcon outcome={s.outcome} />
            {signalOutcomeBn[s.outcome] ?? s.outcome}
          </Badge>
        )}
      </div>

      <div className="flex-1 space-y-4 p-4">
        {error ? (
          <p className="rounded-lg border border-down/40 bg-down/10 p-3 text-xs leading-relaxed text-content" role="alert">
            সিগন্যাল API এখন অনুপলব্ধ — <span className="font-mono text-down">{error}</span>। {bnForCode(error)}
            শিডিউল্ড মূল্যায়ন চলছে থাকলে সংযোগ ফিরলে এখানে ফলাফল আসবে।
          </p>
        ) : loading && !signalLatest ? (
          <div className="space-y-2">
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-surface" />
          </div>
        ) : !s ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি — শিডিউল্ড সিঙ্কের পর ইঞ্জিন স্বয়ংক্রিয়ভাবে মূল্যায়ন করবে (সৎ খালি অবস্থা)।
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="min-w-0">
                <p className="leading-snug text-muted-foreground">সিদ্ধান্ত ক্যান্ডেল (M15)</p>
                <p className="break-words font-mono leading-snug text-foreground/90">{s.decisionCandleTimeUtc ? fmtDhaka(s.decisionCandleTimeUtc) : '—'}</p>
              </div>
              <div className="min-w-0">
                <p className="leading-snug text-muted-foreground">মূল্যায়ন সময় (ঢাকা)</p>
                <p className="break-words font-mono leading-snug text-foreground/90">{fmtDhaka(s.createdAt)}</p>
              </div>
              <div className="min-w-0">
                <p className="leading-snug text-muted-foreground">কৌশল সংস্করণ</p>
                <p className="break-words font-mono leading-snug text-content">{s.strategyVersion}</p>
              </div>
              <div className="min-w-0">
                <p className="leading-snug text-muted-foreground">এক্সিকিউশন লক</p>
                <p className={`leading-snug ${s.executionLocked ? 'text-down' : 'text-sun'}`}>
                  {s.executionLocked ? 'সক্রিয় (read-only)' : '—'}
                </p>
              </div>
            </div>

            {s.levels ? (
              <div className="grid grid-cols-2 gap-2">
                <LevelBox
                  label="দিক"
                  value={s.levels.direction === 'BUY' ? 'BUY (লং)' : 'SELL (শর্ট)'}
                  cls={s.levels.direction === 'BUY' ? 'text-up' : 'text-down'}
                />
                <LevelBox
                  label="এন্ট্রি জোন"
                  value={
                    <>
                      <PriceLevelText value={s.levels.entryZoneLow} spec={priceSpec} />–
                      <PriceLevelText value={s.levels.entryZoneHigh} spec={priceSpec} />
                    </>
                  }
                />
                <LevelBox label="স্টপ-লস" value={<PriceLevelText value={s.levels.stopLoss} spec={priceSpec} />} cls="text-down" />
                <LevelBox
                  label={`টার্গেট (R:R 1:${s.levels.rewardRiskRatio.toFixed(2)})`}
                  value={<PriceLevelText value={s.levels.target} spec={priceSpec} />}
                  cls="text-up"
                />
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                এই ফলাফলে কোনো লেভেল নেই — শুধুমাত্র BUY_SETUP/SELL_SETUP হলে সম্পূর্ণ লেভেল দেওয়া হয়।
              </p>
            )}

            {s.reasonCodes.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-sun/25 bg-sun/5 p-2">
                {s.reasonCodes.slice(0, compact ? 3 : 10).map((c) => (
                  <li key={c} className="text-[11px] leading-relaxed text-content">
                    <span className="font-mono text-sun">{c}</span> — {bnForCode(c)}
                  </li>
                ))}
                {compact && s.reasonCodes.length > 3 && (
                  <li className="text-[10px] text-content">+{s.reasonCodes.length - 3}টি কোড — সিগন্যাল ভিউতে সম্পূর্ণ তালিকা</li>
                )}
              </ul>
            )}

            {cond && cond.checks.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>শর্ত-বাই-শর্ত:</span>
                {passedCount !== null && (
                  <Badge variant="outline" className="text-[11px] border-up/40 bg-up/10 text-up">
                    <CheckCircle2 className="h-3 w-3" aria-hidden /> {passedCount} ✓
                  </Badge>
                )}
                {failedCount !== null && failedCount > 0 && (
                  <Badge variant="outline" className="text-[11px] border-down/40 bg-down/10 text-down">
                    <XCircle className="h-3 w-3" aria-hidden /> {failedCount} ✗
                  </Badge>
                )}
                <Badge variant="outline" className="border-border-strong bg-surface text-[11px] text-muted-foreground">
                  <Minus className="h-3 w-3" aria-hidden /> {cond.checks.length - (passedCount ?? 0) - (failedCount ?? 0)} —
                </Badge>
                <span className={cond.category === 'data-quality' ? 'text-sun' : 'text-muted-foreground'}>
                  {cond.category === 'data-quality' ? '(ডেটা-গুণমান — কৌশলের দোষ নয়)' : '(কৌশল-লজিক)'}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-border px-4 py-3">
        <Button
          size="sm"
          variant="outline"
          onClick={onRunSignal}
          disabled={signalRunning}
          data-testid="run-signal-button"
          className="min-h-10 w-full gap-1.5 border-sun/40 bg-sun/10 text-sun hover:bg-sun/20"
        >
          {signalRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Zap className="h-3.5 w-3.5" aria-hidden />}
          এখনই মূল্যায়ন চালান
        </Button>
        <p className="mt-1.5 text-center text-[11px] leading-relaxed text-muted-foreground">
          টোকেন-সুরক্ষিত ট্রিগার (fail-closed) · শিডিউলার প্রতি ৫ মিনিটে স্বয়ংক্রিয়ভাবে মূল্যায়ন করে
        </p>
      </div>
    </section>
  );
}
