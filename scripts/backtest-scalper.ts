/**
 * XAUUSD AI Trading Agent — SCALPER BACKTEST (Task 38)
 * ----------------------------------------------------------------------------
 * The user's demand: "তোমি নিজেই backtest করে ভেরিফাই করো" — verify the signal
 * engine yourself, don't just claim it works.
 *
 * This harness replays the REAL production engine over the historical candles
 * in the database — no reimplementation, no look-ahead:
 *
 *   · evaluateScalper()          — the exact live deterministic core (SMC
 *                                  ten-agent confluence + momentum/reversal +
 *                                  Task-36/37 gates + SL/TP geometry)
 *   · decideManagedPosition()    — the exact live position-manager pure core
 *                                  (breakeven +1.0R, trail +1.5R @1×ATR,
 *                                  time-stop 45min)
 *   · suppressSetup semantics    — cooldown / same-decision-bar dedup /
 *                                  post-loss circuit breaker, replicated from
 *                                  scalper-service.ts
 *
 * Two scenarios isolate Task 37 (structure gates + SL/TP geometry):
 *   CURRENT — rules as configured (gates ON, SL 1.5×ATR, RR 1.2)
 *   LEGACY  — gates OFF (SMC_LEGACY_GATE=0 equivalent), SL 1.2×ATR, RR 1.5
 *
 * Honest limitations (documented, not hidden):
 *   · constant 0.30 spread assumption (Exness XAUUSDm demo typical)
 *   · entry = NEXT M1 bar open ± half-spread (signal at close, fill after)
 *   · bar-level simulation: when a bar's range covers BOTH SL and TP, the SL
 *     is assumed to fill first (pessimistic)
 *   · one open position at a time (live risk path may occasionally overlap,
 *     but the observed live behaviour is effectively serial)
 *   · data depth = whatever the DB holds (the bridge caps at 2000 bars/call)
 *
 * Usage:  bun --env-file=.env scripts/backtest-scalper.ts
 */
import { db } from '@/lib/db';
import { evaluateScalper, setupFingerprintOf } from '@/lib/signal/scalper/core';
import { buildScalperRules } from '@/lib/signal/scalper/rules';
import type { ScalperRules } from '@/lib/signal/scalper/types';
import {
  decideManagedPosition,
  initialManagedState,
  managerThresholdsFromConfig,
  type ManagedPositionState,
} from '@/lib/execution/position-manager';
import { atrSeries } from '@/lib/analysis/indicators';
import type { AnalysisCandle } from '@/lib/analysis/types';
import { TIMEFRAME_SECONDS, type Timeframe } from '@/lib/market/types';
import type { SignalWindow } from '@/lib/signal/types';
import { writeFileSync, mkdirSync } from 'node:fs';

// ── assumptions ─────────────────────────────────────────────────────────────
const SPREAD = 0.3; // price units — typical Exness XAUUSDm demo spread
const HALF = SPREAD / 2;
const SYMBOL = (process.env.MARKET_SYMBOLS ?? 'XAUUSDm').split(',')[0]?.trim() || 'XAUUSDm';
const TFS: Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4'];
const M1_SEC = TIMEFRAME_SECONDS.M1;

type CloseReason = 'TP' | 'SL' | 'BREAKEVEN' | 'TRAIL' | 'TIME_STOP' | 'OPEN_AT_END';

interface TradeRecord {
  direction: 'BUY' | 'SELL';
  model: string;
  sourceTf: string;
  entry: number;
  sl: number;
  tp: number;
  openIdx: number;
  closeIdx: number;
  bars: number;
  reason: CloseReason;
  realizedR: number;
}

interface ScenarioStats {
  evaluations: number;
  blocked: number;
  noSetup: number;
  wait: number;
  rawSetups: number;
  suppressedDuplicate: number;
  suppressedCooldown: number;
  suppressedPostLoss: number;
  suppressedBusy: number;
  trades: number;
  byReason: Record<CloseReason, number>;
  totalR: number;
  avgR: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownR: number;
  avgBars: number;
  perModel: Map<string, { trades: number; wins: number; totalR: number }>;
  perTf: Map<string, { trades: number; wins: number; totalR: number }>;
  tradesLog: TradeRecord[];
}

