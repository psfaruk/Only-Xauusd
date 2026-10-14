# XAUUSD AI Trading Agent

**GLM-চালিত হাইব্রিড ট্রেডিং অ্যানালিসিস সিস্টেম — Exness MT5 টার্গেট · Read-Only · Bengali-First**

> এই প্রজেক্টে AI (GLM) বাজার বুঝবে ও ব্যাখ্যা করবে, কিন্তু Entry/SL/TP, Lot Size ও Risk
> যাচাই করবে ডিটারমিনিস্টিক কোড। আপনার অনুমোদন ছাড়া কোনো অর্ডার যাবে না — এবং Phase 1-এ
> অর্ডার-পাঠানোর কোনো কোডই নেই।

---

## বর্তমান অবস্থা — Phase 3 (Market Data Database & Validation Pipeline) ✅

Phase 3 সম্পূর্ণ — ডেটাবেস মাইগ্রেশন, আইডেমপোটেন্ট ইনজেশন, ডিটারমিনিস্টিক ভ্যালিডেশন,
ডেটা-গুণমান স্টেট, Read-only Data API, ড্যাশবোর্ড “মার্কেট ডেটা” ট্যাব ও ৭৮টি অটোমেটেড টেস্ট।
বিস্তারিত অডিট: `audit/phase3-audit.md`।

| বিষয় | ফলাফল |
| --- | --- |
| DB schema/migrations | ✅ 6টি Phase-3 টেবিল — বিদ্যমান ডেটা অক্ষুণ্ণ রেখে baseline + additive migration |
| Idempotent ingestion | ✅ `(symbol, timeframe, candleTimeUtc)` upsert — একই ক্যান্ডেল দুবার দিলেও ডুপ্লিকেট হয় না |
| Deterministic validation | ✅ OHLC invariants, finiteness, timestamps, duplicates, ordering, session-aware gaps |
| Data-quality states | ✅ VALID / WARNING / INVALID / STALE / MISSING / UNAVAILABLE — সতর্কতা কখনো VALID হয় না |
| Readiness result | ✅ ready + last_tick + last_closed_candle + data_age + error_codes (কেবল ডেটা-প্রস্তুতি; সিগন্যাল নয়) |
| Data API | ✅ `/api/data/{status,candles,latest,quality,sync-status}` + POST `/api/data/sync` — typed, allowlisted, bounded |
| Automated tests | ✅ ৭৮/৭৮ পাস (মক-ব্রিজ + isolated test DB; মক স্পষ্টভাবে লেবেল-করা) |
| Real MT5 smoke test | ⏸ সম্পাদিত হয়নি — Phase 2 ব্রিজ এখনো ডিপ্লয়েড নয় + ক্রেডেনশিয়াল নেই (`bun run market:smoke` → SKIP) |
| Order execution | 🔒 এখনো কোড-লেভেলে তালাবন্ধ — কোনো order/trade endpoint নেই (স্ট্যাটিক টেস্টে প্রমাণিত) |

### পূর্ববর্তী ফেজ

**Phase 1 (Environment Audit & Foundation) ✅** — মূল ফলাফল (সবই প্রকৃত কমান্ড-প্রমাণসহ, `audit/glm-tool-call.ts` ও `/api/audit/environment`):

| বিষয় | ফলাফল |
| --- | --- |
| OS / Runtime | Debian 13 (trixie) · Node v24 · Bun 1.3 · Python 3.12 + numpy/pandas (টুলিং-এর জন্য) |
| GLM access | ✅ যাচাইকৃত — মডেল `glm-4-plus`, sandbox-managed auth (কোনো API key লাগে না) |
| GLM Bengali | ✅ যাচাইকৃত — Phase 9-এর বাংলা Chat Agent সম্ভব |
| GLM tool calling | ✅ যাচাইকৃত — full loop 720ms (model → allowlist → execute → feed back → answer) |
| MT5 sandbox-এ | ❌ টার্মিনাল অসম্ভব — কিন্তু ওয়েব-টার্মিনাল প্রোটোকল প্রমাণিত (AUTH handshake, `audit/mt5-auth-probe.ts`) |
| Order execution | 🔒 কোড-লেভেলে তালাবন্ধ — ৪-সুইচ গেট, Phase ≥ 11 ছাড়া খোলা যায় না |

