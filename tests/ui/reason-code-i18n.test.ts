/**
 * PHASE 13 FOCUSED TESTS — reason-code Bengali coverage.
 *
 * Defect background: the live dashboard showed honest WAIT verdicts with the
 * reason code rendered as "অজানা সমস্যা (HTF_H4_OPPOSITE)" because most
 * engine reason codes had no bnErrorText mapping. To the user this read like
 * a SYSTEM FAILURE while the engine was actually working correctly — a key
 * contributor to the "no signal in 48 hours, something is broken" report.
 *
 * Guarantee: every uppercase reason code that the deterministic engine can
 * emit (src/lib/signal/conditions.ts, plus the outcome enum) must have a
 * Bengali rendering, and the mapping must be honest (WAIT-family codes say
 * so — they are healthy strategy verdicts, not errors).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bnErrorText } from '@/lib/dashboard/i18n';

const conditionsSrc = readFileSync(
  join(process.cwd(), 'src/lib/signal/conditions.ts'),
  'utf8',
);

/** Extract SCREAMING_SNAKE reason codes from the engine source. */
const engineCodes = new Set(
  [...conditionsSrc.matchAll(/'([A-Z][A-Z0-9_]{4,})'/g)].map((m) => m[1]),
);

// Outcome enum values (also surfaced through bnForCode in toasts/cards).
const outcomeCodes = ['BUY_SETUP', 'SELL_SETUP', 'WAIT', 'NO_SETUP', 'BLOCKED', 'FAILED'];

describe('Phase 13 — reason-code Bengali coverage', () => {
  test('the engine source scan actually found codes (guard against a moved file)', () => {
    expect(engineCodes.size).toBeGreaterThanOrEqual(20);
  });

  test('every engine reason code has a Bengali rendering (no "অজানা সমস্যা" for known codes)', () => {
    const missing: string[] = [];
    for (const code of engineCodes) {
      if (!(code in bnErrorText)) missing.push(code);
    }
    for (const code of outcomeCodes) {
      if (!(code in bnErrorText)) missing.push(code);
    }
    expect(missing).toEqual([]);
  });

  test('WAIT-family codes explicitly say this is a normal strategy verdict, not an error', () => {
    const waitFamily = [
      'HTF_H4_OPPOSITE',
      'HTF_H1_OPPOSITE',
      'RETEST_PENDING',
      'ZONE_INVALIDATED',
      'STRUCTURE_BREAK_TOO_OLD',
      'NO_STRUCTURE_BREAK',
      'PRICE_BEYOND_ENTRY_ZONE',
    ];
    for (const code of waitFamily) {
      const text = bnErrorText[code] ?? '';
      expect(text.length).toBeGreaterThan(5);
      expect(text).toContain('স্বাভাবিক');
    }
  });

  test('the live-observed codes (48h window analysis) are all mapped', () => {
    // Codes observed in the actual runtime DB during the Phase 13 audit.
    const observed = ['RETEST_PENDING', 'HTF_H1_OPPOSITE', 'ZONE_INVALIDATED', 'STRUCTURE_BREAK_TOO_OLD', 'HTF_H4_OPPOSITE'];
    for (const code of observed) expect(bnErrorText[code]).toBeTruthy();
  });
});
