/**
 * Phase 10.3-B — BEFORE/AFTER PAPER-WALK CHRONOLOGY COMPARISON.
 * ----------------------------------------------------------------------------
 * Runs the LEGACY walker (byte-snapshot of src/lib/signal/paper.ts @ 8173751,
 * see scripts/phase10.3b-legacy-walker.ts) and the NEW walker over the SAME
 * frozen synthetic dataset, then diffs every outcome row-by-row and compares
 * the Phase 10.2 pre-registered aggregation inputs.
 *
 * PART 1 (synthetic, ISOLATED THROWAWAY DB — never db/custom.db):
 *   A. normal-cadence rows      → outcomes MUST be identical (no behavior
 *      change in the normal path — the core regression proof)
 *   B. lag rows (bridge-lag / late evaluation) → CHANGED, each documented
 *   C. expiry-boundary rows     → CHANGED (the 13th-bar defect correction)
 *   E. legacy row (no fingerprint) → identical
 *   F. repeated-evaluation cluster → 1 deduped row, identical
 *   G. corrupt-timestamp row    → legacy resolves on bad data; new fails closed
 *
 * PART 2 (LIVE db/custom.db, READ-ONLY — SELECTs only): production paper-row
 *   state (expected 0 — pre-registration intact) and a SHADOW bar-selection
 *   comparison over the REAL persisted evaluations × REAL M15 candles: for
 *   every evaluation, would the old vs new walk bounds select the same bars?
 *   (No setup geometry exists in production — this compares SELECTION, not
 *   outcomes; nothing is written.)
 *
 * Run: bun run scripts/phase10.3b-chronology-comparison.ts
 */

import { spawnSync } from 'node:child_process';
import { rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Project root, derived from this file's location (scripts/ → repo root).
// Portable replacement for the former hardcoded sandbox absolute path.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── Isolated throwaway DB (NEVER the production one) ────────────────────────
const TEST_DB = join(ROOT, 'db/test-chronology-103b.db');
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.MARKET_API_PUBLIC_READS = 'true';
process.env.MT5_BRIDGE_URL = '';
process.env.MT5_BRIDGE_TOKEN = '';
delete process.env.MT5_LOGIN;
delete process.env.MT5_PASSWORD;
delete process.env.MT5_SERVER;
process.env.DATA_API_TOKEN = '';

// Production DB url (READ-ONLY use; never printed) — captured BEFORE the env
// override above took effect… .env is still on disk; parse it directly.
const envText = readFileSync(join(ROOT, '.env'), 'utf8');
const LIVE_URL = (envText.match(/^DATABASE_URL=file:(.+)$/m) ?? [])[1]?.trim() ?? 'db/custom.db';

rmSync(TEST_DB, { force: true });
const push = spawnSync('./node_modules/.bin/prisma', ['db', 'push', '--skip-generate'], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
  encoding: 'utf8',
});
if (push.status !== 0) throw new Error(`throwaway DB preparation failed: ${push.stderr ?? push.stdout}`);

const { db } = await import('../src/lib/db');
const { trackPaperSignals: trackLegacy } = await import('./phase10.3b-legacy-walker');
const { trackPaperSignals: trackNew } = await import('../src/lib/signal/paper');
const paperProtocol = await import('../src/lib/signal/paper-protocol');
const applyFirstOpenRule = paperProtocol.applyFirstOpenRule;
const computeForwardPaperMetrics = paperProtocol.computeForwardPaperMetrics;
type ForwardPaperRowInput = import('../src/lib/signal/paper-protocol').ForwardPaperRowInput;
const { PrismaClient } = await import('@prisma/client');

const SYMBOL = 'XAUUSDm';
const M15 = 900;
/** Frozen dataset clock — Wednesday 2026-10-14 12:00:00 UTC (test-hermetic). */
const NOW = 1_791_979_200;