## আর্কিটেকচার (sandbox-অনুযায়ী বাস্তবায়িত)

```
Web Dashboard + Bengali Chat (Phase 9)   ← Next.js 16, single route
        ↓
Backend API (Next.js route handlers)     ← /api/health · /api/audit/environment · /api/ai/verify
        ↓
GLM Orchestrator (glm-4-plus)            ← z-ai-web-dev-sdk, server-side only
        ↓
Allowlisted Tool Registry                ← 1 active (get_system_health) + 8 planned, schema-validated
        ↓
Deterministic Engines (Phase 4-7)        ← market structure · indicators · setup · risk gate
        ↓
MT5 Bridge — বাহ্যিক সার্ভিস (Phase 2)        ← REST চুক্তি প্রমাণিত (v20 mt5-service) — এখনো ডিপ্লয় হয়নি; Phase 3 fail-closed
        ↓
SQLite + Prisma (12 models)              ← SystemEvent সচল; বাকিগুলো phase-gated
```

**গুরুত্বপূর্ণ সিদ্ধান্ত:** মূল পরিকল্পনায় Python/FastAPI ছিল, কিন্তু এই sandbox-এর ম্যানেজড
অ্যাপ-রানটাইম হলো Next.js (Node/Bun) — একটিই exposed পোর্ট (3000)। তাই backend ও ডিটারমিনিস্টিক
ইঞ্জিন TypeScript-এ বাস্তবায়িত হচ্ছে; Python 3.12 + numpy/pandas আছে, কিন্তু সেটি অফলাইন
টুলিং-এর জন্য। আপনার নিজের VPS-এ ডিপ্লয় করলে (Phase 12) স্ট্যাক-নির্বাচন পুনর্বিবেচনা করা যাবে।

## চালানো

```bash
bun run dev        # dev server (port 3000)
bun run lint       # ESLint
bun run db:push    # Prisma schema → SQLite
```

`.env` ফাইল নেই? `.env.example` কপি করুন — প্লেসহোল্ডার ছাড়া কোনো মান নেই। কখনোই `.env`
commit করবেন না (`.gitignore`-এ সুরক্ষিত, `.env.example` ব্যতিক্রম)।

## API (Phase 1)

| Endpoint | Method | কাজ |
| --- | --- | --- |
| `/api/health` | GET | লাইভ হেলথ: DB, GLM স্ট্যাটাস, execution lock, runtime |
| `/api/audit/environment` | GET | সম্পূর্ণ Phase 1 অডিট রিপোর্ট (স্ট্যাটিক প্রমাণ + লাইভ মাপ + ইভেন্ট) |
| `/api/ai/verify` | POST | লাইভ GLM যাচাই: চ্যাট + বাংলা + টুল-কলিং full loop (রেট-লিমিটেড) |

## ১২-Phase রোডম্যাপ

1. ✅ **Project Audit & Foundation** (বর্তমান)
2. ⬜ Linux MT5 Bridge — বাহ্যিক VPS, read-only কন্ট্র্যাক্ট, symbol detection
3. ⬜ Database ও Market Data Validation
4. ⬜ Deterministic Market Analysis Engine (structure, BOS/CHoCH, EMA/RSI/ATR/ADX)
5. ⬜ Entry Setup ও Signal Engine (BUY/SELL/WAIT + expiry)
6. ⬜ GLM Multi-Agent Orchestration (analyst/critic/risk reviewer)
7. ⬜ Risk Manager ও Safety Gate (lot sizing, exposure, duplicate protection)
8. ⬜ FastAPI-সমমূলক API সম্প্রসারণ + Tool Registry বৃদ্ধি
9. ⬜ Web Dashboard ও বাংলা Chat Agent
10. ⬜ Backtesting ও Strategy Validation
11. ⬜ Demo Trading ও Approval-Based Execution (৪-সুইচ গেট তখনই খোলা যাবে)
12. ⬜ Deployment, Security ও Final Acceptance — Live Trading আলাদা অনুমোদনসাপেক্ষ

