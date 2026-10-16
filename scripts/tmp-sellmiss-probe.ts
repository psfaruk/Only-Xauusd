/** TEMP read-only diagnostic for the M1/M5 sell-miss audit. Deleted after use. */
import { db } from '../src/lib/db';

async function main() {
  const now = Date.now();
  const tfs = await (db as any).marketCandle.groupBy({
    by: ['timeframe'],
    _count: { _all: true },
    _max: { candleTimeUtc: true },
    _min: { candleTimeUtc: true },
  });
  console.log('== TF coverage ==');
  for (const t of tfs) {
    console.log(
      t.timeframe,
      'count=', t._count._all,
      'from=', t._min.candleTimeUtc?.toISOString(),
      'to=', t._max.candleTimeUtc?.toISOString(),
    );
  }
  const tick = await (db as any).marketLatestTick.findFirst();
  console.log('== LatestTick ==', tick ? { bid: tick.bid, ask: tick.ask, spread: tick.spread, ts: tick.tickTimeUtc?.toISOString(), recv: tick.receivedAtUtc?.toISOString() } : null);

  // The 4300 -> 4260 window: ~3h ago (user-provided approx). Current UTC: print.
  console.log('== now ==', new Date().toISOString());
  const since = new Date(now - 6 * 3600_000);
  const recentM5 = await (db as any).marketCandle.findMany({
    where: { timeframe: 'M5', candleTimeUtc: { gte: since }, validationStatus: { in: ['VALID', 'WARNING'] }, isForming: false },
    orderBy: { candleTimeUtc: 'asc' },
    select: { candleTimeUtc: true, open: true, high: true, low: true, close: true },
  });
  console.log('== M5 last 6h ==', recentM5.length, 'bars');
  if (recentM5.length) {
    let hi = -Infinity, lo = Infinity, hiT = '', loT = '';
    for (const c of recentM5) {
      const h = Number(c.high), l = Number(c.low);
      if (h > hi) { hi = h; hiT = c.candleTimeUtc.toISOString(); }
      if (l < lo) { lo = l; loT = c.candleTimeUtc.toISOString(); }
    }
    console.log('6h window: high', hi.toFixed(3), hiT, '| low', lo.toFixed(3), loT);
    console.log('first', recentM5[0].candleTimeUtc.toISOString(), 'O', recentM5[0].open, 'last', recentM5[recentM5.length-1].candleTimeUtc.toISOString(), 'C', recentM5[recentM5.length-1].close);
  }
  // evaluations
  const total = await (db as any).signalEvaluation.count();
  console.log('== SignalEvaluations total ==', total);
  const recent = await (db as any).signalEvaluation.findMany({
    orderBy: { createdAt: 'desc' }, take: 25,
    select: { createdAt: true, outcome: true, reasonCodes: true, strategyVersion: true, decisionCandleTimeUtc: true },
  });
  for (const r of recent) console.log(r.createdAt.toISOString(), r.outcome, r.reasonCodes, r.decisionCandleTimeUtc?.toISOString() ?? '');
  const hist: any[] = await (db as any).$queryRaw`SELECT outcome, reasonCodes, COUNT(*) as c FROM SignalEvaluation GROUP BY outcome, reasonCodes ORDER BY c DESC LIMIT 20`;
  console.log('== reason histogram (all-time) ==');
  for (const h of hist) console.log(h.c, h.outcome, h.reasonCodes);
  const runs = await (db as any).analysisRun.count();
  console.log('== AnalysisRuns ==', runs);
  await (db as any).$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
