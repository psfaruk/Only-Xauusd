# XAUUSD AI Trading Agent — UI Lock Audit (Audit Only)

- **Date:** 2026-10-16 (UTC) · **Repo:** `psfaruk/Xauusd-agent` @ `24ca3ab`, branch `main`, tree clean
- **Scope:** every page, tab, navigation item, button, dropdown, chart and chat interface; every disabled/locked control's root cause; Analysis / Market Data / Charts / Signal History / Chat usability; mobile + desktop layout
- **Mode: AUDIT ONLY — no code change, no lock change, no commit, no push** (this report is the deliverable)
- **Method:** full frontend code inventory (`src/app/page.tsx`, 4,084 lines — the entire user-facing UI) + live browser E2E (desktop 1280×800 and mobile 390×844, every tab clicked, chat exercised end-to-end, GLM verify exercised end-to-end, console/page errors captured) + API/DB cross-verification
- **Security invariants (verified, unchanged):** live/demo order execution **LOCKED** (4-switch gate engaged, `executionLocked: true`, `tradingMode: read_only`); MT5 bridge **GET-only read-only** (405 POST / 401 no-token / `x-bridge-readonly: 1`); zero order-execution code paths; no secret or credential appears in any log, output or screenshot in this report

---

## 0. Executive summary

| # | Finding | Severity | Root-cause class |
|---|---|---|---|
| F-01 | Order-execution lock card + read-only posture | — (correct by design) | Security lock |
| F-02 | Market tab: sync button disabled, all values "—", bridge card "…" | **HIGH visibility / ENV** | Missing data (env rebuild wiped `.env`) — **not** a frontend bug |
| F-03 | GLM tab: capability badges show "✗ ব্যর্থ" after a SUCCESSFUL verification | **MEDIUM** | Frontend bug (state binding) |
| F-04 | Audit / Validation / Backtest cards conflate "API unavailable" with "genuinely empty" | **MEDIUM-LOW** | Frontend bug (missing error branch) |
| F-05 | Phase-label inconsistency: title "Phase 1" vs card "TRADING_PHASE=4" vs live "Phase 1" vs header "Phase 9" | LOW | Cosmetic / stale static copy |
| F-06 | MT5 KPI card stale copy "ব্রিজ বসানো Phase 2-এর কাজ" (bridge actually shipped Phase 8) | LOW | Cosmetic |
| F-07 | Test suite 496/499 — 3 order-dependent failures (test-hermeticity leak) | **MEDIUM** (test infra, not UI) | Test bug — details in `audit/phase11a-live-no-setup-root-cause.md` §6 |
| F-08 | No chart component exists anywhere in the UI | — (by design through Phase 10) | Not a defect — honest answer to the "chart" audit item |
| F-09 | Chat interface fully usable end-to-end (honest fail-closed replies) | — (working) | Verified good |
| F-10 | Mobile 390×844 + desktop 1280×800 layouts: no overflow, footer pinned, 0 console errors | — (working) | Verified good |

**Headline:** there is exactly **one true interactive-control frontend bug** (F-03, stale GLM badges) and **one structural display defect** (F-04, unavailable≠empty conflation). Every *disabled* control currently visible is either a **security lock by design** or the **honest fail-closed consequence of the environment rebuild** (F-02) — none is a placeholder mistake or a permission regression. The earlier user report ("frontend Exness options disappeared") is fully explained by F-02: **no credential-entry form ever existed in this frontend by design** — the "options" the user remembers were the live-populated data tabs and the enabled sync button, which render degraded/empty whenever `.env` loses the MT5 keys (sandbox rebuilds at 04:55 and ~11:51 UTC on 2026-10-16).

---

## 1. Complete UI inventory (code + live)

The whole UI is a single route `/` (`src/app/page.tsx`), a 12-tab dashboard. No other user-visible route exists. Interactive controls are exhaustive and enumerated below — there are **no dropdowns, no select menus, no dialogs, no popovers, no charts** in the entire UI (verified: zero `DropdownMenu`/`SelectTrigger`/`Popover`/`Dialog` usages; market data renders as tables/cards by design through Phase 10).

### 1.1 Tabs (navigation) — `page.tsx:1713-1726`, all 12 verified clickable desktop + mobile