## নিরাপত্তা নীতি

- কোনো secret repo/log/frontend-এ থাকবে না — logger সব লগ মাস্ক করে (`maskSecrets`)।
- GLM শুধু allowlisted tool ব্যবহার করতে পারে — shell/SQL/network টুল নেই; planned tool রানটাইমে প্রত্যাখ্যাত।
- `z-ai-web-dev-sdk` শুধু server-side — client bundle-এ কখনো যাবে না।
- Execution কোড-লেভেলে তালাবন্ধ: `TRADING_PHASE ≥ 11` + `EXECUTION_ARMED` + `ALLOW_EXECUTION` + `TRADING_MODE ≠ read_only` — চারটিই একসাথে লাগবে।
- অডিট ট্রেইল (SystemEvent) append-only — সম্পাদনা/ডিলিট API নেই।

## ডেটাবেস

`prisma/schema.prisma` — ১২টি মডেল, প্রতিটির সাথে সক্রিয়-হওয়ার Phase চিহ্নিত। SQLite-এ Prisma
`Json` টাইপ নেই, তাই JSON পে-লোড `String` হিসেবে থাকে (প্রতিটি মডেলে কমেন্টে ব্যাখ্যা)।

---

# Phase 3 — Market Data Database & Validation Pipeline (অপারেশন গাইড)

**Read-only.** এই ফেজ শুধু ব্রোকার থেকে ডেটা নেয়, যাচাই করে ও সংরক্ষণ করে।
কোনো order/trade/position কার্যকারিতা নেই — স্ট্যাটিক টেস্ট (`tests/market/api.test.ts`,
case 18) প্রতিবার `bun test` চালানোর সময় এটি যাচাই করে।

## ১. ডেটাবেস মাইগ্রেশন ও ব্যাকআপ

```bash
# বর্তমান অবস্থা দেখুন (টেবিল + _prisma_migrations)
bunx prisma migrate status          # বা ./node_modules/.bin/prisma migrate status

# নতুন migration তৈরি করলে (schema.prisma এডিট করার পর)
bun run db:migrate                  # prisma migrate dev — ডেটা রেখে additive change

# ব্যাকআপ (SQLite — ফাইল কপি করলেই হয়; সার্ভার চলাকালীন নিরাপদ ব্যাকআপ)
sqlite3 db/custom.db ".backup 'db/backup-$(date +%F).db'" 2>/dev/null || cp db/custom.db "db/backup-$(date +%F).db"
```

মাইগ্রেশন ইতিহাস: `0_init` (Phase 1 baseline, `db push`-এ তৈরি DB-কে রেসেট ছাড়াই
মাইগ্রেশন ট্র্যাকিং-এ আনা হয়েছে) → `20261014121253_phase3_market_data`।
**Phase 1-এর SystemEvent ডেটা অক্ষুণ্ণ** — মাইগ্রেশনের আগে-পরে row count যাচাইকৃত।

Phase 3 টেবিল: `MarketCandle`, `MarketLatestTick`, `SymbolSpec`, `DataQualityIssue`,
`SyncRun` (দেখুন `prisma/schema.prisma`)। দাম **canonical decimal TEXT** হিসেবে
সংরক্ষিত (যেমন `"2654.32"`) — কারণ Prisma-র Decimal SQLite-এ REAL (float64) হয়ে
যায় (প্রমাণ: `audit/phase3-audit.md` §D3) — TEXT-এ binary rounding error হয় না।

## ২. Environment variables

সব ভেরিয়েবলের ব্যাখ্যা ও ডিফল্ট `.env.example`-এ দেওয়া আছে। গুরুত্বপূর্ণ:

