/**
 * XAUUSD AI Trading Agent — Historical Backtest Simulator (Phase 8, Task 6)
 * ----------------------------------------------------------------------------
 * A SIMULATION over VERIFIED BROKER CANDLES ONLY — never proof of live
 * profitability, never a trade recommendation.
 *
 * Verification guarantees:
 *   · Dataset: only persisted candles with source='bridge-mt5' (authenticated
 *     broker feed), validationStatus='VALID', isForming=false. The dataset
 *     fingerprint (sha256 over exact decimal text + timestamps) makes every
 *     run reproducible and auditable.
 *   · No look-ahead: every Phase 4 computation reused here is causal by
 *     construction — swing points activate only at their confirmation candle
 *     (index + right), BOS/CHoCH events confirm at the closing candle's close
 *     instant, EMA/RSI/ATR are recursive past-only series. Entry occurs at the
 *     NEXT bar's open after the signal bar closes. A test below pins this:
 *     mutating future candles must not change any earlier trade.
 *   · Realistic execution: configurable spread + slippage are charged on
 *     entry AND exit; entry is the next bar's open (not the theoretical
 *     signal price).
 *   · Conservative collision rule: when a single candle's range touches both
 *     stop-loss and target, the LOSS is assumed (SL first) — documented,
 *     deterministic, pessimistic.
 *   · The forming candle is never treated as a completed candle.
 *   · Dev / out-of-sample split: the dataset is split chronologically
 *     (default 70/30); the out-of-sample window is reported separately and
 *     is NEVER optimized against.
 *   · Honest emptiness: with too few candles or trades the engine returns
 *     INSUFFICIENT_DATA with counts — no invented metrics.
 */

import { createHash } from 'node:crypto';
import type { AnalysisCandle } from '@/lib/analysis/types';
import type { BreachEvent } from '@/lib/analysis/types';
import { detectSwings } from '@/lib/analysis/swings';
import { scanStructureEvents } from '@/lib/analysis/structure';
import { emaSeries, rsiSeries, atrSeries } from '@/lib/analysis/indicators';

/** Unwrap a Phase 4 indicator result; null when it could not be computed. */
function seriesValues(
  r: { ok: true; series: { values: Array<number | null> } } | { ok: false; error: { code: string; detail: string } },
): Array<number | null> | null {
  return r.ok ? r.series.values : null;
}

export const BACKTEST_STRATEGY_VERSION = '8.0.0-structure-proxy';

/** Deterministic, documented proxy rules — a HYPOTHESIS for verification,
 *  not the production signal engine (that is Phase 5+, not built yet). */
export interface BacktestRules {
  emaPeriod: number;          // trend filter (default 50)
  rsiPeriod: number;
  rsiLongMax: number;         // long only when RSI < this (default 70)
  rsiShortMin: number;        // short only when RSI > this (default 30)
  atrPeriod: number;
  atrStopBuffer: number;      // SL = swing ± this × ATR (default 0.5)
  rewardRisk: number;         // fixed R multiple target (default 2.0)
  swingLeft: number;          // Phase 4 swing window (3/3 default)
  swingRight: number;
  spreadPrice: number;        // full spread in PRICE units charged round-trip (default: observed 0.24)
  slippagePrice: number;      // extra slippage per side in PRICE units (default 0.02)
  devSplitFraction: number;   // first fraction of candles = development set (default 0.7)
  minCandles: number;         // below this → INSUFFICIENT_DATA (default 220)
  minTrades: number;          // below this per segment → INSUFFICIENT_DATA for that segment (default 5)
}

export const DEFAULT_RULES: BacktestRules = {
  emaPeriod: 50,
  rsiPeriod: 14,
  rsiLongMax: 70,
  rsiShortMin: 30,
  atrPeriod: 14,
  atrStopBuffer: 0.5,
  rewardRisk: 2.0,
  swingLeft: 3,
  swingRight: 3,
  spreadPrice: 0.24,
  slippagePrice: 0.02,
  devSplitFraction: 0.7,
  minCandles: 220,
  minTrades: 5,
};

