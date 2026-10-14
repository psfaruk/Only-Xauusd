/**
 * MANUAL / BACKFILL SYNC CLI (Phase 3) — read-only ingestion trigger.
 * ----------------------------------------------------------------------------
 *   bun run market:sync                                   → incremental, all tfs
 *   bun run market:sync -- --tf M5,H1 --mode manual
 *   bun run market:sync -- --mode backfill --from 2026-10-01T00:00:00Z --to 2026-10-14T00:00:00Z
 *
 * Uses the same fail-closed ingestion service as the API and scheduler.
 */

import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { bridgeClient } from '../src/lib/market/bridge-client';
import { runSync } from '../src/lib/market/ingestion';
import type { Timeframe } from '../src/lib/market/types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const symbol = arg('symbol') ?? config.market.symbols[0] ?? 'XAUUSDm';
  const tfsArg = arg('tf');
  const mode = (arg('mode') ?? 'manual') as 'manual' | 'backfill';
  const from = arg('from');
  const to = arg('to');

  const timeframes: Timeframe[] = tfsArg
    ? (tfsArg.split(',').map((s) => s.trim()).filter((tf) =>
        (config.market.timeframes as readonly string[]).includes(tf),
      ) as Timeframe[])
    : (config.market.timeframes as Timeframe[]);

  if (mode === 'backfill' && (!from || !to)) {
    console.error('backfill mode requires --from and --to (UTC ISO-8601, e.g. 2026-10-01T00:00:00Z)');
    process.exit(2);
  }

  console.log(`[market:sync] symbol=${symbol} mode=${mode} timeframes=[${timeframes.join('/')}]`);
  if (mode === 'backfill') console.log(`[market:sync] range ${from} → ${to} (bounded by MARKET_BACKFILL_MAX_DAYS/BARS)`);

  const outcome = await runSync(
    { bridge: bridgeClient, db },
    {
      mode,
      symbol,
      timeframes,
      rangeStartUtc: from ? new Date(from) : null,
      rangeEndUtc: to ? new Date(to) : null,
    },
  );

  console.log('[market:sync] ────────────────────────────────────────────');
  console.log(`[market:sync] status     : ${outcome.status.toUpperCase()}`);
  console.log(`[market:sync] run id     : ${outcome.runId}`);
  console.log(`[market:sync] requested  : ${outcome.requested}`);
  console.log(`[market:sync] received   : ${outcome.received}`);
  console.log(`[market:sync] inserted   : ${outcome.inserted} · updated ${outcome.updated}`);
  console.log(`[market:sync] rejected   : ${outcome.rejected} · duplicates ${outcome.duplicates}`);
  console.log(`[market:sync] duration   : ${outcome.durationMs}ms`);
  if (outcome.errorCode) console.log(`[market:sync] error      : ${outcome.errorCode} — ${outcome.errorMessage ?? ''}`);
  for (const tf of outcome.perTimeframe) {
    console.log(
      `[market:sync]   ${tf.timeframe.padEnd(4)} ${tf.status.padEnd(8)} +${tf.inserted} ~${tf.updated} ✗${tf.rejected}${tf.errorCode ? ` [${tf.errorCode}]` : ''}`,
    );
  }
  process.exit(outcome.status === 'success' ? 0 : 1);
}

void main();
