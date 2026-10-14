/**
 * XAUUSD AI Trading Agent — Health Service (Phase 1)
 * ----------------------------------------------------------------------------
 * Collects live runtime health: process uptime, memory, DB connectivity,
 * execution lock state and latest GLM verification status. Used by the
 * /api/health endpoint AND by the `get_system_health` allowlisted GLM tool.
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
    auditEventCount: eventCount,
  };
}
