/** TEMP read-only diagnostic #2 — evidence trace during the decline + 4300 search. */
import { db } from '../src/lib/db';

async function main() {
  // 1) Full evidence for evals 13:00Z-16:30Z today (the decline + after)
  const evals = await db.signalEvaluation.findMany({
    where: { createdAt: { gte: new Date('2026-10-16T12:30:00Z') } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, outcome: true, reasonCodes: true, evidence: true, decisionCandleTimeUtc: true },
  });
  console.log('== evals since 12:30Z ==', evals.length);
  let prevKey = '';
  for (const e of evals) {
    const ev = e.evidence ? JSON.parse(JSON.stringify(e.evidence)) : null;
    const key = `${e.outcome}|${String(e.reasonCodes)}|${ev?.structureEvent?.breakCandleTimeUtc ?? ''}|${ev?.structureEvent?.direction ?? ''}|${ev?.htfContext?.h1Trend ?? ''}/${ev?.htfContext?.h4Trend ?? ''}|${ev?.retestBarTimeUtc ?? ''}`;
    if (key !== prevKey) {
      console.log(
        e.createdAt.toISOString(),
        e.outcome,
        String(e.reasonCodes),
        'decision=', e.decisionCandleTimeUtc?.toISOString() ?? '',
        'break=', ev?.structureEvent?.breakCandleTimeUtc ?? '—',
        ev?.structureEvent?.type + '/' + ev?.structureEvent?.direction + '@' + ev?.structureEvent?.levelText ?? '',
        'barsSince=', ev?.structureEvent?.barsSinceBreak ?? '—',
        'htf=', ev?.htfContext?.h1Trend + '/' + ev?.htfContext?.h4Trend,
        'retest=', ev?.retestBarTimeUtc ?? '—',
        'ind=', ev ? JSON.stringify(ev.indicators) : '',
      );
      prevKey = key;
    }
  }
  // 2) When was price last near 4300? H1 26 days, H4 110 days.
  const h1 = await db.marketCandle.findMany({
    where: { timeframe: 'H1', isForming: false },
    orderBy: { candleTimeUtc: 'asc' },
    select: { candleTimeUtc: true, high: true, low: true },
  });
  let last4300: string | null = null;
  let hi = -Infinity, hiT = '';
  for (const c of h1) {
    const h = Number(c.high);
    if (h >= 4280) last4300 = c.candleTimeUtc.toISOString();
    if (h > hi) { hi = h; hiT = c.candleTimeUtc.toISOString(); }
  }
  console.log('== H1 26d: max high', hi.toFixed(3), hiT, '| last bar with high>=4280:', last4300);
  const h4 = await db.marketCandle.findMany({
    where: { timeframe: 'H4', isForming: false },
    orderBy: { candleTimeUtc: 'asc' },
    select: { candleTimeUtc: true, high: true, low: true },
  });
  let h4hi = -Infinity, h4hiT = '', h4last4300: string | null = null;
  for (const c of h4) {
    const h = Number(c.high);
    if (h >= 4280) h4last4300 = c.candleTimeUtc.toISOString();
    if (h > h4hi) { h4hi = h; h4hiT = c.candleTimeUtc.toISOString(); }
  }
  console.log('== H4 110d: max high', h4hi.toFixed(3), h4hiT, '| last H4 bar with high>=4280:', h4last4300);
  // 3) earliest eval today (scheduler restart)
  const first = await db.signalEvaluation.findFirst({ orderBy: { createdAt: 'asc' } });
  console.log('== earliest eval in DB ==', first?.createdAt.toISOString());
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
