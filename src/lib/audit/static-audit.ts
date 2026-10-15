/**
 * XAUUSD AI Trading Agent — Static Audit Metadata (Phase 1 → updated Phase 9)
 * ----------------------------------------------------------------------------
 * HISTORICAL EVIDENCE: the Phase 1 command results now live in
 * src/lib/audit/historical.ts (verbatim, phase-tagged, original timestamps).
 * The old `environmentChecks` export is kept ONLY as a deprecated alias so
 * older consumers keep compiling — the v2 audit API and dashboard use the
 * versioned model in src/lib/audit/{model,report,runtime-checks}.ts.
 *
 * CURRENT METADATA (reconciled in Phase 9, Task A5): the sections below
 * describe the CURRENT architecture — the TypeScript WebSocket bridge inside
 * this sandbox (mini-services/mt5-bridge, :3031), NOT the obsolete
 * "external VPS + Wine" plan from Phase 1.
 */

import { phase1HistoricalChecks } from './historical';

export const AUDIT_PERFORMED_AT = '2026-10-14T17:40:00Z'; // Phase 1 (historical)

// ---------------------------------------------------------------------------
// DEPRECATED — Phase 1 checklist shape. Kept for backward compatibility only.
// The dashboard's audit tab consumes the v2 model; nothing should render this
// as a CURRENT verdict.
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface EnvironmentCheck {
  id: string;
  group: 'runtime' | 'network' | 'mt5' | 'glm' | 'database';
  label: string;
  evidence: string;
  status: CheckStatus;
  note?: string;
}

/** @deprecated Use buildEnvironmentAuditReport() (v2) instead. */
export const environmentChecks: EnvironmentCheck[] = phase1HistoricalChecks().map((c) => ({
  id: c.id.replace('phase1.', ''),
  group: (c.category === 'legacy-dependency' ? 'mt5' : c.category === 'glm' ? 'glm' : c.category === 'database' ? 'database' : 'runtime') as EnvironmentCheck['group'],
  label: c.description.replace('[Phase 1] ', ''),
  evidence: `${c.evidence} [ঐতিহাসিক প্রমাণ — Phase 1, ${c.historical?.performedAtUtc ?? ''}]`,
  status: c.status === 'PASS' ? 'pass' : c.status === 'FAIL' ? 'fail' : 'warn',
  note: c.reason,
}));

// ---------------------------------------------------------------------------
// GLM verification summary (Phase 1 evidence; live status via /api/ai/verify
// and the latest GLM_VERIFY_* SystemEvent — see runtime-checks.ts)
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
// MT5 architecture — CURRENT state (Phase 9 reconciliation)
// ---------------------------------------------------------------------------

export const mt5Feasibility = {
  /** The CURRENT architecture runs the bridge INSIDE this sandbox. */
  currentArchitecture: {
    id: 'ts-websocket-bridge',
    title: 'TypeScript MT5 web-terminal bridge (CURRENT — running since Phase 8)',
    detail:
      'mini-services/mt5-bridge (:3031) dials the Exness-MT5Trial6 gateways DIRECTLY by IP over the MT5 web-terminal protocol (TLS verified, SNI mt5.exwebterm.com): AUTH → LOGIN → SYMBOLS → SUBSCRIBE → QUOTES / CANDLES. READ-ONLY: no trading commands are implemented; the REST surface is GET-only with x-trader-key auth.',
    status: 'deployed-and-verified' as const,
  },
  /** The Phase 1 study — preserved as history, no longer the plan. */
  historicalStudy: {
    feasibleInSandbox: false as const,
    findings: [
      'Wine is not installed and cannot run MT5 Terminal inside this container (Phase 1 finding — historical).',
      'The official MetaTrader5 PyPI package ships Windows-only wheels — pip install fails on Linux (Phase 1 finding — historical).',
      'CONCLUSION SUPERSEDED: MT5 Terminal is NOT needed — the web-terminal protocol bridge replaced this whole approach in Phase 8.',
    ],
    supersededBy: 'ts-websocket-bridge (Phase 8)',
  },
} as const;

// ---------------------------------------------------------------------------
// Database models — CURRENT activation status (Phase 9 reconciliation)
// ---------------------------------------------------------------------------

