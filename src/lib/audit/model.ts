/**
 * XAUUSD AI Trading Agent — Environment Audit Model v2 (Phase 9, Task A)
 * ----------------------------------------------------------------------------
 * Versioned, honest audit vocabulary. Every check result carries its own
 * evidence type, timestamps, duration, runtime identity, freshness policy and
 * an explanatory reason.
 *
 * Status semantics (STRICT — never silently upgraded):
 *   PASS            — this check ran NOW and its acceptance condition held.
 *   WARN            — a real, current limitation exists but does not
 *                     invalidate the current system (e.g. temporarily stale
 *                     data while the capability itself is intact).
 *   FAIL            — a required current capability was tested NOW and failed.
 *   BLOCKED         — a required test could NOT be performed (e.g. a
 *                     dependency of the test itself was unreachable).
 *   NOT_APPLICABLE  — the dependency is NOT required by the chosen
 *                     architecture (must be backed by code-inspection
 *                     evidence, never used to hide a failure).
 *   NOT_TESTED      — no fresh test evidence exists. NEVER counts as PASS.
 *
 * Historical evidence (Phase 1 command results) is kept VERBATIM in
 * historical.ts, tagged with the phase that produced it and its ORIGINAL
 * timestamp. A historical result is never re-labeled as a current result.
 */

export type AuditCheckStatus =
  | 'PASS'
  | 'WARN'
  | 'FAIL'
  | 'BLOCKED'
  | 'NOT_APPLICABLE'
  | 'NOT_TESTED';

export type AuditEvidenceType = 'STATIC' | 'COMMAND' | 'API_PROBE' | 'LIVE_BROKER' | 'FIXTURE';

/** How fresh the evidence is / when it is re-acquired. */
export type AuditFreshnessPolicy =
  | 'per-request'          // re-evaluated on every audit report request
  | 'historical-phase1'    // frozen Phase 1 command evidence (2026-10-14)
  | 'static-invariant';    // structural code invariant, re-verified per request

export type AuditCheckScope = 'current-required' | 'historical' | 'not-applicable';

export type AuditCheckCategory =
  | 'runtime'
  | 'database'
  | 'mt5-bridge'
  | 'market-data'
  | 'signal-engine'
  | 'glm'
  | 'security'
  | 'legacy-dependency';

/** One check result — the full honest record (spec Task A2). */
export interface AuditCheckResult {
  id: string;
  category: AuditCheckCategory;
  description: string;
  required: boolean;
  expected: string;
  actual: string | null;
  evidenceType: AuditEvidenceType;
  /** Safe description of how the evidence was obtained (never client-supplied,
   *  never an executable shell command surface). */
  evidenceCommand: string;
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  /** Commit (or runtime version) under which the check ran. */
  runtimeIdentity: string | null;
  exitCodeOrHttpStatus: number | null;
  durationMs: number | null;
  /** Redacted, bounded evidence (stdout/stderr excerpt or structured facts). */
  evidence: string;
  status: AuditCheckStatus;
  reason: string;
  freshnessPolicy: AuditFreshnessPolicy;
  scope: AuditCheckScope;
  /** Present on historical entries — the phase whose audit produced them. */
  historical?: { phase: number; performedAtUtc: string };
}

export interface AuditTotals {
  currentRequired: { pass: number; warn: number; fail: number; blocked: number; total: number };
  notApplicable: number;
  historical: number;
  notTested: number;
}

export function emptyTotals(): AuditTotals {
  return {
    currentRequired: { pass: 0, warn: 0, fail: 0, blocked: 0, total: 0 },
    notApplicable: 0,
    historical: 0,
    notTested: 0,
  };
}

export function computeTotals(checks: AuditCheckResult[]): AuditTotals {
  const t = emptyTotals();
  for (const c of checks) {
    if (c.scope === 'historical') {
      t.historical += 1;
      continue;
    }
    if (c.scope === 'not-applicable') {
      t.notApplicable += 1;
      continue;
    }
    t.currentRequired.total += 1;
    switch (c.status) {
      case 'PASS':
        t.currentRequired.pass += 1;
        break;
      case 'WARN':
        t.currentRequired.warn += 1;
        break;
      case 'FAIL':
        t.currentRequired.fail += 1;
        break;
      case 'BLOCKED':
        t.currentRequired.blocked += 1;
        break;
      case 'NOT_TESTED':
        t.notTested += 1;
        break;
      case 'NOT_APPLICABLE':
        // scope already classified — unreachable, kept for exhaustiveness
        break;
    }
  }
  return t;
}
