/**
 * GET /api/execution/state — Phase 11 execution surface for the UI:
 * the 4-switch lock state, bridge account + order-layer posture, the
 * approval queue (pending + recent), live open positions and the
 * append-only execution log. Read bucket guard.
 *
 * READ-ONLY by itself: decisions go through POST /api/execution/decide.
 */

import { NextResponse } from 'next/server';
import { guardDataApi } from '@/lib/api-guard';
import { getExecutionState } from '@/lib/execution/service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  const state = await getExecutionState();
  return NextResponse.json({ ok: true, state });
}
