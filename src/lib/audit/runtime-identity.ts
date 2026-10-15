/**
 * XAUUSD AI Trading Agent — Runtime Identity (Phase 9, Task A2)
 * ----------------------------------------------------------------------------
 * Provides the commit identity under which audit checks run. This is a SAFE,
 * fixed, read-only inspection of the repository's .git metadata — NOT a shell
 * execution and NOT client-controllable. Falls back to null when the metadata
 * is unavailable (e.g. a deployment without .git).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached: string | null | undefined;

/** Best-effort short commit sha of the running tree (null when unknown). */
export function readGitCommit(): string | null {
  if (cached !== undefined) return cached;
  try {
    const root = process.cwd();
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      const sha = readFileSync(join(root, '.git', ref), 'utf8').trim();
      cached = /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 12) : null;
    } else if (/^[0-9a-f]{40}$/.test(head)) {
      cached = head.slice(0, 12);
    } else {
      cached = null;
    }
  } catch {
    cached = null;
  }
  return cached;
}