export const databaseModels = [
  { name: 'SystemEvent', purpose: 'Audit trail — every significant system action', phase: 1, status: 'active' as const },
  { name: 'MarketCandle', purpose: 'Verified broker OHLC candles per symbol/timeframe', phase: 3, status: 'active' as const },
  { name: 'MarketLatestTick', purpose: 'Latest bid/ask/spread snapshot per symbol', phase: 3, status: 'active' as const },
  { name: 'SymbolSpec', purpose: 'Verified symbol specifications (digits, point)', phase: 3, status: 'active' as const },
  { name: 'DataQualityIssue', purpose: 'Bounded data-quality check outcomes', phase: 3, status: 'active' as const },
  { name: 'SyncRun', purpose: 'Honest bookkeeping of every ingestion run', phase: 3, status: 'active' as const },
  { name: 'AnalysisRun', purpose: 'Reproducible deterministic analysis runs', phase: 4, status: 'active' as const },
  { name: 'BacktestRun', purpose: 'Backtest simulations over verified candles', phase: 8, status: 'active' as const },
  { name: 'SignalEvaluation', purpose: 'Deterministic signal-engine evaluations (append-only)', phase: 9, status: 'active' as const },
  { name: 'Signal', purpose: 'Legacy Phase-1 signal shape (0 rows — superseded by SignalEvaluation)', phase: 5, status: 'superseded' as const },
  { name: 'AiReview', purpose: 'GLM multi-agent reviews', phase: 6, status: 'planned' as const },
  { name: 'RiskCheck', purpose: 'Deterministic risk-gate results', phase: 7, status: 'planned' as const },
  { name: 'TradeApproval', purpose: 'User approval records (locked until Phase 11)', phase: 11, status: 'locked' as const },
  { name: 'ExecutionLog', purpose: 'Order request/result audit (locked until Phase 11)', phase: 11, status: 'locked' as const },
];

// ---------------------------------------------------------------------------
// Security measures (Phase 1 → extended Phase 9)
// ---------------------------------------------------------------------------

export const securityMeasures = [
  {
    measure: 'No secrets in code or repo',
    detail: 'Only .env (git-ignored) holds values. .env.example ships placeholders. Verified: .gitignore excludes .env; runtime DBs are untracked.',
  },
  {
    measure: 'Secret masking in all logs',
    detail: 'logger.maskSecrets() redacts key/token/password patterns before any SystemEvent row or console line is written.',
  },
  {
    measure: 'Execution hard-locked in code',
    detail: 'config.ts computes executionEnabled = false unless phase ≥ 11 AND EXECUTION_ARMED AND ALLOW_EXECUTION AND mode ≠ read_only. No Phase 9 code path can send orders — none exists.',
  },
  {
    measure: 'AI cannot touch the system directly',
    detail: 'GLM only sees allowlisted tools (src/lib/tools/registry.ts). No shell, no SQL, no network tool, no execution tool. Planned tools are refused at runtime.',
  },
  {
    measure: 'Server-only AI access',
    detail: 'z-ai-web-dev-sdk is imported exclusively inside API routes; the client bundle never sees it.',
  },
  {
    measure: 'Bridge is read-only by construction',
    detail: 'The bridge REST surface is GET-only (405 otherwise) with x-trader-key auth; the WS client implements no trading command ids. Credentials stay in env → memory → LOGIN frame only; the login is reported masked (414•••70).',
  },
  {
    measure: 'Fail-closed API guards',
    detail: 'Trigger endpoints (sync/analysis/backtest/signal runs) require DATA_API_TOKEN always (503 when unset). Reads require the token when set; public reads are an explicit, documented preview-only opt-in.',
  },
  {
    measure: 'Audit trail is append-only in practice',
    detail: 'The UI reads SystemEvent/AnalysisRun/SignalEvaluation rows; no endpoint exists to edit or delete them. Signal evaluations are never overwritten.',
  },
  {
    measure: 'Chat Agent bounded',
    detail: 'POST /api/chat: message-size caps, bounded history, bounded tool rounds, stricter per-IP rate limit, allowlisted read-only tools only, deterministic state always rendered separately from LLM text.',
  },
];

// ---------------------------------------------------------------------------
// Architecture layers (CURRENT — Phase 9)
// ---------------------------------------------------------------------------

export const architectureLayers = [
  {
    id: 'dashboard',
    title: 'Web Dashboard + Bengali Chat (Next.js 16)',
    tech: 'React 19 · Tailwind 4 · shadcn/ui · single route /',
    detail: 'Status KPIs, environment audit v2, market data, analysis, data health, SIGNAL tab, Bengali CHAT tab, architecture, security.',
    phase: '1 → 9 (active)',
  },
  {
    id: 'api',
    title: 'Backend API (Next.js route handlers)',
    tech: 'TypeScript · Node 24 · port 3000 behind gateway',
    detail: 'health · audit/environment (v2) · ai/verify · data/* · analysis/* · backtest/* · signal/* · chat — triggers token-guarded, reads guarded.',
    phase: '1 → 9 (active)',
  },
  {
    id: 'glm',
    title: 'GLM Orchestrator (z-ai-web-dev-sdk)',
    tech: 'model glm-4-plus · server-side only',
    detail: 'Bengali Chat Agent with allowlisted read-only tools. Explains deterministic results; can never override them.',
    phase: '1 (verify) → 9 (chat — active)',
  },
  {
    id: 'tools',
    title: 'Allowlisted Tool Registry',
    tech: 'src/lib/tools/registry.ts',
    detail: 'JSON-schema validated function calls. Active: get_system_health + 7 Phase 9 market/signal/backtest read-only tools. No execution tool exists.',
    phase: '1 → 9 (active)',
  },
  {
    id: 'engines',
    title: 'Deterministic Engines (TypeScript)',
    tech: 'src/lib/{analysis,signal,backtest}',
    detail: 'Market structure (swings/BOS/CHoCH), indicators (EMA/RSI/ATR/ADX), SIGNAL ENGINE (setup outcomes, entry/SL/target, fail-closed gates), backtest simulator. AI reviews them; AI can never override them.',
    phase: '4 → 9 (active)',
  },
  {
    id: 'integrity',
    title: 'Data Integrity Monitor',
    tech: 'src/lib/market/integrity.ts',
    detail: 'Source classification (broker/relay/cache/synthetic), freshness lifecycle (LIVE/STALE/DEGRADED/DISCONNECTED), candle-history audit, signal gating.',
    phase: '8 (active)',
  },
  {
    id: 'bridge',
    title: 'MT5 Bridge — INTERNAL TypeScript service (CURRENT)',
    tech: 'mini-services/mt5-bridge · :3031 · MT5 web-terminal protocol',
    detail: 'Dials Exness-MT5Trial6 gateways directly (TLS verified). AUTH/LOGIN/SYMBOLS/SUBSCRIBE/QUOTES/CANDLES/HEARTBEAT only — trading commands deliberately not ported. GET-only REST with x-trader-key.',
    phase: '8 (active — replaced the Phase 1 "external VPS + Wine" plan)',
  },
  {
    id: 'data',
    title: 'SQLite + Prisma',
    tech: 'db/custom.db · 14 models (9 active, 2 planned, 1 superseded, 2 locked)',
    detail: 'SystemEvent, MarketCandle, MarketLatestTick, SymbolSpec, DataQualityIssue, SyncRun, AnalysisRun, BacktestRun, SignalEvaluation active. TradeApproval/ExecutionLog locked until Phase 11.',
    phase: '1 → 11',
  },
];

