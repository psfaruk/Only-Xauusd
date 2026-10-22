/**
 * GET /api/signal/latest — latest persisted signal evaluation + the latest
 * backtest OF THE SIGNAL ENGINE (comparison surface, Phase 9 Task F).
 *
 * READ-ONLY. Honest absence: when no evaluation exists yet, `signal` is null
 * (never a fabricated result). The comparison block reports the latest
 * BacktestRun produced by the CURRENT strategy version only — a proxy-ruleset
 * run is never presented as a signal-engine validation.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guardDataApi, parseQuery } from '@/lib/api-guard';
import { getLatestSignalEvaluation } from '@/lib/signal/persistence';
import { SIGNAL_STRATEGY_VERSION } from '@/lib/signal/types';
import { deriveConditionReport } from '@/lib/signal/conditions';
import { CANDIDATE_STRATEGY_VERSION } from '@/lib/signal/candidate/types';
import { getLatestCandidateEvaluation } from '@/lib/signal/candidate-persistence';
import { getCandidatePaperStats } from '@/lib/signal/candidate-paper';
import { getLatestScalperEvaluation } from '@/lib/signal/scalper/persistence';
import {
  LIFECYCLE_CONTRACT_VERSION,
  confidenceLabel,
  deriveLifecycleStatus,
  signalDedupeKey,
} from '@/lib/signal/lifecycle';
import { config } from '@/lib/config';
import { signalLatestQuerySchema } from '@/lib/signal/schemas';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const guard = guardDataApi(req, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const parsed = parseQuery(signalLatestQuerySchema, {
    symbol: url.searchParams.get('symbol') ?? undefined,
  });
  if (!parsed.ok) return parsed.response;
  const symbol = parsed.data.symbol ?? config.market.symbols[0] ?? 'XAUUSDm';

  try {
    // Baseline fields stay byte-compatible: `signal` is the latest BASELINE
    // evaluation (explicit baseline scope — Phase 11-E isolation), the
    // candidate gets its own separately-labeled additive field below.
    const [signal, candidateEval] = await Promise.all([
      getLatestSignalEvaluation(db, symbol, SIGNAL_STRATEGY_VERSION),
      getLatestCandidateEvaluation(db, symbol),
    ]);

    // Latest backtest run OF THE SIGNAL ENGINE (strategy-version match only).
    const backtestRow = await db.backtestRun
      .findFirst({
        where: { symbol, strategyVersion: SIGNAL_STRATEGY_VERSION },
        orderBy: { createdAt: 'desc' },
      })
      .catch(() => null);
    const backtestComparison = backtestRow
      ? {
          runId: backtestRow.id,
          createdAt: backtestRow.createdAt.toISOString(),
          strategyVersion: backtestRow.strategyVersion,
          timeframe: backtestRow.timeframe,
          status: backtestRow.status,
          datasetFingerprint: backtestRow.datasetFingerprint,
          datasetFromUtc: backtestRow.datasetFromUtc.toISOString(),
          datasetToUtc: backtestRow.datasetToUtc.toISOString(),
          candleCount: backtestRow.candleCount,
          dev: JSON.parse(backtestRow.devMetrics) as Record<string, unknown>,
          oos: JSON.parse(backtestRow.oosMetrics) as Record<string, unknown>,
          limitations: JSON.parse(backtestRow.limitations) as string[],
        }
      : null;

    // Phase 11-E (additive): the candidate dual-evaluation card — present
    // only when a candidate evaluation exists; null otherwise (honest
    // absence, never fabricated). paperStats carries the counts by
    // status/outcome from PaperCandidateOutcome + the pre-registered protocol
    // verdict state (INCOMPLETE until ≥ 20 completed outcomes).
    const candidate = candidateEval
      ? {
          evaluation: candidateEval,
          levels: candidateEval.levels,
          model: candidateEval.model,
          paperStats: await getCandidatePaperStats(db, symbol),
        }
      : null;

    // Deep-remediation Phase 3 (additive): typed lifecycle contract for the
    // latest evaluation(s) — derived status (CANDIDATE | CONFIRMED | EXPIRED |
    // …), expiry, canonical dedupe key and the confidence TYPE (evidence
    // score, never a probability). Computed read-time from the persisted rows
    // via the pure lifecycle module; null when no evaluation exists (honest
    // absence). The scalper surface gets its own separately-labeled block
    // (same contract) — the scalper ROUTE itself is untouched.
    const nowMs = () => Date.now();
    const lifecycle = signal
      ? {
          contractVersion: LIFECYCLE_CONTRACT_VERSION,
          status: deriveLifecycleStatus({
            outcome: signal.outcome,
            decisionCandleTimeUtc: signal.decisionCandleTimeUtc,
            setupKnownAtUtc: signal.setupKnownAtUtc,
            expiryUtc: signal.expiryUtc,
            now: nowMs,
          }),
          expiresAtUtc: signal.expiryUtc,
          dedupeKey: signalDedupeKey({
            symbol: signal.symbol,
            strategyVersion: signal.strategyVersion,
            setupFingerprint: signal.setupFingerprint,
            decisionCandleTimeUtc: signal.decisionCandleTimeUtc,
          }),
          confidenceType: confidenceLabel(signal.evidence?.smc?.tier ?? null),
        }
      : null;

    const latestScalper = await getLatestScalperEvaluation(db, symbol);
    const scalperLifecycle = latestScalper
      ? {
          contractVersion: LIFECYCLE_CONTRACT_VERSION,
          status: deriveLifecycleStatus({
            outcome: latestScalper.outcome,
            decisionCandleTimeUtc: latestScalper.decisionCandleTimeUtc,
            setupKnownAtUtc: latestScalper.setupKnownAtUtc,
            expiryUtc: latestScalper.expiryUtc,
            now: nowMs,
          }),
          expiresAtUtc: latestScalper.expiryUtc,
          dedupeKey: signalDedupeKey({
            symbol: latestScalper.symbol,
            strategyVersion: latestScalper.strategyVersion,
            setupFingerprint: latestScalper.setupFingerprint,
            decisionCandleTimeUtc: latestScalper.decisionCandleTimeUtc,
          }),
          confidenceType: confidenceLabel(latestScalper.evidence?.smc?.tier ?? null),
        }
      : null;

    return NextResponse.json({
      ok: true,
      symbol,
      signal,
      // Deep-remediation Phase 3: signal lifecycle contract (additive).
      lifecycle,
      scalperLifecycle,
      backtestComparison,
      // Phase 11 (section I): read-time derived condition checklist — WHY the
      // latest evaluation did (or did not) produce a signal, per condition,
      // with the strategy-logic vs data-quality split. Derived from the
      // persisted evaluation only (the engine core is untouched).
      conditions: deriveConditionReport(signal ?? null),
      candidate,
      strategyVersions: {
        activeLive: SIGNAL_STRATEGY_VERSION,
        researchCandidate: CANDIDATE_STRATEGY_VERSION,
        candidateStatus:
          'active-forward-observation (Phase 11-E activation 2026-10-20: dual evaluation live, research-only — separate table/identity namespace; four execution locks stay LOCKED; protocol audit/phase11-candidate-forward-protocol.md)',
      },
      notes: [
        'Signals are research/decision support only — nothing is ever executed.',
        'The comparison block is the latest backtest run of the CURRENT signal-engine strategy version only.',
        'The candidate field is research-only forward observation under phase11-candidate-forward/1 — no execution, ever.',
      ],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL_ERROR', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
