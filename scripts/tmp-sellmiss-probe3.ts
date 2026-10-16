/** TEMP read-only diagnostic #3 — full evidence parse for the decline window. */
import { db } from '../src/lib/db';

async function main() {
  const evals = await db.signalEvaluation.findMany({
    where: { createdAt: { gte: new Date('2026-10-16T12:30:00Z') } },
    orderBy: { createdAt: 'asc' },
  });
  let prevKey = '';
  for (const e of evals as any[]) {
    let ev: any = null;
    try { ev = typeof e.evidence === 'string' ? JSON.parse(e.evidence) : e.evidence; } catch { ev = null; }
    const se = ev?.structureEvent ?? null;
    const key = `${e.outcome}|${e.reasonCodes}|${se?.breakCandleTimeUtc ?? ''}`;
    if (key === prevKey) continue;
    prevKey = key;
    console.log(
      e.createdAt.toISOString(), '|', e.outcome, String(e.reasonCodes),
      '\n   decision=', e.decisionCandleTimeUtc?.toISOString ?? e.decisionCandleTimeUtc,
      'break=', se ? `${se.type} ${se.direction} @ ${se.levelText} (${se.breakCandleTimeUtc}, ${se.barsSinceBreak} bars ago)` : 'none',
      '\n   htf=', ev?.htfContext ? `${ev.htfContext.h1Trend}/${ev.htfContext.h4Trend}` : '—',
      'retest=', ev?.retestBarTimeUtc ?? '—',
      'ind=', ev?.indicators ? JSON.stringify(ev.indicators) : '—',
      'anchor=', ev?.anchorSwing ? `${ev.anchorSwing.kind}@${ev.anchorSwing.priceText}` : '—',
    );
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
