/**
 * XAUUSD AI Trading Agent — Bridge Order Client (Phase 11)
 * ----------------------------------------------------------------------------
 * Server-side client for the Phase 11 bridge trade endpoints:
 *   GET  /api/status           (auth) — now carries accountBalance/accountEquity
 *   GET  /api/positions        (auth + BRIDGE_ORDERS_ENABLED bridge-side)
 *   POST /api/order            (auth + BRIDGE_ORDERS_ENABLED bridge-side)
 *   POST /api/position-close   (auth + BRIDGE_ORDERS_ENABLED bridge-side)
 *
 * Safety properties (mirror of the read-only bridge-client discipline):
 *   · NEVER throws — every call returns a discriminated result.
 *   · Fail-closed: no bridge URL / token → BRIDGE_NOT_CONFIGURED, no network
 *     attempt. A 403 ORDER_LAYER_DISABLED (orders not armed bridge-side) is
 *     reported honestly, never retried.
 *   · Bounded: single attempt, AbortController timeout (orders must never be
 *     double-fired by an automatic retry — exactly-once is the rule).
 *   · Secrets: the token lives only in the x-trader-key header; never logged,
 *     never in error messages.
 *   · Order idempotency: placeOrder is called EXACTLY ONCE per approval
 *     decision by the execution service; a network timeout is surfaced as
 *     'unknown' and NEVER auto-retried (manual verification via positions).
 */

import { config } from '@/lib/config';

export interface BridgeOrderResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface BridgeAccountState {
  connected: boolean;
  authenticated: boolean;
  server: string | null;
  accountCurrency: string | null;
  accountBalance: number | null;
  accountEquity: number | null;
  ordersEnabled: boolean;
  ordersMaxLots: number | null;
}

export interface BridgePosition {
  positionId: string;
  orderId: string;
  timeCreateUtcSec: number;
  timeUpdateUtcSec: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  priceOpen: number;
  priceClose: number;
  sl: number;
  tp: number;
  profit: number;
  commission: number;
  swap: number;
}

export interface BridgeOrderOutcome {
  accepted: boolean;
  action: 'OPEN' | 'CLOSE';
  retcode: number | null;
  immediateRetcode: number | null;
  finalEvent: boolean | null;
  dealId: string | null;
  orderId: string | null;
  price: number | null;
  lots: number | null;
  comment: string | null;
  positionStillOpen: boolean | null;
  raw: Record<string, unknown>;
}

const TIMEOUT_MS = 20_000;

function err<T>(status: number, code: string, message: string): BridgeOrderResult<T> {
  return { ok: false, status, data: null, errorCode: code, errorMessage: message.slice(0, 300) };
}