function emptyStats(): ScenarioStats {
  return {
    evaluations: 0,
    blocked: 0,
    noSetup: 0,
    wait: 0,
    rawSetups: 0,
    suppressedDuplicate: 0,
    suppressedCooldown: 0,
    suppressedPostLoss: 0,
    suppressedBusy: 0,
    trades: 0,
    byReason: { TP: 0, SL: 0, BREAKEVEN: 0, TRAIL: 0, TIME_STOP: 0, OPEN_AT_END: 0 },
    totalR: 0,
    avgR: 0,
    winRate: 0,
    profitFactor: 0,
    maxDrawdownR: 0,
    avgBars: 0,
    perModel: new Map(),
    perTf: new Map(),
    tradesLog: [],
  };
}

// ── data load ───────────────────────────────────────────────────────────────
type LoadedBar = AnalysisCandle;

async function loadCandles(tf: Timeframe): Promise<LoadedBar[]> {
  const rows = await db.marketCandle.findMany({
    where: {
      symbol: SYMBOL,
      timeframe: tf,
      isForming: false,
      validationStatus: { in: ['VALID', 'WARNING'] },
    },
    orderBy: { candleTimeUtc: 'asc' },
  });
  const out: LoadedBar[] = [];
  for (const r of rows) {
    const o = Number(r.open);
    const h = Number(r.high);
    const l = Number(r.low);
    const c = Number(r.close);
    if (![o, h, l, c].every((v) => Number.isFinite(v) && v > 0)) continue;
    if (h < Math.max(o, c) || l > Math.min(o, c) || l > h) continue;
    out.push({
      timeUtcSec: Math.floor(r.candleTimeUtc.getTime() / 1000),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: r.tickVolume,
      openText: r.open,
      highText: r.high,
      lowText: r.low,
      closeText: r.close,
    });
  }
  return out;
}

function windowAt(bars: LoadedBar[], tfSec: number, nowUtcSec: number, windowBars: number, uptoIdx: number): SignalWindow {
  // bars[0..uptoIdx] are candidates; keep those CLOSED by nowUtcSec.
  let hi = uptoIdx;
  while (hi >= 0 && bars[hi].timeUtcSec + tfSec > nowUtcSec) hi--;
  const lo = Math.max(0, hi + 1 - windowBars);
  return {
    timeframe: tfSec === 60 ? 'M1' : tfSec === 300 ? 'M5' : tfSec === 900 ? 'M15' : tfSec === 3600 ? 'H1' : 'H4',
    candles: bars.slice(lo, hi + 1),
    source: 'mt5-bridge',
  } as SignalWindow;
}

