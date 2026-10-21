/**
 * tick-stream — READ-ONLY live tick relay (Task 29-b; realtime channels Task 36-rt), port 3041.
 * ----------------------------------------------------------------------------
 * Polls the mt5-bridge (:3031, x-trader-key auth) and broadcasts genuine
 * observations to socket.io clients:
 *
 *   · `tick`      — live XAUUSDm quote, polled every 250 ms (Task 36-rt — the
 *                   "millisecond" price cadence), emitted ONLY on change;
 *   · `positions` — open positions via GET /api/positions every 3 s (each
 *                   bridge call opens a fresh probe session, 0.5–2 s — strict
 *                   non-overlap guard, 8 s timeout), marked to market against
 *                   the latest cached quote;
 *   · `account`   — balance/connection from GET /api/status every 2 s;
 *   · `bridge`    — full relay/bridge health snapshot after every status poll
 *                   and immediately on client connect.
 *
 * The Next.js dashboard connects through the platform gateway as
 * io('/?XTransformPort=3041') — hence the hardcoded port and the fixed socket
 * path '/' (Caddy selects the upstream by the XTransformPort url-query
 * parameter and requires path '/').
 *
 * READ-ONLY BY CONSTRUCTION:
 *   - the only upstream calls are three GETs (/api/quote, /api/status,
 *     /api/positions — the positions list is a read, never an order);
 *   - this service exposes no HTTP routes of its own beyond socket.io, and
 *     contains no trading, deal or execution code path whatsoever;
 *   - the bridge itself is GET-only on these paths, so no trading surface
 *     exists upstream either — this relay physically cannot trade.
 *
 * Honesty contract:
 *   - every broadcast field is a genuine observation or an honest null —
 *     degraded states never invent values;
 *   - `tick` fires only when the observed quote actually changed (bid, ask or
 *     quote timestamp) — no synthetic heartbeats, no filler repetition;
 *   - `positions`/`account` fire only after a SUCCESSFUL poll — on bridge
 *     errors nothing is emitted for that channel, the last good payload is
 *     kept server-side, and replays to newly connected clients carry an
 *     honest `stale: true` flag once older than 15 s;
 *   - `currentPrice`/`floatingPnlUsd` are computed ONLY from a fresh (< 10 s)
 *     cached XAUUSDm quote (1 lot = 100 oz) — otherwise honest nulls;
 *   - logging is bounded: one startup line, reachability/channel transition
 *     lines (debounced), never per-poll output; MT5_BRIDGE_TOKEN is never logged.
 */

import { createServer } from 'http'
import { Server } from 'socket.io'

// ── fixed configuration ─────────────────────────────────────────────────────
// Port and socket path are part of the platform-gateway contract and are
// deliberately NOT env-configurable (task spec: PORT stays 3041, path '/').
const PORT = 3041
const SYMBOL = 'XAUUSDm'

// Task 36-rt — millisecond-cadence realtime channels. The quote poll is the
// price cadence (250 ms); the positions poll MUST stay ≥ 3 s (each bridge call
// opens a fresh probe session, 0.5–2 s — never concurrent, never faster);
// the status poll also drives the `account` event cadence.
const QUOTE_POLL_MS = 250
const STATUS_POLL_MS = 2000
const POSITIONS_POLL_MS = 3000
const POSITIONS_TIMEOUT_MS = 8000 // probe sessions are slow (fresh login per read)
const REQUEST_TIMEOUT_MS = 3000 // quote + status polls (cheap, in-memory reads)
const TRANSITION_LOG_MIN_GAP_MS = 5000 // anti-flap guard: at most one transition line per 5 s

/** A quote older than this is NOT used to mark positions (honest nulls instead). */
const QUOTE_FRESH_MS = 10_000
/** Last-good payloads older than this are replayed to new clients with stale:true. */
const STALE_AFTER_MS = 15_000
/** XAUUSDm contract: 1 lot = 100 oz (the same constant the risk engine uses). */
const GOLD_CONTRACT_OZ = 100

const SERVICE = 'tick-stream'
const VERSION = '1.1.0'

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

/** `bridge` — emitted after every status poll (every 2 s) and immediately on
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

/** `positions` — emitted after every SUCCESSFUL /api/positions poll (3 s
 *  cadence, strict non-overlap). `currentPrice`/`floatingPnlUsd` are honest
 *  nulls whenever no fresh (< 10 s) XAUUSDm quote is cached, or the position's
 *  symbol is one whose contract size this relay does not know — never invented. */
interface LivePositionRow {
  positionId: string
  symbol: string
  direction: 'BUY' | 'SELL'
  lots: number
  entryPrice: number
  openTimeUtcSec: number
  currentPrice: number | null
  floatingPnlUsd: number | null
  comment: string | null
}

interface PositionsPayload {
  positions: LivePositionRow[]
  updatedAtMs: number
  source: string
  stale: boolean // true only on replays of last-good state older than STALE_AFTER_MS
}

