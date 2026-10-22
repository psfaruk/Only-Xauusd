/**
 * XAUUSD AI Trading Agent — Market-Data Ingestion Service (Phase 3)
 * ----------------------------------------------------------------------------
 * Idempotent, bounded, fail-closed ingestion from the read-only Bridge:
 *
 *   1. Strict allowlist checks (symbol + timeframes) — defense in depth.
 *   2. Bridge health/status probe; demo source is SKIPPED (recorded) unless
 *      explicitly opted in; a disconnected bridge fails the run.
 *   3. Per-timeframe candle fetch with a bounded limit; deterministic
 *      validation; idempotent upserts keyed on (symbol, timeframe, candleTime).
 *      Closed candles are IMMUTABLE: a re-delivery never rewrites final OHLC
 *      (divergent re-deliveries are recorded as CANDLE_CLOSED_REVISION_IGNORED
 *      warnings — never applied silently).
 *   4. Latest-tick snapshot upsert (single row per symbol — no tick history).
 *   5. SymbolSpec upsert containing ONLY bridge-verified fields.
 *   6. Honest SyncRun bookkeeping: incomplete runs are NEVER 'success'
 *      (success | partial | failed | skipped), with safe, bounded diagnostics.
 *
 * Historical backfill: bounded by MARKET_BACKFILL_MAX_BARS / _MAX_DAYS and the
 * per-request limit. The reference bridge API is limit-only (no from/to), so a
 * backfill is a bounded latest-N fetch; requested vs received counts are
 * always recorded honestly.
 */

import type { PrismaClient } from '@prisma/client';
import { config } from '@/lib/config';
import { logEvent } from '@/lib/logger';
import type { BridgeClient } from './bridge-client';
import {
  ErrorCode,
  TIMEFRAME_SECONDS,
  type NormalizedCandle,
  type SyncMode,
  type SyncOutcome,
  type Timeframe,
} from './types';
import { toCanonicalPrice, validateCandleBatch, validateQuote, findMissingCandles, expectedCandleTimes } from './validation';
import { classifyMissingCandle } from './sessions';

export interface SyncDeps {
  bridge: BridgeClient;
  db: PrismaClient;
  /** Injectable clock (epoch ms) — deterministic tests. */
  now?: () => number;
}

export interface SyncOptions {
  mode: SyncMode;
  symbol: string;
  timeframes: Timeframe[];
  /** Backfill range (UTC). rangeStartUtc is REQUIRED for backfill mode. */
  rangeStartUtc?: Date | null;
  rangeEndUtc?: Date | null;
  /** Override the per-request bar limit (bounded). */
  limit?: number | null;
}

interface TfOutcome {
  timeframe: Timeframe;
  status: 'success' | 'failed' | 'skipped';
  requested: number;
  received: number;
  inserted: number;
  updated: number;
  rejected: number;
  duplicates: number;
  errorCode: string | null;
}

/** A divergent re-delivery of an already-CLOSED candle that was IGNORED
 *  (recorded as an auditable warning — closed candles are immutable). */
interface ClosedRevisionIssue {
  barTimeUtcSec: number;
  detail: string;
}

const DAY_SEC = 86_400;

interface SyncAggregates {
  status: SyncOutcome['status'];
  symbol: string;
  timeframes: Timeframe[];
  requested: number;
  received: number;
  inserted: number;
  updated: number;
  rejected: number;
  duplicates: number;
  errorCode: string | null;
  errorMessage: string | null;
  coverage: SyncOutcome['coverage'];
  perTimeframe: TfOutcome[];
}

/** Severity rank for honest aggregation — a worse status always wins. */
function statusRank(s: SyncOutcome['status']): number {
  return s === 'failed' ? 3 : s === 'partial' ? 2 : s === 'skipped' ? 1 : 0;
}

/**
 * Phase 4 hardening: timestamp-based verification that a backfill range is
 * actually covered by persisted CLOSED candles. The bridge API is limit-only,
 * so “the limit was filled” proves nothing about the requested range — this
 * check builds the due-bar grid for [rangeStart, rangeEnd) and counts what is
 * really in the database. Bars missing OUTSIDE approximate closure windows
 * make the entry incomplete; closure-window gaps are reported as info only.
 */
