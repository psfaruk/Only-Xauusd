/**
 * XAUUSD AI Trading Agent — Bootstrap Resampling Utility (Phase 5, Task 42-S3)
 * ----------------------------------------------------------------------------
 * PURE + DETERMINISTIC. No DB, no clock, no network. Same inputs → same
 * outputs, always (a seeded PRNG — mulberry32 — drives the resampling).
 *
 * Purpose: honest uncertainty for backtest expectancy. A mean over N trades
 * has sampling error; a bootstrap distribution of resampled means gives a
 * median + p05/p95 band for the expectancy in R. Small samples produce WIDE
 * bands — that width is the honesty, not a defect.
 *
 * Method (locked + documented):
 *   · input: per-trade R-multiples (net of modeled costs — the same numbers
 *     the reports already use); non-finite entries are dropped and counted.
 *   · for each of `iterations` runs: draw N samples WITH replacement
 *     (N = valid sample count), compute the arithmetic mean (expectancy in R).
 *   · summarize the resampled-mean distribution: median, p05, p95 —
 *     nearest-rank percentiles on the ascending sort: idx = ceil(p/100·n) − 1
 *     (clamped to [0, n−1]). Deterministic, no interpolation.
 *   · degenerate cases: 0 valid samples → all nulls; 1 valid sample → every
 *     resample equals that value (median = p05 = p95 = the value — honest,
 *     the band cannot be narrower than the data).
 *
 * This is a descriptive resampling of a FIXED trade list — it does not create
 * information that is not in the sample and it is NOT a promise about the
 * future (see the uncertainty notes that ship with every surfaced result).
 */

/** Deterministic PRNG — mulberry32 (32-bit seed). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapExpectancy {
  /** Resampling iterations performed. */
  iterations: number;
  /** Valid (finite) samples used. */
  samples: number;
  /** Dropped non-finite inputs (disclosed, never silently ignored). */
  dropped: number;
  /** Point estimate: the arithmetic mean of the source samples (R). */
  expectancyR: number | null;
  /** Median of the bootstrap distribution of the mean (R). */
  medianExpectancyR: number | null;
  /** 5th percentile (nearest-rank) — pessimistic band edge (R). */
  p05ExpectancyR: number | null;
  /** 95th percentile (nearest-rank) — optimistic band edge (R). */
  p95ExpectancyR: number | null;
  /** Honest label rendered next to every surfaced result. */
  note: string;
}

/** Nearest-rank percentile over an ASCENDING-sorted array. */
function nearestRank(sorted: number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  const idx = Math.min(Math.max(0, Math.ceil((p / 100) * sorted.length) - 1), sorted.length - 1);
  return sorted[idx];
}

/**
 * Bootstrap the distribution of the MEAN (expectancy in R) over a fixed list
 * of per-trade R-multiples. Deterministic for a given (samples, iterations,
 * seed) triple — pinned by tests/backtest/bootstrap.test.ts.
 */
export function bootstrapR(
  samples: number[],
  iterations = 1000,
  seed = 42,
): BootstrapExpectancy {
  const valid = samples.filter((v) => Number.isFinite(v));
  const dropped = samples.length - valid.length;
  const note =
    'বুটস্ট্র্যাপ ব্যান্ড নির্দিষ্ট ট্রেড-তালিকার পুনঃনমুনায়ন মাত্র — ভবিষ্যতের প্রতিশ্রুতি নয়; নমুনা যত ছোট, ব্যান্ড তত চওড়া।';

  if (valid.length === 0) {
    return {
      iterations,
      samples: 0,
      dropped,
      expectancyR: null,
      medianExpectancyR: null,
      p05ExpectancyR: null,
      p95ExpectancyR: null,
      note,
    };
  }

  const n = valid.length;
  const mean = valid.reduce((s, v) => s + v, 0) / n;
  const rand = mulberry32(seed);
  const means = new Array<number>(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += valid[Math.floor(rand() * n)];
    }
    means[it] = sum / n;
  }
  const sorted = [...means].sort((a, b) => a - b);

  return {
    iterations,
    samples: n,
    dropped,
    expectancyR: Number(mean.toFixed(6)),
    medianExpectancyR: Number(nearestRank(sorted, 50).toFixed(6)),
    p05ExpectancyR: Number(nearestRank(sorted, 5).toFixed(6)),
    p95ExpectancyR: Number(nearestRank(sorted, 95).toFixed(6)),
    note,
  };
}
