#!/usr/bin/env bun
/**
 * secret-scan.mjs — repository secret scanner (Phase 0, master prompt task 5).
 * ----------------------------------------------------------------------------
 * Scans every GIT-TRACKED file (never untracked local files) for secret-like
 * content and FAILS (exit 1) on any hit. Secret VALUES are never printed —
 * only the offending file path + line number + the rule id that matched.
 *
 * Rules:
 *   1. ENV_SECRET_ASSIGNMENT — a real-looking credential assignment in any
 *      tracked file: MT5_PASSWORD / MT5_LOGIN / MT5_BRIDGE_TOKEN /
 *      DATA_API_TOKEN / *_API_KEY etc. set to a NON-placeholder value
 *      (placeholder forms: empty, YOUR_..., <...>, changeme, xxx).
 *   2. BRIDGE_TOKEN_SHAPE — the known local bridge-token shape
 *      (xauusd-bridge-<alnum>) anywhere in a tracked file.
 *   3. TRACKED_ENV_ARTIFACT — .env or .zscripts/env.golden must never be
 *      tracked again (defense in depth beyond .gitignore).
 *   4. BROKER_PASSWORD_SHAPE — an Exness-style password fragment adjacent to
 *      a login context (defensive; the primary rule is #1).
 *
 * Usage:  bun .zscripts/secret-scan.mjs        (also wired as `bun run secrets:scan`)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROJECT = new URL('..', import.meta.url).pathname;

let trackedFiles = [];
try {
  trackedFiles = execFileSync('git', ['ls-files'], { cwd: PROJECT, encoding: 'utf8', timeout: 30_000 })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch (e) {
  console.error('[secret-scan] FATAL: could not list tracked files (git missing?)');
  process.exit(1);
}
if (trackedFiles.length === 0) {
  console.error('[secret-scan] FATAL: no tracked files — run from the repository root');
  process.exit(1);
}

/** Keys whose assignment is a secret when the value is real. */
const SECRET_ENV_KEYS = [
  'MT5_PASSWORD',
  'MT5_LOGIN',
  'MT5_BRIDGE_TOKEN',
  'DATA_API_TOKEN',
  'GLM_API_KEY',
  'ZAI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
];
const PLACEHOLDER = /^(?:|YOUR_[A-Z0-9_]*|<[^>]*>|changeme|change-me|xxx+|\*\*\*+|placeholder|REDACTED(?:-[A-Z]+)?|test-token.*)$/i;

const findings = [];
const addFinding = (rule, file, line) => findings.push({ rule, file, line });

for (const file of trackedFiles) {
  // Rule 3: tracked env artifacts are forbidden outright.
  if (file === '.env' || file === '.zscripts/env.golden' || file.endsWith('/.env') || /\/env\.golden$/.test(file)) {
    addFinding('TRACKED_ENV_ARTIFACT', file, 0);
    continue;
  }
  // Only scan text-ish files (cheap extension filter; binaries can't hold
  // meaningful env assignments for this threat model).
  if (!/\.(ts|tsx|js|mjs|cjs|json|md|txt|yml|yaml|sh|py|prisma|sql|html|css|example|golden|env|gitignore|lock)$/i.test(file) && !file.startsWith('.gitignore') && !file.includes('Caddyfile') && !file.startsWith('README')) {
    if (!/^(\.env\.example|\.zscripts\/|docs\/|audit\/|skills\/|scripts\/|tests\/|upload\/|mini-services\/|src\/|prisma\/|db\/|examples\/)/.test(file)) continue;
  }

  let text;
  try {
    text = readFileSync(`${PROJECT}${file}`, 'utf8');
  } catch {
    continue; // deleted/renamed between listing and read — skip
  }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Rule 1: secret env assignment with a real-looking value.
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?(.*?)["']?\s*$/.exec(line);
    if (m && SECRET_ENV_KEYS.includes(m[1])) {
      const value = m[2].trim();
      if (value.length > 0 && !PLACEHOLDER.test(value)) {
        addFinding('ENV_SECRET_ASSIGNMENT', file, i + 1);
        continue;
      }
    }
    // .env.example style: KEY=YOUR_... is fine; KEY=<real> is not.
    if (m && SECRET_ENV_KEYS.includes(m[1]) && !PLACEHOLDER.test(m[2].trim()) && m[2].trim().length > 0) {
      addFinding('ENV_SECRET_ASSIGNMENT', file, i + 1);
      continue;
    }

    // Rule 2: the known bridge token shape.
    if (/xauusd-bridge-[a-z0-9]{4,}/i.test(line)) addFinding('BRIDGE_TOKEN_SHAPE', file, i + 1);

    // Rule 4: a LITERAL password value (digits+letters mix, quoted or bare)
    // assigned to a password-ish key. Code contexts (typeof checks, TS type
    // annotations, process.env reads, interface fields) are excluded.
    const isCodeContext =
      /typeof\s|process\.env\.|===\s|interface\s|:\s*(string|number|boolean|unknown|any|null|undefined|Record<)|body\.|params\.|\.password\b.*string/i.test(line);
    if (!isCodeContext) {
      const pm = /["']?(password|passwd|pwd|MT5_PASSWORD)["']?\s*[:=]\s*["']([A-Za-z0-9!@#$%^&*()_+\-/]{6,})["']/i.exec(line);
      if (pm) {
        const val = pm[2];
        // A real password shape: contains BOTH a digit and a letter (rules out
        // pure words like "secret" prose) and is not a placeholder.
        if (/\d/.test(val) && /[A-Za-z]/.test(val) && !/your|placeholder|example|redacted|\*\*\*|xxx/i.test(val)) {
          addFinding('BROKER_PASSWORD_SHAPE', file, i + 1);
        }
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`[secret-scan] FAIL — ${findings.length} finding(s) in tracked files:`);
  for (const f of findings) {
    console.error(`  ${f.rule}: ${f.file}${f.line > 0 ? `:${f.line}` : ''}`);
  }
  console.error('\nSecrets must NEVER be committed. Rotate any exposed credential with its provider,');
  console.error('remove the finding from the current tree, and see docs/security-rotation.md for the');
  console.error('git-history cleanup procedure.');
  process.exit(1);
}

console.log(`[secret-scan] PASS — ${trackedFiles.length} tracked files scanned, 0 secret findings.`);
