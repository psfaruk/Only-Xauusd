'use client';

/**
 * XAUUSD AI Trading Agent — Scalper signal card (Phase 12, Task 32;
 * Phase 14 upgrade, Task 34-i — ICT/SMC ten-agent confluence surface).
 * ----------------------------------------------------------------------------
 * The PRIMARY signal surface: the live M1/M5/M15 OR-logic strategy the user
 * requested (any ONE timeframe agreeing → signal, target cadence 5–7/hour).
 *
 * Renders: the latest scalper verdict with all THREE independent timeframe
 * judgements (chips with per-TF stage + indicators + the Phase 14 SMC
 * confluence chip: score + tier letter), the ICT/SMC ten-agent confluence
 * section — tier + direction badges, confluence meter, the eight-agent vote
 * grid, hard vetoes, the key ICT evidence strip and the top audit reasons —
 * whenever the engine actually attached that evidence, levels only when the
 * evaluation actually produced them (SMC setups show the real POI entry ZONE
 * plus the live entry reference), the last-hour setup counter, the recent
 * setups strip, and the auto-execution posture. Honest states throughout —
 * API error ≠ loading ≠ "no evaluation yet"; a suppressed setup says WHY;
 * the SMC section renders ONLY from persisted evidence, never fabricated.
 */

import { Layers, Loader2, RefreshCw, ShieldAlert, Timer, Zap } from 'lucide-react';
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
  smcAgentBn,
  smcTierBn,
  smcVetoBn,
} from '@/lib/dashboard/i18n';
import type {
  ScalperLatestResponse,
  ScalperTfJudgementView,
  SmcConfluenceView,
} from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

/** Tiny colored tier letter (per-TF chips): A emerald, B amber, C zinc. */
function smcTierLetterClass(tier: 'A' | 'B' | 'C' | null): string {
  if (tier === 'A') return 'text-emerald-400';
  if (tier === 'B') return 'text-amber-400';
  if (tier === 'C') return 'text-zinc-400';
  return 'text-zinc-500';
}

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
      {/* Phase 14 — this TF's SMC confluence summary (only when the layer ran) */}
      {j.smc && (
        <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-zinc-500">
          SMC {j.smc.score} ·{' '}
          <span className={smcTierLetterClass(j.smc.tier)}>{j.smc.tier ?? '—'}</span>
        </p>
      )}
      <p className="sr-only">
        {`${scalperTfLabelBn[j.timeframe] ?? j.timeframe}: ${scalperStageBn[j.stage] ?? j.stage}`}
        {j.smc ? ` — SMC স্কোর ${j.smc.score}, টিয়ার ${j.smc.tier ?? 'নেই'}` : ''}
      </p>
    </div>
  );
}

/**
 * Phase 14 (Task 34-i) — the ICT/SMC ten-agent confluence evidence section.
 * Every block renders straight from the persisted `evidence.smc` read of the
 * source timeframe; absent reads get honest "নেই" chips, never placeholders.
 */
