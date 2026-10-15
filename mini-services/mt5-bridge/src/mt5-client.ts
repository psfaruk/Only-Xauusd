/**
 * mt5-bridge — READ-ONLY MT5 WebSocket protocol client (Phase 8)
 * ----------------------------------------------------------------------------
 * Speaks the Exness MT5 web-terminal binary protocol over
 * `wss://<gateway-ip>:443/terminal` (AES-256-CBC framed) — the same protocol
 * the official Exness web terminal uses. Protocol reference: the user's
 * verified `mt5-poc/PROTOCOL.md` (psfaruk/Xauusd-trad, verified live
 * 2026-09-27) plus the production mt5-service implementation.
 *
 * ─── READ-ONLY BY CONSTRUCTION ───────────────────────────────────────────────
 * This client implements ONLY the market-data command set:
 *   AUTH (0) · ACCOUNT (3) · SUBSCRIBE (7) · QUOTES push (8) · CANDLES (11)
 *   LOGIN (28) · SYMBOLS (34) · HEARTBEAT (51)
 * The trading command layer of the reference implementation (TRADE cmd 12,
 * POSITIONS 4, DEALS 5, TRADE_EVENT 19, POS_UPDATE 22 …) is deliberately NOT
 * ported. There is no code path here that can place, modify or cancel an
 * order, and no function that queries positions or deals. Enforced by the
 * Phase 8 static security scan (no order/trade/position tokens).
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

/** READ-ONLY command ids (the trading ids are intentionally absent). */
const CMD = {
  AUTH: 0,
  ACCOUNT: 3,
  SUBSCRIBE: 7,
  QUOTES: 8,
  CANDLES: 11,
  LOGIN: 28,
  SYMBOLS: 34,
  HEARTBEAT: 51,
} as const;

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

  subscribe(...symbolIds: number[]) {
    const pl = Buffer.alloc(4 + 4 * symbolIds.length);
    pl.writeUInt32LE(symbolIds.length, 0);
    symbolIds.forEach((id, i) => pl.writeUInt32LE(id, 4 + 4 * i));
    this.send(CMD.SUBSCRIBE, pl);
  }

  heartbeat() { this.hbSentAt = Date.now(); this.send(CMD.HEARTBEAT, Buffer.alloc(0)); }
  close() { this.closed = true; try { this.ws.close(); } catch { /* ignore */ } }
}
