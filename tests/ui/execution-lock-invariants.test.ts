/**
 * SIGNAL-ONLY CONTRACT TESTS — Phase 0 deep-remediation invariants.
 *
 * The product contract (master prompt Phase 0) is READ-ONLY: market
 * observation, analysis, signals, backtesting and paper-forward validation.
 * Order execution code was DELETED from the application and the MT5 bridge.
 * These tests pin that state so a future change cannot silently re-introduce
 * a trading path:
 *
 *   1. The execution module, execution API routes and bridge order layer do
 *      not exist on disk (structural, not flag-based).
 *   2. config hard-locks tradingMode to 'read_only' — no env value (absent,
 *      malformed, 'demo', 'live' …) can ever produce a trading posture,
 *      verified in fresh subprocesses.
 *   3. No app source mentions raw MT5 order protocol code.
 *   4. The frontend never fetches an order/trade/position/execution API.
 *   5. The tool registry exposes no order-mutation tool.
 *   6. The scalper/signal services cannot import an execution service
 *      (module absent) and their outputs carry no execution instruction.
 *
 * Hermeticity: imports the market test setup FIRST.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../market/helpers/setup';
import { config } from '@/lib/config';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

describe('signal-only posture (config)', () => {
  test('tradingMode is hard-locked to read_only in code', () => {
    expect(config.tradingMode).toBe('read_only');
    expect(config.execution.enabled).toBe(false);
    expect(config.execution.auto).toBe(false);
    expect(config.execution.reason.length).toBeGreaterThan(0);
  });

  test('phase label states the signal-only posture truthfully', () => {
    expect(config.phaseLabel).not.toMatch(/of\s+\d+/i);
    expect(config.phaseLabel).toContain(`Phase ${config.phase}`);
    expect(config.phaseLabel.toLowerCase()).toContain('read-only');
  });
});

/** Subprocess probe: does the given env produce a non-read_only mode? */
function probeMode(envOverride: Record<string, string>): string {
  // Config is a pure env reader — evaluate it in a fresh process so the
  // in-process pinned env cannot leak into the probe.
  const script = `const m = require('${join(ROOT, 'src', 'lib', 'config.ts').replace(/\\/g, '/')}'); console.log(m.config.tradingMode + '|' + m.config.execution.enabled);`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: '',
    ...envOverride,
  };
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
  const out = execFileSync('bun', ['-e', script], { env, encoding: 'utf8', timeout: 30_000 });
  return out.trim();
}

describe('fail-closed posture — no env combination can enable trading', () => {
  test("TRADING_MODE=live is IGNORED (hard-locked in code)", () => {
    expect(probeMode({ TRADING_MODE: 'live' })).toBe('read_only|false');
  });

  test("TRADING_MODE=demo is IGNORED (hard-locked in code)", () => {
    expect(probeMode({ TRADING_MODE: 'demo' })).toBe('read_only|false');
  });

  test('the historical arming switches no longer exist as env inputs (any value is inert)', () => {
    // The Phase 11 four-switch gate (EXECUTION_ARMED / ALLOW_EXECUTION /
    // EXECUTION_AUTO / BRIDGE_ORDERS_ENABLED) was removed with the execution
    // module. Setting them must have NO effect.
    expect(
      probeMode({
        TRADING_MODE: 'live',
        EXECUTION_ARMED: 'true',
        ALLOW_EXECUTION: 'true',
        EXECUTION_AUTO: 'true',
        BRIDGE_ORDERS_ENABLED: 'true',
        TRADING_PHASE: '14',
      }),
    ).toBe('read_only|false');
  });

  test('a completely empty env still fails closed to read_only', () => {
    expect(probeMode({})).toBe('read_only|false');
  });
});

describe('execution code is structurally ABSENT', () => {
  test('src/lib/execution does not exist', () => {
    expect(existsSync(join(SRC, 'lib', 'execution'))).toBe(false);
  });

  test('/api/execution routes do not exist', () => {
    expect(existsSync(join(SRC, 'app', 'api', 'execution'))).toBe(false);
    const apiRoot = join(SRC, 'app', 'api');
    const dirs = readdirSync(apiRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs).not.toContain('execution');
    expect(dirs.filter((d) => /^(order|trade|trading|position|deal)$/i.test(d))).toEqual([]);
  });

  test('the bridge serves no order/position endpoints and has no order code', () => {
    const bridgeRoot = join(ROOT, 'mini-services', 'mt5-bridge');
    const indexSrc = readFileSync(join(bridgeRoot, 'index.ts'), 'utf8');
    expect(indexSrc).not.toContain("'/api/order'");
    expect(indexSrc).not.toContain("'/api/position-close'");
    expect(indexSrc).not.toContain("'/api/positions'");
    const managerSrc = readFileSync(join(bridgeRoot, 'src', 'manager.ts'), 'utf8');
    expect(managerSrc).not.toMatch(/function placeMarketOrder|function closePosition|function listPositions|export const ordersEnabled/);
    const clientSrc = readFileSync(join(bridgeRoot, 'src', 'mt5-client.ts'), 'utf8');
    expect(clientSrc).not.toMatch(/function buildOpPayload|emitTradeEvent|pendingTrade|async positions\(|async trade\(/);
  });

  test('no app source mentions raw MT5 order protocol code', () => {
    const patterns = [/buildOpPayload/i, /trade_action/i, /CMD\.TRADE/i, /OrderSend/i, /placeBridgeOrder/i, /closeBridgePosition/i];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const src = readFileSync(full, 'utf8');
          if (patterns.some((p) => p.test(src))) offenders.push(full);
        }
      }
    };
    walk(join(SRC, 'lib'));
    walk(join(SRC, 'app'));
    expect(offenders).toEqual([]);
  });
});

describe('frontend + agent surfaces have no order path', () => {
  test('the frontend never fetches an order/trade/position/execution API', () => {
    const frontendFiles = [
      join(SRC, 'app', 'page.tsx'),
      ...readdirSync(join(SRC, 'components', 'terminal'))
        .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
        .map((f) => join(SRC, 'components', 'terminal', f)),
    ];
    const pattern = /['"`](\/api\/[a-z-/]+)/gi;
    const offenders: string[] = [];
    for (const f of frontendFiles) {
      const src = readFileSync(f, 'utf8');
      const hits = [...src.matchAll(pattern)].map((m) => m[1]);
      for (const h of hits) {
        if (/(order|trade|trading|position|execution|deal)/i.test(h)) offenders.push(`${f}: ${h}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the tool registry exposes no order-mutation tool', async () => {
    const { TOOL_REGISTRY } = await import('@/lib/tools/registry');
    const names = TOOL_REGISTRY.map((t) => t.name);
    const executionTool = names.find((n) => /order|trade|position|execute|deal/i.test(n) && !/explain|history|summary/.test(n));
    expect(executionTool).toBeUndefined();
    // run_risk_check stays as an ADVISORY read-only analysis tool (it computes
    // checks; it cannot place, close or approve anything).
    expect(names).toContain('run_risk_check');
  });

  test('the scalper service result carries no execution field', async () => {
    const src = readFileSync(join(SRC, 'lib', 'signal', 'scalper-service.ts'), 'utf8');
    expect(src).not.toMatch(/processActionableSignal|@\/lib\/execution/);
    expect(src).not.toMatch(/execution\?:/);
  });
});
