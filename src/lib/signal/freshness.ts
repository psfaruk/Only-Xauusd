/**
 * FRESHNESS POLICY — the single server-side source of truth (Task 45, Phase 3).
 * ----------------------------------------------------------------------------
 * One centralized, configurable policy that derives a signal's display status
 * from PERSISTED EVENT TIMESTAMPS ONLY — never from when the UI happens to
 * refresh, never from a successful poll.
 *
 * Design contract (master prompt §Phase 3 "Freshness rules"):
 *   · Market-data age  → derived from the source timeframe's latest CLOSED
 *     candle close-time (persisted in MarketCandle), vs the per-TF staleness
 *     thresholds (config.market.staleTfSec).
 *   · Signal age       → now − signalCreatedAtUtc (persisted).
 *   · Validity window  → the engine's own persisted expiryUtc.
 *   · Terminal states  → the paper ledger's persisted outcome (open/resolved:
 *     stopped | targeted | invalidated | expired).
 *   · Engine failure   → SignalEvaluation.outcome === 'FAILED' (typed enum).
 *   · Rejected candidate → any non-SETUP evaluation (WAIT/NO_SETUP/BLOCKED
 *     carries reasonCodes — the persisted rejection evidence).
 *
 * PURE module: no DB, no clock, no network. Every input is injected, every
 * output derived. Fail-closed: unknown/missing data degrades to the honest
 * worse state, never to FRESH.
 */

/** Display status vocabulary (master prompt §Phase 3 required badges). */
export type FreshSignalStatus =
  | 'FRESH'
  | 'PENDING'
  | 'VALIDATED'
  | 'STALE'
  | 'EXPIRED'
  | 'INVALIDATED'
  | 'REJECTED'
  | 'DATA_UNAVAILABLE'
  | 'ENGINE_ERROR';

export const FRESH_SIGNAL_STATUSES: readonly FreshSignalStatus[] = [
  'FRESH',
  'PENDING',
  'VALIDATED',
  'STALE',
  'EXPIRED',
  'INVALIDATED',
  'REJECTED',
  'DATA_UNAVAILABLE',
  'ENGINE_ERROR',
] as const;

/** Outcomes that constitute a PUBLISHED signal (engine typed enums). */
export const SETUP_OUTCOMES = ['BUY_SETUP', 'SELL_SETUP'] as const;

/** Paper ledger statuses (PaperSignalOutcome.status / .outcome columns). */
export const PAPER_OPEN = 'open';
export const PAPER_RESOLVED = 'resolved';

/** Inputs needed to derive one signal's status — all persisted state. */
export interface FreshnessInput {
  nowMs: number;
  /** SignalEvaluation row facts. */
  outcome: string;
  createdAtMs: number;
  expiryMs: number | null;
  /** Paper ledger row facts (null when no paper row exists). */
  paperStatus: string | null;
  paperOutcome: string | null;
  paperLastCheckedMs: number | null;
  /** Source-timeframe data freshness — latest CLOSED candle close-time, ms. */
  sourceTfLatestClosedMs: number | null;
  /** Staleness threshold for the source timeframe, seconds. */
  staleTfSec: number;
}

export interface FreshnessResult {
  status: FreshSignalStatus;
  /** Age of the signal record itself (now − createdAt), seconds. */
  ageSec: number;
  /** Age of the underlying market data (now − latest closed close-time). */
  dataAgeSec: number | null;
  /** True when the paper ledger has resolved this signal terminally. */
  terminal: boolean;
}

/** A data-availability state per timeframe (pipeline health strip). */
export type TfDataState = 'FRESH' | 'STALE' | 'DATA_UNAVAILABLE';

/**
 * Per-TF data-state classification. Thresholds (documented policy):
 *   · age ≤ staleTfSec                    → FRESH
 *   · staleTfSec < age ≤ 3×staleTfSec     → STALE (degraded but present)
 *   · age > 3×staleTfSec or no closed bar → DATA_UNAVAILABLE
 */
export function classifyTfData(
  nowMs: number,
  latestClosedCloseMs: number | null,
  staleTfSec: number,
): { state: TfDataState; ageSec: number | null } {
  if (latestClosedCloseMs === null || !Number.isFinite(latestClosedCloseMs)) {
    return { state: 'DATA_UNAVAILABLE', ageSec: null };
  }
  const ageSec = Math.max(0, (nowMs - latestClosedCloseMs) / 1000);
  if (!Number.isFinite(ageSec)) return { state: 'DATA_UNAVAILABLE', ageSec: null };
  if (ageSec > 3 * staleTfSec) return { state: 'DATA_UNAVAILABLE', ageSec };
  if (ageSec > staleTfSec) return { state: 'STALE', ageSec };
  return { state: 'FRESH', ageSec };
}

/**
 * Derive one signal's display status. Evaluation order is the policy —
 * the FIRST matching rule wins. Actionability facts (engine failure,
 * non-publication, paper resolutions, expiry) are evaluated BEFORE data-trust
 * facts (availability/staleness): an expired signal is EXPIRED even if its
 * source data has also gone stale — the more informative fact wins.
 *
 *   1. outcome === 'FAILED'                        → ENGINE_ERROR
 *   2. outcome not a SETUP (no publish)            → REJECTED (candidate)
 *   3. paper outcome 'invalidated'                 → INVALIDATED
 *   4. paper outcome 'targeted'                    → VALIDATED (TP reached)
 *   5. paper outcome 'expired'                     → EXPIRED
 *   6. paper outcome 'stopped'                     → REJECTED (market stopped
 *                                                     the thesis — SL hit)
 *   7. now > persisted expiryUtc                   → EXPIRED
 *   8. source-TF data unavailable (rule §classify) → DATA_UNAVAILABLE
 *   9. source-TF data stale                        → STALE
 *  10. paper open, never checked yet               → PENDING
 *  11. otherwise                                   → FRESH
 */
