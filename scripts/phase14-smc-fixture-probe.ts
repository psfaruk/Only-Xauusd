/**
 * Phase 14 fixture probe — verifies the hand-crafted ICT/SMC golden-path
 * candle series against every agent before the numbers are baked into
 * tests/ict/confluence.test.ts. Run: bun run scripts/phase14-smc-fixture-probe.ts
 */

import { evaluateSmcConfluence } from '@/lib/signal/ict/confluence';
import { defaultSmcSessionConfig } from '@/lib/signal/ict/sessions';
import type { SmcAgentParams } from '@/lib/signal/ict/types';
import type { AnalysisCandle } from '@/lib/analysis/types';

function candle(i: number, o: number, h: number, l: number, c: number, t: number): AnalysisCandle {
  return {
    timeUtcSec: t + i * 300,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: null,
    openText: String(o),
    highText: String(h),
    lowText: String(l),
    closeText: String(c),
  };
}

/** 2025-01-15 (Wed) 06:15:00 UTC — decision bar lands 08:00 UTC (padded grid). */
const T0 = Date.UTC(2025, 0, 15, 6, 15) / 1000 - 56 * 300;

function buildSeries(): AnalysisCandle[] {
  const rows: Array<[number, number, number, number]> = [];
  // 7 net-flat 8-candle zigzag cycles 2650↔2658 (span-3.0 candles) —
  // pads the window past the 60-bar minimum while creating the EQH/EQL
  // clusters (swing highs 2658.5, swing lows 2649.5).
  let base = 2650.0;
  for (let cycle = 0; cycle < 7; cycle++) {
    for (let k = 0; k < 4; k++) {
      rows.push([base, base + 2.5, base - 0.5, base + 2.0]); // up
      base += 2.0;
    }
    for (let k = 0; k < 4; k++) {
      rows.push([base, base + 0.5, base - 2.5, base - 2.0]); // dn
      base -= 2.0;
    }
  }
  // base back at 2650.0 — the verified ICT tail (same absolute geometry).
  rows.push(
    [2650.0, 2652.5, 2649.5, 2652.0], // 56 up
    [2652.0, 2654.5, 2651.5, 2654.0], // 57 up
    [2654.0, 2656.5, 2653.5, 2656.0], // 58 up
    [2656.0, 2656.5, 2651.5, 2654.0], // 59 dn
    [2654.0, 2657.0, 2653.5, 2655.5], // 60 up (small)
    [2655.5, 2656.0, 2651.5, 2653.5], // 61 dn (small)
    [2653.5, 2654.0, 2647.5, 2653.0], // 62 SWEEP: pierces 2649.5, closes back above
    [2653.0, 2657.5, 2652.5, 2657.0], // 63 DISP up (body 4)
    [2657.0, 2661.5, 2656.5, 2661.0], // 64 DISP up (body 4) — BOS > 2658.5
    [2661.0, 2665.5, 2660.5, 2665.0], // 65 DISP up (body 4) — FVG [2657.5, 2660.5]
    [2665.0, 2665.5, 2660.5, 2661.0], // 66 RETR dn (body 4)
    [2661.0, 2662.1, 2659.6, 2661.6], // 67 DECISION: bullish rejection-wick pin
  );
  return rows.map(([o, h, l, c], i) => candle(i, o, h, l, c, T0));
}

const params: SmcAgentParams = {
  swingLeft: 3,
  swingRight: 3,
  maxBarsSinceEvent: 20,
  sweepLookbackBars: 30,
  maxBarsSinceSweep: 8,
  equalLevelAtrTol: 0.25,
  obMinDisplacementAtr: 1.0,
  fvgMinGapAtr: 0.2,
  entryToleranceAtr: 0.35,
  slAtrBuffer: 0.35,
  poiMaxTests: 3,
  session: defaultSmcSessionConfig(),
  displacementAtr: 1.0,
  amdLookbackBars: 40,
  amdMinRangeAtr: 2.0,
  minScore: 55,
  directionMargin: 10,
  roundNumberStep: 5,
  keyLevelTolAtr: 0.3,
};

const candles = buildSeries();
const nowUtcSec = T0 + 68 * 300; // 08:15 UTC Wednesday — London killzone, no news window

