# Phase 10.3-C — Price Precision Audit & Presentation (audit report)

- **বেসলাইন**: Phase 10.3-B local commit `6419ebd` (parent `8173751`) — preflight-এ যাচাইকৃত
- **স্কোপ**: presentation-only। Signal, dashboard ও paper-validation UI-তে price level প্রদর্শন broker-এর **verified** XAUUSDm digits অনুযায়ী। কোনো trading calculation পরিবর্তন নেই।
- **রিপো শাখা**: `main` · **Push**: করা হয়নি (local commit only)

---

## 1. Preflight (সব মিলেছে — কোনো stop condition নেই)

| চেক | প্রত্যাশা | পাওয়া গেছে | ফল |
|---|---|---|---|
| HEAD | `6419ebd` | `6419ebd` | ✅ |
| Parent | `8173751` | `8173751` | ✅ |
| Working tree | clean | clean (0 file) | ✅ |
| Migration state | db:push-managed (10.3-A/B posture) | একই (migrations dir রেকর্ড; live DB push-managed) | ✅ |
| Phase 10.2 protocol fingerprint | `paper-protocol.ts`, `core.ts`, `rules.ts`, `types.ts` byte-identical to pre-registration `8d94a00` | 4/4 diff = 0 lines | ✅ |
| চারটি execution lock | locked | env-এ কোনো `TRADING_*`/`EXECUTION_*` key নেই → read_only + EXECUTION_ARMED=false + ALLOW_EXECUTION=false + phase gate (<11) | ✅ |
| PaperSignalOutcome / SETUP evals | 0 (pre-registration intact) | 0 paper rows, 0 SETUP (29 evals) | ✅ |
| Bridge :3031 / dev :3000 | healthy | 200 / 200 | ✅ |

## 2. Symbol metadata trace ("digits" কোথা থেকে আসে)

```
Exness MT5 (broker symbol table)
  └─ bridge /api/candles → digits (প্রতি candle-fetch-এ broker-reported)      [mini-services/mt5-bridge/index.ts]
  └─ bridge /api/quote  → digits (প্রতি quote-এ broker-reported)
       │
       ▼  runSync (ingestion.ts §8) — verified fields ONLY
SymbolSpec (db/custom.db): { digits: 3, point: "0.001" (DERIVED 10^-digits, broker-reported নয়),
  tickSize: null, tickValue: null, volume*: null,
  verifiedFields: ["digits"], source: "bridge-mt5",
  lastVerifiedAt: 2026-10-15T18:32:42Z,
  meta: "digits verified from bridge /api/candles response…" }
       │
       ├─→ signal service gate-4 (spec digits) → evaluateSignal → deriveLevels(digits)
       │     └─ toCanonicalPrice(v, digits) — কখনো round করে না; off-grid → String(v) + precisionAnomaly flag
       ├─→ validateQuote → tick bid/ask canonical text (broker price কখনো round হয় না);
       │     spread DERIVED → digits-এ round (নথিভুক্ত ব্যতিক্রম)
       └─→ /api/data/latest → spec block (digits + verifiedFields + lastVerifiedAtUtc) ← 10.3-C এখান থেকেই পড়ে
```

**নথিভুক্ত সত্য**: verified field শুধু `digits`। `point` derived, `tickSize`/`tickValue`/volume bridge contract-এ নেই (null) — তাই presentation precision-এর একমাত্র নির্ভরযোগ্য উৎস `digits`।

## 3. Fail-closed presentation নিয়ম (metadata অনুপস্থিত/stale/inconsistent)

| অবস্থা | আচরণ |
|---|---|
| SymbolSpec row নেই | unverified spec → **raw stored মান verbatim দেখানো + ≈ ফ্ল্যাগ** — কোনো default precision অনুমান নয় |
| `verifiedFields`-এ `"digits"` নেই (stale/unverified) | একই — raw + ফ্ল্যাগ |
| digits null / non-integer / <0 / >8 | একই — unverified |
| Live quote digits ≠ verified spec digits | উভয়ই দেখানো হয় + দৃশ্যমান ⚠ মেটাডেটা-অসঙ্গতি নোট — স্বয়ংক্রিয় সংশোধন নয় |
| Non-finite / unparseable ইনপুট | `'—'` + anomaly — কখনো invented দাম নয় |

`priceDisplaySpecFromSymbolSpec` এসব সব অবস্থাকে fail-closed `UNVERIFIED_PRICE_DISPLAY`-এ collapse করে — caller ভুল করেও assumed precision দিয়ে format করতে পারে না।

## 4. Audit — display-point inventory (source value · formatter · tests)

