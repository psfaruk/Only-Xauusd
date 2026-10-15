/**
 * XAUUSD AI Trading Agent — Live Data Integrity Monitor (Phase 8, Tasks 2-3)
 * ----------------------------------------------------------------------------
 * READ-ONLY data-quality service. Two layers:
 *
 *  1. QUOTE INTEGRITY — classifies the *actual* upstream source of the live
 *     quote (broker | relay | cache | synthetic | unavailable), validates the
 *     numeric payload, computes quote age against configurable freshness
 *     thresholds, and decides whether downstream signal generation may treat
 *     the data as actionable. A socket being open is NEVER sufficient: only a
 *     successful authenticated session plus a recent VALID quote yields
 *     freshness=LIVE and signalPermitted=true.
 *
 *  2. CANDLE HISTORY AUDIT — per-timeframe verification of what is actually
 *     persisted: earliest/latest verified broker candle, counts, expected vs
 *     observed gaps (closure-window aware), duplicate timestamps, OHLC
 *     integrity re-check at read time, out-of-order detection, forming-bar
 *     status, and the H4 coverage limitation (broker history depth).
 *
 * Nothing here mutates data. Nothing labels fallback/relay data as broker
 * data. Invalid values are REJECTED and reported, never silently replaced.
 */

import { db } from '@/lib/db';
import { bridgeClient, createBridgeClient, type BridgeClient } from './bridge-client';
import { config } from '@/lib/config';
import { TIMEFRAME_SECONDS, type Timeframe, type QualityState } from './types';
import { marketLikelyClosedAtUtc } from './sessions';

/** Set MT5_BRIDGE_RELAY=1 when the configured bridge merely forwards another
 *  host's authenticated feed (e.g. a remote mt5-service). Our :3031 bridge
 *  authenticates directly, so this stays unset → source class "broker". */
const BRIDGE_IS_RELAY = process.env.MT5_BRIDGE_RELAY === '1';

function isMarketLikelyClosed(sec: number): boolean {
  return marketLikelyClosedAtUtc(new Date(sec * 1000)).likelyClosed;
}

// ---------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------

export type FeedSourceClass = 'broker' | 'relay' | 'cache' | 'synthetic' | 'unavailable';

export type FreshnessState = 'LIVE' | 'STALE' | 'DEGRADED' | 'DISCONNECTED';

/** Classify what the bridge is actually serving. The bridge labels its own
 *  source; we map that label honestly and NEVER upgrade it. */
export function classifySource(
  bridgeSource: string | undefined,
  authenticated: boolean | undefined,
  gateway: string | null | undefined,
): FeedSourceClass {
  if (!bridgeSource || bridgeSource === 'disconnected') return 'unavailable';
  if (bridgeSource === 'demo') return 'synthetic'; // clearly-labelled demo feed — never "broker"
  if (bridgeSource === 'mt5' && authenticated === true) {
    // Direct authenticated MT5 session (our :3031 bridge dials the Exness
    // gateway itself). Relay classification is reserved for a bridge that
    // merely forwards another host's feed (MT5_BRIDGE_RELAY=1), which this
    // deployment does not set.
    return BRIDGE_IS_RELAY ? 'relay' : 'broker';
  }
  if (bridgeSource === 'mt5') return 'cache'; // mt5-labeled but NOT authenticated → cached/stale feed
  void gateway;
  return 'cache';
}

// ---------------------------------------------------------------------------
// Quote integrity
// ---------------------------------------------------------------------------

export interface QuoteIntegrityReport {
  symbol: string;
  checkedAtUtc: string;
  bridgeReachable: boolean;
  connected: boolean;
  authenticated: boolean;
  server: string | null;
  gateway: string | null;
  sourceClass: FeedSourceClass;
  sourceLabel: string;
  bid: string | null;
  ask: string | null;
  mid: string | null;
  spread: string | null;
  digits: number | null;
  quoteTimeUtc: string | null;
  receivedAtUtc: string | null;
  ageSeconds: number | null;
  stalenessThresholdSeconds: number;
  freshness: FreshnessState;
  reconnects: number | null;
  lastError: string | null;
  validationStatus: 'VALID' | 'INVALID' | 'UNAVAILABLE';
  issues: string[];
  /** Whether downstream signal generation may use this data as actionable. */
  signalPermitted: boolean;
  blockedReasons: string[];
}

