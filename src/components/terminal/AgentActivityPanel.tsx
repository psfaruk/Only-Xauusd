'use client';

/**
 * XAUUSD AI Trading Agent — Agent Activity panel (Phase 8, 42-S5).
 * ----------------------------------------------------------------------------
 * Honest read-only window onto the PERSISTED agent-run state (42-S4 backend
 * contract: GET /api/agent/runs?limit=N → { ok, runs: [...] }):
 *
 *   · Self-fetching panel (own load/poll lifecycle with cleanup) so page.tsx
 *     needs zero new state plumbing — the same convention as
 *     BrokerSettingsView. It is mounted only while the সিস্টেম view is
 *     active, so polling stops the moment the view is left.
 *   · Polls every 10 s. A run shows as "চলমান" ONLY when the API says so —
 *     no animation, no optimistic state, no fabricated activity.
 *   · Every status is driven by the persisted backend row; step digests are
 *     parsed defensively from resultJson (plan/steps arrays if present) and
 *     truncated — never a raw dump.
 *   · Empty state: dashed card + a POST trigger ("বাজারের বর্তমান অবস্থা
 *     দেখাও") that creates one market-status task and refreshes the list;
 *     403/429/5xx get honest Bengali errors. If the endpoint is absent
 *     (backend subagent still finishing → 404) the panel shows the honest
 *     unavailable state and never crashes.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  Timer,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  agentRunBadgeClass,
  agentRunStatusBn,
  fmtDhaka,
  isAgentRunTerminal,
} from '@/lib/dashboard/i18n';
import type { AgentRunView, AgentRunsResponse } from '@/lib/dashboard/types';

const POLL_INTERVAL_MS = 10_000;
const RUNS_LIMIT = 10;
/** The one safe task the empty-state button can start (read-only market view). */
const TRIGGER_TASK = 'বাজারের বর্তমান অবস্থা দেখাও';

/** A single step digest parsed out of a run's persisted plan/step rows. */
interface StepDigest {
  key: string;
  text: string;
}

/** Truncate any digest line to a fixed length (digest-of-a-digest — the
 * backend already REDACTS tool observations to argument keys + 400 chars). */
function digestLine(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Defensive digest extraction. The 42-S4 payload carries the run's `plan`
 * (stepId/description/tool/status) and `steps` (per-tool observation rows,
 * already redacted server-side); older/contract payloads may instead embed a
 * plan inside resultJson. Anything unparseable yields an empty list — the
 * panel then shows no step section (honest absence, never fabricated).
 */
function parseStepDigests(run: AgentRunView): StepDigest[] {
  const digests: StepDigest[] = [];
  const push = (text: string) => {
    if (digests.length < 12) digests.push({ key: `step-${digests.length}`, text: digestLine(text) });
  };

  // Primary: the persisted plan (Bengali task descriptions + tool + status).
  if (Array.isArray(run.plan)) {
    for (const p of run.plan) {
      if (p === null || typeof p !== 'object') continue;
      const desc = typeof p.description === 'string' ? p.description : '';
      const tool = typeof p.tool === 'string' ? p.tool : null;
      const status = typeof p.status === 'string' ? p.status : null;
      if (!desc && !tool) continue;
      push([desc, tool ? `— ${tool}` : '', status ? ` (${status})` : ''].filter(Boolean).join(' '));
    }
  }

  // Secondary: per-tool observation rows (seq · tool · state · retries).
  if (Array.isArray(run.steps)) {
    for (const s of run.steps) {
      if (s === null || typeof s !== 'object') continue;
      const tool = typeof s.toolName === 'string' ? s.toolName : null;
      if (!tool) continue;
      const parts = [
        `ধাপ ${s.seq ?? '—'} · ${tool}`,
        typeof s.state === 'string' ? s.state : '',
        typeof s.retries === 'number' && s.retries > 0 ? `রিট্রাই ${s.retries}` : '',
      ].filter(Boolean);
      push(parts.join(' · '));
    }
  }

  // Fallback: plan/steps arrays embedded in a resultJson string (contract
  // shape) — parsed defensively, rendered as digests only.
  if (digests.length === 0 && run.resultJson) {
    try {
      const parsed: unknown = JSON.parse(run.resultJson);
      if (parsed !== null && typeof parsed === 'object') {
        for (const key of ['steps', 'plan', 'planJson', 'taskGraph']) {
          const v = (parsed as Record<string, unknown>)[key];
          if (!Array.isArray(v)) continue;
          for (const c of v) {
            if (typeof c === 'string') {
              push(c);
            } else if (c !== null && typeof c === 'object') {
              const o = c as Record<string, unknown>;
              const raw = o.title ?? o.description ?? o.step ?? o.tool ?? o.name ?? null;
              if (typeof raw === 'string') push(raw);
            }
          }
        }
      }
    } catch {
      // unparseable — honest absence
    }
  }

  return digests;
}

/** Elapsed rendering — persisted numbers only (never a client-side timer). */
function elapsedText(run: AgentRunView): string {
  if (run.elapsedMs !== null && Number.isFinite(run.elapsedMs)) {
    const s = Math.round(run.elapsedMs / 1000);
    if (s < 60) return `${s} সেকেন্ড`;
    return `${Math.floor(s / 60)} মি ${s % 60} সে`;
  }
  // Fall back to the two persisted timestamps when the engine did not store
  // a duration (both are backend facts — nothing is fabricated).
  if (run.endedAtUtc) {
    const start = new Date(run.startedAtUtc).getTime();
    const end = new Date(run.endedAtUtc).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      const s = Math.round((end - start) / 1000);
      return s < 60 ? `${s} সেকেন্ড` : `${Math.floor(s / 60)} মি ${s % 60} সে`;
    }
  }
  return '—';
}

