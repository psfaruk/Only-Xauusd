/**
 * Phase 10.3-A — BEFORE/AFTER deduplication comparison on the LIVE persisted
 * dataset (READ-ONLY: SELECTs only — no writes, no deletes, no resets).
 *
 * Reports, over the CURRENT db/custom.db contents:
 *   · raw SignalEvaluation rows (and how many carry a complete setup identity)
 *   · distinct logical setups by setupFingerprint (the deduped view)
 *   · the largest same-setup cluster (live proof of repeated evaluations)
 *   · paper rows: OLD algorithm (one row per evaluation id) vs NEW algorithm
 *     (one row per fingerprint) — over the SAME persisted dataset
 *   · forward-paper verdict inputs before/after (pre-registered aggregation,
 *     which is UNCHANGED by Phase 10.3-A)
 *
 * Run: bun run scripts/phase10.3a-dedup-comparison.ts
 */

import { db } from '../src/lib/db';
import { buildStrategyRules } from '../src/lib/signal/rules';
import { setupFingerprintFromEvidence } from '../src/lib/signal/setup-identity';
import { getForwardPaperStatus } from '../src/lib/signal/forward';
import { applyFirstOpenRule, type ForwardPaperRowInput } from '../src/lib/signal/paper-protocol';

const SYMBOL = 'XAUUSDm';

async function main(): Promise<void> {
  const evRows = await db.signalEvaluation.findMany({ where: { symbol: SYMBOL }, orderBy: { createdAt: 'asc' } });
  const paperRows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL } });

  const executionTf = buildStrategyRules().executionTf;
  const fingerprintOf = (row: { strategyVersion: string; evidence: string }) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.evidence ?? '{}');
    } catch {
      parsed = null;
    }
    return setupFingerprintFromEvidence({ symbol: SYMBOL, timeframe: executionTf, strategyVersion: row.strategyVersion, evidence: parsed });
  };

  // ── Cluster the persisted evaluations by logical setup identity ──────────
  const clusters = new Map<string, { count: number; first: Date; last: Date; sample: string }>();
  let identifiable = 0;
  let unidentifiable = 0;
  for (const r of evRows) {
    const fp = fingerprintOf(r);
    if (fp === null) {
      unidentifiable += 1;
      continue;
    }
    identifiable += 1;
    const c = clusters.get(fp) ?? { count: 0, first: r.createdAt, last: r.createdAt, sample: `${r.outcome} [${(JSON.parse(r.reasonCodes ?? '[]') as string[]).join(',')}] decision=${r.decisionCandleTimeUtc?.toISOString() ?? 'null'}` };
    c.count += 1;
    c.last = r.createdAt;
    clusters.set(fp, c);
  }

  const setupEvals = evRows.filter((r) => r.outcome === 'BUY_SETUP' || r.outcome === 'SELL_SETUP');
  const setupFps = new Set<string>();
  for (const r of setupEvals) {
    const fp = fingerprintOf(r);
    if (fp !== null) setupFps.add(fp);
  }

  console.log('════════════════════════════════════════════════════════════════════');
  console.log('PHASE 10.3-A — BEFORE/AFTER DEDUPLICATION COMPARISON (live persisted dataset, read-only)');
  console.log(`executed at ${new Date().toISOString()}  (execution TF: ${executionTf})`);
  console.log('════════════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`── Persisted SignalEvaluation rows (raw): ${evRows.length}`);
  console.log(`   · carrying a complete setup identity : ${identifiable}`);
  console.log(`   · no identity (BLOCKED / no event)    : ${unidentifiable}`);
  console.log(`── Distinct logical setups (deduped view by setupFingerprint): ${clusters.size}`);
  const sortedClusters = [...clusters.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [fp, c] of sortedClusters.slice(0, 5)) {
    console.log(`   · cluster ${fp.slice(0, 16)}…: ${c.count} evaluation(s) of ONE setup`);
    console.log(`     first=${c.first.toISOString()} last=${c.last.toISOString()}`);
    console.log(`     sample: ${c.sample}`);
  }
  console.log('');
  console.log('── Paper rows over the SAME dataset ──────────────────────────────');
  console.log(`   OLD algorithm (pre-10.3-A, one row per evaluation id): ${setupEvals.length} would exist for ${setupEvals.length} SETUP evaluation(s)`);
  console.log(`   NEW algorithm (one row per setupFingerprint)          : ${setupFps.size} would exist for the same ${setupEvals.length} evaluation(s)`);
  console.log(`   PaperSignalOutcome rows actually persisted right now  : ${paperRows.length}`);
  if (setupEvals.length === 0) {
    console.log('   (honest note: 0 SETUP outcomes exist in the live data so far — the');
    console.log('    comparison is degenerate 0→0 on live rows; the meaningful proof runs');
    console.log('    in tests/signal/setup-identity.test.ts D4 on a synthetic 11-row');
    console.log('    cluster shaped like the live 2026-10-15 wait/invalidation cluster.)');
  }
  console.log('');

  // ── Forward-paper verdict inputs before/after (pre-registered, unchanged) ─
  const status = await getForwardPaperStatus(db, SYMBOL);
  const inputs: ForwardPaperRowInput[] = paperRows.map((r) => ({
    id: r.id,
    direction: r.direction,
    signalCreatedAtMs: r.signalCreatedAtUtc.getTime(),
    status: r.status,
    outcome: r.outcome,
    netPnlPrice: r.netPnlPrice,
    rMultiple: r.rMultiple,
    resolutionBarTimeMs: r.resolutionBarTimeUtc?.getTime() ?? null,
    resolvedAtMs: r.resolvedAtUtc?.getTime() ?? null,
  }));
  const { counted, repeats } = applyFirstOpenRule(inputs);
  console.log('── Forward-paper verdict inputs (pre-registered aggregation — UNCHANGED code) ──');
  console.log(`   eligibleRows=${status.progress.eligibleRows}  countedCompleted=${status.progress.countedCompleted}  openCounted=${status.progress.openCounted}`);
  console.log(`   repeatObservations=${status.progress.repeatObservations}  unobservableResolved=${status.progress.unobservableResolved}`);
  console.log(`   first-open over the ${paperRows.length} persisted row(s): counted=${counted.length}, repeats=${repeats.length}`);
  console.log(`   verdict=${status.verdict.conclusion} (rules ${status.verdict.rulesVersion})`);
  console.log(`   BEFORE vs AFTER on this dataset: IDENTICAL — ${paperRows.length} paper rows exist; Phase 10.3-A changes which FUTURE rows are created, never re-counts existing ones.`);
  console.log('');
  console.log('── Integrity ─────────────────────────────────────────────────────');
  const nullFpPaper = paperRows.filter((r) => r.setupFingerprint === null).length;
  console.log(`   PaperSignalOutcome rows with NULL fingerprint (legacy, untouched): ${nullFpPaper}`);
  const dupFps = new Set<string>();
  for (const r of paperRows) if (r.setupFingerprint) if (dupFps.has(r.setupFingerprint)) throw new Error('DUPLICATE FINGERPRINT FOUND'); else dupFps.add(r.setupFingerprint);
  console.log(`   duplicate setupFingerprints among paper rows: 0 (verified)`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error('comparison failed:', e);
  process.exit(1);
});
