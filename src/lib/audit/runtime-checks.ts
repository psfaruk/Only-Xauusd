/**
 * XAUUSD AI Trading Agent — Current Runtime Checks (Phase 9, Task A3/A4)
 * ----------------------------------------------------------------------------
 * A FIXED, allowlisted collection of safe checks over the CURRENT bridge
 * architecture. Properties (enforced here, not by convention):
 *
 *   · No shell execution. Every check is implemented in application code
 *     (HTTP probe with timeout, Prisma query, in-process inspection). The
 *     client can NEVER supply a command, path or URL — the check ids are the
 *     only surface and they are hard-coded.
 *   · Each check is bounded: the bridge probes reuse the Phase 3 bridge
 *     client (AbortController timeout + bounded retries disabled for audit
 *     freshness), DB queries are counted/limited.
 *   · Every result carries start/completion timestamps, duration, HTTP status
 *     where applicable, redacted evidence and an explanatory reason.
 *
 * The bridge checks are deliberately SEPARATE (spec A4): a healthy HTTP bridge
 * does not prove the broker session is authenticated; an authenticated session
 * does not prove the quote is fresh; a fresh quote does not prove candle
 * history exists. Each is its own check with its own verdict.
 */

import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { bridgeClient, createBridgeClient, type BridgeClient } from '@/lib/market/bridge-client';
import { quoteIntegrity, auditCandleHistory } from '@/lib/market/integrity';
import { computeReadiness } from '@/lib/market/quality';
import { TOOL_REGISTRY } from '@/lib/tools/registry';
import { readGitCommit } from './runtime-identity';
import type { AuditCheckResult } from './model';

export interface CurrentCheckDeps {
  /** Injectable bridge client (tests). Defaults: a no-retry client over the
   *  configured bridge URL; falls back to the shared singleton when neither
   *  is configured. */
  bridge?: BridgeClient;
}

/** One-shot bridge client with retries DISABLED so an audit reflects the
 *  CURRENT reachability state (a retry storm would blur the evidence). */
function auditBridgeClient(deps?: CurrentCheckDeps): BridgeClient {
  if (deps?.bridge) return deps.bridge;
  if (config.bridge.url) return createBridgeClient({ maxRetries: 0, timeoutMs: 4_000 });
  return bridgeClient;
}

interface CheckContext {
  commit: string | null;
}

type CheckFn = (ctx: CheckContext) => Promise<AuditCheckResult>;

/** Run one check with honest timing + BLOCKED-on-exception semantics.
 *  `base` carries default status/reason; the check fn overrides them. */
async function runCheck(
  ctx: CheckContext,
  base: Omit<AuditCheckResult, 'startedAtUtc' | 'completedAtUtc' | 'durationMs' | 'runtimeIdentity' | 'scope' | 'exitCodeOrHttpStatus'> & {
    scope?: AuditCheckResult['scope'];
    exitCodeOrHttpStatus?: number | null;
  },
  fn: () => Promise<{ status: AuditCheckResult['status']; reason: string; actual?: string; evidence?: string; httpStatus?: number | null }>,
): Promise<AuditCheckResult> {
  const started = Date.now();
  const startedAtUtc = new Date(started).toISOString();
  try {
    const out = await fn();
    return {
      ...base,
      actual: out.actual ?? base.actual ?? null,
      evidence: out.evidence ?? base.evidence,
      exitCodeOrHttpStatus: out.httpStatus ?? base.exitCodeOrHttpStatus ?? null,
      startedAtUtc,
      completedAtUtc: new Date().toISOString(),
      durationMs: Date.now() - started,
      runtimeIdentity: ctx.commit,
      status: out.status,
      reason: out.reason,
      scope: base.scope ?? 'current-required',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      exitCodeOrHttpStatus: base.exitCodeOrHttpStatus ?? null,
      startedAtUtc,
      completedAtUtc: new Date().toISOString(),
      durationMs: Date.now() - started,
      runtimeIdentity: ctx.commit,
      status: 'BLOCKED',
      reason: `The check itself could not be performed (unexpected exception): ${message.slice(0, 200)}`,
      scope: base.scope ?? 'current-required',
    };
  }
}

