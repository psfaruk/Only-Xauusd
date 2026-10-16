/**
 * mt5-bridge — READ-ONLY REST surface (Phase 8), port 3031.
 * ----------------------------------------------------------------------------
 * Implements the EXACT Phase 3 bridge contract consumed by the app
 * (src/lib/market/bridge-client.ts — see audit/phase3-audit.md §1.3):
 *
 *   GET /health                                  (public)
 *   GET /api/status                              (auth: x-trader-key)
 *   GET /api/symbols                             (auth)
 *   GET /api/quote?symbol=XAUUSDm                (auth)
 *   GET /api/candles?symbol=&tf=&limit=          (auth)
 *
 * READ-ONLY: there are no POST endpoints, no connection-management endpoints
 * and no order/trade/position routes. Credentials never appear in responses,
 * logs or errors; the login is reported masked only.
 */

import {
  connect, snapshot, getQuote, getSymbolInfo, listSymbols, resolvableWatchlist,
  fetchCandles, stop, config,
} from "./src/manager";

const PORT = 3031;
const TOKEN = process.env.MT5_BRIDGE_TOKEN ?? "";

function json(_ctx: unknown, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-bridge-readonly": "1",
    },
  });
}

function authorized(req: Request): boolean {
  if (!TOKEN) return false; // fail-closed: no token configured → nothing served
  return req.headers.get("x-trader-key") === TOKEN;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    if (method !== "GET") {
      return json(null, 405, { ok: false, error: "METHOD_NOT_ALLOWED", detail: "read-only bridge: GET only" });
    }

    // ── public health (no auth, no data) ────────────────────────────────────
    if (path === "/health") {
      const s = snapshot();
      return json(null, 200, {
        ok: true,
        service: "mt5-bridge",
        version: "1.0.0-phase8",
        source: s.source,
        connected: s.connected,
        authenticated: s.authenticated,
        uptime: Math.floor(s.uptimeMs / 1000),
      });
    }

    // ── auth gate for everything below ──────────────────────────────────────
    if (!authorized(req)) {
      return json(null, 401, { ok: false, error: "UNAUTHORIZED", detail: "missing or invalid x-trader-key" });
    }

    if (path === "/api/status") {
      const s = snapshot();
      return json(null, 200, {
        connected: s.connected,
        source: s.source,
        server: s.server,
        latencyMs: s.latencyMs,
        serverTime: s.serverTimeSec ?? undefined,
        offsetSec: s.brokerOffsetSec,
        reason: s.connected ? null : (s.lastError ?? "not connected"),
        symbols: s.symbolsLoaded,
        // Phase 8 integrity extras (ignored by older consumers, honored by
        // the Phase 8 integrity monitor):
        authenticated: s.authenticated,
        gateway: s.gateway,
        loginMasked: s.loginMasked,
        accountCurrency: s.accountCurrency,
        accountGroup: s.accountGroup,
        brokerOffsetVerified: s.brokerOffsetVerified,
        watchlist: s.watchlist,
        watchlistResolved: resolvableWatchlist(),
        reconnects: s.reconnects,
        lastError: s.lastError,
        lastErrorAtMs: s.lastErrorAtMs,
        lastQuoteAtMs: s.lastQuoteAtMs,
        quoteCount: s.quoteCount,
        uptimeMs: s.uptimeMs,
      });
    }

    if (path === "/api/symbols") {
      const s = snapshot();
      return json(null, 200, { source: s.source, list: listSymbols() });
    }

    if (path === "/api/quote") {
      const symbol = (url.searchParams.get("symbol") ?? "").trim();
      if (!symbol) return json(null, 400, { ok: false, error: "BAD_REQUEST", detail: "symbol required" });
      const q = getQuote(symbol);
      if (!q) {
        return json(null, 404, {
          ok: false,
          error: "QUOTE_UNAVAILABLE",
          detail: "no verified quote for symbol (not subscribed, or no live tick received yet)",
        });
      }
      // Broker→UTC normalization (master-audit fix C-D2): the manager measures
      // brokerOffsetSec live from every quote (broker time − local UTC). The
      // app-side contract (src/lib/market/types.ts) says the bridge serves
      // UTC-normalized timestamps — subtract the measured offset so a broker
      // running on a shifted server clock (e.g. GMT+2/+3) can never silently
      // skew the app timeline. Verified today: Exness-MT5Trial6 offset ≈ 0,
      // so served values are unchanged; the fix only matters if the broker
      // clock shifts (then a positive shift would have failed closed anyway,
      // and a small negative shift would have silently skewed — now neither).
      const utcTs = q.brokerTimeSec - snapshot().brokerOffsetSec;
      return json(null, 200, {
        symbol: q.symbol,
        bid: q.bid,
        ask: q.ask,
        mid: q.mid,
        ts: utcTs,
        spread: q.spread,
        // Phase 8 integrity extras:
        digits: q.digits,
        receivedAtMs: q.receivedAtMs,
        source: "mt5",
      });
    }

    if (path === "/api/candles") {
      const symbol = (url.searchParams.get("symbol") ?? "").trim();
      const tf = (url.searchParams.get("tf") ?? "").trim().toUpperCase();
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") ?? 100) || 100));
      if (!symbol || !tf) {
        return json(null, 400, { ok: false, error: "BAD_REQUEST", detail: "symbol and tf required" });
      }
      const info = getSymbolInfo(symbol);
      if (snapshot().connected && !info) {
        return json(null, 404, { ok: false, error: "SYMBOL_NOT_FOUND", detail: `${symbol} not in broker symbol table` });
      }
      try {
        const fetched = await fetchCandles(symbol, tf, limit);
        // Broker→UTC normalization (master-audit fix C-D2): same rule as the
        // quote endpoint — candle bar-open times are broker times; subtract
        // the live-measured brokerOffsetSec before serving. With the current
        // Exness-MT5Trial6 feed (offset ≈ 0) served values are unchanged.
        const offsetSec = snapshot().brokerOffsetSec;
        const bars = fetched.bars.map((b, i) => {
          const last = i === fetched.bars.length - 1;
          const forming = last && fetched.formingCount > 0 && b.time === fetched.bars[fetched.bars.length - 1].time;
          return {
            t: b.time - offsetSec, // UTC-normalized bar open
            o: b.open, h: b.high, l: b.low, c: b.close,
            v: b.tickVolume,
            f: forming ? 1 : 0,
          };
        });
        return json(null, 200, {
          symbol: fetched.symbol,
          tf: fetched.tf,
          digits: fetched.digits,
          source: "mt5",
          bars,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = msg.startsWith("SYMBOL_NOT_FOUND") ? "SYMBOL_NOT_FOUND"
          : msg.startsWith("TIMEFRAME_NOT_SUPPORTED") ? "TIMEFRAME_NOT_SUPPORTED"
          : "BRIDGE_UNAVAILABLE";
        return json(null, 503, { ok: false, error: code, detail: msg });
      }
    }

    return json(null, 404, { ok: false, error: "NOT_FOUND", detail: path });
  },
});

console.log(`[mt5-bridge] READ-ONLY bridge listening on :${PORT} (GET only, x-trader-key auth)`);
console.log(`[mt5-bridge] server=${config.server} watchlist=${config.watchlist.join(",")} gateways=${config.gateways.length}`);
if (!TOKEN) console.warn("[mt5-bridge] MT5_BRIDGE_TOKEN not set — all data endpoints fail closed (401).");

// First connection attempt (manager re-arms itself on failure).
connect().catch((e) => {
  console.error(`[mt5-bridge] initial connect failed: ${e instanceof Error ? e.message : e} (retrying in background)`);
});

process.on("SIGINT", () => { stop(); server.stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); server.stop(); process.exit(0); });