| # | Display point (page.tsx) | Source value | আগের formatter | 10.3-C |
|---|---|---|---|---|
| D1 | Signal levels card: entry zone / SL / TP / entryRef | levels JSON numeric + `*Text` canonical | raw `*Text` string — off-grid derived মানে **15-decimal display** (F1) | `formatPriceLevel(numeric ?? text)` → verified digits + ≈ marker + `raw:` tooltip + কার্ডে ব্যাখ্যা-নোট |
| D2 | Signal structure level / anchor swing | evidence numeric + `levelText`/`priceText` (canonical, on-grid) | raw string | `formatPriceLevel` — on-grid হওয়ায় visual identical, এখন একই নিয়ন্ত্রিত পথ |
| D3 | Signal কোট লাইন bid/ask | quote JSON strings (eval-সময়ের server format) | raw string | `formatPriceLevel(string)` — validated pass-through |
| D4 | Market tab tick Bid/Ask/Spread | MarketLatestTick canonical text | raw string | `formatPriceLevel` — pass-through (broker price কখনো round হয় না) |
| D5 | dhealth quote bid/ask/spread | integrity.ts-এর server-side `toFixed(live digits)` strings | raw string | `formatPriceLevel` + **digits লাইন** + verified-metadata লাইন + mismatch ⚠ |
| D6 | Chat dataState bid/ask badge | `get_latest_quote` tool strings | raw string | `formatPriceLevel` |
| D7 | Paper outcome rows `এন্ট্রি` | `entryReference` number (raw float) | **raw number — কোনো formatter ছিল না** | `formatPriceLevel(number)` + tooltip |
| D8 | Forward paper recentTrades `এন্ট্রি` | number | raw number | `formatPriceLevel` |
| D9 | Signal-tab backtest তুলনা `নিট` | `netPnlPrice` number | **raw number** | `formatPriceQuantity` |
| D10 | Validation `observedSpreadPrice` | number | **raw number** | `formatPriceQuantity` |
| D11 | Segment metrics: gross/costs/net/expectancy/maxDrawdown (price-unit) | number | `fmtInd(_,2)` hardcoded 2 | `formatPriceQuantity` (verified digits) |
| D12 | Walk-forward / perturbation `নেট`; sensitivity `spr/slip/comm/নেট` | number | raw / `fmtInd(2)` | `formatPriceQuantity` |
| D13 | fp.metrics `নেট` | number | `fmtInd(2)` | `formatPriceQuantity` |
| D14 | Indicators (EMA/RSI/ATR/ADX), R:R, R-multiple, PF, win-rate | number | `fmtInd`/`toFixed` | **অপরিবর্তিত (রাখা হয়েছে)** — dimensionless/indicator domain, broker price-grid নয় (নথিভুক্ত সিদ্ধান্ত) |

প্রতিটি নতুন display-এ `title="raw: …"` tooltip — raw calculation value সবসময় traceable (rule 5)।

**পাওয়া inconsistency (আগের অবস্থায়)**: একই dashboard-এ ৪ রকম behavior ছিল — canonical never-round text (D1), server-side toFixed (D5), কিছুই নয় (D7/D9/D10 raw float), hardcoded 2 (D11)। 10.3-C সব price-unit display এক deterministic verified-digits পথে আনে।

## 5. Implementation (scoped, deterministic, presentation-only)

**নতুন**: `src/lib/market/price-display.ts` (pure, no I/O/Date/random)
- `priceDisplaySpecFromSymbolSpec` — verified metadata gate (fail-closed)
- `formatPriceLevel(value, spec)` → `{ text, anomaly, rawText }` — `toFixed(verifiedDigits)`; off-grid → anomaly flag + raw সংরক্ষিত; invalid → `'—'`
- `formatPriceQuantity(value, spec)` — price-unit পরিমাণ, fail-closed
- Rounding semantics: ECMAScript `toFixed` — deterministic, tests-এ pin করা (2.675→"2.67", 0.5→"1" ইত্যাদি)

**পরিবর্তিত**: `src/app/page.tsx` (client UI only)
- ১০টি parallel fetch-এ `/api/data/latest` যোগ (backend route অপরিবর্তিত — existing endpoint)
- `priceSpec` (useMemo) + `PriceLevelText` / `PriceQtyText` helper components (raw tooltip + ≈ anomaly marker + aria-label)
- উপরের D1–D13 সব display point wiring; dhealth card-এ digits + verified-metadata লাইন + mismatch ⚠
- View-interface-তে numeric fields additive যোগ (API পূর্ব থেকেই পাঠায় — backend change নেই)