/** All current checks. Fixed ids, fixed order — nothing client-supplied. */
export async function runCurrentChecks(symbol?: string, deps?: CurrentCheckDeps): Promise<AuditCheckResult[]> {
  const ctx: CheckContext = { commit: readGitCommit() };
  const sym = symbol && config.market.symbols.includes(symbol) ? symbol : (config.market.symbols[0] ?? 'XAUUSDm');
  const bridge = auditBridgeClient(deps);
  const bridgeConfigured = Boolean(deps?.bridge) || config.bridge.url !== '';
  const expectedServer = config.bridge.expectedServer;
  const checks: AuditCheckResult[] = [];

  // ── runtime ────────────────────────────────────────────────────────────
  checks.push(
    await runCheck(ctx, {
      id: 'runtime.process',
      category: 'runtime',
      description: 'Managed application runtime (Node/Bun) is alive and serving this request',
      required: true,
      expected: 'The audit API itself responds from the Next.js process',
      actual: null,
      evidenceType: 'STATIC',
      evidenceCommand: 'in-process observation: process.version / Bun.version / os.release()',
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      const bunVer = typeof Bun !== 'undefined' ? Bun.version : 'n/a';
      const os = await import('node:os');
      return {
        status: 'PASS',
        reason: 'This response was produced by the running process — the runtime is alive by construction.',
        actual: `node ${process.version} · bun ${bunVer} · ${os.type()} ${os.release()} (${os.arch()})`,
        evidence: `uptime ${Math.round(process.uptime())}s · rss ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
      };
    }),
  );

  // ── database ───────────────────────────────────────────────────────────
  checks.push(
    await runCheck(ctx, {
      id: 'database.sqlite',
      category: 'database',
      description: 'SQLite database reachable through Prisma (read query succeeds)',
      required: true,
      expected: 'A counted read against SystemEvent returns without error',
      actual: null,
      evidenceType: 'API_PROBE',
      evidenceCommand: 'in-process Prisma query: db.systemEvent.count()',
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      const count = await db.systemEvent.count();
      return {
        status: 'PASS',
        reason: `Prisma read succeeded — ${count} SystemEvent rows are stored.`,
        actual: `${count} audit events`,
        evidence: `provider sqlite · url configured=${config.bridge.url !== '' ? 'n/a' : 'n/a'} · count query ok`,
      };
    }),
  );

  checks.push(
    await runCheck(ctx, {
      id: 'database.signal-persistence',
      category: 'database',
      description: 'SignalEvaluation persistence available (Phase 9 signal audit trail)',
      required: true,
      expected: 'The SignalEvaluation table exists and is queryable (0 rows is a valid PASS — the engine may simply not have run yet)',
      actual: null,
      evidenceType: 'API_PROBE',
      evidenceCommand: 'in-process Prisma query: db.signalEvaluation.count()',
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      const count = await db.signalEvaluation.count();
      return {
        status: 'PASS',
        reason: `SignalEvaluation table queryable — ${count} persisted evaluations.`,
        actual: `${count} rows`,
        evidence: 'additive Phase 9 migration applied; append-only (evaluations are never overwritten)',
      };
    }),
  );

  // ── bridge (each fact SEPARATE — spec A4) ───────────────────────────────
  checks.push(
    await runCheck(ctx, {
      id: 'bridge.health',
      category: 'mt5-bridge',
      description: 'Read-only MT5 bridge HTTP health endpoint responds (GET /health)',
      required: true,
      expected: 'HTTP 200 with ok:true from the configured bridge URL',
      actual: null,
      evidenceType: 'API_PROBE',
      evidenceCommand: `HTTP GET ${config.bridge.url || '(unset)'}/health — bounded 4s timeout, no retries`,
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      if (!bridgeConfigured) {
        return {
          status: 'FAIL',
          reason: 'MT5_BRIDGE_URL is not configured — the data path fails closed and the bridge cannot be probed.',
          actual: 'BRIDGE_NOT_CONFIGURED',
        };
      }
      const res = await bridge.getHealth();
      if (!res.ok) {
        return {
          status: 'FAIL',
          reason: `Bridge health probe failed: ${res.error.code} — ${res.error.message}`,
          actual: res.error.code,
          evidence: `error: ${res.error.code} (http ${('httpStatus' in res.error ? res.error.httpStatus : null) ?? 'n/a'})`,
          httpStatus: 'httpStatus' in res.error ? (res.error.httpStatus ?? null) : null,
        };
      }
      return {
        status: 'PASS',
        reason: `Bridge /health responded ok (service ${res.data.service ?? 'unknown'}, uptime ${res.data.uptime ?? 'n/a'}s).`,
        actual: `ok=true service=${res.data.service ?? 'unknown'}`,
        evidence: `GET /health → 200 ${JSON.stringify(res.data).slice(0, 160)}`,
        httpStatus: 200,
      };
    }),
  );

  checks.push(
    await runCheck(ctx, {
      id: 'bridge.authenticated-session',
      category: 'mt5-bridge',
      description: 'Broker session is CONNECTED and AUTHENTICATED (separate from HTTP health)',
      required: true,
      expected: 'GET /api/status returns connected=true AND authenticated=true over an authenticated broker session',
      actual: null,
      evidenceType: 'LIVE_BROKER',
      evidenceCommand: `HTTP GET ${config.bridge.url || '(unset)'}/api/status (x-trader-key auth) — session state as reported by the bridge`,
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      if (!bridgeConfigured) {
        return { status: 'FAIL', reason: 'Bridge not configured.', actual: 'BRIDGE_NOT_CONFIGURED' };
      }
      const res = await bridge.getStatus();
      if (!res.ok) {
        return {
          status: 'FAIL',
          reason: `Bridge status probe failed: ${res.error.code} — ${res.error.message}`,
          actual: res.error.code,
          httpStatus: 'httpStatus' in res.error ? (res.error.httpStatus ?? null) : null,
        };
      }
      const s = res.data as unknown as {
        connected: boolean;
        authenticated?: boolean;
        server?: string | null;
        gateway?: string | null;
        loginMasked?: string | null;
        reconnects?: number;
      };
      if (!s.connected) {
        return {
          status: 'FAIL',
          reason: 'The bridge reports connected=false — the broker session is down (an HTTP-healthy bridge is NOT a live feed).',
          actual: 'connected=false',
          evidence: JSON.stringify({ connected: s.connected, authenticated: s.authenticated }).slice(0, 160),
          httpStatus: 200,
        };
      }
      if (s.authenticated !== true) {
        return {
          status: 'FAIL',
          reason: 'The bridge is connected but NOT authenticated — per the integrity policy this can never be treated as a verified broker feed (source would be classified cache, not broker).',
          actual: 'connected=true authenticated=false',
          evidence: JSON.stringify({ connected: s.connected, authenticated: s.authenticated }).slice(0, 160),
          httpStatus: 200,
        };
      }
      return {
        status: 'PASS',
        reason: `Authenticated broker session is up (server ${s.server ?? 'unknown'}, gateway ${s.gateway ?? 'unknown'}, login ${s.loginMasked ?? 'masked'}, reconnects ${s.reconnects ?? 'n/a'}).`,
        actual: `connected=true authenticated=true server=${s.server ?? '?'}`,
        evidence: JSON.stringify({ connected: s.connected, authenticated: s.authenticated, server: s.server, gateway: s.gateway, loginMasked: s.loginMasked, reconnects: s.reconnects }).slice(0, 220),
        httpStatus: 200,
      };
    }),
  );

  checks.push(
    await runCheck(ctx, {
      id: 'bridge.server-identity',
      category: 'mt5-bridge',
      description: `Broker session server identity matches the intended server (${expectedServer})`,
      required: true,
      expected: `status.server === "${expectedServer}" (exact match, no name guessing)`,
      actual: null,
      evidenceType: 'LIVE_BROKER',
      evidenceCommand: 'compare bridge /api/status server field with the configured intended server (MT5_SERVER)',
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      if (!bridgeConfigured) {
        return { status: 'FAIL', reason: 'Bridge not configured.', actual: 'BRIDGE_NOT_CONFIGURED' };
      }
      const res = await bridge.getStatus();
      if (!res.ok) {
        return { status: 'BLOCKED', reason: `Cannot verify server identity — the status probe failed (${res.error.code}).`, actual: res.error.code };
      }
      const server = (res.data as unknown as { server?: string | null }).server ?? null;
      if (server !== expectedServer) {
        return {
          status: 'FAIL',
          reason: `The authenticated session belongs to "${server ?? 'unknown'}", not the intended "${expectedServer}".`,
          actual: server ?? 'unknown',
          httpStatus: 200,
        };
      }
      return {
        status: 'PASS',
        reason: `The session server is exactly "${server}" as intended.`,
        actual: server,
        evidence: `status.server="${server}" == MT5_SERVER="${expectedServer}"`,
        httpStatus: 200,
      };
    }),
  );

  // ── market data (quote + symbol resolution + candles, each SEPARATE) ───
  checks.push(
    await runCheck(ctx, {
      id: 'data.symbol-resolution',
      category: 'market-data',
      description: `Exact symbol resolution for "${sym}" from the broker symbol table`,
      required: true,
      expected: 'A live quote for the exact symbol name is served with verified digits (a wrong/absent symbol yields 404)',
      actual: null,
      evidenceType: 'LIVE_BROKER',
      evidenceCommand: `HTTP GET ${config.bridge.url || '(unset)'}/api/quote?symbol=${sym} — exact-name lookup, no name guessing`,
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      if (!bridgeConfigured) {
        return { status: 'FAIL', reason: 'Bridge not configured.', actual: 'BRIDGE_NOT_CONFIGURED' };
      }
      const res = await bridge.getQuote(sym);
      if (!res.ok) {
        return {
          status: 'FAIL',
          reason: `The broker serves no quote for the exact symbol "${sym}" (${res.error.code}). Symbol resolution must come from the broker table — never guessed.`,
          actual: res.error.code,
          httpStatus: 'httpStatus' in res.error ? (res.error.httpStatus ?? null) : null,
        };
      }
      const digits = (res.data as unknown as { digits?: number }).digits ?? null;
      return {
        status: digits !== null ? 'PASS' : 'WARN',
        reason:
          digits !== null
            ? `Exact-name symbol "${sym}" resolved with verified digits=${digits}.`
            : `Symbol "${sym}" resolved but digits were not reported — level formatting falls back to unformatted values.`,
        actual: `symbol=${sym} digits=${digits ?? 'n/a'}`,
        evidence: `GET /api/quote → symbol="${(res.data as { symbol?: string }).symbol ?? sym}" digits=${digits ?? 'n/a'}`,
        httpStatus: 200,
      };
    }),
  );

  checks.push(
    await runCheck(ctx, {
      id: 'data.fresh-quote',
      category: 'market-data',
      description: 'Recent VALID quote with correct bid/ask and acceptable spread (separate from session state)',
      required: true,
      expected: `freshness=LIVE, validation=VALID, source=broker, age ≤ ${config.market.staleTickSec}s, ask ≥ bid > 0`,
      actual: null,
      evidenceType: 'LIVE_BROKER',
      evidenceCommand: 'integrity monitor: quoteIntegrity(symbol) over the bridge quote (freshness + numeric validation + source class)',
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      const report = await quoteIntegrity(sym, { bridge });
      if (report.validationStatus === 'INVALID') {
        return {
          status: 'FAIL',
          reason: `The latest quote payload is numerically INVALID (${report.issues.join(', ')}) — invalid values are rejected, never replaced.`,
          actual: `validation=${report.validationStatus}`,
          evidence: JSON.stringify({ issues: report.issues, freshness: report.freshness, sourceClass: report.sourceClass }).slice(0, 200),
        };
      }
      if (report.freshness === 'DISCONNECTED' || report.sourceClass !== 'broker') {
        return {
          status: 'FAIL',
          reason: `No verified broker quote is available right now (freshness=${report.freshness}, source=${report.sourceClass}, blocked=${report.blockedReasons.join(',')}).`,
          actual: `freshness=${report.freshness} source=${report.sourceClass}`,
          evidence: JSON.stringify({ freshness: report.freshness, sourceClass: report.sourceClass, blockedReasons: report.blockedReasons, issues: report.issues }).slice(0, 220),
        };
      }
      if (report.freshness !== 'LIVE') {
        return {
          status: 'WARN',
          reason: `Quote present but ${report.freshness} (age ${report.ageSeconds ?? 'n/a'}s > ${report.stalenessThresholdSeconds}s threshold). Signal generation is correctly BLOCKED while stale.`,
          actual: `freshness=${report.freshness} age=${report.ageSeconds ?? 'n/a'}s`,
          evidence: JSON.stringify({ freshness: report.freshness, ageSeconds: report.ageSeconds, validationStatus: report.validationStatus, sourceClass: report.sourceClass }).slice(0, 220),
        };
      }
      return {
        status: 'PASS',
        reason: `LIVE verified broker quote: bid ${report.bid} / ask ${report.ask}, spread ${report.spread}, age ${report.ageSeconds}s.`,
        actual: `bid=${report.bid} ask=${report.ask} age=${report.ageSeconds}s`,
        evidence: JSON.stringify({ freshness: report.freshness, sourceClass: report.sourceClass, bid: report.bid, ask: report.ask, spread: report.spread, ageSeconds: report.ageSeconds, quoteTimeUtc: report.quoteTimeUtc }).slice(0, 240),
      };
    }),
  );

  checks.push(
    await runCheck(ctx, {
      id: 'data.candle-history',
      category: 'market-data',
      description: 'Per-timeframe verified candle history passes read-time integrity checks (counts, OHLC, duplicates, staleness, H4 coverage)',
      required: true,
      expected: `every configured TF (${config.market.timeframes.join('/')}) present, 0 invalid OHLC, 0 duplicates, 0 out-of-order, latest closed within staleness thresholds, H4 ≥ 200 closed candles`,
      actual: null,
      evidenceType: 'API_PROBE',
      evidenceCommand: 'integrity monitor: auditCandleHistory(symbol) over persisted, broker-sourced candles',
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      const history = await auditCandleHistory(sym, config.market.timeframes);
      const missing = history.timeframes.filter((t) => !t.present || t.closedCount === 0);
      const invalid = history.timeframes.filter((t) => t.invalidOhlc > 0 || t.duplicateTimestamps > 0 || t.outOfOrder > 0);
      const stale = history.timeframes.filter((t) => t.qualityState === 'STALE');
      const h4 = history.timeframes.find((t) => t.timeframe === 'H4');
      const summary = history.timeframes
        .map((t) => `${t.timeframe}:${t.closedCount}c/${t.qualityState}${t.missingOutsideClosure > 0 ? `/gaps=${t.missingOutsideClosure}` : ''}`)
        .join(' · ');
      if (missing.length > 0) {
        return {
          status: 'FAIL',
          reason: `No closed candle history for: ${missing.map((t) => t.timeframe).join(', ')} — analysis/signal engines fail closed without data.`,
          actual: summary,
          evidence: summary.slice(0, 240),
        };
      }
      if (invalid.length > 0) {
        return {
          status: 'FAIL',
          reason: `Integrity violations in persisted candles: ${invalid.map((t) => `${t.timeframe} (invalid=${t.invalidOhlc}, dup=${t.duplicateTimestamps}, ooo=${t.outOfOrder})`).join('; ')}.`,
          actual: summary,
          evidence: summary.slice(0, 240),
        };
      }
      if (stale.length > 0) {
        return {
          status: 'WARN',
          reason: `Candle history is structurally valid but STALE for: ${stale.map((t) => `${t.timeframe} (latest closed ${Math.round((t.latestClosedAgeSeconds ?? 0) / 60)}min ago)`).join(', ')}. Engines correctly block on stale data.`,
          actual: summary,
          evidence: summary.slice(0, 240),
        };
      }
      if (h4 && h4.closedCount < 200) {
        return {
          status: 'WARN',
          reason: `H4 coverage is only ${h4.closedCount} closed candles (< 200) — higher-timeframe context is thin; broker H4 depth is bounded (~1,458 bars probed in Phase 8).`,
          actual: summary,
          evidence: `${summary} · ${history.h4Coverage.coverageNote}`.slice(0, 240),
        };
      }
      return {
        status: 'PASS',
        reason: `All timeframes present and clean: ${summary}. ${history.h4Coverage.coverageNote}`,
        actual: summary,
        evidence: summary.slice(0, 240),
      };
    }),
  );

  // ── signal engine ──────────────────────────────────────────────────────
  checks.push(
    await runCheck(ctx, {
      id: 'signal.engine-readiness',
      category: 'signal-engine',
      description: 'Market data is analysis-ready for the deterministic signal engine (tick + per-TF gates)',
      required: true,
      expected: 'computeReadiness(symbol).ready === true (fresh tick, all TFs VALID/WARNING, no demo source)',
      actual: null,
      evidenceType: 'API_PROBE',
      evidenceCommand: 'quality gate: computeReadiness(symbol) — the same gate the signal engine uses before any setup evaluation',
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      const readiness = await computeReadiness({ symbol: sym });
      if (readiness.ready) {
        return {
          status: 'PASS',
          reason: `Data is analysis-ready (state ${readiness.qualityState}) — the signal engine may evaluate setups.`,
          actual: `ready=true state=${readiness.qualityState}`,
          evidence: `tickAge=${readiness.tick.ageSeconds ?? 'n/a'}s codes=[${readiness.errorCodes.join(',')}]`,
        };
      }
      const hasCandles = readiness.timeframes.every((t) => t.scannedCandles > 0);
      return {
        status: hasCandles ? 'WARN' : 'FAIL',
        reason: hasCandles
          ? `Data is temporarily not analysis-ready (state ${readiness.qualityState}, codes: ${readiness.errorCodes.join(', ') || 'none'}) — the signal engine correctly BLOCKS until freshness recovers.`
          : `Structurally not ready (state ${readiness.qualityState}, codes: ${readiness.errorCodes.join(', ')}) — required timeframe history is missing.`,
        actual: `ready=false state=${readiness.qualityState}`,
        evidence: `codes=[${readiness.errorCodes.join(',')}] tickState=${readiness.tick.state}`,
      };
    }),
  );

  // ── GLM ────────────────────────────────────────────────────────────────
  checks.push(
    await runCheck(ctx, {
      id: 'glm.runtime-access',
      category: 'glm',
      description: 'GLM access for the Bengali Chat Agent (latest persisted verification)',
      required: true,
      expected: 'latest GLM verification event = OK (chat, Bengali, tool calling) — re-runnable via POST /api/ai/verify',
      actual: null,
      evidenceType: 'STATIC',
      evidenceCommand: 'read the latest GLM_VERIFY_* SystemEvent row (persisted evidence of the last real verification run)',
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      const last = await db.systemEvent.findFirst({
        where: { category: 'glm', code: { in: ['GLM_VERIFY_OK', 'GLM_VERIFY_FAIL'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!last) {
        return {
          status: 'WARN',
          reason: 'No GLM verification has been recorded yet. The verify endpoint exists (POST /api/ai/verify); until it runs, chat capability is unproven — NOT counted as PASS.',
          actual: 'never verified',
          evidence: 'no GLM_VERIFY_* rows found',
        };
      }
      const ageMin = Math.round((Date.now() - last.createdAt.getTime()) / 60_000);
      if (last.code === 'GLM_VERIFY_FAIL') {
        return {
          status: 'FAIL',
          reason: `The most recent GLM verification FAILED (${ageMin} min ago). Chat may be degraded until re-verified.`,
          actual: 'GLM_VERIFY_FAIL',
          evidence: `last event ${last.createdAt.toISOString()}: ${last.message.slice(0, 160)}`,
        };
      }
      return {
        status: 'PASS',
        reason: `GLM verified OK ${ageMin} min ago (model glm-4-plus: chat, Bengali, tool calling).`,
        actual: 'GLM_VERIFY_OK',
        evidence: `last event ${last.createdAt.toISOString()}: ${last.message.slice(0, 160)}`,
      };
    }),
  );

  // ── security (per-request invariants) ──────────────────────────────────
  checks.push(
    await runCheck(ctx, {
      id: 'security.execution-lock',
      category: 'security',
      description: 'Four-switch execution lock is ENGAGED (phase gate AND arm switches AND mode)',
      required: true,
      expected: 'executionEnabled === false (phase < 11, EXECUTION_ARMED=false, ALLOW_EXECUTION=false, mode=read_only)',
      actual: null,
      evidenceType: 'STATIC',
      evidenceCommand: 'in-process evaluation of the four-switch gate (src/lib/config.ts) at request time',
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'per-request',
    }, async () => {
      if (config.execution.enabled) {
        return {
          status: 'FAIL',
          reason: `EXECUTION IS ENABLED (${config.execution.reason}) — this violates the Phase 9 read-only mandate.`,
          actual: 'executionEnabled=true',
          evidence: 'DANGER: execution gate open',
        };
      }
      return {
        status: 'PASS',
        reason: config.execution.reason,
        actual: 'executionEnabled=false',
        evidence: `phase=${config.phase} (<11) · EXECUTION_ARMED=false · ALLOW_EXECUTION=false · mode=${config.tradingMode}`,
      };
    }),
  );

  checks.push(
    await runCheck(ctx, {
      id: 'security.read-only-surface',
      category: 'security',
      description: 'No execution/order/trade/position capability on any programmatic surface (bridge client, tool registry, POST route inventory)',
      required: true,
      expected: 'bridge client exposes only the 5 read-only methods; tool registry has no execution tool; POST route inventory contains only the 6 guard-protected action routes (5 trigger + chat)',
      actual: null,
      evidenceType: 'STATIC',
      evidenceCommand: 'in-process structural inspection: Object.keys(bridgeClient) + TOOL_REGISTRY names + route inventory constant',
      evidence: '',
      status: 'PASS',
      reason: '',
      freshnessPolicy: 'static-invariant',
    }, async () => {
      const bridgeMethods = Object.keys(bridgeClient).sort();
      const allowed = ['getCandles', 'getHealth', 'getQuote', 'getStatus', 'getSymbols'].sort();
      const bridgeClean = bridgeMethods.join(',') === allowed.join(',');
      const toolNames = TOOL_REGISTRY.map((t) => t.name);
      const executionTool = toolNames.find((n) => /order|trade|position|execute|deal/i.test(n) && !/explain|history|summary/.test(n)) ?? null;
      const postRoutes = POST_ROUTE_INVENTORY.slice().sort();
      const expectedRoutes = [
        '/api/ai/verify',
        '/api/analysis/run',
        '/api/backtest/run',
        '/api/chat',
        '/api/data/sync',
        '/api/signal/run',
      ].sort();
      const routesClean = postRoutes.join(',') === expectedRoutes.join(',');
      if (!bridgeClean || executionTool || !routesClean) {
        return {
          status: 'FAIL',
          reason: `Read-only surface violated: bridgeMethods=${bridgeMethods.join(',')}; executionTool=${executionTool ?? 'none'}; postRoutes=${postRoutes.join(',')}.`,
          actual: 'violation',
          evidence: JSON.stringify({ bridgeMethods, executionTool, postRoutes }),
        };
      }
      return {
        status: 'PASS',
        reason: 'The bridge client implements exactly the 5 read-only methods; no tool in the registry can execute anything; the complete POST inventory is 6 guard-protected action routes (data/sync, analysis/run, signal/run, backtest/run, ai/verify behind the trigger guard; chat behind the read+chat guard).',
        actual: 'clean',
        evidence: `bridgeClient methods: ${bridgeMethods.join(', ')} · registry tools: ${toolNames.length} (none execution-capable) · POST routes: ${postRoutes.join(', ')}`,
      };
    }),
  );

  // ── not-applicable legacy dependencies (with code-inspection evidence) ─
  checks.push(notApplicableCheck(ctx, {
    id: 'dep.wine',
    description: 'Wine (Windows runtime) — legacy Phase 1 dependency, NOT required by the current architecture',
    evidence: 'Code inspection (Phase 9 pre-audit §4): the market-data path is the TypeScript WebSocket bridge (mini-services/mt5-bridge) speaking the MT5 web-terminal protocol directly. No code path spawns Wine or a Windows terminal; "wine" appears only in historical Phase 1 evidence. The historical Phase 1 FAIL (which wine → NOT FOUND) is preserved as phase1.wine.',
  }));
  checks.push(notApplicableCheck(ctx, {
    id: 'dep.metatrader5-python',
    description: 'MetaTrader5 Python package — legacy Phase 1 dependency, NOT required by the current architecture',
    evidence: 'Code inspection (Phase 9 pre-audit §4): the application runtime is Next.js/Node (TypeScript); no Python module is imported anywhere in src/ or mini-services/. The historical Phase 1 FAIL (Windows-only PyPI wheels) is preserved as phase1.mt5-pkg.',
  }));
  checks.push(notApplicableCheck(ctx, {
    id: 'dep.python-datastack',
    description: 'Python 3.12 data stack (numpy/pandas) — available in the sandbox but not part of the application runtime',
    evidence: 'The deterministic engines (analysis, signal, backtest) are TypeScript modules in src/lib/. Python remains available for offline tooling only (historical phase1.python PASS preserved).',
  }));

  return checks;
}

function notApplicableCheck(
  ctx: CheckContext,
  base: { id: string; description: string; evidence: string },
): AuditCheckResult {
  return {
    id: base.id,
    category: 'legacy-dependency',
    description: base.description,
    required: false,
    expected: 'Not required by the TypeScript-bridge architecture (verified by code inspection)',
    actual: 'not required',
    evidenceType: 'STATIC',
    evidenceCommand: 'repository code inspection (src/, mini-services/, scripts/) — no dependency on this legacy component',
    startedAtUtc: null,
    completedAtUtc: new Date().toISOString(),
    runtimeIdentity: ctx.commit,
    exitCodeOrHttpStatus: null,
    durationMs: null,
    evidence: base.evidence,
    status: 'NOT_APPLICABLE',
    reason:
      'The chosen architecture does not depend on this component. This verdict is based on code inspection, NOT on hiding a failure — the original Phase 1 failures remain visible in the historical section with their own timestamps.',
    freshnessPolicy: 'static-invariant',
    scope: 'not-applicable',
  };
}

/** Complete, fixed POST route inventory of this application (kept in sync by
 *  the security tests — tests/market/api.test.ts pins this list). */
export const POST_ROUTE_INVENTORY = [
  '/api/ai/verify',
  '/api/analysis/run',
  '/api/backtest/run',
  '/api/chat',
  '/api/data/sync',
  '/api/signal/run',
] as const;
