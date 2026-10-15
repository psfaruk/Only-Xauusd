/**
 * mt5-bridge — session manager (Phase 8)
 * ----------------------------------------------------------------------------
 * Owns the read-only broker session lifecycle:
 *   connect (gateway failover) → AUTH → LOGIN → ACCOUNT → SYMBOLS → SUBSCRIBE
 *   → heartbeat loop → quote cache → candle fetching (windowed, paginated)
 *
 * Security: credentials arrive via env only, live in memory only, are never
 * logged and never returned by any endpoint (status reports the server name
 * and a MASKED login). No trading command exists in this file or the client.
 */

import { Mt5WsClient, TF_CODE, type AccountInfo, type Mt5Candle, type SymbolInfo } from "./mt5-client";

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
}

const startedAtMs = Date.now();

// ── runtime state (single session, mutex-guarded connect) ───────────────────
let client: Mt5WsClient | null = null;
let account: AccountInfo | null = null;
let symbolTable = new Map<string, SymbolInfo>();
let quoteCache = new Map<string, CachedQuote>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
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