async function computeBackfillCoverage(
  deps: SyncDeps,
  opts: SyncOptions,
  timeframe: Timeframe,
  nowUtcSec: number,
): Promise<NonNullable<SyncOutcome['coverage']>[number]> {
  const fromSec = Math.floor((opts.rangeStartUtc as Date).getTime() / 1000);
  const toSec = Math.floor((opts.rangeEndUtc as Date).getTime() / 1000);
  const tfSec = TIMEFRAME_SECONDS[timeframe];

  // Bars that were DUE (already closed) inside the requested range.
  const grid = expectedCandleTimes(fromSec, toSec, timeframe).filter((t) => t + tfSec <= nowUtcSec);

  const rows = await deps.db.marketCandle
    .findMany({
      where: {
        symbol: opts.symbol,
        timeframe,
        isForming: false,
        candleTimeUtc: { gte: new Date(fromSec * 1000), lt: new Date(toSec * 1000) },
      },
      select: { candleTimeUtc: true },
    })
    .catch(() => []);
  const present = new Set(rows.map((r) => Math.floor(r.candleTimeUtc.getTime() / 1000)));

  let missingBars = 0;
  let closureGaps = 0;
  let presentBars = 0;
  for (const t of grid) {
    if (present.has(t)) {
      presentBars += 1;
      continue;
    }
    const cls = classifyMissingCandle(t);
    if (cls.severity === 'warning') missingBars += 1;
    else closureGaps += 1;
  }

  return {
    timeframe,
    expectedBars: grid.length,
    presentBars,
    missingBars,
    closureGaps,
    complete: missingBars === 0,
  };
}

/** Module-level overlap guard — a second concurrent run is refused, not queued. */
let syncRunning = false;

export function isSyncRunning(): boolean {
  return syncRunning;
}

/** Bounded per-request limit computation. */
export function computeRequestLimit(opts: SyncOptions, timeframe: Timeframe): { limit: number; error?: string } {
  const hardMaxRequest = config.market.maxCandlesPerRequest;
  if (opts.mode !== 'backfill') {
    return { limit: Math.min(opts.limit ?? hardMaxRequest, hardMaxRequest) };
  }
  if (!opts.rangeStartUtc || !opts.rangeEndUtc) {
    return { limit: 0, error: ErrorCode.BAD_REQUEST };
  }
  const rangeSec = Math.floor((opts.rangeEndUtc.getTime() - opts.rangeStartUtc.getTime()) / 1000);
  if (rangeSec <= 0) return { limit: 0, error: ErrorCode.BAD_REQUEST };
  if (rangeSec > config.market.backfillMaxDays * DAY_SEC) {
    return { limit: 0, error: ErrorCode.RANGE_TOO_LARGE };
  }
  const bars = Math.ceil(rangeSec / TIMEFRAME_SECONDS[timeframe]);
  if (bars > config.market.backfillMaxBars) {
    return { limit: 0, error: ErrorCode.RANGE_TOO_LARGE };
  }
  return { limit: Math.min(Math.max(bars, 50), config.market.backfillMaxBars, 20_000) };
}

