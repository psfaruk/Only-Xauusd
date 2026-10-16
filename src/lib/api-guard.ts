/**
 * XAUUSD AI Trading Agent — API Guard (Phase 3, hardened in Phase 4)
 * ----------------------------------------------------------------------------
 * Shared authentication + rate limiting for the /api/data/* and /api/analysis/*
 * surface.
 *
 * Security posture (Phase 4 hardening — fail closed, README §Security):
 *   · TRIGGER endpoints (POST /api/data/sync, POST /api/analysis/run,
 *     POST /api/signal/run) require DATA_API_TOKEN ALWAYS. When the token is
 *     unset they respond 503 MARKET_API_TOKEN_NOT_CONFIGURED and never run.
 *     There is no bypass — except ONE explicit, separately-documented preview
 *     opt-in: MARKET_API_PUBLIC_TRIGGERS=true (Phase 13). That flag only
 *     matters when the token is UNSET, never weakens a token-protected
 *     deployment, and the tight trigger rate-limit bucket still applies.
 *     The guarded operations are read-only w.r.t. the broker (sync +
 *     deterministic analysis + research signal evaluation; no order code
 *     exists anywhere), which is exactly what the autonomous scheduler already
 *     does every MARKET_SYNC_INTERVAL_MS.
 *   · READ endpoints (GET) require the bearer token whenever it is set.
 *     When it is unset they fail closed with the same 503 UNLESS the operator
 *     explicitly opts in via MARKET_API_PUBLIC_READS=true (preview/dashboards
 *     only — never in production).
 *   · Token comparison is timing-safe; the value is never logged or echoed.
 *
 * Rate limiting: fixed-window per client IP, in-memory (per server instance).
 * Reads behind a token get the standard budget; unauthenticated reads (public
 * opt-in) get a smaller one. Triggers are always tightly bounded.
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
 * Guard a protected request. `bucket`:
 *   · 'trigger' — write/trigger endpoints (POST sync / POST analysis run /
 *     POST signal run): bearer token ALWAYS required; unset token → 503 fail
 *     closed, unless the operator explicitly opted in to public triggers via
 *     MARKET_API_PUBLIC_TRIGGERS=true (preview-only; Phase 13). A set token
 *     always requires a valid bearer — the flag never weakens that posture.
 *   · 'read' — read endpoints (GET): token required when set; when unset,
 *     allowed only with the explicit MARKET_API_PUBLIC_READS opt-in,
 *     otherwise 503 fail closed.
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

  // ---- Bearer auth ----------------------------------------------------------
  // Read at CALL time so operators (and tests) can enable/disable without a
  // process restart; the value itself never leaves this function.
  const token = process.env.DATA_API_TOKEN ?? '';

  const requireToken = () => {
    if (token) {
      const auth = request.headers.get('authorization') ?? '';
      const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!presented) {
        return jsonError(401, ErrorCode.AUTH_MISSING_TOKEN, 'Missing Authorization: Bearer token (DATA_API_TOKEN is configured).');
      }
      if (!safeBearerEqual(presented, token)) {
        return jsonError(401, ErrorCode.AUTH_INVALID_TOKEN, 'Invalid bearer token.');
      }
      return null; // authorized
    }
    return jsonError(
      503,
      ErrorCode.MARKET_API_TOKEN_NOT_CONFIGURED,
      'Fail-closed: DATA_API_TOKEN is not set. This endpoint never runs unauthenticated. Set DATA_API_TOKEN (see README §Security).',
    );
  };

  if (bucket === 'trigger') {
    // Triggers require the token — no implicit bypass. ONE explicit,
    // separately-documented preview opt-in (Phase 13): when NO token is
    // configured the operator may open the (broker-read-only, rate-limited)
    // trigger surface with MARKET_API_PUBLIC_TRIGGERS=true. When a token IS
    // set, the bearer check always runs and the flag is ignored.
    if (token) {
      const failure = requireToken();
      if (failure) return { ok: false, response: failure };
      return { ok: true };
    }
    if (process.env.MARKET_API_PUBLIC_TRIGGERS === 'true' || process.env.MARKET_API_PUBLIC_TRIGGERS === '1') {
      return { ok: true }; // explicitly opted-in public trigger (preview only)
    }
    return {
      ok: false,
      response: jsonError(
        503,
        ErrorCode.MARKET_API_TOKEN_NOT_CONFIGURED,
        'Fail-closed: DATA_API_TOKEN is not set. This endpoint never runs unauthenticated. Set DATA_API_TOKEN (see README §Security) or, for preview dashboards only, MARKET_API_PUBLIC_TRIGGERS=true.',
      ),
    };
  }

  // Reads: token set → bearer required. Token unset → public opt-in or 503.
  if (token) {
    const failure = requireToken();
    if (failure) return { ok: false, response: failure };
    return { ok: true };
  }
  if (process.env.MARKET_API_PUBLIC_READS === 'true' || process.env.MARKET_API_PUBLIC_READS === '1') {
    return { ok: true }; // explicitly opted-in public read (preview only)
  }
  return {
    ok: false,
    response: jsonError(
      503,
      ErrorCode.MARKET_API_TOKEN_NOT_CONFIGURED,
      'Fail-closed: DATA_API_TOKEN is not set and public reads are not enabled. Set DATA_API_TOKEN (recommended) or MARKET_API_PUBLIC_READS=true for preview dashboards only (see README §Security).',
    ),
  };
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
