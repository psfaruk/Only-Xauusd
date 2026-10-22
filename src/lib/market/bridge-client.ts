/**
 * XAUUSD AI Trading Agent — MT5 Bridge REST Client (Phase 3)
 * ----------------------------------------------------------------------------
 * Server-side client for the read-only bridge contract (user's v20
 * `mt5-service`, REST :3031 — see audit/phase3-audit.md §1.3):
 *   GET /health                      (public)
 *   GET /api/status                  (auth: x-trader-key)
 *   GET /api/symbols                 (auth)
 *   GET /api/quote?symbol=           (auth)
 *   GET /api/candles?symbol=&tf=&limit= (auth)
 *
 * READ-ONLY: no order/trade/position/connection-management endpoints are
 * defined here or callable through this module — by construction.
 *
 * Safety properties:
 *   · NEVER throws — every call returns a discriminated BridgeResult.
 *   · Fail-closed: no bridge URL configured → BRIDGE_NOT_CONFIGURED without
 *     any network attempt.
 *   · Bounded: per-request timeout (AbortController) and bounded retries with
 *     exponential backoff + jitter. Retries ONLY on network errors, timeouts,
 *     5xx and 429 — never on 4xx (except 429), never indefinitely.
 *   · Secrets: the token travels only in the x-trader-key header; it is never
 *     logged, never included in error messages or results.
 */

import { config } from '@/lib/config';
import type {
  BridgeCandlesRangeResponse,
  BridgeCandlesResponse,
  BridgeHealth,
  BridgeQuote,
  BridgeResult,
  BridgeStatus,
  BridgeSymbolsResponse,
} from './types';

export interface BridgeClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injectable fetch for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export interface BridgeClient {
  getHealth(): Promise<BridgeResult<BridgeHealth>>;
  getStatus(): Promise<BridgeResult<BridgeStatus>>;
  getSymbols(): Promise<BridgeResult<BridgeSymbolsResponse>>;
  getQuote(symbol: string): Promise<BridgeResult<BridgeQuote>>;
  getCandles(params: { symbol: string; timeframe: string; limit: number }): Promise<BridgeResult<BridgeCandlesResponse>>;
  /** Phase 3 historical acquisition — bounded UTC range query (closed bars,
   *  forming edge flagged). Read-only, same auth + fail-closed semantics. */
  getCandlesRange(params: { symbol: string; timeframe: string; fromUtcSec: number; toUtcSec: number }): Promise<BridgeResult<BridgeCandlesRangeResponse>>;
}

const MAX_BRIDGE_ERROR_MESSAGE = 300;

function truncate(s: string, max = MAX_BRIDGE_ERROR_MESSAGE): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Sleep with jittered exponential backoff. */
function backoffMs(attempt: number): number {
  const base = Math.min(400 * Math.pow(2, attempt), 3_000);
  return base + Math.floor(Math.random() * 200);
}

