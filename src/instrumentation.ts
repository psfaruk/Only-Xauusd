/**
 * XAUUSD AI Trading Agent — Server Instrumentation (Phase 3 → Phase 12)
 * ----------------------------------------------------------------------------
 * Next.js runs register() exactly once when the server process starts.
 * The scheduler owns the autonomous market-data + evaluation loop:
 *
 *   MARKET_SYNC_INTERVAL_MS > 0  AND  MT5_BRIDGE_URL set  →  interval sync
 *   otherwise (default)          →  scheduler stays completely off.
 *
 * Phase 12 (Task 32): with MARKET_SYNC_INTERVAL_MS=60000 the loop becomes a
 * 1-MINUTE cadence so the SCALPER strategy (M1/M5/M15 OR-logic) sees every
 * fresh M1 close:
 *
 *   every tick   → sync M1+M5+M15 → scalper evaluation → (setup + auto-armed
 *                  → risk check → single-attempt order, all inside the
 *                  scalper service's execution hook)
 *   every 5th    → sync also H1+H4 → baseline signal evaluation (+ candidate
 *                  dual evaluation) → paper trackers → baseline execution
 *                  hook (approval/auto, same discipline as the scalper)
 *
 * Task 36: the cadence floor dropped 30s → 10s so a 15-second interval makes
 * the scalper react to a fresh M1 close within seconds (user demand: data in
 * real time). The H1/H4 sync follows the same baseline tick math. The
 * position manager runs its OWN loop (position-manager.ts) and is started
 * below, independent of this sync cadence.
 *
 * The multi-agent GLM review still runs only on ACTIONABLE baseline setups.
 * Overlap is impossible: runSync refuses concurrent runs (SYNC_IN_PROGRESS).
 */