| Tab (Bengali) | value | Live state at audit | Degraded handling |
|---|---|---|---|
| নিরীক্ষণ v2 | `audit` | sections render "(0)" counts | **NO banner — silent empty (F-04)** |
| মার্কেট ডেটা | `market` | "—" placeholders, sync disabled | honest placeholders + disabled button (F-02) |
| বিশ্লেষণ | `analysis` | explicit unavailable banner `MARKET_API_TOKEN_NOT_CONFIGURED` | **banner ✓ (the model implementation)** |
| সিগন্যাল | `signal` | honest empty + conditions fallback card | main card conflates (F-04); conditions card honest ✓ |
| ভ্যালিডেশন | `validation` | "এখনো কোনো ভ্যালিডেশন রান সংরক্ষিত হয়নি" | **NO banner — silent empty (F-04)** |
| চ্যাট | `chat` | fully interactive | working (F-09) |
| ডেটা স্বাস্থ্য | `dhealth` | explicit unavailable banner | **banner ✓** |
| আর্কিটেকচার | `arch` | static content, renders | n/a (static) |
| GLM যাচাই | `glm` | verify button works; badges stale | **F-03** |
| MT5 প্রতিবেদন | `mt5` | static/historical content, renders | n/a |
| ডেটাবেস | `db` | model table renders (14 models; 2 locked-until-Phase-11 noted) | n/a |
| নিরাপত্তা ও চেকলিস্ট | `sec` | static checklist renders | n/a |

### 1.2 Buttons — the complete disabled-control audit (the core of this report)

| Control | Location | `disabled` condition (code) | State observed live | Root cause class |
|---|---|---|---|---|
| **"এখনই সিঙ্ক করুন (ম্যানুয়াল)"** (sync) | market tab, `page.tsx:2110` | `syncing \|\| !marketStatus` | **DISABLED** | **Missing data / environment**: `marketStatus` is `null` because `GET /api/data/status` → 503 `MARKET_API_TOKEN_NOT_CONFIGURED` (fail-closed guard; `.env` wiped by sandbox rebuild → `MARKET_API_PUBLIC_READS` + `DATA_API_TOKEN` absent). NOT a security lock, NOT a placeholder bug, NOT a frontend defect. When env is restored (Task-25 posture) this button renders enabled — proven by the committed `phase11-live-restore-*.png` screenshots. |
| "বিশ্লেষণ চালান" (run analysis) | analysis tab, `page.tsx:2256` | `analysisRunning` only | ENABLED; click → POST 503 → **destructive toast** "বিশ্লেষণ চালানো যায়নি — DATA_API_TOKEN সেট করা হয়নি…" (verified live, toast captured) | Normal loading-state disable only; correct fail-closed UX |
| "মূল্যায়ন চালান" (evaluate signal) | signal tab, `page.tsx:2451` | `signalRunning` only | ENABLED; click → POST 503 → **destructive toast** "সিগন্যাল মূল্যায়ন চালানো যায়নি…" (verified live) | Normal loading-state disable; correct fail-closed UX |
| Chat "পাঠান" (send) | chat tab, `page.tsx:3387` | `chatSending \|\| input.trim()===''` | ENABLED with text; DISABLED empty (correct UX); send → honest fail-closed assistant reply "উত্তর আনা যায়নি (MARKET_API_TOKEN_NOT_CONFIGURED)" (verified end-to-end) | Normal UX |
| 5 example-question chips | chat tab, `page.tsx:3294-3301` | never disabled | Click fills the input only (`setChatInput(q)`) — by design, not a send | Normal UX |
| "GLM লাইভ যাচাই চালান" (verify) | glm tab, `page.tsx:3773` | `verifying` only | ENABLED; click → 3 real round-trips **PASSED** (28,394 ms; GLM_VERIFY_OK + Bengali + tool-calling; SystemEvent appended) | Works; but see **F-03** (stale badges) |
| Order execution | — | **No control exists at all.** The Order Execution KPI card (`page.tsx:1658`) is a status display: `LOCKED` badge, "Read-Only", "TRADING_PHASE=4 · চার-সুইচ গেট (Phase ≥ 11)", "Live/Demo অর্ডার: Phase 11+ অনুমোদনসাপেক্ষ" | Security lock by design — verified live: `/api/health` `executionLocked: true`; no order/trade/position endpoint exists in the codebase (scan: 0 hits) | **Security lock (correct)** |

### 1.3 Inputs / textareas

| Control | Location | State | Notes |
|---|---|---|---|
| Chat text input (`id=chat-input`, maxLength 2000) | `page.tsx:3380-3387` | working | Proper `<label>` ("আপনার প্রশ্ন লিখুন"), placeholder, focus styling |
| **No other text inputs, selects, dropdowns, sliders, switches or checkboxes exist** | — | — | Credential entry (MT5 login/password/server/token) is **deliberately absent from the frontend** — Phase 8 audited design: credentials live only in the gitignored `.env`, read by the bridge process. This directly answers the "where did the Exness input options go" question: they were never UI elements. |

