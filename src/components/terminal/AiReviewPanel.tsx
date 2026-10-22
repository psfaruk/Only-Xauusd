'use client';

/**
 * Only-Xauusd — Phase 6 AI multi-agent review panel (Signals tab).
 * ----------------------------------------------------------------------------
 * AiReviewPanel — the GLM multi-agent review surface: run button + the latest
 * four-agent verdicts (advisory only; the deterministic signal engine remains
 * authoritative).
 *
 * Phase 0 deep-remediation: the Phase 11 ExecutionPanel (approval queue,
 * open positions, execution log) was REMOVED together with the execution
 * module — this product is signal-only and cannot place, close or modify
 * broker orders.
 */

import {
  Bot,
  ChevronDown,
  RefreshCw,
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
