/**
 * PHASE 9 ENVIRONMENT-AUDIT v2 TESTS.
 * ----------------------------------------------------------------------------
 * Pinned behaviors (spec Task G):
 *   · the old Wine / MetaTrader5-Python checks are NOT misreported as current
 *     mandatory dependencies (they are NOT_APPLICABLE + preserved historical)
 *   · NOT_APPLICABLE never counts as PASS (totals)
 *   · NOT_TESTED / stale evidence never counts as PASS
 *   · runtime checks carry fresh timestamps + evidence provenance
 *   · a failed live bridge probe produces FAIL (or BLOCKED), never PASS
 *   · audit endpoints reject unauthorized requests (guard posture)
 *   · no secrets leak into the report
 *   · no client-suppliable commands exist (fixed check ids only)
 *
 * MOCK DISCLOSURE: bridge probes run against the local MOCK bridge with
 * synthetic data (tests/market/helpers/mock-bridge.ts) — never a real broker.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import '../market/helpers/setup';
import { computeTotals, type AuditCheckResult } from '@/lib/audit/model';
import { phase1HistoricalChecks } from '@/lib/audit/historical';
import { runCurrentChecks, POST_ROUTE_INVENTORY, type CurrentCheckDeps } from '@/lib/audit/runtime-checks';
import { buildEnvironmentAuditReport } from '@/lib/audit/report';
import { startMockBridge, defaultMockState } from '../market/helpers/mock-bridge';
import { createBridgeClient } from '@/lib/market/bridge-client';
import { config } from '@/lib/config';

type MockBridgeHandle = Awaited<ReturnType<typeof startMockBridge>>;

let bridge: MockBridgeHandle;
let deps: CurrentCheckDeps;

beforeAll(async () => {
  bridge = await startMockBridge({ ...defaultMockState(), server: config.bridge.expectedServer });
  deps = { bridge: createBridgeClient({ baseUrl: bridge.url, timeoutMs: 2000, maxRetries: 0 }) };
});

afterAll(() => {
  bridge?.stop();
});

describe('audit v2 — status model arithmetic', () => {
  test('NOT_APPLICABLE never counts as PASS in the totals', () => {
    const checks: AuditCheckResult[] = [
      mk('a', 'PASS', 'current-required'),
      mk('b', 'NOT_APPLICABLE', 'not-applicable'),
      mk('c', 'NOT_APPLICABLE', 'not-applicable'),
    ];
    const totals = computeTotals(checks);
    expect(totals.currentRequired.pass).toBe(1);
    expect(totals.currentRequired.total).toBe(1);
    expect(totals.notApplicable).toBe(2);
  });

  test('NOT_TESTED never counts as PASS (and is surfaced separately)', () => {
    const checks: AuditCheckResult[] = [
      mk('a', 'PASS', 'current-required'),
      mk('b', 'NOT_TESTED', 'current-required'),
    ];
    const totals = computeTotals(checks);
    expect(totals.currentRequired.pass).toBe(1);
    expect(totals.currentRequired.total).toBe(2);
    expect(totals.notTested).toBe(1);
  });

  test('historical entries never mix into current-required totals', () => {
    const checks: AuditCheckResult[] = [
      ...phase1HistoricalChecks(),
      mk('a', 'PASS', 'current-required'),
    ];
    const totals = computeTotals(checks);
    expect(totals.historical).toBe(11);
    expect(totals.currentRequired.pass).toBe(1);
    expect(totals.currentRequired.total).toBe(1);
  });

  test('a FAIL is reported as a FAIL — never silently upgraded', () => {
    const checks: AuditCheckResult[] = [mk('a', 'FAIL', 'current-required')];
    const totals = computeTotals(checks);
    expect(totals.currentRequired.fail).toBe(1);
    expect(totals.currentRequired.pass).toBe(0);
  });
});

describe('audit v2 — historical evidence (Phase 1) stays historical', () => {
  test('wine and MetaTrader5-Python appear exactly once as historical entries with their ORIGINAL timestamps', () => {
    const hist = phase1HistoricalChecks();
    const wine = hist.find((c) => c.id === 'phase1.wine');
    const mt5pkg = hist.find((c) => c.id === 'phase1.mt5-pkg');
    expect(wine).toBeDefined();
    expect(mt5pkg).toBeDefined();
    expect(wine!.status).toBe('FAIL');
    expect(mt5pkg!.status).toBe('FAIL');
    expect(wine!.scope).toBe('historical');
    expect(wine!.historical?.phase).toBe(1);
    expect(wine!.historical?.performedAtUtc).toBe('2026-10-14T17:40:00Z');
    expect(wine!.freshnessPolicy).toBe('historical-phase1');
    expect(hist).toHaveLength(11);
  });

  test('historical entries carry evidence type COMMAND and never claim per-request freshness', () => {
    for (const c of phase1HistoricalChecks()) {
      expect(c.evidenceType).toBe('COMMAND');
      expect(c.freshnessPolicy).not.toBe('per-request');
    }
  });
});

describe('audit v2 — current runtime checks (mock bridge)', () => {
  test('current checks include the bridge architecture as SEPARATE checks (health ≠ auth ≠ quote ≠ candles)', async () => {
    bridge.state.source = 'mt5';
    bridge.state.connected = true;
    bridge.state.authenticated = true;
    bridge.state.quote = { bid: 2650.1, ask: 2650.34, ts: Math.floor(Date.now() / 1000) };
    bridge.state.quoteAgeMs = 0;
    const checks = await runCurrentChecks('XAUUSDm', deps);
    const ids = checks.filter((c) => c.scope === 'current-required').map((c) => c.id);
    expect(ids).toContain('bridge.health');
    expect(ids).toContain('bridge.authenticated-session');
    expect(ids).toContain('bridge.server-identity');
    expect(ids).toContain('data.symbol-resolution');
    expect(ids).toContain('data.fresh-quote');
    expect(ids).toContain('data.candle-history');
    expect(ids).toContain('signal.engine-readiness');
    expect(ids).toContain('security.execution-lock');
    expect(ids).toContain('security.read-only-surface');
  });

  test('legacy dependencies are NOT_APPLICABLE — with code-inspection evidence, not hidden failures', async () => {
    const checks = await runCurrentChecks('XAUUSDm', deps);
    const wine = checks.find((c) => c.id === 'dep.wine');
    const mt5pkg = checks.find((c) => c.id === 'dep.metatrader5-python');
    expect(wine?.status).toBe('NOT_APPLICABLE');
    expect(mt5pkg?.status).toBe('NOT_APPLICABLE');
    expect(wine?.scope).toBe('not-applicable');
    // The verdict MUST cite the code inspection — never a blind PASS.
    expect(wine?.evidence).toContain('TypeScript WebSocket bridge');
    expect(wine?.evidence).toContain('phase1.wine');
  });

  test('a healthy authenticated mock feed yields PASS on the bridge + quote checks with fresh timestamps', async () => {
    bridge.state.source = 'mt5';
    bridge.state.connected = true;
    bridge.state.authenticated = true;
    bridge.state.quote = { bid: 2650.1, ask: 2650.34, ts: Math.floor(Date.now() / 1000) };
    bridge.state.quoteAgeMs = 0;
    const checks = await runCurrentChecks('XAUUSDm', deps);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId['bridge.health'].status).toBe('PASS');
    expect(byId['bridge.authenticated-session'].status).toBe('PASS');
    expect(byId['data.fresh-quote'].status).toBe('PASS');
    expect(byId['data.fresh-quote'].evidenceType).toBe('LIVE_BROKER');
    // Fresh provenance: timestamps exist and are recent.
    expect(byId['bridge.health'].completedAtUtc).toBeTruthy();
    expect(new Date(byId['bridge.health'].completedAtUtc!).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(typeof byId['bridge.health'].durationMs).toBe('number');
  });

  test('a FAILED live bridge probe produces FAIL (never PASS) — bridge down', async () => {
    bridge.state.connected = false;
    bridge.state.authenticated = false;
    bridge.state.source = 'disconnected';
    const checks = await runCurrentChecks('XAUUSDm', deps);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(['FAIL', 'BLOCKED']).toContain(byId['bridge.authenticated-session'].status);
    expect(byId['bridge.authenticated-session'].status).not.toBe('PASS');
    // A disconnected socket can never be a verified broker feed.
    expect(['FAIL', 'BLOCKED', 'WARN']).toContain(byId['data.fresh-quote'].status);
    expect(byId['data.fresh-quote'].status).not.toBe('PASS');
  });

  test('connected but NOT authenticated → FAIL (socket open is not a verified feed)', async () => {
    bridge.state.source = 'mt5';
    bridge.state.connected = true;
    bridge.state.authenticated = false;
    const checks = await runCurrentChecks('XAUUSDm', deps);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId['bridge.authenticated-session'].status).toBe('FAIL');
  });

  test('wrong server identity → FAIL (intended server mismatch)', async () => {
    bridge.state.source = 'mt5';
    bridge.state.connected = true;
    bridge.state.authenticated = true;
    bridge.state.server = 'SomeOther-Server';
    bridge.state.quote = { bid: 2650.1, ask: 2650.34, ts: Math.floor(Date.now() / 1000) };
    bridge.state.quoteAgeMs = 0;
    const checks = await runCurrentChecks('XAUUSDm', deps);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId['bridge.server-identity'].status).toBe('FAIL');
    expect(byId['bridge.server-identity'].actual).toBe('SomeOther-Server');
  });

  test('no secrets ever appear in any check evidence', async () => {
    bridge.state.source = 'mt5';
    bridge.state.connected = true;
    bridge.state.authenticated = true;
    bridge.state.quote = { bid: 2650.1, ask: 2650.34, ts: Math.floor(Date.now() / 1000) };
    bridge.state.quoteAgeMs = 0;
    const checks = await runCurrentChecks('XAUUSDm', deps);
    const blob = JSON.stringify(checks);
    expect(blob).not.toMatch(/(password|56529050|MT5_PASSWORD[^"']*:\s*"[^"]+)/i);
    expect(blob).not.toMatch(/ghp_[A-Za-z0-9]{10,}/);
  });
});

describe('audit v2 — report assembly + endpoint guard', () => {
  test('report is versioned, carries totals + sections + commit identity and never mixes scopes', async () => {
    bridge.state.source = 'mt5';
    bridge.state.connected = true;
    bridge.state.authenticated = true;
    bridge.state.quote = { bid: 2650.1, ask: 2650.34, ts: Math.floor(Date.now() / 1000) };
    bridge.state.quoteAgeMs = 0;
    const report = await buildEnvironmentAuditReport('XAUUSDm', deps);
    expect(report.model).toBe('environment-audit/2.0');
    expect(report.totals.historical).toBe(11);
    expect(report.sections.historical.every((c) => c.scope === 'historical')).toBe(true);
    expect(report.sections.currentRequired.every((c) => c.scope === 'current-required')).toBe(true);
    expect(report.sections.notApplicable.every((c) => c.scope === 'not-applicable')).toBe(true);
    // The refresh note states the truth: current checks re-run, historical never.
    expect(report.notes.some((n) => n.includes('refresh'))).toBe(true);
  });

  test('GET /api/audit/environment is guard-protected (fail closed without public reads)', async () => {
    const prev = process.env.MARKET_API_PUBLIC_READS;
    const prevToken = process.env.DATA_API_TOKEN;
    process.env.MARKET_API_PUBLIC_READS = '';
    process.env.DATA_API_TOKEN = '';
    try {
      const { GET } = await import('@/app/api/audit/environment/route');
      const res = await GET(new Request('http://localhost/api/audit/environment'));
      expect(res.status).toBe(503); // fail closed — MARKET_API_TOKEN_NOT_CONFIGURED
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('MARKET_API_TOKEN_NOT_CONFIGURED');
    } finally {
      process.env.MARKET_API_PUBLIC_READS = prev;
      process.env.DATA_API_TOKEN = prevToken;
    }
  });

  test('POST route inventory is exactly the guarded trigger set (no execution route exists)', () => {
    expect([...POST_ROUTE_INVENTORY].sort()).toEqual([
      '/api/ai/verify',
      '/api/analysis/run',
      '/api/backtest/run',
      '/api/chat',
      '/api/data/sync',
      '/api/signal/run',
    ]);
    // None of them is an execution surface.
    expect(POST_ROUTE_INVENTORY.some((r) => /order|trade|position|execution/i.test(r))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mk(id: string, status: AuditCheckResult['status'], scope: AuditCheckResult['scope']): AuditCheckResult {
  return {
    id,
    category: 'runtime',
    description: id,
    required: true,
    expected: '',
    actual: null,
    evidenceType: 'STATIC',
    evidenceCommand: '',
    startedAtUtc: null,
    completedAtUtc: null,
    runtimeIdentity: null,
    exitCodeOrHttpStatus: null,
    durationMs: null,
    evidence: '',
    status,
    reason: '',
    freshnessPolicy: 'per-request',
    scope,
  };
}
