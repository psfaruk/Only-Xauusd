/**
 * POST /api/execution/close — manually close an open position by id (Phase 11).
 *
 * Body: { positionId: string }
 * Guard: trigger bucket; the 4-switch lock is enforced inside the service.
 *
 * Closing REDUCES exposure and is deliberately approval-free (the risk gate
 * only clamps OPENING orders). Single attempt — a timeout is reported
 * honestly and never auto-retried.
 */

import { NextResponse } from 'next/server';
import { guardDataApi, jsonError } from '@/lib/api-guard';
import { closePositionByApp } from '@/lib/execution/service';
import { z } from 'zod';

const BodySchema = z.object({ positionId: z.string().min(1).max(64) }).strict();

export async function POST(request: Request) {
  const guard = guardDataApi(request, 'trigger');
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'BAD_REQUEST', 'Request body must be valid JSON.');
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      400,
      'BAD_REQUEST',
      `Invalid request body: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const outcome = await closePositionByApp(parsed.data.positionId);

  return NextResponse.json(
    {
      ok: outcome.ok,
      code: outcome.code,
      message: outcome.message,
      executionLogId: outcome.executionLogId,
      generatedAtUtc: new Date().toISOString(),
    },
    { status: outcome.ok ? 200 : outcome.code === 'EXECUTION_LOCKED' ? 423 : 409 },
  );
}
