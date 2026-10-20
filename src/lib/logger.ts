/**
 * XAUUSD AI Trading Agent — Audit Logger (Phase 1)
 * ----------------------------------------------------------------------------
 * Central audit trail. Every significant action writes a SystemEvent row and
 * a console line. `meta` is secret-masked before persistence. Logging is
 * fire-and-forget so a logging failure can never break a request.
 */

import { db } from '@/lib/db';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type AuditCategory =
  | 'app'
  | 'health'
  | 'glm'
  | 'audit'
  | 'market'
  | 'analysis'
  | 'signal'
  | 'candidate'
  | 'risk'
  | 'approval'
  | 'execution'
  | 'bridge';

export interface LogEventInput {
  level: LogLevel;
  category: AuditCategory;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

/** Redacts common secret shapes from any string before it is persisted. */
export function maskSecrets(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{6,})/g, 'sk-***')
    .replace(/(api[_-]?key|token|password|secret)(\s*[:=]\s*)(["']?)[^\s"']+/gi, '$1$2$3***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}

/** Console mirror with a stable prefix. */
function consoleLine(e: LogEventInput): void {
  const prefix = `[${e.level.toUpperCase()}][${e.category}][${e.code}]`;
  const line = `${prefix} ${e.message}`;
  if (e.level === 'error') console.error(line);
  else if (e.level === 'warn') console.warn(line);
  else console.log(line);
}

/** Fire-and-forget audit event. Never throws. */
export async function logEvent(input: LogEventInput): Promise<void> {
  try {
    consoleLine(input);
    const meta = input.meta ? maskSecrets(JSON.stringify(input.meta)) : null;
    await db.systemEvent.create({
      data: {
        level: input.level,
        category: input.category,
        code: input.code,
        message: maskSecrets(input.message).slice(0, 2000),
        meta,
      },
    });
  } catch (err) {
    // Logging must never break the caller.
    console.error(`[audit] failed to persist event ${input.code}:`, err instanceof Error ? err.message : err);
  }
}

/** Recent events for dashboards (newest first). */
export async function recentEvents(limit: number) {
  try {
    return await db.systemEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(1, limit), 500),
    });
  } catch {
    return [];
  }
}

/** Latest GLM verification status derived from the audit trail. */
export async function latestGlmStatus(): Promise<
  { status: 'verified' | 'failed'; at: string } | { status: 'unverified'; at: null }
> {
  try {
    const rows = await db.systemEvent.findMany({
      where: { code: { in: ['GLM_VERIFY_OK', 'GLM_VERIFY_FAIL'] } },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    if (rows.length === 0) return { status: 'unverified', at: null };
    return {
      status: rows[0].code === 'GLM_VERIFY_OK' ? 'verified' : 'failed',
      at: rows[0].createdAt.toISOString(),
    };
  } catch {
    return { status: 'unverified', at: null };
  }
}
