/**
 * UI-02 FOCUSED TESTS — terminal navigation model.
 * Covers: bottom-nav item integrity (order, uniqueness, Bengali labels),
 * view validation, chart timeframe allowlist (mirrors backend M5..H4) and
 * the honest chart-freshness classification (never invents "fresh").
 */
import { describe, expect, test } from 'bun:test';
import {
  NAV_ITEMS,
  isTerminalView,
  CHART_TIMEFRAMES,
  isChartTimeframe,
  classifyChartFreshness,
} from '@/lib/dashboard/nav';

describe('terminal bottom navigation (mobile)', () => {
  test('has exactly the five designed views in order', () => {
    expect(NAV_ITEMS.map((n) => n.id)).toEqual(['dashboard', 'chart', 'chat', 'history', 'system']);
  });

  test('every item carries a non-empty Bengali label and a stable test id', () => {
    for (const item of NAV_ITEMS) {
      expect(item.labelBn.trim().length).toBeGreaterThan(0);
      expect(item.shortBn.trim().length).toBeGreaterThan(0);
      expect(item.testId).toMatch(/^nav-[a-z]+$/);
    }
  });

  test('view ids are unique', () => {
    expect(new Set(NAV_ITEMS.map((n) => n.id)).size).toBe(NAV_ITEMS.length);
  });

  test('isTerminalView accepts the designed ids and rejects everything else', () => {
    for (const id of ['dashboard', 'chart', 'chat', 'history', 'system']) {
      expect(isTerminalView(id)).toBe(true);
    }
    for (const bad of ['', 'orders', 'settings', null, undefined, 42, 'DASHBOARD']) {
      expect(isTerminalView(bad)).toBe(false);
    }
  });
});

describe('chart timeframe model', () => {
  test('allowlist mirrors the backend: M5, M15, H1, H4 only', () => {
    expect([...CHART_TIMEFRAMES]).toEqual(['M5', 'M15', 'H1', 'H4']);
  });

  test('isChartTimeframe rejects unsupported timeframes', () => {
    expect(isChartTimeframe('M15')).toBe(true);
    expect(isChartTimeframe('H4')).toBe(true);
    expect(isChartTimeframe('M30')).toBe(false);
    expect(isChartTimeframe('D1')).toBe(false);
    expect(isChartTimeframe('')).toBe(false);
    expect(isChartTimeframe(null)).toBe(false);
  });
});

describe('chart freshness classification (honest display states)', () => {
  test('no payload → unknown (never rendered as live)', () => {
    expect(classifyChartFreshness(null)).toBe('unknown');
    expect(classifyChartFreshness(undefined)).toBe('unknown');
  });

  test('zero closed candles → empty (honest empty, not an error)', () => {
    expect(classifyChartFreshness({ closedCount: 0, lastClosedUtcSec: null, stale: false })).toBe('empty');
  });

  test('backend stale flag → stale', () => {
    expect(classifyChartFreshness({ closedCount: 120, lastClosedUtcSec: 1_000, stale: true })).toBe('stale');
  });

  test('fresh data → fresh', () => {
    expect(classifyChartFreshness({ closedCount: 120, lastClosedUtcSec: 1_000, stale: false })).toBe('fresh');
  });
});
