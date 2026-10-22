/**
 * XAUUSD AI Trading Agent — Historical Range Import (Phase 3, master prompt)
 * ----------------------------------------------------------------------------
 * Broker-authorized deep-history acquisition through the read-only bridge
 * range endpoint (GET /api/candles/range). Fills the MarketCandle table with
 * CLOSED, broker-validated bars for a bounded UTC window so the six-month
 * backtest (Phase 5) runs on real broker data instead of the ~30-day slice
 * the limit-only API could serve.
 *
 * HONESTY CONTRACT (master prompt §Phase 3):
 *   · Broker data only — every bar arrives from the authenticated Exness
 *     session via the bridge. NOTHING is synthesized: gaps stay gaps and are
 *     REPORTED, never filled.
 *   · The broker's history depth is whatever it actually serves (probed live:
 *     M1 ≈ last ~100 days; M5/M15/H1/H4 cover the full 6-month window). The
 *     returned stats make real coverage explicit — a partial dataset is never
 *     labeled complete.
 *   · CLOSED candles are immutable: an existing row is never rewritten by a
 *     re-import. Re-delivered closed bars are compared; OHLC divergences are
 *     counted and sampled, never applied.
 *   · Forming bars are dropped (history = closed bars only). The scheduled
 *     live sync owns the rolling recent edge.
 *   · Validation reuses the Phase 3 ingestion rules verbatim
 *     (validateCandleBatch): OHLC sanity, positive prices, future-time
 *     rejection, canonical decimal text, duplicate handling.
 *
 * Idempotency: running the import twice inserts nothing new and changes
 * nothing (only the receipt timestamp of re-delivered bars is refreshed,
 * matching the ingestion contract).
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { datasetFingerprint } from '@/lib/backtest/engine';
import { expectedCandleTimes, validateCandleBatch } from '@/lib/market/validation';
import { classifyMissingCandles } from '@/lib/market/sessions';
import type { BridgeBar } from '@/lib/market/types';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import type { BridgeClient } from '@/lib/market/bridge-client';

/** Prisma is the persistence surface (same convention as SyncDeps — tests
 *  inject fakes via `as unknown as PrismaClient`). */
export type HistoricalImportDb = Pick<PrismaClient, 'marketCandle'>;

export interface HistoricalImportOptions {
  symbol: string;
  timeframe: Timeframe;
  fromUtcSec: number;          // aligned to the timeframe grid by the caller
  toUtcSec: number;            // exclusive right edge (align; stay behind the live edge)
  /** Expected bars per HTTP range call (default 8000; bridge paginates
   *  internally at ≤4000 bars per protocol window). */
  barsPerRequest?: number;
  /** Batch size for DB createMany (default 2000). */
  dbBatchSize?: number;
  /** Cap on sampled divergence examples in stats (default 20). */
  maxDivergenceExamples?: number;
  /** Cap on sampled missing-slot examples (default 40). */
  maxMissingExamples?: number;
  /** Optional progress sink (import can take minutes for M1). */
  onProgress?: (msg: string) => void;
}

export interface HistoricalImportIssueSummary {
  code: string;
  count: number;
  exampleBarTimeUtcSec?: number;
}

export interface HistoricalImportStats {
  symbol: string;
  timeframe: Timeframe;
  requestedFromUtcSec: number;
  requestedToUtcSec: number;
  requests: number;
  barsReceived: number;
  barsRejectedInvalid: number;
  barsFormingDropped: number;
  barsDuplicateInStream: number;
  barsInserted: number;
  barsAlreadyPresent: number;
  divergences: number;
  divergenceExamples: Array<{ barTimeUtcSec: number; stored: string; incoming: string }>;
  validationIssues: HistoricalImportIssueSummary[];
  earliestBarUtcSec: number | null;
  latestBarUtcSec: number | null;
  /** Session-aware coverage over the REQUESTED window. */
  expectedSlots: number;
  closureSlots: number;        // inside approximate weekend/daily-break envelopes
  preHistorySlots: number;     // non-closure slots BEFORE the earliest served bar (broker depth limit)
  missingSlots: number;        // non-closure slots after the earliest bar with no data — REAL gaps
  missingExamples: number[];   // sampled missing slot times (UTC sec)
  fingerprint: string | null;  // sha256 over the imported closed set (canonical text)
  /** Broker-verified digits used for canonical prices (null = unverified). */
  digits: number | null;
  digitsSource: string;
}

