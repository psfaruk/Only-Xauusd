/**
 * mt5-bridge — session manager (Phase 8 core + gated Phase 11 order layer)
 * ----------------------------------------------------------------------------
 * Owns the broker session lifecycle:
 *   connect (gateway failover) → AUTH → LOGIN → ACCOUNT → SYMBOLS → SUBSCRIBE
 *   → heartbeat loop → quote cache → candle fetching (windowed, paginated)
 *
 * Security: credentials arrive via env only, live in memory only, are never
 * logged and never returned by any endpoint (status reports the server name
 * and a MASKED login).
 *
 * Phase 11 order layer (Task 30-b): market BUY/SELL with SL/TP, close-by-
 * position-id and position listing — all DEAD unless BRIDGE_ORDERS_ENABLED is
 * EXACTLY 'true' or '1' (default: read-only, byte-identical to Phase 8).
 * Hard limits live HERE (defense in depth — the REST layer validates the same
 * rules first): watchlist symbol allowlist, lots ∈ [0.01, BRIDGE_MAX_ORDER_LOTS
 * clamped to 0.01–1.0], 0.01 volume step, ≤ 32-char comments, fresh-quote
 * pricing. No pending orders, no modify, no cancel, no transfers — those
 * shapes simply do not exist in this file.
 */

import {
  Mt5WsClient, TF_CODE,
  type AccountInfo, type Mt5Candle, type PositionInfo, type SymbolInfo,
  type TradeRequest, type TradeResult,
} from "./mt5-client";

/** Exness-MT5Trial6 access IPs (verified gateway set, PROTOCOL.md §1). */
const DEFAULT_GATEWAYS = [
  "47.130.41.116", "57.182.183.85", "16.79.3.122", "18.61.99.175",
  "8.219.172.6", "47.236.224.248", "47.81.62.132", "43.210.112.100", "35.154.31.85",
].join(",");

/** Broker→UTC offset in seconds. Exness trial empirically UTC+0; verified at
 *  runtime from live quote timestamps when the market is open. */
let brokerOffsetSec = 0;
let brokerOffsetVerified = false;

export interface CachedQuote {
  symbol: string;
  symbolId: number;
  digits: number;
  bid: number;   // real price (raw ÷ 10^digits)
  ask: number;
  mid: number;
  spread: number; // price units (ask − bid)
  brokerTimeSec: number;
  receivedAtMs: number;
}

export interface BridgeStateSnapshot {
  connected: boolean;
  source: "mt5" | "disconnected";
  authenticated: boolean;
  server: string | null;
  gateway: string | null;
  loginMasked: string | null;
  accountCurrency: string | null;
  accountGroup: string | null;
  // Phase 11 — financial state for the app-side risk gate (not secrets).
  accountBalance: number | null;
  accountEquity: number | null;
  latencyMs: number | null;
  serverTimeSec: number | null;   // broker time estimate (local + offset)
  brokerOffsetSec: number;
  brokerOffsetVerified: boolean;
  symbolsLoaded: number;
  watchlist: string[];
  reconnects: number;
  lastError: string | null;
  lastErrorAtMs: number | null;
  lastQuoteAtMs: number | null;
  quoteCount: number;
  uptimeMs: number;
  candleRequestsServed: number;
  candleCacheHits: number;
  // Phase 11 order layer (observability; routes stay dead unless armed)
  ordersEnabled: boolean;
  ordersMaxLots: number;
  orderRequests: number;
  ordersAccepted: number;
  lastOrderResult: OrderOutcomeRecord | null;
}

const startedAtMs = Date.now();

// ── runtime state (single session, mutex-guarded connect) ───────────────────
let client: Mt5WsClient | null = null;
let account: AccountInfo | null = null;
let symbolTable = new Map<string, SymbolInfo>();
let quoteCache = new Map<string, CachedQuote>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
// Phase 11 — periodic ACCOUNT refresh keeps balance/equity fresh for the
// app-side risk gate (never logs; the payload carries no credentials).
let accountTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connecting = false;
let reconnects = 0;
let lastError: string | null = null;
let lastErrorAtMs: number | null = null;
let lastQuoteAtMs: number | null = null;
let quoteCount = 0;
let candleRequestsServed = 0;
let candleCacheHits = 0;
let loginMasked: string | null = null;
let stopped = false;

