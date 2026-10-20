/**
 * mt5-bridge — Phase 11 order-layer self-test (probe-orders.ts)
 * ----------------------------------------------------------------------------
 * DRY-RUN ONLY: this probe NEVER places, modifies or cancels any order. It
 *   1. loads ../../.env (the same file the service loads via --env-file; real
 *      process env always wins — values are never printed),
 *   2. checks the BRIDGE_ORDERS_ENABLED gate through the manager,
 *   3. (only when the layer is ARMED) opens an in-process manager session and
 *      lists live positions via read-only cmd 4,
 *   4. verifies the 248-byte TRADE payload serialization for a sample order
 *      and a sample close (byte length, volume encoding, symbol/comment
 *      fields, price/SL/TP offsets) — pure in-memory, no network.
 * Exit 0 = all assertions passed. A DISABLED layer is a PASS for this probe —
 * it is the required default posture (the live round-trip test is done
 * manually by the orchestrator, never by this probe).
 */

const ENV_FILE = new URL("../../.env", import.meta.url);

/** Minimal .env loader — never overrides already-set process env, never logs. */
async function loadEnvFile(): Promise<void> {
  let text: string;
  try {
    text = await Bun.file(ENV_FILE).text();
  } catch {
    return; // no .env — keep whatever the process env provides
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue; // blank lines / comments
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    process.exitCode = 1;
  }
}

await loadEnvFile();

// Import AFTER env loading so the manager sees the same BRIDGE_ORDERS_ENABLED
// posture the service would see.
const manager = await import("./src/manager");
const { buildOpPayload } = await import("./src/mt5-client");

console.log(`[probe-orders] ordersEnabled=${manager.ordersEnabled} maxOrderLots=${manager.maxOrderLots}`);

