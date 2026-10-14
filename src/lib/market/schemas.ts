/**
 * XAUUSD AI Trading Agent — Market Data API Schemas (Phase 3)
 * ----------------------------------------------------------------------------
 * Typed request schemas (zod) for every /api/data/* endpoint. Strict
 * allowlists, bounded limits and ranges. All timestamps are UTC ISO-8601.
 */

import { z } from 'zod';
import { config } from '@/lib/config';

const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const UtcIsoString = z
  .string()
  .regex(ISO_UTC_REGEX, 'must be a UTC ISO-8601 timestamp ending in Z')
  .refine((v) => !Number.isNaN(new Date(v).getTime()), 'must be a valid date');

/** Strict symbol allowlist check (default: XAUUSDm). */
export const AllowedSymbol = z.string().refine(
  (s) => config.market.symbols.includes(s),
  { message: `symbol is not in the allowlist (${config.market.symbols.join(', ')})` },
);

/** Strict timeframe allowlist check (M5 | M15 | H1 | H4 subset). */
export const AllowedTimeframe = z.string().refine(
  (tf) => (config.market.timeframes as readonly string[]).includes(tf),
  { message: `timeframe is not in the allowlist (${config.market.timeframes.join(', ')})` },
);

export const CandlesQuerySchema = z
  .object({
    symbol: AllowedSymbol,
    tf: AllowedTimeframe,
    limit: z.coerce.number().int().min(1).max(1000).default(200),
    from: UtcIsoString.optional(),
    to: UtcIsoString.optional(),
    /** Forming candles are excluded by default — they are never confirmed history. */
    includeForming: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .transform((v) => v === true || v === 'true')
      .default(false),
  })
  .superRefine((q, ctx) => {
    if (q.from && q.to) {
      const from = new Date(q.from).getTime();
      const to = new Date(q.to).getTime();
      if (to <= from) {
        ctx.addIssue({ code: 'custom', message: '`to` must be after `from`' });
      }
      if (to - from > 90 * 86_400_000) {
        ctx.addIssue({ code: 'custom', message: 'range too large — maximum 90 days' });
      }
    }
  });

export type CandlesQuery = z.infer<typeof CandlesQuerySchema>;

export const LatestQuerySchema = z.object({
  symbol: AllowedSymbol.optional(),
});

/** Status/quality queries may omit the symbol — the server defaults to the
 *  first allowlisted symbol (single-symbol deployments). */
export const StatusQuerySchema = z.object({
  symbol: AllowedSymbol.optional(),
});

export const QualityQuerySchema = z.object({
  symbol: AllowedSymbol.optional(),
});

export const SyncStatusQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  symbol: AllowedSymbol.optional(),
});

export const SyncTriggerSchema = z
  .object({
    symbol: AllowedSymbol,
    timeframes: z.array(AllowedTimeframe).min(1).optional(),
    mode: z.enum(['manual', 'backfill']).default('manual'),
    rangeStartUtc: UtcIsoString.optional(),
    rangeEndUtc: UtcIsoString.optional(),
  })
  .superRefine((b, ctx) => {
    if (b.mode === 'backfill') {
      if (!b.rangeStartUtc || !b.rangeEndUtc) {
        ctx.addIssue({ code: 'custom', message: 'backfill requires rangeStartUtc and rangeEndUtc (UTC ISO-8601)' });
      } else if (new Date(b.rangeEndUtc).getTime() <= new Date(b.rangeStartUtc).getTime()) {
        ctx.addIssue({ code: 'custom', message: 'rangeEndUtc must be after rangeStartUtc' });
      } else if (
        new Date(b.rangeEndUtc).getTime() - new Date(b.rangeStartUtc).getTime() >
        config.market.backfillMaxDays * 86_400_000
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `backfill range too large — maximum ${config.market.backfillMaxDays} days`,
        });
      }
    }
  });

export type SyncTriggerBody = z.infer<typeof SyncTriggerSchema>;
