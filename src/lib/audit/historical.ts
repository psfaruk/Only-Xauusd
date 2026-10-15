/**
 * XAUUSD AI Trading Agent — Historical (Phase 1) Audit Evidence (Phase 9, Task A2)
 * ----------------------------------------------------------------------------
 * The ORIGINAL Phase 1 environment-audit results, preserved VERBATIM as
 * historical evidence. These were produced by real command executions during
 * the Phase 1 audit on 2026-10-14 (see git history / audit/phase1-* artifacts).
 *
 * Rules enforced here:
 *   · The original timestamp is NEVER presented as a newly executed check.
 *   · A historical FAIL (wine, MetaTrader5 Python package) stays a historical
 *     fact — it describes the Phase 1 MT5-terminal feasibility study, not the
 *     current TypeScript-bridge architecture (see runtime-checks.ts for the
 *     current NOT_APPLICABLE verdicts with code-inspection evidence).
 *   · Nothing in this file is ever mixed into the current-required totals.
 */

import type { AuditCheckResult } from './model';

export const PHASE1_AUDIT_PERFORMED_AT = '2026-10-14T17:40:00Z';

type Phase1Status = 'pass' | 'warn' | 'fail';
interface Phase1Check {
  id: string;
  group: string;
  label: string;
  evidence: string;
  status: Phase1Status;
  note?: string;
  command?: string;
}

/** Verbatim Phase 1 command-evidence table (unchanged values). */
const PHASE1_CHECKS: Phase1Check[] = [
  {
    id: 'os',
    group: 'runtime',
    label: 'Operating System',
    evidence: 'Debian GNU/Linux 13 (trixie) · kernel 5.10.134 x86_64 · 2 vCPU · 4.1 GB RAM · 8.0 GB disk free',
    status: 'pass',
    command: 'uname -a / os-release inspection during Phase 1 audit',
  },
  {
    id: 'node',
    group: 'runtime',
    label: 'Node.js (managed app runtime)',
    evidence: 'node v24.21.0 · npm 11.19.0',
    status: 'pass',
    note: 'Next.js 16 dev server runs here on port 3000 (the only exposed port, behind the gateway).',
    command: 'node --version && npm --version',
  },
  {
    id: 'bun',
    group: 'runtime',
    label: 'Bun runtime & package manager',
    evidence: 'bun 1.3.14',
    status: 'pass',
    command: 'bun --version',
  },
  {
    id: 'python',
    group: 'runtime',
    label: 'Python 3.12 + data stack',
    evidence: 'Python 3.12.15 (venv) · pip 25.0.1 · uv 0.13.0 · numpy 2.1.3 · pandas 2.2.3',
    status: 'pass',
    note: 'Available for offline/tooling scripts. NOT the managed application runtime — the app server is Next.js (Node/Bun).',
    command: 'python3 --version && pip list (venv)',
  },
  {
    id: 'network',
    group: 'network',
    label: 'Outbound network',
    evidence: 'pypi.org → HTTP 200 (0.13s) · metatrader5.com → HTTP 200 (0.78s) · google.com → HTTP 200 (0.06s)',
    status: 'pass',
    command: 'curl -o /dev/null -w "%{http_code}" https://<host> (three hosts)',
  },
  {
    id: 'wine',
    group: 'mt5',
    label: 'Wine (Windows runtime for MT5 Terminal)',
    evidence: 'which wine wine64 → NOT FOUND',
    status: 'fail',
    note: 'MT5 Terminal cannot run inside this sandbox (Phase 1 finding — the current architecture no longer needs Wine; see NOT_APPLICABLE entry dep.wine).',
    command: 'which wine wine64',
  },
  {
    id: 'mt5-pkg',
    group: 'mt5',
    label: 'MetaTrader5 Python package',
    evidence: 'pip install --dry-run MetaTrader5 → ERROR: No matching distribution found',
    status: 'fail',
    note: 'Official PyPI wheels are Windows-only (win32/win_amd64). Confirmed incompatible with Linux (Phase 1 finding — the current architecture no longer needs this package; see NOT_APPLICABLE entry dep.metatrader5-python).',
    command: 'pip install --dry-run MetaTrader5',
  },
  {
    id: 'glm-chat',
    group: 'glm',
    label: 'GLM chat completion access',
    evidence: 'z-ai SDK round-trip → model "glm-4-plus" replied "GLM_ACCESS_OK" (27 tokens). Auth is sandbox-managed — no user API key.',
    status: 'pass',
    command: 'server-side z-ai-web-dev-sdk round-trip (audit/glm-tool-call.ts)',
  },
  {
    id: 'glm-bengali',
    group: 'glm',
    label: 'GLM Bengali response',
    evidence: 'Prompt: "সিস্টেম কি সচল?" → "হ্যাঁ, সিস্টেম সচল আছে।" (model glm-4-plus)',
    status: 'pass',
    command: 'server-side z-ai-web-dev-sdk Bengali round-trip',
  },
  {
    id: 'glm-tools',
    group: 'glm',
    label: 'GLM function/tool calling',
    evidence: 'Full loop in 720 ms: model called allowlisted tool get_system_health → backend executed it → result fed back → final answer. See audit/glm-tool-call.ts.',
    status: 'pass',
    command: 'server-side tool-calling loop (audit/glm-tool-call.ts)',
  },
  {
    id: 'db',
    group: 'database',
    label: 'SQLite via Prisma',
    evidence: 'prisma db push → "Your database is now in sync" (Prisma Client v6.19.2) · db/custom.db',
    status: 'pass',
    command: 'prisma db push',
  },
];

