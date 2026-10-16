/**
 * XAUUSD AI Trading Agent — Dashboard Bengali renderings + formatters (UI-02).
 * ----------------------------------------------------------------------------
 * Pure display helpers moved verbatim from the former single-file page.tsx.
 * No React here (JSX bits live in components/terminal/bits.tsx) so this
 * module stays trivially testable.
 */

// ---------------------------------------------------------------------------
// Bengali renderings of the stable machine-readable error codes
// ---------------------------------------------------------------------------

export const bnErrorText: Record<string, string> = {
  BRIDGE_NOT_CONFIGURED: 'MT5 ব্রিজ কনফিগার করা হয়নি — MT5_BRIDGE_URL ফাঁকা আছে।',
  BRIDGE_UNREACHABLE: 'ব্রিজ সার্ভারে পৌঁছানো যাচ্ছে না।',
  BRIDGE_TIMEOUT: 'ব্রিজ সময়মতো সাড়া দেয়নি (টাইমআউট)।',
  BRIDGE_AUTH_FAILED: 'ব্রিজ অনুরোধ প্রত্যাখ্যান করেছে (অননুমোদিত)।',
  BRIDGE_RATE_LIMITED: 'ব্রিজের রেট লিমিট ছুঁয়ে গেছে — কিছুক্ষণ পরে আবার চেষ্টা হবে।',
  BRIDGE_BAD_RESPONSE: 'ব্রিজ থেকে প্রত্যাশিত ফরম্যাটে উত্তর আসেনি।',
  BRIDGE_PARTIAL_RESPONSE: 'ব্রিজ আংশিক উত্তর দিয়েছে — কিছু ডেটা পাওয়া যায়নি।',
  SOURCE_DEMO: 'ব্রিজ এখন স্পষ্টভাবে চিহ্নিত ডেমো ডেটা দিচ্ছে — এটি লাইভ বাজার নয়।',
  SOURCE_DISCONNECTED: 'MT5 টার্মিনাল সংযোগ বিচ্ছিন্ন আছে।',
  SYMBOL_NOT_ALLOWED: 'এই সিম্বলটি অনুমোদিত তালিকায় নেই।',
  SYMBOL_NOT_FOUND: 'ব্রিজে এই সিম্বলটি পাওয়া যায়নি।',
  TIMEFRAME_NOT_ALLOWED: 'এই টাইমফ্রেমটি অনুমোদিত তালিকায় নেই।',
  DATA_MISSING: 'প্রয়োজনীয় ডেটা এখনো সংরক্ষিত হয়নি।',
  DATA_STALE: 'সংরক্ষিত ডেটা পুরোনো হয়ে গেছে।',
  TICK_STALE: 'সর্বশেষ টিক পুরোনো হয়ে গেছে।',
  TICK_CROSSED: 'টিকের Bid/Ask অসঙ্গতিপূর্ণ (Ask < Bid)।',
  TICK_NON_POSITIVE: 'টিকের দাম শূন্য বা ঋণাত্মক — প্রত্যাখ্যাত।',
  GAP_POSSIBLE: 'সম্ভবত একটি ক্যান্ডেল অনুপস্থিত — বাজার ছুটি (অজানা সময়সূচি) বা ডেটা ত্রুটি হতে পারে।',
  GAP_MARKET_LIKELY_CLOSED: 'সম্ভাব্য ফাঁক — সম্ভবত বাজার বন্ধ ছিল (উইকেন্ড/বিরতি, আনুমানিক)।',
  SPEC_MISSING: 'সিম্বল স্পেসিফিকেশন এখনো যাচাই করা হয়নি।',
  CANDLE_OHLC_INCONSISTENT: 'ক্যান্ডেলের OHLC মান পরস্পরবিরোধী।',
  CANDLE_NON_FINITE: 'ক্যান্ডেলের দাম সংখ্যা নয় (NaN/অসীম)।',
  CANDLE_NON_POSITIVE: 'ক্যান্ডেলের দাম শূন্য বা ঋণাত্মক।',
  CANDLE_DUPLICATE_KEY: 'একই সময়ের ক্যান্ডেল একাধিকবার এসেছে — ডুপ্লিকেট গণনা করা হয়েছে।',
  CANDLE_OUT_OF_ORDER: 'ক্যান্ডেলগুলো সময় অনুযায়ী সাজানো ছিল না — সাজিয়ে নেওয়া হয়েছে।',
  CANDLE_PRICE_PRECISION_ANOMALY: 'দামে প্রত্যাশিত দশমিক-অঙ্কের চেয়ে বেশি অঙ্ক এসেছে — সতর্কতা সহ সংরক্ষিত।',
  DB_TX_FAILED: 'ডেটাবেস লেনদেন ব্যর্থ হয়েছে।',
  DB_ERROR: 'ডেটাবেস ত্রুটি।',
  SYNC_IN_PROGRESS: 'একটি সিঙ্ক ইতিমধ্যেই চলছে — নতুনটি বাতিল।',
  // Phase 4 (analysis + hardened API)
  MARKET_API_TOKEN_NOT_CONFIGURED:
    'DATA_API_TOKEN সেট করা হয়নি — সুরক্ষিত endpoint fail-closedভাবে বন্ধ (এটি ইচ্ছাকৃত, ৫০৩)। প্রিভিউ ড্যাশবোর্ডের জন্য .env-এ MARKET_API_PUBLIC_TRIGGERS=true দিন, অথবা প্রোডাকশনে DATA_API_TOKEN সেট করুন।',
  BACKFILL_INCOMPLETE: 'ব্যাকফিলের অনুরোধ-করা পরিসর টাইমস্ট্যাম্প-ভিত্তিক যাচাইতে অসম্পূর্ণ — সফল বলা হবে না।',
  DATA_NOT_READY: 'বিশ্লেষণের জন্য ডেটা এখনো প্রস্তুত নয়।',
  DATA_INVALID: 'ডেটা যাচাইয়ে ব্যর্থ — বিশ্লেষণের জন্য অবিশ্বস্ত।',
  DEMO_DATA_BLOCKED: 'ডেমো/মক ডেটা — বিশ্লেষণের জন্য চিরকাল বাতিল (এটি লাইভ বাজার নয়)।',
  INSUFFICIENT_DATA: 'পর্যাপ্ত ইতিহাস নেই — ইন্ডিকেটর ওয়ার্ম-আপের জন্য আরও ক্যান্ডেল দরকার।',
  GAP_IN_ANALYSIS_WINDOW: 'বিশ্লেষণ উইন্ডোর ভেতরে অনুপস্থিত ক্যান্ডেল — অনিরাপদ, তাই বন্ধ।',
  ANALYSIS_ERROR: 'বিশ্লেষণ ইঞ্জিনে অপ্রত্যাশিত ত্রুটি (FAILED)।',
  CLOSURE_GAPS_IN_WINDOW: 'বিশ্লেষণ উইন্ডোতে বাজার-বন্ধের সম্ভাব্য ফাঁক (তথ্য, ব্লক নয়)।',
  STRUCTURE_UNCLEAR: 'কাঠামো অস্পষ্ট — অনুমান করা হয়নি।',
  RSI_FLAT_MARKET: 'সমতল বাজার — RSI সংজ্ঞায়িত ৫০ (সতর্কতা)।',
  ADX_FLAT_MARKET: 'সমতল বাজার — DX সংজ্ঞায়িত ০ (সতর্কতা)।',
  TICK_ZERO_SPREAD: 'টিকের স্প্রেড শূন্য — সতর্কতা সহ রাখা হয়েছে।',
  // Phase 13 — signal-engine verdict reason codes (WAIT/NO_SETUP gates are
  // HEALTHY strategy outcomes, not errors; the wording must say exactly that
  // so an honest WAIT never reads as a system failure).
  HTF_H4_OPPOSITE: 'H4 প্রেক্ষাপট সেটআপের দিকের বিপরীত — উচ্চতর টাইমফ্রেম অনুমোদন দেয়নি (স্বাভাবিক WAIT)।',
  HTF_H1_OPPOSITE: 'H1 প্রেক্ষাপট সেটআপের দিকের বিপরীত — উচ্চতর টাইমফ্রেম অনুমোদন দেয়নি (স্বাভাবিক WAIT)।',
  RETEST_PENDING: 'কাঠামো-ভাঙা শনাক্ত হয়েছে — এখন লেভেলে retest-এর অপেক্ষায় (স্বাভাবিক WAIT)।',
  ZONE_INVALIDATED: 'দাম এন্ট্রি-জোন পেরিয়ে চলে গেছে — এই সেটআপ আর বৈধ নয় (স্বাভাবিক WAIT)।',
  STRUCTURE_BREAK_TOO_OLD: 'কাঠামো-ভাঙা খুব পুরোনো হয়ে গেছে — সঠিক সময়ে এন্ট্রি-জোন মিলেনি (স্বাভাবিক WAIT)।',
  NO_STRUCTURE_BREAK: 'সাম্প্রতিক উইন্ডোতে কোনো BOS/CHoCH কাঠামো-ভাঙা নেই (স্বাভাবিক NO_SETUP)।',
  NO_ANCHOR_SWING: 'স্টপ-লসের জন্য বৈধ অ্যাংকর সুইং পাওয়া যায়নি (স্বাভাবিক WAIT)।',
  EMA_TREND_OPPOSITE: 'EMA ট্রেন্ড সেটআপের দিকের বিপরীত (স্বাভাবিক WAIT)।',
  RSI_OUT_OF_RANGE: 'RSI গ্রহণযোগ্য ব্যান্ডের বাইরে (স্বাভাবিক WAIT)।',
  ADX_BELOW_MIN: 'ট্রেন্ড-শক্তি (ADX) ন্যূনতম সীমার নিচে — বাজার চপচপে (স্বাভাবিক WAIT)।',
  SPREAD_TOO_WIDE: 'স্প্রেড সর্বোচ্চ সীমার চেয়ে চওড়া (স্বাভাবিক WAIT)।',
  SPREAD_INVALID: 'স্প্রেড মান অবৈধ — গণনা করা যায়নি।',
  PRICE_BEYOND_ENTRY_ZONE: 'দাম এন্ট্রি-জোনের বাইরে — অপেক্ষা চলবে (স্বাভাবিক WAIT)।',
  AT_ZONE_BOUNDARY: 'দাম এন্ট্রি-জোনের কিনারায় — নিশ্চিত অপেক্ষা (স্বাভাবিক WAIT)।',
  LEVEL_CALC_INVALID: 'এন্ট্রি/SL/TP লেভেল গণনা বৈধ হয়নি — সেটআপ বাতিল (সুরক্ষা)।',
  INDICATOR_WARMUP: 'ইন্ডিকেটর এখনো ওয়ার্ম-আপ করছে — আরও বদ্ধ ক্যান্ডেল দরকার।',
  INSUFFICIENT_H4_HISTORY: 'H4 ইতিহাস অপর্যাপ্ত — উচ্চতর-টাইমফ্রেম প্রেক্ষাপট যাচাই করা যায়নি।',
  INSUFFICIENT_H1_HISTORY: 'H1 ইতিহাস অপর্যাপ্ত — উচ্চতর-টাইমফ্রেম প্রেক্ষাপট যাচাই করা যায়নি।',
  FORMING_CANDLE_IN_INPUT: 'ইনপুটে গঠনশীল ক্যান্ডেল ঢুকে পড়েছে — fail-closed বাতিল (সুরক্ষা)।',
  GAP_IN_WINDOW: 'বিশ্লেষণ উইন্ডোতে ফাঁক — অনিরাপদ, তাই বাতিল (সুরক্ষা)।',
  CHRONOLOGY_BROKEN: 'ক্যান্ডেলের কালানুক্রম ভাঙা — fail-closed বাতিল (সুরক্ষা)।',
  QUOTE_STALE: 'কোট পুরোনো হয়ে গেছে — সিদ্ধান্ত নেওয়া অনিরাপদ (fail-closed)।',
  QUOTE_UNAVAILABLE: 'সর্বশেষ কোট পাওয়া যায়নি (fail-closed)।',
  TICK_INVALID: 'টিক যাচাইয়ে ব্যর্থ (fail-closed)।',
  SOURCE_NOT_BROKER: 'ডেটার উৎস ব্রোকার নয় — অবিশ্বস্ত (fail-closed)।',
  NOT_AUTHENTICATED: 'ব্রিজ সেশন প্রমাণীকৃত নয় (fail-closed)।',
  BUY_SETUP: 'BUY সেটআপ শনাক্ত (গবেষণা সিগন্যাল — কোনো অর্ডার নয়)।',
  SELL_SETUP: 'SELL সেটআপ শনাক্ত (গবেষণা সিগন্যাল — কোনো অর্ডার নয়)।',
  WAIT: 'অপেক্ষা — এই মুহূর্তে কোনো বৈধ সেটআপ নেই (স্বাভাবিক, সৎ ফল)।',
  NO_SETUP: 'সেটআপ নেই — কৌশলের শর্ত পূরণ হয়নি (স্বাভাবিক, সৎ ফল)।',
  BLOCKED: 'ডেটা-গেটে বন্ধ — অবিশ্বস্ত ইনপুটে সিদ্ধান্ত হয় না (fail-closed)।',
  FAILED: 'মূল্যায়ন ব্যর্থ — বিস্তারিত সিস্টেম লগে।',
  SIGNAL_ERROR: 'সিগন্যাল ইঞ্জিনে অপ্রত্যাশিত ত্রুটি।',
};

