# Environment Configuration Guide

**Scope:** every environment variable this app reads, the two supported postures, and how to move between them safely.
**Authoritative annotated reference:** [`.env.example`](../.env.example) (placeholders only — the real `.env` is gitignored and NEVER committed). This guide explains the *postures*; `.env.example` explains the *variables*.

---

## 1. The two postures

| | **Preview (sandbox)** | **Production (persistent host)** |
|---|---|---|
| `DATA_API_TOKEN` | *(unset)* | **long random value** |
| `MARKET_API_PUBLIC_READS` | `true` (explicit opt-in) | *(unset/false)* |
| `MARKET_API_PUBLIC_TRIGGERS` | `true` (explicit opt-in; **same-origin only** since Phase 9) | *(unset/false)* |
| `MARKET_SYNC_INTERVAL_MS` | `60000` (1 min) | `300000` (5 min) |
| MT5 bridge keys | set (gitignored `.env`) | set (secret manager / `.env` 0600) |
| Execution capability | **deleted (Phase 0)** — no locks needed because there is no execution code | same (read-only by construction) |

**Rule:** a surface is open ONLY when (a) a token is set and presented, or (b) the operator explicitly opted in with the matching public flag while NO token is set. There is no third path (fail-closed 503 `MARKET_API_TOKEN_NOT_CONFIGURED`).

## 2. Who guards what (single guard, two buckets)

`src/lib/api-guard.ts` (`guardDataApi`) protects 18 of the 20 routes:

- **`trigger` bucket (12/min/IP):** `POST /api/data/sync`, `/api/analysis/run`, `/api/signal/run`, `/api/backtest/run`, `/api/ai/verify` — token ALWAYS when set; unset → 503 unless `MARKET_API_PUBLIC_TRIGGERS=true`.
- **`read` bucket (120/min/IP):** all GET data/analysis/signal/backtest/audit routes + `POST /api/chat` (extra 12/min chat bucket) — token when set; unset → 503 unless `MARKET_API_PUBLIC_READS=true`.
- Unguarded by design: `GET /api/health` (no data, liveness) and the GET usage-docs handlers on POST routes.

## 3. Variable groups (see `.env.example` for the full annotated list)

1. **Database** — `DATABASE_URL` (SQLite file path).
2. **Product posture (informational)** — `TRADING_PHASE`, `TRADING_MODE`. These are **labels only**: the execution gate and the entire execution layer were deleted in Phase 0. `TRADING_MODE` is hard-locked to `read_only` in `src/lib/config.ts` (the env value is inert); `TRADING_PHASE` feeds the phase label string. The UI badge derives from `/api/health` (`executionLocked` is always `true`).
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
# 3. Lock state (always locked — execution code was deleted in Phase 0):
curl -s localhost:3000/api/health | python3 -c "import json,sys; h=json.load(sys.stdin); print(h['executionLocked'], h['phaseLabel'])"
```

Expected in production: `True Phase 15 — Signal-Only (read-only)` (`TRADING_PHASE` is an informational label, not a capability gate; `executionLocked` is a constant `true`).

---

## Phase 14 — ICT/SMC Ten-Agent Confluence Engine (Task 34 series)

The scalper strategy (`scalper-m1-m5-m15-or/13.0.0`) now leads with the
**SMC_CONFLUENCE model**: ten deterministic specialist agents fused by a
weighted Confluence Master. The legacy EMA/RSI momentum + reversal models
remain as honest fallbacks so the 5–7 signals/hour cadence survives quiet
confluence periods.

### Agents (all pure, no look-ahead, closed candles only)

| # | Agent | Module | Weight |
|---|---|---|---|
| A1 | Structure (BOS/CHoCH, dealing range, premium/discount) | `src/lib/signal/ict/agents/structure.ts` | 15 |
| A2 | Liquidity (EQH/EQL pools, sweeps/stop-hunts) | `agents/liquidity.ts` | 20 |
| A3 | POI (order blocks, FVG, breakers, mitigation) | `agents/poi.ts` | 20 |
| A4 | Key levels (S/R, supply/demand, PDH/PDL, sessions, round) | `agents/levels.ts` | 10 |
| A5 | Price action (engulfing, pins, displacement, rejection) | `agents/price-action.ts` | 15 |
| A6 | Momentum (EMA/RSI/ATR regime score) | `agents/momentum.ts` | 10 |
| A7 | Session/News (killzones + approximate blackout envelopes) | `ict/sessions.ts` | 5 |
| A8 | AMD (accumulation→manipulation→distribution) | `agents/amd.ts` | 5 |
| A9 | Risk levels (POI entry, sweep-anchored SL, liquidity TP) | `ict/risk.ts` | — |
| A10 | Confluence Master (weights → tiers → vetoes) | `ict/confluence.ts` | — |
| A11 | GLM Bengali narrative (best-effort, never blocks) | `ict/narrative.ts` | — |

Tiers: **A ≥ 75** (sure signal) · **B ≥ 55** (default emission bar) · C ≥ 40.
Hard vetoes: NEWS_BLACKOUT · SR_WALL (<0.8×ATR opposing level) ·
MOMENTUM_OPPOSED · PRICE_BEYOND_POI · POI_VIOLATED. News blackout gates
EVERY model (legacy fallbacks included). Direction needs a ≥10-point
BUY-vs-SELL margin.

### Environment switches (all clamped, baked into the rules fingerprint)

```
SMC_ENABLED=1                  # master switch (fallback models judge when off)
SMC_NEWS_BLACKOUT=1            # blackout veto master switch
SMC_MIN_SCORE=55               # emission threshold (tier B)
SMC_SWING_LEFT=3  SMC_SWING_RIGHT=3
SMC_SWEEP_LOOKBACK=30  SMC_MAX_BARS_SINCE_SWEEP=8
SMC_OB_MIN_DISPLACEMENT_ATR=1.0  SMC_FVG_MIN_GAP_ATR=0.2
SMC_ENTRY_TOLERANCE_ATR=0.35  SMC_SL_ATR_BUFFER=0.35
SMC_DISPLACEMENT_ATR=1.0  SMC_AMD_LOOKBACK=40  SMC_AMD_MIN_RANGE_ATR=2.0
SMC_ROUND_STEP=5  SMC_KEY_LEVEL_TOL_ATR=0.3
SMC_LONDON_KZ_FROM_MIN=420 SMC_LONDON_KZ_TO_MIN=600   # 07:00–10:00 UTC
SMC_NY_KZ_FROM_MIN=720     SMC_NY_KZ_TO_MIN=900       # 12:00–15:00 UTC
```

The news blackout envelopes are APPROXIMATE scheduled windows (UTC):
12:25–13:45 (US data cluster) and 14:55–16:15 (US conference cluster),
±5 min buffer — widened to cover both DST variants, no live calendar feed
is claimed. Weekend honesty: Saturday/Sunday-early → OFF_HOURS, no veto.

### Verification

`bun test tests/ict/` — 119 tests: sessions 17, structure 12, liquidity 17,
poi 21, levels 22, price-action 14, momentum 14, amd 14, confluence 16
(probe-verified golden-path fixture: EQL sweep → displacement BOS → FVG
retrace → rejection-wick decision in the London killzone → BUY 78 tier A).
