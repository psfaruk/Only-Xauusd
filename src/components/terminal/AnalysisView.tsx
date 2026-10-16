'use client';

/**
 * XAUUSD AI Trading Agent — Analysis view (UI-02).
 * ----------------------------------------------------------------------------
 * Ported from the former "analysis" + "validation" tabs, sub-tabbed:
 *   · বিশ্লেষণ ইঞ্জিন — deterministic engine runs (structure + indicators),
 *     explicit Run Analysis action (token-guarded POST — honest 503 state),
 *     readiness chips, BLOCKED verdict (never fabricated).
 *   · ভ্যালিডেশন ও ব্যাকটেস্ট — Phase 10 validation, forward-paper protocol
 *     and the latest backtest summary.
 * API-unavailable banners are explicit (F-04 fix).
 */

import { AlertTriangle, Cpu, Loader2, ShieldCheck, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PriceLevelText, PriceQtyText } from './bits';
import {
  alignmentBn,
  analysisStatusBn,
  analysisStatusClass,
  bnForCode,
  fmtDhaka,
  fmtInd,
  trendBn,
} from '@/lib/dashboard/i18n';
import type {
  AnalysisLatestResponse,
  BacktestLatestResponse,
  SignalHistoryResponse,
  ValidationLatestResponse,
  ValidationSegmentView,
} from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

