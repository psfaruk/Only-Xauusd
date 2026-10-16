# PHASE 13 — Production-Readiness Report & Release Checklist

**Scope:** READ-ONLY market analysis & signal generation (Phase 4 of 12). Order execution remains disabled by the four-switch lock and is **out of scope by design** (Phase 11/12 gates).
**Verified at:** 2026-10-16T14:20–14:40Z · commit base `c82dc4e` + Phase-13 working-tree changes (not committed — awaiting review).

Legend: **PASS** (verified with evidence) · **FAIL** (defect confirmed) · **BLOCKED** (external dependency) · **NOT TESTED** (could not run in this sandbox).

---

## 1. Release checklist

### Signal pipeline (read-only)
| Gate | Status | Evidence |
|---|---|---|
| MT5 bridge connected + authenticated | **PASS** | `/health`: connected, authenticated, Exness-MT5Trial6, 47 ms, 355 symbols |
| Bridge is GET-only, token-gated | **PASS** | unauth data → 401; POST → 405 |
| Symbol metadata (XAUUSDm digits/point) verified | **PASS** | digits 3; quote spread 0.240 |
| Candle sync, all 4 TFs, 0 rejects | **PASS** | SyncRun all `success`, 5-min cadence, 1881–1882 upserts/run |
| Candle freshness/completeness gates | **PASS** | VALID for M5/M15/H1/H4; forming bars excluded from decisions |
| Deterministic evaluation each cycle | **PASS** | 36–84 ms/eval, `executionLocked=true` on every row |
| Legitimate WAIT/NO_SETUP distinguishable from failure | **PASS** | reason codes persisted + now fully rendered in Bengali (`(স্বাভাবিক WAIT)`); BLOCKED/FAILED are distinct outcomes with distinct codes |
| Directional paths reachable (given qualifying market) | **PASS** (fixture-proven) | `engine.test.ts` BUY_SETUP/SELL_SETUP with valid levels |
| Scheduler heartbeat & no missed/overlapping runs | **PASS** | max gap exactly 5.0 min; concurrency refused (`SYNC_IN_PROGRESS`); single loop per process |
| Autonomous forward-paper tracking armed | **PASS** | `FORWARD_PAPER_TRACKING=1`; tracker runs post-sync; activates on first qualifying setup |

### User-facing functionality (all read-only)
| Gate | Status | Evidence |
|---|---|---|
| Dashboard & system status | **PASS** | live quote strip, status cards, phase label |
| Market data & freshness | **PASS** | bid/ask/spread/age from live bridge |
| Candlestick chart + TF controls + overlays | **PASS** | M5–H4 switching verified; EMA/swing/BOS-CHoCH/S-R toggles; 300+ real candles |
| On-demand analysis | **PASS** (fixed D1/D2) | button → sync-first → COMPLETED, AnalysisRun persisted |
| On-demand signal evaluation | **PASS** (fixed D1/D2) | button → honest WAIT with translated reason, persisted |
| Manual data sync | **PASS** (fixed D1) | `mode:"manual", status:"success"` |
| Bengali AI chat (grounded, read-only tools) | **PASS** | grounded reply citing the live evaluation evidence |
| Signal history | **PASS** | all outcomes listed with reasons; append-only |
| Risk/data-quality diagnostics | **PASS** | quality VALID; per-TF staleness thresholds shown |
| Mobile & desktop navigation | **PASS** | 5-item bottom nav, no horizontal overflow, footer at exact document bottom; desktop 1280×800 verified |
| Honest loading/empty/stale/error states | **PASS** | per-endpoint error banners; honest empty states for wiped backtest/validation history |

### Security & safety
| Gate | Status | Evidence |
|---|---|---|
| Four execution switches unchanged & LOCKED | **PASS** | env: phase 4 / read_only / armed=false / allow=false; live `/api/health executionLocked:true`; invariant tests green |
| No order/trade/position code or endpoints | **PASS** | static-scan tests (case 18) green; Phase-13 diff touches none |
| Phase 11/12 gates not unlocked | **PASS** | no protocol/strategy file changed |
| API guard fail-closed by default | **PASS** | new tests: unset token + no opt-in → 503; token set → flag ignored, 401 |
| Preview opt-ins explicit & documented | **PASS** | `MARKET_API_PUBLIC_READS`/`MARKET_API_PUBLIC_TRIGGERS` default false; README + .env.example |
| Rate limits active | **PASS** | trigger bucket = rate/10 (min 2)/min/IP; chat 12/min/IP |
| Secrets never logged/echoed | **PASS** | logger masks; guard timing-safe compare; bridge token only in header |
| Allowlisted tool policy intact | **PASS** | registry unchanged; no shell/network tools |
| No unrestricted shell/command execution introduced | **PASS** | diff review — none |
| Paper-testing protocol & data untouched | **PASS** | protocol files + rules unchanged; 0 rows altered |

