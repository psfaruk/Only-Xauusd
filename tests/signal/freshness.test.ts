/**
 * FRESHNESS POLICY TESTS (Task 45, Phase 11).
 * ----------------------------------------------------------------------------
 * Pins the centralized freshness policy: every derivation rule, the per-TF
 * data classification thresholds, terminal/live semantics, and the
 * FAIL-CLOSED guarantee (missing data can never produce FRESH).
 *
 * Pure module — no DB, no network, fixed clock injected.
 */

import { describe, expect, test } from 'bun:test';
import {
  classifyTfData,
  deriveFreshStatus,
  isTerminalStatus,
  isLiveRow,
  FRESH_STATUS_BN,
  FRESH_SIGNAL_STATUSES,
} from '@/lib/signal/freshness';

const NOW = 1_792_000_000_000; // fixed clock (ms)
const T0 = NOW - 600_000; // signal created 10 min ago
const STALE_M15 = 2_700; // 3 × 900 (config default for M15)
const FRESH_CLOSE = NOW - 60_000; // latest closed candle closed 60s ago

const base = {
  nowMs: NOW,
  outcome: 'BUY_SETUP',
  createdAtMs: T0,
  expiryMs: NOW + 3_600_000,
  paperStatus: 'open',
  paperOutcome: null,
  paperLastCheckedMs: NOW - 30_000,
  sourceTfLatestClosedMs: FRESH_CLOSE,
  staleTfSec: STALE_M15,
};

describe('classifyTfData — per-TF data-state thresholds', () => {
  test('fresh: age ≤ staleTfSec', () => {
    expect(classifyTfData(NOW, NOW - 100_000, 420)).toEqual({ state: 'FRESH', ageSec: 100 });
  });
  test('stale: staleTfSec < age ≤ 3×staleTfSec', () => {
    expect(classifyTfData(NOW, NOW - 500_000, 420).state).toBe('STALE');
    expect(classifyTfData(NOW, NOW - 3 * 420_000, 420).state).toBe('STALE'); // exact 3× boundary stays STALE
  });
  test('unavailable: age > 3×staleTfSec', () => {
    expect(classifyTfData(NOW, NOW - 3 * 420_000 - 1_000, 420).state).toBe('DATA_UNAVAILABLE');
  });
  test('no closed bar at all → DATA_UNAVAILABLE (fail-closed, never FRESH)', () => {
    expect(classifyTfData(NOW, null, 420)).toEqual({ state: 'DATA_UNAVAILABLE', ageSec: null });
  });
  test('non-finite timestamp → DATA_UNAVAILABLE', () => {
    expect(classifyTfData(NOW, Number.NaN, 420).state).toBe('DATA_UNAVAILABLE');
  });
});

