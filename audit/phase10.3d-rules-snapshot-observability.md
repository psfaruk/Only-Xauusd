# Phase 10.3-D — Rules Snapshot Persistence & Dashboard Observability

**Report path:** `audit/phase10.3d-rules-snapshot-observability.md`
**Baseline verified:** HEAD `277c98b` (parent `6419ebd`), branch `main`, working tree clean.
**Scope:** analysis/signal/paper ONLY. No order execution (four locks verified: `TRADING_PHASE` unset → 1 < 11; `TRADING_MODE` unset → `read_only`; `EXECUTION_ARMED` unset → false; `ALLOW_EXECUTION` unset → false).

---

## 1. Preflight record (all-pass)

| Check | Result |
|---|---|
| `git status --short` | clean (no unreviewed changes) |
| Branch / HEAD / parent | `main` / `277c98b4…` / `6419ebd6…` — matches expected baseline |
| Phase 10.2 protocol files (`paper-protocol.ts`, `core.ts`, `rules.ts`, `types.ts`) | `git diff 8d94a00 HEAD -- paper-protocol/` → **0 files changed** (byte-identical to pre-registration) |
| Four execution locks | locked (no `TRADING_*` / `EXECUTION_*` keys present in `.env`; defaults all fail-closed) |
| `.env` inspection | keys-only inspection: `DATABASE_URL`, `MARKET_API_PUBLIC_READS`, `MARKET_MAX_CANDLES_PER_REQUEST`, `MARKET_SYNC_INTERVAL_MS`, `MT5_*` (6). No secret values read or recorded. No `SIGNAL_*` / `ANALYSIS_*` overrides → live rules = documented defaults |
| Migration state | `db:push`-managed posture + 6 committed migration folders (0_init … 20261015120000_phase10_3a_setup_fingerprint); no drift actions taken |
| DB counts (read-only) | SignalEvaluation **36**, PaperSignalOutcome **0** (0 open / 0 resolved / 0 legacy-null-fp), Signal 0, AnalysisRun 2, RiskCheck 0 |
| Baseline tests | **403/403 pass** (22 files) — zero pre-existing failures |
| Bridge / dev server | `:3031/health` 200, `:3000/api/health` 200 |
| Paper scheduler | active (recent live evaluation `SIGNAL_NO_SETUP [STRUCTURE_BREAK_TOO_OLD]` in `dev.log`) — NOT stopped |

**Stop conditions:** none triggered.

---

## 2. Phase 10.3-D-A — Why `inputSnapshot.rules` is null (root cause)

### 2.1 The code path (traced, source-level)

```
runSignalEvaluation (src/lib/signal/service.ts)
  ├─ rules = buildStrategyRules()                    ← the ACTUAL rules for this evaluation
  ├─ evaluateSignal({ …, rules })                    ← rules used by the deterministic core
  │    └─ computeSignalFingerprint(input)            ← sha256 payload INCLUDES `rules: input.rules`
  │         → inputFingerprint persisted             ← rules are cryptographically COMMITTED
  └─ persist(evaluation, quote)
       └─ saveSignalEvaluation (src/lib/signal/persistence.ts)
            └─ inputSnapshot: JSON.stringify({
                 windows: …,
                 rules: null,   // ← LINE 114: "rules snapshot added by the service (kept small)"
               })
```

**Root cause:** `saveSignalEvaluation` hard-codes `rules: null`. The Phase 9 comment says the service would add the rules snapshot "kept small", but **`SaveSignalEvaluationArgs` never carried the rules and the service never added them** — an unfinished Phase 9 TODO. The rules *were* used (baked into `inputFingerprint` via sha256) but were never persisted in readable form.

Consequences:
- `inputSnapshot.rules` is `null` on **all 36 live rows** (verified read-only).
- The dashboard cannot show which rules an evaluation used; only the *current* config is knowable, which is not evidence for historical rows.
- `STRATEGY_DOC` (Bengali rule documentation, `src/lib/signal/rules.ts:56`) is defined but **rendered nowhere**.
- The backtest layer DOES persist rules (`BacktestRun.rules` = `{ backtestRules, strategyConfig: StrategyRules }`) — the live evaluation layer is the inconsistent one.

### 2.2 What IS persisted today per evaluation

