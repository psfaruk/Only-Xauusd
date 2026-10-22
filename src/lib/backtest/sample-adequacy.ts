/**
 * XAUUSD AI Trading Agent — Sample Adequacy Labels (Phase 5, Task 42-S3)
 * ----------------------------------------------------------------------------
 * PURE. Statistical honesty for backtest REPORTS: a trade count alone must
 * never be presented as evidence. Every summary that carries performance
 * numbers also carries an adequacy label + an explicit uncertainty note
 * (Bengali — the operator's language).
 *
 * Semantics (locked):
 *   · tradeCount < 30            → INSUFFICIENT_EVIDENCE (no statistical claim
 *                                  of any kind may be attached)
 *   · 30 ≤ tradeCount < 100      → PRELIMINARY (directional at best; never
 *                                  "validated" language)
 *   · tradeCount ≥ 100           → ADEQUATE (reportable; still a simulation,
 *                                  never live proof)
 *
 * These floors are deliberately HARSHER than the per-segment minTrades=5 that
 * keeps empty metrics honest inside the engines (engine.ts / signal-engine.ts)
 * — the engine floor only refuses to invent numbers; this label refuses to
 * lend them meaning.
 */

export type SampleAdequacy = 'INSUFFICIENT_EVIDENCE' | 'PRELIMINARY' | 'ADEQUATE';

export const SAMPLE_ADEQUACY_THRESHOLDS = {
  insufficientBelow: 30,
  adequateAt: 100,
} as const;

/** Bengali one-liners rendered next to every surfaced backtest result. */
export const SAMPLE_ADEQUACY_NOTES: Record<SampleAdequacy, string> = {
  INSUFFICIENT_EVIDENCE: 'নমুনা ছোট (< ৩০ ট্রেড) — ফলাফল পরিসংখ্যানগতভাবে প্রমাণ নয়',
  PRELIMINARY: 'নমুনা মাঝারি (৩০–৯৯ ট্রেড) — ফলাফল প্রাথমিক, চূড়ান্ত নয়',
  ADEQUATE: 'নমুনা ≥ ১০০ ট্রেড — তবুও ব্যাকটেস্ট কখনোই লাইভ প্রমাণ নয়',
};

export function sampleAdequacyFromTradeCount(tradeCount: number): SampleAdequacy {
  if (!Number.isFinite(tradeCount) || tradeCount < 0) return 'INSUFFICIENT_EVIDENCE';
  if (tradeCount < SAMPLE_ADEQUACY_THRESHOLDS.insufficientBelow) return 'INSUFFICIENT_EVIDENCE';
  if (tradeCount < SAMPLE_ADEQUACY_THRESHOLDS.adequateAt) return 'PRELIMINARY';
  return 'ADEQUATE';
}

export interface DataRangeUtc {
  fromUtc: string;
  toUtc: string;
}

export interface SampleAdequacyReport {
  sampleAdequacy: SampleAdequacy;
  tradeCount: number;
  uncertaintyNote: string;
  dataRangeUtc: DataRangeUtc | null;
}

export function buildSampleAdequacyReport(
  tradeCount: number,
  dataRangeUtc: DataRangeUtc | null,
): SampleAdequacyReport {
  const sampleAdequacy = sampleAdequacyFromTradeCount(tradeCount);
  return {
    sampleAdequacy,
    tradeCount,
    uncertaintyNote: SAMPLE_ADEQUACY_NOTES[sampleAdequacy],
    dataRangeUtc,
  };
}
