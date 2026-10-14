/**
 * XAUUSD AI Trading Agent — API Guard (Phase 3)
 * ----------------------------------------------------------------------------
 * Shared authentication + rate limiting for the /api/data/* surface.
 *
 * Auth model (documented in README §Security):
 *   · When DATA_API_TOKEN is set → EVERY /api/data/* request must present
 *     `Authorization: Bearer <token>` (timing-safe compare). Fail-closed 401.
 *   · When unset → read-only GETs remain public (same posture as the Phase 1
 *     health endpoints); the sync trigger is rate-limited harder.
 *
 * Rate limiting: fixed-window per client IP, in-memory (per server instance).
 * The bearer token is NEVER logged and never echoed back.
 */

import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { ErrorCode } from '@/lib/market/types';
import { timingSafeEqual } from 'node:crypto';

const buckets = new Map<string, { count: number; resetAt: number }>();

// Periodic scrub so the limiter map cannot grow forever.
const scrub = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000);
scrub.unref?.();

export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff && xff.length > 0) return xff.split(',')[0].trim();
  return 'local';
}

export function rateLimit(key: string, max: number, windowMs = 60_000): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  b.count += 1;
  if (b.count > max) {
    return { ok: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfterSec: 0 };
}

function safeBearerEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // keep timing flat
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export type GuardFailure = { ok: false; response: NextResponse };

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message, ...extra } }, { status });
}

/**
 * Guard a /api/data/* request: bearer auth (when configured) + rate limit.
 * `bucket` separates read vs trigger budgets.
 */
export function guardDataApi(
  request: Request,
  bucket: 'read' | 'trigger' = 'read',
): { ok: true } | GuardFailure {
  // ---- Rate limit ----------------------------------------------------------
  const max =
    bucket === 'trigger' ? Math.max(2, Math.floor(config.dataApi.rateLimitPerMin / 10)) : config.dataApi.rateLimitPerMin;
  const rl = rateLimit(`${bucket}:${clientIpFromHeaders(request.headers)}`, max);
  if (!rl.ok) {
    return {
      ok: false,
      response: jsonError(429, ErrorCode.RATE_LIMITED, `Rate limit — retry in ${rl.retryAfterSec}s.`, {
        retryAfterSec: rl.retryAfterSec,
      }),
    };
  }

  // ---- Bearer auth (only when DATA_API_TOKEN is configured) -----------------
  // Read at CALL time so operators (and tests) can enable/disable without a
  // process restart; the value itself never leaves this function.
  const token = process.env.DATA_API_TOKEN ?? '';
  if (token) {
    const auth = request.headers.get('authorization') ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!presented) {
      return { ok: false, response: jsonError(401, ErrorCode.AUTH_MISSING_TOKEN, 'Missing Authorization: Bearer token (DATA_API_TOKEN is configured).') };
    }
    if (!safeBearerEqual(presented, token)) {
      return { ok: false, response: jsonError(401, ErrorCode.AUTH_INVALID_TOKEN, 'Invalid bearer token.') };
    }
  }

  return { ok: true };
}

/** Parse + validate query params through a zod schema; fail-closed 400. */
export function parseQuery<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } },
  raw: unknown,
): { ok: true; data: T } | GuardFailure {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(400, ErrorCode.BAD_REQUEST, `Invalid query parameters: ${parsed.error.issues.map((i) => i.message).join('; ')}`),
    };
  }
  return { ok: true, data: parsed.data };
}