| ভেরিয়েবল | ডিফল্ট | কাজ |
| --- | --- | --- |
| `MT5_BRIDGE_URL` | `""` (খালি) | ব্রিজ ঠিকানা। খালি থাকলে পুরো পাইপলাইন fail-closed — কোনো ডেটা বানানো হয় না |
| `MT5_BRIDGE_TOKEN` | `""` | `x-trader-key` হিসেবে যায়; কখনো log/response-এ আসে না |
| `MARKET_SYMBOLS` | `XAUUSDm` | strict allowlist |
| `MARKET_TIMEFRAMES` | `M5,M15,H1,H4` | strict allowlist |
| `MARKET_STALE_M5_SEC` … | ৩×tf | প্রতি-টাইমফ্রেম freshness সীমা (configurable) |
| `MARKET_SYNC_INTERVAL_MS` | `0` (বন্ধ) | শিডিউল করা সিঙ্ক; >0 + ব্রিজ সেট থাকলেই চালু |
| `MARKET_INGEST_DEMO` | `false` | ব্রিজের লেবেল-করা ডেমো ফিড ডিফল্টে skip হয় (SOURCE_DEMO) |
| `DATA_API_TOKEN` | unset | সেট করলে সব `/api/data/*`-এ `Authorization: Bearer` লাগবে |

## ৩. Ingestion — কখন/কীভাবে চালবে

তিনটি ট্রিগার, সব একই fail-closed সার্ভিস (`src/lib/market/ingestion.ts`) ব্যবহার করে:

```bash
# (ক) ম্যানুয়াল CLI — incremental
bun run market:sync
bun run market:sync -- --tf M5,H1 --mode manual

# (খ) ম্যানুয়াল CLI — bounded backfill (সর্বোচ্চ MARKET_BACKFILL_MAX_DAYS/_BARS)
bun run market:sync -- --mode backfill --from 2026-10-01T00:00:00Z --to 2026-10-14T00:00:00Z

# (গ) HTTP trigger (rate-limited; DATA_API_TOKEN সেট থাকলে Bearer লাগবে)
curl -X POST http://localhost:3000/api/data/sync -H 'Content-Type: application/json' \
  -d '{"symbol":"XAUUSDm","mode":"manual"}'

# (ঘ) শিডিউলার (opt-in) — .env-এ MARKET_SYNC_INTERVAL_MS=300000 দিলে প্রতি ৫ মিনিটে
#     স্বয়ংক্রিয় সিঙ্ক; ডিফল্ট বন্ধ। instrumentation.ts দেখুন।
```

আচরণ: idempotent upsert (একই candle-time দুবার দিলে updated হয়, duplicate রেকর্ড হয় না) ·
bounded retries + timeout (ব্রিজ ক্লায়েন্টে) · partial response-সহনশীল (কোনো tf ব্যর্থ হলে
অন্যগুলো চলে, run = `partial`) · **অসম্পূর্ণ run কখনো `success` হয় না** · প্রতিটি run-এর
হিসাব `SyncRun` টেবিলে। Forming candle `isForming=true` হিসেবে থাকে এবং confirmed
history থেকে সবসময় আলাদা থাকে।

## ৪. Data-quality নিয়ম (deterministic)

`src/lib/market/validation.ts` (pure functions — সময় সবসময় প্যারামিটার, তাই testable):

- Candle: required fields → finiteness (NaN/±∞) → positive prices → OHLC সঙ্গতি
  (`high ≥ max(open,close)`, `low ≤ min(open,close)`, `low ≤ high`) → timestamp sanity
  (epoch > 0, ভবিষ্যৎ tolerance 120s) — যেকোনো লঙ্ঘন = INVALID, persist হয় না।
- দামে প্রতীকী digits-এর চেয়ে বেশি দশমিক এলে WARNING (CANDLE_PRICE_PRECISION_ANOMALY)
  — **কখনো নিঃশব্দে round করা হয় না**।
- Tick: bid/ask positive + finite, `ask ≥ bid`, zero-spread = WARNING, ভবিষ্যৎ-ts = INVALID।
- Batch: duplicate key গণনা হয় (closed জেতে forming-এর বিরুদ্ধে), out-of-order sort হয়ে
  warning পায়।
- Gap-scan (session-aware): অনুপস্থিত ক্যান্ডেল → approximate closure envelope-এর ভেতরে
  হলে `GAP_MARKET_LIKELY_CLOSED` (info), বাইরে হলে `GAP_POSSIBLE` (warning — অজানা
  ছুটি/ত্রুটি)। **ব্রোকার সেশন-সময়সূচি যাচাইকৃত নয়** — তাই সব রায় "সম্ভাব্য", নিশ্চিত নয়।
