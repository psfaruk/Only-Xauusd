# Full-App Final Report — Master Audit, Repair & Production Readiness

**Date:** 2026-10-16 · **Task:** Master full-app audit & repair (Phases A–K)
**Start:** `main` @ `15b56f4` (clean, synced with `origin/main`) · **End:** see §13 (commit/push status)
**Method:** 5 parallel read-only audit agents (Tasks 2-a…2-e) → evidence-based baseline (`audit/full-app-baseline.md`) → prioritized fixes → full verification stack → browser E2E. **Prior findings were re-verified, never assumed.**

---

## 1. What was verified BEFORE any change (see full-app-baseline.md §0–§7)

Runtime at audit time: dev server + bridge (connected+authenticated Exness-MT5Trial6) + 5-min scheduler all live; 1,918 candles across 4 TFs; tick VALID; 40 sync runs (0 stuck); 39 evaluations (30 WAIT / 8 NO_SETUP / 1 BLOCKED / 0 setups — consistent with the frozen 30-day funnel); four execution locks live-verified locked.

## 2. Confirmed root causes (baseline §3, all fixed this session unless noted)

| ID | Root cause | Severity |
|---|---|---|
| A1 | `/api/ai/verify` was the ONLY unguarded action route (no `guardDataApi`, no per-IP limit) — anonymous GLM-quota burn possible even in production posture; 3 docs + a runtime-check falsely claimed it was guarded | HIGH-MED |
| E1 | **Migration drift**: no CREATE TABLE for `ValidationRun`/`PaperSignalOutcome`; old chain ALTERed a table no migration created; runtime DB built via `db push` → `prisma migrate deploy` on a fresh host FAILED | HIGH (deploy) |
| B-D1 | 3 orphaned API-error codes — status/backtest outages masqueraded as "empty" across 5 UI surfaces | MED |
| B-D3 | Untruthful phase text: footer hardcoded "Phase 12" gate vs actual Phase-11 gate; `phaseLabel "Phase 4 of 12"` presented a lock value as roadmap progress | MED-LOW |
| B-D2 | LOCKED badge label invariant (could not reflect an unlock); "Order Execution" mini-card fully static | MED-LOW |
| D-D1 | Header tagline claimed a "GLM রিভিউ" signal-review layer that does not exist anywhere | MED (honesty) |
| B-D4 | Static Phase-1 GLM capability constants rendered as current facts; runtime `liveStatus` returned but never rendered | LOW |
| C-D2 | Bridge never applied the live-measured broker→UTC offset to quote/candle timestamps (documented contract unimplemented; latent — offset is 0 today) | MED (latent) |
| C-D1 | `quality.ts` operator-precedence bug discarded the demo-tick check | LOW |
| A5 | Validation backwaters: `signal/run` swallowed malformed JSON→`{}`; `data/health`+`audit/environment` accepted unvalidated symbols | LOW |
| D-M1/M2 | Post-Gate-3 BLOCKED rows omitted verified `digits`; `TICK_STALE` absent from the reason-code union | MINOR |
| C-D3/D4 | SymbolSpec upsert failure swallowed silently; crashed syncs could leave orphan `running` rows forever | INFO |
| A2/A3/E3 | Doc drifts: backtest route comment, README token scope + "১২টি মডেল" (16 actual), static-audit model list missing 2 ACTIVE Phase-10 models, SystemView static "১৪টি মডেল" copy | LOW |
| E4 | No `typecheck`/`db:validate` scripts | LOW |
| E6 | Throwaway `tmp-audit-db.ts` tracked | TRIVIAL |

**Documented, deliberately NOT changed** (baseline §3 decision table): dual error-envelope shapes (all codes actionable — unification is a wide refactor, deferred); `MARKET_API_TOKEN_NOT_CONFIGURED` naming (clients/tests depend on it; documented in 3 places); `next.config.ts ignoreBuildErrors:true` (build not runnable in sandbox; tsc enforced separately — remediation documented); XFF rate-limit spoofing + multi-worker scheduler lock (production-hardening notes in `docs/`); bridge timing-safe compare (informational).

## 3. Fixes implemented (27 files + 2 new docs + 1 new test dir)

**API security (A1):** `guardDataApi(request,'trigger')` added to `POST /api/ai/verify` (before any GLM call/SystemEvent write); route doc-comment updated; `runtime-checks.ts` claim wording corrected; 2 phase-8/9 audit docs got dated correction notes (history preserved, not rewritten); 2 regression tests (401-with-token, 503-fail-closed).

