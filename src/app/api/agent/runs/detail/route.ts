/**
 * GET /api/agent/runs/detail?id=… — single persisted agent run (Task 42-S4).
 * ----------------------------------------------------------------------------
 * Implemented as a static segment with a query param (no dynamic route
 * segment) per the shared Phase 7 architecture contract.
 *
 * Guard: READ. Steps expose REDACTED digests only. An unknown id is an honest
 * 404 — never a fabricated run.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardDataApi, jsonError, parseQuery } from '@/lib/api-guard';
import { ErrorCode } from '@/lib/market/types';
import { getAgentRunDto } from '@/lib/agent-runtime/serialize';

export const dynamic = 'force-dynamic';

const detailQuerySchema = z
  .object({
    id: z.string().trim().min(1).max(64),
  })
  .strict();

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const parsed = parseQuery(detailQuerySchema, { id: url.searchParams.get('id') ?? undefined });
  if (!parsed.ok) return parsed.response;

  try {
    const run = await getAgentRunDto(parsed.data.id);
    if (!run) {
      return jsonError(404, ErrorCode.NOT_FOUND, `No agent run with id '${parsed.data.id}'.`);
    }
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL_ERROR', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