// ── Phase 11 order layer state (all DEAD unless ordersEnabled) ───────────────

/**
 * Orders are DISABLED unless BRIDGE_ORDERS_ENABLED is EXACTLY 'true' or '1'.
 * Unset (or any other value) → the bridge behaves exactly like the Phase 8
 * read-only bridge: every function below refuses, and index.ts never even
 * registers the POST routes. Fail-closed by construction.
 */
export const ordersEnabled =
  process.env.BRIDGE_ORDERS_ENABLED === "true" || process.env.BRIDGE_ORDERS_ENABLED === "1";

/** Per-order volume ceiling: BRIDGE_MAX_ORDER_LOTS (default 0.10) itself
 *  clamped to [0.01, 1.0] — a misconfigured ceiling can never open the gates. */
export const maxOrderLots = (() => {
  const raw = Number(process.env.BRIDGE_MAX_ORDER_LOTS ?? 0.10);
  if (!Number.isFinite(raw)) return 0.10;
  return Math.min(1.0, Math.max(0.01, raw));
})();

const MIN_ORDER_LOTS = 0.01;
const ORDER_LOTS_STEP = 0.01;
const ORDER_COMMENT_MAX_CHARS = 32;      // 64-byte UTF-16LE wire field
const QUOTE_STALE_FOR_ORDER_MS = 30_000; // never price an order off a stale tick

/** JSON-safe, secret-free record of the last order attempt (status surface). */
export interface OrderOutcomeRecord {
  atUtc: string;
  action: "OPEN" | "CLOSE";
  symbol: string;
  type: "BUY" | "SELL";
  lots: number;
  retcode: number;
  accepted: boolean;
  finalEvent: boolean;
  dealId: string | null;
  orderId: string | null;
  price: number | null;
  comment: string; // sanitized + length-capped (contains no secrets by design)
}

let orderRequests = 0;  // validated submissions that reached the wire
let ordersAccepted = 0; // final retcode 10009
let lastOrderResult: OrderOutcomeRecord | null = null;

/** Bounded candle cache: symbol+tf+windowMs → {bars, cachedAtMs}. */
const CANDLE_TTL_MS = 10_000;
const candleCache = new Map<string, { bars: Mt5Candle[]; cachedAtMs: number }>();
const MAX_CANDLE_CACHE_KEYS = 32;

export const config = {
  gateways: (process.env.MT5_GATEWAYS ?? DEFAULT_GATEWAYS).split(",").map((s) => s.trim()).filter(Boolean),
  login: Number(process.env.MT5_LOGIN ?? 0),
  password: process.env.MT5_PASSWORD ?? "",
  server: process.env.MT5_SERVER ?? "Exness-MT5Trial6",
  watchlist: (process.env.MT5_WATCHLIST ?? "XAUUSDm").split(",").map((s) => s.trim()).filter(Boolean),
  heartbeatMs: Number(process.env.MT5_HEARTBEAT_MS ?? 4000),
  maxBarsPerWindow: 4000, // below the broker's observed ~7000-14000 bar ceiling
};

function noteError(msg: string) {
  lastError = msg;
  lastErrorAtMs = Date.now();
}

export function snapshot(): BridgeStateSnapshot {
  const brokerNow = Math.floor(Date.now() / 1000) + brokerOffsetSec;
  return {
    connected: !!client?.isOpen,
    source: client?.isOpen && symbolTable.size > 0 ? "mt5" : "disconnected",
    authenticated: client?.isOpen === true && symbolTable.size > 0,
    server: account?.server ?? (client?.isOpen ? config.server : null),
    gateway: client?.host ?? null,
    loginMasked,
    accountCurrency: account?.currency ?? null,
    accountGroup: account?.group ?? null,
    // Phase 11 — account financial state for the app-side risk gate (NOT
    // secrets: balance/equity are required inputs for position sizing).
    // Values are the last successful ACCOUNT observation; honest nulls before
    // the first fetch.
    accountBalance: account?.balance ?? null,
    accountEquity: account?.equity ?? null,
    latencyMs: client?.lastHeartbeatRttMs ?? null,
    serverTimeSec: client?.isOpen ? brokerNow : null,
    brokerOffsetSec,
    brokerOffsetVerified,
    symbolsLoaded: symbolTable.size,
    watchlist: config.watchlist,
    reconnects,
    lastError,
    lastErrorAtMs,
    lastQuoteAtMs,
    quoteCount,
    uptimeMs: Date.now() - startedAtMs,
    candleRequestsServed,
    candleCacheHits,
    ordersEnabled,
    ordersMaxLots: maxOrderLots,
    orderRequests,
    ordersAccepted,
    lastOrderResult,
  };
}

