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
 * setups strip, and the signal-only posture. Honest states throughout —
 * API error ≠ loading ≠ "no evaluation yet"; a suppressed setup says WHY;
 * the SMC section renders ONLY from persisted evidence, never fabricated.
 */

import { CheckCircle2, Layers, Loader2, RefreshCw, ShieldAlert, Timer, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OutcomeBadgeIcon, PriceLevelText, outcomeBadgeTokenClass } from './bits';
import {
  bnForCode,
  fmtDhaka,
  scalperGateBn,
  scalperModelBn,
  scalperStageBn,
  scalperTfLabelBn,
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
  if (tier === 'A') return 'text-up';
  if (tier === 'B') return 'text-sun';
  if (tier === 'C') return 'text-content';
  return 'text-muted-foreground';
}

function TfChip({ j }: { j: ScalperTfJudgementView }) {
  const agreeing = j.agree !== null;
  const buy = j.agree === 'BUY';
  return (
    <div
      className={`flex min-w-0 flex-col gap-1 rounded-lg border px-2.5 py-2 ${
        agreeing
          ? buy
            ? 'border-up/40 bg-up/10'
            : 'border-down/40 bg-down/10'
          : 'border-border bg-surface'
      }`}
      data-testid={`scalper-tf-${j.timeframe}`}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <span className="shrink-0 font-mono text-xs font-semibold text-foreground/90">{j.timeframe}</span>
        <span
          className={`min-w-0 break-words text-[11px] font-medium leading-snug ${
            agreeing ? (buy ? 'text-up' : 'text-down') : 'text-muted-foreground'
          }`}
        >
          {scalperStageBn[j.stage] ?? j.stage}
        </span>
      </div>
      {/* Task 39 overlap fix (compact rail + narrow mobile): the indicator
          values stack VERTICALLY inside a flex-column chip and each metric is
          an atomic no-wrap span on a wrapping row — a narrow container can
          never push two text bands into the same pixels again. */}
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[10px] leading-normal text-muted-foreground">
        <span className="whitespace-nowrap">RSI {j.indicators.rsi !== null ? j.indicators.rsi.toFixed(1) : '—'}</span>
        <span className="whitespace-nowrap">ATR {j.indicators.atr !== null ? j.indicators.atr.toFixed(2) : '—'}</span>
        {/* Phase 14 — this TF's SMC confluence summary (only when the layer ran) */}
        {j.smc && (
          <span className="whitespace-nowrap">
            SMC {j.smc.score} · <span className={smcTierLetterClass(j.smc.tier)}>{j.smc.tier ?? '—'}</span>
          </span>
        )}
      </p>
      {/* Task 37 — the structure gate's refusal reason: the agent's honest
          “এখানে রিভার্স নয় / কাঠামোর বিপরীত” verdict, per TF. */}
      {j.gate && (
        <p
          className="break-words text-[10px] leading-relaxed text-sun/90"
          data-testid={`scalper-tf-gate-${j.timeframe}`}
        >
          {scalperGateBn[j.gate.reason] ?? j.gate.reason}
        </p>
      )}
      <p className="sr-only">
        {`${scalperTfLabelBn[j.timeframe] ?? j.timeframe}: ${scalperStageBn[j.stage] ?? j.stage}`}
        {j.smc ? ` — SMC স্কোর ${j.smc.score}, টিয়ার ${j.smc.tier ?? 'নেই'}` : ''}
        {j.gate ? ` — ${scalperGateBn[j.gate.reason] ?? j.gate.reason}` : ''}
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
    scorePct >= 75 ? 'bg-up' : scorePct >= 55 ? 'bg-sun' : 'bg-muted-foreground';
  const tierBadgeClass =
    tier === 'A'
      ? 'border-up/40 bg-up/10 text-up'
      : tier === 'B'
        ? 'border-sun/40 bg-sun/10 text-sun'
        : 'border-border-strong/40 bg-muted-foreground/10 text-content';
  const dirBadgeClass =
    dir === 'BUY'
      ? 'border-up/40 bg-up/10 text-up'
      : dir === 'SELL'
        ? 'border-down/40 bg-down/10 text-down'
        : 'border-border-strong/40 bg-muted-foreground/10 text-content';

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
      className="space-y-2 rounded-lg border border-border bg-surface p-3"
      data-testid="smc-confluence-section"
    >
      {/* Header: title + tier + direction */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Layers className="h-3.5 w-3.5 shrink-0 text-sun" aria-hidden />
        <h3 className="text-xs font-semibold text-foreground">SMC কনফ্লুয়েন্স (১০-এজেন্ট ইঞ্জিন)</h3>
        <Badge variant="outline" className={`text-[11px] ${tierBadgeClass}`}>
          {tier !== null ? (smcTierBn[tier] ?? tier) : 'টিয়ার নেই'}
        </Badge>
        <Badge variant="outline" className={`text-[11px] ${dirBadgeClass}`}>
          {dir === 'BUY' ? 'BUY' : dir === 'SELL' ? 'SELL' : 'দিক অনির্ণেয়'}
        </Badge>
      </div>

      {/* Confluence meter (0–100, tier-colored fill) */}
      <div className="flex items-center gap-2">
        <div
          className="h-2 min-w-0 flex-1 rounded-full bg-muted"
          role="meter"
          aria-label="SMC কনফ্লুয়েন্স স্কোর"
          aria-valuenow={Math.round(scorePct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`স্কোর ${smc.totalScore}/১০০`}
        >
          <div className={`h-2 rounded-full ${meterFill}`} style={{ width: `${scorePct}%` }} />
        </div>
        <p className="shrink-0 font-mono text-[10px] text-content">স্কোর {smc.totalScore}/১০০</p>
      </div>

      {/* Eight-agent vote grid (border follows the verdict direction) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="smc-agent-grid">
        {smc.votes.map((v) => {
          const pct = v.weight > 0 ? Math.min(100, Math.max(0, (v.score / v.weight) * 100)) : 0;
          const fill =
            v.score <= 0
              ? 'bg-muted'
              : pct >= 75
                ? 'bg-up'
                : pct >= 55
                  ? 'bg-sun'
                  : 'bg-muted-foreground';
          const border =
            dir !== null && v.vote === dir
              ? 'border-up/30'
              : dir !== null && v.vote !== 'NEUTRAL'
                ? 'border-down/30'
                : 'border-border';
          return (
            <div
              key={v.agent}
              className={`min-w-0 rounded-md border ${border} bg-panel px-2 py-2`}
              title={v.reasonEn}
            >
              {/* name on its own band — never collides with the score below */}
              <p className="min-w-0 break-words text-[10px] leading-snug text-content">
                {smcAgentBn[v.agent] ?? v.agent}
              </p>
              {/* score + meter on a second band, separated by real spacing */}
              <div className="mt-1.5 flex items-center gap-1.5">
                <div className="h-1 min-w-0 flex-1 rounded-full bg-muted">
                  <div className={`h-1 rounded-full ${fill}`} style={{ width: `${pct}%` }} />
                </div>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-content">
                  {v.score}/{v.weight}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Hard vetoes — a veto always blocks emission regardless of score */}
      {smc.vetoes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-down/40 bg-down/10 px-2 py-1.5">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-down" aria-hidden />
          <span className="text-[10px] font-semibold text-down">হার্ড ভিটো:</span>
          {smc.vetoes.map((v) => (
            <span
              key={v}
              className="rounded-md border border-down/40 bg-down/10 px-1.5 py-0.5 text-[10px] text-down"
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
            className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
              sweepMatchesDir
                ? 'border-up/40 bg-up/10 text-up'
                : 'border-border bg-panel text-content'
            }`}
          >
            সুইপ: {sweep.direction === 'BULLISH' ? 'সেল-সাইড কাটা ✓' : 'বাই-সাইড কাটা ✓'} @{' '}
            <span className="font-mono">{sweep.levelText}</span> ({sweep.barsAgo} বার আগে)
          </span>
        ) : (
          <span className="rounded-md border border-border bg-panel px-1.5 py-0.5 text-[10px] text-content">
            সুইপ: নেই
          </span>
        )}
        {poiZone !== null ? (
          <span className="rounded-md border border-sun/40 bg-sun/10 px-1.5 py-0.5 text-[10px] text-sun">
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
          <span className="rounded-md border border-border bg-panel px-1.5 py-0.5 text-[10px] text-content">
            POI: নেই
          </span>
        )}
        {lastEvent !== null ? (
          <span className="rounded-md border border-border bg-panel px-1.5 py-0.5 text-[10px] text-content">
            কাঠামো: {lastEvent.type} {lastEvent.direction} @{' '}
            <span className="font-mono">{lastEvent.levelText}</span>
          </span>
        ) : (
          <span className="rounded-md border border-border bg-panel px-1.5 py-0.5 text-[10px] text-content">
            কাঠামো: ইভেন্ট নেই
          </span>
        )}
        {pattern !== null ? (
          <span className="rounded-md border border-border bg-panel px-1.5 py-0.5 text-[10px] text-content">
            প্যাটার্ন: {pattern.kind} (<span className="font-mono">{pattern.strength.toFixed(2)}</span>)
          </span>
        ) : (
          <span className="rounded-md border border-border bg-panel px-1.5 py-0.5 text-[10px] text-content">
            প্যাটার্ন: নেই
          </span>
        )}
        <span
          className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
            killzone !== null
              ? 'border-up/40 bg-up/10 text-up'
              : 'border-border bg-panel text-content'
          }`}
        >
          সেশন: {smc.session.active}
          {killzone !== null ? ` · ${killzone === 'LONDON_KZ' ? 'লন্ডন কিলজোন' : 'NY কিলজোন'}` : ''}
        </span>
        <span className="rounded-md border border-border bg-panel px-1.5 py-0.5 text-[10px] text-content">
          AMD: {smc.amd.phase}
          {smc.amd.signature !== null ? ` · ${smc.amd.signature}` : ''}
        </span>
      </div>

      {/* Top audit reasons (English evidence is deliberate — the audit trail) */}
      {topVotes.length > 0 && (
        <div className="space-y-0.5">
          {topVotes.map((v) => (
            <p key={`why-${v.agent}`} className="text-[10px] leading-relaxed text-muted-foreground">
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
  const lastHour = scalper?.setupsLastHour ?? 0;

  return (
    <section
      aria-label="স্ক্যাল্পার সিগন্যাল (M1 M5 M15)"
      className="flex flex-col rounded-xl border border-border bg-panel"
      data-testid="scalper-signal-card"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Zap className="h-4 w-4 shrink-0 text-sun" aria-hidden />
        <h2 className="min-w-0 text-sm font-semibold text-foreground">স্ক্যাল্পার সিগন্যাল</h2>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <Badge variant="outline" className="border-sun/40 bg-sun/10 text-[11px] text-sun">
            M1 · M5 · M15
          </Badge>
          {/* Phase 8 — scalper setups are confirmed on CLOSED candles by
           * construction (the engine never reads a forming candle), so the
           * badge states that provenance honestly. */}
          <Badge
            variant="outline"
            className="border-border-strong/50 bg-muted text-[11px] text-content"
            title="সিদ্ধান্ত শুধু সম্পূর্ণ-বন্ধ (closed) ক্যান্ডেলের দেওয়া ওপর ভিত্তি করে — গঠনশীল ক্যান্ডেল নয়"
            data-testid="scalper-closed-candle-badge"
          >
            <CheckCircle2 className="h-3 w-3" aria-hidden /> ক্লোজড-ক্যান্ডেল ভিত্তিক
          </Badge>
          {s && (
            <Badge variant="outline" className={`text-[11px] ${outcomeBadgeTokenClass(s.outcome)}`}>
              <OutcomeBadgeIcon outcome={s.outcome} />
              {s.outcome}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-4 p-4">
        {error ? (
          <p className="rounded-lg border border-down/40 bg-down/10 p-3 text-xs leading-relaxed text-content" role="alert">
            স্ক্যাল্পার API এখন অনুপলব্ধ — <span className="font-mono text-down">{error}</span>।{' '}
            {bnForCode(error)} শিডিউল্ড লুপ চালু থাকলে সংযোগ ফিরলে ফলাফল আসবে।
          </p>
        ) : loading && !scalper ? (
          <div className="space-y-2">
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-surface" />
            <div className="h-10 w-full animate-pulse rounded bg-surface" />
          </div>
        ) : !scalper ? null : !s ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
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
                  className={`flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border p-2 text-[11px] ${
                    htf.opposed
                      ? 'border-sun/40 bg-sun/5'
                      : 'border-border bg-surface'
                  }`}
                  data-testid="scalper-htf-trend"
                >
                  <span className="text-muted-foreground">HTF প্রসঙ্গ (কনটিনিউ-বিচার):</span>
                  <span className="font-mono">
                    H1{' '}
                    <span className={htf.h1 === 'bullish' ? 'text-up' : htf.h1 === 'bearish' ? 'text-down' : 'text-content'}>
                      {htf.h1 ? trendBn[htf.h1] : '—'}
                    </span>
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-mono">
                    H4{' '}
                    <span className={htf.h4 === 'bullish' ? 'text-up' : htf.h4 === 'bearish' ? 'text-down' : 'text-content'}>
                      {htf.h4 ? trendBn[htf.h4] : '—'}
                    </span>
                  </span>
                  {htf.opposed && (
                    <span className="min-w-0 break-words text-sun">
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
                <p className="text-xs text-content">{bnForCode('SCALPER_NO_AGREE')}</p>
              )}
              {s.reasonCodes.map((code) => (
                <p key={code} className="text-xs leading-relaxed text-content">
                  <span className="font-mono text-[10px] text-muted-foreground">{code}</span> — {bnForCode(code)}
                </p>
              ))}
              {s.outcome !== 'NO_SETUP' && s.reasonCodes.length === 0 && s.levels && (
                <p className="text-xs leading-relaxed text-content">
                  সেটআপ নির্গত — উৎস{' '}
                  <span className="font-mono text-sun">{s.evidence?.scalper?.sourceTimeframe ?? '—'}</span>
                  {s.evidence?.scalper?.model ? ` · ${scalperModelBn[s.evidence.scalper.model] ?? s.evidence.scalper.model}` : ''}
                  {s.evidence?.scalper?.model === 'SMC_CONFLUENCE' && smcEvidence?.tier != null
                    ? ` · ${smcTierBn[smcEvidence.tier] ?? ''}`
                    : ''}
                  । সিগন্যাল-অনলি — কোনো অর্ডার যায় না।
                </p>
              )}
            </div>

            {/* Levels — ONLY when the evaluation produced them. SMC setups
             * carry a real POI entry ZONE alongside the live reference. */}
            {s.levels ? (
              <div className="grid grid-cols-2 gap-2" data-testid="scalper-levels">
                <div className="min-w-0 rounded-lg border border-border bg-surface p-2">
                  <p className="text-[10px] leading-snug text-muted-foreground">দিক</p>
                  <p className={`mt-0.5 font-mono text-sm font-semibold ${s.levels.direction === 'BUY' ? 'text-up' : 'text-down'}`}>
                    {s.levels.direction === 'BUY' ? 'BUY (লং)' : 'SELL (শর্ট)'}
                  </p>
                </div>
                <div className="min-w-0 rounded-lg border border-border bg-surface p-2">
                  {s.levels.entryZoneLow !== s.levels.entryZoneHigh ? (
                    <>
                      <p className="text-[10px] leading-snug text-muted-foreground">এন্ট্রি জোন (POI)</p>
                      <p className="break-words font-mono text-sm font-semibold text-foreground/90">
                        <PriceLevelText value={s.levels.entryZoneLow} spec={priceSpec} />
                        <span className="text-muted-foreground">–</span>
                        <PriceLevelText value={s.levels.entryZoneHigh} spec={priceSpec} />
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
                        লাইভ এন্ট্রি <PriceLevelText value={s.levels.entryReference} spec={priceSpec} />
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-[10px] leading-snug text-muted-foreground">এন্ট্রি</p>
                      <p className="break-words font-mono text-sm font-semibold text-foreground/90">
                        <PriceLevelText value={s.levels.entryReference} spec={priceSpec} />
                      </p>
                    </>
                  )}
                </div>
                <div className="min-w-0 rounded-lg border border-border bg-surface p-2">
                  <p className="text-[10px] leading-snug text-muted-foreground">স্টপ-লস</p>
                  <p className="mt-0.5 break-words font-mono text-sm font-semibold text-down">
                    <PriceLevelText value={s.levels.stopLoss} spec={priceSpec} />
                  </p>
                </div>
                <div className="min-w-0 rounded-lg border border-border bg-surface p-2">
                  <p className="text-[10px] leading-snug text-muted-foreground">টার্গেট (R:R 1:{s.levels.rewardRiskRatio.toFixed(2)})</p>
                  <p className="mt-0.5 break-words font-mono text-sm font-semibold text-up">
                    <PriceLevelText value={s.levels.target} spec={priceSpec} />
                  </p>
                </div>
              </div>
            ) : null}

            {/* Meta + cadence counter */}
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="min-w-0">
                <p className="leading-snug text-muted-foreground">সিদ্ধান্ত ক্যান্ডেল</p>
                <p className="break-words font-mono leading-snug text-foreground/90">
                  {s.decisionCandleTimeUtc ? fmtDhaka(s.decisionCandleTimeUtc) : '—'}
                </p>
              </div>
              <div className="min-w-0">
                <p className="leading-snug text-muted-foreground">মূল্যায়ন সময় (ঢাকা)</p>
                <p className="break-words font-mono leading-snug text-foreground/90">{fmtDhaka(s.createdAt)}</p>
              </div>
              <div className="min-w-0">
                <p className="leading-snug text-muted-foreground">শেষ ১ ঘণ্টায় সিগন্যাল</p>
                <p className={`font-mono leading-snug ${lastHour >= 5 ? 'text-up' : 'text-foreground/90'}`}>
                  {lastHour}টি <span className="text-muted-foreground">(লক্ষ্য ৫–৭)</span>
                </p>
              </div>
              <div className="min-w-0">
                <p className="leading-snug text-muted-foreground">কুলডাউন</p>
                <p className="font-mono leading-snug text-foreground/90">৮ মিনিট</p>
              </div>
              {/* Phase 8 — setup expiry (present only when the evaluation
               * carried one; static time text, no fake countdown). */}
              {s.expiryUtc && (
                <div className="min-w-0">
                  <p className="leading-snug text-muted-foreground">মেয়াদ</p>
                  <p className="break-words font-mono leading-snug text-foreground/90">
                    {fmtDhaka(s.expiryUtc)}
                    {new Date(s.expiryUtc).getTime() < Date.now() ? (
                      <span className="ml-1 font-sans text-sun">(মেয়াদোত্তীর্ণ)</span>
                    ) : null}
                  </p>
                </div>
              )}
            </div>

            {/* Recent setups strip */}
            {!compact && recent.length > 0 && (
              <div data-testid="scalper-recent-setups">
                <p className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                  <Timer className="h-3 w-3" aria-hidden /> সাম্প্রতিক সেটআপ (শেষ ১ ঘণ্টা)
                </p>
                <div className="max-h-36 space-y-1 overflow-y-auto pr-1 custom-scrollbar">
                  {recent.slice(0, 8).map((r) => (
                    <div
                      key={r.id}
                      className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-[11px]"
                    >
                      <span
                        className={`font-mono font-semibold ${
                          r.outcome === 'BUY_SETUP' ? 'text-up' : 'text-down'
                        }`}
                      >
                        {r.outcome === 'BUY_SETUP' ? 'BUY' : 'SELL'}
                      </span>
                      <span className="font-mono text-muted-foreground">{r.sourceTimeframe ?? '—'}</span>
                      <span className="text-content">
                        {r.model === 'SMC_CONFLUENCE' ? 'SMC' : r.model === 'REVERSAL' ? 'রিভার্সাল' : 'মোমেন্টাম'}
                      </span>
                      <span className="ml-auto font-mono text-muted-foreground">{fmtDhaka(r.createdAt)}</span>
                      {/* Phase 8 — per-setup expiry when the payload carries
                       * one (recentSetups[].expiryUtc); wraps to its own line
                       * on narrow screens so nothing overflows. */}
                      {r.expiryUtc && (
                        <span className="min-w-0 basis-full break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
                          মেয়াদ: {fmtDhaka(r.expiryUtc)}
                          {new Date(r.expiryUtc).getTime() < Date.now() ? (
                            <span className="ml-1 font-sans text-sun">(মেয়াদোত্তীর্ণ)</span>
                          ) : null}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Action footer — section separation via border, never an extra box */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3">
        <Button
          size="sm"
          variant="outline"
          className="min-h-10 border-sun/40 text-sun hover:text-sun"
          onClick={onRun}
          disabled={running}
          data-testid="scalper-run-button"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          এখনই মূল্যায়ন
        </Button>
        <p className="min-w-0 flex-1 basis-40 text-[11px] leading-snug text-muted-foreground">
          যে কোনো একটি টাইমফ্রেম agree করলেই সিগন্যাল — ১-মিনিট লুপে স্বয়ংক্রিয়।
        </p>
      </div>
    </section>
  );
}
