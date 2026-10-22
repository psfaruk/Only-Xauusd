/**
 * mt5-bridge — READ-ONLY market-data REST surface, port 3031.
 * ----------------------------------------------------------------------------
 * Implements the bridge contract consumed by the app
 * (src/lib/market/bridge-client.ts):
 *
 *   GET /health                                  (public)
 *   GET /api/status                              (auth: x-trader-key)
 *   GET /api/symbols                             (auth)
 *   GET /api/quote?symbol=XAUUSDm                (auth)
 *   GET /api/candles?symbol=&tf=&limit=          (auth)
 *   GET /api/candles/range?symbol=&tf=&fromUtc=&toUtc= (auth — Phase 3
 *        historical acquisition; broker-time conversion both ways, span-capped)
 *
 * TASK 33/35 — ADMIN CREDENTIAL SWAP (always available, auth-gated; a session
 * CONFIG endpoint, not an order endpoint — it only (re)connects the market-data
 * session with the given Exness credentials):
 *   POST /admin/credentials {server,login,password} (auth: x-trader-key)
 *   The password never appears in any response, log or error — the response is
 *   the post-reconnect status snapshot (masked login only) + the applied
 *   settingsRevision for drift detection.
 *
 * PHASE 0 DEEP-REMEDIATION (signal-only product contract): the Phase 11 order
 * layer (GET /api/positions, POST /api/order, POST /api/position-close) and
 * every trade/position code path in the manager + ws client were DELETED.
 * This service is a market-DATA gateway by construction — no env toggle can
 * re-enable ordering because the code no longer exists. Non-GET requests
 * (other than /admin/credentials) are rejected 405 before any handler runs.
 */

import {
  connect, snapshot, getQuote, getSymbolInfo, listSymbols, resolvableWatchlist,
  fetchCandles, fetchCandlesRange, stop, config,
  applyCredentials,
} from "./src/manager";

const PORT = 3031;
const TOKEN = process.env.MT5_BRIDGE_TOKEN ?? "";

/** Task 33/35 — admin credential swap path (config endpoint, NOT an order
 *  endpoint: always POST-able while the token is configured). */
const ADMIN_CREDENTIALS_PATH = "/admin/credentials";
const ADMIN_CREDENTIALS_FIELDS = new Set(["server", "login", "password"]);

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
 * unknown fields rejected). */
