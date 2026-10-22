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
     * Phase 12: 'scalper' → scalper-m1-m5-m15-or/12.0.0 (the live
     * short-timeframe OR-logic strategy).
     */
    strategy: z.enum(['baseline', 'candidate', 'scalper']).default('baseline'),
  })
  .strict();

/**
 * Task 45 (Phase 3+5) — the Fresh Signal Table query. Strict allowlists;
 * every parameter is optional with a safe default. Statuses reference the
 * freshness policy vocabulary (src/lib/signal/freshness.ts) — the client can
 * only FILTER by statuses the server itself derives, never inject one.
 */
export const freshSignalQuerySchema = z
  .object({
    symbol: signalSymbolSchema.optional(),
    /** live = actionable/unresolved only; archive = full history (default live). */
    scope: z.enum(['live', 'archive']).default('live'),
    /** Product engines by default — the candidate research strategy NEVER
     *  leaks into the default surface (Phase 11-E protocol §4). */
    strategy: z.enum(['product', 'baseline', 'scalper', 'candidate', 'all']).default('product'),
    direction: z.enum(['BUY', 'SELL']).optional(),
    timeframe: z.enum(['M1', 'M5', 'M15', 'H1', 'H4']).optional(),
    /** Comma-separated status list (freshness vocabulary only). */
    status: z
      .string()
      .max(200)
      .optional()
      .refine(
        (v) =>
          v === undefined ||
          v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .every((s) =>
              [
                'FRESH', 'PENDING', 'VALIDATED', 'STALE', 'EXPIRED',
                'INVALIDATED', 'REJECTED', 'DATA_UNAVAILABLE', 'ENGINE_ERROR',
              ].includes(s),
            ),
        { message: 'status values must be freshness-policy statuses' },
      ),
    /** ISO date-time bounds on signal creation time (inclusive). */
    fromUtc: z.string().datetime({ offset: true }).optional(),
    toUtc: z.string().datetime({ offset: true }).optional(),
    /** Signal-id substring search (min 2 chars, server-side contains). */
    q: z.string().trim().min(2).max(64).optional(),
    sort: z.enum(['newest', 'oldest', 'timeframe', 'expiry']).default('newest'),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(5).max(100).default(25),
  })
  .strict();
