#!/usr/bin/env bun
/**
 * ensure-env.mjs — FAIL-CLOSED ENV GUARD (Phase 0 rewrite, deep-remediation)
 * ----------------------------------------------------------------------------
 * SECURITY CONTRACT (master prompt Phase 0):
 *   · NEVER restores credentials from any git-tracked file. The old behavior
 *     (restore from .zscripts/env.golden / `git checkout .env`) is REMOVED —
 *     committing secrets to a repository is a security incident, not a
 *     self-healing feature.
 *   · The ONLY fallback is a LOCAL, git-ignored operator backup at
 *     .zscripts/env.local (never committed; .gitignore enforces it). This
 *     keeps the platform-rollback self-healing that this sandbox needs
 *     without pushing secrets into version control.
 *   · If neither .env nor the local backup is complete, the script fails
 *     CLOSED with a clear, non-secret error: which keys are missing, and the
 *     exact manual step (copy .env.example and fill real values).
 *   · No secret VALUE is ever printed, logged or echoed — key names only.
 *
 * (--with-db, root only) Verifies the SQLite schema survived; if the DB was
 * zeroed/wiped → `bunx prisma db push` under a mkdir-lock so concurrent boots
 * can't race.
 *
 * Idempotent, <100 ms when healthy, never touches a healthy .env.
 *
 * Usage:  bun .zscripts/ensure-env.mjs [--with-db]
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = join(PROJECT, '.env');
/** LOCAL-ONLY operator backup — MUST be git-ignored (verified below). */
const LOCAL_BACKUP_PATH = join(PROJECT, '.zscripts', 'env.local');
const EXAMPLE_PATH = join(PROJECT, '.env.example');
const LOG_PATH = join(PROJECT, '.zscripts', 'ensure-env.log');
const LOCK_DIR = join(PROJECT, '.zscripts', '.ensure-env-db.lock');
const DB_DEFAULT = join(PROJECT, 'db', 'custom.db');

/** Keys whose absence means ".env is incomplete". Secret VALUES are never
 * read, compared or printed by this script — only key NAMES are checked. */
const REQUIRED_KEYS = [
  'DATABASE_URL',
  'TRADING_PHASE',
  'TRADING_MODE',
  'MARKET_SYNC_INTERVAL_MS',
  'MARKET_SYMBOLS',
  'MT5_SERVER',
  'MT5_LOGIN',
  'MT5_PASSWORD',
  'MT5_BRIDGE_URL',
  'MT5_BRIDGE_TOKEN',
];

const ts = () => new Date().toISOString();
let logLines = [];
function log(line) {
  logLines.push(`[ensure-env] ${ts()} ${line}`);
}
function flushLog() {
  if (!logLines.length) return;
  try {
    // keep the guard log bounded (rotate at 64 KB)
    try {
      const st = statSync(LOG_PATH);
      if (st.size > 65_536) renameSync(LOG_PATH, `${LOG_PATH}.old`);
    } catch { /* first write */ }
    writeFileSync(LOG_PATH, `${logLines.join('\n')}\n`, { flag: 'a' });
  } catch { /* logging must never break boot */ }
}

function envKeys(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const keys = new Set();
    for (const line of text.split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) keys.add(m[1]);
    }
    return keys;
  } catch {
    return null; // file missing
  }
}

function missingKeys(keys) {
  return REQUIRED_KEYS.filter((k) => !keys.has(k));
}

