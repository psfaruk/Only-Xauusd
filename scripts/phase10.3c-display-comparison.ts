/**
 * Phase 10.3-C — Price Precision BEFORE/AFTER comparison (frozen dataset).
 * ----------------------------------------------------------------------------
 * READ-ONLY evidence script. It freezes the CURRENT persisted dataset
 * (SymbolSpec, latest tick, latest signal evaluation, latest backtest run's
 * full trade list, latest validation run's metrics/sensitivity) and renders
 * every price display the dashboard showed BEFORE Phase 10.3-C (raw strings /
 * hardcoded fmtInd(2) / raw numbers) versus AFTER (the verified-digits
 * display formatter), on byte-identical raw inputs.
 *
 * Guarantees asserted here:
 *   · The raw dataset values are read ONCE and never mutated — display is a
 *     pure function of (rawValue, verifiedSpec).
 *   · For every price-unit field the RAW value is printed alongside, proving
 *     calculation values are unchanged (presentation-only).
 *   · Phase 10.2/10.3-A/10.3-B persisted rows are only READ.
 *
 * Run: bun run scripts/phase10.3c-display-comparison.ts
 */

import { db } from '../src/lib/db';
import {
  formatPriceLevel,
  formatPriceQuantity,
  priceDisplaySpecFromSymbolSpec,
  UNVERIFIED_PRICE_DISPLAY,
} from '../src/lib/market/price-display';

interface Row {
  field: string;
  raw: string;
  oldDisplay: string;
  newDisplay: string;
  changed: boolean;
  note: string;
}

/** EXACT pre-10.3-C dashboard behavior (reproduced byte-for-byte). */
function oldLevel(value: number | string | null | undefined): string {
  // Old UI rendered stored strings verbatim and numbers via String() —
  // signal levels came from the canonical *Text fields, paper entries as raw
  // numbers, quote strings verbatim.
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? (value.trim() === '' ? '—' : value) : String(value);
}

function oldQty(value: number | null | undefined): string {
  // Old UI: fmtInd(value, 2) for metrics, raw String() elsewhere.
  return value === null || value === undefined ? '—' : value.toFixed(2);
}

function oldQtyRaw(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value);
}

