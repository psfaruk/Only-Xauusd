/**
 * PHASE 9 CHAT AGENT TESTS — allowlisted tools + agent loop + honesty rules.
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: bridge data comes from the local mock server with synthetic
 * values; the GLM completions are INJECTED FAKES (no real model is called).
 *
 * Pinned behaviors (spec Task G):
 *   · tool layer returns verified data (market health / quote / coverage /
 *     analysis / signal / backtest / evidence) from allowlisted tools only
 *   · the model cannot invent a price when no quote is available (the TOOL
 *     returns available:false — never a number)
 *   · arbitrary tools, symbols, URLs and malformed arguments are rejected
 *   · secrets never appear in tool output
 *   · tool errors are surfaced honestly (never silently dropped)
 *   · no execution tool exists in the registry (and none can be added via args)
 *   · the agent loop executes model tool-calls through the allowlist gate and
 *     returns the final answer with the deterministic dataState block
 *   · when the model answers WITHOUT calling any tool, the architectural
 *     grounding guard fires (real tool executed server-side) — a market
 *     answer is never left ungrounded
 *   · BLOCKED cannot be overridden: the deterministic state is derived from
 *     tool facts, not from the model text
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import '../market/helpers/setup';
import { executeTool, toolSpecs, TOOL_REGISTRY } from '@/lib/tools/registry';
import { runChatAgent } from '@/lib/chat/agent';
import { startMockBridge, defaultMockState, makeBars } from '../market/helpers/mock-bridge';
import { createBridgeClient } from '@/lib/market/bridge-client';
import { db } from '@/lib/db';

let bridge: Awaited<ReturnType<typeof startMockBridge>>;

beforeAll(async () => {
  bridge = await startMockBridge({ ...defaultMockState() });
  process.env.MT5_BRIDGE_URL = bridge.url;
  process.env.MT5_BRIDGE_TOKEN = '';
});
afterAll(() => {
  bridge?.stop();
  process.env.MT5_BRIDGE_URL = '';
});

// ---------------------------------------------------------------------------
// Registry & allowlist security
// ---------------------------------------------------------------------------

describe('chat tools — allowlist security', () => {
  test('the registry contains exactly the 10 read-only active tools (no execution tool exists)', () => {
    const active = TOOL_REGISTRY.filter((t) => t.status === 'active').map((t) => t.name);
    expect(active.sort()).toEqual([
      'explain_signal_evidence',
      'get_ai_review',
      'get_backtest_summary',
      'get_candle_coverage',
      'get_latest_analysis',
      'get_latest_quote',
      'get_latest_signal',
      'get_market_health',
      'get_system_health',
      'run_risk_check',
    ]);
    // Nothing even named like an execution capability.
    expect(active.some((n) => /order|execute|position|deal|close|modify|submit/i.test(n))).toBe(false);
    // Phase 7 (Task 30-a): run_risk_check is ACTIVE — every registry entry is
    // currently active (no planned tools remain; the refusal machinery stays
    // in place for future phases).
    expect(TOOL_REGISTRY.every((t) => t.status === 'active')).toBe(true);
  });

  test('arbitrary tool names are rejected (not in allowlist)', async () => {
    expect((await executeTool('run_shell', {})).ok).toBe(false);
    expect((await executeTool('fetch_url', { url: 'https://evil.example' })).ok).toBe(false);
    expect((await executeTool('raw_sql', { q: 'SELECT * FROM x' })).ok).toBe(false);
    expect((await executeTool('place_order', { symbol: 'XAUUSDm' })).ok).toBe(false);
  });

  test('run_risk_check is ACTIVE (Phase 7): with no actionable setup it returns the honest skip note — never a fabricated verdict', async () => {
    // Hermetic: remove directional setups possibly seeded by other test files
    // in this shared process (bun file order is not alphabetical).
    await db.signalEvaluation.deleteMany({ where: { outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] } } });
    const riskChecksBefore = await db.riskCheck.count();
    const r = await executeTool('run_risk_check', {});
    expect(r.ok).toBe(true);
    expect(String(r.result?.note)).toBe('কোনো অ্যাকশনেবল সিগন্যাল নেই — রিস্ক চেক প্রযোজ্য নয়');
    // A skipped (not-applicable) check writes NO audit row — only real checks do.
    expect(await db.riskCheck.count()).toBe(riskChecksBefore);
  });

  test('malformed arguments are rejected (unknown arg / wrong type)', async () => {
    expect((await executeTool('get_latest_quote', { symbol: 'XAUUSDm', extra: 1 })).ok).toBe(false);
    expect((await executeTool('get_latest_quote', { symbol: 123 })).ok).toBe(false);
  });

  test('arbitrary (non-allowlisted) symbols are rejected inside every handler', async () => {
    for (const name of ['get_market_health', 'get_latest_quote', 'get_candle_coverage', 'get_latest_signal']) {
      const r = await executeTool(name, { symbol: 'EURUSDm' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not in allowlist');
    }
  });

  test('tool output never contains secrets', async () => {
    bridge.state.quote = { bid: 2650.1, ask: 2650.34, ts: Math.floor(Date.now() / 1000) };
    const results = await Promise.all([
      executeTool('get_system_health', {}),
      executeTool('get_market_health', {}),
      executeTool('get_latest_quote', {}),
      executeTool('get_candle_coverage', {}),
      executeTool('get_backtest_summary', {}),
    ]);
    const blob = JSON.stringify(results);
    expect(blob).not.toMatch(/(password|56529050|ghp_[A-Za-z0-9]{10,}|MT5_PASSWORD)/i);
  });
});

// ---------------------------------------------------------------------------
// Tool honesty
// ---------------------------------------------------------------------------

describe('chat tools — honest data', () => {
  test('get_latest_quote returns available:false with a reason when no verified quote exists (never an invented price)', async () => {
    bridge.state.quote = null;
    const r = await executeTool('get_latest_quote', { symbol: 'XAUUSDm' });
    expect(r.ok).toBe(true);
    expect(r.result?.available).toBe(false);
    expect(JSON.stringify(r.result)).not.toMatch(/"bid":\s*[0-9]/);
    expect(String(r.result?.reason)).toContain('আনুমানিক দাম');
  });

  test('get_market_health reports freshness/source/blockedReasons from the integrity monitor', async () => {
    bridge.state.source = 'mt5';
    bridge.state.connected = true;
    bridge.state.authenticated = true;
    bridge.state.quote = { bid: 2650.1, ask: 2650.34, ts: Math.floor(Date.now() / 1000) };
    bridge.state.quoteAgeMs = 0;
    const r = await executeTool('get_market_health', { symbol: 'XAUUSDm' });
    expect(r.ok).toBe(true);
    expect(r.result?.freshness).toBe('LIVE');
    expect(r.result?.sourceClass).toBe('broker');
    expect(r.result?.signalPermitted).toBe(true);
  });

  test('get_latest_signal reports honest absence when no evaluation exists', async () => {
    const r = await executeTool('get_latest_signal', { symbol: 'XAUUSDm' });
    expect(r.ok).toBe(true);
    // No evaluation persisted in the isolated test DB yet (or an honest one).
    if (r.result?.available === false) {
      expect(String(r.result?.reason)).toContain('signal evaluation');
    } else {
      expect(['BUY_SETUP', 'SELL_SETUP', 'WAIT', 'NO_SETUP', 'BLOCKED', 'FAILED']).toContain(String(r.result?.outcome));
    }
  });

  test('get_backtest_summary always carries the no-profitability disclaimer', async () => {
    const r = await executeTool('get_backtest_summary', { symbol: 'XAUUSDm' });
    expect(r.ok).toBe(true);
    expect(String(r.result?.disclaimer)).toContain('প্রমাণ নয়');
  });

  test('run_risk_check on a persisted BUY_SETUP → full 9-rule verdict, persisted as a RiskCheck audit row (equity honestly unavailable)', async () => {
    bridge.state.quote = { bid: 4150.1, ask: 4150.34, ts: Math.floor(Date.now() / 1000) };
    bridge.state.quoteAgeMs = 0;
    await db.signalEvaluation.deleteMany({ where: { outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] } } });
    await db.riskCheck.deleteMany();
    await db.signalEvaluation.create({
      data: {
        engineVersion: '9.0.0',
        strategyVersion: 'hybrid-structure-retest/9.0.0',
        symbol: 'XAUUSDm',
        outcome: 'BUY_SETUP',
        reasonCodes: JSON.stringify([]),
        inputFingerprint: 'risk-test',
        inputSnapshot: '{}',
        evidence: '{}',
        levels: JSON.stringify({
          direction: 'BUY',
          entryZoneLow: 4149,
          entryZoneHigh: 4151,
          entryReference: 4150,
          stopLoss: 4140,
          target: 4170,
          riskPrice: 10,
          rewardPrice: 20,
          rewardRiskRatio: 2,
        }),
        quote: '{}',
        executionLocked: true,
      },
    });
    const r = await executeTool('run_risk_check', {});
    expect(r.ok).toBe(true);
    expect(r.result?.passed).toBe(false); // fail-closed: bridge contract has no account endpoint
    expect(r.result?.checks).toHaveLength(9);
    const equity = (r.result?.checks as Array<{ rule: string; passed: boolean; detail: string }>).find(
      (c) => c.rule === 'EQUITY_AVAILABLE',
    );
    expect(equity?.passed).toBe(false);
    expect(equity?.detail).toContain('ইকুইটি তথ্য অনুপলব্ধ');
    expect(r.result?.lotSize).toBeNull();
    expect(r.result?.stopDistance).toBe(10);
    // persisted as an append-only audit row + SystemEvent trail
    expect(await db.riskCheck.count()).toBe(1);
    const audit = await db.systemEvent.findFirst({
      where: { category: 'risk', code: 'RISK_CHECK_FAILED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    // cleanup (hermeticity for the other files in this shared process)
    await db.signalEvaluation.deleteMany({ where: { outcome: { in: ['BUY_SETUP', 'SELL_SETUP'] } } });
    await db.riskCheck.deleteMany();
    await db.systemEvent.deleteMany({ where: { category: 'risk' } });
  });
});

// ---------------------------------------------------------------------------
// Agent loop (injected fake completions — no real GLM calls)
// ---------------------------------------------------------------------------

/** Fake completion factory: scripted responses in sequence. */
function fakeCompletion(script: Array<{ content?: string; tool_calls?: Array<{ id: string; name: string; args: string }> }>) {
  let i = 0;
  return (async (_messages: unknown[], _tools?: unknown[]) => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return {
      model: 'fake-glm',
      choices: [
        {
          message: {
            content: step?.content ?? '',
            tool_calls: step?.tool_calls?.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.args },
            })),
          },
        },
      ],
    };
  }) as unknown as typeof import('@/lib/chat/agent').runChatAgent extends never
    ? never
    : (messages: Array<Record<string, unknown>>, tools?: unknown[]) => Promise<{
        model?: string;
        choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> } }>;
      }>;
}