describe('deriveFreshStatus — the 11-rule policy order', () => {
  test('rule 1: FAILED evaluation → ENGINE_ERROR (terminal)', () => {
    const r = deriveFreshStatus({ ...base, outcome: 'FAILED' });
    expect(r.status).toBe('ENGINE_ERROR');
    expect(r.terminal).toBe(true);
  });

  test('rule 2: non-SETUP outcome (WAIT/NO_SETUP/BLOCKED) → REJECTED', () => {
    for (const outcome of ['WAIT', 'NO_SETUP', 'BLOCKED']) {
      expect(deriveFreshStatus({ ...base, outcome }).status).toBe('REJECTED');
    }
  });

  test('rules 3–6: paper resolutions map to terminal states', () => {
    expect(deriveFreshStatus({ ...base, paperStatus: 'resolved', paperOutcome: 'invalidated' }).status).toBe('INVALIDATED');
    expect(deriveFreshStatus({ ...base, paperStatus: 'resolved', paperOutcome: 'targeted' }).status).toBe('VALIDATED');
    expect(deriveFreshStatus({ ...base, paperStatus: 'resolved', paperOutcome: 'expired' }).status).toBe('EXPIRED');
    // stopped = the market rejected the thesis (SL) — honest REJECTED, terminal
    expect(deriveFreshStatus({ ...base, paperStatus: 'resolved', paperOutcome: 'stopped' }).status).toBe('REJECTED');
  });

  test('resolved paper row without a typed outcome NEVER becomes FRESH (fail-closed fallback)', () => {
    expect(deriveFreshStatus({ ...base, paperStatus: 'resolved', paperOutcome: null }).status).toBe('EXPIRED');
  });

  test('rule 7: now past persisted expiryUtc → EXPIRED (terminal) — expiry dominates data state', () => {
    const r = deriveFreshStatus({ ...base, expiryMs: NOW - 1_000 });
    expect(r.status).toBe('EXPIRED');
    expect(r.terminal).toBe(true);
    // priority pin: past expiry wins even when data is ALSO unavailable
    expect(
      deriveFreshStatus({ ...base, expiryMs: NOW - 1_000, sourceTfLatestClosedMs: null }).status,
    ).toBe('EXPIRED');
  });

  test('rule 8: source-TF data unavailable → DATA_UNAVAILABLE even inside validity window', () => {
    const r = deriveFreshStatus({ ...base, sourceTfLatestClosedMs: null });
    expect(r.status).toBe('DATA_UNAVAILABLE');
    expect(r.terminal).toBe(false);
  });

  test('rule 8: very old candle (> 3× threshold) → DATA_UNAVAILABLE', () => {
    expect(deriveFreshStatus({ ...base, sourceTfLatestClosedMs: NOW - 4 * STALE_M15 * 1000 }).status).toBe('DATA_UNAVAILABLE');
  });

  test('rule 9: stale-but-present candle → STALE (within validity window)', () => {
    expect(deriveFreshStatus({ ...base, sourceTfLatestClosedMs: NOW - 2 * STALE_M15 * 1000 }).status).toBe('STALE');
  });

  test('rule 10: paper open but never checked → PENDING', () => {
    expect(deriveFreshStatus({ ...base, paperLastCheckedMs: null }).status).toBe('PENDING');
  });

  test('rule 11: within validity, data fresh, tracking live → FRESH', () => {
    const r = deriveFreshStatus(base);
    expect(r.status).toBe('FRESH');
    expect(r.terminal).toBe(false);
    expect(r.ageSec).toBe(600);
    expect(r.dataAgeSec).toBe(60);
  });

  test('no paper row at all + fresh data + valid window → FRESH (paper is optional)', () => {
    const r = deriveFreshStatus({ ...base, paperStatus: null, paperLastCheckedMs: null });
    expect(r.status).toBe('FRESH');
  });

  test('future/negative ages clamp to 0 (clock skew safety)', () => {
    const r = deriveFreshStatus({ ...base, createdAtMs: NOW + 5_000 });
    expect(r.ageSec).toBe(0);
    expect(r.status).toBe('FRESH');
  });
});

describe('terminal + live semantics', () => {
  test('terminal statuses are exactly the five terminal states', () => {
    for (const s of ['INVALIDATED', 'VALIDATED', 'REJECTED', 'EXPIRED', 'ENGINE_ERROR'] as const) {
      expect(isTerminalStatus(s)).toBe(true);
    }
    for (const s of ['FRESH', 'PENDING', 'STALE', 'DATA_UNAVAILABLE'] as const) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });

  test('live row: non-terminal + unexpired → live; terminal or expired → archive', () => {
    expect(isLiveRow('FRESH', NOW + 1_000, 'open', NOW)).toBe(true);
    expect(isLiveRow('STALE', NOW + 1_000, null, NOW)).toBe(true);
    // expired (terminal) → always archive, even with an open paper row
    expect(isLiveRow('EXPIRED', NOW - 1_000, 'open', NOW)).toBe(false);
    expect(isLiveRow('EXPIRED', NOW - 1_000, null, NOW)).toBe(false);
    // terminal → always archive
    expect(isLiveRow('VALIDATED', NOW + 1_000, 'open', NOW)).toBe(false);
    // no expiry recorded + non-terminal → live (honest default for setups without expiry)
    expect(isLiveRow('PENDING', null, null, NOW)).toBe(true);
  });
});

describe('vocabulary integrity', () => {
  test('exactly the nine master-prompt badges, each with a Bengali explanation', () => {
    expect([...FRESH_SIGNAL_STATUSES]).toEqual([
      'FRESH', 'PENDING', 'VALIDATED', 'STALE', 'EXPIRED',
      'INVALIDATED', 'REJECTED', 'DATA_UNAVAILABLE', 'ENGINE_ERROR',
    ]);
    for (const s of FRESH_SIGNAL_STATUSES) {
      expect(FRESH_STATUS_BN[s].length).toBeGreaterThan(5);
    }
  });
});
