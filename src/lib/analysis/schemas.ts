/**
 * XAUUSD AI Trading Agent — Analysis API Schemas (Phase 4)
 * ----------------------------------------------------------------------------
 * Typed request schemas (zod) for /api/analysis/*. Strict allowlists; bounded
 * arrays. Candle history is bounded SERVER-side (config.analysis.maxBarsPerTf)
 * — clients cannot request unbounded processing.
 */

import { z } from 'zod';
import { AllowedSymbol, AllowedTimeframe } from '@/lib/market/schemas';

export const AnalysisRunSchema = z
  .object({
    symbol: AllowedSymbol.optional(), // defaults to the first allowlisted symbol
    timeframes: z
      .array(AllowedTimeframe)
      .min(1, 'at least one timeframe is required')
      .max(4, 'at most 4 timeframes')
      .transform((tfs) => [...new Set(tfs)]) // dedup, order preserved
      .optional(),
  })
  .strict();

export type AnalysisRunBody = z.infer<typeof AnalysisRunSchema>;

export const AnalysisLatestQuerySchema = z
  .object({
    symbol: AllowedSymbol.optional(),
  })
  .strict();

export type AnalysisLatestQuery = z.infer<typeof AnalysisLatestQuerySchema>;
