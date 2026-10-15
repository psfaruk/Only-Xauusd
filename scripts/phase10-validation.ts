/**
 * Phase 10 — Strategy Validation Runner (ACTUAL BACKTEST OUTPUTS).
 * ----------------------------------------------------------------------------
 * Runs over VERIFIED BROKER CANDLES ONLY (DB rows with source=bridge-mt5,
 * validationStatus=VALID, isForming=false, re-validated at read time).
 *
 *   1. Signal-engine validation (hybrid-structure-retest v9.0.0) — three-way
 *      dev/val/OOS split, walk-forward windows, cost sensitivity, parameter
 *      perturbation SET, pre-registered interpretation.
 *   2. Phase 8 structure-proxy per timeframe (M15/H1/H4) — secondary
 *      reference, clearly labeled as the documented hypothesis, NOT the
 *      production signal engine.
 *   3. Read-only paper-signal forward tracking advancement.
 *
 * No strategy parameter is changed. No execution code exists. Synthetic data
 * is NEVER used here — unit tests use clearly-labeled synthetic fixtures,
 * this script uses only verified historical broker data.
 */

import { runValidationService } from '../src/lib/backtest/validation-service';
import { runBacktestService } from '../src/lib/backtest/service';
import { trackPaperSignals, getPaperSignalSummary } from '../src/lib/signal/paper';
import { db } from '../src/lib/db';
import type { Timeframe } from '../src/lib/market/types';

const iso = (sec: number | null | undefined) =>
  sec ? new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—';

