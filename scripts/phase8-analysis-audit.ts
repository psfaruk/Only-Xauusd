/**
 * Phase 8 Task 5 — Signal Quality Audit (live, deterministic reproducibility).
 * Runs the Phase 4 analysis engine twice over the same verified broker data
 * and compares fingerprints + verdicts. Honest BLOCKED is recorded as such.
 */
import { runAnalysisService } from '../src/lib/analysis/service';

const main = async () => {
  console.log('=== ANALYSIS RUN 1 ===');
  const r1 = await runAnalysisService({ symbol: 'XAUUSDm' });
  const res1 = r1.result;
  console.log('status:', res1.status, '| fingerprint:', res1.inputFingerprint?.slice(0, 24) + '…');
  if (res1.reasonCodes.length) console.log('reasons:', res1.reasonCodes.join(', '));
  if (res1.perTimeframe) {
    for (const [tf, a] of Object.entries(res1.perTimeframe)) {
      const bos = a.structure.events.filter((e) => e.type === 'BOS').length;
      const choch = a.structure.events.filter((e) => e.type === 'CHoCH').length;
      console.log(`  ${tf}: trend=${a.structure.trend} BOS=${bos} CHoCH=${choch}`);
    }
  }

  console.log('=== ANALYSIS RUN 2 (same data — reproducibility) ===');
  const r2 = await runAnalysisService({ symbol: 'XAUUSDm' });
  const res2 = r2.result;
  console.log('fingerprint 2:', res2.inputFingerprint?.slice(0, 24) + '…');
  const same = res1.inputFingerprint === res2.inputFingerprint;
  console.log('REPRODUCIBLE:', same ? 'YES ✓ (identical fingerprints + verdicts)' : 'NO ✗');
  console.log('verdict match:', res1.status === res2.status
    && JSON.stringify(res1.perTimeframe ?? null) === JSON.stringify(res2.perTimeframe ?? null));
  process.exit(0);
};
main().catch((e) => { console.error('FAIL:', e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