- Staleness: প্রতি-tf configurable সীমা (ডিফল্ট ৩×tf); tick-এর আলাদা সীমা।
- Quality states: `VALID | WARNING | INVALID | STALE | MISSING | UNAVAILABLE` —
  WARNING কখনো নিঃশব্দে VALID হয় না; aggregation সবসময় worst-of।

Analysis-readiness (`/api/data/status` → `readiness`): `ready` মানে শুধু "ডেটা প্রস্তুত" —
**এটি কোনো trade recommendation নয়**। Not-ready হলে ডাউনস্ট্রিম বিশ্লেষণ
`getAnalysisReadiness()` থেকে structured UNAVAILABLE ফল পায় — বানানো candle বা
জোর করে BUY/SELL কখনোই নয়।

## ৫. Data API উদাহরণ

```bash
# স্ট্যাটাস: bridge সংযোগ + readiness + শেষ sync গুলো (ড্যাশবোর্ডের মূল কল)
curl 'http://localhost:3000/api/data/status'

# ক্যান্ডেল (closed-only ডিফল্ট; forming আলাদাভাবে চাইলে)
curl 'http://localhost:3000/api/data/candles?symbol=XAUUSDm&tf=M5&limit=100'
curl 'http://localhost:3000/api/data/candles?symbol=XAUUSDm&tf=H1&from=2026-10-01T00:00:00Z&to=2026-10-14T00:00:00Z&includeForming=true'

# সর্বশেষ টিক + verified symbol spec
curl 'http://localhost:3000/api/data/latest'

# কোয়ালিটি রিপোর্ট (readiness + thresholds + open issues)
curl 'http://localhost:3000/api/data/quality'

# sync রান ইতিহাস
curl 'http://localhost:3000/api/data/sync-status?limit=10'
```

সব রেসপন্স UTC ISO-8601 · সব দাম exact decimal string · এনভেলোপ
`{ ok: true, … }` / `{ ok: false, error: { code, message } }` — stable machine-readable
কোড (`BRIDGE_NOT_CONFIGURED`, `SYMBOL_NOT_ALLOWED`, `RATE_LIMITED`, …)।
সীমা: limit ≤ 1000, range ≤ 90 দিন, issues ≤ 200। `/api/health`-এ এখন `market`
সেকশন আছে (local DB state থেকে — ব্রিজ probe করে না, তাই দ্রুত)।

## ৬. টেস্ট চালানো

```bash
bun test              # package.json → bun test tests/market (৭৮টি টেস্ট, ৪ ফাইল)
bun run lint          # ESLint
```

টেস্ট-ডেটা **সম্পূর্ণ আলাদা DB**-তে চলে (`db/test-market.db` — প্রতি রানে নতুন করে তৈরি)।
ব্রিজ রেসপন্স সব **MOCK** (`tests/market/helpers/mock-bridge.ts` — ফাইলের শুরুতেই
স্পষ্ট ঘোষণা)। মক দিয়ে প্রমাণিত আচরণ আর লাইভ পরিকাঠামো আলাদাভাবে রিপোর্ট করা হয়।

## ৭. আসল MT5 smoke test (ব্রিজ ডিপ্লয়ের পর)

```bash
# .env-এ MT5_BRIDGE_URL (এবং লাগলে MT5_BRIDGE_TOKEN) সেট করে:
bun run market:smoke
```

স্ক্রিপ্টটি (`scripts/mt5-smoke-test.ts`) ব্রিজের বিপরীতে **আসল** রিড-ওনলি কল করে:
health → status (source=mt5 কি না) → symbols (XAUUSDm আছে কি না) → live quote →
প্রতিটি tf-এর candles লাইভ ভ্যালিডেটর দিয়ে যাচাই। প্রতিটি ধাপ PASS/FAIL/SKIP
প্রিন্ট করে; ব্রিজ কনফিগার না থাকলে সৎভাবে SKIP (exit 2) দেয় — **লাইভ টেস্ট পাস
বলে দাবি করে না যদি না সত্যিই চালানো হয়।**

