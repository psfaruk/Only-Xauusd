/**
 * FRESH SIGNAL SERVICE — server-side assembly of the Fresh Signal Table
 * (Task 45, Phase 3+5).
 * ----------------------------------------------------------------------------
 * Reads the REAL persisted records only:
 *   · SignalEvaluation — the append-only evaluation audit trail (a published
 *     signal IS an evaluation row with outcome BUY_SETUP | SELL_SETUP; its
 *     `levels`/`evidence`/`quote` JSON are the decision trace);
 *   · PaperSignalOutcome / PaperCandidateOutcome — the read-only forward
 *     tracking rows joined 1:1 by evaluation id;
 *   · MarketCandle — per-TF latest CLOSED candle (data freshness);
 *   · MarketLatestTick — current reference price;
 *   · SyncRun — scheduler health.
 *
 * Freshness is derived by the centralized policy module (./freshness) from
 * persisted event timestamps — never from the request instant alone.
 *
 * HONESTY CONTRACT
 *   · No row is ever synthesized; an empty table is returned as empty.
 *   · The scan is bounded (MAX_SCAN_ROWS) — documented, not hidden.
 *   · DB failures surface as thrown errors (the route maps them to 500);
 *     partial/fabricated data is never returned.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import { config } from '@/lib/config';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';
import { CANDIDATE_STRATEGY_VERSION } from '@/lib/signal/candidate/types';
import { SCALPER_STRATEGY_VERSION } from '@/lib/signal/scalper/types';
import {
  deriveFreshStatus,
  isLiveRow,
  classifyTfData,
  FRESH_STATUS_BN,
  type FreshSignalStatus,
} from '@/lib/signal/freshness';
import { deriveConditionReport, type ConditionReport } from '@/lib/signal/conditions';
import type { SignalLevels } from '@/lib/signal/types';

/** Bounded scan — the fresh table assembles over the most recent N matching
 *  rows. Live setups arrive at ≤ a few per day (six-month backtest ground
 *  truth ≈ 0.2–0.4/day), so 2,000 rows covers months of history. */
export const MAX_SCAN_ROWS = 2_000;

export type FreshSort = 'newest' | 'oldest' | 'timeframe' | 'expiry';
export type FreshScope = 'live' | 'archive';
export type FreshStrategyScope = 'product' | 'baseline' | 'scalper' | 'candidate' | 'all';

export interface FreshSignalQuery {
  symbol: string;
  scope: FreshScope;
  strategy: FreshStrategyScope;
  direction?: 'BUY' | 'SELL';
  timeframe?: Timeframe;
  statuses?: FreshSignalStatus[];
  fromUtcMs?: number;
  toUtcMs?: number;
  searchId?: string;
  sort: FreshSort;
  page: number;
  pageSize: number;
}

export interface FreshSignalRow {
  /** Public signal id (= the persisted evaluation id). */
  id: string;
  symbol: string;
  direction: 'BUY' | 'SELL' | null;
  outcome: string;
  status: FreshSignalStatus;
  statusBn: string;
  sourceTimeframe: Timeframe | null;
  strategyVersion: string;
  engineVersion: string;
  levels: {
    entryReference: number | null;
    entryZoneLow: number | null;
    entryZoneHigh: number | null;
    stopLoss: number | null;
    target: number | null;
    riskPrice: number | null;
    rewardPrice: number | null;
    rewardRiskRatio: number | null;
  };
  /** SMC confluence score/tier when the engine attached one — a confluence
   *  score, explicitly NOT a win probability. */
  smc: { score: number; tier: string | null } | null;
  reasonCodes: string[];
  reasonSummaryBn: string;
  validation: ConditionReport;
  decisionCandleTimeUtc: string | null;
  setupKnownAtUtc: string | null;
  createdAtUtc: string;
  expiryUtc: string | null;
  ageSec: number;
  marketDataTimeUtc: string | null;
  dataAgeSec: number | null;
  currentPrice: { price: number; atUtc: string; source: string } | null;
  movementPrice: number | null;
  movementR: number | null;
  paper: {
    id: string;
    status: string;
    outcome: string | null;
    rMultiple: number | null;
    netPnlPrice: number | null;
    exitPrice: number | null;
    observations: number;
    openedAtUtc: string;
    lastCheckedBarTimeUtc: string | null;
    resolvedAtUtc: string | null;
  } | null;
  /** Derived lifecycle timeline — every entry backed by a persisted column. */
  lifecycle: Array<{ atUtc: string; event: string; detailBn: string }>;
  quote: unknown;
  live: boolean;
}

