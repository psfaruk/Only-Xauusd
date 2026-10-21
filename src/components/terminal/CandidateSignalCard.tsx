'use client';

/**
 * XAUUSD AI Trading Agent — Candidate research signal card (Task 31-e).
 * ----------------------------------------------------------------------------
 * Phase 11-E additive surface: the LATEST evaluation of the research candidate
 * strategy (hybrid-multimodel-research/11.0.0-candidate.1), which now runs
 * DUAL with the baseline on every cycle. Clearly labeled গবেষণা (research) —
 * NEVER mixed into the baseline SignalCard, never an execution instruction.
 *
 * Honest states only: API-unavailable banner, loading skeleton, first-cycle
 * empty state (candidate === null — never fabricated), and the forward-paper
 * strip with the pre-registered 20-outcome sample floor.
 */

import { FlaskConical, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { LevelBox, OutcomeBadgeIcon, PriceLevelText, outcomeBadgeTokenClass } from './bits';
import { buildCandidatePaperStrip } from '@/lib/dashboard/candidate-display';
import {
  bnForCode,
  candidateModelBn,
  fmtDhaka,
  signalOutcomeBn,
} from '@/lib/dashboard/i18n';
import type { SignalLatestResponse } from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

export function CandidateSignalCard({
  signalLatest,
  priceSpec,
  error,
  loading,
  compact = false,
}: {
  signalLatest: SignalLatestResponse | null;
  priceSpec: PriceDisplaySpec;
  /** Signal-API unavailability code (same endpoint as the baseline card). */
  error?: string | null;
  loading?: boolean;
  compact?: boolean;
}) {
  const candidate = signalLatest?.candidate ?? null;
  const versions = signalLatest?.strategyVersions ?? null;
  const strategyVersion = candidate?.evaluation.strategyVersion ?? versions?.researchCandidate ?? null;
  const isSetup = candidate?.evaluation.outcome === 'BUY_SETUP' || candidate?.evaluation.outcome === 'SELL_SETUP';
  const paper = candidate ? buildCandidatePaperStrip(candidate.paperStats) : null;

  return (
    <section
      aria-label="ক্যান্ডিডেট সিগন্যাল (গবেষণা)"
      data-testid="candidate-signal-card"
      className="flex flex-col rounded-xl border border-border bg-panel"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <FlaskConical className="h-4 w-4 shrink-0 text-sun" aria-hidden />
        <h2 className="min-w-0 text-sm font-semibold text-foreground">ক্যান্ডিডেট সিগন্যাল</h2>
        <Badge
          variant="outline"
          data-testid="candidate-research-badge"
          className="border-sun/50 bg-sun/10 text-[11px] text-sun"
        >
          গবেষণা
        </Badge>
        {candidate && (
          <Badge
            variant="outline"
            className={`ml-auto text-[11px] ${outcomeBadgeTokenClass(candidate.evaluation.outcome)}`}
            data-testid="candidate-outcome-badge"
          >
            <OutcomeBadgeIcon outcome={candidate.evaluation.outcome} />
            {signalOutcomeBn[candidate.evaluation.outcome] ?? candidate.evaluation.outcome}
          </Badge>
        )}
      </div>
      {strategyVersion && (
        <p className="border-b border-border px-4 py-1.5 font-mono text-[10px] text-muted-foreground" data-testid="candidate-strategy-version">
          {strategyVersion}
        </p>
      )}

      <div className="flex-1 space-y-4 p-4">
        {error ? (
          <p className="rounded-lg border border-down/40 bg-down/10 p-3 text-xs leading-relaxed text-content" role="alert">
            ক্যান্ডিডেট ডেটা এখন অনুপলব্ধ — বেসলাইন সিগন্যালের সাথে একই API সংযোগ (<span className="font-mono text-down">{error}</span>)। সংযোগ ফিরলে এখানে ফলাফল আসবে।
          </p>
        ) : loading && !signalLatest ? (
          <div className="space-y-2" aria-hidden>
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-surface" />
            <div className="h-8 w-full animate-pulse rounded bg-surface" />
          </div>
        ) : !candidate ? (
          <p className="text-xs leading-relaxed text-muted-foreground" data-testid="candidate-empty-state">
            প্রথম ক্যান্ডিডেট মূল্যায়ন পরবর্তী সাইকেলে আসবে — এখানে কিছু বানানো হয় না (সৎ খালি অবস্থা)।
          </p>
        ) : (
          <>
            {/* Meta: decision candle + evaluation time + model badge */}
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="min-w-0">
                <p className="leading-snug text-muted-foreground">সিদ্ধান্ত ক্যান্ডেল (M15)</p>
                <p className="break-words font-mono leading-snug text-foreground/90">
                  {candidate.evaluation.decisionCandleTimeUtc ? fmtDhaka(candidate.evaluation.decisionCandleTimeUtc) : '—'}
                </p>
              </div>
              <div className="min-w-0">
                <p className="leading-snug text-muted-foreground">মূল্যায়ন সময় (ঢাকা)</p>
                <p className="break-words font-mono leading-snug text-foreground/90">{fmtDhaka(candidate.evaluation.createdAt)}</p>
              </div>
            </div>
            {isSetup && candidate.model && (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  data-testid="candidate-model-badge"
                  className="border-sun/40 bg-sun/10 text-[11px] text-sun"
                >
                  {candidateModelBn[candidate.model] ?? `মডেল ${candidate.model}`}
                </Badge>
                <span className="min-w-0 break-words text-[10px] leading-relaxed text-muted-foreground">
                  — এই সেটআপটি যে মডেল থেকে এসেছে (A = কাঠামো-রিটেস্ট, B = পুলব্যাক, C = রেঞ্জ-সুইপ)।
                </span>
              </div>
            )}

            {/* Levels — only when the candidate actually produced them */}
            {candidate.levels ? (
              <div className="grid grid-cols-2 gap-2" data-testid="candidate-levels">
                <LevelBox
                  label="দিক"
                  value={candidate.levels.direction === 'BUY' ? 'BUY (লং)' : 'SELL (শর্ট)'}
                  cls={candidate.levels.direction === 'BUY' ? 'text-up' : 'text-down'}
                />
                <LevelBox
                  label="এন্ট্রি রেফারেন্স"
                  value={<PriceLevelText value={candidate.levels.entryReference} spec={priceSpec} />}
                />
                <LevelBox
                  label="স্টপ-লস"
                  value={<PriceLevelText value={candidate.levels.stopLoss} spec={priceSpec} />}
                  cls="text-down"
                />
                <LevelBox
                  label={`টার্গেট (R:R 1:${candidate.levels.rewardRiskRatio.toFixed(2)})`}
                  value={<PriceLevelText value={candidate.levels.target} spec={priceSpec} />}
                  cls="text-up"
                />
                <LevelBox
                  label="ইনভ্যালিডেশন লেভেল"
                  value={<PriceLevelText value={candidate.levels.invalidationLevel} spec={priceSpec} />}
                  cls="text-sun"
                />
                <LevelBox
                  label="মেয়াদ"
                  value={candidate.evaluation.expiryUtc ? fmtDhaka(candidate.evaluation.expiryUtc) : '—'}
                />
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                এই ফলাফলে কোনো লেভেল নেই — শুধুমাত্র BUY_SETUP/SELL_SETUP হলে সম্পূর্ণ লেভেল দেওয়া হয়।
              </p>
            )}

            {/* Reason codes — translated chips */}
            {candidate.evaluation.reasonCodes.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" data-testid="candidate-reason-codes">
                {candidate.evaluation.reasonCodes.slice(0, compact ? 3 : 10).map((c) => (
                  <li
                    key={c}
                    title={c}
                    className="rounded-full border border-sun/25 bg-sun/5 px-2 py-1 text-[10px] leading-relaxed text-content"
                  >
                    <span className="font-mono text-sun">{c}</span> — {bnForCode(c)}
                  </li>
                ))}
                {compact && candidate.evaluation.reasonCodes.length > 3 && (
                  <li className="px-1 py-1 text-[10px] text-content">
                    +{candidate.evaluation.reasonCodes.length - 3}টি কোড — সিগন্যাল ভিউতে সম্পূর্ণ তালিকা
                  </li>
                )}
              </ul>
            )}

            {/* Forward-paper strip (research-only protocol tracking) */}
            {paper && (
              <div
                className="space-y-1.5 rounded-lg border border-border bg-surface p-3"
                role="region"
                aria-label="ফরোয়ার্ড পেপার (ক্যান্ডিডেট)"
                data-testid="candidate-paper-stats"
              >
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-content">
                  <Info className="h-3.5 w-3.5 text-sun" aria-hidden /> ফরোয়ার্ড পেপার (ক্যান্ডিডেট)
                  <span
                    className="font-normal text-muted-foreground"
                    title="phase11-candidate-forward/1 প্রোটোকল — প্রতিটি ক্যান্ডিডেট সেটআপ সম্পূর্ণ হলে তাদের SL/TP/মেয়াদ ফলাফল কাগজে (পেপারে) অনুসরণ করা হয়। কোনো আসল ট্রেড হয় না।"
                  >
                    (প্রোটোকল ট্র্যাকিং)
                  </span>
                </p>
                {paper.isEmpty ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="candidate-paper-empty">
                    {paper.emptyLine}
                  </p>
                ) : (
                  <>
                    <p className="text-[11px] leading-relaxed text-content">{paper.countsLine}</p>
                    <p className="text-[11px] leading-relaxed text-content">{paper.resolvedLine}</p>
                    {paper.unobservableLine && (
                      <p className="text-[10px] leading-relaxed text-muted-foreground">{paper.unobservableLine}</p>
                    )}
                  </>
                )}
                <p className="text-[11px] leading-relaxed text-content" data-testid="candidate-paper-floor">
                  {paper.floorLine}
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-muted-foreground">রায়:</span>
                  <Badge
                    variant="outline"
                    data-testid="candidate-paper-verdict"
                    className={`text-[11px] ${
                      candidate.paperStats.verdict?.conclusion === 'CONTINUE_FORWARD_RESEARCH'
                        ? 'border-up/40 bg-up/10 text-up'
                        : 'border-sun/40 bg-sun/10 text-sun'
                    }`}
                  >
                    {paper.conclusionLabel}
                  </Badge>
                </p>
                {paper.stopLine && (
                  <p className="rounded-md border border-down/40 bg-down/10 p-1.5 text-[10px] leading-relaxed text-down" role="alert">
                    {paper.stopLine}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Explainer — the candidate never trades */}
      <div className="border-t border-border px-4 py-3">
        <p
          className="text-[10px] leading-relaxed text-muted-foreground"
          title="ক্যান্ডিডেট কৌশলটি বেসলাইনের থেকে আলাদা — আলাদা টেবিলে, আলাদা আঙ্গুলছাপ-নামস্থানে সংরক্ষিত। প্রতি মূল্যায়ন-সাইকেলে বেসলাইনের পাশাপাশি চলে এবং ফলাফল কেবল গবেষণার জন্য; এই গবেষণা-কৌশলটি থেকে কোনো অর্ডার কখনো যায় না (লাইভ অর্ডার কেবল স্ক্যাল্পার পাইপলাইন থেকে)।"
        >
          গবেষণা ব্যাখ্যা: ক্যান্ডিডেট একটি পৃথক গবেষণা-কৌশল — বেসলাইনের পাশাপাশি প্রতি সাইকেলে চলে;{' '}
          <span className="text-sun/90">এটি কখনো ট্রেড করে না</span> এবং বেসলাইন সিগন্যালের সাথে মেশানো হয় না।
        </p>
      </div>
    </section>
  );
}
