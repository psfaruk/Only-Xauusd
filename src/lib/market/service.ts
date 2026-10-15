/**
 * XAUUSD AI Trading Agent — Market Data Service (Phase 3)
 * ----------------------------------------------------------------------------
 * Orchestration layer between the /api/data/* routes and the market libs.
 * Routes stay thin; every response is typed and UTC ISO-8601.
 *
 * Fail-closed rules:
 *   · Bridge unreachable/not configured → structured BRIDGE_* error in the
 *     status payload; readiness degrades to UNAVAILABLE; nothing fabricated.
 *   · The bridge probe is cached briefly (10s) so dashboard polling cannot
 *     hammer the bridge.
 */

import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { bridgeClient, createBridgeClient } from './bridge-client';
import { computeReadiness } from './quality';
import { runSync, isSyncRunning, type SyncOptions } from './ingestion';
import type { CandlesQuery, SyncTriggerBody } from './schemas';
import type { ReadinessResult, Timeframe } from './types';

// ---------------------------------------------------------------------------
// Symbol resolution (single-symbol deployments: first allowlisted symbol)
// ---------------------------------------------------------------------------

export function defaultMarketSymbol(): string {
  return config.market.symbols[0] ?? 'XAUUSDm';
}

// ---------------------------------------------------------------------------
// Bridge probe (cached — bounded network usage)
// ---------------------------------------------------------------------------

export interface BridgeProbe {
  configured: boolean;
  reachable: boolean;
  probedAtUtc: string;
  health: { ok: boolean; service: string | null; connected: boolean | null; uptimeSec: number | null } | null;
  status: { connected: boolean; source: string; server: string | null; latencyMs: number | null; reason: string | null } | null;
  error: { code: string; message: string } | null;
}

let probeCache: { at: number; value: BridgeProbe } | null = null;
const PROBE_TTL_MS = 10_000;

/** Short-timeout, zero-retry client for liveness probing only. */
const probeClient = createBridgeClient({ timeoutMs: 2_500, maxRetries: 0 });

