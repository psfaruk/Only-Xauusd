/**
 * Phase 10.2 — Forward Paper Snapshot Export (durability across sandbox rebuilds).
 * ----------------------------------------------------------------------------
 * The sandbox has wiped .env / the SQLite DB on rebuild three times. This
 * script exports ALL raw PaperSignalOutcome rows plus the derived
 * pre-registered-protocol status to audit/phase10.2-paper-snapshot.json
 * (tracked in git), so forward evidence survives rebuilds and can be honestly
 * rehydrated later. It never fabricates or back-fills anything, and it can
 * never place a broker order (no such code exists anywhere).
 *
 * Usage: bun run paper:snapshot   (run + commit after each resolution batch /
 * at least weekly — see audit/phase10.2-forward-paper-protocol.md §8)
 */

import { writeFileSync } from 'node:fs';
import { db } from '../src/lib/db';
import { getForwardPaperStatus } from '../src/lib/signal/forward';

const main = async (): Promise<number> => {
  const symbol = process.env.TRADING_SYMBOLS?.split(',')[0]?.trim() || 'XAUUSDm';
  const status = await getForwardPaperStatus(db, symbol);

  const rows = await db.paperSignalOutcome.findMany({
    where: { symbol },
    orderBy: { createdAt: 'asc' },
  });

  const snapshot = {
    generatedAtUtc: new Date().toISOString(),
    purpose:
      'durability export — raw rows for honest rehydration after a sandbox rebuild; never fabrication',
    protocol: status.protocol,
    progress: status.progress,
    statusCounts: status.statusCounts,
    metrics: status.metrics,
    verdict: status.verdict,
    rawRowCount: rows.length,
    rawRows: rows.map((r) => ({
      id: r.id,
      signalEvaluationId: r.signalEvaluationId,
      symbol: r.symbol,
      direction: r.direction,
      signalCreatedAtUtc: r.signalCreatedAtUtc.toISOString(),
      decisionCandleTimeUtc: r.decisionCandleTimeUtc.toISOString(),
      setupKnownAtUtc: r.setupKnownAtUtc.toISOString(),
      expiryUtc: r.expiryUtc.toISOString(),
      datasetFingerprint: r.datasetFingerprint,
      inputFingerprint: r.inputFingerprint,
      sourceCandleRange: r.sourceCandleRange,
      entryReference: r.entryReference,
      stopLoss: r.stopLoss,
      target: r.target,
      invalidationLevel: r.invalidationLevel,
      status: r.status,
      outcome: r.outcome,
      resolvedAtUtc: r.resolvedAtUtc ? r.resolvedAtUtc.toISOString() : null,
      resolutionBarTimeUtc: r.resolutionBarTimeUtc ? r.resolutionBarTimeUtc.toISOString() : null,
      exitPrice: r.exitPrice,
      observations: r.observations,
      lastCheckedBarTimeUtc: r.lastCheckedBarTimeUtc ? r.lastCheckedBarTimeUtc.toISOString() : null,
      modeledCostsPrice: r.modeledCostsPrice,
      grossPnlPrice: r.grossPnlPrice,
      netPnlPrice: r.netPnlPrice,
      rMultiple: r.rMultiple,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  };

  writeFileSync('audit/phase10.2-paper-snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`);

  console.log(`Phase 10.2 paper snapshot — ${symbol}`);
  console.log(`  raw rows exported : ${rows.length}`);
  console.log(`  counted completed : ${status.progress.countedCompleted}/${status.protocol.minCompletedTrades}`);
  console.log(`  open / repeats    : ${status.progress.openCounted} / ${status.progress.repeatObservations}`);
  console.log(`  verdict           : ${status.verdict.conclusion} (${status.verdict.rulesVersion})`);
  console.log(`  written           : audit/phase10.2-paper-snapshot.json`);
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('snapshot failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => {
    void db.$disconnect();
  });