## ৮. Troubleshooting ও রিকভারি

| উপসর্গ | কারণ/সমাধান |
| --- | --- |
| ড্যাশবোর্ডে “ডেটা পাওয়া যাচ্ছে না” + `BRIDGE_NOT_CONFIGURED` | প্রত্যাশিত — Phase 2 ব্রিজ এখনো নেই। `MT5_BRIDGE_URL` সেট করুন |
| `BRIDGE_UNREACHABLE` / `BRIDGE_TIMEOUT` | ব্রিজ প্রসেস বন্ধ/ধীর। ব্রিজ লগ দেখুন; ক্লায়েন্ট নিজেই bounded retry করে |
| `SOURCE_DEMO` (run=skipped) | ব্রিজে ক্রেডেনশিয়াল নেই — লেবেল-করা ডেমো ফিড দিচ্ছে। Exness demo লগইন দিন (read-only/investor password পছন্দনীয়) |
| `SYMBOL_NOT_FOUND` | ব্রিজের watchlist-এ XAUUSDm নেই — ব্রিজ কনফিগে সিম্বল যোগ করুন |
| `DB_TX_FAILED` | ট্রানজেকশন ব্যর্থ — run failed রেকর্ড হয়; পরের run-এ পুনরায় চেষ্টা হয় (idempotent, তাই নিরাপদ) |
| Stale data দেখাচ্ছে | `MARKET_STALE_*_SEC` সীমা বাড়ান, বা sync বেশি ঘন করুন (`MARKET_SYNC_INTERVAL_MS`) |
| পুরনো ভুল ডেটা মুছতে | এটি destructive — যেমন `db.marketCandle.deleteMany({ where: { validationStatus: 'INVALID' } })` (Phase 3-এ INVALID candle প্রথম থেকেই persist হয় না) |

রিকভারি নীতি: সব লেখা idempotent — যেকোনো ব্যর্থতার পরে শুধু `bun run market:sync`
আবার চালান; ডেটা স্বয়ংক্রিয়ভাবে মিলে যায়, duplicate হয় না।

## ৯. পরিচিত সীমাবদ্ধতা (Known Limitations)

1. **Phase 2 ব্রিজ ডিপ্লয়েড নয়** — তাই লাইভ XAUUSDm ডেটা এখনো আসে না; সব
   পৃষ্ঠ fail-closed। ব্রিজ বসালেই পাইপলাইন কোনো কোড পরিবর্তন ছাড়াই সক্রিয় হবে
   (চুক্তি: `audit/phase3-audit.md` §1.3)।
2. **Exness ক্রেডেনশিয়াল নেই** (`MT5_LOGIN/MT5_PASSWORD/MT5_SERVER`) — ব্রিজ বসার
   পরেও লাইভ LOGIN→candles প্রবাহ যাচাইয়ের জন্য দরকার।
3. **Market-session envelopes আনুমানিক** (উইকেন্ড/দৈনিক বিরতি) — ব্রোকার-যাচাইকৃত
   নয়; ফাঁকের রায় সবসময় "সম্ভাব্য"। ব্রিজ পরে session spec দিলে সেটা replace করবে।
4. **Reference ব্রিজে candles endpoint-এ from/to নেই** — শুধু `limit` — তাই backfill
   হলো bounded latest-N fetch; requested vs received সৎভাবে রেকর্ড হয়।
5. **SymbolSpec-এ শুধু `digits` verified** — point derive করা (10^-digits, meta-তে
   চিহ্নিত), tick_size/tick_value/volume ফিল্ড ব্রিজ চুক্তিতে নেই — অনুমান করা হয়নি।
6. **Scheduler ডিফল্টে বন্ধ** — sandbox-এ ২৪/৭ চালানোর কথা নয়; প্রোডাকশনে
   `MARKET_SYNC_INTERVAL_MS` দিয়ে চালু করবেন।
7. **Tick history রাখা হয় না** (by design) — প্রতি সিম্বলে শুধু latest snapshot।
