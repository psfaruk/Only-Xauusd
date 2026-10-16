/**
 * GET /api/audit/environment — Environment Audit v2 (Phase 9, Task A3).
 * ----------------------------------------------------------------------------
 * Combines (per spec A3):
 *   1. static architecture requirements (metadata below),
 *   2. fresh bounded runtime checks (executed on every request — v2 `checks`),
 *   3. latest persisted audit-run evidence (GLM verification, sync runs),
 *   4. broker & data-health state (through the runtime checks themselves),
 *   5. explicit stale-evidence / unavailable states (NOT_TESTED never = PASS).
 *
 * SAFETY: the runtime checks are a FIXED, allowlisted collection implemented
 * in application code (src/lib/audit/runtime-checks.ts). No shell execution,
 * no client-supplied commands, no arbitrary URLs — the query string only
 * carries an optional symbol from the configured allowlist.
 *
 * Refreshing re-runs the CURRENT checks; the Phase 1 historical entries keep
 * their original timestamps and are never presented as re-executed.
 */

import { NextResponse } from 'next/server';
import { buildEnvironmentAuditReport } from '@/lib/audit/report';
import { config } from '@/lib/config';
import {
  glmAccess,
  mt5Feasibility,
  databaseModels,
  securityMeasures,
  architectureLayers,
  repositoryTree,
  acceptanceChecklist,
} from '@/lib/audit/static-audit';
import { TOOL_REGISTRY } from '@/lib/tools/registry';
import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { StatusQuerySchema } from '@/lib/market/schemas';
import { recentEvents } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // Read-guarded like every data surface (token when set; preview opt-in).
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  try {
    // Master-audit fix A5: the symbol used to fall back to the allowlist
    // silently when invalid. Now it follows the shared allowlist contract
    // (400 with the zod message) instead of quietly auditing a different
    // symbol than the caller asked for.
    const query = parseQuery(StatusQuerySchema, {
      symbol: new URL(req.url).searchParams.get('symbol') ?? undefined,
    });
    if (!query.ok) return query.response;
    const report = await buildEnvironmentAuditReport(query.data.symbol ?? undefined);
    const events = await recentEvents(config.limits.maxEventsReturned);

    return NextResponse.json({
      ...report,
      live: {
        node: process.version,
        bun: typeof Bun !== 'undefined' ? Bun.version : null,
        platform: `${report.app.version}`,
        arch: null,
        cpuCores: null,
        memoryTotalMb: null,
        memoryFreeMb: null,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: report.generatedAtUtc,
      },
      glm: {
        ...glmAccess,
        liveStatus: report.persistedFacts.lastGlmVerification,
      },
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
      { ok: false, error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 },
    );
  }
}