| Data | Where | Rules included? |
|---|---|---|
| Windows (from/to/bars per TF) | `inputSnapshot.windows` | no |
| Rules | `inputSnapshot.rules` | **null (the gap)** |
| Structure/anchor/indicators/HTF | `evidence` | no (data, not config) |
| Levels + canonical text | `levels` (setups only) | no |
| Quote at evaluation | `quote` | no |
| Rules hash-commitment | `inputFingerprint` | yes, but sha256-only (not readable, not diffable) |
| Setup identity | `setupFingerprint` (10.3-A) | strategyVersion is an input |
| Engine/strategy versions | columns | version strings only |

### 2.3 Risk-check storage

`RiskCheck` (Phase 7 model) has **0 rows** — the deterministic risk gates live inside the signal engine (reason codes per evaluation), not in a separate risk-check table. The signal's own `reasonCodes` + `quote` + `evidence` ARE the recorded gate outcomes. Nothing to migrate; the dashboard must surface them (it already lists reason codes; this phase makes the *rules* they were checked against visible).

---

## 3. Rules inventory (complete, traced to source)

Live values = verified defaults (no env overrides present). Units/scopes from `core.ts` usage.

### 3.1 Manifest entries (23) — from `StrategyRules` (all genuinely used per evaluation)

| # | Rule ID | Live value | Unit | Scope | Source | Persisted today? |
|---|---|---|---|---|---|---|
| 1 | `strategy.version` | `hybrid-structure-retest/9.0.0` | version | identity | strategy constant (`types.ts:30`) | column + fingerprint only |
| 2 | `signal.executionTf` | `M15` | timeframe | eligibility | strategy constant (`config.ts:154`) | fingerprint only |
| 3 | `signal.contextTfs` | `H1,H4` | timeframes | eligibility | strategy constant (`config.ts:155`) | fingerprint only |
| 4 | `analysis.windowBars` | 300 | bars | window | verified configuration (`ANALYSIS_MAX_BARS_PER_TF`) | fingerprint only |
| 5 | `analysis.minExecutionBars` | 220 | bars | eligibility gate | verified configuration (`ANALYSIS_MIN_BARS_PER_TF`) | fingerprint only |
| 6 | `signal.minH1Bars` | 220 | bars | eligibility gate | verified configuration (`SIGNAL_MIN_H1_BARS`) | fingerprint only |
| 7 | `signal.minH4Bars` | 200 | bars | eligibility gate | verified configuration (`SIGNAL_MIN_H4_BARS`) | fingerprint only |
| 8 | `analysis.swingLeft` | 3 | bars | structure detection | verified configuration (`ANALYSIS_SWING_LEFT`) | fingerprint only |
| 9 | `analysis.swingRight` | 3 | bars | structure detection | verified configuration (`ANALYSIS_SWING_RIGHT`) | fingerprint only |
| 10 | `signal.maxBarsSinceBreak` | 8 | bars | eligibility | verified configuration (`SIGNAL_MAX_BARS_SINCE_BREAK`) | fingerprint only |
| 11 | `signal.zoneWidthAtr` | 0.5 | ATR multiple | entry | verified configuration (`SIGNAL_ZONE_WIDTH_ATR`) | fingerprint only |
| 12 | `signal.entryToleranceAtr` | 0.25 | ATR multiple | entry | verified configuration (`SIGNAL_ENTRY_TOLERANCE_ATR`) | fingerprint only |
| 13 | `signal.slAtrBuffer` | 0.5 | ATR multiple | risk (SL) | verified configuration (`SIGNAL_SL_ATR_BUFFER`) | fingerprint only |
| 14 | `signal.rewardRisk` | 2.0 | R multiple | risk (TP) | verified configuration (`SIGNAL_REWARD_RISK`) | fingerprint only |
| 15 | `signal.minAdx` | 15 | ADX | eligibility filter | verified configuration (`SIGNAL_MIN_ADX`) | fingerprint only |
| 16 | `signal.rsiBuyMin` | 40 | RSI | eligibility filter | verified configuration (`SIGNAL_RSI_BUY_MIN`) | fingerprint only |
| 17 | `signal.rsiBuyMax` | 75 | RSI | eligibility filter | verified configuration (`SIGNAL_RSI_BUY_MAX`) | fingerprint only |
| 18 | `signal.maxSpreadPrice` | 0.6 | price | eligibility filter | verified configuration (`SIGNAL_MAX_SPREAD`) | fingerprint only |
| 19 | `signal.expiryBars` | 12 | bars | expiry | verified configuration (`SIGNAL_EXPIRY_BARS`) | fingerprint only |
| 20 | `indicator.emaPeriod` | 50 | period | indicator | strategy constant (`rules.ts:48`) | fingerprint only |
| 21 | `indicator.rsiPeriod` | 14 | period | indicator | strategy constant (`rules.ts:49`) | fingerprint only |
| 22 | `indicator.atrPeriod` | 14 | period | indicator | strategy constant (`rules.ts:50`) | fingerprint only |
| 23 | `indicator.adxPeriod` | 14 | period | indicator | strategy constant (`rules.ts:51`) | fingerprint only |

