/**
 * XAUUSD AI Trading Agent — GLM Multi-Agent Orchestration (Phase 6)
 * ----------------------------------------------------------------------------
 * A four-role advisory review pipeline that runs AFTER the deterministic
 * signal evaluation:
 *
 *   analyst       — reads the verified evidence, summarises the market state
 *   critic        — challenges the analyst's read against the same evidence
 *   risk_reviewer — assesses risk-relevant conditions (spread, structure age,
 *                   HTF alignment, expiry, Phase 7 risk check when present)
 *   orchestrator  — synthesises the three into one final verdict + summary
 *
 * ─── NON-NEGOTIABLE INVARIANTS ───────────────────────────────────────────────
 *   · The LLM NEVER computes or overrides a number. Every figure the agents
 *     see comes from the deterministic evaluation payload passed in; the
 *     prompts forbid inventing prices/levels.
 *   · The review NEVER changes the signal outcome. It is advisory commentary
 *     persisted in AiReview rows — the deterministic engine stays authoritative.
 *   · Verdicts are strictly {approve, reject, wait}; anything unparseable
 *     degrades honestly to 'wait' with a note in meta.
 *   · Every agent call is bounded (timeout, output length); a failed agent
 *     degrades to verdict 'wait' with reasoning 'মডেল কল ব্যর্থ' — the batch
 *     completes with degraded=true rather than failing wholesale.
 *   · z-ai-web-dev-sdk is used SERVER-SIDE only (never bundled client-side).
 */

import ZAI from 'z-ai-web-dev-sdk';
import { config } from '@/lib/config';
import { logEvent } from '@/lib/logger';
import type { SignalEvaluation } from '@/lib/signal/types';
import type { StoredRiskCheck } from '@/lib/risk/types';

export const MULTI_AGENT_VERSION = '6.0.0';

export type ReviewAgentName = 'analyst' | 'critic' | 'risk_reviewer' | 'orchestrator';
export type ReviewVerdict = 'approve' | 'reject' | 'wait';

/** The deterministic facts every agent sees (structural subset of the stored
 *  evaluation — fields guaranteed present in LatestSignalEvaluation). */
export interface ReviewEvaluationFacts {
  symbol: string;
  engineVersion: string;
  strategyVersion: string;
  outcome: string;
  reasonCodes: string[];
  decisionCandleTimeUtc: string | null;
  setupKnownAtUtc: string | null;
  expiryUtc: string | null;
  levels: SignalEvaluation['levels'];
  evidence: SignalEvaluation['evidence'];
}

export interface ReviewQuoteContext {
  bid: number | null;
  ask: number | null;
  spread: number | null;
  freshness: string | null;
  sourceClass: string | null;
}

export interface MultiAgentReviewInput {
  symbol: string;
  evaluation: ReviewEvaluationFacts;
  evaluationId: string | null;
  quote: ReviewQuoteContext | null;
  riskCheck: StoredRiskCheck | null;
}

export interface AgentReview {
  agent: ReviewAgentName;
  verdict: ReviewVerdict;
  reasoning: string;
  durationMs: number;
  modelOk: boolean;
}

export interface MultiAgentReviewResult {
  batchId: string;
  version: string;
  symbol: string;
  evaluationId: string | null;
  evaluationOutcome: string;
  ranAtUtc: string;
  agents: AgentReview[];
  orchestrator: AgentReview;
  degraded: boolean;
  notes: string[];
  model: string;
}

const MAX_REASONING_CHARS = 600;