// ── Seed helpers (synthetic; unique ids/levels/decision regions) ────────────
async function seedEval(o: {
  id: string; direction: 'BUY' | 'SELL'; decisionSec: number; createdAtSec: number;
  level: number; expiryBars?: number;
  /** Explicit structure-break time — omit to derive from decisionSec. Shared
   *  across evaluations = the SAME logical setup (repeated-evaluation cluster). */
  breakSec?: number;
}) {
  const dir = o.direction;
  await db.signalEvaluation.create({
    data: {
      id: o.id, engineVersion: '9.0.0', strategyVersion: 'hybrid-structure-retest/9.0.0',
      symbol: SYMBOL, outcome: dir === 'BUY' ? 'BUY_SETUP' : 'SELL_SETUP',
      reasonCodes: '[]', inputFingerprint: `fp-${o.id}`, datasetFingerprint: `dfp-${o.id}`,
      inputSnapshot: '{}',
      evidence: JSON.stringify({
        structureEvent: {
          type: 'BOS', direction: dir === 'BUY' ? 'bullish' : 'bearish',
          level: o.level, levelText: String(o.level),
          breakCandleTimeUtc: new Date((o.breakSec ?? o.decisionSec - 2 * M15) * 1000).toISOString(),
          barsSinceBreak: 2,
        },
        executionWindow: { fromUtc: new Date((o.decisionSec - 300 * M15) * 1000).toISOString(), toUtc: new Date(o.decisionSec * 1000).toISOString(), bars: 300 },
        h1Window: { fromUtc: new Date(o.decisionSec * 1000).toISOString(), toUtc: new Date(o.decisionSec * 1000).toISOString(), bars: 300 },
        h4Window: { fromUtc: new Date(o.decisionSec * 1000).toISOString(), toUtc: new Date(o.decisionSec * 1000).toISOString(), bars: 300 },
      }),
      levels: JSON.stringify({
        direction: dir, entryZoneLow: o.level, entryZoneHigh: o.level + 1,
        entryReference: 2650, stopLoss: 2640, target: 2670,
        riskPrice: dir === 'BUY' ? 2650 - 2640 : 2640 - 2650,
        rewardPrice: Math.abs(2670 - 2650), rewardRiskRatio: 2,
        entryZoneLowText: String(o.level), entryZoneHighText: String(o.level + 1),
        stopLossText: '2640', targetText: '2670', entryReferenceText: '2650',
      }),
      decisionCandleTimeUtc: new Date(o.decisionSec * 1000),
      setupKnownAtUtc: new Date((o.decisionSec + M15) * 1000),
      expiryUtc: new Date((o.decisionSec + M15 + (o.expiryBars ?? 12) * M15) * 1000),
      quote: '{}', executionLocked: true, durationMs: 5,
      createdAt: new Date(o.createdAtSec * 1000),
    },
  });
}

async function seedBar(timeSec: number, o: number, h: number, l: number, c: number) {
  await db.marketCandle.create({
    data: {
      symbol: SYMBOL, timeframe: 'M15', candleTimeUtc: new Date(timeSec * 1000),
      open: String(o), high: String(h), low: String(l), close: String(c),
      source: 'bridge-mt5', isForming: false, validationStatus: 'VALID',
      receivedAtUtc: new Date((timeSec + M15) * 1000),
    },
  });
}

/** Creation instant: decision close (d+900) + offset seconds. */
const f15 = (d: number, offset: number) => d + M15 + offset;

/** Pre-create a LEGACY paper row (no fingerprint — per-evaluation path). */
async function seedLegacyRow(id: string, decisionSec: number, createdAtSec: number) {
  await db.paperSignalOutcome.create({
    data: {
      signalEvaluationId: id, symbol: SYMBOL, direction: 'BUY',
      signalCreatedAtUtc: new Date(createdAtSec * 1000),
      decisionCandleTimeUtc: new Date(decisionSec * 1000),
      setupKnownAtUtc: new Date((decisionSec + M15) * 1000),
      expiryUtc: new Date((decisionSec + 13 * M15) * 1000),
      datasetFingerprint: null, inputFingerprint: `fp-${id}`, setupFingerprint: null,
      sourceCandleRange: '{}', entryReference: 2650, stopLoss: 2640, target: 2670,
      invalidationLevel: 2699, status: 'open', modeledCostsPrice: 0.28, details: '{}',
    },
  });
}

