/**
 * XAUUSD AI Trading Agent — Terminal navigation model (UI-02).
 * ----------------------------------------------------------------------------
 * Pure, testable definition of the mobile bottom-navigation views. The app
 * keeps its single-route architecture (src/app/page.tsx); views are client
 * state, not routes. Desktop shows the workspace + lower tabs; mobile shows
 * exactly one active view driven by this model.
 */

export type TerminalView = 'dashboard' | 'chart' | 'chat' | 'signals' | 'history' | 'analysis' | 'system' | 'settings';

export interface NavItem {
  id: TerminalView;
  /** Bengali label shown under the icon. */
  labelBn: string;
  /** Short Bengali label for cramped widths. */
  shortBn: string;
  /** Stable test id (data-view). */
  testId: string;
}

/** Order matters — it is the bottom-nav order (left → right). */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboard', labelBn: 'ড্যাশবোর্ড', shortBn: 'হোম', testId: 'nav-dashboard' },
  { id: 'chart', labelBn: 'চার্ট', shortBn: 'চার্ট', testId: 'nav-chart' },
  { id: 'chat', labelBn: 'এআই চ্যাট', shortBn: 'চ্যাট', testId: 'nav-chat' },
  // Task 45 — the Fresh Signal Table: the PRIMARY signals surface (live
  // table + pipeline health). The archive detail view stays under 'history'.
  { id: 'signals', labelBn: 'ফ্রেশ সিগন্যাল', shortBn: 'ফ্রেশ', testId: 'nav-signals' },
  { id: 'history', labelBn: 'সিগন্যাল ইতিহাস', shortBn: 'ইতিহাস', testId: 'nav-history' },
  { id: 'system', labelBn: 'সিস্টেম', shortBn: 'সিস্টেম', testId: 'nav-system' },
  // Task 33/35 — সেটিংস: UI-import for Exness MT5 credentials (bridge
  // re-credentials live; .env never touched again).
  { id: 'settings', labelBn: 'সেটিংস', shortBn: 'সেটিংস', testId: 'nav-settings' },
] as const;

export function isTerminalView(v: unknown): v is TerminalView {
  return typeof v === 'string' && NAV_ITEMS.some((n) => n.id === v);
}

/** Chart timeframe model — allowlist mirrors the backend (M1..H4). M1 was
 *  added in the Task 29 sell-miss fix: same validated bridge feed, 60s bars
 *  (chart granularity only — the strategy itself stays M15-based). */
export const CHART_TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4'] as const;
export type ChartTimeframe = (typeof CHART_TIMEFRAMES)[number];

export function isChartTimeframe(v: unknown): v is ChartTimeframe {
  return typeof v === 'string' && (CHART_TIMEFRAMES as readonly string[]).includes(v);
}

/**
 * Chart data freshness classification for display (pure).
 * Mirrors the backend staleness decision (meta.stale) and adds the
 * disconnected/empty display states. NEVER invents a "live" state.
 */
export type ChartFreshness = 'fresh' | 'stale' | 'empty' | 'unknown';

export function classifyChartFreshness(
  meta: { closedCount: number; lastClosedUtcSec: number | null; stale: boolean } | null | undefined,
): ChartFreshness {
  if (!meta) return 'unknown';
  if (meta.closedCount === 0) return 'empty';
  return meta.stale ? 'stale' : 'fresh';
}
