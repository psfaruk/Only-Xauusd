/**
 * XAUUSD AI Trading Agent — Chat submission logic (UI-02).
 * ----------------------------------------------------------------------------
 * Pure helpers extracted from the former inline chat handler so the
 * submission/error-recovery behaviour is unit-testable without a DOM:
 *   · input validation + clamping (server caps mirrored client-side)
 *   · history window construction (last N turns, roles preserved)
 *   · honest failure replies (Bengali, code + detail surfaced, retryable)
 * No fabricated AI responses exist here — an error is an error.
 */

import type { ChatMessage, ChatResponse } from './types';

export const CHAT_INPUT_MAX_CHARS = 2000;

/** Can the current input be sent? (empty or duplicate-in-flight blocked) */
export function canSendChat(input: string, sending: boolean): boolean {
  return !sending && input.trim().length > 0;
}

/** Clamp raw input to the server-side cap (defensive; server clamps too). */
export function clampChatInput(input: string): string {
  return input.length > CHAT_INPUT_MAX_CHARS ? input.slice(0, CHAT_INPUT_MAX_CHARS) : input;
}

/** Build the history window sent with the request (last `maxTurns` turns). */
export function buildChatHistory(messages: ChatMessage[], maxTurns = 10): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .filter((m) => m.content.trim().length > 0)
    .slice(-maxTurns)
    .map((m) => ({ role: m.role, content: m.content }));
}

/** The retryable user text for an error bubble: the closest preceding user message. */
export function retryTextFor(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && !m.isError) return null; // last exchange succeeded — nothing to retry
    if (m.role === 'user') return m.content;
  }
  return null;
}

/** Should the retry affordance be shown? Only when the LAST assistant reply failed. */
export function shouldShowRetry(messages: ChatMessage[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return last.role === 'assistant' && last.isError === true;
}

/** Honest failure bubble for API-level errors (body parsed, non-ok). */
export function chatApiErrorMessage(body: ChatResponse | null): string {
  const errText = body?.error
    ? `${body.error.code}${body.error.detail ? `: ${body.error.detail}` : ''}`
    : 'অজানা ত্রুটি';
  return `দুঃখিত — উত্তর আনা যায়নি (${errText})। কিছুক্ষণ পরে আবার চেষ্টা করুন।`;
}

/** Honest failure bubble for network/exception errors. */
export function chatNetworkErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : 'unknown';
  return `দুঃখিত — সংযোগ ত্রুটি (${detail})। ইন্টারনেট/সার্ভার ঠিক হলে আবার চেষ্টা করুন।`;
}