export interface FreshSignalsResult {
  rows: FreshSignalRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  scanned: number;
}

export interface PipelineHealth {
  symbol: string;
  generatedAtUtc: string;
  dataFreshness: Record<
    string,
    { latestClosedUtc: string | null; ageSec: number | null; staleTfSec: number; state: string }
  >;
  lastSync: { atUtc: string; status: string; inserted: number } | null;
  engines: Array<{
    strategyVersion: string;
    lastEvalAtUtc: string | null;
    lastOutcome: string | null;
    lastReasonCodes: string[];
    evals24h: number;
    setups24h: number;
  }>;
  reasonDistribution24h: Array<{ code: string; n: number }>;
  paper: { open: number; resolved: number; targeted: number; stopped: number; invalidated: number; expired: number };
  tick: { mid: number | null; atUtc: string | null; source: string | null };
}

const TF_ORDER: Record<string, number> = { M1: 0, M5: 1, M15: 2, H1: 3, H4: 4 };

function safeJson<T>(s: string | null, fallback: T): T {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Strategy-version family → the strategyVersions it covers. */
function strategyVersionsFor(scope: FreshStrategyScope): string[] | null {
  switch (scope) {
    case 'baseline':
      return [SIGNAL_STRATEGY_VERSION];
    case 'scalper':
      return [SCALPER_STRATEGY_VERSION];
    case 'candidate':
      return [CANDIDATE_STRATEGY_VERSION];
    case 'all':
      return null; // no filter
    case 'product':
    default:
      return [SIGNAL_STRATEGY_VERSION, SCALPER_STRATEGY_VERSION];
  }
}

/** Source timeframe of an evaluation row (persisted evidence only). */
function sourceTimeframeOf(strategyVersion: string, evidence: unknown): Timeframe | null {
  if (strategyVersion === SCALPER_STRATEGY_VERSION) {
    const ev = evidence as { scalper?: { sourceTimeframe?: string | null } } | null;
    const tf = ev?.scalper?.sourceTimeframe;
    return tf === 'M1' || tf === 'M5' || tf === 'M15' || tf === 'H1' || tf === 'H4' ? tf : null;
  }
  // Hybrid baseline/candidate: the engine's fixed execution timeframe.
  if (strategyVersion === SIGNAL_STRATEGY_VERSION || strategyVersion === CANDIDATE_STRATEGY_VERSION) {
    return 'M15';
  }
  return null;
}

function reasonSummaryBn(codes: string[], outcome: string): string {
  if (codes.length === 0) return outcome;
  return codes.slice(0, 3).join(' · ');
}

interface EvalRow {
  id: string;
  engineVersion: string;
  strategyVersion: string;
  symbol: string;
  outcome: string;
  reasonCodes: string;
  inputFingerprint: string;
  setupFingerprint: string | null;
  datasetFingerprint: string | null;
  levels: string | null;
  evidence: string;
  quote: string;
  decisionCandleTimeUtc: Date | null;
  setupKnownAtUtc: Date | null;
  expiryUtc: Date | null;
  durationMs: number | null;
  createdAt: Date;
}

interface PaperRowLike {
  id: string;
  status: string;
  outcome: string | null;
  rMultiple: string | number | null;
  netPnlPrice: string | number | null;
  exitPrice: string | number | null;
  observations: number;
  createdAt: Date;
  lastCheckedBarTimeUtc: Date | null;
  resolvedAtUtc: Date | null;
}

/**
 * Assemble the Fresh Signal Table page. All enrichment is in-memory over a
 * bounded scan (MAX_SCAN_ROWS), because status/timeframe filters depend on
 * derived state (freshness policy) and JSON columns (evidence), which the
 * database cannot filter natively. Ordering is deterministic: sort key,
 * then createdAt, then id.
 */
export async function getFreshSignals(db: PrismaClient, q: FreshSignalQuery): Promise<FreshSignalsResult> {
  const versions = strategyVersionsFor(q.strategy);
  const now = new Date();
  const nowMs = now.getTime();

  // ---- Base where (all server-validated upstream) -------------------------
  const where: Prisma.SignalEvaluationWhereInput = {
    symbol: q.symbol,
    ...(versions ? { strategyVersion: { in: versions } } : {}),
    ...(q.fromUtcMs || q.toUtcMs
      ? {
          createdAt: {
            ...(q.fromUtcMs ? { gte: new Date(q.fromUtcMs) } : {}),
            ...(q.toUtcMs ? { lte: new Date(q.toUtcMs) } : {}),
          },
        }
      : {}),
  };

  // ---- Fetch (bounded scan, newest-first) ---------------------------------
  const rows: EvalRow[] = await db.signalEvaluation.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_SCAN_ROWS,
  });

  // ---- Per-TF latest closed candles (freshness + current price fallback) --
  const tfFresh: Record<string, { closeMs: number; openIso: string | null }> = {};
  for (const tf of config.market.timeframes) {
    const latest = await db.marketCandle.findFirst({
      where: { symbol: q.symbol, timeframe: tf, isForming: false },
      orderBy: { candleTimeUtc: 'desc' },
      select: { candleTimeUtc: true },
    });
    if (latest) {
      const closeMs = latest.candleTimeUtc.getTime() + TIMEFRAME_SECONDS[tf] * 1000;
      tfFresh[tf] = { closeMs, openIso: latest.candleTimeUtc.toISOString() };
    }
  }

  // ---- Current reference price: latest tick mid, else the freshest CLOSED
  //      candle of ANY timeframe (a real observed price, older, labeled) ----
  const tick = await db.marketLatestTick.findUnique({ where: { symbol: q.symbol } }).catch(() => null);
  let currentPrice: FreshSignalRow['currentPrice'] = null;
  if (tick) {
    const bid = Number(tick.bid);
    const ask = Number(tick.ask);
    if (Number.isFinite(bid) && Number.isFinite(ask)) {
      currentPrice = {
        price: (bid + ask) / 2,
        atUtc: tick.tickTimeUtc.toISOString(),
        source: `tick/${tick.source}`,
      };
    }
  }
  if (!currentPrice) {
    const anyCandle = await db.marketCandle
      .findFirst({
        where: { symbol: q.symbol, isForming: false },
        orderBy: { candleTimeUtc: 'desc' },
        select: { close: true, candleTimeUtc: true, source: true, timeframe: true },
      })
      .catch(() => null);
    if (anyCandle) {
      const c = Number(anyCandle.close);
      if (Number.isFinite(c)) {
        currentPrice = {
          price: c,
          atUtc: anyCandle.candleTimeUtc.toISOString(),
          source: `candle/${anyCandle.timeframe}/${anyCandle.source}`,
        };
      }
    }
  }

  // ---- Paper joins (1:1 by evaluation id; both ledgers) -------------------
  const ids = rows.map((r) => r.id);
  const paperBase = ids.length
    ? await db.paperSignalOutcome.findMany({ where: { signalEvaluationId: { in: ids } } }).catch(() => [])
    : [];
  const paperCand = ids.length
    ? await db.paperCandidateOutcome.findMany({ where: { candidateEvaluationId: { in: ids } } }).catch(() => [])
    : [];
  const paperByEval = new Map<string, PaperRowLike>();
  for (const p of paperBase as unknown as PaperRowLike[]) paperByEval.set((p as unknown as { signalEvaluationId: string }).signalEvaluationId, p);
  for (const p of paperCand as unknown as (PaperRowLike & { candidateEvaluationId: string })[])
    paperByEval.set(p.candidateEvaluationId, p);

  // ---- Enrich --------------------------------------------------------------
  const enriched: FreshSignalRow[] = [];
  for (const row of rows) {
    const levels = row.levels ? safeJson<SignalLevels | null>(row.levels, null) : null;
    const evidence = safeJson<Record<string, unknown>>(row.evidence, {});
    const reasonCodes = safeJson<string[]>(row.reasonCodes, []);
    const paper = paperByEval.get(row.id) ?? null;
    const sourceTf = sourceTimeframeOf(row.strategyVersion, evidence);
    const tfSec = sourceTf ? config.market.staleTfSec[sourceTf] : config.market.staleTfSec.M15;
    const latestClosedMs = sourceTf ? (tfFresh[sourceTf]?.closeMs ?? null) : null;

    const fr = deriveFreshStatus({
      nowMs,
      outcome: row.outcome,
      createdAtMs: row.createdAt.getTime(),
      expiryMs: row.expiryUtc ? row.expiryUtc.getTime() : null,
      paperStatus: paper?.status ?? null,
      paperOutcome: paper?.outcome ?? null,
      paperLastCheckedMs: paper?.lastCheckedBarTimeUtc ? paper.lastCheckedBarTimeUtc.getTime() : null,
      sourceTfLatestClosedMs: latestClosedMs,
      staleTfSec: tfSec,
    });

    const live = isLiveRow(
      fr.status,
      row.expiryUtc ? row.expiryUtc.getTime() : null,
      paper?.status ?? null,
      nowMs,
    );

    const direction: 'BUY' | 'SELL' | null =
      row.outcome === 'BUY_SETUP' ? 'BUY' : row.outcome === 'SELL_SETUP' ? 'SELL' : null;

    const entryRef = levels?.entryReference ?? null;
    const movementPrice =
      currentPrice && entryRef !== null && Number.isFinite(entryRef)
        ? Number((currentPrice.price - entryRef).toFixed(3))
        : null;
    const movementR =
      movementPrice !== null && levels && Number.isFinite(levels.riskPrice) && levels.riskPrice > 0
        ? Number((movementPrice / levels.riskPrice).toFixed(2))
        : null;

    const smcEvidence = (evidence as { smc?: { totalScore?: number; tier?: string | null } }).smc ?? null;
    const smc =
      smcEvidence && typeof smcEvidence.totalScore === 'number'
        ? { score: smcEvidence.totalScore, tier: smcEvidence.tier ?? null }
        : null;

    // Lifecycle timeline — one entry per persisted fact.
    const lifecycle: FreshSignalRow['lifecycle'] = [];
    if (row.decisionCandleTimeUtc)
      lifecycle.push({
        atUtc: row.decisionCandleTimeUtc.toISOString(),
        event: 'DECISION_CANDLE',
        detailBn: 'ডিসিশন ক্যান্ডেল ক্লোজ (ইঞ্জিন এই বার পর্যন্ত ডেটা দেখেছে)',
      });
    if (row.setupKnownAtUtc)
      lifecycle.push({
        atUtc: row.setupKnownAtUtc.toISOString(),
        event: 'SETUP_KNOWN',
        detailBn: 'সেটআপ জানা গেছে (ক্যান্ডেল ক্লোজের পরেই — লুক-অ্যাহেড নেই)',
      });
    lifecycle.push({
      atUtc: row.createdAt.toISOString(),
      event: 'EVALUATED',
      detailBn: `মূল্যায়ন সম্পন্ন — ফলাফল ${row.outcome}`,
    });
    if (paper) {
      lifecycle.push({
        atUtc: paper.createdAt.toISOString(),
        event: 'PAPER_OPENED',
        detailBn: 'রিড-ওনলি পেপার ট্র্যাকিং শুরু (কোনো ব্রোকার অর্ডার নয়)',
      });
      if (paper.observations > 0 && paper.lastCheckedBarTimeUtc)
        lifecycle.push({
          atUtc: paper.lastCheckedBarTimeUtc.toISOString(),
          event: 'PAPER_CHECKED',
          detailBn: `ফরওয়ার্ড চেক ${paper.observations} বার`,
        });
      if (paper.resolvedAtUtc)
        lifecycle.push({
          atUtc: paper.resolvedAtUtc.toISOString(),
          event: 'PAPER_RESOLVED',
          detailBn: `পেপার সমাধান — ${paper.outcome ?? 'unknown'}${paper.rMultiple !== null ? ` (${Number(paper.rMultiple)}R)` : ''}`,
        });
    }

    enriched.push({
      id: row.id,
      symbol: row.symbol,
      direction,
      outcome: row.outcome,
      status: fr.status,
      statusBn: FRESH_STATUS_BN[fr.status],
      sourceTimeframe: sourceTf,
      strategyVersion: row.strategyVersion,
      engineVersion: row.engineVersion,
      levels: {
        entryReference: levels?.entryReference ?? null,
        entryZoneLow: levels?.entryZoneLow ?? null,
        entryZoneHigh: levels?.entryZoneHigh ?? null,
        stopLoss: levels?.stopLoss ?? null,
        target: levels?.target ?? null,
        riskPrice: levels?.riskPrice ?? null,
        rewardPrice: levels?.rewardPrice ?? null,
        rewardRiskRatio: levels?.rewardRiskRatio ?? null,
      },
      smc,
      reasonCodes,
      reasonSummaryBn: reasonSummaryBn(reasonCodes, row.outcome),
      validation: deriveConditionReport({ outcome: row.outcome, reasonCodes, evidence }),
      decisionCandleTimeUtc: iso(row.decisionCandleTimeUtc),
      setupKnownAtUtc: iso(row.setupKnownAtUtc),
      createdAtUtc: row.createdAt.toISOString(),
      expiryUtc: iso(row.expiryUtc),
      ageSec: fr.ageSec,
      marketDataTimeUtc: iso(row.decisionCandleTimeUtc),
      dataAgeSec: fr.dataAgeSec,
      currentPrice,
      movementPrice,
      movementR,
      paper: paper
        ? {
            id: paper.id,
            status: paper.status,
            outcome: paper.outcome,
            rMultiple: paper.rMultiple === null ? null : Number(paper.rMultiple),
            netPnlPrice: paper.netPnlPrice === null ? null : Number(paper.netPnlPrice),
            exitPrice: paper.exitPrice === null ? null : Number(paper.exitPrice),
            observations: paper.observations,
            openedAtUtc: paper.createdAt.toISOString(),
            lastCheckedBarTimeUtc: iso(paper.lastCheckedBarTimeUtc),
            resolvedAtUtc: iso(paper.resolvedAtUtc),
          }
        : null,
      lifecycle,
      quote: safeJson<unknown>(row.quote, null),
      live,
    });
  }

  // ---- Filter (derived-state filters in memory) ----------------------------
  let filtered = enriched;
  if (q.scope === 'live') filtered = filtered.filter((r) => r.live);
  if (q.direction) filtered = filtered.filter((r) => r.direction === q.direction);
  if (q.timeframe) filtered = filtered.filter((r) => r.sourceTimeframe === q.timeframe);
  if (q.statuses && q.statuses.length > 0) filtered = filtered.filter((r) => q.statuses!.includes(r.status));
  if (q.searchId && q.searchId.length >= 2) {
    const needle = q.searchId.toLowerCase();
    filtered = filtered.filter((r) => r.id.toLowerCase().includes(needle));
  }

  // ---- Sort (deterministic; tiebreaks createdAt then id) --------------------
  const byCreated = (a: FreshSignalRow, b: FreshSignalRow) =>
    b.createdAtUtc.localeCompare(a.createdAtUtc) || b.id.localeCompare(a.id);
  switch (q.sort) {
    case 'oldest':
      filtered.sort((a, b) => -byCreated(a, b));
      break;
    case 'timeframe':
      filtered.sort(
        (a, b) =>
          (TF_ORDER[a.sourceTimeframe ?? ''] ?? 99) - (TF_ORDER[b.sourceTimeframe ?? ''] ?? 99) ||
          byCreated(a, b),
      );
      break;
    case 'expiry':
      filtered.sort((a, b) => {
        const ae = a.expiryUtc ?? '9999';
        const be = b.expiryUtc ?? '9999';
        return ae.localeCompare(be) || byCreated(a, b);
      });
      break;
    case 'newest':
    default:
      filtered.sort(byCreated);
      break;
  }

  // ---- Paginate --------------------------------------------------------------
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / q.pageSize));
  const page = Math.min(q.page, totalPages);
  const start = (page - 1) * q.pageSize;
  const rowsPage = filtered.slice(start, start + q.pageSize);

  return { rows: rowsPage, page, pageSize: q.pageSize, total, totalPages, scanned: rows.length };
}

