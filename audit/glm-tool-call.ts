/**
 * Phase 1 Audit — GLM Tool-Calling Support Verification (real round-trip)
 * Flow: model requests allowlisted tool -> backend executes real function ->
 * result returned to model -> final answer. Run: bun audit/glm-tool-call.ts
 */
import ZAI from 'z-ai-web-dev-sdk';

const getSystemHealth = () => ({
  status: 'ok' as const,
  phase: 1,
  executionLocked: true,
  uptimeSeconds: Math.round(process.uptime()),
  db: 'connected' as const,
});

const ALLOWLIST = new Set(['get_system_health']);

async function main() {
  const zai = await ZAI.create();
  const started = Date.now();

  const first = await zai.chat.completions.create({
    messages: [
      {
        role: 'assistant',
        content:
          'You are the GLM Orchestrator of the XAUUSD AI Trading Agent (Phase 1 audit). You may ONLY use allowlisted tools. Never invent data.',
      },
      {
        role: 'user',
        content:
          'Check the system health by calling the get_system_health tool. Then answer in one short sentence.',
      },
    ],
    thinking: { type: 'disabled' },
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_system_health',
          description:
            'Returns live system health of the XAUUSD Trading Agent backend: status, phase, DB state, uptime and execution lock flag.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ],
  } as never);

  const msg = first.choices?.[0]?.message as {
    content: string | null;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  } | undefined;

  console.log('=== STEP 1: model response ===');
  console.log('content:', msg?.content);
  console.log('tool_calls:', JSON.stringify(msg?.tool_calls ?? null, null, 2));

  if (!msg?.tool_calls?.length) {
    console.log('RESULT: TOOL_CALLING_NOT_USED (model answered directly)');
    return;
  }

  const call = msg.tool_calls[0];
  if (!ALLOWLIST.has(call.function.name)) {
    console.log('RESULT: REJECTED_NON_ALLOWLISTED_TOOL ->', call.function.name);
    return;
  }
  console.log('=== STEP 2: executing allowlisted tool ===', call.function.name);
  const toolResult = getSystemHealth();

  const second = await zai.chat.completions.create({
    messages: [
      {
        role: 'assistant',
        content:
          'You are the GLM Orchestrator of the XAUUSD AI Trading Agent (Phase 1 audit). You may ONLY use allowlisted tools. Never invent data.',
      },
      {
        role: 'user',
        content:
          'Check the system health by calling the get_system_health tool. Then answer in one short sentence.',
      },
      { role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls },
      { role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolResult) },
    ],
    thinking: { type: 'disabled' },
  } as never);

  console.log('=== STEP 3: final answer after tool result ===');
  console.log(second.choices?.[0]?.message?.content);
  console.log('RESULT: TOOL_CALLING_VERIFIED in', Date.now() - started, 'ms');
}

main().catch((e) => {
  console.error('TOOL_CALL_TEST_FAILED:', e?.message ?? e);
  process.exit(1);
});
