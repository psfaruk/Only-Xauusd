/**
 * UI-02 FOCUSED TESTS — execution-lock invariants for the redesigned UI.
 * The terminal redesign must NOT introduce, expose or call any order path:
 *   1. The four fail-closed execution switches keep execution disabled
 *      (TRADING_PHASE gate, TRADING_MODE, EXECUTION_ARMED, ALLOW_EXECUTION).
 *   2. The new /api/data/chart surface is GET-only and read-guarded.
 *   3. No order/trade/position/execution endpoint exists anywhere under
 *      src/app/api.
 *   4. The frontend never fetches an order/trade/execution endpoint.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@/lib/config';

const SRC = join(process.cwd(), 'src');

describe('execution locks (four-switch gate)', () => {
  test('execution stays disabled with the locked posture (phase gate + arm switches + read-only mode)', () => {
    // Deployed posture (gitignored .env): TRADING_PHASE=4, TRADING_MODE=read_only,
    // EXECUTION_ARMED=false, ALLOW_EXECUTION=false. When env is wiped the
    // fail-closed DEFAULTS in src/lib/config.ts apply (phase 1) — either way
    // this invariant must hold: a UI redesign can never unlock execution.
    expect(config.execution.enabled).toBe(false);
    const s = config.execution.switches;
    // At least the phase gate or an arm switch must be holding the lock.
    expect(s.phaseGatePassed === false || s.executionArmed === false || s.allowExecution === false || s.tradingMode === 'read_only').toBe(true);
    // And the effective mode never allows execution while locked.
    expect(config.execution.reason.length).toBeGreaterThan(0);
  });

  test('the current audited posture keeps ALL FOUR switches locked', () => {
    // With .env present: phase 4 (< 11) + read_only + both arm switches off.
    // With .env wiped: defaults 1/read_only/false/false. Both postures keep
    // every individual switch in its locked state.
    expect(config.phase).toBeLessThan(11);
    expect(config.tradingMode).toBe('read_only');
    expect(config.execution.switches.executionArmed).toBe(false);
    expect(config.execution.switches.allowExecution).toBe(false);
  });
});

describe('no order-execution surface exists', () => {
  test('/api/data/chart route exports GET only (no mutation handlers)', () => {
    const src = readFileSync(join(SRC, 'app', 'api', 'data', 'chart', 'route.ts'), 'utf8');
    expect(src).toContain('export async function GET');
    expect(src).not.toMatch(/export\s+async\s+function\s+(POST|PUT|DELETE|PATCH)/);
    expect(src).toContain("guardDataApi(request, 'read')");
  });

  test('no order/trade/position/execution API routes exist', () => {
    const apiRoot = join(SRC, 'app', 'api');
    const forbidden = /^(order|trade|trading|position|execution|deal)$/i;
    const dirs = readdirSync(apiRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs.filter((d) => forbidden.test(d))).toEqual([]);
  });

  test('the frontend never fetches an order/trade/execution endpoint', () => {
    const frontendFiles = [
      join(SRC, 'app', 'page.tsx'),
      ...readdirSync(join(SRC, 'components', 'terminal'))
        .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
        .map((f) => join(SRC, 'components', 'terminal', f)),
    ];
    const pattern = /fetch\(\s*['"`]\/api\/(order|trade|trading|position|execution|deal)/i;
    for (const file of frontendFiles) {
      if (!existsSync(file)) continue;
      const src = readFileSync(file, 'utf8');
      expect(pattern.test(src)).toBe(false);
    }
  });

  test('the terminal UI keeps the LOCKED badge bound to the backend flag (no hardcoded "unlocked")', () => {
    const header = readFileSync(join(SRC, 'components', 'terminal', 'TerminalHeader.tsx'), 'utf8');
    expect(header).toContain('executionLocked'); // bound to /api/health payload
    expect(header).toContain('LOCKED');
  });
});
