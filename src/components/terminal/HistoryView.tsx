'use client';

/**
 * XAUUSD AI Trading Agent — Signal History view (UI-02).
 * ----------------------------------------------------------------------------
 * Ported from the former "signal" tab: full latest-evaluation detail (levels,
 * evidence, rules-snapshot, Phase-11 condition checklist, backtest
 * comparison) + the append-only evaluation history with the distinct-setup
 * counts. API-unavailable is rendered as an explicit banner (F-04 fix) —
 * never conflated with "genuinely empty".
 *
 * UI-03 "Sky Terminal" polish: unified card anatomy (rounded-xl border
 * border-border bg-panel · header row · p-4 body · border-b dividers),
 * token-only status colors, mono/tabular numerals, one reason-code chip
 * pattern, list headers + hoverable rows, skeleton loading states.
 */

import { useState } from 'react';
import { CheckCircle2, ChevronDown, History, Inbox, Minus, RotateCw, ShieldCheck, XCircle, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { PriceLevelText, PriceQtyText } from './bits';
import {
  bnForCode,
  candidateModelBn,
  directionBn,
  fmtDhaka,
  fmtInd,
  signalOutcomeBn,
  trendBn,
} from '@/lib/dashboard/i18n';
import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';
import { CANDIDATE_STRATEGY_VERSION } from '@/lib/signal/candidate/types';
import type { SignalHistoryResponse, SignalLatestResponse } from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';
import { formatPriceLevel } from '@/lib/market/price-display';

/* ---------------------------------------------------------------------------
 * UI-03 shared presentational helpers — token-only, identical pattern in
 * AnalysisView so both data views read as one family.
 * ------------------------------------------------------------------------- */

/** Outcome → semantic token palette (UI-03; the label text always accompanies
 *  the color — never color-only). Replaces the raw amber/emerald/red palette
 *  so light mode stays legible on white surfaces. */
const OUTCOME_BADGE_CLASS: Record<string, string> = {
  BUY_SETUP: 'border-up/40 bg-up/10 text-up',
  SELL_SETUP: 'border-down/40 bg-down/10 text-down',
  WAIT: 'border-sun/40 bg-sun/10 text-sun',
  NO_SETUP: 'border-border-strong bg-muted text-muted-foreground',
  BLOCKED: 'border-warn/40 bg-warn/10 text-warn',
};

function outcomeBadgeClass(outcome: string): string {
  return OUTCOME_BADGE_CLASS[outcome] ?? 'border-down/40 bg-down/10 text-down';
}

/** One reason-code chip pattern everywhere (UI-03 §5). */
function ReasonChip({ code, title }: { code: string; title?: string }) {
  return (
    <span title={title} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-content">
      {code}
    </span>
  );
}

/** Honest empty state — dashed surface, icon, Bengali message. */
function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-dashed border-border-strong bg-surface p-4 text-xs leading-relaxed text-muted-foreground">
      <Inbox className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{children}</p>
    </div>
  );
}

/** Column-caption row for the append-only lists (decorative legend). */
function ListHeaderRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-hidden
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground"
    >
      {children}
    </div>
  );
}

