# Historical Data Report — Six-Month Broker-Authorized Acquisition (Phase 3)

**Run:** 2026-10-22T12:39–12:43 UTC · script `scripts/six-month-import.ts` (remediation branch `remediation/six-month-backtest`)
**Source:** the broker-authorized read-only MT5 bridge (Exness-MT5Trial6, gateway 47.130.41.116, masked login 414•••70, bridge v2.0.0-signal-only) via the NEW `GET /api/candles/range` endpoint — the same authenticated broker session the live app uses. **No third-party or synthetic data of any kind.**

**Companion artifact:** `audit/historical-data-manifest.json` (machine-readable, full per-TF stats, assumptions, provenance).

---

## 1. Why this run was possible now

Until this remediation the bridge exposed only a latest-N `GET /api/candles?limit=` (cap 2000 bars/request) — every previous backtest was bounded by it (documented in `audit/phase11-real-comparison.md`: M15 ≈ 30 days, M5 ≈ 9 days, "older M5 bars are unobtainable"). The underlying MT5 protocol command (CANDLES cmd 11) always supported arbitrary `[from, to]` windows; this remediation exposed it behind a bounded, authenticated, read-only range endpoint (`GET /api/candles/range?symbol=&tf=&fromUtc=&toUtc=`, span cap ≈ 400 days, future-window rejection, UTC↔broker-time normalization both ways, GET-only by the bridge's construction — the order layer does not exist in the service).

## 2. Actual coverage (honest — what the broker serves, nothing assumed)

Requested window per timeframe: ~182.5 days ending at the last closed bar at run time (2026-04-22/23 → 2026-10-22, per-TF aligned). All timestamps UTC (bar-open), normalized with the live-measured broker offset (Exness trial empirically UTC+0, verified from live quotes).

| TF | Served range (UTC) | Bars | Non-closure gaps | Pre-history slots* | Closure slots** | Rejected | Fingerprint (sha256, first 16) |
|---|---|---|---|---|---|---|---|
| M15 | 2026-04-23 → 2026-10-22 (**full 6 mo**) | 11,955 | 36 | 0 | 5,528 | 0 | `a8e2eb097c682c8c` |
| M5 | 2026-04-23 → 2026-10-22 (**full 6 mo**) | 35,866 | 108 | 0 | 16,585 | 0 | `0006577571f7f3a0` |
| H1 | 2026-04-23 → 2026-10-22 (**full 6 mo**) | 2,989 | 8 | 0 | 1,382 | 0 | `ea33f77493195eb8` |
| H4 | 2026-04-23 → 2026-10-22 (**full 6 mo**) | 806 | 0 | 0 | 288 | 0 | `c4056b22ea48cae7` |
| M1 | **2026-07-13 → 2026-10-22 (~101 days ONLY)** | 100,018 | 97 | 74,922 | 87,762 | 0 | `9b058ae4ad4751e3` |

\* **Pre-history slots** = grid slots before the earliest served bar — the broker's history-depth limit, probed live (M1 boundary between 100 and 105 days ago). **These are NOT gaps in delivered data; the broker does not serve older M1. Nothing was fabricated, resampled or interpolated to fill them.** M5/M15/H1/H4 all serve the full six months.
\*\* **Closure slots** = missing grid slots inside approximate weekend/daily-break envelopes (generic spot-gold conventions; the broker's exact session schedule is not verified — stated as approximate, never as confirmed closures).

**Validation:** every bar passed the Phase 3 ingestion rules (`validateCandleBatch`: OHLC consistency, positive prices, future-time rejection, canonical decimal text with verified digits=3, duplicate resolution). Zero bars rejected. Zero forming bars persisted (dropped at the right edge; the scheduled live sync owns the rolling edge). Zero OHLC divergences vs. previously stored rows (closed candles are immutable; re-import only refreshes receipt timestamps).

## 3. Reproducibility & provenance

- Each dataset carries a sha256 fingerprint over canonical decimal OHLC text + timestamps (`datasetFingerprint` — identical formula the backtest loader computes from the DB, so any backtest on this data is reproducible against these fingerprints).
- Import is idempotent: re-running inserts nothing and never rewrites a closed candle (pinned by `tests/market/historical-import.test.ts` case d).
- Manifest records provider identity (server, gateway, masked login), retrieval timestamp, per-TF stats, and the assumption list.

## 4. Explicit limitations

1. **M1 depth:** six months of M1 is NOT available from this broker source — only ~101 days. Any statement claiming "6-month M1 dataset" would be false; this report does not make it.
2. **Historical spread/tick bid-ask** is not served per-bar; backtest costs remain labeled assumptions with a sensitivity band.
3. **Non-closure gaps** (M15: 36, M5: 108, H1: 8, M1: 97 slots ≈ 0.2–0.3% of served bars) are reported, not filled. Likely broker holidays or brief outages outside the approximate closure envelopes; the exact broker calendar is unverified.
4. Weekend/daily-break classification uses widened approximate envelopes (±DST variants) — a missing candle inside an envelope is "likely closure", never silently ignored.

## 5. Verification status of this report's claims

- Verified by direct execution: coverage table, validation counts, fingerprints (this run's console output + `audit/historical-data-manifest.json`).
- Verified by source inspection: range-endpoint read-only construction, UTC normalization, span caps.
- Not tested: broker session-schedule verification (no verified calendar source available).