async function call<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  validate: (body: unknown) => T | null,
): Promise<BridgeOrderResult<T>> {
  const baseUrl = config.bridge.url;
  const token = process.env.MT5_BRIDGE_TOKEN ?? '';
  if (!baseUrl) return err(0, 'BRIDGE_NOT_CONFIGURED', 'MT5_BRIDGE_URL is not configured');
  if (!token) return err(0, 'BRIDGE_TOKEN_NOT_CONFIGURED', 'MT5_BRIDGE_TOKEN is not configured');

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        'x-trader-key': token,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const b = body as { error?: { code?: string; message?: string } } | null;
      return err(
        res.status,
        b?.error?.code ?? `HTTP_${res.status}`,
        b?.error?.message ?? `bridge responded HTTP ${res.status}`,
      );
    }
    const parsed = validate(body);
    if (parsed === null) return err(res.status, 'BRIDGE_MALFORMED_RESPONSE', 'unexpected bridge payload shape');
    return { ok: true, status: res.status, data: parsed, errorCode: null, errorMessage: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown bridge error';
    return err(0, msg.includes('timeout') || msg.includes('Timeout') ? 'BRIDGE_TIMEOUT' : 'BRIDGE_UNREACHABLE', msg);
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Account + order-layer posture (read-only call, safe any time). */
export async function getBridgeAccountState(): Promise<BridgeOrderResult<BridgeAccountState>> {
  return call('/api/status', { method: 'GET' }, (body) => {
    const b = asRecord(body);
    if (!b) return null;
    return {
      connected: b.connected === true,
      authenticated: b.authenticated === true,
      server: str(b.server),
      accountCurrency: str(b.accountCurrency),
      accountBalance: num(b.accountBalance),
      accountEquity: num(b.accountEquity),
      ordersEnabled: b.ordersEnabled === true,
      ordersMaxLots: num(b.ordersMaxLots),
    };
  });
}

/** Live open positions (bridge order layer must be armed). */
export async function listBridgePositions(): Promise<BridgeOrderResult<BridgePosition[]>> {
  return call('/api/positions', { method: 'GET' }, (body) => {
    const b = asRecord(body);
    if (!b || !Array.isArray(b.positions)) return null;
    const out: BridgePosition[] = [];
    for (const raw of b.positions) {
      const p = asRecord(raw);
      if (!p) continue;
      const direction = p.direction === 'BUY' || p.direction === 'SELL' ? p.direction : null;
      if (!direction) continue;
      out.push({
        positionId: str(p.positionId) ?? '',
        orderId: str(p.orderId) ?? '',
        timeCreateUtcSec: num(p.timeCreateUtcSec) ?? 0,
        timeUpdateUtcSec: num(p.timeUpdateUtcSec) ?? 0,
        symbol: str(p.symbol) ?? '',
        direction,
        lots: num(p.lots) ?? 0,
        priceOpen: num(p.priceOpen) ?? 0,
        priceClose: num(p.priceClose) ?? 0,
        sl: num(p.sl) ?? 0,
        tp: num(p.tp) ?? 0,
        profit: num(p.profit) ?? 0,
        commission: num(p.commission) ?? 0,
        swap: num(p.swap) ?? 0,
      });
    }
    return out;
  });
}

/** Market order with SL/TP — SINGLE ATTEMPT (never auto-retried). */
export async function placeBridgeOrder(params: {
  symbol: string;
  type: 'BUY' | 'SELL';
  lots: number;
  sl?: number;
  tp?: number;
  comment?: string;
}): Promise<BridgeOrderResult<BridgeOrderOutcome>> {
  return call('/api/order', { method: 'POST', body: params }, (body) => {
    const b = asRecord(body);
    if (!b) return null;
    return {
      accepted: b.accepted === true || b.ok === true,
      action: 'OPEN',
      retcode: num(b.retcode),
      immediateRetcode: num(b.immediateRetcode),
      finalEvent: typeof b.finalEvent === 'boolean' ? b.finalEvent : null,
      dealId: str(b.dealId),
      orderId: str(b.orderId),
      price: num(b.price),
      lots: num(b.lots) ?? num(b.dealtLots),
      comment: str(b.comment),
      positionStillOpen: null,
      raw: b,
    };
  });
}

/** Close an open position by id — SINGLE ATTEMPT (never auto-retried). */
export async function closeBridgePosition(positionId: string): Promise<BridgeOrderResult<BridgeOrderOutcome>> {
  return call(
    '/api/position-close',
    { method: 'POST', body: { positionId } },
    (body) => {
      const b = asRecord(body);
      if (!b) return null;
      return {
        accepted: b.accepted === true || b.ok === true,
        action: 'CLOSE',
        retcode: num(b.retcode),
        immediateRetcode: num(b.immediateRetcode),
        finalEvent: typeof b.finalEvent === 'boolean' ? b.finalEvent : null,
        dealId: str(b.dealId),
        orderId: str(b.orderId),
        price: num(b.price),
        lots: num(b.lots) ?? num(b.dealtLots),
        comment: str(b.comment),
        positionStillOpen: typeof b.positionStillOpen === 'boolean' ? b.positionStillOpen : null,
        raw: b,
      };
    },
  );
}
