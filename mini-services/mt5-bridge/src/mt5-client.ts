/**
 * mt5-bridge — MT5 WebSocket protocol client (Phase 8 read-only core + gated Phase 11 trade subset)
 * ----------------------------------------------------------------------------
 * Speaks the Exness MT5 web-terminal binary protocol over
 * `wss://<gateway-ip>:443/terminal` (AES-256-CBC framed) — the same protocol
 * the official Exness web terminal uses. Protocol reference: the user's
 * verified `mt5-poc/PROTOCOL.md` (psfaruk/Xauusd-trad, verified live
 * 2026-09-27) plus the production mt5-service implementation.
 *
 * ─── READ-ONLY CORE (Phase 8, always active) ────────────────────────────────
 * The market-data command set:
 *   AUTH (0) · ACCOUNT (3) · SUBSCRIBE (7) · QUOTES push (8) · CANDLES (11)
 *   LOGIN (28) · SYMBOLS (34) · HEARTBEAT (51)
 *
 * ─── PHASE 11 TRADE LAYER (explicitly gated — added Task 30-b) ──────────────
 * A minimal trading subset exists in this file and is DEAD by default:
 *   TRADE (12) — market open / close-by-position ONLY
 *   POSITIONS (4) — open-position listing
 *   TRADE_EVENT (19) — server push carrying the final trade result
 * NOTHING else from the reference trading layer was ported: no pending
 * orders, no modify, no cancel, no deals history, no account transfers.
 * Every path to these commands is gated by the manager's `ordersEnabled`
 * flag (env BRIDGE_ORDERS_ENABLED must be exactly 'true' or '1'); with the
 * flag unset the REST surface never reaches these methods at all, and this
 * client only ever sends the read-only command set. Enforced end-to-end
 * (index.ts method gate → manager validation → this client).
 *
 * Framing per WS binary message:
 *   wire:   [payload_len:u32 LE][version:u32 LE = 1][AES-256-CBC ciphertext]
 *   cmd:    [rnd:u8][rnd:u8][cmd_id:u16 LE][payload]
 *   resp:   [tag:u16 LE][cmd_id:u16 LE][res_code:u8][body]
 * Static AUTH key is public (embedded in every MT5 web bundle). The session
 * key is the last 32 bytes of the AUTH response body.
 */

import { createCipheriv, createDecipheriv } from "node:crypto";
import { gunzipSync, inflateSync, inflateRawSync } from "node:zlib";
import WebSocket from "ws";

const STATIC_KEY = Buffer.from(
  "02de02a1a65cc794684fcbea1ecb0fd74ae657e43662c11eee885d2fd64f4964",
  "hex",
);
const ZERO_IV = Buffer.alloc(16);

/** Timeframe codes understood by CANDLES (verified constants). */
export const TF_CODE: Record<string, number> = {
  M1: 1, M5: 5, M15: 15, M30: 30,
  H1: 16385, H4: 16388, D1: 16408,
};

/**
 * Command ids. Market-data set (always active) plus the Phase 11 trade subset
 * — POSITIONS/TRADE/TRADE_EVENT are reachable ONLY through manager methods
 * that first refuse unless BRIDGE_ORDERS_ENABLED is armed (exactly 'true'/'1').
 */
const CMD = {
  AUTH: 0,
  ACCOUNT: 3,
  POSITIONS: 4,      // Phase 11 (gated): open-position listing
  SUBSCRIBE: 7,
  QUOTES: 8,
  CANDLES: 11,
  TRADE: 12,         // Phase 11 (gated): market open / close-by-position ONLY
  TRADE_EVENT: 19,   // Phase 11 (gated): server PUSH — final trade results
  LOGIN: 28,
  SYMBOLS: 34,
  HEARTBEAT: 51,
} as const;

/** MT5 trade retcodes that matter to the Phase 11 layer. */
export const TRADE_RETCODE = {
  ACK: 10002,         // intermediate acknowledgement (first of two events)
  ACCEPTED: 10009,    // TRADE_RETCODE_DONE — final success, deal details attached
  INVALID: 10013,     // invalid request
  UNSUPPORTED: 10030, // unsupported command (e.g. trade_action 10 "CLOSE")
} as const;

/** Overall budget for one cmd-12 round trip (immediate response + final event). */
const TRADE_TIMEOUT_MS = 15000;