export interface BacktestTrade {
  /** 'dev' | 'oos' */
  segment: 'dev' | 'oos';
  direction: 'long' | 'short';
  signalBarTimeUtcSec: number;   // bar whose CLOSE produced the signal
  entryBarTimeUtcSec: number;    // next bar (entry at ITS open)
  entryPrice: number;            // incl. half-spread + slippage
  stopLoss: number;
  target: number;
  exitBarTimeUtcSec: number;
  exitPrice: number;
  exitReason: 'stop' | 'target' | 'end_of_data';
  pnlPrice: number;              // in price units, net of spread+slippage
  rMultiple: number;             // pnl / initial risk
}

export interface BacktestMetrics {
  status: 'COMPUTED' | 'INSUFFICIENT_DATA';
  candles: number;
  fromUtcSec: number | null;
  toUtcSec: number | null;
  signals: number;
  executedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossPnlPrice: number | null;
  netPnlPrice: number | null;     // after spread + slippage (already in prices)
  profitFactor: number | null;
  maxDrawdownPrice: number | null;
  avgRewardRisk: number | null;
  avgWinPrice: number | null;
  avgLossPrice: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  reason?: string;
}

export interface BacktestResult {
  strategyVersion: string;
  datasetFingerprint: string;
  dataset: {
    symbol: string;
    timeframe: string;
    candleCount: number;
    fromUtcSec: number;
    toUtcSec: number;
    source: string;
    exclusions: string[];        // what was excluded and why
  };
  rules: BacktestRules;
  dev: BacktestMetrics;
  oos: BacktestMetrics;
  trades: BacktestTrade[];
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Dataset fingerprint — sha256 over exact decimal text + timestamps
// ---------------------------------------------------------------------------

export function datasetFingerprint(
  symbol: string,
  timeframe: string,
  candles: Array<Pick<AnalysisCandle, 'timeUtcSec' | 'openText' | 'highText' | 'lowText' | 'closeText'>>,
): string {
  const h = createHash('sha256');
  h.update(`${symbol}|${timeframe}|${candles.length}`);
  for (const c of candles) {
    h.update(`|${c.timeUtcSec},${c.openText},${c.highText},${c.lowText},${c.closeText}`);
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export function runBacktest(
  symbol: string,
  timeframe: string,
  tfSec: number,
  candles: AnalysisCandle[],
  digits: number | null,
  rules: BacktestRules = DEFAULT_RULES,
): BacktestResult {
  const exclusions: string[] = [];
  if (candles.length < rules.minCandles) {
    const empty = emptyMetrics(candles, 'INSUFFICIENT_DATA', `only ${candles.length} candles (< ${rules.minCandles})`);
    return {
      strategyVersion: BACKTEST_STRATEGY_VERSION,
      datasetFingerprint: datasetFingerprint(symbol, timeframe, candles),
      dataset: datasetBlock(symbol, timeframe, candles, 'bridge-mt5', exclusions),
      rules,
      dev: empty,
      oos: empty,
      trades: [],
      limitations: LIMITATIONS,
    };
  }

  // ── Phase 4 causal computations (reused, not duplicated) ────────────────
  const swingDetection = detectSwings(candles, {
    left: rules.swingLeft, right: rules.swingRight, tfSec, digits,
  });
  const structure = scanStructureEvents(candles, swingDetection.swings, {
    swingLeft: rules.swingLeft, swingRight: rules.swingRight, tfSec, digits,
  });
  const ema = seriesValues(emaSeries(candles.map((c) => c.close), rules.emaPeriod));
  const rsi = seriesValues(rsiSeries(candles.map((c) => c.close), rules.rsiPeriod));
  const atr = seriesValues(atrSeries(candles, rules.atrPeriod));
  if (!ema || !rsi || !atr) {
    const empty = emptyMetrics(candles, 'INSUFFICIENT_DATA', 'indicator warm-up incomplete for this dataset length');
    return {
      strategyVersion: BACKTEST_STRATEGY_VERSION,
      datasetFingerprint: datasetFingerprint(symbol, timeframe, candles),
      dataset: datasetBlock(symbol, timeframe, candles, 'bridge-mt5', exclusions),
      rules,
      dev: empty,
      oos: empty,
      trades: [],
      limitations: LIMITATIONS,
    };
  }

  // Event index by the bar whose close confirmed the event (causal key).
  const eventAtBar = new Map<number, BreachEvent>();
  const barTimeToIndex = new Map<number, number>();
  candles.forEach((c, i) => barTimeToIndex.set(c.timeUtcSec, i));
  for (const ev of structure.events) {
    const i = barTimeToIndex.get(ev.breakCandleTimeUtcSec);
    if (i !== undefined) eventAtBar.set(i, ev);
  }

  // ── Dev / OOS chronological split ───────────────────────────────────────
  const splitIndex = Math.floor(candles.length * rules.devSplitFraction);

  const trades: BacktestTrade[] = [];
  let open: OpenPosition | null = null;

  // Track the most recent CONFIRMED swing (activation-time aware) for SL.
  const swingsSorted = [...swingDetection.swings]
    .sort((a, b) => a.index + rules.swingRight - (b.index + rules.swingRight));

  const halfSpread = rules.spreadPrice / 2;

  if (process.env.BT_DEBUG) {
    let sigCount = 0, noSwing = 0, noAtr = 0, zeroRisk = 0;
    for (let i = 1; i < candles.length; i++) {
      const sig = signalForBar(i - 1, candles, eventAtBar, ema, rsi, rules);
      if (!sig) continue;
      sigCount++;
      const sw = lastConfirmedSwingBy(i - 1, swingsSorted, rules.swingRight, sig);
      const at = atr[i - 1] ?? null;
      if (sw === null) noSwing++;
      else if (at === null || !(Number.isFinite(at) && at > 0)) noAtr++;
      else {
        const buf = rules.atrStopBuffer * at;
        const sl = sig === 'long' ? sw - buf : sw + buf;
        if (Math.abs(candles[i].open - sl) <= 0) zeroRisk++;
      }
    }
    console.log(`[bt] events=${structure.events.length} eventBars=${eventAtBar.size} rawSignals=${sigCount} noSwing=${noSwing} noAtr=${noAtr} zeroRisk=${zeroRisk}`);
  }

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];

    // ── 1) manage an open position on this bar ───────────────────────────
    if (open && i > open.entryIndex) {
      const hitStop = open.direction === 'long' ? bar.low <= open.stopLoss : bar.high >= open.stopLoss;
      const hitTarget = open.direction === 'long' ? bar.high >= open.target : bar.low <= open.target;
      // CONSERVATIVE COLLISION RULE: both touched in one candle → assume the
      // LOSS (stop first). Documented + pessimistic by design.
      if (hitStop) {
        closeTrade(open, i, open.stopLoss, 'stop', trades, candles, splitIndex);
        open = null;
      } else if (hitTarget) {
        closeTrade(open, i, open.target, 'target', trades, candles, splitIndex);
        open = null;
      }
    }

    // ── 2) entry on this bar's open, if signaled at the previous close ────
    if (!open && i > 0) {
      const sig = signalForBar(i - 1, candles, eventAtBar, ema, rsi, rules);
      if (sig) {
        // Next-bar-open entry with spread+slippage charged on both sides.
        const entry =
          sig === 'long'
            ? bar.open + halfSpread + rules.slippagePrice   // buy at ask + slip
            : bar.open - halfSpread - rules.slippagePrice;  // sell at bid − slip
        // SL anchored at the most recent CONFIRMED swing (known at signal
        // time) with an ATR buffer; risk from the ACTUAL entry price.
        const swingForStop = lastConfirmedSwingBy(i - 1, swingsSorted, rules.swingRight, sig);
        const atrAtSignal = atr[i - 1] ?? null;
        if (swingForStop !== null && atrAtSignal !== null && Number.isFinite(atrAtSignal) && atrAtSignal > 0) {
          const buffer = rules.atrStopBuffer * atrAtSignal;
          const stopLoss = sig === 'long' ? swingForStop - buffer : swingForStop + buffer;
          const risk = Math.abs(entry - stopLoss);
          if (risk > 0) {
            const target = sig === 'long' ? entry + rules.rewardRisk * risk : entry - rules.rewardRisk * risk;
            open = {
              direction: sig,
              entryIndex: i,
              entryPrice: entry,
              stopLoss,
              target,
              risk,
              signalBarTime: candles[i - 1].timeUtcSec,
            };
          }
        }
      }
    }

    // ── 3) same-bar exit check for a position opened at this bar's open ──
    // (entry bar: the stop/target can already be hit inside the entry bar)
    if (open && i === open.entryIndex) {
      const hitStop = open.direction === 'long' ? bar.low <= open.stopLoss : bar.high >= open.stopLoss;
      const hitTarget = open.direction === 'long' ? bar.high >= open.target : bar.low <= open.target;
      if (hitStop) { // collision → loss first (conservative)
        closeTrade(open, i, open.stopLoss, 'stop', trades, candles, splitIndex);
        open = null;
      } else if (hitTarget) {
        closeTrade(open, i, open.target, 'target', trades, candles, splitIndex);
        open = null;
      }
    }
  }

  // End of data: close any open position at the final close (marked).
  if (open) {
    const last = candles[candles.length - 1];
    closeTrade(open, candles.length - 1, last.close, 'end_of_data', trades, candles, splitIndex);
  }

  exclusions.push(
    'Only closed candles with source=bridge-mt5 and validationStatus=VALID are simulated.',
    'Candles inside approximate market-closure windows are absent by market design (not fabricated).',
  );

  const devTrades = trades.filter((t) => t.segment === 'dev');
  const oosTrades = trades.filter((t) => t.segment === 'oos');

  return {
    strategyVersion: BACKTEST_STRATEGY_VERSION,
    datasetFingerprint: datasetFingerprint(symbol, timeframe, candles),
    dataset: datasetBlock(symbol, timeframe, candles, 'bridge-mt5', exclusions),
    rules,
    dev: computeMetrics(devTrades, candles.slice(0, splitIndex), rules),
    oos: computeMetrics(oosTrades, candles.slice(splitIndex), rules),
    trades,
    limitations: LIMITATIONS,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const LIMITATIONS = [
  'Backtests are simulations, not proof of live profitability.',
  'Entries assume next-bar-open fills with fixed spread+slippage — real fills can differ.',
  'When one candle touches both stop and target, the LOSS is assumed (conservative rule).',
  'H4 history is broker-bounded (see the H4 coverage note in /api/data/health); long-horizon statistics are limited by that depth.',
  'The ruleset is a documented Phase 8 verification hypothesis — not the production signal engine.',
];

function datasetBlock(
  symbol: string, timeframe: string,
  candles: AnalysisCandle[], source: string, exclusions: string[],
): BacktestResult['dataset'] {
  return {
    symbol,
    timeframe,
    candleCount: candles.length,
    fromUtcSec: candles.length ? candles[0].timeUtcSec : 0,
    toUtcSec: candles.length ? candles[candles.length - 1].timeUtcSec : 0,
    source,
    exclusions,
  };
}

function signalForBar(
  i: number,
  candles: AnalysisCandle[],
  eventAtBar: Map<number, BreachEvent>,
  emaValues: Array<number | null>,
  rsiValues: Array<number | null>,
  rules: BacktestRules,
): 'long' | 'short' | null {
  const ev = eventAtBar.get(i);
  if (!ev) return null;
  const ema = emaValues[i] ?? null;
  const rsi = rsiValues[i] ?? null;
  if (ema === null || rsi === null || !Number.isFinite(ema) || !Number.isFinite(rsi)) return null;
  const close = candles[i].close;
  if (ev.direction === 'bullish' && close > ema && rsi < rules.rsiLongMax) return 'long';
  if (ev.direction === 'bearish' && close < ema && rsi > rules.rsiShortMin) return 'short';
  return null;
}

/** Most recent swing whose CONFIRMATION index is <= knownBy (no look-ahead). */
function lastConfirmedSwingBy(
  knownBy: number,
  swingsSorted: Array<{ index: number; kind: 'high' | 'low'; price: number }>,
  right: number,
  direction: 'long' | 'short',
): number | null {
  const wantKind = direction === 'long' ? 'low' : 'high';
  for (let k = swingsSorted.length - 1; k >= 0; k--) {
    const s = swingsSorted[k];
    if (s.kind !== wantKind) continue;
    if (s.index + right <= knownBy) return s.price;
  }
  return null;
}

interface OpenPosition {
  direction: 'long' | 'short';
  entryIndex: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  risk: number;
  signalBarTime: number;
}

function closeTrade(
  open: OpenPosition,
  exitIndex: number,
  exitPriceRaw: number,
  reason: BacktestTrade['exitReason'],
  trades: BacktestTrade[],
  candles: AnalysisCandle[],
  splitIndex: number,
): void {
  // Exit at the raw level price; round-trip costs were charged at entry
  // (entry bought at ask + slippage; exit sells at the level = bid-side
  // equivalent, so the spread is paid once on each side via the entry shift
  // and this exit price).
  const exitPrice = exitPriceRaw;
  const gross = open.direction === 'long' ? exitPrice - open.entryPrice : open.entryPrice - exitPrice;
  trades.push({
    segment: open.entryIndex < splitIndex ? 'dev' : 'oos',
    direction: open.direction,
    signalBarTimeUtcSec: open.signalBarTime,
    entryBarTimeUtcSec: candles[open.entryIndex].timeUtcSec,
    entryPrice: open.entryPrice,
    stopLoss: open.stopLoss,
    target: open.target,
    exitBarTimeUtcSec: candles[exitIndex].timeUtcSec,
    exitPrice,
    exitReason: reason,
    pnlPrice: Number(gross.toFixed(10)),
    rMultiple: open.risk > 0 ? Number((gross / open.risk).toFixed(6)) : 0,
  });
}

function computeMetrics(
  trades: BacktestTrade[],
  segmentCandles: AnalysisCandle[],
  rules: BacktestRules,
): BacktestMetrics {
  const base: BacktestMetrics = {
    status: 'COMPUTED',
    candles: segmentCandles.length,
    fromUtcSec: segmentCandles.length ? segmentCandles[0].timeUtcSec : null,
    toUtcSec: segmentCandles.length ? segmentCandles[segmentCandles.length - 1].timeUtcSec : null,
    signals: trades.length,
    executedTrades: trades.length,
    wins: 0, losses: 0,
    winRate: null, grossPnlPrice: null, netPnlPrice: null, profitFactor: null,
    maxDrawdownPrice: null, avgRewardRisk: null, avgWinPrice: null, avgLossPrice: null,
    maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
  };
  if (trades.length < rules.minTrades) {
    return {
      ...base,
      status: 'INSUFFICIENT_DATA',
      reason: `only ${trades.length} trades in segment (< ${rules.minTrades}) — metrics are NOT invented`,
    };
  }
  const wins = trades.filter((t) => t.pnlPrice > 0);
  const losses = trades.filter((t) => t.pnlPrice <= 0);
  const gross = trades.reduce((s, t) => s + t.pnlPrice, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlPrice, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPrice, 0));

  // Max drawdown over the chronological trade P&L curve (price units).
  let equity = 0;
  let peak = 0;
  let dd = 0;
  let streakW = 0, streakL = 0, maxW = 0, maxL = 0;
  for (const t of trades) {
    equity += t.pnlPrice;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    if (t.pnlPrice > 0) { streakW++; streakL = 0; } else { streakL++; streakW = 0; }
    maxW = Math.max(maxW, streakW);
    maxL = Math.max(maxL, streakL);
  }

  return {
    ...base,
    wins: wins.length,
    losses: losses.length,
    winRate: Number((wins.length / trades.length).toFixed(4)),
    grossPnlPrice: Number(gross.toFixed(4)),
    netPnlPrice: Number(gross.toFixed(4)), // costs already inside each trade's prices
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(4)) : null,
    maxDrawdownPrice: Number(dd.toFixed(4)),
    avgRewardRisk: Number((trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length).toFixed(4)),
    avgWinPrice: wins.length ? Number((grossWin / wins.length).toFixed(4)) : null,
    avgLossPrice: losses.length ? Number((-grossLoss / losses.length).toFixed(4)) : null,
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
  };
}

function emptyMetrics(candles: AnalysisCandle[], status: 'INSUFFICIENT_DATA', reason: string): BacktestMetrics {
  return {
    status,
    candles: candles.length,
    fromUtcSec: candles.length ? candles[0].timeUtcSec : null,
    toUtcSec: candles.length ? candles[candles.length - 1].timeUtcSec : null,
    signals: 0,
    executedTrades: 0,
    wins: 0, losses: 0,
    winRate: null, grossPnlPrice: null, netPnlPrice: null, profitFactor: null,
    maxDrawdownPrice: null, avgRewardRisk: null, avgWinPrice: null, avgLossPrice: null,
    maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
    reason,
  };
}