/** Deterministic, bounded evidence block — the ONLY source of numbers. */
function buildEvidenceBlock(input: MultiAgentReviewInput): string {
  const e = input.evaluation;
  const lines: string[] = [];
  lines.push(`সিম্বল: ${e.symbol}`);
  lines.push(`স্ট্র্যাটেজি: ${e.strategyVersion} (ইঞ্জিন ${e.engineVersion})`);
  lines.push(`নির্ধারিত ফলাফল (deterministic): ${e.outcome}`);
  if (e.reasonCodes.length) lines.push(`কারণ-কোড: ${e.reasonCodes.join(', ')}`);
  if (e.decisionCandleTimeUtc) lines.push(`সিদ্ধান্ত ক্যান্ডেল: ${e.decisionCandleTimeUtc}`);
  if (e.expiryUtc) lines.push(`মেয়াদ: ${e.expiryUtc}`);

  if (e.levels) {
    const l = e.levels;
    lines.push(
      `লেভেল: entry zone ${l.entryZoneLow}–${l.entryZoneHigh}, SL ${l.stopLoss}, target ${l.target}` +
        (typeof l.rewardRiskRatio === 'number' ? `, R:R ${l.rewardRiskRatio}` : ''),
    );
  }

  const ev = e.evidence as Record<string, unknown> | null;
  if (ev) {
    const se = ev.structureEvent as Record<string, unknown> | undefined;
    if (se) {
      lines.push(
        `কাঠামো ইভেন্ট: ${se.type} ${se.direction} @ ${se.levelText ?? se.level}` +
          (se.breakCandleTimeUtc ? ` (${se.breakCandleTimeUtc})` : '') +
          (typeof se.barsSinceBreak === 'number' ? ` — ${se.barsSinceBreak} bar আগে` : ''),
      );
    }
    const ind = ev.indicators as Record<string, unknown> | undefined;
    if (ind) {
      const parts: string[] = [];
      for (const key of ['ema20', 'ema50', 'ema200', 'rsi14', 'adx14', 'atr14']) {
        const v = ind[key];
        if (typeof v === 'number' && Number.isFinite(v)) {
          parts.push(`${key}=${Math.round(v * 1000) / 1000}`);
        }
      }
      if (parts.length) lines.push(`ইন্ডিকেটর: ${parts.join(', ')}`);
    }
    const htf = ev.htfContext as Record<string, unknown> | undefined;
    if (htf) {
      const h1 = htf.h1 as Record<string, unknown> | undefined;
      const h4 = htf.h4 as Record<string, unknown> | undefined;
      if (h1?.trend) lines.push(`H1 ট্রেন্ড: ${h1.trend}`);
      if (h4?.trend) lines.push(`H4 ট্রেন্ড: ${h4.trend}`);
    }
  }

  if (input.quote) {
    const q = input.quote;
    lines.push(
      `লাইভ কোট: bid=${q.bid ?? 'অজানা'}, ask=${q.ask ?? 'অজানা'}, spread=${q.spread ?? 'অজানা'} (${q.freshness ?? 'অজানা'}, উৎস ${q.sourceClass ?? 'অজানা'})`,
    );
  } else {
    lines.push('লাইভ কোট: অনুপলব্ধ (নির্ধারিত ইঞ্জিনের ফলাফলের উপর ভিত্তি করে পর্যালোচনা)');
  }

  if (input.riskCheck) {
    const rc = input.riskCheck;
    lines.push(
      `রিস্ক চেক (Phase 7): ${rc.passed ? 'পাস' : 'ফেল'} — ` +
        `নিয়ম: ${rc.checks.filter((c) => c.passed).length}/${rc.checks.length} পাস`,
    );
    const failed = rc.checks.filter((c) => !c.passed);
    for (const f of failed) lines.push(`  ✗ ${f.rule}: ${f.detail}`);
  }

  return lines.join('\n');
}

/** The single question every agent answers about the deterministic verdict. */
function verdictQuestion(outcome: string): string {
  if (outcome === 'BUY_SETUP' || outcome === 'SELL_SETUP') {
    return 'প্রশ্ন: এই অ্যাকশনেবল সেটআপের যুক্তি কি প্রমাণের সাথে সঙ্গতিপূর্ণ?';
  }
  return `প্রশ্ন: এই ফলাফল (${outcome} — মানে এখন অ্যাকশনেবল সেটআপ নেই বা অপেক্ষা) কি প্রমাণ অনুযায়ী সঠিক?`;
}

const OUTPUT_CONTRACT = `উত্তর শুধু এই JSON-এ: {"verdict":"approve|reject|wait","reasoning":"..."}
- approve = প্রমাণের সাথে সঙ্গতিপূর্ণ/গ্রহণযোগ্য
- reject = প্রমাণের সাথে বিরোধ/গ্রহণযোগ্য নয়
- wait = প্রমাণ অপর্যাপ্ত / নিশ্চিত হতে পারছি না
reasoning সর্বোচ্চ ${MAX_REASONING_CHARS} অক্ষর, বাংলায়, JSON স্ট্রিং-এর ভিতরে (নতুন লাইন ছাড়া নয় তবে এস্কেপ করা হলে চলবে)।`;