### 3.2 Metadata entry (1) — evaluation input, broker-verified

| # | Rule ID | Live value | Unit | Scope | Source | Persisted today? |
|---|---|---|---|---|---|---|
| 24 | `symbol.digits` | 3 (XAUUSDm) | digits | metadata (level text formatting) | broker metadata (`SymbolSpec`, bridge-verified; `null` when spec missing → **unavailable**) | no — only inside the fingerprint hash |

### 3.3 Values NOT included in the manifest (and why)

- **Gate thresholds outside `StrategyRules`** (staleness windows, quote-integrity rules, demo-source policy): these are *data-readiness gates*, not strategy rules; their outcomes are already persisted per evaluation as `reasonCodes` + `quote`. Labelled here as traced-but-out-of-manifest (would double the surface without adding evaluation semantics). Source gap: none — documented in `config.ts` + `integrity.ts`.
- **Phase 10.2 paper protocol rules**: pre-registered, versioned, test-pinned in `paper-protocol.ts` (byte-identical to `8d94a00`) — deliberately NOT copied into per-evaluation snapshots (they are protocol-level, not evaluation-level; duplication would create drift risk).
- **No unknown/untraceable rules exist** — every `StrategyRules` field is traceable to `config.ts` or a `rules.ts` constant. No invented values.

### 3.4 Persisted / reconstructed / missing classification

- **Persisted (readable):** none of the 24 entries.
- **Committed (hash-only):** all 23 strategy entries (inside `inputFingerprint`).
- **Reconstructed today by the dashboard:** none (the dashboard shows no rules at all — honest, but unobservable).
- **Missing:** `symbol.digits` is not even hash-committed separately (it is inside the fingerprint payload).

---

## 4. Proposed snapshot schema (Phase 10.3-D-B design)

**Decision: reuse the existing `inputSnapshot.rules` JSON key — NO migration, NO schema change.** The column already exists (`SignalEvaluation.inputSnapshot`, non-null String), the key is already reserved (`rules: null`), and no code parses it today (verified: only the fingerprint hashes the rules; nothing reads `inputSnapshot.rules`). Filling it is purely additive JSON content. Historical rows keep `rules: null` → displayed as **"Not recorded for this evaluation"** — never backfilled, never reconstructed.

### 4.1 Shape (versioned, validated, deterministic)

```typescript
export const RULES_SNAPSHOT_VERSION = 1;

export type RuleProvenance =
  | 'verified-configuration'   // value from src/lib/config.ts (the verified config)
  | 'strategy-constant'        // hard-locked constant in signal/rules.ts|types.ts
  | 'broker-metadata'          // verified SymbolSpec value (digits)
  | 'unavailable';             // genuinely not available at evaluation time (e.g. digits=null on SPEC_MISSING)

export interface RuleManifestEntry {
  id: string;          // stable rule ID, e.g. 'signal.maxBarsSinceBreak'
  value: number | string | string[];  // the ACTUAL value used; numbers always finite
  unit: string;        // 'bars' | 'atr_multiple' | 'r_multiple' | 'adx' | 'rsi' | 'price' | 'period' | 'timeframe' | 'version' | 'digits'
  scope: string;       // 'identity' | 'eligibility' | 'window' | 'entry' | 'risk' | 'expiry' | 'indicator' | 'metadata'
  source: RuleProvenance;
}

export interface RulesSnapshot {
  rulesSnapshotVersion: number;  // 1 — required, validated
  engineVersion: string;         // '9.0.0' (evaluation's engine, not "current")
  strategyVersion: string;       // 'hybrid-structure-retest/9.0.0'
  symbol: string;                // 'XAUUSDm'
  rules: RuleManifestEntry[];    // fixed construction order → stable serialization
  snapshotHash: string;          // sha256, namespace 'rules-snapshot/1' — INTEGRITY ONLY
}                                  // (deliberately separate from setupFingerprint,
                                   // inputFingerprint and the Phase 10.2 protocol fingerprint;
                                   // implies NO authenticity, NO broker verification)
```

