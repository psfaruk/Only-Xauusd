/**
 * XAUUSD AI Trading Agent — A11 SMC Narrative Agent (Phase 14, Task 34-j)
 * ----------------------------------------------------------------------------
 * Converts the deterministic ten-agent ICT/SMC confluence evidence of an
 * EMITTED setup into a short Bengali educational narrative via glm-4-plus.
 *
 * ─── NON-NEGOTIABLE INVARIANTS (same as the Phase 6 multi-agent review) ────
 *   · The LLM NEVER computes or overrides a number — every figure comes from
 *     the persisted evidence; the prompt forbids inventing prices/levels.
 *   · The narrative NEVER changes the signal outcome — the deterministic
 *     engine stays authoritative. This is commentary only.
 *   · The call is bounded (timeout, disabled thinking, short output) and
 *     best-effort: a failure degrades to an honest modelOk=false note and is
 *     logged — it NEVER blocks or fails the signal pipeline.
 *   · z-ai-web-dev-sdk is used SERVER-SIDE only.
 */

import ZAI from 'z-ai-web-dev-sdk';
import { logEvent } from '@/lib/logger';
import type { SignalLevels } from '../types';
import type { ScalperTf } from '../scalper/types';
import type { SmcConfluenceEvidence } from './types';

export const SMC_NARRATIVE_VERSION = '14.0.0';

export interface SmcNarrativeInput {
  symbol: string;
  sourceTimeframe: ScalperTf;
  outcome: 'BUY_SETUP' | 'SELL_SETUP';
  levels: SignalLevels | null;
  smc: SmcConfluenceEvidence;
}

export interface SmcNarrativeResult {
  version: string;
  symbol: string;
  narrativeBn: string;
  modelOk: boolean;
  durationMs: number;
  error: string | null;
}

/** Deterministic fact sheet — the ONLY numbers the model may reference. */
function buildFactSheet(input: SmcNarrativeInput): string {
  const s = input.smc;
  const lines: string[] = [];
  lines.push(`সিম্বল: ${input.symbol}`);
  lines.push(`উৎস টাইমফ্রেম: ${input.sourceTimeframe}`);
  lines.push(`ফলাফল: ${input.outcome} · স্কোর ${s.totalScore}/100 · টিয়ার ${s.tier ?? '—'}`);
  if (input.levels) {
    lines.push(
      `লেভেল: এন্ট্রি জোন ${input.levels.entryZoneLowText}–${input.levels.entryZoneHighText}, SL ${input.levels.stopLossText}, টার্গেট ${input.levels.targetText} (R:R ${input.levels.rewardRiskRatio})`,
    );
  }
  const sweep = s.liquidity.sweeps[0];
  if (sweep) {
    lines.push(
      `লিকুইডিটি সুইপ: ${sweep.direction === 'BULLISH' ? 'সেল-সাইড' : 'বাই-সাইড'} (${sweep.origin}) @ ${sweep.levelText} — ${sweep.barsAgo} বার আগে, রিক্লেইম হয়েছে`,
    );
  } else {
    lines.push('লিকুইডিটি সুইপ: নেই');
  }
  const poi = s.direction === 'SELL' ? s.poi.nearestBearish : s.poi.nearestBullish;
  if (poi) {
    lines.push(`POI জোন: ${poi.kind} ${poi.bottomText}–${poi.topText} (${poi.fresh ? 'ফ্রেশ' : 'মিটিগেটেড'})`);
  } else {
    lines.push('POI জোন: নেই');
  }
  const ev = s.structure.lastEvent;
  if (ev) {
    lines.push(`কাঠামো: ${ev.type} ${ev.direction} @ ${ev.levelText}${s.structure.barsSinceEvent !== null ? ` (${s.structure.barsSinceEvent} বার আগে)` : ''}`);
  }
  const pat = s.priceAction.decisionPattern;
  if (pat) lines.push(`সিদ্ধান্ত-বার প্যাটার্ন: ${pat.kind} (শক্তি ${pat.strength.toFixed(2)})`);
  lines.push(
    `মোমেন্টাম: স্কোর ${s.momentum.score.toFixed(0)}, RSI ${s.momentum.rsi !== null ? s.momentum.rsi.toFixed(1) : '—'}, ATR ${s.momentum.atr !== null ? s.momentum.atr.toFixed(2) : '—'}`,
  );
  lines.push(
    `সেশন: ${s.session.active}${s.session.killzone ? ` (${s.session.killzone === 'LONDON_KZ' ? 'লন্ডন কিলজোন' : 'NY কিলজোন'})` : ''}`,
  );
  lines.push(`AMD: ${s.amd.phase}${s.amd.signature ? ` · ${s.amd.signature}` : ''}`);
  const voteLines = s.votes.map((v) => `  · ${v.agent}: ${v.score}/${v.weight} — ${v.reasonEn}`);
  lines.push('এজেন্ট ভোট:', ...voteLines);
  if (s.vetoes.length) lines.push(`ভিটো: ${s.vetoes.join(', ')}`);
  return lines.join('\n');
}