export function bnForCode(code: string): string {
  return bnErrorText[code] ?? `অজানা সমস্যা (${code})।`;
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

export function fmtAge(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec} সেকেন্ড`;
  if (sec < 3600) return `${Math.floor(sec / 60)} মিনিট`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ঘণ্টা`;
  return `${Math.floor(sec / 86400)} দিন`;
}

export function qualityStateBadgeClass(state: string): string {
  switch (state) {
    case 'VALID':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400';
    case 'WARNING':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'STALE':
      return 'border-orange-500/40 bg-orange-500/10 text-orange-400';
    case 'MISSING':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'INVALID':
      return 'border-red-600/50 bg-red-600/15 text-red-300';
    default:
      return 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400'; // UNAVAILABLE
  }
}

export const qualityStateBn: Record<string, string> = {
  VALID: 'বৈধ',
  WARNING: 'সতর্কতা',
  INVALID: 'অবৈধ',
  STALE: 'পুরোনো',
  MISSING: 'অনুপস্থিত',
  UNAVAILABLE: 'অনুপলব্ধ',
};

export function syncStatusBn(status: string): string {
  switch (status) {
    case 'success': return 'সফল';
    case 'partial': return 'আংশিক';
    case 'failed': return 'ব্যর্থ';
    case 'skipped': return 'স্কিপ';
    case 'running': return 'চলছে';
    default: return status;
  }
}

