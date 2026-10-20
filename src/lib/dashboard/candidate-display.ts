/**
 * XAUUSD AI Trading Agent — Candidate research card display helpers (Phase 11-E).
 * ----------------------------------------------------------------------------
 * Pure, testable projection of the `candidate.paperStats` payload (from
 * /api/signal/latest) into the Bengali strings the CandidateSignalCard renders.
 * No React here (JSX lives in components/terminal/) so this module stays
 * trivially testable, like the rest of src/lib/dashboard.
 *
 * Honesty contract: every line is derived from the payload only — no
 * fabricated counts, no performance claim below the pre-registered 20-outcome
 * sample floor (phase11-candidate-forward/1).
 */

import { paperConclusionBn } from './i18n';
import type { CandidatePaperStatsView } from './types';

/** Bengali digit rendering (০-৯) for Bengali display copy. */
export function bnDigits(n: number | string): string {
  const s = typeof n === 'number' ? String(Math.trunc(n)) : n;
  const map: Record<string, string> = {
    '0': '০', '1': '১', '2': '২', '3': '৩', '4': '৪',
    '5': '৫', '6': '৬', '7': '৭', '8': '৮', '9': '৯',
  };
  return s.replace(/[0-9]/g, (d) => map[d] ?? d);
}

/** Progress against the pre-registered sample floor (e.g. "০/২০ সম্পূর্ণ ফলাফল"). */
export function candidatePaperFloorLineBn(completedOutcomes: number, minCompleted: number): string {
  const done = bnDigits(Math.max(0, Math.trunc(completedOutcomes)));
  const floor = bnDigits(Math.max(0, Math.trunc(minCompleted)));
  return completedOutcomes < minCompleted
    ? `${done}/${floor} সম্পূর্ণ ফলাফল — ${floor}টি সম্পূর্ণ ফলাফল লাগবে (নমুনা-সীমার নিচে কোনো পারফরম্যান্স-দাবি নেই)`
    : `${done}/${floor} সম্পূর্ণ ফলাফল — নমুনা-সীমা পূরণ হয়েছে`;
}

/** Resolved-outcome breakdown (e.g. "নিষ্পন্ন ৪ — SL ১ · টার্গেট ২ · বাতিল ০ · মেয়াদোত্তীর্ণ ১"). */
export function candidatePaperResolvedLineBn(resolved: {
  stopped: number;
  targeted: number;
  invalidated: number;
  expired: number;
}): string {
  const total = resolved.stopped + resolved.targeted + resolved.invalidated + resolved.expired;
  return (
    `নিষ্পন্ন ${bnDigits(total)} — ` +
    `SL ${bnDigits(resolved.stopped)} · টার্গেট ${bnDigits(resolved.targeted)} · ` +
    `বাতিল ${bnDigits(resolved.invalidated)} · মেয়াদোত্তীর্ণ ${bnDigits(resolved.expired)}`
  );
}

/** Bengali label for a verdict conclusion, with an honest unknown fallback. */
export function paperConclusionLabelBn(conclusion: string): string {
  return paperConclusionBn[conclusion] ?? `অজানা রায়-অবস্থা (${conclusion})`;
}

/** The pure view-model of the forward-paper strip on the candidate card. */
export interface CandidatePaperStripModel {
  /** true when paperStats.total === 0 — the honest "nothing tracked yet" state. */
  isEmpty: boolean;
  /** Shown when isEmpty — explains when tracking starts (never fabricates rows). */
  emptyLine: string;
  /** Progress vs the pre-registered sample floor. */
  floorLine: string;
  /** total / open / resolved counts line. */
  countsLine: string;
  /** Resolved-outcome breakdown. */
  resolvedLine: string;
  /** Bengali verdict label (INCOMPLETE etc.). */
  conclusionLabel: string;
  /** Unobservable-expiry disclosure — only when it actually happened (> 0). */
  unobservableLine: string | null;
  /** Stopping-condition alert — only when the protocol says it triggered. */
  stopLine: string | null;
}

/** Project the API paperStats payload into the strip's Bengali strings. */
export function buildCandidatePaperStrip(stats: CandidatePaperStatsView): CandidatePaperStripModel {
  const minCompleted = stats.protocol?.minCompleted ?? 20;
  const resolvedTotal =
    stats.resolved.stopped + stats.resolved.targeted + stats.resolved.invalidated + stats.resolved.expired;
  return {
    isEmpty: stats.total === 0,
    emptyLine: 'এখনো কোনো ক্যান্ডিডেট পেপার-সারি খোলা হয়নি — প্রথম ক্যান্ডিডেট সেটআপের পর ট্র্যাকিং শুরু হবে।',
    floorLine: candidatePaperFloorLineBn(stats.completedOutcomes, minCompleted),
    countsLine: `মোট ${bnDigits(stats.total)} সারি · চলমান ${bnDigits(stats.open)} · নিষ্পন্ন ${bnDigits(resolvedTotal)}`,
    resolvedLine: candidatePaperResolvedLineBn(stats.resolved),
    conclusionLabel: paperConclusionLabelBn(stats.verdict?.conclusion ?? ''),
    unobservableLine:
      stats.unobservableExpired > 0
        ? `${bnDigits(stats.unobservableExpired)}টি মেয়াদোত্তীর্ণ সারির ফলাফল পর্যবেক্ষণযোগ্য নয় — হিসাব থেকে বাদ, কখনো বানানো হয় না।`
        : null,
    stopLine:
      stats.stopCondition?.triggered === true
        ? `প্রোটোকল স্টপ-শর্ত পূরণ হয়েছে — ${stats.stopCondition.reason ?? 'কারণ নথিভুক্ত নয়'}। পর্যবেক্ষণ থামানোর সিদ্ধান্ত অপারেটরের।`
        : null,
  };
}
