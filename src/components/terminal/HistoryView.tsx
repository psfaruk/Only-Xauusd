'use client';

/**
 * XAUUSD AI Trading Agent — Signal History view (UI-02).
 * ----------------------------------------------------------------------------
 * Ported from the former "signal" tab: full latest-evaluation detail (levels,
 * evidence, rules-snapshot, Phase-11 condition checklist, backtest
 * comparison) + the append-only evaluation history with the distinct-setup
 * counts. API-unavailable is rendered as an explicit banner (F-04 fix) —
 * never conflated with "genuinely empty".
 */

import { useState } from 'react';
import { CheckCircle2, ChevronDown, FlaskConical, Minus, ShieldCheck, XCircle, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { PriceLevelText, PriceQtyText } from './bits';
import {
  bnForCode,
  candidateModelBn,
  directionBn,
  fmtDhaka,
  fmtInd,
  signalOutcomeBn,
  signalOutcomeBadgeClass,
  trendBn,
} from '@/lib/dashboard/i18n';
import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';
import { CANDIDATE_STRATEGY_VERSION } from '@/lib/signal/candidate/types';
import type { SignalHistoryResponse, SignalLatestResponse } from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';
import { formatPriceLevel } from '@/lib/market/price-display';

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
      <div role="note" className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
        <p className="text-xs leading-relaxed text-zinc-400">
          সিগন্যাল ইঞ্জিন <span className="font-semibold text-amber-300">নির্ধারিত (deterministic)</span> — LLM এটি বদলাতে পারে না। ফলাফল শুধুমাত্র{' '}
          <span className="font-semibold text-amber-300">গবেষণা/সিদ্ধান্ত-সহায়তা</span>; কোনো ট্রেড কার্যকর হয়নি এবং সেই ক্ষমতা সিস্টেমে নেই (চার-সুইচ লক সক্রিয়)।
          BUY_SETUP/SELL_SETUP হলেই লাভের প্রমাণ নয়।
        </p>
      </div>

      {/* Unavailable banner (F-04 fix) */}
      {signalError && (
        <div role="alert" className="flex flex-col gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-red-200">সিগন্যাল পরিষেবা এখন অনুপলব্ধ</p>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
                {bnForCode(signalError)} — এটি &ldquo;খালি ইতিহাস&rdquo; নয়; API fail-closed। শিডিউল্ড মূল্যায়ন চালু থাকলে ডেটা ফিরবে।
              </p>
            </div>
          </div>
          <Badge variant="outline" className="w-fit shrink-0 border-zinc-600/50 bg-zinc-700/20 font-mono text-zinc-400">
            {signalError}
          </Badge>
        </div>
      )}

      {/* ---------------------------------------------------------------- Latest */}
      <Card className="border-zinc-800 bg-zinc-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            সর্বশেষ সিগন্যাল মূল্যায়ন
            {s && (
              <Badge variant="outline" className={signalOutcomeBadgeClass(s.outcome)}>
                {signalOutcomeBn[s.outcome] ?? s.outcome}
              </Badge>
            )}
            <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={onRunSignal} disabled={signalRunning}>
              {signalRunning ? <Zap className="h-3.5 w-3.5 animate-pulse" aria-hidden /> : <Zap className="h-3.5 w-3.5" aria-hidden />}
              মূল্যায়ন চালান
            </Button>
          </CardTitle>
          <p className="text-xs text-zinc-500">
            POST /api/signal/run — টোকেন-সুরক্ষিত ট্রিগার (fail-closed)। মূল্যায়ন ইতিহাস append-only — আগের ফলাফল কখনো মুছে বা আপডেট হয় না।
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && !signalLatest ? (
            <Skeleton className="h-16 w-full" />
          ) : !s ? (
            <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
              এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি — শিডিউল্ড সিঙ্কের পর ইঞ্জিন স্বয়ংক্রিয়ভাবে মূল্যায়ন করবে।
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                  <p className="text-xs text-zinc-500">ইঞ্জিন / কৌশল</p>
                  <p className="mt-1 font-mono text-sm text-zinc-200">{s.engineVersion}</p>
                  <p className="font-mono text-xs text-zinc-500">{s.strategyVersion}</p>
                  <p className="text-xs text-zinc-400">সিম্বল: <span className="font-mono">{s.symbol}</span> · M15</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                  <p className="text-xs text-zinc-500">সিদ্ধান্ত ক্যান্ডেল (M15)</p>
                  <p className="mt-1 text-sm text-zinc-200">{s.decisionCandleTimeUtc ? fmtDhaka(s.decisionCandleTimeUtc) : '—'}</p>
                  <p className="text-xs text-zinc-500">জানা গেছে: {s.setupKnownAtUtc ? fmtDhaka(s.setupKnownAtUtc) : '—'}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                  <p className="text-xs text-zinc-500">সেটআপ আঙ্গুলছাপ (10.3-A)</p>
                  {s.setupFingerprint ? (
                    <p className="mt-1 break-all font-mono text-xs text-zinc-300" title={s.setupFingerprint}>{s.setupFingerprint.slice(0, 16)}…</p>
                  ) : (
                    <p className="mt-1 text-xs text-zinc-500">আঙ্গুলছাপ নেই (legacy/অ-শনাক্ত)</p>
                  )}
                  <p className="text-xs text-zinc-400">একই লজিক্যাল সেটআপ = একই আঙ্গুলছাপ</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                  <p className="text-xs text-zinc-500">ডেটাসেট ফিঙ্গারপ্রিন্ট</p>
                  <p className="mt-1 break-all font-mono text-xs text-zinc-300">{s.inputFingerprint ? s.inputFingerprint.slice(0, 16) : '—'}</p>
                  <p className="text-xs text-zinc-400">dataset: {s.datasetFingerprint ? s.datasetFingerprint.slice(0, 12) : '—'}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                  <p className="text-xs text-zinc-500">এক্সিকিউশন লক</p>
                  <p className="mt-1 text-sm text-zinc-200">{s.executionLocked ? 'সক্রিয় (read-only)' : '—'}</p>
                  <p className="text-xs text-zinc-400">
                    মেয়াদ: {s.expiryUtc ? (
                      <>{fmtDhaka(s.expiryUtc)}{new Date(s.expiryUtc).getTime() < Date.now() ? <span className="ml-1 text-amber-400">(মেয়াদোত্তীর্ণ)</span> : null}</>
                    ) : '—'}
                  </p>
                </div>
              </div>

              {/* Reason codes */}
              {s.reasonCodes.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <p className="text-xs font-semibold text-amber-300">
                    {s.outcome === 'BLOCKED' ? 'ব্লকের কারণ (সৎ, সংকেত নয়):' : 'কারণ-কোড:'}
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {s.reasonCodes.map((c) => (
                      <li key={c} className="text-xs leading-relaxed text-zinc-400">
                        <span className="font-mono text-amber-400">{c}</span> — {bnForCode(c)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Levels */}
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
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                        <p className="text-xs text-zinc-500">দিক</p>
                        <p className={`mt-1 text-sm font-semibold ${lv.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>
                          {lv.direction === 'BUY' ? 'BUY (লং)' : 'SELL (শর্ট)'}
                        </p>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                        <p className="text-xs text-zinc-500">এন্ট্রি জোন</p>
                        <p className="mt-1 font-mono text-sm text-zinc-200" title={`raw: ${lvlZoneLow.rawText} / ${lvlZoneHigh.rawText}`}>
                          {lvlZoneLow.text}{lvlZoneLow.anomaly && <sup className="ml-0.5 text-amber-400" aria-label="precision anomaly">≈</sup>} – {lvlZoneHigh.text}{lvlZoneHigh.anomaly && <sup className="ml-0.5 text-amber-400" aria-label="precision anomaly">≈</sup>}
                        </p>
                      </div>
                      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                        <p className="text-xs text-zinc-500">স্টপ-লস</p>
                        <p className="mt-1 font-mono text-sm text-red-300" title={`raw: ${lvlSl.rawText}`}>
                          {lvlSl.text}{lvlSl.anomaly && <sup className="ml-0.5 text-amber-400" aria-label="precision anomaly">≈</sup>}
                        </p>
                      </div>
                      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                        <p className="text-xs text-zinc-500">টার্গেট</p>
                        <p className="mt-1 font-mono text-sm text-emerald-300" title={`raw: ${lvlTp.rawText}`}>
                          {lvlTp.text}{lvlTp.anomaly && <sup className="ml-0.5 text-amber-400" aria-label="precision anomaly">≈</sup>}
                        </p>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                        <p className="text-xs text-zinc-500">Reward / Risk</p>
                        <p className="mt-1 font-mono text-sm text-zinc-200">1 : {lv.rewardRiskRatio.toFixed(2)}</p>
                        <p className="text-xs text-zinc-400">
                          রেফারেন্স এন্ট্রি{' '}
                          <span className="font-mono" title={`raw: ${lvlRef.rawText}`}>
                            {lvlRef.text}{lvlRef.anomaly && <sup className="ml-0.5 text-amber-400" aria-label="precision anomaly">≈</sup>}
                          </span>{' '}
                          (স্প্রেড-সমন্বিত)
                        </p>
                      </div>
                    </div>
                    {(anyLevelAnomaly || !priceSpec.verified) && (
                      <p className="text-[11px] leading-relaxed text-amber-300/80">
                        {priceSpec.verified
                          ? '≈ চিহ্ন: raw গণনা-মান broker grid-এ নেই (derived) — verified digits-এ দেখানো হচ্ছে, raw মান tooltip-এ। সংরক্ষিত মান অপরিবর্তিত।'
                          : 'সিম্বল মেটাডেটা (digits) যাচাইকৃত নয় — কোনো default precision অনুমান না করে raw মান দেখানো হচ্ছে (≈ চিহ্নিত)।'}
                      </p>
                    )}
                  </>
                );
              })() : (
                <p className="text-xs leading-relaxed text-zinc-500">
                  এই ফলাফলে কোনো লেভেল নেই — শুধুমাত্র BUY_SETUP/SELL_SETUP হলে সম্পূর্ণ, যাচাইকৃত লেভেল দেওয়া হয়।
                </p>
              )}

              {/* Evidence */}
              {s.evidence && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                  <p className="text-xs font-semibold text-zinc-400">প্রমাণ (deterministic)</p>
                  <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-zinc-400 sm:grid-cols-2">
                    {s.evidence.structureEvent ? (
                      <p>
                        স্ট্রাকচার: <span className="font-mono text-zinc-300">{s.evidence.structureEvent.type} {directionBn[s.evidence.structureEvent.direction] ?? s.evidence.structureEvent.direction}</span>{' '}
                        @ <PriceLevelText value={s.evidence.structureEvent.level ?? s.evidence.structureEvent.levelText} spec={priceSpec} className="font-mono text-zinc-300" /> ({s.evidence.structureEvent.barsSinceBreak} বার আগে, {fmtDhaka(s.evidence.structureEvent.breakCandleTimeUtc)})
                      </p>
                    ) : (
                      <p>স্ট্রাকচার ব্রেক: সাম্প্রতিক কোনো ব্রেক নেই</p>
                    )}
                    {s.evidence.anchorSwing ? (
                      <p>
                        অ্যাঙ্কর সুইং: <PriceLevelText value={s.evidence.anchorSwing.price ?? s.evidence.anchorSwing.priceText} spec={priceSpec} className="font-mono text-zinc-300" /> ({s.evidence.anchorSwing.kind === 'low' ? 'সুইং লো' : 'সুইং হাই'}, {fmtDhaka(s.evidence.anchorSwing.swingTimeUtc)})
                      </p>
                    ) : (
                      <p>অ্যাঙ্কর সুইং: প্রযোজ্য নয়</p>
                    )}
                    <p>
                      ইন্ডিকেটর (M15): EMA50 <span className="font-mono text-zinc-300">{fmtInd(s.evidence.indicators.ema50)}</span> · RSI{' '}
                      <span className="font-mono text-zinc-300">{fmtInd(s.evidence.indicators.rsi14, 1)}</span> · ATR{' '}
                      <span className="font-mono text-zinc-300">{fmtInd(s.evidence.indicators.atr14)}</span> · ADX{' '}
                      <span className="font-mono text-zinc-300">{fmtInd(s.evidence.indicators.adx14, 1)}</span>
                    </p>
                    <p>
                      HTF প্রসঙ্গ: H1 <span className="font-mono text-zinc-300">{s.evidence.htfContext.h1Trend ? (trendBn[s.evidence.htfContext.h1Trend] ?? s.evidence.htfContext.h1Trend) : '—'}</span> · H4{' '}
                      <span className="font-mono text-zinc-300">{s.evidence.htfContext.h4Trend ? (trendBn[s.evidence.htfContext.h4Trend] ?? s.evidence.htfContext.h4Trend) : '—'}</span>
                    </p>
                    <p>রিটেস্ট বার: {s.evidence.retestBarTimeUtc ? fmtDhaka(s.evidence.retestBarTimeUtc) : 'এখনো হয়নি'}</p>
                    <p>
                      উইন্ডো: M15 {s.evidence.executionWindow.bars} · H1 {s.evidence.h1Window.bars} · H4 {s.evidence.h4Window.bars} ক্যান্ডেল
                    </p>
                  </div>
                </div>
              )}

              {/* Quote at evaluation */}
              {s.quote && (
                <p className="text-xs text-zinc-500">
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
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                    <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-zinc-400">
                      নিয়ম-ম্যানিফেস্ট (এই মূল্যায়নে ব্যবহৃত)
                      <Badge variant="outline" className="border-zinc-700 bg-zinc-900 font-mono text-[10px] text-zinc-400">v{rs.rulesSnapshotVersion}</Badge>
                      <span className="break-all font-mono text-[10px] text-zinc-400" title={rs.snapshotHash}>hash {rs.snapshotHash.slice(0, 12)}…</span>
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                      সংরক্ষিত স্ন্যাপশট — পরে কনফিগ বদলালেও এই সারির মান বদলায় না।
                    </p>
                    <div className="custom-scrollbar mt-2 max-h-64 space-y-1 overflow-y-auto pr-1" role="region" aria-label="নিয়ম-ম্যানিফেস্ট তালিকা">
                      {rs.rules.map((entry) => (
                        <div key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded border border-zinc-800/60 bg-zinc-900/60 px-2 py-1 text-[11px]">
                          <span className="break-all font-mono text-zinc-400">{entry.id}</span>
                          <span className="font-mono text-zinc-200">
                            = {entry.value === null ? 'null' : Array.isArray(entry.value) ? entry.value.join('+') : String(entry.value)}
                          </span>
                          <span className="text-zinc-400">{entry.unit}</span>
                          <span className="ml-auto text-zinc-400" title={`source: ${entry.source}`}>{sourceBn[entry.source] ?? entry.source}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {s.rulesSnapshot.status === 'not-recorded' && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3" role="note">
                  <p className="text-xs text-amber-300">নিয়ম-স্ন্যাপশট: এই মূল্যায়নের জন্য রেকর্ড করা হয়নি (Not recorded for this evaluation)</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                    পুরনো (legacy) সারি — অনুমান করে বর্তমান কনফিগ দেখানো হয় না; এটি কৌশলের ব্যর্থতাও নয়। নতুন মূল্যায়নে স্বয়ংক্রিয়ভাবে স্ন্যাপশট সংরক্ষিত হবে।
                  </p>
                </div>
              )}
              {s.rulesSnapshot.status === 'invalid' && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3" role="alert">
                  <p className="text-xs text-red-300">নিয়ম-স্ন্যাপশট অকার্যকর/অসংগত — নিরাপদে প্রত্যাখ্যাত</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-zinc-500">কারণ: {s.rulesSnapshot.reason ?? 'অজানা'}</p>
                </div>
              )}
            </>
          )}

          {/* Phase 11 — condition checklist (why / why not a signal) */}
          {!signalLatest && !signalError && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3" role="region" aria-label="শর্ত-বাই-শর্ত বিশ্লেষণ">
              <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-zinc-400">
                শর্ত-বাই-শর্ত বিশ্লেষণ — কেন সিগন্যাল হলো / হলো না
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300">ডেটা-গুণমান (কৌশলের দোষ নয়)</Badge>
              </p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-300">
                কোনো মূল্যায়ন সংরক্ষিত নেই — সংযোগ ছাড়া ইঞ্জিন মূল্যায়নই করে না (fail-closed)।
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                সক্রিয় লাইভ কৌশল: <span className="font-mono text-zinc-400">{SIGNAL_STRATEGY_VERSION}</span> · গবেষণা ক্যান্ডিডেট:{' '}
                <span className="font-mono text-zinc-400">{CANDIDATE_STRATEGY_VERSION}</span>{' '}
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
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3" role="region" aria-label="শর্ত-বাই-শর্ত বিশ্লেষণ">
                <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-zinc-400">
                  শর্ত-বাই-শর্ত বিশ্লেষণ — কেন সিগন্যাল হলো / হলো না
                  {catBn && (
                    <Badge variant="outline" className={cond.category === 'data-quality' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-zinc-700 bg-zinc-900 text-zinc-400'}>
                      {catBn}
                    </Badge>
                  )}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-300">{cond.headlineBn}</p>
                {cond.checks.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {cond.checks.map((c) => (
                      <div key={c.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded border border-zinc-800/60 bg-zinc-900/60 px-2 py-1 text-[11px]">
                        {c.passed === true ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 self-center text-emerald-400" aria-hidden />
                        ) : c.passed === false ? (
                          <XCircle className="h-3.5 w-3.5 shrink-0 self-center text-red-400" aria-hidden />
                        ) : (
                          <Minus className="h-3.5 w-3.5 shrink-0 self-center text-zinc-400" aria-hidden />
                        )}
                        <span className="text-zinc-300">{c.labelBn}</span>
                        <span className="ml-auto text-zinc-400">{c.category === 'data-quality' ? 'ডেটা' : 'কৌশল'}</span>
                        {c.detailBn && <span className="w-full text-zinc-500">{c.detailBn}</span>}
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
                  ✓ পাস · ✗ ব্যর্থ · — পর্যায়ে পৌঁছায়নি (ইঞ্জিন আগের ব্যর্থ ধাপেই থেমে গেছে — সৎ অবস্থা, লুকানো নয়)।
                </p>
                {signalLatest.strategyVersions && (
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                    সক্রিয় লাইভ কৌশল: <span className="font-mono text-zinc-400">{signalLatest.strategyVersions.activeLive}</span> · গবেষণা ক্যান্ডিডেট:{' '}
                    <span className="font-mono text-zinc-400">{signalLatest.strategyVersions.researchCandidate}</span>{' '}
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
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <p className="text-xs font-semibold text-zinc-400">
                  তুলনা-ব্যাকটেস্ট (একই কৌশল সংস্করণ <span className="font-mono text-zinc-300">{bt.strategyVersion}</span>)
                </p>
                <p className="mt-1 text-[11px] text-zinc-500">
                  {fmtDhaka(bt.createdAt)} · {bt.timeframe} · {bt.candleCount} ক্যান্ডেল · dataset {bt.datasetFromUtc.slice(0, 10)} → {bt.datasetToUtc.slice(0, 10)}
                </p>
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-zinc-400">
                    Dev:{' '}
                    {dev.status === 'INSUFFICIENT_DATA' || dev.executedTrades === undefined
                      ? `INSUFFICIENT_DATA — ${dev.reason ?? 'পর্যাপ্ত ট্রেড নেই'}`
                      : `${dev.executedTrades} ট্রেড · জয়রেট ${dev.winRate ?? '—'} · PF ${dev.profitFactor ?? '—'} · নিট `}
                    {dev.netPnlPrice !== undefined && dev.status !== 'INSUFFICIENT_DATA' && <PriceQtyText value={dev.netPnlPrice} spec={priceSpec} />}
                  </p>
                  <p className="text-xs text-zinc-400">
                    OOS:{' '}
                    {oos.status === 'INSUFFICIENT_DATA' || oos.executedTrades === undefined
                      ? `INSUFFICIENT_DATA — ${oos.reason ?? 'পর্যাপ্ত ট্রেড নেই'}`
                      : `${oos.executedTrades} ট্রেড · জয়রেট ${oos.winRate ?? '—'} · PF ${oos.profitFactor ?? '—'} · নিট `}
                    {oos.netPnlPrice !== undefined && oos.status !== 'INSUFFICIENT_DATA' && <PriceQtyText value={oos.netPnlPrice} spec={priceSpec} />}
                  </p>
                </div>
                {bt.limitations.length > 0 && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-400">{bt.limitations.join(' · ')}</p>
                )}
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- History */}
      <Card className="border-zinc-800 bg-zinc-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            মূল্যায়ন-ইতিহাস (append-only)
            {signalHistory?.outcomeCounts && (
              <span className="flex flex-wrap gap-1.5">
                {Object.entries(signalHistory.outcomeCounts).map(([k, v]) => (
                  <Badge key={k} variant="outline" className={`text-[10px] ${signalOutcomeBadgeClass(k)}`}>
                    {signalOutcomeBn[k]?.split(' ')[0] ?? k}: {v}
                  </Badge>
                ))}
              </span>
            )}
            {signalHistory?.counts && (
              <span className="ml-auto text-xs font-normal text-zinc-500">
                মোট <span className="font-mono text-zinc-300">{signalHistory.counts.totalEvaluations}</span> মূল্যায়ন ·{' '}
                <span className="font-mono text-zinc-300">{signalHistory.counts.distinctSetups}</span> স্বতন্ত্র সেটআপ
              </span>
            )}
          </CardTitle>
          <p className="text-xs text-zinc-500">
            মূল্যায়ন-সংখ্যা ≠ স্বতন্ত্র সেটআপ-সংখ্যা — একই লজিক্যাল সেটআপ বারবার মূল্যায়ন হতে পারে (10.3-A dedup)। আঙ্গুলছাপ-নেই সারি = legacy/অ-শনাক্ত।
          </p>
        </CardHeader>
        <CardContent>
          {historyError ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-zinc-400" role="alert">
              মূল্যায়ন-ইতিহাস API অনুপলব্ধ — <span className="font-mono text-red-300">{historyError}</span>। এটি খালি-ইতিহাস নয় (fail-closed)।
            </p>
          ) : !signalHistory ? (
            <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500">
              মূল্যায়ন-ইতিহাস এখন লোড করা যায়নি (সৎ খালি)।
            </p>
          ) : signalHistory.history.length === 0 ? (
            <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500">
              এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি — শিডিউল্ড সিঙ্কের পর ইঞ্জিন স্বয়ংক্রিয়ভাবে মূল্যায়ন করবে।
            </p>
          ) : (
            <div className="custom-scrollbar max-h-72 space-y-1.5 overflow-y-auto pr-1" role="region" aria-label="সাম্প্রতিক মূল্যায়ন তালিকা">
              {signalHistory.history.map((h) => (
                <div key={h.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                  <span className="text-zinc-400">{fmtDhaka(h.createdAt)}</span>
                  <Badge variant="outline" className={signalOutcomeBadgeClass(h.outcome)}>
                    {signalOutcomeBn[h.outcome] ?? h.outcome}
                  </Badge>
                  {h.reasonCodes.length > 0 && (
                    <span className="break-all font-mono text-[10px] text-zinc-500">{h.reasonCodes.join(', ')}</span>
                  )}
                  {h.setupFingerprint ? (
                    <span className="ml-auto break-all font-mono text-[10px] text-zinc-400" title={h.setupFingerprint}>
                      সেটআপ {h.setupFingerprint.slice(0, 10)}…
                    </span>
                  ) : (
                    <span className="ml-auto text-[10px] text-zinc-400">আঙ্গুলছাপ নেই (legacy/অ-শনাক্ত)</span>
                  )}
                  {h.rulesSnapshot.status === 'not-recorded' && (
                    <span className="text-[10px] text-amber-500/80" title="Not recorded for this evaluation">নিয়ম-রেকর্ড নেই</span>
                  )}
                  {h.rulesSnapshot.status === 'invalid' && (
                    <span className="text-[10px] text-red-400/80" title={`অকার্যকর স্ন্যাপশট: ${h.rulesSnapshot.reason ?? ''}`}>স্ন্যাপশট অকার্যকর</span>
                  )}
                </div>
              ))}
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
    <Card className="border-amber-500/25 bg-zinc-900/40" data-testid="candidate-history-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="pb-3">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-expanded={open}
              aria-controls="candidate-history-content"
              data-testid="candidate-history-toggle"
              className="flex min-h-[44px] w-full flex-wrap items-center gap-2 text-left"
            >
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}
                aria-hidden
              />
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                ক্যান্ডিডেট ইতিহাস
                <Badge variant="outline" className="border-amber-500/50 bg-amber-500/5 text-amber-300">
                  গবেষণা
                </Badge>
              </CardTitle>
              {candidateHistory?.counts && (
                <span className="text-xs font-normal text-zinc-500">
                  মোট <span className="font-mono text-zinc-300">{candidateHistory.counts.totalEvaluations}</span> মূল্যায়ন ·{' '}
                  <span className="font-mono text-zinc-300">{candidateHistory.counts.distinctSetups}</span> স্বতন্ত্র সেটআপ
                </span>
              )}
            </button>
          </CollapsibleTrigger>
          <p className="text-xs text-zinc-500">
            শুধুমাত্র গবেষণা ক্যান্ডিডেট কৌশলের (<span className="font-mono">{strategyVersion}</span>) append-only মূল্যায়ন — উপরের
            বেসলাইন ইতিহাসের থেকে সম্পূর্ণ আলাদা। ক্যান্ডিডেট কখনো ট্রেড করে না।
          </p>
          {candidateHistory?.outcomeCounts && Object.keys(candidateHistory.outcomeCounts).length > 0 && (
            <span className="flex flex-wrap gap-1.5">
              {Object.entries(candidateHistory.outcomeCounts).map(([k, v]) => (
                <Badge key={k} variant="outline" className={`text-[10px] ${signalOutcomeBadgeClass(k)}`}>
                  {signalOutcomeBn[k]?.split(' ')[0] ?? k}: {v}
                </Badge>
              ))}
            </span>
          )}
        </CardHeader>
        <CollapsibleContent id="candidate-history-content">
          <CardContent>
            {error ? (
              <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-zinc-400" role="alert">
                ক্যান্ডিডেট-ইতিহাস API অনুপলব্ধ — <span className="font-mono text-red-300">{error}</span>। এটি খালি-ইতিহাস নয় (fail-closed)।
              </p>
            ) : loading && !candidateHistory ? (
              <Skeleton className="h-16 w-full" />
            ) : !candidateHistory ? (
              <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500">
                ক্যান্ডিডেট-ইতিহাস এখন লোড করা যায়নি (সৎ খালি)।
              </p>
            ) : rows.length === 0 ? (
              <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500">
                এখনো কোনো ক্যান্ডিডেট মূল্যায়ন সংরক্ষিত হয়নি — প্রথম মূল্যায়ন পরবর্তী সাইকেলে আসবে।
              </p>
            ) : (
              <div
                className="custom-scrollbar max-h-72 space-y-1.5 overflow-y-auto pr-1"
                role="region"
                aria-label="ক্যান্ডিডেট মূল্যায়ন তালিকা (গবেষণা)"
                data-testid="candidate-history-list"
              >
                {rows.map((h) => (
                  <div
                    key={h.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs"
                    data-testid="candidate-history-row"
                  >
                    <span className="text-zinc-400">{fmtDhaka(h.createdAt)}</span>
                    <Badge variant="outline" className={signalOutcomeBadgeClass(h.outcome)}>
                      {signalOutcomeBn[h.outcome] ?? h.outcome}
                    </Badge>
                    {h.model && (
                      <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300">
                        {candidateModelBn[h.model] ?? `মডেল ${h.model}`}
                      </Badge>
                    )}
                    {h.reasonCodes.length > 0 && (
                      <span className="w-full break-words text-[10px] leading-relaxed text-zinc-500">
                        {h.reasonCodes.map((c) => (
                          <span key={c}>
                            <span className="font-mono text-amber-500/90">{c}</span> — {bnForCode(c)}{' '}
                          </span>
                        ))}
                      </span>
                    )}
                    {h.decisionCandleTimeUtc && (
                      <span className="ml-auto text-[10px] text-zinc-500">সিদ্ধান্ত ক্যান্ডেল: {fmtDhaka(h.decisionCandleTimeUtc)}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