**DB/deploy (E1):** broken 6-migration chain replaced by a single consolidated baseline `0_baseline_full_schema` generated from the schema itself; verified on scratch DBs — `migrate deploy` creates exactly the 16 app tables AND `prisma migrate diff` against a `db push` scratch DB is EMPTY (schemas identical); runtime DB untouched (still push-managed; 16 tables verified identical); regression test `tests/db/migration-chain.test.ts` provisions a fresh DB via the real `prisma migrate deploy` on every run. New scripts: `typecheck`, `db:validate`, `db:deploy`.

**Engine/pipeline:** quality.ts precedence fix (demo-tick check now counts; regression test: demo tick + no candles → `SOURCE_DEMO`); `digits` passed on all 4 post-Gate-3 BLOCKED paths (rules snapshots no longer understate provenance); `TICK_STALE` added to the `SignalReasonCode` union; `signal/run` malformed JSON → 400 (3 tests); `data/health` + `audit/environment` symbols zod-validated against the allowlist (2 tests); SyncRun orphan reaper (>15-min `running` → `failed/ORPHANED_SYNC_RUN` at next sync start); SymbolSpec upsert failure now writes a `SYMBOL_SPEC_UPSERT_FAILED` SystemEvent.

**Bridge (C-D2):** `/api/quote` and `/api/candles` now subtract the live-measured `brokerOffsetSec` (broker→UTC normalization per the documented contract). **Live-verified after restart:** quote `ts` drift vs local clock = **0s**, candles byte-identical (next sync: `success, 0 rejected, 0 duplicates` — idempotent upserts matched all 1,876 existing keys). A broker clock shift can no longer silently skew the timeline.

**UI honesty/UX pack:** all 3 orphaned error codes threaded to consumers (MarketSnapshot + SystemMiniCards + SystemView market tab get explicit "API অনুপলব্ধ" banners; bridge mini-card says "অজানা" instead of asserting facts from null; backtest outage ≠ "রান নেই"); sync button no longer silently disabled when the status API is down (sync is an independent POST; tooltip explains); LOCKED badge derives label from `health.executionLocked` (+`data-execution-locked` attribute; mini-card derived too); truthful `phaseLabel` "Phase 4 — Read-Only Research" (no "of 12"); `EXECUTION_GATE_PHASE=11` exported once — footer now states the SAME gate the lock logic uses (was hardcoded "Phase 12"); GLM `liveStatus` (runtime SystemEvent) rendered with timestamp; capability badges time-stamped as historical evidence; tagline reworded to "ডিটারমিনিস্টিক ইঞ্জিন সর্বোচ্চ কর্তৃত্ব · GLM শুধু ব্যাখ্যাকারী (চ্যাট)"; chat textarea focus-visible ring; IME composition guard (Bengali Enter-to-commit no longer sends); fetch timeouts everywhere (20s refresh, 90–120s actions/chat — hung requests can no longer wedge the send button); TF-switch dim+spinner overlay (stale frame no longer mistaken for the new TF); toggle chips ≥24px; disclaimer text zinc-600→zinc-400 (contrast); dead code removed (viewRef, inputRef, unused useRef import); DB-tab model summary now payload-derived.

**Docs:** README (16 models; token scope covers all guarded routes); `docs/operations-and-troubleshooting.md` (NEW — run/restart, health matrix, migrate-vs-push decision, symptom→fix runbook incl. the 48h-no-signal playbook, safety invariants, honest limitations); `docs/environment-configuration.md` (NEW — preview vs production postures, guard buckets, variable groups, rotation policy, posture verification commands); `scripts/tmp-audit-db.ts` → `scripts/db-status.ts`.

## 4. Tests actually executed (exact results)

| Command | Result |
|---|---|
| `bun test` (full suite) | **549 pass / 0 fail** — 85,454 expects, 32 files (up from 540; +9 new: 2 migration-chain, 2 ai/verify guard, 3 A5 validation, 1 quality precedence, 1 phase-label truthfulness; lock-badge test strengthened) |
| `bunx tsc --noEmit` | **0 errors** |
| `bunx eslint .` | **0 problems** |
| `bun run db:validate` | **schema valid** |
| `prisma migrate deploy` (scratch, in-test) | **applied; exactly 16 app tables + bookkeeping** |
| `prisma migrate diff` deploy-DB vs push-DB | **empty migration (schemas identical)** |

## 5. Market-data & signal-pipeline verification (live, read-only)

- Bridge: connected+authenticated after restart; quote `ts`/local drift **0s**; candles 300s-spaced, forming flag correct.
- App sync (manual, post-bridge-change): `success — 0 rejected, 0 duplicates` (timestamps byte-identical, offset 0 confirmed end-to-end).
- Autonomous loop: scheduled syncs + `NO_SETUP [ZONE_INVALIDATED]` evaluations continuing (latest 15:53:27Z, engine 9.0.0, fingerprint recorded).
- Manual signal evaluation via UI button (golden path): sync-first → evaluation → **persisted** `NO_SETUP [ZONE_INVALIDATED]` → returned by `/api/signal/latest` → rendered with full শর্ত-বাই-শর্ত checklist. WAIT/NO_SETUP remain **legitimate verdicts** (retest-stage trio rejects ~72% of bars; ≈1 setup-episode/1.4 days on real data) — no threshold was loosened anywhere.