**যা স্পষ্টভাবে করা হয়নি**: কোনো API route, `src/lib/signal/*`, `src/lib/market/{validation,ingestion,integrity,service}.ts`, prisma schema, migration, stored float/canonical text, strategy/risk/outcome calculation স্পর্শ হয়নি।

## 6. Tests (test-first)

- `tests/market/price-display.test.ts` — **আগে লেখা, RED প্রমাণিত** (module অনুপস্থিত → 0 pass), তারপর GREEN **39/39**:
  - S1–S6 spec gate (verified/unverified/stale/invalid digits/boundary 0–8)
  - L1–L10 levels: digits=2 ও digits=3, on-grid no-anomaly round-trip, **off-grid F1 মান → rounded + anomaly + raw**, rounding boundaries (4393.3965→"4393.396", 8.999→"9.00", 0.5→"1"), trailing zeros, negative finite, NaN/±Infinity fail-closed
  - T1–T6 canonical string inputs (off-grid string, empty, non-numeric, extra trailing zeros, tick strings)
  - M1–M5 unverified metadata → raw + ফ্ল্যাগ, কখনো assumed precision নয়
  - Q1–Q4 quantities (null/NaN/'—'/verified/unverified)
  - P1–P6 purity: ইনপুট mutation নেই, on-grid exact round-trip, off-grid raw recoverable, spec unmutated, output সবসময় string (numeric feedback অসম্ভব)
  - X1–X2 canonical layer-এর সাথে coexistence: on-grid-এ `toCanonicalPrice` text-এর সাথে identical; off-grid-এ canonical raw থাকে, display round করে + flag
- **পূর্ণ suite: 403/403 pass** (364 pre-existing + 39 নতুন) — paper-chronology, paper, setup-identity, backtest, **Phase 10.2 protocol-সহ সব পূর্ব-নথিভুক্ত test অপরিবর্তিত ও pass**
- `bun run lint` clean · `tsc --noEmit` 0 error (app)

## 7. Frozen-dataset before/after (scripts/phase10.3c-display-comparison.ts)

একই frozen dataset (live DB read-only: SymbolSpec, latest tick, latest signal eval, latest backtest run-এর সম্পূর্ণ 10-trade তালিকা, latest validation run metrics/sensitivity; paper rows = 0):

- **৭১ field তুলনা · ৫৫ display-only পরিবর্তন · ১৬ identical**
- **Raw column প্রমাণ**: প্রতিটি field-এ raw calculation value অপরিবর্তিত (purity assertion in-script)
- On-grid মান (tick bid/ask 4158.175/4158.415, structure level 4144.821, on-grid entryPrice 4127.299/4149.142) → **display identical** — কোনো regression নেই
- Off-grid derived levels — সব **১০টি backtest trade-এর** stopLoss/target/exitPrice (+ কিছু entryPrice, যেমন 5034.5779999999995) আগে 15-decimal raw দেখাত (F1), এখন verified 3-digit + ≈ ফ্ল্যাগ + tooltip-এ raw; **33টি off-grid display এখন ফ্ল্যাগকৃত**
- পরিমাণ: dev.netPnlPrice 428.2141→"428.214", observedSpread 0.24→"0.240", sensitivity spr 0.24→"0.240" ইত্যাদি
- Synthetic edge cases আলাদা সেকশনে (production data থেকে পৃথক): off-grid string/number, trailing zero 4144.5→"4144.500", rounding boundary, invalid string→'—', unverified spec→raw+ফ্ল্যাগ
- **SL/TP comparison, R:R, risk gate, paper outcome metrics**: এসবের সব ইনপুট ও গণনা অপরিবর্তিত — 403/403 suite ও raw column উভয়ে প্রমাণিত; display string কখনো calculation-এ ফিরে যায় না (P6)

## 8. Browser verification (agent-browser E2E)

- Desktop 1280×800: সব tab রেন্ডার; dhealth-এ `bid 4157.952 / ask 4158.192`, `spread 0.240 … digits 3`, `প্রদর্শন-নির্ভুলতা: যাচাইকৃত digits=3 (bridge-mt5, …)`; tooltip `raw: 4157.952`; signal evidence `BOS বিয়ারিশ @ 4144.821`, কোট `4158.175 / 4158.415`; validation-এ `স্প্রেড অনুমান 0.240`, `spr 0.240 / slip 0.020 / comm 0.000`, `নেট -254.024`; market tick `Bid 4158.175 / Ask 4158.415 / Spread 0.240`
- **0 page error, 0 console error**; dev.log পরিষ্কার (সব 200, `/api/data/latest` live)
- Mobile 390×844: **horizontal overflow নেই** (scrollW 390 = clientW 390); footer content-এর সাথে স্বাভাবিকভাবে নিচে push
- Screenshots: `audit/phase10.3c-desktop.png`, `audit/phase10.3c-mobile.png`
- সীমাবদ্ধতা (সৎ প্রকাশ): live-এ এখনো ০টি SETUP — তাই levels card-এর নতুন পথ (D1) live browser-এ দেখা যায়নি; frozen backtest trade dataset + 39 unit test + comparison script এ সম্পূর্ণ প্রমাণিত। Paper rows = 0 — D7/D8 live-এ খালি-সৎ অবস্থা।

