'use client';

/**
 * useTickStream — live market-tick websocket client (Task 29-c; realtime
 * positions/account channels Task 36-rt).
 * ----------------------------------------------------------------------------
 * Connects to the tick-stream mini-service (socket.io, port 3041 — read-only
 * relay of the authenticated Exness MT5 feed; no trading capability exists).
 *
 * Platform gateway rule: relative URL only, service port carried in the
 * XTransformPort query parameter, socket.io path '/' — exactly the pattern
 * from examples/websocket (never an absolute http://localhost:PORT URL).
 *
 * Channels (Task 36-rt):
 *   · `tick`      — live quote, 250 ms poll cadence, emitted only on change;
 *   · `positions` — open positions marked to market, 3 s cadence, emitted
 *                   only after successful bridge polls (last-good replays on
 *                   (re)connect carry an honest `stale` flag);
 *   · `account`   — balance/connection, 2 s cadence, same honesty rule;
 *   · `bridge`    — relay/bridge health snapshot every 2 s.
 *
 * Honest-state contract: 'connecting' → 'live' | 'down'. A down stream NEVER
 * fabricates values — consumers must fall back to their polling sources and
 * say so. Payloads are validated minimally; anything malformed is ignored.
 */

import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

export interface TickStreamTick {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  digits: number | null;
  quoteTimeUtc: string;
  receivedAtUtc: string;
  serviceSeq: number;
  bridgeLatencyMs: number;
}

export interface TickStreamBridge {
  reachable: boolean | null;
  configured: boolean | null;
  connected: boolean | null;
  authenticated: boolean | null;
  server: string | null;
  gateway: string | null;
  latencyMs: number | null;
  offsetSec: number | null;
  symbols: number | null;
  quoteCount: number | null;
  lastQuoteAtMs: number | null;
  reconnects: number | null;
  lastError: string | null;
  lastErrorAtMs: number | null;
  uptimeMs: number | null;
  serviceUptimeMs: number | null;
}

export type TickStreamStatus = 'connecting' | 'live' | 'down';

/** Task 36-rt — one live open position from the `positions` channel.
 *  `currentPrice`/`floatingPnlUsd` are honest nulls whenever the relay had no
 *  fresh (< 10 s) XAUUSDm quote — never fabricated. */
export interface TickStreamLivePosition {
  positionId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  entryPrice: number;
  openTimeUtcSec: number;
  currentPrice: number | null;
  floatingPnlUsd: number | null;
  comment: string | null;
}

/** Task 36-rt — live account snapshot from the `account` channel. */
export interface TickStreamAccount {
  balance: number | null;
  currency: string | null;
  connected: boolean | null;
  authenticated: boolean | null;
  updatedAtMs: number;
  stale: boolean;
}

export interface TickStreamState {
  status: TickStreamStatus;
  tick: TickStreamTick | null;
  bridge: TickStreamBridge | null;
  /** Ticks received by THIS client since mount (honest session counter). */
  sessionTicks: number;
  lastEventAtMs: number | null;
  /** Task 36-rt — realtime open-position channel ([] until the first event;
  *  an empty list is a genuine "no open positions" observation). */
  positions: TickStreamLivePosition[];
  positionsUpdatedAtMs: number | null;
  positionsStale: boolean;
  positionsSource: string | null;
  /** Task 36-rt — realtime account channel (null until the first event). */
  account: TickStreamAccount | null;
}

const TICK_STREAM_URL = '/?XTransformPort=3041';

function isTick(v: unknown): v is TickStreamTick {
  if (v === null || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.symbol === 'string' &&
    typeof t.bid === 'number' && Number.isFinite(t.bid) &&
    typeof t.ask === 'number' && Number.isFinite(t.ask) &&
    t.bid > 0 && t.ask > 0 && t.ask >= t.bid
  );
}

function isBridge(v: unknown): v is TickStreamBridge {
  if (v === null || typeof v !== 'object') return false;
  return true; // all fields optional/nullable by contract — accept the object
}

