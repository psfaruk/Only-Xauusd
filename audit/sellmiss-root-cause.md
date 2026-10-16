# M1/M5 Sell-Miss Investigation — Root-Cause Report (Task 29)

**Date:** 2026-10-16 (post-Task-28 continuation session)
**Trigger:** User reported a missed SELL during an intraday decline, described approximately as "4300 → 4260, ~3h ago", and asked why the agent produced no sell signal.
**Method:** Read-only DB probes against the live pipeline (`scripts/tmp-sellmiss-probe{,2,3}.ts` — deleted after this report captured their output; every number below is from the real runtime DB / live API, nothing invented).

---

## 1. What the validated feed actually recorded (premise check)

- **The described price move does not exist in the authenticated broker feed for that window.** The M5 6-hour window ending 17:55Z (70 bars) printed: **high 4198.958 @ 14:25Z, low 4154.592 @ 13:20Z** — an intraday range of ~44 points, not 4300→4260.
- **Price has not been ≥ 4280 since 2026-09-25** (3 weeks): last H1 bar with high ≥ 4280 = `2026-09-25T20:00Z` (H1 max in the 26d window: 4383.445 @ 09-21; H4 max in the 110d window: 4697.047 @ 08-25).
- Conclusion: the user's level recollection maps to the **September** decline (or an external chart), not to the current window. No broker-validated "4300 → 4260" sell opportunity existed for the agent to miss today.

## 2. What the engine actually did during the real decline (12:30Z → 18:00Z)

Full per-evaluation evidence trace (69 evaluations, deduped by state; engine 9.0.0, strategy `hybrid-structure-retest/9.0.0`, all gates passing, quote LIVE throughout):

| UTC | Outcome | Reason(s) | Structure event | HTF (H1/H4) |
|---|---|---|---|---|
| 12:56 | NO_SETUP | STRUCTURE_BREAK_TOO_OLD | CHoCH bearish @ 4178.327 (09:45Z, 11 bars old) | bullish / bearish |
| 13:01 | **WAIT** | **RETEST_PENDING** | **BOS bearish @ 4171.066 (12:45Z, 0 bars)** | bullish / bearish |
| 13:16 | **WAIT** | **HTF_H1_OPPOSITE** | BOS bearish @ 4171.066 (retest done 13:00Z) | **bullish** / bearish |
| 13:46 | NO_SETUP | ZONE_INVALIDATED | BOS bearish @ 4171.066 | bullish / bearish |
| 14:01 | WAIT | RETEST_PENDING | **CHoCH bullish @ 4181.492 (13:45Z)** | bullish / bearish |
| 14:16→ | WAIT | HTF_H4_OPPOSITE | CHoCH bullish (retest done) | bullish / **bearish** |
| 15:16→17:56 | NO_SETUP | ZONE_INVALIDATED / STRUCTURE_BREAK_TOO_OLD | CHoCH bullish @ 4181.492 | bullish / bearish |

**Reading:** at 12:45Z a genuine **bearish BOS** fired and the engine armed a sell — `WAIT RETEST_PENDING` is the strategy *waiting for the retest*, by design. The retest printed at 13:00Z; at that exact moment the **H1 trend was bullish**, so the setup was correctly vetoed (`HTF_H1_OPPOSITE` — the strategy requires H1+H4 alignment with the setup direction). Price then bottomed at 4154.592 (13:20Z), and structure **flipped bullish** (CHoCH @ 13:45Z @ 4181.492). From that point every potential long was vetoed by the bearish H4, and the bearish side had no fresh structure left — hence NO_SETUP.

**Verdict: the engine missed nothing.** The one candidate sell was rejected by the same HTF-alignment gate that is test-pinned across the suite; the market then invalidated that setup's premise by reversing. This matches the documented 30-day funnel (retest-stage trio rejects ~72% of bars; ≈1 setup-episode/1.4 days on real data). **No threshold, gate, or strategy rule was changed in this task.**

