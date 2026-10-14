/**
 * MOCK BRIDGE — automated tests only. NOT a real MT5 bridge.
 * ----------------------------------------------------------------------------
 * A tiny local HTTP server that imitates the read-only REST surface of the
 * v20 mt5-service contract (/health, /api/status, /api/symbols, /api/quote,
 * /api/candles) with SYNTHETIC, clearly-deterministic data. It exists so the
 * ingestion pipeline can be tested end-to-end without any broker connection.
 * Nothing here is ever presented as live market data.
 */

import type { BridgeBar, Timeframe } from '@/lib/market/types';

export interface MockBridgeState {
  source: 'mt5' | 'demo' | 'disconnected';
  connected: boolean;
  symbols: string[];
  quote: { bid: number; ask: number; ts: number } | null;
  candles: Partial<Record<Timeframe, BridgeBar[]>>;
  /** Timeframes that respond 503 (failure injection). */
  failTfs: Partial<Record<Timeframe, number>>; // tf -> http status
  /** Simulated global delay (ms) before responding (health/timeout injection). */
  delayMs: number;
  /** Simulated delay (ms) applied ONLY to /api/candles (per-tf timeout injection). */
  delayCandlesMs: number;
  /** When true, /health and everything else respond 401 (auth injection). */
  requireKey: boolean;
}

export function defaultMockState(): MockBridgeState {
  return {
    source: 'mt5',
    connected: true,
    symbols: ['XAUUSDm', 'XAUUSD', 'GOLD'],
    quote: null,
    candles: {},
    failTfs: {},
    delayMs: 0,
    delayCandlesMs: 0,
    requireKey: false,
  };
}

/**
 * Deterministic synthetic bars for one timeframe. Prices are structurally
 * valid OHLC (never real market values). `lastForming` controls whether the
 * newest bar is still open.
 */
export function makeBars(
  timeframeSec: number,
  count: number,
  lastOpenSec: number,
  opts: { forming?: boolean; holeAtOffsets?: number[]; base?: number } = {},
): BridgeBar[] {
  const base = opts.base ?? 2650;
  const hole = new Set(opts.holeAtOffsets ?? []);
  const bars: BridgeBar[] = [];
  let n = 0;
  for (let i = count - 1; i >= 0; i--) {
    if (hole.has(i)) continue; // deliberately missing candle
    const t = lastOpenSec - i * timeframeSec;
    const o = base + n * 0.25;
    const c = o + 0.5;
    const h = Math.max(o, c) + 0.75;
    const l = Math.min(o, c) - 0.75;
    const isLast = i === 0;
    bars.push({
      t,
      o: Number(o.toFixed(2)),
      h: Number(h.toFixed(2)),
      l: Number(l.toFixed(2)),
      c: Number(c.toFixed(2)),
      v: 100 + n,
      ...(isLast && opts.forming ? { f: 1 } : {}),
    });
    n += 1;
  }
  return bars;
}

/** Start the mock bridge on an ephemeral port; returns its base URL + controls. */
export async function startMockBridge(initial: MockBridgeState = defaultMockState()) {
  const state: MockBridgeState = { ...initial };

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (state.requireKey && req.headers.get('x-trader-key') !== 'mock-key') {
        return Response.json({ error: 'unauthorized (mock)' }, { status: 401 });
      }
      if (state.delayMs > 0) {
        await new Promise((r) => setTimeout(r, state.delayMs));
      }

      const isCandles = url.pathname === '/api/candles';
      if (isCandles && state.delayCandlesMs > 0) {
        await new Promise((r) => setTimeout(r, state.delayCandlesMs));
      }

      if (url.pathname === '/health') {
        return Response.json({
          ok: true,
          service: 'MOCK-mt5-service',
          source: state.source,
          connected: state.connected,
          uptime: 42,
        });
      }
      if (url.pathname === '/api/status') {
        return Response.json({
          connected: state.connected,
          source: state.source,
          server: 'MockServer',
          latencyMs: 12,
          serverTime: Math.floor(Date.now() / 1000),
          offsetSec: 0,
          reason: state.connected ? '' : 'mock disconnected',
          symbols: state.symbols.length,
        });
      }
      if (url.pathname === '/api/symbols') {
        return Response.json({ source: state.source, list: state.symbols });
      }
      if (url.pathname === '/api/quote') {
        if (!state.quote) return Response.json({ error: 'no quote yet' }, { status: 404 });
        const { bid, ask, ts } = state.quote;
        return Response.json({ symbol: url.searchParams.get('symbol'), bid, ask, mid: (bid + ask) / 2, ts, spread: ask - bid });
      }
      if (url.pathname === '/api/candles') {
        const tf = url.searchParams.get('tf') ?? 'M15';
        const limit = Number(url.searchParams.get('limit') ?? 500);
        const fail = state.failTfs[tf as Timeframe];
        if (fail) return Response.json({ error: `mock failure for ${tf}` }, { status: fail });
        const bars = state.candles[tf as Timeframe] ?? [];
        return Response.json({
          symbol: url.searchParams.get('symbol'),
          tf,
          digits: 2,
          source: state.source,
          bars: bars.slice(-limit),
        });
      }
      return Response.json({ error: 'not found (mock)' }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    stop: () => server.stop(true),
  };
}
