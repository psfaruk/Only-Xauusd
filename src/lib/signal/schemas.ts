/**
 * XAUUSD AI Trading Agent — Signal API Schemas (Phase 9, Task F)
 * ----------------------------------------------------------------------------
 * Zod validation for the signal API surface. Strict allowlists only — a
 * client can never choose an arbitrary symbol or inject anything executable.
 */

import { z } from 'zod';
import { config } from '@/lib/config';

export const signalSymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .refine((s) => config.market.symbols.includes(s), {
    message: `symbol must be one of the configured allowlist: ${config.market.symbols.join(', ')}`,
  });

export const signalRunBodySchema = z
  .object({
    symbol: signalSymbolSchema.optional(),
  })
  .strict();

export const signalLatestQuerySchema = z
  .object({
    symbol: signalSymbolSchema.optional(),
  })
  .strict();

export const signalHistoryQuerySchema = z
  .object({
    symbol: signalSymbolSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /**
     * Phase 11-E (additive): which strategy's evaluations to list.
     * 'baseline' (default) → hybrid-structure-retest/9.0.0 — the default
     * surface stays baseline-scoped (protocol §4). 'candidate' →
     * hybrid-multimodel-research/11.0.0-candidate.1, returned labeled.
     */
    strategy: z.enum(['baseline', 'candidate']).default('baseline'),
  })
  .strict();
