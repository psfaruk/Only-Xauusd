/**
 * XAUUSD AI Trading Agent — Strategy Rules (Phase 9, Task B2)
 * ----------------------------------------------------------------------------
 * Builds the documented, versioned strategy configuration from app config.
 * The LLM can never read or alter these thresholds — they are deterministic
 * inputs persisted with every evaluation and baked into the fingerprint.
 *
 * Strategy: "hybrid-structure-retest" v9.0.0
 *   1. A CONFIRMED close-basis structure break (BOS or CHoCH, Phase 4
 *      semantics) on the execution TF (M15) must exist within
 *      `maxBarsSinceBreak` bars of the decision bar.
 *   2. After the break, price must pull back into the entry zone (retest)
 *      WITHOUT any close back through the broken level (invalidation).
 *   3. Higher-timeframe context (H1, H4) must not be OPPOSITE to the setup
 *      direction (range/unclear allowed — this is a filter, NOT a vote).
 *   4. Indicator filters on the execution TF: EMA50 trend side, RSI band,
 *      ADX floor.
 *   5. Live price must be inside/near the entry zone.
 *   6. SL beyond the most recent CONFIRMED anchor swing (± ATR buffer);
 *      target at a fixed reward/risk multiple of the actual risk.
 */

import { config } from '@/lib/config';
import { SIGNAL_STRATEGY_VERSION, type StrategyRules } from './types';

export function buildStrategyRules(): StrategyRules {
  const s = config.signal;
  return {
    strategyVersion: SIGNAL_STRATEGY_VERSION,
    executionTf: s.executionTf,
    contextTfs: s.contextTfs,
    windowBars: config.analysis.maxBarsPerTf,
    minExecutionBars: config.analysis.minBarsPerTf,
    minH1Bars: s.minH1Bars,
    minH4Bars: s.minH4Bars,
    swingLeft: config.analysis.swingLeft,
    swingRight: config.analysis.swingRight,
    maxBarsSinceBreak: s.maxBarsSinceBreak,
    zoneWidthAtr: s.zoneWidthAtr,
    entryToleranceAtr: s.entryToleranceAtr,
    slAtrBuffer: s.slAtrBuffer,
    rewardRisk: s.rewardRisk,
    minAdx: s.minAdx,
    rsiBuyMin: s.rsiBuyMin,
    rsiBuyMax: s.rsiBuyMax,
    maxSpreadPrice: s.maxSpreadPrice,
    expiryBars: s.expiryBars,
    emaPeriod: 50,
    rsiPeriod: 14,
    atrPeriod: 14,
    adxPeriod: 14,
  };
}

/** Human-readable rule documentation (rendered in the UI + persisted runs). */
export const STRATEGY_DOC: string[] = [
  'কনফার্মড ক্লোজ-বেসিস স্ট্রাকচার ব্রেক (BOS/CHoCH) থাকতে হবে M15-এ, সিদ্ধান্ত-বার থেকে সর্বোচ্চ maxBarsSinceBreak বারের মধ্যে।',
  'ব্রেকের পরে দাম এন্ট্রি জোনে পুলব্যাক (রিটেস্ট) করেছে কি না — রিটেস্ট ছাড়া WAIT।',
  'ব্রেকের পরে যেকোনো M15 ক্লোজ ভাঙা লেভেলের ওপারে গেলে জোন ইনভ্যালিড → NO_SETUP।',
  'H1 ও H4 ট্রেন্ড সেটআপের বিপরীত হলে WAIT (range/unclear অনুমোদিত — এটি ফিল্টার, ভোট নয়)।',
  'M15 ক্লোজ EMA50-এর সেটআপ-পক্ষে থাকতে হবে; RSI ব্যান্ডের মধ্যে থাকতে হবে; ADX ≥ minAdx।',
  'লাইভ মিড-প্রাইস এন্ট্রি জোনের কাছাকাছি থাকতে হবে (entryToleranceAtr × ATR সহনশীলতা)।',
  'SL = সর্বশেষ কনফার্মড অ্যাঙ্কর সুইং ± slAtrBuffer × ATR; টার্গেট = প্রকৃত রিস্কের rewardRisk গুণ।',
  'স্প্রেড > maxSpreadPrice হলে WAIT। সব গেট ও শর্ত পাস হলেই কেবল BUY_SETUP/SELL_SETUP — অন্যথায় WAIT/NO_SETUP/BLOCKED।',
];
