/**
 * Phase 9 live audit script — runs the REAL signal engine against the LIVE
 * broker data path and proves:
 *   1. a live evaluation (whatever the honest outcome is),
 *   2. reproducibility (same dataset → same fingerprint & outcome),
 *   3. the signal-engine backtest over verified candles (live run),
 *   4. a second backtest run → identical dataset fingerprint (reproducible).
 *
 * Read-only: no order/trade/position capability exists anywhere.
 * Run: bun run scripts/phase9-signal-audit.ts
 */
import { runSignalEvaluation } from '../src/lib/signal/service';
import { runSignalBacktestService } from '../src/lib/backtest/service';

async function main() {
  console.log('=== PHASE 9 SIGNAL LIVE AUDIT ===');

  // 1+2) live evaluation, twice (reproducibility of outcome + fingerprint)
  const r1 = await runSignalEvaluation({ symbol: 'XAUUSDm' });
  console.log(`RUN 1 → ${r1.outcome}${r1.evaluation.reasonCodes.length ? ` [${r1.evaluation.reasonCodes.join(',')}]` : ''}`);
  if (r1.evaluation.levels) {
    const lv = r1.evaluation.levels;
    console.log(`  entry zone ${lv.entryZoneLowText}–${lv.entryZoneHighText} · SL ${lv.stopLossText} · target ${lv.targetText} · R:R ${lv.rewardRiskRatio}`);
  }
  if (r1.evaluation.evidence?.structureEvent) {
    const e = r1.evaluation.evidence.structureEvent;
    console.log(`  event: ${e.type} ${e.direction} @ ${e.levelText} (${e.barsSinceBreak} bars ago)`);
  }
  if (r1.evaluation.evidence) {
    const ev = r1.evaluation.evidence;
    console.log(`  indicators: EMA50=${ev.indicators.ema50?.toFixed(2)} RSI=${ev.indicators.rsi14?.toFixed(1)} ATR=${ev.indicators.atr14?.toFixed(2)} ADX=${ev.indicators.adx14?.toFixed(1)}`);
    console.log(`  HTF: H1=${ev.htfContext.h1Trend} H4=${ev.htfContext.h4Trend}`);
  }
  console.log(`  fp=${r1.evaluation.inputFingerprint.slice(0, 16)}`);

  const r2 = await runSignalEvaluation({ symbol: 'XAUUSDm' });
  const sameOutcome = r1.outcome === r2.outcome;
  const sameFp = r1.evaluation.inputFingerprint === r2.evaluation.inputFingerprint;
  console.log(`RUN 2 → ${r2.outcome} fp=${r2.evaluation.inputFingerprint.slice(0, 16)}`);
  console.log(`REPRODUCIBLE: ${sameOutcome && sameFp ? 'YES ✓' : 'NO ✗ (live data may have ticked between runs — dataset fingerprint differs only if data changed)'}`);

  // 3+4) signal-engine backtest, twice (dataset fingerprint identity)
  const b1 = await runSignalBacktestService({ symbol: 'XAUUSDm' });
  if (!b1.result) {
    console.log(`BACKTEST FAILED: ${b1.error}`);
    process.exit(1);
  }
  const c = b1.result.counters;
  console.log(`\nSIGNAL-ENGINE BACKTEST → ${b1.status}`);
  console.log(`  dataset: M15=${b1.result.dataset.executionCandles} H1=${b1.result.dataset.h1Candles} H4=${b1.result.dataset.h4Candles} (${new Date(b1.result.dataset.fromUtcSec * 1000).toISOString().slice(0, 10)} → ${new Date(b1.result.dataset.toUtcSec * 1000).toISOString().slice(0, 10)})`);
  console.log(`  fp=${b1.result.datasetFingerprint.slice(0, 16)}`);
  console.log(`  counters: evaluations=${c.evaluations} blocked=${c.blockedEvaluations} noSetup=${c.noSetup} wait=${c.wait} candidates=${c.candidateSetups} valid=${c.validSetups} fills=${c.hypotheticalFills} completed=${c.completedOutcomes}`);
  console.log(`  dev: ${b1.result.dev.status} trades=${b1.result.dev.executedTrades}${b1.result.dev.status === 'COMPUTED' ? ` winRate=${b1.result.dev.winRate} PF=${b1.result.dev.profitFactor} net=${b1.result.dev.netPnlPrice}` : ` (${b1.result.dev.reason})`}`);
  console.log(`  oos: ${b1.result.oos.status} trades=${b1.result.oos.executedTrades}${b1.result.oos.status === 'COMPUTED' ? ` winRate=${b1.result.oos.winRate} PF=${b1.result.oos.profitFactor} net=${b1.result.oos.netPnlPrice}` : ` (${b1.result.oos.reason})`}`);

  const b2 = await runSignalBacktestService({ symbol: 'XAUUSDm' });
  const sameDataset = b1.result.datasetFingerprint === b2.result?.datasetFingerprint;
  console.log(`BACKTEST REPRODUCIBLE (dataset fp): ${sameDataset ? 'YES ✓' : 'NO ✗'}`);

  console.log('\nNOTE: outcomes are research/decision support — never execution instructions.');
}

main().catch((e) => {
  console.error('AUDIT FAILED:', e);
  process.exit(1);
});
