/**
 * TEST SETUP — MUST BE THE FIRST IMPORT OF EVERY TEST FILE.
 * ----------------------------------------------------------------------------
 * Points DATABASE_URL at an ISOLATED test database (never the real one),
 * prepares its schema once per process, and exposes the fixed test clock.
 *
 * MOCK DISCLOSURE: everything under tests/ uses MOCKED bridge responses and
 * synthetic OHLC numbers for automated testing only — they are NOT real
 * broker data and are never presented as such anywhere in the product.
 */

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export const TEST_DB_PATH = '/home/z/my-project/db/test-market.db';

process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.MARKET_API_PUBLIC_READS = 'true'; // hermetic: never depend on dev .env (sandbox rebuild wiped it 2026-10-15)

// Phase 8: isolate tests from the developer's real .env. Bun auto-loads .env,
// which since Phase 8 carries a real MT5_BRIDGE_URL/credentials for the live
// bridge. Automated tests must exercise the fail-closed paths and their own
// mocks — never a real bridge (accidental live calls would make results
// environment-dependent and could leak timing/credentials into logs).
process.env.MT5_BRIDGE_URL = '';
process.env.MT5_BRIDGE_TOKEN = '';
delete process.env.MT5_LOGIN;
delete process.env.MT5_PASSWORD;
delete process.env.MT5_SERVER;

const g = globalThis as unknown as { __marketTestPrepared?: boolean };

if (!g.__marketTestPrepared) {
  g.__marketTestPrepared = true;
  // Fresh isolated DB with the current schema (never touches db/custom.db —
  // DATABASE_URL above is absolute).
  try {
    rmSync(TEST_DB_PATH, { force: true });
  } catch {
    // ignore
  }
  const res = spawnSync(
    './node_modules/.bin/prisma',
    ['db', 'push', '--skip-generate'],
    {
      cwd: '/home/z/my-project',
      env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}` },
      encoding: 'utf8',
    },
  );
  if (res.status !== 0) {
    throw new Error(`test DB preparation failed: ${res.stderr ?? res.stdout}`);
  }
}

/**
 * Fixed test clock — Wednesday 2026-10-14 12:00:00 UTC (a normal trading day,
 * outside every approximate closure envelope, so gap classification is stable).
 * Value verified: 1791979200 — divisible by 300 and 3600 (M5/M15/H1/H4 aligned).
 */
export const FIXED_NOW_SEC = 1_791_979_200; // 2026-10-14T12:00:00Z (Wednesday)
export const FIXED_NOW_MS = FIXED_NOW_SEC * 1000;
export const fixedNow = () => FIXED_NOW_MS;
