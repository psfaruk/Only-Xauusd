/**
 * XAUUSD AI Trading Agent — Market Session Awareness (Phase 3)
 * ----------------------------------------------------------------------------
 * Used by gap detection to avoid flagging normal market closures as defects.
 *
 * HONESTY CONTRACT (spec Step 4):
 * The exact XAUUSDm session schedule for this Exness demo account is NOT
 * verified — no broker session specification was retrieved. Therefore:
 *   · Closure windows below are APPROXIMATE envelopes (widened to cover both
 *     DST variants), derived from generic spot-gold market conventions
 *     (COMEX/OTC gold): weekend close Fri ~20:00–22:00 UTC, reopen Sun
 *     ~22:00–23:00 UTC; a short daily maintenance break around 20:00–22:00 UTC.
 *   · A missing candle inside an envelope is reported as
 *     GAP_MARKET_LIKELY_CLOSED (severity: info, "possible gap") — NEVER as a
 *     confirmed closure and never silently ignored.
 *   · A missing candle outside every envelope is GAP_POSSIBLE (severity:
 *     warning) — a possible defect or an UNKNOWN holiday. We do not invent a
 *     definitive diagnosis for unknown schedules.
 *
 * When the broker schedule becomes verified (Phase 2 bridge extension), this
 * module can be replaced by a verified schedule without touching callers.
 */

import type { MissingCandle } from './types';

/** Widened weekend envelope (covers both DST variants). */
const WEEKEND_START_UTC_MIN = 20 * 60; // Friday 20:00 UTC (earliest plausible close)
const WEEKEND_END_UTC_MIN = 23 * 60 + 59; // Sunday 23:59 UTC (latest plausible reopen)

/** Widened daily-break envelope. */
const DAILY_BREAK_START_UTC_MIN = 20 * 60; // 20:00 UTC
const DAILY_BREAK_END_UTC_MIN = 22 * 60; // 22:00 UTC

/** How many minutes after the weekend envelope a reopen may lag. */
const SUNDAY_REOPEN_GRACE_MIN = 90;

export type ClosureKind = 'weekend' | 'daily_break' | null;

export interface ClosureAssessment {
  likelyClosed: boolean;
  kind: ClosureKind;
  /** 'approximate' — always. We never claim a verified broker schedule. */
  confidence: 'approximate';
  noteEn: string;
}

/** Assess whether the market was likely closed at a given UTC instant. */
export function marketLikelyClosedAtUtc(instant: Date): ClosureAssessment {
  const day = instant.getUTCDay(); // 0=Sun … 6=Sat
  const minutes = instant.getUTCHours() * 60 + instant.getUTCMinutes();

  // Saturday: always inside the weekend envelope.
  if (day === 6) {
    return {
      likelyClosed: true,
      kind: 'weekend',
      confidence: 'approximate',
      noteEn: 'Saturday — spot gold market weekend (approximate envelope).',
    };
  }

  // Friday: closed from WEEKEND_START until midnight UTC.
  if (day === 5 && minutes >= WEEKEND_START_UTC_MIN) {
    return {
      likelyClosed: true,
      kind: 'weekend',
      confidence: 'approximate',
      noteEn: 'Friday after ~20:00 UTC — market weekend likely began (approximate envelope).',
    };
  }

  // Sunday: closed until the envelope end + grace (reopen can lag).
  if (day === 0 && minutes <= WEEKEND_END_UTC_MIN + SUNDAY_REOPEN_GRACE_MIN) {
    return {
      likelyClosed: true,
      kind: 'weekend',
      confidence: 'approximate',
      noteEn: 'Sunday before ~01:30 UTC — market weekend likely still active (approximate envelope + grace).',
    };
  }

  // Any day: short maintenance-break envelope around 20:00–22:00 UTC.
  // (On Friday this is inside the weekend envelope already; on Sat/Sun too.)
  if (day >= 1 && day <= 4 && minutes >= DAILY_BREAK_START_UTC_MIN && minutes < DAILY_BREAK_END_UTC_MIN) {
    return {
      likelyClosed: true,
      kind: 'daily_break',
      confidence: 'approximate',
      noteEn: 'Inside ~20:00–22:00 UTC daily maintenance-break envelope (approximate, not broker-verified).',
    };
  }

  return {
    likelyClosed: false,
    kind: null,
    confidence: 'approximate',
    noteEn: 'Outside every known approximate closure envelope.',
  };
}

/** Classify one missing (expected but absent) candle by session awareness. */
export function classifyMissingCandle(expectedTimeUtcSec: number): MissingCandle {
  const assessment = marketLikelyClosedAtUtc(new Date(expectedTimeUtcSec * 1000));
  if (assessment.likelyClosed) {
    return {
      expectedTimeUtcSec,
      severity: 'info',
      reasonCode: 'GAP_MARKET_LIKELY_CLOSED',
      note: `Possible gap — ${assessment.noteEn} Reported as possible, not confirmed.`,
    };
  }
  return {
    expectedTimeUtcSec,
    severity: 'warning',
    reasonCode: 'GAP_POSSIBLE',
    note: 'Possible gap outside approximate closure windows — could be a broker holiday (schedule unknown) or a data defect.',
  };
}

/**
 * Classify a batch of missing candles. The result is deterministic for the
 * same input; ordering follows the input order.
 */
export function classifyMissingCandles(expectedTimesUtcSec: number[]): MissingCandle[] {
  return expectedTimesUtcSec.map((t) => classifyMissingCandle(t));
}
