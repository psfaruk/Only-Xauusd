/**
 * REGRESSION TEST — migration chain integrity (master audit fix E1).
 * ---------------------------------------------------------------------------
 * Root cause being pinned: the migration chain had DRIFTED from the schema —
 * `ValidationRun` and `PaperSignalOutcome` had no CREATE TABLE migration
 * (the old 20261015120000_phase10_3a ALTERed a table no migration created),
 * and the runtime DB was provisioned via `prisma db push` (no
 * `_prisma_migrations` table), so `prisma migrate deploy` on a FRESH host
 * failed with "no such table: PaperSignalOutcome".
 *
 * Fix under test: prisma/migrations now contains a single consolidated
 * baseline (0_baseline_full_schema) generated from the schema itself.
 *
 * Phase 11-E (2026-10-20): PaperCandidateOutcome added ADDITIVELY to both the
 * schema and the consolidated baseline — the pinned list is now 17 tables.
 *
 * This test proves, on every run, that a brand-new database provisioned with
 * `prisma migrate deploy` receives EXACTLY the application tables defined
 * by prisma/schema.prisma. The runtime DB (db/custom.db) is never touched.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const prismaBin = require_.resolve('prisma/build/index.js');
const REPO_ROOT = join(import.meta.dir, '..', '..');

const APP_TABLES = [
  'AiReview',
  'AnalysisRun',
  'BacktestRun',
  'DataQualityIssue',
  'ExecutionLog',
  'MarketCandle',
  'MarketLatestTick',
  'PaperCandidateOutcome',
  'PaperSignalOutcome',
  'RiskCheck',
  'Signal',
  'SignalEvaluation',
  'SymbolSpec',
  'SyncRun',
  'SystemEvent',
  'TradeApproval',
  'ValidationRun',
];

function sqliteTables(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'",
      )
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
  } finally {
    db.close();
  }
}

function runPrisma(args: string[], dbUrl: string) {
  return spawnSync('node', [prismaBin, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('migration chain integrity (master audit fix E1)', () => {
  test('prisma migrate deploy on a fresh DB creates exactly the 16 schema tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-chain-'));
    const dbFile = join(dir, 'scratch.db');
    try {
      const res = runPrisma(['migrate', 'deploy'], `file:${dbFile}`);
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      expect(res.status).toBe(0);
      expect(out).toContain('applied'); // a migration actually ran

      expect(sqliteTables(dbFile)).toEqual(APP_TABLES);

      // The Prisma bookkeeping table proves this was a real migrate-deploy
      // run (db push would not create it).
      const db = new Database(dbFile, { readonly: true });
      try {
        const bookkeeping = db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name = '_prisma_migrations'")
          .all();
        expect(bookkeeping.length).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test('the schema itself validates (prisma validate)', () => {
    const res = runPrisma(['validate'], 'file::memory:');
    expect(res.status).toBe(0);
  }, 90_000);
});
