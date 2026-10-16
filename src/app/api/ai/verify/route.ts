/**
 * POST /api/ai/verify — LIVE GLM access verification (Phase 1 deliverable).
 * ----------------------------------------------------------------------------
 * Runs three real round-trips against the sandbox-managed GLM model:
 *   1. Basic chat completion (token check)
 *   2. Bengali response (Chat Agent feasibility)
 *   3. Full tool-calling loop: model → allowlist check → tool executes →
 *      result fed back → final answer
 * Results are persisted to the SystemEvent audit trail.
 *
 * GUARDED (2026-10-16, master audit fix A1): POST runs through
 * guardDataApi(request, 'trigger') — the same contract as sync/analysis/
 * signal. DATA_API_TOKEN always required when set; unset → 503 fail-closed
 * unless the explicit MARKET_API_PUBLIC_TRIGGERS preview opt-in. The tight
 * trigger rate-limit bucket (12/min/IP) applies on top of the in-process
 * interval below. GET returns usage docs only (unguarded by convention).
 */
import { NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';
import { guardDataApi } from '@/lib/api-guard';
import { config } from '@/lib/config';
import { logEvent } from '@/lib/logger';
import { executeTool, toolSpecs } from '@/lib/tools/registry';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ToolCallShape {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface MessageShape {
  role: 'assistant' | 'user' | 'tool';
  content?: string | null;
  tool_calls?: ToolCallShape[];
  tool_call_id?: string;
}

interface TestResult {
  id: string;
  name: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
  sample?: string;
}

// In-memory rate limit (per server instance).
let lastRunAt = 0;

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

async function runVerification() {
  const started = Date.now();
  const tests: TestResult[] = [];
  let model = config.glm.model;

  // ---- Test 1: basic chat completion -------------------------------------
  try {
    const t0 = Date.now();
    const res = await withTimeout(
      completion([
        { role: 'assistant', content: 'You are a verification endpoint. Follow the instruction exactly.' },
        { role: 'user', content: 'Reply with exactly this token and nothing else: GLM_VERIFY_OK' },
      ]),
      config.glm.timeoutMs,
      'chat completion',
    );
    model = res.model ?? model;
    const content = res.choices?.[0]?.message?.content ?? '';
    const ok = content.includes('GLM_VERIFY_OK');
    tests.push({
      id: 'chat',
      name: 'Chat completion (English)',
      ok,
      latencyMs: Date.now() - t0,
      detail: ok ? 'Model returned the expected token.' : `Unexpected content: ${content.slice(0, 80)}`,
      sample: content.slice(0, 120),
    });
  } catch (e) {
    tests.push({
      id: 'chat',
      name: 'Chat completion (English)',
      ok: false,
      latencyMs: -1,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // ---- Test 2: Bengali response ------------------------------------------
  try {
    const t0 = Date.now();
    const res = await withTimeout(
      completion([
        {
          role: 'assistant',
          content: 'তুমি একজন ট্রেডিং সিস্টেম সহকারী। সংক্ষেপে বাংলায় উত্তর দাও।',
        },
        { role: 'user', content: 'একটি বাক্যে বাংলায় উত্তর দাও: সিস্টেম কি সচল?' },
      ]),
      config.glm.timeoutMs,
      'bengali completion',
    );
    const content = res.choices?.[0]?.message?.content ?? '';
    const ok = /[\u0980-\u09FF]/.test(content);
    tests.push({
      id: 'bengali',
      name: 'Bengali response (Chat Agent feasibility)',
      ok,
      latencyMs: Date.now() - t0,
      detail: ok
        ? 'Model produced Bengali script — the Phase 9 Bengali Chat Agent is feasible.'
        : 'Model did not return Bengali script.',
      sample: content.slice(0, 120),
    });
  } catch (e) {
    tests.push({
      id: 'bengali',
      name: 'Bengali response (Chat Agent feasibility)',
      ok: false,
      latencyMs: -1,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // ---- Test 3: full tool-calling loop --------------------------------------
  try {
    const t0 = Date.now();
    const specs = toolSpecs(false); // active tools only
    const first = await withTimeout(
      completion(
        [
          {
            role: 'assistant',
            content:
              'You are the GLM Orchestrator of the XAUUSD AI Trading Agent. Use ONLY allowlisted tools. Never invent data.',
          },
          {
            role: 'user',
            content:
              'Check the system health by calling the get_system_health tool. Then answer in ONE short sentence.',
          },
        ],
        specs,
      ),
      config.glm.timeoutMs,
      'tool-call step 1',
    );
    const msg = first.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];

    if (calls.length === 0) {
      tests.push({
        id: 'tool_call',
        name: 'Tool-calling loop (allowlist + execution)',
        ok: false,
        latencyMs: Date.now() - t0,
        detail: 'Model answered directly without calling the tool.',
        sample: (msg?.content ?? '').slice(0, 120),
      });
    } else {
      const call = calls[0];
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      // Allowlist + schema validation + execution — through the ONLY gate.
      const executed = await executeTool(call.function.name, args);
      if (!executed.ok) {
        tests.push({
          id: 'tool_call',
          name: 'Tool-calling loop (allowlist + execution)',
          ok: false,
          latencyMs: Date.now() - t0,
          detail: `Tool refused by registry: ${executed.error}`,
        });
      } else {
        const second = await withTimeout(
          completion([
            {
              role: 'assistant',
              content:
                'You are the GLM Orchestrator of the XAUUSD AI Trading Agent. Use ONLY allowlisted tools. Never invent data.',
            },
            {
              role: 'user',
              content:
                'Check the system health by calling the get_system_health tool. Then answer in ONE short sentence.',
            },
            { role: 'assistant', content: msg?.content ?? '', tool_calls: calls },
            { role: 'tool', tool_call_id: call.id, content: JSON.stringify(executed.result) },
          ]),
          config.glm.timeoutMs,
          'tool-call step 2',
        );
        const final = second.choices?.[0]?.message?.content ?? '';
        tests.push({
          id: 'tool_call',
          name: 'Tool-calling loop (allowlist + execution)',
          ok: true,
          latencyMs: Date.now() - t0,
          detail: `Model called ${call.function.name} → registry validated & executed it → result returned → final answer produced.`,
          sample: final.slice(0, 160),
        });
      }
    }
  } catch (e) {
    tests.push({
      id: 'tool_call',
      name: 'Tool-calling loop (allowlist + execution)',
      ok: false,
      latencyMs: -1,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const verified = tests.every((t) => t.ok);
  const totalLatencyMs = Date.now() - started;
  return { verified, model, totalLatencyMs, tests, checkedAt: new Date().toISOString() };
}

export async function POST(request: Request) {
  // Guard FIRST — before any GLM quota is consumed or SystemEvent written.
  const guard = guardDataApi(request, 'trigger');
  if (!guard.ok) return guard.response;

  try {
    const now = Date.now();
    let force = false;
    try {
      const body = (await request.json()) as { force?: boolean } | null;
      force = Boolean(body?.force);
    } catch {
      force = false;
    }

    // Rate limit: normal interval, or 2s even when forced.
    const minInterval = force ? 2000 : config.glm.minVerifyIntervalMs;
    if (now - lastRunAt < minInterval) {
      return NextResponse.json(
        {
          error: 'rate_limited',
          retryAfterMs: minInterval - (now - lastRunAt),
          message: `GLM verification interval is ${config.glm.minVerifyIntervalMs}ms (use force to override after 2s).`,
        },
        { status: 429 },
      );
    }
    lastRunAt = now;

    const result = await runVerification();

    await logEvent({
      level: result.verified ? 'info' : 'error',
      category: 'glm',
      code: result.verified ? 'GLM_VERIFY_OK' : 'GLM_VERIFY_FAIL',
      message: result.verified
        ? `GLM verification passed (model ${result.model}, ${result.totalLatencyMs}ms)`
        : `GLM verification FAILED (${result.tests.map((t) => `${t.id}:${t.ok}`).join(', ')})`,
      meta: { model: result.model, totalLatencyMs: result.totalLatencyMs, tests: result.tests },
    });

    return NextResponse.json(result, { status: result.verified ? 200 : 503 });
  } catch (err) {
    lastRunAt = 0;
    await logEvent({
      level: 'error',
      category: 'glm',
      code: 'GLM_VERIFY_ERROR',
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'verification error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json(
    {
      endpoint: '/api/ai/verify',
      method: 'POST',
      body: { force: 'boolean (optional) — bypass the standard interval after 2s' },
      description: 'Runs live GLM verification: chat completion, Bengali response and a full tool-calling loop.',
    },
    { status: 200 },
  );
}
