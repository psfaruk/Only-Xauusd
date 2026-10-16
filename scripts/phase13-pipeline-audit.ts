/**
 * PHASE 13 diagnostic — 48h signal-pipeline classification (READ-ONLY DB queries).
 * No data is written. No secrets printed.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

function sinceHours(h: number) {
  return new Date(Date.now() - h * 3600_000);
}

async function main() {
  const now = new Date();
  const since48 = sinceHours(48);
  console.log('NOW_UTC=' + now.toISOString());
  console.log('WINDOW_START=' + since48.toISOString());

  // 1. Total evaluation counts by outcome (all time + 48h)
  const byOutcomeAll = await db.signalEvaluation.groupBy({
    by: ['outcome'],
    _count: { _all: true },
  });
  console.log('\n=== SignalEvaluation by outcome (ALL TIME) ===');
  for (const r of byOutcomeAll) console.log(`${r.outcome}: ${r._count._all}`);

  const evals48 = await db.signalEvaluation.findMany({
    where: { createdAt: { gte: since48 } },
    select: {
      createdAt: true,
      outcome: true,
      reasonCodes: true,
      durationMs: true,
      executionLocked: true,
      setupKnownAtUtc: true,
      decisionCandleTimeUtc: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n=== Evaluations in last 48h: ${evals48.length} ===`);

  // reason code frequency in 48h
  const reasonFreq = new Map<string, number>();
  const outcomeFreq = new Map<string, number>();
  const parseReasons = (rc: unknown): string[] => {
    if (typeof rc === 'string') { try { const p = JSON.parse(rc); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
    if (Array.isArray(rc)) return rc.map(String);
    return [];
  };
  for (const e of evals48) {
    outcomeFreq.set(e.outcome, (outcomeFreq.get(e.outcome) ?? 0) + 1);
    for (const rc of parseReasons(e.reasonCodes)) reasonFreq.set(rc, (reasonFreq.get(rc) ?? 0) + 1);
  }
  console.log('\nOutcome frequency (48h):');
  for (const [k, v] of [...outcomeFreq].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log('Reason-code frequency (48h):');
  for (const [k, v] of [...reasonFreq].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  // earliest and latest in window
  if (evals48.length > 0) {
    console.log(`\nFirst eval in window: ${evals48[0].createdAt.toISOString()} outcome=${evals48[0].outcome}`);
    console.log(`Last eval in window:  ${evals48[evals48.length - 1].createdAt.toISOString()} outcome=${evals48[evals48.length - 1].outcome}`);
    // gap analysis: max interval between consecutive evals
    let maxGapMs = 0; let gapAfter: string | null = null;
    for (let i = 1; i < evals48.length; i++) {
      const gap = evals48[i].createdAt.getTime() - evals48[i - 1].createdAt.getTime();
      if (gap > maxGapMs) { maxGapMs = gap; gapAfter = evals48[i - 1].createdAt.toISOString(); }
    }
    console.log(`Max gap between evals: ${(maxGapMs / 60000).toFixed(1)} min (after ${gapAfter})`);
    // avg duration
    const durs = evals48.map((e) => e.durationMs ?? 0);
    console.log(`Eval duration ms: min=${Math.min(...durs)} max=${Math.max(...durs)} avg=${(durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(0)}`);
    // any executionLocked=false?
    console.log(`executionLocked=false count: ${evals48.filter((e) => e.executionLocked === false).length}`);
  } else {
    console.log('NO EVALUATIONS IN 48h WINDOW — scheduler not running or not persisting!');
  }

  // 2. Any BUY/SELL ever?
  const directional = await db.signalEvaluation.findMany({
    where: { outcome: { in: ['BUY', 'SELL'] } },
    select: { createdAt: true, outcome: true, reasonCodes: true, symbol: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log(`\n=== Directional (BUY/SELL) evaluations EVER: ${directional.length} (showing up to 10) ===`);
  for (const d of directional) console.log(`${d.createdAt.toISOString()} ${d.outcome} ${d.symbol} reasons=${parseReasons(d.reasonCodes).join(',')}`);

  // earliest SignalEvaluation ever in this DB
  const firstEvalEver = await db.signalEvaluation.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  console.log(`Earliest SignalEvaluation in DB: ${firstEvalEver?.createdAt?.toISOString() ?? 'NONE'}`);
  // earliest/last SyncRun ever
  const firstSyncEver = await db.syncRun.findFirst({ orderBy: { startedAtUtc: 'asc' }, select: { startedAtUtc: true } });
  console.log(`Earliest SyncRun in DB: ${firstSyncEver?.startedAtUtc?.toISOString() ?? 'NONE'}`);
  // earliest/last candle ever
  const firstCandleEver = await db.marketCandle.findFirst({ orderBy: { candleTimeUtc: 'asc' }, select: { candleTimeUtc: true, timeframe: true } });
  console.log(`Earliest MarketCandle in DB: ${firstCandleEver ? firstCandleEver.timeframe + ' @ ' + firstCandleEver.candleTimeUtc.toISOString() : 'NONE'} (backfill history, not runtime start)`);

  // 3. SyncRun health in 48h
  const syncs48 = await db.syncRun.findMany({
    where: { startedAtUtc: { gte: since48 } },
    select: { startedAtUtc: true, status: true, inserted: true, updated: true, rejected: true, duplicates: true, errorCode: true, durationMs: true },
    orderBy: { startedAtUtc: 'asc' },
  });
  console.log(`\n=== SyncRuns in last 48h: ${syncs48.length} ===`);
  const syncStatus = new Map<string, number>();
  for (const s of syncs48) syncStatus.set(s.status, (syncStatus.get(s.status) ?? 0) + 1);
  for (const [k, v] of syncStatus) console.log(`  ${k}: ${v}`);
  if (syncs48.length > 0) {
    let maxGapMs = 0; let gapAfter: string | null = null;
    for (let i = 1; i < syncs48.length; i++) {
      const gap = syncs48[i].startedAtUtc.getTime() - syncs48[i - 1].startedAtUtc.getTime();
      if (gap > maxGapMs) { maxGapMs = gap; gapAfter = syncs48[i - 1].startedAtUtc.toISOString(); }
    }
    console.log(`First sync: ${syncs48[0].startedAtUtc.toISOString()}  Last sync: ${syncs48[syncs48.length - 1].startedAtUtc.toISOString()}`);
    console.log(`Max gap between syncs: ${(maxGapMs / 60000).toFixed(1)} min (after ${gapAfter})`);
    const rejectedTotal = syncs48.reduce((a, s) => a + (s.rejected ?? 0), 0);
    console.log(`Total rejected candles in window: ${rejectedTotal}`);
  }

  // 4. AnalysisRun records in 48h (uses startedAt, not createdAt)
  const analysisRuns48 = await db.analysisRun.count({ where: { startedAt: { gte: since48 } } });
  console.log(`\n=== AnalysisRun records in 48h: ${analysisRuns48} ===`);
  const analysisAll = await db.analysisRun.count({});
  console.log(`AnalysisRun records ALL TIME: ${analysisAll}`);
  if (analysisAll > 0) {
    const firstAR = await db.analysisRun.findFirst({ orderBy: { startedAt: 'asc' }, select: { startedAt: true } });
    const lastAR = await db.analysisRun.findFirst({ orderBy: { startedAt: 'desc' }, select: { startedAt: true, status: true } });
    console.log(`AnalysisRun span: ${firstAR?.startedAt?.toISOString()} → ${lastAR?.startedAt?.toISOString()} (last status=${lastAR?.status})`);
  }

  // 5. SystemEvent errors in 48h (count by code)
  const events48 = await db.systemEvent.findMany({
    where: { createdAt: { gte: since48 } },
    select: { level: true, code: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`\n=== SystemEvents in 48h: ${events48.length} ===`);
  const codeFreq = new Map<string, number>();
  for (const e of events48) {
    const key = `${e.level}/${e.code}`;
    codeFreq.set(key, (codeFreq.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...codeFreq].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${k}: ${v}`);

  // 6. Candle freshness per TF
  for (const tf of ['M5', 'M15', 'H1', 'H4']) {
    const last = await db.marketCandle.findFirst({
      where: { symbol: 'XAUUSDm', timeframe: tf },
      orderBy: { candleTimeUtc: 'desc' },
      select: { candleTimeUtc: true, isForming: true, validationStatus: true },
    });
    const count = await db.marketCandle.count({ where: { symbol: 'XAUUSDm', timeframe: tf } });
    console.log(`TF ${tf}: candles=${count} last=${last ? last.candleTimeUtc.toISOString() : 'NONE'} forming=${last?.isForming} status=${last?.validationStatus}`);
  }

  // 7. Latest tick
  const tick = await db.marketLatestTick.findUnique({ where: { symbol: 'XAUUSDm' } });
  if (tick) {
    console.log(`\nLatestTick: bid=${tick.bid} ask=${tick.ask} spread=${tick.spread} tickTime=${tick.tickTimeUtc?.toISOString()} received=${tick.receivedAtUtc?.toISOString()} status=${tick.validationStatus}`);
  }

  // 8. AiReview status in 48h (GLM stage)
  const aiReviews = await db.aiReview.count({ where: { createdAt: { gte: since48 } } });
  console.log(`\nAiReview records in 48h: ${aiReviews}`);

  // 9. PaperSignalOutcome (forward tracking)
  const paperCount = await db.paperSignalOutcome.count();
  console.log(`PaperSignalOutcome total: ${paperCount}`);

  // 10. DB totals
  console.log(`\nTotal SignalEvaluation: ${await db.signalEvaluation.count()}`);
  console.log(`Total SyncRun: ${await db.syncRun.count()}`);
  console.log(`Total SystemEvent: ${await db.systemEvent.count()}`);

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error('DIAGNOSTIC FAILED:', e);
  await db.$disconnect();
  process.exit(1);
});
