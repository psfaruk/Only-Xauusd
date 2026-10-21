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
 *                        (close), append-only execution log. Task 36-rt: the
 *                        open-positions section renders the REALTIME channel
 *                        (250 ms live price marking, 3 s position refresh,
 *                        2 s account balance) whenever it is fresher than the
 *                        15 s poll, and falls back to the polled view —
 *                        honestly, never mixing the two.
 *
 * Deterministic data (signal verdicts, levels, risk checks) always comes from
 * the engine via props — this panel never computes a price or lot size. The
 * ONLY local arithmetic is the display-time mark-to-market of a live tick
 * against a position's real entry (same 100 oz contract the tick-stream
 * relay uses) — a rendering, never a trading decision.
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
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { bnDigits } from '@/lib/dashboard/candidate-display';
import { fmtDhaka } from '@/lib/dashboard/i18n';
import type {
  AiReviewAgent,
  AiReviewLatestResponse,
  ExecutionStateResponse,
} from '@/lib/dashboard/types';
import type { TickStreamLivePosition, TickStreamTick } from '@/hooks/use-tick-stream';

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
  if (v === 'approve') return { label: 'সম্মত', cls: 'bg-up/15 text-up border-up/30' };
  if (v === 'reject') return { label: 'আপত্তি', cls: 'bg-down/15 text-down border-down/30' };
  return { label: 'অপেক্ষা', cls: 'bg-sun/15 text-sun border-sun/30' };
}

