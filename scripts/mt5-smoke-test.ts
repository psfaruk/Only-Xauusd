/**
 * REAL MT5 BRIDGE SMOKE TEST (Phase 3) — NOT a mock.
 * ----------------------------------------------------------------------------
 * Run this ONLY against the real bridge when it is deployed and the Exness
 * demo account is connected. It performs read-only checks and validates live
 * responses with the same deterministic validators the pipeline uses.
 *
 *   bun run market:smoke                       (uses MT5_BRIDGE_URL + token from .env)
 *   MT5_BRIDGE_URL=http://127.0.0.1:3031 bun run market:smoke
 *
 * Every step prints PASS / FAIL / SKIP with evidence. The exit code is 0 only
 * when ALL steps that ran passed. If the bridge is not configured, the script
 * reports SKIP (exit 2) — it never pretends a live test happened.
 */

import { config } from '../src/lib/config';
import { createBridgeClient } from '../src/lib/market/bridge-client';
import { validateCandleBatch, validateQuote } from '../src/lib/market/validation';
import type { Timeframe } from '../src/lib/market/types';

interface StepResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

const results: StepResult[] = [];
const step = (name: string, status: StepResult['status'], detail: string) => {
  results.push({ name, status, detail });
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '–';
  console.log(` ${icon} [${status}] ${name}\n     ${detail}`);
};

const TFS: Timeframe[] = ['M5', 'M15', 'H1', 'H4'];
const SYMBOL = config.market.symbols[0] ?? 'XAUUSDm';

async function main() {
  console.log('════════════════════════════════════════════════════════════');
  console.log(' REAL MT5 BRIDGE SMOKE TEST — live checks, no mocks');
  console.log(` bridge: ${config.bridge.url || '(not configured)'}`);
  console.log(` symbol: ${SYMBOL} · timeframes: ${config.market.timeframes.join('/')}`);
  console.log('════════════════════════════════════════════════════════════\n');

  if (!config.bridge.url) {
    step('bridge configuration', 'SKIP', 'MT5_BRIDGE_URL is empty — no real bridge to test. Deploy the Phase 2 bridge (e.g. port the read-only mt5-service from psfaruk/xauusd-trad to mini-services/ or your VPS), set MT5_BRIDGE_URL (+ MT5_BRIDGE_TOKEN), then re-run.');
    finish(2);
    return;
  }

  const client = createBridgeClient();

  // ---- 1. Health -------------------------------------------------------------
  const health = await client.getHealth();
  if (!health.ok) {
    step('GET /health', 'FAIL', `${health.error.code}: ${health.error.message}`);
    finish(1);
    return;
  }
  step(
    'GET /health',
    'PASS',
    `ok=${health.data.ok} service=${health.data.service ?? '?'} connected=${health.data.connected} source=${health.data.source} uptime=${health.data.uptime ?? '?'}s`,
  );

  // ---- 2. Status (feed source + connection) -----------------------------------
  const status = await client.getStatus();
  if (!status.ok) {
    step('GET /api/status', 'FAIL', `${status.error.code}: ${status.error.message}`);
    finish(1);
    return;
  }
  const src = String(status.data.source);
  step(
    'GET /api/status',
    src === 'mt5' ? 'PASS' : 'FAIL',
    `connected=${status.data.connected} source=${src} server=${status.data.server ?? '?'} latency=${status.data.latencyMs ?? '?'}ms${src !== 'mt5' ? ' — expected source "mt5" (real account). A demo feed or disconnected terminal means the smoke test cannot verify live XAUUSDm data.' : ''}`,
  );
  if (src !== 'mt5') {
    finish(1);
    return;
  }

  // ---- 3. Symbols -------------------------------------------------------------
  const symbols = await client.getSymbols();
  if (!symbols.ok) {
    step('GET /api/symbols', 'FAIL', `${symbols.error.code}: ${symbols.error.message}`);
    finish(1);
    return;
  }
  const hasSymbol = symbols.data.list.includes(SYMBOL);
  step(
    'GET /api/symbols',
    hasSymbol ? 'PASS' : 'FAIL',
    hasSymbol ? `${SYMBOL} present (${symbols.data.list.length} symbols served)` : `${SYMBOL} NOT in bridge symbol list: ${symbols.data.list.slice(0, 10).join(', ')}`,
  );
  if (!hasSymbol) {
    finish(1);
    return;
  }

  // ---- 4. Quote (live tick) -----------------------------------------------------
  const nowSec = Math.floor(Date.now() / 1000);
  const quote = await client.getQuote(SYMBOL);
  if (!quote.ok) {
    step('GET /api/quote', 'FAIL', `${quote.error.code}: ${quote.error.message}`);
  } else {
    const v = validateQuote(quote.data, { nowUtcSec: nowSec, digits: null });
    step(
      'GET /api/quote',
      v.status === 'INVALID' ? 'FAIL' : 'PASS',
      v.normalized
        ? `bid=${v.normalized.bid} ask=${v.normalized.ask} ts=${new Date(v.normalized.tickTimeUtcSec * 1000).toISOString()} validation=${v.status}${v.errorCodes.length ? ` codes=[${v.errorCodes.join(',')}]` : ''}`
        : `INVALID tick: ${v.errorCodes.join(',')}`,
    );
  }

  // ---- 5. Candles per timeframe (live validation) -------------------------------
  let candlesOk = true;
  for (const tf of TFS) {
    const res = await client.getCandles({ symbol: SYMBOL, timeframe: tf, limit: 300 });
    if (!res.ok) {
      step(`GET /api/candles ${tf}`, 'FAIL', `${res.error.code}: ${res.error.message}`);
      candlesOk = false;
      continue;
    }
    const batch = validateCandleBatch(res.data.bars, {
      timeframe: tf,
      nowUtcSec: nowSec,
      digits: typeof res.data.digits === 'number' ? res.data.digits : null,
    });
    const newest = batch.candles[batch.candles.length - 1];
    const ok = batch.candles.length > 0 && batch.rejected === 0;
    if (!ok) candlesOk = false;
    step(
      `GET /api/candles ${tf}`,
      ok ? 'PASS' : 'FAIL',
      `bars=${res.data.bars.length} valid=${batch.candles.length} rejected=${batch.rejected} duplicates=${batch.duplicates} digits=${res.data.digits ?? '?'} newest=${newest ? new Date(newest.candleTimeUtcSec * 1000).toISOString() : '—'}${batch.issues.length ? ` issues=[${[...new Set(batch.issues.map((i) => i.code))].join(',')}]` : ''}`,
    );
  }

  finish(candlesOk ? 0 : 1);
}

function finish(code: number) {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(` RESULT: ${pass} pass · ${fail} fail · ${skip} skip → exit ${code}`);
  console.log(' Read-only smoke test. No orders were sent (none exist in this app).');
  console.log('════════════════════════════════════════════════════════════');
  process.exit(code);
}

void main();