export function getQuote(symbol: string): CachedQuote | null {
  return quoteCache.get(symbol) ?? null;
}

export function getSymbolInfo(symbol: string): SymbolInfo | null {
  return symbolTable.get(symbol) ?? null;
}

export function listSymbols(): string[] {
  return [...symbolTable.keys()].sort();
}

/** All watchlist symbols that actually exist in the broker table (exact names). */
export function resolvableWatchlist(): string[] {
  return config.watchlist.filter((s) => symbolTable.has(s));
}

function handleQuote(symbolId: number, timeSec: number, bidRaw: number, askRaw: number) {
  // Resolve the symbol from the table — quotes for unknown ids are ignored
  // (never guessed, never mapped by position).
  for (const info of symbolTable.values()) {
    if (info.id !== symbolId) continue;
    const div = Math.pow(10, info.digits);
    const bid = bidRaw / div;
    const ask = askRaw / div;
    // Reject degenerate quotes up-front: non-positive or crossed prices are
    // recorded as an error, never cached as a "fresh" price.
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
      noteError(`degenerate quote ${info.name}: bid=${bid} ask=${ask}`);
      return;
    }
    const prev = quoteCache.get(info.name);
    // Out-of-order detection: a quote older than the cached one is a broker
    // replay/repair — keep the newer observation.
    if (prev && prev.brokerTimeSec > timeSec) {
      noteError(`out-of-order quote ${info.name}: ${timeSec} < cached ${prev.brokerTimeSec}`);
      return;
    }
    quoteCache.set(info.name, {
      symbol: info.name,
      symbolId: info.id,
      digits: info.digits,
      bid, ask,
      mid: (bid + ask) / 2,
      spread: ask - bid,
      brokerTimeSec: timeSec,
      receivedAtMs: Date.now(),
    });
    quoteCount++;
    lastQuoteAtMs = Date.now();
    // Broker→UTC offset: live quote time vs local receipt (only while data
    // actually flows; ±2s tolerance before we claim the offset verified).
    const localSec = Date.now() / 1000;
    const measured = Math.round(timeSec - localSec);
    if (Math.abs(measured - brokerOffsetSec) > 2) {
      brokerOffsetSec = measured;
    }
    brokerOffsetVerified = true;
    return;
  }
}

async function connectOnce(gateway: string): Promise<Mt5WsClient> {
  const ws = await Mt5WsClient.connect(gateway);
  ws.onQuotes((q) => handleQuote(q.symbolId, q.timeSec, q.bid, q.ask));
  ws.onClose(() => {
    noteError(`session closed (gateway ${gateway})`);
    if (client === ws) {
      client = null;
      scheduleReconnect();
    }
  });
  await ws.auth();
  if (!config.login || !config.password) {
    ws.close();
    throw new Error("MT5_LOGIN / MT5_PASSWORD not configured");
  }
  await ws.login(config.login, config.password);
  const acct = await ws.account();
  account = acct;
  loginMasked = String(config.login).replace(/^(\d{3})\d+(\d{2})$/, "$1•••$2");
  const table = await ws.symbols();
  symbolTable = table;
  client = ws;

  // Subscribe every watchlist symbol that EXISTS (exact-name resolution).
  const ids = resolvableWatchlist()
    .map((s) => symbolTable.get(s)!.id);
  if (ids.length) ws.subscribe(...ids);

  // Heartbeat keeps the session alive and measures round-trip latency.
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (client?.isOpen) {
      try { client.heartbeat(); } catch { /* close handler deals with it */ }
    }
  }, config.heartbeatMs);

  // Phase 11 — keep account balance/equity fresh for the risk gate (every
  // 60 s, best-effort; failures keep the last observation and never log
  // secrets — the ACCOUNT payload contains no credentials).
  if (accountTimer) clearInterval(accountTimer);
  accountTimer = setInterval(() => {
    if (client?.isOpen) {
      void client
        .account()
        .then((a) => { account = a; })
        .catch(() => undefined);
    }
  }, 60_000);
  return ws;
}