export interface Mt5Candle {
  time: number; // unix seconds, broker server time (bar OPEN)
  open: number; high: number; low: number; close: number; // real prices
  tickVolume: number; spread: number;
}

export interface LiveQuote {
  symbolId: number;
  timeSec: number;  // broker server time of the quote
  bid: number;      // RAW — divide by 10^digits of the symbol
  ask: number;      // RAW
}

export interface SymbolInfo {
  id: number;
  digits: number;
  name: string;
  description?: string;
  path?: string;
}

export interface AccountInfo {
  login: number;
  balance: number;
  equity: number;
  currency: string;
  group: string;
  server: string;
}

interface Mt5Response { tag: number; cmdId: number; resCode: number; body: Buffer; }

// ── Phase 11 trade layer types ───────────────────────────────────────────────

/** One market order (open, or close-by-position). `digits` comes from the
 *  live broker symbol table (the manager supplies it). */
export interface TradeRequest {
  symbol: string;
  type: "BUY" | "SELL";      // trade_type: 0 = BUY, 1 = SELL
  lots: number;             // manager clamps to [0.01, maxOrderLots], step 0.01
  price: number;            // current ask (BUY) / bid (SELL)
  digits: number;           // symbol digits
  sl: number;               // stop-loss price, 0 = none
  tp: number;               // take-profit price, 0 = none
  comment?: string;         // ≤ 32 UTF-16 code units (64-byte wire field)
  closePositionId?: bigint; // position id when CLOSING; absent/undefined = new order
}

/** Honest result of one cmd-12 round trip. */
export interface TradeResult {
  retcode: number;          // final event retcode when finalEvent, else immediate
  immediateRetcode: number; // 4-byte u32 from the cmd-12 response (-1 if absent)
  resCode: number;          // protocol-level res_code of the cmd-12 response
  finalEvent: boolean;      // true = final TRADE_EVENT (retcode ≠ 10002) observed
  accepted: boolean;        // retcode === 10009 (TRADE_ACCEPTED / DONE)
  dealId: string | null;    // final event only (Ap.deal, i64 → string)
  orderId: string | null;   // final event only (Ap.order, i64 → string)
  price: number | null;     // execution price (final event only)
  dealtLots: number | null; // deal volume in lots (final event only; unit
                            // calibrated against the requested volume — see
                            // emitTradeEvent)
  dealVolumeRaw: string;    // raw Ap.volume integer, exposed for honest verification
  comment: string | null;   // broker comment from the final event ('ok' on success)
  waitedMs: number;         // total cmd-12 round-trip time
}

/** One open position from POSITIONS (cmd 4). IDs are strings (i64-safe JSON).
 *  Times are the RAW record values (broker server time; Exness trial ≈ UTC,
 *  runtime-verified) — the manager subtracts the live-measured broker offset
 *  before serving them, exactly like quotes/candles. */
export interface PositionInfo {
  positionId: string;
  orderId: string;
  timeCreateUtcSec: number;
  timeUpdateUtcSec: number;
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;        // trade_volume ÷ 1e8 (empirical, 2025-10-21)
  priceOpen: number;
  priceClose: number;  // 0 while the position is open
  sl: number;
  tp: number;
  profit: number;
  commission: number;
  swap: number;        // storage_
}

/** Parsed final TRADE_EVENT (module-internal). */
interface TradeEventParsed {
  retcode: number;
  symbol: string;
  dealId: string | null;
  orderId: string | null;
  volumeRaw: string;
  lots: number | null;
  price: number | null;
  comment: string | null;
}

/** Write `text` as UTF-16LE into a fixed-size field (zero-padded; the caller
 *  pre-validates the length so truncation can never corrupt an order). */
function writeUtf16Fixed(buf: Buffer, offset: number, text: string, maxBytes: number): void {
  Buffer.from(text, "utf16le").subarray(0, maxBytes).copy(buf, offset);
}