## 6. Browser E2E (agent-browser, desktop 1280×800 + mobile 375×812)

- **Desktop:** footer "Phase 4 — Read-Only Research" + "Live Trading: Phase 11 রিলিজ-গেট…" ✅; LOCKED badge `data-execution-locked="true"` ✅; truthful tagline ✅; live chart (forming-candle legend updating) + TF switch M5→M15→H4 ✅; signal-eval button → persisted verdict ✅; GLM `liveStatus` rendered (GLM_VERIFY_OK + Dhaka timestamp) ✅; **zero console/page errors** ✅. Screenshot: `audit/fullapp-desktop-terminal.png`.
- **Mobile:** all 5 nav views — **zero horizontal overflow**; footer at exact document bottom (docH 1610); chat send → **grounded live reply** (real Bid/Ask/Spread, LIVE freshness); a transient GLM round-2 timeout produced the **honest error bubble with retry** (no fabricated reply) and a manual retry succeeded. Screenshots: `audit/fullapp-mobile-chat.png`, `fullapp-mobile-chat-ok.png`.

## 7. NO_SETUP root causes (from actual run data — no invented statistics)

Current retained window (since 12:56Z restore): WAIT 30 / NO_SETUP 8 / BLOCKED 1 / setups 0. Dominant reason codes: `RETEST_PENDING`, `HTF_H1_OPPOSITE`, `ZONE_INVALIDATED` (×8 today), `STRUCTURE_BREAK_TOO_OLD` — the same retest-stage rejections documented in the 30-day frozen funnel (1,999 evals → 48 valid (2.4%) → 22 episodes). The original 48-hour outage itself was **environmental** (sandbox rebuild wiped `.env`+DB → pipeline down → fail-closed), documented in `audit/signal-pipeline-root-cause.md`; today every gate passes and the engine's WAIT/NO_SETUP verdicts are genuine mixed-HTF market context, each with a full per-rule trace.

## 8. Security review

No secrets in any diff (scanned); `.env` gitignored, `.env.example` placeholders only; token compare timing-safe; bridge masks login; `/api/health` secret-free (live-verified); no order/execution endpoint anywhere (3 test tripwires + runtime check); rate limit runs before auth; the one real gap (A1) is closed and regression-tested. **Credential-rotation reminder:** the MT5 password and a GitHub PAT were exposed in chat earlier — both must be rotated by the user (see §12).

## 9. Four execution locks — UNCHANGED and LOCKED

Live `/api/health`: `executionLocked:true`, `tradingMode:read_only`, reason "Phase 4 is read-only by design (Phase 11 gate required)". Lock logic touched only to export the gate constant + truthful label — `config.execution.enabled` semantics byte-identical; test-pinned (`execution-lock-invariants`: all four switches locked, no-unlock, no order surface, LOCKED badge derivation).

## 10. Remaining blockers & unverified areas (honest)

1. **Persistent hosting** still required for real production (ephemeral sandbox wipes env+DB — the original root cause class). Deployment runbook: `docs/operations-and-troubleshooting.md` §3–4.
2. **Production build not runnable in the sandbox** (platform constraint) — run `bun run build && bun run start` on the persistent host; consider flipping `ignoreBuildErrors` there after the build passes.
3. **GLM completion-timeout path has no automated test** (the honest fallback was live-verified in E2E instead — a transient round-2 timeout produced the correct error bubble); tool-loop fakes cover the rest.
4. Multi-worker scheduler lock + XFF hardening are documented preconditions for scaled deployments.
5. Browser E2E remains a manual documented procedure (screenshots in `audit/`), not CI-automated.

## 11. Working tree / diff hygiene

40 files changed (+650/−461): 24 source, 8 tests (4 modified + 1 new file), 6 docs/audit + 2 new docs, migration consolidation (6→1), 1 rename, worklog. No generated DB files, no logs, no secrets, no unrelated changes.

## 12. Required user actions (security)

1. **Rotate the MT5 password** (exposed in an earlier chat) — Exness account → change password → update `MT5_PASSWORD` in `.env`.
2. **Revoke the GitHub PAT** pasted in chat (`ghp_…`) — https://github.com/settings/tokens → Delete.

## 13. Commit / push status

Committed and pushed at delivery time — exact hashes and the verified remote tip are recorded in `worklog.md` Task 28 (final section) at the moment of the push; this report is written pre-commit by design so the push evidence lives in one authoritative place.