export async function connect(): Promise<void> {
  if (connecting || client?.isOpen || stopped) return;
  connecting = true;
  try {
    let lastFail = "no gateway attempted";
    for (const gw of config.gateways) {
      try {
        await connectOnce(gw);
        lastError = null; // successful session clears the sticky error
        connecting = false;
        return;
      } catch (e) {
        lastFail = e instanceof Error ? e.message : String(e);
        noteError(`gateway ${gw}: ${lastFail}`);
      }
    }
    throw new Error(`all gateways failed — last: ${lastFail}`);
  } catch (e) {
    connecting = false;
    scheduleReconnect();
    throw e;
  }
}

let backoffMs = 2000;
function scheduleReconnect() {
  if (stopped || reconnectTimer || client?.isOpen) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 30_000);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    reconnects++;
    try { await connect(); backoffMs = 2000; }
    catch { /* scheduleReconnect already re-armed */ }
  }, delay);
}

export function stop() {
  stopped = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  client?.close();
}

// ── candles ─────────────────────────────────────────────────────────────────

export interface CandleFetch {
  symbol: string;
  tf: string;              // M1 | M5 | M15 | M30 | H1 | H4
  bars: Mt5Candle[];       // ascending by open time, broker time
  digits: number;
  formingCount: number;    // bars whose close-time is in the broker future
  windowFromSec: number;
  windowToSec: number;
  paginated: boolean;
}

const TF_SECONDS: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400,
};

/**
 * Fetch the most recent `limit` bars of `symbol`/`tf` from the broker.
 * Windows are bounded (≤ maxBarsPerWindow per request) and paginated when
 * the requested count exceeds a single window. The forming bar (the one
 * still open at the broker) is returned LAST and counted separately.
 */
export async function fetchCandles(symbol: string, tf: string, limit: number): Promise<CandleFetch> {
  const info = symbolTable.get(symbol);
  if (!info) throw new Error(`SYMBOL_NOT_FOUND: ${symbol} not in broker symbol table`);
  const code = TF_CODE[tf];
  const dur = TF_SECONDS[tf];
  if (!code || !dur) throw new Error(`TIMEFRAME_NOT_SUPPORTED: ${tf}`);
  if (!client?.isOpen) throw new Error("not connected");

  const cacheKey = `${symbol}|${tf}|${limit}`;
  const hit = candleCache.get(cacheKey);
  if (hit && Date.now() - hit.cachedAtMs < CANDLE_TTL_MS) {
    candleCacheHits++;
    candleRequestsServed++;
    return {
      symbol, tf, digits: info.digits,
      bars: hit.bars,
      formingCount: countForming(hit.bars, dur),
      windowFromSec: hit.bars.length ? hit.bars[0].time : 0,
      windowToSec: hit.bars.length ? hit.bars[hit.bars.length - 1].time : 0,
      paginated: false,
    };
  }

  const brokerNow = Math.floor(Date.now() / 1000) + brokerOffsetSec;
  const toSec = brokerNow + dur; // include the currently-forming bar
  const byTime = new Map<number, Mt5Candle>();
  let windowStart = toSec - Math.min(limit, config.maxBarsPerWindow) * dur;
  let paginated = false;

  while (byTime.size < limit) {
    const win = await client.candles(symbol, code, windowStart, toSec);
    if (!win.length) break;
    // Merge by open-time (a later window can return OLDER bars — append-only
    // merging would silently drop them; the map dedupes and keeps every bar).
    for (const b of win) byTime.set(b.time, b);
    if (byTime.size >= limit) break;
    paginated = true;
    const earliest = Math.min(...byTime.keys());
    const nextStart = earliest - Math.min(limit - byTime.size, config.maxBarsPerWindow) * dur;
    // No progress (or ran off the clock) → stop instead of looping.
    if (nextStart >= windowStart || nextStart <= 0) break;
    windowStart = nextStart;
  }

  const all = [...byTime.values()].sort((a, b) => a.time - b.time);

  const bars = all.slice(-limit).sort((a, b) => a.time - b.time);
  // cache bounded
  if (candleCache.size >= MAX_CANDLE_CACHE_KEYS) {
    const oldest = candleCache.keys().next().value;
    if (oldest) candleCache.delete(oldest);
  }
  candleCache.set(cacheKey, { bars, cachedAtMs: Date.now() });
  candleRequestsServed++;

  return {
    symbol, tf, digits: info.digits,
    bars,
    formingCount: countForming(bars, dur),
    windowFromSec: bars.length ? bars[0].time : 0,
    windowToSec: bars.length ? bars[bars.length - 1].time : 0,
    paginated,
  };
}

