/**
 * Phase 8 Task 3 — H4 broker history depth probe (read-only, live).
 * Asks the bridge for the largest bounded H4 window and reports the ACTUAL
 * earliest bar the broker serves — the honest H4 coverage limitation.
 */
import { bridgeClient } from '../src/lib/market/bridge-client';

const main = async () => {
  const res = await bridgeClient.getCandles({ symbol: 'XAUUSDm', timeframe: 'H4', limit: 2000 });
  if (!res.ok) {
    console.log('BRIDGE ERROR:', res.error.code, res.error.message);
    process.exit(1);
  }
  const bars = res.data.bars;
  const closed = bars.filter((b) => b.f !== 1);
  console.log(`H4 probe: requested 2000, received ${bars.length} (${closed.length} closed + ${bars.length - closed.length} forming)`);
  console.log(`earliest broker bar: ${new Date(bars[0].t * 1000).toISOString()}`);
  console.log(`latest bar:          ${new Date(bars[bars.length - 1].t * 1000).toISOString()}`);
  console.log(`span days:           ${((bars[bars.length - 1].t - bars[0].t) / 86400).toFixed(1)}`);
  // gaps check inside the broker-served window
  let gaps = 0, weekendGaps = 0;
  for (let i = 1; i < bars.length; i++) {
    const dt = bars[i].t - bars[i - 1].t;
    if (dt > 14400) {
      const day = new Date(bars[i - 1].t * 1000).getUTCDay();
      if (day === 5 || day === 6 || day === 0) weekendGaps++;
      else gaps++;
    }
  }
  console.log(`intra-window gaps > 4h: ${gaps} suspicious, ${weekendGaps} weekend-expected`);
  process.exit(0);
};
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