async function readStrictJsonBody(req: Request, allowedFields: Set<string>): Promise<StrictBodyResult> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return { ok: false, response: json(null, 400, { ok: false, error: "UNSUPPORTED_MEDIA_TYPE", detail: "content-type must be application/json" }) };
  }
  const text = await req.text();
  if (text.length > 4096) {
    return { ok: false, response: json(null, 400, { ok: false, error: "REQUEST_TOO_LARGE", detail: "body must be at most 4096 bytes" }) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    return { ok: false, response: json(null, 400, { ok: false, error: "INVALID_JSON", detail: "body is not valid JSON" }) };
  }
  if (!isJsonObject(parsed)) {
    return { ok: false, response: json(null, 400, { ok: false, error: "INVALID_BODY", detail: "body must be a JSON object" }) };
  }
  const unknownFields = Object.keys(parsed).filter((k) => !allowedFields.has(k));
  if (unknownFields.length) {
    return { ok: false, response: json(null, 400, { ok: false, error: "UNKNOWN_FIELD", detail: `unknown field(s): ${unknownFields.join(", ")} (allowed: ${[...allowedFields].join(", ")})` }) };
  }
  return { ok: true, body: parsed };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    // ── READ-ONLY surface: only /admin/credentials may POST ────────────────
    if (method !== "GET" && !(method === "POST" && path === ADMIN_CREDENTIALS_PATH)) {
      return json(null, 405, {
        ok: false,
        error: "METHOD_NOT_ALLOWED",
        detail: "read-only market-data bridge: GET only (+ POST /admin/credentials for the settings store). Order endpoints do not exist — the bridge is a data gateway by construction.",
      });
    }

    // ── public health (no auth, no data) ────────────────────────────────────
    if (path === "/health") {
      const s = snapshot();
      return json(null, 200, {
        ok: true,
        service: "mt5-bridge",
        version: "2.0.0-signal-only",
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

    // ── Task 33/35 — admin credential swap (settings-store push) ──────────
    // Config endpoint, NOT an order endpoint: always available while the
    // token is configured. Strict body {server, login, password}; the
    // response carries the post-reconnect status with the login MASKED —
    // the password never appears in any response, log or error.
    if (path === ADMIN_CREDENTIALS_PATH && method === "POST") {
      const body = await readStrictJsonBody(req, ADMIN_CREDENTIALS_FIELDS);
      if (!body.ok) return body.response;
      const server = typeof body.body.server === "string" ? body.body.server.trim() : "";
      const loginNum = Number(body.body.login);
      const password = typeof body.body.password === "string" ? body.body.password : "";
      if (!/^[A-Za-z0-9._-]{3,64}$/.test(server) || !Number.isInteger(loginNum) || loginNum <= 0 || password.length < 4) {
        return json(null, 400, {
          ok: false,
          error: "BAD_CREDENTIALS",
          detail: "server (3-64 chars, [A-Za-z0-9._-]), numeric login and password (>=4 chars) required",
        });
      }
      try {
        const snap = await applyCredentials({ server, login: loginNum, password });
        return json(null, 200, {
          ok: true,
          applied: true,
          settingsRevision: snap.settingsRevision,
          connected: snap.connected,
          authenticated: snap.authenticated,
          server: snap.server,
          loginMasked: snap.loginMasked,
          accountCurrency: snap.accountCurrency,
          accountBalance: snap.accountBalance,
          accountEquity: snap.accountEquity,
          symbols: snap.symbolsLoaded,
          reconnects: snap.reconnects,
          lastError: snap.lastError,
        });
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        const safe = raw.replace(/password\s*[:=]?\s*\S+/gi, "password ***");
        return json(null, 503, { ok: false, error: "RECONNECT_FAILED", detail: safe, settingsRevision: snapshot().settingsRevision });
      }
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
        // Account financial state (read-only observation; NOT secrets:
        // balance/equity in account currency — informational in the
        // signal-only product).
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
        // Task 33/35 — applied-credential revision (drift detection)
        settingsRevision: s.settingsRevision,
        // Phase 0 — explicit read-only posture (no order layer exists)
        readOnly: true,
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
      // skew the app timeline.
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
        // the live-measured brokerOffsetSec before serving.
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

    if (path === "/api/candles/range") {
      const symbol = (url.searchParams.get("symbol") ?? "").trim();
      const tf = (url.searchParams.get("tf") ?? "").trim().toUpperCase();
      const fromUtc = Number(url.searchParams.get("fromUtc"));
      const toUtc = Number(url.searchParams.get("toUtc"));
      if (!symbol || !tf) {
        return json(null, 400, { ok: false, error: "BAD_REQUEST", detail: "symbol and tf required" });
      }
      if (!Number.isFinite(fromUtc) || !Number.isFinite(toUtc) || fromUtc <= 0 || toUtc <= 0 || fromUtc >= toUtc) {
        return json(null, 400, { ok: false, error: "BAD_REQUEST", detail: "fromUtc and toUtc must be positive unix seconds (UTC) with fromUtc < toUtc" });
      }
      // Span cap: the range endpoint serves bounded research windows (the
      // 6-month acquisition + retries), not unbounded crawls.
      const MAX_RANGE_SPAN_SEC = 400 * 86400;
      if (toUtc - fromUtc > MAX_RANGE_SPAN_SEC) {
        return json(null, 400, { ok: false, error: "BAD_REQUEST", detail: `range span must be ≤ ${MAX_RANGE_SPAN_SEC}s (~400 days)` });
      }
      // No future windows — the range path is for CLOSED history.
      const nowUtc = Math.floor(Date.now() / 1000);
      if (fromUtc > nowUtc + 3600) {
        return json(null, 400, { ok: false, error: "BAD_REQUEST", detail: "fromUtc is in the future" });
      }
      const info = getSymbolInfo(symbol);
      if (snapshot().connected && !info) {
        return json(null, 404, { ok: false, error: "SYMBOL_NOT_FOUND", detail: `${symbol} not in broker symbol table` });
      }
      try {
        const offsetSec = snapshot().brokerOffsetSec;
        // UTC → broker time for the protocol call; broker → UTC on output
        // (same normalization rule as /api/quote and /api/candles).
        const fetched = await fetchCandlesRange(symbol, tf, fromUtc + offsetSec, toUtc + offsetSec);
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
          fromUtc,
          toUtc,
          paginated: fetched.paginated,
          bars,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = msg.startsWith("SYMBOL_NOT_FOUND") ? "SYMBOL_NOT_FOUND"
          : msg.startsWith("TIMEFRAME_NOT_SUPPORTED") ? "TIMEFRAME_NOT_SUPPORTED"
          : msg.startsWith("BAD_RANGE") ? "BAD_REQUEST"
          : "BRIDGE_UNAVAILABLE";
        const status = code === "BAD_REQUEST" ? 400 : code === "SYMBOL_NOT_FOUND" || code === "TIMEFRAME_NOT_SUPPORTED" ? 404 : 503;
        return json(null, status, { ok: false, error: code, detail: msg });
      }
    }

    return json(null, 404, { ok: false, error: "NOT_FOUND", detail: path });
  },
});

console.log(`[mt5-bridge] READ-ONLY market-data bridge listening on :${PORT} (GET + POST /admin/credentials only, x-trader-key auth)`);
console.log(`[mt5-bridge] order layer REMOVED (Phase 0 signal-only contract) — this service cannot place, close or list broker orders`);
console.log(`[mt5-bridge] server=${config.server} watchlist=${config.watchlist.join(",")} gateways=${config.gateways.length}`);
if (!TOKEN) console.warn("[mt5-bridge] MT5_BRIDGE_TOKEN not set — all data endpoints fail closed (401).");

// First connection attempt (manager re-arms itself on failure).
connect().catch((e) => {
  console.error(`[mt5-bridge] initial connect failed: ${e instanceof Error ? e.message : e} (retrying in background)`);
});

process.on("SIGINT", () => { stop(); server.stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); server.stop(); process.exit(0); });