function analystPrompt(evidence: string, outcome: string): string {
  return `তুমি XAUUSD AI Trading Agent-এর "অ্যানালিস্ট" এজেন্ট (Phase 6 মাল্টি-এজেন্ট রিভিউ)।

নিচের ভেরিফাইড ডেটাই একমাত্র সত্যের উৎস — এর বাইরে কোনো দাম, লেভেল বা ইন্ডিকেটর বানাবে না।

${verdictQuestion(outcome)}

কাজ: প্রমাণ পড়ে ৩-৫ বাক্যে বাংলায় বাজারের অবস্থা ব্যাখ্যা করো (কাঠামো, ট্রেন্ড, মোমেন্টাম), এবং ফলাফলের সাথে একমত কি না বলো।

${OUTPUT_CONTRACT}

--- ভেরিফাইড ডেটা ---
${evidence}`;
}

function criticPrompt(evidence: string, outcome: string, analyst: AgentReview): string {
  return `তুমি XAUUSD AI Trading Agent-এর "ক্রিটিক" এজেন্ট (Phase 6 মাল্টি-এজেন্ট রিভিউ)।

অ্যানালিস্টের সারসংক্ষেপ পর্যালোচনা করো — অতিরিক্ত আত্মবিশ্বাস, প্রমাণের সাথে বিরোধ, বাদ পড়া ঝুঁকি খুঁজে বের করো। নিজে কোনো নতুন সংখ্যা বানাবে না।

${verdictQuestion(outcome)}

কাজ: অ্যানালিস্টের পাঠ কি প্রমাণে টিকে কি না — ২-৪ বাক্যে বাংলায় বিচার করো।

${OUTPUT_CONTRACT}

--- ভেরিফাইড ডেটা ---
${evidence}

--- অ্যানালিস্টের পাঠ (verdict: ${analyst.verdict}) ---
${analyst.reasoning}`;
}

function riskReviewerPrompt(evidence: string, outcome: string): string {
  return `তুমি XAUUSD AI Trading Agent-এর "রিস্ক রিভিউয়ার" এজেন্ট (Phase 6 মাল্টি-এজেন্ট রিভিউ)।

শুধু ঝুঁকির দিকগুলো দেখো: spread, কাঠামোর ব্রেক কত পুরোনো, উচ্চ টাইমফ্রেম (H1/H4) অ্যালাইনমেন্ট, সেটআপের মেয়াদ, রিস্ক চেকের ফলাফল (দেওয়া থাকলে)। নিজে কোনো নতুন সংখ্যা বানাবে না।

${verdictQuestion(outcome)}

কাজ: এই পরিস্থিতিতে ঝুঁকির দিক থেকে ফলাফলের সাথে একমত কি না — ২-৪ বাক্যে বাংলায়।

${OUTPUT_CONTRACT}

--- ভেরিফাইড ডেটা ---
${evidence}`;
}

function orchestratorPrompt(
  evidence: string,
  outcome: string,
  analyst: AgentReview,
  critic: AgentReview,
  riskReviewer: AgentReview,
): string {
  return `তুমি XAUUSD AI Trading Agent-এর "অর্কেস্ট্রেটর" এজেন্ট (Phase 6 মাল্টি-এজেন্ট রিভিউ)।

তিনজন এজেন্টের মতামত মিলিয়ে একটি চূড়ান্ত রায় দাও। মনে রেখো: নির্ধারিত (deterministic) ইঞ্জিনের ফলাফল (${outcome}) কখনো বদলানো যায় না — এই রিভিউ শুধু পরামর্শমূলক ব্যাখ্যা। নিজে কোনো নতুন সংখ্যা বানাবে না।

reasoning: ব্যবহারকারীর জন্য সরাসরি ২-৪ বাক্যের বাংলা সারসংক্ষেপ — এখন বাজারে কী হচ্ছে এবং কেন এই ফলাফল এসেছে, সহজ ভাষায়।

${OUTPUT_CONTRACT}

--- ভেরিফাইড ডেটা ---
${evidence}

--- অ্যানালিস্ট (${analyst.verdict}${analyst.modelOk ? '' : ', মডেল কল ব্যর্থ'}) ---
${analyst.reasoning}

--- ক্রিটিক (${critic.verdict}${critic.modelOk ? '' : ', মডেল কল ব্যর্থ'}) ---
${critic.reasoning}

--- রিস্ক রিভিউয়ার (${riskReviewer.verdict}${riskReviewer.modelOk ? '' : ', মডেল কল ব্যর্থ'}) ---
${riskReviewer.reasoning}`;
}

