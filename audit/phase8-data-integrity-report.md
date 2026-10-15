# Phase 8 — Live Data Integrity Report (Tasks 2, 3, 4)

**Date:** 2026-10-15 (Asia/Dhaka) · **Scope:** quote integrity, candle-history validation, database integrity & repeatable sync
**Live path in force:** Exness-MT5Trial6 gateway `47.130.41.116:443` → authenticated MT5 web-terminal session (`:3031` read-only bridge) → REST contract → ingestion → SQLite.

> Every verdict below is backed by an executed command or API call from this session. Fixture-based tests are labeled as such; they are never presented as live-broker evidence.

## 1. Quote Integrity Monitor (Task 2) — PASS

Module `src/lib/market/integrity.ts` + read-only endpoint `GET /api/data/health` (guard: `guardDataApi` read semantics, rate-limited, no secrets).

| Requirement | Verdict | Evidence |
|---|---|---|
| Source labeled (broker/relay/cache/synthetic) | **PASS** | `classifySource()` maps bridge labels honestly; live response: `"sourceClass": "broker"`, `"sourceLabel": "Authenticated Exness MT5 session (direct web-terminal protocol)"`. `demo` → `synthetic`, `mt5` without auth → `cache` (pinned by tests). |
| Socket open ≠ LIVE | **PASS** | LIVE requires `authenticated=true` AND fresh VALID quote. Browser-verified badge: "LIVE — সত্যিকারের ব্রোকার ফিড" with `bid 4143.736 / ask 4143.976, spread 0.240, কোট-বয়স 0s`. |
| Freshness states (LIVE/STALE/DEGRADED/DISCONNECTED) | **PASS** | Configurable threshold (`MARKET_STALE_TICK_SEC=120`). Live probe: LIVE; stale injection (5-min-old quote): STALE + `signalPermitted:false`; 1-hour-old: DEGRADED; dead bridge: DISCONNECTED with `bid:null` (nothing fabricated). |
| Invalid numerics rejected, never replaced | **PASS** | Crossed bid/ask → `TICK_CROSSED`, `validationStatus=INVALID`; non-positive → `TICK_NON_POSITIVE`. No fallback substitution exists. |
| Wrong symbol handling | **PASS** | Symbol not in broker table → 404 at the bridge; integrity reports `TICK_UNAVAILABLE`, `bid:null`. XAUUSDm resolved by **exact name from the broker symbol table** (id 442, digits 3, "Gold vs US Dollar") — never name-guessed. |
| Reconnect count + last error surfaced | **PASS** | `reconnects: 0`, `lastError: null` (live session); errors recorded on degenerate/out-of-order quotes at the bridge. |
| Relay stall & recovery | **PASS** | Fixture test: dead port → DISCONNECTED/BRIDGE_UNREACHABLE, then recovery → LIVE. |
| Signal gating on stale/invalid data | **PASS** | `blockedReasons` computed live: `BRIDGE_UNREACHABLE`, `SOURCE_DISCONNECTED`, `NOT_AUTHENTICATED`, `SOURCE_*`, `TICK_INVALID`, `TICK_UNAVAILABLE`, `QUOTE_STALE`. Dashboard shows BLOCKED with reasons. |
| No secrets in output | **PASS** | Credential-pattern scan of the integrity payload: clean; bridge returns masked login only (`414•••70`). |

## 2. Candle History Validation (Task 3) — PASS (with documented H4 limit)

`auditCandleHistory()` re-verifies everything at read time; surfaced in `/api/data/health` + the dashboard table.

| Timeframe | Verified broker candles (closed) | Coverage (UTC) | Suspicious gaps | Weekend/closure gaps | Invalid OHLC | Duplicates | Out-of-order |
|---|---|---|---|---|---|---|---|
| M5 | 904 | 2026-10-05 → 2026-10-15 | small (session-edge) | expected count | 0 | 0 | 0 |
| M15 | 1000 | 2026-09-15 → 2026-10-15 | small | expected | 0 | 0 | 0 |
| H1 | 990 | 2026-08-16 → 2026-10-15 | small | expected | 0 | 0 | 0 |
| H4 | 996 | 2026-03-02 → 2026-10-15 | 3 (broker-side) | 46 | 0 | 0 | 0 |