## 9. Calculation values unchanged — স্পষ্ট ঘোষণা

**হ্যাঁ — সম্পূর্ণভাবে unchanged।** Stored float, canonical decimal text, strategy output, entry/SL/TP geometry, risk calculation, paper-walk chronology, outcome calculation, verdict input — কোনোটিই পরিবর্তন হয়নি। পরিবর্তন শুধু নতুন **display string** তৈরি করেছে (separate layer); formatter output সবসময় string, কখনো stored value-কে overwrite/feed-back করে না। প্রমাণ: frozen-dataset raw column (§7), purity tests P1–P6, 403/403 suite, backend diff = 0 file।

## 10. Phase 10.2 protocol integrity

- `paper-protocol.ts`, `core.ts`, `rules.ts`, `types.ts`, `forward.ts`, `setup-identity.ts`, `prisma/schema.prisma`, `config.ts` — **git diff খালি** (10.3-B HEAD ও pre-registration 8d94a00 উভয়ের বিপরীতে)
- Activation time, 90-day window, 20-trade floor, 35% concentration, 8-loss, 10R drawdown — অপরিবর্তিত; সব protocol test pass
- 10.3-A dedup semantics, 10.3-B chronology invariant — অপরিবর্তিত
- চারটি execution lock locked · কোনো order/trade endpoint নেই · DB/snapshot/legacy row/`.env` অস্পৃষ্ট

## 11. Changed files

| ফাইল | ধরন |
|---|---|
| `src/lib/market/price-display.ts` | নতুন — pure display formatter |
| `src/app/page.tsx` | পরিবর্তিত — display wiring only |
| `tests/market/price-display.test.ts` | নতুন — 39 regression tests |
| `scripts/phase10.3c-display-comparison.ts` | নতুন — before/after evidence (read-only) |
| `audit/phase10.3c-price-precision.md` | নতুন — এই রিপোর্ট |
| `audit/phase10.3c-{desktop,mobile}.png` | নতুন — browser evidence |

## 12. Residual risks

- **R1** — Live SETUP না হওয়া পর্যন্ত levels card-এর নতুন পথ (D1) production browser-এ অপ্রয়োগকৃত; unit + frozen-dataset প্রমাণ বহন করে।
- **R2** — Verified digits বদলালে (broker change) পুরনো persisted canonical text-দের display নতুন digits-এ হবে; raw tooltip সবসময় সত্য বহন করবে। এটি desired behavior, কিন্তু ঐতিহাসিক দৃশ্যে mixed-precision দেখা যেতে পারে।
- **R3** — `toFixed` binary-representation quirk (2.675→"2.67") display rounding-এ থেকে যায় — deterministic ও pinned, কিন্তু half-up প্রত্যাশা করা হলে বিভ্রান্তিকর হতে পারে।
- **R4** — `dataHealth.quote`-এর server-side fmt (integrity.ts) এখনও live-bridge digits ব্যবহার করে (server অপরিবর্তিত রাখা হয়েছে — backend scope-এর বাইরে); frontend mismatch ⚠ এটি ধরার একমাত্র উপায়, এখন দৃশ্যমান।
- **R5** — Chat LLM টেক্সটের ভেতরের দাম LLM নিজে লেখে — formatter শুধু deterministic dataState badge-এ প্রযোজ্য।

## 13. Build স্ট্যাটাস (স্পষ্ট বিবৃতি)

Sandbox নিয়মে `bun run build` **চালানো হয়নি** — তাই "build সফল" দাবি করা হচ্ছে না। যা যাচাইকৃত: `bun run lint` clean, `tsc --noEmit` 0 error, `bun test` 403/403, dev server (port 3000) স্বাভাবিক চলমান ও dev.log error-free, browser E2E desktop+mobile পাস।

## 14. Local commit

- Commit: এই রিপোর্টসহ সব artifact একটি local commit-এ (message-এ phase10.3-C summary)। **GitHub push করা হয়নি।**
