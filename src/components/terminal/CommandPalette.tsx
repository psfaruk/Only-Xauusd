'use client';

/**
 * XAUUSD AI Trading Agent — Command palette (Task 39, UI-03).
 * ----------------------------------------------------------------------------
 * The terminal's global search bar + tool box (Ctrl/Cmd+K):
 *
 *   নেভিগেশন → switch the active client view (same state switch as the
 *              sidebar / bottom-nav — no routing change)
 *   ক্রিয়াকলাপ → fire EXISTING handlers only (sync / analysis / signal /
 *              scalper / GLM verify / multi-agent review / theme toggle /
 *              open the AI chat sheet)
 *
 * No new API surface is introduced — every action is a callback the page
 * already owns. cmdk provides keyboard navigation + filtering.
 */

import { useEffect } from 'react';
import { useTheme } from 'next-themes';
import {
  Activity,
  BarChart3,
  Database,
  Home,
  MessageCircle,
  Moon,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Target,
  Wand2,
  Zap,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import type { TerminalView } from '@/lib/dashboard/nav';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: TerminalView) => void;
  onOpenChat: () => void;
  onRunSync: () => void;
  onRunAnalysis: () => void;
  onRunSignal: () => void;
  onRunScalper: () => void;
  onRunVerify: () => void;
  onRunAiReview: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onOpenChat,
  onRunSync,
  onRunAnalysis,
  onRunSignal,
  onRunScalper,
  onRunVerify,
  onRunAiReview,
}: CommandPaletteProps) {
  const { resolvedTheme, setTheme } = useTheme();

  // Global Ctrl/Cmd+K launcher.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
        data-testid="command-palette"
      >
        <DialogTitle className="sr-only">কমান্ড প্যালেট — সার্চ ও টুলস</DialogTitle>
        <DialogDescription className="sr-only">
          ভিউ পরিবর্তন করুন অথবা সিস্টেমের বিদ্যমান ক্রিয়াকলাপ চালান। কোনো নতুন ট্রেডিং ক্ষমতা যোগ হয় না।
        </DialogDescription>
        <Command>
          <CommandInput
            placeholder="সার্চ করুন… (ভিউ, সিঙ্ক, বিশ্লেষণ, সিগন্যাল)"
            data-testid="command-input"
          />
          <CommandList className="max-h-[320px] custom-scrollbar">
            <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
              কিছু পাওয়া যায়নি।
            </CommandEmpty>

            <CommandGroup heading="নেভিগেশন">
              <CommandItem onSelect={() => run(() => onNavigate('dashboard'))} data-testid="cmd-nav-dashboard">
                <Home className="h-4 w-4" aria-hidden />
                ড্যাশবোর্ড
              </CommandItem>
              <CommandItem onSelect={() => run(() => onNavigate('history'))}>
                <Activity className="h-4 w-4" aria-hidden />
                সিগন্যাল ইতিহাস
              </CommandItem>
              <CommandItem onSelect={() => run(() => onNavigate('analysis'))}>
                <BarChart3 className="h-4 w-4" aria-hidden />
                বিশ্লেষণ
              </CommandItem>
              <CommandItem onSelect={() => run(() => onNavigate('system'))}>
                <ShieldCheck className="h-4 w-4" aria-hidden />
                সিস্টেম
              </CommandItem>
              <CommandItem onSelect={() => run(() => onNavigate('settings'))}>
                <SettingsIcon className="h-4 w-4" aria-hidden />
                সেটিংস (ব্রোকার সংযোগ)
              </CommandItem>
              <CommandItem onSelect={() => run(onOpenChat)}>
                <MessageCircle className="h-4 w-4" aria-hidden />
                এআই চ্যাট খুলুন
              </CommandItem>
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading="ক্রিয়াকলাপ (বিদ্যমান পাইপলাইন)">
              <CommandItem onSelect={() => run(onRunSync)} data-testid="cmd-run-sync">
                <Database className="h-4 w-4" aria-hidden />
                ডেটা সিঙ্ক চালান
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">/api/data/sync</span>
              </CommandItem>
              <CommandItem onSelect={() => run(onRunAnalysis)}>
                <BarChart3 className="h-4 w-4" aria-hidden />
                বিশ্লেষণ চালান
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">/api/analysis/run</span>
              </CommandItem>
              <CommandItem onSelect={() => run(onRunSignal)}>
                <Target className="h-4 w-4" aria-hidden />
                সিগন্যাল মূল্যায়ন
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">/api/signal/run</span>
              </CommandItem>
              <CommandItem onSelect={() => run(onRunScalper)}>
                <Zap className="h-4 w-4" aria-hidden />
                স্ক্যাল্পার মূল্যায়ন
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">/api/signal/scalper</span>
              </CommandItem>
              <CommandItem onSelect={() => run(onRunVerify)}>
                <Wand2 className="h-4 w-4" aria-hidden />
                GLM যাচাই
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">/api/ai/verify</span>
              </CommandItem>
              <CommandItem onSelect={() => run(onRunAiReview)}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                মাল্টি-এজেন্ট রিভিউ
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">/api/ai/review</span>
              </CommandItem>
              <CommandItem
                onSelect={() =>
                  run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))
                }
                data-testid="cmd-theme"
              >
                {resolvedTheme === 'dark' ? (
                  <Sun className="h-4 w-4" aria-hidden />
                ) : (
                  <Moon className="h-4 w-4" aria-hidden />
                )}
                থিম পাল্টান ({resolvedTheme === 'dark' ? 'লাইট' : 'ডার্ক'})
              </CommandItem>
            </CommandGroup>
          </CommandList>
          <div className="flex items-center gap-3 border-t border-border bg-muted/50 px-3 py-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Search className="h-3 w-3" aria-hidden /> Ctrl/⌘K দিয়ে খুলুন
            </span>
            <span>↑↓ নেভিগেট</span>
            <span>⏎ চালান</span>
            <span>Esc বন্ধ</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
