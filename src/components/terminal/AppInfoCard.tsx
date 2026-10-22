'use client';

/**
 * XAUUSD AI Trading Agent — App identity card (Task 40).
 * ----------------------------------------------------------------------------
 * The former three-line footer status block (phase posture · tech stack ·
 * scalper status) now lives HERE, at the top of the সিস্টেম (system) tab —
 * the persistent bottom area stays slim and no longer eats screen space.
 * Every value comes from the real /api/health payload; the fail-closed
 * default shows the locked posture when health is unavailable (nothing is
 * ever fabricated or optimistically unlocked).
 */

import { Activity, Cpu, ShieldCheck, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { HealthReport } from '@/lib/dashboard/types';

export function AppInfoCard({ health }: { health: HealthReport | null }) {
  // Fail-closed display default — mirrors TerminalHeader/ExecutionPanel.
  const locked = health?.executionLocked ?? true;

  return (
    <section
      aria-label="অ্যাপ পরিচিতি"
      data-testid="app-info-card"
      className="rounded-xl border border-border bg-panel"
    >
      {/* Header — app identity + live posture badges */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <img
          src="/gold-icon.svg"
          alt=""
          aria-hidden
          className="h-5 w-5 shrink-0"
        />
        <h3 className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
          XAUUSD <span className="text-brand">AI Trading Agent</span>
        </h3>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <Badge
            variant="outline"
            className="border-border-strong/50 bg-muted font-mono text-[10px] text-content"
            title="বর্তমান ফেজ (backend /api/health)"
          >
            {health?.phaseLabel ?? 'Phase —'}
          </Badge>
          <Badge
            variant="outline"
            className={`gap-1 text-[10px] ${
              locked
                ? 'border-down/40 bg-down/10 text-down'
                : 'border-up/40 bg-up/10 text-up'
            }`}
            data-execution-locked={locked ? 'true' : 'false'}
            title={health?.executionReason ?? 'Execution locked — read-only by design'}
          >
            <ShieldCheck className="h-3 w-3" aria-hidden />
            {locked ? 'রিড-ওনলি মোড' : 'লাইভ ডেমো সচল'}
          </Badge>
        </span>
      </div>

      {/* Body — the three former footer lines, verbatim posture logic */}
      <dl className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-border/60 bg-surface p-3">
          <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Activity className="h-3.5 w-3.5 shrink-0 text-sun" aria-hidden />
            ট্রেডিং মোড
          </dt>
          <dd className="mt-1.5 text-xs leading-relaxed text-content">
            {health && !health.executionLocked
              ? 'লাইভ ডেমো ট্রেডিং সচল — সিগন্যাল অনুযায়ী অর্ডার যায়'
              : 'রিড-ওনলি মোড'}
          </dd>
        </div>
        <div className="rounded-lg border border-border/60 bg-surface p-3">
          <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Zap className="h-3.5 w-3.5 shrink-0 text-sun" aria-hidden />
            স্ক্যাল্পার সিগন্যাল
          </dt>
          <dd className="mt-1.5 text-xs leading-relaxed text-content">
            {health && !health.executionLocked
              ? 'স্ক্যাল্পার M1·M5·M15 সিগন্যাল সচল — রিস্ক-চেক পাস করলে অটো-অর্ডার কার্যকর হয়'
              : `Live Trading: Phase ${health?.executionGatePhase ?? 11} গেট পাস হলে চালু হবে`}
          </dd>
        </div>
        <div className="rounded-lg border border-border/60 bg-surface p-3">
          <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Cpu className="h-3.5 w-3.5 shrink-0 text-sun" aria-hidden />
            প্রযুক্তি স্ট্যাক
          </dt>
          <dd className="mt-1.5 break-words font-mono text-[11px] leading-relaxed text-content">
            Next.js 16 · TypeScript · Prisma/SQLite · z-ai-web-dev-sdk (glm-4-plus)
          </dd>
        </div>
        <div className="rounded-lg border border-border/60 bg-surface p-3">
          <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-sun" aria-hidden />
            নিরাপত্তা
          </dt>
          <dd className="mt-1.5 text-xs leading-relaxed text-content">
            অর্ডার এক্সিকিউশন চারটি fail-closed সুইচের পেছনে তালাবদ্ধ — UI কখনো
            ব্যাকএন্ড অনুমোদন বাইপাস করতে পারে না।
          </dd>
        </div>
      </dl>
    </section>
  );
}
