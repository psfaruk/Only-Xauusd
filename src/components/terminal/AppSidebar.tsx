'use client';

/**
 * XAUUSD AI Trading Agent — Desktop navigation sidebar (Task 39, UI-03).
 * ----------------------------------------------------------------------------
 * Grouped, collapsible left navigation for the desktop terminal shell:
 *
 *   ট্রেডিং    → ড্যাশবোর্ড (chart workspace) · সিগন্যাল ইতিহাস · বিশ্লেষণ
 *   সিস্টেম    → সিস্টেম · সেটিংস
 *
 * Pure presentation — switching a view is the SAME client-state switch the
 * mobile bottom-nav uses (no routing, no backend change). Collapsed width
 * persists in localStorage; icon-only mode shows accessible tooltips.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  Activity,
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  Home,
  Settings as SettingsIcon,
  ShieldCheck,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { TerminalView } from '@/lib/dashboard/nav';
import type { HealthReport } from '@/lib/dashboard/types';

const STORAGE_KEY = 'xauusd.sidebar.collapsed';
const CHANGE_EVENT = 'xauusd:sidebar-collapse';

/**
 * localStorage-backed collapsed flag via useSyncExternalStore — SSR-safe
 * (server snapshot: expanded) and re-renders on toggle without a
 * setState-in-effect.
 */
function useSidebarCollapsed(): [boolean, () => void] {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener('storage', onStoreChange);
    window.addEventListener(CHANGE_EVENT, onStoreChange);
    return () => {
      window.removeEventListener('storage', onStoreChange);
      window.removeEventListener(CHANGE_EVENT, onStoreChange);
    };
  }, []);
  const collapsed = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return window.localStorage.getItem(STORAGE_KEY) === '1';
      } catch {
        return false;
      }
    },
    () => false,
  );
  const toggle = useCallback(() => {
    try {
      const next = window.localStorage.getItem(STORAGE_KEY) !== '1';
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* private mode — visual toggle only for this render */
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [collapsed, toggle];
}

export interface SidebarNavItem {
  id: TerminalView;
  labelBn: string;
  icon: React.ComponentType<{ className?: string }>;
}

const GROUPS: Array<{ labelBn: string; items: SidebarNavItem[] }> = [
  {
    labelBn: 'ট্রেডিং',
    items: [
      { id: 'dashboard', labelBn: 'ড্যাশবোর্ড', icon: Home },
      { id: 'history', labelBn: 'সিগন্যাল ইতিহাস', icon: Activity },
      { id: 'analysis', labelBn: 'বিশ্লেষণ', icon: BarChart3 },
    ],
  },
  {
    labelBn: 'সিস্টেম',
    items: [
      { id: 'system', labelBn: 'সিস্টেম', icon: ShieldCheck },
      { id: 'settings', labelBn: 'সেটিংস', icon: SettingsIcon },
    ],
  },
];

export function AppSidebar({
  view,
  onViewChange,
  health,
}: {
  view: TerminalView;
  onViewChange: (v: TerminalView) => void;
  health: HealthReport | null;
}) {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();

  const locked = health?.executionLocked ?? true; // fail-closed display default

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        aria-label="ডেস্কটপ নেভিগেশন"
        data-testid="app-sidebar"
        data-collapsed={collapsed ? 'true' : 'false'}
        className={`sticky top-[var(--header-height)] hidden h-[calc(100dvh-var(--header-height))] shrink-0 flex-col border-r border-border bg-panel transition-[width] duration-200 lg:flex ${
          collapsed ? 'w-[68px]' : 'w-60'
        }`}
      >
        <nav className="flex-1 overflow-y-auto custom-scrollbar px-3 py-4">
          {GROUPS.map((group) => (
            <div key={group.labelBn} className="mb-5 last:mb-0">
              {collapsed ? (
                <div
                  className="mx-auto mb-2 h-px w-6 bg-border-strong"
                  role="separator"
                  aria-label={group.labelBn}
                />
              ) : (
                <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.labelBn}
                </p>
              )}
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const active =
                    view === item.id ||
                    // chart is part of the dashboard workspace on desktop
                    (view === 'chart' && item.id === 'dashboard');
                  const Icon = item.icon;
                  const button = (
                    <button
                      type="button"
                      onClick={() => onViewChange(item.id)}
                      aria-current={active ? 'page' : undefined}
                      data-testid={`sidebar-${item.id}`}
                      data-view={item.id}
                      className={`group relative flex min-h-[40px] w-full items-center gap-3 rounded-lg px-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                        collapsed ? 'justify-center' : ''
                      } ${
                        active
                          ? 'bg-brand/10 text-brand'
                          : 'text-content hover:bg-accent hover:text-foreground'
                      }`}
                    >
                      {active && (
                        <span
                          className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-brand"
                          aria-hidden
                        />
                      )}
                      <Icon
                        className={`h-[18px] w-[18px] shrink-0 ${
                          active ? 'text-brand' : 'text-muted-foreground group-hover:text-content'
                        }`}
                        aria-hidden
                      />
                      {!collapsed && <span className="truncate">{item.labelBn}</span>}
                    </button>
                  );
                  return (
                    <li key={item.id}>
                      {collapsed ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{button}</TooltipTrigger>
                          <TooltipContent side="right" className="font-medium">
                            {item.labelBn}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        button
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Sidebar footer: honest posture + collapse control */}
        <div className="border-t border-border px-3 py-3">
          {!collapsed && (
            <div
              className={`mb-2 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium ${
                locked
                  ? 'border-down/40 bg-down/10 text-down'
                  : 'border-up/40 bg-up/10 text-up'
              }`}
              data-execution-locked={locked ? 'true' : 'false'}
              title={health?.executionReason ?? undefined}
            >
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                {locked ? 'অর্ডার লকড (রিড-ওনলি)' : 'ডেমো এক্সিকিউশন সচল'}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'সাইডবার বড় করুন' : 'সাইডবার ছোট করুন'}
            data-testid="sidebar-collapse"
            className={`flex min-h-[36px] w-full items-center gap-2 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" aria-hidden />
            ) : (
              <>
                <ChevronsLeft className="h-4 w-4" aria-hidden />
                <span>সাইডবার ছোট করুন</span>
              </>
            )}
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