export function HistoryView({
  signalLatest,
  signalHistory,
  candidateHistory,
  signalRunning,
  onRunSignal,
  priceSpec,
  signalError,
  historyError,
  candidateHistoryError,
  loading,
  below,
}: {
  signalLatest: SignalLatestResponse | null;
  signalHistory: SignalHistoryResponse | null;
  /** Phase 11-E — the candidate's own research history (?strategy=candidate).
   *  Rendered in a SEPARATE labeled section; never merged into the baseline
   *  history list above. */
  candidateHistory: SignalHistoryResponse | null;
  signalRunning: boolean;
  onRunSignal: () => void;
  priceSpec: PriceDisplaySpec;
  signalError?: string | null;
  historyError?: string | null;
  /** Unavailability code for the candidate history endpoint (F-04 fix). */
  candidateHistoryError?: string | null;
  loading?: boolean;
  /** Phase 6/7/11 panels (AI review + risk + execution) rendered under the
   *  signal surfaces — passed from page.tsx to keep this view focused. */
  below?: React.ReactNode;
}) {
  const s = signalLatest?.signal ?? null;

  return (
    <div className="space-y-4">
      {/* Research-signal disclaimer */}
      <div role="note" className="flex items-start gap-3 rounded-xl border border-sun/30 bg-sun/5 p-3.5">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-sun" aria-hidden />
        <p className="text-xs leading-relaxed text-content">
          সিগন্যাল ইঞ্জিন <span className="font-semibold text-sun">নির্ধারিত (deterministic)</span> — LLM এটি বদলাতে পারে না। বেসলাইন ফলাফল{' '}
          <span className="font-semibold text-sun">গবেষণা/সিদ্ধান্ত-সহায়তা</span>; স্ক্যাল্পার সিগন্যাল (M1·M5·M15) রিস্ক-চেক পাস করলে স্বয়ংক্রিয়ভাবে অর্ডার কার্যকর হয়।
          BUY_SETUP/SELL_SETUP হলেই লাভের প্রমাণ নয়।
        </p>
      </div>

      {/* Unavailable banner (F-04 fix) */}
      {signalError && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-down/40 bg-down/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-down" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-down">সিগন্যাল পরিষেবা এখন অনুপলব্ধ</p>
              <p className="mt-0.5 text-xs leading-relaxed text-content">
                {bnForCode(signalError)} — এটি &ldquo;খালি ইতিহাস&rdquo; নয়; API fail-closed। শিডিউল্ড মূল্যায়ন চালু থাকলে ডেটা ফিরবে।
              </p>
            </div>
          </div>
          <div className="flex w-fit shrink-0 items-center gap-2">
            <Badge variant="outline" className="border-border-strong/50 bg-muted font-mono text-content">
              {signalError}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              className="min-h-[40px] gap-1.5 border-down/40 text-down hover:bg-down/10 hover:text-down"
              onClick={onRunSignal}
              disabled={signalRunning}
            >
              <RotateCw className={cn('h-3.5 w-3.5', signalRunning && 'animate-spin')} aria-hidden />
              পুনরায় চেষ্টা
            </Button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- Latest */}
      <Card className="gap-0 border-border bg-panel py-0">
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              <Zap className="h-4 w-4 text-sun" aria-hidden />
              সর্বশেষ সিগন্যাল মূল্যায়ন
              {s && (
                <Badge variant="outline" className={cn('text-[11px] font-semibold', outcomeBadgeClass(s.outcome))}>
                  {signalOutcomeBn[s.outcome] ?? s.outcome}
                </Badge>
              )}
            </h3>
            <Button size="sm" variant="outline" className="min-h-[40px] gap-1.5" onClick={onRunSignal} disabled={signalRunning}>
              {signalRunning ? <Zap className="h-3.5 w-3.5 animate-pulse" aria-hidden /> : <Zap className="h-3.5 w-3.5" aria-hidden />}
              মূল্যায়ন চালান
            </Button>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            POST /api/signal/run — টোকেন-সুরক্ষিত ট্রিগার (fail-closed)। মূল্যায়ন ইতিহাস append-only — আগের ফলাফল কখনো মুছে বা আপডেট হয় না।
          </p>
        </div>
        <CardContent className="space-y-4 p-4">
          {loading && !signalLatest ? (
            <div className="space-y-3" aria-hidden>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-[72px] w-full" />
                ))}
              </div>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : !s ? (
            <EmptyState>এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি — শিডিউল্ড সিঙ্কের পর ইঞ্জিন স্বয়ংক্রিয়ভাবে মূল্যায়ন করবে।</EmptyState>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <div className="rounded-lg border border-border bg-surface p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">ইঞ্জিন / কৌশল</p>
                  <p className="mt-1 font-mono text-sm text-foreground">{s.engineVersion}</p>
                  <p className="font-mono text-xs text-muted-foreground">{s.strategyVersion}</p>
                  <p className="mt-0.5 text-xs text-content">সিম্বল: <span className="font-mono">{s.symbol}</span> · M15</p>
                </div>
                <div className="rounded-lg border border-border bg-surface p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">সিদ্ধান্ত ক্যান্ডেল (M15)</p>
                  <p className="mt-1 text-sm tabular-nums text-foreground">{s.decisionCandleTimeUtc ? fmtDhaka(s.decisionCandleTimeUtc) : '—'}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">জানা গেছে: <span className="tabular-nums">{s.setupKnownAtUtc ? fmtDhaka(s.setupKnownAtUtc) : '—'}</span></p>
                </div>
                <div className="rounded-lg border border-border bg-surface p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">সেটআপ আঙ্গুলছাপ (10.3-A)</p>
                  {s.setupFingerprint ? (
                    <p className="mt-1 break-all font-mono text-xs text-content" title={s.setupFingerprint}>{s.setupFingerprint.slice(0, 16)}…</p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">আঙ্গুলছাপ নেই (legacy/অ-শনাক্ত)</p>
                  )}
                  <p className="mt-0.5 text-xs text-content">একই লজিক্যাল সেটআপ = একই আঙ্গুলছাপ</p>
                </div>
                <div className="rounded-lg border border-border bg-surface p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">ডেটাসেট ফিঙ্গারপ্রিন্ট</p>
                  <p className="mt-1 break-all font-mono text-xs text-content">{s.inputFingerprint ? s.inputFingerprint.slice(0, 16) : '—'}</p>
                  <p className="mt-0.5 text-xs text-content">dataset: <span className="font-mono">{s.datasetFingerprint ? s.datasetFingerprint.slice(0, 12) : '—'}</span></p>
                </div>
                <div className="rounded-lg border border-border bg-surface p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">এক্সিকিউশন লক</p>
                  <p className="mt-1 text-sm text-foreground">{s.executionLocked ? 'সক্রিয় (read-only)' : '—'}</p>
                  <p className="mt-0.5 text-xs text-content">
                    মেয়াদ: {s.expiryUtc ? (
                      <span className="tabular-nums">{fmtDhaka(s.expiryUtc)}{new Date(s.expiryUtc).getTime() < Date.now() ? <span className="ml-1 text-sun">(মেয়াদোত্তীর্ণ)</span> : null}</span>
                    ) : '—'}
                  </p>
                </div>
              </div>

              {/* Reason codes */}
              {s.reasonCodes.length > 0 && (
                <div className="rounded-lg border border-sun/30 bg-sun/5 p-3">
                  <p className="text-xs font-semibold text-sun">
                    {s.outcome === 'BLOCKED' ? 'ব্লকের কারণ (সৎ, সংকেত নয়):' : 'কারণ-কোড:'}
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {s.reasonCodes.map((c) => (
                      <li key={c} className="flex flex-wrap items-baseline gap-1.5 text-xs leading-relaxed text-content">
                        <ReasonChip code={c} />
                        <span>{bnForCode(c)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Levels — dl rows: muted label left, mono value right (SL ↓ / TP ↑) */}
              {s.levels ? (() => {
                const lv = s.levels;
                const lvlZoneLow = formatPriceLevel(lv.entryZoneLow ?? lv.entryZoneLowText, priceSpec);
                const lvlZoneHigh = formatPriceLevel(lv.entryZoneHigh ?? lv.entryZoneHighText, priceSpec);
                const lvlSl = formatPriceLevel(lv.stopLoss ?? lv.stopLossText, priceSpec);
                const lvlTp = formatPriceLevel(lv.target ?? lv.targetText, priceSpec);
                const lvlRef = formatPriceLevel(lv.entryReference ?? lv.entryReferenceText, priceSpec);
                const anyLevelAnomaly = [lvlZoneLow, lvlZoneHigh, lvlSl, lvlTp, lvlRef].some((r) => r.anomaly);
                return (
                  <>
                    <dl className="rounded-lg border border-border bg-surface p-4">
                      <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2">
                          <dt className="text-xs text-muted-foreground">দিক</dt>
                          <dd className={`text-xs font-semibold ${lv.direction === 'BUY' ? 'text-up' : 'text-down'}`}>
                            {lv.direction === 'BUY' ? 'BUY (লং)' : 'SELL (শর্ট)'}
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2">
                          <dt className="shrink-0 text-xs text-muted-foreground">এন্ট্রি জোন</dt>
                          <dd className="text-right font-mono text-xs text-foreground" title={`raw: ${lvlZoneLow.rawText} / ${lvlZoneHigh.rawText}`}>
                            {lvlZoneLow.text}{lvlZoneLow.anomaly && <sup className="ml-0.5 text-sun" aria-label="precision anomaly">≈</sup>} – {lvlZoneHigh.text}{lvlZoneHigh.anomaly && <sup className="ml-0.5 text-sun" aria-label="precision anomaly">≈</sup>}
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2">
                          <dt className="shrink-0 text-xs text-muted-foreground">স্টপ-লস</dt>
                          <dd className="font-mono text-xs text-down" title={`raw: ${lvlSl.rawText}`}>
                            {lvlSl.text}{lvlSl.anomaly && <sup className="ml-0.5 text-sun" aria-label="precision anomaly">≈</sup>}
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2">
                          <dt className="shrink-0 text-xs text-muted-foreground">টার্গেট</dt>
                          <dd className="font-mono text-xs text-up" title={`raw: ${lvlTp.rawText}`}>
                            {lvlTp.text}{lvlTp.anomaly && <sup className="ml-0.5 text-sun" aria-label="precision anomaly">≈</sup>}
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2">
                          <dt className="text-xs text-muted-foreground">Reward / Risk</dt>
                          <dd className="font-mono text-xs text-foreground">1 : {lv.rewardRiskRatio.toFixed(2)}</dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2">
                          <dt className="shrink-0 text-xs text-muted-foreground">রেফারেন্স এন্ট্রি</dt>
                          <dd className="text-right font-mono text-xs text-foreground">
                            <span title={`raw: ${lvlRef.rawText}`}>
                              {lvlRef.text}{lvlRef.anomaly && <sup className="ml-0.5 text-sun" aria-label="precision anomaly">≈</sup>}
                            </span>{' '}
                            <span className="font-sans text-muted-foreground">(স্প্রেড-সমন্বিত)</span>
                          </dd>
                        </div>
                      </div>
                    </dl>
                    {(anyLevelAnomaly || !priceSpec.verified) && (
                      <p className="text-[11px] leading-relaxed text-sun">
                        {priceSpec.verified
                          ? '≈ চিহ্ন: raw গণনা-মান broker grid-এ নেই (derived) — verified digits-এ দেখানো হচ্ছে, raw মান tooltip-এ। সংরক্ষিত মান অপরিবর্তিত।'
                          : 'সিম্বল মেটাডেটা (digits) যাচাইকৃত নয় — কোনো default precision অনুমান না করে raw মান দেখানো হচ্ছে (≈ চিহ্নিত)।'}
                      </p>
                    )}
                  </>
                );
              })() : (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  এই ফলাফলে কোনো লেভেল নেই — শুধুমাত্র BUY_SETUP/SELL_SETUP হলে সম্পূর্ণ, যাচাইকৃত লেভেল দেওয়া হয়।
                </p>
              )}

              {/* Evidence */}
              {s.evidence && (
                <div className="rounded-lg border border-border bg-surface p-4">
                  <p className="text-xs font-semibold text-foreground">প্রমাণ (deterministic)</p>
                  <dl className="mt-1 text-xs">
                    <div className="flex flex-col gap-0.5 border-b border-border/60 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <dt className="shrink-0 text-muted-foreground">স্ট্রাকচার ব্রেক</dt>
                      <dd className="leading-relaxed text-content sm:text-right">
                        {s.evidence.structureEvent ? (
                          <>
                            <span className="font-mono text-content">{s.evidence.structureEvent.type} {directionBn[s.evidence.structureEvent.direction] ?? s.evidence.structureEvent.direction}</span>{' '}
                            @ <PriceLevelText value={s.evidence.structureEvent.level ?? s.evidence.structureEvent.levelText} spec={priceSpec} className="font-mono text-content" /> ({s.evidence.structureEvent.barsSinceBreak} বার আগে, {fmtDhaka(s.evidence.structureEvent.breakCandleTimeUtc)})
                          </>
                        ) : (
                          'সাম্প্রতিক কোনো ব্রেক নেই'
                        )}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5 border-b border-border/60 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <dt className="shrink-0 text-muted-foreground">অ্যাঙ্কর সুইং</dt>
                      <dd className="leading-relaxed text-content sm:text-right">
                        {s.evidence.anchorSwing ? (
                          <>
                            <PriceLevelText value={s.evidence.anchorSwing.price ?? s.evidence.anchorSwing.priceText} spec={priceSpec} className="font-mono text-content" /> ({s.evidence.anchorSwing.kind === 'low' ? 'সুইং লো' : 'সুইং হাই'}, {fmtDhaka(s.evidence.anchorSwing.swingTimeUtc)})
                          </>
                        ) : (
                          'প্রযোজ্য নয়'
                        )}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5 border-b border-border/60 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <dt className="shrink-0 text-muted-foreground">ইন্ডিকেটর (M15)</dt>
                      <dd className="leading-relaxed text-content sm:text-right">
                        EMA50 <span className="font-mono text-content">{fmtInd(s.evidence.indicators.ema50)}</span> · RSI{' '}
                        <span className="font-mono text-content">{fmtInd(s.evidence.indicators.rsi14, 1)}</span> · ATR{' '}
                        <span className="font-mono text-content">{fmtInd(s.evidence.indicators.atr14)}</span> · ADX{' '}
                        <span className="font-mono text-content">{fmtInd(s.evidence.indicators.adx14, 1)}</span>
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5 border-b border-border/60 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <dt className="shrink-0 text-muted-foreground">HTF প্রসঙ্গ</dt>
                      <dd className="leading-relaxed text-content sm:text-right">
                        H1 <span className="font-mono text-content">{s.evidence.htfContext.h1Trend ? (trendBn[s.evidence.htfContext.h1Trend] ?? s.evidence.htfContext.h1Trend) : '—'}</span> · H4{' '}
                        <span className="font-mono text-content">{s.evidence.htfContext.h4Trend ? (trendBn[s.evidence.htfContext.h4Trend] ?? s.evidence.htfContext.h4Trend) : '—'}</span>
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5 border-b border-border/60 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <dt className="shrink-0 text-muted-foreground">রিটেস্ট বার</dt>
                      <dd className="tabular-nums text-content sm:text-right">{s.evidence.retestBarTimeUtc ? fmtDhaka(s.evidence.retestBarTimeUtc) : 'এখনো হয়নি'}</dd>
                    </div>
                    <div className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <dt className="shrink-0 text-muted-foreground">উইন্ডো</dt>
                      <dd className="tabular-nums text-content sm:text-right">M15 {s.evidence.executionWindow.bars} · H1 {s.evidence.h1Window.bars} · H4 {s.evidence.h4Window.bars} ক্যান্ডেল</dd>
                    </div>
                  </dl>
                </div>
              )}

              {/* Quote at evaluation */}
              {s.quote && (
                <p className="text-xs text-muted-foreground">
                  মূল্যায়নের সময় কোট: {String((s.quote as { freshness?: string }).freshness ?? '—')} · উৎস {String((s.quote as { sourceClass?: string }).sourceClass ?? '—')} ·{' '}
                  <PriceLevelText value={(s.quote as { bid?: string }).bid} spec={priceSpec} className="font-mono" /> / <PriceLevelText value={(s.quote as { ask?: string }).ask} spec={priceSpec} className="font-mono" /> ({String((s.quote as { ageSeconds?: number }).ageSeconds ?? '—')}s আগে)
                </p>
              )}

              {/* Rules manifest — 3 honest states */}
              {s.rulesSnapshot.status === 'present' && s.rulesSnapshot.snapshot && (() => {
                const rs = s.rulesSnapshot.snapshot!;
                const sourceBn: Record<string, string> = {
                  'verified-configuration': 'যাচাইকৃত কনফিগ',
                  'strategy-constant': 'কৌশল-ধ্রুবক',
                  'broker-metadata': 'ব্রোকার মেটাডেটা',
                  unavailable: 'অনুপলব্ধ',
                };
                return (
                  <div className="rounded-lg border border-border bg-surface p-3">
                    <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
                      নিয়ম-ম্যানিফেস্ট (এই মূল্যায়নে ব্যবহৃত)
                      <Badge variant="outline" className="border-border-strong bg-muted font-mono text-[10px] text-content">v{rs.rulesSnapshotVersion}</Badge>
                      <span className="break-all font-mono text-[10px] text-content" title={rs.snapshotHash}>hash {rs.snapshotHash.slice(0, 12)}…</span>
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-content">
                      সংরক্ষিত স্ন্যাপশট — পরে কনফিগ বদলালেও এই সারির মান বদলায় না।
                    </p>
                    <div className="custom-scrollbar mt-2 max-h-96 space-y-1 overflow-y-auto pr-1" role="region" aria-label="নিয়ম-ম্যানিফেস্ট তালিকা">
                      {rs.rules.map((entry) => (
                        <div key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border border-border/60 bg-muted px-2 py-1 text-[11px]">
                          <span className="break-all font-mono text-content">{entry.id}</span>
                          <span className="font-mono text-foreground">
                            = {entry.value === null ? 'null' : Array.isArray(entry.value) ? entry.value.join('+') : String(entry.value)}
                          </span>
                          <span className="text-muted-foreground">{entry.unit}</span>
                          <span className="ml-auto text-muted-foreground" title={`source: ${entry.source}`}>{sourceBn[entry.source] ?? entry.source}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {s.rulesSnapshot.status === 'not-recorded' && (
                <div className="rounded-lg border border-sun/30 bg-sun/5 p-3" role="note">
                  <p className="text-xs font-semibold text-sun">নিয়ম-স্ন্যাপশট: এই মূল্যায়নের জন্য রেকর্ড করা হয়নি (Not recorded for this evaluation)</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    পুরনো (legacy) সারি — অনুমান করে বর্তমান কনফিগ দেখানো হয় না; এটি কৌশলের ব্যর্থতাও নয়। নতুন মূল্যায়নে স্বয়ংক্রিয়ভাবে স্ন্যাপশট সংরক্ষিত হবে।
                  </p>
                </div>
              )}
              {s.rulesSnapshot.status === 'invalid' && (
                <div className="rounded-lg border border-down/40 bg-down/10 p-3" role="alert">
                  <p className="text-xs font-semibold text-down">নিয়ম-স্ন্যাপশট অকার্যকর/অসংগত — নিরাপদে প্রত্যাখ্যাত</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">কারণ: {s.rulesSnapshot.reason ?? 'অজানা'}</p>
                </div>
              )}
            </>
          )}

          {/* Phase 11 — condition checklist (why / why not a signal) */}
          {!signalLatest && !signalError && (
            <div className="rounded-lg border border-border bg-surface p-3" role="region" aria-label="শর্ত-বাই-শর্ত বিশ্লেষণ">
              <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
                শর্ত-বাই-শর্ত বিশ্লেষণ — কেন সিগন্যাল হলো / হলো না
                <Badge variant="outline" className="border-sun/40 bg-sun/10 text-sun">ডেটা-গুণমান (কৌশলের দোষ নয়)</Badge>
              </p>
              <p className="mt-1 text-xs leading-relaxed text-content">
                কোনো মূল্যায়ন সংরক্ষিত নেই — সংযোগ ছাড়া ইঞ্জিন মূল্যায়নই করে না (fail-closed)।
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                সক্রিয় লাইভ কৌশল: <span className="font-mono text-content">{SIGNAL_STRATEGY_VERSION}</span> · গবেষণা ক্যান্ডিডেট:{' '}
                <span className="font-mono text-content">{CANDIDATE_STRATEGY_VERSION}</span>{' '}
                (লাইভ ফরোয়ার্ড পর্যবেক্ষণে সক্রিয় — প্রতি সাইকেলে বেসলাইনের পাশাপাশি মূল্যায়ন হয়; কখনো ট্রেড করে না)
              </p>
            </div>
          )}
          {signalLatest?.conditions && (() => {
            const cond = signalLatest.conditions;
            const catBn = cond.category === 'data-quality'
              ? 'ডেটা-গুণমান (কৌশলের দোষ নয়)'
              : cond.category === 'strategy-logic'
                ? 'কৌশল-লজিক'
                : null;
            return (
              <div className="rounded-lg border border-border bg-surface p-3" role="region" aria-label="শর্ত-বাই-শর্ত বিশ্লেষণ">
                <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
                  শর্ত-বাই-শর্ত বিশ্লেষণ — কেন সিগন্যাল হলো / হলো না
                  {catBn && (
                    <Badge variant="outline" className={cond.category === 'data-quality' ? 'border-sun/40 bg-sun/10 text-sun' : 'border-border-strong bg-muted text-content'}>
                      {catBn}
                    </Badge>
                  )}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-content">{cond.headlineBn}</p>
                {cond.checks.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {cond.checks.map((c) => (
                      <div key={c.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border border-border/60 bg-muted px-2 py-1.5 text-[11px]">
                        {c.passed === true ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 self-center text-up" aria-hidden />
                        ) : c.passed === false ? (
                          <XCircle className="h-3.5 w-3.5 shrink-0 self-center text-down" aria-hidden />
                        ) : (
                          <Minus className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
                        )}
                        <span className="text-content">{c.labelBn}</span>
                        <span className="ml-auto text-muted-foreground">{c.category === 'data-quality' ? 'ডেটা' : 'কৌশল'}</span>
                        {c.detailBn && <span className="w-full text-muted-foreground">{c.detailBn}</span>}
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-content">
                  ✓ পাস · ✗ ব্যর্থ · — পর্যায়ে পৌঁছায়নি (ইঞ্জিন আগের ব্যর্থ ধাপেই থেমে গেছে — সৎ অবস্থা, লুকানো নয়)।
                </p>
                {signalLatest.strategyVersions && (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    সক্রিয় লাইভ কৌশল: <span className="font-mono text-content">{signalLatest.strategyVersions.activeLive}</span> · গবেষণা ক্যান্ডিডেট:{' '}
                    <span className="font-mono text-content">{signalLatest.strategyVersions.researchCandidate}</span>{' '}
                    (লাইভ ফরোয়ার্ড পর্যবেক্ষণে সক্রিয় — প্রতি সাইকেলে বেসলাইনের পাশাপাশি মূল্যায়ন হয়; কখনো ট্রেড করে না)
                  </p>
                )}
              </div>
            );
          })()}

          {/* Backtest comparison */}
          {signalLatest?.backtestComparison && (() => {
            const bt = signalLatest.backtestComparison;
            const dev = bt.dev as { status?: string; executedTrades?: number; winRate?: number | null; profitFactor?: number | null; netPnlPrice?: number | null; reason?: string };
            const oos = bt.oos as { status?: string; executedTrades?: number; winRate?: number | null; profitFactor?: number | null; netPnlPrice?: number | null; reason?: string };
            return (
              <div className="rounded-lg border border-border bg-surface p-3">
                <p className="text-xs font-semibold text-foreground">
                  তুলনা-ব্যাকটেস্ট (একই কৌশল সংস্করণ <span className="font-mono text-content">{bt.strategyVersion}</span>)
                </p>
                <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                  {fmtDhaka(bt.createdAt)} · {bt.timeframe} · {bt.candleCount} ক্যান্ডেল · dataset {bt.datasetFromUtc.slice(0, 10)} → {bt.datasetToUtc.slice(0, 10)}
                </p>
                <dl className="mt-1 text-xs">
                  <div className="flex flex-col gap-0.5 border-b border-border/60 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                    <dt className="shrink-0 text-muted-foreground">Dev</dt>
                    <dd className="tabular-nums text-content sm:text-right">
                      {dev.status === 'INSUFFICIENT_DATA' || dev.executedTrades === undefined
                        ? `INSUFFICIENT_DATA — ${dev.reason ?? 'পর্যাপ্ত ট্রেড নেই'}`
                        : `${dev.executedTrades} ট্রেড · জয়রেট ${dev.winRate ?? '—'} · PF ${dev.profitFactor ?? '—'} · নিট `}
                      {dev.netPnlPrice !== undefined && dev.status !== 'INSUFFICIENT_DATA' && <PriceQtyText value={dev.netPnlPrice} spec={priceSpec} />}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                    <dt className="shrink-0 text-muted-foreground">OOS</dt>
                    <dd className="tabular-nums text-content sm:text-right">
                      {oos.status === 'INSUFFICIENT_DATA' || oos.executedTrades === undefined
                        ? `INSUFFICIENT_DATA — ${oos.reason ?? 'পর্যাপ্ত ট্রেড নেই'}`
                        : `${oos.executedTrades} ট্রেড · জয়রেট ${oos.winRate ?? '—'} · PF ${oos.profitFactor ?? '—'} · নিট `}
                      {oos.netPnlPrice !== undefined && oos.status !== 'INSUFFICIENT_DATA' && <PriceQtyText value={oos.netPnlPrice} spec={priceSpec} />}
                    </dd>
                  </div>
                </dl>
                {bt.limitations.length > 0 && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">{bt.limitations.join(' · ')}</p>
                )}
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- History */}
      <Card className="gap-0 border-border bg-panel py-0">
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              <History className="h-4 w-4 text-sun" aria-hidden />
              মূল্যায়ন-ইতিহাস (append-only)
              {signalHistory?.outcomeCounts && (
                <span className="flex flex-wrap gap-1.5">
                  {Object.entries(signalHistory.outcomeCounts).map(([k, v]) => (
                    <Badge key={k} variant="outline" className={cn('text-[10px]', outcomeBadgeClass(k))}>
                      {signalOutcomeBn[k]?.split(' ')[0] ?? k}: {v}
                    </Badge>
                  ))}
                </span>
              )}
            </h3>
            {signalHistory?.counts && (
              <p className="text-xs text-muted-foreground">
                মোট <span className="font-mono text-foreground">{signalHistory.counts.totalEvaluations}</span> মূল্যায়ন ·{' '}
                <span className="font-mono text-foreground">{signalHistory.counts.distinctSetups}</span> স্বতন্ত্র সেটআপ
              </p>
            )}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            মূল্যায়ন-সংখ্যা ≠ স্বতন্ত্র সেটআপ-সংখ্যা — একই লজিক্যাল সেটআপ বারবার মূল্যায়ন হতে পারে (10.3-A dedup)। আঙ্গুলছাপ-নেই সারি = legacy/অ-শনাক্ত।
          </p>
        </div>
        <CardContent className="p-4">
          {historyError ? (
            <div role="alert" className="rounded-lg border border-down/40 bg-down/10 p-3 text-xs text-content">
              <p className="font-semibold text-down">মূল্যায়ন-ইতিহাস API অনুপলব্ধ</p>
              <p className="mt-0.5 leading-relaxed">
                <span className="font-mono text-down">{historyError}</span> — এটি খালি-ইতিহাস নয় (fail-closed)।
              </p>
            </div>
          ) : loading && !signalHistory ? (
            <div className="space-y-1.5" aria-hidden>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !signalHistory ? (
            <EmptyState>মূল্যায়ন-ইতিহাস এখন লোড করা যায়নি (সৎ খালি)।</EmptyState>
          ) : signalHistory.history.length === 0 ? (
            <EmptyState>এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি — শিডিউল্ড সিঙ্কের পর ইঞ্জিন স্বয়ংক্রিয়ভাবে মূল্যায়ন করবে।</EmptyState>
          ) : (
            <div className="space-y-1.5">
              <ListHeaderRow>
                <span>সময়</span>
                <span>ফলাফল</span>
                <span>কারণ-কোড</span>
                <span className="ml-auto">সেটআপ আঙ্গুলছাপ</span>
              </ListHeaderRow>
              <div className="custom-scrollbar max-h-96 space-y-1.5 overflow-y-auto pr-1" role="region" aria-label="সাম্প্রতিক মূল্যায়ন তালিকা">
                {signalHistory.history.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs transition-colors hover:bg-accent">
                    <span className="tabular-nums text-content">{fmtDhaka(h.createdAt)}</span>
                    <Badge variant="outline" className={cn('text-[11px] font-semibold', outcomeBadgeClass(h.outcome))}>
                      {signalOutcomeBn[h.outcome] ?? h.outcome}
                    </Badge>
                    {h.reasonCodes.length > 0 && (
                      <span className="flex flex-wrap items-baseline gap-1">
                        {h.reasonCodes.map((c) => (
                          <ReasonChip key={c} code={c} />
                        ))}
                      </span>
                    )}
                    {h.setupFingerprint ? (
                      <span className="ml-auto break-all font-mono text-[10px] text-content" title={h.setupFingerprint}>
                        সেটআপ {h.setupFingerprint.slice(0, 10)}…
                      </span>
                    ) : (
                      <span className="ml-auto text-[10px] text-muted-foreground">আঙ্গুলছাপ নেই (legacy/অ-শনাক্ত)</span>
                    )}
                    {h.rulesSnapshot.status === 'not-recorded' && (
                      <span className="text-[10px] text-sun" title="Not recorded for this evaluation">নিয়ম-রেকর্ড নেই</span>
                    )}
                    {h.rulesSnapshot.status === 'invalid' && (
                      <span className="text-[10px] text-down" title={`অকার্যকর স্ন্যাপশট: ${h.rulesSnapshot.reason ?? ''}`}>স্ন্যাপশট অকার্যকর</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* --------------------------------------------- Candidate history (research) */}
      <CandidateHistoryCard candidateHistory={candidateHistory} error={candidateHistoryError} loading={loading} />
      {below}
    </div>
  );
}

/**
 * Phase 11-E — the candidate's own append-only history, in a clearly-labeled
 * collapsible section SEPARATE from the baseline history card above. Rows come
 * from /api/signal/history?strategy=candidate; every honest state is distinct
 * (error ≠ not-loaded ≠ empty) and nothing is ever fabricated.
 */
function CandidateHistoryCard({
  candidateHistory,
  error,
  loading,
}: {
  candidateHistory: SignalHistoryResponse | null;
  error?: string | null;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rows = candidateHistory?.history ?? [];
  const strategyVersion = candidateHistory?.strategyVersion ?? CANDIDATE_STRATEGY_VERSION;

  return (
    <Card className="gap-0 border-sun/25 bg-panel py-0" data-testid="candidate-history-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="px-4 pt-3">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-expanded={open}
              aria-controls="candidate-history-content"
              data-testid="candidate-history-toggle"
              className="flex min-h-[44px] w-full flex-wrap items-center gap-2 rounded-lg px-1 py-1 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-content transition-transform ${open ? 'rotate-180' : ''}`}
                aria-hidden
              />
              <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                ক্যান্ডিডেট ইতিহাস
                <Badge variant="outline" className="border-sun/50 bg-sun/10 text-sun">
                  গবেষণা
                </Badge>
              </span>
              {candidateHistory?.counts && (
                <span className="text-xs font-normal text-muted-foreground">
                  মোট <span className="font-mono text-foreground">{candidateHistory.counts.totalEvaluations}</span> মূল্যায়ন ·{' '}
                  <span className="font-mono text-foreground">{candidateHistory.counts.distinctSetups}</span> স্বতন্ত্র সেটআপ
                </span>
              )}
            </button>
          </CollapsibleTrigger>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            শুধুমাত্র গবেষণা ক্যান্ডিডেট কৌশলের (<span className="font-mono">{strategyVersion}</span>) append-only মূল্যায়ন — উপরের
            বেসলাইন ইতিহাসের থেকে সম্পূর্ণ আলাদা। ক্যান্ডিডেট কখনো ট্রেড করে না।
          </p>
          {candidateHistory?.outcomeCounts && Object.keys(candidateHistory.outcomeCounts).length > 0 && (
            <span className="mb-3 mt-2 flex flex-wrap gap-1.5">
              {Object.entries(candidateHistory.outcomeCounts).map(([k, v]) => (
                <Badge key={k} variant="outline" className={cn('text-[10px]', outcomeBadgeClass(k))}>
                  {signalOutcomeBn[k]?.split(' ')[0] ?? k}: {v}
                </Badge>
              ))}
            </span>
          )}
        </div>
        <CollapsibleContent id="candidate-history-content">
          <CardContent className="border-t border-border p-4">
            {error ? (
              <div role="alert" className="rounded-lg border border-down/40 bg-down/10 p-3 text-xs text-content">
                <p className="font-semibold text-down">ক্যান্ডিডেট-ইতিহাস API অনুপলব্ধ</p>
                <p className="mt-0.5 leading-relaxed">
                  <span className="font-mono text-down">{error}</span> — এটি খালি-ইতিহাস নয় (fail-closed)।
                </p>
              </div>
            ) : loading && !candidateHistory ? (
              <div className="space-y-1.5" aria-hidden>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : !candidateHistory ? (
              <EmptyState>ক্যান্ডিডেট-ইতিহাস এখন লোড করা যায়নি (সৎ খালি)।</EmptyState>
            ) : rows.length === 0 ? (
              <EmptyState>এখনো কোনো ক্যান্ডিডেট মূল্যায়ন সংরক্ষিত হয়নি — প্রথম মূল্যায়ন পরবর্তী সাইকেলে আসবে।</EmptyState>
            ) : (
              <div className="space-y-1.5">
                <ListHeaderRow>
                  <span>সময়</span>
                  <span>ফলাফল</span>
                  <span>মডেল</span>
                  <span>কারণ-কোড</span>
                  <span className="ml-auto">সিদ্ধান্ত ক্যান্ডেল</span>
                </ListHeaderRow>
                <div
                  className="custom-scrollbar max-h-96 space-y-1.5 overflow-y-auto pr-1"
                  role="region"
                  aria-label="ক্যান্ডিডেট মূল্যায়ন তালিকা (গবেষণা)"
                  data-testid="candidate-history-list"
                >
                  {rows.map((h) => (
                    <div
                      key={h.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs transition-colors hover:bg-accent"
                      data-testid="candidate-history-row"
                    >
                      <span className="tabular-nums text-content">{fmtDhaka(h.createdAt)}</span>
                      <Badge variant="outline" className={cn('text-[11px] font-semibold', outcomeBadgeClass(h.outcome))}>
                        {signalOutcomeBn[h.outcome] ?? h.outcome}
                      </Badge>
                      {h.model && (
                        <Badge variant="outline" className="border-sun/40 bg-sun/10 text-[11px] font-semibold text-sun">
                          {candidateModelBn[h.model] ?? `মডেল ${h.model}`}
                        </Badge>
                      )}
                      {h.reasonCodes.length > 0 && (
                        <span className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-1">
                          {h.reasonCodes.map((c) => (
                            <span key={c} className="flex items-baseline gap-1">
                              <ReasonChip code={c} />
                              <span className="text-[10px] leading-relaxed text-muted-foreground">{bnForCode(c)}</span>
                            </span>
                          ))}
                        </span>
                      )}
                      {h.decisionCandleTimeUtc && (
                        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">সিদ্ধান্ত ক্যান্ডেল: {fmtDhaka(h.decisionCandleTimeUtc)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
