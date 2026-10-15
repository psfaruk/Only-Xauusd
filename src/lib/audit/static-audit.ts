/**
 * XAUUSD AI Trading Agent — Phase 1 Static Audit Report
 * ----------------------------------------------------------------------------
 * REAL evidence collected during the Phase 1 environment audit on this
 * sandbox. Every entry below was produced by an actual command execution
 * (see `evidence`). Nothing here is invented. Timestamps are UTC.
 */

export const AUDIT_PERFORMED_AT = '2026-10-14T17:40:00Z';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface EnvironmentCheck {
  id: string;
  group: 'runtime' | 'network' | 'mt5' | 'glm' | 'database';
  label: string;
  evidence: string;
  status: CheckStatus;
  note?: string;
}

export const environmentChecks: EnvironmentCheck[] = [
  {
    id: 'os',
    group: 'runtime',
    label: 'Operating System',
    evidence: 'Debian GNU/Linux 13 (trixie) · kernel 5.10.134 x86_64 · 2 vCPU · 4.1 GB RAM · 8.0 GB disk free',
    status: 'pass',
  },
  {
    id: 'node',
    group: 'runtime',
    label: 'Node.js (managed app runtime)',
    evidence: 'node v24.21.0 · npm 11.19.0',
    status: 'pass',
    note: 'Next.js 16 dev server runs here on port 3000 (the only exposed port, behind the gateway).',
  },
  {
    id: 'bun',
    group: 'runtime',
    label: 'Bun runtime & package manager',
    evidence: 'bun 1.3.14',
    status: 'pass',
  },
  {
    id: 'python',
    group: 'runtime',
    label: 'Python 3.12 + data stack',
    evidence: 'Python 3.12.15 (venv) · pip 25.0.1 · uv 0.13.0 · numpy 2.1.3 · pandas 2.2.3',
    status: 'pass',
    note: 'Available for offline/tooling scripts. NOT the managed application runtime — the app server is Next.js (Node/Bun).',
  },
  {
    id: 'network',
    group: 'network',
    label: 'Outbound network',
    evidence: 'pypi.org → HTTP 200 (0.13s) · metatrader5.com → HTTP 200 (0.78s) · google.com → HTTP 200 (0.06s)',
    status: 'pass',
    note: 'Outbound HTTPS is reachable. In-app AI access goes through the sandbox-managed z-ai-web-dev-sdk (no external key needed).',
  },
  {
    id: 'wine',
    group: 'mt5',
    label: 'Wine (Windows runtime for MT5)',
    evidence: 'which wine wine64 → NOT FOUND',
    status: 'fail',
    note: 'MT5 Terminal cannot run inside this sandbox.',
  },
  {
    id: 'mt5-pkg',
    group: 'mt5',
    label: 'MetaTrader5 Python package',
    evidence: 'pip install --dry-run MetaTrader5 → ERROR: No matching distribution found',
    status: 'fail',
    note: 'Official PyPI wheels are Windows-only (win32/win_amd64). Confirmed incompatible with Linux.',
  },
  {
    id: 'glm-chat',
    group: 'glm',
    label: 'GLM chat completion access',
    evidence: 'z-ai SDK round-trip → model "glm-4-plus" replied "GLM_ACCESS_OK" (27 tokens). Auth is sandbox-managed — no user API key.',
    status: 'pass',
  },
  {
    id: 'glm-bengali',
    group: 'glm',
    label: 'GLM Bengali response',
    evidence: 'Prompt: "সিস্টেম কি সচল?" → "হ্যাঁ, সিস্টেম সচল আছে।" (model glm-4-plus)',
    status: 'pass',
    note: 'Bengali Chat Agent (Phase 9) is feasible on this model.',
  },
  {
    id: 'glm-tools',
    group: 'glm',
    label: 'GLM function/tool calling',
    evidence: 'Full loop in 720 ms: model called allowlisted tool get_system_health → backend executed it → result fed back → final answer. See audit/glm-tool-call.ts.',
    status: 'pass',
    note: 'Allowlist + JSON-schema validation + refusal of planned tools is enforced in src/lib/tools/registry.ts.',
  },
  {
    id: 'db',
    group: 'database',
    label: 'SQLite via Prisma',
    evidence: 'prisma db push → "Your database is now in sync" (Prisma Client v6.19.2) · db/custom.db',
    status: 'pass',
    note: '12 models defined; only SystemEvent is actively written in Phase 1.',
  },
];

// ---------------------------------------------------------------------------
// GLM verification summary (static evidence; live re-verify via /api/ai/verify)
// ---------------------------------------------------------------------------

export const glmAccess = {
  sdk: 'z-ai-web-dev-sdk (server-side only)',
  model: 'glm-4-plus',
  auth: 'sandbox-managed — no API key required from the user, no key in code',
  verifiedAt: AUDIT_PERFORMED_AT,
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
};

// ---------------------------------------------------------------------------
// MT5 feasibility
// ---------------------------------------------------------------------------

