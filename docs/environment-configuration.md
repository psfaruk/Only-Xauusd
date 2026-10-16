# Environment Configuration Guide

**Scope:** every environment variable this app reads, the two supported postures, and how to move between them safely.
**Authoritative annotated reference:** [`.env.example`](../.env.example) (placeholders only — the real `.env` is gitignored and NEVER committed). This guide explains the *postures*; `.env.example` explains the *variables*.

---

## 1. The two postures

| | **Preview (sandbox)** | **Production (persistent host)** |
|---|---|---|
| `DATA_API_TOKEN` | *(unset)* | **long random value** |
| `MARKET_API_PUBLIC_READS` | `true` (explicit opt-in) | *(unset/false)* |
| `MARKET_API_PUBLIC_TRIGGERS` | `true` (explicit opt-in) | *(unset/false)* |
| `MARKET_SYNC_INTERVAL_MS` | `300000` | `300000` |
| MT5 bridge keys | set (gitignored `.env`) | set (secret manager / `.env` 0600) |
| Execution locks | all four LOCKED | all four LOCKED (unchanged — Phase 11 gate) |

**Rule:** a surface is open ONLY when (a) a token is set and presented, or (b) the operator explicitly opted in with the matching public flag while NO token is set. There is no third path (fail-closed 503 `MARKET_API_TOKEN_NOT_CONFIGURED`).

## 2. Who guards what (single guard, two buckets)

`src/lib/api-guard.ts` (`guardDataApi`) protects 18 of the 20 routes:

- **`trigger` bucket (12/min/IP):** `POST /api/data/sync`, `/api/analysis/run`, `/api/signal/run`, `/api/backtest/run`, `/api/ai/verify` — token ALWAYS when set; unset → 503 unless `MARKET_API_PUBLIC_TRIGGERS=true`.
- **`read` bucket (120/min/IP):** all GET data/analysis/signal/backtest/audit routes + `POST /api/chat` (extra 12/min chat bucket) — token when set; unset → 503 unless `MARKET_API_PUBLIC_READS=true`.
- Unguarded by design: `GET /api/health` (no data, liveness) and the GET usage-docs handlers on POST routes.

## 3. Variable groups (see `.env.example` for the full annotated list)

1. **Database** — `DATABASE_URL` (SQLite file path).
2. **Execution locks (four)** — `TRADING_PHASE`, `TRADING_MODE`, `EXECUTION_ARMED`, `ALLOW_EXECUTION`. Execution requires ALL FOUR to pass (`phase ≥ 11` + armed + allowed + non-read-only). Leave locked; the UI badge derives from `/api/health`.
3. **GLM** — `GLM_MODEL`, `GLM_TIMEOUT_MS`, `GLM_MAX_RETRIES`, `GLM_MIN_VERIFY_INTERVAL_MS`. No API key: the sandbox SDK manages auth server-side.
4. **MT5 bridge (app side)** — `MT5_BRIDGE_URL`, `MT5_BRIDGE_TOKEN` (sent as `x-trader-key`), `MT5_BRIDGE_TIMEOUT_MS`, `MT5_BRIDGE_MAX_RETRIES`.
5. **MT5 bridge (bridge side)** — `MT5_LOGIN`, `MT5_PASSWORD`, `MT5_SERVER`, `MT5_WATCHLIST`, `MT5_BRIDGE_RELAY`. Read ONLY by the bridge process. **If these were ever exposed (chat, logs), rotate them at the broker immediately.**
6. **Market pipeline** — `MARKET_SYMBOLS`/`MARKET_TIMEFRAMES` (strict allowlists), staleness thresholds, bounded limits, `MARKET_INGEST_DEMO` (default false — demo never analysis-ready), `MARKET_SYNC_INTERVAL_MS`.
7. **Data API security** — `DATA_API_TOKEN`, `DATA_API_RATE_LIMIT_PER_MIN`, `MARKET_API_PUBLIC_READS`, `MARKET_API_PUBLIC_TRIGGERS` (see §1).
8. **Analysis/signal tuning** — `ANALYSIS_*` warm-up/swing params, `SIGNAL_*` strategy thresholds (documented per rule in `src/lib/signal/rules.ts`; persisted with every evaluation). **Do not loosen to manufacture signals.**

## 4. Rotating / moving secrets safely

- Never paste real values into chat, tickets, logs or commits — only variable NAMES.
- Rotate at the source (broker password change, GitHub PAT revoke+reissue, token regeneration) then update `.env` and restart the owning process.
- The app/bridge never echo secrets: token compares are timing-safe; bridge errors name the env var, not the value; `/api/health` is secret-free (verified).

## 5. Posture verification (after any change)

```bash
# 1. Fail-closed check WITHOUT a token (production posture expects 401/503):
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/data/status          # 503 (no public reads)
# 2. With the token:
curl -s -H "Authorization: Bearer $DATA_API_TOKEN" localhost:3000/api/data/status | head -c 120
# 3. Lock state (must always say locked + gate phase):
curl -s localhost:3000/api/health | python3 -c "import json,sys; h=json.load(sys.stdin); print(h['executionLocked'], h['executionGatePhase'], h['phaseLabel'])"
```

Expected in production: `True 11 Phase 4 — Read-Only Research` (phase number = your `TRADING_PHASE`, label states the mode truthfully — it is a lock value, not roadmap progress).