describe('chat agent — tool loop (injected fake model)', () => {
  test('a market question triggers the correct allowlisted tool and the loop feeds results back', async () => {
    bridge.state.source = 'mt5';
    bridge.state.connected = true;
    bridge.state.authenticated = true;
    bridge.state.quote = { bid: 2650.1, ask: 2650.34, ts: Math.floor(Date.now() / 1000) };
    bridge.state.quoteAgeMs = 0;

    const completion = fakeCompletion([
      { tool_calls: [{ id: 'c1', name: 'get_market_health', args: '{"symbol":"XAUUSDm"}' }] },
      { content: 'বাজার এখন LIVE — ব্রোকার ফিড সংযুক্ত।' },
    ]);
    const result = await runChatAgent({
      message: 'এখন XAUUSDm-এর বাজারের অবস্থা কী?',
      completionImpl: completion as never,
      maxToolRounds: 2,
    });
    expect(result.toolCalls.map((t) => t.name)).toEqual(['get_market_health']);
    expect(result.toolCalls[0].ok).toBe(true);
    expect(result.reply).toContain('LIVE');
    // The deterministic dataState derives from the TOOL facts.
    expect(result.dataState.quoteFreshness).toBe('LIVE');
    expect(result.dataState.quoteSourceClass).toBe('broker');
  });

  test('when the model answers WITHOUT any tool call, the grounding guard fires (real tool executed server-side)', async () => {
    bridge.state.quote = { bid: 2650.1, ask: 2650.34, ts: Math.floor(Date.now() / 1000) };
    bridge.state.quoteAgeMs = 0;
    const completion = fakeCompletion([
      { content: 'দাম প্রায় ২৬৫০ মনে হয়।' }, // round 0: no tool — hallucination risk
      { content: 'যাচাইকৃত তথ্য: বাজার LIVE।' }, // round 1: grounded answer
    ]);
    const result = await runChatAgent({
      message: 'বাজারের অবস্থা কী?',
      completionImpl: completion as never,
      maxToolRounds: 3,
    });
    // The guard executed a REAL allowlisted tool even though the model skipped it.
    expect(result.toolCalls.some((t) => t.name === 'get_market_health' && t.ok)).toBe(true);
    expect(result.dataState.quoteFreshness).toBe('LIVE');
  });

  test('BLOCKED signal state cannot be overridden by model text — dataState comes from tool facts only', async () => {
    // Seed a BLOCKED evaluation into the isolated test DB.
    await db.signalEvaluation.create({
      data: {
        engineVersion: '9.0.0',
        strategyVersion: 'hybrid-structure-retest/9.0.0',
        symbol: 'XAUUSDm',
        outcome: 'BLOCKED',
        reasonCodes: JSON.stringify(['QUOTE_STALE']),
        inputFingerprint: 'test',
        inputSnapshot: '{}',
        evidence: '{}',
        quote: '{}',
        executionLocked: true,
      },
    });
    const completion = fakeCompletion([
      { tool_calls: [{ id: 'c1', name: 'get_latest_signal', args: '{}' }] },
      { content: 'সিগন্যালটি BLOCKED — ডেটা পুরোনো।' },
    ]);
    const result = await runChatAgent({
      message: 'সর্বশেষ সিগন্যাল কেন BLOCKED?',
      completionImpl: completion as never,
      maxToolRounds: 2,
    });
    // The deterministic block reports the REAL outcome — the model cannot change it.
    expect(result.dataState.latestSignalOutcome).toBe('BLOCKED');
    expect(result.dataState.latestSignalReasonCodes).toEqual(['QUOTE_STALE']);
  });

  test('tool errors are surfaced honestly in the record (never silently dropped)', async () => {
    const completion = fakeCompletion([
      { tool_calls: [{ id: 'c1', name: 'get_latest_quote', args: '{"symbol":"EURUSDm"}' }] },
      { content: 'দুঃখিত, ওই সিম্বলের ডেটা নেই।' },
    ]);
    const result = await runChatAgent({
      message: 'EURUSDm দাম কত?',
      completionImpl: completion as never,
      maxToolRounds: 2,
    });
    expect(result.toolCalls[0].ok).toBe(false);
    expect(result.toolCalls[0].error).toContain('not in allowlist');
  });

  test('the system prompt itself forbids inventing prices and overriding BLOCKED', async () => {
    // Structural: the prompt is embedded in the agent module. Verify through
    // the first fake completion's received messages.
    let seenSystem = '';
    const completion = (async (messages: Array<Record<string, unknown>>) => {
      if (!seenSystem) {
        const sys = messages.find((m) => m.role === 'system');
        seenSystem = typeof sys?.content === 'string' ? sys.content : '';
      }
      return { model: 'fake', choices: [{ message: { content: 'ঠিক আছে।' } }] };
    }) as never;
    await runChatAgent({ message: 'হ্যালো', completionImpl: completion, maxToolRounds: 1 });
    expect(seenSystem).toContain('বানিয়ে লিখবে না');
    expect(seenSystem).toContain('BLOCKED');
    expect(seenSystem).toContain('কার্যকর করে না');
  });

  test('toolSpecs exposes ONLY active tools to the model context (planned excluded)', () => {
    const names = toolSpecs(false).map((t) => t.function.name);
    expect(names).toContain('run_risk_check'); // active since Phase 7 (Task 30-a)
    expect(names).toContain('get_ai_review'); // active since Phase 6 (Task 30)
    expect(names).toHaveLength(10);
  });
});
