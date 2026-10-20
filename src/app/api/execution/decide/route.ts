/**
 * POST /api/execution/decide — the HUMAN gate of the Phase 11 approval-based
 * execution: approve or reject a pending TradeApproval.
 *
 * Body: { approvalId: string, decision: 'approve' | 'reject', note?: string }
 * Guard: trigger bucket.
 *
 * On approve: the service re-verifies the risk gate with live data, then sends
 * EXACTLY ONE bridge order (lots from the risk check, SL/TP from the signal
 * levels) and persists an append-only ExecutionLog row. A network timeout is
 * reported honestly and NEVER auto-retried (exactly-once discipline).
 *
 * The 4-switch execution lock (TRADING_PHASE ≥ 11 + EXECUTION_ARMED +
 * ALLOW_EXECUTION + mode ≠ read_only) is enforced inside the service —
 * every path fails closed when locked.
 */

import { NextResponse } from 'next/server';
import { guardDataApi, jsonError } from '@/lib/api-guard';
import { decideApproval } from '@/lib/execution/service';
import { z } from 'zod';

const BodySchema = z
  .object({
    approvalId: z.string().min(1).max(64),
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(200).optional(),
  })
  .strict();

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

  const outcome = await decideApproval(parsed.data.approvalId, parsed.data.decision, parsed.data.note);

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
