# Security: Credential Rotation & Git-History Cleanup Runbook

**Status: ACTION REQUIRED (external, user-owned steps)** — produced by the
Phase 0 deep-remediation (signal-only contract). This document never contains
real credential values.

## 1. What happened (incident summary)

During Phases 11–14 the local runtime `.env` (containing the Exness broker
login/password and the local bridge token) and `.zscripts/env.golden` (a copy)
were **force-committed to git** as an anti-rollback self-healing measure, and
credential values appeared in two lines of `worklog.md`. All of it was pushed
to the remote repository (github.com/psfaruk/Only-Xauusd) in commit history.

Although the repository is intended to be private, every credential that
reached git history must be treated as **potentially compromised** until
rotated, because:

- repository visibility may change or the account may be compromised;
- anyone who cloned/fetched while it was readable has the values;
- the values remain in the git object database even after deletion from the
  current tree.

## 2. What was already fixed in the current tree (Phase 0)

| Item | Action |
|---|---|
| `.env` | Untracked (`git rm --cached`), stays git-ignored; local file kept for runtime |
| `.zscripts/env.golden` | **Deleted** from the tree and git-ignored |
| `worklog.md` | Both credential-bearing lines redacted to `[REDACTED-*]` placeholders |
| `.zscripts/ensure-env.mjs` | Rewritten FAIL-CLOSED: never restores from git or a committed golden file; the only fallback is the **local, git-ignored** `.zscripts/env.local` operator backup; missing secrets produce a clear non-secret error |
| `.env.example` | Placeholders only (`YOUR_BROKER_PASSWORD` etc.), read-only defaults |
| Secret scanner | `.zscripts/secret-scan.mjs` (`bun run secrets:scan`) fails on any tracked secret; run in CI before every push |
| Order execution | Entire execution module + bridge order layer DELETED (see the main remediation report) — the broker account is now reachable by this app **read-only** (market data) regardless of credentials |

## 3. REQUIRED external user actions (cannot be done from this repo)

1. **Rotate the Exness account password** (Exness personal area → security).
   The old password existed in git history; changing it invalidates it.
2. **Rotate the MT5 bridge token**: generate a new random token
   (e.g. `openssl rand -hex 16`), update it in the LOCAL `.env`
   (`MT5_BRIDGE_TOKEN=...`), copy to the local backup
   (`cp .env .zscripts/env.local`), and restart the bridge
   (`python3 .zscripts/relaunch-bridge.py`). The old token loses all power
   once the bridge restarts with the new one — the bridge is the ONLY
   consumer of that token.
3. **Confirm the GitHub repository is PRIVATE** (Settings → General → Danger
   Zone → Change visibility). If it was public even briefly, treat both
   credentials as definitely compromised and rotate immediately.

## 4. Optional: purge the secrets from git history

Removing secrets from the CURRENT tree does not remove them from history.
If you want the history clean (recommended before any future sharing), run
ONE of the following from a fresh clone, then force-push:

```bash
# ── Option A: git filter-repo (recommended, fast) ─────────────────────────
pip install git-filter-repo
git clone https://github.com/psfaruk/Only-Xauusd.git only-xauusd-clean
cd only-xauusd-clean
git filter-repo --invert-paths --path .env --path .zscripts/env.golden
# Build replacements.txt from the OLD values (recover them from the pre-purge
# history WITHOUT copying them into any tracked file, e.g.
#   git show <old-sha>:.env   — then write lines like  <old-value>==>[REDACTED]
# to an UNTRACKED replacements.txt and run:
git filter-repo --replace-text replacements.txt
git remote add origin https://github.com/psfaruk/Only-Xauusd.git
git push --force --set-upstream origin main

# ── Option B: BFG repo-cleaner (requires Java) ────────────────────────────
bfg --delete-files .env --delete-files env.golden --replace-text replacements.txt
git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push --force
```

Impact plan (why this is safe HERE):

- the repository is ~1 day old with a single writer (this machine);
- no other clones, forks, branches or open PRs exist;
- a full pre-rewrite backup exists on this machine (`.git` + the pushed
  remote state before the force push);
- after the rewrite, re-run `bun run secrets:scan` and confirm PASS before
  any further work.

**Rotation remains mandatory even after the history purge** — history
cleaning does not un-leak anything already fetched.