## 3. The genuine defects found (and fixed) during the investigation

While reconstructing the user's view of the market, two real gaps were identified — both observability/integration gaps, not strategy defects:

1. **M1 was never requested.** The bridge has served M1 since Phase 8 (355 symbols, full granularity), but the app's `MARKET_TIMEFRAMES` never included M1, so no M1 candles were ever ingested and no M1 chart existed in-app — the user could not verify the agent's view at minute granularity inside the product.
   **Fix (shipped in this task):** `M1` added to the allowlist end-to-end — `TIMEFRAME_SECONDS`/`ALL_TIMEFRAMES` (market/types), config allowlist + `MARKET_STALE_M1_SEC` (see §5), instrumentation scheduler list, zod `AllowedTimeframe` message, analysis schema cap (4→5), `CHART_TIMEFRAMES` + chart panel, `.env`/`.env.example`. **The strategy itself is untouched:** signal gates take their TF list from the rules (`executionTf M15 + context H1/H4`), never from the sync allowlist — verified by reading `signal/service.ts` Gate 4 (`timeframes: [rules.executionTf, ...rules.contextTfs]`). First live sync after the change: `Sync XAUUSDm [M1/M5/M15/H1/H4] → success: +501 new, 0 rejected` (501 = the initial M1 history); chart `tf=M1` returns fresh validated candles (120 closed + 1 forming, not stale).

2. **No live tick observability.** The dashboard's freshest quote came from a 20-second poll; the bridge's genuine tick counters (`quoteCount`, `reconnects`, `lastError`) were served by the bridge but never surfaced — a disconnected feed looked identical to a quiet one.
   **Fix (shipped in this task):** new read-only **tick-stream** mini-service (socket.io, port 3041, Task 29-b) relaying genuine bridge ticks (1 s poll, change-only broadcast) + bridge status (5 s); dashboard diagnostics panel + live bid/ask (Task 29-c) show real counters instead of inferred state.

## 4. Why this is not a strategy change (safety statement)

- Strategy version stays `hybrid-structure-retest/9.0.0`; rules snapshot unchanged; candidate `11.0.0-candidate.1` stays offline research-only.
- Four execution locks remain LOCKED (`TRADING_PHASE=4`, `read_only`, `EXECUTION_ARMED=false`, `ALLOW_EXECUTION=false`); no order/trade code exists anywhere; bridge remains GET-only.
- M1 affects **only** sync depth, chart granularity, and (default-path) analysis coverage. Signal evaluation gates were re-verified live after the change: identical outcomes (`NO_SETUP [STRUCTURE_BREAK_TOO_OLD]`, same structure event), because the engine consumes M15/H1/H4 windows only.

## 5. M1 staleness threshold — why 420 s and not 3×duration

`computeReadiness` treats a TF as STALE when the latest **closed** candle is older than its threshold. With the 300 s scheduler cadence, the worst-case age of the newest closed M1 bar just before the next sync completes is ≈ 60 s (bar close) + 300 s (sync interval) = 360 s. A `3×duration` default (180 s) would therefore flap STALE between syncs and paint a healthy feed red. **M1 default = 420 s** (360 s worst case + margin), configurable via `MARKET_STALE_M1_SEC`. All other TFs keep `3×duration` (their worst-case age ≪ threshold). This is a display/quality-state bound only — it never gates signals (see §3.1).

## 6. Evidence artifacts

- Probe outputs §1–§2: captured from the live DB on 2026-10-16 ~18:00Z (probe scripts deleted per their headers; this report is the record).
- Live post-fix: `/api/data/health` M1 entry — `closed 499, forming 1, qualityState WARNING (GAP_POSSIBLE only)`, quote `LIVE` bid 4161.891; `/api/data/chart?tf=M1&limit=120` — 121 candles, `stale:false`.
- Suite: 549/549 green after fixture updates (7 tests re-pinned from 4-TF to 5-TF world — fixture maintenance, no assertion weakened).
