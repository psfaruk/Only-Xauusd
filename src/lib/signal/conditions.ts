/**
 * XAUUSD AI Trading Agent — Signal Condition Checklist (Phase 11, section I)
 * ----------------------------------------------------------------------------
 * READ-TIME observability derivation: explains WHY the latest evaluation did
 * (or did not) produce a signal — which conditions passed, which failed, and
 * whether each is strategy logic or data quality. Derived PURELY from a
 * persisted evaluation (or its honest absence). The protocol-frozen engine
 * core (core.ts) is NEVER touched — this module only reads its output.
 *
 * Honesty rules:
 *   · The engine evaluates stages in order and stops at the first failure —
 *     checks downstream of a failed strategy stage are reported as null
 *     ("পর্যায়ে পৌঁছায়নি"), never as fake passes.
 *   · BLOCKED (data-quality) evaluations never blame the strategy: strategy
 *     checks are null and the category is data-quality.
 *   · No evaluation at all → source 'none' with an honest headline — never a
 *     fabricated check and never a strategy failure.
 */

import type { SignalEvidence } from '@/lib/signal/types';

export type ConditionCategory = 'data-quality' | 'strategy-logic';

export interface ConditionCheck {
  id: string;
  labelBn: string;
  category: ConditionCategory;
  /** true = passed, false = failed, null = not evaluated (upstream stopped). */
  passed: boolean | null;
  detailBn: string | null;
}

export interface ConditionReport {
  source: 'evaluation' | 'none';
  headlineBn: string;
  category: ConditionCategory | null;
  checks: ConditionCheck[];
}

/** Loose read shape — accepts the persisted evaluation as served by the API. */
export interface ConditionEvaluationLike {
  outcome: string;
  reasonCodes?: string[] | null;
  evidence?: unknown;
}

const DATA_BLOCK_CODES = new Set([
  'SPEC_MISSING', 'DATA_MISSING', 'DATA_INVALID', 'DATA_STALE', 'INSUFFICIENT_DATA',
  'INSUFFICIENT_H1_HISTORY', 'INSUFFICIENT_H4_HISTORY', 'CHRONOLOGY_BROKEN',
  'FORMING_CANDLE_IN_INPUT', 'SOURCE_DEMO', 'SOURCE_NOT_BROKER', 'INDICATOR_WARMUP',
  'GAP_IN_WINDOW', 'SYMBOL_NOT_ALLOWED', 'NOT_AUTHENTICATED', 'QUOTE_STALE',
  'QUOTE_UNAVAILABLE', 'TICK_INVALID', 'TICK_STALE', 'SPREAD_INVALID', 'SIGNAL_ERROR',
]);

const QUOTE_CODES = new Set(['QUOTE_STALE', 'QUOTE_UNAVAILABLE', 'TICK_INVALID', 'TICK_STALE', 'NOT_AUTHENTICATED', 'SPREAD_INVALID']);
const WINDOW_CODES = new Set([
  'DATA_MISSING', 'DATA_INVALID', 'INSUFFICIENT_DATA', 'INSUFFICIENT_H1_HISTORY', 'INSUFFICIENT_H4_HISTORY',
  'CHRONOLOGY_BROKEN', 'FORMING_CANDLE_IN_INPUT', 'SOURCE_DEMO', 'SOURCE_NOT_BROKER', 'INDICATOR_WARMUP', 'GAP_IN_WINDOW',
]);

/** Strategy-stage order (the engine's own evaluation order). */
const STRATEGY_STAGES = [
  { id: 'structure', codes: ['NO_STRUCTURE_BREAK', 'STRUCTURE_BREAK_TOO_OLD'] },
  { id: 'zone', codes: ['ZONE_INVALIDATED', 'AT_ZONE_BOUNDARY'] },
  { id: 'retest', codes: ['RETEST_PENDING'] },
  { id: 'spread', codes: ['SPREAD_TOO_WIDE'] },
  { id: 'htf', codes: ['HTF_H1_OPPOSITE', 'HTF_H4_OPPOSITE'] },
  { id: 'indicators', codes: ['EMA_TREND_OPPOSITE', 'RSI_OUT_OF_RANGE', 'ADX_BELOW_MIN'] },
  { id: 'proximity', codes: ['PRICE_BEYOND_ENTRY_ZONE'] },
  { id: 'levels', codes: ['NO_ANCHOR_SWING', 'LEVEL_CALC_INVALID'] },
] as const;

