/**
 * XAUUSD AI Trading Agent — SYNTHETIC Market Generator (Phase 11 research)
 * ----------------------------------------------------------------------------
 * *** SYNTHETIC DATA — RESEARCH ONLY ***
 * Produces FABRICATED, seeded, deterministic OHLC series for pipeline
 * mechanics verification (baseline-vs-candidate comparison). This is NEVER
 * broker data, is NEVER persisted as market data, and can NEVER support a
 * performance claim (see audit/phase11-baseline-vs-candidate.md).
 *
 * Design: regime-switching M5 random walk (mulberry32 PRNG + Box-Muller
 * gaussian) over a fixed schedule of up/range/down/range segments, then
 * time-bucket aggregation to M15/H1/H4 — so all timeframes are coherent
 * with each other BY CONSTRUCTION. Same seed → byte-identical series.
 */

import { createHash } from 'node:crypto';
import type { AnalysisCandle } from '@/lib/analysis/types';

export interface SyntheticMarket {
  m5: AnalysisCandle[];
  m15: AnalysisCandle[];
  h1: AnalysisCandle[];
  h4: AnalysisCandle[];
  /** The deterministic regime schedule (bar-index ranges, for reporting). */
  regimes: Array<{ kind: 'up' | 'down' | 'range'; fromM5: number; toM5: number }>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  // Box-Muller (deterministic given the PRNG)
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const M5_SEC = 300;

/** Aligned start so every aggregation bucket is exact. */
const EPOCH_START = 1_793_000_000 - (1_793_000_000 % M5_SEC);

function r2(v: number): number {
  return Number(v.toFixed(2));
}

function aggregate(m5: AnalysisCandle[], tfSec: number): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  let bucketStart = -1;
  let open = 0;
  let high = -Infinity;
  let low = Infinity;
  let close = 0;
  for (const bar of m5) {
    const b = Math.floor((bar.timeUtcSec - EPOCH_START) / tfSec) * tfSec + EPOCH_START;
    if (b !== bucketStart) {
      if (bucketStart >= 0) {
        out.push({
          timeUtcSec: bucketStart, open: r2(open), high: r2(high), low: r2(low), close: r2(close), volume: null,
          openText: r2(open).toFixed(2), highText: r2(high).toFixed(2), lowText: r2(low).toFixed(2), closeText: r2(close).toFixed(2),
        });
      }
      bucketStart = b;
      open = bar.open;
      high = bar.high;
      low = bar.low;
    }
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
    close = bar.close;
  }
  if (bucketStart >= 0) {
    out.push({
      timeUtcSec: bucketStart, open: r2(open), high: r2(high), low: r2(low), close: r2(close), volume: null,
      openText: r2(open).toFixed(2), highText: r2(high).toFixed(2), lowText: r2(low).toFixed(2), closeText: r2(close).toFixed(2),
    });
  }
  return out;
}

/**
 * Deterministic synthetic market. Regime schedule: eight equal segments
 * cycling up → range → down → range → up → range → down → range (each
 * segment = days/8). Trend drift ±0.10/M5 bar; range segments mean-revert
 * (κ = 0.05) around their opening price; σ = 0.55/M5 bar; wicks |N|×0.30.
 */
export function generateSyntheticMarket(opts: { seed: number; days: number }): SyntheticMarket {
  const { seed, days } = opts;
  const rand = mulberry32(seed);
  const totalBars = Math.max(1, Math.round(days * 288));
  const segmentLen = Math.max(1, Math.floor(totalBars / 8));
  const schedule: Array<'up' | 'range' | 'down' | 'range'> = ['up', 'range', 'down', 'range', 'up', 'range', 'down', 'range'];

  const regimes: SyntheticMarket['regimes'] = [];
  const m5: AnalysisCandle[] = [];
  let price = 2650;
  let anchor = price;

  for (let i = 0; i < totalBars; i++) {
    const segIdx = Math.min(schedule.length - 1, Math.floor(i / segmentLen));
    const kind = schedule[segIdx];
    if (regimes.length === 0 || regimes[regimes.length - 1].kind !== kind || i === regimes[regimes.length - 1].toM5 + 1) {
      const last = regimes[regimes.length - 1];
      if (!last || i > last.toM5) {
        regimes.push({ kind, fromM5: i, toM5: Math.min(totalBars - 1, (segIdx + 1) * segmentLen - 1) });
        anchor = price; // range segments revert around their opening price
      }
    }
    const sigma = 0.55;
    let drift = 0;
    if (kind === 'up') drift = 0.10;
    else if (kind === 'down') drift = -0.10;
    else drift = -0.05 * (price - anchor);
    const open = price;
    const ret = drift + sigma * gaussian(rand);
    const close = Math.max(1, open + ret);
    const upper = Math.abs(gaussian(rand)) * 0.30;
    const lower = Math.abs(gaussian(rand)) * 0.30;
    const high = Math.max(open, close) + upper;
    const low = Math.max(0.01, Math.min(open, close) - lower);
    m5.push({
      timeUtcSec: EPOCH_START + i * M5_SEC,
      open: r2(open), high: r2(high), low: r2(low), close: r2(close), volume: null,
      openText: r2(open).toFixed(2), highText: r2(high).toFixed(2), lowText: r2(low).toFixed(2), closeText: r2(close).toFixed(2),
    });
    price = close;
  }

  return { m5, m15: aggregate(m5, 900), h1: aggregate(m5, 3600), h4: aggregate(m5, 14400), regimes };
}

/** Stable fingerprint over every timeframe's full OHLC text. */
export function syntheticDatasetFingerprint(d: SyntheticMarket): string {
  const h = createHash('sha256');
  h.update(`synthetic|M5=${d.m5.length}|M15=${d.m15.length}|H1=${d.h1.length}|H4=${d.h4.length}`);
  for (const c of d.m5) h.update(`|5${c.timeUtcSec},${c.openText},${c.highText},${c.lowText},${c.closeText}`);
  for (const c of d.m15) h.update(`|15${c.timeUtcSec},${c.openText},${c.highText},${c.lowText},${c.closeText}`);
  for (const c of d.h1) h.update(`|60${c.timeUtcSec},${c.openText},${c.highText},${c.lowText},${c.closeText}`);
  for (const c of d.h4) h.update(`|240${c.timeUtcSec},${c.openText},${c.highText},${c.lowText},${c.closeText}`);
  return h.digest('hex');
}