const main = async () => {
  const symbol = process.env.TRADING_SYMBOLS?.split(',')[0]?.trim() || 'XAUUSDm';

  // ── 1. Signal-engine validation (primary) ────────────────────────────────
  console.log(`\n================ SIGNAL-ENGINE VALIDATION (${symbol}) ================`);
  const v = await runValidationService({ symbol });
  console.log('status:', v.status, '| runId:', v.runId, v.error ? `| ERROR: ${v.error}` : '');
  if (v.result) {
    const r = v.result;
    console.log(`harness=${r.harnessVersion} strategy=${r.strategyVersion}`);
    console.log(`dataset: M15=${r.dataset.executionCandles} H1=${r.dataset.h1Candles} H4=${r.dataset.h4Candles} ${iso(r.dataset.fromUtcSec)} → ${iso(r.dataset.toUtcSec)} fp=${r.datasetFingerprint.slice(0, 16)}…`);
    console.log(`split: dev=${r.dataset.splitFractions.dev} val=${r.dataset.splitFractions.val} oos=${r.dataset.splitFractions.oos} | observed spread=${r.dataset.observedSpreadPrice}`);
    console.log(`counters: evaluations=${r.counters.evaluations} blocked=${r.counters.blockedEvaluations} noSetup=${r.counters.noSetup} wait=${r.counters.wait} candidates=${r.counters.candidateSetups} validSetups=${r.counters.validSetups} fills=${r.counters.hypotheticalFills} completed=${r.counters.completedOutcomes}`);
    for (const seg of ['dev', 'val', 'oos'] as const) {
      const m = r.segments[seg];
      if (m.status === 'INSUFFICIENT_DATA') {
        console.log(`${seg}: INSUFFICIENT_DATA — ${m.reason}`);
      } else {
        console.log(`${seg}: trades=${m.trades} win=${m.winRate} PF=${m.profitFactor} gross=${m.grossPnlPrice} costs=${m.costsPrice} net=${m.netPnlPrice} exp=${m.expectancyPrice} R=${m.expectancyR} maxDD=${m.maxDrawdownPrice} maxConsecLoss=${m.maxConsecutiveLosses} exposure%=${m.exposurePct} trades/wk=${m.tradesPerWeek} top1Share=${m.concentration.top1GrossShare}`);
      }
    }
    console.log('walk-forward windows:');
    for (const w of r.walkForward.windows) {
      const m = w.metrics;
      console.log(`  w${w.index}: ${iso(w.fromUtcSec)} → ${iso(w.toUtcSec)} bars=${w.candles} ${m.status === 'COMPUTED' ? `trades=${m.trades} net=${m.netPnlPrice} PF=${m.profitFactor}` : `INSUFFICIENT_DATA (${m.trades} trades)`}`);
    }
    const agg = r.walkForward.aggregate;
    console.log(`walk-forward aggregate: ${agg.status === 'COMPUTED' ? `trades=${agg.trades} net=${agg.netPnlPrice} PF=${agg.profitFactor}` : `INSUFFICIENT_DATA (${agg.reason})`}`);
    console.log('sensitivity:');
    for (const s of r.sensitivity) {
      console.log(`  ${s.scenario}: spread=${s.spreadPrice} slip=${s.slippagePrice} comm=${s.commissionPrice} trades=${s.trades} net=${s.netPnlPrice} PF=${s.profitFactor} netPositive=${s.netPositive}`);
    }
    console.log(`perturbation set (${r.perturbations.length} rows — complete set, nothing selected):`);
    for (const p of r.perturbations) {
      console.log(`  ${p.param === '(baseline)' ? '(baseline)' : `${p.param}=${p.value} (base ${p.baselineValue})`}: trades=${p.trades} net=${p.netPnlPrice} PF=${p.profitFactor}`);
    }
    console.log(`INTERPRETATION: ${r.interpretation.conclusion}`);
    for (const reason of r.interpretation.reasons) console.log(`  · ${reason}`);
    if (r.warnings.length) {
      console.log('warnings:');
      for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    }
  }

  // ── 2. Phase 8 structure-proxy per TF (secondary reference) ─────────────
  console.log(`\n================ PHASE 8 STRUCTURE-PROXY (secondary reference, NOT the production engine) ================`);
  for (const tf of ['M15', 'H1', 'H4'] as Timeframe[]) {
    const out = await runBacktestService({ symbol, timeframe: tf });
    console.log(`\n=== ${tf} ===`);
    console.log('status:', out.status, '| runId:', out.runId);
    if (out.result) {
      const r = out.result;
      console.log(`dataset: ${r.dataset.candleCount} candles ${new Date(r.dataset.fromUtcSec * 1000).toISOString().slice(0, 10)} → ${new Date(r.dataset.toUtcSec * 1000).toISOString().slice(0, 10)} fp=${r.datasetFingerprint.slice(0, 16)}…`);
      for (const seg of ['dev', 'oos'] as const) {
        const m = r[seg];
        if (m.status === 'INSUFFICIENT_DATA') {
          console.log(`${seg}: INSUFFICIENT_DATA — ${m.reason}`);
        } else {
          console.log(`${seg}: trades=${m.executedTrades} winRate=${m.winRate} PF=${m.profitFactor} netPnl=${m.netPnlPrice} maxDD=${m.maxDrawdownPrice} avgRR=${m.avgRewardRisk}`);
        }
      }
    }
  }

  // ── 3. Paper-signal tracking advancement + summary ──────────────────────
  console.log(`\n================ PAPER-SIGNAL FORWARD TRACKING ================`);
  const track = await trackPaperSignals(db, { symbol });
  console.log(
    `scanned=${track.scanned} newlyOpened=${track.newlyOpened} advanced=${track.advanced} skippedResolved=${track.skippedResolved} resolved: stopped=${track.resolved.stopped} targeted=${track.resolved.targeted} invalidated=${track.resolved.invalidated} expired=${track.resolved.expired}`,
  );
  if (track.errors.length) console.log('errors:', track.errors.slice(0, 5));
  const paper = await getPaperSignalSummary(db, symbol, 50);
  console.log(
    `summary: total=${paper.total} open=${paper.open} resolved: stopped=${paper.resolved.stopped} targeted=${paper.resolved.targeted} invalidated=${paper.resolved.invalidated} expired=${paper.resolved.expired} | withPnl=${paper.resolvedWithPnl} wins=${paper.wins} losses=${paper.losses} netR=${paper.sumR} avgR=${paper.avgR}`,
  );

  await db.$disconnect();
  process.exit(0);
};

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
