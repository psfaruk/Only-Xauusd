'use client';

/**
 * useTickStream — live market-tick websocket client (Task 29-c).
 * ----------------------------------------------------------------------------
 * Connects to the tick-stream mini-service (socket.io, port 3041 — read-only
 * relay of the authenticated Exness MT5 feed; no trading capability exists).
 *
 * Platform gateway rule: relative URL only, service port carried in the
 * XTransformPort query parameter, socket.io path '/' — exactly the pattern
 * from examples/websocket (never an absolute http://localhost:PORT URL).
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

export interface TickStreamState {
  status: TickStreamStatus;
  tick: TickStreamTick | null;
  bridge: TickStreamBridge | null;
  /** Ticks received by THIS client since mount (honest session counter). */
  sessionTicks: number;
  lastEventAtMs: number | null;
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

export function useTickStream(): TickStreamState {
  const [state, setState] = useState<TickStreamState>({
    status: 'connecting',
    tick: null,
    bridge: null,
    sessionTicks: 0,
    lastEventAtMs: null,
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

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
  }, []);

  return state;
}