export async function runSync(deps: SyncDeps, opts: SyncOptions): Promise<SyncOutcome> {
  const nowMs = () => (deps.now ?? Date.now)();
  const startedAtMs = nowMs();
  const nowUtcSec = Math.floor(nowMs() / 1000);
  const receivedAt = new Date(nowMs());

  const finishNothing = (status: SyncOutcome['status'], errorCode: string, message: string): SyncOutcome => ({
    runId: 'none',
    status,
    symbol: opts.symbol,
    timeframes: opts.timeframes,
    requested: 0,
    received: 0,
    inserted: 0,
    updated: 0,
    rejected: 0,
    duplicates: 0,
    durationMs: nowMs() - startedAtMs,
    errorCode,
    errorMessage: message,
    coverage: null,
    perTimeframe: [],
  });

  // ---- 0. Overlap guard --------------------------------------------------
  if (syncRunning) {
    return finishNothing('failed', ErrorCode.SYNC_IN_PROGRESS, 'A sync run is already in progress.');
  }
  syncRunning = true;

  // ---- 0b. Orphaned-run reaper (master-audit fix C-D4) -------------------
  // A hard crash mid-sync used to leave `status:'running'` rows forever
  // (verified: 0 today, but nothing prevented it). A running row older than
  // 15 minutes cannot belong to this process's in-flight sync (the overlap
  // guard above refuses concurrency), so it is demoted to failed with an
  // explicit code — dashboards/history never show a phantom running sync.
  await deps.db.syncRun
    .updateMany({
      where: {
        status: 'running',
        startedAtUtc: { lt: new Date(nowMs() - 15 * 60_000) },
      },
      data: {
        status: 'failed',
        endedAtUtc: new Date(nowMs()),
        errorCode: 'ORPHANED_SYNC_RUN',
        errorMessage: 'Run exceeded 15 minutes without completing — marked failed by the orphan reaper (process crash or hang).',
      },
    })
    .catch(() => undefined);

  try {
    // ---- 1. Allowlists (defense in depth; the API layer validates first) --
    if (!config.market.symbols.includes(opts.symbol)) {
      return await recordTerminalRun(deps, opts, startedAtMs, nowUtcSec, 'failed', ErrorCode.SYMBOL_NOT_ALLOWED,
        `Symbol ${opts.symbol} is not in the MARKET_SYMBOLS allowlist.`, []);
    }
    const allowedTfs = opts.timeframes.filter((tf) =>
      (config.market.timeframes as readonly string[]).includes(tf) && TIMEFRAME_SECONDS[tf] !== undefined,
    );
    if (allowedTfs.length === 0) {
      return await recordTerminalRun(deps, opts, startedAtMs, nowUtcSec, 'failed', ErrorCode.TIMEFRAME_NOT_ALLOWED,
        `None of the requested timeframes are allowed (${opts.timeframes.join(', ')}).`, []);
    }

    // ---- 2. SyncRun row (running) -----------------------------------------
    const run = await deps.db.syncRun.create({
      data: {
        mode: opts.mode,
        source: 'none',
        symbol: opts.symbol,
        timeframes: JSON.stringify(allowedTfs),
        rangeStartUtc: opts.rangeStartUtc ?? null,
        rangeEndUtc: opts.rangeEndUtc ?? null,
        startedAtUtc: new Date(startedAtMs),
        status: 'running',
      },
    });

    // Feed source of this run — assigned at the bridge status probe (step 4);
    // declared early so every finalize() path (including early failures) can
    // reference it safely.
    let feedSource = 'unknown';

    const finalize = async (a: SyncAggregates): Promise<SyncOutcome> => {
      const durationMs = nowMs() - startedAtMs;
      await deps.db.syncRun.update({
        where: { id: run.id },
        data: {
          endedAtUtc: new Date(nowMs()),
          status: a.status,
          requested: a.requested,
          received: a.received,
          inserted: a.inserted,
          updated: a.updated,
          rejected: a.rejected,
          duplicates: a.duplicates,
          errorCode: a.errorCode,
          errorMessage: a.errorMessage,
          durationMs,
        },
      }).catch(() => undefined);
      // EVERY outcome (including early failures) reaches the audit trail.
      await logEvent({
        level: a.status === 'success' ? 'info' : a.status === 'partial' || a.status === 'skipped' ? 'warn' : 'error',
        category: 'market',
        code: `MARKET_SYNC_${a.status.toUpperCase()}`,
        message: `Sync ${a.symbol} [${a.timeframes.join('/')}] → ${a.status}: +${a.inserted} new, ~${a.updated} updated, ${a.rejected} rejected (source: ${feedSource ?? 'none'})${a.errorCode ? ` [${a.errorCode}]` : ''}`,
        meta: { runId: run.id, status: a.status, feedSource: feedSource ?? 'none', inserted: a.inserted, rejected: a.rejected, errorCode: a.errorCode },
      }).catch(() => undefined);
      return { ...a, runId: run.id, durationMs };
    };

    // ---- 3. Bridge health --------------------------------------------------
    const health = await deps.bridge.getHealth();
    if (!health.ok) {
      return await finalize({
        status: 'failed',
        symbol: opts.symbol,
        timeframes: allowedTfs,
        requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
        errorCode: health.error.code,
        errorMessage: `Bridge health check failed: ${health.error.message}`,
        coverage: null,
        perTimeframe: allowedTfs.map<TfOutcome>((tf) => ({
          timeframe: tf, status: 'skipped', requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
          errorCode: health.error.code,
        })),
      });
    }

    // ---- 4. Feed source policy (fail closed) -------------------------------
    const status = await deps.bridge.getStatus();
    feedSource = status.ok ? String(status.data.source) : 'unknown';
    await deps.db.syncRun.update({ where: { id: run.id }, data: { source: feedSource } }).catch(() => undefined);

    if (feedSource === 'demo' && !config.market.ingestDemo) {
      return await finalize({
        status: 'skipped',
        symbol: opts.symbol,
        timeframes: allowedTfs,
        requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
        errorCode: ErrorCode.SOURCE_DEMO,
        errorMessage: 'Bridge is serving its clearly-labelled demo feed; demo ingestion is disabled (MARKET_INGEST_DEMO=false).',
        coverage: null,
        perTimeframe: allowedTfs.map<TfOutcome>((tf) => ({
          timeframe: tf, status: 'skipped', requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
          errorCode: ErrorCode.SOURCE_DEMO,
        })),
      });
    }
    if (status.ok && !status.data.connected && feedSource !== 'demo') {
      return await finalize({
        status: 'failed',
        symbol: opts.symbol,
        timeframes: allowedTfs,
        requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
        errorCode: ErrorCode.SOURCE_DISCONNECTED,
        errorMessage: 'Bridge reports the MT5 terminal is disconnected — refusing to ingest (fail closed).',
        coverage: null,
        perTimeframe: allowedTfs.map<TfOutcome>((tf) => ({
          timeframe: tf, status: 'skipped', requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
          errorCode: ErrorCode.SOURCE_DISCONNECTED,
        })),
      });
    }

    // ---- 5. Symbol existence check ----------------------------------------
    const symbols = await deps.bridge.getSymbols();
    if (!symbols.ok) {
      return await finalize({
        status: 'failed',
        symbol: opts.symbol,
        timeframes: allowedTfs,
        requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
        errorCode: symbols.error.code,
        errorMessage: `Could not verify symbol list: ${symbols.error.message}`,
        coverage: null,
        perTimeframe: allowedTfs.map<TfOutcome>((tf) => ({
          timeframe: tf, status: 'skipped', requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
          errorCode: symbols.error.code,
        })),
      });
    }
    if (!symbols.data.list.includes(opts.symbol)) {
      return await finalize({
        status: 'failed',
        symbol: opts.symbol,
        timeframes: allowedTfs,
        requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
        errorCode: ErrorCode.SYMBOL_NOT_FOUND,
        errorMessage: `Bridge symbol list does not contain ${opts.symbol} (it serves: ${symbols.data.list.slice(0, 8).join(', ')}${symbols.data.list.length > 8 ? '…' : ''}).`,
        coverage: null,
        perTimeframe: allowedTfs.map<TfOutcome>((tf) => ({
          timeframe: tf, status: 'skipped', requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
          errorCode: ErrorCode.SYMBOL_NOT_FOUND,
        })),
      });
    }

    // ---- 6. Per-timeframe candle ingestion ---------------------------------
    const tfOutcomes: TfOutcome[] = [];
    const allIssues: Array<{ code: string; severity: 'info' | 'warning' | 'error'; detail: string; tf: Timeframe; barTimeUtcSec?: number }> = [];
    let verifiedDigits: number | null = null;

    for (const tf of allowedTfs) {
      const { limit, error } = computeRequestLimit(opts, tf);
      if (error) {
        tfOutcomes.push({
          timeframe: tf, status: 'failed', requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0, errorCode: error,
        });
        allIssues.push({ code: error, severity: 'error', detail: `Backfill bounds rejected this timeframe (${tf}).`, tf });
        continue;
      }

      const res = await deps.bridge.getCandles({ symbol: opts.symbol, timeframe: tf, limit });
      if (!res.ok) {
        tfOutcomes.push({
          timeframe: tf, status: 'failed', requested: limit, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
          errorCode: res.error.code,
        });
        allIssues.push({ code: res.error.code, severity: 'error', detail: `Candle fetch failed: ${res.error.message}`, tf });
        continue; // other timeframes still attempted — partial-response tolerance
      }

      const digits = typeof res.data.digits === 'number' && Number.isInteger(res.data.digits) && res.data.digits >= 0 && res.data.digits <= 8
        ? res.data.digits
        : null;
      if (digits !== null) {
        if (verifiedDigits !== null && verifiedDigits !== digits) {
          allIssues.push({ code: 'SPEC_DIGITS_MISMATCH', severity: 'warning', detail: `Bridge reported different digits for ${opts.symbol} across timeframes (${verifiedDigits} vs ${digits}).`, tf });
        } else {
          verifiedDigits = verifiedDigits ?? digits;
        }
      }

      const batch = validateCandleBatch(res.data.bars, { timeframe: tf, nowUtcSec, digits });

      // Persist idempotently inside one transaction per timeframe.
      // Deep-remediation Phase 2 (master prompt §Phase 2 task 4: "Never
      // mutate an already closed candle silently"): an already-CLOSED row is
      // FINAL — a re-delivery never rewrites its OHLC/isForming/validation,
      // only the receipt bookkeeping (receivedAtUtc) is refreshed. Divergent
      // re-deliveries are recorded as auditable WARNING issues, never applied.
      // (forming → closed transitions still take the normal update path: the
      // final values of a bar that just closed DO arrive.)
      let inserted = 0;
      let updated = 0;
      // Typed via the interface because the assignment happens inside the
      // transaction callback (TS control-flow cannot see it — cast at read).
      let closedRevisionIssues: ClosedRevisionIssue[] | null = null;
      try {
        await deps.db.$transaction(
          async (tx) => {
            const times = batch.candles.map((c) => new Date(c.candleTimeUtcSec * 1000));
            const existing = await tx.marketCandle.findMany({
              where: { symbol: opts.symbol, timeframe: tf, candleTimeUtc: { in: times } },
              select: { candleTimeUtc: true, isForming: true, open: true, high: true, low: true, close: true },
            });
            const existingByTime = new Map(
              existing.map((r) => [r.candleTimeUtc.getTime(), r] as const),
            );
            const existingTimes = new Set(existingByTime.keys());
            const divergences: ClosedRevisionIssue[] = [];

            for (const c of batch.candles) {
              const time = new Date(c.candleTimeUtcSec * 1000);
              const stored = existingByTime.get(time.getTime());
              if (stored && !stored.isForming) {
                // CLOSED row re-delivered: refresh receipt time ONLY.
                await tx.marketCandle.update({
                  where: {
                    symbol_timeframe_candleTimeUtc: {
                      symbol: opts.symbol,
                      timeframe: tf,
                      candleTimeUtc: time,
                    },
                  },
                  data: { receivedAtUtc: receivedAt },
                });
                const ohlcDiffers =
                  c.open !== stored.open ||
                  c.high !== stored.high ||
                  c.low !== stored.low ||
                  c.close !== stored.close;
                if (c.isForming || ohlcDiffers) {
                  divergences.push({
                    barTimeUtcSec: c.candleTimeUtcSec,
                    detail: c.isForming
                      ? `Bridge re-delivered closed ${tf} bar as FORMING — ignored (a closed candle never re-opens). Stored OHLC kept.`
                      : `Bridge re-delivered closed ${tf} bar with different OHLC (stored ${stored.open}/${stored.high}/${stored.low}/${stored.close} vs incoming ${c.open}/${c.high}/${c.low}/${c.close}) — revision IGNORED (closed candles are immutable); stored values kept.`,
                  });
                }
              } else {
                await tx.marketCandle.upsert({
                  where: { symbol_timeframe_candleTimeUtc: { symbol: opts.symbol, timeframe: tf, candleTimeUtc: time } },
                  create: {
                    symbol: opts.symbol,
                    timeframe: tf,
                    candleTimeUtc: time,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    tickVolume: c.tickVolume,
                    spread: null,
                    source: `bridge-${feedSource}`,
                    isForming: c.isForming,
                    validationStatus: c.validationStatus,
                    receivedAtUtc: receivedAt,
                  },
                  update: {
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    tickVolume: c.tickVolume,
                    isForming: c.isForming,
                    validationStatus: c.validationStatus,
                    receivedAtUtc: receivedAt,
                  },
                });
              }
              if (existingTimes.has(time.getTime())) updated += 1;
              else inserted += 1;
            }

            // Safety: forming rows whose bar period has definitively ended but
            // whose final values never arrived are flagged WARNING — they stay
            // excluded from confirmed history (never presented as final).
            await tx.marketCandle.updateMany({
              where: {
                symbol: opts.symbol,
                timeframe: tf,
                isForming: true,
                validationStatus: 'VALID',
                candleTimeUtc: { lt: new Date((nowUtcSec - TIMEFRAME_SECONDS[tf]) * 1000) },
              },
              data: { validationStatus: 'WARNING' },
            });

            closedRevisionIssues = divergences;
          },
          { timeout: 15_000, maxWait: 5_000 },
        );
      } catch (txErr) {
        tfOutcomes.push({
          timeframe: tf, status: 'failed', requested: limit, received: res.data.bars.length, inserted: 0, updated: 0,
          rejected: batch.rejected, duplicates: batch.duplicates, errorCode: ErrorCode.DB_TX_FAILED,
        });
        allIssues.push({
          code: ErrorCode.DB_TX_FAILED,
          severity: 'error',
          detail: `Transaction failed for ${tf}: ${txErr instanceof Error ? txErr.message.slice(0, 200) : 'unknown'}`,
          tf,
        });
        continue;
      }
      for (const rev of (closedRevisionIssues as ClosedRevisionIssue[] | null) ?? []) {
        allIssues.push({
          code: ErrorCode.CANDLE_CLOSED_REVISION_IGNORED,
          severity: 'warning',
          detail: rev.detail,
          tf,
          barTimeUtcSec: rev.barTimeUtcSec,
        });
      }

      tfOutcomes.push({
        timeframe: tf,
        status: 'success',
        requested: limit,
        received: res.data.bars.length,
        inserted,
        updated,
        rejected: batch.rejected,
        duplicates: batch.duplicates,
        errorCode: null,
      });
      for (const issue of batch.issues) {
        allIssues.push({ code: issue.code, severity: issue.severity, detail: issue.detail, tf, barTimeUtcSec: issue.barTimeUtcSec });
      }

      // Session-aware gap scan over the received window (persisted evidence,
      // capped). Only CLOSED bars form the grid; forming slots are not due yet.
      const closedTimes = batch.candles.filter((c) => !c.isForming).map((c) => c.candleTimeUtcSec);
      if (closedTimes.length >= 2) {
        const gaps = findMissingCandles(closedTimes, {
          timeframe: tf,
          fromUtcSec: closedTimes[0],
          toUtcSec: closedTimes[closedTimes.length - 1] + TIMEFRAME_SECONDS[tf],
          nowUtcSec,
          maxGaps: 200,
        });
        for (const g of gaps.slice(0, 20)) {
          allIssues.push({ code: g.reasonCode, severity: g.severity, detail: g.note, tf, barTimeUtcSec: g.expectedTimeUtcSec });
        }
      }

      if (batch.candles.length === 0) {
        allIssues.push({
          code: ErrorCode.BRIDGE_PARTIAL_RESPONSE,
          severity: 'warning',
          detail: `Bridge returned zero usable bars for ${tf} (raw bars: ${res.data.bars.length}).`,
          tf,
        });
      }
    }

    // ---- 7. Latest tick (supplementary — never fabricates) -----------------
    const quote = await deps.bridge.getQuote(opts.symbol);
    if (quote.ok) {
      const tick = validateQuote(quote.data, { nowUtcSec, digits: verifiedDigits });
      if (tick.normalized) {
        await deps.db.marketLatestTick.upsert({
          where: { symbol: opts.symbol },
          create: {
            symbol: opts.symbol,
            bid: tick.normalized.bid,
            ask: tick.normalized.ask,
            spread: tick.normalized.spread,
            spreadPoints: tick.normalized.spreadPoints,
            tickTimeUtc: new Date(tick.normalized.tickTimeUtcSec * 1000),
            receivedAtUtc: receivedAt,
            source: `bridge-${feedSource}`,
            validationStatus: tick.status,
          },
          update: {
            bid: tick.normalized.bid,
            ask: tick.normalized.ask,
            spread: tick.normalized.spread,
            spreadPoints: tick.normalized.spreadPoints,
            tickTimeUtc: new Date(tick.normalized.tickTimeUtcSec * 1000),
            receivedAtUtc: receivedAt,
            source: `bridge-${feedSource}`,
            validationStatus: tick.status,
          },
        }).catch((e: unknown) => {
          allIssues.push({
            code: ErrorCode.DB_ERROR, severity: 'error',
            detail: `Latest-tick upsert failed: ${e instanceof Error ? e.message.slice(0, 160) : 'unknown'}`, tf: 'M5',
          });
        });
        if (tick.status === 'WARNING') {
          allIssues.push({ code: tick.errorCodes.join('+'), severity: 'warning', detail: `Tick kept with warning: ${tick.errorCodes.join(', ')}`, tf: 'M5' });
        }
      } else {
        allIssues.push({ code: tick.errorCodes.join('+'), severity: 'error', detail: `Tick rejected: ${tick.errorCodes.join(', ')}`, tf: 'M5' });
      }
    } else if (quote.error.code !== 'NOT_FOUND') {
      // 404 "no quote yet" is normal right after bridge startup — info only.
      allIssues.push({ code: quote.error.code, severity: 'warning', detail: `Quote fetch failed: ${quote.error.message}`, tf: 'M5' });
    }

    // ---- 8. SymbolSpec — verified fields ONLY ------------------------------
    if (verifiedDigits !== null) {
      const pointText = toCanonicalPrice(Math.pow(10, -verifiedDigits), verifiedDigits).text;
      await deps.db.symbolSpec
        .upsert({
          where: { symbol: opts.symbol },
          create: {
            symbol: opts.symbol,
            digits: verifiedDigits,
            point: pointText,
            source: `bridge-${feedSource}`,
            verifiedFields: JSON.stringify(['digits']),
            meta: JSON.stringify({
              note: 'digits verified from bridge /api/candles response. point is DERIVED as 10^-digits (mathematical definition) — NOT broker-reported; tick/volume specs unavailable from the current bridge contract.',
            }),
            lastVerifiedAt: receivedAt,
          },
          update: {
            digits: verifiedDigits,
            point: pointText,
            source: `bridge-${feedSource}`,
            verifiedFields: JSON.stringify(['digits']),
            lastVerifiedAt: receivedAt,
          },
        })
        .catch(async (e: unknown) => {
          // Master-audit fix C-D3: this failure used to be swallowed with no
          // trace. The downstream gates honestly report SPEC_MISSING, but the
          // operator needs the write failure itself in the audit trail.
          await logEvent({
            level: 'warn',
            category: 'market',
            code: 'SYMBOL_SPEC_UPSERT_FAILED',
            message: `SymbolSpec upsert failed for ${opts.symbol}: ${e instanceof Error ? e.message : String(e)}`,
            meta: { symbol: opts.symbol },
          }).catch(() => undefined);
        });
    } else {
      allIssues.push({
        code: ErrorCode.SPEC_MISSING,
        severity: 'warning',
        detail: 'No verified symbol digits obtained this run — spec not written.',
        tf: 'M5',
      });
    }

    // ---- 9. Bounded DataQualityIssue records -------------------------------
    const cap = config.market.maxIssuesPerRun;
    const issuesToWrite = allIssues.slice(0, cap);
    for (const issue of issuesToWrite) {
      await deps.db.dataQualityIssue.create({
        data: {
          checkType: issue.code.startsWith('GAP_') ? 'GAP_SCAN' : 'INGESTION',
          symbol: opts.symbol,
          timeframe: issue.tf,
          targetTimeUtc: issue.barTimeUtcSec ? new Date(issue.barTimeUtcSec * 1000) : null,
          severity: issue.severity,
          errorCode: issue.code,
          details: JSON.stringify({ detail: issue.detail }),
          checkedAtUtc: receivedAt,
        },
      }).catch(() => undefined);
    }

    // ---- 9.5 Backfill coverage verification (Phase 4 hardening) ----------
    // Timestamp-based proof that the requested range is actually covered.
    // Without this, a limit-only bridge response that merely filled the `limit`
    // could be mistaken for a covered range (user-reported Phase 3 risk #5).
    let coverage: SyncOutcome['coverage'] = null;
    if (opts.mode === 'backfill' && opts.rangeStartUtc && opts.rangeEndUtc) {
      coverage = [];
      for (const tf of allowedTfs) {
        coverage.push(await computeBackfillCoverage(deps, opts, tf, nowUtcSec));
      }
    }

    // ---- 10. Aggregate & finalize (never mark incomplete as success) -------
    const sum = (fn: (o: TfOutcome) => number) => tfOutcomes.reduce((a, o) => a + fn(o), 0);
    const successes = tfOutcomes.filter((o) => o.status === 'success').length;
    let runStatus: SyncOutcome['status'];
    if (successes === 0) runStatus = 'failed';
    else if (successes === tfOutcomes.length) runStatus = 'success';
    else runStatus = 'partial';

    let errorCode: string | null = tfOutcomes.find((o) => o.errorCode)?.errorCode ?? null;
    const messageParts: string[] = [];
    if (errorCode) {
      messageParts.push(`One or more timeframes failed (first error: ${errorCode}).`);
    }

    // A backfill run whose range is not actually covered is NEVER 'success':
    // all timeframes incomplete → failed; some → partial. Worse status wins.
    if (coverage) {
      const incomplete = coverage.filter((c) => !c.complete);
      if (incomplete.length > 0) {
        const covRank = incomplete.length === coverage.length ? 3 : 2;
        if (covRank > statusRank(runStatus)) {
          runStatus = covRank === 3 ? 'failed' : 'partial';
        }
        if (!errorCode) errorCode = ErrorCode.BACKFILL_INCOMPLETE;
        messageParts.push(
          `Backfill range not fully covered (timestamp-based verification): ${incomplete.length}/${coverage.length} timeframes missing bars outside approximate closure windows.`,
        );
      }
    }

    const outcome = await finalize({
      status: runStatus,
      symbol: opts.symbol,
      timeframes: allowedTfs,
      requested: sum((o) => o.requested),
      received: sum((o) => o.received),
      inserted: sum((o) => o.inserted),
      updated: sum((o) => o.updated),
      rejected: sum((o) => o.rejected),
      duplicates: sum((o) => o.duplicates),
      errorCode,
      errorMessage: messageParts.length > 0 ? messageParts.join(' ') : null,
      coverage,
      perTimeframe: tfOutcomes,
    });

    return outcome;
  } finally {
    syncRunning = false;
  }
}

