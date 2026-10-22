/**
 * PHASE 5 — SAMPLE ADEQUACY LABEL TESTS (Task 42-S3).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic counts — never real trade data.
 *
 * Pins:
 *   · thresholds: < 30 → INSUFFICIENT_EVIDENCE; 30–99 → PRELIMINARY; ≥ 100 →
 *     ADEQUATE (boundaries 29/30/99/100 each pinned exactly)
 *   · malformed counts (negative, NaN) → INSUFFICIENT_EVIDENCE
 *   · every level carries a non-empty Bengali uncertainty note
 *   · the report block is built from (tradeCount, dataRange) purely
 */

import { describe, expect, test } from 'bun:test';
import {
  buildSampleAdequacyReport,
  SAMPLE_ADEQUACY_NOTES,
  sampleAdequacyFromTradeCount,
} from '@/lib/backtest/sample-adequacy';

describe('sampleAdequacyFromTradeCount — thresholds', () => {
  test('0 / 1 / 29 → INSUFFICIENT_EVIDENCE', () => {
    expect(sampleAdequacyFromTradeCount(0)).toBe('INSUFFICIENT_EVIDENCE');
    expect(sampleAdequacyFromTradeCount(1)).toBe('INSUFFICIENT_EVIDENCE');
    expect(sampleAdequacyFromTradeCount(29)).toBe('INSUFFICIENT_EVIDENCE');
  });
  test('30 / 99 → PRELIMINARY (boundaries exact)', () => {
    expect(sampleAdequacyFromTradeCount(30)).toBe('PRELIMINARY');
    expect(sampleAdequacyFromTradeCount(99)).toBe('PRELIMINARY');
  });
  test('100 / 500 → ADEQUATE', () => {
    expect(sampleAdequacyFromTradeCount(100)).toBe('ADEQUATE');
    expect(sampleAdequacyFromTradeCount(500)).toBe('ADEQUATE');
  });
  test('negative / NaN → INSUFFICIENT_EVIDENCE (never a crash)', () => {
    expect(sampleAdequacyFromTradeCount(-5)).toBe('INSUFFICIENT_EVIDENCE');
    expect(sampleAdequacyFromTradeCount(Number.NaN)).toBe('INSUFFICIENT_EVIDENCE');
  });
});

describe('SAMPLE_ADEQUACY_NOTES — every level carries a Bengali uncertainty note', () => {
  test('INSUFFICIENT_EVIDENCE note says small sample is not proof', () => {
    expect(SAMPLE_ADEQUACY_NOTES.INSUFFICIENT_EVIDENCE).toContain('নমুনা ছোট');
    expect(SAMPLE_ADEQUACY_NOTES.INSUFFICIENT_EVIDENCE).toContain('প্রমাণ নয়');
  });
  test('PRELIMINARY and ADEQUATE notes exist and differ', () => {
    expect(SAMPLE_ADEQUACY_NOTES.PRELIMINARY.length).toBeGreaterThan(10);
    expect(SAMPLE_ADEQUACY_NOTES.ADEQUATE.length).toBeGreaterThan(10);
    expect(SAMPLE_ADEQUACY_NOTES.PRELIMINARY).not.toBe(SAMPLE_ADEQUACY_NOTES.ADEQUATE);
  });
});

describe('buildSampleAdequacyReport — pure block construction', () => {
  test('carries the label, the count, the note and the data range', () => {
    const r = buildSampleAdequacyReport(12, { fromUtc: '2026-10-01T00:00:00.000Z', toUtc: '2026-10-14T00:00:00.000Z' });
    expect(r.sampleAdequacy).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.tradeCount).toBe(12);
    expect(r.uncertaintyNote).toBe(SAMPLE_ADEQUACY_NOTES.INSUFFICIENT_EVIDENCE);
    expect(r.dataRangeUtc).toEqual({ fromUtc: '2026-10-01T00:00:00.000Z', toUtc: '2026-10-14T00:00:00.000Z' });
  });
  test('a null data range stays null (never fabricated)', () => {
    const r = buildSampleAdequacyReport(150, null);
    expect(r.sampleAdequacy).toBe('ADEQUATE');
    expect(r.dataRangeUtc).toBeNull();
  });
});
