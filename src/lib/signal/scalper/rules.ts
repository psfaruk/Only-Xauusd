/**
 * XAUUSD AI Trading Agent — Scalper Strategy Rules (Phase 12, Task 32 · Phase 14, Task 34-g)
 * ----------------------------------------------------------------------------
 * Materializes the documented, versioned scalper configuration from app
 * config. The thresholds are persisted with every evaluation and baked into
 * the input fingerprint — the LLM can never read or alter them.
 *
 * Phase 14 adds the `smc` block: the ICT/SMC ten-agent confluence parameters
 * (structure/liquidity/POI/key-levels/price-action/momentum/session/AMD +
 * level derivation), all env-overridable and clamped in config.ts.
 */

import { config } from '@/lib/config';
import { DEFAULT_NEWS_BUFFER_MIN, DEFAULT_NEWS_WINDOWS } from '@/lib/signal/ict/sessions';
import { SCALPER_STRATEGY_VERSION, type ScalperRules } from './types';

export function buildScalperRules(): ScalperRules {
  const s = config.signal.scalper;
  const smc = config.signal.smc;
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
    maxExtensionAtr: s.maxExtensionAtr,
    postLossCooldownSec: s.postLossCooldownSec,
    momentumEnabled: s.momentumEnabled,
    momentumSourceTfOnly: s.momentumSourceTfOnly,
    htf: {
      enabled: s.htfEnabled,
      emaFastPeriod: s.htfEmaFastPeriod,
      emaSlowPeriod: s.htfEmaSlowPeriod,
      minBars: s.htfMinBars,
      counterTrendMinScore: s.htfCounterTrendMinScore,
    },
    smc: {
      enabled: smc.enabled,
      newsBlackoutEnabled: smc.newsBlackoutEnabled,
      legacyGate: smc.legacyGate,
      params: {
        swingLeft: smc.swingLeft,
        swingRight: smc.swingRight,
        maxBarsSinceEvent: smc.maxBarsSinceEvent,
        sweepLookbackBars: smc.sweepLookbackBars,
        maxBarsSinceSweep: smc.maxBarsSinceSweep,
        equalLevelAtrTol: smc.equalLevelAtrTol,
        obMinDisplacementAtr: smc.obMinDisplacementAtr,
        fvgMinGapAtr: smc.fvgMinGapAtr,
        entryToleranceAtr: smc.entryToleranceAtr,
        slAtrBuffer: smc.slAtrBuffer,
        poiMaxTests: smc.poiMaxTests,
        session: {
          londonKzFromMin: smc.londonKzFromMin,
          londonKzToMin: smc.londonKzToMin,
          nyKzFromMin: smc.nyKzFromMin,
          nyKzToMin: smc.nyKzToMin,
          // The approximate envelopes are the locked defaults; the master
          // switch empties the list (blackout veto then never fires).
          newsWindows: smc.newsBlackoutEnabled ? DEFAULT_NEWS_WINDOWS : [],
          newsBufferMin: DEFAULT_NEWS_BUFFER_MIN,
        },
        displacementAtr: smc.displacementAtr,
        amdLookbackBars: smc.amdLookbackBars,
        amdMinRangeAtr: smc.amdMinRangeAtr,
        minScore: smc.minScore,
        directionMargin: smc.directionMargin,
        roundNumberStep: smc.roundNumberStep,
        keyLevelTolAtr: smc.keyLevelTolAtr,
      },
      indicatorPeriods: {
        emaFastPeriod: s.emaFastPeriod,
        emaSlowPeriod: s.emaSlowPeriod,
        rsiPeriod: s.rsiPeriod,
        atrPeriod: s.atrPeriod,
      },
    },
  };
}

