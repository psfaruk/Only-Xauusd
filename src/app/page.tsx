'use client';

/**
 * XAUUSD AI Trading Agent — Phase 1 Dashboard (the only user-visible route)
 * ----------------------------------------------------------------------------
 * Live Phase 1 audit report: environment evidence, architecture, GLM
 * verification (with a live re-verify button), MT5 feasibility, database
 * model map, security & acceptance checklist, and the SystemEvent audit trail.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  Cpu,
  Database,
  FileLock2,
  Globe,
  Languages,
  LineChart,
  Loader2,
  LockKeyhole,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useToast } from '@/hooks/use-toast';

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  phase: number;
  phaseLabel: string;
  tradingMode: string;
  executionLocked: boolean;
  executionReason: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: { database: 'ok' | 'fail'; glm: 'verified' | 'failed' | 'unverified'; executionLock: 'engaged' | 'DANGER' };
  runtime: {
    node: string;
    platform: string;
    cpuCores: number;
    memoryTotalMb: number;
    memoryFreeMb: number;
    processRssMb: number;
  };
  glm: { status: string; lastCheckedAt: string | null };
  auditEventCount: number;
}

interface EnvCheck {
  id: string;
  group: 'runtime' | 'network' | 'mt5' | 'glm' | 'database';
  label: string;
  evidence: string;
  status: 'pass' | 'warn' | 'fail';
  note?: string;
}

interface AuditResponse {
  auditPerformedAt: string;
  generatedAt: string;
  config: {
    version: string;
    phase: number;
    tradingMode: string;
    executionEnabled: boolean;
    executionReason: string;
    symbol: string;
  };
  live: {
    node: string;
    bun: string | null;
    platform: string;
    arch: string;
    cpuCores: number;
    memoryTotalMb: number;
    memoryFreeMb: number;
    uptimeSeconds: number;
    timestamp: string;
  };
  environmentChecks: EnvCheck[];
  glm: {
    sdk: string;
    model: string;
    auth: string;
    verifiedAt: string;
    capabilities: { chatCompletion: boolean; bengali: boolean; toolCalling: boolean; toolCallRoundTripMs: number };
    sample: { prompt: string; response: string };
    liveStatus: { status: string; lastCheckedAt: string | null };
  };
  mt5: {
    feasibleInSandbox: boolean;
    findings: string[];
    bridgeOptions: { id: string; title: string; detail: string }[];
    phase2Plan: string[];
  };
  database: {
    provider: string;
    models: { name: string; purpose: string; phase: number; status: 'active' | 'planned' }[];
  };
  tools: { total: number; active: string[]; planned: { name: string; phase: number }[] };
  security: { measure: string; detail: string }[];
  architecture: { id: string; title: string; tech: string; detail: string; phase: string }[];
  repositoryTree: string;
  acceptanceChecklist: { id: string; label: string; done: boolean }[];
  events: { id: string; level: string; category: string; code: string; message: string; createdAt: string }[];
}

interface VerifyTest {
  id: string;
  name: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
  sample?: string;
}

interface VerifyResponse {
  verified: boolean;
  model: string;
  totalLatencyMs: number;
  checkedAt: string;
  tests: VerifyTest[];
}

// ---------------------------------------------------------------------------
// Phase 3 — market data API shapes (/api/data/*)
// ---------------------------------------------------------------------------

type QualityState = 'VALID' | 'WARNING' | 'INVALID' | 'STALE' | 'MISSING' | 'UNAVAILABLE';

interface TfReadiness {
  timeframe: string;
  state: QualityState;
  lastClosedCandleTimeUtc: string | null;
  lastClosedCandleAgeSeconds: number | null;
  stalenessThresholdSeconds: number;
  scannedCandles: number;
  missingCandles: number;
  possibleClosureGaps: number;
  errorCodes: string[];
}

interface MarketStatusResponse {
  ok: true;
  symbol: string;
  bridge: {
    configured: boolean;
    reachable: boolean;
    probedAtUtc: string;
    health: { ok: boolean; service: string | null; connected: boolean | null; uptimeSec: number | null } | null;
    status: { connected: boolean; source: string; server: string | null; latencyMs: number | null; reason: string | null } | null;
    error: { code: string; message: string } | null;
  };
  readiness: {
    ready: boolean;
    symbol: string;
    timeframesChecked: string[];
    source: string | null;
    checkedAtUtc: string;
    lastTickTimeUtc: string | null;
    lastClosedCandleTimeUtc: string | null;
    dataAgeSeconds: number | null;
    qualityState: QualityState;
    errorCodes: string[];
    tick: {
      state: QualityState;
      bid: string | null;
      ask: string | null;
      spread: string | null;
      lastTickTimeUtc: string | null;
      ageSeconds: number | null;
      stalenessThresholdSeconds: number;
      errorCodes: string[];
    };
    timeframes: TfReadiness[];
  };
  sync: {
    running: boolean;
    lastRun: SyncRunSummary | null;
    lastSuccess: SyncRunSummary | null;
    lastFailure: SyncRunSummary | null;
  };
  config: {
    symbols: string[];
    timeframes: string[];
    staleTickSec: number;
    staleTfSec: Record<string, number>;
    ingestDemo: boolean;
    syncIntervalMs: number;
  };
  generatedAtUtc: string;
}

interface SyncRunSummary {
  id: string;
  mode: string;
  source: string;
  symbol: string;
  timeframes: string[];
  status: string;
  startedAtUtc: string;
  endedAtUtc: string | null;
  durationMs: number | null;
  requested: number;
  received: number;
  inserted: number;
  updated: number;
  rejected: number;
  duplicates: number;
  errorCode: string | null;
  errorMessage: string | null;
}

interface QualityIssueRow {
  id: string;
  checkType: string;
  timeframe: string | null;
  severity: string;
  errorCode: string;
  targetTimeUtc: string | null;
  details: { detail?: string };
  checkedAtUtc: string;
}

interface QualityResponse {
  ok: true;
  symbol: string;
  openIssues: QualityIssueRow[];
  generatedAtUtc: string;
}

/** Bengali renderings of the stable machine-readable error codes. */
const bnErrorText: Record<string, string> = {
  BRIDGE_NOT_CONFIGURED: 'MT5 ব্রিজ কনফিগার করা হয়নি — MT5_BRIDGE_URL ফাঁকা আছে।',
  BRIDGE_UNREACHABLE: 'ব্রিজ সার্ভারে পৌঁছানো যাচ্ছে না।',
  BRIDGE_TIMEOUT: 'ব্রিজ সময়মতো সাড়া দেয়নি (টাইমআউট)।',
  BRIDGE_AUTH_FAILED: 'ব্রিজ অনুরোধ প্রত্যাখ্যান করেছে (অননুমোদিত)।',
  BRIDGE_RATE_LIMITED: 'ব্রিজের রেট লিমিট ছুঁয়ে গেছে — কিছুক্ষণ পরে আবার চেষ্টা হবে।',
  BRIDGE_BAD_RESPONSE: 'ব্রিজ থেকে প্রত্যাশিত ফরম্যাটে উত্তর আসেনি।',
  BRIDGE_PARTIAL_RESPONSE: 'ব্রিজ আংশিক উত্তর দিয়েছে — কিছু ডেটা পাওয়া যায়নি।',
  SOURCE_DEMO: 'ব্রিজ এখন স্পষ্টভাবে চিহ্নিত ডেমো ডেটা দিচ্ছে — এটি লাইভ বাজার নয়।',
  SOURCE_DISCONNECTED: 'MT5 টার্মিনাল সংযোগ বিচ্ছিন্ন আছে।',
  SYMBOL_NOT_ALLOWED: 'এই সিম্বলটি অনুমোদিত তালিকায় নেই।',
  SYMBOL_NOT_FOUND: 'ব্রিজে এই সিম্বলটি পাওয়া যায়নি।',
  TIMEFRAME_NOT_ALLOWED: 'এই টাইমফ্রেমটি অনুমোদিত তালিকায় নেই।',
  DATA_MISSING: 'প্রয়োজনীয় ডেটা এখনো সংরক্ষিত হয়নি।',
  DATA_STALE: 'সংরক্ষিত ডেটা পুরোনো হয়ে গেছে।',
  TICK_STALE: 'সর্বশেষ টিক পুরোনো হয়ে গেছে।',
  TICK_CROSSED: 'টিকের Bid/Ask অসঙ্গতিপূর্ণ (Ask < Bid)।',
  TICK_NON_POSITIVE: 'টিকের দাম শূন্য বা ঋণাত্মক — প্রত্যাখ্যাত।',
  GAP_POSSIBLE: 'সম্ভবত একটি ক্যান্ডেল অনুপস্থিত — বাজার ছুটি (অজানা সময়সূচি) বা ডেটা ত্রুটি হতে পারে।',
  GAP_MARKET_LIKELY_CLOSED: 'সম্ভাব্য ফাঁক — সম্ভবত বাজার বন্ধ ছিল (উইকেন্ড/বিরতি, আনুমানিক)।',
  SPEC_MISSING: 'সিম্বল স্পেসিফিকেশন এখনো যাচাই করা হয়নি।',
  CANDLE_OHLC_INCONSISTENT: 'ক্যান্ডেলের OHLC মান পরস্পরবিরোধী।',
  CANDLE_NON_FINITE: 'ক্যান্ডেলের দাম সংখ্যা নয় (NaN/অসীম)।',
  CANDLE_NON_POSITIVE: 'ক্যান্ডেলের দাম শূন্য বা ঋণাত্মক।',
  CANDLE_DUPLICATE_KEY: 'একই সময়ের ক্যান্ডেল একাধিকবার এসেছে — ডুপ্লিকেট গণনা করা হয়েছে।',
  CANDLE_OUT_OF_ORDER: 'ক্যান্ডেলগুলো সময় অনুযায়ী সাজানো ছিল না — সাজিয়ে নেওয়া হয়েছে।',
  CANDLE_PRICE_PRECISION_ANOMALY: 'দামে প্রত্যাশিত দশমিক-অঙ্কের চেয়ে বেশি অঙ্ক এসেছে — সতর্কতা সহ সংরক্ষিত।',
  DB_TX_FAILED: 'ডেটাবেস লেনদেন ব্যর্থ হয়েছে।',
  DB_ERROR: 'ডেটাবেস ত্রুটি।',
  SYNC_IN_PROGRESS: 'একটি সিঙ্ক ইতিমধ্যেই চলছে — নতুনটি বাতিল।',
};