// ---------------------------------------------------------------------------
// Repository tree (as of Phase 9)
// ---------------------------------------------------------------------------

export const repositoryTree = `xauusd-ai-trading-agent/
├── .env.example            # placeholders only — no secrets
├── .gitignore              # .env*, db/*.db excluded; .env.example kept
├── README.md               # bilingual project guide
├── package.json            # dev / lint / test / db:* / market:* / bridge:dev
├── prisma/schema.prisma    # 14 models, phase-tagged + migrations/
├── db/custom.db            # SQLite (git-untracked, re-syncable)
├── audit/                  # phase reports + evidence (phase1…phase9)
├── mini-services/
│   └── mt5-bridge/         # READ-ONLY TS bridge (:3031) — GET-only REST
├── scripts/                # mt5-smoke-test, sync-market, phase8/9 audits
├── src/
│   ├── app/
│   │   ├── layout.tsx      # Bengali fonts, metadata
│   │   ├── page.tsx        # the ONLY user-visible route (dashboard)
│   │   └── api/
│   │       ├── health/ · audit/environment/ · ai/verify/
│   │       ├── data/{status,candles,latest,quality,sync-status,sync,health}/
│   │       ├── analysis/{run,latest}/
│   │       ├── backtest/{run,latest}/
│   │       ├── signal/{run,latest,history}/
│   │       └── chat/       # Bengali chat agent (allowlisted tools)
│   ├── components/ui/      # shadcn/ui
│   └── lib/
│       ├── config.ts       # env + 4-switch execution lock + signal/chat cfg
│       ├── db.ts · logger.ts · health.ts · api-guard.ts
│       ├── audit/          # v2 model · runtime checks · historical evidence
│       ├── market/         # bridge client · ingestion · quality · integrity
│       ├── analysis/       # swings · structure · indicators · engine
│       ├── signal/         # rules · core · service · persistence · schemas
│       ├── backtest/       # engine (proxy) · signal-engine validation
│       ├── chat/           # Bengali agent (tool loop)
│       └── tools/          # allowlisted tool registry
└── tests/                  # bun:test — market · analysis · signal · backtest · audit · chat
└── worklog.md              # multi-agent work journal`;

// ---------------------------------------------------------------------------
// Phase 1 acceptance checklist (HISTORICAL — kept verbatim as history)
// ---------------------------------------------------------------------------

export const acceptanceChecklist = [
  { id: 'audit', label: 'Environment audit completed with real command evidence (Phase 1 — historical)', done: true },
  { id: 'glm', label: 'GLM access verified (chat, Bengali, tool calling) (Phase 1 — historical)', done: true },
  { id: 'glm-live', label: 'Live re-verification available via /api/ai/verify (still active)', done: true },
  { id: 'mt5', label: 'MT5 infeasibility proven & bridge options documented (Phase 1 — superseded by the TS bridge)', done: true },
  { id: 'schema', label: 'Foundation DB schema pushed (models phase-tagged)', done: true },
  { id: 'config', label: 'Config module with hard execution lock', done: true },
  { id: 'logger', label: 'Audit logger with secret masking', done: true },
  { id: 'registry', label: 'Allowlisted tool registry (active tools grow per phase)', done: true },
  { id: 'apis', label: 'Health + audit + GLM-verify APIs live', done: true },
  { id: 'dashboard', label: 'Dashboard renders with live data', done: true },
  { id: 'readonly', label: 'No order-execution code exists anywhere', done: true },
  { id: 'docs', label: 'README, .env.example, worklog maintained', done: true },
];
