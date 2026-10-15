/**
 * GET /api/validation/latest — latest Phase 10 validation run (READ-ONLY).
 * Returns the most recent ValidationRun for the symbol (three-way split,
 * walk-forward, sensitivity, perturbation set, pre-registered interpretation),
 * the paper-signal forward-tracking summary, and the Phase 10.2 pre-registered
 * forward paper validation status (protocol progress + verdict). Honest
 * emptiness: nulls when nothing exists. This endpoint can never execute a
 * trade (no such code exists anywhere).
 */

import { NextResponse } from 'next/server';
import { guardDataApi } from '@/lib/api-guard';
import { config } from '@/lib/config';
import { db } from '@/lib/db';
import { getLatestValidation } from '@/lib/backtest/validation-service';
import { getPaperSignalSummary } from '@/lib/signal/paper';
import { getForwardPaperStatus } from '@/lib/signal/forward';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  const symbol = new URL(req.url).searchParams.get('symbol') ?? config.market.symbols[0] ?? 'XAUUSDm';
  if (!config.market.symbols.includes(symbol)) {
    return NextResponse.json(
      { ok: false, error: 'SYMBOL_NOT_ALLOWED', detail: `symbol must be one of ${config.market.symbols.join(', ')}` },
      { status: 400 },
    );
  }

  const [latest, paper, forwardPaper] = await Promise.all([
    getLatestValidation(symbol),
    getPaperSignalSummary(db, symbol, 50),
    getForwardPaperStatus(db, symbol),
  ]);

  return NextResponse.json({
    ok: true,
    symbol,
    validation: latest,
    paper,
    forwardPaper,
    disclaimer: latest
      ? 'Validation is a simulation over verified broker candles — NEVER proof of live profitability.'
      : null,
  });
}
