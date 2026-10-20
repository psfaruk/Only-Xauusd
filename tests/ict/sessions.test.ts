/**
 * Phase 14, Task 34-a — Session & News Agent tests.
 * Deterministic instants (fixed epoch seconds) pinned to expected sessions,
 * killzones and blackout envelopes. All instants are Wednesdays or Saturdays
 * (fixed weekday) so the weekend logic is exercised deterministically.
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_NEWS_WINDOWS,
  defaultSmcSessionConfig,
  previousUtcDayStartSec,
  readSessionState,
  sessionBoundariesFor,
  utcDayStartSec,
} from '@/lib/signal/ict/sessions';

/** 2025-01-15 is a Wednesday. */
const WED = Date.UTC(2025, 0, 15) / 1000;

/** 2025-01-18 is a Saturday. */
const SAT = Date.UTC(2025, 0, 18) / 1000;

const cfg = defaultSmcSessionConfig();

function at(wedBase: number, h: number, m = 0): number {
  return wedBase + h * 3600 + m * 60;
}

describe('readSessionState — session classification (UTC envelopes)', () => {
  test('03:10 UTC Wednesday → ASIA', () => {
    const s = readSessionState(at(WED, 3, 10), cfg);
    expect(s.active).toBe('ASIA');
    expect(s.inKillzone).toBe(false);
    expect(s.newsBlackout).toBe(false);
    expect(s.weekday).toBe(3);
  });

  test('08:30 UTC Wednesday → LONDON + London killzone', () => {
    const s = readSessionState(at(WED, 8, 30), cfg);
    expect(s.active).toBe('LONDON');
    expect(s.inKillzone).toBe(true);
    expect(s.killzone).toBe('LONDON_KZ');
  });

  test('13:30 UTC Wednesday → OVERLAP + NY killzone', () => {
    const s = readSessionState(at(WED, 13, 30), cfg);
    expect(s.active).toBe('OVERLAP_LDN_NY');
    expect(s.killzone).toBe('NY_KZ');
  });

  test('17:00 UTC Wednesday → NEW_YORK, no killzone', () => {
    const s = readSessionState(at(WED, 17, 0), cfg);
    expect(s.active).toBe('NEW_YORK');
    expect(s.inKillzone).toBe(false);
  });

  test('22:00 UTC Wednesday → OFF_HOURS', () => {
    const s = readSessionState(at(WED, 22, 0), cfg);
    expect(s.active).toBe('OFF_HOURS');
  });
});

describe('readSessionState — weekend honesty', () => {
  test('Saturday any time → OFF_HOURS, no killzone, no news flag', () => {
    const s = readSessionState(at(SAT, 9, 0), cfg);
    expect(s.active).toBe('OFF_HOURS');
    expect(s.inKillzone).toBe(false);
    expect(s.newsBlackout).toBe(false);
    expect(s.weekday).toBe(6);
  });

  test('Sunday 00:30 UTC → OFF_HOURS (reopen envelope)', () => {
    const s = readSessionState(Date.UTC(2025, 0, 19, 0, 30) / 1000, cfg);
    expect(s.active).toBe('OFF_HOURS');
  });
});

describe('readSessionState — approximate news blackout envelopes', () => {
  test('13:00 UTC (inside widened US-data envelope) → blackout', () => {
    const s = readSessionState(at(WED, 13, 0), cfg);
    expect(s.newsBlackout).toBe(true);
    expect(s.activeNewsWindow).not.toBeNull();
    expect(s.activeNewsWindow?.label).toContain('US data');
  });

  test('12:19 UTC (before envelope − buffer) → no blackout', () => {
    const s = readSessionState(at(WED, 12, 19), cfg);
    expect(s.newsBlackout).toBe(false);
  });

  test('13:50 UTC (after envelope + buffer) → no blackout', () => {
    const s = readSessionState(at(WED, 13, 50), cfg);
    expect(s.newsBlackout).toBe(false);
  });

  test('15:30 UTC (inside US conference envelope) → blackout', () => {
    const s = readSessionState(at(WED, 15, 30), cfg);
    expect(s.newsBlackout).toBe(true);
    expect(s.activeNewsWindow?.label).toContain('US conference');
  });

  test('blackout respects a disabled news window list', () => {
    const noNews = { ...cfg, newsWindows: [] };
    const s = readSessionState(at(WED, 13, 0), noNews);
    expect(s.newsBlackout).toBe(false);
    expect(s.activeNewsWindow).toBeNull();
  });
});

describe('day/session boundary helpers', () => {
  test('utcDayStartSec truncates to UTC midnight', () => {
    expect(utcDayStartSec(at(WED, 13, 37))).toBe(WED);
    expect(utcDayStartSec(at(WED, 0, 0))).toBe(WED);
  });

  test('previousUtcDayStartSec is exactly one day back', () => {
    expect(previousUtcDayStartSec(at(WED, 5, 0))).toBe(WED - 86_400);
  });

  test('sessionBoundariesFor covers Asia/London/NY on the same UTC day', () => {
    const b = sessionBoundariesFor(at(WED, 9, 0));
    expect(b).toHaveLength(3);
    expect(b[0]).toEqual({ session: 'ASIA', fromUtcSec: WED, toUtcSec: WED + 7 * 3600 });
    expect(b[1]).toEqual({ session: 'LONDON', fromUtcSec: WED + 7 * 3600, toUtcSec: WED + 12 * 3600 });
    expect(b[2]).toEqual({ session: 'NEW_YORK', fromUtcSec: WED + 12 * 3600, toUtcSec: WED + 21 * 3600 });
  });
});

describe('default config sanity', () => {
  test('default news windows are ordered and non-empty', () => {
    expect(DEFAULT_NEWS_WINDOWS.length).toBeGreaterThanOrEqual(1);
    for (const w of DEFAULT_NEWS_WINDOWS) {
      expect(w.toUtcMin).toBeGreaterThan(w.fromUtcMin);
    }
  });

  test('determinism — same instant twice yields identical state', () => {
    const a = readSessionState(at(WED, 13, 0), cfg);
    const b = readSessionState(at(WED, 13, 0), cfg);
    expect(a).toEqual(b);
  });
});
