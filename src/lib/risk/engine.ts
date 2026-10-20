/**
 * XAUUSD AI Trading Agent — Deterministic Risk Engine (Phase 7)
 * ----------------------------------------------------------------------------
 * PURE position-sizing + limit gate. No DB, no network, no clock:
 *   · every input arrives via RiskCheckInput (caller-supplied numbers),
 *   · every threshold comes from the clamped `config.risk` section,
 *   · evaluatedAtUtc is PASSED IN (service/tool layer owns the clock),
 *   · the LLM never computes or overrides any value here.
 *
 * Rules (each produces { rule, passed, detail }; ALL must pass):
 *   1. EQUITY_AVAILABLE      — equity present, finite and ≥ RISK_MIN_EQUITY
 *   2. STOP_DISTANCE_VALID   — |entry − SL| > 0, finite, direction-consistent
 *                              (BUY: SL < entry < TP; SELL: TP < entry < SL)
 *   3. LOT_SIZE_COMPUTABLE   — riskAmount = equity × pct/100;
 *                              rawLot = riskAmount / (stopDistance × tickValuePerLot);
 *                              lot = floor to RISK_LOT_STEP; PASS iff lot ≥ RISK_MIN_LOTS;
 *                              capped at RISK_MAX_LOTS (capping noted, still PASS)
 *   4. LOT_WITHIN_CAP        — final lot ≤ RISK_MAX_LOTS (explicit audit rule;
 *                              always true after the cap — kept for honesty)
 *   5. SPREAD_WITHIN_LIMIT   — spread finite and ≤ RISK_MAX_SPREAD_PRICE
 *   6. EXPOSURE_LIMIT        — existingOpenPositions < RISK_MAX_OPEN_POSITIONS
 *   7. PENDING_APPROVAL_LIMIT— existingPendingApprovals < RISK_MAX_PENDING_APPROVALS
 *   8. DAILY_ORDER_LIMIT     — sameSetupApprovedToday < RISK_MAX_ORDERS_PER_DAY
 *   9. DUPLICATE_PROTECTION  — sameSetupApprovedToday === 0
 *
 * A RiskCheckResult is an ANALYSIS artifact: it cannot place, modify or
 * approve any order. Missing data (equity, tick value, spread) FAILS the
 * corresponding check honestly — never a guessed number.
 */

import { config } from '@/lib/config';
import type { RiskCheckDetail, RiskCheckInput, RiskCheckResult } from './types';

/** Number formatting for detail strings — deterministic, no locale drift. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  // Up to 4 decimals, trailing zeros trimmed (0.0500 → 0.05; 4150 → 4150).
  return String(Number(n.toFixed(4)));
}

/** Floor `value` DOWN to an exact multiple of `step` (FP-safe).
 *  The 1e-9 relative epsilon absorbs binary-representation noise such as
 *  0.1 / 0.01 === 10.000000000000002 (still floors to 10) and
 *  0.09999 / 0.01 === 9.999… (floors to 9, as it genuinely should). */
function floorToStep(value: number, step: number): number {
  const steps = Math.floor(value / step + 1e-9);
  return Number((steps * step).toFixed(8));
}

/** JSON-safe snapshot of the active risk configuration (audit + API). */
export function riskConfigSnapshot() {
  const c = config.risk;
  return {
    percentPerTrade: c.percentPerTrade,
    maxLots: c.maxLots,
    minLots: c.minLots,
    maxOpenPositions: c.maxOpenPositions,
    maxPendingApprovals: c.maxPendingApprovals,
    maxOrdersPerDay: c.maxOrdersPerDay,
    maxSpreadPrice: c.maxSpreadPrice,
    minEquity: c.minEquity,
    lotStep: c.lotStep,
  };
}

/**
 * Run the deterministic risk gate. PURE: identical input → identical output,
 * no side effects, no clock reads (evaluatedAtUtc comes from the input).
 */