### 1.4 Charts

None. All market/indicator data is presented as cards and tables. (Audit item answered honestly: nothing chart-like is locked or missing because no chart component exists by design through Phase 10.)

---

## 2. Findings — evidence, root cause, severity, proposed fix

### F-01 · Order execution lock — CORRECT BY DESIGN (no fix)

**Evidence:** KPI card `page.tsx:1658` (`TRADING_PHASE=4 · চার-সুইচ গেট (Phase ≥ 11)`); live `/api/health` → `executionLocked: true`, `tradingMode: "read_only"`, `executionReason: "Execution locked: Phase 1 is read-only by design (Phase 11 gate required)"`; bridge probes 405/401/`x-bridge-readonly: 1`; `db` tab lists `TradeApproval`/`ExecutionLog` as "Phase 11 পর্যন্ত তালাবদ্ধ"; code scan: zero order-submission endpoints, zero `tradeApproval.create`/`executionLog.create`.
**Root cause:** the audited four-switch lock (phase gate + `EXECUTION_ARMED` + `ALLOW_EXECUTION` + mode ≠ read_only), fail-closed defaults. The current env has no `TRADING_*` keys → defaults keep it locked.
**Classification:** security lock — **must remain unchanged** (mandate respected: this audit changed nothing).

### F-02 · Everything "dead-looking" on the Market tab (and the vanished "Exness options") — ENVIRONMENT, not frontend

**Evidence (live):** bridge card values all "—", quote card "এখনো কোনো বৈধ টিক সংরক্ষিত হয়নি", readiness "প্রস্তুত নয় (not ready)", sync runs "এখনো নেই", sync button disabled; bridge `/health` → `connected:false`; `GET /api/data/status` → 503 `MARKET_API_TOKEN_NOT_CONFIGURED`; `.env` contains only `DATABASE_URL`.
**Root cause chain:** third sandbox rebuild (~11:51 UTC 2026-10-16) regenerated `.env` → `MT5_BRIDGE_URL/TOKEN`, `MT5_LOGIN/PASSWORD/SERVER`, `MARKET_API_PUBLIC_READS`, `DATA_API_TOKEN`, `MARKET_SYNC_INTERVAL_MS`, `FORWARD_PAPER_TRACKING` all absent → every data API fails closed (by design) → `marketStatus=null` → button disabled (`!marketStatus`) → tabs render honest-empty. **The frontend is behaving exactly as designed** (fail-closed, no fabricated data).
**Why the user's "options" disappeared:** they were never input fields — they were the live-populated bridge/quote/candle cards and the enabled sync button (see committed `phase11-live-restore-market.png` for how it looks when connected). Same root cause.
**Proposed fix (environment, user-gated — no code):** restore the audited Task-25 `.env` posture via the platform env mechanism (credentials NEVER via chat), relaunch bridge + dev with the committed `.zscripts/relaunch-bridge.py`/`relaunch-dev.py`. **Rotate the previously chat-exposed MT5 password and GitHub PAT.** Optional small code hardening later (not now): add an explicit "সংযোগ-কনফিগ অনুপস্থিত (পরিবেশ)" banner to the market tab so env-loss is visually distinct from no-data.

### F-03 · GLM capability badges stale after successful verify — FRONTEND BUG (the one real control bug)

**Evidence (live, reproduced):** clicked "GLM লাইভ যাচাই চালান" → all three real round-trips passed (detail block shows GLM_VERIFY_OK / Bengali ✓ / tool-calling ✓, "সব টেস্ট পাস — মোট 28394ms") and the header KPI card updated to "GLM AI Access verified … সর্বশেষ যাচাই ৬:২৪ PM" — but the tab's three summary badges continued to display **"✗ ব্যর্থ"** with "Full loop —ms".
**Root cause (`page.tsx:3722-3760`):** the badges bind `audit?.glm.capabilities.chatCompletion ?? false` etc. — i.e., they read only the `/api/audit/environment` payload. That endpoint is currently 503 (env, F-02) → `audit === null` → `?? false` → "✗ ব্যর্থ" is rendered **regardless of the fresh `verifyResult`** that `runVerify` (`page.tsx:1300-1338`) just set. The badge never consults `verifyResult`; when the audit API is reachable the badges happen to refresh via `refresh()`, masking the defect.
**Severity:** MEDIUM — displays a false failure verdict on the same screen as contradictory pass evidence; misleads exactly when the environment is degraded.
**Proposed fix (next code phase, not now):** (a) when `verifyResult` exists, derive the three badges from it (`verifyResult.tests`); and/or (b) when `audit` is null, render a neutral "অডিট অনুপলব্ধ" badge instead of `false → ✗`; keep the pass/fail badge only when real evidence exists. Never show "ব্যর্থ" without evidence.