export type HistoricalImportOutcome =
  | { ok: true; stats: HistoricalImportStats }
  | { ok: false; error: { code: string; message: string; partialStats?: HistoricalImportStats } };

const DEFAULT_BARS_PER_REQUEST = 8000;
const DEFAULT_DB_BATCH = 2000;

/**
 * Import one timeframe window. Never throws — returns a discriminated
 * outcome. On bridge failure mid-run the partial stats are returned with the
 * error so coverage acquired so far is not hidden.
 */
export async function importHistoryRange(
  client: Pick<BridgeClient, 'getCandlesRange'>,
  db: HistoricalImportDb,
  opts: HistoricalImportOptions,
): Promise<HistoricalImportOutcome> {
  const tfSec = TIMEFRAME_SECONDS[opts.timeframe];
  if (!tfSec) {
    return { ok: false, error: { code: 'TIMEFRAME_NOT_SUPPORTED', message: `unsupported timeframe ${opts.timeframe}` } };
  }
  if (!Number.isFinite(opts.fromUtcSec) || !Number.isFinite(opts.toUtcSec) || opts.fromUtcSec >= opts.toUtcSec) {
    return { ok: false, error: { code: 'BAD_RANGE', message: 'fromUtcSec must be < toUtcSec (unix seconds UTC)' } };
  }
  if (opts.fromUtcSec % tfSec !== 0 || opts.toUtcSec % tfSec !== 0) {
    return { ok: false, error: { code: 'BAD_RANGE', message: `window edges must be aligned to the ${opts.timeframe} grid (${tfSec}s)` } };
  }

  const barsPerRequest = Math.max(500, Math.min(opts.barsPerRequest ?? DEFAULT_BARS_PER_REQUEST, 12000));
  const dbBatch = Math.max(100, Math.min(opts.dbBatchSize ?? DEFAULT_DB_BATCH, 5000));
  const maxDivergenceExamples = opts.maxDivergenceExamples ?? 20;
  const maxMissingExamples = opts.maxMissingExamples ?? 40;
  const nowUtcSec = Math.floor(Date.now() / 1000);
  const receivedAt = new Date();

  // Digits: verified from the bridge response per chunk (broker metadata);
  // the first response wins, cross-checked afterwards.
  let digits: number | null = null;
  let digitsConfirmedBy: string | null = null;

  const byTime = new Map<number, {
    open: string; high: string; low: string; close: string;
    tickVolume: number | null; isForming: boolean; validationStatus: string;
  }>();

  // Closed-bar set — declared BEFORE the fetch loop so the failure path's
  // buildStats() can run at any time (TDZ-safe partial stats).
  let closed: Array<[number, { open: string; high: string; low: string; close: string; tickVolume: number | null; isForming: boolean; validationStatus: string }]> = [];

  let requests = 0;
  let barsReceived = 0;
  let barsRejectedInvalid = 0;
  let barsFormingDropped = 0;
  let barsDuplicateInStream = 0;
  // Accumulators referenced by buildStats() — ALL declared BEFORE the fetch
  // loop so the bridge-failure path can build partial stats at ANY time
  // (TDZ-safe). Regression: tests/market/historical-import.test.ts case e —
  // the previous layout left these in the temporal dead zone and the failure
  // path crashed with a ReferenceError instead of returning partial stats.
  let barsInserted = 0;
  let barsAlreadyPresent = 0;
  const divergences: Array<{ barTimeUtcSec: number; stored: string; incoming: string }> = [];
  const issueCounter = new Map<string, { count: number; example?: number }>();

  const recordIssue = (code: string, exampleBarTime?: number) => {
    const cur = issueCounter.get(code) ?? { count: 0 };
    cur.count += 1;
    if (cur.example === undefined && exampleBarTime !== undefined) cur.example = exampleBarTime;
    issueCounter.set(code, cur);
  };

  // ── chunked range fetch ──────────────────────────────────────────────────
  const chunkSpanSec = barsPerRequest * tfSec;
  let cursor = opts.fromUtcSec;
  while (cursor < opts.toUtcSec) {
    const chunkEnd = Math.min(cursor + chunkSpanSec, opts.toUtcSec);
    const res = await client.getCandlesRange({
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      fromUtcSec: cursor,
      toUtcSec: chunkEnd,
    });
    if (!res.ok) {
      const partialStats = buildStats();
      return {
        ok: false,
        error: {
          code: res.error.code,
          message: `range fetch failed at ${new Date(cursor * 1000).toISOString()}: ${res.error.message}`,
          partialStats,
        },
      };
    }
    requests += 1;
    barsReceived += res.data.bars.length;

    // Digits from broker metadata (first chunk establishes; later chunks must agree).
    if (typeof res.data.digits === 'number' && digits === null) {
      digits = res.data.digits;
      digitsConfirmedBy = `bridge range response (chunk ${requests})`;
    } else if (typeof res.data.digits === 'number' && res.data.digits !== digits) {
      recordIssue('HISTORICAL_DIGITS_MISMATCH', res.data.bars[0]?.t);
    }

    const batch = validateCandleBatch(res.data.bars as BridgeBar[], {
      timeframe: opts.timeframe,
      nowUtcSec,
      digits,
    });
    barsRejectedInvalid += batch.rejected;
    barsDuplicateInStream += batch.duplicates;
    for (const issue of batch.issues) {
      recordIssue(issue.code, issue.barTimeUtcSec);
    }
    for (const c of batch.candles) {
      const existing = byTime.get(c.candleTimeUtcSec);
      if (existing) {
        // Cross-chunk boundary duplicate — deterministic: closed beats forming.
        if (existing.isForming && !c.isForming) byTime.set(c.candleTimeUtcSec, c);
        continue;
      }
      byTime.set(c.candleTimeUtcSec, c);
    }

    opts.onProgress?.(
      `${opts.timeframe} chunk ${requests}: [${new Date(cursor * 1000).toISOString()} → ${new Date(chunkEnd * 1000).toISOString()}) — ${res.data.bars.length} bars, total ${byTime.size}`,
    );

    cursor = chunkEnd;
  }

  // ── drop forming bars (history = closed bars only) ───────────────────────
  closed = [...byTime.entries()]
    .filter(([, c]) => !c.isForming)
    .sort((a, b) => a[0] - b[0]);
  barsFormingDropped = byTime.size - closed.length;

  // ── compare with what is already persisted (immutable closed rows).
  //    Chunked IN-queries — SQLite caps host parameters per statement (~999). ─
  const times = closed.map(([t]) => new Date(t * 1000));
  const existingByTime = new Map<number, { candleTimeUtc: Date; open?: string; high?: string; low?: string; close?: string }>();
  {
    const IN_CHUNK = 900;
    for (let i = 0; i < times.length; i += IN_CHUNK) {
      const rows = await db.marketCandle.findMany({
        where: { symbol: opts.symbol, timeframe: opts.timeframe, candleTimeUtc: { in: times.slice(i, i + IN_CHUNK) } },
        select: { candleTimeUtc: true, open: true, high: true, low: true, close: true },
      });
      for (const r of rows) existingByTime.set(r.candleTimeUtc.getTime(), r);
    }
  }
  barsAlreadyPresent = existingByTime.size;

  const toInsert: Array<Prisma.MarketCandleCreateManyInput> = [];
  for (const [t, c] of closed) {
    const stored = existingByTime.get(t * 1000);
    if (stored) {
      const storedOhlc = `${stored.open}/${stored.high}/${stored.low}/${stored.close}`;
      const incomingOhlc = `${c.open}/${c.high}/${c.low}/${c.close}`;
      if (storedOhlc !== incomingOhlc && divergences.length < maxDivergenceExamples + 1000) {
        divergences.push({ barTimeUtcSec: t, stored: storedOhlc, incoming: incomingOhlc });
      }
      continue;
    }
    toInsert.push({
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      candleTimeUtc: new Date(t * 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      tickVolume: c.tickVolume,
      spread: null,
      source: 'bridge-mt5',
      isForming: false,
      validationStatus: c.validationStatus,
      receivedAtUtc: receivedAt,
    });
  }

  // ── bulk insert (batched; unique-violation fallback per row) ─────────────
  for (let i = 0; i < toInsert.length; i += dbBatch) {
    const slice = toInsert.slice(i, i + dbBatch);
    try {
      const r = await db.marketCandle.createMany({ data: slice });
      barsInserted += r.count;
    } catch {
      // Concurrent writer (scheduled sync) may have won a race on the unique
      // key — fall back to per-row tolerant writes.
      for (const row of slice) {
        try {
          const r = await db.marketCandle.createMany({ data: [row] });
          barsInserted += r.count;
        } catch { /* already present — idempotent no-op */ }
      }
    }
  }

  // ── refresh receipt bookkeeping on re-delivered closed rows (matches the
  //    ingestion contract: closed rows are final, only receivedAtUtc moves).
  //    Chunked — SQLite caps host parameters per statement (~999). ─────────
  const existingTimes = [...existingByTime.keys()].map((ms) => new Date(ms));
  const IN_CHUNK = 900;
  for (let i = 0; i < existingTimes.length; i += IN_CHUNK) {
    try {
      await db.marketCandle.updateMany({
        where: { symbol: opts.symbol, timeframe: opts.timeframe, candleTimeUtc: { in: existingTimes.slice(i, i + IN_CHUNK) } },
        data: { receivedAtUtc: receivedAt },
      });
    } catch { /* cosmetic bookkeeping only — never fails the import */ }
  }

  function buildStats(): HistoricalImportStats {
    const closedTimes = new Set(closed.map(([t]) => t));
    const earliest = closed.length ? closed[0][0] : null;
    const latest = closed.length ? closed[closed.length - 1][0] : null;

    // Session-aware coverage grid over the REQUESTED window.
    const expected = expectedCandleTimes(opts.fromUtcSec, opts.toUtcSec, opts.timeframe);
    let closureSlots = 0;
    let preHistorySlots = 0;
    let missingSlots = 0;
    const missingExamples: number[] = [];
    if (expected.length) {
      const classified = classifyMissingCandles(expected.filter((t) => !closedTimes.has(t)));
      for (const m of classified) {
        if (m.reasonCode === 'GAP_MARKET_LIKELY_CLOSED') closureSlots += 1;
        else if (earliest !== null && m.expectedTimeUtcSec < earliest) preHistorySlots += 1;
        else {
          missingSlots += 1;
          if (missingExamples.length < maxMissingExamples) missingExamples.push(m.expectedTimeUtcSec);
        }
      }
    }

    return {
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      requestedFromUtcSec: opts.fromUtcSec,
      requestedToUtcSec: opts.toUtcSec,
      requests,
      barsReceived,
      barsRejectedInvalid,
      barsFormingDropped,
      barsDuplicateInStream,
      barsInserted,
      barsAlreadyPresent,
      divergences: divergences.length,
      divergenceExamples: divergences.slice(0, maxDivergenceExamples),
      validationIssues: [...issueCounter.entries()].map(([code, v]) => ({ code, count: v.count, exampleBarTimeUtcSec: v.example })),
      earliestBarUtcSec: earliest,
      latestBarUtcSec: latest,
      expectedSlots: expected.length,
      closureSlots,
      preHistorySlots,
      missingSlots,
      missingExamples,
      fingerprint: null,
      digits,
      digitsSource: digitsConfirmedBy ?? 'unverified',
    };
  }

  const stats = buildStats();

  // ── dataset fingerprint over the imported CLOSED set (canonical text —
  //    identical to what the backtest loader computes from the DB) ─────────
  if (closed.length) {
    const analysisShaped = closed.map(([t, c]) => ({
      timeUtcSec: t,
      openText: c.open,
      highText: c.high,
      lowText: c.low,
      closeText: c.close,
    }));
    stats.fingerprint = datasetFingerprint(opts.symbol, opts.timeframe, analysisShaped);
  }

  opts.onProgress?.(
    `${opts.timeframe} done: ${stats.barsInserted} inserted, ${stats.barsAlreadyPresent} already present, ` +
    `${stats.missingSlots} missing slots (non-closure), ${stats.preHistorySlots} pre-history slots, fingerprint ${stats.fingerprint?.slice(0, 12) ?? 'n/a'}…`,
  );

  return { ok: true, stats };
}
