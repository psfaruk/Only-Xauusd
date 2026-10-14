/**
 * XAUUSD AI Trading Agent — Analysis Readiness Gate (Phase 4)
 * ----------------------------------------------------------------------------
 * PURE per-timeframe gate. Reuses the Phase 3 quality semantics (freshness,
 * session-aware gaps, demo policy) instead of duplicating conflicting rules.
 * Anything missing / stale / invalid / demo-labelled / under warm-up →
 * BLOCKED with machine-readable codes. No data → no analysis, ever.
 *
 * The loader (persistence.ts) supplies per-timeframe facts; this module only
 * decides. Non-blocking findings (closure-window gaps, Phase 3 warnings) stay
 * visible in `warnings` — a warning never silently becomes READY-with-issues.
 */

import type { QualityState, Timeframe, TimeframeReadiness as Phase3TfReadiness } from '@/lib/market/types';
import type { TfLoadedData, TimeframeReadinessEntry } from './types';

export interface ReadinessAssessmentInput {
  timeframe: Timeframe;
  phase3: Phase3TfReadiness; // freshness + gap scan from Phase 3 (computeReadiness)
  loaded: TfLoadedData; // row-level facts from the analysis loader
  requiredMinBars: number; // configured warm-up floor (covers EMA200 + ADX + swings)
}

function mapPhase3State(state: QualityState): string[] {
  switch (state) {
    case 'STALE':
      return ['DATA_STALE'];
    case 'MISSING':
      return ['DATA_MISSING'];
    case 'INVALID':
      return ['DATA_INVALID'];
    case 'UNAVAILABLE':
      return ['DATA_NOT_READY'];
    default:
      return []; // VALID | WARNING pass the Phase 3 freshness layer
  }
}

export function assessTimeframe(inp: ReadinessAssessmentInput): TimeframeReadinessEntry {
  const errorCodes: string[] = [];
  const warnings: string[] = [];

  // Phase 3 freshness layer (VALID/WARNING pass; warnings stay visible).
  for (const code of mapPhase3State(inp.phase3.state)) errorCodes.push(code);
  for (const code of inp.phase3.errorCodes) {
    // Phase 3 tf codes (e.g. GAP_POSSIBLE, DATA_STALE) — informational at this
    // layer; blocking is decided by the in-window scan below + state mapping.
    if (!warnings.includes(code)) warnings.push(code);
  }

  // Row-level demo policy — demo data is NEVER analysis-ready.
  if (inp.loaded.demoRows) {
    errorCodes.push('DEMO_DATA_BLOCKED', 'SOURCE_DEMO');
  }

  // Defensive: INVALID rows found in the window (ingestion never persists
  // them, but if any pre-existing row is INVALID it must block, not corrupt).
  if (inp.loaded.invalidExcluded > 0) {
    errorCodes.push('DATA_INVALID');
  }

  // Warm-up floor — covers EMA200 seed, ADX 2×period, swing windows.
  if (inp.loaded.candles.length < inp.requiredMinBars) {
    errorCodes.push('INSUFFICIENT_DATA');
  }

  // In-window continuity: suspicious gaps make the analysis unsafe.
  if (inp.loaded.windowGapsSuspicious > 0) {
    errorCodes.push('GAP_IN_ANALYSIS_WINDOW', 'DATA_INVALID');
  } else if (inp.loaded.windowClosureGaps > 0) {
    warnings.push('CLOSURE_GAPS_IN_WINDOW'); // closure windows are info, never silent
  }

  const dedupErrors = [...new Set(errorCodes)];
  const dedupWarnings = [...new Set(warnings)].filter((w) => !dedupErrors.includes(w));

  return {
    timeframe: inp.timeframe,
    state: dedupErrors.length === 0 ? 'READY' : 'BLOCKED',
    phase3State: inp.phase3.state,
    closedCandles: inp.loaded.candles.length,
    requiredMinBars: inp.requiredMinBars,
    errorCodes: dedupErrors,
    warnings: dedupWarnings,
  };
}

/** Tick gate — the latest tick must be fresh too (spec Phase 4 §3). */
export function assessTick(
  tick: { state: QualityState; errorCodes: string[] },
): { ok: boolean; errorCodes: string[]; warnings: string[] } {
  const errorCodes: string[] = [];
  const warnings: string[] = [];
  if (tick.state === 'STALE') errorCodes.push('DATA_STALE', 'TICK_STALE');
  else if (tick.state === 'MISSING') errorCodes.push('DATA_MISSING');
  else if (tick.state === 'INVALID') errorCodes.push('DATA_INVALID', 'TICK_INVALID');
  else if (tick.state === 'UNAVAILABLE') errorCodes.push('DATA_NOT_READY');
  else if (tick.state === 'WARNING') warnings.push('TICK_ZERO_SPREAD');
  return { ok: errorCodes.length === 0, errorCodes, warnings };
}