const OUTCOME_HEADLINE_BN: Record<string, string> = {
  BUY_SETUP: 'BUY সেটআপ — সব শর্ত পাস (গবেষণা সিগন্যাল, কোনো অর্ডার নয়)',
  SELL_SETUP: 'SELL সেটআপ — সব শর্ত পাস (গবেষণা সিগন্যাল, কোনো অর্ডার নয়)',
  WAIT: 'অপেক্ষা (WAIT) — ইনপুট বৈধ, কিন্তু এখনো সম্পূর্ণ সেটআপ হয়নি',
  NO_SETUP: 'সেটআপ নেই (NO_SETUP) — শর্তগুলো এখন সেটআপ তৈরি করে না',
  BLOCKED: 'মূল্যায়ন ব্লকড — ডেটা/নিরাপত্তা গেট (কৌশলগত ব্যর্থতা নয়)',
  FAILED: 'ইঞ্জিন ত্রুটি (bounded, safe)',
};

const TREND_BN: Record<string, string> = {
  bullish: 'বুলিশ', bearish: 'বিয়ারিশ', unclear: 'আনক্লিয়ার',
};

const fmt1 = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : String(Number(v.toFixed(1)));

export function deriveConditionReport(evaluation: ConditionEvaluationLike | null | undefined): ConditionReport {
  if (!evaluation) {
    return {
      source: 'none',
      headlineBn: 'কোনো মূল্যায়ন সংরক্ষিত নেই — ডেটা সংযোগ ছাড়া মূল্যায়ন সম্ভব নয় (এটি কৌশলগত ব্যর্থতা নয়; বর্তমান পরিবেশে ব্রিজ বিচ্ছিন্ন)।',
      category: null,
      checks: [],
    };
  }

  const codes = new Set<string>(evaluation.reasonCodes ?? []);
  const outcome = evaluation.outcome;
  const evidence = (evaluation.evidence ?? null) as SignalEvidence | null;
  const isBlockedFamily = outcome === 'BLOCKED' || outcome === 'FAILED' || [...codes].some((c) => DATA_BLOCK_CODES.has(c));
  const category: ConditionCategory = isBlockedFamily ? 'data-quality' : 'strategy-logic';
  const isSetup = outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP';

  // ── Data-quality checks (always derivable from the codes) ────────────────
  const dataChecks: ConditionCheck[] = [
    {
      id: 'spec',
      labelBn: 'সিম্বল স্পেসিফিকেশন (digits)',
      category: 'data-quality',
      passed: codes.has('SPEC_MISSING') || codes.has('SYMBOL_NOT_ALLOWED') ? false : true,
      detailBn: codes.has('SPEC_MISSING') ? 'যাচাইকৃত digits পাওয়া যায়নি — লেভেল ফরম্যাটিং অবিশ্বস্ত, তাই ব্লকড' : 'যাচাইকৃত ব্রোকার স্পেসিফিকেশন উপস্থিত',
    },
    {
      id: 'quote',
      labelBn: 'লাইভ কোট ইন্টিগ্রিটি',
      category: 'data-quality',
      passed: ![...QUOTE_CODES].some((c) => codes.has(c)),
      detailBn: [...QUOTE_CODES].filter((c) => codes.has(c)).join(', ') || null,
    },
    {
      id: 'windows',
      labelBn: 'ক্যান্ডল উইন্ডো (M15/H1/H4)',
      category: 'data-quality',
      passed: ![...WINDOW_CODES].some((c) => codes.has(c)),
      detailBn: [...WINDOW_CODES].filter((c) => codes.has(c)).join(', ') || null,
    },
  ];

  // ── Strategy checks (funnel: null after the first failure) ───────────────
  const structureEvent = evidence?.structureEvent ?? null;
  const strategyChecks: ConditionCheck[] = [];
  let stopped = isBlockedFamily; // behind a data gate nothing was evaluated

  const push = (check: Omit<ConditionCheck, 'passed' | 'detailBn'> & { detailBn?: string | null }, failed: boolean, detailBn: string | null) => {
    if (stopped) {
      strategyChecks.push({ ...check, passed: null, detailBn: null });
      return;
    }
    if (failed) {
      strategyChecks.push({ ...check, passed: false, detailBn });
      stopped = true; // everything downstream was never evaluated
    } else {
      strategyChecks.push({ ...check, passed: true, detailBn });
    }
  };

  // structure
  {
    const failed = codes.has('NO_STRUCTURE_BREAK') || codes.has('STRUCTURE_BREAK_TOO_OLD');
    let detail: string | null = null;
    if (codes.has('STRUCTURE_BREAK_TOO_OLD')) detail = `সর্বশেষ ব্রেক পুরোনো — maxBarsSinceBreak পেরিয়ে গেছে (${structureEvent ? `ব্রেক ${structureEvent.breakCandleTimeUtc}` : ''})`;
    else if (structureEvent) detail = `${structureEvent.type} ${TREND_BN[structureEvent.direction] ?? structureEvent.direction} @ ${structureEvent.levelText} · ব্রেক ${structureEvent.barsSinceBreak} বার আগে`;
    else if (codes.has('NO_STRUCTURE_BREAK')) detail = 'উইন্ডোয় কোনো কনফার্মড BOS/CHoCH নেই';
    push({ id: 'structure', labelBn: 'কনফার্মড স্ট্রাকচার ব্রেক (BOS/CHoCH)', category: 'strategy-logic' }, failed, detail);
  }

  // zone
  {
    const failed = codes.has('ZONE_INVALIDATED') || codes.has('AT_ZONE_BOUNDARY');
    const detail = codes.has('ZONE_INVALIDATED')
      ? 'ব্রেকের পর ক্লোজ ভাঙা লেভেলের ওপারে — জোন বাতিল'
      : codes.has('AT_ZONE_BOUNDARY')
        ? 'সিদ্ধান্ত-ক্লোজ ঠিক লেভেলের সীমানায় — এখনো নিশ্চিত নয়'
        : structureEvent ? `লেভেল ${structureEvent.levelText}-এর ওপারে ক্লোজ ধরে আছে` : null;
    push({ id: 'zone', labelBn: 'জোন বৈধতা (ক্লোজ লেভেল অতিক্রম করেনি)', category: 'strategy-logic' }, failed, detail);
  }

  // retest
  {
    const retestAt = evidence?.retestBarTimeUtc ?? null;
    const failed = codes.has('RETEST_PENDING');
    push(
      { id: 'retest', labelBn: 'এন্ট্রি জোনে রিটেস্ট', category: 'strategy-logic' },
      failed,
      retestAt ? `রিটেস্ট বার: ${retestAt}` : 'ব্রেকের পর দাম এখনো এন্ট্রি জোনে ফেরেনি',
    );
  }

  // spread
  {
    const failed = codes.has('SPREAD_TOO_WIDE');
    push({ id: 'spread', labelBn: 'স্প্রেড গেট', category: 'strategy-logic' }, failed, failed ? 'স্প্রেড maxSpreadPrice-এর বেশি' : 'স্প্রেড সীমার মধ্যে');
  }

  // htf
  {
    const failed = codes.has('HTF_H1_OPPOSITE') || codes.has('HTF_H4_OPPOSITE');
    const htf = evidence?.htfContext ?? null;
    const detail = htf
      ? `H1: ${TREND_BN[htf.h1Trend ?? ''] ?? '—'} · H4: ${TREND_BN[htf.h4Trend ?? ''] ?? '—'}`
      : null;
    push({ id: 'htf', labelBn: 'HTF কনটেক্সট (H1/H4 বিপরীত নয়)', category: 'strategy-logic' }, failed, detail);
  }

  // indicators
  {
    const failed = codes.has('EMA_TREND_OPPOSITE') || codes.has('RSI_OUT_OF_RANGE') || codes.has('ADX_BELOW_MIN');
    const ind = evidence?.indicators ?? null;
    const detail = ind
      ? `EMA50 ${fmt1(ind.ema50)} · RSI ${fmt1(ind.rsi14)} · ADX ${fmt1(ind.adx14)} · ATR ${fmt1(ind.atr14)}`
      : null;
    push({ id: 'indicators', labelBn: 'ইন্ডিকেটর ফিল্টার (EMA50/RSI/ADX)', category: 'strategy-logic' }, failed, detail);
  }

  // proximity
  {
    const failed = codes.has('PRICE_BEYOND_ENTRY_ZONE');
    const close = evidence?.decisionClose ?? null;
    push(
      { id: 'proximity', labelBn: 'লাইভ দাম এন্ট্রি জোনের কাছাকাছি', category: 'strategy-logic' },
      failed,
      failed ? 'রেফারেন্স দাম জোন ± সহনশীলতার বাইরে' : close !== null ? `সিদ্ধান্ত-ক্লোজ ${fmt1(close)}` : null,
    );
  }

  // levels
  {
    const failed = codes.has('NO_ANCHOR_SWING') || codes.has('LEVEL_CALC_INVALID');
    push({ id: 'levels', labelBn: 'লেভেল গণিত (SL/TP বৈধ ক্রম)', category: 'strategy-logic' }, failed, failed ? 'অ্যাঙ্কর সুইং বা লেভেল-ক্রম অবৈধ — লেভেল তৈরি হয়নি' : 'বৈধ অ্যাঙ্কর ও ক্রম বিদ্যমান');
  }

  // On a pure setup every strategy check must be passed (sanity: if a code
  // slipped through, the funnel above already marked it failed honestly).
  const headline = isSetup
    ? OUTCOME_HEADLINE_BN[outcome]
    : `${OUTCOME_HEADLINE_BN[outcome] ?? outcome}${evaluation.reasonCodes?.length ? ` — ${evaluation.reasonCodes.join(', ')}` : ''}`;

  return {
    source: 'evaluation',
    headlineBn: headline,
    category,
    checks: [...dataChecks, ...strategyChecks],
  };
}
