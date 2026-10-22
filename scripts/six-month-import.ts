/**
 * SIX-MONTH HISTORICAL IMPORT (master prompt Phase 3)
 * ----------------------------------------------------------------------------
 * Acquires up to six months of XAUUSDm history from the BROKER-AUTHORIZED
 * source (the read-only Exness MT5 bridge — same authenticated session the
 * live app uses) via the new range endpoint, validates every bar with the
 * Phase 3 ingestion rules, persists closed bars, and writes the coverage
 * manifest + report.
 *
 * HONESTY RULES (user directive #3):
 *   · Data that the broker does not serve (e.g. M1 older than ~100 days) is
 *     REPORTED AS UNAVAILABLE — nothing is ever synthesized or resampled
 *     into the gap.
 *   · The manifest records the ACTUAL served range per timeframe, gap
 *     classification (weekend/daily-break envelopes are approximate), and a
 *     dataset fingerprint for reproducibility.
 *
 * Usage: bun --env-file=.env scripts/six-month-import.ts
 */
import { writeFileSync } from 'node:fs';
import { db } from '../src/lib/db';
import { createBridgeClient } from '../src/lib/market/bridge-client';
import { importHistoryRange, type HistoricalImportStats } from '../src/lib/market/historical-import';
import type { Timeframe } from '../src/lib/market/types';
import { TIMEFRAME_SECONDS } from '../src/lib/market/types';

/** Broker symbol name — the MARKET_SYMBOLS allowlist (first entry) is the
 *  authoritative broker-exact name (XAUUSDm); TRADING_SYMBOL is a display
 *  label and may lack the broker suffix. */
const SYMBOL = (process.env.MARKET_SYMBOLS ?? 'XAUUSDm').split(',')[0]?.trim() || 'XAUUSDm';
const TFS: Timeframe[] = ['H4', 'H1', 'M15', 'M5', 'M1'];
/** Six months ≈ 182.5 days (the per-TF aligned boundary is computed at runtime). */
const SIX_MONTHS_SEC = Math.round(182.5 * 86400);

function iso(sec: number | null): string {
  return sec === null ? '—' : new Date(sec * 1000).toISOString();
}

async function main() {
  const startedAt = new Date();
  console.log(`[six-month-import] start ${startedAt.toISOString()} symbol=${SYMBOL}`);

  // ── fail closed: bridge must be connected + authenticated ───────────────
  const client = createBridgeClient({ timeoutMs: 120_000, maxRetries: 1 });
  const status = await client.getStatus();
  if (!status.ok) {
    console.error(`[six-month-import] BRIDGE NOT REACHABLE: ${status.error.code} — ${status.error.message}`);
    process.exit(1);
  }
  if (!status.data.connected || !status.data.authenticated) {
    console.error('[six-month-import] BRIDGE NOT AUTHENTICATED — cannot acquire broker history. Exiting WITHOUT importing anything.');
    process.exit(1);
  }
  console.log(
    `[six-month-import] bridge OK — server=${status.data.server} gateway=${status.data.gateway} login=${status.data.loginMasked} brokerOffsetSec=${status.data.brokerOffsetSec} (verified=${status.data.brokerOffsetVerified})`,
  );

  const nowUtcSec = Math.floor(Date.now() / 1000);
  const perTf: Array<HistoricalImportStats> = [];
  const failures: Array<{ tf: string; code: string; message: string }> = [];

  for (const tf of TFS) {
    const tfSec = TIMEFRAME_SECONDS[tf];
    const toUtcSec = Math.floor(nowUtcSec / tfSec) * tfSec; // exclude the forming bar
    const fromUtcSec = Math.ceil((nowUtcSec - SIX_MONTHS_SEC) / tfSec) * tfSec; // aligned ~6 months back
    console.log(`[six-month-import] ${tf}: window ${iso(fromUtcSec)} → ${iso(toUtcSec)} (${((toUtcSec - fromUtcSec) / 86400).toFixed(1)} days)`);

    const outcome = await importHistoryRange(client, db, {
      symbol: SYMBOL,
      timeframe: tf,
      fromUtcSec,
      toUtcSec,
      onProgress: (m) => console.log(`  [${tf}] ${m}`),
    });

    if (outcome.ok) {
      perTf.push(outcome.stats);
    } else {
      console.error(`  [${tf}] FAILED: ${outcome.error.code} — ${outcome.error.message}`);
      failures.push({ tf, code: outcome.error.code, message: outcome.error.message });
      if (outcome.error.partialStats) perTf.push(outcome.error.partialStats);
    }
  }

  // ── manifest (machine-readable) ─────────────────────────────────────────
  const manifest = {
    generatedAtUtc: new Date().toISOString(),
    provider: {
      kind: 'broker-authorized-mt5-bridge',
      server: status.data.server,
      gateway: status.data.gateway,
      loginMasked: status.data.loginMasked,
      bridgeVersion: '2.0.0-signal-only',
      endpoint: 'GET /api/candles/range (read-only)',
    },
    instrument: SYMBOL,
    requestedWindow: {
      approxDays: 182.5,
      note: 'per-timeframe aligned window ending at the last closed bar at run time',
    },
    timeframes: perTf,
    failures,
    assumptions: [
      'Bars are broker bar-OPEN times normalized to UTC using the live-measured broker offset (Exness trial empirically UTC+0, verified from live quotes).',
      'Only CLOSED bars are persisted; the forming edge is dropped (the scheduled live sync owns it).',
      'Weekend/daily-break gap classification uses APPROXIMATE envelopes (generic spot-gold conventions) — the broker session schedule is not verified.',
      'Historical per-bar spread/tick bid-ask is NOT served by this source; costs in the backtest remain labeled assumptions.',
      'Closed candles are immutable: re-imports never rewrite stored OHLC; divergences are recorded, not applied.',
    ],
  };
  writeFileSync('audit/historical-data-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  // ── console coverage table ──────────────────────────────────────────────
  console.log('\n=== COVERAGE (broker-served, honest) ===');
  for (const s of perTf) {
    console.log(
      `${s.timeframe}: served ${iso(s.earliestBarUtcSec)} → ${iso(s.latestBarUtcSec)} · ${s.barsInserted} inserted ` +
      `(${s.barsAlreadyPresent} already present) · rejected=${s.barsRejectedInvalid} formingDropped=${s.barsFormingDropped} ` +
      `· non-closure missing=${s.missingSlots} pre-history=${s.preHistorySlots} closure=${s.closureSlots} · fp=${s.fingerprint?.slice(0, 16) ?? 'n/a'}`,
    );
  }
  if (failures.length) {
    console.log(`FAILURES: ${failures.map((f) => `${f.tf}(${f.code})`).join(', ')}`);
  }

  await db.$disconnect();
  const exitFail = failures.length > 0 ? 1 : 0;
  console.log(`[six-month-import] manifest → audit/historical-data-manifest.json (exit ${exitFail})`);
  process.exit(exitFail);
}

main().catch((e) => {
  console.error("[six-month-import] fatal:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
