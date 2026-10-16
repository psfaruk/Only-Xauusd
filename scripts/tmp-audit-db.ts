import { db } from '../src/lib/db';

async function main() {
  const counts = {
    evaluations: await db.signalEvaluation.count(),
    candles: await db.marketCandle.count(),
    signals: await db.signal.count(),
    paper: await db.paperSignalOutcome.count(),
    events: await db.systemEvent.count(),
    syncRuns: await db.syncRun.count(),
    ticks: await db.marketLatestTick.count(),
    symbolSpecs: await db.symbolSpec.count(),
    analysisRuns: await db.analysisRun.count(),
    riskChecks: await db.riskCheck.count(),
    tradeApprovals: await db.tradeApproval.count(),
    executionLogs: await db.executionLog.count(),
  };
  console.log('COUNTS:', JSON.stringify(counts));

  const latest = await db.signalEvaluation.findFirst({ orderBy: { createdAt: 'desc' } });
  if (latest) {
    console.log('LATEST_EVAL:', JSON.stringify({
      id: latest.id, createdAt: latest.createdAt, status: latest.status,
      reasonCode: latest.reasonCode, strategyVersion: latest.strategyVersion,
      symbol: latest.symbol
    }));
  } else {
    console.log('LATEST_EVAL: NONE');
  }
  const first = await db.signalEvaluation.findFirst({ orderBy: { createdAt: 'asc' } });
  console.log('FIRST_EVAL_AT:', first ? first.createdAt.toISOString() : 'NONE');

  const lastSync = await db.syncRun.findFirst({ orderBy: { startedAtUtc: 'desc' } });
  console.log('LAST_SYNC:', lastSync ? JSON.stringify({ startedAtUtc: lastSync.startedAtUtc, status: lastSync.status, inserted: lastSync.inserted }) : 'NONE');

  const lastTick = await db.marketLatestTick.findFirst({ where: { symbol: 'XAUUSDm' } });
  console.log('LAST_TICK:', lastTick ? JSON.stringify({ tickTimeUtc: lastTick.tickTimeUtc, receivedAtUtc: lastTick.receivedAtUtc, validationStatus: lastTick.validationStatus, source: lastTick.source }) : 'NONE');

  await db.$disconnect();
}
main().catch(e => { console.error('DB_ERROR:', e?.message?.slice(0, 300)); process.exit(1); });