/** Resolve `p` with null after `ms` (never rejects; the timer is cleared on
 *  early resolution so no stray timeouts accumulate). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/**
 * Phase 11 (gated): serialize the 248-byte TRADE (cmd 12) request payload.
 * Layout per the verified reference protocol (little-endian, packed):
 *   action_id       u32 @0   = 0 (new request)
 *   trade_action    u32 @4   = 3 (MARKET — verified for open AND close;
 *                                action 10 "CLOSE" returns 10030)
 *   symbol          64B @8   UTF-16LE
 *   volume          u64 @72  = lots × 100000000 (0.01 lot = 1000000)
 *   digits          u32 @80  symbol digits
 *   trade_order     u64 @84  = 0 (server-assigned, echoed by TRADE_EVENT)
 *   trade_type      u32 @92  0 = BUY, 1 = SELL
 *   type_filling    u32 @96  = 0 (FOK)
 *   type_time       u32 @100 = 0 (GTC)
 *   type_flags      u32 @104 = 2 (new order)
 *   type_reason     u32 @108 = 0
 *   price_order     f64 @112 current ask (BUY) / bid (SELL)
 *   price_trigger   f64 @120 = 0
 *   price_sl        f64 @128 stop loss (0 = none)
 *   price_tp        f64 @136 take profit (0 = none)
 *   price_deviation u32 @144 = 0
 *   price_top       f64 @148 = 0
 *   price_bottom    f64 @156 = 0
 *   comment         64B @164 UTF-16LE
 *   trade_position  u64 @228 = 0 for new; = position id for CLOSE
 *   position_by     u64 @236 = 0
 *   time_expiration u32 @244 = 0
 * (The field list sums to exactly 248 bytes and matches the TRADE_EVENT
 * Op-echo offsets — price@112, trade_order@84, trade_type@92.)
 *
 * Exported ONLY so probe-orders.ts can dry-run the serialization offline; the
 * manager never calls it directly.
 */
export function buildOpPayload(req: TradeRequest): Buffer {
  if (!req.symbol) throw new Error("trade payload: symbol required");
  if (req.symbol.length > 32) throw new Error("trade payload: symbol longer than the 64-byte field");
  if (req.comment && req.comment.length > 32) throw new Error("trade payload: comment longer than the 64-byte field");
  if (!Number.isFinite(req.lots) || req.lots <= 0) throw new Error("trade payload: lots must be a positive finite number");
  if (!Number.isFinite(req.price) || req.price <= 0) throw new Error("trade payload: price must be a positive finite number");
  if (!Number.isFinite(req.sl) || req.sl < 0) throw new Error("trade payload: sl must be a finite non-negative price");
  if (!Number.isFinite(req.tp) || req.tp < 0) throw new Error("trade payload: tp must be a finite non-negative price");
  if (!Number.isInteger(req.digits) || req.digits < 0) throw new Error("trade payload: digits must be a non-negative integer");
  const op = Buffer.alloc(248);
  op.writeUInt32LE(0, 0);                                            // action_id
  op.writeUInt32LE(3, 4);                                            // trade_action = 3 MARKET
  writeUtf16Fixed(op, 8, req.symbol, 64);                            // symbol
  op.writeBigUInt64LE(BigInt(Math.round(req.lots * 100000000)), 72); // volume (0.01 lot = 1000000)
  op.writeUInt32LE(req.digits, 80);                                  // digits
  op.writeBigUInt64LE(0n, 84);                                       // trade_order (server-assigned)
  op.writeUInt32LE(req.type === "BUY" ? 0 : 1, 92);                  // trade_type
  op.writeUInt32LE(0, 96);                                           // type_filling = 0 FOK
  op.writeUInt32LE(0, 100);                                          // type_time = 0 GTC
  op.writeUInt32LE(2, 104);                                          // type_flags = 2 new order
  op.writeUInt32LE(0, 108);                                          // type_reason
  op.writeDoubleLE(req.price, 112);                                  // price_order
  op.writeDoubleLE(0, 120);                                          // price_trigger
  op.writeDoubleLE(req.sl, 128);                                     // price_sl (0 = none)
  op.writeDoubleLE(req.tp, 136);                                     // price_tp (0 = none)
  op.writeUInt32LE(0, 144);                                          // price_deviation
  op.writeDoubleLE(0, 148);                                          // price_top
  op.writeDoubleLE(0, 156);                                          // price_bottom
  writeUtf16Fixed(op, 164, req.comment ?? "", 64);                   // comment
  op.writeBigUInt64LE(req.closePositionId ?? 0n, 228);               // trade_position (position id on CLOSE)
  op.writeBigUInt64LE(0n, 236);                                      // position_by
  op.writeUInt32LE(0, 244);                                          // time_expiration
  return op;
}

function aesEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const pad = 16 - (plaintext.length % 16);
  const padded = Buffer.concat([plaintext, Buffer.alloc(pad, pad)]);
  return createCipheriv("aes-256-cbc", key, ZERO_IV).update(padded);
}
function aesDecrypt(key: Buffer, ciphertext: Buffer): Buffer {
  const dec = createDecipheriv("aes-256-cbc", key, ZERO_IV);
  const pt = Buffer.concat([dec.update(ciphertext), dec.final()]);
  const p = pt[pt.length - 1];
  if (p >= 1 && p <= 16 && pt.subarray(pt.length - p).every((b) => b === p)) {
    return pt.subarray(0, pt.length - p);
  }
  return pt;
}
function frame(encrypted: Buffer): Buffer {
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32LE(encrypted.length, 0);
  hdr.writeUInt32LE(1, 4);
  return Buffer.concat([hdr, encrypted]);
}
function buildCommand(cmdId: number, payload: Buffer): Buffer {
  const cmd = Buffer.alloc(4 + payload.length);
  cmd[0] = (Math.random() * 256) | 0;
  cmd[1] = (Math.random() * 256) | 0;
  cmd.writeUInt16LE(cmdId, 2);
  payload.copy(cmd, 4);
  return cmd;
}
function parseResponse(plain: Buffer): Mt5Response | null {
  if (plain.length < 5) return null;
  return { tag: plain.readUInt16LE(0), cmdId: plain.readUInt16LE(2), resCode: plain[4], body: plain.subarray(5) };
}
function utf16(buf: Buffer): string {
  const s = buf.toString("utf16le");
  const nul = s.indexOf("\u0000");
  return nul >= 0 ? s.slice(0, nul) : s;
}

export class Mt5WsClient {
  private ws: WebSocket;
  private sessionKey: Buffer | null = null;
  private waiters = new Map<number, Array<(r: Mt5Response) => void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private quoteHandler: ((q: LiveQuote) => void) | null = null;
  private onCloseCb: (() => void) | null = null;
  /** Single in-flight cmd-12 waiter (trades are serialized through run(), so
   *  at most one trade awaits its final TRADE_EVENT at any moment). */
  private pendingTrade: { symbol: string; lots: number; resolve: (e: TradeEventParsed | null) => void } | null = null;
  closed = false;
  readonly host: string;
  lastRecvAt = Date.now();
  lastHeartbeatRttMs: number | null = null;

  private constructor(ws: WebSocket, host: string) {
    this.ws = ws;
    this.host = host;
  }