export const mt5Feasibility = {
  feasibleInSandbox: false as const,
  findings: [
    'Wine is not installed and cannot run MT5 Terminal inside this container.',
    'The official MetaTrader5 PyPI package ships Windows-only wheels — pip install fails on Linux (verified).',
    'The sandbox exposes exactly one port (3000) through a gateway; it is an app-runtime, not a persistent trading server.',
  ],
  bridgeOptions: [
    {
      id: 'linux-vps-wine',
      title: 'Linux VPS + Wine + MT5 Terminal (bridge outside sandbox)',
      detail:
        'Dedicated Debian/Ubuntu VPS runs MT5 Terminal under Wine with a small authenticated bridge service (REST + WS). This app connects to it over HTTPS. Most flexible; needs a stable VPS.',
    },
    {
      id: 'windows-vps',
      title: 'Windows VPS + MT5 native (bridge outside sandbox)',
      detail:
        'Windows VPS runs MT5 natively with the official MetaTrader5 Python package. Bridge exposes the same contract. Simplest MT5 path; needs a Windows host.',
    },
    {
      id: 'broker-api',
      title: 'Broker-side REST/feed (to be investigated in Phase 2)',
      detail:
        'If Exness offers an official REST/market-data API it can be consumed directly. Phase 2 will investigate; no assumption is made now.',
    },
  ],
  phase2Plan: [
    'Define the Bridge Contract: /health, /symbol/resolve, /snapshot, /candles — with auth token, timestamps, quality flags (ok | stale | suspicious).',
    'Market data quality gate: stale data, invalid prices and market-closed states must never produce a signal.',
    'Symbol resolution against the live Exness demo account (XAUUSD vs XAUUSDm vs GOLD) — detected, never hardcoded.',
    'Read-only: the bridge contract contains NO order-sending endpoints in Phase 2.',
  ],
};

// ---------------------------------------------------------------------------
// Database models (foundation schema)
// ---------------------------------------------------------------------------

export const databaseModels = [
  { name: 'SystemEvent', purpose: 'Audit trail — every significant system action', phase: 1, status: 'active' as const },
  { name: 'MarketCandle', purpose: 'OHLC candles per symbol/timeframe with quality flags', phase: 3, status: 'planned' as const },
  { name: 'MarketTick', purpose: 'Bid/ask/spread ticks', phase: 3, status: 'planned' as const },
  { name: 'AnalysisRun', purpose: 'Reproducible analysis inputs & results', phase: 4, status: 'planned' as const },
  { name: 'Signal', purpose: 'BUY/SELL/WAIT with entry, SL, TP, expiry', phase: 5, status: 'planned' as const },
  { name: 'AiReview', purpose: 'GLM agent verdicts (analyst/critic/risk reviewer)', phase: 6, status: 'planned' as const },
  { name: 'RiskCheck', purpose: 'Deterministic risk-gate results', phase: 7, status: 'planned' as const },
  { name: 'TradeApproval', purpose: 'User approval records (locked until Phase 11)', phase: 11, status: 'planned' as const },
  { name: 'ExecutionLog', purpose: 'Order request/result audit (locked until Phase 11)', phase: 11, status: 'planned' as const },
];

// ---------------------------------------------------------------------------
// Security measures (Phase 1)
// ---------------------------------------------------------------------------

export const securityMeasures = [
  {
    measure: 'No secrets in code or repo',
    detail: 'Only .env (git-ignored) holds values. .env.example ships placeholders. Verified: .gitignore excludes .env.',
  },
  {
    measure: 'Secret masking in all logs',
    detail: 'logger.maskSecrets() redacts key/token/password patterns before any SystemEvent row or console line is written.',
  },
  {
    measure: 'Execution hard-locked in code',
    detail: 'config.ts computes executionEnabled = false unless phase ≥ 11 AND EXECUTION_ARMED AND ALLOW_EXECUTION AND mode ≠ read_only. No Phase 1 code path can send orders.',
  },
  {
    measure: 'AI cannot touch the system directly',
    detail: 'GLM only sees allowlisted tools (src/lib/tools/registry.ts). No shell, no SQL, no network tool. Planned tools are refused at runtime with an explicit error.',
  },
  {
    measure: 'Server-only AI access',
    detail: 'z-ai-web-dev-sdk is imported exclusively inside API routes; the client bundle never sees it.',
  },
  {
    measure: 'Audit trail is append-only in practice',
    detail: 'The UI reads SystemEvent rows; no endpoint exists to edit or delete them.',
  },
  {
    measure: 'GLM verify rate-limit',
    detail: '/api/ai/verify enforces a configurable minimum interval (default 10 s) to prevent accidental token burn.',
  },
];

// ---------------------------------------------------------------------------
// Architecture layers (rendered as diagram in the dashboard)
// ---------------------------------------------------------------------------

