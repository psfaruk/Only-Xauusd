# PHASE 13 — Implementation Changelog (Full System Recovery & Production Readiness)

Base: `c82dc4e` (main, working tree was clean). All Phase-13 changes are **uncommitted** — awaiting review.
Scope guard: **no changes** to `src/lib/signal/**`, `src/lib/market/**` (engine/validation/ingestion), `src/lib/analysis/**`, `prisma/**`, `src/instrumentation.ts`, bridge service, or any execution-lock code. No threshold was loosened. No order-execution path introduced.

---

## Confirmed defects → root cause → fix → regression test

### D1 — Manual trigger buttons 503 `MARKET_API_TOKEN_NOT_CONFIGURED` (the "UI partially disabled" symptom)
- **Defect (confirmed):** POST `/api/data/sync`, `/api/analysis/run`, `/api/signal/run` always failed closed in the preview deployment (no `DATA_API_TOKEN`), so every on-demand action was dead; the error surfaced in toasts/chat. The code name refers to the app's own guard — not an external API token.
- **Root cause:** `guardDataApi(…, 'trigger')` in `src/lib/api-guard.ts` required the bearer token unconditionally; the preview posture has no token (secrets must not live in a public frontend).
- **Fix:** explicit, separately-documented preview opt-in `MARKET_API_PUBLIC_TRIGGERS=true` (default **false** — fail-closed default preserved). Applies **only** when `DATA_API_TOKEN` is unset; a configured token always wins (bearer required, flag ignored). Guarded operations are broker-read-only and rate-limited (trigger bucket). Updated: `api-guard.ts`, `config.ts` (parse + snapshot), `.env` (preview flag on), `.env.example`, README §Security (2 sections), 3 route doc-comments.
- **Regression tests:** `tests/market/api.test.ts` — 4 new cases (opt-in passes guard → zod 400; opt-in → route executes; token+flag → 401; defaults → 503 preserved). Existing fail-closed tests extended to control the new flag (`tests/market/api.test.ts`, `tests/analysis/persistence-api.test.ts`).

### D2 — On-demand evaluation between syncs blocked with `TICK_STALE` (~60 % of clicks)
- **Defect (confirmed):** `MARKET_STALE_TICK_SEC=120` vs 5-min sync cadence — a manual evaluation >2 min after the last sync correctly fail-closed, making the button feel dead. Threshold is a **data-quality gate** and was deliberately NOT changed.
- **Fix (UI orchestration only):** `syncBeforeRun` in `src/app/page.tsx` — the analysis & signal buttons now run a manual sync first; if that sync fails, the evaluation still reports the honest stale verdict.
- **Verification:** live E2E — manual runs persisted (`mode:"manual", status:"success"`) followed by honest WAIT; existing pipeline tests unchanged and green.

### D3 — Honest WAIT verdicts rendered as "অজানা সমস্যা (CODE)" ("unknown problem")
- **Defect (confirmed):** 30+ engine reason codes had no Bengali mapping; healthy WAIT/NO_SETUP verdicts read like system failures — a key driver of the "48 hours, something is broken" perception.
- **Fix:** complete Bengali mapping in `src/lib/dashboard/i18n.ts` with honest wording — WAIT-family codes explicitly state `(স্বাভাবিক WAIT)`; fail-closed codes state `(সুরক্ষা)`/`(fail-closed)`; `MARKET_API_TOKEN_NOT_CONFIGURED` guidance now names both configuration options.
- **Regression test:** `tests/ui/reason-code-i18n.test.ts` (new, 4 tests) — scans `src/lib/signal/conditions.ts` for every emittable code and asserts 100 % coverage + WAIT-family wording + live-observed codes.

### D4 — Chat Sheet accessibility warning
- **Defect (confirmed):** Radix console warning — DialogContent without Description.
- **Fix:** `SheetDescription` (sr-only, Bengali) in `src/app/page.tsx`. Verified: warning gone.

---

## Environment/ops actions (no code)
- `.env` (gitignored): appended `MARKET_API_PUBLIC_TRIGGERS=true` (preview posture). **No secret values touched or printed.**
- New read-only diagnostic: `scripts/phase13-pipeline-audit.ts` (48 h classification; kept for future audits).

## Verification summary (all evidence in `audit/`)
- `tsc --noEmit`: 0 errors · ESLint: 0/0 · `bun test`: **540/540 pass** (31 files, 85,420 expects; was 532)
- Live: bridge healthy (Exness-MT5Trial6, 47 ms, GET-only, 401 unauth); 5-min scheduler all-success, 0 rejected candles; evaluations 36–84 ms, all `executionLocked`
- Browser E2E desktop 1280×800 + mobile 375×812: eval/analysis/sync buttons all persist real outcomes; chat grounded reply; TF switching; no page errors; no horizontal overflow; footer at exact document bottom — screenshots `audit/phase13-*.png`
- Lock invariants: `/api/health executionLocked:true`; static tripwire tests green; diff review confirms zero execution/strategy/market/prisma changes

## Not done / out of scope (honest)
- `next build` production build: NOT TESTED (sandbox is dev-server-only)
- No commit / no push (per instructions — diff awaits review)
- Live/demo order execution: intentionally absent and locked (Phase 11/12 gates)
