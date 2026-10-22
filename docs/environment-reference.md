# Environment Reference — every key

**Scope:** one row per environment key documented in [`.env.example`](../.env.example)
(plus the optional `DATA_API_TOKEN`). Placeholders only — the real `.env` is
gitignored and never committed. Companion guides:
[`environment-configuration.md`](./environment-configuration.md) (postures) ·
[`security-rotation.md`](./security-rotation.md) (incident + rotation).

Legend — **Secret?**: 🔐 = credential, treat as compromised if ever exposed;
⭕ = operational value, not a credential, but never quote the real value in
public output; ✅ = non-secret configuration.

## Database & product posture

| Key | Meaning | Default (template) | Secret? |
|---|---|---|---|
| `DATABASE_URL` | SQLite datasource. Prisma resolves relative paths against `prisma/schema.prisma`, so `file:../db/custom.db` → `<repo>/db/custom.db`. Absolute paths also work. | `file:../db/custom.db` | ✅ |
| `TRADING_PHASE` | **Informational label only** — feeds the phase label string (“Phase 15 — Signal-Only (read-only)”). Not a capability gate; execution code is deleted. | `15` | ✅ |
| `TRADING_MODE` | **Inert.** Hard-locked to `read_only` in `src/lib/config.ts`; the env value cannot change it. | `read_only` | ✅ |
| `TRADING_SYMBOL` | Product symbol label. The data-pipeline allowlist is `MARKET_SYMBOLS`. | `XAUUSD` | ✅ |

## Market pipeline

| Key | Meaning | Default (template) | Secret? |
|---|---|---|---|
| `MARKET_SYMBOLS` | Strict symbol allowlist for ingestion (never silently substituted). | `XAUUSDm` | ✅ |
| `MARKET_TIMEFRAMES` | Strict timeframe allowlist. | `M1,M5,M15,H1,H4` | ✅ |
| `MARKET_SYNC_INTERVAL_MS` | Scheduler candle-sync cadence; `0` disables the scheduler. | `60000` (1 min) | ✅ |
| `MARKET_API_PUBLIC_READS` | Preview opt-in: anonymous GETs on guarded read routes (no token set). Unset/false in production. | `true` (template) | ✅ |
| `MARKET_API_PUBLIC_TRIGGERS` | Preview opt-in: anonymous POST triggers. **Same-origin only since Phase 9** — off-box anonymous callers get 403. Unset/false in production. | `true` (template) | ✅ |
| `DATA_API_RATE_LIMIT_PER_MIN` | Per-IP read-bucket rate limit (trigger bucket = 1/10th, min 2). | `120` | ✅ |
| `DATA_API_TOKEN` | Bearer token for guarded routes. When set, it is ALWAYS required and both public flags are ignored. Recommended posture on any shared host. | *(unset in template)* | 🔐 (generate long random) |

## MT5 bridge — market-data gateway (:3031)

| Key | Meaning | Default (template) | Secret? |
|---|---|---|---|
| `MT5_SERVER` | Broker server name for the web-terminal auth handshake. | placeholder | 🔐 |
| `MT5_LOGIN` | Broker login number (Exness). | placeholder | 🔐 |
| `MT5_PASSWORD` | Broker password. Read only by the bridge process. | placeholder | 🔐 |
| `MT5_BRIDGE_URL` | Base URL of the read-only bridge service. Empty ⇒ the whole pipeline fails closed (no fabricated data). | `http://localhost:3031` | ⭕ |
| `MT5_BRIDGE_TOKEN` | Shared app↔bridge key, sent as `x-trader-key`; timing-safe compare; never logged. Must be identical in `.env` for app and bridge. | placeholder | 🔐 |
| `MT5_BRIDGE_TIMEOUT_MS` | Bridge client timeout per call. | `8000` | ✅ |
| `MT5_BRIDGE_MAX_RETRIES` | Bridge client bounded retries. | `2` | ✅ |
| `MT5_WATCHLIST` | Symbols the bridge subscribes to. | `XAUUSDm` | ✅ |

## Signal engines (deterministic; thresholds clamped in code)

| Key | Meaning | Default (template) | Secret? |
|---|---|---|---|
| `SMC_ENABLED` | SMC_CONFLUENCE master switch (fallback models judge when off). | `1` | ✅ |
| `SCALPER_ENABLED` | Scalper engine master switch. | `1` | ✅ |
| `SCALPER_MOMENTUM_ENABLED` | Momentum fallback model switch (backtest-driven decision — see worklog Task 38). | `true` | ✅ |
| `SCALPER_SL_ATR_MULT` | Scalper stop-loss ATR multiplier (clamped 0.3–5). | `1.5` | ✅ |
| `SCALPER_REWARD_RISK` | Scalper reward/risk ratio (clamped 0.5–5). | `1.2` | ✅ |
| `SMC_SL_ATR_BUFFER` | SMC stop-loss ATR buffer (clamped 0.05–2). | `0.5` | ✅ |

## AI layer (advisory only)

| Key | Meaning | Default (template) | Secret? |
|---|---|---|---|
| `GLM_MODEL` | GLM model id. Sandbox SDK manages auth server-side — no API key exists. | `glm-4-plus` | ✅ |
| `GLM_TIMEOUT_MS` | GLM call timeout. | `30000` | ✅ |

---

Rules that never change:

1. The real `.env` is **gitignored**; only `.env.example` (placeholders) is
   committed. A local fail-closed backup lives at `.zscripts/env.local`
   (gitignored, `chmod 600`) — never commit either file.
2. Missing/malformed secrets fail closed with a clear non-secret error
   (`bun .zscripts/ensure-env.mjs`); the app never invents credentials.
3. `bun run secrets:scan` must PASS before every commit; it catches secret
   shapes without printing values.
4. Execution-related switches do not exist anymore — there is no env key that
   can enable order placement (the execution layer was deleted in Phase 0).
