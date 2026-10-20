/**
 * XAUUSD AI Trading Agent — Scalper Strategy Rules (Phase 12, Task 32)
 * ----------------------------------------------------------------------------
 * Materializes the documented, versioned scalper configuration from app
 * config. The thresholds are persisted with every evaluation and baked into
 * the input fingerprint — the LLM can never read or alter them.
 */

import { config } from '@/lib/config';
import { SCALPER_STRATEGY_VERSION, type ScalperRules } from './types';

export function buildScalperRules(): ScalperRules {
  const s = config.signal.scalper;
  return {
    strategyVersion: SCALPER_STRATEGY_VERSION,
    timeframes: ['M15', 'M5', 'M1'],
    windowBars: s.windowBars,
    minBarsPerTf: s.minBarsPerTf,
    emaFastPeriod: s.emaFastPeriod,
    emaSlowPeriod: s.emaSlowPeriod,
    rsiPeriod: s.rsiPeriod,
    atrPeriod: s.atrPeriod,
    momentumRsiMin: s.momentumRsiMin,
    momentumRsiMax: s.momentumRsiMax,
    reversalRsiOversold: s.reversalRsiOversold,
    reversalRsiOverbought: s.reversalRsiOverbought,
    slAtrMult: s.slAtrMult,
    rewardRisk: s.rewardRisk,
    maxSpreadPrice: s.maxSpreadPrice,
    minStopPrice: s.minStopPrice,
    cooldownSec: s.cooldownSec,
    expirySec: {
      M1: s.expirySecM1,
      M5: s.expirySecM5,
      M15: s.expirySecM15,
    },
  };
}

/** Human-readable rule documentation (persisted + rendered in the UI). */
export const SCALPER_DOC: string[] = [
  'তিনটি শর্ট টাইমফ্রেম (M15, M5, M1) স্বাধীনভাবে বিচার হয় — যে কোনো একটি agree করলেই সিগন্যাল (OR-লজিক), কোনো উচ্চতর-টাইমফ্রেম গেট নেই।',
  'মোমেন্টাম মডেল: EMA9 > EMA21 (বা বিপরীত), দাম EMA9-এর ওপরে (নিচে), RSI 52–78 ব্যান্ডে (SELL-এ আয়নাকৃত ব্যান্ড)।',
  'রিভার্সাল মডেল: আগের বারে RSI 32-এর নিচে (অথবা 68-এর ওপরে), সিদ্ধান্ত-বারে RSI ফিরে আসছে + দিকানুগ ক্লোজ।',
  'কয়েকটি TF একসাথে agree করলে অগ্রাধিকার M15 → M5 → M1 (উৎস টাইমফ্রেম হিসেবে)।',
  'এন্ট্রি = লাইভ মিড ± অর্ধ-স্প্রেড; SL = সিদ্ধান্ত-ক্লোজ ∓ 1.2×ATR(উৎস TF); টার্গেট = প্রকৃত রিস্কের 1.5 গুণ।',
  'SL-দূরত্ব 0.50-এর কম হলে সেটআপ বাদ (স্প্রেডের চেয়ে চাপা স্টপ অবাণিজ্যিক)।',
  'স্প্রেড > 0.60 হলে WAIT। কুলডাউন: একটি সিগন্যালের ৮ মিনিটের মধ্যে পরেরটি নয় (ঘণ্টায় ৫–৭ সিগন্যালের লক্ষ্য-ছন্দ)।',
  'একই সিদ্ধান্ত-বারের একই সেটআপ দ্বিতীয়বার নির্গত হয় না (SCALPER_DUPLICATE_SETUP)।',
];
