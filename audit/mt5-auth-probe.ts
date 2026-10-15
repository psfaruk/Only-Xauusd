/**
 * Phase 2 evidence — MT5 gateway AUTH-only probe (NO credentials, NO trading).
 * ----------------------------------------------------------------------------
 * Proves from THIS sandbox, without any account:
 *   1. WSS connect to the Exness MT5 web-terminal gateway works
 *   2. The AES-256-CBC framed binary protocol handshake (cmd 0 AUTH) works
 *   3. A real session key is returned by the broker
 *
 * This is READ-ONLY and anonymous: AUTH exchanges the public static key for a
 * per-session key. No login, no account, no orders. Run: bun run audit/mt5-auth-probe.ts
 *
 * Protocol reference: psfaruk/xauusd-trad mt5-poc (itself from
 * github.com/leon-git-21/MT5-Client-Reverse-Engineer).
 */
import { createCipheriv, createDecipheriv, randomInt } from "node:crypto";

const STATIC_KEY = Buffer.from(
  "02de02a1a65cc794684fcbea1ecb0fd74ae657e43662c11eee885d2fd64f4964",
  "hex",
);
const ZERO_IV = Buffer.alloc(16);
const GATEWAYS = [
  "47.130.41.116", "57.182.183.85", "16.79.3.122", "18.61.99.175",
  "8.219.172.6", "47.236.224.248", "47.81.62.132", "43.210.112.100",
  "35.154.31.85",
];

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
function frame(enc: Buffer): Buffer {
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32LE(enc.length, 0);
  hdr.writeUInt32LE(1, 4);
  return Buffer.concat([hdr, enc]);
}

async function tryGateway(gw: string): Promise<{ ok: boolean; detail: string }> {
  const url = `wss://${gw}:443/terminal`;
  const ws = new WebSocket(url, {
    headers: {
      Origin: `https://${gw}:443`,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
    // gateways present *.exwebterm.com certs; we dial by IP with SNI inside that domain
    servername: "mt5.exwebterm.com",
    tls: { rejectUnauthorized: true },
  } as never);
  ws.binaryType = "arraybuffer";

  return new Promise((resolve) => {
    const done = (ok: boolean, detail: string) => {
      try { ws.close(); } catch { /* already closed */ }
      resolve({ ok, detail });
    };
    setTimeout(() => done(false, "timeout (8s)"), 8000).unref?.();

    ws.onopen = () => {
      // send AUTH (cmd 0): 64 zero bytes, encrypted with the public static key
      const cmd = Buffer.alloc(4 + 64);
      cmd[0] = randomInt(256);
      cmd[1] = randomInt(256);
      cmd.writeUInt16LE(0, 2);
      ws.send(frame(aesEncrypt(STATIC_KEY, cmd)));
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const raw = Buffer.from(ev.data);
      if (raw.length <= 8) return;
      try {
        const plain = aesDecrypt(STATIC_KEY, raw.subarray(8));
        if (plain.length < 5) return;
        const cmdId = plain.readUInt16LE(2);
        const resCode = plain[4];
        if (cmdId === 0) {
          const sessionKey = plain.subarray(5).subarray(plain.subarray(5).length - 32);
          done(
            resCode === 0,
            resCode === 0
              ? `AUTH OK (res_code=0) — broker returned a ${sessionKey.length}-byte session key (${sessionKey.toString("hex").slice(0, 12)}…)`
              : `AUTH refused res_code=${resCode}`,
          );
        }
      } catch {
        done(false, "undecryptable frame");
      }
    };
    ws.onerror = () => done(false, "WS connect failed");
  });
}

let proved = false;
for (const gw of GATEWAYS) {
  process.stdout.write(`[probe] wss://${gw}:443/terminal … `);
  const r = await tryGateway(gw);
  console.log(r.ok ? `✅ ${r.detail}` : `❌ ${r.detail}`);
  if (r.ok) { proved = true; break; } // one gateway is enough proof
}
console.log(
  proved
    ? "\nRESULT: PROVEN — direct MT5 gateway binary protocol works from this sandbox (anonymous AUTH handshake). No Wine, no MT5 Terminal, no VPS needed for the connection itself."
    : "\nRESULT: NOT PROVEN — no gateway completed the AUTH handshake from this sandbox.",
);
process.exit(proved ? 0 : 1);