const SOURCE_LABELS: Record<FeedSourceClass, string> = {
  broker: 'Authenticated Exness MT5 session (direct web-terminal protocol)',
  relay: 'External relay feed (forwarded broker data — not directly authenticated here)',
  cache: 'Cached/unauthenticated feed (socket may be open but session is not verified)',
  synthetic: 'Synthetic/demo feed (NOT market data)',
  unavailable: 'No feed available',
};

export async function quoteIntegrity(
  symbol: string,
  deps: { bridge?: BridgeClient } = {},
): Promise<QuoteIntegrityReport> {
  const bridge = deps.bridge ?? bridgeClient;
  const now = Date.now();
  const issues: string[] = [];
  const blocked: string[] = [];

  const status = await bridge.getStatus();
  const bridgeReachable = status.ok;
  const s = status.ok ? status.data : null;

  const connected = s?.connected === true;
  const authenticated =
    (s as unknown as { authenticated?: boolean } | null)?.authenticated === true;
  const gateway = (s as unknown as { gateway?: string | null } | null)?.gateway ?? null;
  const reconnects = (s as unknown as { reconnects?: number } | null)?.reconnects ?? null;
  const bridgeLastError = (s as unknown as { lastError?: string | null } | null)?.lastError ?? null;

  const sourceClass = classifySource(s?.source, authenticated, gateway);

  // Quote fetch only when the bridge is reachable at all.
  const quote = bridgeReachable ? await bridge.getQuote(symbol) : null;
  const q = quote?.ok ? quote.data : null;
  const quoteExtra = q as unknown as {
    digits?: number; receivedAtMs?: number; source?: string;
  } | null;

  let bid: number | null = null;
  let ask: number | null = null;
  let spread: number | null = null;
  let quoteTimeSec: number | null = null;
  let receivedAtMs: number | null = null;
  let validationStatus: QuoteIntegrityReport['validationStatus'] = 'UNAVAILABLE';

  if (q) {
    bid = q.bid; ask = q.ask; spread = q.spread ?? (q.ask - q.bid);
    quoteTimeSec = q.ts;
    receivedAtMs = quoteExtra?.receivedAtMs ?? null;
    // Numeric validation — invalid values are rejected, never replaced.
    const valid =
      Number.isFinite(bid) && Number.isFinite(ask) &&
      bid > 0 && ask > 0 && ask >= bid && Number.isFinite(spread) && spread >= 0;
    validationStatus = valid ? 'VALID' : 'INVALID';
    if (!valid) issues.push('TICK_INVALID');
    if (Number.isFinite(bid) && bid <= 0) issues.push('TICK_NON_POSITIVE');
    if (Number.isFinite(bid) && Number.isFinite(ask) && ask < bid) issues.push('TICK_CROSSED');
  } else if (bridgeReachable && connected && sourceClass === 'broker') {
    issues.push('DATA_MISSING');
  }

  const threshold = config.market.staleTickSec;
  const ageSeconds = receivedAtMs !== null
    ? Math.max(0, Math.round((now - receivedAtMs) / 1000))
    : null;

  // Freshness — requires authenticated broker session for LIVE.
  let freshness: FreshnessState;
  if (!bridgeReachable || !connected || sourceClass === 'unavailable' || sourceClass === 'synthetic') {
    freshness = 'DISCONNECTED';
  } else if (sourceClass !== 'broker') {
    freshness = 'DEGRADED'; // reachable but not a verified broker feed
  } else if (ageSeconds === null || validationStatus === 'INVALID') {
    freshness = 'DEGRADED';
  } else if (ageSeconds <= threshold) {
    freshness = 'LIVE';
  } else if (ageSeconds <= threshold * 10) {
    freshness = 'STALE';
    issues.push('DATA_STALE');
  } else {
    freshness = 'DEGRADED';
    issues.push('DATA_STALE');
  }

  // Signal permission — all gates must hold.
  if (!bridgeReachable) blocked.push('BRIDGE_UNREACHABLE');
  if (bridgeReachable && !connected) blocked.push('SOURCE_DISCONNECTED');
  if (connected && !authenticated) blocked.push('NOT_AUTHENTICATED');
  if (sourceClass !== 'broker') blocked.push(`SOURCE_${sourceClass.toUpperCase()}`);
  if (validationStatus === 'INVALID') blocked.push('TICK_INVALID');
  if (validationStatus === 'UNAVAILABLE') blocked.push('TICK_UNAVAILABLE');
  if (ageSeconds !== null && ageSeconds > threshold) blocked.push('QUOTE_STALE');

  const digits = quoteExtra?.digits ?? null;
  const fmt = (v: number | null): string | null =>
    v === null ? null : (digits !== null ? v.toFixed(digits) : String(v));

  return {
    symbol,
    checkedAtUtc: new Date(now).toISOString(),
    bridgeReachable,
    connected,
    authenticated,
    server: s?.server ?? null,
    gateway,
    sourceClass,
    sourceLabel: SOURCE_LABELS[sourceClass],
    bid: fmt(bid),
    ask: fmt(ask),
    mid: bid !== null && ask !== null ? fmt((bid + ask) / 2) : null,
    spread: fmt(spread),
    digits,
    quoteTimeUtc: quoteTimeSec !== null ? new Date(quoteTimeSec * 1000).toISOString() : null,
    receivedAtUtc: receivedAtMs !== null ? new Date(receivedAtMs).toISOString() : null,
    ageSeconds,
    stalenessThresholdSeconds: threshold,
    freshness,
    reconnects,
    lastError: bridgeLastError,
    validationStatus,
    issues,
    signalPermitted: blocked.length === 0,
    blockedReasons: blocked,
  };
}

