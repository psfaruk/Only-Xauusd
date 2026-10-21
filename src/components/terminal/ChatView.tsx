'use client';

/**
 * XAUUSD AI Trading Agent — Bengali AI Chat view (UI-02).
 * ----------------------------------------------------------------------------
 * Upgraded chat surface on the EXISTING /api/chat agent (allowlisted
 * read-only tools, GLM backend, deterministic dataState — unchanged):
 *   · Enter sends, Shift+Enter inserts a newline
 *   · duplicate submissions impossible while a request is running
 *   · progress, completion and recoverable errors are distinct states
 *   · retry affordance resends the last failed user message
 *   · the deterministic data-state block stays attached to every reply
 * No fabricated AI responses — an error is rendered as an error.
 */

import { useEffect, useRef } from 'react';
import { Bot, Languages, Loader2, RotateCcw, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { canSendChat, shouldShowRetry } from '@/lib/dashboard/chat-logic';
import { fmtDhaka, signalOutcomeBadgeClass } from '@/lib/dashboard/i18n';
import type { ChatMessage } from '@/lib/dashboard/types';
import { PriceLevelText } from './bits';
import type { PriceDisplaySpec } from '@/lib/market/price-display';

const SUGGESTED_QUESTIONS = [
  'এখন XAUUSDm-এর বাজারের অবস্থা কী?',
  'M15 ও H1 ট্রেন্ড কী?',
  'সর্বশেষ সিগন্যাল কেন NO_SETUP?',
  'H4 ইতিহাস কত দিনের?',
  'সর্বশেষ backtest কী বলছে?',
];

export function ChatView({
  messages,
  input,
  sending,
  onInputChange,
  onSubmit,
  onRetry,
  onSuggestion,
  priceSpec,
  variant = 'page',
}: {
  messages: ChatMessage[];
  input: string;
  sending: boolean;
  onInputChange: (v: string) => void;
  onSubmit: () => void;
  onRetry: () => void;
  onSuggestion: (q: string) => void;
  priceSpec: PriceDisplaySpec;
  variant?: 'page' | 'sheet';
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const canSend = canSendChat(input, sending);
  const showRetry = shouldShowRetry(messages);

  return (
    <section
      aria-label="বাংলা এআই চ্যাট"
      className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-panel"
      data-testid="chat-view"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Languages className="h-4 w-4 text-sun" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">বাংলা এআই চ্যাট</h2>
        <Badge variant="outline" className="ml-auto border-border bg-muted px-2 text-[10px] font-medium text-content">
          read-only টুল · ট্রেড চালাতে পারে না
        </Badge>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className={`custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4 ${variant === 'page' ? 'max-h-[52vh]' : ''}`}
        aria-live="polite"
        data-testid="chat-messages"
      >
        {messages.length === 0 && (
          <div className="space-y-4 py-6 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface">
              <Bot className="h-6 w-6 text-brand" aria-hidden />
            </div>
            <p className="text-sm text-muted-foreground">প্রশ্ন করুন — যেমন:</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => onSuggestion(q)}
                  className="min-h-[40px] rounded-full border border-border bg-muted px-3.5 py-2 text-xs text-content transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-xl border px-3.5 py-2.5 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'rounded-tr-sm border-brand/30 bg-brand/10 text-foreground'
                  : m.isError
                    ? 'rounded-tl-sm border-down/40 bg-down/10 text-down'
                    : 'rounded-tl-sm border-border bg-surface text-foreground'
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{m.content}</p>

              {/* Deterministic data state — always separate from LLM text */}
              {m.role === 'assistant' && m.meta && !m.isError && (
                <div className="mt-2.5 space-y-1.5 border-t border-border pt-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    নির্ধারিত ডেটা অবস্থা (LLM টেক্সট থেকে আলাদা, সর্বোচ্চ কর্তৃত্ব)
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {m.meta.dataState.quoteFreshness && (
                      <Badge
                        variant="outline"
                        className={
                          m.meta.dataState.quoteFreshness === 'LIVE'
                            ? 'border-up/40 bg-up/10 text-up'
                            : 'border-sun/40 bg-sun/10 text-sun'
                        }
                      >
                        কোট: {m.meta.dataState.quoteFreshness}
                      </Badge>
                    )}
                    {m.meta.dataState.quoteSourceClass && (
                      <Badge variant="outline" className="border-border bg-muted text-content">
                        উৎস: {m.meta.dataState.quoteSourceClass}
                      </Badge>
                    )}
                    {m.meta.dataState.bid && (
                      <Badge variant="outline" className="border-border bg-muted font-mono text-content">
                        <PriceLevelText value={m.meta.dataState.bid} spec={priceSpec} /> /{' '}
                        <PriceLevelText value={m.meta.dataState.ask} spec={priceSpec} />
                      </Badge>
                    )}
                    {m.meta.dataState.latestSignalOutcome && (
                      <Badge variant="outline" className={signalOutcomeBadgeClass(m.meta.dataState.latestSignalOutcome)}>
                        সিগন্যাল: {m.meta.dataState.latestSignalOutcome}
                        {m.meta.dataState.latestSignalReasonCodes.length > 0
                          ? ` (${m.meta.dataState.latestSignalReasonCodes.join(', ')})`
                          : ''}
                      </Badge>
                    )}
                    {m.meta.toolCalls.length > 0 && (
                      <Badge variant="outline" className="border-border bg-muted text-muted-foreground">
                        টুল: {m.meta.toolCalls.map((t) => `${t.name}${t.ok ? '✓' : '✗'}`).join(' · ')}
                      </Badge>
                    )}
                    {m.meta.dataState.quoteTimeUtc && (
                      <span className="text-[10px] text-muted-foreground">কোট-সময়: {fmtDhaka(m.meta.dataState.quoteTimeUtc)}</span>
                    )}
                    {m.meta.model && (
                      <span className="text-[10px] text-muted-foreground">
                        মডেল: {m.meta.model} · উত্তর: {(m.meta.totalDurationMs / 1000).toFixed(1)} সেকেন্ড
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2.5 rounded-xl rounded-tl-sm border border-border bg-surface px-3.5 py-3 text-sm text-content">
              <span className="flex items-center gap-1" aria-hidden>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand/70" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand/70 [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand/70 [animation-delay:300ms]" />
              </span>
              টুল থেকে যাচাইকৃত ডেটা আনা হচ্ছে…
            </div>
          </div>
        )}
      </div>

      {/* Retry row (only after a failed exchange) */}
      {showRetry && !sending && (
        <div className="border-t border-border px-3 py-2.5">
          <Button
            size="sm"
            variant="outline"
            onClick={onRetry}
            className="h-10 w-full gap-1.5 border-border-strong bg-surface text-foreground hover:bg-accent hover:text-foreground"
            data-testid="chat-retry"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> শেষ বার্তাটি আবার পাঠান
          </Button>
        </div>
      )}

      {/* Input */}
      <form
        className="border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) onSubmit();
        }}
      >
        <div className="flex items-end gap-2">
          <label htmlFor="chat-input" className="sr-only">
            আপনার প্রশ্ন লিখুন (Enter পাঠাতে, Shift+Enter নতুন লাইন)
          </label>
          <textarea
            id="chat-input"
            rows={1}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              // Master-audit fix (IME): Bengali IME users press Enter to
              // COMMIT a composition — that must not send the message.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSend) onSubmit();
              }
              // Shift+Enter → default newline behaviour
            }}
            placeholder="যেমন: এখন XAUUSDm-এর বাজারের অবস্থা কী?"
            maxLength={2000}
            data-testid="chat-input"
            className="custom-scrollbar max-h-24 min-h-[44px] flex-1 resize-y rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            type="submit"
            size="sm"
            disabled={!canSend}
            data-testid="chat-send"
            aria-label="বার্তা পাঠান"
            className="h-[44px] gap-1.5 px-4"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            <span className="hidden sm:inline">পাঠান</span>
          </Button>
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
          Enter = পাঠান · Shift+Enter = নতুন লাইন · এজেন্ট কখনো দাম বানিয়ে বলবে না — প্রতিটি উত্তরে টুল-প্রমাণ ও টাইমস্ট্যাম্প থাকে।
        </p>
      </form>
    </section>
  );
}
