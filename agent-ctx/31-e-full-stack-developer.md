# Task 31-e — full-stack-developer — Candidate research surface in the UI

(Task record for the orchestrator; the authoritative append-only project log is
`worklog.md` → section "Task ID: 31-e".)

## Scope
Frontend-only: surface the live research candidate (`hybrid-multimodel-research/11.0.0-candidate.1`,
activated in Phase 11-E / Task 31-c) in the trading terminal, clearly labeled
গবেষণা (research), never mixed with the baseline. Backend untouched.

## Files
- `src/lib/dashboard/types.ts` — additive candidate types (`CandidateLatestView`,
  `CandidateEvaluationView`, `CandidateLevelsView`, `CandidatePaperStatsView`,
  `CandidateModelEvidenceView`) + `SignalLatestResponse.candidate` + optional
  history fields (`strategy`, `strategyVersion`, `note`, `decisionCandleTimeUtc`, `model`, `direction`).
- `src/lib/dashboard/i18n.ts` — 8 new candidate reason codes (MODEL_CONFLICT,
  PULLBACK_CONTEXT_NOT_ALIGNED, PULLBACK_NO_TOUCH, PULLBACK_TOO_DEEP,
  M5_CONFIRMATION_PENDING, RANGE_NOT_DETECTED, RANGE_SWEEP_PENDING,
  RANGE_RECLAIM_PENDING) + `candidateModelBn` + `paperConclusionBn`.
- `src/lib/dashboard/candidate-display.ts` (NEW) — pure paper-strip helpers
  (`bnDigits`, `candidatePaperFloorLineBn`, `candidatePaperResolvedLineBn`,
  `paperConclusionLabelBn`, `buildCandidatePaperStrip`).
- `src/components/terminal/CandidateSignalCard.tsx` (NEW) — the research card
  (outcome/meta/levels incl. invalidationLevel/model badge/reason chips/paper
  strip/honest states; data-testid `candidate-signal-card`).
- `src/components/terminal/DashboardView.tsx` — card under baseline SignalCard (mobile).
- `src/app/page.tsx` — card in desktop right rail (compact) + candidate-history
  fetch (`?strategy=candidate`, limit 20) in the 30s refresh loop (index 11).
- `src/components/terminal/HistoryView.tsx` — collapsible "ক্যান্ডিডেট ইতিহাস"
  section (`candidate-history-card`, 48px toggle) + FIXED two stale strings that
  claimed the candidate is "অফলাইন — লাইভ মূল্যায়ন/পেপার ট্র্যাকিংয়ে সংযুক্ত নয়"
  (factually wrong since 31-c activation).
- `tests/ui/reason-code-i18n.test.ts` — extended with a Phase 11-E describe
  block (exported WAIT/NO_SETUP class lists fully mapped; per-code honesty
  wording). Existing Phase 13 assertions untouched.
- `tests/ui/candidate-display.test.ts` (NEW) — 12 tests for the pure helpers.

## Gates
- tsc --noEmit: 0 errors. eslint: 0 problems.
- bun test: 657/657 pass (641 pre-existing incl. 31-d's 8 live-candle tests
  + 16 new), 0 fail, 39 files.
- Live: page 200; candidate block verified via curl (WAIT [HTF_H1_OPPOSITE,
  EMA_TREND_OPPOSITE, RANGE_NOT_DETECTED], paperStats 0/20 INCOMPLETE);
  candidate history 7 rows; dev.log clean; browser E2E desktop+mobile
  (card visible both layouts, no horizontal overflow, no console/page errors).

## Notes for the next agent
- The candidate card's Bengali numerals (০/২০ etc.) come from `bnDigits` —
  keep mono price values Western-digit (unchanged convention).
- The API contract shapes live in `src/lib/dashboard/types.ts` (view types only).
- Do not add the candidate to the baseline `signal` card or merge the two
  history lists — protocol §4 isolation is test-pinned backend-side.
