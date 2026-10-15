/**
 * XAUUSD AI Trading Agent — Server Instrumentation (Phase 3)
 * ----------------------------------------------------------------------------
 * Next.js runs register() exactly once when the server process starts.
 * Used ONLY for the optional scheduled market-data sync:
 *
 *   MARKET_SYNC_INTERVAL_MS > 0  AND  MT5_BRIDGE_URL set  →  interval sync
 *   otherwise (default)          →  scheduler stays completely off.
 *
 * The scheduler calls the same read-only ingestion service as the manual
 * trigger — it cannot place, modify or close orders (no such code exists).
 * Overlap is impossible: runSync refuses concurrent runs (SYNC_IN_PROGRESS).
 */

export async function register() {
  // Avoid importing app config inside the Edge/instrumentation bootstrap —
  // read the two env switches directly and cheaply.
  const intervalMs = Number(process.env.MARKET_SYNC_INTERVAL_MS ?? '0');
  const bridgeUrl = (process.env.MT5_BRIDGE_URL ?? '').trim();

  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !bridgeUrl) {
    console.log('[instrumentation] market sync scheduler: OFF (default) — enable with MARKET_SYNC_INTERVAL_MS + MT5_BRIDGE_URL');
    return;
  }

  const minInterval = Math.max(30_000, Math.floor(intervalMs));
  const { runSync } = await import('@/lib/market/ingestion');
  const { bridgeClient } = await import('@/lib/market/bridge-client');
  const { db } = await import('@/lib/db');

  const symbol = (process.env.MARKET_SYMBOLS ?? 'XAUUSDm').split(',')[0]?.trim() || 'XAUUSDm';
  const timeframes = (process.env.MARKET_TIMEFRAMES ?? 'M5,M15,H1,H4')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => ['M5', 'M15', 'H1', 'H4'].includes(t));

  console.log(`[instrumentation] market sync scheduler: ON — every ${Math.round(minInterval / 1000)}s for ${symbol} [${timeframes.join('/')}]`);

  const tick = async () => {
    try {
      const outcome = await runSync(
        { bridge: bridgeClient, db },
        { mode: 'scheduled', symbol, timeframes: timeframes as Array<'M5' | 'M15' | 'H1' | 'H4'> },
      );
      if (outcome.status !== 'success') {
        console.warn(`[scheduler] sync ${outcome.status}: ${outcome.errorCode ?? ''} ${outcome.errorMessage ?? ''}`);
      } else {
        // Phase 10: advance the read-only paper-signal tracking after every
        // successful scheduled sync (fire-and-forget, error-isolated).
        try {
          const { trackPaperSignals } = await import('@/lib/signal/paper');
          void trackPaperSignals(db, { symbol }).catch(() => undefined);
        } catch {
          // paper tracking must never break the sync scheduler
        }
      }
    } catch (err) {
      console.error('[scheduler] sync crashed:', err instanceof Error ? err.message : err);
    }
  };

  // First run shortly after boot, then on the interval.
  setTimeout(() => void tick(), 5_000).unref?.();
  setInterval(() => void tick(), minInterval).unref?.();
}
