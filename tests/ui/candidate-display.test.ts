/**
 * PHASE 11-E FOCUSED TESTS (Task 31-e) — candidate card display helpers.
 *
 * The CandidateSignalCard renders research-only forward-paper data from
 * /api/signal/latest → candidate.paperStats. All display strings are built
 * by the PURE helpers in src/lib/dashboard/candidate-display.ts so the
 * honesty contract is testable without React:
 *
 *   · No fabricated counts — every line derives from the payload only.
 *   · The pre-registered 20-outcome sample floor is always stated
 *     (phase11-candidate-forward/1) — no performance claim below it.
 *   · Unknown verdict conclusions get an honest fallback label, never a
 *     silently wrong Bengali rendering.
 */
import { describe, expect, test } from 'bun:test';
import {
  bnDigits,
  buildCandidatePaperStrip,
  candidatePaperFloorLineBn,
  candidatePaperResolvedLineBn,
  paperConclusionLabelBn,
} from '@/lib/dashboard/candidate-display';
import type { CandidatePaperStatsView } from '@/lib/dashboard/types';

function paperStatsFixture(overrides?: Partial<CandidatePaperStatsView>): CandidatePaperStatsView {
  return {
    total: 7,
    open: 3,
    resolved: { stopped: 1, targeted: 2, invalidated: 0, expired: 1 },
    completedOutcomes: 4,
    unobservableExpired: 0,
    netPnlPrice: 1.23,
    sumR: 2.5,
    verdict: {
      conclusion: 'INCOMPLETE',
      reasons: ['in progress'],
      protocolId: 'phase11-candidate-forward/1',
      disclaimer: 'research only',
    },
    stopCondition: { triggered: false, reason: null },
    protocol: {
      id: 'phase11-candidate-forward/1',
      candidateVersion: 'hybrid-multimodel-research/11.0.0-candidate.1',
      activatedAtUtc: '2026-10-20T15:00:00Z',
      deadlineUtc: '2027-01-18T15:00:00.000Z',
      windowDays: 90,
      minCompleted: 20,
    },
    ...overrides,
  };
}

describe('bnDigits — Bengali digit rendering', () => {
  test('converts Western digits to Bengali digits', () => {
    expect(bnDigits(0)).toBe('০');
    expect(bnDigits(9)).toBe('৯');
    expect(bnDigits(20)).toBe('২০');
    expect(bnDigits('123')).toBe('১২৩');
  });

  test('leaves non-digit characters untouched', () => {
    expect(bnDigits('A12C')).toBe('A১২C');
  });
});

describe('candidatePaperFloorLineBn — the pre-registered sample floor', () => {
  test('below the floor: states the floor explicitly (no performance claim)', () => {
    const line = candidatePaperFloorLineBn(0, 20);
    expect(line).toContain('০/২০');
    expect(line).toContain('২০টি সম্পূর্ণ ফলাফল লাগবে');
    expect(candidatePaperFloorLineBn(19, 20)).toContain('১৯/২০');
  });

  test('at or above the floor: says the floor is met (never claims profit)', () => {
    const line = candidatePaperFloorLineBn(20, 20);
    expect(line).toContain('২০/২০');
    expect(line).toContain('নমুনা-সীমা পূরণ হয়েছে');
    expect(candidatePaperFloorLineBn(31, 20)).toContain('৩১/২০');
  });
});

describe('candidatePaperResolvedLineBn — resolved outcome breakdown', () => {
  test('sums the four resolution kinds with Bengali labels', () => {
    expect(candidatePaperResolvedLineBn({ stopped: 1, targeted: 2, invalidated: 0, expired: 1 })).toBe(
      'নিষ্পন্ন ৪ — SL ১ · টার্গেট ২ · বাতিল ০ · মেয়াদোত্তীর্ণ ১',
    );
  });

  test('all-zero resolution is honest zero, not omitted', () => {
    expect(candidatePaperResolvedLineBn({ stopped: 0, targeted: 0, invalidated: 0, expired: 0 })).toBe(
      'নিষ্পন্ন ০ — SL ০ · টার্গেট ০ · বাতিল ০ · মেয়াদোত্তীর্ণ ০',
    );
  });
});

describe('paperConclusionLabelBn — verdict conclusion labels', () => {
  test('maps every pre-registered conclusion to a Bengali label', () => {
    expect(paperConclusionLabelBn('INCOMPLETE')).toContain('অসম্পূর্ণ');
    expect(paperConclusionLabelBn('INCOMPLETE_TIMEOUT')).toContain('সময়সীমা');
    expect(paperConclusionLabelBn('NEGATIVE_AFTER_COSTS')).toContain('নেতিবাচক');
    expect(paperConclusionLabelBn('INCONCLUSIVE_CONCENTRATION')).toContain('অনির্ণেয়');
    expect(paperConclusionLabelBn('INCONCLUSIVE_DRAWDOWN')).toContain('অনির্ণেয়');
    expect(paperConclusionLabelBn('CONTINUE_FORWARD_RESEARCH')).toContain('ফরোয়ার্ড');
  });

  test('unknown conclusion gets an honest fallback that keeps the raw code visible', () => {
    const label = paperConclusionLabelBn('SOMETHING_NEW');
    expect(label).toContain('SOMETHING_NEW');
    expect(label).toContain('অজানা');
  });
});

describe('buildCandidatePaperStrip — the full strip projection', () => {
  test('total === 0 renders the honest empty state (nothing tracked yet) plus the floor line', () => {
    const strip = buildCandidatePaperStrip(paperStatsFixture({
      total: 0,
      open: 0,
      resolved: { stopped: 0, targeted: 0, invalidated: 0, expired: 0 },
      completedOutcomes: 0,
      netPnlPrice: null,
      sumR: null,
    }));
    expect(strip.isEmpty).toBe(true);
    expect(strip.emptyLine).toContain('কোনো ক্যান্ডিডেট পেপার-সারি খোলা হয়নি');
    expect(strip.floorLine).toContain('০/২০');
  });

  test('populated stats produce counts/resolved/floor lines and the INCOMPLETE label', () => {
    const strip = buildCandidatePaperStrip(paperStatsFixture());
    expect(strip.isEmpty).toBe(false);
    expect(strip.countsLine).toBe('মোট ৭ সারি · চলমান ৩ · নিষ্পন্ন ৪');
    expect(strip.resolvedLine).toBe('নিষ্পন্ন ৪ — SL ১ · টার্গেট ২ · বাতিল ০ · মেয়াদোত্তীর্ণ ১');
    expect(strip.floorLine).toContain('৪/২০');
    expect(strip.conclusionLabel).toContain('অসম্পূর্ণ');
    expect(strip.unobservableLine).toBeNull();
    expect(strip.stopLine).toBeNull();
  });

  test('unobservable expired rows are disclosed only when they exist', () => {
    const strip = buildCandidatePaperStrip(paperStatsFixture({ unobservableExpired: 2 }));
    expect(strip.unobservableLine).toContain('২টি');
    expect(strip.unobservableLine).toContain('বানানো হয় না');
  });

  test('a triggered protocol stop condition surfaces as an alert line with its reason', () => {
    const strip = buildCandidatePaperStrip(
      paperStatsFixture({ stopCondition: { triggered: true, reason: '8 consecutive losses' } }),
    );
    expect(strip.stopLine).toContain('স্টপ-শর্ত');
    expect(strip.stopLine).toContain('8 consecutive losses');
  });
});