export const architectureLayers = [
  {
    id: 'dashboard',
    title: 'Web Dashboard + Chat (Bengali)',
    tech: 'Next.js 16 · React 19 · Tailwind 4 · shadcn/ui',
    detail: 'Single-route app: live status, audit report, GLM verify panel, event stream. Chat Agent arrives in Phase 9.',
    phase: '1 (foundation) → 9 (chat)',
  },
  {
    id: 'api',
    title: 'Backend API (Next.js route handlers)',
    tech: 'TypeScript · Node 24 · port 3000 behind gateway',
    detail: '/api/health · /api/audit/environment · /api/ai/verify — growing per phase (analysis, signals, approvals).',
    phase: '1 → 8',
  },
  {
    id: 'glm',
    title: 'GLM Orchestrator (z-ai-web-dev-sdk)',
    tech: 'model glm-4-plus · server-side only',
    detail: 'Tool selection within allowlist, Bengali explanation, multi-agent roles (Phase 6). Never overrides deterministic engines.',
    phase: '1 (verify) → 6 (agents)',
  },
  {
    id: 'tools',
    title: 'Allowlisted Tool Registry',
    tech: 'src/lib/tools/registry.ts',
    detail: 'JSON-schema validated function calls. 1 active tool (get_system_health), 8 planned tools refused until their phase.',
    phase: '1 → 8',
  },
  {
    id: 'engines',
    title: 'Deterministic Engines (Python-spec, TS impl)',
    tech: 'Market structure, indicators, entry/SL/TP, risk gate',
    detail: 'Pure, testable calculations. AI reviews them; AI can never override them. Implemented in Phases 4-5 and 7.',
    phase: '4-7 (planned)',
  },
  {
    id: 'bridge',
    title: 'MT5 Bridge (EXTERNAL — outside sandbox)',
    tech: 'Linux VPS + Wine / Windows VPS — REST+WS contract',
    detail: 'MT5 cannot run in this sandbox (verified). All market data flows through an authenticated bridge defined in Phase 2.',
    phase: '2 (planned)',
  },
  {
    id: 'data',
    title: 'SQLite + Prisma',
    tech: 'db/custom.db · 12 models',
    detail: 'SystemEvent active now; market/analysis/signal/risk/approval/execution tables defined and phase-gated.',
    phase: '1 → 11',
  },
];

// ---------------------------------------------------------------------------
// Repository tree (as delivered in Phase 1)
// ---------------------------------------------------------------------------

export const repositoryTree = `xauusd-ai-trading-agent/
├── .env.example            # placeholders only — no secrets
├── .gitignore              # .env, node_modules, .next, db, logs excluded
├── README.md               # project guide (bilingual)
├── package.json            # scripts: dev / lint / db:push
├── prisma/schema.prisma    # 12 models, phase-tagged
├── db/custom.db            # SQLite database (git-ignored)
├── audit/
│   └── glm-tool-call.ts    # Phase 1 evidence: GLM tool-calling round-trip
├── src/
│   ├── app/
│   │   ├── layout.tsx      # Bengali-capable fonts, metadata
│   │   ├── page.tsx        # the ONLY user-visible route (dashboard)
│   │   └── api/
│   │       ├── health/route.ts
│   │       ├── audit/environment/route.ts
│   │       └── ai/verify/route.ts
│   ├── components/ui/      # shadcn/ui (scaffold)
│   └── lib/
│       ├── config.ts       # env + execution safety gate
│       ├── db.ts           # Prisma client singleton
│       ├── health.ts       # live health collector
│       ├── logger.ts       # audit logger + secret masking
│       ├── audit/static-audit.ts   # Phase 1 evidence
│       └── tools/registry.ts       # allowlisted tool registry
└── worklog.md              # multi-agent work journal`;

// ---------------------------------------------------------------------------
// Phase 1 acceptance checklist
// ---------------------------------------------------------------------------

export const acceptanceChecklist = [
  { id: 'audit', label: 'Environment audit completed with real command evidence', done: true },
  { id: 'glm', label: 'GLM access verified (chat, Bengali, tool calling)', done: true },
  { id: 'glm-live', label: 'Live re-verification available via /api/ai/verify', done: true },
  { id: 'mt5', label: 'MT5 infeasibility proven & bridge options documented', done: true },
  { id: 'schema', label: 'Foundation DB schema pushed (12 models, phase-gated)', done: true },
  { id: 'config', label: 'Config module with hard execution lock', done: true },
  { id: 'logger', label: 'Audit logger with secret masking', done: true },
  { id: 'registry', label: 'Allowlisted tool registry (1 active / 8 planned)', done: true },
  { id: 'apis', label: 'Health + audit + GLM-verify APIs live', done: true },
  { id: 'dashboard', label: 'Phase 1 dashboard renders with live data', done: true },
  { id: 'readonly', label: 'No order-execution code exists anywhere', done: true },
  { id: 'docs', label: 'README, .env.example, worklog maintained', done: true },
];