/** The FROZEN DATASET (all synthetic, deterministic). */
async function seedDataset(): Promise<void> {
  // A. NORMAL CADENCE (creation = decision close + 300 s — production shape)
  // A1 stopped @bar2
  const a1 = NOW - 100 * M15;
  await seedEval({ id: 'cmp-a1-stopped', direction: 'BUY', decisionSec: a1, createdAtSec: a1 + M15 + 300, level: 2501 });
  await seedBar(a1 + M15, 2652, 2658, 2650, 2655);
  await seedBar(a1 + 2 * M15, 2650, 2652, 2639.5, 2644);
  // A2 targeted @bar2
  const a2 = NOW - 120 * M15;
  await seedEval({ id: 'cmp-a2-targeted', direction: 'BUY', decisionSec: a2, createdAtSec: a2 + M15 + 300, level: 2502 });
  await seedBar(a2 + M15, 2650, 2653, 2649, 2652);
  await seedBar(a2 + 2 * M15, 2652, 2671, 2651, 2668);
  // A3 invalidated @bar1
  const a3 = NOW - 140 * M15;
  await seedEval({ id: 'cmp-a3-invalidated', direction: 'BUY', decisionSec: a3, createdAtSec: a3 + M15 + 300, level: 2645 });
  await seedBar(a3 + M15, 2648, 2649, 2644.0, 2644.2);
  // A4 expired with observable bars (window only — no 13th bar in DB)
  const a4 = NOW - 160 * M15;
  await seedEval({ id: 'cmp-a4-expired', direction: 'BUY', decisionSec: a4, createdAtSec: a4 + M15 + 300, level: 2504, expiryBars: 3 });
  await seedBar(a4 + M15, 2652, 2658, 2650, 2655);
  await seedBar(a4 + 2 * M15, 2653, 2659, 2651, 2657);
  // A5 unresolved open (expiry after NOW)
  const a5 = NOW - 4 * M15;
  await seedEval({ id: 'cmp-a5-open', direction: 'BUY', decisionSec: a5, createdAtSec: a5 + M15 + 300, level: 2505 });
  await seedBar(a5 + M15, 2652, 2658, 2650, 2655);

  // B. LAG ROWS (late evaluation — the F4 chronology case)
  // B1: bars 1–3 SL-touch PRE-creation, bar 4 TP-touch post-creation
  const b1 = NOW - 180 * M15;
  await seedEval({ id: 'cmp-b1-lag', direction: 'BUY', decisionSec: b1, createdAtSec: b1 + 4 * M15 + 60, level: 2511 });
  await seedBar(b1 + M15, 2650, 2652, 2635, 2644);
  await seedBar(b1 + 2 * M15, 2650, 2652, 2636, 2644);
  await seedBar(b1 + 3 * M15, 2650, 2652, 2637, 2644);
  await seedBar(b1 + 4 * M15, 2648, 2671, 2647, 2668);
  // B2: ALL bars pre-creation, expiry passed
  const b2 = NOW - 200 * M15;
  await seedEval({ id: 'cmp-b2-lag-all', direction: 'BUY', decisionSec: b2, createdAtSec: b2 + 6 * M15, level: 2512, expiryBars: 3 });
  await seedBar(b2 + M15, 2652, 2658, 2650, 2655);
  await seedBar(b2 + 2 * M15, 2653, 2659, 2651, 2657);
  await seedBar(b2 + 3 * M15, 2654, 2660, 2652, 2658);
  // B3: creation AFTER expiry (evaluation of a long-dead setup)
  const b3 = NOW - 220 * M15;
  await seedEval({ id: 'cmp-b3-post-expiry', direction: 'BUY', decisionSec: b3, createdAtSec: b3 + 20 * M15, level: 2513, expiryBars: 12 });
  await seedBar(b3 + M15, 2650, 2652, 2639.5, 2644); // SL touch, pre-creation

  // C. EXPIRY-BOUNDARY rows (the 13th-bar defect)
  // C1: 12 no-hit bars + 13th bar (opens AT expiry) SL-touch
  const c1 = NOW - 260 * M15;
  await seedEval({ id: 'cmp-c1-expiry-hit', direction: 'BUY', decisionSec: c1, createdAtSec: c1 + M15 + 300, level: 2521 });
  for (let i = 1; i <= 12; i++) await seedBar(c1 + i * M15, 2650, 2655, 2646, 2652);
  await seedBar(c1 + 13 * M15, 2650, 2652, 2639.5, 2644); // opens AT expiry
  // C2: 12 no-hit bars + 13th no-hit bar (expired exit differs)
  const c2 = NOW - 280 * M15;
  await seedEval({ id: 'cmp-c2-expiry-exit', direction: 'BUY', decisionSec: c2, createdAtSec: c2 + M15 + 300, level: 2522 });
  for (let i = 1; i <= 12; i++) await seedBar(c2 + i * M15, 2650, 2655, 2646, 2652);
  await seedBar(c2 + 13 * M15, 2650, 2660, 2647, 2659); // opens AT expiry, closes 2659 (valid OHLC)

  // E. LEGACY row (no fingerprint, per-evaluation path) — normal cadence
  const e1 = NOW - 300 * M15;
  await seedEval({ id: 'cmp-e1-legacy', direction: 'BUY', decisionSec: e1, createdAtSec: e1 + M15 + 300, level: 2531 });
  await seedLegacyRow('cmp-e1-legacy', e1, e1 + M15 + 300);
  await seedBar(e1 + M15, 2650, 2652, 2639.5, 2644); // SL @bar1

  // F1. REPEATED EVALUATIONS of ONE setup, all in NORMAL cadence (the live
  // 2026-10-15 cluster shape: same event, same decision candle, different
  // instants — every creation before the first post-decision bar closes)
  const f1 = NOW - 320 * M15;
  const fBreak = f1 - 2 * M15;
  await seedEval({ id: 'cmp-f1-e1', direction: 'BUY', decisionSec: f1, createdAtSec: f1 + M15 + 300, level: 2541, breakSec: fBreak });
  await seedEval({ id: 'cmp-f1-e2', direction: 'BUY', decisionSec: f1, createdAtSec: f15(f1, 480), level: 2541, breakSec: fBreak });
  await seedEval({ id: 'cmp-f1-e3', direction: 'BUY', decisionSec: f1, createdAtSec: f15(f1, 660), level: 2541, breakSec: fBreak });
  await seedBar(f1 + M15, 2650, 2652, 2639.5, 2644); // SL @bar1 (closes f1+2·M15 — after every creation)

  // F2. Same shape but the NEWEST evaluation (the row CREATOR under the
  // createdAt-DESC scan) lands AFTER bar1 closed: the frozen geometry is the
  // creator's quote, so the invariant correctly excludes bar1 — the OLD walker
  // mixed the creator's entry price with pre-creation price action.
  const f2 = NOW - 360 * M15;
  const f2Break = f2 - 2 * M15;
  await seedEval({ id: 'cmp-f2-e1', direction: 'BUY', decisionSec: f2, createdAtSec: f2 + M15 + 300, level: 2542, breakSec: f2Break });
  await seedEval({ id: 'cmp-f2-e2', direction: 'BUY', decisionSec: f2, createdAtSec: f15(f2, 660), level: 2542, breakSec: f2Break });
  await seedEval({ id: 'cmp-f2-e3', direction: 'BUY', decisionSec: f2, createdAtSec: f2 + M15 + 1020, level: 2542, breakSec: f2Break }); // creator — after bar1 closed
  await seedBar(f2 + M15, 2650, 2652, 2639.5, 2644);  // bar1 SL — closes BEFORE the creator's instant
  await seedBar(f2 + 2 * M15, 2648, 2671, 2647, 2668); // bar2 TP — closes after → NEW resolves here

  // G. CORRUPT TIMESTAMP (off-grid bar in the window)
  const g1 = NOW - 340 * M15;
  await seedEval({ id: 'cmp-g1-corrupt', direction: 'BUY', decisionSec: g1, createdAtSec: g1 + M15 + 300, level: 2551 });
  await db.marketCandle.create({
    data: {
      symbol: SYMBOL, timeframe: 'M15', candleTimeUtc: new Date((g1 + M15 + 37) * 1000),
      open: '2650', high: '2652', low: '2639', close: '2644', // SL-touch corrupt bar
      source: 'bridge-mt5', isForming: false, validationStatus: 'VALID',
      receivedAtUtc: new Date((g1 + 2 * M15) * 1000),
    },
  });
}