export function runRiskCheck(input: RiskCheckInput): RiskCheckResult {
  const cfg = config.risk;
  const checks: RiskCheckDetail[] = [];

  // ---- shared state computed by the early checks ------------------------
  let equityUsable = false;
  let levelsValid = false;
  let stopDistance: number | null = null;
  let riskAmount: number | null = null;
  let lot: number | null = null;

  // ---- 1. EQUITY_AVAILABLE ----------------------------------------------
  if (input.equity === null || !Number.isFinite(input.equity)) {
    checks.push({
      rule: 'EQUITY_AVAILABLE',
      passed: false,
      detail: 'ইকুইটি তথ্য অনুপলব্ধ — রিস্ক হিসাব fail-closed (ব্রিজ কন্ট্র্যাক্টে অ্যাকাউন্ট এন্ডপয়েন্ট নেই)।',
    });
  } else if (input.equity < cfg.minEquity) {
    checks.push({
      rule: 'EQUITY_AVAILABLE',
      passed: false,
      detail: `ইকুইটি ${fmt(input.equity)} < সর্বনিম্ন সীমা ${fmt(cfg.minEquity)}।`,
    });
  } else {
    equityUsable = true;
    checks.push({
      rule: 'EQUITY_AVAILABLE',
      passed: true,
      detail: `ইকুইটি ${fmt(input.equity)} ≥ সর্বনিম্ন সীমা ${fmt(cfg.minEquity)}।`,
    });
  }

  // ---- 2. STOP_DISTANCE_VALID --------------------------------------------
  const { entry, stopLoss, takeProfit, direction } = input;
  const levelsFinite =
    Number.isFinite(entry) && Number.isFinite(stopLoss) && Number.isFinite(takeProfit);
  const distance = levelsFinite ? Math.abs(entry - stopLoss) : Number.NaN;
  const sideOk =
    levelsFinite &&
    (direction === 'BUY'
      ? stopLoss < entry && takeProfit > entry
      : stopLoss > entry && takeProfit < entry);

  if (!levelsFinite) {
    checks.push({
      rule: 'STOP_DISTANCE_VALID',
      passed: false,
      detail: 'এন্ট্রি/SL/TP লেভেল সংখ্যা হিসেবে বৈধ নয় (finite নয়)।',
    });
  } else if (!(distance > 0)) {
    checks.push({
      rule: 'STOP_DISTANCE_VALID',
      passed: false,
      detail: `স্টপ দূরত্ব শূন্য বা ঋণাত্মক (|entry − SL| = ${fmt(distance)}) — অবৈধ।`,
    });
  } else if (!sideOk) {
    const expected =
      direction === 'BUY' ? 'BUY হলে SL < entry এবং TP > entry হতে হবে' : 'SELL হলে SL > entry এবং TP < entry হতে হবে';
    checks.push({
      rule: 'STOP_DISTANCE_VALID',
      passed: false,
      detail: `দিকের সাথে লেভেল অসঙ্গত — ${expected} (entry ${fmt(entry)}, SL ${fmt(stopLoss)}, TP ${fmt(takeProfit)})।`,
    });
  } else {
    levelsValid = true;
    stopDistance = distance;
    checks.push({
      rule: 'STOP_DISTANCE_VALID',
      passed: true,
      detail: `স্টপ দূরত্ব ${fmt(distance)} — দিকসঙ্গত (${direction}: entry ${fmt(entry)}, SL ${fmt(stopLoss)}, TP ${fmt(takeProfit)})।`,
    });
  }

  // ---- 3. LOT_SIZE_COMPUTABLE ---------------------------------------------
  if (!equityUsable || !levelsValid) {
    const why = !equityUsable ? 'ইকুইটি অনুপলব্ধ' : 'লেভেল অবৈধ';
    checks.push({
      rule: 'LOT_SIZE_COMPUTABLE',
      passed: false,
      detail: `লট গণনা করা যায়নি — ${why} (fail-closed)।`,
    });
  } else if (input.tickValuePerLot === null || !Number.isFinite(input.tickValuePerLot) || input.tickValuePerLot <= 0) {
    checks.push({
      rule: 'LOT_SIZE_COMPUTABLE',
      passed: false,
      detail: 'tickValuePerLot অনুপলব্ধ বা অবৈধ (≤ 0) — লট গণনা অসম্ভব (fail-closed)।',
    });
  } else {
    riskAmount = (input.equity as number) * (cfg.percentPerTrade / 100);
    const denom = (stopDistance as number) * input.tickValuePerLot;
    const rawLot = riskAmount / denom;
    const floored = floorToStep(rawLot, cfg.lotStep);
    if (!(floored >= cfg.minLots) || floored <= 0) {
      checks.push({
        rule: 'LOT_SIZE_COMPUTABLE',
        passed: false,
        detail: `গণনাকৃত লট ${fmt(floored)} < সর্বনিম্ন লট ${fmt(cfg.minLots)} (riskAmount ${fmt(riskAmount)}, স্টপ দূরত্ব ${fmt(stopDistance as number)}, rawLot ${fmt(rawLot)}) — গ্রহণযোগ্য নয়।`,
      });
    } else if (floored > cfg.maxLots) {
      lot = cfg.maxLots;
      checks.push({
        rule: 'LOT_SIZE_COMPUTABLE',
        passed: true,
        detail: `গণনাকৃত লট ${fmt(floored)} সর্বোচ্চ সীমা ${fmt(cfg.maxLots)}-এ ক্যাপ করা হলো (riskAmount ${fmt(riskAmount)}, rawLot ${fmt(rawLot)})।`,
      });
    } else {
      lot = floored;
      checks.push({
        rule: 'LOT_SIZE_COMPUTABLE',
        passed: true,
        detail: `লট ${fmt(floored)} গণনা সম্পন্ন (riskAmount ${fmt(riskAmount)} = ইকুইটির ${fmt(cfg.percentPerTrade)}%, স্টপ দূরত্ব ${fmt(stopDistance as number)})।`,
      });
    }
  }

  // ---- 4. LOT_WITHIN_CAP (explicit audit rule — always true after the cap) --
  if (lot === null) {
    checks.push({
      rule: 'LOT_WITHIN_CAP',
      passed: false,
      detail: 'লট গণনা হয়নি — ক্যাপ যাচাই করা যায়নি (fail-closed)।',
    });
  } else {
    checks.push({
      rule: 'LOT_WITHIN_CAP',
      passed: lot <= cfg.maxLots,
      detail:
        lot <= cfg.maxLots
          ? `চূড়ান্ত লট ${fmt(lot)} ≤ সর্বোচ্চ সীমা ${fmt(cfg.maxLots)}।`
          : `চূড়ান্ত লট ${fmt(lot)} > সর্বোচ্চ সীমা ${fmt(cfg.maxLots)} — ক্যাপ লঙ্ঘন।`,
    });
  }

  // ---- 5. SPREAD_WITHIN_LIMIT ----------------------------------------------
  if (!Number.isFinite(input.spread) || input.spread < 0) {
    checks.push({
      rule: 'SPREAD_WITHIN_LIMIT',
      passed: false,
      detail: 'স্প্রেড তথ্য অনুপলব্ধ বা অবৈধ — গ্রহণ করা হয়নি (fail-closed)।',
    });
  } else if (input.spread > cfg.maxSpreadPrice) {
    checks.push({
      rule: 'SPREAD_WITHIN_LIMIT',
      passed: false,
      detail: `স্প্রেড ${fmt(input.spread)} > সর্বোচ্চ অনুমোদিত ${fmt(cfg.maxSpreadPrice)}।`,
    });
  } else {
    checks.push({
      rule: 'SPREAD_WITHIN_LIMIT',
      passed: true,
      detail: `স্প্রেড ${fmt(input.spread)} ≤ সর্বোচ্চ অনুমোদিত ${fmt(cfg.maxSpreadPrice)}।`,
    });
  }

  // ---- 6. EXPOSURE_LIMIT -----------------------------------------------------
  if (input.existingOpenPositions < cfg.maxOpenPositions) {
    checks.push({
      rule: 'EXPOSURE_LIMIT',
      passed: true,
      detail: `খোলা এক্সপোজার ${input.existingOpenPositions} < সর্বোচ্চ ${cfg.maxOpenPositions}।`,
    });
  } else {
    checks.push({
      rule: 'EXPOSURE_LIMIT',
      passed: false,
      detail: `খোলা এক্সপোজার ${input.existingOpenPositions} ≥ সর্বোচ্চ ${cfg.maxOpenPositions} — নতুন পজিশন নেওয়া যাবে না।`,
    });
  }

  // ---- 7. PENDING_APPROVAL_LIMIT ----------------------------------------------
  if (input.existingPendingApprovals < cfg.maxPendingApprovals) {
    checks.push({
      rule: 'PENDING_APPROVAL_LIMIT',
      passed: true,
      detail: `অপেক্ষমাণ অনুমোদন ${input.existingPendingApprovals} < সর্বোচ্চ ${cfg.maxPendingApprovals}।`,
    });
  } else {
    checks.push({
      rule: 'PENDING_APPROVAL_LIMIT',
      passed: false,
      detail: `অপেক্ষমাণ অনুমোদন ${input.existingPendingApprovals} ≥ সর্বোচ্চ ${cfg.maxPendingApprovals} — আর নয়।`,
    });
  }

  // ---- 8. DAILY_ORDER_LIMIT -----------------------------------------------------
  if (input.sameSetupApprovedToday < cfg.maxOrdersPerDay) {
    checks.push({
      rule: 'DAILY_ORDER_LIMIT',
      passed: true,
      detail: `আজকের অনুমোদিত অর্ডার ${input.sameSetupApprovedToday} < দৈনিক সীমা ${cfg.maxOrdersPerDay}।`,
    });
  } else {
    checks.push({
      rule: 'DAILY_ORDER_LIMIT',
      passed: false,
      detail: `আজকের অনুমোদিত অর্ডার ${input.sameSetupApprovedToday} ≥ দৈনিক সীমা ${cfg.maxOrdersPerDay}।`,
    });
  }

  // ---- 9. DUPLICATE_PROTECTION ----------------------------------------------------
  if (input.sameSetupApprovedToday === 0) {
    checks.push({
      rule: 'DUPLICATE_PROTECTION',
      passed: true,
      detail: 'এই সেটআপ আজ আর অনুমোদিত হয়নি — ডুপ্লিকেট নেই।',
    });
  } else {
    checks.push({
      rule: 'DUPLICATE_PROTECTION',
      passed: false,
      detail: `এই একই সেটআপ আজ ইতিমধ্যে ${input.sameSetupApprovedToday} বার অনুমোদিত — ডুপ্লিকেট সুরক্ষা নিষেধ করছে।`,
    });
  }

  const passed = checks.every((c) => c.passed);
  return {
    passed,
    // lotSize is reported whenever the computation itself succeeded
    // (checks 1–3) — even if a limit check failed, the honest number is
    // surfaced for transparency. passed=false still blocks everything.
    lotSize: lot,
    checks,
    evaluatedAtUtc: input.evaluatedAtUtc ?? '',
    accountEquity: input.equity,
    accountBalance: input.balance,
    riskAmount,
    stopDistance,
  };
}