/**
 * Pipeline health block — the observability surface that makes
 * "healthy selective engine" distinguishable from "broken pipeline".
 */
export async function getPipelineHealth(db: PrismaClient, symbol: string): Promise<PipelineHealth> {
  const nowMs = Date.now();
  const since24h = new Date(nowMs - 24 * 3_600_000);

  // Per-TF data freshness.
  const dataFreshness: PipelineHealth['dataFreshness'] = {};
  for (const tf of config.market.timeframes) {
    const latest = await db.marketCandle
      .findFirst({
        where: { symbol, timeframe: tf, isForming: false },
        orderBy: { candleTimeUtc: 'desc' },
        select: { candleTimeUtc: true },
      })
      .catch(() => null);
    const closeMs = latest ? latest.candleTimeUtc.getTime() + TIMEFRAME_SECONDS[tf] * 1000 : null;
    const cls = classifyTfData(nowMs, closeMs, config.market.staleTfSec[tf]);
    dataFreshness[tf] = {
      latestClosedUtc: latest?.candleTimeUtc.toISOString() ?? null,
      ageSec: cls.ageSec === null ? null : Math.round(cls.ageSec),
      staleTfSec: config.market.staleTfSec[tf],
      state: cls.state,
    };
  }

  // Last sync.
  const lastSync = await db.syncRun
    .findFirst({ where: { symbol }, orderBy: { startedAtUtc: 'desc' } })
    .catch(() => null);

  // Engines: last evaluation + 24h counts (all strategy families present).
  const versions = [SIGNAL_STRATEGY_VERSION, SCALPER_STRATEGY_VERSION, CANDIDATE_STRATEGY_VERSION];
  const engines: PipelineHealth['engines'] = [];
  for (const v of versions) {
    const last = await db.signalEvaluation
      .findFirst({ where: { symbol, strategyVersion: v }, orderBy: { createdAt: 'desc' } })
      .catch(() => null);
    const agg = (await db.signalEvaluation
      .groupBy({
        by: ['outcome'],
        where: { symbol, strategyVersion: v, createdAt: { gte: since24h } },
        _count: { _all: true },
      })
      .catch(() => [])) as Array<{ outcome: string; _count: { _all: number } }>;
    const evals24h = agg.reduce((s: number, a) => s + a._count._all, 0);
    const setups24h = agg
      .filter((a) => a.outcome === 'BUY_SETUP' || a.outcome === 'SELL_SETUP')
      .reduce((s: number, a) => s + a._count._all, 0);
    engines.push({
      strategyVersion: v,
      lastEvalAtUtc: iso(last?.createdAt),
      lastOutcome: last?.outcome ?? null,
      lastReasonCodes: last ? safeJson<string[]>(last.reasonCodes, []) : [],
      evals24h,
      setups24h,
    });
  }

  // Reason distribution over the last 24h (all product engines together).
  const recent = await db.signalEvaluation
    .findMany({
      where: { symbol, createdAt: { gte: since24h } },
      select: { reasonCodes: true },
      take: 5_000,
      orderBy: { createdAt: 'desc' },
    })
    .catch(() => [] as Array<{ reasonCodes: string }>);
  const dist = new Map<string, number>();
  for (const r of recent) {
    for (const code of safeJson<string[]>(r.reasonCodes, [])) {
      dist.set(code, (dist.get(code) ?? 0) + 1);
    }
  }
  const reasonDistribution24h = [...dist.entries()]
    .map(([code, n]) => ({ code, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 10);

  // Paper ledger counts.
  const paperAgg = await db.paperSignalOutcome
    .groupBy({ by: ['status', 'outcome'], where: { symbol }, _count: { _all: true } })
    .catch(
      () =>
        [] as Array<{ status: string; outcome: string | null; _count: { _all: number } }>,
    );
  const paper = { open: 0, resolved: 0, targeted: 0, stopped: 0, invalidated: 0, expired: 0 };
  for (const p of paperAgg) {
    if (p.status === 'open') paper.open += p._count._all;
    else {
      paper.resolved += p._count._all;
      if (p.outcome === 'targeted') paper.targeted += p._count._all;
      else if (p.outcome === 'stopped') paper.stopped += p._count._all;
      else if (p.outcome === 'invalidated') paper.invalidated += p._count._all;
      else if (p.outcome === 'expired') paper.expired += p._count._all;
    }
  }

  // Tick.
  const tick = await db.marketLatestTick.findUnique({ where: { symbol } }).catch(() => null);
  let tickMid: number | null = null;
  if (tick) {
    const bid = Number(tick.bid);
    const ask = Number(tick.ask);
    if (Number.isFinite(bid) && Number.isFinite(ask)) tickMid = (bid + ask) / 2;
  }

  return {
    symbol,
    generatedAtUtc: new Date().toISOString(),
    dataFreshness,
    lastSync: lastSync
      ? {
          atUtc: lastSync.startedAtUtc.toISOString(),
          status: lastSync.status,
          inserted: lastSync.inserted,
        }
      : null,
    engines,
    reasonDistribution24h,
    paper,
    tick: { mid: tickMid, atUtc: iso(tick?.tickTimeUtc), source: tick?.source ?? null },
  };
}
