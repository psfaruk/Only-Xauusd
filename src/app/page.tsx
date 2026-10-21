'use client';

/**
 * XAUUSD AI Trading Agent — Trading Terminal (UI-02 redesign).
 * ----------------------------------------------------------------------------
 * Single user-visible route. Professional dark trading-terminal layout on
 * the SAME backend/APIs (nothing about data flow, strategy or safety changed):
 *
 *   Desktop (lg+) : header quote strip → [chart workspace | right rail:
 *                   signal decision + market snapshot] → lower tabs
 *                   (বিশ্লেষণ | সিগন্যাল ইতিহাস | সিস্টেম) → footer.
 *                   AI chat opens as a right Sheet (chart stays visible).
 *   Mobile (<lg)  : compact header → ONE active view at a time, driven by the
 *                   bottom navigation (ড্যাশবোর্ড · চার্ট · এআই চ্যাট ·
 *                   সিগন্যাল · সিস্টেম), safe-area aware, no horizontal scroll.
 *
 * Safety contract (unchanged): order execution is LOCKED behind the four
 * fail-closed switches; the UI can never bypass backend authorization; the
 * MT5 bridge stays read-only. All data is real or honestly absent.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Home, MessageCircle, Settings as SettingsIcon, ShieldCheck, Activity } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useTickStream } from '@/hooks/use-tick-stream';
import {
  priceDisplaySpecFromSymbolSpec,
  type PriceDisplaySpec,
} from '@/lib/market/price-display';
import { NAV_ITEMS, type TerminalView } from '@/lib/dashboard/nav';
import { BrokerSettingsView } from '@/components/terminal/BrokerSettingsView';
import {
  buildChatHistory,
  canSendChat,
  chatApiErrorMessage,
  chatNetworkErrorMessage,
  clampChatInput,
  retryTextFor,
} from '@/lib/dashboard/chat-logic';
import type {
  AiReviewLatestResponse,
  AnalysisLatestResponse,
  AuditResponse,
  BacktestLatestResponse,
  ChatMessage,
  ChatResponse,
  DataHealthResponse,
  DataLatestResponse,
  ExecutionStateResponse,
  HealthReport,
  MarketStatusResponse,
  QualityResponse,
  SignalHistoryResponse,
  SignalLatestResponse,
  ScalperLatestResponse,
  ValidationLatestResponse,
  VerifyResponse,
} from '@/lib/dashboard/types';
import { bnForCode, syncStatusBn } from '@/lib/dashboard/i18n';
import { TerminalHeader } from '@/components/terminal/TerminalHeader';
import { ChartPanel } from '@/components/terminal/ChartPanel';
import { CandidateSignalCard } from '@/components/terminal/CandidateSignalCard';
import { ScalperSignalCard } from '@/components/terminal/ScalperSignalCard';
import { SignalCard } from '@/components/terminal/SignalCard';
import { DashboardView, MarketSnapshot, SystemMiniCards } from '@/components/terminal/DashboardView';
import { ChatView } from '@/components/terminal/ChatView';
import { HistoryView } from '@/components/terminal/HistoryView';
import { AnalysisView } from '@/components/terminal/AnalysisView';
import { SystemView } from '@/components/terminal/SystemView';
import { AiReviewPanel, ExecutionPanel } from '@/components/terminal/ExecutionPanel';

const SYMBOL = 'XAUUSDm';

export default function TradingTerminal() {
  const { toast } = useToast();
  // Task 29-c — single live tick-stream socket for the whole page (socket.io
  // :3041 via the platform gateway XTransformPort query; see use-tick-stream).
  const tickStream = useTickStream();

  // ---- Data state (all real API payloads; null = honestly unavailable) -------
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [marketStatus, setMarketStatus] = useState<MarketStatusResponse | null>(null);
  const [marketQuality, setMarketQuality] = useState<QualityResponse | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [analysisLatest, setAnalysisLatest] = useState<AnalysisLatestResponse | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [dataHealth, setDataHealth] = useState<DataHealthResponse | null>(null);
  const [backtestLatest, setBacktestLatest] = useState<BacktestLatestResponse | null>(null);
  const [signalLatest, setSignalLatest] = useState<SignalLatestResponse | null>(null);
  const [signalRunning, setSignalRunning] = useState(false);
  // Phase 12 — the live scalper strategy surface (M1/M5/M15 OR-logic).
  const [scalperLatest, setScalperLatest] = useState<ScalperLatestResponse | null>(null);
  const [scalperRunning, setScalperRunning] = useState(false);
  const [signalHistory, setSignalHistory] = useState<SignalHistoryResponse | null>(null);
  // Phase 11-E — the candidate's own separately-labeled history surface
  // (?strategy=candidate; never merged into the baseline history list).
  const [candidateHistory, setCandidateHistory] = useState<SignalHistoryResponse | null>(null);
  const [validationLatest, setValidationLatest] = useState<ValidationLatestResponse | null>(null);
  const [dataLatest, setDataLatest] = useState<DataLatestResponse | null>(null);

  // ---- Phase 6/11 state (AI review + approval-based execution) -----------------
  const [aiReview, setAiReview] = useState<AiReviewLatestResponse | null>(null);
  const [aiReviewRunning, setAiReviewRunning] = useState(false);
  const [executionState, setExecutionState] = useState<ExecutionStateResponse | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);

  /** Per-endpoint unavailability codes (F-04 fix: unavailable ≠ empty). */
  const [apiErrors, setApiErrors] = useState<Record<string, string | null>>({});
  const setApiError = useCallback((key: string, code: string | null) => {
    setApiErrors((prev) => (prev[key] === code ? prev : { ...prev, [key]: code }));
  }, []);

  // ---- Chat state -------------------------------------------------------------
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);

  // ---- Navigation state --------------------------------------------------------
  const [view, setView] = useState<TerminalView>('dashboard');
  const [chatSheetOpen, setChatSheetOpen] = useState(false);
  /** bumped by the refresh loop so the chart refetches too. */
  const [refreshTick, setRefreshTick] = useState(0);
  /** Task 36-rt — wall-clock of the last COMPLETED refresh sweep. The realtime
   *  channels (positions/account) win over the polled views only while their
   *  updatedAtMs beats this timestamp — an honest newest-observation rule. */
  const [lastRefreshAtMs, setLastRefreshAtMs] = useState<number | null>(null);

  // ---- Refresh loop (same 12 endpoints as before + error codes) ----------------
  // Master-audit fix: every fetch is bounded by a client-side timeout so a
  // network blackhole can never wedge the 15s refresh loop (each promise
  // settles as a rejection → honest NETWORK_ERROR code, next tick retries).
  // Task 36-rt: the sweep runs every 15 s now — the heavy/audit endpoints stay
  // polled, while price (250 ms), positions (3 s) and account (2 s) ride the
  // realtime tick-stream socket instead.
  const refresh = useCallback(async () => {
    try {
      const results = await Promise.allSettled([
        fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/audit/environment', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/data/status', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/data/quality', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/analysis/latest', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/data/health?symbol=XAUUSDm', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/backtest/latest?symbol=XAUUSDm', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/signal/latest?symbol=XAUUSDm', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/validation/latest?symbol=XAUUSDm', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/data/latest?symbol=XAUUSDm', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/signal/history?symbol=XAUUSDm&limit=20', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/signal/history?symbol=XAUUSDm&limit=20&strategy=candidate', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/ai/review/latest?symbol=XAUUSDm', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/execution/state', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
        fetch('/api/signal/scalper?symbol=XAUUSDm', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }),
      ]);
      const resOf = (i: number): Response | null =>
        results[i].status === 'fulfilled' ? results[i].value : null;
      const ok = (i: number) => {
        const r = resOf(i);
        return r !== null && r.ok;
      };
      const body = async <T,>(i: number): Promise<T | null> => {
        const r = resOf(i);
        if (r === null || !r.ok) return null;
        try {
          return (await r.json()) as T;
        } catch {
          return null;
        }
      };
      /** /api/health deliberately answers HTTP 503 while its JSON body still
       *  carries the full report (status "degraded" — e.g. GLM not yet
       *  verified, or the execution-lock check honestly flagged DANGER now
       *  that live orders are enabled). The dashboard needs that PAYLOAD
       *  regardless of the HTTP status — without this, a permanently
       *  "degraded" (but fully operational) backend would leave health=null
       *  and the UI would fall back to stale lock messaging forever. */
      const healthBody = async (): Promise<HealthReport | null> => {
        const r = resOf(0);
        if (r === null) return null;
        try {
          return (await r.json()) as HealthReport;
        } catch {
          return null;
        }
      };
      const errCode = async (i: number): Promise<string | null> => {
        const r = resOf(i);
        if (r === null) return 'NETWORK_ERROR';
        if (r.ok) return null;
        try {
          const b = (await r.json()) as { error?: { code?: string } };
          return b?.error?.code ?? `HTTP_${r.status}`;
        } catch {
          return `HTTP_${r.status}`;
        }
      };

      if (!ok(0) && !ok(1)) throw new Error('API unreachable');

      setHealth((await healthBody()) ?? null);
      setAudit((await body<AuditResponse>(1)) ?? null);
      setApiError('audit', await errCode(1));

      setMarketStatus((await body<MarketStatusResponse>(2)) ?? null);
      setApiError('market', await errCode(2));
      setMarketQuality((await body<QualityResponse>(3)) ?? null);
      setApiError('quality', await errCode(3));

      const an = await body<AnalysisLatestResponse>(4);
      setAnalysisLatest(an);
      setAnalysisError(an ? null : await errCode(4));

      setDataHealth((await body<DataHealthResponse>(5)) ?? null);
      setApiError('dhealth', await errCode(5));
      setBacktestLatest((await body<BacktestLatestResponse>(6)) ?? null);
      setApiError('backtest', await errCode(6));
      setSignalLatest((await body<SignalLatestResponse>(7)) ?? null);
      setApiError('signal', await errCode(7));
      setValidationLatest((await body<ValidationLatestResponse>(8)) ?? null);
      setApiError('validation', await errCode(8));
      setDataLatest((await body<DataLatestResponse>(9)) ?? null);
      setApiError('dataLatest', await errCode(9));
      setSignalHistory((await body<SignalHistoryResponse>(10)) ?? null);
      setApiError('history', await errCode(10));
      setCandidateHistory((await body<SignalHistoryResponse>(11)) ?? null);
      setApiError('candidateHistory', await errCode(11));
      setAiReview((await body<AiReviewLatestResponse>(12)) ?? null);
      setApiError('aiReview', await errCode(12));
      setExecutionState((await body<ExecutionStateResponse>(13)) ?? null);
      setApiError('execution', await errCode(13));
      setScalperLatest((await body<ScalperLatestResponse>(14)) ?? null);
      setApiError('scalper', await errCode(14));

      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'unknown error');
    } finally {
      setLoading(false);
      setRefreshTick((t) => t + 1);
      setLastRefreshAtMs(Date.now());
    }
  }, [setApiError]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  // ---- Verified price display precision ----------------------------------------
  const priceSpec = useMemo(
    () => priceDisplaySpecFromSymbolSpec(dataLatest?.spec ?? null),
    [dataLatest],
  );
  const quoteDigitsMismatch =
    dataHealth?.quote.digits != null && priceSpec.verified && dataHealth.quote.digits !== priceSpec.digits;

  // ---- Task 36-rt — realtime bundles for the execution panel --------------------
  // The live channel wins ONLY while it is fresh (socket live, payload not
  // stale) AND newer than the last completed 15 s poll; otherwise the polled
  // view renders unchanged (honest fallback — the two are never mixed).
  const liveExecutionPositions = useMemo(() => {
    if (tickStream.status !== 'live') return null;
    const updatedAtMs = tickStream.positionsUpdatedAtMs;
    if (updatedAtMs === null || tickStream.positionsStale) return null;
    if (lastRefreshAtMs !== null && updatedAtMs <= lastRefreshAtMs) return null;
    return {
      positions: tickStream.positions,
      updatedAtMs,
      stale: tickStream.positionsStale,
    };
  }, [tickStream.status, tickStream.positions, tickStream.positionsUpdatedAtMs, tickStream.positionsStale, lastRefreshAtMs]);

  const liveExecutionAccount = useMemo(() => {
    if (tickStream.status !== 'live') return null;
    const a = tickStream.account;
    if (!a || a.balance === null) return null;
    if (lastRefreshAtMs !== null && a.updatedAtMs <= lastRefreshAtMs) return null;
    return { balance: a.balance, currency: a.currency, updatedAtMs: a.updatedAtMs };
  }, [tickStream.status, tickStream.account, lastRefreshAtMs]);

  // ---- Actions (same endpoints, same honest error handling) ---------------------

  const runVerify = useCallback(async () => {
    setVerifying(true);
    try {
      const res = await fetch('/api/ai/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 429) {
        const body = (await res.json()) as { message?: string };
        toast({ title: 'রেট লিমিট', description: body.message ?? 'অনুগ্রহ করে কিছুক্ষণ পরে আবার চেষ্টা করুন।', variant: 'destructive' });
        return;
      }
      const body = (await res.json()) as VerifyResponse;
      setVerifyResult(body);
      if (body.verified) {
        toast({ title: 'GLM যাচাই সফল', description: `মডেল ${body.model} · ${body.totalLatencyMs}ms` });
      } else {
        toast({ title: 'GLM যাচাই ব্যর্থ', description: 'বিস্তারিত সিস্টেম → GLM যাচাই-তে দেখুন।', variant: 'destructive' });
      }
      await refresh();
    } catch (e) {
      toast({ title: 'যাচাই চালানো যায়নি', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
    } finally {
      setVerifying(false);
    }
  }, [refresh, toast]);

  const runSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const symbol = marketStatus?.symbol ?? SYMBOL;
      const res = await fetch('/api/data/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, mode: 'manual' }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await res.json()) as {
        ok: boolean;
        outcome?: { status: string; inserted: number; updated: number; errorCode: string | null };
        error?: { code: string; message: string };
      };
      if (res.status === 429) {
        toast({ title: 'রেট লিমিট', description: 'খুব ঘন ঘন সিঙ্ক চালানো হচ্ছে — কিছুক্ষণ পরে চেষ্টা করুন।', variant: 'destructive' });
      } else if (body.ok && body.outcome?.status === 'success') {
        toast({ title: 'সিঙ্ক সফল', description: `নতুন ${body.outcome.inserted}টি, আপডেট ${body.outcome.updated}টি ক্যান্ডেল।` });
      } else if (body.ok && body.outcome) {
        toast({
          title: `সিঙ্ক ${syncStatusBn(body.outcome.status)}`,
          description: body.outcome.errorCode ? bnForCode(body.outcome.errorCode) : 'কিছু টাইমফ্রেম সম্পূর্ণ হয়নি।',
          variant: 'destructive',
        });
      } else {
        toast({ title: 'সিঙ্ক ব্যর্থ', description: body.error ? bnForCode(body.error.code) : 'অজানা ত্রুটি।', variant: 'destructive' });
      }
      await refresh();
    } catch (e) {
      toast({ title: 'সিঙ্ক চালানো যায়নি', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
    } finally {
      setSyncing(false);
    }
  }, [marketStatus?.symbol, refresh, toast]);

  /**
   * Phase 13 — sync-first helper for on-demand runs. The signal engine
   * fail-closes on ticks older than MARKET_STALE_TICK_SEC (120s default) while
   * the scheduler syncs every 300s, so an on-demand evaluation BETWEEN syncs
   * would honestly BLOCK with TICK_STALE. Fetching fresh data first keeps the
   * verdict meaningful without touching any data-quality threshold. Sync
   * failures are ignored here — the evaluation then reports the honest stale
   * verdict itself.
   */
  const syncBeforeRun = useCallback(async (symbol: string) => {
    try {
      await fetch('/api/data/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, mode: 'manual' }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      // network-level failure — the subsequent evaluation shows the honest state
    }
  }, []);

  const runAnalysisNow = useCallback(async () => {
    setAnalysisRunning(true);
    try {
      const symbol = marketStatus?.symbol ?? SYMBOL;
      await syncBeforeRun(symbol);
      const res = await fetch('/api/analysis/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await res.json()) as {
        ok: boolean;
        analysis?: { status: string; reasonCodes: string[] };
        error?: { code: string; message: string };
      };
      if (res.status === 401 || res.status === 503) {
        // fail-closed security posture — honest, never bypassed from the UI
        toast({
          title: 'বিশ্লেষণ চালানো যায়নি',
          description: body.error ? bnForCode(body.error.code) : 'সংযোগ বন্ধ।',
          variant: 'destructive',
        });
      } else if (res.status === 500) {
        toast({ title: 'বিশ্লেষণ ব্যর্থ (FAILED)', description: body.error?.message ?? 'অজানা ত্রুটি।', variant: 'destructive' });
      } else if (body.analysis?.status === 'COMPLETED') {
        toast({ title: 'বিশ্লেষণ সম্পূর্ণ', description: 'কাঠামো ও সূচক হালনাগাদ — বিশ্লেষণ ভিউতে দেখুন।' });
      } else if (body.analysis?.status === 'BLOCKED') {
        toast({
          title: 'বিশ্লেষণ বন্ধ — সৎ ফলাফল',
          description: body.analysis.reasonCodes.map((c) => bnForCode(c)).join(' '),
          variant: 'destructive',
        });
      }
      await refresh();
    } catch (e) {
      toast({ title: 'বিশ্লেষণ চালানো যায়নি', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
    } finally {
      setAnalysisRunning(false);
    }
  }, [marketStatus?.symbol, refresh, syncBeforeRun, toast]);

  const runSignalNow = useCallback(async () => {
    setSignalRunning(true);
    try {
      const symbol = marketStatus?.symbol ?? SYMBOL;
      await syncBeforeRun(symbol);
      const res = await fetch('/api/signal/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await res.json()) as {
        ok: boolean;
        evaluation?: { outcome: string; reasonCodes: string[] };
        error?: { code: string; message: string };
      };
      if (res.status === 401 || res.status === 503) {
        toast({
          title: 'সিগন্যাল মূল্যায়ন চালানো যায়নি',
          description: body.error ? bnForCode(body.error.code) : 'সংযোগ বন্ধ (fail-closed)।',
          variant: 'destructive',
        });
      } else if (res.status === 500) {
        toast({ title: 'সিগন্যাল মূল্যায়ন ব্যর্থ (FAILED)', description: body.error?.message ?? 'অজানা ত্রুটি।', variant: 'destructive' });
      } else if (body.evaluation) {
        const outcome = body.evaluation.outcome;
        if (outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP') {
          toast({ title: `সেটআপ পাওয়া গেছে: ${outcome === 'BUY_SETUP' ? 'BUY' : 'SELL'} (গবেষণা সিগন্যাল)`, description: 'সিগন্যাল ভিউতে সম্পূর্ণ লেভেল দেখুন — কোনো ট্রেড কার্যকর হয়নি।' });
        } else {
          toast({
            title: `ফলাফল: ${outcome}`,
            description: body.evaluation.reasonCodes.map((c) => bnForCode(c)).join(' ') || 'কোনো কারণ-কোড নেই।',
          });
        }
      }
      await refresh();
    } catch (e) {
      toast({ title: 'সিগন্যাল মূল্যায়ন চালানো যায়নি', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
    } finally {
      setSignalRunning(false);
    }
  }, [marketStatus?.symbol, refresh, syncBeforeRun, toast]);

  // ---- Phase 12 — manual scalper evaluation trigger ----------------------------
  const runScalperNow = useCallback(async () => {
    setScalperRunning(true);
    try {
      const symbol = marketStatus?.symbol ?? SYMBOL;
      await syncBeforeRun(symbol);
      const res = await fetch(`/api/signal/scalper?symbol=${encodeURIComponent(symbol)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        outcome?: string;
        evaluation?: { reasonCodes: string[] };
        execution?: { attempted: boolean; code: string; message: string; lots: number | null } | null;
        error?: { code: string; message: string };
      } | null;
      if (!res.ok || !body?.ok) {
        toast({
          title: 'স্ক্যাল্পার মূল্যায়ন চালানো যায়নি',
          description: body?.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`,
          variant: 'destructive',
        });
      } else if (body.outcome === 'BUY_SETUP' || body.outcome === 'SELL_SETUP') {
        toast({
          title: `স্ক্যাল্পার সেটআপ: ${body.outcome === 'BUY_SETUP' ? 'BUY' : 'SELL'}`,
          description: body.execution
            ? body.execution.message
            : 'রিস্ক-চেক/অটো-এক্সিকিউশন পাইপলাইনে গেছে।',
        });
      } else {
        toast({
          title: `স্ক্যাল্পার ফলাফল: ${body.outcome}`,
          description: body.evaluation?.reasonCodes.map((c) => bnForCode(c)).join(' ') || 'কোনো কারণ-কোড নেই।',
        });
      }
      await refresh();
    } catch (e) {
      toast({ title: 'স্ক্যাল্পার মূল্যায়ন চালানো যায়নি', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
    } finally {
      setScalperRunning(false);
    }
  }, [marketStatus?.symbol, refresh, syncBeforeRun, toast]);

  // ---- Chat submit (Enter-to-send wired in ChatView; logic extracted+tested) ----
  const sendChat = useCallback(
    async (rawMessage?: string) => {
      const message = (rawMessage ?? chatInput).trim();
      if (!canSendChat(message, chatSending)) return;
      setChatInput('');
      setChatMessages((prev) => [...prev, { role: 'user', content: message }]);
      setChatSending(true);
      try {
        const history = buildChatHistory(chatMessages);
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, history }),
          // Master-audit fix: bounded client timeout — a hung request can no
          // longer leave chatSending=true forever (send button stuck).
          signal: AbortSignal.timeout(120_000),
        });
        const body = (await res.json().catch(() => null)) as ChatResponse | null;
        if (res.ok && body?.ok) {
          setChatMessages((prev) => [...prev, { role: 'assistant', content: body.reply, meta: body, isError: false }]);
        } else {
          setChatMessages((prev) => [
            ...prev,
            { role: 'assistant', content: chatApiErrorMessage(body), meta: null, isError: true },
          ]);
        }
      } catch (e) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: chatNetworkErrorMessage(e), meta: null, isError: true },
        ]);
      } finally {
        setChatSending(false);
      }
    },
    [chatInput, chatMessages, chatSending],
  );

  const retryChat = useCallback(() => {
    const text = retryTextFor(chatMessages);
    if (text !== null) {
      // drop the trailing error bubble + its user message; resend
      setChatMessages((prev) => {
        const copy = [...prev];
        if (copy.length && copy[copy.length - 1].role === 'assistant' && copy[copy.length - 1].isError) copy.pop();
        if (copy.length && copy[copy.length - 1].role === 'user') copy.pop();
        return copy;
      });
      void sendChat(text);
    }
  }, [chatMessages, sendChat]);

  const onChatInputChange = useCallback((v: string) => setChatInput(clampChatInput(v)), []);

  // ---- Phase 6 — AI multi-agent review trigger ---------------------------------
  const runAiReview = useCallback(async () => {
    setAiReviewRunning(true);
    try {
      const res = await fetch('/api/ai/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: marketStatus?.symbol ?? SYMBOL, force: true }),
        signal: AbortSignal.timeout(180_000),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; ran?: boolean; reason?: string; review?: { orchestrator?: { verdict?: string } } | null } | null;
      if (res.status === 429) {
        toast({ title: 'রেট লিমিট', description: 'কিছুক্ষণ পরে আবার চেষ্টা করুন।', variant: 'destructive' });
      } else if (body?.ran && body.review?.orchestrator) {
        toast({
          title: 'মাল্টি-এজেন্ট রিভিউ সম্পন্ন',
          description: `সমন্বয়কের রায়: ${body.review.orchestrator.verdict === 'approve' ? 'সম্মত' : body.review.orchestrator.verdict === 'reject' ? 'আপত্তি' : 'অপেক্ষা'}`,
        });
      } else {
        toast({ title: 'রিভিউ চালানো যায়নি', description: body?.reason ?? 'অজানা কারণ।', variant: 'destructive' });
      }
      await refresh();
    } catch (e) {
      toast({ title: 'রিভিউ চালানো যায়নি', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
    } finally {
      setAiReviewRunning(false);
    }
  }, [marketStatus?.symbol, refresh, toast]);

  // ---- Phase 11 — approval decision (the human gate) ---------------------------
  const decideApproval = useCallback(
    async (approvalId: string, decision: 'approve' | 'reject') => {
      setDeciding(true);
      try {
        const res = await fetch('/api/execution/decide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvalId, decision }),
          signal: AbortSignal.timeout(60_000),
        });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; code?: string } | null;
        if (body?.ok) {
          toast({ title: decision === 'approve' ? 'অর্ডার কার্যকর' : 'অনুমোদন বাতিল', description: body.message ?? '' });
        } else {
          toast({ title: 'সিদ্ধান্ত নেওয়া যায়নি', description: body?.message ?? bnForCode(body?.code ?? '') ?? 'অজানা ত্রুটি।', variant: 'destructive' });
        }
        await refresh();
      } catch (e) {
        toast({ title: 'সিদ্ধান্ত নেওয়া যায়নি', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
      } finally {
        setDeciding(false);
      }
    },
    [refresh, toast],
  );

  // ---- Phase 11 — manual position close ------------------------------------------
  const closePosition = useCallback(
    async (positionId: string) => {
      setClosingPositionId(positionId);
      try {
        const res = await fetch('/api/execution/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positionId }),
          signal: AbortSignal.timeout(60_000),
        });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
        if (body?.ok) {
          toast({ title: 'পজিশন ক্লোজ সম্পন্ন', description: body.message ?? '' });
        } else {
          toast({ title: 'ক্লোজ করা যায়নি', description: body?.message ?? 'অজানা ত্রুটি।', variant: 'destructive' });
        }
        await refresh();
      } catch (e) {
        toast({ title: 'ক্লোজ করা যায়নি', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
      } finally {
        setClosingPositionId(null);
      }
    },
    [refresh, toast],
  );

  // ---- Shared view fragments -----------------------------------------------------

  const historyView = (
    <HistoryView
      signalLatest={signalLatest}
      signalHistory={signalHistory}
      candidateHistory={candidateHistory}
      signalRunning={signalRunning}
      onRunSignal={() => void runSignalNow()}
      priceSpec={priceSpec}
      signalError={apiErrors.signal ?? null}
      historyError={apiErrors.history ?? null}
      candidateHistoryError={apiErrors.candidateHistory ?? null}
      loading={loading}
      below={
        <>
          <AiReviewPanel
            review={aiReview}
            running={aiReviewRunning}
            onRun={() => void runAiReview()}
            error={apiErrors.aiReview ?? null}
          />
          <ExecutionPanel
            state={executionState}
            deciding={deciding}
            closingId={closingPositionId}
            onDecide={(id, d) => void decideApproval(id, d)}
            onClose={(pid) => void closePosition(pid)}
            error={apiErrors.execution ?? null}
            livePositions={liveExecutionPositions}
            liveTick={tickStream.status === 'live' ? tickStream.tick : null}
            liveAccount={liveExecutionAccount}
          />
        </>
      }
    />
  );
  const analysisView = (
    <AnalysisView
      analysisLatest={analysisLatest}
      analysisError={analysisError}
      analysisRunning={analysisRunning}
      onRunAnalysis={() => void runAnalysisNow()}
      validationLatest={validationLatest}
      validationError={apiErrors.validation ?? null}
      backtestLatest={backtestLatest}
      backtestError={apiErrors.backtest ?? null}
      signalHistory={signalHistory}
      priceSpec={priceSpec}
      loading={loading}
    />
  );
  const systemView = (
    <SystemView
      audit={audit}
      auditError={apiErrors.audit ?? null}
      health={health}
      marketStatus={marketStatus}
      marketError={apiErrors.market ?? null}
      marketQuality={marketQuality}
      qualityError={apiErrors.quality ?? null}
      dataHealth={dataHealth}
      dhealthError={apiErrors.dhealth ?? null}
      dataLatest={dataLatest}
      backtestLatest={backtestLatest}
      backtestError={apiErrors.backtest ?? null}
      analysisLatest={analysisLatest}
      verifyResult={verifyResult}
      verifying={verifying}
      onRunVerify={() => void runVerify()}
      syncing={syncing}
      onRunSync={() => void runSyncNow()}
      priceSpec={priceSpec}
      quoteDigitsMismatch={quoteDigitsMismatch}
      tickStream={tickStream}
      loading={loading}
    />
  );
  const chatView = (
    <ChatView
      messages={chatMessages}
      input={chatInput}
      sending={chatSending}
      onInputChange={onChatInputChange}
      onSubmit={() => void sendChat()}
      onRetry={retryChat}
      onSuggestion={(q) => setChatInput(q)}
      priceSpec={priceSpec}
    />
  );

  const loadErrorBanner = loadError ? (
    <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
      ডেটা রিফ্রেশ ব্যর্থ ({loadError}) — ১৫ সেকেন্ড পরে আবার চেষ্টা হবে। পুরনো ডেটা দেখানো হচ্ছে, কিছু বানানো হয়নি।
    </div>
  ) : null;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <TerminalHeader
        health={health}
        dataHealth={dataHealth}
        priceSpec={priceSpec}
        chatOpen={chatSheetOpen}
        onOpenChat={() => setChatSheetOpen(true)}
      />

      <main className="flex-1">
        {/* ================= Desktop workspace (lg+) ================= */}
        <div className="hidden lg:block">
          <div className="mx-auto w-full max-w-[1600px] space-y-4 px-6 py-4">
            {loadErrorBanner}
            <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-4">
              <ChartPanel
                symbol={SYMBOL}
                priceSpec={priceSpec}
                marketStatus={marketStatus}
                refreshKey={refreshTick}
                heightClass="h-[540px]"
                liveTick={tickStream.status === 'live' ? tickStream.tick : null}
              />
              <div className="space-y-4">
                {/* Phase 12 — the LIVE scalper strategy is the PRIMARY signal
                 * surface (M1/M5/M15 OR-logic; auto-execution when armed). */}
                <ScalperSignalCard
                  scalper={scalperLatest}
                  running={scalperRunning}
                  onRun={() => void runScalperNow()}
                  priceSpec={priceSpec}
                  error={apiErrors.scalper ?? null}
                  loading={loading}
                  compact
                />
                <SignalCard
                  signalLatest={signalLatest}
                  signalRunning={signalRunning}
                  onRunSignal={() => void runSignalNow()}
                  priceSpec={priceSpec}
                  error={apiErrors.signal ?? null}
                  loading={loading}
                  compact
                />
                {/* Phase 11-E — the research candidate card directly under the
                 * baseline decision card (never merged into it). */}
                <CandidateSignalCard
                  signalLatest={signalLatest}
                  priceSpec={priceSpec}
                  error={apiErrors.signal ?? null}
                  loading={loading}
                  compact
                />
                <MarketSnapshot
                  marketStatus={marketStatus}
                  dataHealth={dataHealth}
                  priceSpec={priceSpec}
                  loading={loading}
                  marketError={apiErrors.market ?? null}
                />
              </div>
            </div>

            <SystemMiniCards health={health} marketStatus={marketStatus} loading={loading} marketError={apiErrors.market ?? null} />

            <Tabs defaultValue="history" className="space-y-4">
              <TabsList className="h-auto w-full max-w-full flex-nowrap bg-zinc-900/60 p-1">
                <TabsTrigger value="history" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
                  সিগন্যাল ইতিহাস
                </TabsTrigger>
                <TabsTrigger value="analysis" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
                  বিশ্লেষণ
                </TabsTrigger>
                <TabsTrigger value="system" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
                  সিস্টেম
                </TabsTrigger>
                {/* Task 33/35 — সেটিংস: Exness MT5 ক্রেডেনশিয়াল UI-import */}
                <TabsTrigger value="settings" className="data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
                  সেটিংস
                </TabsTrigger>
              </TabsList>
              <TabsContent value="history">{historyView}</TabsContent>
              <TabsContent value="analysis">{analysisView}</TabsContent>
              <TabsContent value="system">{systemView}</TabsContent>
              <TabsContent value="settings">
                <BrokerSettingsView />
              </TabsContent>
            </Tabs>
          </div>
        </div>

        {/* ================= Mobile views (<lg) ================= */}
        <div className="lg:hidden">
          <div className="space-y-4 px-3 pb-28 pt-3" data-testid="mobile-view-root">
            {loadErrorBanner}
            {view === 'dashboard' && (
              <div className="space-y-4">
                {/* Phase 12 — the live scalper card on top of the mobile
                 * dashboard (primary signal surface). */}
                <ScalperSignalCard
                  scalper={scalperLatest}
                  running={scalperRunning}
                  onRun={() => void runScalperNow()}
                  priceSpec={priceSpec}
                  error={apiErrors.scalper ?? null}
                  loading={loading}
                />
                <DashboardView
                  health={health}
                  marketStatus={marketStatus}
                  dataHealth={dataHealth}
                  signalLatest={signalLatest}
                  signalRunning={signalRunning}
                  onRunSignal={() => void runSignalNow()}
                  priceSpec={priceSpec}
                  signalError={apiErrors.signal ?? null}
                  marketError={apiErrors.market ?? null}
                  loading={loading}
                  tickStream={tickStream}
                />
              </div>
            )}
            {view === 'chart' && (
              <div className="space-y-4">
                <ChartPanel
                  symbol={SYMBOL}
                  priceSpec={priceSpec}
                  marketStatus={marketStatus}
                  refreshKey={refreshTick}
                  heightClass="h-[58vh] min-h-[340px]"
                  liveTick={tickStream.status === 'live' ? tickStream.tick : null}
                />
                <SystemMiniCards health={health} marketStatus={marketStatus} loading={loading} marketError={apiErrors.market ?? null} />
              </div>
            )}
            {view === 'chat' && <div className="h-[calc(100dvh-11.5rem)] min-h-[420px]">{chatView}</div>}
            {view === 'history' && historyView}
            {view === 'settings' && (
              <div className="pb-2">
                <BrokerSettingsView />
              </div>
            )}
            {view === 'system' && (
              <div className="space-y-4">
                <AnalysisView
                  analysisLatest={analysisLatest}
                  analysisError={analysisError}
                  analysisRunning={analysisRunning}
                  onRunAnalysis={() => void runAnalysisNow()}
                  validationLatest={validationLatest}
                  validationError={apiErrors.validation ?? null}
                  backtestLatest={backtestLatest}
                  backtestError={apiErrors.backtest ?? null}
                  signalHistory={signalHistory}
                  priceSpec={priceSpec}
                  loading={loading}
                />
                {systemView}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ================= Desktop chat Sheet (chart stays visible) ================= */}
      <div className="hidden lg:block">
        <Sheet open={chatSheetOpen} onOpenChange={setChatSheetOpen}>
          <SheetContent side="right" className="w-[420px] border-zinc-800 bg-zinc-950 p-0 sm:max-w-[420px]" data-testid="chat-sheet">
            <SheetHeader className="border-b border-zinc-800 px-4 py-3">
              <SheetTitle className="flex items-center gap-2 text-sm text-zinc-100">
                <MessageCircle className="h-4 w-4 text-amber-400" aria-hidden /> বাংলা এআই চ্যাট
              </SheetTitle>
              <SheetDescription className="sr-only">
                Read-only টুল-ভিত্তিক সহকারী — সিস্টেম স্ট্যাটাস, বাজার ডেটা ও সর্বশেষ মূল্যায়ন নিয়ে বাংলায় প্রশ্ন করুন। ট্রেড চালানোর ক্ষমতা নেই।
              </SheetDescription>
            </SheetHeader>
            <div className="h-[calc(100vh-4rem)]">{chatView}</div>
          </SheetContent>
        </Sheet>
      </div>

      {/* ================= Footer (sticky bottom) ================= */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-2 px-4 pb-20 pt-4 text-xs text-zinc-500 sm:px-6 lg:pb-4 md:flex-row md:items-center md:justify-between">
          <p className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
            XAUUSD AI Trading Agent · {health?.phaseLabel ?? 'Phase —'} ·{' '}
            {health && !health.executionLocked
              ? 'লাইভ ডেমো ট্রেডিং সচল — সিগন্যাল অনুযায়ী অর্ডার যায়'
              : 'রিড-ওনলি মোড'}
          </p>
          <p className="font-mono text-[11px] text-zinc-400">
            Next.js 16 · TypeScript · Prisma/SQLite · z-ai-web-dev-sdk (glm-4-plus)
          </p>
          {/* Honest live posture derived from the backend state — no stale
           * release-gate messaging (Phase 12: the app is fully operational). */}
          <p className="text-zinc-400">
            {health && !health.executionLocked
              ? 'স্ক্যাল্পার M1·M5·M15 সিগন্যাল সচল — রিস্ক-চেক পাস করলে অটো-অর্ডার কার্যকর হয়'
              : `Live Trading: Phase ${health?.executionGatePhase ?? 11} গেট পাস হলে চালু হবে`}
          </p>
        </div>
      </footer>

      {/* ================= Mobile bottom navigation ================= */}
      <nav
        aria-label="প্রধান নেভিগেশন"
        data-testid="bottom-nav"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="mx-auto grid max-w-lg grid-cols-6">
          {NAV_ITEMS.map((item) => {
            const active = view === item.id;
            const Icon =
              item.id === 'dashboard' ? Home
                : item.id === 'chart' ? BarChart3
                  : item.id === 'chat' ? MessageCircle
                    : item.id === 'history' ? Activity
                      : item.id === 'settings' ? SettingsIcon
                        : ShieldCheck;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                aria-current={active ? 'page' : undefined}
                data-testid={item.testId}
                data-view={item.id}
                aria-label={item.labelBn}
                className={`flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10px] transition-colors ${
                  active ? 'text-amber-300' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <Icon className={`h-5 w-5 ${active ? 'text-amber-400' : ''}`} aria-hidden />
                <span className="leading-none">{item.labelBn}</span>
                <span
                  className={`mt-0.5 h-0.5 w-6 rounded-full ${active ? 'bg-amber-400' : 'bg-transparent'}`}
                  aria-hidden
                />
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
