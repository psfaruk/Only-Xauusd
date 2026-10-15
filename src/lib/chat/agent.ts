/**
 * XAUUSD AI Trading Agent — Bengali Chat Agent (Phase 9, Task D)
 * ----------------------------------------------------------------------------
 * Server-side GLM orchestration with SAFE tool use:
 *
 *   · The model can ONLY call allowlisted read-only tools (registry).
 *   · Arguments are schema-validated; symbols are allowlist-checked inside
 *     every handler (defense in depth). There is NO shell, no raw SQL, no
 *     arbitrary URL, no filesystem, and NO execution tool.
 *   · The DETERMINISTIC engines own signal direction, levels and readiness.
 *     The LLM may only EXPLAIN verified results in Bengali. It can never
 *     override BLOCKED, alter SL/target math, or invent prices — the tool
 *     layer returns only verified data, and the UI renders the deterministic
 *     state separately from the model's text.
 *   · Bounded: message length, history turns, tool rounds, per-call timeout.
 *
 * The conversation itself is not persisted (client-supplied history); every
 * chat turn writes an audit-trail SystemEvent instead (no secrets inside).
 */

import ZAI from 'z-ai-web-dev-sdk';
import { config } from '@/lib/config';
import { executeTool, toolSpecs } from '@/lib/tools/registry';
import { logEvent } from '@/lib/logger';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatToolCallRecord {
  name: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface ChatEvidenceSource {
  tool: string;
  /** Deterministic facts the answer is based on (bounded excerpt). */
  facts: Record<string, unknown>;
}

export interface ChatAgentResult {
  reply: string;
  toolCalls: ChatToolCallRecord[];
  evidence: ChatEvidenceSource[];
  /** Deterministic data state at answer time — ALWAYS rendered separately
   *  from the model text so the user can see the authoritative facts. */
  dataState: {
    quoteFreshness: string | null;
    quoteSourceClass: string | null;
    bid: string | null;
    ask: string | null;
    quoteTimeUtc: string | null;
    latestSignalOutcome: string | null;
    latestSignalReasonCodes: string[];
  };
  limitations: string[];
  model: string;
  totalDurationMs: number;
}

interface ToolCallShape {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface MessageShape {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCallShape[];
  tool_call_id?: string;
}

const SYSTEM_PROMPT = `তুমি XAUUSD AI Trading Agent-এর বাংলা রিসার্চ সহকারী (Bengali research assistant)। এটি একটি READ-ONLY গবেষণা ও সিদ্ধান্ত-সহায়তা সিস্টেম — স্বয়ংক্রিয় ট্রেডিং বট নয়।

নিয়ম (অপরিবর্তনীয়):
1. বাংলায় উত্তর দাও (প্রয়োজনে ইংরেজি টেকনিক্যাল টার্ম রাখতে পারো)।
2. বাজার/দাম/সিগন্যাল/বিশ্লেষণ/backtest সংক্রান্ত প্রতিটি প্রশ্নের উত্তর দেওয়ার আগে অবশ্যই প্রাসঙ্গিক টুল কল করবে — এটি বাধ্যতামূলক। টুল ছাড়া কোনো সংখ্যা/দাম/স্ট্যাটাস লিখবে না। টুল ডেটা না থাকলে সততার সাথে বলবে "ডেটা পাওয়া যাচ্ছে না" — অনুমান করে দাম বলবে না।
3. কোনো দাম, ইন্ডিকেটর, সিগন্যাল বা ক্যান্ডেল বানিয়ে লিখবে না — সব সংখ্যা টুলের আউটপুট থেকে হুবহু নেবে।
4. সিগন্যাল BLOCKED হলে সেটাই বলবে — BLOCKED কখনো উপেক্ষা বা ওভাররাইড করবে না। WAIT/NO_SETUP মানে এখন কোনো সেটআপ নেই।
5. Entry zone, SL, target বা reward/risk এর হিসাব কখনো নিজে বদলাবে না বা নতুন লেভেল বানাবে না — শুধু টুল থেকে পাওয়া নির্ধারিত (deterministic) মান ব্যাখ্যা করবে।
6. এই সিস্টেম কোনো ট্রেড কার্যকর করে না — "ট্রেড হয়ে গেছে" বলবে না। সিগন্যাল হলো গবেষণা-সংক্রান্ত তথ্য।
7. Execution lock সর্বদা সক্রিয় — ব্যবহারকারী চাইলেও ট্রেডিং চালু করতে পারবে না, সেটা বলে দেবে।
8. টুলের ডেটার সাথে টাইমস্ট্যাম্প/ফ্রেশনেস (LIVE/STALE/DISCONNECTED) উল্লেখ করবে।
9. সংক্ষেপে, স্পষ্টভাবে উত্তর দাও; প্রয়োজন হলে ছোট bullet ব্যবহার করো।

টুল নির্দেশিকা:
- বাজারের বর্তমান অবস্থা/সংযোগ/ফ্রেশনেস → get_market_health
- সর্বশেষ দাম (bid/ask/spread) → get_latest_quote
- ক্যান্ডেল কভারেজ/H4 ইতিহাস → get_candle_coverage
- M15/H1/H4 ট্রেন্ড ও কাঠামো → get_latest_analysis
- সর্বশেষ সিগন্যাল/কারণ/লেভেল → get_latest_signal
- backtest ফলাফল/সীমাবদ্ধতা → get_backtest_summary
- সিগন্যাল কেন হলো/প্রমাণ → explain_signal_evidence`;

const CHAT_LIMITATIONS = [
  'LLM উত্তর শুধুমাত্র ব্যাখ্যা — সিগন্যাল/লেভেল/স্ট্যাটাস সবসময় deterministic engine থেকে আসে।',
  'টুল ডেটা STALE/DISCONNECTED হলে লাইভ ব্যাজ দেখানো হয় না।',
  'এই সিস্টেম read-only — কোনো অর্ডার/পজিশন ক্ষমতা নেই।',
];

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function completion(messages: MessageShape[], tools?: unknown[]) {
  const zai = await ZAI.create();
  return zai.chat.completions.create({
    messages: messages as never,
    thinking: { type: 'disabled' },
    ...(tools ? { tools: tools as never } : {}),
  } as never) as Promise<{
    model?: string;
    choices: Array<{ message: { content: string | null; tool_calls?: ToolCallShape[] } }>;
  }>;
}

export interface RunChatAgentInput {
  message: string;
  history?: ChatTurn[];
  /** Injectable for tests. */
  completionImpl?: typeof completion;
  maxToolRounds?: number;
}

export async function runChatAgent(input: RunChatAgentInput): Promise<ChatAgentResult> {
  const startedAt = Date.now();
  const maxRounds = input.maxToolRounds ?? config.chat.maxToolRounds;
  const doComplete = input.completionImpl ?? completion;

  const trimmedHistory = (input.history ?? [])
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim().length > 0)
    .slice(-config.chat.maxHistoryTurns)
    .map((t) => ({ role: t.role, content: t.content.slice(0, config.chat.maxMessageChars) }));

  const messages: MessageShape[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...trimmedHistory,
    { role: 'user', content: input.message.slice(0, config.chat.maxMessageChars) },
  ];

  const specs = toolSpecs(false);
  const toolCalls: ChatToolCallRecord[] = [];
  const evidence: ChatEvidenceSource[] = [];
  let model = config.glm.model;
  let reply = '';

  /** Execute a tool call through the ONLY allowlist gate and record it. */
  const runOneTool = async (call: ToolCallShape) => {
    const t0 = Date.now();
    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    const executed = await executeTool(call.function.name, args);
    const record: ChatToolCallRecord = {
      name: call.function.name,
      ok: executed.ok,
      durationMs: Date.now() - t0,
    };
    if (!executed.ok) record.error = executed.error;
    toolCalls.push(record);
    const toolResult = executed.ok
      ? JSON.stringify(executed.result).slice(0, 8_000)
      : JSON.stringify({ toolError: true, error: executed.error });
    messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
    if (executed.ok && executed.result) {
      evidence.push({ tool: call.function.name, facts: executed.result });
    }
  };

  for (let round = 0; round < maxRounds; round++) {
    const res = await withTimeout(
      doComplete(messages, specs),
      config.glm.timeoutMs,
      `chat completion (round ${round + 1})`,
    );
    model = res.model ?? model;
    const msg = res.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];

    if (calls.length === 0) {
      // ── ARCHITECTURAL GUARD: no tool was called ────────────────────────
      // A market answer without a tool call is UNVERIFIED — the model may
      // have invented numbers. We deterministically ground the conversation:
      // fetch the core market-health facts server-side (read-only, bounded),
      // then ask the model to answer STRICTLY from that data. The forced
      // grounding is recorded as a real tool call and shown in the UI.
      if (round === 0) {
        const groundingId = `grounding-${Date.now()}`;
        messages.push({
          role: 'assistant',
          content: msg?.content ?? '',
          tool_calls: [
            {
              id: groundingId,
              type: 'function',
              function: { name: 'get_market_health', arguments: '{}' },
            },
          ],
        });
        await runOneTool({
          id: groundingId,
          type: 'function',
          function: { name: 'get_market_health', arguments: '{}' },
        });
        messages.push({
          role: 'user',
          content:
            'উপরের টুল-ফলাফল থেকে হুবহু তথ্য নিয়ে উত্তর দাও। টুলে যা নেই তা লিখবে না — দাম/সংখ্যা বানাবে না। আরও তথ্য দরকার হলে অন্য টুল কল করতে পারো।',
        });
        continue; // re-ask with grounded context
      }
      reply = (msg?.content ?? '').trim();
      break;
    }

    // The model wants tools — execute each through the ONLY allowlist gate,
    // feed the results back, and continue the loop.
    messages.push({ role: 'assistant', content: msg?.content ?? '', tool_calls: calls });
    for (const call of calls) {
      await runOneTool(call);
    }
  }

  // If the loop exhausted rounds without a final answer, close honestly.
  if (!reply) {
    const closing = await withTimeout(doComplete(messages), config.glm.timeoutMs, 'chat closing completion').catch(
      () => null,
    );
    reply =
      (closing?.choices?.[0]?.message?.content ?? '').trim() ||
      'দুঃখিত — টুল রাউন্ড শেষ হয়ে গেছে এবং চূড়ান্ত উত্তর তৈরি করা যায়নি। আবার চেষ্টা করুন।';
  }

  // ── Deterministic data state (from the tools actually used) ────────────
  const marketHealth = evidence.find((e) => e.tool === 'get_market_health')?.facts as
    | { freshness?: string; sourceClass?: string; bid?: string; ask?: string; quoteTimeUtc?: string }
    | undefined;
  const latestQuote = evidence.find((e) => e.tool === 'get_latest_quote')?.facts as
    | { freshness?: string; sourceClass?: string; bid?: string; ask?: string; quoteTimeUtc?: string }
    | undefined;
  const latestSignal = evidence.find((e) => e.tool === 'get_latest_signal')?.facts as
    | { outcome?: string; reasonCodes?: string[] }
    | undefined;
  const quoteFacts = marketHealth ?? latestQuote;

  const result: ChatAgentResult = {
    reply,
    toolCalls,
    evidence: evidence.slice(0, 8),
    dataState: {
      quoteFreshness: quoteFacts?.freshness ?? null,
      quoteSourceClass: quoteFacts?.sourceClass ?? null,
      bid: quoteFacts?.bid ?? null,
      ask: quoteFacts?.ask ?? null,
      quoteTimeUtc: quoteFacts?.quoteTimeUtc ?? null,
      latestSignalOutcome: latestSignal?.outcome ?? null,
      latestSignalReasonCodes: latestSignal?.reasonCodes ?? [],
    },
    limitations: CHAT_LIMITATIONS,
    model,
    totalDurationMs: Date.now() - startedAt,
  };

  await logEvent({
    level: 'info',
    category: 'glm',
    code: 'CHAT_AGENT_TURN',
    message: `Chat turn: ${toolCalls.length} tool call(s) [${toolCalls.map((t) => `${t.name}:${t.ok ? 'ok' : 'err'}`).join(', ') || 'none'}] in ${result.totalDurationMs}ms`,
    meta: {
      tools: toolCalls.map((t) => ({ name: t.name, ok: t.ok })),
      model,
      durationMs: result.totalDurationMs,
      messageChars: input.message.length,
    },
  }).catch(() => undefined);

  return result;
}