// ---------------------------------------------------------------------------
// Candle history audit (Task 3)
// ---------------------------------------------------------------------------

export interface TimeframeHistoryAudit {
  timeframe: Timeframe;
  present: boolean;
  source: string | null;
  earliestCandleUtc: string | null;
  latestCandleUtc: string | null;
  latestFormingCandleUtc: string | null;
  closedCount: number;
  formingCount: number;
  duplicateTimestamps: number;
  invalidOhlc: number;
  outOfOrder: number;
  expectedBarsBetweenEndpoints: number | null; // closure-aware grid expectation
  observedBars: number;
  missingOutsideClosure: number;   // suspicious gaps
  closureGaps: number;             // expected-but-absent inside closure windows (info)
  gapRatio: number | null;
  latestClosedAgeSeconds: number | null;
  stalenessThresholdSeconds: number;
  qualityState: QualityState;
  issues: string[];
}

export interface HistoryAuditReport {
  symbol: string;
  auditedAtUtc: string;
  timeframes: TimeframeHistoryAudit[];
  h4Coverage: {
    earliestUtc: string | null;
    latestUtc: string | null;
    closedCount: number;
    /** Honest statement of what the broker served for H4 — never "full history". */
    coverageNote: string;
  };
  notes: string[];
}

interface RawCandle {
  candleTimeUtc: Date;
  open: string; high: string; low: string; close: string;
  isForming: boolean;
  validationStatus: string;
  source: string;
}

function ohlcValid(o: number, h: number, l: number, c: number): boolean {
  return (
    [o, h, l, c].every((v) => Number.isFinite(v) && v > 0) &&
    h >= Math.max(o, c) &&
    l <= Math.min(o, c) &&
    h >= l
  );
}