function SmcConfluenceSection({ smc }: { smc: SmcConfluenceView }) {
  const dir = smc.direction;
  const tier = smc.tier;
  const scorePct = Math.min(100, Math.max(0, smc.totalScore));
  const meterFill =
    scorePct >= 75 ? 'bg-emerald-500' : scorePct >= 55 ? 'bg-amber-500' : 'bg-zinc-500';
  const tierBadgeClass =
    tier === 'A'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
      : tier === 'B'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
        : 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300';
  const dirBadgeClass =
    dir === 'BUY'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
      : dir === 'SELL'
        ? 'border-red-500/40 bg-red-500/10 text-red-400'
        : 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300';

  // Top 3 audit reasons = the highest-scoring agents that actually scored.
  const topVotes = smc.votes
    .filter((v) => v.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  // Key ICT evidence picks (most recent sweep first; POI follows the verdict
  // direction — a null direction falls back to whichever side exists).
  const sweep = smc.liquidity.sweeps[0] ?? null;
  const sweepMatchesDir =
    sweep !== null &&
    dir !== null &&
    ((sweep.direction === 'BULLISH' && dir === 'BUY') || (sweep.direction === 'BEARISH' && dir === 'SELL'));
  const poiZone =
    dir === 'BUY'
      ? smc.poi.nearestBullish
      : dir === 'SELL'
        ? smc.poi.nearestBearish
        : (smc.poi.nearestBullish ?? smc.poi.nearestBearish);
  // The view's nearest zones carry no timesTested — look the zone up in the
  // capped zones list (kind + exact geometry). Not found → honest fallback.
  const poiTests =
    poiZone !== null
      ? (smc.poi.zones.find(
          (z) =>
            z.kind === poiZone.kind && z.topText === poiZone.topText && z.bottomText === poiZone.bottomText,
        )?.timesTested ?? null)
      : null;
  const lastEvent = smc.structure.lastEvent;
  const pattern = smc.priceAction.decisionPattern;
  const killzone = smc.session.killzone;

  return (
    <div
      className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5"
      data-testid="smc-confluence-section"
    >
      {/* Header: title + tier + direction */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Layers className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
        <h3 className="text-xs font-semibold text-zinc-100">SMC কনফ্লুয়েন্স (১০-এজেন্ট ইঞ্জিন)</h3>
        <Badge variant="outline" className={tierBadgeClass}>
          {tier !== null ? (smcTierBn[tier] ?? tier) : 'টিয়ার নেই'}
        </Badge>
        <Badge variant="outline" className={dirBadgeClass}>
          {dir === 'BUY' ? 'BUY' : dir === 'SELL' ? 'SELL' : 'দিক অনির্ণেয়'}
        </Badge>
      </div>

      {/* Confluence meter (0–100, tier-colored fill) */}
      <div className="flex items-center gap-2">
        <div
          className="h-2 min-w-0 flex-1 rounded-full bg-zinc-800"
          role="meter"
          aria-label="SMC কনফ্লুয়েন্স স্কোর"
          aria-valuenow={Math.round(scorePct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`স্কোর ${smc.totalScore}/১০০`}
        >
          <div className={`h-2 rounded-full ${meterFill}`} style={{ width: `${scorePct}%` }} />
        </div>
        <p className="shrink-0 font-mono text-[10px] text-zinc-400">স্কোর {smc.totalScore}/১০০</p>
      </div>

      {/* Eight-agent vote grid (border follows the verdict direction) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="smc-agent-grid">
        {smc.votes.map((v) => {
          const pct = v.weight > 0 ? Math.min(100, Math.max(0, (v.score / v.weight) * 100)) : 0;
          const fill =
            v.score <= 0
              ? 'bg-zinc-700'
              : pct >= 75
                ? 'bg-emerald-500'
                : pct >= 55
                  ? 'bg-amber-500'
                  : 'bg-zinc-500';
          const border =
            dir !== null && v.vote === dir
              ? 'border-emerald-500/30'
              : dir !== null && v.vote !== 'NEUTRAL'
                ? 'border-red-500/30'
                : 'border-zinc-800';
          return (
            <div
              key={v.agent}
              className={`rounded-md border ${border} bg-zinc-900/60 px-2 py-1.5`}
              title={v.reasonEn}
            >
              <div className="flex items-baseline justify-between gap-1">
                <span className="min-w-0 text-[10px] leading-tight text-zinc-300">
                  {smcAgentBn[v.agent] ?? v.agent}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-zinc-400">
                  {v.score}/{v.weight}
                </span>
              </div>
              <div className="mt-1 h-1 w-full rounded-full bg-zinc-800">
                <div className={`h-1 rounded-full ${fill}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Hard vetoes — a veto always blocks emission regardless of score */}
      {smc.vetoes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden />
          <span className="text-[10px] font-semibold text-red-300">হার্ড ভিটো:</span>
          {smc.vetoes.map((v) => (
            <span
              key={v}
              className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300"
            >
              {smcVetoBn[v] ?? v}
            </span>
          ))}
        </div>
      )}

      {/* Key ICT evidence strip (wrap-friendly; numeric parts in mono) */}
      <div className="flex flex-wrap items-center gap-1" data-testid="smc-evidence-strip">
        {sweep !== null ? (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              sweepMatchesDir
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
            }`}
          >
            সুইপ: {sweep.direction === 'BULLISH' ? 'সেল-সাইড কাটা ✓' : 'বাই-সাইড কাটা ✓'} @{' '}
            <span className="font-mono">{sweep.levelText}</span> ({sweep.barsAgo} বার আগে)
          </span>
        ) : (
          <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
            সুইপ: নেই
          </span>
        )}
        {poiZone !== null ? (
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
            POI: {poiZone.kind}{' '}
            <span className="font-mono">
              {poiZone.bottomText}–{poiZone.topText}
            </span>
            {poiZone.fresh
              ? ' (ফ্রেশ)'
              : poiTests !== null
                ? ` (${poiTests}× টেস্ট)`
                : ' (মিটিগেটেড)'}
          </span>
        ) : (
          <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
            POI: নেই
          </span>
        )}
        {lastEvent !== null ? (
          <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
            কাঠামো: {lastEvent.type} {lastEvent.direction} @{' '}
            <span className="font-mono">{lastEvent.levelText}</span>
          </span>
        ) : (
          <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
            কাঠামো: ইভেন্ট নেই
          </span>
        )}
        {pattern !== null ? (
          <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
            প্যাটার্ন: {pattern.kind} (<span className="font-mono">{pattern.strength.toFixed(2)}</span>)
          </span>
        ) : (
          <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
            প্যাটার্ন: নেই
          </span>
        )}
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] ${
            killzone !== null
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
          }`}
        >
          সেশন: {smc.session.active}
          {killzone !== null ? ` · ${killzone === 'LONDON_KZ' ? 'লন্ডন কিলজোন' : 'NY কিলজোন'}` : ''}
        </span>
        <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
          AMD: {smc.amd.phase}
          {smc.amd.signature !== null ? ` · ${smc.amd.signature}` : ''}
        </span>
      </div>

      {/* Top audit reasons (English evidence is deliberate — the audit trail) */}
      {topVotes.length > 0 && (
        <div className="space-y-0.5">
          {topVotes.map((v) => (
            <p key={`why-${v.agent}`} className="text-[10px] leading-relaxed text-zinc-500">
              · {smcAgentBn[v.agent] ?? v.agent}: {v.reasonEn}
            </p>
          ))}
        </div>
      )}
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
  const smcEvidence = s?.evidence?.smc ?? null;
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

            {/* Task 36 — HTF reverse-vs-continue context (H1/H4 trend read).
             * Renders only when the engine attached the block; the OPPOSED
             * state gets the amber highlight because it explains a WAIT. */}
            {(() => {
              const htf = s.evidence?.scalper?.htfTrend;
              if (!htf) return null;
              const trendBn: Record<string, string> = {
                bullish: 'বুলিশ ↑',
                bearish: 'বেয়ারিশ ↓',
                range: 'রেঞ্জ ↔',
              };
              return (
                <div
                  className={`flex flex-wrap items-center gap-1.5 rounded-lg border p-2 text-[11px] ${
                    htf.opposed
                      ? 'border-amber-500/40 bg-amber-500/5'
                      : 'border-zinc-800 bg-zinc-900/60'
                  }`}
                  data-testid="scalper-htf-trend"
                >
                  <span className="text-zinc-500">HTF প্রসঙ্গ (কনটিনিউ-বিচার):</span>
                  <span className="font-mono">
                    H1{' '}
                    <span className={htf.h1 === 'bullish' ? 'text-emerald-400' : htf.h1 === 'bearish' ? 'text-red-400' : 'text-zinc-400'}>
                      {htf.h1 ? trendBn[htf.h1] : '—'}
                    </span>
                  </span>
                  <span className="text-zinc-600">·</span>
                  <span className="font-mono">
                    H4{' '}
                    <span className={htf.h4 === 'bullish' ? 'text-emerald-400' : htf.h4 === 'bearish' ? 'text-red-400' : 'text-zinc-400'}>
                      {htf.h4 ? trendBn[htf.h4] : '—'}
                    </span>
                  </span>
                  {htf.opposed && (
                    <span className="text-amber-300">
                      — ট্রেন্ডের বিপরীত সিগন্যাল আটকানো (SCALPER_HTF_OPPOSED)
                    </span>
                  )}
                </div>
              );
            })()}

            {/* Phase 14 — the ICT/SMC ten-agent confluence evidence of the
             * source timeframe (ONLY when the engine actually attached it). */}
            {smcEvidence !== null && <SmcConfluenceSection smc={smcEvidence} />}

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
                  {s.evidence?.scalper?.model === 'SMC_CONFLUENCE' && smcEvidence?.tier != null
                    ? ` · ${smcTierBn[smcEvidence.tier] ?? ''}`
                    : ''}
                  {autoArmed ? ' · রিস্ক-চেক পাস করলে অর্ডার স্বয়ংক্রিয়ভাবে যাবে' : ''}
                  ।
                </p>
              )}
            </div>

            {/* Levels — ONLY when the evaluation produced them. SMC setups
             * carry a real POI entry ZONE alongside the live reference. */}
            {s.levels ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="scalper-levels">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
                  <p className="text-[10px] text-zinc-500">দিক</p>
                  <p className={`font-mono text-sm ${s.levels.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {s.levels.direction === 'BUY' ? 'BUY (লং)' : 'SELL (শর্ট)'}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
                  {s.levels.entryZoneLow !== s.levels.entryZoneHigh ? (
                    <>
                      <p className="text-[10px] text-zinc-500">এন্ট্রি জোন (POI)</p>
                      <p className="font-mono text-sm text-zinc-200">
                        <PriceLevelText value={s.levels.entryZoneLow} spec={priceSpec} />
                        <span className="text-zinc-500">–</span>
                        <PriceLevelText value={s.levels.entryZoneHigh} spec={priceSpec} />
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-zinc-500">
                        লাইভ এন্ট্রি <PriceLevelText value={s.levels.entryReference} spec={priceSpec} />
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-[10px] text-zinc-500">এন্ট্রি</p>
                      <p className="font-mono text-sm text-zinc-200">
                        <PriceLevelText value={s.levels.entryReference} spec={priceSpec} />
                      </p>
                    </>
                  )}
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
                      <span className="text-zinc-400">
                        {r.model === 'SMC_CONFLUENCE' ? 'SMC' : r.model === 'REVERSAL' ? 'রিভার্সাল' : 'মোমেন্টাম'}
                      </span>
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
