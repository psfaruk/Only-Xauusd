/**
 * XAUUSD AI Trading Agent — Environment Audit Report v2 (Phase 9, Task A3)
 * ----------------------------------------------------------------------------
 * Combines, in ONE honest report:
 *   1. the versioned CURRENT runtime checks (bridge/data/signal/security —
 *      executed fresh per request, bounded, no shell);
 *   2. the preserved Phase 1 HISTORICAL command evidence (own timestamps,
 *      never re-labeled);
 *   3. the latest persisted audit-run facts (GLM verification, last sync);
 *   4. the Phase 8 data-health state (quote integrity + candle audit summary);
 *   5. explicit stale-evidence / unavailable states (NOT_TESTED never counts
 *      as PASS).
 *
 * The response shape is versioned (`model: environment-audit/2.0`) so clients
 * can detect the contract explicitly.
 */

import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { computeTotals, type AuditCheckResult, type AuditTotals } from './model';
import { runCurrentChecks } from './runtime-checks';
import { phase1HistoricalChecks, PHASE1_AUDIT_PERFORMED_AT } from './historical';
import { readGitCommit } from './runtime-identity';

export interface EnvironmentAuditReportV2 {
  ok: true;
  model: 'environment-audit/2.0';
  generatedAtUtc: string;
  commit: string | null;
  app: { version: string; phase: number; phaseLabel: string; tradingMode: string };
  executionLock: {
    enabled: boolean;
    reason: string;
    switches: { phaseGate: boolean; executionArmed: boolean; allowExecution: boolean; readOnlyMode: boolean };
  };
  checks: AuditCheckResult[];
  totals: AuditTotals;
  sections: {
    currentRequired: AuditCheckResult[];
    notApplicable: AuditCheckResult[];
    historical: AuditCheckResult[];
  };
  persistedFacts: {
    lastGlmVerification: { code: string; at: string | null; message: string } | null;
    lastSyncRun: { status: string; at: string | null; source: string | null; inserted: number; updated: number } | null;
    analysisRuns: number;
    backtestRuns: number;
    signalEvaluations: number;
  };
  notes: string[];
}

export async function buildEnvironmentAuditReport(
  symbol?: string,
  deps?: import('./runtime-checks').CurrentCheckDeps,
): Promise<EnvironmentAuditReportV2> {
  const generatedAt = new Date();
  const commit = readGitCommit();

  // Fresh, bounded current checks (may include FAIL/BLOCKED — kept as-is).
  const current = await runCurrentChecks(symbol, deps);
  const historical = phase1HistoricalChecks();
  const checks = [...current, ...historical];
  const totals = computeTotals(checks);

  const [glmEvent, lastSync, analysisCount, backtestCount, signalCount] = await Promise.all([
    db.systemEvent
      .findFirst({ where: { category: 'glm', code: { in: ['GLM_VERIFY_OK', 'GLM_VERIFY_FAIL'] } }, orderBy: { createdAt: 'desc' } })
      .catch(() => null),
    db.syncRun.findFirst({ orderBy: { startedAtUtc: 'desc' } }).catch(() => null),
    db.analysisRun.count().catch(() => 0),
    db.backtestRun.count().catch(() => 0),
    db.signalEvaluation.count().catch(() => 0),
  ]);

  return {
    ok: true,
    model: 'environment-audit/2.0',
    generatedAtUtc: generatedAt.toISOString(),
    commit,
    app: {
      version: config.version,
      phase: config.phase,
      phaseLabel: config.phaseLabel,
      tradingMode: config.tradingMode,
    },
    executionLock: {
      enabled: config.execution.enabled,
      reason: config.execution.reason,
      switches: {
        phaseGate: config.execution.switches.phaseGatePassed,
        executionArmed: config.execution.switches.executionArmed,
        allowExecution: config.execution.switches.allowExecution,
        readOnlyMode: config.execution.switches.tradingMode === 'read_only',
      },
    },
    checks,
    totals,
    sections: {
      currentRequired: checks.filter((c) => c.scope === 'current-required'),
      notApplicable: checks.filter((c) => c.scope === 'not-applicable'),
      historical: checks.filter((c) => c.scope === 'historical'),
    },
    persistedFacts: {
      lastGlmVerification: glmEvent
        ? { code: glmEvent.code, at: glmEvent.createdAt.toISOString(), message: glmEvent.message.slice(0, 160) }
        : null,
      lastSyncRun: lastSync
        ? {
            status: lastSync.status,
            at: lastSync.startedAtUtc.toISOString(),
            source: lastSync.source,
            inserted: lastSync.inserted,
            updated: lastSync.updated,
          }
        : null,
      analysisRuns: analysisCount,
      backtestRuns: backtestCount,
      signalEvaluations: signalCount,
    },
    notes: [
      `Current checks were executed fresh at ${generatedAt.toISOString()} — refreshing re-runs them (bounded in-process probes; no shell, no client-supplied commands).`,
      `Historical entries are Phase 1 command evidence frozen at ${PHASE1_AUDIT_PERFORMED_AT}; their timestamps are original and a refresh never re-executes them.`,
      'NOT_APPLICABLE verdicts are backed by code inspection of the current TypeScript-bridge architecture — the original Phase 1 failures stay visible in the historical section.',
      'NOT_TESTED / missing evidence never counts as PASS anywhere in this report.',
    ],
  };
}