function countForming(bars: Mt5Candle[], durSec: number): number {
  const brokerNow = Math.floor(Date.now() / 1000) + brokerOffsetSec;
  let n = 0;
  for (const b of bars) if (b.time + durSec > brokerNow) n++;
  return n;
}

// ── Phase 11 order layer (every path re-checks ordersEnabled first) ──────────

/** Shared outcome shape for open and close round trips. */
export interface OrderExecutionOutcome {
  symbol: string;
  type: "BUY" | "SELL";       // side of THIS order (close = opposite side)
  lots: number;               // requested volume
  requestedPrice: number;     // quote used at submission (ask for BUY / bid for SELL)
  retcode: number;
  immediateRetcode: number;
  finalEvent: boolean;
  accepted: boolean;
  dealId: string | null;
  orderId: string | null;
  price: number | null;       // execution price (final event only)
  dealtLots: number | null;   // deal volume (final event only)
  dealVolumeRaw: string;
  comment: string | null;     // broker comment from the final event
}

export interface PlaceOrderParams {
  symbol: string;
  type: "BUY" | "SELL";
  lots: number;
  sl?: number;   // 0 / omitted = none
  tp?: number;   // 0 / omitted = none
  comment?: string;
}

/** Strip control characters and cap length — the only "masking" a caller
 *  comment needs (comments never contain credentials by construction). */
function sanitizeComment(c: string | undefined): string {
  if (!c) return "";
  return c.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, ORDER_COMMENT_MAX_CHARS);
}

/** Log + remember the outcome of an order round trip (no secrets in this path). */
function recordOrderOutcome(
  action: "OPEN" | "CLOSE",
  symbol: string,
  type: "BUY" | "SELL",
  lots: number,
  comment: string | undefined,
  r: TradeResult,
): OrderOutcomeRecord {
  const rec: OrderOutcomeRecord = {
    atUtc: new Date().toISOString(),
    action, symbol, type, lots,
    retcode: r.retcode,
    accepted: r.accepted,
    finalEvent: r.finalEvent,
    dealId: r.dealId,
    orderId: r.orderId,
    price: r.price,
    comment: sanitizeComment(comment),
  };
  lastOrderResult = rec;
  console.log(
    `[order] ${action} ${symbol} ${type} ${lots} → retcode=${r.retcode} accepted=${r.accepted} ` +
    `finalEvent=${r.finalEvent} deal=${r.dealId ?? "-"} order=${r.orderId ?? "-"} ` +
    `price=${r.price ?? "-"} comment="${rec.comment}"`,
  );
  return rec;
}

function validateOrderVolume(lots: number): number {
  if (typeof lots !== "number" || !Number.isFinite(lots)) throw new Error("BAD_LOTS: lots must be a finite number");
  if (lots < MIN_ORDER_LOTS - 1e-9) throw new Error(`LOTS_TOO_SMALL: minimum is ${MIN_ORDER_LOTS} lots`);
  if (lots > maxOrderLots + 1e-9) throw new Error(`LOTS_TOO_LARGE: maximum is ${maxOrderLots} lots (BRIDGE_MAX_ORDER_LOTS)`);
  if (Math.abs(lots / ORDER_LOTS_STEP - Math.round(lots / ORDER_LOTS_STEP)) > 1e-6) {
    throw new Error(`LOTS_STEP_INVALID: volume must align to the ${ORDER_LOTS_STEP} lot step`);
  }
  return Math.round(lots * 100) / 100;
}

