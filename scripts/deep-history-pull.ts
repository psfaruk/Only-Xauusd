/**
 * Deep history pull (Task 38, one-off) — maximize per-TF candle depth in the
 * DB directly from the mt5-bridge (the HTTP API caps at 2000 bars/request).
 * The scheduled sync refreshes recent bars; this deepens M1/M5/M15 so the
 * backtest harness (and the engine's indicator warm-ups) get maximum history.
 *
 * Usage:  bun --env-file=.env scripts/deep-history-pull.ts
 */
import { db } from '@/lib/db';

const SYMBOL = (process.env.MARKET_SYMBOLS ?? 'XAUUSDm').split(',')[0]?.trim() || 'XAUUSDm';
const BRIDGE_URL = (process.env.MT5_BRIDGE_URL ?? '').replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.MT5_BRIDGE_TOKEN ?? '';
const PLAN: Array<{ tf: string; limit: number }> = [
  { tf: 'M1', limit: 2000 },
  { tf: 'M5', limit: 2000 },
  { tf: 'M15', limit: 2000 },
  { tf: 'H1', limit: 1000 },
  { tf: 'H4', limit: 500 },
];

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; f: number }

async function pull(tf: string, limit: number): Promise<Bar[]> {
  const res = await fetch(`${BRIDGE_URL}/api/candles?symbol=${SYMBOL}&tf=${tf}&limit=${limit}`, {
    headers: { 'x-trader-key': BRIDGE_TOKEN },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${tf}: HTTP ${res.status}`);
  const body = (await res.json()) as { bars?: Bar[] };
  return body.bars ?? [];
}

async function main() {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) throw new Error('MT5_BRIDGE_URL / MT5_BRIDGE_TOKEN missing');
  const receivedAt = new Date();
  for (const { tf, limit } of PLAN) {
    const bars = await pull(tf, limit);
    let inserted = 0;
    let updated = 0;
    let rejected = 0;
    for (const b of bars) {
      const ok =
        Number.isFinite(b.t) && b.t > 0 &&
        [b.o, b.h, b.l, b.c].every((v) => Number.isFinite(v) && v > 0) &&
        b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c) && b.h >= b.l;
      if (!ok) { rejected++; continue; }
      const time = new Date(b.t * 1000);
      const row = await db.marketCandle.upsert({
        where: { symbol_timeframe_candleTimeUtc: { symbol: SYMBOL, timeframe: tf, candleTimeUtc: time } },
        create: {
          symbol: SYMBOL,
          timeframe: tf,
          candleTimeUtc: time,
          open: String(b.o),
          high: String(b.h),
          low: String(b.l),
          close: String(b.c),
          tickVolume: Number.isFinite(b.v) ? Math.max(0, Math.round(b.v)) : null,
          spread: null,
          source: 'bridge-mt5',
          isForming: b.f === 1,
          validationStatus: 'VALID',
          receivedAtUtc: receivedAt,
        },
        update: {
          open: String(b.o),
          high: String(b.h),
          low: String(b.l),
          close: String(b.c),
          tickVolume: Number.isFinite(b.v) ? Math.max(0, Math.round(b.v)) : null,
          isForming: b.f === 1,
          validationStatus: 'VALID',
          receivedAtUtc: receivedAt,
        },
      });
      if (row.createdAt.getTime() === row.receivedAtUtc.getTime()) inserted++;
      else updated++;
    }
    const oldest = bars.length ? new Date(bars[0].t * 1000).toISOString().slice(0, 16) : '-';
    const newest = bars.length ? new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 16) : '-';
    console.log(`${tf.padEnd(3)} pulled ${String(bars.length).padStart(4)} · inserted ${inserted} · updated ${updated} · rejected ${rejected} · ${oldest} → ${newest}`);
  }
}

main()
  .catch((err) => { console.error('deep-history-pull failed:', err); process.exit(1); })
  .finally(() => db.$disconnect());