### F-04 · Unavailable-vs-empty conflation on Audit / Validation / Backtest (and signal main card) — FRONTEND BUG

**Evidence (live + code):** `/api/audit/environment`, `/api/validation/latest`, `/api/backtest/latest`, `/api/signal/latest` all 503 — yet the audit tab renders its three sections as "(0)" empty tables with no unavailability notice; the validation tab renders "এখনো কোনো ভ্যালিডেশন রান সংরক্ষিত হয়নি — সৎ খালি অবস্থা"; the backtest card renders "এখনো কোনো ব্যাকটেস্ট রান নেই" (`page.tsx:3603`); the signal main card renders "এখনো কোনো মূল্যায়ন সংরক্ষিত হয়নি". Contrast: the analysis tab shows a proper "পরিষেবা এখন অনুপলব্ধ (MARKET_API_TOKEN_NOT_CONFIGURED)" banner (via its dedicated `analysisError` state, `page.tsx:1251-1264`) and the dhealth tab shows "এন্ডপয়েন্ট এখন উপলব্ধ নয় (fail-closed)" (`page.tsx:3404-3408`).
**Root cause (`page.tsx:1246-1275`):** on fetch failure these responses are simply `setX(null)` — the null state renders the same UI as "genuinely no data". There is no error branch per endpoint (only analysis has one).
**Severity:** MEDIUM-LOW — today the DB is also genuinely empty (post-rebuild), so the display is coincidentally honest; but whenever the DB has rows and the API is unreachable (e.g., the Phase 9.1/9.2 recovery states), these tabs would wrongly claim "no runs stored" — an honesty defect in a product whose core design principle is never showing fabricated or misleading states.
**Proposed fix (next code phase):** replicate the `analysisError` pattern for `validationLatest`, `backtestLatest`, `signalLatest`, `signalHistory` and the audit response — a distinct "API অনুপলব্ধ (fail-closed)" banner rendered on 503/failure, reserving "এখনো কিছু নেই" exclusively for a successful empty response.

### F-05 · Phase-label inconsistency (4 different "phases" on one screen) — COSMETIC

**Evidence (live):** page `<title>` "… — **Phase 1 Audit**" (`src/app/layout.tsx:18`); header note "**Phase 9** (সিগন্যাল ইঞ্জিন + বাংলা চ্যাট) পর্যন্ত সবকিছু read-only"; Order Execution card static "**TRADING_PHASE=4** …" (`page.tsx:1658`); live health reason "**Phase 1** is read-only by design" (env default after rebuild — no `TRADING_PHASE` key). All four appear simultaneously.
**Root cause:** static copy from different eras (title from Phase 1; card label hardcoded during the Phase-9 preview posture when `TRADING_PHASE=4` was actually set — already flagged as COSM-1 in Phase 10.3-E; header note is a scope description). The env rebuild made the live reason revert to the default "Phase 1", amplifying the inconsistency.
**Severity:** LOW (cosmetic; the lock itself is verified engaged either way).
**Proposed fix (next code phase):** bind the card's phase text to the live `health.phase`/`executionReason` instead of the hardcoded "TRADING_PHASE=4"; refresh the title.

### F-06 · MT5 KPI card stale copy — COSMETIC

**Evidence:** card subtitle "ওয়েব-টার্মিনাল প্রোটোকল প্রমাণিত · **ব্রিজ বসানো Phase 2-এর কাজ**" (`page.tsx:1648`) — while the MT5 report tab correctly states the bridge shipped in Phase 8 and was live-verified.
**Root cause:** Phase-1-era copy never updated.
**Proposed fix:** update the string (next code phase).

### F-07 · Test suite 496/499 (3 order-dependent failures) — TEST-INFRASTRUCTURE DEFECT (full detail + proof in the companion Phase 11-A report §6)

**Evidence:** full-suite runs fail deterministically on `paper.test.ts:213`, `paper-chronology.test.ts:509/568`; each file passes in isolation (17/17, 28/28); `tests/market/quality.test.ts` (which cleans only in `beforeEach`, never `afterAll`) + either paper file reproduces the failures exactly; the third sandbox rebuild changed Bun's file-enumeration order, putting the leaking market file before the paper files.
**Root cause:** shared isolated test DB polluted across files; NOT production code (tree clean, protocol byte-identical).
**Severity:** MEDIUM (breaks the 499/499 reliability gate; zero effect on live behavior — proven).
**Proposed fix (next code phase):** `afterAll` cleanup in `quality.test.ts` + per-test row isolation in the paper DB tests.