function requireFreshQuote(symbol: string): CachedQuote {
  const q = getQuote(symbol);
  if (!q) throw new Error(`QUOTE_UNAVAILABLE: no live quote for ${symbol} (not subscribed or no tick received yet)`);
  const ageMs = Date.now() - q.receivedAtMs;
  if (ageMs > QUOTE_STALE_FOR_ORDER_MS) {
    throw new Error(`QUOTE_STALE: last ${symbol} quote is ${Math.round(ageMs / 1000)}s old (limit ${QUOTE_STALE_FOR_ORDER_MS / 1000}s) — refusing to price an order off it`);
  }
  return q;
}

/**
 * Place ONE market order (BUY/SELL with optional SL/TP) on a WATCHLIST symbol.
 * This is the ONLY open-exposure path in the bridge; every clamp is re-checked
 * here (defense in depth — the REST layer validates the same rules first).
 */
export async function placeMarketOrder(params: PlaceOrderParams): Promise<OrderExecutionOutcome> {
  if (!ordersEnabled) throw new Error("ORDER_LAYER_DISABLED: BRIDGE_ORDERS_ENABLED is not 'true'/'1'");
  if (!client?.isOpen) throw new Error("NOT_CONNECTED: no authenticated broker session");
  if (typeof params.symbol !== "string" || params.symbol.length === 0) throw new Error("BAD_SYMBOL: symbol must be a non-empty string");
  if (!config.watchlist.includes(params.symbol)) {
    throw new Error(`SYMBOL_NOT_TRADEABLE: ${params.symbol} is not in the MT5_WATCHLIST allowlist (${config.watchlist.join(", ")})`);
  }
  const info = symbolTable.get(params.symbol);
  if (!info) throw new Error(`SYMBOL_NOT_FOUND: ${params.symbol} is missing from the broker symbol table`);
  if (params.type !== "BUY" && params.type !== "SELL") throw new Error("BAD_TYPE: type must be 'BUY' or 'SELL'");
  if (params.comment !== undefined && (typeof params.comment !== "string" || params.comment.length > ORDER_COMMENT_MAX_CHARS)) {
    throw new Error(`BAD_COMMENT: optional comment must be a string of at most ${ORDER_COMMENT_MAX_CHARS} characters`);
  }
  const lots = validateOrderVolume(params.lots);
  const sl = params.sl ?? 0;
  const tp = params.tp ?? 0;
  if (typeof sl !== "number" || !Number.isFinite(sl) || sl < 0) throw new Error("BAD_SL: sl must be a finite non-negative price (0 = none)");
  if (typeof tp !== "number" || !Number.isFinite(tp) || tp < 0) throw new Error("BAD_TP: tp must be a finite non-negative price (0 = none)");

  const quote = requireFreshQuote(params.symbol);
  const price = params.type === "BUY" ? quote.ask : quote.bid;
  // Directional sanity — the broker would reject wrong-side stops anyway; we
  // refuse early with a precise error instead.
  if (sl > 0 && params.type === "BUY" && sl >= price) throw new Error(`BAD_SL: a BUY stop-loss must sit BELOW the current ask (${price})`);
  if (sl > 0 && params.type === "SELL" && sl <= price) throw new Error(`BAD_SL: a SELL stop-loss must sit ABOVE the current bid (${price})`);
  if (tp > 0 && params.type === "BUY" && tp <= price) throw new Error(`BAD_TP: a BUY take-profit must sit ABOVE the current ask (${price})`);
  if (tp > 0 && params.type === "SELL" && tp >= price) throw new Error(`BAD_TP: a SELL take-profit must sit BELOW the current bid (${price})`);

  orderRequests++;
  const r = await client.trade({
    symbol: params.symbol, type: params.type, lots, price, digits: info.digits,
    sl, tp, comment: params.comment,
  } satisfies TradeRequest);
  if (r.accepted) ordersAccepted++;
  recordOrderOutcome("OPEN", params.symbol, params.type, lots, params.comment, r);
  return {
    symbol: params.symbol, type: params.type, lots, requestedPrice: price,
    retcode: r.retcode, immediateRetcode: r.immediateRetcode, finalEvent: r.finalEvent,
    accepted: r.accepted, dealId: r.dealId, orderId: r.orderId, price: r.price,
    dealtLots: r.dealtLots, dealVolumeRaw: r.dealVolumeRaw, comment: r.comment,
  };
}