### 4.2 Design decisions (determinism & honesty)

1. **No timestamps inside the snapshot.** The evaluation instant is the row's `createdAt`/`generatedAtUtc` (already stored). A `capturedAtUtc` would break byte-determinism of repeated construction and add nothing. The strict validator rejects unknown fields, so injected timestamps fail closed.
2. **Single construction path = canonical serialization.** `buildRulesSnapshot()` builds entries in a fixed literal order with fixed keys; `JSON.stringify` of that construction is the canonical form. Repeated construction from the same `StrategyRules` yields byte-identical JSON (test-pinned).
3. **`null` / absent / unavailable handling:** legacy rows (`rules: null` or key absent) → read result `not-recorded`; malformed values (including JSON-`null` where a number belongs — which is how `NaN`/`Infinity` survive `JSON.stringify`) → `invalid` with a structured diagnostic; `symbol.digits: null` is a legitimate `unavailable` provenance entry (value `null` allowed ONLY for this entry).
4. **Hash is integrity-only.** `snapshotHash` recomputes over the manifest; mismatch on read → `invalid` (detects tampering/corruption). It is namespaced (`rules-snapshot/1`), never compared to, mixed with, or derived from the setup fingerprint (10.3-A), `inputFingerprint`, or the Phase 10.2 protocol fingerprint. It implies nothing about authenticity or broker verification.
5. **Secret exclusion by construction:** only the 24 documented rule values + version strings + symbol enter the snapshot. Test scans the serialized output for forbidden key patterns (token/password/secret/key/env). No API keys, credentials, account data, or environment dumps.
6. **Compact manifest, not a market-data copy:** 24 entries ≈ 2 KB JSON. No candles, no quotes, no evidence duplication (`windows` already lives beside it in `inputSnapshot`).
7. **Build is total, write is safe:** `buildRulesSnapshot(rules, meta)` validates and returns either `{ ok: true, snapshot }` or `{ ok: false, diagnostic }`. On failure the service persists a structured diagnostic object (`{ rulesSnapshotVersion, error: 'INVALID_RULES_SNAPSHOT', diagnostic }`) — persistence failure must never mask the verdict (existing service invariant).
8. **Rules = configuration in force, not pass/fail.** The manifest records what the evaluation was *configured* with. Whether a rule *passed or failed* is the `reasonCodes` surface (already persisted and displayed). The dashboard keeps these two concepts visually and semantically separate, and never renders a green/pass indicator for a merely-recorded rule.

### 4.3 Integrity & versioning (Phase 10.3-D-C)

- **Strategy version is NOT bumped.** This is persistence/presentation work; `SIGNAL_STRATEGY_VERSION` stays `hybrid-structure-retest/9.0.0`, engine stays `9.0.0`. Strategy behavior, eligibility, geometry: untouched.
- **Setup identity (10.3-A) untouched:** `setup-identity/1` algorithm, exclusions, dedup boundaries — no code path changes. `setupFingerprintFromEvidence` is not modified.
- **Snapshot version vs strategy version:** `rulesSnapshotVersion` describes the SNAPSHOT FORMAT. A future strategy change that alters rule values produces a different manifest (and hash) under the same format version; a format change bumps `rulesSnapshotVersion` and old readers reject newer snapshots as `invalid` (fail-closed) rather than mis-rendering them.
- **Older-evaluation behaviour:** when current rule definitions differ from a stored snapshot, the dashboard shows the STORED snapshot (historical truth). It never recomputes from `buildStrategyRules()` at read time (test-pinned). Rows written before this phase show the explicit legacy notice.
- **Repeat reads are non-mutating:** the read path is pure parsing; no write-back, no recomputation, no drift (test-pinned). Retried/duplicate evaluations follow existing append-only + 10.3-A dedup semantics (regression suites). Resolved paper outcomes remain immutable (regression suites).
- **When definitions differ:** the audit trail remains append-only — a rules change appears as different manifests on NEW rows; OLD rows keep their stored snapshot forever. A visible `rulesSnapshotVersion` + `snapshotHash` (short, full in tooltip) lets a reader detect that two evaluations used different rule sets without trusting the dashboard's claim.

### 4.4 Read-path result model

```typescript
export type RulesSnapshotRead =
  | { status: 'present'; snapshot: RulesSnapshot }         // parsed + hash-verified
  | { status: 'not-recorded' }                             // legacy row (rules: null / absent)
  | { status: 'invalid'; reason: string };                 // malformed/contradictory — diagnostic
```

