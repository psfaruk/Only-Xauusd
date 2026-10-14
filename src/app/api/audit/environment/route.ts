/**
 * GET /api/audit/environment — full Phase 1 audit report.
 * Merges the static evidence collected during the audit with LIVE runtime
 * measurements and the most recent SystemEvent rows.
 */
import { NextResponse } from 'next/server';
import os from 'node:os';
import { collectHealth } from '@/lib/health';
import { recentEvents } from '@/lib/logger';
import { config } from '@/lib/config';
import {
  AUDIT_PERFORMED_AT,
  environmentChecks,
  glmAccess,
  mt5Feasibility,
  databaseModels,
  securityMeasures,
  architectureLayers,
  repositoryTree,
  acceptanceChecklist,
} from '@/lib/audit/static-audit';
import { TOOL_REGISTRY } from '@/lib/tools/registry';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const health = await collectHealth();
    const events = await recentEvents(config.limits.maxEventsReturned);

    const live = {
      node: process.version,
      bun: typeof Bun !== 'undefined' ? Bun.version : null,
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpuCores: os.cpus().length,
      memoryTotalMb: Math.round(os.totalmem() / 1024 / 1024),
      memoryFreeMb: Math.round(os.freemem() / 1024 / 1024),
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json({
      auditPerformedAt: AUDIT_PERFORMED_AT,
      generatedAt: live.timestamp,
      config: {
        version: config.version,
        phase: config.phase,
        tradingMode: config.tradingMode,
        executionEnabled: config.execution.enabled,
        executionReason: config.execution.reason,
        symbol: config.symbol,
      },
      live,
      health,
      environmentChecks,
      glm: { ...glmAccess, liveStatus: health.glm },
      mt5: mt5Feasibility,
      database: {
        provider: 'SQLite (Prisma)',
        urlConfigured: true,
        models: databaseModels,
      },
      tools: {
        total: TOOL_REGISTRY.length,
        active: TOOL_REGISTRY.filter((t) => t.status === 'active').map((t) => t.name),
        planned: TOOL_REGISTRY.filter((t) => t.status === 'planned').map((t) => ({
          name: t.name,
          phase: t.activatesInPhase,
        })),
      },
      security: securityMeasures,
      architecture: architectureLayers,
      repositoryTree,
      acceptanceChecklist,
      events: events.map((e) => ({
        id: e.id,
        level: e.level,
        category: e.category,
        code: e.code,
        message: e.message,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 },
    );
  }
}
