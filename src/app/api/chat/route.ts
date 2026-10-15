/**
 * POST /api/chat — Bengali Chat Agent (Phase 9, Task D/F).
 * ----------------------------------------------------------------------------
 * Query-style endpoint: it READS data through allowlisted tools and produces
 * a Bengali explanation. It mutates NO domain state (only an audit-trail
 * SystemEvent), but because it consumes LLM quota it is guarded MORE tightly
 * than plain reads:
 *
 *   · DATA_API_TOKEN set  → bearer token REQUIRED (401 without/invalid).
 *   · token unset         → allowed ONLY under the explicit preview opt-in
 *     (MARKET_API_PUBLIC_READS=true), same fail-closed convention as every
 *     GET; otherwise 503. Production deployments always set the token.
 *   · Stricter per-IP rate limit (config.chat.rateLimitPerMin, default 12/min).
 *   · Message + history size caps, bounded tool rounds (server-side).
 *
 * The deterministic state (dataState block) is computed from tool facts and
 * returned SEPARATELY from the model text — the LLM can never override it.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardDataApi, jsonError, rateLimit, clientIpFromHeaders } from '@/lib/api-guard';
import { config } from '@/lib/config';
import { runChatAgent } from '@/lib/chat/agent';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const chatTurnSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(4_000),
  })
  .strict();

const chatBodySchema = z
  .object({
    message: z.string().trim().min(1).max(4_000),
    history: z.array(chatTurnSchema).max(20).optional(),
  })
  .strict();

export async function POST(request: Request) {
  // Standard guard first (token posture + standard rate limit)…
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  // …then the STRICTER chat-specific limit.
  const chatLimit = rateLimit(`chat:${clientIpFromHeaders(request.headers)}`, config.chat.rateLimitPerMin);
  if (!chatLimit.ok) {
    return jsonError(429, 'RATE_LIMITED', `Chat rate limit — retry in ${chatLimit.retryAfterSec}s.`, {
      retryAfterSec: chatLimit.retryAfterSec,
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'BAD_REQUEST', 'Request body must be valid JSON.');
  }

  const parsed = chatBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      400,
      'BAD_REQUEST',
      `Invalid request body: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  // Server-side message caps (config-bounded, stricter than the schema).
  const message = parsed.data.message.slice(0, config.chat.maxMessageChars);
  if (message.length === 0) {
    return jsonError(400, 'BAD_REQUEST', 'Empty message.');
  }

  try {
    const result = await runChatAgent({ message, history: parsed.data.history });
    return NextResponse.json({
      ok: true,
      reply: result.reply,
      toolCalls: result.toolCalls,
      evidence: result.evidence,
      dataState: result.dataState,
      limitations: result.limitations,
      model: result.model,
      totalDurationMs: result.totalDurationMs,
      note: 'উত্তর শুধুমাত্র ব্যাখ্যা — deterministic সিগন্যাল/স্ট্যাটাস আলাদা ব্লকে (dataState) দেখানো হয়েছে।',
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: 'CHAT_AGENT_ERROR',
        detail: (err instanceof Error ? err.message : 'unknown error').slice(0, 200),
      },
      { status: 502 },
    );
  }
}

export async function GET() {
  return NextResponse.json(
    {
      endpoint: '/api/chat',
      method: 'POST',
      body: {
        message: 'string (required, 1–4000 chars)',
        history: 'array of { role: user|assistant, content } (optional, max 20 turns)',
      },
      description:
        'Bengali Chat Agent — allowlisted read-only tools only; the deterministic data state is returned separately from the model text. Read-guard posture + stricter chat rate limit.',
    },
    { status: 200 },
  );
}
