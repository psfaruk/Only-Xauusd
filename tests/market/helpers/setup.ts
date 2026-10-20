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

// Phase 10.1: DATA_API_TOKEN is read at CALL time by guardDataApi. A token
// provisioned in the developer's .env (needed for the live sync/signal POST
// endpoints after a sandbox rebuild) leaked into tests and turned every
// unauthenticated test request into 401. NOTE: it must be SET TO '' — not
// deleted — because @prisma/client re-loads .env when the PrismaClient in
// src/lib/db.ts is instantiated (dotenv merge semantics: keys ABSENT from
// process.env get restored from disk, keys already present are left alone).
// The same is why MT5_BRIDGE_URL/TOKEN are set to '' above rather than deleted.
process.env.DATA_API_TOKEN = '';

// Phase 7 (Task 30-a): pin the risk-gate env to its DEFAULTS so the
// deterministic engine tests (tests/risk/) can never become dependent on a
// developer .env that might later carry tuned RISK_* values. Same hermeticity
// rule as MT5_BRIDGE_URL/DATA_API_TOKEN above — set (not deleted) so the
// prisma/dotenv merge leaves these keys alone.
process.env.RISK_PERCENT_PER_TRADE = '1.0';
process.env.RISK_MAX_LOTS = '0.10';
process.env.RISK_MIN_LOTS = '0.01';
process.env.RISK_MAX_OPEN_POSITIONS = '2';
process.env.RISK_MAX_PENDING_APPROVALS = '3';
process.env.RISK_MAX_ORDERS_PER_DAY = '6';
process.env.RISK_MAX_SPREAD_PRICE = '0.6';
process.env.RISK_MIN_EQUITY = '0';
process.env.RISK_LOT_STEP = '0.01';

// Phase 11: pin the four-switch execution lock to the LOCKED posture so the
// lock-invariant tests stay hermetic regardless of the developer's .env
// (which may now deliberately arm the Phase 11 demo gate). Same set-not-delete
// rule as above (prisma/dotenv merge semantics).
process.env.TRADING_PHASE = '4';
process.env.TRADING_MODE = 'read_only';
process.env.EXECUTION_ARMED = 'false';
process.env.ALLOW_EXECUTION = 'false';

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