interface ParsedAgentOutput {
  verdict: ReviewVerdict;
  reasoning: string;
}

function parseAgentOutput(raw: string): ParsedAgentOutput | null {
  const text = raw.trim();
  // Tolerate a code-fenced or prose-wrapped JSON object; find the outermost braces.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as { verdict?: unknown; reasoning?: unknown };
      const verdict =
        obj.verdict === 'approve' || obj.verdict === 'reject' || obj.verdict === 'wait' ? obj.verdict : null;
      const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '';
      if (verdict && reasoning.length > 0) {
        return { verdict, reasoning: reasoning.slice(0, MAX_REASONING_CHARS) };
      }
      if (verdict) return { verdict, reasoning: '(মডেল ব্যাখ্যা দেয়নি)' };
    } catch {
      // fall through
    }
  }
  return null;
}

async function callAgent(
  prompt: string,
): Promise<{ parsed: ParsedAgentOutput | null; durationMs: number; error: string | null }> {
  const started = Date.now();
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content:
            'তুমি একজন নিয়ম-মেনে-চলা বিশ্লেষণ এজেন্ট। শুধু নির্দেশিত JSON ফরম্যাটে উত্তর দাও — অন্য কিছু নয়। কোনো নতুন সংখ্যা বানাবে না।',
        },
        { role: 'user', content: prompt },
      ],
      thinking: { type: 'disabled' },
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) {
      return { parsed: null, durationMs: Date.now() - started, error: 'empty model response' };
    }
    return { parsed: parseAgentOutput(raw), durationMs: Date.now() - started, error: null };
  } catch (err) {
    return {
      parsed: null,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'unknown model error',
    };
  }
}

function degradedAgent(agent: ReviewAgentName, durationMs: number, error: string | null): AgentReview {
  return {
    agent,
    verdict: 'wait',
    reasoning: `মডেল কল ব্যর্থ — সৎ অবনমন (verdict: wait)।${error ? ` কারণ: ${error.slice(0, 120)}` : ''}`,
    durationMs,
    modelOk: false,
  };
}