export async function register() {
  // Avoid importing app config inside the Edge/instrumentation bootstrap —
  // read the env switches directly and cheaply.
  const intervalMs = Number(process.env.MARKET_SYNC_INTERVAL_MS ?? '0');
  const bridgeUrl = (process.env.MT5_BRIDGE_URL ?? '').trim();

  // ── Task 33/35 — broker-credential drift sync (always on) ──────────────
  // DB-stored credentials (সেটিংস tab) are the source of truth once saved.
  // The bridge may (re)start with stale .env credentials — after app boot,
  // and then once per scheduler tick, compare the DB revision with the
  // bridge's applied revision and re-push when they drift. Fire-and-forget,
  // error-isolated, never blocks the scheduler.
  if (bridgeUrl && process.env.NEXT_RUNTIME === 'nodejs') {
    const { syncBridgeCredentials } = await import('@/lib/settings');
    const syncOnce = () =>
      void syncBridgeCredentials()
        .then((r) => {
          if (r.pushed) console.log(`[settings-sync] ${r.reason}`);
        })
        .catch(() => undefined);
    setTimeout(syncOnce, 10_000).unref?.();
    setInterval(syncOnce, Math.max(60_000, intervalMs || 60_000)).unref?.();
  }

  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !bridgeUrl) {
    console.log('[instrumentation] market sync scheduler: OFF (default) — enable with MARKET_SYNC_INTERVAL_MS + MT5_BRIDGE_URL');
    return;
  }

  const minInterval = Math.max(10_000, Math.floor(intervalMs));
  const { runSync } = await import('@/lib/market/ingestion');
  const { bridgeClient } = await import('@/lib/market/bridge-client');
  const { db } = await import('@/lib/db');

  // ── Task 36 — software position manager (breakeven / trailing / time stop).
  //    Independent of the sync loop: it watches OUR open positions every
  //    pollSec, banks moves at a trailing floor instead of round-tripping
  //    them to the SL, and feeds the post-loss circuit breaker. Never blocks
  //    the scheduler; disabled by POSITION_MANAGER_ENABLED=0.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startPositionManagerLoop } = await import('@/lib/execution/position-manager');
      startPositionManagerLoop();
    } catch {
      // the manager must never break the scheduler
    }
  }

  const symbol = (process.env.MARKET_SYMBOLS ?? 'XAUUSDm').split(',')[0]?.trim() || 'XAUUSDm';
  const allTimeframes = (process.env.MARKET_TIMEFRAMES ?? 'M1,M5,M15,H1,H4')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => ['M1', 'M5', 'M15', 'H1', 'H4'].includes(t)) as Array<'M1' | 'M5' | 'M15' | 'H1' | 'H4'>;
  const fastTimeframes = allTimeframes.filter((t) => t === 'M1' || t === 'M5' || t === 'M15');
  const slowTimeframes = allTimeframes.filter((t) => t === 'H1' || t === 'H4');
  /** The baseline/candidate research loop keeps its historical 5-minute
   *  cadence: N fast ticks between baseline evaluations. */
  const baselineEveryNTicks = Math.max(1, Math.round(300_000 / minInterval));
  const scalperEnabled = process.env.SCALPER_ENABLED !== '0';

  console.log(
    `[instrumentation] market sync scheduler: ON — every ${Math.round(minInterval / 1000)}s for ${symbol} [fast: ${fastTimeframes.join('/') || 'none'} · slow: ${slowTimeframes.join('/') || 'none'} every ${baselineEveryNTicks}]${scalperEnabled ? ' · scalper loop ON' : ' · scalper loop OFF'}`,
  );

  let tickCount = 0;

  const tick = async () => {
    tickCount += 1;
    const isBaselineTick = tickCount % baselineEveryNTicks === 0 || tickCount === 1;
    const timeframes = isBaselineTick ? allTimeframes : fastTimeframes;
    try {
      const outcome = await runSync(
        { bridge: bridgeClient, db },
        { mode: 'scheduled', symbol, timeframes },
      );
      if (outcome.status !== 'success') {
        console.warn(`[scheduler] sync ${outcome.status}: ${outcome.errorCode ?? ''} ${outcome.errorMessage ?? ''}`);
        return;
      }

      // ── Phase 12: SCALPER loop — every successful sync ─────────────────
      // (fire-and-forget, error-isolated; the execution hook lives inside
      // the scalper service: risk check → single-attempt auto order).
      if (scalperEnabled && process.env.NEXT_RUNTIME === 'nodejs') {
        try {
          const { runScalperEvaluation } = await import('@/lib/signal/scalper-service');
          void runScalperEvaluation({ symbol })
            .then((r) => {
              if (
                r.outcome === 'BUY_SETUP' ||
                r.outcome === 'SELL_SETUP' ||
                r.outcome === 'BLOCKED' ||
                r.outcome === 'FAILED'
              ) {
                console.log(
                  `[scheduler] scalper ${symbol} → ${r.outcome}${
                    r.evaluation.reasonCodes.length ? ` [${r.evaluation.reasonCodes.join(',')}]` : ''
                  }${r.evaluation.evidence?.scalper?.sourceTimeframe ? ` src=${r.evaluation.evidence.scalper.sourceTimeframe}` : ''}`,
                );
              }
            })
            .catch(() => undefined);
        } catch {
          // the scalper loop must never break the scheduler
        }
      }

      // ── Baseline research loop — historical 5-minute cadence ──────────
      if (isBaselineTick) {
        // Phase 10.2 — autonomous forward-paper loop: evaluate the
        // deterministic baseline engine + candidate dual evaluation after
        // every 5th successful scheduled sync (READ-ONLY research).
        if (process.env.FORWARD_PAPER_TRACKING !== '0' && process.env.NEXT_RUNTIME === 'nodejs') {
          try {
            const { runSignalEvaluation } = await import('@/lib/signal/service');
            void runSignalEvaluation({ symbol })
              .then(async (r) => {
                if (
                  r.outcome === 'BUY_SETUP' ||
                  r.outcome === 'SELL_SETUP' ||
                  r.outcome === 'FAILED'
                ) {
                  console.log(
                    `[scheduler] forward-paper signal ${symbol} → ${r.outcome}${
                      r.evaluation.reasonCodes.length ? ` [${r.evaluation.reasonCodes.join(',')}]` : ''
                    }`,
                  );
                }
                // Phase 6 — autonomous multi-agent review on ACTIONABLE setups
                // only (4 GLM calls each; NO_SETUP/WAIT would burn the budget).
                if (r.runId && (r.outcome === 'BUY_SETUP' || r.outcome === 'SELL_SETUP')) {
                  try {
                    const { runReviewForLatestEvaluation } = await import('@/lib/ai/multi-agent');
                    void runReviewForLatestEvaluation(symbol).catch(() => undefined);
                  } catch {
                    // the review must never break the scheduler
                  }
                }
                // Phase 11/12 — risk gate + auto/pending approval path for
                // the baseline. Fire-and-forget, error-isolated, idempotent
                // by signal id.
                if (r.outcome === 'BUY_SETUP' || r.outcome === 'SELL_SETUP') {
                  try {
                    const { processActionableSignal } = await import('@/lib/execution/service');
                    void processActionableSignal(symbol).catch(() => undefined);
                  } catch {
                    // the approval pipeline must never break the scheduler
                  }
                }
              })
              .catch(() => undefined);
          } catch {
            // signal evaluation must never break the sync scheduler
          }
        }
        // Phase 10: advance the read-only paper-signal tracking.
        if (process.env.NEXT_RUNTIME === 'nodejs') {
          try {
            const { trackPaperSignals } = await import('@/lib/signal/paper');
            void trackPaperSignals(db, { symbol }).catch(() => undefined);
          } catch {
            // paper tracking must never break the scheduler
          }
        }
        // Phase 11-E: advance the CANDIDATE forward-paper tracking.
        if (process.env.FORWARD_PAPER_TRACKING !== '0' && process.env.NEXT_RUNTIME === 'nodejs') {
          try {
            const { trackCandidatePaperSignals } = await import('@/lib/signal/candidate-paper');
            void trackCandidatePaperSignals(db, { symbol }).catch(() => undefined);
          } catch {
            // candidate paper tracking must never break the scheduler
          }
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
