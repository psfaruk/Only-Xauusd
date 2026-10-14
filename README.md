# XAUUSD AI Trading Agent

**GLM-চালিত হাইব্রিড ট্রেডিং অ্যানালিসিস সিস্টেম — Exness MT5 টার্গেট · Read-Only · Bengali-First**

> এই প্রজেক্টে AI (GLM) বাজার বুঝবে ও ব্যাখ্যা করবে, কিন্তু Entry/SL/TP, Lot Size ও Risk
> যাচাই করবে ডিটারমিনিস্টিক কোড। আপনার অনুমোদন ছাড়া কোনো অর্ডার যাবে না — এবং Phase 1-এ
> অর্ডার-পাঠানোর কোনো কোডই নেই।

---

## বর্তমান অবস্থা — Phase 1 (Environment Audit & Foundation) ✅

Phase 1-এর সম্পূর্ণ প্রতিবেদন **ড্যাশবোর্ডে** (`/` route) দেখুন — সেটিই একমাত্র user-visible route।

মূল ফলাফল (সবই প্রকৃত কমান্ড-প্রমাণসহ, `audit/glm-tool-call.ts` ও `/api/audit/environment`):

| বিষয় | ফলাফল |
| --- | --- |
| OS / Runtime | Debian 13 (trixie) · Node v24 · Bun 1.3 · Python 3.12 + numpy/pandas (টুলিং-এর জন্য) |
| GLM access | ✅ যাচাইকৃত — মডেল `glm-4-plus`, sandbox-managed auth (কোনো API key লাগে না) |
| GLM Bengali | ✅ যাচাইকৃত — Phase 9-এর বাংলা Chat Agent সম্ভব |
| GLM tool calling | ✅ যাচাইকৃত — full loop 720ms (model → allowlist → execute → feed back → answer) |
| MT5 sandbox-এ | ❌ অসম্ভব — Wine নেই; `pip install MetaTrader5` Linux-এ ব্যর্থ (Windows-only wheels) |
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
MT5 Bridge — EXTERNAL (Phase 2)          ← sandbox-এ MT5 চলবে না; বাহ্যিক VPS ব্রিজ প্রয়োজন
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