const result = evaluateSmcConfluence({
  candles,
  tfSec: 300,
  digits: 2,
  nowUtcSec,
  params,
  indicatorPeriods: { emaFastPeriod: 9, emaSlowPeriod: 21, rsiPeriod: 14, atrPeriod: 14 },
  newsBlackoutEnabled: true,
});

const e = result.evidence;
console.log('=== SESSION ===', e.session.active, 'kz:', e.session.killzone, 'news:', e.session.newsBlackout);
console.log('=== STRUCTURE ===', e.structure.trend, 'event:', e.structure.lastEvent?.type, e.structure.lastEvent?.direction, 'barsSince:', e.structure.barsSinceEvent, 'zone:', e.structure.zone);
console.log('=== LIQUIDITY ===');
console.log('  sweeps:', e.liquidity.sweeps.map((s) => `${s.direction} ${s.origin}@${s.levelText} wick=${s.wickBeyond} barsAgo=${s.barsAgo}`));
console.log('  pools:', e.liquidity.pools.map((p) => `${p.side} ${p.origin}@${p.levelText}`));
console.log('  nearestBuy:', e.liquidity.nearestBuySide, 'nearestSell:', e.liquidity.nearestSellSide);
console.log('=== POI ===');
console.log('  zones:', e.poi.zones.map((z) => `${z.kind} [${z.bottomText},${z.topText}] fresh=${z.fresh} tested=${z.timesTested} active=${z.active}`));
console.log('  nearestBullish:', e.poi.nearestBullish ? `${e.poi.nearestBullish.kind} [${e.poi.nearestBullish.bottomText},${e.poi.nearestBullish.topText}] fresh=${e.poi.nearestBullish.fresh}` : null);
console.log('  nearestBearish:', e.poi.nearestBearish ? `${e.poi.nearestBearish.kind}` : null);
console.log('=== KEY LEVELS ===');
console.log('  above:', e.keyLevels.nearestAbove ? `${e.keyLevels.nearestAbove.kind}@${e.keyLevels.nearestAbove.levelText} (${e.keyLevels.nearestAbove.labelEn})` : null);
console.log('  below:', e.keyLevels.nearestBelow ? `${e.keyLevels.nearestBelow.kind}@${e.keyLevels.nearestBelow.levelText}` : null);
console.log('  all:', e.keyLevels.levels.map((l) => `${l.kind}@${l.levelText}`).join(' | '));
console.log('=== PRICE ACTION ===', e.priceAction.decisionPattern ? `${e.priceAction.decisionPattern.kind} strength=${e.priceAction.decisionPattern.strength}` : 'none');
console.log('=== MOMENTUM ===', 'score:', e.momentum.score, 'ema:', e.momentum.emaAligned, 'rsi:', e.momentum.rsi, 'atr:', e.momentum.atr, 'regime:', e.momentum.atrRegime, 'disp:', e.momentum.displacementStrength);
console.log('=== AMD ===', e.amd.phase, e.amd.signature, e.amd.signatureDirection, `range [${e.amd.rangeLow},${e.amd.rangeHigh}]`);
console.log('=== VERDICT ===');
console.log('  direction:', e.direction, 'score:', e.totalScore, 'tier:', e.tier, 'actionable:', result.actionable, 'vetoes:', e.vetoes);
for (const v of e.votes) console.log(`  ${v.agent}: ${v.score}/${v.weight} (${v.vote}) — ${v.reasonEn}`);

// News-blackout variant: same series evaluated at 13:00 UTC Wednesday.
const blackoutNow = Date.UTC(2025, 0, 15, 13, 0) / 1000;
const blackout = evaluateSmcConfluence({
  candles,
  tfSec: 300,
  digits: 2,
  nowUtcSec: blackoutNow,
  params,
  indicatorPeriods: { emaFastPeriod: 9, emaSlowPeriod: 21, rsiPeriod: 14, atrPeriod: 14 },
  newsBlackoutEnabled: true,
});
console.log('=== BLACKOUT VARIANT (13:00 UTC) ===');
console.log('  direction:', blackout.evidence.direction, 'score:', blackout.evidence.totalScore, 'actionable:', blackout.actionable, 'vetoes:', blackout.evidence.vetoes);
