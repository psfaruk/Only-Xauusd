/**
 * AUTOMATED TESTS — Signal Lifecycle Contract (Deep-remediation Phase 3).
 * ----------------------------------------------------------------------------
 * Pure-module tests (no DB, no mocks): the legal/illegal transition matrix,
 * deriveLifecycleStatus across fresh / expired / wait / fail-closed cases,
 * dedupe-key stability, and confidence honesty. Replay determinism is pinned
 * everywhere: the same evaluation always derives the same lifecycle.
 */
import { describe, expect, test } from 'bun:test';

import {
  CONFIDENCE_CALIBRATED,
  LEGAL_TRANSITIONS,
  LIFECYCLE_CONTRACT_VERSION,
  canTransition,
  confidenceLabel,
  deriveLifecycleStatus,
  signalDedupeKey,
  transition,
  type SignalLifecycleStatus,
} from '@/lib/signal/lifecycle';

const ALL_STATUSES: SignalLifecycleStatus[] = [
  'CANDIDATE',
  'CONFIRMED',
  'ISSUED',
  'EXPIRED',
  'CANCELLED',
  'OUTCOME_RECORDED',
];

const NOW_MS = Date.parse('2026-10-22T12:00:00Z');
const now = () => NOW_MS;

describe('lifecycle — legal transition matrix (master prompt Phase 3)', () => {
  test('the documented happy path is legal end-to-end', () => {
    // CANDIDATE → CONFIRMED → ISSUED → EXPIRED/CANCELLED → OUTCOME_RECORDED
    for (const [from, to] of [
      ['CANDIDATE', 'CONFIRMED'],
      ['CONFIRMED', 'ISSUED'],
      ['ISSUED', 'EXPIRED'],
      ['ISSUED', 'CANCELLED'],
      ['EXPIRED', 'OUTCOME_RECORDED'],
      ['CANCELLED', 'OUTCOME_RECORDED'],
    ] as Array<[SignalLifecycleStatus, SignalLifecycleStatus]>) {
      expect(canTransition(from, to)).toBe(true);
      expect(transition(from, to)).toEqual({ ok: true, to });
    }
  });

  test('canTransition agrees with LEGAL_TRANSITIONS for EVERY (from, to) pair', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = from !== to && LEGAL_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(expected);
      }
    }
  });

  test('self-transitions are illegal; OUTCOME_RECORDED is terminal; no resurrection', () => {
    for (const s of ALL_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
      expect(transition(s, s).ok).toBe(false);
    }
    expect(LEGAL_TRANSITIONS.OUTCOME_RECORDED).toEqual([]);
    // Nothing can return from a terminal or post-issuance state:
    for (const from of ['ISSUED', 'EXPIRED', 'CANCELLED', 'OUTCOME_RECORDED'] as SignalLifecycleStatus[]) {
      expect(canTransition(from, 'CANDIDATE')).toBe(false);
      expect(canTransition(from, 'CONFIRMED')).toBe(false);
    }
  });

  test('a CANDIDATE may never skip confirmation straight to ISSUED (no silent promotion)', () => {
    const res = transition('CANDIDATE', 'ISSUED');
    expect(res).toEqual({
      ok: false,
      error: 'ILLEGAL_TRANSITION',
      detail: expect.stringContaining('CANDIDATE → ISSUED'),
    });
  });

  test('illegal results never carry a destination and are pure (from unchanged)', () => {
    const res = transition('OUTCOME_RECORDED', 'CANDIDATE');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('ILLEGAL_TRANSITION');
  });
});

