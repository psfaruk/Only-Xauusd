'use client';

/**
 * XAUUSD AI Trading Agent — System view (UI-02).
 * ----------------------------------------------------------------------------
 * Ported from the former audit / market / dhealth / glm / mt5 / db / sec /
 * arch tabs, regrouped as sub-tabs of one "সিস্টেম" surface, plus the
 * SystemEvent audit trail. API-unavailable is explicit everywhere (F-04 fix)
 * and the GLM capability badges use a three-state model (unknown when the
 * audit API is unreachable — F-03 fix).
 */

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  ClipboardCheck,
  Cpu,
  Database,
  FolderTree,
  Globe,
  Languages,
  Layers,
  LineChart,
  Loader2,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Wrench,
  XCircle,
  Zap,
  Activity,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AuditStatusIcon, PriceLevelText, StatusIcon, qualityStateTokenClass } from './bits';
import {
  bnForCode,
  fmtAge,
  fmtDhaka,
  qualityStateBn,
  syncStatusBn,
} from '@/lib/dashboard/i18n';
import type {
  AnalysisLatestResponse,
  AuditResponse,
  BacktestLatestResponse,
  DataHealthResponse,
  DataLatestResponse,
  HealthReport,
  MarketStatusResponse,
  QualityResponse,
  SyncRunSummary,
  VerifyResponse,
} from '@/lib/dashboard/types';
import type { PriceDisplaySpec } from '@/lib/market/price-display';
import type { TickStreamState } from '@/hooks/use-tick-stream';

/* ---------------------------------------------------------------------------
 * UI-03 (Task 39) — token-only badge twins (same family as HistoryView /
 * AnalysisView). The i18n badge-class helpers still emit the raw dark-mode
 * palette; these local maps keep every status on the theme-aware terminal
 * tokens so light mode stays legible. A label always accompanies the color —
 * never color-only.
 * ------------------------------------------------------------------------- */

/** Log level / severity → token palette (error → down, warn → sun, info → muted). */
const SEVERITY_BADGE_CLASS: Record<string, string> = {
  error: 'border-down/40 bg-down/10 text-down',
  warn: 'border-sun/40 bg-sun/10 text-sun',
  warning: 'border-sun/40 bg-sun/10 text-sun',
  info: 'border-border-strong bg-muted text-content',
};

function severityBadgeClass(level: string): string {
  return SEVERITY_BADGE_CLASS[level] ?? 'border-border-strong bg-muted text-muted-foreground';
}