function isLivePosition(v: unknown): v is TickStreamLivePosition {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.positionId === 'string' && p.positionId.length > 0 &&
    typeof p.symbol === 'string' && p.symbol.length > 0 &&
    (p.direction === 'BUY' || p.direction === 'SELL') &&
    typeof p.lots === 'number' && Number.isFinite(p.lots) && p.lots > 0 &&
    typeof p.entryPrice === 'number' && Number.isFinite(p.entryPrice) && p.entryPrice > 0 &&
    typeof p.openTimeUtcSec === 'number' && Number.isFinite(p.openTimeUtcSec)
  ); // currentPrice/floatingPnlUsd/comment are nullable — rendered with ?? null
}

/** Minimal wire validation for a `positions` payload (positions array + a
 *  finite updatedAtMs); malformed events are ignored, never rendered. */
function isPositionsPayload(v: unknown): v is { positions: unknown[]; updatedAtMs: number; stale: unknown; source: unknown } {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return Array.isArray(p.positions) && typeof p.updatedAtMs === 'number' && Number.isFinite(p.updatedAtMs);
}

/** Minimal wire validation for an `account` payload. */
function isAccountPayload(v: unknown): v is Record<string, unknown> & { updatedAtMs: number } {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.updatedAtMs === 'number' && Number.isFinite(p.updatedAtMs);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

export function useTickStream(): TickStreamState {
  const [state, setState] = useState<TickStreamState>({
    status: 'connecting',
    tick: null,
    bridge: null,
    sessionTicks: 0,
    lastEventAtMs: null,
    positions: [],
    positionsUpdatedAtMs: null,
    positionsStale: false,
    positionsSource: null,
    account: null,
  });

  useEffect(() => {
    const socket = io(TICK_STREAM_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      timeout: 8000,
    });

    socket.on('connect', () => {
      setState((s) => ({ ...s, status: 'live', lastEventAtMs: Date.now() }));
    });
    socket.on('hello', () => {
      // Service greeted us (sent right before the snapshot events).
      setState((s) => ({ ...s, status: 'live', lastEventAtMs: Date.now() }));
    });
    socket.on('disconnect', () => {
      setState((s) => ({ ...s, status: 'down' }));
    });
    socket.on('connect_error', () => {
      setState((s) => (s.status === 'live' ? { ...s, status: 'down' } : { ...s, status: 'down' }));
    });
    socket.on('tick', (payload: unknown) => {
      if (!isTick(payload)) return; // malformed → ignored, never rendered
      setState((s) => ({
        ...s,
        status: 'live',
        tick: payload,
        sessionTicks: s.sessionTicks + 1,
        lastEventAtMs: Date.now(),
      }));
    });
    socket.on('bridge', (payload: unknown) => {
      if (!isBridge(payload)) return;
      setState((s) => ({ ...s, bridge: payload, lastEventAtMs: Date.now() }));
    });
    socket.on('positions', (payload: unknown) => {
      if (!isPositionsPayload(payload)) return; // malformed → ignored, never rendered
      const positions = payload.positions.filter(isLivePosition);
      setState((s) => ({
        ...s,
        positions,
        positionsUpdatedAtMs: payload.updatedAtMs,
        positionsStale: payload.stale === true,
        positionsSource: strOrNull(payload.source),
        lastEventAtMs: Date.now(),
      }));
    });
    socket.on('account', (payload: unknown) => {
      if (!isAccountPayload(payload)) return;
      setState((s) => ({
        ...s,
        account: {
          balance: numOrNull(payload.balance),
          currency: strOrNull(payload.currency),
          connected: boolOrNull(payload.connected),
          authenticated: boolOrNull(payload.authenticated),
          updatedAtMs: payload.updatedAtMs,
          stale: payload.stale === true,
        },
        lastEventAtMs: Date.now(),
      }));
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
  }, []);

  return state;
}