function RunStatusIcon({ status }: { status: string }) {
  if (status === 'COMPLETED') return <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden />;
  if (status === 'FAILED') return <XCircle className="h-3 w-3 shrink-0" aria-hidden />;
  if (status === 'BLOCKED') return <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />;
  // Non-terminal (RUNNING / PLANNED / WAITING_FOR_TOOL) — the backend says
  // the run is active, so the spinner reflects persisted state, not fiction.
  return <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />;
}

function AgentRunRow({ run }: { run: AgentRunView }) {
  const [open, setOpen] = useState(false);
  const steps = parseStepDigests(run);
  const summaryBn =
    run.result && typeof run.result.summaryBn === 'string' && run.result.summaryBn.length > 0
      ? run.result.summaryBn
      : null;

  return (
    <div
      className="min-w-0 rounded-lg border border-border bg-surface p-3"
      data-testid="agent-run-row"
    >
      {/* Row 1 — task + status badge */}
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
        <p className="min-w-0 flex-1 basis-40 break-words text-xs leading-relaxed text-foreground/90">
          {run.task}
        </p>
        <Badge
          variant="outline"
          className={`shrink-0 text-[11px] ${agentRunBadgeClass(run.status)}`}
          data-testid="agent-run-status"
        >
          <RunStatusIcon status={run.status} />
          {agentRunStatusBn[run.status] ?? run.status}
        </Badge>
      </div>

      {/* Row 2 — budgets + elapsed + started (persisted numbers only) */}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1" title="ধাপ বাজেট (ব্যবহৃত/সর্বোচ্চ)">
          <Timer className="h-3 w-3 shrink-0" aria-hidden />
          ধাপ <span className="font-mono tabular-nums text-content">{run.stepsUsed}/{run.stepsMax}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1" title="টুল-কল বাজেট (ব্যবহৃত/সর্বোচ্চ)">
          <Wrench className="h-3 w-3 shrink-0" aria-hidden />
          টুল <span className="font-mono tabular-nums text-content">{run.toolCallsUsed}/{run.toolCallsMax}</span>
        </span>
        <span className="min-w-0">
          সময় <span className="font-mono tabular-nums text-content">{elapsedText(run)}</span>
        </span>
        <span className="min-w-0 basis-full break-words">
          শুরু <span className="font-mono text-content">{fmtDhaka(run.startedAtUtc)}</span>
          {run.endedAtUtc ? (
            <> · শেষ <span className="font-mono text-content">{fmtDhaka(run.endedAtUtc)}</span></>
          ) : null}
        </span>
      </div>

      {/* Row 3 — error text (persisted, honest) */}
      {run.errorText && (
        <p
          className="mt-2 break-words rounded-md border border-down/40 bg-down/10 px-2 py-1.5 text-[11px] leading-relaxed text-down"
          role="note"
        >
          {run.errorText}
        </p>
      )}

      {/* Row 3b — the backend's own Bengali result summary (persisted
       * completion evidence — displayed verbatim, never generated here). */}
      {summaryBn && (
        <p
          className="mt-2 break-words rounded-md border border-border bg-panel px-2 py-1.5 text-[11px] leading-relaxed text-content"
          data-testid="agent-run-summary"
        >
          {digestLine(summaryBn, 280)}
        </p>
      )}

      {/* Row 4 — expandable step digests (only when any were parsed) */}
      {steps.length > 0 && (
        <div className="mt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? 'এজেন্ট রানের ধাপ-তালিকা লুকান' : 'এজেন্ট রানের ধাপ-তালিকা দেখুন'}
            className="min-h-10 h-10 w-full justify-between gap-2 px-2 text-[11px] text-muted-foreground hover:text-content"
            data-testid="agent-run-steps-toggle"
          >
            <span>ধাপ-তালিকা ({steps.length}টি ডাইজেস্ট)</span>
            {open ? <ChevronUp className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          </Button>
          {open && (
            <ol className="mt-1.5 space-y-1 rounded-md border border-border bg-panel px-2 py-2">
              {steps.map((st) => (
                <li key={st.key} className="break-words text-[11px] leading-relaxed text-content">
                  <span className="mr-1 font-mono text-muted-foreground">·</span>
                  {st.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {/* Terminal runs carry their own persisted completion state — nothing
       * here is client-side animation or inference. */}
      {isAgentRunTerminal(run.status) && steps.length === 0 && !run.errorText && !summaryBn && (
        <p className="mt-1.5 break-words text-[10px] leading-relaxed text-muted-foreground">
          ফলাফল সংরক্ষিত আছে (ডাইজেস্ট নেই) — সম্পূর্ণ বিবরণ সিস্টেম লগে।
        </p>
      )}
    </div>
  );
}

export function AgentActivityPanel() {
  const [runs, setRuns] = useState<AgentRunView[] | null>(null);
  const [loading, setLoading] = useState(true);
  /** Endpoint absent / backend not finished (404 or ok:false) — honest state. */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  /** Transport-level failure (network / 5xx) — shown as an error banner. */
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<
    { kind: 'ok' | 'error'; text: string } | null
  >(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/agent/runs?limit=${RUNS_LIMIT}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) {
        // Backend subagent still finishing — honest unavailable state.
        setUnavailable('ENDPOINT_NOT_FOUND');
        setRuns(null);
        setFetchError(null);
        return;
      }
      const body = (await res.json().catch(() => null)) as AgentRunsResponse | null;
      if (!res.ok || !body || body.ok !== true) {
        const code = body?.error?.code ?? `HTTP_${res.status}`;
        setUnavailable(code);
        setRuns(null);
        setFetchError(null);
        return;
      }
      setUnavailable(null);
      setFetchError(null);
      setRuns(Array.isArray(body.runs) ? body.runs : []);
    } catch {
      setFetchError('NETWORK_ERROR');
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll loop — cleanup cancels the interval; the panel unmounts when the
  // সিস্টেম view is left, so polling only happens while it is visible.
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  const triggerTask = useCallback(async () => {
    setTriggering(true);
    setTriggerResult(null);
    try {
      const res = await fetch('/api/agent/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: TRIGGER_TASK }),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 404) {
        setTriggerResult({
          kind: 'error',
          text: 'এজেন্ট API এখনো চালু নেই (404) — ব্যাকএন্ড প্রস্তুত হলে এখানে রান দেখা যাবে।',
        });
      } else if (res.status === 403) {
        setTriggerResult({
          kind: 'error',
          text: 'ট্রিগার অনুমোদিত নয় (403) — একই-উৎস (same-origin) ব্রাউজার থেকে চালাতে হবে।',
        });
      } else if (res.status === 429) {
        setTriggerResult({
          kind: 'error',
          text: 'রেট লিমিট (429) — খুব ঘন ঘন অনুরোধ; কিছুক্ষণ পরে আবার চেষ্টা করুন।',
        });
      } else if (res.status >= 500) {
        setTriggerResult({
          kind: 'error',
          text: `সার্ভারে ত্রুটি (HTTP ${res.status}) — রান তৈরি হয়নি; কিছু বানানো হয়নি।`,
        });
      } else if (res.ok) {
        setTriggerResult({
          kind: 'ok',
          text: 'এজেন্ট টাস্ক শুরু হয়েছে — অবস্থা ১০ সেকেন্ডের মধ্যে এই তালিকায় দেখা যাবে।',
        });
      } else {
        setTriggerResult({
          kind: 'error',
          text: `অপ্রত্যাশিত সাড়া (HTTP ${res.status})।`,
        });
      }
    } catch (e) {
      setTriggerResult({
        kind: 'error',
        text: `নেটওয়ার্ক ত্রুটি — অনুরোধ পাঠানো যায়নি (${e instanceof Error ? e.message : 'unknown'})।`,
      });
    } finally {
      setTriggering(false);
      await load();
    }
  }, [load]);

  return (
    <section
      aria-label="এজেন্ট অ্যাক্টিভিটি"
      className="flex flex-col rounded-xl border border-border bg-panel"
      data-testid="agent-activity-panel"
    >
      {/* Header — icon + title + honest poll cadence */}
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Bot className="h-4 w-4 shrink-0 text-sun" aria-hidden />
        <h2 className="min-w-0 text-sm font-semibold text-foreground">এজেন্ট অ্যাক্টিভিটি</h2>
        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          ১০ সেকেন্ড পোল · সংরক্ষিত স্ট্যাটাস
        </span>
      </div>

      <div className="flex-1 space-y-3 p-4">
        {fetchError && (
          <p
            role="alert"
            className="break-words rounded-lg border border-down/40 bg-down/10 p-3 text-xs leading-relaxed text-down"
          >
            এজেন্ট-রান তালিকা আনা যায়নি (নেটওয়ার্ক ত্রুটি) — ১০ সেকেন্ড পরে আবার চেষ্টা হবে।
            তালিকা না এলে কিছু বানানো হয় না।
          </p>
        )}

        {loading && runs === null && unavailable === null && !fetchError ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : unavailable ? (
          /* Endpoint absent / refused — honest unavailable card, no crash */
          <div
            className="rounded-lg border border-dashed border-border-strong/60 p-4 text-center"
            data-testid="agent-activity-unavailable"
          >
            <Bot className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
            <p className="mt-2 break-words text-xs leading-relaxed text-muted-foreground">
              এজেন্ট-রান API এখন অনুপলব্ধ{' '}
              (<span className="font-mono">{unavailable}</span>) — ব্যাকএন্ড প্রস্তুত হলে এখানে
              সংরক্ষিত রান-তালিকা দেখা যাবে। কিছু বানানো হয়নি।
            </p>
          </div>
        ) : runs !== null && runs.length === 0 ? (
          /* Honest empty state + the one safe read-only trigger */
          <div
            className="rounded-lg border border-dashed border-border-strong/60 p-4 text-center"
            data-testid="agent-activity-empty"
          >
            <Bot className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
            <p className="mt-2 break-words text-xs leading-relaxed text-muted-foreground">
              এজেন্ট রান নেই — এখনো কোনো টাস্ক সংরক্ষিত হয়নি।
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void triggerTask()}
              disabled={triggering}
              className="mt-3 min-h-10 w-full gap-1.5 border-brand/40 bg-brand/10 text-brand hover:bg-brand/20"
              data-testid="agent-activity-trigger"
              aria-label="এজেন্ট টাস্ক চালান — বাজারের বর্তমান অবস্থা দেখাও"
            >
              {triggering ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden />
              )}
              এজেন্ট টাস্ক চালান (বাজার অবস্থা)
            </Button>
            <p className="mt-1.5 break-words text-[10px] leading-relaxed text-muted-foreground">
              রিড-ওনলি টাস্ক — বাজারের অবস্থা দেখে জানাবে; কোনো অর্ডার বা পরিবর্তন করতে পারে না।
            </p>
          </div>
        ) : runs !== null && runs.length > 0 ? (
          <>
            <div className="max-h-96 space-y-2 overflow-y-auto pr-1 custom-scrollbar">
              {runs.map((run) => (
                <AgentRunRow key={run.id} run={run} />
              ))}
            </div>
            {/* When runs exist the trigger stays available compactly — the
             * user may start another read-only market-status task anytime. */}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void triggerTask()}
              disabled={triggering}
              className="min-h-10 h-10 w-full gap-1.5 text-[11px] text-muted-foreground hover:text-content"
              data-testid="agent-activity-trigger-inline"
              aria-label="আরেকটি এজেন্ট টাস্ক চালান — বাজারের বর্তমান অবস্থা দেখাও"
            >
              {triggering ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden />
              )}
              আরেকটি টাস্ক চালান (বাজার অবস্থা)
            </Button>
          </>
        ) : null}

        {triggerResult && (
          <p
            role="status"
            className={`break-words rounded-lg border p-2.5 text-[11px] leading-relaxed ${
              triggerResult.kind === 'ok'
                ? 'border-up/40 bg-up/10 text-up'
                : 'border-down/40 bg-down/10 text-down'
            }`}
            data-testid="agent-activity-trigger-result"
          >
            {triggerResult.text}
          </p>
        )}
      </div>
    </section>
  );
}
