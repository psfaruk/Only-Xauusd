/**
 * XAUUSD AI Trading Agent — Risk Persistence & Counting Service (Phase 7)
 * ----------------------------------------------------------------------------
 * DB edge of the deterministic risk gate:
 *   · persistRiskCheck        — append-only RiskCheck rows (the audit trail)
 *   · latestRiskCheckForSignal— honest read-back (absent stays absent)
 *   · approvedToday / pendingApprovals / sameSetupApprovedToday — the
 *     TradeApproval-derived counters feeding the exposure/daily/duplicate
 *     checks. NOTE: TradeApproval rows only start existing in Phase 11 —
 *     until then these counts are honestly 0 (nothing is fabricated).
 *
 * This module OWNS the clock (new Date()) — the engine stays pure. No
 * secrets are ever logged; meta payloads carry counters and ids only.
 */

import { db } from '@/lib/db';
import type { RiskCheckDetail, RiskCheckResult, RiskCheckCounts, StoredRiskCheck } from './types';

/** Start of the current UTC day (00:00:00Z) for a given instant. */
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * Append-only persistence of a risk evaluation. The full checks array is
 * serialized to JSON (SQLite has no Json type — project convention). Never
 * overwrites a previous row: every risk check is its own audit record.
 */
export async function persistRiskCheck(
  signalId: string,
  result: RiskCheckResult,
): Promise<void> {
  await db.riskCheck.create({
    data: {
      signalId,
      checks: JSON.stringify(result.checks),
      passed: result.passed,
    },
  });
}

/** Latest persisted risk check for a signal (parsed; null when none exists). */
export async function latestRiskCheckForSignal(
  signalId: string,
): Promise<StoredRiskCheck | null> {
  const row = await db.riskCheck
    .findFirst({ where: { signalId }, orderBy: { createdAt: 'desc' } })
    .catch(() => null);
  if (!row) return null;
  let checks: RiskCheckDetail[] = [];
  try {
    const parsed = JSON.parse(row.checks) as RiskCheckDetail[];
    if (Array.isArray(parsed)) checks = parsed;
  } catch {
    checks = []; // malformed JSON is reported as an empty list, never guessed
  }
  return {
    id: row.id,
    signalId: row.signalId,
    passed: row.passed,
    checks,
    createdAtUtc: row.createdAt.toISOString(),
  };
}

/** TradeApproval rows with status='approved' created since UTC midnight.
 *  Phase 7/9 reality: the table is empty (Phase 11 locked) → honest 0. */
export async function approvedToday(now: Date = new Date()): Promise<number> {
  return db.tradeApproval
    .count({ where: { status: 'approved', createdAt: { gte: startOfUtcDay(now) } } })
    .catch(() => 0);
}

/** TradeApproval rows currently pending (all time — pending is a live state). */
export async function pendingApprovals(): Promise<number> {
  return db.tradeApproval.count({ where: { status: 'pending' } }).catch(() => 0);
}

/** Approvals of THIS SAME setup (signalId) since UTC midnight — the duplicate
 *  protection input. Distinct from approvedToday(): that counts everything. */
export async function sameSetupApprovedToday(
  signalId: string,
  now: Date = new Date(),
): Promise<number> {
  return db.tradeApproval
    .count({
      where: { signalId, status: 'approved', createdAt: { gte: startOfUtcDay(now) } },
    })
    .catch(() => 0);
}

/** Aggregated counters for observability (UI/orchestrator integration). */
export async function getRiskCheckCounts(now: Date = new Date()): Promise<RiskCheckCounts> {
  const [total, passedRows, approved, pending] = await Promise.all([
    db.riskCheck.count().catch(() => 0),
    db.riskCheck.count({ where: { passed: true } }).catch(() => 0),
    approvedToday(now),
    pendingApprovals(),
  ]);
  return {
    totalRiskChecks: total,
    passedRiskChecks: passedRows,
    failedRiskChecks: Math.max(0, total - passedRows),
    approvedToday: approved,
    pendingApprovals: pending,
  };
}