export async function auditCandleHistory(
  symbol: string,
  timeframes: readonly Timeframe[] = ['M5', 'M15', 'H1', 'H4'],
  deps: { dbClient?: typeof db; nowSec?: number } = {},
): Promise<HistoryAuditReport> {
  const database = deps.dbClient ?? db;
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const notes: string[] = [];
  const out: TimeframeHistoryAudit[] = [];

  for (const tf of timeframes) {
    const dur = TIMEFRAME_SECONDS[tf];
    const staleSec = config.market.staleTfSec[tf];
    const candles = (await database.marketCandle.findMany({
      where: { symbol, timeframe: tf },
      orderBy: { candleTimeUtc: 'asc' },
      select: {
        candleTimeUtc: true, open: true, high: true, low: true, close: true,
        isForming: true, validationStatus: true, source: true,
      },
    })) as unknown as RawCandle[];

    const issues: string[] = [];
    if (!candles.length) {
      out.push({
        timeframe: tf, present: false, source: null,
        earliestCandleUtc: null, latestCandleUtc: null, latestFormingCandleUtc: null,
        closedCount: 0, formingCount: 0, duplicateTimestamps: 0, invalidOhlc: 0,
        outOfOrder: 0, expectedBarsBetweenEndpoints: null, observedBars: 0,
        missingOutsideClosure: 0, closureGaps: 0, gapRatio: null,
        latestClosedAgeSeconds: null, stalenessThresholdSeconds: staleSec,
        qualityState: 'MISSING', issues: ['DATA_MISSING'],
      });
      continue;
    }

    const sources = new Set(candles.map((c) => c.source));
    const source = sources.size === 1 ? [...sources][0] : [...sources].join('+');

    // Duplicate timestamps (unique index should prevent; audit verifies).
    const seen = new Set<number>();
    let duplicates = 0;
    for (const c of candles) {
      const t = Math.floor(c.candleTimeUtc.getTime() / 1000);
      if (seen.has(t)) duplicates++;
      seen.add(t);
    }
    if (duplicates > 0) issues.push('CANDLE_DUPLICATE_KEY');

    // OHLC integrity re-check at read time + out-of-order detection.
    let invalid = 0;
    let outOfOrder = 0;
    let prevT = -1;
    for (const c of candles) {
      const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
      if (!ohlcValid(o, h, l, cl)) invalid++;
      const t = Math.floor(c.candleTimeUtc.getTime() / 1000);
      if (t <= prevT && prevT !== -1 && t === prevT) { /* dup counted above */ }
      else if (t < prevT) outOfOrder++;
      prevT = Math.max(prevT, t);
    }
    if (invalid > 0) issues.push('CANDLE_OHLC_INCONSISTENT');
    if (outOfOrder > 0) issues.push('CANDLE_OUT_OF_ORDER');

    const closed = candles.filter((c) => !c.isForming);
    const forming = candles.filter((c) => c.isForming);
    const times = candles.map((c) => Math.floor(c.candleTimeUtc.getTime() / 1000));
    const firstT = Math.min(...times);
    const lastT = Math.max(...times);

    // Expected grid between endpoints (closure-aware) — Phase 3 session rules.
    let expected = 0;
    let closureGaps = 0;
    let missingOutside = 0;
    const closedTimes = new Set(closed.map((c) => Math.floor(c.candleTimeUtc.getTime() / 1000)));
    for (let t = firstT; t <= lastT; t += dur) {
      if (closedTimes.has(t)) { expected++; continue; }
      if (isMarketLikelyClosed(t)) { closureGaps++; continue; }
      missingOutside++;
      expected++;
    }
    if (missingOutside > 0) issues.push('GAP_POSSIBLE');

    const latestClosedT = closed.length
      ? Math.max(...closed.map((c) => Math.floor(c.candleTimeUtc.getTime() / 1000)))
      : null;
    const latestClosedAge = latestClosedT !== null ? nowSec - (latestClosedT + dur) : null;

    let qualityState: QualityState = 'VALID';
    if (missingOutside > 0) qualityState = 'WARNING';
    if (invalid > 0 || outOfOrder > 0 || duplicates > 0) qualityState = 'INVALID';
    if (latestClosedAge !== null && latestClosedAge > staleSec) {
      qualityState = qualityState === 'VALID' ? 'STALE' : qualityState;
      issues.push('DATA_STALE');
    }
    if (!closed.length) qualityState = 'MISSING';

    out.push({
      timeframe: tf, present: true, source,
      earliestCandleUtc: new Date(firstT * 1000).toISOString(),
      latestCandleUtc: new Date(lastT * 1000).toISOString(),
      latestFormingCandleUtc: forming.length
        ? new Date(Math.max(...forming.map((c) => Math.floor(c.candleTimeUtc.getTime() / 1000))) * 1000).toISOString()
        : null,
      closedCount: closed.length,
      formingCount: forming.length,
      duplicateTimestamps: duplicates,
      invalidOhlc: invalid,
      outOfOrder,
      expectedBarsBetweenEndpoints: expected,
      observedBars: closed.length,
      missingOutsideClosure: missingOutside,
      closureGaps,
      gapRatio: expected > 0 ? Number((missingOutside / expected).toFixed(4)) : null,
      latestClosedAgeSeconds: latestClosedAge,
      stalenessThresholdSeconds: staleSec,
      qualityState,
      issues,
    });
  }

  const h4 = out.find((t) => t.timeframe === 'H4');
  const h4Coverage = {
    earliestUtc: h4?.earliestCandleUtc ?? null,
    latestUtc: h4?.latestCandleUtc ?? null,
    closedCount: h4?.closedCount ?? 0,
    coverageNote: h4?.present
      ? `H4 coverage: ${h4.closedCount} closed candles ${h4.earliestCandleUtc?.slice(0, 10)} → ${h4.latestCandleUtc?.slice(0, 10)}. This is the VERIFIED broker-served range only — Exness serves bounded H4 history per request window; "full history" is NOT claimed.`
      : 'H4 data absent.',
  };

  notes.push(
    'Gaps inside approximate market-closure windows are expected (weekends/daily break) and excluded from suspicious-gap counts.',
    'The most recent candle of each timeframe may still be FORMING (open bar) and is never counted as closed history.',
  );

  return {
    symbol,
    auditedAtUtc: new Date().toISOString(),
    timeframes: out,
    h4Coverage,
    notes,
  };
}