function AgentCard({ agent }: { agent: AiReviewAgent }) {
  const [open, setOpen] = useState(false);
  const v = verdictBadge(agent.verdict);
  return (
    <div className="rounded-lg border border-border bg-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-3 text-left"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-foreground/90">{AGENT_BN[agent.agent] ?? agent.agent}</span>
          {agent.modelOk === false && <Badge className="border-border-strong bg-muted text-[10px] text-content">মডেল ব্যর্থ</Badge>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Badge className={`border text-[10px] ${v.cls}`}>{v.label}</Badge>
          <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </span>
      </button>
      {open && (
        <p className="border-t border-border p-3 text-xs leading-relaxed text-content">{agent.reasoning}</p>
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
    <Card className="border-border bg-terminal">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Bot className="h-4 w-4 text-fuchsia-400" aria-hidden />
            AI মাল্টি-এজেন্ট রিভিউ (Phase 6)
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-border-strong text-xs"
            onClick={onRun}
            disabled={running}
            aria-label="মাল্টি-এজেন্ট রিভিউ চালান"
          >
            {running ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Zap className="h-3.5 w-3.5" aria-hidden />}
            {running ? 'চলছে…' : 'রিভিউ চালান'}
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          চারজন GLM এজেন্ট (বিশ্লেষক → সমালোচক → রিস্ক পর্যালোচক → সমন্বয়ক) ভেরিফায়েড প্রমাণ পড়ে পরামর্শ দেয়। রিভিউ
          <span className="font-semibold text-fuchsia-300"> পরামর্শমূলক</span> — নির্ধারিত ইঞ্জিনের ফলাফল কখনো বদলায় না।
        </p>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-down/40 bg-down/10 p-3 text-xs text-down">
            <XCircle className="h-4 w-4 shrink-0" aria-hidden /> রিভিউ পরিষেবা অনুপলব্ধ — {error}
          </div>
        )}
        {!r && !error && (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            এখনো কোনো রিভিউ নেই — উপরের বাটন চেপে সর্বশেষ সিগন্যাল ইভ্যালুয়েশনের রিভিউ চালান।
          </div>
        )}
        {r && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>চালানো: {fmtDhaka(r.ranAtUtc)}</span>
              <span className="text-muted-foreground">•</span>
              <span>ফলাফল: <span className="text-content">{r.evaluationOutcome ?? 'অজানা'}</span></span>
              {r.degraded && (
                <Badge className="border-sun/30 bg-sun/15 text-[10px] text-sun">আংশিক অবনমিত</Badge>
              )}
            </div>
            {r.orchestrator && (
              <div className="rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/5 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <Badge className={`border text-[10px] ${verdictBadge(r.orchestrator.verdict).cls}`}>
                    {verdictBadge(r.orchestrator.verdict).label}
                  </Badge>
                  <span className="text-xs font-semibold text-foreground/90">{AGENT_BN.orchestrator}র সারসংক্ষেপ</span>
                </div>
                <p className="text-xs leading-relaxed text-content">{r.orchestrator.reasoning}</p>
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
      return { label: 'অপেক্ষমাণ', cls: 'bg-sun/15 text-sun border-sun/30' };
    case 'approved':
      return { label: 'অনুমোদিত', cls: 'bg-up/15 text-up border-up/30' };
    case 'rejected':
      return { label: 'বাতিল', cls: 'bg-down/15 text-down border-down/30' };
    case 'expired':
      return { label: 'মেয়াদোত্তীর্ণ', cls: 'bg-muted-foreground/15 text-content border-border-strong/30' };
    default:
      return { label: s, cls: 'bg-muted-foreground/15 text-content border-border-strong/30' };
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

// ---------------------------------------------------------------------------
// Task 36-rt — realtime open-position channel (live rendering helpers)
// ---------------------------------------------------------------------------

/** Optional live-positions bundle from the tick-stream socket (3 s cadence).
 *  Non-null ONLY while it is fresher than the last 15 s poll — the parent
 *  decides; null means "render the existing polled view unchanged". */
export interface LiveExecutionPositions {
  positions: TickStreamLivePosition[];
  updatedAtMs: number;
  stale: boolean;
}

/** Optional live-account bundle (2 s cadence; balance only when observed). */
export interface LiveExecutionAccount {
  balance: number;
  currency: string | null;
  updatedAtMs: number;
}

/** XAUUSDm contract: 1 lot = 100 oz — the SAME constant the tick-stream relay
 *  uses for its floatingPnlUsd. Display-time mark-to-market ONLY (the live
 *  250 ms tick against the position's REAL entry) — never a trading
 *  computation; entries/lots/risk always come from the engine. */
const GOLD_CONTRACT_OZ = 100;
const LIVE_TICK_FRESH_MS = 10_000;

function markToMarket(
  p: TickStreamLivePosition,
  tick: TickStreamTick | null,
): { price: number | null; pnl: number | null } {
  if (tick !== null && tick.symbol === p.symbol) {
    const tickMs = Date.parse(tick.quoteTimeUtc);
    if (Number.isFinite(tickMs) && Date.now() - tickMs < LIVE_TICK_FRESH_MS) {
      // BUY closes at bid, SELL at ask — identical to the relay's formula.
      const delta = p.direction === 'BUY' ? tick.bid - p.entryPrice : p.entryPrice - tick.ask;
      return {
        price: p.direction === 'BUY' ? tick.bid : tick.ask,
        pnl: Math.round(delta * GOLD_CONTRACT_OZ * p.lots * 100) / 100,
      };
    }
  }
  // Relay-marked values (≤ 3 s old) or honest nulls — never fabricated.
  return { price: p.currentPrice, pnl: p.floatingPnlUsd };
}

/** Bengali age of an open position, e.g. "৪ মিনিট" / "২ ঘণ্টা ১৫ মিনিট". */
function ageBn(openTimeUtcSec: number, nowMs: number): string {
  if (!Number.isFinite(openTimeUtcSec) || openTimeUtcSec <= 0) return '—';
  const sec = Math.max(0, Math.floor(nowMs / 1000) - openTimeUtcSec);
  if (sec < 60) return `${bnDigits(sec)} সেকেন্ড`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${bnDigits(min)} মিনিট`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${bnDigits(hr)} ঘণ্টা ${bnDigits(remMin)} মিনিট` : `${bnDigits(hr)} ঘণ্টা`;
}

/** Pulsing লাইভ badge — shown only while the underlying realtime observation
 *  is < 5 s old (the pulse is presentation; the gate is the honest age). */
function LiveBadge({ testId }: { testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-up/30 bg-up/10 px-1.5 py-0.5 text-[9px] font-semibold text-up"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-up" aria-hidden />
      লাইভ
    </span>
  );
}

export function ExecutionPanel({
  state,
  deciding,
  closingId,
  onDecide,
  onClose,
  error,
  livePositions = null,
  liveTick = null,
  liveAccount = null,
}: {
  state: ExecutionStateResponse | null;
  deciding: boolean;
  closingId: string | null;
  onDecide: (approvalId: string, decision: 'approve' | 'reject') => void;
  onClose: (positionId: string) => void;
  error?: string | null;
  /** Task 36-rt — realtime positions (null ⇒ polled view unchanged). */
  livePositions?: LiveExecutionPositions | null;
  /** Task 36-rt — freshest 250 ms quote for live price/PnL marking. */
  liveTick?: TickStreamTick | null;
  /** Task 36-rt — realtime account balance (null ⇒ polled balance). */
  liveAccount?: LiveExecutionAccount | null;
}) {
  const s = state?.state ?? null;

  // 1 s heartbeat while any realtime channel is displayed — keeps the লাইভ
  // badge (< 5 s gate), the position age and the staleness fallback honest
  // even when socket events stop arriving (prices themselves re-render at the
  // 250 ms tick cadence from the parent). The timer callback owns all state
  // updates — nothing is set synchronously inside the effect body.
  const hasLiveChannel = livePositions !== null || liveAccount !== null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLiveChannel) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasLiveChannel]);

  // Balance: the realtime account channel wins only while fresher than the
  // 15 s poll (the parent gates it); otherwise the polled value stands.
  const liveBalance = liveAccount !== null ? liveAccount.balance : (s?.bridge.accountBalance ?? null);
  const liveBalanceIsLive = liveAccount !== null && nowMs - liveAccount.updatedAtMs < 5000;

  return (
    <Card className="border-border bg-terminal">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Crosshair className="h-4 w-4 text-warn" aria-hidden />
          এক্সিকিউশন — লাইভ অর্ডার পাইপলাইন (Phase 11/12)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-down/40 bg-down/10 p-3 text-xs text-down">
            <XCircle className="h-4 w-4 shrink-0" aria-hidden /> {error}
          </div>
        )}

        {/* Lock / armed banner */}
        {s && (
          <div
            className={`flex items-start gap-3 rounded-xl border p-3.5 ${
              s.executionEnabled ? 'border-up/30 bg-up/5' : 'border-border-strong bg-panel'
            }`}
            role="status"
          >
            {s.executionEnabled ? (
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-up" aria-hidden />
            ) : (
              <Lock className="mt-0.5 h-5 w-5 shrink-0 text-content" aria-hidden />
            )}
            <div className="min-w-0 text-xs leading-relaxed">
              {s.executionEnabled && s.executionAuto ? (
                <>
                  <p className="font-semibold text-up">অটো-এক্সিকিউশন সচল — সিগন্যাল + রিস্ক-চেক পাস হলেই অর্ডার যায়</p>
                  <p className="mt-0.5 text-content">
                    প্রতিটি অর্ডারের আগে ডিটারমিনিস্টিক রিস্ক চেক (লট-ক্যাপ, এক্সপোজার-ক্যাপ, দৈনিক সীমা, স্প্রেড) বাধ্যতামূলক — একবারই পাঠানো হয়, স্বয়ংক্রিয় রিট্রাই নেই।
                  </p>
                </>
              ) : s.executionEnabled ? (
                <>
                  <p className="font-semibold text-up">ডেমো এক্সিকিউশন সক্রিয় — প্রতিটি অর্ডারে আপনার অনুমোদন লাগবে</p>
                  <p className="mt-0.5 text-content">
                    সিগন্যাল + রিস্ক চেক পাস হলে অনুমোদনের অপেক্ষায় থাকবে, আপনি চাপ দিলেই ব্রোকারে যাবে।
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold text-foreground/90">এক্সিকিউশন তালাবন্ধ (read-only)</p>
                  <p className="mt-0.5 text-content">{s.executionReason}</p>
                </>
              )}
              {s.bridge.server && (
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>সার্ভার: {s.bridge.server}</span>
                  {s.bridge.accountEquity !== null && (
                    <>
                      <span className="text-muted-foreground">•</span>
                      <span>
                        ইকুইটি {s.bridge.accountEquity.toFixed(2)} {s.bridge.accountCurrency ?? ''}
                      </span>
                    </>
                  )}
                  {liveBalance !== null && (
                    <>
                      <span className="text-muted-foreground">•</span>
                      <span className="inline-flex items-center gap-1.5">
                        ব্যালেন্স <span className="font-mono">{liveBalance.toFixed(2)}</span>
                        {liveBalanceIsLive && <LiveBadge testId="live-balance-badge" />}
                      </span>
                    </>
                  )}
                  <span className="text-muted-foreground">•</span>
                  <span>{s.bridge.ordersEnabled ? 'ব্রিজ অর্ডার লেয়ার সক্রিয়' : 'ব্রিজ অর্ডার লেয়ার বন্ধ'}</span>
                </p>
              )}
            </div>
          </div>
        )}

        {/* Approval queue */}
        <section aria-label="অনুমোদন তালিকা">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-content">
            <ShieldAlert className="h-3.5 w-3.5 text-sun" aria-hidden /> অনুমোদনের অপেক্ষায়
          </h4>
          {!s || s.approvals.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              কোনো অনুমোদন নেই — অ্যাকশনেবল সিগন্যাল এলে রিস্ক চেকসহ এখানে হাজির হবে।
            </p>
          ) : (
            <div className="max-h-96 space-y-2.5 overflow-y-auto pr-1">
              {s.approvals.map((a) => {
                const st = approvalStatusBn(a.status);
                const pending = a.status === 'pending';
                return (
                  <div key={a.id} className="rounded-lg border border-border bg-panel p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {a.direction && (
                        <Badge
                          className={`border text-[10px] ${
                            a.direction === 'BUY'
                              ? 'bg-up/15 text-up border-up/30'
                              : 'bg-down/15 text-down border-down/30'
                          }`}
                        >
                          {a.direction === 'BUY' ? <TrendingUp className="mr-1 h-3 w-3" aria-hidden /> : <TrendingDown className="mr-1 h-3 w-3" aria-hidden />}
                          {a.direction}
                        </Badge>
                      )}
                      <Badge className={`border text-[10px] ${st.cls}`}>{st.label}</Badge>
                      {a.lots !== null && (
                        <span className="text-[11px] text-content">{a.lots} লট</span>
                      )}
                      {a.riskPassed === true && (
                        <Badge className="border-up/30 bg-up/10 text-[10px] text-up">রিস্ক পাস</Badge>
                      )}
                      {a.riskPassed === false && (
                        <Badge className="border-down/30 bg-down/10 text-[10px] text-down">রিস্ক ফেল</Badge>
                      )}
                      <span className="ml-auto text-[10px] text-muted-foreground">{fmtDhaka(a.createdAtUtc)}</span>
                    </div>
                    {(a.entry !== null || a.stopLoss !== null || a.takeProfit !== null) && (
                      <p className="mt-1.5 text-[11px] text-content">
                        Entry {a.entry ?? '—'} · SL <span className="text-down">{a.stopLoss ?? '—'}</span> · TP{' '}
                        <span className="text-up">{a.takeProfit ?? '—'}</span>
                      </p>
                    )}
                    {a.note && <p className="mt-1 text-[11px] text-muted-foreground">{a.note}</p>}
                    {pending && a.expiresAtUtc && (
                      <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Clock className="h-3 w-3" aria-hidden /> মেয়াদ: {fmtDhaka(a.expiresAtUtc)}
                      </p>
                    )}
                    {pending && (
                      <div className="mt-2.5 flex gap-2">
                        <Button
                          size="sm"
                          className="h-8 bg-up text-xs hover:bg-up"
                          onClick={() => onDecide(a.id, 'approve')}
                          disabled={deciding || !s.executionEnabled}
                          aria-label="অর্ডার অনুমোদন"
                        >
                          <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden /> অনুমোদন ও পাঠান
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 border-down/40 text-xs text-down hover:bg-down/10"
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

        {/* Open positions — Task 36-rt: the realtime channel (3 s refresh, 250 ms
         * price/PnL marking) whenever it is fresher than the last 15 s poll;
         * the existing polled view renders unchanged as the honest fallback. */}
        <section aria-label="খোলা পজিশন">
          <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold text-content">
            খোলা পজিশন (লাইভ)
            {livePositions !== null && nowMs - livePositions.updatedAtMs < 5000 && (
              <LiveBadge testId="live-positions-badge" />
            )}
          </h4>
          {livePositions !== null ? (
            livePositions.positions.length === 0 ? (
              <p data-testid="live-positions-list" className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                এই মুহূর্তে কোনো খোলা পজিশন নেই (রিয়েল-টাইম)।
              </p>
            ) : (
              <div data-testid="live-positions-list" className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {livePositions.positions.map((p) => {
                  const marked = markToMarket(p, liveTick);
                  return (
                    <div
                      key={p.positionId}
                      data-testid="live-position-row"
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-panel p-3"
                    >
                      <Badge
                        className={`border text-[10px] ${
                          p.direction === 'BUY'
                            ? 'bg-up/15 text-up border-up/30'
                            : 'bg-down/15 text-down border-down/30'
                        }`}
                      >
                        {p.direction}
                      </Badge>
                      <span className="text-xs text-foreground/90">{p.symbol}</span>
                      <span className="text-[11px] text-content">
                        {p.lots} লট @ <span className="font-mono">{p.entryPrice}</span>
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        চলতি{' '}
                        <span className="font-mono text-foreground/90">{marked.price !== null ? marked.price : '—'}</span>
                      </span>
                      {marked.pnl === null ? (
                        <span data-testid="live-position-pnl" className="font-mono text-xs text-muted-foreground">—</span>
                      ) : (
                        <span
                          data-testid="live-position-pnl"
                          className={`font-mono text-xs font-semibold ${
                            marked.pnl > 0 ? 'text-up' : marked.pnl < 0 ? 'text-down' : 'text-content'
                          }`}
                        >
                          {marked.pnl > 0 ? '+' : ''}
                          {marked.pnl.toFixed(2)}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground">{ageBn(p.openTimeUtcSec, nowMs)}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-auto h-7 border-border-strong px-2.5 text-[11px]"
                        onClick={() => onClose(p.positionId)}
                        disabled={closingId !== null || !(s?.executionEnabled ?? false)}
                        aria-label={`পজিশন ${p.positionId} ক্লোজ করুন`}
                      >
                        {closingId === p.positionId ? 'চলছে…' : 'ক্লোজ'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )
          ) : !s || s.positions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              {s?.positionsError
                ? `পজিশন তালিকা অনুপলব্ধ (${s.positionsError})`
                : 'এই মুহূর্তে কোনো খোলা পজিশন নেই।'}
            </p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {s.positions.map((p) => (
                <div key={p.positionId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-panel p-3">
                  <Badge
                    className={`border text-[10px] ${
                      p.direction === 'BUY'
                        ? 'bg-up/15 text-up border-up/30'
                        : 'bg-down/15 text-down border-down/30'
                    }`}
                  >
                    {p.direction}
                  </Badge>
                  <span className="text-xs text-foreground/90">{p.symbol}</span>
                  <span className="text-[11px] text-content">{p.lots} লট @ {p.priceOpen}</span>
                  <span className={`text-xs font-semibold ${p.profit >= 0 ? 'text-up' : 'text-down'}`}>
                    {p.profit >= 0 ? '+' : ''}
                    {p.profit.toFixed(2)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7 border-border-strong px-2.5 text-[11px]"
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
          <h4 className="mb-2 text-xs font-semibold text-content">এক্সিকিউশন লগ (অডিট)</h4>
          {!s || s.logs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">এখনো কোনো অর্ডার কার্যকর হয়নি।</p>
          ) : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {s.logs.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-panel px-3 py-2 text-[11px]">
                  <span className="text-muted-foreground">{fmtDhaka(l.createdAtUtc)}</span>
                  <Badge
                    className={`border text-[10px] ${
                      l.status === 'filled'
                        ? 'bg-up/15 text-up border-up/30'
                        : l.status === 'failed'
                          ? 'bg-down/15 text-down border-down/30'
                          : 'bg-sun/15 text-sun border-sun/30'
                    }`}
                  >
                    {logStatusBn(l.status)}
                  </Badge>
                  <span className="truncate text-content">
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
