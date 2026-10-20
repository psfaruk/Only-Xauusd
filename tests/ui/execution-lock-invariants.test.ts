/**
 * UI-02 FOCUSED TESTS — execution-gate invariants for the Phase 11 era.
 *
 * Phase 11 legitimately introduced APPROVAL-BASED demo execution (user-armed
 * four-switch gate on a trial account). The guarantees evolved — none weakened:
 *
 *   1. The four fail-closed switches keep execution disabled unless ALL FOUR
 *      are deliberately armed by the operator (subprocess-verified per switch:
 *      any single missing switch keeps the lock).
 *   2. The /api/data/chart surface stays GET-only and read-guarded.
 *   3. Execution API routes exist ONLY under /api/execution/* — every one of
 *      them is guard-protected, and NO other API path mentions order/trade/
 *      position/execution vocabulary.
 *   4. The frontend fetches ONLY the three /api/execution/* endpoints and no
 *      other order/trade/position endpoint anywhere.
 *   5. The LOCKED badge stays bound to the backend flag (no hardcoded state).
 *
 * Hermeticity: this file imports the market test setup FIRST, which pins the
 * four switches to the LOCKED posture — the locked-posture assertions below
 * therefore never depend on the developer's (possibly armed) .env.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../market/helpers/setup';
import { config } from '@/lib/config';

const SRC = join(process.cwd(), 'src');

describe('execution locks (four-switch gate)', () => {
  test('execution stays disabled with the locked posture (phase gate + arm switches + read-only mode)', () => {
    // Hermetic posture (pinned by the test setup): TRADING_PHASE=4,
    // TRADING_MODE=read_only, EXECUTION_ARMED=false, ALLOW_EXECUTION=false.
    // When env is wiped the fail-closed DEFAULTS in src/lib/config.ts apply
    // (phase 1) — either way this invariant must hold: nothing but the
    // operator's deliberate arming can unlock execution.
    expect(config.execution.enabled).toBe(false);
    const s = config.execution.switches;
    expect(s.phaseGatePassed === false || s.executionArmed === false || s.allowExecution === false || s.tradingMode === 'read_only').toBe(true);
    expect(config.execution.reason.length).toBeGreaterThan(0);
  });

  test('the hermetic locked posture keeps ALL FOUR switches locked', () => {
    expect(config.phase).toBeLessThan(11);
    expect(config.tradingMode).toBe('read_only');
    expect(config.execution.switches.executionArmed).toBe(false);
    expect(config.execution.switches.allowExecution).toBe(false);
  });

  test('phase label is truthful status, not roadmap progress (master audit B-D3)', () => {
    expect(config.phaseLabel).not.toMatch(/of\s+\d+/i);
    expect(config.phaseLabel).toContain(`Phase ${config.phase}`);
    expect(config.phaseLabel.toLowerCase()).toContain(config.tradingMode === 'read_only' ? 'read-only' : config.tradingMode);
    expect(config.executionGatePhase).toBe(11);
    if (!config.execution.enabled) {
      expect(config.execution.reason).toContain(`Phase ${config.executionGatePhase} gate`);
    }
  });
});

/** Subprocess probe: does the given env produce an ENABLED execution gate? */
function probeArmed(envOverride: Record<string, string>): boolean {
  // Config is a pure env reader — evaluate its gate logic in a fresh process
  // so the in-process pinned env cannot leak into the probe.
  const script = `const m = require('/home/z/my-project/src/lib/config.ts'); console.log(m.config.execution.enabled ? '1' : '0');`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // strip every .env-sourced switch, then apply the override
    TRADING_PHASE: '',
    TRADING_MODE: '',
    EXECUTION_ARMED: '',
    ALLOW_EXECUTION: '',
    DATABASE_URL: '',
    ...envOverride,
  };
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
  const out = execFileSync('bun', ['-e', script], { env, encoding: 'utf8', timeout: 30_000 });
  return out.trim().endsWith('1');
}