`parseRulesSnapshot(inputSnapshotJson: string | null)` inspects the WHOLE `inputSnapshot` object, so null/absent/malformed are distinguished at the boundary. The reason string is a safe machine code (e.g. `VERSION_UNSUPPORTED`, `HASH_MISMATCH`, `NON_FINITE_VALUE`) — never raw error dumps, never secrets.

### 4.5 API surface changes (read-only, additive)

1. `/api/signal/latest` + `/api/signal/history`: each returned evaluation gains `setupFingerprint: string | null` and `rulesSnapshot: RulesSnapshotRead` (pass-through of the extended `LatestSignalEvaluation`).
2. `/api/signal/history` additionally gains `totalEvaluations` (all-time count for the symbol) and `distinctSetups` (all-time count of distinct non-null `setupFingerprint`) — so the dashboard can distinguish **evaluation counts** from **distinct setup counts** from **paper outcome counts**. No new endpoint; GET-only.
3. Dashboard (`/`): identity card (setup fingerprint, symbol/TF, snapshot version+hash, lifecycle/expiry status), rule-manifest card (three states: present / not-recorded [legacy notice, not a failure] / invalid [diagnostic]), counts row + recent-evaluations list in the validation tab (legacy rows labelled "আঙুলছাপ নেই (legacy/unidentified)" — no fabricated IDs), pass-state note for setups. All existing price formatting goes through the Phase 10.3-C verified formatter. No execute/approve/submit controls; interface stays read-only.

### 4.6 Test plan (test-first — RED before implementation)

New `tests/signal/rules-snapshot.test.ts` (pure) + persistence integration cases + API route tests + regression suites. Full matrix in §8 (RED/GREEN evidence recorded there when run).

---

## 5. Implementation record (Phase 10.3-D-B/C/D)

### 5.1 Files changed (complete list)

| File | Change |
|---|---|
| `src/lib/signal/rules-snapshot.ts` | **NEW** — pure module: `RULES_SNAPSHOT_VERSION=1`, `buildRulesSnapshot` (total, validating), `serializeRulesSnapshot` (canonical, single construction path), `parseRulesSnapshot` (strict fail-closed: not-recorded / invalid-with-reason), 24-entry `RULE_SPECS` manifest spec (single source of truth for build AND parse), namespaced integrity hash `rules-snapshot/1` |
| `src/lib/signal/persistence.ts` | `SaveSignalEvaluationArgs` + `rules` + `digits`; `inputSnapshot.rules` = built snapshot or structured diagnostic; `LatestSignalEvaluation` + `setupFingerprint` + `rulesSnapshot`; `parseLatestRow` parses both; **NEW** `getSignalEvaluationCounts` (all-time evaluations vs distinct non-null setup fingerprints; null on DB error) |
| `src/lib/signal/service.ts` | `persist`/`blockedOutcome` carry verified digits (null = unavailable, recorded honestly); happy path passes `windows.digits`; every outcome family (BLOCKED/NO_SETUP/WAIT/FAILED/SETUP) persists the ACTUAL `rules` object built once per run |
| `src/app/api/signal/history/route.ts` | additive `counts` block (`totalEvaluations`, `distinctSetups`); each history entry now includes `setupFingerprint` + `rulesSnapshot` |
| `src/app/page.tsx` | 11th parallel fetch `/api/signal/history`; identity card gains symbol + setup-fingerprint cell (full value in tooltip, honest null label) + expiry status (মেয়াদোত্তীর্ণ indicator); **rule-manifest card** (3 states: present [bounded scrollable list, v-badge, hash short+tooltip, per-entry id/value/unit/source-Bengali], not-recorded [amber legacy notice — NOT a failure], invalid [diagnostic + explicit "not a strategy failure"]); **recent-evaluations card** (bounded 20, legacy/no-fingerprint labels, snapshot-state markers); **validation-tab counts strip** (three never-conflated counts: evaluations / distinct setups / paper rows + paper-is-not-a-broker-trade note) |
| `tests/signal/rules-snapshot.test.ts` | **NEW** — 41 tests (matrix below) |
| `tests/signal/setup-identity.test.ts` | 2 disclosed fixture updates: D2 call sites gain `rules: buildStrategyRules(), digits: 3` (assertion intent unchanged — the setup-identity assertions are byte-identical) |
| `audit/phase10.3d-rules-snapshot-observability.md` | this report |

**Schema/migration: NONE.** The snapshot lives inside the existing `inputSnapshot` JSON (`rules` key, previously always `null`). Verified: `git diff 277c98b -- prisma/schema.prisma` → 0 changes.