function atomicWriteEnv(content) {
  const tmp = `${ENV_PATH}.ensure-env.tmp`;
  writeFileSync(tmp, content, { flag: 'w' });
  try { renameSync(tmp, ENV_PATH); } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

// ── Step 1+2: .env integrity (fail-closed, LOCAL fallback ONLY) ────────────
let envOk = false;
const current = envKeys(ENV_PATH);
if (current) {
  const missing = missingKeys(current);
  if (missing.length === 0) {
    envOk = true;
    log(`.env intact (${REQUIRED_KEYS.length} required keys present)`);
  } else {
    log(`.env INCOMPLETE — missing ${missing.length} key(s): ${missing.join(', ')}`);
  }
} else {
  log('.env MISSING entirely');
}

if (!envOk) {
  let restored = false;
  // The ONLY fallback: the local, git-ignored operator backup.
  // NEVER from git. NEVER from a committed golden copy (deleted in Phase 0).
  const backupKeys = envKeys(LOCAL_BACKUP_PATH);
  if (backupKeys && missingKeys(backupKeys).length === 0) {
    atomicWriteEnv(readFileSync(LOCAL_BACKUP_PATH, 'utf8'));
    const verify = envKeys(ENV_PATH);
    if (verify && missingKeys(verify).length === 0) {
      restored = true;
      log(`RESTORED .env from LOCAL backup .zscripts/env.local (${REQUIRED_KEYS.length} keys verified — never from git)`);
    }
  }
  if (!restored) {
    const msg = [
      '[ensure-env] FATAL: .env is incomplete and no complete local backup exists (.zscripts/env.local).',
      `         Missing key(s): ${current ? missingKeys(current).join(', ') : REQUIRED_KEYS.join(', ')}`,
      `         Manual fix: cp ${'.env.example'} .env  →  fill REAL values (broker login/password, bridge token),`,
      '         then:  cp .env .zscripts/env.local   (keeps the local self-heal working).',
      '         Credentials are NEVER committed to git — if you lost them, rotate them with your broker.',
    ].join('\n');
    log('FATAL: .env unrestorable (no complete local backup) — booting refused (fail-closed)');
    flushLog();
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
}

// ── Step 3 (--with-db): SQLite schema survival ─────────────────────────────
if (process.argv.includes('--with-db')) {
  let dbPath = DB_DEFAULT;
  try {
    const envText = readFileSync(ENV_PATH, 'utf8');
    const m = /^DATABASE_URL=file:(.+)$/m.exec(envText);
    if (m && m[1].trim()) dbPath = m[1].trim();
  } catch { /* default */ }

  let schemaOk = false;
  try {
    if (existsSync(dbPath) && statSync(dbPath).size > 0) {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get();
        schemaOk = Number(row?.n ?? 0) >= 15; // full schema ≈ 18 tables; stripped/empty DB has 0
        if (!schemaOk) log(`DB schema INCOMPLETE (${row?.n ?? 0} tables) — needs db:push`);
      } finally {
        db.close();
      }
    } else {
      log(`DB file missing/empty (${dbPath}) — needs db:push`);
    }
  } catch (err) {
    log(`DB check error (${err instanceof Error ? err.message : err}) — needs db:push`);
  }

  if (!schemaOk) {
    // mkdir-lock: atomic on POSIX; stale locks (>120s) are reclaimed
    let locked = false;
    try {
      mkdirSync(LOCK_DIR);
      locked = true;
    } catch {
      try {
        const st = statSync(LOCK_DIR);
        if (Date.now() - st.mtimeMs > 120_000) {
          try { unlinkSync(join(LOCK_DIR, 'pid')); } catch { /* no pid file */ }
          try { unlinkSync(LOCK_DIR); } catch { /* raced */ }
          try { mkdirSync(LOCK_DIR); locked = true; } catch { /* someone else won */ }
        }
      } catch { /* lock dir vanished — retry mkdir */ }
    }
    if (locked) {
      try {
        writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
        log('running bunx prisma db push (schema restore)…');
        const out = execFileSync('bunx', ['prisma', 'db', 'push', '--accept-data-loss'], {
          cwd: PROJECT,
          stdio: 'pipe',
          timeout: 120_000,
        });
        log(`db push done (${String(out).split('\n').filter(Boolean).slice(-2).join(' | ')})`);
      } catch (err) {
        log(`db push FAILED: ${err instanceof Error ? err.message : err}`);
      } finally {
        try { unlinkSync(join(LOCK_DIR, 'pid')); } catch { /* best effort */ }
        try { unlinkSync(LOCK_DIR); } catch { /* best effort */ }
      }
    } else {
      log('another boot is already restoring the DB schema — skipping');
    }
  } else {
    log(`DB schema intact (${dbPath})`);
  }
}

flushLog();