/** Run the full four-role pipeline. NEVER throws — degrades honestly. */
export async function runMultiAgentReview(input: MultiAgentReviewInput): Promise<MultiAgentReviewResult> {
  const notes: string[] = [];
  const evidence = buildEvidenceBlock(input);
  const outcome = input.evaluation.outcome;

  // ---- Agent 1: analyst -----------------------------------------------------
  const a1 = await callAgent(analystPrompt(evidence, outcome));
  const analyst: AgentReview = a1.parsed
    ? { agent: 'analyst', ...a1.parsed, durationMs: a1.durationMs, modelOk: true }
    : (notes.push('analyst এজেন্ট ব্যর্থ'), degradedAgent('analyst', a1.durationMs, a1.error));

  // ---- Agent 2: critic (sees the analyst) ------------------------------------
  const a2 = await callAgent(criticPrompt(evidence, outcome, analyst));
  const critic: AgentReview = a2.parsed
    ? { agent: 'critic', ...a2.parsed, durationMs: a2.durationMs, modelOk: true }
    : (notes.push('critic এজেন্ট ব্যর্থ'), degradedAgent('critic', a2.durationMs, a2.error));

  // ---- Agent 3: risk reviewer -------------------------------------------------
  const a3 = await callAgent(riskReviewerPrompt(evidence, outcome));
  const riskReviewer: AgentReview = a3.parsed
    ? { agent: 'risk_reviewer', ...a3.parsed, durationMs: a3.durationMs, modelOk: true }
    : (notes.push('risk_reviewer এজেন্ট ব্যর্থ'), degradedAgent('risk_reviewer', a3.durationMs, a3.error));

  // ---- Agent 4: orchestrator (sees all three) ----------------------------------
  const a4 = await callAgent(orchestratorPrompt(evidence, outcome, analyst, critic, riskReviewer));
  const orchestrator: AgentReview = a4.parsed
    ? { agent: 'orchestrator', ...a4.parsed, durationMs: a4.durationMs, modelOk: true }
    : (notes.push('orchestrator এজেন্ট ব্যর্থ'), degradedAgent('orchestrator', a4.durationMs, a4.error));

  const batchId = `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    batchId,
    version: MULTI_AGENT_VERSION,
    symbol: input.symbol,
    evaluationId: input.evaluationId,
    evaluationOutcome: outcome,
    ranAtUtc: new Date().toISOString(),
    agents: [analyst, critic, riskReviewer],
    orchestrator,
    degraded: notes.length > 0,
    notes,
    model: config.glm.model,
  };
}

// ---------------------------------------------------------------------------
// Persistence — AiReview rows (one per agent per batch)
// ---------------------------------------------------------------------------

import { db } from '@/lib/db';

export async function persistMultiAgentReview(result: MultiAgentReviewResult): Promise<void> {
  const rows: Array<{ agent: AgentReview; signalId: string | null }> = [
    ...result.agents.map((a) => ({ agent: a, signalId: result.evaluationId })),
    { agent: result.orchestrator, signalId: result.evaluationId },
  ];
  for (const { agent, signalId } of rows) {
    await db.aiReview.create({
      data: {
        signalId,
        analysisId: null,
        agent: agent.agent,
        verdict: agent.verdict,
        reasoning: agent.reasoning,
        meta: JSON.stringify({
          batchId: result.batchId,
          version: result.version,
          symbol: result.symbol,
          evaluationOutcome: result.evaluationOutcome,
          durationMs: agent.durationMs,
          modelOk: agent.modelOk,
          degraded: result.degraded,
        }),
      },
    });
  }
}

export interface StoredAgentReview {
  agent: string;
  verdict: string;
  reasoning: string;
  createdAtUtc: string;
  modelOk: boolean | null;
}

export interface StoredMultiAgentReview {
  batchId: string;
  evaluationId: string | null;
  evaluationOutcome: string | null;
  ranAtUtc: string;
  degraded: boolean | null;
  agents: StoredAgentReview[];
  orchestrator: StoredAgentReview | null;
}

interface BatchRow {
  agent: string;
  verdict: string;
  reasoning: string;
  createdAt: Date;
  signalId: string | null;
  meta: {
    batchId?: string;
    evaluationOutcome?: string;
    modelOk?: boolean;
    degraded?: boolean;
    symbol?: string;
  };
}

/** Read back the latest complete review batch for a symbol (newest first). */
export async function getLatestMultiAgentReview(symbol: string): Promise<StoredMultiAgentReview | null> {
  const rows = await db.aiReview
    .findMany({
      where: { agent: { in: ['analyst', 'critic', 'risk_reviewer', 'orchestrator'] } },
      orderBy: { createdAt: 'desc' },
      take: 24,
    })
    .catch(() => []);

  const batches = new Map<string, BatchRow[]>();
  for (const row of rows) {
    let meta: BatchRow['meta'] = {};
    try {
      meta = JSON.parse(row.meta ?? '{}') as BatchRow['meta'];
    } catch {
      meta = {};
    }
    if (!meta.batchId) continue;
    if (meta.symbol && meta.symbol !== symbol) continue;
    const list = batches.get(meta.batchId) ?? [];
    list.push({
      agent: row.agent,
      verdict: row.verdict,
      reasoning: row.reasoning,
      createdAt: row.createdAt,
      signalId: row.signalId,
      meta,
    });
    batches.set(meta.batchId, list);
  }

  const ordered = [...batches.entries()].sort((a, b) => {
    const ta = Math.max(...a[1].map((r) => r.createdAt.getTime()));
    const tb = Math.max(...b[1].map((r) => r.createdAt.getTime()));
    return tb - ta;
  });

  for (const [, list] of ordered) {
    const orchestratorRow = list.find((r) => r.agent === 'orchestrator');
    if (!orchestratorRow) continue; // incomplete batch — skip honestly
    const toStored = (r: BatchRow): StoredAgentReview => ({
      agent: r.agent,
      verdict: r.verdict,
      reasoning: r.reasoning,
      createdAtUtc: r.createdAt.toISOString(),
      modelOk: typeof r.meta.modelOk === 'boolean' ? r.meta.modelOk : null,
    });
    return {
      batchId: orchestratorRow.meta.batchId!,
      evaluationId: orchestratorRow.signalId,
      evaluationOutcome: orchestratorRow.meta.evaluationOutcome ?? null,
      ranAtUtc: orchestratorRow.createdAt.toISOString(),
      degraded: typeof orchestratorRow.meta.degraded === 'boolean' ? orchestratorRow.meta.degraded : null,
      agents: list.filter((r) => r.agent !== 'orchestrator').map(toStored),
      orchestrator: toStored(orchestratorRow),
    };
  }
  return null;
}

/** True when the given evaluation id already has an orchestrator review. */
export async function alreadyReviewed(evaluationId: string): Promise<boolean> {
  const row = await db.aiReview
    .findFirst({
      where: { signalId: evaluationId, agent: 'orchestrator' },
      select: { id: true },
    })
    .catch(() => null);
  return row !== null;
}

// ---------------------------------------------------------------------------
// Orchestration entry — build the input from live state and run
// ---------------------------------------------------------------------------

import { getLatestSignalEvaluation } from '@/lib/signal/persistence';
import { getLatestTick } from '@/lib/market/service';
import { latestRiskCheckForSignal } from '@/lib/risk/service';

export interface ReviewRunOutcome {
  ran: boolean;
  reason: string;
  result: MultiAgentReviewResult | null;
}

/** Live-quote context for the review (honest nulls when no verified tick). */
async function liveQuoteContext(symbol: string): Promise<ReviewQuoteContext | null> {
  const res = await getLatestTick(symbol).catch(() => null);
  const tick = res?.tick ?? null;
  if (!tick) return null;
  // Stored tick fields are canonical decimal TEXT — parse honestly, NaN stays
  // out of the payload (null).
  const num = (v: string | null | undefined): number | null => {
    if (typeof v !== 'string' || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const ageSec = (Date.now() - new Date(tick.tickTimeUtc).getTime()) / 1000;
  const freshness = ageSec <= config.market.staleTickSec ? 'LIVE' : 'STALE';
  return {
    bid: num(tick.bid),
    ask: num(tick.ask),
    spread: num(tick.spread),
    freshness,
    sourceClass: tick.source ?? null,
  };
}

/** Run a review for the latest evaluation of a symbol (skips when already reviewed). */
export async function runReviewForLatestEvaluation(
  symbol: string,
  opts: { force?: boolean } = {},
): Promise<ReviewRunOutcome> {
  const latest = await getLatestSignalEvaluation(db, symbol);
  if (!latest) {
    return { ran: false, reason: 'কোনো সিগন্যাল ইভ্যালুয়েশন নেই — আগে সিগন্যাল রান করুন', result: null };
  }
  const evaluationId = latest.id;
  if (!opts.force && (await alreadyReviewed(evaluationId))) {
    return { ran: false, reason: 'এই ইভ্যালুয়েশনের রিভিউ আগেই হয়ে গেছে', result: null };
  }

  const [quote, riskCheck] = await Promise.all([
    liveQuoteContext(symbol),
    latestRiskCheckForSignal(evaluationId).catch(() => null),
  ]);

  const result = await runMultiAgentReview({
    symbol,
    evaluation: {
      symbol: latest.symbol,
      engineVersion: latest.engineVersion,
      strategyVersion: latest.strategyVersion,
      outcome: latest.outcome,
      reasonCodes: latest.reasonCodes,
      decisionCandleTimeUtc: latest.decisionCandleTimeUtc,
      setupKnownAtUtc: latest.setupKnownAtUtc,
      expiryUtc: latest.expiryUtc,
      levels: latest.levels,
      evidence: latest.evidence,
    },
    evaluationId,
    quote,
    riskCheck,
  });

  try {
    await persistMultiAgentReview(result);
    await logEvent({
      level: result.degraded ? 'warn' : 'info',
      category: 'glm',
      code: result.degraded ? 'AI_REVIEW_DEGRADED' : 'AI_REVIEW_COMPLETED',
      message: `Multi-agent review ${symbol} → ${result.orchestrator.verdict} (${result.evaluationOutcome})${
        result.degraded ? ` [degraded: ${result.notes.join('; ')}]` : ''
      }`,
      meta: {
        batchId: result.batchId,
        evaluationId,
        outcome: result.evaluationOutcome,
        verdict: result.orchestrator.verdict,
      },
    });
  } catch {
    // persistence failure must never mask the review itself
  }

  return { ran: true, reason: 'রিভিউ সম্পন্ন', result };
}