/** Terminal run that still creates a SyncRun row (honest bookkeeping). */
async function recordTerminalRun(
  deps: SyncDeps,
  opts: SyncOptions,
  startedAtMs: number,
  _nowUtcSec: number,
  status: SyncOutcome['status'],
  errorCode: string,
  errorMessage: string,
  _tfs: Timeframe[],
): Promise<SyncOutcome> {
  const endedMs = (deps.now ?? Date.now)();
  let runId = 'none';
  try {
    const run = await deps.db.syncRun.create({
      data: {
        mode: opts.mode,
        source: 'none',
        symbol: opts.symbol,
        timeframes: JSON.stringify(opts.timeframes),
        rangeStartUtc: opts.rangeStartUtc ?? null,
        rangeEndUtc: opts.rangeEndUtc ?? null,
        startedAtUtc: new Date(startedAtMs),
        endedAtUtc: new Date(endedMs),
        status,
        errorCode,
        errorMessage,
        durationMs: endedMs - startedAtMs,
      },
    });
    runId = run.id;
  } catch {
    // bookkeeping failure must not mask the original error
  }
  await logEvent({
    level: 'error',
    category: 'market',
    code: 'MARKET_SYNC_FAILED',
    message: `Sync ${opts.symbol} rejected before fetch: ${errorCode}`,
    meta: { errorCode },
  }).catch(() => undefined);
  return {
    runId,
    status,
    symbol: opts.symbol,
    timeframes: opts.timeframes,
    requested: 0, received: 0, inserted: 0, updated: 0, rejected: 0, duplicates: 0,
    durationMs: endedMs - startedAtMs,
    errorCode,
    errorMessage,
    coverage: null,
    perTimeframe: [],
  };
}
