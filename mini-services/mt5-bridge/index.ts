/**
 * mt5-bridge — REST surface (Phase 8 read-only core + gated Phase 11 order
 * endpoints), port 3031.
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
 * PHASE 11 ORDER LAYER (Task 30-b) — every endpoint below is DEAD unless the
 * env BRIDGE_ORDERS_ENABLED is exactly 'true' or '1' (default: the bridge
 * behaves byte-identically to the Phase 8 read-only bridge — non-GET → 405,
 * unknown paths → 404):
 *   GET  /api/positions                          (auth; 403 when disabled)
 *   POST /api/order                              (auth; 405 when disabled)
 *   POST /api/position-close                     (auth; 405 when disabled)
 * The order surface is limited BY CONSTRUCTION to market BUY/SELL with SL/TP,
 * close-by-position-id and position listing — no pending orders, no modify,
 * no cancel, no account transfers. Credentials never appear in responses,
 * logs or errors; the login is reported masked only; order logs carry a
 * sanitized comment and never any secret.
 */

import {
  connect, snapshot, getQuote, getSymbolInfo, listSymbols, resolvableWatchlist,
  fetchCandles, stop, config,
  ordersEnabled, maxOrderLots, placeMarketOrder, closePosition, listPositions,
} from "./src/manager";

const PORT = 3031;
const TOKEN = process.env.MT5_BRIDGE_TOKEN ?? "";

/** The only POST-able paths in the bridge — and only while the Phase 11 gate
 *  is armed. Anything else stays GET-only (byte-identical to Phase 8 when the
 *  gate is unset). */
const ORDER_POST_PATHS = new Set(["/api/order", "/api/position-close"]);
const ORDER_BODY_FIELDS = new Set(["symbol", "type", "lots", "sl", "tp", "comment"]);
const CLOSE_BODY_FIELDS = new Set(["positionId"]);

function json(_ctx: unknown, status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-bridge-readonly": "1",
      ...(headers ?? {}),
    },
  });
}

/** Response from the (armed) order layer — x-bridge-readonly honestly 0. */
function tjson(status: number, body: unknown): Response {
  return json(null, status, body, { "x-bridge-readonly": "0" });
}

function authorized(req: Request): boolean {
  if (!TOKEN) return false; // fail-closed: no token configured → nothing served
  return req.headers.get("x-trader-key") === TOKEN;
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type StrictBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

/** Read a JSON object body with strict shape rules (≤ 4 KB, object only,
 *  unknown fields rejected). */
async function readStrictJsonBody(req: Request, allowedFields: Set<string>): Promise<StrictBodyResult> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return { ok: false, response: tjson(400, { ok: false, error: "UNSUPPORTED_MEDIA_TYPE", detail: "content-type must be application/json" }) };
  }
  const text = await req.text();
  if (text.length > 4096) {
    return { ok: false, response: tjson(400, { ok: false, error: "REQUEST_TOO_LARGE", detail: "body must be at most 4096 bytes" }) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    return { ok: false, response: tjson(400, { ok: false, error: "INVALID_JSON", detail: "body is not valid JSON" }) };
  }
  if (!isJsonObject(parsed)) {
    return { ok: false, response: tjson(400, { ok: false, error: "INVALID_BODY", detail: "body must be a JSON object" }) };
  }
  const unknownFields = Object.keys(parsed).filter((k) => !allowedFields.has(k));
  if (unknownFields.length) {
    return { ok: false, response: tjson(400, { ok: false, error: "UNKNOWN_FIELD", detail: `unknown field(s): ${unknownFields.join(", ")} (allowed: ${[...allowedFields].join(", ")})` }) };
  }
  return { ok: true, body: parsed };
}

const ORDER_LAYER_DISABLED_DETAIL = "the Phase 11 order layer is not armed — set BRIDGE_ORDERS_ENABLED=true and restart the bridge";

/** Map a manager/client error (code-prefixed message) to an honest HTTP
 *  response. A completed-but-rejected trade is NOT an HTTP error (it returns
 *  200 with accepted=false); this maps request/transport/validation failures. */
