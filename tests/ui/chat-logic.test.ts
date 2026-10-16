/**
 * UI-02 FOCUSED TESTS — chat submission & error recovery logic.
 * Covers: send-gating (empty/whitespace/duplicate-in-flight), input clamping,
 * history window construction, retry extraction (only after a FAILED
 * exchange) and honest failure messages (code surfaced, never success faked).
 */
import { describe, expect, test } from 'bun:test';
import {
  canSendChat,
  clampChatInput,
  buildChatHistory,
  retryTextFor,
  shouldShowRetry,
  chatApiErrorMessage,
  chatNetworkErrorMessage,
  CHAT_INPUT_MAX_CHARS,
} from '@/lib/dashboard/chat-logic';
import type { ChatMessage } from '@/lib/dashboard/types';

describe('send gating', () => {
  test('empty and whitespace-only input can never be sent', () => {
    expect(canSendChat('', false)).toBe(false);
    expect(canSendChat('   \n\t ', false)).toBe(false);
  });

  test('duplicate submissions are blocked while a request is running', () => {
    expect(canSendChat('এখন বাজার কেমন?', true)).toBe(false);
  });

  test('valid input sends', () => {
    expect(canSendChat('এখন বাজার কেমন?', false)).toBe(true);
  });
});

describe('input clamping', () => {
  test('input is capped at the server-side maximum', () => {
    const long = 'x'.repeat(CHAT_INPUT_MAX_CHARS + 500);
    expect(clampChatInput(long).length).toBe(CHAT_INPUT_MAX_CHARS);
    expect(clampChatInput('ছোট').length).toBeLessThanOrEqual(CHAT_INPUT_MAX_CHARS);
  });
});

describe('history window', () => {
  test('builds the last N turns with roles preserved and blanks filtered', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'প্রশ্ন ১' },
      { role: 'assistant', content: 'উত্তর ১', meta: null },
      { role: 'user', content: '   ' }, // blank — filtered
      { role: 'user', content: 'প্রশ্ন ২' },
      { role: 'assistant', content: 'উত্তর ২', meta: null },
    ];
    const history = buildChatHistory(messages, 10);
    expect(history).toEqual([
      { role: 'user', content: 'প্রশ্ন ১' },
      { role: 'assistant', content: 'উত্তর ১' },
      { role: 'user', content: 'প্রশ্ন ২' },
      { role: 'assistant', content: 'উত্তর ২' },
    ]);
  });

  test('window keeps only the last maxTurns entries', () => {
    const messages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i}`,
    }));
    expect(buildChatHistory(messages, 10)).toHaveLength(10);
    expect(buildChatHistory(messages, 10)[0].content).toBe('m10');
  });
});

describe('error recovery (retry)', () => {
  test('retry text is the last user message when the exchange failed', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'সফল প্রশ্ন' },
      { role: 'assistant', content: 'সফল উত্তর', meta: null },
      { role: 'user', content: 'ব্যর্থ প্রশ্ন' },
      { role: 'assistant', content: 'দুঃখিত — উত্তর আনা যায়নি', meta: null, isError: true },
    ];
    expect(retryTextFor(messages)).toBe('ব্যর্থ প্রশ্ন');
    expect(shouldShowRetry(messages)).toBe(true);
  });

  test('no retry after a successful exchange', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'প্রশ্ন' },
      { role: 'assistant', content: 'উত্তর', meta: null },
    ];
    expect(retryTextFor(messages)).toBeNull();
    expect(shouldShowRetry(messages)).toBe(false);
  });

  test('no retry affordance while empty or mid-turn', () => {
    expect(shouldShowRetry([])).toBe(false);
    expect(shouldShowRetry([{ role: 'user', content: 'প্রশ্ন' }])).toBe(false);
  });
});

describe('honest failure messages', () => {
  test('API error surfaces code + detail', () => {
    const msg = chatApiErrorMessage({ ok: false, reply: '', toolCalls: [], evidence: [], dataState: {} as never, limitations: [], model: 'x', totalDurationMs: 0, error: { code: 'RATE_LIMITED', detail: 'retry in 5s' } });
    expect(msg).toContain('RATE_LIMITED');
    expect(msg).toContain('retry in 5s');
    expect(msg).toContain('আবার চেষ্টা করুন');
  });

  test('API error without a parsed body stays honest', () => {
    expect(chatApiErrorMessage(null)).toContain('অজানা ত্রুটি');
  });

  test('network error surfaces the exception message', () => {
    expect(chatNetworkErrorMessage(new Error('socket hang up'))).toContain('socket hang up');
    expect(chatNetworkErrorMessage('boom')).toContain('unknown');
  });
});