// Phase 4 — analysis renderings
export const analysisStatusBn: Record<string, string> = {
  completed: 'সম্পূর্ণ',
  blocked: 'বন্ধ',
  failed: 'ব্যর্থ',
  pending: 'অপেক্ষমাণ',
};

export const analysisStatusClass: Record<string, string> = {
  completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  blocked: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  failed: 'border-red-500/40 bg-red-500/10 text-red-300',
  pending: 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400',
};

export const trendBn: Record<string, string> = {
  bullish: 'বুলিশ (ঊর্ধ্বমুখী)',
  bearish: 'বিয়ারিশ (নিম্নমুখী)',
  range: 'রেঞ্জ',
  unclear: 'অস্পষ্ট',
};

export const directionBn: Record<string, string> = { bullish: 'বুলিশ', bearish: 'বিয়ারিশ' };

export const alignmentBn: Record<string, string> = {
  'aligned-bullish': 'সব টাইমফ্রেম ঊর্ধ্বমুখী',
  'aligned-bearish': 'সব টাইমফ্রেম নিম্নমুখী',
  mixed: 'টাইমফ্রেমগুলো একমত নয় (মিশ্র)',
  unclear: 'অস্পষ্ট',
};

export function fmtInd(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}

const dhakaDateTime = new Intl.DateTimeFormat('bn-BD', {
  timeZone: 'Asia/Dhaka',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function fmtDhaka(iso: string): string {
  try {
    return dhakaDateTime.format(new Date(iso));
  } catch {
    return iso;
  }
}

export function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const groupLabel: Record<string, string> = {
  runtime: 'রানটাইম',
  network: 'নেটওয়ার্ক',
  glm: 'GLM',
  mt5: 'MT5',
  database: 'ডেটাবেস',
};

export function auditStatusBadgeClass(status: string): string {
  switch (status) {
    case 'PASS':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400';
    case 'WARN':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'FAIL':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'BLOCKED':
      return 'border-orange-500/40 bg-orange-500/10 text-orange-400';
    case 'NOT_APPLICABLE':
      return 'border-zinc-600/50 bg-zinc-700/20 text-zinc-500';
    default:
      return 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400'; // NOT_TESTED
  }
}

/** Phase 9 — signal outcome renderings. */
export const signalOutcomeBn: Record<string, string> = {
  BUY_SETUP: 'BUY সেটআপ (গবেষণা)',
  SELL_SETUP: 'SELL সেটআপ (গবেষণা)',
  WAIT: 'অপেক্ষা (WAIT)',
  NO_SETUP: 'সেটআপ নেই (NO_SETUP)',
  BLOCKED: 'বন্ধ (BLOCKED)',
  FAILED: 'ব্যর্থ (FAILED)',
};

export function signalOutcomeBadgeClass(outcome: string): string {
  switch (outcome) {
    case 'BUY_SETUP':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400';
    case 'SELL_SETUP':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'WAIT':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'NO_SETUP':
      return 'border-zinc-600/50 bg-zinc-700/20 text-zinc-400';
    case 'BLOCKED':
      return 'border-orange-500/40 bg-orange-500/10 text-orange-400';
    default:
      return 'border-red-600/50 bg-red-600/15 text-red-300';
  }
}

export function levelBadgeClass(level: string): string {
  switch (level) {
    case 'error':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'warn':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'info':
      return 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300';
    default:
      return 'border-zinc-700 bg-zinc-800/50 text-zinc-500';
  }
}