export async function probeBridge(force = false): Promise<BridgeProbe> {
  if (!force && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return probeCache.value;
  }
  let value: BridgeProbe;
  if (!config.bridge.url) {
    value = {
      configured: false,
      reachable: false,
      probedAtUtc: new Date().toISOString(),
      health: null,
      status: null,
      error: { code: 'BRIDGE_NOT_CONFIGURED', message: 'MT5_BRIDGE_URL is not set — no bridge to probe (fail closed).' },
    };
  } else {
    const health = await probeClient.getHealth();
    if (!health.ok) {
      value = {
        configured: true,
        reachable: false,
        probedAtUtc: new Date().toISOString(),
        health: null,
        status: null,
        error: { code: health.error.code, message: health.error.message },
      };
    } else {
      const status = await probeClient.getStatus();
      value = {
        configured: true,
        reachable: true,
        probedAtUtc: new Date().toISOString(),
        health: {
          ok: health.data.ok,
          service: health.data.service ?? null,
          connected: typeof health.data.connected === 'boolean' ? health.data.connected : null,
          uptimeSec: typeof health.data.uptime === 'number' ? health.data.uptime : null,
        },
        status: status.ok
          ? {
              connected: status.data.connected,
              source: String(status.data.source),
              server: status.data.server ?? null,
              latencyMs: status.data.latencyMs ?? null,
              reason: status.data.reason ?? null,
            }
          : null,
        error: null,
      };
    }
  }
  probeCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// GET /api/data/status — one rich snapshot for the dashboard
// ---------------------------------------------------------------------------

export interface MarketStatusPayload {
  ok: true;
  symbol: string;
  bridge: BridgeProbe;
  readiness: ReadinessResult;
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

export interface SyncRunSummary {
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

function toSummary(r: {
  id: string; mode: string; source: string; symbol: string; timeframes: string;
  status: string; startedAtUtc: Date; endedAtUtc: Date | null; durationMs: number | null;
  requested: number; received: number; inserted: number; updated: number; rejected: number; duplicates: number;
  errorCode: string | null; errorMessage: string | null;
}): SyncRunSummary {
  let tfs: string[] = [];
  try {
    tfs = JSON.parse(r.timeframes) as string[];
  } catch {
    tfs = [];
  }
  return {
    id: r.id,
    mode: r.mode,
    source: r.source,
    symbol: r.symbol,
    timeframes: tfs,
    status: r.status,
    startedAtUtc: r.startedAtUtc.toISOString(),
    endedAtUtc: r.endedAtUtc ? r.endedAtUtc.toISOString() : null,
    durationMs: r.durationMs,
    requested: r.requested,
    received: r.received,
    inserted: r.inserted,
    updated: r.updated,
    rejected: r.rejected,
    duplicates: r.duplicates,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
  };
}

export async function getMarketStatus(symbol: string): Promise<MarketStatusPayload> {
  const [bridge, readiness] = await Promise.all([probeBridge(), computeReadiness({ symbol })]);
  const [lastRun, lastSuccess, lastFailure] = await Promise.all([
    db.syncRun.findFirst({ where: { symbol }, orderBy: { startedAtUtc: 'desc' } }).catch(() => null),
    db.syncRun.findFirst({ where: { symbol, status: 'success' }, orderBy: { startedAtUtc: 'desc' } }).catch(() => null),
    db.syncRun
      .findFirst({ where: { symbol, status: { in: ['failed', 'partial'] } }, orderBy: { startedAtUtc: 'desc' } })
      .catch(() => null),
  ]);
  return {
    ok: true,
    symbol,
    bridge,
    readiness,
    sync: {
      running: isSyncRunning(),
      lastRun: lastRun ? toSummary(lastRun) : null,
      lastSuccess: lastSuccess ? toSummary(lastSuccess) : null,
      lastFailure: lastFailure ? toSummary(lastFailure) : null,
    },
    config: {
      symbols: config.market.symbols,
      timeframes: config.market.timeframes,
      staleTickSec: config.market.staleTickSec,
      staleTfSec: { ...config.market.staleTfSec },
      ingestDemo: config.market.ingestDemo,
      syncIntervalMs: config.market.syncIntervalMs,
    },
    generatedAtUtc: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/data/candles — bounded, typed history read
// ---------------------------------------------------------------------------

export async function getCandles(query: CandlesQuery) {
  const where: Record<string, unknown> = {
    symbol: query.symbol,
    timeframe: query.tf,
    ...(query.includeForming ? {} : { isForming: false }),
  };
  if (query.from || query.to) {
    where.candleTimeUtc = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
  }
  const rows = await db.marketCandle.findMany({
    where,
    orderBy: { candleTimeUtc: 'desc' },
    take: query.limit,
  });
  const candles = rows
    .map((r) => ({
      symbol: r.symbol,
      timeframe: r.timeframe,
      candleTimeUtc: r.candleTimeUtc.toISOString(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      tickVolume: r.tickVolume,
      spread: r.spread,
      isForming: r.isForming,
      validationStatus: r.validationStatus,
      source: r.source,
      receivedAtUtc: r.receivedAtUtc.toISOString(),
    }))
    .sort((a, b) => a.candleTimeUtc.localeCompare(b.candleTimeUtc)); // ascending

  return {
    ok: true as const,
    symbol: query.symbol,
    timeframe: query.tf,
    count: candles.length,
    includeForming: query.includeForming,
    candles,
    meta: {
      note: 'Prices are exact decimal strings. Forming candles are excluded unless includeForming=true.',
      earliestUtc: candles.length > 0 ? candles[0].candleTimeUtc : null,
      latestUtc: candles.length > 0 ? candles[candles.length - 1].candleTimeUtc : null,
    },
    generatedAtUtc: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/data/latest — latest validated tick + verified spec
// ---------------------------------------------------------------------------

export async function getLatestTick(symbol: string) {
  const [tick, spec] = await Promise.all([
    db.marketLatestTick.findUnique({ where: { symbol } }).catch(() => null),
    db.symbolSpec.findUnique({ where: { symbol } }).catch(() => null),
  ]);
  let verifiedFields: string[] = [];
  let specMeta: unknown = null;
  if (spec) {
    try {
      verifiedFields = JSON.parse(spec.verifiedFields) as string[];
      specMeta = spec.meta ? JSON.parse(spec.meta) : null;
    } catch {
      verifiedFields = [];
    }
  }
  return {
    ok: true as const,
    symbol,
    tick: tick
      ? {
          bid: tick.bid,
          ask: tick.ask,
          spread: tick.spread,
          spreadPoints: tick.spreadPoints,
          tickTimeUtc: tick.tickTimeUtc.toISOString(),
          receivedAtUtc: tick.receivedAtUtc.toISOString(),
          source: tick.source,
          validationStatus: tick.validationStatus,
        }
      : null,
    spec: spec
      ? {
          digits: spec.digits,
          point: spec.point,
          tickSize: spec.tickSize,
          tickValue: spec.tickValue,
          volumeMin: spec.volumeMin,
          volumeMax: spec.volumeMax,
          volumeStep: spec.volumeStep,
          source: spec.source,
          verifiedFields,
          meta: specMeta,
          lastVerifiedAtUtc: spec.lastVerifiedAt.toISOString(),
        }
      : null,
    note: 'No tick stored yet — the bridge has not returned a valid quote (fail closed; nothing fabricated).',
    generatedAtUtc: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/data/quality — readiness + open issues + thresholds
// ---------------------------------------------------------------------------

export async function getQualityReport(symbol: string, issuesLimit = 50) {
  const readiness = await computeReadiness({ symbol });
  const issues = await db.dataQualityIssue
    .findMany({
      where: { symbol, resolutionStatus: 'open' },
      orderBy: { checkedAtUtc: 'desc' },
      take: Math.min(Math.max(1, issuesLimit), 200),
    })
    .catch(() => []);
  return {
    ok: true as const,
    symbol,
    readiness,
    thresholds: {
      tick: { staleAfterSec: config.market.staleTickSec },
      timeframes: { ...config.market.staleTfSec },
    },
    openIssues: issues.map((i) => ({
      id: i.id,
      checkType: i.checkType,
      timeframe: i.timeframe,
      severity: i.severity,
      errorCode: i.errorCode,
      targetTimeUtc: i.targetTimeUtc ? i.targetTimeUtc.toISOString() : null,
      details: (() => {
        try {
          return JSON.parse(i.details);
        } catch {
          return { detail: i.details };
        }
      })(),
      checkedAtUtc: i.checkedAtUtc.toISOString(),
    })),
    generatedAtUtc: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/data/sync-status — run history + aggregates
// ---------------------------------------------------------------------------

export async function getSyncStatus(limit: number, symbol?: string) {
  const runs = await db.syncRun
    .findMany({
      where: symbol ? { symbol } : undefined,
      orderBy: { startedAtUtc: 'desc' },
      take: limit,
    })
    .catch(() => []);
  const [total, succeeded, failed] = await Promise.all([
    db.syncRun.count({ where: symbol ? { symbol } : undefined }).catch(() => 0),
    db.syncRun.count({ where: { ...(symbol ? { symbol } : {}), status: 'success' } }).catch(() => 0),
    db.syncRun.count({ where: { ...(symbol ? { symbol } : {}), status: { in: ['failed', 'partial'] } } }).catch(() => 0),
  ]);
  return {
    ok: true as const,
    running: isSyncRunning(),
    runs: runs.map(toSummary),
    aggregates: { total, succeeded, failed: failed },
    generatedAtUtc: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// POST /api/data/sync — trigger (manual or bounded backfill)
// ---------------------------------------------------------------------------

export async function triggerSync(body: SyncTriggerBody) {
  const opts: SyncOptions = {
    mode: body.mode,
    symbol: body.symbol,
    timeframes: (body.timeframes ?? (config.market.timeframes as Timeframe[])) as Timeframe[],
    rangeStartUtc: body.rangeStartUtc ? new Date(body.rangeStartUtc) : null,
    rangeEndUtc: body.rangeEndUtc ? new Date(body.rangeEndUtc) : null,
  };
  const outcome = await runSync({ bridge: bridgeClient, db }, opts);
  return { ok: true as const, outcome };
}