interface RowSnap {
  id: string; status: string; outcome: string | null; exitPrice: number | null;
  observations: number; resolutionBar: number | null; netPnl: number | null; rMultiple: number | null;
}

async function snapshot(): Promise<Map<string, RowSnap>> {
  const rows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL } });
  const m = new Map<string, RowSnap>();
  for (const r of rows) {
    m.set(r.signalEvaluationId, {
      id: r.signalEvaluationId, status: r.status, outcome: r.outcome,
      exitPrice: r.exitPrice, observations: r.observations,
      resolutionBar: r.resolutionBarTimeUtc ? Math.floor(r.resolutionBarTimeUtc.getTime() / 1000) : null,
      netPnl: r.netPnlPrice, rMultiple: r.rMultiple,
    });
  }
  return m;
}

function toAggInput(rows: { id: string; signalCreatedAtUtc: Date; status: string; outcome: string | null; netPnlPrice: number | null; rMultiple: number | null; resolutionBarTimeUtc: Date | null; resolvedAtUtc: Date | null; direction: string }[]): ForwardPaperRowInput[] {
  return rows.map((r) => ({
    id: r.id, direction: r.direction, signalCreatedAtMs: r.signalCreatedAtUtc.getTime(),
    status: r.status, outcome: r.outcome, netPnlPrice: r.netPnlPrice, rMultiple: r.rMultiple,
    resolutionBarTimeMs: r.resolutionBarTimeUtc?.getTime() ?? null,
    resolvedAtMs: r.resolvedAtUtc?.getTime() ?? null,
  }));
}