### 5.2 What is stored vs displayed

- **Stored (new rows only):** 24-entry manifest (23 strategy rules + broker digits), `rulesSnapshotVersion`, engine/strategy versions, symbol, integrity hash — inside `inputSnapshot.rules`.
- **Displayed:** identity card (symbol, engine/strategy, setup fingerprint, snapshot version + hash short, expiry state), rule manifest (id/value/unit/source per entry), recent-evaluations list, three-way counts. All from the STORED snapshot / row — nothing recomputed from current config at read time (test-pinned).
- **Not stored, not displayed:** no timestamps inside the snapshot (row `createdAt` is the evaluation instant); no market-data copy; no secrets (construction only emits the 24 documented values; key-pattern scan test-pinned).

### 5.3 Integrity & versioning behaviour (Phase 10.3-D-C, as-built)

- Strategy/engine versions NOT bumped (`hybrid-structure-retest/9.0.0`, `9.0.0`). Setup-identity algorithm untouched (byte-identical `setup-identity.ts`).
- `snapshotHash` namespaces `rules-snapshot/1:` — separate from `setupFingerprint`, `inputFingerprint`, and the Phase 10.2 protocol fingerprint; implies integrity only, never authenticity or broker verification.
- Older evaluations: the dashboard shows the STORED snapshot forever; a rules change appears only on NEW rows. `rulesSnapshotVersion` bump makes old readers reject newer snapshots as `invalid` (fail-closed) rather than mis-render.
- Repeated reads never mutate (test-pinned; live-verified). Duplicate evaluations follow 10.3-A semantics (two audit rows, same fingerprint, one paper row max — test-pinned). Resolved paper outcomes immutable (regression suites green).

---

## 6. Frozen-data before/after comparison (live DB, read-only)

Frozen cut: pre-change rows = `createdAt < 2026-10-15T19:14:00Z` (dev-server restart boundary; the dev hot-reload quirk — scheduler interval held the old module closure — required the established `relaunch-dev.py` restart).

| Metric | BEFORE (36 rows @ preflight) | AFTER (41 rows) | Δ explanation |
|---|---|---|---|
| Total evaluations | 36 | 41 | +5 = scheduler cadence (3 pre-restart old-code: 19:02/19:07/19:12; 2 new-code: 19:16/19:21) — not a change effect |
| Distinct setups (non-null fingerprint) | 1 (`730259ec…`) | 1 (`730259ec…`) | unchanged |
| Paper outcomes | 0 | 0 | unchanged |
| Pre-change rows' `inputSnapshot.rules` | `null` (all 36) | `null` (all 39 pre-change rows byte-unchanged) | no rewrite, no backfill |
| New rows' rules | — | snapshot present, values = live config, `symbol.digits = 3` (broker-metadata) | NEW persisted metadata (the objective) |
| Setup identity (same live setup BOS/bearish@4144.821) | `730259ec7b3616e6…` | `730259ec7b3616e6…` — **identical across the code change** (18:52→19:21 rows) | 10.3-A identity byte-unchanged, LIVE-proven |
| Dataset fingerprint (same decision candle, new code) | — | `d9397d66b0` at 19:16 == `d9397d66b0` at 19:21 | deterministic under new code |
| Input fingerprints | unique per evaluation (live quote in payload — by design, pre-existing) | same behaviour | `inputFingerprint` uniqueness is pre-existing engine semantics, not a change |
| Entry/SL/TP/R:R values | 0 SETUP evaluations ever → no levels exist | same | n/a (honest) |
| Phase 10.2 forward verdict inputs | IN_PROGRESS, 0/20 counted, 89.88d remaining | IN_PROGRESS, 0/20, 89.88d | unchanged |
| Phase 10.2 protocol files | byte-identical to `8d94a00` | byte-identical to `8d94a00` | unchanged |
| Four execution locks | locked | locked (no `TRADING_*`/`EXECUTION_*` keys) | unchanged |
| Paper scheduler | running (5-min cadence) | running through the whole phase (rows at 19:16/19:21 prove post-restart resume) | never stopped |

**Calculation-value guarantee:** `core.ts`, `rules.ts`, `types.ts`, `config.ts` are byte-identical to `277c98b` (git-diff 0) — the evaluation/fingerprint/level math is literally the same code; the 25 engine tests + 19 identity + 28 chronology + 39 display + 20 protocol tests all pass unchanged. The snapshot is built in the PERSISTENCE layer, outside `evaluateSignal`, and is not part of any fingerprint payload.