export function createBridgeClient(options: BridgeClientOptions = {}): BridgeClient {
  const baseUrl = (options.baseUrl ?? config.bridge.url).replace(/\/+$/, '');
  const token = options.token ?? process.env.MT5_BRIDGE_TOKEN ?? '';
  const timeoutMs = options.timeoutMs ?? config.bridge.timeoutMs;
  const maxRetries = options.maxRetries ?? config.bridge.maxRetries;
  const doFetch = options.fetchImpl ?? fetch;

  async function requestJson<T>(
    path: string,
    validate: (body: unknown) => T | null,
  ): Promise<BridgeResult<T>> {
    if (!baseUrl) {
      return {
        ok: false,
        error: { code: 'BRIDGE_NOT_CONFIGURED', message: 'MT5_BRIDGE_URL is not configured — the data pipeline fails closed.' },
      };
    }

    const url = `${baseUrl}${path}`;
    // Headers are built per attempt and NEVER logged or returned.
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['x-trader-key'] = token;

    let lastError: { code: string; message: string; httpStatus?: number } = {
      code: 'BRIDGE_UNREACHABLE',
      message: 'unknown bridge failure',
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          cache: 'no-store',
        });

        if (res.ok) {
          const body: unknown = await res.json().catch(() => null);
          const validated = validate(body);
          if (validated === null) {
            // Shape mismatch — a bad response is NOT retried blindly; it is a
            // deterministic failure of the contract.
            return {
              ok: false,
              error: {
                code: 'BRIDGE_BAD_RESPONSE',
                message: `Bridge response for ${path} did not match the expected contract.`,
                httpStatus: res.status,
              },
            };
          }
          return { ok: true, data: validated };
        }

        // Non-2xx — classify. 404 is a legitimate "no data yet" (e.g. quote).
        if (res.status === 404) {
          return {
            ok: false,
            error: { code: 'NOT_FOUND', message: `Bridge has no data for ${path} yet.`, httpStatus: 404 },
          };
        }
        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            error: { code: 'BRIDGE_AUTH_FAILED', message: 'Bridge rejected the request (unauthorized).', httpStatus: res.status },
          };
        }
        if (res.status === 429) {
          lastError = { code: 'BRIDGE_RATE_LIMITED', message: 'Bridge rate limit hit.', httpStatus: 429 };
          // fall through to retry
        } else if (res.status >= 500) {
          const text = await res.text().catch(() => '');
          lastError = {
            code: 'BRIDGE_HTTP_ERROR',
            message: truncate(`Bridge HTTP ${res.status}${text ? `: ${truncate(text, 160)}` : ''}`),
            httpStatus: res.status,
          };
          // fall through to retry
        } else {
          // Other 4xx — deterministic client error, do not retry.
          const text = await res.text().catch(() => '');
          return {
            ok: false,
            error: {
              code: 'BRIDGE_HTTP_ERROR',
              message: truncate(`Bridge HTTP ${res.status}${text ? `: ${truncate(text, 160)}` : ''}`),
              httpStatus: res.status,
            },
          };
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          lastError = { code: 'BRIDGE_TIMEOUT', message: `Bridge request timed out after ${timeoutMs}ms.` };
        } else {
          lastError = {
            code: 'BRIDGE_UNREACHABLE',
            message: truncate(err instanceof Error ? err.message : 'network error'),
          };
        }
        // fall through to retry
      } finally {
        clearTimeout(timer);
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
    }

    return { ok: false, error: lastError };
  }

  return {
    getHealth: () =>
      requestJson<BridgeHealth>('/health', (b) => {
        if (!isRecord(b) || typeof b.ok !== 'boolean') return null;
        return b as unknown as BridgeHealth;
      }),

    getStatus: () =>
      requestJson<BridgeStatus>('/api/status', (b) => {
        if (!isRecord(b) || typeof b.connected !== 'boolean' || typeof b.source !== 'string')
          return null;
        return b as unknown as BridgeStatus;
      }),

    getSymbols: () =>
      requestJson<BridgeSymbolsResponse>('/api/symbols', (b) => {
        if (!isRecord(b) || !Array.isArray(b.list)) return null;
        return b as unknown as BridgeSymbolsResponse;
      }),

    getQuote: (symbol: string) =>
      requestJson<BridgeQuote>(`/api/quote?symbol=${encodeURIComponent(symbol)}`, (b) => {
        if (!isRecord(b) || typeof b.bid !== 'number' || typeof b.ask !== 'number' || typeof b.ts !== 'number') return null;
        return b as unknown as BridgeQuote;
      }),

    getCandles: ({ symbol, timeframe, limit }) =>
      requestJson<BridgeCandlesResponse>(
        `/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(timeframe)}&limit=${Math.max(1, Math.trunc(limit))}`,
        (b) => {
          if (!isRecord(b) || !Array.isArray(b.bars) || typeof b.source !== 'string') return null;
          return b as unknown as BridgeCandlesResponse;
        },
      ),

    getCandlesRange: ({ symbol, timeframe, fromUtcSec, toUtcSec }) =>
      requestJson<BridgeCandlesRangeResponse>(
        `/api/candles/range?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(timeframe)}&fromUtc=${Math.trunc(fromUtcSec)}&toUtc=${Math.trunc(toUtcSec)}`,
        (b) => {
          if (
            !isRecord(b) ||
            !Array.isArray(b.bars) ||
            typeof b.source !== 'string' ||
            typeof b.fromUtc !== 'number' ||
            typeof b.toUtc !== 'number' ||
            typeof b.paginated !== 'boolean'
          ) return null;
          return b as unknown as BridgeCandlesRangeResponse;
        },
      ),
  };
}

/** Shared singleton for the app (tests build their own with options). */
export const bridgeClient = createBridgeClient();
