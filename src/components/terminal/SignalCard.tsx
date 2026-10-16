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
import { PriceLevelText } from './bits';
import { bnForCode, fmtDhaka, signalOutcomeBn, signalOutcomeBadgeClass } from '@/lib/dashboard/i18n';
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
      className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/40"
      data-testid="signal-card"
    >
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <Zap className="h-4 w-4 text-amber-400" aria-hidden />
        <h2 className="text-sm font-semibold text-zinc-100">সর্বশেষ সিগন্যাল সিদ্ধান্ত</h2>
        {s && (
          <Badge variant="outline" className={`ml-auto ${signalOutcomeBadgeClass(s.outcome)}`}>
            {signalOutcomeBn[s.outcome] ?? s.outcome}
          </Badge>
        )}
      </div>

      <div className="flex-1 space-y-3 p-3">
        {error ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 text-xs leading-relaxed text-zinc-400" role="alert">
            সিগন্যাল API এখন অনুপলব্ধ — <span className="font-mono text-red-300">{error}</span>। {bnForCode(error)}
            শিডিউল্ড মূল্যায়ন চলছে থাকলে সংযোগ ফিরলে এখানে ফলাফল আসবে।
          </p>
        ) : loading && !signalLatest ? (
          <div className="space-y-2">
            <div className="h-4 w-2/3 animate-pulse rounded bg-zinc-800" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-800" />
          </div>
        ) : !s ? (
          <p className="text-xs leading-relaxed text-zinc-500">
            এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি — শিডিউল্ড সিঙ্কের পর ইঞ্জিন স্বয়ংক্রিয়ভাবে মূল্যায়ন করবে (সৎ খালি অবস্থা)।
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <p className="text-zinc-500">সিদ্ধান্ত ক্যান্ডেল (M15)</p>
                <p className="font-mono text-zinc-200">{s.decisionCandleTimeUtc ? fmtDhaka(s.decisionCandleTimeUtc) : '—'}</p>
              </div>
              <div>
                <p className="text-zinc-500">মূল্যায়ন সময় (ঢাকা)</p>
                <p className="font-mono text-zinc-200">{fmtDhaka(s.createdAt)}</p>
              </div>
              <div>
                <p className="text-zinc-500">কৌশল সংস্করণ</p>
                <p className="font-mono text-zinc-300">{s.strategyVersion}</p>
              </div>
              <div>
                <p className="text-zinc-500">এক্সিকিউশন লক</p>
                <p className={s.executionLocked ? 'text-red-400' : 'text-amber-300'}>
                  {s.executionLocked ? 'সক্রিয় (read-only)' : '—'}
                </p>
              </div>
            </div>

            {s.levels ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <LevelBox
                  label="দিক"
                  value={s.levels.direction === 'BUY' ? 'BUY (লং)' : 'SELL (শর্ট)'}
                  cls={s.levels.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}
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
                <LevelBox label="স্টপ-লস" value={<PriceLevelText value={s.levels.stopLoss} spec={priceSpec} />} cls="text-red-300" />
                <LevelBox
                  label={`টার্গেট (R:R 1:${s.levels.rewardRiskRatio.toFixed(2)})`}
                  value={<PriceLevelText value={s.levels.target} spec={priceSpec} />}
                  cls="text-emerald-300"
                />
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-zinc-500">
                এই ফলাফলে কোনো লেভেল নেই — শুধুমাত্র BUY_SETUP/SELL_SETUP হলে সম্পূর্ণ লেভেল দেওয়া হয়।
              </p>
            )}

            {s.reasonCodes.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2">
                {s.reasonCodes.slice(0, compact ? 3 : 10).map((c) => (
                  <li key={c} className="text-[11px] leading-relaxed text-zinc-400">
                    <span className="font-mono text-amber-400">{c}</span> — {bnForCode(c)}
                  </li>
                ))}
                {compact && s.reasonCodes.length > 3 && (
                  <li className="text-[10px] text-zinc-600">+{s.reasonCodes.length - 3}টি কোড — সিগন্যাল ভিউতে সম্পূর্ণ তালিকা</li>
                )}
              </ul>
            )}

            {cond && cond.checks.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                <span>শর্ত-বাই-শর্ত:</span>
                {passedCount !== null && (
                  <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                    <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden /> {passedCount} ✓
                  </Badge>
                )}
                {failedCount !== null && failedCount > 0 && (
                  <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-400">
                    <XCircle className="mr-1 h-3 w-3" aria-hidden /> {failedCount} ✗
                  </Badge>
                )}
                <Badge variant="outline" className="border-zinc-700 bg-zinc-800/60 text-zinc-500">
                  <Minus className="mr-1 h-3 w-3" aria-hidden /> {cond.checks.length - (passedCount ?? 0) - (failedCount ?? 0)} —
                </Badge>
                <span className={cond.category === 'data-quality' ? 'text-amber-400' : 'text-zinc-500'}>
                  {cond.category === 'data-quality' ? '(ডেটা-গুণমান — কৌশলের দোষ নয়)' : '(কৌশল-লজিক)'}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-zinc-800/80 p-2.5">
        <Button
          size="sm"
          variant="outline"
          onClick={onRunSignal}
          disabled={signalRunning}
          data-testid="run-signal-button"
          className="w-full gap-1.5 border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
        >
          {signalRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Zap className="h-3.5 w-3.5" aria-hidden />}
          এখনই মূল্যায়ন চালান
        </Button>
        <p className="mt-1.5 text-center text-[10px] leading-relaxed text-zinc-600">
          টোকেন-সুরক্ষিত ট্রিগার (fail-closed) · শিডিউলার প্রতি ৫ মিনিটে স্বয়ংক্রিয়ভাবে মূল্যায়ন করে
        </p>
      </div>
    </section>
  );
}

function LevelBox({ label, value, cls }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
      <p className="text-[10px] text-zinc-500">{label}</p>
      <p className={`mt-0.5 font-mono text-xs font-semibold ${cls ?? 'text-zinc-200'}`}>{value}</p>
    </div>
  );
}