### Quality gates
| Gate | Status | Evidence |
|---|---|---|
| TypeScript strict | **PASS** | `tsc --noEmit` 0 errors |
| ESLint | **PASS** | 0 errors / 0 warnings |
| Unit + integration suite | **PASS** | **540/540** tests, 31 files, 85,420 expects (up from 532; +4 guard tests, +4 i18n tests) |
| Execution-lock tripwire tests | **PASS** | included in suite |
| Browser E2E desktop | **PASS** | 1280×800: eval/analysis/sync/chat/TF-switch, 0 page errors, 6 screenshots |
| Browser E2E mobile | **PASS** | 375×812: nav, eval button, no overflow, footer bottom |
| Production build (`next build`) | **NOT TESTED** | sandbox constraint: dev-server-only (3000). Stated honestly per task rules |
| Scheduler restart/overlap stress test | **PASS** (unit-level) | concurrency-refusal covered by ingestion tests; live restart behavior observed during rebuilds |

---

## 2. Runtime configuration (reproducible; names only — never values)

Required in the **gitignored** `.env` for the current preview posture:

```
MT5_BRIDGE_URL, MT5_BRIDGE_TOKEN, MT5_LOGIN, MT5_PASSWORD, MT5_SERVER   # bridge + session
MT5_BRIDGE_TIMEOUT_MS, MT5_BRIDGE_MAX_RETRIES, MT5_WATCHLIST             # bridge tuning
MARKET_SYMBOLS=XAUUSDm, MARKET_TIMEFRAMES=M5,M15,H1,H4
MARKET_SYNC_INTERVAL_MS=300000        # 5-min scheduler
FORWARD_PAPER_TRACKING=1
MARKET_API_PUBLIC_READS=true          # preview: unauthenticated GET dashboard
MARKET_API_PUBLIC_TRIGGERS=true       # Phase 13 preview: on-demand buttons (opt-in)
TRADING_PHASE=4, TRADING_MODE=read_only, EXECUTION_ARMED=false, ALLOW_EXECUTION=false
DATABASE_URL=file:...custom.db
```

Production posture (documented in README §Security + `.env.example`): set a long random `DATA_API_TOKEN`, **disable both public flags**, run the bridge + app under a process supervisor.

---

## 3. Health/readiness observability

`/api/health` distinguishes: app+database (`checks.database`), GLM (`glm.status`, last verified), execution lock, and **market** (bridge configured, last sync status/time, data-quality state) — app health is never claimed from bridge health. The bridge daemon exposes its own `/health` (connected/authenticated/uptime) and `/api/status` (latency, gateway, masked login, reconnects, last error). The scheduler writes `MARKET_SYNC_*` and `SIGNAL_*` SystemEvents (append-only audit trail) with run IDs.

---

## 4. Remaining blockers & deployment gap (honest)

| Item | Status | Impact / required action |
|---|---|---|
| **Persistent hosting** | **BLOCKED** | The Z.ai sandbox is **ephemeral**: rebuilds wiped `.env` and the runtime DB — the direct cause of the 48 h outage (C1 in root-cause report). This WILL recur on the next rebuild. Production requires a persistent VPS (or equivalent) with: supervised bridge daemon (`bun run start` in `mini-services/mt5-bridge`), supervised Next.js server, `.env` on persistent storage, SQLite file on persistent volume with the documented backup command, and the production auth posture (§2). |
| **Credential rotation** | **BLOCKED (operator action)** | MT5 credentials were pasted into chat in an earlier session. **Rotate the Exness password and the bridge token** before any real deployment; update `.env` afterwards. |
| Production build verification | **NOT TESTED** | Run `next build` on the target host before go-live (sandbox is dev-server-only). |
| Backtest/validation history | **EMPTY (by environment)** | Wiped with the DB rebuild; re-run the Phase 8 backtest script on the persistent host to repopulate (`scripts/phase8-backtest-run.ts`). No code defect. |
| First qualifying signal | **PENDING (market-dependent)** | Zero BUY/SELL since restoration is a legitimate market outcome; the forward-paper protocol starts accruing statistics on the first qualifying setup. Do not expect — and do not accept — forced signals. |
| Live trading | **OUT OF SCOPE** | Phase 11/12 release gates; four locks remain engaged. |

---

## 5. Final status statement

- **Signal pipeline: OPERATIONAL** (bridge → sync → validation → evaluation → persistence → API → UI), autonomous every 5 min + on-demand.
- **Legitimate NO_SETUP/WAIT vs system failure: DISTINGUISHABLE** — exact reason codes in Bengali, distinct BLOCKED/FAILED outcomes, SystemEvent audit trail.
- **Chat, chart, analysis, history: WORKING** (browser-verified desktop + mobile).
- **Tests: 540/540 PASS; tsc 0; lint 0. Production build: NOT TESTED (sandbox constraint).**
- **Runtime deployment: PREVIEW-READY in this sandbox; genuine production hosting REMAINS BLOCKED** on a persistent host + credential rotation (§4).
- **All four execution locks unchanged — order execution remains DISABLED** (env + code + live + static tripwires). No order-submission path exists anywhere in the codebase; the bridge is GET-only.

**Phase-13 change set is NOT committed/pushed** — awaiting review of the final diff (`git diff` + new files listed in the changelog).