function bnForCode(code: string): string {
  return bnErrorText[code] ?? `অজানা সমস্যা (${code})।`;
}

function fmtAge(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec} সেকেন্ড`;
  if (sec < 3600) return `${Math.floor(sec / 60)} মিনিট`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ঘণ্টা`;
  return `${Math.floor(sec / 86400)} দিন`;
}

function qualityStateBadgeClass(state: string): string {
  switch (state) {
    case 'VALID':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400';
    case 'WARNING':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'STALE':
      return 'border-orange-500/40 bg-orange-500/10 text-orange-400';
    case 'MISSING':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'INVALID':
      return 'border-red-600/50 bg-red-600/15 text-red-300';
    default:
      return 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400'; // UNAVAILABLE
  }
}

const qualityStateBn: Record<string, string> = {
  VALID: 'বৈধ',
  WARNING: 'সতর্কতা',
  INVALID: 'অবৈধ',
  STALE: 'পুরোনো',
  MISSING: 'অনুপস্থিত',
  UNAVAILABLE: 'অনুপলব্ধ',
};

function syncStatusBn(status: string): string {
  switch (status) {
    case 'success': return 'সফল';
    case 'partial': return 'আংশিক';
    case 'failed': return 'ব্যর্থ';
    case 'skipped': return 'স্কিপ';
    case 'running': return 'চলছে';
    default: return status;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dhakaDateTime = new Intl.DateTimeFormat('bn-BD', {
  timeZone: 'Asia/Dhaka',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function fmtDhaka(iso: string): string {
  try {
    return dhakaDateTime.format(new Date(iso));
  } catch {
    return iso;
  }
}

function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const groupLabel: Record<EnvCheck['group'], string> = {
  runtime: 'রানটাইম',
  network: 'নেটওয়ার্ক',
  glm: 'GLM',
  mt5: 'MT5',
  database: 'ডেটাবেস',
};

function useDhakaClock(): string | null {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('bn-BD', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
    const tick = () => setNow(fmt.format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function StatusIcon({ status }: { status: 'pass' | 'warn' | 'fail' | 'active' | 'planned' | string }) {
  if (status === 'pass' || status === 'active' || status === 'verified')
    return <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />;
  if (status === 'fail') return <XCircle className="h-4 w-4 text-red-400" aria-hidden />;
  return <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />;
}

function levelBadgeClass(level: string): string {
  switch (level) {
    case 'error':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'warn':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'info':
      return 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300';
    default:
      return 'border-zinc-700 bg-zinc-800/50 text-zinc-500';
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Phase1Dashboard() {
  const { toast } = useToast();
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [marketStatus, setMarketStatus] = useState<MarketStatusResponse | null>(null);
  const [marketQuality, setMarketQuality] = useState<QualityResponse | null>(null);
  const [syncing, setSyncing] = useState(false);
  const clock = useDhakaClock();

  const refresh = useCallback(async () => {
    try {
      const [hRes, aRes, mRes, qRes] = await Promise.all([
        fetch('/api/health', { cache: 'no-store' }),
        fetch('/api/audit/environment', { cache: 'no-store' }),
        fetch('/api/data/status', { cache: 'no-store' }).catch(() => null),
        fetch('/api/data/quality', { cache: 'no-store' }).catch(() => null),
      ]);
      if (!hRes.ok && !aRes.ok) throw new Error('API unreachable');
      if (hRes.ok) setHealth((await hRes.json()) as HealthReport);
      if (aRes.ok) setAudit((await aRes.json()) as AuditResponse);
      if (mRes && mRes.ok) setMarketStatus((await mRes.json()) as MarketStatusResponse);
      if (qRes && qRes.ok) setMarketQuality((await qRes.json()) as QualityResponse);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const runVerify = useCallback(async () => {
    setVerifying(true);
    try {
      const res = await fetch('/api/ai/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (res.status === 429) {
        const body = (await res.json()) as { message?: string };
        toast({
          title: 'রেট লিমিট',
          description: body.message ?? 'অনুগ্রহ করে কিছুক্ষণ পরে আবার চেষ্টা করুন।',
          variant: 'destructive',
        });
        return;
      }
      const body = (await res.json()) as VerifyResponse;
      setVerifyResult(body);
      if (body.verified) {
        toast({ title: 'GLM যাচাই সফল', description: `মডেল ${body.model} · ${body.totalLatencyMs}ms` });
      } else {
        toast({
          title: 'GLM যাচাই ব্যর্থ',
          description: 'বিস্তারিত GLM ট্যাবে দেখুন।',
          variant: 'destructive',
        });
      }
      await refresh(); // pull fresh health + audit trail rows
    } catch (e) {
      toast({
        title: 'যাচাই চালানো যায়নি',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      });
    } finally {
      setVerifying(false);
    }
  }, [refresh, toast]);

  const runSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const symbol = marketStatus?.symbol ?? 'XAUUSDm';
      const res = await fetch('/api/data/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, mode: 'manual' }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        outcome?: SyncRunSummary & { status: string };
        error?: { code: string; message: string };
      };
      if (res.status === 429) {
        toast({
          title: 'রেট লিমিট',
          description: 'খুব ঘন ঘন সিঙ্ক চালানো হচ্ছে — কিছুক্ষণ পরে চেষ্টা করুন।',
          variant: 'destructive',
        });
      } else if (body.ok && body.outcome?.status === 'success') {
        toast({
          title: 'সিঙ্ক সফল',
          description: `নতুন ${body.outcome.inserted}টি, আপডেট ${body.outcome.updated}টি ক্যান্ডেল।`,
        });
      } else if (body.ok && body.outcome) {
        toast({
          title: `সিঙ্ক ${syncStatusBn(body.outcome.status)}`,
          description: body.outcome.errorCode ? bnForCode(body.outcome.errorCode) : 'কিছু টাইমফ্রেম সম্পূর্ণ হয়নি।',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'সিঙ্ক ব্যর্থ',
          description: body.error ? bnForCode(body.error.code) : 'অজানা ত্রুটি।',
          variant: 'destructive',
        });
      }
      await refresh();
    } catch (e) {
      toast({
        title: 'সিঙ্ক চালানো যায়নি',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      });
    } finally {
      setSyncing(false);
    }
  }, [marketStatus?.symbol, refresh, toast]);

  const checkSummary = useMemo(() => {
    if (!audit) return null;
    const c = { pass: 0, warn: 0, fail: 0 };
    for (const e of audit.environmentChecks) c[e.status] += 1;
    return c;
  }, [audit]);

  const glmLiveStatus = health?.glm.status ?? 'unverified';

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100 font-sans">
      {/* ---------------------------------------------------------------- Header */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/75">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
          <div className="flex h-16 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <img src="/gold-icon.svg" alt="XAUUSD AI Trading Agent logo" className="h-9 w-9 shrink-0" />
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold sm:text-base text-zinc-50">
                  XAUUSD AI Trading Agent
                  <span className="ml-2 hidden text-xs font-normal text-zinc-400 md:inline">
                    GLM-চালিত হাইব্রিড মার্কেট-স্ট্রাকচার অ্যানালিসিস
                  </span>
                </h1>
                <p className="truncate text-[11px] text-zinc-500">
                  Exness MT5 টার্গেট · ডিটারমিনিস্টিক ইঞ্জিন + AI রিভিউ · Risk Gate সর্বোচ্চ কর্তৃত্ব
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <Badge
                variant="outline"
                className={`gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-400 ${
                  health?.status === 'degraded' ? 'border-amber-500/40 bg-amber-500/10 text-amber-400' : ''
                }`}
              >
                <Activity className="h-3 w-3" aria-hidden />
                {health ? (health.status === 'ok' ? 'সিস্টেম সচল' : 'সতর্কতা প্রয়োজন') : '...'}
              </Badge>
              <span className="hidden text-xs tabular-nums text-zinc-400 sm:inline" suppressHydrationWarning>
                ঢাকা {clock ?? '--:--:--'}
              </span>
              <Badge variant="outline" className="hidden border-amber-500/40 bg-amber-500/10 text-amber-400 md:inline-flex">
                Phase 3 / 12
              </Badge>
            </div>
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------- Main */}
      <main className="flex-1 w-full">
        <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6">
          {/* Read-only banner */}
          <div
            role="alert"
            className="gold-grid-bg flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <FileLock2 className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
              <div>
                <p className="text-sm font-semibold text-amber-200">
                  Read-Only Mode সক্রিয় — কোনো অর্ডার পাঠানো হবে না
                </p>
                <p className="text-xs leading-relaxed text-zinc-400">
                  Phase 1 শুধুই অডিট ও ফাউন্ডেশন। Execution কোড-লেভেলে তালাবন্ধ —{' '}
                  {health?.executionReason ?? 'Phase 11 গেটের আগে খোলা যাবে না।'}
                </p>
              </div>
            </div>
            <Badge variant="outline" className="w-fit shrink-0 gap-1.5 border-red-500/40 bg-red-500/10 text-red-400">
              <LockKeyhole className="h-3 w-3" aria-hidden /> Order Execution: LOCKED
            </Badge>
          </div>

          {/* KPI cards */}
          <section aria-label="সারসংক্ষেপ" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                key: 'glm',
                icon: Bot,
                title: 'GLM AI Access',
                value: 'glm-4-plus',
                state: glmLiveStatus === 'verified' ? 'verified' : 'pending',
                stateClass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
                lines: ['চ্যাট ✓ বাংলা ✓ টুল-কলিং ✓ (৭২০ms)', `সর্বশেষ যাচাই: ${health?.glm.lastCheckedAt ? fmtDhaka(health.glm.lastCheckedAt) : 'এখনো হয়নি'}`],
              },
              {
                key: 'runtime',
                icon: Cpu,
                title: 'Runtime (Sandbox)',
                value: 'Debian 13 · Node 24',
                state: 'সচল',
                stateClass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
                lines: [
                  `Next.js 16 · Bun ${audit?.live.bun ?? '1.3'} · 2 vCPU`,
                  `আপটাইম ${health ? fmtUptime(health.uptimeSeconds) : '—'} · DB ${health?.checks.database ?? '—'}`,
                ],
              },
              {
                key: 'mt5',
                icon: Network,
                title: 'MT5 Bridge',
                value: marketStatus
                  ? marketStatus.bridge.configured
                    ? marketStatus.bridge.reachable
                      ? `${marketStatus.symbol} · ${marketStatus.bridge.status?.source ?? '…'}`
                      : 'ব্রিজ অনুপলব্ধ'
                    : 'কনফিগার করা হয়নি'
                  : '…',
                state: marketStatus
                  ? marketStatus.bridge.configured
                    ? marketStatus.bridge.reachable && marketStatus.bridge.status?.connected
                      ? marketStatus.bridge.status?.source === 'demo' ? 'ডেমো ফিড' : 'সংযুক্ত'
                      : 'সংযোগ নেই'
                    : 'অনুপলব্ধ'
                  : '…',
                stateClass: marketStatus
                  ? marketStatus.bridge.configured && marketStatus.bridge.reachable && marketStatus.bridge.status?.connected
                    ? marketStatus.bridge.status?.source === 'demo'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                      : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                  : 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400',
                lines: [
                  `ডেটা অবস্থা: ${marketStatus ? qualityStateBn[marketStatus.readiness.qualityState] : '—'} · প্রস্তুত: ${marketStatus?.readiness.ready ? 'হ্যাঁ' : 'না'}`,
                  'ওয়েব-টার্মিনাল প্রোটোকল প্রমাণিত · ব্রিজ বসানো Phase 2-এর কাজ',
                ],
              },
              {
                key: 'exec',
                icon: LockKeyhole,
                title: 'Order Execution',
                value: 'Read-Only',
                state: 'LOCKED',
                stateClass: 'border-red-500/40 bg-red-500/10 text-red-400',
                lines: ['TRADING_PHASE=1 · চার-সুইচ গেট (Phase ≥ 11)', 'Live/Demo অর্ডার: Phase 11+ অনুমোদনসাপেক্ষ'],
              },
            ].map((k, i) => (
              <motion.div
                key={k.key}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: i * 0.06 }}
              >
                <Card className="h-full border-zinc-800 bg-zinc-900/40">
                  <CardContent className="p-4 sm:p-5">
                    {loading && !audit ? (
                      <div className="space-y-3">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-6 w-40" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-2/3" />
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
                            <k.icon className="h-4 w-4 text-amber-400" aria-hidden />
                            {k.title}
                          </span>
                          <Badge variant="outline" className={k.stateClass}>
                            {k.state}
                          </Badge>
                        </div>
                        <p className="mt-2 font-mono text-sm font-semibold text-zinc-50">{k.value}</p>
                        <div className="mt-2 space-y-1">
                          {k.lines.map((line) => (
                            <p key={line} className="text-xs leading-relaxed text-zinc-400">
                              {line}
                            </p>
                          ))}
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </section>

          {loadError && (
            <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
              API লোড করা যায়নি: {loadError} —{' '}
              <Button variant="outline" size="sm" className="ml-2" onClick={() => void refresh()}>
                আবার চেষ্টা করুন
              </Button>
            </div>
          )}

          {/* Report tabs */}
          <Tabs defaultValue="audit" className="space-y-4">
            <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-zinc-900/60 p-1">
              <TabsTrigger value="audit" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">নিরীক্ষণ</TabsTrigger>
              <TabsTrigger value="market" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">মার্কেট ডেটা</TabsTrigger>
              <TabsTrigger value="arch" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">আর্কিটেকচার</TabsTrigger>
              <TabsTrigger value="glm" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">GLM যাচাই</TabsTrigger>
              <TabsTrigger value="mt5" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">MT5 প্রতিবেদন</TabsTrigger>
              <TabsTrigger value="db" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">ডেটাবেস</TabsTrigger>
              <TabsTrigger value="sec" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">নিরাপত্তা ও চেকলিস্ট</TabsTrigger>
            </TabsList>

            {/* ------------------------------------------------ Tab: audit */}
            <TabsContent value="audit" className="space-y-4">
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    পরিবেশ নিরীক্ষণ — প্রকৃত কমান্ড প্রমাণ
                    {checkSummary && (
                      <span className="flex gap-1.5">
                        <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">{checkSummary.pass} pass</Badge>
                        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-400">{checkSummary.warn} warn</Badge>
                        <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-400">{checkSummary.fail} fail</Badge>
                      </span>
                    )}
                  </CardTitle>
                  <p className="text-xs text-zinc-500">
                    প্রতিটি ফলাফল সরাসরি কমান্ড এক্সিকিউশন থেকে — {audit ? fmtDhaka(audit.auditPerformedAt) : ''} (UTC অডিট সময়)। কিছুই আন্দাজ নয়।
                  </p>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-zinc-800 hover:bg-transparent">
                          <TableHead className="pl-4 sm:pl-6">অবস্থা</TableHead>
                          <TableHead>বিষয়</TableHead>
                          <TableHead className="min-w-[280px]">প্রমাণ (কমান্ড আউটপুট)</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(audit?.environmentChecks ?? []).map((c) => (
                          <TableRow key={c.id} className="border-zinc-800/70">
                            <TableCell className="pl-4 sm:pl-6">
                              <span className="flex items-center gap-1.5">
                                <StatusIcon status={c.status} />
                                <Badge variant="outline" className="text-zinc-400">{groupLabel[c.group]}</Badge>
                              </span>
                            </TableCell>
                            <TableCell>
                              <p className="text-sm font-medium text-zinc-200">{c.label}</p>
                              {c.note && <p className="mt-0.5 max-w-md text-xs leading-relaxed text-zinc-500">{c.note}</p>}
                            </TableCell>
                            <TableCell className="max-w-[440px] break-words font-mono text-xs text-zinc-400">{c.evidence}</TableCell>
                          </TableRow>
                        ))}
                        {loading && !audit && (
                          <TableRow>
                            <TableCell colSpan={3} className="p-6">
                              <Skeleton className="h-5 w-full" />
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ------------------------------------------------ Tab: market data (Phase 3) */}
            <TabsContent value="market" className="space-y-4">
              {/* Fail-closed banner */}
              {marketStatus && (!marketStatus.bridge.configured || !marketStatus.bridge.reachable || !marketStatus.bridge.status?.connected) && (
                <div
                  role="alert"
                  className="flex flex-col gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden />
                    <div>
                      <p className="text-sm font-semibold text-red-200">ডেটা পাওয়া যাচ্ছে না</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
                        {marketStatus.bridge.error
                          ? `${bnForCode(marketStatus.bridge.error.code)} `
                          : 'MT5 ব্রিজ এখনো বসানো হয়নি (Phase 2 ডেলিভারেবল)। '}
                        ডেটা পাইপলাইন fail-closed — কোনো ডেটা বানানো হবে না; ব্রিজ সচল হলে স্বয়ংক্রিয়ভাবে যুক্ত হবে।
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline" className="w-fit shrink-0 border-zinc-600/50 bg-zinc-700/20 font-mono text-zinc-400">
                    {marketStatus.bridge.error?.code ?? 'BRIDGE_NOT_DEPLOYED'}
                  </Badge>
                </div>
              )}

              {/* Demo-source banner (clearly labelled) */}
              {marketStatus?.bridge.status?.source === 'demo' && (
                <div
                  role="status"
                  className="flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
                >
                  <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" aria-hidden />
                  <p className="text-xs leading-relaxed text-amber-200">
                    <span className="font-semibold">ডেমো ডেটা চিহ্নিত:</span> ব্রিজ কোনো ক্রেডেনশিয়াল ছাড়া স্পষ্টভাবে লেবেল-করা সিন্থেটিক ফিড দিচ্ছে।
                    এটি লাইভ বাজার নয় — বিশ্লেষণ-প্রস্তুতি কখনোই “প্রস্তুত” হবে না এবং কোনো দাম লাইভ হিসেবে দেখানো হবে না।
                  </p>
                </div>
              )}

              {/* Bridge + tick cards */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <Network className="h-4 w-4 text-amber-400" aria-hidden /> MT5 ব্রিজ সংযোগ
                      {marketStatus?.bridge.status?.source && (
                        <Badge variant="outline" className="font-mono text-[10px] text-zinc-400">source: {marketStatus.bridge.status.source}</Badge>
                      )}
                    </CardTitle>
                    <p className="text-xs text-zinc-500">রিড-ওনলি REST চুক্তি (/health, /api/status, /api/quote, /api/candles) · প্রোব প্রতি ১০ সেকেন্ডে ক্যাশ হয়।</p>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    {([
                      ['কনফিগারড (MT5_BRIDGE_URL)', marketStatus ? (marketStatus.bridge.configured ? 'হ্যাঁ' : 'না') : '—'],
                      ['সার্ভার পৌঁছানো যায়', marketStatus ? (marketStatus.bridge.reachable ? 'হ্যাঁ' : 'না') : '—'],
                      ['MT5 সংযুক্ত', marketStatus?.bridge.status ? (marketStatus.bridge.status.connected ? 'হ্যাঁ' : 'না') : '—'],
                      ['সার্ভার', marketStatus?.bridge.status?.server ?? '—'],
                      ['লেটেন্সি', marketStatus?.bridge.status?.latencyMs != null ? `${marketStatus.bridge.status.latencyMs}ms` : '—'],
                      ['প্রোব সময় (ঢাকা)', marketStatus ? fmtDhaka(marketStatus.bridge.probedAtUtc) : '—'],
                    ] as Array<[string, string]>).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between gap-3 border-b border-zinc-800/60 pb-1.5 last:border-0 last:pb-0">
                        <span className="text-zinc-500">{k}</span>
                        <span className="text-right font-mono text-zinc-200">{v}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <Zap className="h-4 w-4 text-amber-400" aria-hidden /> সর্বশেষ টিক — {marketStatus?.symbol ?? 'XAUUSDm'}
                      {marketStatus?.readiness.tick.state && (
                        <Badge variant="outline" className={qualityStateBadgeClass(marketStatus.readiness.tick.state)}>
                          {qualityStateBn[marketStatus.readiness.tick.state]}
                        </Badge>
                      )}
                    </CardTitle>
                    <p className="text-xs text-zinc-500">প্রতি সিম্বলে একটি স্ন্যাপশট (উচ্চ-ফ্রিকোয়েন্সি টিক ইতিহাস নয় — ইচ্ছাকৃত সীমাবদ্ধতা)।</p>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    {marketStatus?.readiness.tick.bid ? (
                      <>
                        <div className="grid grid-cols-3 gap-2">
                          {([
                            ['Bid', marketStatus.readiness.tick.bid],
                            ['Ask', marketStatus.readiness.tick.ask],
                            ['Spread', marketStatus.readiness.tick.spread],
                          ] as Array<[string, string | null]>).map(([k, v]) => (
                            <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-center">
                              <p className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</p>
                              <p className="mt-0.5 font-mono text-sm text-amber-200">{v ?? '—'}</p>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-between border-b border-zinc-800/60 pb-1.5 text-zinc-500">
                          <span>টিক সময় (ঢাকা)</span>
                          <span className="font-mono text-zinc-200">{marketStatus.readiness.tick.lastTickTimeUtc ? fmtDhaka(marketStatus.readiness.tick.lastTickTimeUtc) : '—'}</span>
                        </div>
                        <div className="flex items-center justify-between text-zinc-500">
                          <span>ডেটার বয়স</span>
                          <span className="font-mono text-zinc-200">
                            {fmtAge(marketStatus.readiness.tick.ageSeconds)} / সীমা {fmtAge(marketStatus.readiness.tick.stalenessThresholdSeconds)}
                          </span>
                        </div>
                      </>
                    ) : (
                      <p className="rounded-lg border border-dashed border-zinc-800 p-3 text-center text-zinc-500">
                        এখনো কোনো বৈধ টিক সংরক্ষিত হয়নি — ব্রিজ সচল হলে সিঙ্কের পর এখানে আসবে।
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Per-timeframe readiness */}
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <LineChart className="h-4 w-4 text-amber-400" aria-hidden /> টাইমফ্রেম অনুযায়ী ডেটা-গুণমান
                    <Badge variant="outline" className={qualityStateBadgeClass(marketStatus?.readiness.qualityState ?? 'UNAVAILABLE')}>
                      সামগ্রিক: {qualityStateBn[marketStatus?.readiness.qualityState ?? 'UNAVAILABLE']}
                    </Badge>
                  </CardTitle>
                  <p className="text-xs text-zinc-500">
                    ফর্মিং ক্যান্ডেল কখনোই নিশ্চিত ইতিহাস হিসেবে গণ্য হয় না — শুধু বন্ধ (closed) ক্যান্ডেল বিবেচিত। সেশন-সচেতন ফাঁক-স্ক্যান উইকেন্ড/বিরতিকে “সম্ভাব্য বাজার-বন্ধ” হিসেবে দেখায় (আনুমানিক, ব্রোকার-যাচাইকৃত নয়)।
                  </p>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {(marketStatus?.readiness.timeframes ?? []).map((tf) => (
                    <div key={tf.timeframe} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold text-zinc-100">{tf.timeframe}</span>
                        <Badge variant="outline" className={qualityStateBadgeClass(tf.state)}>{qualityStateBn[tf.state]}</Badge>
                      </div>
                      <dl className="mt-2 space-y-1 text-[11px] leading-relaxed text-zinc-400">
                        <div className="flex justify-between gap-2">
                          <dt className="text-zinc-500">শেষ বন্ধ ক্যান্ডেল</dt>
                          <dd className="text-right">{tf.lastClosedCandleTimeUtc ? fmtDhaka(tf.lastClosedCandleTimeUtc) : '—'}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-zinc-500">বয়স / সীমা</dt>
                          <dd className="text-right font-mono">{fmtAge(tf.lastClosedCandleAgeSeconds)} / {fmtAge(tf.stalenessThresholdSeconds)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-zinc-500">স্ক্যান / সন্দেহজনক ফাঁক</dt>
                          <dd className="text-right font-mono">{tf.scannedCandles} / <span className={tf.missingCandles > 0 ? 'text-amber-400' : 'text-zinc-300'}>{tf.missingCandles}</span></dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-zinc-500">সম্ভাব্য বাজার-বন্ধ ফাঁক</dt>
                          <dd className="text-right font-mono text-zinc-400">{tf.possibleClosureGaps}</dd>
                        </div>
                      </dl>
                      {tf.errorCodes.length > 0 && (
                        <p className="mt-2 border-t border-zinc-800/70 pt-1.5 text-[10px] leading-relaxed text-amber-300/80">
                          {tf.errorCodes.map((c) => bnForCode(c)).join(' ')}
                        </p>
                      )}
                    </div>
                  ))}
                  {marketStatus && marketStatus.readiness.timeframes.length === 0 && (
                    <p className="col-span-full rounded-lg border border-dashed border-zinc-800 p-3 text-center text-xs text-zinc-500">
                      কনফিগারকৃত টাইমফ্রেম নেই।
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Readiness verdict + sync */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <ShieldCheck className="h-4 w-4 text-amber-400" aria-hidden /> বিশ্লেষণ-প্রস্তুতি (Data Readiness)
                    </CardTitle>
                    <p className="text-xs text-zinc-500">
                      শুধুই ডেটা-প্রস্তুতি নির্দেশক — <span className="text-zinc-300">কোনো ট্রেড সিগন্যাল নয়</span>। প্রস্তুত না হলে ডাউনস্ট্রিম বিশ্লেষণ স্ট্রাকচার্ড “অনুপলব্ধ” ফল পায় — বানানো ক্যান্ডেল বা জোর করে BUY/SELL কখনোই নয়।
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={(marketStatus?.readiness.ready ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-red-500/40 bg-red-500/10 text-red-400')}>
                        {marketStatus?.readiness.ready ? 'প্রস্তুত (ready)' : 'প্রস্তুত নয় (not ready)'}
                      </Badge>
                      <Badge variant="outline" className={qualityStateBadgeClass(marketStatus?.readiness.qualityState ?? 'UNAVAILABLE')}>
                        quality: {marketStatus?.readiness.qualityState ?? '—'}
                      </Badge>
                      <span className="text-zinc-500">ডেটার বয়স: <span className="font-mono text-zinc-300">{fmtAge(marketStatus?.readiness.dataAgeSeconds)}</span></span>
                    </div>
                    {marketStatus && marketStatus.readiness.errorCodes.length > 0 ? (
                      <ul className="space-y-1">
                        {marketStatus.readiness.errorCodes.map((c) => (
                          <li key={c} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-400">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" aria-hidden />
                            <span>{bnForCode(c)} <span className="font-mono text-zinc-600">[{c}]</span></span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[11px] text-zinc-500">কোনো ত্রুটি কোড নেই — সব টাইমফ্রেম ও টিক সদ্য-সদ্য সতেজ।</p>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <Database className="h-4 w-4 text-amber-400" aria-hidden /> ডেটাবেস সিঙ্ক অবস্থা
                      {marketStatus?.sync.running && (
                        <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">চলছে…</Badge>
                      )}
                    </CardTitle>
                    <p className="text-xs text-zinc-500">আইডেমপোটেন্ট আপসার্ট — একই ক্যান্ডেল দুবার সিঙ্ক করলেও ডুপ্লিকেট রেকর্ড হয় না।</p>
                  </CardHeader>
                  <CardContent className="space-y-3 text-xs">
                    {([
                      ['সর্বশেষ রান', marketStatus?.sync.lastRun],
                      ['সর্বশেষ সফল', marketStatus?.sync.lastSuccess],
                      ['সর্বশেষ ব্যর্থ/আংশিক', marketStatus?.sync.lastFailure],
                    ] as Array<[string, SyncRunSummary | null | undefined]>).map(([label, run]) => (
                      <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-zinc-500">{label}</span>
                          {run ? (
                            <Badge variant="outline" className={run.status === 'success' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : run.status === 'partial' ? 'border-amber-500/40 bg-amber-500/10 text-amber-400' : 'border-red-500/40 bg-red-500/10 text-red-400'}>
                              {syncStatusBn(run.status)}
                            </Badge>
                          ) : (
                            <span className="text-zinc-600">এখনো নেই</span>
                          )}
                        </div>
                        {run && (
                          <p className="mt-1 font-mono text-[10px] leading-relaxed text-zinc-400">
                            {fmtDhaka(run.startedAtUtc)} · {run.mode} · {run.timeframes.join('/')}
                            {' '}· প্রাপ্ত {run.received} · নতুন {run.inserted} · আপডেট {run.updated} · বাতিল {run.rejected} · ডুপ {run.duplicates}
                            {run.durationMs != null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}
                            {run.errorCode ? ` · [${run.errorCode}]` : ''}
                          </p>
                        )}
                      </div>
                    ))}
                    <Button
                      onClick={() => void runSyncNow()}
                      disabled={syncing || !marketStatus}
                      className="w-full gap-2 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                      variant="outline"
                    >
                      {syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                      {syncing ? 'সিঙ্ক চলছে…' : 'এখনই সিঙ্ক করুন (ম্যানুয়াল)'}
                    </Button>
                  </CardContent>
                </Card>
              </div>

              {/* Data-quality issues */}
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden /> ডেটা-গুণমান সমস্যা (খোলা)
                    <Badge variant="outline" className="border-zinc-700 bg-zinc-800/60 text-zinc-400">{marketQuality?.openIssues.length ?? 0} টি</Badge>
                  </CardTitle>
                  <p className="text-xs text-zinc-500">প্রতি সিঙ্ক রানে সীমিত সংখ্যক সমস্যা সংরক্ষিত হয় (ফ্লাড নিয়ন্ত্রণ) — বিস্তারিত নিরাপদ ডায়াগনস্টিক।</p>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="custom-scrollbar max-h-96 overflow-y-auto">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
                        <TableRow className="border-zinc-800 hover:bg-transparent">
                          <TableHead className="pl-4 sm:pl-6">সময় (ঢাকা)</TableHead>
                          <TableHead>মাত্রা</TableHead>
                          <TableHead>কোড</TableHead>
                          <TableHead>টাইমফ্রেম</TableHead>
                          <TableHead className="pr-4 sm:pr-6">বিবরণ</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(marketQuality?.openIssues ?? []).map((i) => (
                          <TableRow key={i.id} className="border-zinc-800/70">
                            <TableCell className="whitespace-nowrap pl-4 text-xs tabular-nums text-zinc-500 sm:pl-6">{fmtDhaka(i.checkedAtUtc)}</TableCell>
                            <TableCell>
                              <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${levelBadgeClass(i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warn' : 'info')}`}>
                                {i.severity}
                              </span>
                            </TableCell>
                            <TableCell className="font-mono text-xs text-amber-300/80">{i.errorCode}</TableCell>
                            <TableCell className="font-mono text-xs text-zinc-400">{i.timeframe ?? '—'}</TableCell>
                            <TableCell className="pr-4 text-xs text-zinc-300 sm:pr-6">{bnForCode(i.errorCode)}{i.details?.detail ? <span className="block text-[10px] text-zinc-500">{i.details.detail}</span> : null}</TableCell>
                          </TableRow>
                        ))}
                        {marketQuality && marketQuality.openIssues.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={5} className="p-6 text-center text-sm text-zinc-500">
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
                </CardContent>
              </Card>
            </TabsContent>

            {/* ------------------------------------------------ Tab: architecture */}
            <TabsContent value="arch" className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">সিস্টেম স্তর (উপর থেকে নিচে)</CardTitle>
                    <p className="text-xs text-zinc-500">MT5 ব্রিজ ছাড়া বাকি সব স্তর এই sandbox-এ বাস্তবায়িত।</p>
                  </CardHeader>
                  <CardContent className="space-y-0">
                    {(audit?.architecture ?? []).map((layer, i) => (
                      <div key={layer.id}>
                        <div className="flex gap-3 rounded-lg border border-zinc-800/70 bg-zinc-950/60 p-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/10">
                            {layer.id === 'dashboard' ? <Globe className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'api' ? <Server className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'glm' ? <Bot className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'tools' ? <Wrench className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'engines' ? <Cpu className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'bridge' ? <Network className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                            {layer.id === 'data' ? <Database className="h-4 w-4 text-amber-400" aria-hidden /> : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center justify-between gap-1">
                              <p className="text-sm font-semibold text-zinc-100">{layer.title}</p>
                              <Badge variant="outline" className="border-zinc-700 bg-zinc-800/60 text-[10px] text-zinc-400">
                                {layer.phase}
                              </Badge>
                            </div>
                            <p className="mt-0.5 font-mono text-[11px] text-amber-300/80">{layer.tech}</p>
                            <p className="mt-1 text-xs leading-relaxed text-zinc-400">{layer.detail}</p>
                          </div>
                        </div>
                        {i < (audit?.architecture.length ?? 0) - 1 && (
                          <div className="flex justify-center py-1" aria-hidden>
                            <ChevronDown className="h-4 w-4 text-zinc-600" />
                          </div>
                        )}
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <div className="space-y-4">
                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Repository কাঠামো</CardTitle>
                      <p className="text-xs text-zinc-500">Phase 1 ডেলিভারি — প্রতিটি ফাইলের ভূমিকা স্পষ্ট।</p>
                    </CardHeader>
                    <CardContent>
                      <pre className="custom-scrollbar max-h-[320px] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950/80 p-4 font-mono text-[11px] leading-relaxed text-zinc-300">
                        {audit?.repositoryTree ?? ''}
                      </pre>
                    </CardContent>
                  </Card>

                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Tool Registry (Allowlist)</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-xs leading-relaxed text-zinc-400">
                        GLM শুধু অনুমোদিত টুল কল করতে পারে — কোনো shell, SQL বা নেটওয়ার্ক টুল নেই।
                        ভবিষ্যৎ টুল রানটাইমে স্পষ্ট এররসহ প্রত্যাখ্যাত হয়।
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {(audit?.tools.active ?? []).map((t) => (
                          <Badge key={t} variant="outline" className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" aria-hidden /> {t}
                          </Badge>
                        ))}
                        {(audit?.tools.planned ?? []).map((t) => (
                          <Badge key={t.name} variant="outline" className="border-zinc-700 bg-zinc-800/60 text-zinc-400">
                            {t.name} · P{t.phase}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </TabsContent>

            {/* ------------------------------------------------ Tab: GLM verify */}
            <TabsContent value="glm" className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {[
                  {
                    icon: Zap,
                    title: 'Chat Completion',
                    ok: audit?.glm.capabilities.chatCompletion ?? false,
                    detail: 'ইংরেজি টোকেন-টেস্ট রাউন্ড-ট্রিপ',
                  },
                  {
                    icon: Languages,
                    title: 'Bengali Response',
                    ok: audit?.glm.capabilities.bengali ?? false,
                    detail: 'Phase 9-এর বাংলা Chat Agent-এর ভিত্তি',
                  },
                  {
                    icon: Wrench,
                    title: 'Tool Calling',
                    ok: audit?.glm.capabilities.toolCalling ?? false,
                    detail: `Full loop ${audit?.glm.capabilities.toolCallRoundTripMs ?? '—'}ms`,
                  },
                ].map((cap) => (
                  <Card key={cap.title} className="border-zinc-800 bg-zinc-900/40">
                    <CardContent className="flex items-start gap-3 p-4 sm:p-5">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/10">
                        <cap.icon className="h-5 w-5 text-amber-400" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-zinc-100">{cap.title}</p>
                          {cap.ok ? (
                            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">✓ যাচাইকৃত</Badge>
                          ) : (
                            <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-400">✗ ব্যর্থ</Badge>
                          )}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-zinc-400">{cap.detail}</p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">লাইভ পুনঃযাচাই</CardTitle>
                  <p className="text-xs text-zinc-500">
                    স্ট্যাটিক প্রমাণ নয় — বাটন চাপলেই এখনই তিনটি রিয়েল রাউন্ড-ট্রিপ চলে (চ্যাট, বাংলা, টুল-কলিং)।
                    ফল সরাসরি SystemEvent অডিট ট্রেইলে লেখা হয়।
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={() => void runVerify()} disabled={verifying} className="bg-amber-500 text-zinc-950 hover:bg-amber-400">
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
                    <span className="text-xs text-zinc-500">
                      মডেল: <span className="font-mono text-amber-300">{audit?.glm.model ?? 'glm-4-plus'}</span> ·
                      SDK: z-ai-web-dev-sdk (server-side only) · Auth: sandbox-managed — কোনো API key লাগে না
                    </span>
                  </div>

                  {verifyResult && (
                    <div className="space-y-3">
                      <div
                        role="status"
                        className={`rounded-lg border p-3 text-sm ${
                          verifyResult.verified
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                            : 'border-red-500/40 bg-red-500/10 text-red-300'
                        }`}
                      >
                        {verifyResult.verified ? 'সব টেস্ট পাস — ' : 'এক বা একাধিক টেস্ট ব্যর্থ — '}
                        মোট {verifyResult.totalLatencyMs}ms · {fmtDhaka(verifyResult.checkedAt)} (ঢাকা)
                      </div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        {verifyResult.tests.map((t) => (
                          <div key={t.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-semibold text-zinc-200">{t.name}</p>
                              <StatusIcon status={t.ok ? 'pass' : 'fail'} />
                            </div>
                            <p className="mt-1 font-mono text-[11px] text-zinc-500">{t.latencyMs > 0 ? `${t.latencyMs}ms` : '—'}</p>
                            <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{t.detail}</p>
                            {t.sample && (
                              <p className="custom-scrollbar mt-2 max-h-24 overflow-auto rounded border border-zinc-800 bg-zinc-900/60 p-2 font-mono text-[11px] text-amber-200/90">
                                &ldquo;{t.sample}&rdquo;
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <Separator className="bg-zinc-800" />
                  <div className="grid grid-cols-1 gap-3 text-xs text-zinc-400 sm:grid-cols-2">
                    <p>
                      <span className="text-zinc-200">নমুনা রিকোয়েস্ট:</span>{' '}
                      <span className="font-mono text-zinc-500">{audit?.glm.sample.prompt ?? '—'}</span>
                    </p>
                    <p>
                      <span className="text-zinc-200">নমুনা রেসপন্স:</span>{' '}
                      <span className="font-mono text-emerald-400/90">{audit?.glm.sample.response ?? '—'}</span>
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ------------------------------------------------ Tab: MT5 */}
            <TabsContent value="mt5" className="space-y-4">
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    MT5 সম্ভাব্যতা প্রতিবেদন
                    <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-400">Sandbox-এ অসম্ভব</Badge>
                  </CardTitle>
                  <p className="text-xs text-zinc-500">সত্যি প্রমাণসহ — সংযোগ দাবি করা হয়নি, কারণ পরীক্ষা করে ব্যর্থ প্রমাণিত।</p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ul className="space-y-2">
                    {(audit?.mt5.findings ?? []).map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm leading-relaxed text-zinc-300">
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Separator className="bg-zinc-800" />
                  <p className="text-sm font-semibold text-zinc-100">ব্রিজ অপশন (Phase 2 সিদ্ধান্তের জন্য)</p>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {(audit?.mt5.bridgeOptions ?? []).map((o, i) => (
                      <div key={o.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                        <div className="flex items-center gap-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/10 font-mono text-xs text-amber-400">
                            {i + 1}
                          </span>
                          <p className="text-xs font-semibold text-zinc-100">{o.title}</p>
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{o.detail}</p>
                      </div>
                    ))}
                  </div>
                  <Separator className="bg-zinc-800" />
                  <p className="text-sm font-semibold text-zinc-100">Phase 2 পরিকল্পনা (Bridge Contract)</p>
                  <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-zinc-400">
                    {(audit?.mt5.phase2Plan ?? []).map((p) => <li key={p}>{p}</li>)}
                  </ol>
                  <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs leading-relaxed text-red-300">
                    Phase 2-এর ব্রিজ কন্ট্র্যাক্টে কোনো অর্ডার-পাঠানোর endpoint থাকবে না — শুধুই মার্কেট ডেটা (read-only)।
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ------------------------------------------------ Tab: database */}
            <TabsContent value="db" className="space-y-4">
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">ডেটা মডেল (SQLite · Prisma)</CardTitle>
                  <p className="text-xs text-zinc-500">
                    ১২টি মডেল এখনই ডিফাইন করা — Phase 1-এ শুধু SystemEvent সচল; বাকিগুলো নিজ নিজ Phase-এ সক্রিয় হয়।
                  </p>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-zinc-800 hover:bg-transparent">
                          <TableHead className="pl-4 sm:pl-6">মডেল</TableHead>
                          <TableHead className="min-w-[220px]">উদ্দেশ্য</TableHead>
                          <TableHead>Phase</TableHead>
                          <TableHead className="pr-4 sm:pr-6">অবস্থা</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(audit?.database.models ?? []).map((m) => (
                          <TableRow key={m.name} className="border-zinc-800/70">
                            <TableCell className="pl-4 font-mono text-xs text-zinc-200 sm:pl-6">{m.name}</TableCell>
                            <TableCell className="text-xs text-zinc-400">{m.purpose}</TableCell>
                            <TableCell className="font-mono text-xs text-zinc-500">P{m.phase}</TableCell>
                            <TableCell className="pr-4 sm:pr-6">
                              <Badge
                                variant="outline"
                                className={
                                  m.status === 'active'
                                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
                                }
                              >
                                {m.status === 'active' ? 'সচল' : 'পরিকল্পিত'}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
              <p className="text-xs leading-relaxed text-zinc-500">
                টেকনিক্যাল নোট: SQLite-এ Prisma Json টাইপ নেই, তাই JSON পে-লোড String হিসেবে সংরক্ষিত — schema-তে প্রতিটি মডেলে কমেন্টে ব্যাখ্যা আছে।
                সব মূল্য-ক্যান্ডেল-রেকর্ড symbol+timeframe+timestamp ইউনিক কনস্ট্রেইন্টে আবদ্ধ — ডুপ্লিকেট সিগন্যাল তৈরির পথ বন্ধ।
              </p>
            </TabsContent>

            {/* ------------------------------------------------ Tab: security & checklist */}
            <TabsContent value="sec" className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="border-zinc-800 bg-zinc-900/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden /> নিরাপত্তা ব্যবস্থা
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {(audit?.security ?? []).map((s) => (
                      <div key={s.measure} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                        <p className="text-xs font-semibold text-zinc-100">{s.measure}</p>
                        <p className="mt-1 text-xs leading-relaxed text-zinc-400">{s.detail}</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <div className="space-y-4">
                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Phase 1 গ্রহণযোগ্যতা চেকলিস্ট</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2">
                        {(audit?.acceptanceChecklist ?? []).map((c) => (
                          <li key={c.id} className="flex items-start gap-2 text-sm text-zinc-300">
                            {c.done ? (
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                            ) : (
                              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" aria-hidden />
                            )}
                            {c.label}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>

                  <Card className="border-zinc-800 bg-zinc-900/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden /> ঝুঁকি ও অসমাধান ব্লকার
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-zinc-400">
                        <li>
                          <span className="text-zinc-200">MT5 ব্রিজ বাহ্যিক নির্ভরতা:</span> sandbox-এ MT5 চলবে না (প্রমাণিত)।
                          Phase 2-এর আগে আপনাকে সিদ্ধান্ত নিতে হবে — কোন ব্রিজ অপশন (Linux VPS + Wine / Windows VPS) নেবেন।
                        </li>
                        <li>
                          <span className="text-zinc-200">Sandbox স্থায়িত্ব:</span> এটি কোডিং-রানটাইম, ২৪/৭ ট্রেডিং সার্ভার নয়।
                          চূড়ান্ত ডিপ্লয়মেন্ট (Phase 12) আপনার নিজের Linux VPS-এ হবে।
                        </li>
                        <li>
                          <span className="text-zinc-200">এক-পোর্ট সীমাবদ্ধতা:</span> বাইরের সব সংযোগ গেটওয়ে হয়ে যায়;
                          ব্রিজে যাওয়ার সময় আউটবাউন্ড HTTPS ব্যবহার হবে (নেটওয়ার্ক পরীক্ষায় সমর্থিত)।
                        </li>
                        <li>
                          <span className="text-zinc-200">GLM কোটা/খরচ:</span> স্যান্ডবক্স প্ল্যানের উপর নির্ভরশীল — তাই
                          /api/ai/verify-তে রেট লিমিট (ডিফল্ট ১০ সেকেন্ড) দেওয়া আছে।
                        </li>
                      </ul>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {/* ------------------------------------------------ Audit trail (events) */}
          <Card className="border-zinc-800 bg-zinc-900/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <Terminal className="h-4 w-4 text-amber-400" aria-hidden /> সিস্টেম ইভেন্ট — লাইভ অডিট ট্রেইল
                <Badge variant="outline" className="border-zinc-700 bg-zinc-800/60 text-zinc-400">
                  {health?.auditEventCount ?? audit?.events.length ?? 0} টি
                </Badge>
              </CardTitle>
              <p className="text-xs text-zinc-500">
                SystemEvent টেবিল থেকে সরাসরি (append-only)। GLM যাচাই চালালে এখানে নতুন রেকর্ড যুক্ত হতে দেখবেন।
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="custom-scrollbar max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
                    <TableRow className="border-zinc-800 hover:bg-transparent">
                      <TableHead className="pl-4 sm:pl-6">সময় (ঢাকা)</TableHead>
                      <TableHead>স্তর</TableHead>
                      <TableHead>কোড</TableHead>
                      <TableHead className="min-w-[240px] pr-4 sm:pr-6">বার্তা</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(audit?.events ?? []).map((e) => (
                      <TableRow key={e.id} className="border-zinc-800/70">
                        <TableCell className="whitespace-nowrap pl-4 text-xs tabular-nums text-zinc-500 sm:pl-6">
                          {fmtDhaka(e.createdAt)}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${levelBadgeClass(e.level)}`}
                          >
                            {e.level}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-amber-300/80">{e.code}</TableCell>
                        <TableCell className="pr-4 text-xs text-zinc-300 sm:pr-6">{e.message}</TableCell>
                      </TableRow>
                    ))}
                    {audit && audit.events.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="p-6 text-center text-sm text-zinc-500">
                          এখনো কোনো ইভেন্ট নেই — &ldquo;GLM যাচাই&rdquo; ট্যাব থেকে লাইভ যাচাই চালান।
                        </TableCell>
                      </TableRow>
                    )}
                    {loading && !audit && (
                      <TableRow>
                        <TableCell colSpan={4} className="p-6">
                          <Skeleton className="h-5 w-full" />
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* ---------------------------------------------------------------- Footer */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-4 text-xs text-zinc-500 sm:px-6 md:flex-row md:items-center md:justify-between">
          <p className="flex items-center gap-1.5">
            <LockKeyhole className="h-3.5 w-3.5 text-red-400" aria-hidden />
            XAUUSD AI Trading Agent · Phase 3/12 · Read-Only — কোনো অর্ডার পাঠানো হবে না
          </p>
          <p className="font-mono text-[11px] text-zinc-600">
            Next.js 16 · TypeScript · Prisma/SQLite · z-ai-web-dev-sdk (glm-4-plus)
          </p>
          <p className="text-zinc-600">Live Trading: Phase 12 রিলিজ-গেটের আগে চালু হবে না</p>
        </div>
      </footer>
    </div>
  );
}