if (!manager.ordersEnabled) {
  console.log("ORDER LAYER DISABLED (expected without BRIDGE_ORDERS_ENABLED)");
  console.log("[probe-orders] live position listing skipped (gated behind the disabled layer) — dry-run below still runs.");
} else {
  console.log("[probe-orders] order layer ARMED — connecting an in-process manager session (read-only)…");
  try {
    await manager.connect();
  } catch (e) {
    console.error(`[probe-orders] connect failed: ${e instanceof Error ? e.message : e}`);
  }
  for (let i = 0; i < 40 && !manager.snapshot().connected; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const s = manager.snapshot();
  console.log(`[probe-orders] session: connected=${s.connected} authenticated=${s.authenticated} server=${s.server} symbols=${s.symbolsLoaded}`);
  if (!s.connected) {
    console.error("[probe-orders] no connected broker session — live position listing NOT verified");
    process.exitCode = 1;
  } else {
    try {
      const positions = await manager.listPositions();
      console.log(`[probe-orders] live positions: ${positions.length}`);
      for (const p of positions) {
        console.log(
          `  · #${p.positionId} ${p.direction} ${p.lots} ${p.symbol} open=${p.priceOpen} sl=${p.sl} tp=${p.tp} profit=${p.profit}`,
        );
      }
    } catch (e) {
      console.error(`[probe-orders] listPositions failed: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    }
  }
  manager.stop();
}

// ── DRY-RUN serialization test (always runs; never touches the network) ─────
console.log("[probe-orders] DRY-RUN: building a sample 248-byte TRADE payload (NO order will be sent)…");
const op = buildOpPayload({
  symbol: "XAUUSDm",
  type: "BUY",
  lots: 0.01,
  price: 4200.125,
  digits: 3,
  sl: 4195.5,
  tp: 4210.0,
  comment: "probe-dry-run",
});
assert(op.length === 248, `payload length is 248 (got ${op.length})`);
assert(op.readUInt32LE(0) === 0, "action_id@0 = 0 (new request)");
assert(op.readUInt32LE(4) === 3, "trade_action@4 = 3 (MARKET — verified for open AND close; action 10 CLOSE returns 10030)");
assert(op.toString("utf16le", 8, 8 + 14) === "XAUUSDm", "symbol@8 is UTF-16LE 'XAUUSDm'");
assert(op[8 + 14] === 0 && op[8 + 15] === 0, "symbol field zero-padded to 64 bytes");
assert(op.readBigUInt64LE(72) === 1000000n, "volume@72 for 0.01 lots = 1000000 (lots × 100000000)");
assert(op.readUInt32LE(80) === 3, "digits@80 = 3");
assert(op.readBigUInt64LE(84) === 0n, "trade_order@84 = 0 (server-assigned)");
assert(op.readUInt32LE(92) === 0, "trade_type@92 = 0 (BUY)");
assert(op.readUInt32LE(96) === 0, "type_filling@96 = 0 (FOK)");
assert(op.readUInt32LE(100) === 0, "type_time@100 = 0 (GTC)");
assert(op.readUInt32LE(104) === 2, "type_flags@104 = 2 (new order)");
assert(op.readUInt32LE(108) === 0, "type_reason@108 = 0");
assert(op.readDoubleLE(112) === 4200.125, "price_order@112 f64 = 4200.125 (ask for BUY)");
assert(op.readDoubleLE(120) === 0, "price_trigger@120 = 0");
assert(op.readDoubleLE(128) === 4195.5, "price_sl@128 f64 = 4195.5");
assert(op.readDoubleLE(136) === 4210.0, "price_tp@136 f64 = 4210.0");
assert(op.readUInt32LE(144) === 0, "price_deviation@144 = 0");
assert(op.readDoubleLE(148) === 0 && op.readDoubleLE(156) === 0, "price_top@148 / price_bottom@156 = 0");
assert(op.toString("utf16le", 164, 164 + 26) === "probe-dry-run", "comment@164 is UTF-16LE 'probe-dry-run'");
assert(op.readBigUInt64LE(228) === 0n, "trade_position@228 = 0 (new order)");
assert(op.readBigUInt64LE(236) === 0n, "position_by@236 = 0");
assert(op.readUInt32LE(244) === 0, "time_expiration@244 = 0");
console.log("  (offset note: price_order sits at 112 — the field table that sums to 248 and the TRADE_EVENT Op-echo offsets both place it there; a brief's 'offset 88' matches no consistent layout)");

const closeOp = buildOpPayload({
  symbol: "XAUUSDm",
  type: "SELL",
  lots: 0.10,
  price: 4199.5,
  digits: 3,
  sl: 0,
  tp: 0,
  comment: "phase11-close",
  closePositionId: 123456789012n,
});
assert(closeOp.length === 248, "close payload length is 248");
assert(closeOp.readUInt32LE(92) === 1, "close trade_type@92 = 1 (SELL — opposite side of a BUY position)");
assert(closeOp.readBigUInt64LE(228) === 123456789012n, "close trade_position@228 = position id");
assert(closeOp.readBigUInt64LE(72) === 10000000n, "close volume@72 for 0.10 lots = 10000000");

// Length guards (the wire fields are fixed 64-byte UTF-16 — refuse, never truncate).
let threw = false;
try {
  buildOpPayload({ symbol: "XAUUSDm", type: "BUY", lots: 0.01, price: 4200, digits: 3, sl: 0, tp: 0, comment: "x".repeat(33) });
} catch {
  threw = true;
}
assert(threw, "33-char comment is refused (64-byte UTF-16 field = 32 chars max)");
threw = false;
try {
  buildOpPayload({ symbol: "XAUUSDm", type: "BUY", lots: 0, price: 4200, digits: 3, sl: 0, tp: 0 });
} catch {
  threw = true;
}
assert(threw, "zero-lot order is refused by the serializer");

console.log(
  (process.exitCode ?? 0) === 0
    ? "[probe-orders] DRY-RUN serialization assertions PASSED — no live order was placed"
    : "[probe-orders] DRY-RUN FAILED",
);
process.exit(process.exitCode ?? 0);