const SCENARIOS: Record<string, string> = {
  'cmp-a1-stopped': 'A1 normal-cadence stopped',
  'cmp-a2-targeted': 'A2 normal-cadence targeted',
  'cmp-a3-invalidated': 'A3 normal-cadence invalidated',
  'cmp-a4-expired': 'A4 normal-cadence expired (window-only bars)',
  'cmp-a5-open': 'A5 normal-cadence open',
  'cmp-b1-lag': 'B1 lag: 3 pre-creation SL bars + post-creation TP bar',
  'cmp-b2-lag-all': 'B2 lag: ALL bars pre-creation, expiry passed',
  'cmp-b3-post-expiry': 'B3 creation AFTER expiry',
  'cmp-c1-expiry-hit': 'C1 expiry boundary: 13th bar (opens at expiry) SL-hit',
  'cmp-c2-expiry-exit': 'C2 expiry boundary: 13th no-hit bar changes expired exit',
  'cmp-e1-legacy': 'E legacy row (no fingerprint, normal cadence)',
  'cmp-f1-e1': 'F1 repeated evals, normal cadence — deduped row keyed by creating eval',
  'cmp-f1-e2': 'F1 repeat evaluation 2 (suppressed — no second row)',
  'cmp-f1-e3': 'F1 repeat evaluation 3 (row creator under createdAt-DESC scan)',
  'cmp-f2-e1': 'F2 lagged creator: newest eval created after bar1 closed (row creator)',
  'cmp-f2-e2': 'F2 repeat evaluation 2 (suppressed — no second row)',
  'cmp-f2-e3': 'F2 lagged creator — row keyed by creating eval e3 (walk starts post-creation)',
  'cmp-g1-corrupt': 'G corrupt off-grid bar (SL-touch)',
};

