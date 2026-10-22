/**
 * XAUUSD AI Trading Agent — Agent Run Serialization (Phase 7, Task 42-S4)
 * ----------------------------------------------------------------------------
 * DTO builders + DB readers for persisted agent runs. This module defines the
 * EXACT API contract consumed by the UI (subagent 42-S5):
 *
 *   GET  /api/agent/runs?limit=20      → { ok, runs: AgentRunDto[] }
 *   GET  /api/agent/runs/detail?id=…   → { ok, run: AgentRunDto }
 *   POST /api/agent/runs { task }      → { ok, run: AgentRunDto }
 *
 * AgentRunDto fields (stable contract):
 *   id, task, status, plan[{stepId,description,tool,status}],
 *   result{verdict,reason,facts[],evidence[],summaryBn}|null, errorText,
 *   stepsUsed, stepsMax, toolCallsUsed, toolCallsMax, elapsedMs,
 *   startedAtUtc, endedAtUtc, createdAtUtc, updatedAtUtc,
 *   steps[{id,seq,state,toolName,toolArgsDigest,toolResultDigest,retries,
 *          errorText,startedAtUtc,endedAtUtc}]
 *
 * Steps expose DIGESTS ONLY (argument keys + first 400 chars of the bounded
 * result) — raw tool arguments/results are never persisted or returned.
 */

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

export interface PlannedStepView {
  stepId: string;
  description: string;
  tool: string;
  status: string;
}

export interface AgentFactView {
  /** The step whose TOOL OBSERVATION produced this fact — never invented. */
  sourceStepId: string;
  tool: string;
  key: string;
  value: string | number | boolean | null;
}

export interface AgentEvidenceView {
  stepId: string;
  tool: string;
  ok: boolean;
  digest: string | null;
  retries: number;
  attempts: number;
  durationMs: number;
}

export interface AgentResultView {
  verdict: string;
  reason: string | null;
  facts: AgentFactView[];
  evidence: AgentEvidenceView[];
  summaryBn: string | null;
}

export interface AgentStepDto {
  id: string;
  seq: number;
  state: string;
  toolName: string | null;
  toolArgsDigest: string | null;
  toolResultDigest: string | null;
  retries: number;
  errorText: string | null;
  startedAtUtc: string;
  endedAtUtc: string | null;
}

export interface AgentRunDto {
  id: string;
  task: string;
  status: string;
  plan: PlannedStepView[];
  result: AgentResultView | null;
  errorText: string | null;
  stepsUsed: number;
  stepsMax: number;
  toolCallsUsed: number;
  toolCallsMax: number;
  elapsedMs: number;
  startedAtUtc: string;
  endedAtUtc: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
  steps: AgentStepDto[];
}

type RunRowWithSteps = Prisma.AgentRunGetPayload<{ include: { steps: true } }>;

function parseJsonSafe<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function serializeRun(row: RunRowWithSteps): AgentRunDto {
  const plan = parseJsonSafe<PlannedStepView[]>(row.planJson, []);
  const result = row.resultJson
    ? parseJsonSafe<AgentResultView | null>(row.resultJson, null)
    : null;
  return {
    id: row.id,
    task: row.task,
    status: row.status,
    plan: Array.isArray(plan) ? plan : [],
    result: result && typeof result === 'object' ? result : null,
    errorText: row.errorText,
    stepsUsed: row.stepsUsed,
    stepsMax: row.stepsMax,
    toolCallsUsed: row.toolCallsUsed,
    toolCallsMax: row.toolCallsMax,
    elapsedMs: row.elapsedMs,
    startedAtUtc: row.startedAtUtc.toISOString(),
    endedAtUtc: row.endedAtUtc ? row.endedAtUtc.toISOString() : null,
    createdAtUtc: row.createdAtUtc.toISOString(),
    updatedAtUtc: row.updatedAtUtc.toISOString(),
    steps: [...row.steps]
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({
        id: s.id,
        seq: s.seq,
        state: s.state,
        toolName: s.toolName,
        toolArgsDigest: s.toolArgsDigest,
        toolResultDigest: s.toolResultDigest,
        retries: s.retries,
        errorText: s.errorText,
        startedAtUtc: s.startedAtUtc.toISOString(),
        endedAtUtc: s.endedAtUtc ? s.endedAtUtc.toISOString() : null,
      })),
  };
}

/** Latest runs (newest first) with their steps — digests only by construction. */
export async function listAgentRunDtos(limit: number): Promise<AgentRunDto[]> {
  const rows = await db.agentRun.findMany({
    orderBy: { createdAtUtc: 'desc' },
    take: limit,
    include: { steps: true },
  });
  return rows.map(serializeRun);
}

/** Single run by id (null when absent — the caller decides the 404). */
export async function getAgentRunDto(id: string): Promise<AgentRunDto | null> {
  const row = await db.agentRun.findUnique({
    where: { id },
    include: { steps: true },
  });
  return row ? serializeRun(row) : null;
}