export function AnalysisView({
  analysisLatest,
  analysisError,
  analysisRunning,
  onRunAnalysis,
  validationLatest,
  validationError,
  backtestLatest,
  signalHistory,
  priceSpec,
  loading,
}: {
  analysisLatest: AnalysisLatestResponse | null;
  analysisError: string | null;
  analysisRunning: boolean;
  onRunAnalysis: () => void;
  validationLatest: ValidationLatestResponse | null;
  validationError?: string | null;
  backtestLatest: BacktestLatestResponse | null;
  signalHistory: SignalHistoryResponse | null;
  priceSpec: PriceDisplaySpec;
  loading?: boolean;
}) {
  return (
    <div className="space-y-4">
      <Tabs defaultValue="engine" className="space-y-4">
        <TabsList className="h-auto w-full max-w-full flex-nowrap overflow-x-auto bg-zinc-900/60 p-1">
          <TabsTrigger value="engine" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
            বিশ্লেষণ ইঞ্জিন
          </TabsTrigger>
          <TabsTrigger value="validation" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
            ভ্যালিডেশন ও ব্যাকটেস্ট
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------- Sub-tab: engine */}
        <TabsContent value="engine" className="space-y-4">
          {analysisError && (
            <div role="alert" className="flex flex-col gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden />
                <div>
                  <p className="text-sm font-semibold text-red-200">বিশ্লেষণ পরিষেবা এখন অনুপলব্ধ</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{bnForCode(analysisError)}</p>
                </div>
              </div>
              <Badge variant="outline" className="w-fit shrink-0 border-zinc-600/50 bg-zinc-700/20 font-mono text-zinc-400">
                {analysisError}
              </Badge>
            </div>
          )}

          <Card className="border-zinc-800 bg-zinc-900/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <Cpu className="h-4 w-4 text-amber-400" aria-hidden /> ডিটারমিনিস্টিক বিশ্লেষণ ইঞ্জিন
                {analysisLatest?.latest ? (
                  <Badge variant="outline" className={analysisStatusClass[analysisLatest.latest.status] ?? ''}>
                    {analysisStatusBn[analysisLatest.latest.status] ?? analysisLatest.latest.status}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-zinc-600/50 bg-zinc-700/20 font-mono text-[10px] text-zinc-400">
                    এখনো কোনো রান নেই
                  </Badge>
                )}
              </CardTitle>
              <p className="text-xs text-zinc-500">
                কাঠামো (সুইং, HH/HL/LH/LL, BOS/CHoCH — ক্লোজ-নিশ্চিত) + সূচক (EMA 20/50/200, RSI 14, ATR 14, ADX 14 — Wilder)।
                এটি <span className="text-amber-300">কেবল প্রযুক্তিগত বিশ্লেষণ — কোনো ট্রেড সিগন্যাল বা সুপরিশ নয়</span>।
                চার্ট ভিউতে একই ইঞ্জিনের লাইভ গণনা দেখা যায়।
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {analysisLatest?.latest ? (
                <>
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
                    {([
                      ['ইঞ্জিন', `v${analysisLatest.latest.engineVersion}`],
                      ['সিম্বল', analysisLatest.latest.symbol],
                      ['রানের সময় (ঢাকা)', fmtDhaka(analysisLatest.latest.startedAtUtc)],
                      ['সময়কাল', analysisLatest.latest.durationMs != null ? `${analysisLatest.latest.durationMs}ms` : '—'],
                      ['ফিঙ্গারপ্রিন্ট', analysisLatest.latest.inputFingerprint ? `${analysisLatest.latest.inputFingerprint.slice(0, 12)}…` : '—'],
                      ['টাইমফ্রেম', analysisLatest.latest.timeframes.join('/') || '—'],
                    ] as Array<[string, string]>).map(([k, v]) => (
                      <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                        <p className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</p>
                        <p className="mt-0.5 truncate font-mono text-zinc-200">{v}</p>
                      </div>
                    ))}
                  </div>
                  {analysisLatest.latest.reasonCodes.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {analysisLatest.latest.reasonCodes.map((c) => (
                        <Badge key={c} variant="outline" className="border-red-500/40 bg-red-500/10 font-mono text-[10px] text-red-300">
                          {c}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {analysisLatest.latest.analysis?.status === 'FAILED' && analysisLatest.latest.analysis.failureMessage && (
                    <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-2 font-mono text-[11px] text-red-300">
                      {analysisLatest.latest.analysis.failureMessage}
                    </p>
                  )}
                </>
              ) : (
                !analysisError && (
                  <p className="text-xs text-zinc-500">
                    এখনো কোনো বিশ্লেষণ রান সংরক্ষিত হয়নি — নিচের বাটন দিয়ে চালান, অথবা চার্ট ভিউতে ইঞ্জিনের লাইভ গণনা দেখুন।
                  </p>
                )
              )}

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <Button onClick={onRunAnalysis} disabled={analysisRunning} className="gap-2">
                  {analysisRunning ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> চলছে…
                    </>
                  ) : (
                    <>
                      <Cpu className="h-4 w-4" aria-hidden /> বিশ্লেষণ চালান
                    </>
                  )}
                </Button>
                <p className="text-[11px] leading-relaxed text-zinc-600">
                  POST /api/analysis/run — সবসময় টোকেন দাবি করে (fail-closed)। ডেটা অবিশ্বস্ত হলে ফলাফল BLOCKED হবে, কখনো বানানো হবে না।
                </p>
              </div>
            </CardContent>
          </Card>

          {analysisLatest?.latest?.analysis?.status === 'BLOCKED' && (
            <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
              <p className="text-sm font-semibold text-amber-200">বিশ্লেষণ বন্ধ (BLOCKED) — সৎ ফলাফল</p>
              <ul className="mt-2 space-y-1 text-xs leading-relaxed text-zinc-300">
                {analysisLatest.latest.analysis.reasonCodes.map((c) => (
                  <li key={c} className="flex gap-2">
                    <span className="font-mono text-[10px] text-amber-300/80">{c}</span>
                    <span>{bnForCode(c)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-zinc-500">কোনো কাঠামো বা সূচক বানানো হয়নি — ডেটা গেট fail-closed।</p>
            </div>
          )}

          {analysisLatest?.latest?.analysis && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {analysisLatest.latest.analysis.readiness.map((r) => (
                <Card key={r.timeframe} className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <span className="font-mono">{r.timeframe}</span>
                      <Badge variant="outline" className={r.state === 'READY' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-red-500/40 bg-red-500/10 text-red-300'}>
                        {r.state === 'READY' ? 'প্রস্তুত' : 'বন্ধ'}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">বন্ধ ক্যান্ডেল</span>
                      <span className="font-mono text-zinc-200">{r.closedCandles}/{r.requiredMinBars}</span>
                    </div>
                    {r.errorCodes.slice(0, 3).map((c) => (
                      <p key={c} className="font-mono text-[10px] text-red-300/90">{c}</p>
                    ))}
                    {r.warnings.slice(0, 2).map((w) => (
                      <p key={w} className="font-mono text-[10px] text-amber-300/80">{w}</p>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {analysisLatest?.latest?.analysis?.status === 'COMPLETED' && analysisLatest.latest.analysis.perTimeframe && (
            <>
              {analysisLatest.latest.analysis.timeframeContext && (
                <div className="flex flex-col gap-2 rounded-xl border border-zinc-700/60 bg-zinc-900/60 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-zinc-100">
                      মাল্টি-টাইমফ্রেম প্রসঙ্গ — {alignmentBn[analysisLatest.latest.analysis.timeframeContext.alignment] ?? analysisLatest.latest.analysis.timeframeContext.alignment}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-400">{analysisLatest.latest.analysis.timeframeContext.note}</p>
                    <p className="mt-1 text-[11px] text-zinc-600">বর্ণনামূলক পর্যবেক্ষণ মাত্র — কোনো সিগন্যাল নয় (descriptive-only-not-a-signal)।</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(analysisLatest.latest.analysis.timeframeContext.trendByTimeframe ?? {}).map(([tf, t]) => (
                      <Badge key={tf} variant="outline" className="font-mono text-[10px] text-zinc-400">
                        {tf}: {String(t)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {Object.values(analysisLatest.latest.analysis.perTimeframe).map((a) => (
                  <Card key={a.timeframe} className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                        <span className="font-mono">{a.timeframe}</span> কাঠামো
                        <Badge variant="outline" className={
                          a.structure.trend === 'bullish'
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                            : a.structure.trend === 'bearish'
                              ? 'border-red-500/40 bg-red-500/10 text-red-300'
                              : 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400'
                        }>
                          {trendBn[a.structure.trend] ?? a.structure.trend}
                        </Badge>
                        <Badge variant="outline" className="font-mono text-[10px] text-zinc-400">{a.structure.highLabel}</Badge>
                        <Badge variant="outline" className="font-mono text-[10px] text-zinc-400">{a.structure.lowLabel}</Badge>
                      </CardTitle>
                      <p className="text-xs text-zinc-500">
                        {a.candleCount}টি বন্ধ ক্যান্ডেল · সোর্স {a.source} · সুইং উইন্ডো {analysisLatest.latest?.analysis?.calculationConfig.swingLeft}/{analysisLatest.latest?.analysis?.calculationConfig.swingRight}
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3 text-xs">
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                        {([
                          ['EMA20', fmtInd(a.indicators.ema20?.last?.value)],
                          ['EMA50', fmtInd(a.indicators.ema50?.last?.value)],
                          ['EMA200', fmtInd(a.indicators.ema200?.last?.value)],
                          ['RSI14', fmtInd(a.indicators.rsi14?.last?.value, 1)],
                          ['ATR14', fmtInd(a.indicators.atr14?.last?.value)],
                          ['ADX14', fmtInd(a.indicators.adx14?.last?.value, 1)],
                        ] as Array<[string, string]>).map(([k, v]) => (
                          <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-center">
                            <p className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</p>
                            <p className="mt-0.5 font-mono text-sm text-amber-200">{v}</p>
                          </div>
                        ))}
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex justify-between border-b border-zinc-800/60 pb-1.5">
                          <span className="text-zinc-500">নিশ্চিত সুইং</span>
                          <span className="font-mono text-zinc-200">{a.structure.confirmedSwings.length}</span>
                        </div>
                        <div className="flex justify-between border-b border-zinc-800/60 pb-1.5">
                          <span className="text-zinc-500">BOS/CHoCH ইভেন্ট</span>
                          <span className="font-mono text-zinc-200">{a.structure.events.length}</span>
                        </div>
                        <div className="flex justify-between border-b border-zinc-800/60 pb-1.5">
                          <span className="text-zinc-500">অ-নিশ্চিত উইক-ক্রসিং</span>
                          <span className="font-mono text-zinc-200">{a.structure.unconfirmedCrossings.length}</span>
                        </div>
                        {a.structure.events.length > 0 && (
                          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                            <p className="text-[10px] uppercase tracking-wide text-zinc-500">সর্বশেষ ইভেন্ট</p>
                            {(() => {
                              const e = a.structure.events[a.structure.events.length - 1];
                              return (
                                <p className="mt-1 font-mono text-[11px] leading-relaxed text-zinc-300">
                                  {e.type} · {e.direction} · স্তর <PriceLevelText value={e.level ?? e.levelText} spec={priceSpec} /> · ক্লোজ-নিশ্চিত ({e.basis}) ·{' '}
                                  {fmtDhaka(new Date(e.confirmedAtUtcSec * 1000).toISOString())}
                                </p>
                              );
                            })()}
                          </div>
                        )}
                        {a.indicatorIssues.length > 0 && (
                          <p className="font-mono text-[10px] text-red-300/90">{a.indicatorIssues.join(' · ')}</p>
                        )}
                        {a.warnings.length > 0 && (
                          <p className="font-mono text-[10px] text-amber-300/80">{a.warnings.join(' · ')}</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}
        </TabsContent>

        {/* ------------------------------------------------- Sub-tab: validation */}
        <TabsContent value="validation" className="space-y-4">
          <div role="note" className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
            <p className="text-xs leading-relaxed text-zinc-400">
              এটি <span className="font-semibold text-amber-300">Phase 10 কৌশল-ভ্যালিডেশন</span> — যাচাইকৃত ব্রোকার ক্যান্ডেলের ওপর সিমুলেশন, লাভজনকতার প্রমাণ কখনোই নয়। সিদ্ধান্ত নির্ধারিত নিয়মে (pre-registered) — পর্যাপ্ত OOS নমুনা না থাকলে <span className="font-semibold text-amber-300">INCONCLUSIVE</span>।
            </p>
          </div>

          {validationError ? (
            <Card className="border-red-500/40 bg-red-500/5">
              <CardContent className="p-6">
                <p className="text-sm text-zinc-300" role="alert">
                  ভ্যালিডেশন API এখন অনুপলব্ধ — <span className="font-mono text-red-300">{validationError}</span>। সংরক্ষিত রান নেই এমন অবস্থা থেকে এটি আলাদা (fail-closed)।
                </p>
              </CardContent>
            </Card>
          ) : !validationLatest?.validation ? (
            <Card className="border-zinc-800 bg-zinc-900/40">
              <CardContent className="p-6">
                <p className="text-sm text-zinc-400">
                  এখনো কোনো ভ্যালিডেশন রান সংরক্ষিত হয়নি — সৎ খালি অবস্থা। রান তৈরি হলে এখানে dev / validation / OOS ফলাফল আলাদাভাবে দেখা যাবে।
                </p>
              </CardContent>
            </Card>
          ) : (
            <ValidationBody
              v={validationLatest.validation}
              signalHistory={signalHistory}
              backtestLatest={backtestLatest}
              priceSpec={priceSpec}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation body (ported verbatim; separated for readability)
// ---------------------------------------------------------------------------

function ValidationBody({
  v,
  signalHistory,
  backtestLatest,
  priceSpec,
}: {
  v: NonNullable<ValidationLatestResponse['validation']>;
  signalHistory: SignalHistoryResponse | null;
  backtestLatest: BacktestLatestResponse | null;
  priceSpec: PriceDisplaySpec;
}) {
  const r = v.result;
  const segLabel: Record<'dev' | 'val' | 'oos', string> = { dev: 'Development (৫০%)', val: 'Validation (২০%)', oos: 'Out-of-Sample (৩০%) — অছুঁয়া' };
  const segBn: Record<'dev' | 'val' | 'oos', string> = { dev: 'ডেভেলপমেন্ট', val: 'ভ্যালিডেশন', oos: 'আউট-অব-স্যাম্পল' };
  const conclusionClass =
    r.interpretation.conclusion === 'NEGATIVE_AFTER_COSTS'
      ? 'border-red-500/40 bg-red-500/10 text-red-300'
      : r.interpretation.conclusion === 'PROMISING_CONTINUE_FORWARD'
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  const pnlClass = (x: number | null | undefined) => (x === null || x === undefined ? 'text-zinc-500' : x < 0 ? 'text-red-400' : 'text-zinc-200');

  return (
    <>
      <Card className="border-zinc-800 bg-zinc-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            সামগ্রিক সিদ্ধান্ত (নির্ধারিত নিয়মে)
            <Badge variant="outline" className={conclusionClass}>{r.interpretation.conclusion}</Badge>
            <Badge variant="outline" className="ml-auto border-zinc-700 bg-zinc-900 font-mono text-[10px] text-zinc-400">
              {v.harnessVersion}
            </Badge>
          </CardTitle>
          <p className="text-xs text-zinc-500">
            রান: {fmtDhaka(v.createdAt)} · কৌশল <span className="font-mono">{v.strategyVersion}</span> · সময় {v.durationMs}ms
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="space-y-1">
            {r.interpretation.reasons.map((reason, i) => (
              <li key={i} className="text-xs leading-relaxed text-zinc-400">· {reason}</li>
            ))}
          </ul>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <p className="text-xs text-zinc-500">ডেটাসেট ফিঙ্গারপ্রিন্ট</p>
              <p className="mt-1 break-all font-mono text-xs text-zinc-300">{r.datasetFingerprint.slice(0, 20)}…</p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <p className="text-xs text-zinc-500">কভারেজ (M15)</p>
              <p className="mt-1 text-sm text-zinc-200">{fmtDhaka(new Date(r.dataset.fromUtcSec * 1000).toISOString())}</p>
              <p className="text-xs text-zinc-600">→ {fmtDhaka(new Date(r.dataset.toUtcSec * 1000).toISOString())}</p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <p className="text-xs text-zinc-500">ক্যান্ডেল (M15/H1/H4)</p>
              <p className="mt-1 font-mono text-sm text-zinc-200">{r.dataset.executionCandles} / {r.dataset.h1Candles} / {r.dataset.h4Candles}</p>
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-xs text-zinc-500">স্প্রেড অনুমান</p>
              <p className="mt-1 font-mono text-sm text-amber-300">
                <PriceQtyText value={r.dataset.observedSpreadPrice} spec={priceSpec} />
              </p>
              <p className="text-xs text-zinc-600">বর্তমান পর্যবেক্ষণ — ঐতিহাসিক নয়</p>
            </div>
          </div>
          <p className="text-xs text-zinc-500">
            কাউন্টার: মূল্যায়ন {r.counters.evaluations} · ব্লকড {r.counters.blockedEvaluations} · NO_SETUP {r.counters.noSetup} · WAIT {r.counters.wait} · ক্যান্ডিডেট {r.counters.candidateSetups} · ভ্যালিড সেটআপ {r.counters.validSetups} · ফিল {r.counters.hypotheticalFills} · সম্পন্ন {r.counters.completedOutcomes}
          </p>
        </CardContent>
      </Card>

      {/* Three segments */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {(['dev', 'val', 'oos'] as const).map((key) => {
          const m = r.segments[key];
          return (
            <Card key={key} className="border-zinc-800 bg-zinc-900/40">
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                  {segBn[key]}
                  {m.status === 'INSUFFICIENT_DATA' ? (
                    <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300">INSUFFICIENT_DATA</Badge>
                  ) : (
                    <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-400">{m.trades} ট্রেড</Badge>
                  )}
                </CardTitle>
                <p className="text-xs text-zinc-500">{segLabel[key]}</p>
              </CardHeader>
              <CardContent>
                {m.status === 'INSUFFICIENT_DATA' ? (
                  <p className="text-xs leading-relaxed text-zinc-400">{m.reason ?? 'নমুনা অপর্যাপ্ত — মেট্রিক বানানো হয়নি।'}</p>
                ) : (
                  <dl className="space-y-1.5 text-xs">
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">কভারেজ</dt><dd className="text-zinc-300">{m.candles} বার</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">উইন-রেট</dt><dd className="text-zinc-200">{fmtInd(m.winRate !== null ? m.winRate * 100 : null, 1)}%</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">গ্রস (খরচ-পূর্ব)</dt><dd className={pnlClass(m.grossPnlPrice)}><PriceQtyText value={m.grossPnlPrice} spec={priceSpec} /></dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">মডেলড খরচ</dt><dd className="text-zinc-400">−<PriceQtyText value={m.costsPrice} spec={priceSpec} /></dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">নেট (খরচ-পর)</dt><dd className={pnlClass(m.netPnlPrice)}><PriceQtyText value={m.netPnlPrice} spec={priceSpec} /></dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">প্রফিট ফ্যাক্টর</dt><dd className="text-zinc-200">{fmtInd(m.profitFactor, 2)}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">এক্সপেক্ট্যান্সি / ট্রেড</dt><dd className={pnlClass(m.expectancyPrice)}><PriceQtyText value={m.expectancyPrice} spec={priceSpec} /></dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">গড় R</dt><dd className={pnlClass(m.expectancyR)}>{fmtInd(m.expectancyR, 3)}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">সর্বোচ্চ ড্রডাউন</dt><dd className="text-red-400"><PriceQtyText value={m.maxDrawdownPrice} spec={priceSpec} /></dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">সর্বোচ্চ পরপর লস</dt><dd className="text-red-400">{m.maxConsecutiveLosses}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">এক্সপোজার</dt><dd className="text-zinc-200">{fmtInd(m.exposurePct, 1)}%</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">ট্রেড / সপ্তাহ</dt><dd className="text-zinc-200">{fmtInd(m.tradesPerWeek, 2)}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-zinc-500">টপ-১ লাভের অংশ</dt><dd className="text-zinc-200">{fmtInd(m.concentration.top1GrossShare !== null ? m.concentration.top1GrossShare * 100 : null, 1)}%</dd></div>
                  </dl>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Walk-forward */}
      <Card className="border-zinc-800 bg-zinc-900/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">ওয়াক-ফরোয়ার্ড — ক্রমিক সময়-উইন্ডো</CardTitle>
          <p className="text-xs leading-relaxed text-zinc-500">{r.walkForward.note}</p>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="custom-scrollbar max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {r.walkForward.windows.map((w) => (
              <div key={w.index} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                <span className="font-mono text-zinc-500">w{w.index}</span>
                <span className="text-zinc-400">{fmtDhaka(new Date(w.fromUtcSec * 1000).toISOString())} → {fmtDhaka(new Date(w.toUtcSec * 1000).toISOString())}</span>
                <span className="text-zinc-600">{w.candles} বার</span>
                {w.metrics.status === 'COMPUTED' ? (
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    <span className="text-zinc-300">{w.metrics.trades} ট্রেড</span>
                    <span className={pnlClass(w.metrics.netPnlPrice)}>নেট <PriceQtyText value={w.metrics.netPnlPrice} spec={priceSpec} /></span>
                    <span className="text-zinc-400">PF {fmtInd(w.metrics.profitFactor, 2)}</span>
                  </span>
                ) : (
                  <span className="ml-auto text-amber-400">INSUFFICIENT_DATA ({w.metrics.trades})</span>
                )}
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs">
            <span className="text-zinc-400">সমষ্টি: </span>
            {r.walkForward.aggregate.status === 'COMPUTED' ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-300">{r.walkForward.aggregate.trades} ট্রেড</span>
                <span className={pnlClass(r.walkForward.aggregate.netPnlPrice)}>নেট <PriceQtyText value={r.walkForward.aggregate.netPnlPrice} spec={priceSpec} /></span>
                <span className="text-zinc-400">PF {fmtInd(r.walkForward.aggregate.profitFactor, 2)}</span>
              </span>
            ) : (
              <span className="text-amber-400">INSUFFICIENT_DATA — {r.walkForward.aggregate.reason}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Sensitivity + Perturbations */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="border-zinc-800 bg-zinc-900/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">খরচ-সংবেদনশীলতা (একই ট্রেড-তালিকা)</CardTitle>
            <p className="text-xs text-zinc-500">স্প্রেড বাড়ালে ফল কখনো ভালো হয় না — সীমানা পরীক্ষা, পূর্বাভাস নয়।</p>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {r.sensitivity.map((s) => (
                <div key={s.scenario} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                  <span className="font-mono text-zinc-400">{s.scenario}</span>
                  <span className="text-zinc-600">spr <PriceQtyText value={s.spreadPrice} spec={priceSpec} /> / slip <PriceQtyText value={s.slippagePrice} spec={priceSpec} /> / comm <PriceQtyText value={s.commissionPrice} spec={priceSpec} /></span>
                  <span className="ml-auto flex items-center gap-2">
                    <span className={pnlClass(s.netPnlPrice)}>নেট <PriceQtyText value={s.netPnlPrice} spec={priceSpec} /></span>
                    <span className="text-zinc-400">PF {fmtInd(s.profitFactor, 2)}</span>
                    {!s.netPositive && <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-300">ঋণাত্মক</Badge>}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-zinc-900/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">প্যারামিটার পার্টার্বেশন — পূর্ণ সেট</CardTitle>
            <p className="text-xs text-zinc-500">কোনো ভ্যারিয়েন্ট বাছাই করা হয়নি; প্রোডাকশন কনফিগ অপরিবর্তিত।</p>
          </CardHeader>
          <CardContent>
            <div className="custom-scrollbar max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {r.perturbations.map((p, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                  <span className="font-mono text-zinc-400">{p.param === '(baseline)' ? '(বেসলাইন)' : `${p.param}`}</span>
                  {p.param !== '(baseline)' && <span className="font-mono text-zinc-500">= {p.value}</span>}
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-zinc-300">{p.trades} ট্রেড</span>
                    <span className={pnlClass(p.netPnlPrice)}>নেট <PriceQtyText value={p.netPnlPrice} spec={priceSpec} /></span>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Paper signals */}
      <Card className="border-zinc-800 bg-zinc-900/40">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            ফরোয়ার্ড পেপার-সিগন্যাল ট্র্যাকিং
            <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-400">read-only</Badge>
          </CardTitle>
          <p className="text-xs text-zinc-500">SETUP সিগন্যালের পরে দাম আসলে কী করেছে — ব্রোকার অর্ডার কোথাও নেই (ক্ষমতাই নেই)। প্রতি সিগন্যালে ঠিক একটি ফলাফল।</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
              <p className="text-[11px] text-zinc-500">মোট মূল্যায়ন (সব ফলাফল)</p>
              <p className="mt-0.5 text-sm font-semibold text-zinc-200">{signalHistory?.counts ? signalHistory.counts.totalEvaluations : '—'}</p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
              <p className="text-[11px] text-zinc-500">স্বতন্ত্র লজিক্যাল সেটআপ</p>
              <p className="mt-0.5 text-sm font-semibold text-zinc-200">{signalHistory?.counts ? signalHistory.counts.distinctSetups : '—'}</p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
              <p className="text-[11px] text-zinc-500">পেপার-ফলাফল সারি</p>
              <p className="mt-0.5 text-sm font-semibold text-zinc-200">{v.paper.total}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {[
              { label: 'মোট', value: String(v.paper.total) },
              { label: 'খোলা', value: String(v.paper.open) },
              { label: 'স্টপড', value: String(v.paper.resolved.stopped) },
              { label: 'টার্গেটেড', value: String(v.paper.resolved.targeted) },
              { label: 'ইনভ্যালিডেড', value: String(v.paper.resolved.invalidated) },
              { label: 'এক্সপায়ার্ড', value: String(v.paper.resolved.expired) },
              { label: 'গড় R', value: v.paper.avgR !== null ? fmtInd(v.paper.avgR, 3) : '—' },
            ].map((cell) => (
              <div key={cell.label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
                <p className="text-[11px] text-zinc-500">{cell.label}</p>
                <p className="mt-0.5 text-sm font-semibold text-zinc-200">{cell.value}</p>
              </div>
            ))}
          </div>
          {v.paper.outcomes.length === 0 ? (
            <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400">
              এখনো কোনো SETUP সিগন্যাল হয়নি — ট্র্যাক করার কিছু নেই (সৎ খালি)।
            </p>
          ) : (
            <div className="custom-scrollbar max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {v.paper.outcomes.map((o) => (
                <div key={o.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                  <Badge variant="outline" className={o.direction === 'BUY' ? 'border-emerald-500/40 text-emerald-300' : 'border-red-500/40 text-red-300'}>{o.direction}</Badge>
                  <span className="text-zinc-400">{fmtDhaka(o.signalCreatedAtUtc)}</span>
                  <span className="font-mono text-zinc-500">এন্ট্রি <PriceLevelText value={o.entryReference} spec={priceSpec} /></span>
                  {o.outcome && <Badge variant="outline" className="border-zinc-700 text-zinc-300">{o.outcome}</Badge>}
                  {o.rMultiple !== null && <span className={pnlClass(o.rMultiple)}>R {fmtInd(o.rMultiple, 2)}</span>}
                  <span className="ml-auto text-zinc-600">{o.observations} বার দেখা</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Forward paper validation (Phase 10.2) */}
      {(() => {
        const fp = v.forwardPaper;
        const fpPnl = (x: number | null | undefined) =>
          x === null || x === undefined ? 'text-zinc-500' : x < 0 ? 'text-red-400' : 'text-zinc-200';
        const verdictBadge =
          fp.verdict.conclusion === 'NEGATIVE_AFTER_COSTS'
            ? 'border-red-500/40 bg-red-500/10 text-red-300'
            : fp.verdict.conclusion === 'PROMISING_CONTINUE_FORWARD'
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              : 'border-zinc-600 bg-zinc-800/60 text-zinc-300';
        const verdictBn: Record<string, string> = {
          IN_PROGRESS: 'পর্যবেক্ষণ চলছে',
          INCONCLUSIVE_TIMEOUT: 'সময়সীমা শেষ — অনির্ণীত',
          NEGATIVE_AFTER_COSTS: 'ঋণাত্মক (খরচ-পরবর্তী)',
          INCONCLUSIVE_CONCENTRATION: 'অনির্ণীত — ঘনত্ব বেশি',
          INCONCLUSIVE_DRAWDOWN: 'অনির্ণীত — ঝুঁকি সীমার বাইরে',
          PROMISING_CONTINUE_FORWARD: 'সামনে এগোনোর প্রমাণ (দাবি নয়)',
        };
        return (
          <Card className="border-zinc-800 bg-zinc-900/40">
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                ফরোয়ার্ড পেপার ভ্যালিডেশন — Phase 10.2
                <Badge variant="outline" className={verdictBadge}>{verdictBn[fp.verdict.conclusion] ?? fp.verdict.conclusion}</Badge>
                <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-500">প্রি-রেজিস্টার্ড</Badge>
              </CardTitle>
              <p className="text-xs text-zinc-500">
                ফলাফল জমার <span className="text-amber-300">আগেই</span> নিয়ম দৃঢ় করা হয়েছে (first-open গণনা, ২০ ট্রেড ফ্লোর, ৯০ দিন সীমা, ঝুঁকি গেট)।
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  { label: 'সম্পন্ন ট্রেড', value: `${fp.progress.countedCompleted} / ${fp.protocol.minCompletedTrades}` },
                  { label: 'খোলা', value: String(fp.progress.openCounted) },
                  { label: 'পুনরাবৃত্তি (বাদ)', value: String(fp.progress.repeatObservations) },
                  { label: 'অপর্যবেক্ষিত', value: String(fp.progress.unobservableResolved) },
                  { label: 'অতিবাহিত দিন', value: fmtInd(fp.progress.elapsedDays, 1) },
                  { label: 'অবশিষ্ট দিন', value: fmtInd(fp.progress.daysRemaining, 1) },
                ].map((cell) => (
                  <div key={cell.label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
                    <p className="text-[11px] text-zinc-500">{cell.label}</p>
                    <p className="mt-0.5 text-sm font-semibold text-zinc-200">{cell.value}</p>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                <span>সক্রিয়করণ: <span className="font-mono text-zinc-400">{fmtDhaka(fp.protocol.activatedAtUtc)}</span></span>
                <span>সময়সীমা: <span className="font-mono text-zinc-400">{fmtDhaka(fp.protocol.deadlineUtc)}</span></span>
                <span>নিয়ম সংস্করণ: <span className="font-mono text-zinc-400">{fp.protocol.rulesVersion}</span></span>
              </div>
              {fp.metrics && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
                  {[
                    { label: 'n', value: String(fp.metrics.trades) },
                    { label: 'উইন রেট', value: fmtInd(fp.metrics.winRate !== null ? fp.metrics.winRate * 100 : null, 1) + '%' },
                    { label: 'নেট', value: <PriceQtyText key="net" value={fp.metrics.netPnlPrice} spec={priceSpec} />, cls: fpPnl(fp.metrics.netPnlPrice) },
                    { label: 'PF', value: fmtInd(fp.metrics.profitFactor, 2) },
                    { label: 'গড় R', value: fmtInd(fp.metrics.avgR, 3), cls: fpPnl(fp.metrics.avgR) },
                    { label: 'সর্বোচ্চ ড্রডাউন', value: `${fmtInd(fp.metrics.maxDrawdownR, 2)}R` },
                    { label: 'পরপর লস', value: String(fp.metrics.maxConsecutiveLosses) },
                    { label: 'টপ-১ শেয়ার', value: fp.metrics.top1NetShare !== null ? fmtInd(fp.metrics.top1NetShare * 100, 1) + '%' : '—' },
                  ].map((cell) => (
                    <div key={cell.label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
                      <p className="text-[11px] text-zinc-500">{cell.label}</p>
                      <p className={`mt-0.5 text-sm font-semibold ${cell.cls ?? 'text-zinc-200'}`}>{cell.value}</p>
                    </div>
                  ))}
                </div>
              )}
              <ul className="space-y-1">
                {fp.verdict.reasons.map((rr, i) => (
                  <li key={i} className="text-xs leading-relaxed text-zinc-400">· {rr}</li>
                ))}
              </ul>
              {fp.recentTrades.length === 0 ? (
                <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400">
                  এখনো কোনো গণনাকৃত ট্রেড নেই — সৎ খালি অবস্থা।
                </p>
              ) : (
                <div className="custom-scrollbar max-h-64 space-y-1.5 overflow-y-auto pr-1">
                  {fp.recentTrades.map((t) => (
                    <div key={t.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                      <Badge variant="outline" className={t.direction === 'BUY' ? 'border-emerald-500/40 text-emerald-300' : 'border-red-500/40 text-red-300'}>{t.direction}</Badge>
                      <span className="text-zinc-400">{fmtDhaka(t.signalCreatedAtUtc)}</span>
                      <span className="font-mono text-zinc-500">এন্ট্রি <PriceLevelText value={t.entryReference} spec={priceSpec} /></span>
                      {t.status === 'open' ? (
                        <Badge variant="outline" className="border-amber-500/40 text-amber-300">খোলা</Badge>
                      ) : (
                        <>
                          {t.outcome && <Badge variant="outline" className="border-zinc-700 text-zinc-300">{t.outcome}</Badge>}
                          {t.rMultiple !== null && <span className={fpPnl(t.rMultiple)}>R {fmtInd(t.rMultiple, 2)}</span>}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-zinc-600">⚠ {fp.verdict.disclaimer}</p>
            </CardContent>
          </Card>
        );
      })()}

      {/* Latest backtest summary */}
      <Card className="border-zinc-800 bg-zinc-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">সর্বশেষ ব্যাকটেস্ট (সিমুলেশন — লাভের প্রমাণ নয়)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {!backtestLatest?.latest ? (
            <p className="text-zinc-400">এখনো কোনো ব্যাকটেস্ট রান নেই।</p>
          ) : (
            <>
              <p className="text-zinc-300">
                {backtestLatest.latest.timeframe} · {backtestLatest.latest.status} · {backtestLatest.latest.dataset.candleCount} ক্যান্ডেল ·{' '}
                {backtestLatest.latest.dataset.fromUtc.slice(0, 10)} → {backtestLatest.latest.dataset.toUtc.slice(0, 10)}
              </p>
              <p className="text-zinc-500">
                ফিঙ্গারপ্রিন্ট <span className="font-mono text-[10px] text-amber-300/80">{backtestLatest.latest.datasetFingerprint.slice(0, 24)}…</span> · কৌশল {backtestLatest.latest.strategyVersion}
              </p>
              {(['dev', 'oos'] as const).map((seg) => {
                const m = (seg === 'dev' ? backtestLatest.latest!.dev : backtestLatest.latest!.oos) as {
                  status: string; executedTrades?: number; winRate?: number; profitFactor?: number; netPnlPrice?: number; reason?: string;
                };
                return (
                  <p key={seg} className="text-zinc-400">
                    {seg === 'dev' ? 'Dev' : 'Out-of-sample'}:{' '}
                    {m.status === 'INSUFFICIENT_DATA'
                      ? `INSUFFICIENT_DATA — ${m.reason ?? 'পর্যাপ্ত ট্রেড নেই'}`
                      : `${m.executedTrades} ট্রেড · জয়রেট ${m.winRate} · PF ${m.profitFactor} · নিট P&L ${m.netPnlPrice} (মূল্য-একক)`}
                  </p>
                );
              })}
              <p className="text-[10px] text-zinc-500">{backtestLatest.disclaimer}</p>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