export interface ClosePositionOutcome extends OrderExecutionOutcome {
  positionId: string;
  /** Advisory post-verification: true = still open after an accepted close,
   *  false = gone, null = could not verify. Never falsifies `accepted`. */
  positionStillOpen: boolean | null;
}

/**
 * Close ONE open position by id: full volume, OPPOSITE side, trade_action 3
 * (MARKET — the reference proves action 10 "CLOSE" returns 10030),
 * trade_position = position id, priced at the current bid (closing BUY) / ask
 * (closing SELL).
 *
 * Close volume is deliberately NOT clamped to maxOrderLots: closing REDUCES
 * exposure — refusing to close an over-limit position would trap risk. The
 * open-side surface (placeMarketOrder) is where the volume clamps live.
 */
export async function closePosition(positionId: string): Promise<ClosePositionOutcome> {
  if (!ordersEnabled) throw new Error("ORDER_LAYER_DISABLED: BRIDGE_ORDERS_ENABLED is not 'true'/'1'");
  if (!client?.isOpen) throw new Error("NOT_CONNECTED: no authenticated broker session");
  if (typeof positionId !== "string" || !/^\d{1,20}$/.test(positionId)) throw new Error("BAD_POSITION_ID: positionId must be a numeric string");

  const positions = await client.positions();
  const pos = positions.find((p) => p.positionId === positionId);
  if (!pos) throw new Error(`POSITION_NOT_FOUND: ${positionId} is not an open position`);
  const info = symbolTable.get(pos.symbol);
  const quote = requireFreshQuote(pos.symbol);

  const type: "BUY" | "SELL" = pos.direction === "BUY" ? "SELL" : "BUY";
  const price = pos.direction === "BUY" ? quote.bid : quote.ask;
  const lots = Math.round(pos.lots * 100) / 100;
  if (lots < MIN_ORDER_LOTS - 1e-9) throw new Error(`POSITION_VOLUME_INVALID: position ${positionId} reports ${pos.lots} lots`);

  orderRequests++;
  const r = await client.trade({
    symbol: pos.symbol, type, lots, price, digits: info?.digits ?? 0,
    sl: 0, tp: 0, comment: "phase11-close", closePositionId: BigInt(positionId),
  } satisfies TradeRequest);
  if (r.accepted) ordersAccepted++;
  recordOrderOutcome("CLOSE", pos.symbol, type, lots, "phase11-close", r);

  // Advisory post-verification: an accepted close should remove the position.
  // One re-check after a short settle delay; failures here never flip
  // `accepted` — they surface as positionStillOpen=true/null for the caller.
  let positionStillOpen: boolean | null = null;
  if (r.accepted) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        positionStillOpen = (await client.positions()).some((p) => p.positionId === positionId);
      } catch {
        positionStillOpen = null;
        break;
      }
      if (!positionStillOpen) break;
      await new Promise((res) => setTimeout(res, 400)); // let the broker settle
    }
  }
  return {
    positionId,
    positionStillOpen,
    symbol: pos.symbol, type, lots, requestedPrice: price,
    retcode: r.retcode, immediateRetcode: r.immediateRetcode, finalEvent: r.finalEvent,
    accepted: r.accepted, dealId: r.dealId, orderId: r.orderId, price: r.price,
    dealtLots: r.dealtLots, dealVolumeRaw: r.dealVolumeRaw, comment: r.comment,
  };
}

/**
 * List open positions for the REST surface. Client record times are broker
 * server times; they are normalized to UTC with the live-measured offset
 * (same rule as quotes/candles — Exness trial ≈ UTC, verified ≈ 0).
 */
export async function listPositions(): Promise<PositionInfo[]> {
  if (!ordersEnabled) throw new Error("ORDER_LAYER_DISABLED: BRIDGE_ORDERS_ENABLED is not 'true'/'1'");
  if (!client?.isOpen) throw new Error("NOT_CONNECTED: no authenticated broker session");
  const raw = await client.positions();
  return raw.map((p) => ({
    ...p,
    timeCreateUtcSec: p.timeCreateUtcSec > 0 ? p.timeCreateUtcSec - brokerOffsetSec : 0,
    timeUpdateUtcSec: p.timeUpdateUtcSec > 0 ? p.timeUpdateUtcSec - brokerOffsetSec : 0,
  }));
}
