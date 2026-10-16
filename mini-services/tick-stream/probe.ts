/**
 * probe.ts — end-to-end self-test for the tick-stream relay (Task 29-b).
 * ----------------------------------------------------------------------------
 * Connects to the LIVE service on 127.0.0.1:3041 (socket path '/'), waits for
 * the `hello` handshake, then collects `tick` + `bridge` events for up to 8 s.
 *
 * PASS — at least one genuine `tick` observed (two or more finish early),
 *        OR (quiet market, per task note) `hello` + a `bridge` payload with
 *        reachable:true and quoteCount>0.
 * FAIL — anything else (no hello, connect error, no healthy bridge payload).
 * Exit code 0 = verified, 1 = failed. The probe only LISTENS — it is a
 * read-only verification tool with no capability beyond observing events.
 */

import { io } from 'socket.io-client'

const SERVICE_URL = 'http://127.0.0.1:3041'
const COLLECT_MS = 8000
const HELLO_TIMEOUT_MS = 6000 // generous vs the 4 s connect timeout

interface HelloPayload {
  service: string
  version: string
  startedAtUtc: string
  symbol: string
  clients: number
}

interface TickPayload {
  symbol: string
  bid: number
  ask: number
  mid: number
  spread: number
  digits: number | null
  quoteTimeUtc: string
  receivedAtUtc: string
  serviceSeq: number
  bridgeLatencyMs: number
}

interface BridgePayload {
  reachable: boolean
  configured: boolean
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
  serviceUptimeMs: number
}

const socket = io(SERVICE_URL, {
  path: '/',
  transports: ['websocket', 'polling'],
  timeout: 4000,
  reconnection: false,
})

let finished = false
let hello: HelloPayload | null = null
const ticks: TickPayload[] = []
const bridges: BridgePayload[] = []
let helloTimer: ReturnType<typeof setTimeout> | undefined
let collectTimer: ReturnType<typeof setTimeout> | undefined

function finish(ok: boolean, note: string): void {
  if (finished) return
  finished = true
  if (helloTimer !== undefined) clearTimeout(helloTimer)
  if (collectTimer !== undefined) clearTimeout(collectTimer)

  const latest = bridges.length > 0 ? bridges[bridges.length - 1] : null
  console.log('──────── tick-stream probe summary ────────')
  console.log(`result : ${ok ? 'PASS' : 'FAIL'} — ${note}`)
  console.log(`events : hello=${hello !== null ? 1 : 0} tick=${ticks.length} bridge=${bridges.length}`)
  if (hello !== null) console.log(`hello  : ${JSON.stringify(hello)}`)
  if (ticks.length > 0) {
    console.log(`tick#1 : ${JSON.stringify(ticks[0])}`)
    console.log(`tick#${ticks[ticks.length - 1].serviceSeq} : ${JSON.stringify(ticks[ticks.length - 1])}`)
  }
  if (latest !== null) {
    console.log(
      `bridge : reachable=${latest.reachable} configured=${latest.configured} connected=${latest.connected} authenticated=${latest.authenticated}`,
    )
    console.log(
      `bridge : server=${latest.server ?? 'null'} gateway=${latest.gateway ?? 'null'} latencyMs=${latest.latencyMs ?? 'null'} offsetSec=${latest.offsetSec ?? 'null'}`,
    )
    console.log(
      `bridge : quoteCount=${latest.quoteCount ?? 'null'} reconnects=${latest.reconnects ?? 'null'} symbols=${latest.symbols ?? 'null'} uptimeMs=${latest.uptimeMs ?? 'null'}`,
    )
  }
  console.log(`exit   : ${ok ? 0 : 1}`)
  socket.disconnect()
  process.exit(ok ? 0 : 1)
}

function evaluateWindow(): void {
  const latest = bridges.length > 0 ? bridges[bridges.length - 1] : null
  if (ticks.length > 0) {
    finish(true, `${ticks.length} genuine tick event(s) observed`)
    return
  }
  if (latest !== null && latest.reachable === true && typeof latest.quoteCount === 'number' && latest.quoteCount > 0) {
    finish(
      true,
      'no tick within the 8 s window (quiet market) — bridge reachable with quoteCount>0 (treated as success per task note)',
    )
    return
  }
  finish(
    false,
    `no tick and no healthy bridge payload within 8 s (last bridge: ${
      latest === null ? 'none received' : `reachable=${String(latest.reachable)} quoteCount=${latest.quoteCount ?? 'null'}`
    })`,
  )
}

function maybeFinishEarly(): void {
  // Two ticks + a bridge payload prove both contracts AND live data flow (the
  // first tick may be the connect-time replay of the latest known tick).
  if (ticks.length >= 2 && bridges.length >= 1) {
    finish(true, `verified early: ${ticks.length} tick event(s) + ${bridges.length} bridge event(s)`)
  }
}

socket.on('connect', () => {
  console.log(`[probe] connected to ${SERVICE_URL} (id=${socket.id}, transport=${socket.io.engine.transport.name})`)
})

socket.on('connect_error', (err: Error) => {
  finish(false, `connect_error: ${err.message}`)
})

socket.on('disconnect', (reason: string) => {
  if (!finished) finish(false, `socket disconnected before verification completed (${reason})`)
})

socket.on('hello', (p: HelloPayload) => {
  if (hello !== null) return
  hello = p
  console.log(
    `[probe] hello: service=${p.service} version=${p.version} symbol=${p.symbol} clients=${p.clients} startedAtUtc=${p.startedAtUtc}`,
  )
  collectTimer = setTimeout(evaluateWindow, COLLECT_MS)
})

socket.on('tick', (t: TickPayload) => {
  ticks.push(t)
  console.log(
    `[probe] tick serviceSeq=${t.serviceSeq} ${t.symbol} bid=${t.bid} ask=${t.ask} spread=${t.spread} digits=${t.digits ?? 'null'} quoteTimeUtc=${t.quoteTimeUtc} bridgeLatencyMs=${t.bridgeLatencyMs}`,
  )
  maybeFinishEarly()
})

socket.on('bridge', (b: BridgePayload) => {
  bridges.push(b)
  console.log(
    `[probe] bridge: reachable=${b.reachable} configured=${b.configured} connected=${b.connected} quoteCount=${b.quoteCount ?? 'null'} reconnects=${b.reconnects ?? 'null'}`,
  )
  maybeFinishEarly()
})

helloTimer = setTimeout(() => {
  finish(false, 'no `hello` within 6 s — is the tick-stream service running on 127.0.0.1:3041?')
}, HELLO_TIMEOUT_MS)

console.log(`[probe] target ${SERVICE_URL} (path '/'), collecting up to ${COLLECT_MS} ms after hello`)
