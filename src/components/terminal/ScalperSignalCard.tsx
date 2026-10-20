'use client';

/**
 * XAUUSD AI Trading Agent — Scalper signal card (Phase 12, Task 32).
 * ----------------------------------------------------------------------------
 * The PRIMARY signal surface: the live M1/M5/M15 OR-logic strategy the user
 * requested (any ONE timeframe agreeing → signal, target cadence 5–7/hour).
 *
 * Renders: the latest scalper verdict with all THREE independent timeframe
 * judgements (chips with per-TF stage + indicators), levels only when the
 * evaluation actually produced them, the last-hour setup counter, the recent
 * setups strip, and the auto-execution posture. Honest states throughout —
 * API error ≠ loading ≠ "no evaluation yet"; a suppressed setup says WHY.
 */

import { Loader2, RefreshCw, Timer, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PriceLevelText } from './bits';
import {
  bnForCode,
  fmtDhaka,
  scalperModelBn,
  scalperStageBn,
  scalperTfLabelBn,
  signalOutcomeBadgeClass,
} from '@/lib/dashboard/i18n';
import type { ScalperLatestResponse, ScalperTfJudgementView } from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

function TfChip({ j }: { j: ScalperTfJudgementView }) {
  const agreeing = j.agree !== null;
  const buy = j.agree === 'BUY';
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${
        agreeing
          ? buy
            ? 'border-emerald-500/40 bg-emerald-500/10'
            : 'border-red-500/40 bg-red-500/10'
          : 'border-zinc-800 bg-zinc-900/50'
      }`}
      data-testid={`scalper-tf-${j.timeframe}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-zinc-200">{j.timeframe}</span>
        <span
          className={`text-[11px] font-medium ${
            agreeing ? (buy ? 'text-emerald-400' : 'text-red-400') : 'text-zinc-500'
          }`}
        >
          {scalperStageBn[j.stage] ?? j.stage}
        </span>
      </div>
      <p className="mt-1 font-mono text-[10px] leading-relaxed text-zinc-500">
        RSI {j.indicators.rsi !== null ? j.indicators.rsi.toFixed(1) : '—'} · ATR{' '}
        {j.indicators.atr !== null ? j.indicators.atr.toFixed(2) : '—'}
      </p>
      <p className="sr-only">{`${scalperTfLabelBn[j.timeframe] ?? j.timeframe}: ${scalperStageBn[j.stage] ?? j.stage}`}</p>
    </div>
  );
}