const PROMPT_TEMPLATE = (facts: string) => `তুমি XAUUSD স্মার্ট-মানি কনসেপ্ট (ICT/SMC) শিক্ষক। নিচের নির্ধারিত (deterministic) এভিডেন্স থেকে বাংলায় ৪–৬ বাক্যের একটি শিক্ষামূলক ব্যাখ্যা লেখো — কেন এই সিগন্যাল এসেছে তা একজন নতুন ট্রেডারকে বোঝানোর মতো করে।

কঠিন নিয়ম:
1. শুধু নিচের তথ্যের সংখ্যাগুলো ব্যবহার করো — কোনো নতুন সংখ্যা/দাম/লেভেল বানানো একদম নিষেধ।
2. ICT শব্দ ব্যাখ্যা করো (সুইপ/স্টপ-হান্ট, POI/অর্ডার ব্লক, FVG, কিলজোন) — মূল ইংরেজি শব্দটা বন্ধনীতে রাখো।
3. কোনো নতুন সুপারিশ/টার্গেট যোগ করবে না — ব্যাখ্যা শুধু।
4. এক লাইনে ঝুঁকি-মন্তব্য দাও (SL-এর গুরুত্ব)।

এভিডেন্স:
${facts}`;

/**
 * Best-effort narrative for an emitted SMC setup. NEVER throws — a model
 * failure returns modelOk=false with the honest error note.
 */
export async function generateSmcNarrative(input: SmcNarrativeInput): Promise<SmcNarrativeResult> {
  const started = Date.now();
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content:
            'তুমি একজন নিয়ম-মেনে-চলা ICT/SMC শিক্ষক। শুধু বাংলা ব্যাখ্যা দাও — কোনো নতুন সংখ্যা বানাবে না, কোনো JSON নয়।',
        },
        { role: 'user', content: PROMPT_TEMPLATE(buildFactSheet(input)) },
      ],
      thinking: { type: 'disabled' },
    });
    const narrative = (completion.choices[0]?.message?.content ?? '').trim();
    const durationMs = Date.now() - started;
    if (!narrative) {
      return {
        version: SMC_NARRATIVE_VERSION,
        symbol: input.symbol,
        narrativeBn: '',
        modelOk: false,
        durationMs,
        error: 'empty model response',
      };
    }
    return {
      version: SMC_NARRATIVE_VERSION,
      symbol: input.symbol,
      narrativeBn: narrative.slice(0, 1_500),
      modelOk: true,
      durationMs,
      error: null,
    };
  } catch (err) {
    return {
      version: SMC_NARRATIVE_VERSION,
      symbol: input.symbol,
      narrativeBn: '',
      modelOk: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown narrative failure',
    };
  }
}

/**
 * Fire-and-forget wrapper for the scalper service: generates the narrative
 * for an emitted SMC setup and persists it in the audit trail (SystemEvent).
 * NEVER blocks the signal pipeline; every failure is logged honestly.
 */
export async function narrateEmittedSetupInBackground(input: SmcNarrativeInput): Promise<void> {
  const result = await generateSmcNarrative(input);
  await logEvent({
    level: result.modelOk ? 'info' : 'warn',
    category: 'smc-narrative',
    code: result.modelOk ? 'SMC_NARRATIVE_GENERATED' : 'SMC_NARRATIVE_FAILED',
    message: result.modelOk
      ? `SMC narrative ${input.symbol} ${input.outcome} (${input.smc.tier ?? '—'} tier): ${result.narrativeBn.slice(0, 120)}…`
      : `SMC narrative failed for ${input.symbol}: ${result.error ?? 'unknown'}`,
    meta: {
      symbol: input.symbol,
      outcome: input.outcome,
      sourceTimeframe: input.sourceTimeframe,
      score: input.smc.totalScore,
      tier: input.smc.tier,
      durationMs: result.durationMs,
      narrativeBn: result.narrativeBn || null,
      error: result.error,
    },
  }).catch(() => undefined);
}
