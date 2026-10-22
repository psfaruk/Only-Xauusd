/**
 * PHASE 5 — BOOTRAP RESAMPLING TESTS (Task 42-S3).
 * ----------------------------------------------------------------------------
 * MOCK DISCLOSURE: synthetic R-multiple lists — never real trade data.
 *
 * Pins:
 *   · determinism — same (samples, iterations, seed) → identical output
 *   · different seed → a different (still valid) band — the seed is the ONLY
 *     free parameter
 *   · degenerate inputs: constant list → a point band; 1 sample → the value;
 *     empty → all nulls; non-finite dropped + disclosed
 *   · band ordering p05 ≤ median ≤ p95 and exact frozen values (probe-frozen)
 *   · the band is a resampling of the FIXED list — widening with smaller
 *     samples is visible (20-trade list vs the 10-sample symmetric list)
 */

import { describe, expect, test } from 'bun:test';
import { bootstrapR } from '@/lib/backtest/bootstrap';

describe('bootstrapR — determinism', () => {
  test('identical inputs → identical output (JSON byte-identical)', () => {
    const samples = [1.9, 1.8, -1, -1, 1.7, -1, -1, 1.85, -1, 2.0, -1, 1.6, -1, -1, 1.75, -1, 1.95, -1, 1.5, -1];
    const a = bootstrapR(samples, 1000, 42);
    const b = bootstrapR(samples, 1000, 42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('a different seed produces a different, still valid band', () => {
    const samples = [1.9, 1.8, -1, -1, 1.7, -1, -1, 1.85, -1, 2.0, -1, 1.6, -1, -1, 1.75, -1, 1.95, -1, 1.5, -1];
    const a = bootstrapR(samples, 1000, 42);
    const b = bootstrapR(samples, 1000, 7);
    expect(b.p05ExpectancyR).not.toBe(a.p05ExpectancyR);
    expect(b.medianExpectancyR).not.toBe(a.medianExpectancyR);
    // frozen probe values (seed 7): p05 −0.2825, p95 0.6925, median 0.24
    expect(b.p05ExpectancyR).toBeCloseTo(-0.2825, 6);
    expect(b.p95ExpectancyR).toBeCloseTo(0.6925, 6);
    expect(b.medianExpectancyR).toBeCloseTo(0.24, 6);
  });
});

describe('bootstrapR — exact frozen values (seed 42, 1000 iterations)', () => {
  test('constant list → a point band (all statistics equal the constant)', () => {
    const r = bootstrapR([2, 2, 2, 2], 1000, 42);
    expect(r.expectancyR).toBeCloseTo(2, 9);
    expect(r.medianExpectancyR).toBeCloseTo(2, 9);
    expect(r.p05ExpectancyR).toBeCloseTo(2, 9);
    expect(r.p95ExpectancyR).toBeCloseTo(2, 9);
  });

  test('symmetric ±1 list (n=10) → median 0, p05 −0.4, p95 0.6', () => {
    const r = bootstrapR([1, -1, 1, -1, 1, -1, 1, -1, 1, -1], 1000, 42);
    expect(r.expectancyR).toBeCloseTo(0, 9);
    expect(r.medianExpectancyR).toBeCloseTo(0, 9);
    expect(r.p05ExpectancyR).toBeCloseTo(-0.4, 6);
    expect(r.p95ExpectancyR).toBeCloseTo(0.6, 6);
    expect(r.p05ExpectancyR!).toBeLessThanOrEqual(r.medianExpectancyR!);
    expect(r.medianExpectancyR!).toBeLessThanOrEqual(r.p95ExpectancyR!);
  });

  test('20-trade mixed list → mean 0.2525, median 0.255, p05 −0.275, p95 0.7875', () => {
    const trades = [1.9, 1.8, -1, -1, 1.7, -1, -1, 1.85, -1, 2.0, -1, 1.6, -1, -1, 1.75, -1, 1.95, -1, 1.5, -1];
    const r = bootstrapR(trades, 1000, 42);
    expect(r.samples).toBe(20);
    expect(r.expectancyR).toBeCloseTo(0.2525, 6);
    expect(r.medianExpectancyR).toBeCloseTo(0.255, 6);
    expect(r.p05ExpectancyR).toBeCloseTo(-0.275, 6);
    expect(r.p95ExpectancyR).toBeCloseTo(0.7875, 6);
    // the honest headline: a p05 BELOW ZERO — a "positive expectancy" sample
    // still contains a plausible world where it is negative
    expect(r.p05ExpectancyR!).toBeLessThan(0);
    expect(r.p95ExpectancyR!).toBeGreaterThan(0);
  });
});

describe('bootstrapR — degenerate + malformed inputs (fail-closed)', () => {
  test('empty list → all statistics null', () => {
    const r = bootstrapR([], 500, 42);
    expect(r.samples).toBe(0);
    expect(r.expectancyR).toBeNull();
    expect(r.medianExpectancyR).toBeNull();
    expect(r.p05ExpectancyR).toBeNull();
    expect(r.p95ExpectancyR).toBeNull();
  });

  test('a single sample → every resample equals the value (band cannot be narrower)', () => {
    const r = bootstrapR([0.33], 500, 42);
    expect(r.samples).toBe(1);
    expect(r.expectancyR).toBeCloseTo(0.33, 9);
    expect(r.medianExpectancyR).toBeCloseTo(0.33, 9);
    expect(r.p05ExpectancyR).toBeCloseTo(0.33, 9);
    expect(r.p95ExpectancyR).toBeCloseTo(0.33, 9);
  });

  test('non-finite entries are dropped, counted and disclosed', () => {
    const r = bootstrapR([1, Number.NaN, 2, Number.POSITIVE_INFINITY], 500, 42);
    expect(r.samples).toBe(2);
    expect(r.dropped).toBe(2);
    expect(r.medianExpectancyR).toBeCloseTo(1.5, 9); // mean of [1, 2] resamples
  });

  test('the honesty note is always present (Bengali)', () => {
    for (const r of [bootstrapR([], 10, 1), bootstrapR([1], 10, 1)]) {
      expect(r.note.length).toBeGreaterThan(10);
    }
  });
});