function orderErrorToResponse(e: unknown): Response {
  const msg = e instanceof Error ? e.message : String(e);
  const code = /^[A-Z][A-Z0-9_]+(?=:|$)/.exec(msg)?.[0] ?? "BRIDGE_UNAVAILABLE";
  if (code === "ORDER_LAYER_DISABLED") {
    return tjson(403, { ok: false, error: code, detail: ORDER_LAYER_DISABLED_DETAIL });
  }
  if (code === "POSITION_NOT_FOUND") return tjson(404, { ok: false, error: code, detail: msg });
  if (code === "NOT_CONNECTED" || code === "QUOTE_UNAVAILABLE" || code === "QUOTE_STALE") {
    return tjson(503, { ok: false, error: code, detail: msg });
  }
  if (/^(BAD_|LOTS_|SYMBOL_NOT_|POSITION_VOLUME_)/.test(code)) {
    return tjson(400, { ok: false, error: code, detail: msg });
  }
  return tjson(503, { ok: false, error: "BRIDGE_UNAVAILABLE", detail: msg });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    if (method !== "GET" && !(ordersEnabled && method === "POST" && ORDER_POST_PATHS.has(path))) {
      return json(null, 405, {
        ok: false,
        error: "METHOD_NOT_ALLOWED",
        detail: ordersEnabled
          ? "bridge methods: GET (market data) + POST /api/order + POST /api/position-close (Phase 11 order layer)"
          : "read-only bridge: GET only",
      });
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
        // Phase 11 — account financial state for the app-side risk gate
        // (position sizing). Not secrets: balance/equity in account currency.
        accountBalance: s.accountBalance ?? null,
        accountEquity: s.accountEquity ?? null,
        brokerOffsetVerified: s.brokerOffsetVerified,
        watchlist: s.watchlist,
        watchlistResolved: resolvableWatchlist(),
        reconnects: s.reconnects,
        lastError: s.lastError,
        lastErrorAtMs: s.lastErrorAtMs,
        lastQuoteAtMs: s.lastQuoteAtMs,
        quoteCount: s.quoteCount,
        uptimeMs: s.uptimeMs,
        // Phase 11 order layer observability (endpoints stay dead unless armed):
        ordersEnabled: s.ordersEnabled,
        ordersMaxLots: s.ordersMaxLots,
        orderRequests: s.orderRequests,
        ordersAccepted: s.ordersAccepted,
        lastOrderResult: s.lastOrderResult,
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

    // ── Phase 11 order layer (auth + ordersEnabled; see file header) ────────

    // GET /api/positions — open-position listing (gated; 403 when disabled)
    if (path === "/api/positions") {
      if (!ordersEnabled) {
        return json(null, 403, { ok: false, error: "ORDER_LAYER_DISABLED", detail: ORDER_LAYER_DISABLED_DETAIL });
      }
      try {
        const positions = await listPositions();
        return tjson(200, { ok: true, source: "mt5", count: positions.length, positions });
      } catch (e) {
        return orderErrorToResponse(e);
      }
    }

    // POST /api/order — ONE market order (BUY/SELL, optional SL/TP)
    if (ordersEnabled && path === "/api/order") {
      if (method !== "POST") {
        return tjson(405, { ok: false, error: "METHOD_NOT_ALLOWED", detail: "POST only" });
      }
      const parsed = await readStrictJsonBody(req, ORDER_BODY_FIELDS);
      if (!parsed.ok) return parsed.response;
      const b = parsed.body;
      const symbol = b.symbol;
      if (typeof symbol !== "string" || symbol.length === 0 || symbol.length > 32) {
        return tjson(400, { ok: false, error: "BAD_SYMBOL", detail: "symbol must be a non-empty string of at most 32 characters" });
      }
      const type = b.type;
      if (type !== "BUY" && type !== "SELL") {
        return tjson(400, { ok: false, error: "BAD_TYPE", detail: "type must be 'BUY' or 'SELL'" });
      }
      const lots = b.lots;
      if (typeof lots !== "number" || !Number.isFinite(lots)) {
        return tjson(400, { ok: false, error: "BAD_LOTS", detail: "lots must be a finite number" });
      }
      const sl = b.sl ?? 0;
      if (typeof sl !== "number" || !Number.isFinite(sl) || sl < 0) {
        return tjson(400, { ok: false, error: "BAD_SL", detail: "sl must be a finite non-negative price (0 or omitted = none)" });
      }
      const tp = b.tp ?? 0;
      if (typeof tp !== "number" || !Number.isFinite(tp) || tp < 0) {
        return tjson(400, { ok: false, error: "BAD_TP", detail: "tp must be a finite non-negative price (0 or omitted = none)" });
      }
      const comment = b.comment;
      if (comment !== undefined && (typeof comment !== "string" || comment.length > 32)) {
        return tjson(400, { ok: false, error: "BAD_COMMENT", detail: "comment must be a string of at most 32 characters" });
      }
      try {
        const r = await placeMarketOrder({ symbol, type, lots, sl, tp, comment });
        return tjson(200, {
          ok: r.accepted,
          action: "OPEN",
          symbol: r.symbol,
          type: r.type,
          lots: r.lots,
          requestedPrice: r.requestedPrice,
          maxOrderLots,
          retcode: r.retcode,
          immediateRetcode: r.immediateRetcode,
          finalEvent: r.finalEvent,
          accepted: r.accepted,
          dealId: r.dealId,
          orderId: r.orderId,
          price: r.price,
          dealtLots: r.dealtLots,
          dealVolumeRaw: r.dealVolumeRaw,
          comment: r.comment,
        });
      } catch (e) {
        return orderErrorToResponse(e);
      }
    }

    // POST /api/position-close — close ONE position by id (full volume)
    if (ordersEnabled && path === "/api/position-close") {
      if (method !== "POST") {
        return tjson(405, { ok: false, error: "METHOD_NOT_ALLOWED", detail: "POST only" });
      }
      const parsed = await readStrictJsonBody(req, CLOSE_BODY_FIELDS);
      if (!parsed.ok) return parsed.response;
      const positionId = parsed.body.positionId;
      if (typeof positionId !== "string" || !/^\d{1,20}$/.test(positionId)) {
        return tjson(400, { ok: false, error: "BAD_POSITION_ID", detail: "positionId must be a numeric string" });
      }
      try {
        const r = await closePosition(positionId);
        return tjson(200, {
          ok: r.accepted,
          action: "CLOSE",
          positionId: r.positionId,
          positionStillOpen: r.positionStillOpen,
          symbol: r.symbol,
          type: r.type,
          lots: r.lots,
          requestedPrice: r.requestedPrice,
          retcode: r.retcode,
          immediateRetcode: r.immediateRetcode,
          finalEvent: r.finalEvent,
          accepted: r.accepted,
          dealId: r.dealId,
          orderId: r.orderId,
          price: r.price,
          dealtLots: r.dealtLots,
          dealVolumeRaw: r.dealVolumeRaw,
          comment: r.comment,
        });
      } catch (e) {
        return orderErrorToResponse(e);
      }
    }

    return json(null, 404, { ok: false, error: "NOT_FOUND", detail: path });
  },
});

console.log(`[mt5-bridge] ${ordersEnabled ? "bridge listening on :" + PORT + " (GET + gated POST order endpoints, x-trader-key auth)" : "READ-ONLY bridge listening on :" + PORT + " (GET only, x-trader-key auth)"}`);
console.log(`[mt5-bridge] order layer ${ordersEnabled ? `ENABLED — market BUY/SELL + close-by-position only; symbols=${config.watchlist.join(",")}; lots ∈ [0.01, ${maxOrderLots}]` : "DISABLED (BRIDGE_ORDERS_ENABLED is not 'true'/'1') — bridge is read-only"}`);
console.log(`[mt5-bridge] server=${config.server} watchlist=${config.watchlist.join(",")} gateways=${config.gateways.length}`);
if (!TOKEN) console.warn("[mt5-bridge] MT5_BRIDGE_TOKEN not set — all data endpoints fail closed (401).");

// First connection attempt (manager re-arms itself on failure).
connect().catch((e) => {
  console.error(`[mt5-bridge] initial connect failed: ${e instanceof Error ? e.message : e} (retrying in background)`);
});

process.on("SIGINT", () => { stop(); server.stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); server.stop(); process.exit(0); });