---

## 3. Usability verification (the five mandated areas)

| Area | Verdict | Evidence |
|---|---|---|
| **Analysis** | Usable, honest | Tab renders; service banner states exactly why it is closed (`MARKET_API_TOKEN_NOT_CONFIGURED`, "ইচ্ছাকৃত, ৫০৩"); run button enabled with loading state; click produces a destructive toast with the reason (captured live). Engine card explains scope ("কোনো ট্রেড সিগন্যাল বা সুপারিশ নয়"). |
| **Market Data** | Usable, honestly degraded | Every empty field shows an explicit placeholder ("—", "এখনো নেই", "প্রস্তুত নয়") with explanatory copy; nothing is fabricated; sync disabled with a code-verified reason (F-02). When connected (committed Task-25 screenshots) the same tab shows live bid/ask/spread, per-TF candle freshness and a working sync. |
| **Charts** | N/A — none exist by design | No chart component in the codebase; tables/cards only (see §1.4). |
| **Signal History** | Usable, honestly empty | "সর্বশেষ মূল্যায়ন" card + "সামপ্রতিক মূল্যায়ন (append-only)" list with the mandated "মূল্যায়ন-সংখ্যা ≠ স্বতন্ত্র সেটআপ-সংখ্যা" note; conditions card ("শর্ত-বাই-শর্ত বিশ্লেষণ") shows the honest unavailable fallback "এটি কৌশলগত ব্যর্থতা নয়" (distinct from F-04's main-card conflation); baseline + candidate version lines render. |
| **Chat** | Fully usable | Input + label + placeholder; 5 example chips fill the input; send disabled-when-empty (correct); send → user bubble + assistant honest fail-closed reply with error code; design shows deterministic state badges separately from LLM text; explicit "চ্যাট কোনো ট্রেড চালাতে পারে না" notice; allowlisted read-only tools documented on-card. |

## 4. Mobile & desktop layout verification

| Check | Desktop 1280×800 | Mobile 390×844 |
|---|---|---|
| All 12 tabs reachable/clickable | ✓ | ✓ (tablist wraps to 3 rows, height 106 px, all visible — no hidden/unclickable tab) |
| Horizontal overflow | none | none (`scrollWidth 390 === clientWidth 390`) |
| Footer | pinned at content bottom | exact document bottom (`gapBelowFooter: 0`, page height 2206) |
| Console / page errors across the whole session (all tabs + chat send + GLM verify + both trigger buttons) | **0** | **0** |
| Touch targets | buttons ≥ 44 px padded | ✓ (chips ~30 px visual but padded hit area; primary buttons comfortably sized) |
| Screenshots (this audit) | `audit/ui-audit-desktop-initial.png`, `-final.png`, `-tab-market.png`, `-tab-analysis.png`, `-toast-signal-503.png` | `audit/ui-audit-mobile-top.png`, `-chat.png`, `-footer.png` |

`dev.log` during the session: only the pre-documented transient `EADDRINUSE` startup race (environment, Phase 10.3-E) — zero runtime/render/hydration errors; 503s are the intended fail-closed responses.

---

## 5. Correction plan (ordered, evidence-based; NOTHING executed in this audit-only phase)

1. **Environment restoration (user-gated, no code):** re-provision `.env` (audited Task-25 posture) via the platform mechanism; rotate the chat-exposed MT5 password + GitHub PAT first; relaunch via the committed double-fork relaunchers. Unblocks F-02 (and the dashboard returns to the connected state). — *smallest action with the largest effect.*
2. **F-03 fix (code, next phase):** GLM badges derive from `verifyResult` when present; neutral "অনুপলব্ধ" badge when `audit` is null.
3. **F-04 fix (code, next phase):** per-endpoint unavailable banners (analysis/dhealth pattern) for validation/backtest/signal/audit responses.
4. **F-07 fix (code, next phase):** test-hermeticity cleanup (`afterAll` in `quality.test.ts`; row isolation in paper tests) → restore 499/499.
5. **F-05/F-06 fixes (code, next phase):** live-bind the phase label; refresh stale copy + title.
6. **Never:** any change to the four execution locks, the bridge's read-only contract, or adding any order-execution control. The Order Execution card must stay a LOCKED status display.

**This phase made no code change, no lock change, no commit, no push. Both deliverables: `audit/ui-lock-root-cause.md` (this file) and `audit/phase11a-live-no-setup-root-cause.md`.**