/** Human-readable rule documentation (persisted + rendered in the UI). */
export const SCALPER_DOC: string[] = [
  'তিনটি শর্ট টাইমফ্রেম (M15, M5, M1) স্বাধীনভাবে বিচার হয় — যে কোনো একটি agree করলেই সিগন্যাল (OR-লজিক)। Task 36: H1+H4 ট্রেন্ড একসাথে একদিকে থাকলে বিপরীত-দিকের সিগন্যাল আটকে যায় (SCALPER_HTF_OPPOSED) — শুধু টিয়ার-A SMC রিভার্সাল (স্কোর ≥ ৭৫) ব্যতিক্রম। কোথায় রিভার্স আর কোথায় কনটিনিউ — এটিই সেই বিচার।',
  'Task 37 — স্ট্রাকচার গেট: মোমেন্টাম মডেল এখন কেবল কাঠামোর সাথে মিলে চলে (bullish ট্রেন্ডে BUY, bearish-এ SELL, অথবা সদ্য-নিশ্চিত BOS) — কাউন্টার-স্ট্রাকচার বাউন্স কেনা বন্ধ (COUNTER_STRUCTURE)। রিভার্সাল মডেলের ট্রিগার (RSI এক্সট্রিম + টার্ন বার) এখন কনফার্মেশন চায়: সদ্য লিকুইডিটি সুইপ (স্টপ-হান্ট + রিক্লেইম) অথবা CHoCH — না থাকলে “এখানে রিভার্স নয়” (NO_REVERSAL_CONFIRM)। সিগন্যাল কার্ডে প্রতি TF-এর চিপে কারণ দেখা যায়।',
  'Task 37 — SL/TP জ্যামিতি: SL = ১.৫×ATR (আগে ১.২ — গোল্ডের নয়েজে স্টপ সুইপ হতো), প্রথম টার্গেট ১.২R (পৌঁছানো যায়), পজিশন ম্যানেজার +১R-এ ব্রেকইভেন + ১.৫R-এ ট্রেইলিং — বড় মুভ হলে ট্রেইল বাকিটা তোলে।',
  'মোমেন্টাম মডেলে অ্যান্টি-চেজ গার্ড (Task 36): দাম EMA9-এর চেয়ে ০.৬×ATR-এর বেশি দূরে গেলে সেই দিকে ঢুকতে নেই — পুলব্যাক এন্ট্রি, দৌড়নো টপ নয়।',
  'Task 36 — পোস্ট-লস কুলডাউন: একটি লস হলে পরবর্তী ১৫ মিনিট নতুন অটো-এন্ট্রি বন্ধ (SCALPER_POST_LOSS_COOLDOWN) — রিভেঞ্জ ট্রেড ঠেকাতে। পজিশন ম্যানেজার: +১R-এ ব্রেকইভেন, +১.৫R-এ ট্রেইলিং স্টপ, ৪৫ মিনিটে ডেড-ট্রেড টাইম-স্টপ।',
  'Phase 14 — SMC/ICT কনফ্লুয়েন্স মডেল (অগ্রাধিকার): ৮টি এজেন্ট (স্ট্রাকচার ১৫ · লিকুইডিটি ২০ · POI ২০ · কি-লেভেল ১০ · প্রাইস-অ্যাকশন ১৫ · মোমেন্টাম ১০ · সেশন ৫ · AMD ৫ = ১০০) ওজন-যোগে স্কোর করে; টিয়ার A ≥ 75 (সিউর), B ≥ 55 (ডিফল্ট ইমিশন), C ≥ 40।',
  'SMC হার্ড ভিটো: নিউজ ব্ল্যাকআউট উইন্ডো, ০.৮×ATR-এর কাছে বিপরীত কি-লেভেল দেয়াল (SR_WALL), POI-এর বাইরে দাম (PRICE_BEYOND_POI), POI ভাঙা (POI_VIOLATED), শক্তিশালী বিপরীত মোমেন্টাম (MOMENTUM_OPPOSED)।',
  'SMC লেভেল: এন্ট্রি = POI জোনে লাইভ দাম; SL = সুইপ-উইক/জোন-প্রান্তের বাইরে ০.৫×ATR বাফার; টার্গেট = বিপরীত লিকুইডিটি পুল (সর্বোচ্চ ১.২R ক্যাপ; ১R-এর কাছের ম্যাগনেট হলে SMC_TP_TOO_CLOSE)।',
  'Task 38 — ব্যাকটেস্ট-নির্দেশিত সিদ্ধান্ত: মোমেন্টাম মডেল সাময়িক বন্ধ (SCALPER_MOMENTUM_ENABLED=false)। ৩৪ ঘণ্টার রিপ্লে-ব্যাকটেস্টে (৪৬ ট্রেড) মোমেন্টাম রিফ্লেক্সই ছিল একমাত্র বড় ঘাটতি (৩৩% উইন, −৮.৬৪R); গেট-করা রিভার্সাল ও SMC কনফ্লুয়েন্স বইটি বহন করেছে (মোমেন্টাম বন্ধ রেখে: +৫.৭৯R, ৫৫.৬% উইন)। সুইচটি যেকোনো সময় আবার চালু করা যায়।',
  'মোমেন্টাম মডেল (ফলব্যাক, যখন চালু): EMA9 > EMA21 (বা বিপরীত), দাম EMA9-এর ওপরে (নিচে), RSI 52–78 ব্যান্ডে (SELL-এ আয়নাকৃত ব্যান্ড) — সাথে টাইমফ্রেমের স্ট্রাকচার ট্রেন্ড বা সদ্য BOS একই দিকে (Task 37 গেট)।',
  'রিভার্সাল মডেল (ফলব্যাক): আগের বারে RSI 32-এর নিচে (অথবা 68-এর ওপরে), সিদ্ধান্ত-বারে RSI ফিরে আসছে + দিকানুগ ক্লোজ — সাথে লিকুইডিটি সুইপ বা CHoCH কনফার্মেশন (Task 37 গেট)।',
  'কয়েকটি TF একসাথে agree করলে অগ্রাধিকার M15 → M5 → M1 (উৎস টাইমফ্রেম হিসেবে)।',
  'SL-দূরত্ব 0.50-এর কম হলে সেটআপ বাদ (স্প্রেডের চেয়ে চাপা স্টপ অবাণিজ্যিক)।',
  'স্প্রেড > 0.60 হলে WAIT। কুলডাউন: একটি সিগন্যালের ৮ মিনিটের মধ্যে পরেরটি নয় (ঘণ্টায় ৫–৭ সিগন্যালের লক্ষ্য-ছন্দ)।',
  'একই সিদ্ধান্ত-বারের একই সেটআপ দ্বিতীয়বার নির্গত হয় না (SCALPER_DUPLICATE_SETUP)।',
];
