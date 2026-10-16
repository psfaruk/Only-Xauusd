/**
 * tick-stream — READ-ONLY live tick relay (Task 29-b), port 3041.
 * ----------------------------------------------------------------------------
 * Polls the mt5-bridge (:3031, x-trader-key auth) for the live XAUUSDm quote
 * (every 1 s) and the bridge status (every 5 s), and broadcasts genuine
 * observations to socket.io clients. The Next.js dashboard connects through
 * the platform gateway as io('/?XTransformPort=3041') — hence the hardcoded
 * port and the fixed socket path '/' (Caddy selects the upstream by the
 * XTransformPort url-query parameter and requires path '/').
 *
 * READ-ONLY BY CONSTRUCTION:
 *   - the only upstream calls are two GETs (/api/quote, /api/status);
 *   - this service exposes no HTTP routes of its own beyond socket.io, and
 *     contains no trading, deal, position or execution code path whatsoever;
 *   - the bridge itself is GET-only, so no trading surface exists upstream
 *     either — this relay physically cannot trade.
 *
 * Honesty contract:
 *   - every broadcast field is a genuine observation or an honest null —
 *     degraded states never invent values;
 *   - `tick` fires only when the observed quote actually changed (bid, ask or
 *     quote timestamp) — no synthetic heartbeats, no filler repetition;
 *   - logging is bounded: one startup line, reachability transition lines
 *     (debounced), never per-poll output; MT5_BRIDGE_TOKEN is never logged.
 */

import { createServer } from 'http'
import { Server } from 'socket.io'

// ── fixed configuration ─────────────────────────────────────────────────────
// Port and socket path are part of the platform-gateway contract and are
// deliberately NOT env-configurable (task spec: PORT stays 3041, path '/').
const PORT = 3041
const SYMBOL = 'XAUUSDm'
const QUOTE_POLL_MS = 1000
const STATUS_POLL_MS = 5000
const REQUEST_TIMEOUT_MS = 3000
const TRANSITION_LOG_MIN_GAP_MS = 5000 // anti-flap guard: at most one transition line per 5 s

const SERVICE = 'tick-stream'
const VERSION = '1.0.0'

const BRIDGE_URL = (process.env.MT5_BRIDGE_URL ?? 'http://127.0.0.1:3031').replace(/\/+$/, '')
const BRIDGE_TOKEN = process.env.MT5_BRIDGE_TOKEN ?? '' // lives only in the x-trader-key header — never logged
const BRIDGE_CONFIGURED = BRIDGE_TOKEN.length > 0

const startedAtMs = Date.now()
const startedAtUtc = new Date(startedAtMs).toISOString()

// ── broadcast contracts (default namespace; JSON-serializable; numbers stay numbers) ──

/** `tick` — emitted ONLY when the observed quote actually changed vs the last
 *  broadcast (bid, ask or quote timestamp differ). */
interface TickPayload {
  symbol: string
  bid: number
  ask: number
  mid: number
  spread: number
  digits: number | null // honest null if the bridge omits it (the real bridge always sends 3)
  quoteTimeUtc: string // ISO 8601 — from the quote's `ts`
  receivedAtUtc: string // ISO 8601 — from the quote's `recv` / `receivedAtMs`
  serviceSeq: number // monotonic counter of ticks broadcast since service start (starts at 1)
  bridgeLatencyMs: number // HTTP round-trip of the poll that produced this tick
}

/** `bridge` — emitted after every status poll (every 5 s) and immediately on
 *  any client connect. Degraded states carry honest nulls, never invented
 *  values; `reachable`/`configured`/`serviceUptimeMs` are live relay state,
 *  the remaining fields are the last successful status-poll observation. */
interface BridgePayload {
  reachable: boolean
  configured: boolean // false ⇒ token absent ⇒ pollers disabled (fail-closed)
  connected: boolean | null // null = unknown (no successful status poll)
  authenticated: boolean | null
  server: string | null
  gateway: string | null
  latencyMs: number | null
  offsetSec: number | null
  symbols: number | null
  quoteCount: number | null
  lastQuoteAtMs: number | null
  reconnects: number | null
  lastError: string | null
  lastErrorAtMs: number | null
  uptimeMs: number | null
  serviceUptimeMs: number
}