- **OHLC rules enforced** (`high ≥ max(o,c)`, `low ≤ min(o,c)`, `high ≥ low`, finite & positive): fixture tests pin detection; the live dataset re-validates with **0 invalid rows**.
- **Forming bar** marked `isForming` and excluded from closed counts (4 forming bars at audit time, one per TF).
- **H4 broker limit (explicit):** depth probe (`scripts/phase8-h4-depth-probe.ts`) requested 2000 bars and the broker served **1458 (2025-11-16 → 2026-10-15, 332 days)** — that is the observed ceiling; "full history" is **not claimed**, and the dashboard carries the H4 coverage warning. 3 intra-window gaps >4h outside weekends were observed broker-side and reported as-is.
- **No invented candles:** any gap repair would be a separate, labeled dataset — none exists in the verified store (source is uniformly `bridge-mt5`).

## 3. Database Integrity & Repeatable Sync (Task 4) — PASS

| Requirement | Verdict | Evidence |
|---|---|---|
| Unique candle identity (symbol+tf+bar-open) | **PASS** | Prisma `@@unique([symbol, timeframe, candleTimeUtc])` (Phase 3, unchanged); audit re-check found 0 duplicates across 3,900 rows. |
| Idempotent repeated sync | **PASS** | Executed repeatedly; second H4 run: `+0 new, ~733 updated` (upsert, no duplicates). Final scheduled run: `+3 new, ~1997 updated`, `duplicates: 0`. |
| Verified rows never overwritten by fallback | **PASS** | Ingestion skips `demo`-labeled feeds by default (`SOURCE_DEMO`); only `mt5`-sourced, VALID rows enter. No synthetic writer exists. |
| Provenance & sync metadata | **PASS** | Every row carries `source`, `validationStatus`, `receivedAtUtc`; `SyncRun` rows record mode/range/counts/error (7 runs recorded). |
| Transactions & bounded retries | **PASS** | Phase 3 ingestion transaction + bounded retry (unchanged, covered by its tests); bridge adds bounded reconnect/backoff with gateway failover. |
| Interrupted sync resumes without duplication | **PASS** | Windowed pagination + upsert keyed on bar-open; merge-by-time map in the bridge (bug found & fixed this phase — see §4). |
| No secret logging | **PASS** | Credential scan over logs/outputs clean; password lives in env → memory → LOGIN frame only. |

## 4. Defects found & fixed during verification (honest record)

1. **Bridge pagination merge bug:** older-window bars were dropped by an append-only merge (`b.time > last`) — a second window returned older bars that were silently discarded, capping H4 fetches at 733. **Fixed** with merge-by-open-time map + progress guard; verified 1000/1000 after fix.
2. **Quote handler field mismatch:** manager read `q.bidRaw/q.askRaw` while the client emits `bid/ask` → `undefined/10^3 = NaN`, every live quote rejected as degenerate. **Fixed**; live quotes flow (age 0–1 s).
3. **Symbol case:** watchlist upper-cased `XAUUSDm → XAUUSDM` (no such symbol). **Fixed** to exact-name resolution.

## 5. Verdict summary

| Criterion | Verdict |
|---|---|
| Quote source identified & validated | **PASS** |
| Freshness/staleness/degradation visible & actionable | **PASS** |
| Candle history validated per timeframe with gaps & duplicates visible | **PASS** |
| H4 limitation explicitly reported | **PASS** (broker depth 1,458 bars; not claimed as full) |
| Idempotent, resumable, provenance-tracked sync | **PASS** |
| Invalid data never silently replaced | **PASS** |
