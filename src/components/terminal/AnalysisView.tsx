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
 *
 * UI-03 "Sky Terminal" polish: unified card anatomy (rounded-xl border
 * border-border bg-panel · header row · p-4 body · border-b dividers),
 * token-only status colors, mono/tabular numerals, one reason-code chip
 * pattern, list headers + hoverable rows, skeleton loading states.
 */

import { AlertTriangle, Cpu, FlaskConical, Inbox, Loader2, RotateCw, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { PriceLevelText, PriceQtyText } from './bits';
import {
  alignmentBn,
  analysisStatusBn,
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

/* ---------------------------------------------------------------------------
 * UI-03 shared presentational helpers — token-only, identical pattern in
 * HistoryView so both data views read as one family.
 * ------------------------------------------------------------------------- */

/** Analysis-run status → semantic token palette (label text always
 *  accompanies the color — never color-only). */
const STATUS_BADGE_CLASS: Record<string, string> = {
  completed: 'border-up/40 bg-up/10 text-up',
  blocked: 'border-sun/40 bg-sun/10 text-sun',
  failed: 'border-down/40 bg-down/10 text-down',
  pending: 'border-border-strong bg-muted text-muted-foreground',
};

function statusBadgeClass(status: string): string {
  return STATUS_BADGE_CLASS[status] ?? 'border-border-strong bg-muted text-muted-foreground';
}

/** Trade direction → token palette (BUY up / SELL down, label always shown). */
function directionBadgeClass(direction: string): string {
  return direction === 'BUY' ? 'border-up/40 bg-up/10 text-up' : 'border-down/40 bg-down/10 text-down';
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

/** Centered label/value metric tile (mono + tabular numerals). */
function StatTile({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-2.5 text-center">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground', valueClass)}>{value}</p>
    </div>
  );
}

/** Column-caption row for scrollable lists (decorative legend). */
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

export function AnalysisView({
  analysisLatest,
  analysisError,
  analysisRunning,
  onRunAnalysis,
  validationLatest,
  validationError,
  backtestLatest,
  backtestError,
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
  /** Master-audit fix B-D1: backtest-API outage code — an outage must not
   * read as "এখনো কোনো ব্যাকটেস্ট রান নেই". */
  backtestError?: string | null;
  signalHistory: SignalHistoryResponse | null;
  priceSpec: PriceDisplaySpec;
  loading?: boolean;
}) {
  return (
    <div className="space-y-4">
      <Tabs defaultValue="engine" className="space-y-4">
        <TabsList className="h-auto w-full max-w-full flex-nowrap overflow-x-auto bg-panel p-1">
          <TabsTrigger value="engine" className="min-h-[40px] px-4 data-[state=active]:bg-sun/15 data-[state=active]:text-sun">
            বিশ্লেষণ ইঞ্জিন
          </TabsTrigger>
          <TabsTrigger value="validation" className="min-h-[40px] px-4 data-[state=active]:bg-sun/15 data-[state=active]:text-sun">
            ভ্যালিডেশন ও ব্যাকটেস্ট
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------- Sub-tab: engine */}
        <TabsContent value="engine" className="space-y-4">
          {analysisError && (
            <div role="alert" className="flex flex-col gap-3 rounded-xl border border-down/40 bg-down/10 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-down" aria-hidden />
                <div>
                  <p className="text-sm font-semibold text-down">বিশ্লেষণ পরিষেবা এখন অনুপলব্ধ</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-content">{bnForCode(analysisError)}</p>
                </div>
              </div>
              <div className="flex w-fit shrink-0 items-center gap-2">
                <Badge variant="outline" className="border-border-strong/50 bg-muted font-mono text-content">
                  {analysisError}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-[40px] gap-1.5 border-down/40 text-down hover:bg-down/10 hover:text-down"
                  onClick={onRunAnalysis}
                  disabled={analysisRunning}
                >
                  <RotateCw className={cn('h-3.5 w-3.5', analysisRunning && 'animate-spin')} aria-hidden />
                  পুনরায় চেষ্টা
                </Button>
              </div>
            </div>
          )}

          <Card className="gap-0 border-border bg-panel py-0">
            <div className="border-b border-border px-4 py-3">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                <Cpu className="h-4 w-4 text-sun" aria-hidden /> ডিটারমিনিস্টিক বিশ্লেষণ ইঞ্জিন
                {analysisLatest?.latest ? (
                  <Badge variant="outline" className={cn('text-[11px] font-semibold', statusBadgeClass(analysisLatest.latest.status))}>
                    {analysisStatusBn[analysisLatest.latest.status] ?? analysisLatest.latest.status}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-border-strong bg-muted font-mono text-[10px] text-muted-foreground">
                    এখনো কোনো রান নেই
                  </Badge>
                )}
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                কাঠামো (সুইং, HH/HL/LH/LL, BOS/CHoCH — ক্লোজ-নিশ্চিত) + সূচক (EMA 20/50/200, RSI 14, ATR 14, ADX 14 — Wilder)।
                এটি <span className="text-sun">কেবল প্রযুক্তিগত বিশ্লেষণ — কোনো ট্রেড সিগন্যাল বা সুপরিশ নয়</span>।
                চার্ট ভিউতে একই ইঞ্জিনের লাইভ গণনা দেখা যায়।
              </p>
            </div>
            <CardContent className="space-y-3 p-4">
              {loading && !analysisLatest ? (
                <div className="space-y-3" aria-hidden>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton key={i} className="h-14 w-full" />
                    ))}
                  </div>
                  <Skeleton className="h-8 w-44" />
                </div>
              ) : analysisLatest?.latest ? (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    {([
                      ['ইঞ্জিন', `v${analysisLatest.latest.engineVersion}`],
                      ['সিম্বল', analysisLatest.latest.symbol],
                      ['রানের সময় (ঢাকা)', fmtDhaka(analysisLatest.latest.startedAtUtc)],
                      ['সময়কাল', analysisLatest.latest.durationMs != null ? `${analysisLatest.latest.durationMs}ms` : '—'],
                      ['ফিঙ্গারপ্রিন্ট', analysisLatest.latest.inputFingerprint ? `${analysisLatest.latest.inputFingerprint.slice(0, 12)}…` : '—'],
                      ['টাইমফ্রেম', analysisLatest.latest.timeframes.join('/') || '—'],
                    ] as Array<[string, string]>).map(([k, v]) => (
                      <StatTile key={k} label={k} value={v} />
                    ))}
                  </div>
                  {analysisLatest.latest.reasonCodes.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {analysisLatest.latest.reasonCodes.map((c) => (
                        <ReasonChip key={c} code={c} />
                      ))}
                    </div>
                  )}
                  {analysisLatest.latest.analysis?.status === 'FAILED' && analysisLatest.latest.analysis.failureMessage && (
                    <p className="rounded-lg border border-down/40 bg-down/10 p-2.5 font-mono text-[11px] text-down">
                      {analysisLatest.latest.analysis.failureMessage}
                    </p>
                  )}
                </>
              ) : (
                !analysisError && (
                  <EmptyState>এখনো কোনো বিশ্লেষণ রান সংরক্ষিত হয়নি — নিচের বাটন দিয়ে চালান, অথবা চার্ট ভিউতে ইঞ্জিনের লাইভ গণনা দেখুন।</EmptyState>
                )
              )}

              <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                <Button onClick={onRunAnalysis} disabled={analysisRunning} className="min-h-[40px] gap-2">
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
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  POST /api/analysis/run — সবসময় টোকেন দাবি করে (fail-closed)। ডেটা অবিশ্বস্ত হলে ফলাফল BLOCKED হবে, কখনো বানানো হবে না।
                </p>
              </div>
            </CardContent>
          </Card>

          {analysisLatest?.latest?.analysis?.status === 'BLOCKED' && (
            <div role="alert" className="rounded-xl border border-sun/40 bg-sun/10 p-4">
              <p className="text-sm font-semibold text-sun">বিশ্লেষণ বন্ধ (BLOCKED) — সৎ ফলাফল</p>
              <ul className="mt-2 space-y-1.5">
                {analysisLatest.latest.analysis.reasonCodes.map((c) => (
                  <li key={c} className="flex flex-wrap items-baseline gap-1.5 text-xs leading-relaxed text-content">
                    <ReasonChip code={c} />
                    <span>{bnForCode(c)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">কোনো কাঠামো বা সূচক বানানো হয়নি — ডেটা গেট fail-closed।</p>
            </div>
          )}

          {analysisLatest?.latest?.analysis && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {analysisLatest.latest.analysis.readiness.map((r) => (
                <Card key={r.timeframe} className="gap-0 border-border bg-panel py-0">
                  <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                    <span className="font-mono text-xs font-semibold text-foreground">{r.timeframe}</span>
                    <Badge variant="outline" className={cn('text-[11px] font-semibold', r.state === 'READY' ? 'border-up/40 bg-up/10 text-up' : 'border-down/40 bg-down/10 text-down')}>
                      {r.state === 'READY' ? 'প্রস্তুত' : 'বন্ধ'}
                    </Badge>
                  </div>
                  <CardContent className="space-y-1.5 p-3 text-xs">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground">বন্ধ ক্যান্ডেল</span>
                      <span className="font-mono tabular-nums text-foreground">{r.closedCandles}/{r.requiredMinBars}</span>
                    </div>
                    {r.errorCodes.slice(0, 3).map((c) => (
                      <p key={c} className="font-mono text-[10px] text-down">{c}</p>
                    ))}
                    {r.warnings.slice(0, 2).map((w) => (
                      <p key={w} className="font-mono text-[10px] text-sun">{w}</p>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {analysisLatest?.latest?.analysis?.status === 'COMPLETED' && analysisLatest.latest.analysis.perTimeframe && (
            <>
              {analysisLatest.latest.analysis.timeframeContext && (
                <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      মাল্টি-টাইমফ্রেম প্রসঙ্গ — {alignmentBn[analysisLatest.latest.analysis.timeframeContext.alignment] ?? analysisLatest.latest.analysis.timeframeContext.alignment}
                    </p>
                    <p className="mt-0.5 text-xs text-content">{analysisLatest.latest.analysis.timeframeContext.note}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">বর্ণনামূলক পর্যবেক্ষণ মাত্র — কোনো সিগন্যাল নয় (descriptive-only-not-a-signal)।</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(analysisLatest.latest.analysis.timeframeContext.trendByTimeframe ?? {}).map(([tf, t]) => (
                      <Badge key={tf} variant="outline" className="border-border bg-muted font-mono text-[10px] text-content">
                        {tf}: {String(t)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {Object.values(analysisLatest.latest.analysis.perTimeframe).map((a) => (
                  <Card key={a.timeframe} className="gap-0 border-border bg-panel py-0">
                    <div className="border-b border-border px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <span className="font-mono">{a.timeframe}</span> কাঠামো
                          <Badge variant="outline" className={
                            a.structure.trend === 'bullish'
                              ? 'border-up/40 bg-up/10 text-up'
                              : a.structure.trend === 'bearish'
                                ? 'border-down/40 bg-down/10 text-down'
                                : 'border-border-strong bg-muted text-muted-foreground'
                          }>
                            {trendBn[a.structure.trend] ?? a.structure.trend}
                          </Badge>
                        </h3>
                        <span className="ml-auto flex gap-1.5">
                          <Badge variant="outline" className="border-border bg-muted font-mono text-[10px] text-content">{a.structure.highLabel}</Badge>
                          <Badge variant="outline" className="border-border bg-muted font-mono text-[10px] text-content">{a.structure.lowLabel}</Badge>
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        {a.candleCount}টি বন্ধ ক্যান্ডেল · সোর্স {a.source} · সুইং উইন্ডো {analysisLatest.latest?.analysis?.calculationConfig.swingLeft}/{analysisLatest.latest?.analysis?.calculationConfig.swingRight}
                      </p>
                    </div>
                    <CardContent className="space-y-3 p-4 text-xs">
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                        {([
                          ['EMA20', fmtInd(a.indicators.ema20?.last?.value)],
                          ['EMA50', fmtInd(a.indicators.ema50?.last?.value)],
                          ['EMA200', fmtInd(a.indicators.ema200?.last?.value)],
                          ['RSI14', fmtInd(a.indicators.rsi14?.last?.value, 1)],
                          ['ATR14', fmtInd(a.indicators.atr14?.last?.value)],
                          ['ADX14', fmtInd(a.indicators.adx14?.last?.value, 1)],
                        ] as Array<[string, string]>).map(([k, v]) => (
                          <div key={k} className="rounded-lg border border-border bg-muted p-2 text-center">
                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</p>
                            <p className="mt-0.5 font-mono text-sm tabular-nums text-foreground">{v}</p>
                          </div>
                        ))}
                      </div>
                      <dl className="space-y-0">
                        <div className="flex items-baseline justify-between gap-2 border-b border-border/60 py-1.5">
                          <dt className="text-muted-foreground">নিশ্চিত সুইং</dt>
                          <dd className="font-mono tabular-nums text-foreground">{a.structure.confirmedSwings.length}</dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 border-b border-border/60 py-1.5">
                          <dt className="text-muted-foreground">BOS/CHoCH ইভেন্ট</dt>
                          <dd className="font-mono tabular-nums text-foreground">{a.structure.events.length}</dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 py-1.5">
                          <dt className="text-muted-foreground">অ-নিশ্চিত উইক-ক্রসিং</dt>
                          <dd className="font-mono tabular-nums text-foreground">{a.structure.unconfirmedCrossings.length}</dd>
                        </div>
                      </dl>
                      {a.structure.events.length > 0 && (
                        <div className="rounded-lg border border-border bg-muted p-2.5">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">সর্বশেষ ইভেন্ট</p>
                          {(() => {
                            const e = a.structure.events[a.structure.events.length - 1];
                            return (
                              <p className="mt-1 font-mono text-[11px] leading-relaxed text-content">
                                {e.type} · {e.direction} · স্তর <PriceLevelText value={e.level ?? e.levelText} spec={priceSpec} /> · ক্লোজ-নিশ্চিত ({e.basis}) ·{' '}
                                {fmtDhaka(new Date(e.confirmedAtUtcSec * 1000).toISOString())}
                              </p>
                            );
                          })()}
                        </div>
                      )}
                      {a.indicatorIssues.length > 0 && (
                        <p className="font-mono text-[10px] leading-relaxed text-down">{a.indicatorIssues.join(' · ')}</p>
                      )}
                      {a.warnings.length > 0 && (
                        <p className="font-mono text-[10px] leading-relaxed text-sun">{a.warnings.join(' · ')}</p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}
        </TabsContent>

        {/* ------------------------------------------------- Sub-tab: validation */}
        <TabsContent value="validation" className="space-y-4">
          <div role="note" className="flex items-start gap-3 rounded-xl border border-sun/30 bg-sun/5 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-sun" aria-hidden />
            <p className="text-xs leading-relaxed text-content">
              এটি <span className="font-semibold text-sun">Phase 10 কৌশল-ভ্যালিডেশন</span> — যাচাইকৃত ব্রোকার ক্যান্ডেলের ওপর সিমুলেশন, লাভজনকতার প্রমাণ কখনোই নয়। সিদ্ধান্ত নির্ধারিত নিয়মে (pre-registered) — পর্যাপ্ত OOS নমুনা না থাকলে <span className="font-semibold text-sun">INCONCLUSIVE</span>।
            </p>
          </div>

          {validationError ? (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-down/40 bg-down/10 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-down" aria-hidden />
              <p className="text-sm leading-relaxed text-content">
                ভ্যালিডেশন API এখন অনুপলব্ধ — <span className="font-mono text-down">{validationError}</span>। সংরক্ষিত রান নেই এমন অবস্থা থেকে এটি আলাদা (fail-closed)।
              </p>
            </div>
          ) : !validationLatest?.validation ? (
            <EmptyState>এখনো কোনো ভ্যালিডেশন রান সংরক্ষিত হয়নি — সৎ খালি অবস্থা। রান তৈরি হলে এখানে dev / validation / OOS ফলাফল আলাদাভাবে দেখা যাবে।</EmptyState>
          ) : (
            <ValidationBody
              v={validationLatest.validation}
              signalHistory={signalHistory}
              backtestLatest={backtestLatest}
              backtestError={backtestError}
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
  backtestError,
  priceSpec,
}: {
  v: NonNullable<ValidationLatestResponse['validation']>;
  signalHistory: SignalHistoryResponse | null;
  backtestLatest: BacktestLatestResponse | null;
  /** Master-audit fix B-D1: backtest-API outage code (threaded from
   * AnalysisView so the outage banner renders at the point of consumption). */
  backtestError?: string | null;
  priceSpec: PriceDisplaySpec;
}) {
  const r = v.result;
  const segLabel: Record<'dev' | 'val' | 'oos', string> = { dev: 'Development (৫০%)', val: 'Validation (২০%)', oos: 'Out-of-Sample (৩০%) — অছুঁয়া' };
  const segBn: Record<'dev' | 'val' | 'oos', string> = { dev: 'ডেভেলপমেন্ট', val: 'ভ্যালিডেশন', oos: 'আউট-অব-স্যাম্পল' };
  const conclusionClass =
    r.interpretation.conclusion === 'NEGATIVE_AFTER_COSTS'
      ? 'border-down/40 bg-down/10 text-down'
      : r.interpretation.conclusion === 'PROMISING_CONTINUE_FORWARD'
        ? 'border-up/40 bg-up/10 text-up'
        : 'border-sun/40 bg-sun/10 text-sun';
  const pnlClass = (x: number | null | undefined) => (x === null || x === undefined ? 'text-muted-foreground' : x < 0 ? 'text-down' : 'text-foreground');

  return (
    <>
      <Card className="gap-0 border-border bg-panel py-0">
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              <FlaskConical className="h-4 w-4 text-sun" aria-hidden />
              সামগ্রিক সিদ্ধান্ত (নির্ধারিত নিয়মে)
              <Badge variant="outline" className={cn('text-[11px] font-semibold', conclusionClass)}>{r.interpretation.conclusion}</Badge>
            </h3>
            <Badge variant="outline" className="border-border-strong bg-muted font-mono text-[10px] text-content">
              {v.harnessVersion}
            </Badge>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            রান: <span className="tabular-nums">{fmtDhaka(v.createdAt)}</span> · কৌশল <span className="font-mono">{v.strategyVersion}</span> · সময় <span className="font-mono tabular-nums">{v.durationMs}ms</span>
          </p>
        </div>
        <CardContent className="space-y-3 p-4">
          <ul className="space-y-1">
            {r.interpretation.reasons.map((reason, i) => (
              <li key={i} className="text-xs leading-relaxed text-content">· {reason}</li>
            ))}
          </ul>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border bg-surface p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">ডেটাসেট ফিঙ্গারপ্রিন্ট</p>
              <p className="mt-1 break-all font-mono text-xs text-content">{r.datasetFingerprint.slice(0, 20)}…</p>
            </div>
            <div className="rounded-lg border border-border bg-surface p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">কভারেজ (M15)</p>
              <p className="mt-1 text-sm tabular-nums text-foreground">{fmtDhaka(new Date(r.dataset.fromUtcSec * 1000).toISOString())}</p>
              <p className="text-xs tabular-nums text-muted-foreground">→ {fmtDhaka(new Date(r.dataset.toUtcSec * 1000).toISOString())}</p>
            </div>
            <div className="rounded-lg border border-border bg-surface p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">ক্যান্ডেল (M15/H1/H4)</p>
              <p className="mt-1 font-mono text-sm tabular-nums text-foreground">{r.dataset.executionCandles} / {r.dataset.h1Candles} / {r.dataset.h4Candles}</p>
            </div>
            <div className="rounded-lg border border-sun/30 bg-sun/5 p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">স্প্রেড অনুমান</p>
              <p className="mt-1 font-mono text-sm text-sun">
                <PriceQtyText value={r.dataset.observedSpreadPrice} spec={priceSpec} />
              </p>
              <p className="text-xs text-muted-foreground">বর্তমান পর্যবেক্ষণ — ঐতিহাসিক নয়</p>
            </div>
          </div>
          <p className="text-xs tabular-nums text-muted-foreground">
            কাউন্টার: মূল্যায়ন {r.counters.evaluations} · ব্লকড {r.counters.blockedEvaluations} · NO_SETUP {r.counters.noSetup} · WAIT {r.counters.wait} · ক্যান্ডিডেট {r.counters.candidateSetups} · ভ্যালিড সেটআপ {r.counters.validSetups} · ফিল {r.counters.hypotheticalFills} · সম্পন্ন {r.counters.completedOutcomes}
          </p>
        </CardContent>
      </Card>

      {/* Three segments */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {(['dev', 'val', 'oos'] as const).map((key) => {
          const m = r.segments[key];
          return (
            <Card key={key} className="gap-0 border-border bg-panel py-0">
              <div className="border-b border-border px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{segBn[key]}</h3>
                  {m.status === 'INSUFFICIENT_DATA' ? (
                    <Badge variant="outline" className="border-sun/40 bg-sun/10 text-[11px] font-semibold text-sun">INSUFFICIENT_DATA</Badge>
                  ) : (
                    <Badge variant="outline" className="border-border-strong bg-muted text-[11px] font-semibold text-content">{m.trades} ট্রেড</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{segLabel[key]}</p>
              </div>
              <CardContent className="p-4">
                {m.status === 'INSUFFICIENT_DATA' ? (
                  <p className="text-xs leading-relaxed text-content">{m.reason ?? 'নমুনা অপর্যাপ্ত — মেট্রিক বানানো হয়নি।'}</p>
                ) : (
                  <dl className="space-y-1.5 text-xs">
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">কভারেজ</dt><dd className="font-mono tabular-nums text-content">{m.candles} বার</dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">উইন-রেট</dt><dd className="font-mono tabular-nums text-foreground">{fmtInd(m.winRate !== null ? m.winRate * 100 : null, 1)}%</dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">গ্রস (খরচ-পূর্ব)</dt><dd className={cn('font-mono tabular-nums', pnlClass(m.grossPnlPrice))}><PriceQtyText value={m.grossPnlPrice} spec={priceSpec} /></dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">মডেলড খরচ</dt><dd className="font-mono tabular-nums text-content">−<PriceQtyText value={m.costsPrice} spec={priceSpec} /></dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">নেট (খরচ-পর)</dt><dd className={cn('font-mono tabular-nums', pnlClass(m.netPnlPrice))}><PriceQtyText value={m.netPnlPrice} spec={priceSpec} /></dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">প্রফিট ফ্যাক্টর</dt><dd className="font-mono tabular-nums text-foreground">{fmtInd(m.profitFactor, 2)}</dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">এক্সপেক্ট্যান্সি / ট্রেড</dt><dd className={cn('font-mono tabular-nums', pnlClass(m.expectancyPrice))}><PriceQtyText value={m.expectancyPrice} spec={priceSpec} /></dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">গড় R</dt><dd className={cn('font-mono tabular-nums', pnlClass(m.expectancyR))}>{fmtInd(m.expectancyR, 3)}</dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">সর্বোচ্চ ড্রডাউন</dt><dd className="font-mono tabular-nums text-down"><PriceQtyText value={m.maxDrawdownPrice} spec={priceSpec} /></dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">সর্বোচ্চ পরপর লস</dt><dd className="font-mono tabular-nums text-down">{m.maxConsecutiveLosses}</dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">এক্সপোজার</dt><dd className="font-mono tabular-nums text-foreground">{fmtInd(m.exposurePct, 1)}%</dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">ট্রেড / সপ্তাহ</dt><dd className="font-mono tabular-nums text-foreground">{fmtInd(m.tradesPerWeek, 2)}</dd></div>
                    <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">টপ-১ লাভের অংশ</dt><dd className="font-mono tabular-nums text-foreground">{fmtInd(m.concentration.top1GrossShare !== null ? m.concentration.top1GrossShare * 100 : null, 1)}%</dd></div>
                  </dl>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Walk-forward */}
      <Card className="gap-0 border-border bg-panel py-0">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">ওয়াক-ফরোয়ার্ড — ক্রমিক সময়-উইন্ডো</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{r.walkForward.note}</p>
        </div>
        <CardContent className="space-y-2 p-4">
          <div className="space-y-1.5">
            <ListHeaderRow>
              <span>উইন্ডো</span>
              <span>সময়কাল</span>
              <span>বার</span>
              <span className="ml-auto">ফলাফল</span>
            </ListHeaderRow>
            <div className="custom-scrollbar max-h-96 space-y-1.5 overflow-y-auto pr-1">
              {r.walkForward.windows.map((w) => (
                <div key={w.index} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs transition-colors hover:bg-accent">
                  <span className="font-mono text-muted-foreground">w{w.index}</span>
                  <span className="tabular-nums text-content">{fmtDhaka(new Date(w.fromUtcSec * 1000).toISOString())} → {fmtDhaka(new Date(w.toUtcSec * 1000).toISOString())}</span>
                  <span className="tabular-nums text-muted-foreground">{w.candles} বার</span>
                  {w.metrics.status === 'COMPUTED' ? (
                    <span className="ml-auto flex flex-wrap items-center gap-2">
                      <span className="tabular-nums text-content">{w.metrics.trades} ট্রেড</span>
                      <span className={cn('font-mono tabular-nums', pnlClass(w.metrics.netPnlPrice))}>নেট <PriceQtyText value={w.metrics.netPnlPrice} spec={priceSpec} /></span>
                      <span className="font-mono tabular-nums text-content">PF {fmtInd(w.metrics.profitFactor, 2)}</span>
                    </span>
                  ) : (
                    <span className="ml-auto text-sun">INSUFFICIENT_DATA ({w.metrics.trades})</span>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-muted px-3 py-2 text-xs">
            <span className="text-content">সমষ্টি: </span>
            {r.walkForward.aggregate.status === 'COMPUTED' ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-content">{r.walkForward.aggregate.trades} ট্রেড</span>
                <span className={cn('font-mono tabular-nums', pnlClass(r.walkForward.aggregate.netPnlPrice))}>নেট <PriceQtyText value={r.walkForward.aggregate.netPnlPrice} spec={priceSpec} /></span>
                <span className="font-mono tabular-nums text-content">PF {fmtInd(r.walkForward.aggregate.profitFactor, 2)}</span>
              </span>
            ) : (
              <span className="text-sun">INSUFFICIENT_DATA — {r.walkForward.aggregate.reason}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Sensitivity + Perturbations */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="gap-0 border-border bg-panel py-0">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">খরচ-সংবেদনশীলতা (একই ট্রেড-তালিকা)</h3>
            <p className="mt-1 text-xs text-muted-foreground">স্প্রেড বাড়ালে ফল কখনো ভালো হয় না — সীমানা পরীক্ষা, পূর্বাভাস নয়।</p>
          </div>
          <CardContent className="p-4">
            <div className="space-y-1.5">
              {r.sensitivity.map((s) => (
                <div key={s.scenario} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs transition-colors hover:bg-accent">
                  <span className="font-mono text-content">{s.scenario}</span>
                  <span className="font-mono text-muted-foreground">spr <PriceQtyText value={s.spreadPrice} spec={priceSpec} /> / slip <PriceQtyText value={s.slippagePrice} spec={priceSpec} /> / comm <PriceQtyText value={s.commissionPrice} spec={priceSpec} /></span>
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    <span className={cn('font-mono tabular-nums', pnlClass(s.netPnlPrice))}>নেট <PriceQtyText value={s.netPnlPrice} spec={priceSpec} /></span>
                    <span className="font-mono tabular-nums text-content">PF {fmtInd(s.profitFactor, 2)}</span>
                    {!s.netPositive && <Badge variant="outline" className="border-down/40 bg-down/10 text-[11px] font-semibold text-down">ঋণাত্মক</Badge>}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="gap-0 border-border bg-panel py-0">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">প্যারামিটার পার্টার্বেশন — পূর্ণ সেট</h3>
            <p className="mt-1 text-xs text-muted-foreground">কোনো ভ্যারিয়েন্ট বাছাই করা হয়নি; প্রোডাকশন কনফিগ অপরিবর্তিত।</p>
          </div>
          <CardContent className="p-4">
            <div className="custom-scrollbar max-h-96 space-y-1.5 overflow-y-auto pr-1">
              {r.perturbations.map((p, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs transition-colors hover:bg-accent">
                  <span className="font-mono text-content">{p.param === '(baseline)' ? '(বেসলাইন)' : `${p.param}`}</span>
                  {p.param !== '(baseline)' && <span className="font-mono text-muted-foreground">= {p.value}</span>}
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    <span className="tabular-nums text-content">{p.trades} ট্রেড</span>
                    <span className={cn('font-mono tabular-nums', pnlClass(p.netPnlPrice))}>নেট <PriceQtyText value={p.netPnlPrice} spec={priceSpec} /></span>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Paper signals */}
      <Card className="gap-0 border-border bg-panel py-0">
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              ফরোয়ার্ড পেপার-সিগন্যাল ট্র্যাকিং
              <Badge variant="outline" className="border-border-strong bg-muted text-content">read-only</Badge>
            </h3>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">SETUP সিগন্যালের পরে দাম আসলে কী করেছে — ব্রোকার অর্ডার কোথাও নেই (ক্ষমতাই নেই)। প্রতি সিগন্যালে ঠিক একটি ফলাফল।</p>
        </div>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <StatTile label="মোট মূল্যায়ন (সব ফলাফল)" value={signalHistory?.counts ? signalHistory.counts.totalEvaluations : '—'} />
            <StatTile label="স্বতন্ত্র লজিক্যাল সেটআপ" value={signalHistory?.counts ? signalHistory.counts.distinctSetups : '—'} />
            <StatTile label="পেপার-ফলাফল সারি" value={v.paper.total} />
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
              <StatTile key={cell.label} label={cell.label} value={cell.value} />
            ))}
          </div>
          {v.paper.outcomes.length === 0 ? (
            <EmptyState>এখনো কোনো SETUP সিগন্যাল হয়নি — ট্র্যাক করার কিছু নেই (সৎ খালি)।</EmptyState>
          ) : (
            <div className="space-y-1.5">
              <ListHeaderRow>
                <span>দিক</span>
                <span>সময়</span>
                <span>এন্ট্রি</span>
                <span>ফলাফল</span>
                <span className="ml-auto">R</span>
              </ListHeaderRow>
              <div className="custom-scrollbar max-h-96 space-y-1.5 overflow-y-auto pr-1">
                {v.paper.outcomes.map((o) => (
                  <div key={o.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs transition-colors hover:bg-accent">
                    <Badge variant="outline" className={cn('text-[11px] font-semibold', directionBadgeClass(o.direction))}>{o.direction}</Badge>
                    <span className="tabular-nums text-content">{fmtDhaka(o.signalCreatedAtUtc)}</span>
                    <span className="font-mono text-muted-foreground">এন্ট্রি <PriceLevelText value={o.entryReference} spec={priceSpec} /></span>
                    {o.outcome && <Badge variant="outline" className="border-border-strong bg-muted text-content">{o.outcome}</Badge>}
                    {o.rMultiple !== null && <span className={cn('font-mono tabular-nums', pnlClass(o.rMultiple))}>R {fmtInd(o.rMultiple, 2)}</span>}
                    <span className="ml-auto tabular-nums text-muted-foreground">{o.observations} বার দেখা</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Forward paper validation (Phase 10.2) */}
      {(() => {
        const fp = v.forwardPaper;
        const fpPnl = (x: number | null | undefined) =>
          x === null || x === undefined ? 'text-muted-foreground' : x < 0 ? 'text-down' : 'text-foreground';
        const verdictBadge =
          fp.verdict.conclusion === 'NEGATIVE_AFTER_COSTS'
            ? 'border-down/40 bg-down/10 text-down'
            : fp.verdict.conclusion === 'PROMISING_CONTINUE_FORWARD'
              ? 'border-up/40 bg-up/10 text-up'
              : 'border-border-strong bg-muted text-muted-foreground';
        const verdictBn: Record<string, string> = {
          IN_PROGRESS: 'পর্যবেক্ষণ চলছে',
          INCONCLUSIVE_TIMEOUT: 'সময়সীমা শেষ — অনির্ণীত',
          NEGATIVE_AFTER_COSTS: 'ঋণাত্মক (খরচ-পরবর্তী)',
          INCONCLUSIVE_CONCENTRATION: 'অনির্ণীত — ঘনত্ব বেশি',
          INCONCLUSIVE_DRAWDOWN: 'অনির্ণীত — ঝুঁকি সীমার বাইরে',
          PROMISING_CONTINUE_FORWARD: 'সামনে এগোনোর প্রমাণ (দাবি নয়)',
        };
        return (
          <Card className="gap-0 border-border bg-panel py-0">
            <div className="border-b border-border px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  ফরোয়ার্ড পেপার ভ্যালিডেশন — Phase 10.2
                  <Badge variant="outline" className={cn('text-[11px] font-semibold', verdictBadge)}>{verdictBn[fp.verdict.conclusion] ?? fp.verdict.conclusion}</Badge>
                </h3>
                <Badge variant="outline" className="border-border-strong bg-muted text-muted-foreground">প্রি-রেজিস্টার্ড</Badge>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                ফলাফল জমার <span className="text-sun">আগেই</span> নিয়ম দৃঢ় করা হয়েছে (first-open গণনা, ২০ ট্রেড ফ্লোর, ৯০ দিন সীমা, ঝুঁকি গেট)।
              </p>
            </div>
            <CardContent className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  { label: 'সম্পন্ন ট্রেড', value: `${fp.progress.countedCompleted} / ${fp.protocol.minCompletedTrades}` },
                  { label: 'খোলা', value: String(fp.progress.openCounted) },
                  { label: 'পুনরাবৃত্তি (বাদ)', value: String(fp.progress.repeatObservations) },
                  { label: 'অপর্যবেক্ষিত', value: String(fp.progress.unobservableResolved) },
                  { label: 'অতিবাহিত দিন', value: fmtInd(fp.progress.elapsedDays, 1) },
                  { label: 'অবশিষ্ট দিন', value: fmtInd(fp.progress.daysRemaining, 1) },
                ].map((cell) => (
                  <StatTile key={cell.label} label={cell.label} value={cell.value} />
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                <span>সক্রিয়করণ: <span className="font-mono text-content">{fmtDhaka(fp.protocol.activatedAtUtc)}</span></span>
                <span>সময়সীমা: <span className="font-mono text-content">{fmtDhaka(fp.protocol.deadlineUtc)}</span></span>
                <span>নিয়ম সংস্করণ: <span className="font-mono text-content">{fp.protocol.rulesVersion}</span></span>
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
                    <StatTile key={cell.label} label={cell.label} value={cell.value} valueClass={cell.cls} />
                  ))}
                </div>
              )}
              <ul className="space-y-1">
                {fp.verdict.reasons.map((rr, i) => (
                  <li key={i} className="text-xs leading-relaxed text-content">· {rr}</li>
                ))}
              </ul>
              {fp.recentTrades.length === 0 ? (
                <EmptyState>এখনো কোনো গণনাকৃত ট্রেড নেই — সৎ খালি অবস্থা।</EmptyState>
              ) : (
                <div className="space-y-1.5">
                  <ListHeaderRow>
                    <span>দিক</span>
                    <span>সময়</span>
                    <span>এন্ট্রি</span>
                    <span>ফলাফল</span>
                    <span className="ml-auto">R</span>
                  </ListHeaderRow>
                  <div className="custom-scrollbar max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {fp.recentTrades.map((t) => (
                      <div key={t.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs transition-colors hover:bg-accent">
                        <Badge variant="outline" className={cn('text-[11px] font-semibold', directionBadgeClass(t.direction))}>{t.direction}</Badge>
                        <span className="tabular-nums text-content">{fmtDhaka(t.signalCreatedAtUtc)}</span>
                        <span className="font-mono text-muted-foreground">এন্ট্রি <PriceLevelText value={t.entryReference} spec={priceSpec} /></span>
                        {t.status === 'open' ? (
                          <Badge variant="outline" className="border-sun/40 bg-sun/10 text-[11px] font-semibold text-sun">খোলা</Badge>
                        ) : (
                          <>
                            {t.outcome && <Badge variant="outline" className="border-border-strong bg-muted text-content">{t.outcome}</Badge>}
                            {t.rMultiple !== null && <span className={cn('font-mono tabular-nums', fpPnl(t.rMultiple))}>R {fmtInd(t.rMultiple, 2)}</span>}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">⚠ {fp.verdict.disclaimer}</p>
            </CardContent>
          </Card>
        );
      })()}

      {/* Latest backtest summary */}
      <Card className="gap-0 border-border bg-panel py-0">
        <div className="border-b border-border px-4 py-3">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            <FlaskConical className="h-4 w-4 text-sun" aria-hidden />
            সর্বশেষ ব্যাকটেস্ট (সিমুলেশন — লাভের প্রমাণ নয়)
          </h3>
        </div>
        <CardContent className="space-y-2 p-4 text-xs">
          {!backtestLatest?.latest ? (
            backtestError ? (
              <p role="alert" className="rounded-lg border border-down/40 bg-down/10 p-2.5 leading-relaxed text-down">
                ব্যাকটেস্ট API অনুপলব্ধ — <span className="font-mono">{backtestError}</span>। এটি &quot;রান নেই&quot;-এর মতো নয় (fail-closed); সংরক্ষিত রান থাকলেও এখন দেখানো যাচ্ছে না।
              </p>
            ) : (
              <EmptyState>এখনো কোনো ব্যাকটেস্ট রান নেই।</EmptyState>
            )
          ) : (
            <>
              <p className="tabular-nums text-content">
                {backtestLatest.latest.timeframe} · {backtestLatest.latest.status} · {backtestLatest.latest.dataset.candleCount} ক্যান্ডেল ·{' '}
                {backtestLatest.latest.dataset.fromUtc.slice(0, 10)} → {backtestLatest.latest.dataset.toUtc.slice(0, 10)}
              </p>
              <p className="text-muted-foreground">
                ফিঙ্গারপ্রিন্ট <span className="font-mono text-[10px] text-sun">{backtestLatest.latest.datasetFingerprint.slice(0, 24)}…</span> · কৌশল <span className="font-mono">{backtestLatest.latest.strategyVersion}</span>
              </p>
              <dl>
                {(['dev', 'oos'] as const).map((seg) => {
                  const m = (seg === 'dev' ? backtestLatest.latest!.dev : backtestLatest.latest!.oos) as {
                    status: string; executedTrades?: number; winRate?: number; profitFactor?: number; netPnlPrice?: number; reason?: string;
                  };
                  return (
                    <div key={seg} className="flex flex-col gap-0.5 border-b border-border/60 py-1.5 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <dt className="shrink-0 text-muted-foreground">{seg === 'dev' ? 'Dev' : 'Out-of-sample'}</dt>
                      <dd className="tabular-nums text-content sm:text-right">
                        {m.status === 'INSUFFICIENT_DATA'
                          ? `INSUFFICIENT_DATA — ${m.reason ?? 'পর্যাপ্ত ট্রেড নেই'}`
                          : `${m.executedTrades} ট্রেড · জয়রেট ${m.winRate} · PF ${m.profitFactor} · নিট P&L ${m.netPnlPrice} (মূল্য-একক)`}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              <p className="text-[10px] leading-relaxed text-muted-foreground">{backtestLatest.disclaimer}</p>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