  /**
   * Dial a gateway by IP with a VERIFIED TLS chain. The gateways present
   * `*.exwebterm.com` certificates, so we set servername/SNI accordingly and
   * never disable verification (no MITM escape hatch in the bridge).
   */
  static async connect(host: string, timeoutMs = 8000): Promise<Mt5WsClient> {
    const url = `wss://${host}:443/terminal`;
    const ws = new WebSocket(url, {
      headers: {
        Origin: `https://${host}:443`,
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
      servername: "mt5.exwebterm.com",
      rejectUnauthorized: true,
    } as WebSocket.ClientOptions);

    const client = await new Promise<Mt5WsClient>((resolve, reject) => {
      const t = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`WS connect timeout (${url})`));
      }, timeoutMs);
      ws.on("open", () => { clearTimeout(t); resolve(new Mt5WsClient(ws, host)); });
      ws.on("error", (err: Error) => {
        clearTimeout(t);
        reject(new Error(`WS connect failed (${url}): ${err.message}`));
      });
    });

    ws.on("message", (data: Buffer) => {
      client.lastRecvAt = Date.now();
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (raw.length <= 8) return;
      const key = client.sessionKey ?? STATIC_KEY;
      let plain: Buffer;
      try { plain = aesDecrypt(key, raw.subarray(8)); } catch { return; }
      const resp = parseResponse(plain);
      if (!resp) return;
      if (resp.cmdId === CMD.QUOTES) { client.emitQuotes(resp.body); return; }
      if (resp.cmdId === CMD.TRADE_EVENT) { client.emitTradeEvent(resp.body); return; }
      if (resp.cmdId === CMD.HEARTBEAT) {
        client.lastHeartbeatRttMs = Date.now() - client.hbSentAt;
        return;
      }
      const q = client.waiters.get(resp.cmdId);
      if (q && q.length) {
        q.shift()!(resp);
        if (!q.length) client.waiters.delete(resp.cmdId);
      }
    });
    ws.on("close", () => {
      client.releasePendingTrade(); // an in-flight trade falls back to its immediate retcode honestly
      if (!client.closed) { client.closed = true; client.onCloseCb?.(); }
    });
    ws.on("error", () => {
      if (!client.closed) { client.closed = true; try { ws.close(); } catch { /* ignore */ } client.onCloseCb?.(); }
    });
    return client;
  }

  private hbSentAt = Date.now();

  get isOpen(): boolean { return !this.closed && this.ws.readyState === WebSocket.OPEN; }
  onClose(cb: () => void) { this.onCloseCb = cb; }
  onQuotes(h: (q: LiveQuote) => void) { this.quoteHandler = h; }

  private emitQuotes(body: Buffer) {
    const n = Math.floor(body.length / 50);
    if (process.env.MT5_DEBUG && n > 0 && (this as unknown as { dbgN?: number }).dbgN === undefined) {
      (this as unknown as { dbgN?: number }).dbgN = 1;
      const parts: string[] = [];
      for (let off = 8; off <= 20; off++) {
        try { parts.push(`@${off}=${body.readDoubleLE(off)}`); } catch { /* short */ }
      }
      console.log(`[mt5-client] QUOTES first-record offsets: ${parts.join(" ")}`);
      console.log(`[mt5-client] QUOTES hex[0..28]=${body.subarray(0, 28).toString("hex")}`);
    }
    for (let i = 0; i < n; i++) {
      const off = i * 50;
      if (off + 50 > body.length) break;
      this.quoteHandler?.({
        symbolId: body.readUInt32LE(off),
        timeSec: body.readInt32LE(off + 4),
        bid: body.readDoubleLE(off + 12),
        ask: body.readDoubleLE(off + 20),
      });
    }
  }

  private send(cmdId: number, payload: Buffer, key?: Buffer) {
    const k = key ?? this.sessionKey;
    if (!k) throw new Error("no session key");
    this.ws.send(frame(aesEncrypt(k, buildCommand(cmdId, payload))));
  }

  /** Serialize requests sharing a cmd_id (responses match FIFO per cmd). */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private async request(
    cmdId: number,
    payload: Buffer = Buffer.alloc(0),
    key?: Buffer,
    timeoutMs = 15000,
  ): Promise<Mt5Response> {
    if (this.closed) throw new Error("mt5 not connected (session closed)");
    if (!this.waiters.has(cmdId)) this.waiters.set(cmdId, []);
    const queue = this.waiters.get(cmdId)!;
    let waiter!: (r: Mt5Response) => void;
    const p = new Promise<Mt5Response>((resolve) => {
      waiter = resolve;
      queue.push(waiter);
    });
    this.send(cmdId, payload, key);
    const timer = setTimeout(() => {
      const idx = queue.indexOf(waiter);
      if (idx >= 0) queue.splice(idx, 1);
      if (!queue.length) this.waiters.delete(cmdId);
      timeoutRej(new Error(`timeout waiting cmd ${cmdId}`));
    }, timeoutMs);
    let timeoutRej!: (e: Error) => void;
    const t = new Promise<never>((_, rej) => { timeoutRej = rej; });
    try {
      return await Promise.race([p, t]);
    } finally {
      clearTimeout(timer);
      const idx = queue.indexOf(waiter);
      if (idx >= 0) queue.splice(idx, 1);
      if (!queue.length) this.waiters.delete(cmdId);
    }
  }

  /** AUTH with the public static key; derive and store the session key. */
  async auth(): Promise<Buffer> {
    const r = await this.request(CMD.AUTH, Buffer.alloc(64), STATIC_KEY);
    if (r.resCode !== 0) throw new Error(`AUTH failed: res_code=${r.resCode}`);
    this.sessionKey = Buffer.from(r.body.subarray(r.body.length - 32));
    return this.sessionKey;
  }

  /** LOGIN (credentials stay in memory only — never logged, never returned). */
  async login(login: number, password: string): Promise<bigint> {
    const h = Buffer.alloc(912);
    Buffer.from(password, "utf16le").copy(h, 4);
    h.writeUInt32LE(this.host.length, 476);
    Buffer.from(this.host, "utf16le").copy(h, 480);
    h.writeBigUInt64LE(BigInt(login), 736);
    const r = await this.request(CMD.LOGIN, h);
    if (r.resCode !== 0) {
      throw new Error(`LOGIN failed: res_code=${r.resCode}`);
    }
    return r.body.length >= 168 ? r.body.readBigUInt64LE(160) : 0n;
  }

  async account(): Promise<AccountInfo> {
    const r = await this.request(CMD.ACCOUNT);
    const b = r.body;
    return {
      login: 0, // account payload does not echo the login; caller knows it
      balance: b.readDoubleLE(9),
      equity: b.length >= 25 ? b.readDoubleLE(17) : b.readDoubleLE(9),
      currency: utf16(b.subarray(25, 25 + 64)),
      group: utf16(b.subarray(97, 97 + 256)),
      server: utf16(b.subarray(355, 355 + 128)),
    };
  }

  async symbols(): Promise<Map<string, SymbolInfo>> {
    const r = await this.request(CMD.SYMBOLS, undefined, undefined, 20000);
    const blob = r.body.subarray(4);
    let decompressed: Buffer;
    try { decompressed = gunzipSync(blob); }
    catch { try { decompressed = inflateSync(blob); } catch { decompressed = inflateRawSync(blob); } }
    const count = decompressed.readUInt32LE(0);
    const map = new Map<string, SymbolInfo>();
    let off = 4;
    const REC = 526;
    for (let i = 0; i < count && off + REC <= decompressed.length; i++, off += REC) {
      const name = utf16(decompressed.subarray(off, off + 64));
      const digits = decompressed.readUInt32LE(off + 192);
      const id = decompressed.readUInt32LE(off + 196);
      if (name) {
        map.set(name, {
          id, digits, name,
          description: utf16(decompressed.subarray(off + 64, off + 192)),
          path: utf16(decompressed.subarray(off + 200, off + 456)),
        });
      }
    }
    return map;
  }

  /**
   * CANDLES for [fromSec, toSec] (broker time, bar OPEN). 48-byte bars with
   * real prices. Window validation: a bar outside the requested window (±1d
   * slack) throws — a mis-delivered response never poisons the cache.
   */
  async candles(symbol: string, tf: number, fromSec: number, toSec: number): Promise<Mt5Candle[]> {
    return this.run(async () => {
      const pl = Buffer.alloc(74);
      Buffer.from(symbol, "utf16le").copy(pl, 0);
      pl.writeUInt16LE(tf, 64);
      pl.writeInt32LE(fromSec, 66);
      pl.writeInt32LE(toSec, 70);
      const r = await this.request(CMD.CANDLES, pl, undefined, 25000);
      const out: Mt5Candle[] = [];
      for (let off = 0; off + 48 <= r.body.length; off += 48) {
        const b = r.body;
        out.push({
          time: b.readInt32LE(off),
          open: b.readDoubleLE(off + 4),
          high: b.readDoubleLE(off + 12),
          low: b.readDoubleLE(off + 20),
          close: b.readDoubleLE(off + 28),
          tickVolume: Number(b.readBigInt64LE(off + 36)),
          spread: b.readInt32LE(off + 44),
        });
      }
      const slack = 86400;
      for (const b of out) {
        if (b.time < fromSec - slack || b.time > toSec + slack) {
          throw new Error(
            `candles response outside requested window (bar ${b.time}, window [${fromSec}, ${toSec}]) — possible response mismatch`,
          );
        }
      }
      return out;
    });
  }

  // ── Phase 11 trade layer (gated upstream by the manager) ────────────────────

  /**
   * Submit ONE market order (open or close-by-position) as cmd 12: await the
   * immediate 4-byte retcode AND collect the final TRADE_EVENT push (cmd 19,
   * retcode ≠ 10002) that carries the deal details. Serialized through the
   * run() queue exactly like candles(). Budget: TRADE_TIMEOUT_MS overall —
   * if no final event arrives inside the window the immediate retcode is
   * returned honestly with finalEvent=false (deal details unknown; the caller
   * must verify via positions() before assuming anything).
   */
  async trade(req: TradeRequest): Promise<TradeResult> {
    return this.run(async () => {
      const startedAt = Date.now();
      const op = buildOpPayload(req);

      // Register the event waiter BEFORE sending: the final TRADE_EVENT can
      // arrive before the immediate response resolves.
      let resolveEvent!: (e: TradeEventParsed | null) => void;
      const eventP = new Promise<TradeEventParsed | null>((res) => { resolveEvent = res; });
      this.pendingTrade = { symbol: req.symbol, lots: req.lots, resolve: resolveEvent };

      try {
        const r = await this.request(CMD.TRADE, op, undefined, TRADE_TIMEOUT_MS);
        const immediateRetcode = r.body.length >= 4 ? r.body.readUInt32LE(0) : -1;
        if (immediateRetcode < 0 && r.resCode !== 0) {
          throw new Error(`TRADE protocol error: res_code=${r.resCode} body_len=${r.body.length}`);
        }
        const remainingMs = Math.max(250, TRADE_TIMEOUT_MS - (Date.now() - startedAt));
        const ev = await withTimeout(eventP, remainingMs);
        const waitedMs = Date.now() - startedAt;
        if (ev) {
          return {
            retcode: ev.retcode,
            immediateRetcode,
            resCode: r.resCode,
            finalEvent: true,
            accepted: ev.retcode === TRADE_RETCODE.ACCEPTED,
            dealId: ev.dealId,
            orderId: ev.orderId,
            price: ev.price,
            dealtLots: ev.lots,
            dealVolumeRaw: ev.volumeRaw,
            comment: ev.comment,
            waitedMs,
          };
        }
        // No final event inside the window — report the immediate retcode
        // honestly instead of guessing (finalEvent=false tells the caller the
        // deal details are unknown).
        return {
          retcode: immediateRetcode,
          immediateRetcode,
          resCode: r.resCode,
          finalEvent: false,
          accepted: immediateRetcode === TRADE_RETCODE.ACCEPTED,
          dealId: null,
          orderId: null,
          price: null,
          dealtLots: null,
          dealVolumeRaw: "",
          comment: null,
          waitedMs,
        };
      } finally {
        this.pendingTrade = null;
        resolveEvent(null); // release the waiter (no-op once resolved)
      }
    });
  }

  /**
   * List open positions (cmd 4). 344-byte packed records; the pending-orders
   * block that follows is observed but NOT parsed (out of scope by design).
   */
  async positions(): Promise<PositionInfo[]> {
    return this.run(async () => {
      const r = await this.request(CMD.POSITIONS);
      if (r.resCode !== 0) throw new Error(`POSITIONS failed: res_code=${r.resCode}`);
      const b = r.body;
      if (b.length < 4) return [];
      const posCount = b.readUInt32LE(0);
      const REC = 344;
      const out: PositionInfo[] = [];
      let off = 4;
      for (let i = 0; i < posCount && off + REC <= b.length; i++, off += REC) {
        const rec = b.subarray(off, off + REC);
        const action = rec.readUInt32LE(88); // 0 = BUY, 1 = SELL
        if (action !== 0 && action !== 1) continue; // unknown record shape — skipped honestly
        out.push({
          positionId: rec.readBigInt64LE(0).toString(),
          orderId: rec.readBigInt64LE(8).toString(),
          timeCreateUtcSec: rec.readUInt32LE(16),
          timeUpdateUtcSec: rec.readUInt32LE(20),
          symbol: utf16(rec.subarray(24, 88)),
          direction: action === 0 ? "BUY" : "SELL",
          // volume u64 @124 — ÷1e8, empirically calibrated 2025-10-21:
          // a live 0.01-lot position returned raw 1,000,000 (the brief's
          // ÷1e5 assumption would misreport it as 10 lots).
          lots: Number(rec.readBigUInt64LE(124)) / 100000000,
          priceOpen: rec.readDoubleLE(92),
          priceClose: rec.readDoubleLE(100),
          sl: rec.readDoubleLE(108),
          tp: rec.readDoubleLE(116),
          profit: rec.readDoubleLE(132),
          commission: rec.readDoubleLE(156),
          swap: rec.readDoubleLE(164),
        });
      }
      if (out.length < posCount) {
        console.warn(`[mt5-client] POSITIONS truncated: count=${posCount} parsed=${out.length} len=${b.length}`);
      }
      return out;
    });
  }

  /**
   * TRADE_EVENT push (cmd 19). Body = [prefix 4B][Op echo 248B][Ap 128B]
   * (380 bytes). Two events arrive per trade: retcode 10002 (ACK), then the
   * FINAL event (10009 accepted / 10013 invalid / 10030 unsupported …).
   * Only a final event resolves the pending trade; 10002 keeps us waiting.
   *
   * Cross-talk caveat (documented residual risk): the event carries no
   * client-generated correlation id, so a LATE final event for a previous
   * timed-out trade on the SAME symbol could resolve a newer in-flight trade.
   * Trades are serialized through run() and events normally arrive < 1 s, so
   * the window requires a full 15 s timeout followed by an immediate retry —
   * callers that hit finalEvent=false must verify via positions() first.
   */
  private emitTradeEvent(body: Buffer): void {
    const AP = 252; // Ap block starts at byte 252 of the body (4 + 248)
    if (body.length < AP + 36) return; // need retcode/deal/order/volume/price
    const retcode = body.readUInt32LE(AP);
    if (retcode === TRADE_RETCODE.ACK) return; // intermediate ACK — keep waiting
    const pending = this.pendingTrade;
    if (!pending) return;
    const symbol = utf16(body.subarray(4 + 8, 4 + 8 + 64)); // Op echo symbol@8
    if (symbol && pending.symbol && symbol !== pending.symbol) return; // different instrument
    const deal = body.readBigInt64LE(AP + 4);
    const order = body.readBigInt64LE(AP + 12);
    const volumeRaw = body.readBigInt64LE(AP + 20);
    const price = body.readDoubleLE(AP + 28);
    const comment = body.length >= AP + 128 ? utf16(body.subarray(AP + 64, AP + 128)) : null;
    // The reference does not document the Ap volume UNIT (the Op request uses
    // lots × 1e8, position records use lots × 1e5). Calibrate against the
    // known requested volume instead of guessing; the raw integer is always
    // exposed for honest verification.
    let dealtLots: number | null = null;
    if (volumeRaw > 0n && pending.lots > 0) {
      const asOpUnit = Number(volumeRaw) / 1e8;
      const asPosUnit = Number(volumeRaw) / 1e5;
      const best = Math.abs(asOpUnit - pending.lots) <= Math.abs(asPosUnit - pending.lots)
        ? asOpUnit
        : asPosUnit;
      if (Number.isFinite(best) && best > 0) dealtLots = Math.round(best * 100) / 100;
    }
    const parsed: TradeEventParsed = {
      retcode,
      symbol,
      dealId: deal > 0n ? deal.toString() : null,
      orderId: order > 0n ? order.toString() : null,
      volumeRaw: volumeRaw.toString(),
      lots: dealtLots,
      price: Number.isFinite(price) && price > 0 ? price : null,
      comment,
    };
    if (process.env.MT5_DEBUG) {
      console.log(`[mt5-client] TRADE_EVENT retcode=${retcode} deal=${parsed.dealId} order=${parsed.orderId} volumeRaw=${parsed.volumeRaw} price=${parsed.price} comment=${JSON.stringify(comment)}`);
    }
    this.pendingTrade = null;
    pending.resolve(parsed);
  }

  /** Resolve (and clear) an in-flight trade waiter WITHOUT an event — used on
   *  socket close so trade() falls back to the immediate retcode honestly. */
  private releasePendingTrade(): void {
    const pending = this.pendingTrade;
    if (!pending) return;
    this.pendingTrade = null;
    pending.resolve(null);
  }

  subscribe(...symbolIds: number[]) {
    const pl = Buffer.alloc(4 + 4 * symbolIds.length);
    pl.writeUInt32LE(symbolIds.length, 0);
    symbolIds.forEach((id, i) => pl.writeUInt32LE(id, 4 + 4 * i));
    this.send(CMD.SUBSCRIBE, pl);
  }

  heartbeat() { this.hbSentAt = Date.now(); this.send(CMD.HEARTBEAT, Buffer.alloc(0)); }
  close() { this.closed = true; try { this.ws.close(); } catch { /* ignore */ } }
}