const STATUS_MAP: Record<Phase1Status, AuditCheckResult['status']> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
};

const GROUP_MAP: Record<string, AuditCheckResult['category']> = {
  runtime: 'runtime',
  network: 'runtime',
  mt5: 'legacy-dependency',
  glm: 'glm',
  database: 'database',
};

/** Phase 1 evidence as historical AuditCheckResults (scope: historical). */
export function phase1HistoricalChecks(): AuditCheckResult[] {
  return PHASE1_CHECKS.map((c) => ({
    id: `phase1.${c.id}`,
    category: GROUP_MAP[c.group] ?? 'runtime',
    description: `[Phase 1] ${c.label}`,
    required: false, // historical evidence is informational for the current system
    expected: 'Recorded as executed during the Phase 1 environment audit.',
    actual: c.status === 'pass' ? 'passed (as executed then)' : c.status === 'fail' ? 'failed (as executed then)' : 'warned (as executed then)',
    evidenceType: 'COMMAND' as const,
    evidenceCommand: c.command ?? 'Phase 1 audit procedure',
    startedAtUtc: null,
    completedAtUtc: PHASE1_AUDIT_PERFORMED_AT,
    runtimeIdentity: 'phase-1-foundation',
    exitCodeOrHttpStatus: null,
    durationMs: null,
    evidence: c.evidence,
    status: STATUS_MAP[c.status],
    reason:
      c.status === 'fail'
        ? `Historical Phase 1 FAIL — an obstacle found during the original MT5-terminal feasibility study. ${
            c.note ?? ''
          } This is NOT a statement about the current bridge architecture; the current equivalents are the dep.* NOT_APPLICABLE entries and the live bridge checks.`
        : (c.note ?? 'Historical Phase 1 evidence — preserved verbatim, not re-executed.'),
    freshnessPolicy: 'historical-phase1' as const,
    scope: 'historical' as const,
    historical: { phase: 1, performedAtUtc: PHASE1_AUDIT_PERFORMED_AT },
  }));
}

/** Phase 1 GLM verification summary — historical reference (live status comes
 *  from the latest persisted GLM_VERIFY SystemEvent in runtime-checks.ts). */
export const PHASE1_GLM_SUMMARY = {
  sdk: 'z-ai-web-dev-sdk (server-side only)',
  model: 'glm-4-plus',
  auth: 'sandbox-managed — no API key required from the user, no key in code',
  verifiedAt: PHASE1_AUDIT_PERFORMED_AT,
  capabilities: {
    chatCompletion: true,
    bengali: true,
    toolCalling: true,
    toolCallRoundTripMs: 720,
  },
  sample: {
    prompt: 'Reply with exactly this token and nothing else: GLM_ACCESS_OK',
    response: 'GLM_ACCESS_OK',
  },
} as const;
