/** Phase 8 Task 6 — run the backtest over verified live-broker candles. */
import { runBacktestService } from '../src/lib/backtest/service';
import type { Timeframe } from '../src/lib/market/types';

const main = async () => {
  for (const tf of ['M15', 'H1', 'H4'] as Timeframe[]) {
    const out = await runBacktestService({ symbol: 'XAUUSDm', timeframe: tf });
    console.log(`\n=== ${tf} ===`);
    console.log('status:', out.status, '| runId:', out.runId);
    if (out.error) console.log('error:', out.error);
    if (out.result) {
      const r = out.result;
      console.log(`dataset: ${r.dataset.candleCount} candles ${new Date(r.dataset.fromUtcSec * 1000).toISOString().slice(0, 10)} → ${new Date(r.dataset.toUtcSec * 1000).toISOString().slice(0, 10)} fp=${r.datasetFingerprint.slice(0, 16)}…`);
      console.log(`spread=${r.rules.spreadPrice} slippage=${r.rules.slippagePrice} RR=${r.rules.rewardRisk}`);
      for (const seg of ['dev', 'oos'] as const) {
        const m = r[seg];
        if (m.status === 'INSUFFICIENT_DATA') {
          console.log(`${seg}: INSUFFICIENT_DATA — ${m.reason}`);
        } else {
          console.log(`${seg}: trades=${m.executedTrades} winRate=${m.winRate} PF=${m.profitFactor} netPnl=${m.netPnlPrice} maxDD=${m.maxDrawdownPrice} avgRR=${m.avgRewardRisk} streakW/L=${m.maxConsecutiveWins}/${m.maxConsecutiveLosses}`);
        }
      }
    }
  }
  process.exit(0);
};
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