// ── defensive parsing ────────────────────────────────────────────────────────

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

function toBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (v === 1) return true
  if (v === 0) return false
  return null
}

function toNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Accept second- or millisecond-precision epochs and normalize to integer ms.
 *  (The real bridge serves the quote `ts` in SECONDS and receipt stamps in ms;
 *  a wrapped envelope might serve either — handle both, invent neither.) */
function toEpochMs(v: unknown): number | null {
  const n = toFiniteNumber(v)
  if (n === null || n <= 0) return null
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

interface NormalizedQuote {
  symbol: string
  bid: number
  ask: number
  mid: number
  spread: number
  digits: number | null
  tsMs: number
  recvMs: number
}

/** Defensive quote parse. Accepts the REAL bridge shape (flat
 *  {symbol,bid,ask,mid,ts,spread,digits,receivedAtMs,source}) and a wrapped
 *  {ok,quote:{...}} envelope; `ts` may arrive in s or ms; the receipt stamp
 *  may be `recv` or `receivedAtMs`. Returns null when the response does not
 *  validate (the caller then marks the bridge unreachable for this poll). */
function parseQuote(body: unknown): NormalizedQuote | null {
  if (body === null || typeof body !== 'object') return null
  const envelope = body as Record<string, unknown>
  const q: Record<string, unknown> =
    envelope.quote !== null && typeof envelope.quote === 'object'
      ? (envelope.quote as Record<string, unknown>)
      : envelope

  const bid = toFiniteNumber(q.bid)
  const ask = toFiniteNumber(q.ask)
  // A quote with non-positive or crossed prices is not a genuine observation.
  if (bid === null || ask === null || bid <= 0 || ask <= 0 || bid > ask) return null
  const tsMs = toEpochMs(q.ts)
  if (tsMs === null) return null

  const mid = toFiniteNumber(q.mid) ?? (bid + ask) / 2 // same formula the bridge itself uses
  const spread = toFiniteNumber(q.spread) ?? ask - bid
  const digits = toFiniteNumber(q.digits)
  // Receipt-stamp fallback: the moment this relay got the response — an honest
  // lower bound when the bridge does not report its own receipt time.
  const recvMs = toEpochMs(q.recv ?? q.receivedAtMs) ?? Date.now()
  const symbol = toNonEmptyString(q.symbol) ?? SYMBOL
  return { symbol, bid, ask, mid, spread, digits, tsMs, recvMs }
}

/** The nullable status fields carried on the `bridge` payload. */
interface BridgeStatusFields {
  connected: boolean | null
  authenticated: boolean | null
  server: string | null
  gateway: string | null
  latencyMs: number | null
  offsetSec: number | null
  symbols: number | null
  quoteCount: number | null
  lastQuoteAtMs: number | null
  reconnects: number | null
  lastError: string | null
  lastErrorAtMs: number | null
  uptimeMs: number | null
}

function parseStatusFields(body: unknown): BridgeStatusFields {
  const s: Record<string, unknown> =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  return {
    connected: toBoolean(s.connected),
    authenticated: toBoolean(s.authenticated),
    server: toNonEmptyString(s.server),
    gateway: toNonEmptyString(s.gateway),
    latencyMs: toFiniteNumber(s.latencyMs),
    offsetSec: toFiniteNumber(s.offsetSec),
    symbols: toFiniteNumber(s.symbols),
    quoteCount: toFiniteNumber(s.quoteCount),
    lastQuoteAtMs: toEpochMs(s.lastQuoteAtMs),
    reconnects: toFiniteNumber(s.reconnects),
    lastError: toNonEmptyString(s.lastError),
    lastErrorAtMs: toEpochMs(s.lastErrorAtMs),
    uptimeMs: toFiniteNumber(s.uptimeMs),
  }
}

// ── relay state ──────────────────────────────────────────────────────────────

let reachableNow: boolean | null = null // null = no poll has completed yet
let lastStatusFields: BridgeStatusFields | null = null // null = no successful status poll (or the last one failed)
let lastTickPayload: TickPayload | null = null // replayed to newly connected clients
let lastBroadcastKey: { bid: number; ask: number; tsMs: number } | null = null // change detection
let serviceSeq = 0

let quoteInFlight = false
let statusInFlight = false

let loggedReachable: boolean | null = null
let lastTransitionLogAtMs = 0

function buildBridgePayload(): BridgePayload {
  const f = lastStatusFields
  return {
    reachable: reachableNow === true,
    configured: BRIDGE_CONFIGURED,
    connected: f?.connected ?? null,
    authenticated: f?.authenticated ?? null,
    server: f?.server ?? null,
    gateway: f?.gateway ?? null,
    latencyMs: f?.latencyMs ?? null,
    offsetSec: f?.offsetSec ?? null,
    symbols: f?.symbols ?? null,
    quoteCount: f?.quoteCount ?? null,
    lastQuoteAtMs: f?.lastQuoteAtMs ?? null,
    reconnects: f?.reconnects ?? null,
    lastError: f?.lastError ?? null,
    lastErrorAtMs: f?.lastErrorAtMs ?? null,
    uptimeMs: f?.uptimeMs ?? null,
    serviceUptimeMs: Date.now() - startedAtMs,
  }
}

/** Update the shared reachability view; log TRANSITIONS only (debounced). */
function noteReachable(reachable: boolean, detail: string): void {
  const previous = loggedReachable
  reachableNow = reachable
  if (previous === reachable) return
  loggedReachable = reachable
  const now = Date.now()
  // Anti-flap: if the two pollers briefly disagree (e.g. quote 404 while
  // status 200) the STATE still updates every poll, but log lines stay bounded.
  if (now - lastTransitionLogAtMs < TRANSITION_LOG_MIN_GAP_MS) return
  lastTransitionLogAtMs = now
  if (reachable) {
    console.log(
      previous === null
        ? `[tick-stream] bridge reachable (${detail})`
        : `[tick-stream] bridge reachable again (${detail})`,
    )
  } else {
    console.log(`[tick-stream] bridge UNREACHABLE (${detail}) — keep polling, broadcasting honest degraded state`)
  }
}

// ── bridge polling (GET-only; the bridge has no other surface) ──────────────

interface BridgeFetchResult {
  ok: boolean
  status: number | null
  body: unknown
  error: string | null
  latencyMs: number
}

async function bridgeGet(pathAndQuery: string): Promise<BridgeFetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const started = Date.now()
  try {
    const res = await fetch(`${BRIDGE_URL}${pathAndQuery}`, {
      method: 'GET',
      headers: { 'x-trader-key': BRIDGE_TOKEN, accept: 'application/json' },
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    if (!res.ok) {
      return { ok: false, status: res.status, body: null, error: `HTTP ${res.status}`, latencyMs }
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      return { ok: false, status: res.status, body: null, error: 'response was not valid JSON', latencyMs }
    }
    return { ok: true, status: res.status, body, error: null, latencyMs }
  } catch (e) {
    // Timeouts / connection refused / DNS — surface the reason, never crash.
    return {
      ok: false,
      status: null,
      body: null,
      error: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function pollQuote(): Promise<void> {
  if (!BRIDGE_CONFIGURED || quoteInFlight) return
  quoteInFlight = true
  try {
    const res = await bridgeGet(`/api/quote?symbol=${encodeURIComponent(SYMBOL)}`)
    if (!res.ok) {
      noteReachable(false, `quote poll: ${res.error ?? 'unknown failure'}`)
      return
    }
    const q = parseQuote(res.body)
    if (q === null) {
      noteReachable(false, 'quote poll: response did not validate')
      return
    }
    noteReachable(true, 'quote poll ok')

    const changed =
      lastBroadcastKey === null ||
      q.bid !== lastBroadcastKey.bid ||
      q.ask !== lastBroadcastKey.ask ||
      q.tsMs !== lastBroadcastKey.tsMs
    if (!changed) return // identical quote (same bid/ask/timestamp) — stay silent

    serviceSeq += 1
    const payload: TickPayload = {
      symbol: q.symbol,
      bid: q.bid,
      ask: q.ask,
      mid: q.mid,
      spread: q.spread,
      digits: q.digits,
      quoteTimeUtc: new Date(q.tsMs).toISOString(),
      receivedAtUtc: new Date(q.recvMs).toISOString(),
      serviceSeq,
      bridgeLatencyMs: res.latencyMs,
    }
    lastBroadcastKey = { bid: q.bid, ask: q.ask, tsMs: q.tsMs }
    lastTickPayload = payload
    io.emit('tick', payload)
  } catch (e) {
    // Top-level guard around the whole poll body — the poller can never crash
    // the service; the next interval tick retries.
    noteReachable(false, `quote poll: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    quoteInFlight = false
  }
}

async function pollStatus(): Promise<void> {
  if (!BRIDGE_CONFIGURED || statusInFlight) return
  statusInFlight = true
  try {
    const res = await bridgeGet('/api/status')
    if (res.ok) {
      noteReachable(true, 'status poll ok')
      lastStatusFields = parseStatusFields(res.body)
    } else {
      noteReachable(false, `status poll: ${res.error ?? 'unknown failure'}`)
      lastStatusFields = null // honest nulls — never serve stale status as current
    }
  } catch (e) {
    noteReachable(false, `status poll: ${e instanceof Error ? e.message : String(e)}`)
    lastStatusFields = null
  } finally {
    statusInFlight = false
  }
  // `bridge` is broadcast after EVERY status poll (5 s), healthy or degraded.
  io.emit('bridge', buildBridgePayload())
}

// ── socket.io relay ─────────────────────────────────────────────────────────

// Bare node:http server — no routes of our own; engine.io answers any other
// path with 400 (expected platform-gateway behavior).
const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path: the platform gateway (Caddy) forwards requests
  // selected by the XTransformPort url-query parameter and requires path '/'.
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

io.on('connection', (socket) => {
  // Handshake sequence: hello → current bridge snapshot → latest tick (if any).
  socket.emit('hello', {
    service: SERVICE,
    version: VERSION,
    startedAtUtc,
    symbol: SYMBOL,
    clients: io.engine.clientsCount,
  })
  socket.emit('bridge', buildBridgePayload())
  if (lastTickPayload !== null) socket.emit('tick', lastTickPayload)

  socket.on('disconnect', () => {
    // Client count is tracked by the engine (io.engine.clientsCount) — no
    // broadcast to the remaining clients is required.
  })
})

// ── lifecycle ───────────────────────────────────────────────────────────────

httpServer.on('error', (err) => {
  console.error(`[tick-stream] http server error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

httpServer.listen(PORT, () => {
  console.log(`[tick-stream] listening :${PORT} — bridge ${BRIDGE_URL}`)
  if (!BRIDGE_CONFIGURED) {
    console.warn(
      '[tick-stream] MT5_BRIDGE_TOKEN is empty — degraded mode: bridgeConfigured=false, pollers disabled (fail-closed, never polling)',
    )
  }
})

if (BRIDGE_CONFIGURED) {
  // Immediate first poll, then steady cadence. The in-flight guards prevent
  // pile-up when a request hangs up to its 3 s timeout.
  void pollQuote()
  void pollStatus()
  setInterval(() => {
    void pollQuote()
  }, QUOTE_POLL_MS)
  setInterval(() => {
    void pollStatus()
  }, STATUS_POLL_MS)
}

process.on('unhandledRejection', (reason) => {
  console.error(
    `[tick-stream] unhandled rejection (service continues): ${reason instanceof Error ? reason.message : String(reason)}`,
  )
})

function shutdown(signal: string): void {
  console.log(`[tick-stream] ${signal} received — shutting down (clients connected: ${io.engine.clientsCount})`)
  io.close(() => {
    process.exit(0)
  })
  setTimeout(() => {
    process.exit(0) // hard-exit fallback if close hangs
  }, 2000)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