export function SystemView({
  audit,
  auditError,
  health,
  marketStatus,
  marketError,
  marketQuality,
  qualityError,
  dataHealth,
  dhealthError,
  dataLatest,
  backtestLatest,
  backtestError,
  analysisLatest,
  verifyResult,
  verifying,
  onRunVerify,
  syncing,
  onRunSync,
  priceSpec,
  quoteDigitsMismatch,
  loading,
  tickStream,
}: {
  audit: AuditResponse | null;
  auditError?: string | null;
  health: HealthReport | null;
  marketStatus: MarketStatusResponse | null;
  /** Master-audit fix B-D1: status-API outage code — explicit banner in the
   * market tab; never conflated with "no data". */
  marketError?: string | null;
  marketQuality: QualityResponse | null;
  qualityError?: string | null;
  dataHealth: DataHealthResponse | null;
  dhealthError?: string | null;
  dataLatest: DataLatestResponse | null;
  backtestLatest: BacktestLatestResponse | null;
  backtestError?: string | null;
  analysisLatest: AnalysisLatestResponse | null;
  verifyResult: VerifyResponse | null;
  verifying: boolean;
  onRunVerify: () => void;
  syncing: boolean;
  onRunSync: () => void;
  priceSpec: PriceDisplaySpec;
  quoteDigitsMismatch: boolean;
  loading?: boolean;
  /** Live tick-stream (Task 29-c) — socket.io relay of genuine bridge ticks.
   *  null-safe: a down stream renders an honest unavailable card, never
   *  fabricated values. */
  tickStream: TickStreamState | null;
}) {
  return (
    <div className="space-y-4">
      <Tabs defaultValue="audit" className="space-y-4">
        {/* Task 40 fix: was flex-nowrap overflow-x-auto — a hidden horizontal
         * scroll row where "নিরাপত্তা" and "আর্কিটেকচার" sat off-screen on
         * mobile (invisible functions). A 4-column grid keeps all 8 sub-tabs
         * on-screen in exactly two rows at every width. */}
        <TabsList className="h-auto w-full max-w-full grid grid-cols-4 gap-1 bg-panel p-1">
          {(
            [
              ['audit', 'নিরীক্ষণ v2'],
              ['market', 'মার্কেট ডেটা'],
              ['dhealth', 'ডেটা স্বাস্থ্য'],
              ['glm', 'GLM যাচাই'],
              ['mt5', 'MT5'],
              ['db', 'ডেটাবেস'],
              ['sec', 'নিরাপত্তা'],
              ['arch', 'আর্কিটেকচার'],
            ] as Array<[string, string]>
          ).map(([v, label]) => (
            <TabsTrigger
              key={v}
              value={v}
              className="min-h-[40px] whitespace-normal px-2 text-center text-xs leading-tight sm:px-4 sm:text-sm data-[state=active]:bg-sun/15 data-[state=active]:text-sun"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ------------------------------------------------- audit v2 */}
        <TabsContent value="audit" className="space-y-4">
          {auditError ? (
            <UnavailableBanner label="পরিবেশ-নিরীক্ষণ API অনুপলব্ধ" code={auditError} />
          ) : (
            <>
              <Card className="gap-0 border-border bg-panel py-0">
                <div className="border-b border-border px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                      <ClipboardCheck className="h-4 w-4 text-sun" aria-hidden />
                      পরিবেশ নিরীক্ষণ v2 — বর্তমান বনাম ঐতিহাসিক প্রমাণ আলাদা
                      {audit && (
                        <span className="flex flex-wrap gap-1.5">
                          <Badge variant="outline" className="border-up/40 bg-up/10 text-[10px] text-up">বর্তমান: {audit.totals.currentRequired.pass} pass</Badge>
                          <Badge variant="outline" className="border-sun/40 bg-sun/10 text-[10px] text-sun">{audit.totals.currentRequired.warn} warn</Badge>
                          <Badge variant="outline" className="border-down/40 bg-down/10 text-[10px] text-down">{audit.totals.currentRequired.fail} fail</Badge>
                          <Badge variant="outline" className="border-warn/40 bg-warn/10 text-[10px] text-warn">{audit.totals.currentRequired.blocked} blocked</Badge>
                          <Badge variant="outline" className="border-border-strong/50 bg-muted text-[10px] text-content">{audit.totals.notApplicable} অপ্রযোজ্য</Badge>
                          <Badge variant="outline" className="border-border-strong/50 bg-muted text-[10px] text-content">{audit.totals.historical} ঐতিহাসিক</Badge>
                        </span>
                      )}
                    </h3>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    বর্তমান চেকগুলো এই মুহূর্তে চালানো হয়েছে (রিফ্রেশ করলে আবার চলবে){audit ? ` — ${fmtDhaka(audit.generatedAtUtc)}` : ''}
                  </p>
                </div>
                <CardContent className="space-y-5 p-4">
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">বর্তমান প্রয়োজনীয় চেক ({audit?.sections.currentRequired.length ?? 0})</h3>
                      <Badge variant="outline" className="border-border-strong bg-surface font-mono text-[10px] text-muted-foreground">freshness: per-request</Badge>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-border hover:bg-transparent">
                            <TableHead className="pl-4 text-[11px] uppercase tracking-wide">অবস্থা</TableHead>
                            <TableHead className="text-[11px] uppercase tracking-wide">চেক</TableHead>
                            <TableHead className="min-w-[240px] text-[11px] uppercase tracking-wide">প্রমাণ</TableHead>
                            <TableHead className="min-w-[160px] text-[11px] uppercase tracking-wide">সময় / সময়কাল</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(audit?.sections.currentRequired ?? []).map((c) => (
                            <TableRow key={c.id} className="border-border/70 bg-surface hover:bg-accent">
                              <TableCell className="pl-4">
                                <span className="flex items-center gap-1.5 whitespace-nowrap">
                                  <AuditStatusIcon status={c.status} />
                                  <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">{c.evidenceType}</Badge>
                                </span>
                              </TableCell>
                              <TableCell className="max-w-[320px]">
                                <p className="text-sm font-medium text-foreground">{c.description}</p>
                                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{c.reason}</p>
                              </TableCell>
                              <TableCell className="max-w-[380px] break-words font-mono text-xs text-content">{c.evidence || '—'}</TableCell>
                              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                {c.completedAtUtc ? fmtDhaka(c.completedAtUtc) : '—'}
                                {c.durationMs !== null ? <span className="block text-muted-foreground">{c.durationMs}ms</span> : null}
                              </TableCell>
                            </TableRow>
                          ))}
                          {loading && !audit && (
                            <>
                              {[0, 1, 2].map((i) => (
                                <TableRow key={`audit-skeleton-${i}`}>
                                  <TableCell colSpan={4} className="p-4">
                                    <Skeleton className="h-5 w-full" />
                                  </TableCell>
                                </TableRow>
                              ))}
                            </>
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">অপ্রযোজ্য লিগ্যাসি ডিপেন্ডেন্সি ({audit?.sections.notApplicable.length ?? 0})</h3>
                      <Badge variant="outline" className="border-border-strong bg-surface font-mono text-[10px] text-muted-foreground">NOT_APPLICABLE ≠ PASS</Badge>
                    </div>
                    <div className="space-y-2">
                      {(audit?.sections.notApplicable ?? []).map((c) => (
                        <div key={c.id} className="rounded-lg border border-border bg-surface p-3">
                          <p className="text-sm font-medium text-content">
                            <span className="mr-2 text-muted-foreground">∅</span>
                            {c.description}
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.reason}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">ঐতিহাসিক প্রমাণ — Phase 1 ({audit?.sections.historical.length ?? 0})</h3>
                      <Badge variant="outline" className="border-border-strong bg-surface font-mono text-[10px] text-muted-foreground">freshness: historical-phase1</Badge>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-border hover:bg-transparent">
                            <TableHead className="pl-4 text-[11px] uppercase tracking-wide">ফলাফল (তখন)</TableHead>
                            <TableHead className="text-[11px] uppercase tracking-wide">বিষয়</TableHead>
                            <TableHead className="min-w-[240px] text-[11px] uppercase tracking-wide">প্রমাণ (মূল কমান্ড আউটপুট)</TableHead>
                            <TableHead className="text-[11px] uppercase tracking-wide">মূল সময়</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(audit?.sections.historical ?? []).map((c) => (
                            <TableRow key={c.id} className="border-border/70 bg-surface hover:bg-accent">
                              <TableCell className="pl-4">
                                <span className="flex items-center gap-1.5">
                                  <StatusIcon status={c.status === 'PASS' ? 'pass' : c.status === 'FAIL' ? 'fail' : 'warn'} />
                                  <span className="font-mono text-xs text-muted-foreground">{c.status}</span>
                                </span>
                              </TableCell>
                              <TableCell className="max-w-[260px]">
                                <p className="text-sm font-medium text-content">{c.description}</p>
                                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{c.reason}</p>
                              </TableCell>
                              <TableCell className="max-w-[380px] break-words font-mono text-xs text-muted-foreground">{c.evidence}</TableCell>
                              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{c.historical ? fmtDhaka(c.historical.performedAtUtc) : '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* ------------------------------------------------- market */}
        <TabsContent value="market" className="space-y-4">
          {marketError && !marketStatus && (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-down/40 bg-down/10 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-down" aria-hidden />
              <div>
                <p className="text-sm font-semibold text-down">মার্কেট-স্ট্যাটাস API অনুপলব্ধ</p>
                <p className="mt-0.5 text-xs leading-relaxed text-content">
                  কোড <span className="font-mono text-down">{marketError}</span> — নিচের '—' চিহ্নগুলো ডেটা নেই-এর প্রমাণ নয়, স্ট্যাটাস আনা যায়নি (fail-closed)। রিফ্রেশ লুপ ৩০ সেকেন্ডে আবার চেষ্টা করে।
                </p>
              </div>
            </div>
          )}
          {marketStatus && (!marketStatus.bridge.configured || !marketStatus.bridge.reachable || !marketStatus.bridge.status?.connected) && (
            <div role="alert" className="flex flex-col gap-2 rounded-xl border border-down/40 bg-down/10 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-down" aria-hidden />
                <div>
                  <p className="text-sm font-semibold text-down">ডেটা পাওয়া যাচ্ছে না</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-content">
                    {marketStatus.bridge.error
                      ? `${bnForCode(marketStatus.bridge.error.code)} `
                      : 'MT5 ব্রিজ এখনো বসানো হয়নি। '}
                    ডেটা পাইপলাইন fail-closed — কোনো ডেটা বানানো হবে না।
                  </p>
                </div>
              </div>
              <Badge variant="outline" className="w-fit shrink-0 border-border-strong/50 bg-muted font-mono text-content">
                {marketStatus.bridge.error?.code ?? 'BRIDGE_NOT_DEPLOYED'}
              </Badge>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="gap-0 border-border bg-panel py-0">
              <div className="border-b border-border px-4 py-3">
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  <Network className="h-4 w-4 text-sun" aria-hidden /> MT5 ব্রিজ সংযোগ
                  {marketStatus?.bridge.status?.source && (
                    <Badge variant="outline" className="border-border-strong/50 bg-muted font-mono text-[10px] text-content">source: {marketStatus.bridge.status.source}</Badge>
                  )}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">রিড-ওনলি REST চুক্তি (/health, /api/status, /api/quote, /api/candles) · প্রোব প্রতি ১০ সেকেন্ডে ক্যাশ হয়।</p>
              </div>
              <CardContent className="space-y-2 p-4 text-xs">
                {([
                  ['কনফিগারড (MT5_BRIDGE_URL)', marketStatus ? (marketStatus.bridge.configured ? 'হ্যাঁ' : 'না') : '—'],
                  ['সার্ভার পৌঁছানো যায়', marketStatus ? (marketStatus.bridge.reachable ? 'হ্যাঁ' : 'না') : '—'],
                  ['MT5 সংযুক্ত', marketStatus?.bridge.status ? (marketStatus.bridge.status.connected ? 'হ্যাঁ' : 'না') : '—'],
                  ['সার্ভার', marketStatus?.bridge.status?.server ?? '—'],
                  ['লেটেন্সি', marketStatus?.bridge.status?.latencyMs != null ? `${marketStatus.bridge.status.latencyMs}ms` : '—'],
                  ['প্রোব সময় (ঢাকা)', marketStatus ? fmtDhaka(marketStatus.bridge.probedAtUtc) : '—'],
                ] as Array<[string, string]>).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3 border-b border-border/60 pb-1.5 last:border-0 last:pb-0">
                    <span className="text-muted-foreground">{k}</span>
                    <span className="text-right font-mono text-foreground">{v}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="gap-0 border-border bg-panel py-0">
              <div className="border-b border-border px-4 py-3">
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  <Zap className="h-4 w-4 text-sun" aria-hidden /> সর্বশেষ টিক — {marketStatus?.symbol ?? 'XAUUSDm'}
                  {marketStatus?.readiness.tick.state && (
                    <Badge variant="outline" className={qualityStateTokenClass(marketStatus.readiness.tick.state)}>
                      {qualityStateBn[marketStatus.readiness.tick.state]}
                    </Badge>
                  )}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">প্রতি সিম্বলে একটি স্ন্যাপশট (উচ্চ-ফ্রিকোয়েন্সি টিক ইতিহাস নয় — ইচ্ছাকৃত সীমাবদ্ধতা)।</p>
              </div>
              <CardContent className="space-y-2 p-4 text-xs">
                {marketStatus?.readiness.tick.bid ? (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        ['Bid', marketStatus.readiness.tick.bid, 'text-up'],
                        ['Ask', marketStatus.readiness.tick.ask, 'text-down'],
                        ['Spread', marketStatus.readiness.tick.spread, 'text-foreground'],
                      ] as Array<[string, string | null, string]>).map(([k, v, cls]) => (
                        <div key={k} className="min-w-0 rounded-lg border border-border bg-surface p-2 text-center">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{k}</p>
                          <p className={`mt-0.5 font-mono text-sm font-semibold ${cls}`}>
                            <PriceLevelText value={v} spec={priceSpec} />
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between border-b border-border/60 pb-1.5 text-muted-foreground">
                      <span>টিক সময় (ঢাকা)</span>
                      <span className="font-mono text-foreground">{marketStatus.readiness.tick.lastTickTimeUtc ? fmtDhaka(marketStatus.readiness.tick.lastTickTimeUtc) : '—'}</span>
                    </div>
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span>ডেটার বয়স</span>
                      <span className="font-mono text-foreground">
                        {fmtAge(marketStatus.readiness.tick.ageSeconds)} / সীমা {fmtAge(marketStatus.readiness.tick.stalenessThresholdSeconds)}
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="rounded-lg border border-dashed border-border p-3 text-center leading-relaxed text-muted-foreground">
                    এখনো কোনো বৈধ টিক সংরক্ষিত হয়নি — ব্রিজ সচল হলে সিঙ্কের পর এখানে আসবে।
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Task 29-c — genuine live tick-stream observability (socket.io relay,
                port 3041). Counters below are REAL bridge counters, never inferred. */}
            <Card className="gap-0 border-border bg-panel py-0" data-testid="tick-stream-card">
              <div className="border-b border-border px-4 py-3">
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  <Activity className="h-4 w-4 text-sun" aria-hidden /> লাইভ টিক স্ট্রিম
                  <Badge
                    variant="outline"
                    data-testid="tick-stream-status"
                    className={
                      tickStream?.status === 'live'
                        ? 'border-up/40 bg-up/10 text-up'
                        : tickStream?.status === 'down'
                          ? 'border-down/40 bg-down/10 text-down'
                          : 'border-border-strong bg-muted text-content'
                    }
                  >
                    {tickStream?.status === 'live' ? (
                      <CheckCircle2 className="h-3 w-3" aria-hidden />
                    ) : tickStream?.status === 'down' ? (
                      <XCircle className="h-3 w-3" aria-hidden />
                    ) : (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    )}
                    {tickStream?.status === 'live' ? 'লাইভ' : tickStream?.status === 'down' ? 'বিচ্ছিন্ন' : 'যুক্ত হচ্ছে'}
                  </Badge>
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  tick-stream মিনি-সার্ভিস (socket.io :3041) — ব্রিজ থেকে প্রতি সেকেন্ড পোল, দাম বদলালেই সম্প্রচার। ২০-সেকেন্ড পোলের বিকল্প নয় — সমান্তরাল লাইভ চ্যানেল; স্ট্রিম না থাকলে পোলই যথেষ্ট (fail-closed)।
                </p>
              </div>
              <CardContent className="space-y-2 p-4 text-xs">
                {tickStream?.status === 'live' && tickStream.tick ? (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        ['Bid', String(tickStream.tick.bid), 'text-up'],
                        ['Ask', String(tickStream.tick.ask), 'text-down'],
                        ['Spread', (tickStream.tick.spread).toFixed(tickStream.tick.digits ?? 3), 'text-foreground/90'],
                      ] as Array<[string, string, string]>).map(([k, v, cls]) => (
                        <div key={k} className="min-w-0 rounded-lg border border-border bg-surface p-2 text-center">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{k}</p>
                          <p className={`mt-0.5 font-mono text-sm font-semibold ${cls}`}>{v}</p>
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        ['ব্রিজ মোট টিক', tickStream.bridge?.quoteCount != null ? tickStream.bridge.quoteCount.toLocaleString('en-US') : null],
                        ['রিলে সিকোয়েন্স', String(tickStream.tick.serviceSeq)],
                        ['এই সেশনে', String(tickStream.sessionTicks)],
                      ] as Array<[string, string | null]>).map(([k, v]) => (
                        <div key={k} className="min-w-0 rounded-lg border border-border bg-surface p-2 text-center">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{k}</p>
                          <p className="mt-0.5 font-mono text-sm font-semibold text-foreground" data-testid={k === 'ব্রিজ মোট টিক' ? 'tick-stream-quotecount' : undefined}>{v ?? '—'}</p>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between border-b border-border/60 pb-1.5 text-muted-foreground">
                      <span>শেষ কোট (ঢাকা)</span>
                      <span className="font-mono text-foreground">
                        {tickStream.tick.quoteTimeUtc ? fmtDhaka(tickStream.tick.quoteTimeUtc) : '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between border-b border-border/60 pb-1.5 text-muted-foreground">
                      <span>ব্রিজ সার্ভার / গেটওয়ে</span>
                      <span className="font-mono text-foreground">
                        {tickStream.bridge?.server ?? '—'} · {tickStream.bridge?.gateway ?? '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between border-b border-border/60 pb-1.5 text-muted-foreground">
                      <span>লেটেন্সি / অফসেট</span>
                      <span className="font-mono text-foreground">
                        {tickStream.bridge?.latencyMs != null ? `${tickStream.bridge.latencyMs} ms` : '—'} /{' '}
                        {tickStream.bridge?.offsetSec != null ? `${tickStream.bridge.offsetSec}s` : '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between border-b border-border/60 pb-1.5 text-muted-foreground">
                      <span>রিকানেক্ট / আপটাইম</span>
                      <span className="font-mono text-foreground">
                        {tickStream.bridge?.reconnects != null ? String(tickStream.bridge.reconnects) : '—'} /{' '}
                        {tickStream.bridge?.uptimeMs != null ? fmtAge(tickStream.bridge.uptimeMs / 1000) : '—'}
                      </span>
                    </div>
                    {tickStream.bridge?.lastError ? (
                      <p role="note" className="rounded-lg border border-sun/30 bg-sun/10 p-2 text-sun" data-testid="tick-stream-lasterror">
                        সর্বশেষ ব্রিজ ত্রুটি (নিরাময় হয়েছে কি না স্ট্রিমই বলে): {tickStream.bridge.lastError}
                      </p>
                    ) : null}
                  </>
                ) : tickStream?.status === 'live' ? (
                  <p className="rounded-lg border border-dashed border-border p-3 text-center text-muted-foreground">
                    সংযোগ আছে, এখনো কোনো টিক সম্প্রচারিত হয়নি — বাজার স্থির থাকলে স্বাভাবিক (দাম বদলালেই আসবে)।
                  </p>
                ) : tickStream?.status === 'down' ? (
                  <p role="note" className="rounded-lg border border-down/40 bg-down/10 p-2.5 text-down">
                    স্ট্রিম অনুপলব্ধ — ডেটা বানানো হয় না। নিয়মিত ২০-সেকেন্ড পোল চালু আছে; স্ট্রিম ফিরলে লাইভ কাউন্টার দেখা যাবে।
                  </p>
                ) : (
                  <p className="rounded-lg border border-dashed border-border p-3 text-center text-muted-foreground">
                    স্ট্রিমে যুক্ত হচ্ছে…
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="gap-0 border-border bg-panel py-0">
            <div className="border-b border-border px-4 py-3">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                <LineChart className="h-4 w-4 text-sun" aria-hidden /> টাইমফ্রেম অনুযায়ী ডেটা-গুণমান
                <Badge variant="outline" className={qualityStateTokenClass(marketStatus?.readiness.qualityState ?? 'UNAVAILABLE')}>
                  সামগ্রিক: {qualityStateBn[marketStatus?.readiness.qualityState ?? 'UNAVAILABLE']}
                </Badge>
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                ফর্মিং ক্যান্ডেল কখনোই নিশ্চিত ইতিহাস হিসেবে গণ্য হয় না — শুধু বন্ধ (closed) ক্যান্ডেল বিবেচিত।
              </p>
            </div>
            <CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
              {(marketStatus?.readiness.timeframes ?? []).map((tf) => (
                <div key={tf.timeframe} className="rounded-xl border border-border bg-surface p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold text-foreground">{tf.timeframe}</span>
                    <Badge variant="outline" className={qualityStateTokenClass(tf.state)}>{qualityStateBn[tf.state]}</Badge>
                  </div>
                  <dl className="mt-2 space-y-1 text-[11px] leading-relaxed text-content">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">শেষ বন্ধ ক্যান্ডেল</dt>
                      <dd className="text-right">{tf.lastClosedCandleTimeUtc ? fmtDhaka(tf.lastClosedCandleTimeUtc) : '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">বয়স / সীমা</dt>
                      <dd className="text-right font-mono">{fmtAge(tf.lastClosedCandleAgeSeconds)} / {fmtAge(tf.stalenessThresholdSeconds)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">স্ক্যান / সন্দেহজনক ফাঁক</dt>
                      <dd className="text-right font-mono">{tf.scannedCandles} / <span className={tf.missingCandles > 0 ? 'text-sun' : 'text-content'}>{tf.missingCandles}</span></dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">সম্ভাব্য বাজার-বন্ধ ফাঁক</dt>
                      <dd className="text-right font-mono text-content">{tf.possibleClosureGaps}</dd>
                    </div>
                  </dl>
                  {tf.errorCodes.length > 0 && (
                    <p className="mt-2 border-t border-border/70 pt-1.5 text-[10px] leading-relaxed text-sun">
                      {tf.errorCodes.map((c) => bnForCode(c)).join(' ')}
                    </p>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="gap-0 border-border bg-panel py-0">
              <div className="border-b border-border px-4 py-3">
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  <ShieldCheck className="h-4 w-4 text-sun" aria-hidden /> বিশ্লেষণ-প্রস্তুতি (Data Readiness)
                </h3>
              </div>
              <CardContent className="space-y-3 p-4 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={(marketStatus?.readiness.ready ? 'border-up/40 bg-up/10 text-up' : 'border-down/40 bg-down/10 text-down')}>
                    {marketStatus?.readiness.ready ? 'প্রস্তুত (ready)' : 'প্রস্তুত নয় (not ready)'}
                  </Badge>
                  <Badge variant="outline" className={qualityStateTokenClass(marketStatus?.readiness.qualityState ?? 'UNAVAILABLE')}>
                    quality: {marketStatus?.readiness.qualityState ?? '—'}
                  </Badge>
                  <span className="text-muted-foreground">ডেটার বয়স: <span className="font-mono text-content">{fmtAge(marketStatus?.readiness.dataAgeSeconds)}</span></span>
                </div>
                {marketStatus && marketStatus.readiness.errorCodes.length > 0 ? (
                  <ul className="space-y-1">
                    {marketStatus.readiness.errorCodes.map((c) => (
                      <li key={c} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-content">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-sun" aria-hidden />
                        <span>{bnForCode(c)} <span className="font-mono text-muted-foreground">[{c}]</span></span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-muted-foreground">কোনো ত্রুটি কোড নেই।</p>
                )}
              </CardContent>
            </Card>

            <Card className="gap-0 border-border bg-panel py-0">
              <div className="border-b border-border px-4 py-3">
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  <Database className="h-4 w-4 text-sun" aria-hidden /> ডেটাবেস সিঙ্ক অবস্থা
                  {marketStatus?.sync.running && (
                    <Badge variant="outline" className="border-up/40 bg-up/10 text-up">চলছে…</Badge>
                  )}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">আইডেমপোটেন্ট আপসার্ট — একই ক্যান্ডেল দুবার সিঙ্ক করলেও ডুপ্লিকেট রেকর্ড হয় না।</p>
              </div>
              <CardContent className="space-y-3 p-4 text-xs">
                {([
                  ['সর্বশেষ রান', marketStatus?.sync.lastRun],
                  ['সর্বশেষ সফল', marketStatus?.sync.lastSuccess],
                  ['সর্বশেষ ব্যর্থ/আংশিক', marketStatus?.sync.lastFailure],
                ] as Array<[string, SyncRunSummary | null | undefined]>).map(([label, run]) => (
                  <div key={label} className="rounded-lg border border-border bg-surface p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">{label}</span>
                      {run ? (
                        <Badge variant="outline" className={run.status === 'success' ? 'border-up/40 bg-up/10 text-up' : run.status === 'partial' ? 'border-sun/40 bg-sun/10 text-sun' : 'border-down/40 bg-down/10 text-down'}>
                          {syncStatusBn(run.status)}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">এখনো নেই</span>
                      )}
                    </div>
                    {run && (
                      <p className="mt-1 font-mono text-[10px] leading-relaxed text-content">
                        {fmtDhaka(run.startedAtUtc)} · {run.mode} · {run.timeframes.join('/')}
                        {' '}· প্রাপ্ত {run.received} · নতুন {run.inserted} · আপডেট {run.updated} · বাতিল {run.rejected} · ডুপ {run.duplicates}
                        {run.durationMs != null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}
                        {run.errorCode ? ` · [${run.errorCode}]` : ''}
                      </p>
                    )}
                  </div>
                ))}
                <Button
                  onClick={onRunSync}
                  disabled={syncing}
                  title={marketError && !marketStatus ? 'স্ট্যাটাস API ডাউন থাকলেও সিঙ্ক স্বাধীনভাবে চলে — ফল সৎভাবে দেখানো হবে' : undefined}
                  className="min-h-10 w-full gap-2"
                >
                  {syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                  {syncing ? 'সিঙ্ক চলছে…' : 'এখনই সিঙ্ক করুন (ম্যানুয়াল)'}
                </Button>
              </CardContent>
            </Card>
          </div>

          <Card className="gap-0 border-border bg-panel py-0">
            <div className="border-b border-border px-4 py-3">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                <AlertTriangle className="h-4 w-4 text-sun" aria-hidden /> ডেটা-গুণমান সমস্যা (খোলা)
                <Badge variant="outline" className="border-border-strong bg-muted text-[10px] text-content">{marketQuality?.openIssues.length ?? 0} টি</Badge>
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">প্রতি সিঙ্ক রানে সীমিত সংখ্যক সমস্যা সংরক্ষিত হয় (ফ্লাড নিয়ন্ত্রণ)।</p>
            </div>
            <CardContent className="p-0">
              {qualityError ? (
                <div className="flex items-start gap-2.5 p-4 text-xs" role="alert">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden />
                  <p className="leading-relaxed text-content">
                    ডেটা-গুণমান API অনুপলব্ধ — <span className="font-mono text-down">{qualityError}</span>।
                  </p>
                </div>
              ) : (
                <div className="custom-scrollbar max-h-96 overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-panel">
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="pl-4 text-[11px] uppercase tracking-wide sm:pl-6">সময় (ঢাকা)</TableHead>
                        <TableHead className="text-[11px] uppercase tracking-wide">মাত্রা</TableHead>
                        <TableHead className="text-[11px] uppercase tracking-wide">কোড</TableHead>
                        <TableHead className="text-[11px] uppercase tracking-wide">টাইমফ্রেম</TableHead>
                        <TableHead className="pr-4 text-[11px] uppercase tracking-wide sm:pr-6">বিবরণ</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(marketQuality?.openIssues ?? []).map((i) => (
                        <TableRow key={i.id} className="border-border/70 bg-surface hover:bg-accent">
                          <TableCell className="whitespace-nowrap pl-4 text-xs tabular-nums text-muted-foreground sm:pl-6">{fmtDhaka(i.checkedAtUtc)}</TableCell>
                          <TableCell>
                            <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${severityBadgeClass(i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warn' : 'info')}`}>
                              {i.severity}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-sun">{i.errorCode}</TableCell>
                          <TableCell className="font-mono text-xs text-content">{i.timeframe ?? '—'}</TableCell>
                          <TableCell className="pr-4 text-xs text-content sm:pr-6">{bnForCode(i.errorCode)}{i.details?.detail ? <span className="block text-[10px] text-muted-foreground">{i.details.detail}</span> : null}</TableCell>
                        </TableRow>
                      ))}
                      {marketQuality && marketQuality.openIssues.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="p-6 text-center text-sm text-muted-foreground">
                            কোনো খোলা সমস্যা নেই।
                          </TableCell>
                        </TableRow>
                      )}
                      {!marketQuality && (
                        <TableRow>
                          <TableCell colSpan={5} className="p-6">
                            <Skeleton className="h-5 w-full" />
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------- dhealth */}
        <TabsContent value="dhealth" className="space-y-4">
          {!dataHealth ? (
            <Card className="gap-0 border-border bg-panel py-0">
              <CardContent className="p-4">
                {dhealthError ? (
                  <div className="flex items-start gap-2.5 rounded-lg border border-down/40 bg-down/10 p-4 text-sm">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-down" aria-hidden />
                    <p className="leading-relaxed text-content">
                      ডেটা-স্বাস্থ্য এন্ডপয়েন্ট এখন উপলব্ধ নয় ({dhealthError}) — কোনো কিছু আন্দাজ করে দেখানো হচ্ছে না।
                    </p>
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed border-border-strong bg-surface p-4 text-sm leading-relaxed text-muted-foreground">
                    ডেটা-স্বাস্থ্য এন্ডপয়েন্ট এখন উপলব্ধ নয় (fail-closed) — কোনো কিছু আন্দাজ করে দেখানো হচ্ছে না।
                  </p>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className="gap-0 border-border bg-panel py-0">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    <Activity className="h-4 w-4 text-sun" aria-hidden /> লাইভ ফিড ও রিয়েল-টাইম কোট সততা
                    <Badge
                      variant="outline"
                      className={
                        dataHealth.quote.freshness === 'LIVE'
                          ? 'border-up/40 bg-up/10 text-up'
                          : dataHealth.quote.freshness === 'STALE'
                            ? 'border-sun/40 bg-sun/10 text-sun'
                            : dataHealth.quote.freshness === 'DEGRADED'
                              ? 'border-warn/40 bg-warn/10 text-warn'
                              : 'border-down/40 bg-down/10 text-down'
                      }
                    >
                      {dataHealth.quote.freshness}
                    </Badge>
                  </h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    শুধু সফল authenticated সেশন + সাম্প্রতিক বৈধ কোট মিললেই LIVE — শুধু WebSocket খোলা থাকা যথেষ্ট নয়।
                  </p>
                </div>
                <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border border-border bg-surface p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">উৎস (প্রকৃত)</p>
                    <p className="mt-1 text-sm font-medium text-foreground">{dataHealth.quote.sourceLabel}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      server: {dataHealth.quote.server ?? '—'} · gateway: {dataHealth.quote.gateway ?? '—'}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border bg-surface p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">XAUUSDm কোট</p>
                    {dataHealth.quote.bid !== null ? (
                      <>
                        <p className="mt-1 font-mono text-sm text-foreground">
                          bid <PriceLevelText value={dataHealth.quote.bid} spec={priceSpec} /> / ask <PriceLevelText value={dataHealth.quote.ask} spec={priceSpec} />
                        </p>
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          spread <PriceLevelText value={dataHealth.quote.spread} spec={priceSpec} /> · কোট-বয়স {dataHealth.quote.ageSeconds ?? '—'}s · digits {dataHealth.quote.digits ?? '—'}
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 text-sm text-content">বৈধ কোট নেই (কিছু বানানো হয়নি)</p>
                    )}
                    {quoteDigitsMismatch && (
                      <p className="mt-1 text-[10px] leading-relaxed text-sun">
                        ⚠ মেটাডেটা-অসঙ্গতি: লাইভ কোট digits ({dataHealth?.quote.digits}) ≠ যাচাইকৃত SymbolSpec digits ({priceSpec.digits})।
                      </p>
                    )}
                    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                      {priceSpec.verified
                        ? `প্রদর্শন-নির্ভুলতা: যাচাইকৃত digits=${priceSpec.digits} (${dataLatest?.spec?.source ?? 'bridge'}${dataLatest?.spec?.lastVerifiedAtUtc ? `, যাচাই ${fmtDhaka(dataLatest.spec.lastVerifiedAtUtc)}` : ''})`
                        : 'প্রদর্শন-নির্ভুলতা: সিম্বল মেটাডেটা যাচাইকৃত নয় — raw মান দেখানো হচ্ছে (fail-closed)।'}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border bg-surface p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">সংযোগ সত্যতা</p>
                    <p className="mt-1 text-xs text-content">
                      authenticated: {dataHealth.quote.authenticated ? 'হ্যাঁ ✓' : 'না ✗'} · পুনর্সংযোগ: {dataHealth.quote.reconnects ?? '—'}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">শেষ ত্রুটি: {dataHealth.quote.lastError ?? 'নেই'}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-surface p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">সিগন্যাল গেট</p>
                    <p className={`mt-1 text-sm font-medium ${dataHealth.quote.signalPermitted ? 'text-up' : 'text-sun'}`}>
                      {dataHealth.quote.signalPermitted ? 'অনুমোদিত (সব শর্ত পূরণ)' : 'অবরুদ্ধ (BLOCKED)'}
                    </p>
                    {dataHealth.quote.blockedReasons.length > 0 && (
                      <p className="mt-1 font-mono text-[10px] text-sun">{dataHealth.quote.blockedReasons.join(' · ')}</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="gap-0 border-border bg-panel py-0">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    <Database className="h-4 w-4 text-sun" aria-hidden /> ক্যানেল-হিস্টোরি নিরীক্ষণ (প্রতি টাইমফ্রেম)
                  </h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    ডেটাবেসে সংরক্ষিত প্রকৃত ব্রোকার ক্যানেলের যাচাই — অডিট সময় {dataHealth.candleHistory.auditedAtUtc.slice(0, 19).replace('T', ' ')} UTC।
                  </p>
                </div>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2">TF</th>
                          <th className="px-3 py-2">কভারেজ (UTC)</th>
                          <th className="px-3 py-2">ক্লোজড</th>
                          <th className="px-3 py-2">ফর্মিং</th>
                          <th className="px-3 py-2">সন্দেহজনক গ্যাপ</th>
                          <th className="px-3 py-2">ওয়াকেন্ড গ্যাপ</th>
                          <th className="px-3 py-2">অবৈধ OHLC</th>
                          <th className="px-3 py-2">ডুপ্লিকেট</th>
                          <th className="px-3 py-2">অবস্থা</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dataHealth.candleHistory.timeframes.map((tf) => (
                          <tr key={tf.timeframe} className="border-b border-border/50 transition-colors hover:bg-accent/50">
                            <td className="px-3 py-2 font-mono font-medium tabular-nums text-foreground">{tf.timeframe}</td>
                            <td className="px-3 py-2 tabular-nums text-content">
                              {tf.present ? `${tf.earliestCandleUtc?.slice(0, 10)} → ${tf.latestCandleUtc?.slice(0, 10)}` : '—'}
                            </td>
                            <td className="px-3 py-2 font-mono tabular-nums text-content">{tf.closedCount}</td>
                            <td className="px-3 py-2 font-mono tabular-nums text-content">{tf.formingCount}</td>
                            <td className={`px-3 py-2 font-mono tabular-nums ${tf.missingOutsideClosure > 0 ? 'text-sun' : 'text-up'}`}>{tf.missingOutsideClosure}</td>
                            <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">{tf.closureGaps}</td>
                            <td className={`px-3 py-2 font-mono tabular-nums ${tf.invalidOhlc > 0 ? 'text-down' : 'text-up'}`}>{tf.invalidOhlc}</td>
                            <td className={`px-3 py-2 font-mono tabular-nums ${tf.duplicateTimestamps > 0 ? 'text-down' : 'text-up'}`}>{tf.duplicateTimestamps}</td>
                            <td className="px-3 py-2">
                              <Badge variant="outline" className={qualityStateTokenClass(tf.qualityState)}>
                                {tf.qualityState}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="border-t border-border p-3">
                    <p className="text-xs leading-relaxed text-sun">⚠ H4 সীমা: {dataHealth.candleHistory.h4Coverage.coverageNote}</p>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* ------------------------------------------------- GLM */}
        <TabsContent value="glm" className="space-y-4">
          {/* Master-audit fix B-D4: the runtime-derived last verification
           * event (persisted SystemEvent) — previously returned by the API
           * but never rendered, while static Phase-1 constants appeared as
           * current facts. */}
          {audit?.glm.liveStatus ? (
            <div
              role="status"
              className={`flex flex-wrap items-center gap-2 rounded-xl border p-3 text-xs ${
                audit.glm.liveStatus.code === 'GLM_VERIFY_OK'
                  ? 'border-up/40 bg-up/10 text-up'
                  : 'border-sun/40 bg-sun/10 text-sun'
              }`}
            >
              <span className="font-semibold">সর্বশেষ লাইভ যাচাই (রানটাইম):</span>
              <span className="font-mono">{audit.glm.liveStatus.code}</span>
              {audit.glm.liveStatus.at ? <span>· {fmtDhaka(audit.glm.liveStatus.at)} (ঢাকা)</span> : <span>· সময় অজানা</span>}
              {audit.glm.liveStatus.message ? <span className="w-full text-content">{audit.glm.liveStatus.message}</span> : null}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border-strong bg-surface p-4 text-xs leading-relaxed text-muted-foreground">
              এখনো কোনো লাইভ যাচাই-ইভেন্ট সংরক্ষিত হয়নি — নিচের বাটন দিয়ে এখনই চালানো যায়।
            </p>
          )}
          {/* F-03 fix: three-state capability badges — unknown when audit unavailable.
           * B-D4: badges now carry their evidence timestamp (static Phase-1
           * proof, not a live claim). */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {[
              { icon: Zap, title: 'Chat Completion', ok: audit?.glm.capabilities.chatCompletion ?? null, detail: 'ইংরেজি টোকেন-টেস্ট রাউন্ড-ট্রিপ' },
              { icon: Languages, title: 'Bengali Response', ok: audit?.glm.capabilities.bengali ?? null, detail: 'Phase 9-এর বাংলা Chat Agent-এর ভিত্তি' },
              { icon: Wrench, title: 'Tool Calling', ok: audit?.glm.capabilities.toolCalling ?? null, detail: `Full loop ${audit?.glm.capabilities.toolCallRoundTripMs ?? '—'}ms` },
            ].map((cap) => (
              <Card key={cap.title} className="gap-0 border-border bg-panel py-0">
                <CardContent className="flex items-start gap-3 p-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-sun/30 bg-sun/10">
                    <cap.icon className="h-5 w-5 text-sun" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">{cap.title}</p>
                      {cap.ok === null ? (
                        <Badge variant="outline" className="border-border-strong/50 bg-muted text-content">অজানা (API অনুপলব্ধ)</Badge>
                      ) : cap.ok ? (
                        <Badge variant="outline" className="border-up/40 bg-up/10 text-up">✓ যাচাইকৃত</Badge>
                      ) : (
                        <Badge variant="outline" className="border-down/40 bg-down/10 text-down">✗ ব্যর্থ</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-content">{cap.detail}</p>
                    {/* B-D4: time-stamp the static evidence — a Phase-1 proof,
                     * not a claim about the current minute. */}
                    {audit?.glm.verifiedAt && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">প্রমাণ-সময়: {fmtDhaka(audit.glm.verifiedAt)} (ঐতিহাসিক)</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="gap-0 border-border bg-panel py-0">
            <div className="border-b border-border px-4 py-3">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                <Bot className="h-4 w-4 text-sun" aria-hidden /> লাইভ পুনঃযাচাই
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                স্ট্যাটিক প্রমাণ নয় — বাটন চাপলেই এখনই তিনটি রিয়েল রাউন্ড-ট্রিপ চলে (চ্যাট, বাংলা, টুল-কলিং)। ফল SystemEvent অডিট ট্রেইলে লেখা হয়।
              </p>
            </div>
            <CardContent className="space-y-4 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={onRunVerify} disabled={verifying} className="min-h-10 gap-2">
                  {verifying ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> যাচাই চলছে…
                    </>
                  ) : (
                    <>
                      <Zap className="h-4 w-4" aria-hidden /> GLM লাইভ যাচাই চালান
                    </>
                  )}
                </Button>
                <span className="text-xs text-muted-foreground">
                  মডেল: <span className="font-mono text-sun">{audit?.glm.model ?? 'glm-4-plus'}</span> ·
                  SDK: z-ai-web-dev-sdk (server-side only) · Auth: sandbox-managed
                </span>
              </div>

              {verifyResult && (
                <div className="space-y-3">
                  <div
                    role="status"
                    className={`rounded-lg border p-3 text-sm ${
                      verifyResult.verified
                        ? 'border-up/40 bg-up/10 text-up'
                        : 'border-down/40 bg-down/10 text-down'
                    }`}
                  >
                    {verifyResult.verified ? 'সব টেস্ট পাস — ' : 'এক বা একাধিক টেস্ট ব্যর্থ — '}
                    মোট {verifyResult.totalLatencyMs}ms · {fmtDhaka(verifyResult.checkedAt)} (ঢাকা)
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {verifyResult.tests.map((t) => (
                      <div key={t.id} className="rounded-lg border border-border bg-surface p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-foreground">{t.name}</p>
                          <StatusIcon status={t.ok ? 'pass' : 'fail'} />
                        </div>
                        <p className="mt-1 font-mono tabular-nums text-[11px] text-muted-foreground">{t.latencyMs > 0 ? `${t.latencyMs}ms` : '—'}</p>
                        <p className="mt-1.5 text-xs leading-relaxed text-content">{t.detail}</p>
                        {t.sample && (
                          <p className="custom-scrollbar mt-2 max-h-24 overflow-auto rounded-md border border-border bg-muted p-2 font-mono text-[11px] leading-relaxed text-content">
                            &ldquo;{t.sample}&rdquo;
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Separator />
              <div className="grid grid-cols-1 gap-3 text-xs text-content sm:grid-cols-2">
                <p>
                  <span className="font-medium text-foreground">নমুনা রিকোয়েস্ট:</span>{' '}
                  <span className="font-mono text-muted-foreground">{audit?.glm.sample.prompt ?? '—'}</span>
                </p>
                <p>
                  <span className="font-medium text-foreground">নমুনা রেসপন্স:</span>{' '}
                  <span className="font-mono text-content">{audit?.glm.sample.response ?? '—'}</span>
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------- MT5 */}
        <TabsContent value="mt5" className="space-y-4">
          <Card className="gap-0 border-border bg-panel py-0">
            <div className="border-b border-border px-4 py-3">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                <Network className="h-4 w-4 text-sun" aria-hidden /> MT5 আর্কিটেকচার প্রতিবেদন
                {audit?.mt5.currentArchitecture && (
                  <Badge variant="outline" className="border-up/40 bg-up/10 text-up">
                    {audit.mt5.currentArchitecture.status === 'deployed-and-verified' ? 'বর্তমান ব্রিজ: স্থাপিত ও যাচাইকৃত' : audit.mt5.currentArchitecture.status}
                  </Badge>
                )}
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                Phase 1-এর সম্ভাব্যতা গবেষণা ঐতিহাসিক সত্য হিসেবে সংরক্ষিত; Phase 8 থেকে বাস্তব সমাধান — সরাসরি TypeScript ওয়েব-টার্মিনাল ব্রিজ।
              </p>
            </div>
            <CardContent className="space-y-4 p-4">
              {audit?.mt5.currentArchitecture && (
                <div className="rounded-lg border border-up/30 bg-up/5 p-4">
                  <p className="text-sm font-semibold text-up">{audit.mt5.currentArchitecture.title}</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-content">{audit.mt5.currentArchitecture.detail}</p>
                </div>
              )}
              <Separator />
              <p className="text-sm font-semibold text-foreground">ঐতিহাসিক গবেষণা — Phase 1 ({audit?.mt5.historicalStudy ? `সমাধান: ${audit.mt5.historicalStudy.supersededBy}` : ''})</p>
              <ul className="space-y-2">
                {(audit?.mt5.historicalStudy?.findings ?? audit?.mt5.findings ?? []).map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm leading-relaxed text-content">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
              <p className="rounded-lg border border-up/30 bg-up/5 p-3 text-xs leading-relaxed text-up">
                ব্রিজটি GET-only REST (x-trader-key auth) — কোনো ট্রেডিং কমান্ড কোডেই নেই (স্ট্যাটিক স্ক্যান-যাচাইকৃত)।
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------- database */}
        <TabsContent value="db" className="space-y-4">
          <Card className="gap-0 border-border bg-panel py-0">
            <div className="border-b border-border px-4 py-3">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                <Database className="h-4 w-4 text-sun" aria-hidden /> ডেটা মডেল (SQLite · Prisma)
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {/* Master-audit fix E3: derived from the payload (the old static
                    "১৪টি মডেল — ৯টি সচল" copy was stale; schema has 16). */}
                {audit
                  ? `${audit.database.models.length}টি মডেল — সচল ${audit.database.models.filter((m) => m.status === 'active').length}, অবচিত ${audit.database.models.filter((m) => m.status === 'superseded').length} (Signal → SignalEvaluation), পরিকল্পিত ${audit.database.models.filter((m) => m.status === 'planned').length} (AiReview, RiskCheck), তালাবদ্ধ ${audit.database.models.filter((m) => m.status === 'locked').length} (Phase 11 পর্যন্ত)।`
                  : 'মডেল-তালিকা অনুপলব্ধ — সংযোগ ফিরলে দেখানো হবে।'}
              </p>
            </div>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead className="pl-4 text-[11px] uppercase tracking-wide sm:pl-6">মডেল</TableHead>
                      <TableHead className="min-w-[220px] text-[11px] uppercase tracking-wide">উদ্দেশ্য</TableHead>
                      <TableHead className="text-[11px] uppercase tracking-wide">Phase</TableHead>
                      <TableHead className="pr-4 text-[11px] uppercase tracking-wide sm:pr-6">অবস্থা</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(audit?.database.models ?? []).map((m) => (
                      <TableRow key={m.name} className="border-border/70 bg-surface hover:bg-accent">
                        <TableCell className="pl-4 font-mono text-xs text-foreground sm:pl-6">{m.name}</TableCell>
                        <TableCell className="text-xs text-content">{m.purpose}</TableCell>
                        <TableCell className="font-mono tabular-nums text-xs text-muted-foreground">P{m.phase}</TableCell>
                        <TableCell className="pr-4 sm:pr-6">
                          <Badge
                            variant="outline"
                            className={
                              m.status === 'active'
                                ? 'border-up/40 bg-up/10 text-up'
                                : m.status === 'locked'
                                  ? 'border-down/40 bg-down/10 text-down'
                                  : m.status === 'superseded'
                                    ? 'border-border-strong bg-muted text-muted-foreground line-through'
                                    : 'border-border-strong bg-muted text-content'
                            }
                          >
                            {m.status === 'active' ? 'সচল' : m.status === 'locked' ? 'তালাবদ্ধ (Phase 11)' : m.status === 'superseded' ? 'অবচিত' : 'পরিকল্পিত'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                    {loading && !audit && (
                      <>
                        {[0, 1, 2].map((i) => (
                          <TableRow key={`db-skeleton-${i}`}>
                            <TableCell colSpan={4} className="p-4">
                              <Skeleton className="h-5 w-full" />
                            </TableCell>
                          </TableRow>
                        ))}
                      </>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
          <p className="text-xs leading-relaxed text-muted-foreground">
            টেকনিক্যাল নোট: SQLite-এ Prisma Json টাইপ নেই, তাই JSON পে-লোড String হিসেবে সংরক্ষিত। সব মূল্য-ক্যান্ডেল-রেকর্ড symbol+timeframe+timestamp ইউনিক কনস্ট্রেইন্টে আবদ্ধ।
          </p>
        </TabsContent>

        {/* ------------------------------------------------- security */}
        <TabsContent value="sec" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="gap-0 border-border bg-panel py-0">
              <div className="border-b border-border px-4 py-3">
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  <ShieldCheck className="h-4 w-4 text-sun" aria-hidden /> নিরাপত্তা ব্যবস্থা
                </h3>
              </div>
              <CardContent className="space-y-3 p-4">
                {(audit?.security ?? []).map((s) => (
                  <div key={s.measure} className="rounded-lg border border-border bg-surface p-3">
                    <p className="text-xs font-semibold text-foreground">{s.measure}</p>
                    <p className="mt-1 text-xs leading-relaxed text-content">{s.detail}</p>
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card className="gap-0 border-border bg-panel py-0">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    <ClipboardCheck className="h-4 w-4 text-sun" aria-hidden /> গ্রহণযোগ্যতা চেকলিস্ট
                  </h3>
                </div>
                <CardContent className="p-4">
                  <ul className="space-y-2">
                    {(audit?.acceptanceChecklist ?? []).map((c) => (
                      <li key={c.id} className="flex items-start gap-2 text-sm text-content">
                        {c.done ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden />
                        ) : (
                          <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        {c.label}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              <Card className="gap-0 border-border bg-panel py-0">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    <AlertTriangle className="h-4 w-4 text-sun" aria-hidden /> ঝুঁকি ও অসমাধান ব্লকার
                  </h3>
                </div>
                <CardContent className="p-4">
                  <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-content">
                    <li><span className="font-medium text-foreground">Sandbox স্থায়িত্ব:</span> এটি কোডিং-রানটাইম, ২৪/৭ ট্রেডিং সার্ভার নয়। চূড়ান্ত ডিপ্লয়মেন্ট (Phase 12) আপনার নিজের Linux VPS-এ হবে।</li>
                    <li><span className="font-medium text-foreground">এক-পোর্ট সীমাবদ্ধতা:</span> বাইরের সব সংযোগ গেটওয়ে হয়ে যায়।</li>
                    <li><span className="font-medium text-foreground">GLM কোটা/খরচ:</span> স্যান্ডবক্স প্ল্যানের উপর নির্ভরশীল — /api/ai/verify-তে রেট লিমিট আছে।</li>
                  </ul>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* ------------------------------------------------- architecture */}
        <TabsContent value="arch" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="gap-0 border-border bg-panel py-0">
              <div className="border-b border-border px-4 py-3">
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  <Layers className="h-4 w-4 text-sun" aria-hidden /> সিস্টেম স্তর (উপর থেকে নিচে)
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">Phase 8 থেকে সব স্তর এই sandbox-এ বাস্তবায়িত (TypeScript ব্রিজ সহ)।</p>
              </div>
              <CardContent className="space-y-0 p-4">
                {(audit?.architecture ?? []).map((layer, i) => (
                  <div key={layer.id}>
                    <div className="flex gap-3 rounded-lg border border-border bg-surface p-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-sun/30 bg-sun/10">
                        {layer.id === 'dashboard' ? <Globe className="h-4 w-4 text-sun" aria-hidden /> : null}
                        {layer.id === 'api' ? <Server className="h-4 w-4 text-sun" aria-hidden /> : null}
                        {layer.id === 'glm' ? <Bot className="h-4 w-4 text-sun" aria-hidden /> : null}
                        {layer.id === 'tools' ? <Wrench className="h-4 w-4 text-sun" aria-hidden /> : null}
                        {layer.id === 'engines' ? <Cpu className="h-4 w-4 text-sun" aria-hidden /> : null}
                        {layer.id === 'bridge' ? <Network className="h-4 w-4 text-sun" aria-hidden /> : null}
                        {layer.id === 'data' ? <Database className="h-4 w-4 text-sun" aria-hidden /> : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-1">
                          <p className="text-sm font-semibold text-foreground">{layer.title}</p>
                          <Badge variant="outline" className="border-border-strong bg-muted font-mono text-[10px] text-content">
                            {layer.phase}
                          </Badge>
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-content">{layer.tech}</p>
                        <p className="mt-1 text-xs leading-relaxed text-content">{layer.detail}</p>
                      </div>
                    </div>
                    {i < (audit?.architecture.length ?? 0) - 1 && (
                      <div className="flex justify-center py-1" aria-hidden>
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card className="gap-0 border-border bg-panel py-0">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    <FolderTree className="h-4 w-4 text-sun" aria-hidden /> Repository কাঠামো
                  </h3>
                </div>
                <CardContent className="p-4">
                  <pre className="custom-scrollbar max-h-[320px] overflow-auto rounded-lg border border-border bg-muted p-4 font-mono text-[11px] leading-relaxed text-content">
                    {audit?.repositoryTree ?? ''}
                  </pre>
                </CardContent>
              </Card>

              <Card className="gap-0 border-border bg-panel py-0">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    <Wrench className="h-4 w-4 text-sun" aria-hidden /> Tool Registry (Allowlist)
                  </h3>
                </div>
                <CardContent className="space-y-3 p-4">
                  <p className="text-xs leading-relaxed text-content">
                    GLM শুধু অনুমোদিত টুল কল করতে পারে — কোনো shell, SQL বা নেটওয়ার্ক টুল নেই।
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(audit?.tools.active ?? []).map((t) => (
                      <Badge key={t} variant="outline" className="gap-1 border-up/40 bg-up/10 text-up">
                        <CheckCircle2 className="h-3 w-3" aria-hidden /> {t}
                      </Badge>
                    ))}
                    {(audit?.tools.planned ?? []).map((t) => (
                      <Badge key={t.name} variant="outline" className="border-border-strong bg-surface text-content">
                        {t.name} · P{t.phase}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Events trail */}
      <Card className="gap-0 border-border bg-panel py-0">
        <div className="border-b border-border px-4 py-3">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            <Terminal className="h-4 w-4 text-sun" aria-hidden /> সিস্টেম ইভেন্ট — লাইভ অডিট ট্রেইল
            <Badge variant="outline" className="border-border-strong bg-muted text-[10px] text-content">
              {health?.auditEventCount ?? audit?.events.length ?? 0} টি
            </Badge>
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">SystemEvent টেবিল থেকে সরাসরি (append-only)।</p>
        </div>
        <CardContent className="p-0">
          <div className="custom-scrollbar max-h-96 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-panel">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="pl-4 text-[11px] uppercase tracking-wide sm:pl-6">সময় (ঢাকা)</TableHead>
                  <TableHead className="text-[11px] uppercase tracking-wide">স্তর</TableHead>
                  <TableHead className="text-[11px] uppercase tracking-wide">কোড</TableHead>
                  <TableHead className="min-w-[240px] pr-4 text-[11px] uppercase tracking-wide sm:pr-6">বার্তা</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(audit?.events ?? []).map((e) => (
                  <TableRow key={e.id} className="border-border/70 bg-surface hover:bg-accent">
                    <TableCell className="whitespace-nowrap pl-4 text-xs tabular-nums text-muted-foreground sm:pl-6">
                      {fmtDhaka(e.createdAt)}
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${severityBadgeClass(e.level)}`}>
                        {e.level}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-sun">{e.code}</TableCell>
                    <TableCell className="pr-4 text-xs text-content sm:pr-6">{e.message}</TableCell>
                  </TableRow>
                ))}
                {audit && audit.events.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="p-6 text-center text-sm text-muted-foreground">
                      এখনো কোনো ইভেন্ট নেই — &ldquo;GLM যাচাই&rdquo; থেকে লাইভ যাচাই চালান।
                    </TableCell>
                  </TableRow>
                )}
                {loading && !audit && (
                  <>
                    {[0, 1, 2].map((i) => (
                      <TableRow key={`events-skeleton-${i}`}>
                        <TableCell colSpan={4} className="p-4">
                          <Skeleton className="h-5 w-full" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UnavailableBanner({ label, code }: { label: string; code: string }) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-xl border border-down/40 bg-down/10 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-down" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-down">{label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-content">{bnForCode(code)}</p>
        </div>
      </div>
      <Badge variant="outline" className="w-fit shrink-0 border-border-strong/50 bg-muted font-mono text-content">
        {code}
      </Badge>
    </div>
  );
}