/** `account` — emitted after every SUCCESSFUL /api/status poll (2 s cadence).
 *  accountEquity is deliberately absent (this gateway reports 0 — known). */
interface AccountPayload {
  balance: number | null
  currency: string | null
  connected: boolean | null
  authenticated: boolean | null
  serverTime: number | null
  updatedAtMs: number
  stale: boolean
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

/** Validated raw position from the bridge /api/positions response (the
 *  PositionInfo shape of mini-services/mt5-bridge/src/mt5-client.ts:
 *  positionId, symbol, direction BUY|SELL, lots, priceOpen, timeCreateUtcSec
 *  — the bridge sends no per-position comment, so it stays an honest null). */
interface RawBridgePosition {
  positionId: string
  symbol: string
  direction: 'BUY' | 'SELL'
  lots: number
  entryPrice: number
  openTimeUtcSec: number
  comment: string | null
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

/** Defensive /api/positions parse. Accepts the REAL bridge envelope
 *  {ok:true, source, count, positions:[PositionInfo...]} or a bare position
 *  array. Malformed ENTRIES are skipped honestly; a failure envelope
 *  (ok:false) or a shape without a positions array returns null (the caller
 *  then emits nothing for this channel). */
function parsePositionsResponse(body: unknown): { positions: RawBridgePosition[]; source: string } | null {
  if (body === null || typeof body !== 'object') return null
  const envelope = body as Record<string, unknown>
  const rawList: unknown[] | null = Array.isArray(envelope.positions)
    ? envelope.positions
    : Array.isArray(body)
      ? body
      : null
  if (rawList === null || envelope.ok === false) return null
  const source = toNonEmptyString(envelope.source) ?? 'bridge'
  const positions: RawBridgePosition[] = []
  for (const item of rawList) {
    if (item === null || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const positionId = toNonEmptyString(p.positionId)
    const symbol = toNonEmptyString(p.symbol)
    const direction = p.direction === 'BUY' || p.direction === 'SELL' ? p.direction : null
    const lots = toFiniteNumber(p.lots)
    const entryPrice = toFiniteNumber(p.priceOpen)
    const openTimeUtcSec = toFiniteNumber(p.timeCreateUtcSec) ?? 0
    if (
      positionId === null || symbol === null || direction === null ||
      lots === null || lots <= 0 || entryPrice === null || entryPrice <= 0
    ) {
      continue // malformed entry — skipped honestly, never guessed
    }
    positions.push({ positionId, symbol, direction, lots, entryPrice, openTimeUtcSec, comment: toNonEmptyString(p.comment) })
  }
  return { positions, source }
}

/** Mark every position to market against the LATEST cached quote (cached on
 *  every successful quote poll, i.e. ≤ 250 ms old as an observation). Quote
 *  FRESHNESS is the quote's own broker timestamp (< 10 s) — during a market
 *  pause the honest result is null, never a stale mark presented as current. */
function buildPositionsPayload(raw: { positions: RawBridgePosition[]; source: string }): PositionsPayload {
  const updatedAtMs = Date.now()
  return {
    positions: raw.positions.map((p): LivePositionRow => {
      const q = lastQuoteForMarking
      let currentPrice: number | null = null
      let floatingPnlUsd: number | null = null
      if (q !== null && updatedAtMs - q.tsMs < QUOTE_FRESH_MS && p.symbol === SYMBOL) {
        if (p.direction === 'BUY') {
          currentPrice = q.bid // a BUY closes at bid
          floatingPnlUsd = Math.round((q.bid - p.entryPrice) * GOLD_CONTRACT_OZ * p.lots * 100) / 100
        } else {
          currentPrice = q.ask // a SELL closes at ask
          floatingPnlUsd = Math.round((p.entryPrice - q.ask) * GOLD_CONTRACT_OZ * p.lots * 100) / 100
        }
      }
      return {
        positionId: p.positionId,
        symbol: p.symbol,
        direction: p.direction,
        lots: p.lots,
        entryPrice: p.entryPrice,
        openTimeUtcSec: p.openTimeUtcSec,
        currentPrice,
        floatingPnlUsd,
        comment: p.comment,
      }
    }),
    updatedAtMs,
    source: raw.source,
    stale: false,
  }
}

/** `account` projection of a successful /api/status body (fields:
 *  accountBalance, accountCurrency, connected, authenticated, serverTime). */
function buildAccountPayload(body: unknown): AccountPayload {
  const s = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  return {
    balance: toFiniteNumber(s.accountBalance),
    currency: toNonEmptyString(s.accountCurrency),
    connected: toBoolean(s.connected),
    authenticated: toBoolean(s.authenticated),
    serverTime: toFiniteNumber(s.serverTime),
    updatedAtMs: Date.now(),
    stale: false,
  }
}

// ── relay state ──────────────────────────────────────────────────────────────

let reachableNow: boolean | null = null // null = no poll has completed yet
let lastStatusFields: BridgeStatusFields | null = null // null = no successful status poll (or the last one failed)
let lastTickPayload: TickPayload | null = null // replayed to newly connected clients
let lastBroadcastKey: { bid: number; ask: number; tsMs: number } | null = null // change detection
let serviceSeq = 0

// Task 36-rt — realtime channel state.
let lastQuoteForMarking: { bid: number; ask: number; tsMs: number } | null = null // EVERY successful quote observation
let lastPositionsPayload: PositionsPayload | null = null // last good positions observation (replayed on connect)
let lastAccountPayload: AccountPayload | null = null // last good account observation (replayed on connect)

let quoteInFlight = false
let statusInFlight = false
let positionsInFlight = false // strict non-overlap guard for the probe-session positions reads

let loggedReachable: boolean | null = null
let lastTransitionLogAtMs = 0

let positionsChannelOk: boolean | null = null
let positionsTransitionLogAtMs = 0

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

/** Replay copy of a last-good payload for a newly connected client: identical
 *  data with the staleness flag recomputed at SEND time (honest age — the
 *  observation itself is never refreshed or fabricated). */
function withStaleFlag<T extends { updatedAtMs: number; stale: boolean }>(payload: T): T {
  return { ...payload, stale: Date.now() - payload.updatedAtMs > STALE_AFTER_MS }
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

async function bridgeGet(pathAndQuery: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<BridgeFetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
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

    // Cache EVERY successful observation (not just changed quotes) so the
    // positions channel can mark to market at poll time (Task 36-rt).
    lastQuoteForMarking = { bid: q.bid, ask: q.ask, tsMs: q.tsMs }

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
      // Task 36-rt — account channel: the same successful status observation,
      // emitted as its own event. On failure nothing is emitted for this
      // channel; the last good payload stays server-side with its honest age.
      lastAccountPayload = buildAccountPayload(res.body)
      io.emit('account', lastAccountPayload)
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
  // `bridge` is broadcast after EVERY status poll (2 s), healthy or degraded.
  io.emit('bridge', buildBridgePayload())
}

/** Task 36-rt — positions channel. Polls GET /api/positions every 3 s with a
 *  STRICT non-overlap guard: each bridge call opens a fresh probe session
 *  (connect → auth → login → positions → close, 0.5–2 s) and must never run
 *  concurrently or faster than every 3 s. On any failure nothing is emitted
 *  for this channel — the last good payload is kept server-side and replayed
 *  (with stale:true once > 15 s) to newly connected clients. */
async function pollPositions(): Promise<void> {
  if (!BRIDGE_CONFIGURED || positionsInFlight) return // previous probe still running — skip this tick
  positionsInFlight = true
  try {
    const res = await bridgeGet('/api/positions', POSITIONS_TIMEOUT_MS)
    if (!res.ok) {
      notePositionsChannel(false, `positions poll: ${res.error ?? 'unknown failure'}`)
      return
    }
    const parsed = parsePositionsResponse(res.body)
    if (parsed === null) {
      notePositionsChannel(false, 'positions poll: response did not validate')
      return
    }
    notePositionsChannel(true, `${parsed.positions.length} open, source ${parsed.source}`)
    const payload = buildPositionsPayload(parsed)
    lastPositionsPayload = payload
    io.emit('positions', payload)
  } catch (e) {
    notePositionsChannel(false, `positions poll: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    positionsInFlight = false
  }
}

/** Positions-channel health for BOUNDED transition logging (same anti-flap
 *  discipline as noteReachable — at most one line per 5 s, never per-poll). */
function notePositionsChannel(ok: boolean, detail: string): void {
  const previous = positionsChannelOk
  positionsChannelOk = ok
  if (previous === ok) return
  const now = Date.now()
  if (now - positionsTransitionLogAtMs < TRANSITION_LOG_MIN_GAP_MS) return
  positionsTransitionLogAtMs = now
  if (ok) {
    console.log(
      previous === null
        ? `[tick-stream] positions channel live (${detail})`
        : `[tick-stream] positions channel live again (${detail})`,
    )
  } else {
    console.log(
      `[tick-stream] positions channel degraded (${detail}) — nothing emitted for this channel, last good state kept (stale flag after ${STALE_AFTER_MS / 1000}s)`,
    )
  }
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
  // Task 36-rt — replay the last-good realtime-channel observations so a
  // freshly connected client paints instantly; staleness is recomputed at
  // send time (an old observation is flagged, never presented as current).
  if (lastPositionsPayload !== null) socket.emit('positions', withStaleFlag(lastPositionsPayload))
  if (lastAccountPayload !== null) socket.emit('account', withStaleFlag(lastAccountPayload))

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
  // pile-up when a request hangs up to its timeout (positions probes may
  // legitimately take up to 8 s — the 3 s interval simply skips ticks while
  // one is still running, so reads NEVER overlap).
  void pollQuote()
  void pollStatus()
  void pollPositions()
  setInterval(() => {
    void pollQuote()
  }, QUOTE_POLL_MS)
  setInterval(() => {
    void pollStatus()
  }, STATUS_POLL_MS)
  setInterval(() => {
    void pollPositions()
  }, POSITIONS_POLL_MS)
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
