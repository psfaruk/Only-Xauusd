'use client';

/**
 * XAUUSD AI Trading Agent — Phase 6/7/11 panels (Signals tab).
 * ----------------------------------------------------------------------------
 * Three surfaces, one component tree:
 *
 *   AiReviewPanel      — Phase 6 GLM multi-agent review: run button + the
 *                        latest four-agent verdicts (advisory only).
 *   ExecutionPanel     — Phase 11 approval-based execution: lock banner,
 *                        approval queue (approve/reject), open positions
 *                        (close), append-only execution log.
 *
 * Deterministic data (signal verdicts, levels, risk checks) always comes from
 * the engine via props — this panel never computes a price or lot size.
 */

import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock,
  Crosshair,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  XCircle,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtDhaka } from '@/lib/dashboard/i18n';
import type {
  AiReviewAgent,
  AiReviewLatestResponse,
  ExecutionStateResponse,
} from '@/lib/dashboard/types';

// ---------------------------------------------------------------------------
// Phase 6 — AI multi-agent review panel
// ---------------------------------------------------------------------------

const AGENT_BN: Record<string, string> = {
  analyst: 'বিশ্লেষক (Analyst)',
  critic: 'সমালোচক (Critic)',
  risk_reviewer: 'রিস্ক পর্যালোচক',
  orchestrator: 'সমন্বয়ক (Orchestrator)',
};

