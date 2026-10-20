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
import { PriceLevelText } from './bits';
import { buildCandidatePaperStrip } from '@/lib/dashboard/candidate-display';
import {
  bnForCode,
  candidateModelBn,
  fmtDhaka,
  signalOutcomeBn,
  signalOutcomeBadgeClass,
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
      className="flex flex-col rounded-xl border border-amber-500/25 bg-zinc-900/40"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <FlaskConical className="h-4 w-4 text-amber-400" aria-hidden />
        <h2 className="text-sm font-semibold text-zinc-100">ক্যান্ডিডেট সিগন্যাল</h2>
        <Badge
          variant="outline"
          data-testid="candidate-research-badge"
          className="border-amber-500/50 bg-amber-500/5 text-amber-300"
        >
          গবেষণা
        </Badge>
        {candidate && (
          <Badge
            variant="outline"
            className={`ml-auto ${signalOutcomeBadgeClass(candidate.evaluation.outcome)}`}
            data-testid="candidate-outcome-badge"
          >
            {signalOutcomeBn[candidate.evaluation.outcome] ?? candidate.evaluation.outcome}
          </Badge>
        )}
      </div>
      {strategyVersion && (
        <p className="border-b border-zinc-800/60 px-3 py-1.5 font-mono text-[10px] text-zinc-500" data-testid="candidate-strategy-version">
          {strategyVersion}
        </p>
      )}

      <div className="flex-1 space-y-3 p-3">
        {error ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 text-xs leading-relaxed text-zinc-400" role="alert">
            ক্যান্ডিডেট ডেটা এখন অনুপলব্ধ — বেসলাইন সিগন্যালের সাথে একই API সংযোগ (<span className="font-mono text-red-300">{error}</span>)। সংযোগ ফিরলে এখানে ফলাফল আসবে।
          </p>
        ) : loading && !signalLatest ? (
          <div className="space-y-2" aria-hidden>
            <div className="h-4 w-2/3 animate-pulse rounded bg-zinc-800" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-800" />
            <div className="h-8 w-full animate-pulse rounded bg-zinc-800" />
          </div>
        ) : !candidate ? (
          <p className="text-xs leading-relaxed text-zinc-500" data-testid="candidate-empty-state">
            প্রথম ক্যান্ডিডেট মূল্যায়ন পরবর্তী সাইকেলে আসবে — এখানে কিছু বানানো হয় না (সৎ খালি অবস্থা)।
          </p>
        ) : (
          <>
            {/* Meta: decision candle + evaluation time + model badge */}
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <p className="text-zinc-500">সিদ্ধান্ত ক্যান্ডেল (M15)</p>
                <p className="font-mono text-zinc-200">
                  {candidate.evaluation.decisionCandleTimeUtc ? fmtDhaka(candidate.evaluation.decisionCandleTimeUtc) : '—'}
                </p>
              </div>
              <div>
                <p className="text-zinc-500">মূল্যায়ন সময় (ঢাকা)</p>
                <p className="font-mono text-zinc-200">{fmtDhaka(candidate.evaluation.createdAt)}</p>
              </div>
            </div>
            {isSetup && candidate.model && (
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  data-testid="candidate-model-badge"
                  className="border-amber-500/40 bg-amber-500/10 text-amber-300"
                >
                  {candidateModelBn[candidate.model] ?? `মডেল ${candidate.model}`}
                </Badge>
                <span className="text-[10px] leading-relaxed text-zinc-500">
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
                  cls={candidate.levels.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}
                />
                <LevelBox
                  label="এন্ট্রি রেফারেন্স"
                  value={<PriceLevelText value={candidate.levels.entryReference} spec={priceSpec} />}
                />
                <LevelBox
                  label="স্টপ-লস"
                  value={<PriceLevelText value={candidate.levels.stopLoss} spec={priceSpec} />}
                  cls="text-red-300"
                />
                <LevelBox
                  label={`টার্গেট (R:R 1:${candidate.levels.rewardRiskRatio.toFixed(2)})`}
                  value={<PriceLevelText value={candidate.levels.target} spec={priceSpec} />}
                  cls="text-emerald-300"
                />
                <LevelBox
                  label="ইনভ্যালিডেশন লেভেল"
                  value={<PriceLevelText value={candidate.levels.invalidationLevel} spec={priceSpec} />}
                  cls="text-amber-300"
                />
                <LevelBox
                  label="মেয়াদ"
                  value={candidate.evaluation.expiryUtc ? fmtDhaka(candidate.evaluation.expiryUtc) : '—'}
                />
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-zinc-500">
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
                    className="rounded-full border border-amber-500/25 bg-amber-500/5 px-2 py-1 text-[10px] leading-relaxed text-zinc-400"
                  >
                    <span className="font-mono text-amber-400">{c}</span> — {bnForCode(c)}
                  </li>
                ))}
                {compact && candidate.evaluation.reasonCodes.length > 3 && (
                  <li className="px-1 py-1 text-[10px] text-zinc-400">
                    +{candidate.evaluation.reasonCodes.length - 3}টি কোড — সিগন্যাল ভিউতে সম্পূর্ণ তালিকা
                  </li>
                )}
              </ul>
            )}

            {/* Forward-paper strip (research-only protocol tracking) */}
            {paper && (
              <div
                className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5"
                role="region"
                aria-label="ফরোয়ার্ড পেপার (ক্যান্ডিডেট)"
                data-testid="candidate-paper-stats"
              >
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300">
                  <Info className="h-3.5 w-3.5 text-amber-400" aria-hidden /> ফরোয়ার্ড পেপার (ক্যান্ডিডেট)
                  <span
                    className="font-normal text-zinc-500"
                    title="phase11-candidate-forward/1 প্রোটোকল — প্রতিটি ক্যান্ডিডেট সেটআপ সম্পূর্ণ হলে তাদের SL/TP/মেয়াদ ফলাফল কাগজে (পেপারে) অনুসরণ করা হয়। কোনো আসল ট্রেড হয় না।"
                  >
                    (প্রোটোকল ট্র্যাকিং)
                  </span>
                </p>
                {paper.isEmpty ? (
                  <p className="text-[11px] leading-relaxed text-zinc-500" data-testid="candidate-paper-empty">
                    {paper.emptyLine}
                  </p>
                ) : (
                  <>
                    <p className="text-[11px] leading-relaxed text-zinc-400">{paper.countsLine}</p>
                    <p className="text-[11px] leading-relaxed text-zinc-400">{paper.resolvedLine}</p>
                    {paper.unobservableLine && (
                      <p className="text-[10px] leading-relaxed text-zinc-500">{paper.unobservableLine}</p>
                    )}
                  </>
                )}
                <p className="text-[11px] leading-relaxed text-zinc-400" data-testid="candidate-paper-floor">
                  {paper.floorLine}
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-zinc-500">রায়:</span>
                  <Badge
                    variant="outline"
                    data-testid="candidate-paper-verdict"
                    className={
                      candidate.paperStats.verdict?.conclusion === 'CONTINUE_FORWARD_RESEARCH'
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                    }
                  >
                    {paper.conclusionLabel}
                  </Badge>
                </p>
                {paper.stopLine && (
                  <p className="rounded border border-red-500/30 bg-red-500/5 p-1.5 text-[10px] leading-relaxed text-red-300" role="alert">
                    {paper.stopLine}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Explainer — the candidate never trades */}
      <div className="border-t border-zinc-800/80 p-2.5">
        <p
          className="text-[10px] leading-relaxed text-zinc-500"
          title="ক্যান্ডিডেট কৌশলটি বেসলাইনের থেকে আলাদা — আলাদা টেবিলে, আলাদা আঙ্গুলছাপ-নামস্থানে সংরক্ষিত। প্রতি মূল্যায়ন-সাইকেলে বেসলাইনের পাশাপাশি চলে এবং ফলাফল কেবল গবেষণার জন্য; কোনো অর্ডার/এক্সিকিউশন কখনো হয় না (চার-সুইচ লক সক্রিয়)।"
        >
          গবেষণা ব্যাখ্যা: ক্যান্ডিডেট একটি পৃথক গবেষণা-কৌশল — বেসলাইনের পাশাপাশি প্রতি সাইকেলে চলে;{' '}
          <span className="text-amber-400/90">এটি কখনো ট্রেড করে না</span> এবং বেসলাইন সিগন্যালের সাথে মেশানো হয় না।
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