/** M1 ATR(14) evaluated at bar index j (Wilder, last CLOSED bar = j). */
function m1AtrAt(m1: LoadedBar[], j: number): number | null {
  const from = Math.max(0, j - 29);
  const slice = m1.slice(from, j + 1);
  const res = atrSeries(slice, 14);
  if (!res.ok) return null;
  const v = res.series.values[slice.length - 1];
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

// ── one scenario run ────────────────────────────────────────────────────────
function runScenario(
  name: string,
  rules: ScalperRules,
  data: Record<Timeframe, LoadedBar[]>,
  digits: number,
  thresholds: ReturnType<typeof managerThresholdsFromConfig>,
): ScenarioStats {
  const m1 = data.M1;
  const N = m1.length;
  const stats = emptyStats();
  const dedupWindowSec = Math.max(rules.expirySec.M15, 2 * rules.cooldownSec);
  const emitted = new Map<string, number>(); // fingerprint → emit sec
  let lastEmitSec = -Infinity;
  let lastLossCloseSec = -Infinity;
  let openTrade: null | {
    direction: 'BUY' | 'SELL';
    model: string;
    sourceTf: string;
    entry: number;
    sl: number;
    tp: number;
    riskUnit: number;
    openIdx: number;
    openTimeMs: number;
    lastManaged: number;
    state: ManagedPositionState;
  } = null;

  // per-TF monotonic pointers (windows only ever grow forward)
  const upto: Record<Timeframe, number> = { M1: -1, M5: -1, M15: -1, H1: -1, H4: -1 };
  const advance = (tf: Timeframe, nowUtcSec: number) => {
    const bars = data[tf];
    const tfSec = TIMEFRAME_SECONDS[tf];
    while (upto[tf] + 1 < bars.length && bars[upto[tf] + 1].timeUtcSec + tfSec <= nowUtcSec) upto[tf]++;
  };

  // warm-up: every TF window must have >= minBarsPerTf closed bars
  let start = 0;
  while (
    start < N &&
    !(data.M15.filter((b) => b.timeUtcSec + 900 <= m1[start].timeUtcSec + M1_SEC).length >= rules.minBarsPerTf &&
      data.M5.filter((b) => b.timeUtcSec + 300 <= m1[start].timeUtcSec + M1_SEC).length >= rules.minBarsPerTf &&
      start + 1 >= rules.minBarsPerTf)
  ) {
    start++;
  }

  for (let i = start; i < N - 1; i++) {
    const nowUtcSec = m1[i].timeUtcSec + M1_SEC; // decision instant = M1 close
    for (const tf of TFS) advance(tf, nowUtcSec);

    // a position opened earlier is still being managed on this bar
    if (openTrade) {
      const closed = manageTrade(openTrade, i);
      if (closed) {
        recordClose(stats, openTrade, closed.reason, closed.realizedPrice, closed.closeIdx);
        if (closed.realizedR < 0) lastLossCloseSec = m1[closed.closeIdx].timeUtcSec + M1_SEC;
        openTrade = null;
      }
      // fall through: while a position is open the engine still evaluates
      // (live behaviour), but a new EMIT is suppressed as busy below.
    }

    const evaluation = evaluateScalper({
      symbol: SYMBOL,
      digits,
      m15: windowAt(data.M15, 900, nowUtcSec, rules.windowBars, upto.M15),
      m5: windowAt(data.M5, 300, nowUtcSec, rules.windowBars, upto.M5),
      m1: windowAt(data.M1, 60, nowUtcSec, rules.windowBars, upto.M1),
      h1: windowAt(data.H1, 3600, nowUtcSec, rules.windowBars, upto.H1),
      h4: windowAt(data.H4, 14400, nowUtcSec, rules.windowBars, upto.H4),
      referencePrice: m1[i].close,
      spreadPrice: SPREAD,
      nowUtcSec,
      rules,
    });
    stats.evaluations++;
    if (evaluation.outcome === 'BLOCKED') { stats.blocked++; continue; }
    if (evaluation.outcome === 'NO_SETUP') { stats.noSetup++; continue; }
    if (evaluation.outcome === 'WAIT') { stats.wait++; continue; }
    stats.rawSetups++;

    // ── suppression semantics (scalper-service.ts) ──────────────────────
    for (const [fp, sec] of emitted) if (nowUtcSec - sec > dedupWindowSec) emitted.delete(fp);
    const fp = setupFingerprintOf(evaluation);
    const duplicate = fp !== null && emitted.has(fp);
    if (duplicate) { stats.suppressedDuplicate++; continue; }
    if (lastEmitSec + rules.cooldownSec > nowUtcSec) { stats.suppressedCooldown++; continue; }
    if (rules.postLossCooldownSec > 0 && lastLossCloseSec + rules.postLossCooldownSec > nowUtcSec) {
      stats.suppressedPostLoss++;
      continue;
    }
    if (openTrade) { stats.suppressedBusy++; continue; }

    // ── EMIT → open at the NEXT M1 bar's open ± half-spread ─────────────
    const direction = evaluation.outcome === 'BUY_SETUP' ? 'BUY' : 'SELL';
    const lv = evaluation.levels!;
    const nextBar = m1[i + 1];
    const entry = direction === 'BUY' ? nextBar.open + HALF : nextBar.open - HALF;
    const riskUnit = direction === 'BUY' ? entry - lv.stopLoss : lv.stopLoss - entry;
    if (!(riskUnit > 0)) continue; // degenerate geometry — honest skip
    if (fp) emitted.set(fp, nowUtcSec);
    lastEmitSec = nowUtcSec;
    const firstExit = direction === 'BUY' ? nextBar.open - HALF : nextBar.open + HALF;
    openTrade = {
      direction,
      model: evaluation.evidence?.scalper?.model ?? 'UNKNOWN',
      sourceTf: evaluation.evidence?.scalper?.sourceTimeframe ?? 'UNKNOWN',
      entry,
      sl: lv.stopLoss,
      tp: lv.target,
      riskUnit,
      openIdx: i + 1,
      openTimeMs: nextBar.timeUtcSec * 1000,
      lastManaged: i, // the entry bar (i+1) is the first managed bar
      state: initialManagedState(firstExit),
    };
    stats.trades++;
  }

  // a position may still be open at data end — close it honestly at the last bar
  if (openTrade) {
    const last = N - 1;
    const exitSide = openTrade.direction === 'BUY' ? m1[last].close - HALF : m1[last].close + HALF;
    const realized = openTrade.direction === 'BUY' ? exitSide - openTrade.entry : openTrade.entry - exitSide;
    recordClose(stats, openTrade, 'OPEN_AT_END', exitSide, last);
    void realized;
    openTrade = null;
  }

  // ── aggregate ─────────────────────────────────────────────────────────
  const log = stats.tradesLog;
  if (log.length) {
    stats.totalR = log.reduce((s, t) => s + t.realizedR, 0);
    stats.avgR = stats.totalR / log.length;
    const wins = log.filter((t) => t.realizedR > 0);
    stats.winRate = wins.length / log.length;
    const grossWin = wins.reduce((s, t) => s + t.realizedR, 0);
    const grossLoss = Math.abs(log.filter((t) => t.realizedR < 0).reduce((s, t) => s + t.realizedR, 0));
    stats.profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    stats.avgBars = log.reduce((s, t) => s + t.bars, 0) / log.length;
    let cum = 0;
    let peak = 0;
    for (const t of log) {
      cum += t.realizedR;
      peak = Math.max(peak, cum);
      stats.maxDrawdownR = Math.max(stats.maxDrawdownR, peak - cum);
    }
  }
  void name;
  return stats;

  // ── trade management (bar-level walk-forward) ─────────────────────────
  function manageTrade(
    t: NonNullable<typeof openTrade>,
    fromDecisionIdx: number,
  ): { reason: CloseReason; realizedPrice: number; realizedR: number; closeIdx: number } | null {
    // manage on every M1 bar from the entry bar up to (and including) the
    // current decision bar; the caller re-invokes us each decision step.
    for (let j = Math.max(t.openIdx, t.lastManaged + 1); j <= fromDecisionIdx; j++) {
      const bar = m1[j];
      // 1) broker-side hard SL/TP first (pessimistic: SL wins a both-hit bar)
      if (t.direction === 'BUY') {
        if (bar.low <= t.sl) return { reason: 'SL', realizedPrice: t.sl, realizedR: (t.sl - t.entry) / t.riskUnit, closeIdx: j };
        if (bar.high >= t.tp) return { reason: 'TP', realizedPrice: t.tp, realizedR: (t.tp - t.entry) / t.riskUnit, closeIdx: j };
      } else {
        if (bar.high >= t.sl) return { reason: 'SL', realizedPrice: t.sl, realizedR: (t.entry - t.sl) / t.riskUnit, closeIdx: j };
        if (bar.low <= t.tp) return { reason: 'TP', realizedPrice: t.tp, realizedR: (t.entry - t.tp) / t.riskUnit, closeIdx: j };
      }
      // 2) position-manager poll at this bar's close (exit-side price)
      const exitSide = t.direction === 'BUY' ? bar.close - HALF : bar.close + HALF;
      const atr = m1AtrAt(m1, j);
      const { state, decision } = decideManagedPosition(
        t.state,
        {
          positionId: 'backtest',
          symbol: SYMBOL,
          direction: t.direction,
          lots: 0.1,
          entryPrice: t.entry,
          stopLoss: t.sl,
          openTimeMs: t.openTimeMs,
          comment: null,
          currentPrice: exitSide,
          m1Atr: atr,
          nowMs: (bar.timeUtcSec + M1_SEC) * 1000,
        },
        thresholds,
      );
      t.state = state;
      t.lastManaged = j;
      if (decision.action !== 'HOLD') {
        const realized = t.direction === 'BUY' ? exitSide - t.entry : t.entry - exitSide;
        const reason: CloseReason =
          decision.action === 'CLOSE_BREAKEVEN' ? 'BREAKEVEN'
          : decision.action === 'CLOSE_TRAIL' ? 'TRAIL'
          : 'TIME_STOP';
        return { reason, realizedPrice: exitSide, realizedR: realized / t.riskUnit, closeIdx: j };
      }
    }
    return null;
  }
}

// ── close bookkeeping ────────────────────────────────────────────────────────────────────
function recordClose(
  stats: ScenarioStats,
  t: {
    direction: 'BUY' | 'SELL';
    model: string;
    sourceTf: string;
    entry: number;
    sl: number;
    tp: number;
    openIdx: number;
  },
  reason: CloseReason,
  exitPrice: number,
  closeIdx: number,
): void {
  const realized = t.direction === 'BUY' ? exitPrice - t.entry : t.entry - exitPrice;
  const riskUnit = t.direction === 'BUY' ? t.entry - t.sl : t.sl - t.entry;
  const realizedR = riskUnit > 0 ? realized / riskUnit : 0;
  stats.byReason[reason]++;
  stats.tradesLog.push({
    direction: t.direction,
    model: t.model,
    sourceTf: t.sourceTf,
    entry: t.entry,
    sl: t.sl,
    tp: t.tp,
    openIdx: t.openIdx,
    closeIdx,
    bars: closeIdx - t.openIdx,
    reason,
    realizedR,
  });
  const mk = stats.perModel.get(t.model) ?? { trades: 0, wins: 0, totalR: 0 };
  mk.trades++; if (realizedR > 0) mk.wins++; mk.totalR += realizedR;
  stats.perModel.set(t.model, mk);
  const tk = stats.perTf.get(t.sourceTf) ?? { trades: 0, wins: 0, totalR: 0 };
  tk.trades++; if (realizedR > 0) tk.wins++; tk.totalR += realizedR;
  stats.perTf.set(t.sourceTf, tk);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  SCALPER BACKTEST — real engine replay over DB candles (Task 38) ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  const data: Record<Timeframe, LoadedBar[]> = {
    M1: await loadCandles('M1'),
    M5: await loadCandles('M5'),
    M15: await loadCandles('M15'),
    H1: await loadCandles('H1'),
    H4: await loadCandles('H4'),
  };
  const spec = await db.symbolSpec.findUnique({ where: { symbol: SYMBOL } }).catch(() => null);
  const digits = spec?.digits ?? 3;
  const m1 = data.M1;
  if (m1.length < 200) {
    console.error(`FATAL: only ${m1.length} M1 candles in the DB — sync more history first.`);
    process.exit(1);
  }
  const span = (arr: LoadedBar[]) =>
    `${new Date(arr[0].timeUtcSec * 1000).toISOString().slice(0, 16)} → ${new Date(arr[arr.length - 1].timeUtcSec * 1000).toISOString().slice(0, 16)}`;
  console.log(`symbol ${SYMBOL} · digits ${digits} · spread assumption ${SPREAD.toFixed(2)}`);
  for (const tf of TFS) console.log(`  ${tf.padEnd(3)} ${String(data[tf].length).padStart(5)} bars  ${span(data[tf])}`);

  const thresholds = managerThresholdsFromConfig();
  console.log(`position manager: BE ${thresholds.breakevenAtR}R · trail ${thresholds.trailAtR}R × ${thresholds.trailAtrMult}×ATR · time-stop ${thresholds.maxAgeMin}min`);
  console.log('');

  const baseRules = buildScalperRules();
  const scenarios: Array<{ name: string; note: string; rules: ScalperRules }> = [
    {
      name: 'CURRENT (Task 37)',
      note: `gates ON · SL ${baseRules.slAtrMult}×ATR · RR ${baseRules.rewardRisk}`,
      rules: baseRules,
    },
    {
      name: 'LEGACY (pre-Task 37)',
      note: 'gates OFF · SL 1.2×ATR · RR 1.5',
      rules: {
        ...baseRules,
        slAtrMult: 1.2,
        rewardRisk: 1.5,
        smc: { ...baseRules.smc, legacyGate: false },
      },
    },
    {
      name: 'NO-MOMENTUM (Task 38)',
      note: 'momentum reflex OFF · reversal+SMC only',
      rules: { ...baseRules, momentumEnabled: false },
    },
    {
      name: 'MOMENTUM-M15-ONLY',
      note: 'momentum restricted to the M15 source TF',
      rules: { ...baseRules, momentumSourceTfOnly: 'M15' },
    },
  ];

  const results: Record<string, unknown> = { generatedAtUtc: new Date().toISOString(), symbol: SYMBOL, spread: SPREAD, scenarios: {} };

  for (const sc of scenarios) {
    const t0 = Date.now();
    const stats = runScenario(sc.name, sc.rules, data, digits, thresholds);
    const ms = Date.now() - t0;
    console.log(`── ${sc.name} — ${sc.note} (${ms} ms) ` + '─'.repeat(Math.max(0, 46 - sc.name.length - sc.note.length)));
    console.log(`  evaluations ${stats.evaluations} · NO_SETUP ${stats.noSetup} · WAIT ${stats.wait} · BLOCKED ${stats.blocked}`);
    console.log(`  raw setups ${stats.rawSetups} · suppressed: dup ${stats.suppressedDuplicate} · cooldown ${stats.suppressedCooldown} · post-loss ${stats.suppressedPostLoss} · busy ${stats.suppressedBusy}`);
    console.log(`  TRADES ${stats.trades}`);
    console.log(
      `    TP ${stats.byReason.TP} · SL ${stats.byReason.SL} · BREAKEVEN ${stats.byReason.BREAKEVEN} · TRAIL ${stats.byReason.TRAIL} · TIME_STOP ${stats.byReason.TIME_STOP} · OPEN@END ${stats.byReason.OPEN_AT_END}`,
    );
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    console.log(
      `  total ${stats.totalR >= 0 ? '+' : ''}${stats.totalR.toFixed(2)}R · avg ${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R · win-rate ${pct(stats.winRate)} · PF ${Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'} · maxDD ${stats.maxDrawdownR.toFixed(2)}R · avg hold ${stats.avgBars.toFixed(0)} bars`,
    );
    for (const [model, s] of stats.perModel) {
      console.log(`    ${model.padEnd(15)} ${String(s.trades).padStart(3)} trades · win ${pct(s.trades ? s.wins / s.trades : 0)} · ${s.totalR >= 0 ? '+' : ''}${s.totalR.toFixed(2)}R`);
    }
    for (const [tf, s] of stats.perTf) {
      console.log(`    src ${tf.padEnd(11)} ${String(s.trades).padStart(3)} trades · win ${pct(s.trades ? s.wins / s.trades : 0)} · ${s.totalR >= 0 ? '+' : ''}${s.totalR.toFixed(2)}R`);
    }
    console.log('');
    (results.scenarios as Record<string, unknown>)[sc.name] = {
      note: sc.note,
      evaluations: stats.evaluations,
      rawSetups: stats.rawSetups,
      suppressed: {
        duplicate: stats.suppressedDuplicate,
        cooldown: stats.suppressedCooldown,
        postLoss: stats.suppressedPostLoss,
        busy: stats.suppressedBusy,
      },
      trades: stats.trades,
      byReason: stats.byReason,
      totalR: Number(stats.totalR.toFixed(3)),
      avgR: Number(stats.avgR.toFixed(3)),
      winRate: Number(stats.winRate.toFixed(4)),
      profitFactor: Number.isFinite(stats.profitFactor) ? Number(stats.profitFactor.toFixed(3)) : null,
      maxDrawdownR: Number(stats.maxDrawdownR.toFixed(3)),
      avgHoldBars: Number(stats.avgBars.toFixed(1)),
      perModel: Object.fromEntries([...stats.perModel].map(([k, v]) => [k, { ...v, totalR: Number(v.totalR.toFixed(3)) }])),
      perSourceTf: Object.fromEntries([...stats.perTf].map(([k, v]) => [k, { ...v, totalR: Number(v.totalR.toFixed(3)) }])),
      tradesLog: stats.tradesLog.map((t) => ({ ...t, realizedR: Number(t.realizedR.toFixed(3)) })),
    };
  }

  mkdirSync('audit', { recursive: true });
  writeFileSync('audit/backtest-results.json', JSON.stringify(results, null, 2));
  console.log('full log → audit/backtest-results.json');
  console.log('assumptions: constant 0.30 spread · next-bar-open fill · SL-first on both-hit bars · one position at a time');
}

main()
  .catch((err) => {
    console.error('backtest failed:', err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