function verdictBadge(v: string): { label: string; cls: string } {
  if (v === 'approve') return { label: 'সম্মত', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
  if (v === 'reject') return { label: 'আপত্তি', cls: 'bg-red-500/15 text-red-300 border-red-500/30' };
  return { label: 'অপেক্ষা', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
}

function AgentCard({ agent }: { agent: AiReviewAgent }) {
  const [open, setOpen] = useState(false);
  const v = verdictBadge(agent.verdict);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-3 text-left"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-zinc-200">{AGENT_BN[agent.agent] ?? agent.agent}</span>
          {agent.modelOk === false && <Badge className="border-zinc-600 bg-zinc-700/30 text-[10px] text-zinc-400">মডেল ব্যর্থ</Badge>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Badge className={`border text-[10px] ${v.cls}`}>{v.label}</Badge>
          <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </span>
      </button>
      {open && (
        <p className="border-t border-zinc-800 p-3 text-xs leading-relaxed text-zinc-400">{agent.reasoning}</p>
      )}
    </div>
  );
}

export function AiReviewPanel({
  review,
  running,
  onRun,
  error,
}: {
  review: AiReviewLatestResponse | null;
  running: boolean;
  onRun: () => void;
  error?: string | null;
}) {
  const r = review?.review ?? null;
  return (
    <Card className="border-zinc-800 bg-zinc-950/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Bot className="h-4 w-4 text-fuchsia-400" aria-hidden />
            AI মাল্টি-এজেন্ট রিভিউ (Phase 6)
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-zinc-700 text-xs"
            onClick={onRun}
            disabled={running}
            aria-label="মাল্টি-এজেন্ট রিভিউ চালান"
          >
            {running ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Zap className="h-3.5 w-3.5" aria-hidden />}
            {running ? 'চলছে…' : 'রিভিউ চালান'}
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          চারজন GLM এজেন্ট (বিশ্লেষক → সমালোচক → রিস্ক পর্যালোচক → সমন্বয়ক) ভেরিফায়েড প্রমাণ পড়ে পরামর্শ দেয়। রিভিউ
          <span className="font-semibold text-fuchsia-300"> পরামর্শমূলক</span> — নির্ধারিত ইঞ্জিনের ফলাফল কখনো বদলায় না।
        </p>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            <XCircle className="h-4 w-4 shrink-0" aria-hidden /> রিভিউ পরিষেবা অনুপলব্ধ — {error}
          </div>
        )}
        {!r && !error && (
          <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
            এখনো কোনো রিভিউ নেই — উপরের বাটন চেপে সর্বশেষ সিগন্যাল ইভ্যালুয়েশনের রিভিউ চালান।
          </div>
        )}
        {r && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
              <span>চালানো: {fmtDhaka(r.ranAtUtc)}</span>
              <span className="text-zinc-700">•</span>
              <span>ফলাফল: <span className="text-zinc-300">{r.evaluationOutcome ?? 'অজানা'}</span></span>
              {r.degraded && (
                <Badge className="border-amber-500/30 bg-amber-500/15 text-[10px] text-amber-300">আংশিক অবনমিত</Badge>
              )}
            </div>
            {r.orchestrator && (
              <div className="rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/5 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <Badge className={`border text-[10px] ${verdictBadge(r.orchestrator.verdict).cls}`}>
                    {verdictBadge(r.orchestrator.verdict).label}
                  </Badge>
                  <span className="text-xs font-semibold text-zinc-200">{AGENT_BN.orchestrator}র সারসংক্ষেপ</span>
                </div>
                <p className="text-xs leading-relaxed text-zinc-300">{r.orchestrator.reasoning}</p>
              </div>
            )}
            <div className="space-y-2">
              {r.agents.map((a) => (
                <AgentCard key={`${r.batchId}-${a.agent}`} agent={a} />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Phase 11 — execution panel
// ---------------------------------------------------------------------------

function approvalStatusBn(s: string): { label: string; cls: string } {
  switch (s) {
    case 'pending':
      return { label: 'অপেক্ষমাণ', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
    case 'approved':
      return { label: 'অনুমোদিত', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
    case 'rejected':
      return { label: 'বাতিল', cls: 'bg-red-500/15 text-red-300 border-red-500/30' };
    case 'expired':
      return { label: 'মেয়াদোত্তীর্ণ', cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' };
    default:
      return { label: s, cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' };
  }
}

function logStatusBn(s: string): string {
  switch (s) {
    case 'filled':
      return 'সম্পন্ন';
    case 'sent':
      return 'পাঠানো (ফলাফল অজানা)';
    case 'rejected':
      return 'ব্রোকার বাতিল';
    case 'failed':
      return 'ব্যর্থ';
    default:
      return s;
  }
}

export function ExecutionPanel({
  state,
  deciding,
  closingId,
  onDecide,
  onClose,
  error,
}: {
  state: ExecutionStateResponse | null;
  deciding: boolean;
  closingId: string | null;
  onDecide: (approvalId: string, decision: 'approve' | 'reject') => void;
  onClose: (positionId: string) => void;
  error?: string | null;
}) {
  const s = state?.state ?? null;

  return (
    <Card className="border-zinc-800 bg-zinc-950/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <Crosshair className="h-4 w-4 text-orange-400" aria-hidden />
          এক্সিকিউশন — অনুমোদন-ভিত্তিক ডেমো ট্রেডিং (Phase 11)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            <XCircle className="h-4 w-4 shrink-0" aria-hidden /> {error}
          </div>
        )}

        {/* Lock / armed banner */}
        {s && (
          <div
            className={`flex items-start gap-3 rounded-xl border p-3.5 ${
              s.executionEnabled ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-zinc-700 bg-zinc-900/50'
            }`}
            role="status"
          >
            {s.executionEnabled ? (
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
            ) : (
              <Lock className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" aria-hidden />
            )}
            <div className="min-w-0 text-xs leading-relaxed">
              {s.executionEnabled ? (
                <>
                  <p className="font-semibold text-emerald-300">ডেমো এক্সিকিউশন সক্রিয় — প্রতিটি অর্ডারে আপনার অনুমোদন লাগবে</p>
                  <p className="mt-0.5 text-zinc-400">
                    স্বয়ংক্রিয় ট্রেডিং নেই — সিগন্যাল + রিস্ক চেক পাস হলে অনুমোদনের অপেক্ষায় থাকবে, আপনি চাপ দিলেই ব্রোকারে যাবে।
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold text-zinc-200">এক্সিকিউশন তালাবন্ধ (read-only)</p>
                  <p className="mt-0.5 text-zinc-400">{s.executionReason}</p>
                </>
              )}
              {s.bridge.server && (
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
                  <span>সার্ভার: {s.bridge.server}</span>
                  {s.bridge.accountEquity !== null && (
                    <>
                      <span className="text-zinc-700">•</span>
                      <span>
                        ইকুইটি {s.bridge.accountEquity.toFixed(2)} {s.bridge.accountCurrency ?? ''}
                      </span>
                    </>
                  )}
                  {s.bridge.accountBalance !== null && (
                    <>
                      <span className="text-zinc-700">•</span>
                      <span>ব্যালেন্স {s.bridge.accountBalance.toFixed(2)}</span>
                    </>
                  )}
                  <span className="text-zinc-700">•</span>
                  <span>{s.bridge.ordersEnabled ? 'ব্রিজ অর্ডার লেয়ার সক্রিয়' : 'ব্রিজ অর্ডার লেয়ার বন্ধ'}</span>
                </p>
              )}
            </div>
          </div>
        )}

        {/* Approval queue */}
        <section aria-label="অনুমোদন তালিকা">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-400" aria-hidden /> অনুমোদনের অপেক্ষায়
          </h4>
          {!s || s.approvals.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-800 p-3 text-xs text-zinc-500">
              কোনো অনুমোদন নেই — অ্যাকশনেবল সিগন্যাল এলে রিস্ক চেকসহ এখানে হাজির হবে।
            </p>
          ) : (
            <div className="max-h-96 space-y-2.5 overflow-y-auto pr-1">
              {s.approvals.map((a) => {
                const st = approvalStatusBn(a.status);
                const pending = a.status === 'pending';
                return (
                  <div key={a.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {a.direction && (
                        <Badge
                          className={`border text-[10px] ${
                            a.direction === 'BUY'
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                              : 'bg-red-500/15 text-red-300 border-red-500/30'
                          }`}
                        >
                          {a.direction === 'BUY' ? <TrendingUp className="mr-1 h-3 w-3" aria-hidden /> : <TrendingDown className="mr-1 h-3 w-3" aria-hidden />}
                          {a.direction}
                        </Badge>
                      )}
                      <Badge className={`border text-[10px] ${st.cls}`}>{st.label}</Badge>
                      {a.lots !== null && (
                        <span className="text-[11px] text-zinc-400">{a.lots} লট</span>
                      )}
                      {a.riskPassed === true && (
                        <Badge className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300">রিস্ক পাস</Badge>
                      )}
                      {a.riskPassed === false && (
                        <Badge className="border-red-500/30 bg-red-500/10 text-[10px] text-red-300">রিস্ক ফেল</Badge>
                      )}
                      <span className="ml-auto text-[10px] text-zinc-500">{fmtDhaka(a.createdAtUtc)}</span>
                    </div>
                    {(a.entry !== null || a.stopLoss !== null || a.takeProfit !== null) && (
                      <p className="mt-1.5 text-[11px] text-zinc-400">
                        Entry {a.entry ?? '—'} · SL <span className="text-red-300">{a.stopLoss ?? '—'}</span> · TP{' '}
                        <span className="text-emerald-300">{a.takeProfit ?? '—'}</span>
                      </p>
                    )}
                    {a.note && <p className="mt-1 text-[11px] text-zinc-500">{a.note}</p>}
                    {pending && a.expiresAtUtc && (
                      <p className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500">
                        <Clock className="h-3 w-3" aria-hidden /> মেয়াদ: {fmtDhaka(a.expiresAtUtc)}
                      </p>
                    )}
                    {pending && (
                      <div className="mt-2.5 flex gap-2">
                        <Button
                          size="sm"
                          className="h-8 bg-emerald-600 text-xs hover:bg-emerald-500"
                          onClick={() => onDecide(a.id, 'approve')}
                          disabled={deciding || !s.executionEnabled}
                          aria-label="অর্ডার অনুমোদন"
                        >
                          <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden /> অনুমোদন ও পাঠান
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 border-red-500/40 text-xs text-red-300 hover:bg-red-500/10"
                          onClick={() => onDecide(a.id, 'reject')}
                          disabled={deciding}
                          aria-label="অনুমোদন বাতিল"
                        >
                          <XCircle className="mr-1 h-3.5 w-3.5" aria-hidden /> বাতিল
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Open positions */}
        <section aria-label="খোলা পজিশন">
          <h4 className="mb-2 text-xs font-semibold text-zinc-300">খোলা পজিশন (লাইভ)</h4>
          {!s || s.positions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-800 p-3 text-xs text-zinc-500">
              {s?.positionsError
                ? `পজিশন তালিকা অনুপলব্ধ (${s.positionsError})`
                : 'এই মুহূর্তে কোনো খোলা পজিশন নেই।'}
            </p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {s.positions.map((p) => (
                <div key={p.positionId} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                  <Badge
                    className={`border text-[10px] ${
                      p.direction === 'BUY'
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : 'bg-red-500/15 text-red-300 border-red-500/30'
                    }`}
                  >
                    {p.direction}
                  </Badge>
                  <span className="text-xs text-zinc-200">{p.symbol}</span>
                  <span className="text-[11px] text-zinc-400">{p.lots} লট @ {p.priceOpen}</span>
                  <span className={`text-xs font-semibold ${p.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {p.profit >= 0 ? '+' : ''}
                    {p.profit.toFixed(2)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7 border-zinc-700 px-2.5 text-[11px]"
                    onClick={() => onClose(p.positionId)}
                    disabled={closingId !== null || !s.executionEnabled}
                    aria-label={`পজিশন ${p.positionId} ক্লোজ করুন`}
                  >
                    {closingId === p.positionId ? 'চলছে…' : 'ক্লোজ'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Execution log */}
        <section aria-label="এক্সিকিউশন লগ">
          <h4 className="mb-2 text-xs font-semibold text-zinc-300">এক্সিকিউশন লগ (অডিট)</h4>
          {!s || s.logs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-800 p-3 text-xs text-zinc-500">এখনো কোনো অর্ডার কার্যকর হয়নি।</p>
          ) : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {s.logs.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2 text-[11px]">
                  <span className="text-zinc-500">{fmtDhaka(l.createdAtUtc)}</span>
                  <Badge
                    className={`border text-[10px] ${
                      l.status === 'filled'
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : l.status === 'failed'
                          ? 'bg-red-500/15 text-red-300 border-red-500/30'
                          : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                    }`}
                  >
                    {logStatusBn(l.status)}
                  </Badge>
                  <span className="truncate text-zinc-400">
                    {typeof l.request.type === 'string' ? `${l.request.type} ` : ''}
                    {typeof l.request.lots === 'number' ? `${l.request.lots} লট ` : ''}
                    {typeof l.request.symbol === 'string' ? l.request.symbol : l.request.action === 'CLOSE' ? 'পজিশন ক্লোজ' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