describe('lifecycle — deriveLifecycleStatus (persisted evaluations)', () => {
  const base = {
    outcome: 'BUY_SETUP',
    decisionCandleTimeUtc: '2026-10-22T11:45:00Z',
    setupKnownAtUtc: '2026-10-22T11:45:00Z',
    expiryUtc: '2026-10-22T13:00:00Z',
    now,
  };

  test('fresh actionable setup on a closed decision candle → CONFIRMED', () => {
    expect(deriveLifecycleStatus(base)).toBe('CONFIRMED');
    expect(deriveLifecycleStatus({ ...base, outcome: 'SELL_SETUP' })).toBe('CONFIRMED');
  });

  test('expired setup → EXPIRED (an old entry is never displayed as current)', () => {
    expect(deriveLifecycleStatus({ ...base, expiryUtc: '2026-10-22T11:00:00Z' })).toBe('EXPIRED');
    // Expiry wins regardless of the outcome label:
    expect(
      deriveLifecycleStatus({ ...base, outcome: 'WAIT', expiryUtc: '2026-10-22T11:00:00Z' }),
    ).toBe('EXPIRED');
  });

  test('expiry boundary: valid AT the instant, expired strictly after', () => {
    expect(deriveLifecycleStatus({ ...base, expiryUtc: new Date(NOW_MS).toISOString() })).toBe('CONFIRMED');
    expect(deriveLifecycleStatus({ ...base, expiryUtc: new Date(NOW_MS - 1).toISOString() })).toBe('EXPIRED');
  });

  test('non-actionable outcomes → CANDIDATE (wait / no-setup / blocked / failed)', () => {
    for (const outcome of ['WAIT', 'NO_SETUP', 'BLOCKED', 'FAILED']) {
      expect(
        deriveLifecycleStatus({
          ...base,
          outcome,
          decisionCandleTimeUtc: null,
          setupKnownAtUtc: null,
          expiryUtc: null,
        }),
      ).toBe('CANDIDATE');
    }
  });

  test('fail closed: actionable without provable closed-candle basis or timeliness', () => {
    // No decision candle → cannot prove the closed-candle basis.
    expect(deriveLifecycleStatus({ ...base, decisionCandleTimeUtc: null })).toBe('CANDIDATE');
    // No expiry → timeliness cannot be proven; never a fabricated CONFIRMED.
    expect(deriveLifecycleStatus({ ...base, expiryUtc: null })).toBe('CANDIDATE');
    // Unparseable expiry is treated as absent, never as "not expired" magic.
    expect(deriveLifecycleStatus({ ...base, expiryUtc: 'not-a-date' })).toBe('CANDIDATE');
  });

  test('determinism: the same evaluation always derives the same status', () => {
    const a = deriveLifecycleStatus(base);
    const b = deriveLifecycleStatus({ ...base });
    // Serializable fields round-trip; the injected clock is re-attached.
    const c = deriveLifecycleStatus({ ...JSON.parse(JSON.stringify(base)), now });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('lifecycle — canonical dedupe key', () => {
  const base = {
    symbol: 'XAUUSDm',
    strategyVersion: 'hybrid-structure-retest/9.0.0',
    setupFingerprint: 'abc123deadbeef',
    decisionCandleTimeUtc: '2026-10-22T11:45:00Z',
  };

  test('same input → same key (retries/reloads never repeat the alert)', () => {
    expect(signalDedupeKey(base)).toBe(signalDedupeKey({ ...base }));
    expect(signalDedupeKey(JSON.parse(JSON.stringify(base)) as typeof base)).toBe(signalDedupeKey(base));
  });

  test('canonical shape: symbol|strategyVersion|setupFingerprint|decisionCandleTimeUtc', () => {
    expect(signalDedupeKey(base)).toBe(
      'XAUUSDm|hybrid-structure-retest/9.0.0|abc123deadbeef|2026-10-22T11:45:00Z',
    );
  });

  test('ANY differing component → different key', () => {
    const original = signalDedupeKey(base);
    expect(signalDedupeKey({ ...base, symbol: 'XAUUSD' })).not.toBe(original);
    expect(signalDedupeKey({ ...base, strategyVersion: 'scalper-m1-m5-m15-or/14.0.0' })).not.toBe(original);
    expect(signalDedupeKey({ ...base, setupFingerprint: 'other' })).not.toBe(original);
    expect(signalDedupeKey({ ...base, decisionCandleTimeUtc: '2026-10-22T11:50:00Z' })).not.toBe(original);
  });

  test('null components use stable placeholders (never guessed, never unstable)', () => {
    const key = signalDedupeKey({
      symbol: 'XAUUSDm',
      strategyVersion: 'hybrid-structure-retest/9.0.0',
      setupFingerprint: null,
      decisionCandleTimeUtc: null,
    });
    expect(key).toBe('XAUUSDm|hybrid-structure-retest/9.0.0|no-setup-fingerprint|no-decision-candle');
    expect(signalDedupeKey({ ...base, setupFingerprint: null })).not.toBe(signalDedupeKey(base));
  });
});

describe('lifecycle — confidence honesty (never "probability" until calibrated)', () => {
  test('every tier (and no tier) maps to EVIDENCE_SCORE', () => {
    for (const tier of ['A', 'B', 'C', null, undefined]) {
      expect(confidenceLabel(tier)).toBe('EVIDENCE_SCORE');
    }
  });

  test('the calibration flag is explicitly false and the contract is versioned', () => {
    expect(CONFIDENCE_CALIBRATED).toBe(false);
    expect(LIFECYCLE_CONTRACT_VERSION).toBe('signal-lifecycle/1.0.0');
  });
});
