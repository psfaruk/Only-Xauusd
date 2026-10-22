/**
 * /api/agent/runs — Phase 7 real agent runtime surface (Task 42-S4).
 * ----------------------------------------------------------------------------
 *   GET  — list the latest agent runs with their steps (digests only).
 *          Guard: READ (token when configured; public only under the explicit
 *          MARKET_API_PUBLIC_READS preview opt-in).
 *   POST — create + execute one bounded agent run (awaited, ≤ ~70s wall).
 *          Guard: TRIGGER (bearer token ALWAYS when configured; without a
 *          token only under MARKET_API_PUBLIC_TRIGGERS=true AND same-origin
 *          evidence — the app's own browser UI qualifies, bare curl does not).
 *
 * The runtime is READ-ONLY: only the 9 allowlisted observation tools exist;
 * no order/execution tool can be invoked (see src/lib/agent-runtime/tools.ts).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardDataApi, jsonError, parseQuery } from '@/lib/api-guard';
import { ErrorCode } from '@/lib/market/types';
import { runAgentTask, MIN_TASK_CHARS, MAX_TASK_CHARS } from '@/lib/agent-runtime/orchestrator';
import { listAgentRunDtos } from '@/lib/agent-runtime/serialize';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

const createBodySchema = z
  .object({
    task: z.string().trim().min(MIN_TASK_CHARS).max(MAX_TASK_CHARS),
  })
  .strict();

/** In-process concurrency cap (Phase 7 §6): never more than 2 runs at once. */
const MAX_CONCURRENT_RUNS = 2;
let activeRuns = 0;

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const parsed = parseQuery(listQuerySchema, { limit: url.searchParams.get('limit') ?? undefined });
  if (!parsed.ok) return parsed.response;

  try {
    const runs = await listAgentRunDtos(parsed.data.limit);
    return NextResponse.json({
      ok: true,
      count: runs.length,
      runs,
      note: 'Agent runs — read-only tool observations only; step rows carry REDACTED digests (argument keys + first 400 chars).',
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL_ERROR', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const guard = guardDataApi(req, 'trigger');
  if (!guard.ok) return guard.response;

  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    return jsonError(
      429,
      ErrorCode.RATE_LIMITED,
      `Agent runtime busy — at most ${MAX_CONCURRENT_RUNS} runs may execute concurrently. Retry shortly.`,
      { retryAfterSec: 5 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, ErrorCode.BAD_REQUEST, 'Request body must be valid JSON.');
  }
  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      400,
      ErrorCode.BAD_REQUEST,
      `Invalid request body: task must be a string of ${MIN_TASK_CHARS}..${MAX_TASK_CHARS} characters (no other fields).`,
    );
  }

  activeRuns += 1;
  try {
    // Bounded execution: hard budgets live INSIDE the orchestrator
    // (steps/tool-calls/wall-clock) — the request can never hang forever.
    const run = await runAgentTask({ task: parsed.data.task, llmSummary: true });
    return NextResponse.json({
      ok: true,
      run,
      note: 'রান deterministic টুল পর্যবেক্ষণ থেকে ফলাফল তৈরি করে — GLM সারসংক্ষেপ (summaryBn) শুধু পরামর্শমূলক।',
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: 'AGENT_RUN_ERROR',
        detail: (e instanceof Error ? e.message : 'unknown error').slice(0, 200),
      },
      { status: 500 },
    );
  } finally {
    activeRuns -= 1;
  }
}