**Stop conditions:** none — every difference is the intended new persisted/displayed metadata or scheduler cadence.

---

## 7. Validation results

| Check | Result |
|---|---|
| New test file (`tests/signal/rules-snapshot.test.ts`) | **41/41 pass** |
| Full suite | **444/444 pass** (403 baseline + 41 new), 22→23 files, 1,764 expect() calls |
| ESLint (`bun run lint`) | clean |
| TypeScript app (`tsc --noEmit`) | 0 errors |
| TypeScript bridge (`mini-services/mt5-bridge`) | 0 errors |
| Migration/schema validation | no migration this phase; `schema.prisma` byte-identical to `277c98b`; `db:push`-managed posture unchanged |
| Protocol fingerprint | `git diff 8d94a00 -- paper-protocol.ts core.ts rules.ts types.ts config.ts` → 0; only `schema.prisma` differs vs 8d94a00 by the two 10.3-A columns (pre-committed in `8173751`) |
| Execution-lock audit | all four locked (env has no execution keys → fail-closed defaults) |
| Bridge / dev health | `:3031` 200, `:3000` 200 |
| `dev.log` since restart | 0 errors (no exceptions, no secrets) |
| Browser E2E desktop 1280×800 | signal tab: identity card (5 cells incl. setup fingerprint `730259ec7b3616e6…`, symbol), **rule manifest PRESENT** (v1, hash `e446cb407e69…`, entries `signal.maxBarsSinceBreak = 8 bars`, `symbol.digits = 3 digits` with ব্রোকার-মেটাডেটা source), recent-evaluations card (41 evaluations · 1 distinct setup; 18 legacy rows flagged "নিয়ম-রেকর্ড নেই"); validation tab: three-count strip (41 / 1 / 0) + Phase 10.2 pre-registered card intact; 0 page errors; screenshots `audit/phase10.3d-{signal,validation}-desktop.png` |
| Browser E2E mobile 390×844 | no horizontal overflow (`scrollWidth === 390` on signal + validation tabs); manifest list scrolls inside its bounded region; footer pushed naturally on long content (`gapBelowFooter = 0`, footer bottom = viewport bottom); screenshots `audit/phase10.3d-{signal,manifest,validation,signal-mobile-bottom}-*.png` |
| `bun run build` | **NOT run** (sandbox rule) — not claimed |

---

## 8. Test-first RED/GREEN evidence

**RED (before implementation):** `bun test tests/signal/rules-snapshot.test.ts` → `0 pass / 1 fail / 1 error — Cannot find module '@/lib/signal/rules-snapshot'` (the whole file is blocked by the missing module — the maximal RED state).

**GREEN (after implementation):** 41/41; full suite 444/444.

Coverage matrix (user-mandated minimum):

