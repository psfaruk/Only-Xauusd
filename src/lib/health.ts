/**
 * XAUUSD AI Trading Agent — Health Service (Phase 1, extended in Phase 3)
 * ----------------------------------------------------------------------------
 * Collects live runtime health: process uptime, memory, DB connectivity,
 * execution lock state, latest GLM verification status, and (Phase 3) the
 * market-data pipeline state. Used by the /api/health endpoint AND by the
 * `get_system_health` allowlisted GLM tool.
 *
 * Phase 3 note: the market section is derived from LOCAL database state only
 * (last sync run, tick age) — it never probes the bridge, so health stays
 * fast and cannot be slowed or blocked by an external service.
 */

import os from 'node:os';
import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { latestGlmStatus } from '@/lib/logger';

export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  phase: number;
  phaseLabel: string;
  tradingMode: string;
  executionLocked: boolean;
  executionReason: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: {
    database: 'ok' | 'fail';
    glm: 'verified' | 'failed' | 'unverified';
    executionLock: 'engaged' | 'DANGER';
  };
  runtime: {
    node: string;
    platform: string;
    cpuCores: number;
    memoryTotalMb: number;
    memoryFreeMb: number;
    processRssMb: number;
  };
  glm: { status: string; lastCheckedAt: string | null };
  market: {
    bridgeConfigured: boolean;
    lastSync: { status: string; at: string; errorCode: string | null } | null;
    dataQualityState: string;
    dataReady: boolean;
    symbol: string;
    note: string;
  };
  auditEventCount: number;
}

export async function collectHealth(): Promise<HealthReport> {
  let database: 'ok' | 'fail' = 'ok';
  let eventCount = 0;
  try {
    eventCount = await db.systemEvent.count();
  } catch {
    database = 'fail';
  }

  const glm = await latestGlmStatus();
  const executionLocked = !config.execution.enabled;
  const executionLock: 'engaged' | 'DANGER' = executionLocked ? 'engaged' : 'DANGER';

  // Phase 3: local-only market pipeline state (no bridge probe here).
  const marketSymbol = config.market.symbols[0] ?? 'XAUUSDm';
  let market: HealthReport['market'] = {
    bridgeConfigured: config.bridge.url !== '',
    lastSync: null,
    dataQualityState: 'UNAVAILABLE',
    dataReady: false,
    symbol: marketSymbol,
    note: 'No sync run recorded yet — data pipeline idle (fail closed).',
  };
  try {
    const { computeReadiness } = await import('@/lib/market/quality');
    const readiness = await computeReadiness({ symbol: marketSymbol });
    const lastRun = await db.syncRun.findFirst({
      where: { symbol: marketSymbol },
      orderBy: { startedAtUtc: 'desc' },
    });
    market = {
      bridgeConfigured: config.bridge.url !== '',
      lastSync: lastRun
        ? { status: lastRun.status, at: lastRun.startedAtUtc.toISOString(), errorCode: lastRun.errorCode }
        : null,
      dataQualityState: readiness.qualityState,
      dataReady: readiness.ready,
      symbol: marketSymbol,
      note: 'Derived from local DB state only (no bridge probe in /api/health).',
    };
  } catch {
    // market stays UNAVAILABLE — fail closed
  }

  const degraded = database === 'fail' || glm.status === 'failed' || !executionLocked;

  return {
    status: degraded ? 'degraded' : 'ok',
    version: config.version,
    phase: config.phase,
    phaseLabel: config.phaseLabel,
    tradingMode: config.tradingMode,
    executionLocked,
    executionReason: config.execution.reason,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: { database, glm: glm.status, executionLock },
    runtime: {
      node: process.version,
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      cpuCores: os.cpus().length,
      memoryTotalMb: Math.round(os.totalmem() / 1024 / 1024),
      memoryFreeMb: Math.round(os.freemem() / 1024 / 1024),
      processRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    glm: { status: glm.status, lastCheckedAt: glm.at },
    market,
    auditEventCount: eventCount,
  };
}