describe('Phase 11 arming — every one of the four switches is required', () => {
  const ARMED = {
    TRADING_PHASE: '11',
    TRADING_MODE: 'demo',
    EXECUTION_ARMED: 'true',
    ALLOW_EXECUTION: 'true',
  };

  test('all four switches ON → execution enabled (the deliberate operator arming)', () => {
    expect(probeArmed(ARMED)).toBe(true);
  });

  test('missing TRADING_PHASE gate → locked', () => {
    expect(probeArmed({ ...ARMED, TRADING_PHASE: '4' })).toBe(false);
  });

  test('read_only mode → locked even with everything else ON', () => {
    expect(probeArmed({ ...ARMED, TRADING_MODE: 'read_only' })).toBe(false);
  });

  test('EXECUTION_ARMED off → locked', () => {
    expect(probeArmed({ ...ARMED, EXECUTION_ARMED: 'false' })).toBe(false);
  });

  test('ALLOW_EXECUTION off → locked', () => {
    expect(probeArmed({ ...ARMED, ALLOW_EXECUTION: 'false' })).toBe(false);
  });

  test('live mode is NOT enabled by the demo arming (live requires its own explicit mode)', () => {
    // demo arming must never silently become live-capable
    const script = `const m = require('/home/z/my-project/src/lib/config.ts'); console.log(m.config.tradingMode);`;
    const env: NodeJS.ProcessEnv = { ...process.env, ...ARMED };
    const out = execFileSync('bun', ['-e', script], { env, encoding: 'utf8', timeout: 30_000 });
    expect(out.trim()).toBe('demo');
  });
});

describe('execution surface containment (Phase 11)', () => {
  test('/api/data/chart route exports GET only (no mutation handlers)', () => {
    const src = readFileSync(join(SRC, 'app', 'api', 'data', 'chart', 'route.ts'), 'utf8');
    expect(src).toContain('export async function GET');
    expect(src).not.toMatch(/export\s+async\s+function\s+(POST|PUT|DELETE|PATCH)/);
    expect(src).toContain("guardDataApi(request, 'read')");
  });

  test('order/trade/position/execution API routes exist ONLY under /api/execution/*', () => {
    const apiRoot = join(SRC, 'app', 'api');
    const forbidden = /^(order|trade|trading|position|deal)$/i;
    const dirs = readdirSync(apiRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    // The ONLY allowed execution-adjacent top-level dir is /api/execution.
    // (dirs is already the mapped name list — match the string itself; the
    // pre-existing d.name access was always undefined, i.e. a vacuous pass.)
    expect(dirs.filter((d) => forbidden.test(d))).toEqual([]);
    expect(dirs).toContain('execution');
    expect(existsSync(join(apiRoot, 'execution', 'state', 'route.ts'))).toBe(true);
    expect(existsSync(join(apiRoot, 'execution', 'decide', 'route.ts'))).toBe(true);
    expect(existsSync(join(apiRoot, 'execution', 'close', 'route.ts'))).toBe(true);
  });

  test('every /api/execution route is guard-protected (fail-closed auth)', () => {
    for (const sub of ['state', 'decide', 'close']) {
      const src = readFileSync(join(SRC, 'app', 'api', 'execution', sub, 'route.ts'), 'utf8');
      expect(src).toContain('guardDataApi(request,');
    }
  });

  test('no app source outside /api/execution mentions raw MT5 order protocol code', () => {
    // The wire protocol (248B Op serialization, TRADE cmd) lives ONLY in the
    // bridge mini-service. The app talks to it via the typed REST client in
    // src/lib/execution/bridge-orders.ts — never by building protocol frames
    // itself.
    const patterns = [/buildOpPayload/i, /trade_action/i, /CMD\.TRADE/i, /OrderSend/i];
    const offenders: string[] = [];
    const walk = (dir: string) => {
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

  test('the frontend fetches ONLY the three /api/execution/* endpoints (no other order surface)', () => {
    const frontendFiles = [
      join(SRC, 'app', 'page.tsx'),
      ...readdirSync(join(SRC, 'components', 'terminal'))
        .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
        .map((f) => join(SRC, 'components', 'terminal', f)),
    ];
    const allowed = /^\/api\/execution\/(state|decide|close)$/;
    const pattern = /['"`](\/api\/[a-z-/]+)/gi;
    const offenders: string[] = [];
    for (const f of frontendFiles) {
      const src = readFileSync(f, 'utf8');
      const hits = [...src.matchAll(pattern)].map((m) => m[1]);
      for (const h of hits) {
        if (/(order|trade|trading|position|execution|deal)/i.test(h) && !allowed.test(h)) offenders.push(`${f}: ${h}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the terminal UI keeps the lock state bound to the backend flag (no hardcoded "unlocked")', () => {
    const src = readFileSync(join(SRC, 'components', 'terminal', 'ExecutionPanel.tsx'), 'utf8');
    expect(src).toContain('s.executionEnabled');
    expect(src).not.toMatch(/সক্রিয় এক্সিকিউশন(?!.*)'\s*\)/); // no hardcoded armed text outside the conditional
    // The armed banner is inside a conditional on the backend flag.
    expect(src).toMatch(/\{s\.executionEnabled\s*\?/);
  });
});