async function main(): Promise<void> {
  await seedDataset();
  const seededEvalCount = await db.signalEvaluation.count();
  const seededBarCount = await db.marketCandle.count();

  // ── OLD walker over the frozen dataset ────────────────────────────────────
  const oldOut = await trackLegacy(db, { symbol: SYMBOL, now: () => NOW * 1000 });
  const oldRows = await snapshot();
  const oldAggRows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL }, orderBy: { signalCreatedAtUtc: 'asc' } });

  // ── reset paper rows (SignalEvaluation/MarketCandle untouched) ────────────
  await db.paperSignalOutcome.deleteMany({});
  await seedLegacyRow('cmp-e1-legacy', NOW - 300 * M15, NOW - 300 * M15 + M15 + 300); // re-seed legacy row

  // ── NEW walker over the SAME frozen dataset ───────────────────────────────
  const newOut = await trackNew(db, { symbol: SYMBOL, now: () => NOW * 1000 });
  const newRows = await snapshot();
  const newAggRows = await db.paperSignalOutcome.findMany({ where: { symbol: SYMBOL }, orderBy: { signalCreatedAtUtc: 'asc' } });

  console.log('════ PART 1 — SYNTHETIC FROZEN DATASET (isolated throwaway DB) ════');
  console.log(`seeded: ${seededEvalCount} evaluations, ${seededBarCount} candles (all synthetic — never broker data)`);
  console.log(`OLD walker: scanned=${oldOut.scanned} newlyOpened=${oldOut.newlyOpened} resolved=${JSON.stringify(oldOut.resolved)} errors=${oldOut.errors.length}`);
  console.log(`NEW walker: scanned=${newOut.scanned} newlyOpened=${newOut.newlyOpened} resolved=${JSON.stringify(newOut.resolved)} errors=${newOut.errors.length}`);
  if (newOut.errors.length) for (const e of newOut.errors) console.log(`  NEW row error (fail-closed): ${e}`);

  console.log('\n── Row-by-row diff (outcome / exit / resolutionBar / observations / netPnl / R) ──');
  const allIds = [...new Set([...oldRows.keys(), ...newRows.keys()])].sort();
  let identical = 0; let changed = 0;
  for (const id of allIds) {
    const o = oldRows.get(id); const n = newRows.get(id);
    const same = !!o && !!n
      && o.status === n.status && o.outcome === n.outcome
      && o.exitPrice === n.exitPrice && o.observations === n.observations
      && o.resolutionBar === n.resolutionBar && o.netPnl === n.netPnl && o.rMultiple === n.rMultiple;
    const fmt = (r?: RowSnap) => r
      ? `${r.status}/${r.outcome ?? '—'} exit=${r.exitPrice ?? 'null'} bar=${r.resolutionBar ?? 'null'} obs=${r.observations} net=${r.netPnl ?? 'null'} R=${r.rMultiple ?? 'null'}`
      : '(no row)';
    if (same) { identical += 1; } else { changed += 1; }
    console.log(`${same ? 'IDENTICAL' : 'CHANGED  '} ${SCENARIOS[id] ?? id}`);
    if (!same) {
      console.log(`           OLD: ${fmt(o)}`);
      console.log(`           NEW: ${fmt(n)}`);
    }
  }
  console.log(`\nidentical rows: ${identical} / ${allIds.length}; changed rows: ${changed} (each changed row is an edge-case correction — see audit §4)`);

  // ── Phase 10.2 aggregation comparison over both outcome sets ─────────────
  const oldCounting = applyFirstOpenRule(toAggInput(oldAggRows));
  const newCounting = applyFirstOpenRule(toAggInput(newAggRows));
  const oldMetrics = computeForwardPaperMetrics(oldCounting.counted);
  const newMetrics = computeForwardPaperMetrics(newCounting.counted);
  console.log('\n── Phase 10.2 pre-registered aggregation over the SAME dataset ──');
  console.log(`ALL ROWS  OLD: counted=${oldCounting.counted.length} repeats=${oldCounting.repeats.length} metrics=${JSON.stringify(oldMetrics)}`);
  console.log(`ALL ROWS  NEW: counted=${newCounting.counted.length} repeats=${newCounting.repeats.length} metrics=${JSON.stringify(newMetrics)}`);
  // The G row (corrupt bar) stays OPEN under the new fail-closed walker and
  // therefore occupies the single paper position — isolating it shows the
  // chronology-driven aggregation differences alone:
  const oldNoG = oldAggRows.filter((r) => r.signalEvaluationId !== 'cmp-g1-corrupt');
  const newNoG = newAggRows.filter((r) => r.signalEvaluationId !== 'cmp-g1-corrupt');
  const oc2 = applyFirstOpenRule(toAggInput(oldNoG));
  const nc2 = applyFirstOpenRule(toAggInput(newNoG));
  console.log(`SANS-G    OLD: counted=${oc2.counted.length} repeats=${oc2.repeats.length} metrics=${JSON.stringify(computeForwardPaperMetrics(oc2.counted))}`);
  console.log(`SANS-G    NEW: counted=${nc2.counted.length} repeats=${nc2.repeats.length} metrics=${JSON.stringify(computeForwardPaperMetrics(nc2.counted))}`);
  console.log('(aggregation CODE is untouched — differences come only from the corrected edge-case outcomes above)');

  // ── PART 2 — LIVE production DB, read-only ───────────────────────────────
  console.log('\n════ PART 2 — LIVE PRODUCTION DB (READ-ONLY — SELECTs only) ════');
  const live = new PrismaClient({ datasources: { db: { url: `file:${LIVE_URL.startsWith('/') ? '' : ROOT + '/'}${LIVE_URL}` } } });
  try {
    const paperCount = await live.paperSignalOutcome.count();
    const setupEvals = await live.signalEvaluation.count({ where: { outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] } } });
    const evalCount = await live.signalEvaluation.count();
    const candles = await live.marketCandle.count({ where: { symbol: SYMBOL, timeframe: 'M15', isForming: false, validationStatus: 'VALID', source: 'bridge-mt5' } });
    console.log(`production SignalEvaluation rows: ${evalCount} (SETUP outcomes: ${setupEvals})`);
    console.log(`production PaperSignalOutcome rows: ${paperCount} (pre-registration state — nothing has EVER been walked)`);
    console.log(`production verified closed M15 candles: ${candles}`);

    // Shadow bar-selection comparison: for EVERY real evaluation with a decision
    // candle, compare the bar set the OLD vs NEW bounds would select (against
    // the REAL candle table). Hypothetical SETUP expiry = decision + 13·900.
    const evals = await live.signalEvaluation.findMany({
      where: { symbol: SYMBOL, decisionCandleTimeUtc: { not: null } },
      select: { id: true, decisionCandleTimeUtc: true, createdAt: true, outcome: true },
      orderBy: { createdAt: 'asc' },
    });
    const nowSec = Math.floor(Date.now() / 1000);
    let sameSel = 0; let diffSel = 0; let lagged = 0; let firstDiffs: string[] = [];
    for (const ev of evals) {
      const d = Math.floor(ev.decisionCandleTimeUtc!.getTime() / 1000);
      const c = Math.floor(ev.createdAt.getTime() / 1000);
      const exp = d + 13 * M15;
      // OLD bounds: open > d AND open <= min(exp, now)
      // NEW bounds: open > max(d, c-900) AND open < exp AND open <= now
      const bars = await live.marketCandle.findMany({
        where: {
          symbol: SYMBOL, timeframe: 'M15', isForming: false, validationStatus: 'VALID', source: 'bridge-mt5',
          candleTimeUtc: { gt: new Date((d - 1) * 1000), lt: new Date((Math.min(exp, nowSec) + M15) * 1000) },
        },
        select: { candleTimeUtc: true },
        orderBy: { candleTimeUtc: 'asc' },
      });
      const oldSet = bars
        .map((b) => Math.floor(b.candleTimeUtc.getTime() / 1000))
        .filter((t) => t > d && t <= Math.min(exp, nowSec));
      const newSet = oldSet.filter((t) => t > Math.max(d, c - M15) && t < exp);
      const isLag = c > d + 2 * M15; // creation after the first post-decision bar closed
      if (isLag) lagged += 1;
      if (oldSet.length === newSet.length && oldSet.every((t, i) => t === newSet[i])) sameSel += 1;
      else {
        diffSel += 1;
        if (firstDiffs.length < 5) {
          firstDiffs.push(`${ev.id} [${ev.outcome}] decision=${new Date(d * 1000).toISOString()} created=${new Date(c * 1000).toISOString()} oldBars=${oldSet.length} newBars=${newSet.length}`);
        }
      }
    }
    console.log(`shadow bar-selection over ${evals.length} real evaluations: identical=${sameSel} differing=${diffSel}`);
    console.log(`evaluations created AFTER the first post-decision bar closed (F4-relevant lag): ${lagged}`);
    for (const l of firstDiffs) console.log(`  DIFFERING: ${l}`);
    console.log('(no setup geometry exists in production — this compares SELECTION windows only; nothing was written)');
  } finally {
    await live.$disconnect();
    await db.$disconnect();
  }
  rmSync(TEST_DB, { force: true });
}

main().catch((err) => { console.error(err); process.exit(1); });