export function ScalperSignalCard({
  scalper,
  running,
  onRun,
  priceSpec,
  error,
  loading,
  compact = false,
}: {
  scalper: ScalperLatestResponse | null;
  running: boolean;
  onRun: () => void;
  priceSpec: PriceDisplaySpec;
  error?: string | null;
  loading?: boolean;
  compact?: boolean;
}) {
  const s = scalper?.latest ?? null;
  const judgements = s?.evidence?.scalper?.tfJudgements ?? [];
  const recent = scalper?.recentSetups ?? [];
  const autoArmed = scalper?.execution?.enabled === true && scalper?.execution?.auto === true;
  const lastHour = scalper?.setupsLastHour ?? 0;

  return (
    <section
      aria-label="স্ক্যাল্পার সিগন্যাল (M1 M5 M15)"
      className="flex flex-col rounded-xl border border-amber-500/30 bg-zinc-900/40"
      data-testid="scalper-signal-card"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <Zap className="h-4 w-4 text-amber-400" aria-hidden />
        <h2 className="text-sm font-semibold text-zinc-100">স্ক্যাল্পার সিগন্যাল</h2>
        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300">
          M1 · M5 · M15
        </Badge>
        {autoArmed && (
          <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
            অটো-এক্সিকিউশন সচল
          </Badge>
        )}
        {s && (
          <Badge variant="outline" className={`ml-auto ${signalOutcomeBadgeClass(s.outcome)}`}>
            {s.outcome}
          </Badge>
        )}
      </div>

      <div className="flex-1 space-y-3 p-3">
        {error ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 text-xs leading-relaxed text-zinc-400" role="alert">
            স্ক্যাল্পার API এখন অনুপলব্ধ — <span className="font-mono text-red-300">{error}</span>।{' '}
            {bnForCode(error)} শিডিউল্ড লুপ চালু থাকলে সংযোগ ফিরলে ফলাফল আসবে।
          </p>
        ) : loading && !scalper ? (
          <div className="space-y-2">
            <div className="h-4 w-2/3 animate-pulse rounded bg-zinc-800" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-800" />
            <div className="h-10 w-full animate-pulse rounded bg-zinc-800" />
          </div>
        ) : !scalper ? null : !s ? (
          <p className="text-xs leading-relaxed text-zinc-500">
            এখনো কোনো স্ক্যাল্পার মূল্যায়ন হয়নি — ১-মিনিট শিডিউল্ড লুপ থেকে প্রথম ফলাফল এক মিনিটের মধ্যে আসবে (সৎ খালি অবস্থা)।
          </p>
        ) : (
          <>
            {/* Three independent timeframe judgements */}
            {judgements.length > 0 && (
              <div className="grid grid-cols-3 gap-2" data-testid="scalper-tf-judgements">
                {judgements.map((j) => (
                  <TfChip key={j.timeframe} j={j} />
                ))}
              </div>
            )}

            {/* Verdict line + reason codes */}
            <div className="space-y-1.5">
              {s.outcome === 'NO_SETUP' && (
                <p className="text-xs text-zinc-400">{bnForCode('SCALPER_NO_AGREE')}</p>
              )}
              {s.reasonCodes.map((code) => (
                <p key={code} className="text-xs leading-relaxed text-zinc-400">
                  <span className="font-mono text-[10px] text-zinc-500">{code}</span> — {bnForCode(code)}
                </p>
              ))}
              {s.outcome !== 'NO_SETUP' && s.reasonCodes.length === 0 && s.levels && (
                <p className="text-xs leading-relaxed text-zinc-300">
                  সেটআপ নির্গত — উৎস{' '}
                  <span className="font-mono text-amber-300">{s.evidence?.scalper?.sourceTimeframe ?? '—'}</span>
                  {s.evidence?.scalper?.model ? ` · ${scalperModelBn[s.evidence.scalper.model] ?? s.evidence.scalper.model}` : ''}
                  {autoArmed ? ' · রিস্ক-চেক পাস করলে অর্ডার স্বয়ংক্রিয়ভাবে যাবে' : ''}
                  ।
                </p>
              )}
            </div>

            {/* Levels — ONLY when the evaluation produced them */}
            {s.levels ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="scalper-levels">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
                  <p className="text-[10px] text-zinc-500">দিক</p>
                  <p className={`font-mono text-sm ${s.levels.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {s.levels.direction === 'BUY' ? 'BUY (লং)' : 'SELL (শর্ট)'}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
                  <p className="text-[10px] text-zinc-500">এন্ট্রি</p>
                  <p className="font-mono text-sm text-zinc-200">
                    <PriceLevelText value={s.levels.entryReference} spec={priceSpec} />
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
                  <p className="text-[10px] text-zinc-500">স্টপ-লস</p>
                  <p className="font-mono text-sm text-red-300">
                    <PriceLevelText value={s.levels.stopLoss} spec={priceSpec} />
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
                  <p className="text-[10px] text-zinc-500">টার্গেট (R:R 1:{s.levels.rewardRiskRatio.toFixed(2)})</p>
                  <p className="font-mono text-sm text-emerald-300">
                    <PriceLevelText value={s.levels.target} spec={priceSpec} />
                  </p>
                </div>
              </div>
            ) : null}

            {/* Meta + cadence counter */}
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <p className="text-zinc-500">সিদ্ধান্ত ক্যান্ডেল</p>
                <p className="font-mono text-zinc-200">
                  {s.decisionCandleTimeUtc ? fmtDhaka(s.decisionCandleTimeUtc) : '—'}
                </p>
              </div>
              <div>
                <p className="text-zinc-500">মূল্যায়ন সময় (ঢাকা)</p>
                <p className="font-mono text-zinc-200">{fmtDhaka(s.createdAt)}</p>
              </div>
              <div>
                <p className="text-zinc-500">শেষ ১ ঘণ্টায় সিগন্যাল</p>
                <p className={`font-mono ${lastHour >= 5 ? 'text-emerald-400' : 'text-zinc-200'}`}>
                  {lastHour}টি <span className="text-zinc-500">(লক্ষ্য ৫–৭)</span>
                </p>
              </div>
              <div>
                <p className="text-zinc-500">কুলডাউন</p>
                <p className="font-mono text-zinc-200">৮ মিনিট</p>
              </div>
            </div>

            {/* Recent setups strip */}
            {!compact && recent.length > 0 && (
              <div data-testid="scalper-recent-setups">
                <p className="mb-1 flex items-center gap-1 text-[10px] font-medium text-zinc-500">
                  <Timer className="h-3 w-3" aria-hidden /> সাম্প্রতিক সেটআপ (শেষ ১ ঘণ্টা)
                </p>
                <div className="max-h-36 space-y-1 overflow-y-auto pr-1 custom-scrollbar">
                  {recent.slice(0, 8).map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/40 px-2 py-1.5 text-[11px]"
                    >
                      <span
                        className={`font-mono font-semibold ${
                          r.outcome === 'BUY_SETUP' ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {r.outcome === 'BUY_SETUP' ? 'BUY' : 'SELL'}
                      </span>
                      <span className="font-mono text-zinc-500">{r.sourceTimeframe ?? '—'}</span>
                      <span className="text-zinc-400">{r.model === 'REVERSAL' ? 'রিভার্সাল' : 'মোমেন্টাম'}</span>
                      <span className="ml-auto font-mono text-zinc-500">{fmtDhaka(r.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <div className="flex items-center gap-2 border-t border-zinc-800/60 pt-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-amber-500/30 text-amber-300 hover:text-amber-200"
            onClick={onRun}
            disabled={running}
            data-testid="scalper-run-button"
          >
            {running ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />}
            এখনই মূল্যায়ন
          </Button>
          <p className="text-[10px] leading-tight text-zinc-500">
            যে কোনো একটি টাইমফ্রেম agree করলেই সিগন্যাল — ১-মিনিট লুপে স্বয়ংক্রিয়।
          </p>
        </div>
      </div>
    </section>
  );
}