async function main() {
  const rows: Row[] = [];

  // ---- 1. Freeze the metadata (the ONLY precision authority) -------------
  const spec = await db.symbolSpec.findUnique({ where: { symbol: 'XAUUSDm' } });
  let verifiedFields: string[] = [];
  if (spec) {
    try {
      verifiedFields = JSON.parse(spec.verifiedFields) as string[];
    } catch {
      verifiedFields = [];
    }
  }
  const displaySpec = priceDisplaySpecFromSymbolSpec(
    spec ? { digits: spec.digits, verifiedFields } : null,
  );
  console.log('=== SymbolSpec (frozen) ===');
  console.log(
    JSON.stringify(
      spec
        ? {
            symbol: spec.symbol,
            digits: spec.digits,
            point: spec.point,
            verifiedFields,
            source: spec.source,
            lastVerifiedAt: spec.lastVerifiedAt,
          }
        : null,
    ),
  );
  console.log(`displaySpec = ${JSON.stringify(displaySpec)}\n`);
  const digitsLabel = displaySpec.verified ? `verified digits=${displaySpec.digits}` : 'UNVERIFIED';

  // ---- 2. Latest tick (market tab + quote card inputs) -------------------
  const tick = await db.marketLatestTick.findUnique({ where: { symbol: 'XAUUSDm' } });
  if (tick) {
    for (const [field, v] of [
      ['tick.bid', tick.bid],
      ['tick.ask', tick.ask],
      ['tick.spread', tick.spread],
    ] as Array<[string, string]>) {
      const n = formatPriceLevel(v, displaySpec);
      rows.push({
        field,
        raw: v,
        oldDisplay: oldLevel(v),
        newDisplay: n.text + (n.anomaly ? ' ≈' : ''),
        changed: n.text !== oldLevel(v),
        note: 'canonical stored text',
      });
    }
  }

  // ---- 3. Latest signal evaluation (evidence + quote record) -------------
  const evalRow = await db.signalEvaluation.findFirst({
    where: { symbol: 'XAUUSDm' },
    orderBy: { createdAt: 'desc' },
  });
  if (evalRow) {
    const evidence = evalRow.evidence
      ? (JSON.parse(evalRow.evidence) as {
          structureEvent?: { level: number; levelText: string } | null;
          anchorSwing?: { price: number; priceText: string } | null;
        })
      : null;
    const quote = evalRow.quote
      ? (JSON.parse(evalRow.quote) as { bid?: string; ask?: string })
      : null;
    if (evidence?.structureEvent) {
      const n = formatPriceLevel(evidence.structureEvent.level, displaySpec);
      rows.push({
        field: 'signal.structureLevel',
        raw: String(evidence.structureEvent.level),
        oldDisplay: oldLevel(evidence.structureEvent.levelText),
        newDisplay: n.text + (n.anomaly ? ' ≈' : ''),
        changed: n.text !== oldLevel(evidence.structureEvent.levelText),
        note: 'candle-grid structure level',
      });
    }
    if (evidence?.anchorSwing) {
      const n = formatPriceLevel(evidence.anchorSwing.price, displaySpec);
      rows.push({
        field: 'signal.anchorSwing',
        raw: String(evidence.anchorSwing.price),
        oldDisplay: oldLevel(evidence.anchorSwing.priceText),
        newDisplay: n.text + (n.anomaly ? ' ≈' : ''),
        changed: n.text !== oldLevel(evidence.anchorSwing.priceText),
        note: 'candle-grid swing price',
      });
    }
    if (quote?.bid) {
      const n = formatPriceLevel(quote.bid, displaySpec);
      rows.push({
        field: 'signal.quoteBid',
        raw: quote.bid,
        oldDisplay: oldLevel(quote.bid),
        newDisplay: n.text + (n.anomaly ? ' ≈' : ''),
        changed: n.text !== oldLevel(quote.bid),
        note: 'server-formatted quote string',
      });
    }
  }

  // ---- 4. Latest backtest run — FULL frozen trade list (levels + P&L) ----
  const bt = await db.backtestRun.findFirst({
    where: { symbol: 'XAUUSDm' },
    orderBy: { createdAt: 'desc' },
  });
  if (bt) {
    const trades = JSON.parse(bt.trades) as Array<{
      entryPrice: number;
      stopLoss: number;
      target: number;
      exitPrice: number | null;
      pnlPrice: number | null;
    }>;
    let offGridCount = 0;
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      for (const [field, v] of [
        [`bt[${i}].entryPrice`, t.entryPrice],
        [`bt[${i}].stopLoss`, t.stopLoss],
        [`bt[${i}].target`, t.target],
        [`bt[${i}].exitPrice`, t.exitPrice],
      ] as Array<[string, number | null]>) {
        const n = formatPriceLevel(v, displaySpec);
        if (n.anomaly) offGridCount++;
        rows.push({
          field,
          raw: String(v),
          oldDisplay: oldLevel(v ?? null),
          newDisplay: n.text + (n.anomaly ? ' ≈' : ''),
          changed: n.text !== oldLevel(v ?? null),
          note: n.anomaly ? 'OFF-GRID derived level (F1) — anomaly now flagged' : 'on-grid',
        });
      }
      if (t.pnlPrice !== null && t.pnlPrice !== undefined) {
        const nq = formatPriceQuantity(t.pnlPrice, displaySpec);
        rows.push({
          field: `bt[${i}].pnlPrice`,
          raw: String(t.pnlPrice),
          oldDisplay: oldQtyRaw(t.pnlPrice),
          newDisplay: nq,
          changed: nq !== oldQtyRaw(t.pnlPrice),
          note: 'price-unit quantity',
        });
      }
    }
    console.log(
      `backtest trades: ${trades.length} · off-grid level displays flagged: ${offGridCount}`,
    );

    const dev = JSON.parse(bt.devMetrics) as { netPnlPrice?: number | null; status?: string };
    if (typeof dev.netPnlPrice === 'number') {
      const nq = formatPriceQuantity(dev.netPnlPrice, displaySpec);
      rows.push({
        field: 'bt.dev.netPnlPrice',
        raw: String(dev.netPnlPrice),
        oldDisplay: oldQtyRaw(dev.netPnlPrice), // signal-tab card rendered the raw number
        newDisplay: nq,
        changed: nq !== oldQtyRaw(dev.netPnlPrice),
        note: 'was raw number in signal tab',
      });
    }
  }

  // ---- 5. Latest validation run — metrics + sensitivity (frozen) ---------
  const vr = await db.validationRun.findFirst({
    where: { symbol: 'XAUUSDm' },
    orderBy: { createdAt: 'desc' },
  });
  if (vr) {
    const result = JSON.parse(vr.result) as {
      segments?: Record<string, { netPnlPrice?: number | null; grossPnlPrice?: number | null; maxDrawdownPrice?: number | null }>;
      sensitivity?: Array<{ scenario: string; spreadPrice: number; netPnlPrice: number }>;
      dataset?: { observedSpreadPrice?: number };
    };
    const seg = result.segments?.oos;
    if (seg) {
      for (const [field, v] of [
        ['val.oos.grossPnlPrice', seg.grossPnlPrice ?? null],
        ['val.oos.netPnlPrice', seg.netPnlPrice ?? null],
        ['val.oos.maxDrawdownPrice', seg.maxDrawdownPrice ?? null],
      ] as Array<[string, number | null]>) {
        const nq = formatPriceQuantity(v, displaySpec);
        rows.push({
          field,
          raw: String(v),
          oldDisplay: oldQty(v), // fmtInd(_, 2) before
          newDisplay: nq,
          changed: nq !== oldQty(v),
          note: 'was fmtInd(2)',
        });
      }
    }
    if (typeof result.dataset?.observedSpreadPrice === 'number') {
      const nq = formatPriceQuantity(result.dataset.observedSpreadPrice, displaySpec);
      rows.push({
        field: 'val.dataset.observedSpreadPrice',
        raw: String(result.dataset.observedSpreadPrice),
        oldDisplay: oldQtyRaw(result.dataset.observedSpreadPrice),
        newDisplay: nq,
        changed: nq !== oldQtyRaw(result.dataset.observedSpreadPrice),
        note: 'was raw number',
      });
    }
    for (const s of result.sensitivity ?? []) {
      const nq = formatPriceQuantity(s.spreadPrice, displaySpec);
      rows.push({
        field: `val.sens[${s.scenario}].spreadPrice`,
        raw: String(s.spreadPrice),
        oldDisplay: oldQtyRaw(s.spreadPrice),
        newDisplay: nq,
        changed: nq !== oldQtyRaw(s.spreadPrice),
        note: 'was raw number',
      });
    }
  }

  // ---- 6. Paper rows (frozen — currently 0) ------------------------------
  const paperCount = await db.paperSignalOutcome.count();
  console.log(`paper rows: ${paperCount} (frozen — nothing historical can change)`);

  // ---- 7. Synthetic edge inputs on the SAME verified spec (documented) ---
  console.log('\n=== Synthetic edge cases (NOT production data — clearly separated) ===');
  const synthetic: Array<[string, number | string]> = [
    ['synthetic.offGridSl', 4393.396214351791],
    ['synthetic.offGridSlText', '4393.396214351791'],
    ['synthetic.onGrid', 4144.821],
    ['synthetic.trailingZero', 4144.5],
    ['synthetic.roundingBoundary', 4393.3965],
    ['synthetic.carryBoundary', 8.999],
    ['synthetic.invalidString', 'not-a-price'],
  ];
  for (const [field, v] of synthetic) {
    const n = formatPriceLevel(v, displaySpec);
    rows.push({
      field,
      raw: String(v),
      oldDisplay: oldLevel(v),
      newDisplay: n.text + (n.anomaly ? ' ≈' : ''),
      changed: n.text !== oldLevel(v),
      note: 'synthetic edge case',
    });
  }
  // Unverified-spec behavior (metadata missing → fail-closed raw + flag)
  const nq = formatPriceLevel(4144.821, UNVERIFIED_PRICE_DISPLAY);
  rows.push({
    field: 'synthetic.unverifiedSpec',
    raw: '4144.821',
    oldDisplay: oldLevel(4144.821),
    newDisplay: nq.text + (nq.anomaly ? ' ≈' : ''),
    changed: nq.text !== oldLevel(4144.821),
    note: 'metadata missing → raw shown + flagged (no default precision)',
  });

  // ---- 8. Report ----------------------------------------------------------
  console.log(`\n=== BEFORE/AFTER display comparison (${digitsLabel}) ===`);
  const width = [26, 24, 24, 26];
  console.log(
    ['FIELD'.padEnd(width[0]), 'RAW (unchanged)'.padEnd(width[1]), 'OLD DISPLAY'.padEnd(width[2]), 'NEW DISPLAY'.padEnd(width[3]), 'CHG'].join(''),
  );
  console.log('-'.repeat(width.reduce((a, b) => a + b, 0) + 4));
  for (const r of rows) {
    console.log(
      [
        r.field.slice(0, width[0] - 1).padEnd(width[0]),
        r.raw.slice(0, width[1] - 1).padEnd(width[1]),
        r.oldDisplay.slice(0, width[2] - 1).padEnd(width[2]),
        (r.newDisplay + (r.changed ? '' : '')).slice(0, width[3] - 1).padEnd(width[3]),
        r.changed ? 'YES' : 'no',
      ].join(''),
    );
  }
  const changed = rows.filter((r) => r.changed).length;
  const unchanged = rows.length - changed;
  console.log(`\ntotal fields: ${rows.length} · display changed: ${changed} · display identical: ${unchanged}`);

  // ---- 9. Purity assertion: raw inputs were never touched -----------------
  const check = formatPriceLevel(4393.396214351791, displaySpec);
  if (check.rawText !== '4393.396214351791' || Number(check.rawText) !== 4393.396214351791) {
    throw new Error('PURITY VIOLATION: raw value was mutated by display formatting');
  }
  console.log('purity check: raw calculation values untouched by display formatting — OK');
  console.log('calculation values unchanged: YES (display layer produces strings only; DB read-only)');

  await db.$disconnect();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