export function deriveFreshStatus(input: FreshnessInput): FreshnessResult {
  const ageSec = Math.max(0, (input.nowMs - input.createdAtMs) / 1000);
  const data = classifyTfData(input.nowMs, input.sourceTfLatestClosedMs, input.staleTfSec);

  // 1 — engine failure is a fact about the evaluation itself.
  if (input.outcome === 'FAILED') {
    return { status: 'ENGINE_ERROR', ageSec, dataAgeSec: data.ageSec, terminal: true };
  }
  // 2 — non-SETUP evaluations are rejected candidates (reasonCodes carry why).
  const isSetup = (SETUP_OUTCOMES as readonly string[]).includes(input.outcome);
  if (!isSetup) {
    return { status: 'REJECTED', ageSec, dataAgeSec: data.ageSec, terminal: true };
  }
  // 3–6 — the paper ledger's terminal resolutions.
  if (input.paperStatus === PAPER_RESOLVED || input.paperOutcome !== null) {
    switch (input.paperOutcome) {
      case 'invalidated':
        return { status: 'INVALIDATED', ageSec, dataAgeSec: data.ageSec, terminal: true };
      case 'targeted':
        return { status: 'VALIDATED', ageSec, dataAgeSec: data.ageSec, terminal: true };
      case 'expired':
        return { status: 'EXPIRED', ageSec, dataAgeSec: data.ageSec, terminal: true };
      case 'stopped':
        return { status: 'REJECTED', ageSec, dataAgeSec: data.ageSec, terminal: true };
      default:
        // resolved row without a typed outcome — honest fallback, never FRESH.
        return { status: 'EXPIRED', ageSec, dataAgeSec: data.ageSec, terminal: true };
    }
  }
  // 7 — engine-persisted expiry (actionability fact; dominates data-trust).
  if (input.expiryMs !== null && Number.isFinite(input.expiryMs) && input.nowMs > input.expiryMs) {
    return { status: 'EXPIRED', ageSec, dataAgeSec: data.ageSec, terminal: true };
  }
  // 8–9 — data availability/staleness of the signal's own source timeframe.
  if (data.state === 'DATA_UNAVAILABLE') {
    return { status: 'DATA_UNAVAILABLE', ageSec, dataAgeSec: data.ageSec, terminal: false };
  }
  if (data.state === 'STALE') {
    return { status: 'STALE', ageSec, dataAgeSec: data.ageSec, terminal: false };
  }
  // 10 — paper row exists but the first forward check has not happened yet.
  if (input.paperStatus === PAPER_OPEN && input.paperLastCheckedMs === null) {
    return { status: 'PENDING', ageSec, dataAgeSec: data.ageSec, terminal: false };
  }
  // 11 — within validity, data fresh, tracking live.
  return { status: 'FRESH', ageSec, dataAgeSec: data.ageSec, terminal: false };
}

/** Terminal statuses — a terminal signal never returns to FRESH. */
export function isTerminalStatus(status: FreshSignalStatus): boolean {
  return (
    status === 'INVALIDATED' ||
    status === 'VALIDATED' ||
    status === 'REJECTED' ||
    status === 'EXPIRED' ||
    status === 'ENGINE_ERROR'
  );
}

/**
 * Live-vs-archive scoping (master prompt: "Separate the live Fresh Signal
 * Table from the historical signal archive"). A row belongs to the LIVE
 * surface while it is non-terminal AND either unexpired or without an
 * engine expiry. Terminal resolutions (VALIDATED/REJECTED/INVALIDATED/
 * EXPIRED/ENGINE_ERROR) always move to the archive — the paper tracker may
 * keep advancing an expired setup's row in the background, but an expired
 * setup is no longer actionable and never re-enters the live table.
 */
export function isLiveRow(
  status: FreshSignalStatus,
  expiryMs: number | null,
  paperStatus: string | null,
  nowMs: number,
): boolean {
  if (isTerminalStatus(status)) return false;
  if (paperStatus === PAPER_OPEN) return true;
  if (expiryMs === null) return true;
  return nowMs <= expiryMs;
}

/** Bengali one-line explanation per status — displayed with every badge. */
export const FRESH_STATUS_BN: Record<FreshSignalStatus, string> = {
  FRESH: 'সতেজ — বৈধতা উইন্ডোর ভেতরে, ডেটা সতেজ',
  PENDING: 'অপেক্ষমাণ — সিগন্যাল রেকর্ড হয়েছে, প্রথম ফরওয়ার্ড চেক বাকি',
  VALIDATED: 'যাচাইকৃত — টার্গেট অর্জিত (পেপার)',
  STALE: 'স্টেল — সোর্স টাইমফ্রেমের ডেটা পুরোনো',
  EXPIRED: 'মেয়াদোত্তীর্ণ — বৈধতা উইন্ডো শেষ',
  INVALIDATED: 'বাতিল — ইনভ্যালিডেশন লেভেল ছুঁয়েছে (পেপার)',
  REJECTED: 'প্রত্যাখ্যাত — ফিল্টার/বাজার সেটআপ নিশ্চিত করেনি',
  DATA_UNAVAILABLE: 'ডেটা অনুপলব্ধ — সোর্স টাইমফ্রেমে সাম্প্রতিক ক্যান্ডেল নেই',
  ENGINE_ERROR: 'ইঞ্জিন ত্রুটি — মূল্যায়ন ব্যর্থ (FAILED)',
};