| Required case | Test |
|---|---|
| Complete valid snapshot | 'complete valid snapshot: 24 manifest entries…' |
| Missing optional rule | 'missing rule entry (dropped from manifest) → invalid' (RULE_MISSING via hash+completeness) |
| Missing required snapshot version | 'missing required snapshot version → invalid' (VERSION_MISSING) |
| Unknown rule value | 'unknown rule id → invalid' + 'wrong value type…' (VALUE_TYPE_INVALID) |
| Null vs absent field | legacy rules:null → not-recorded; key ABSENT → not-recorded; null input → not-recorded; null-where-number → NON_FINITE_VALUE |
| Invalid timestamp | unknown top-level field (injected `capturedAtUtc`) → UNKNOWN_FIELD (snapshot design contains no timestamps — documented) |
| NaN and Infinity rejection | build: NaN/Infinity → ok:false; parse: JSON-null survivor → NON_FINITE_VALUE |
| Stable canonical serialization | key-order pinned (top-level + entry) |
| Deterministic repeated construction | byte-identical JSON + identical hash; changed value/digits → different hash |
| Verified / derived / unavailable provenance | all four sources asserted (verified-configuration, strategy-constant, broker-metadata, unavailable [digits=null]) |
| No secret fields | serialized output key-pattern scan |
| Historical snapshot not recomputed | stored 99/3.5/8.8.8/2-digit snapshot read back verbatim (not current config) |
| New evaluation persists actual rules | values match the passed rules object + digits |
| Historical records remain readable | legacy row → getLatest works, not-recorded |
| Legacy null snapshots remain null | re-read byte-identical, DB value unchanged |
| Migration additive | no migration (documented; schema byte-identical) |
| Invalid snapshot handled safely | diagnostic persisted, verdict BLOCKED intact, row saved |
| Repeated reads don't mutate | two reads byte-identical |
| Duplicate setup follows 10.3-A | two rows, same setupFingerprint, both snapshot-present |
| Resolved paper outcomes immutable | paper suites (17+28+20 tests) green — regression |
| Setup identity & 10.2 aggregation unchanged | setup-identity (19) + paper-protocol (20) + forward-paper (8) green — regression |
| Dashboard: valid snapshot renders | E2E desktop (manifest with live values) + lib-level present-state |
| Dashboard: legacy clearly labelled | E2E: 18 legacy rows flagged in recent list; lib-level not-recorded (latest-eval amber card branch: lib-tested; see residual R1) |
| Dashboard: unknown ≠ passed | manifest shows values + "নিয়ম = চালু থাকা কনফিগারেশন; পাস/ফেল অবস্থা কারণ-কোডে" note; no green/pass indicator on rules |
| Price formatter reused | levels/evidence/quote rendering untouched (10.3-C components still used — regression suite 39 green) |
| WAIT/NO_SETUP/block states render | outcome badges + reason codes (pre-existing) — E2E verified NO_SETUP with STRUCTURE_BREAK_TOO_OLD |
| Missing market evidence not fabricated | '—' placeholders retained (pre-existing pattern, E2E) |
| Mobile readability | 390×390 no overflow; IDs break-all + tooltips; manifest scrolls in bounded region |
| No execution controls | read-only interface unchanged; no approve/execute/submit anywhere |

---

## 9. Commit

- Message: `feat: persist evaluation rules and improve signal observability`
- Phase 10.3-D commit: the SINGLE local commit directly on top of parent `277c98b` containing this report (see `git log --oneline -2`; SHA reported in the session log/worklog stage summary). LOCAL ONLY — never pushed.
- Diff review: only the 8 files in §5.1 changed; protocol files byte-identical to `8d94a00`; 10.3-A/B/C files byte-identical to `277c98b`; four locks locked; secret-pattern scan over the diff: 0 hits (no tokens/credentials — the snapshot contains only the 24 documented rule values).

---

## 10. Residual risks & untested paths

| # | Risk | Status |
|---|---|---|
| R1 | The latest-evaluation amber "not recorded" card is lib-tested + the equivalent state is live-proven in the recent-evaluations list (18 legacy rows flagged), but the specific latest-eval card branch is currently not live-exercised because the newest evaluation already carries a snapshot. It renders the moment a pre-10.3-D row is again the latest (impossible going forward) — i.e. only visible historically; branch covered by parseRulesSnapshot tests + conditional rendering. | disclosed |
| R2 | The `invalid`-snapshot dashboard state is test-proven (diagnostic write path + parse) but cannot appear in production unless a row is corrupted or a future format version is read by an older reader — fail-closed by design. | disclosed |
| R3 | 0 SETUP evaluations ever → the levels + expiry + paper paths of the new observability UI remain live-unexercised (same honest limit as 10.3-A/B/C; proven by 41 new tests + 444 suite instead). | disclosed |
| R4 | `getSignalEvaluationCounts` uses `groupBy` over all rows for the symbol — unbounded growth would eventually need an index; at research scale (dozens of rows) this is trivial. Counts return `null` (displayed '—') on DB error, never a fabricated 0. | disclosed |
| R5 | The rules snapshot records the rules in force; it is NOT proof any rule passed, that the strategy is profitable, or that the data was broker-verified beyond the recorded digits provenance. The UI states this explicitly next to the manifest. | disclosed |
| R6 | If `SIGNAL_*` env overrides are ever set, new snapshots record the overridden values (source stays 'verified-configuration' — the config layer is the verification boundary); historical rows keep their own stored values regardless. | disclosed |
| R7 | Dev-server hot reload does not refresh the scheduler's module closure — the established `relaunch-dev.py` restart was used (same procedure as 10.3-A); production builds are unaffected. | disclosed |

**No order execution was added.** The system remains analysis/signal/paper-only: no order-submission endpoint exists anywhere, all four execution locks are locked, and the interface stays read-only (no approve/execute/submit controls).

**Paper-scheduler safety:** never stopped; resumed post-restart (live rows at 19:16 and 19:21 prove it); 0 paper rows ever written by this phase; Phase 10.2 protocol and verdict inputs byte-identical.
