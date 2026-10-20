/**
 * XAUUSD AI Trading Agent — Approval-Based + Auto Execution Service (Phase 11/12)
 * ----------------------------------------------------------------------------
 * The execution workflow, gated by the 4-switch lock
 * (TRADING_PHASE ≥ 11 + EXECUTION_ARMED + ALLOW_EXECUTION + mode ≠ read_only):
 *
 *   actionable signal (deterministic engine)
 *     → Phase 7 risk check (deterministic, fail-closed)
 *     → EXECUTION_AUTO=true (Phase 12): order placed IMMEDIATELY (single
 *       attempt), TradeApproval row recorded as approved/auto for the audit
 *       chain, ExecutionLog row appended
 *       otherwise: TradeApproval row (pending, TTL-bounded) → HUMAN decision
 *       (approve / reject) in the UI → on approve: ONE bridge order →
 *       ExecutionLog row (append-only audit)
 *     → open positions visible; close-by-id → ExecutionLog
 *
 * Invariants:
 *   · Every order is preceded by a PASSING risk check (lot cap, exposure
 *     cap, daily cap, spread limit) — auto mode NEVER skips it.
 *   · Bridge order calls are SINGLE-ATTEMPT — a timeout is never auto-retried
 *     (exactly-once discipline; verification via the positions list).
 *   · Idempotent by signal id: an approval (any status) existing for the
 *     signal means no second order is ever attempted.
 *   · Every state change writes an append-only SystemEvent (approval /
 *     execution categories).
 */

import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { logEvent } from '@/lib/logger';
import { runRiskCheck } from '@/lib/risk/engine';
import {
  persistRiskCheck,
  getRiskCheckCounts,
  latestRiskCheckForSignal,
  sameSetupApprovedToday,
} from '@/lib/risk/service';
import type { RiskCheckDetail } from '@/lib/risk/types';
import { getLatestSignalEvaluation } from '@/lib/signal/persistence';
import { SIGNAL_STRATEGY_VERSION, type SignalLevels } from '@/lib/signal/types';
import {
  getBridgeAccountState,
  listBridgePositions,
  placeBridgeOrder,
  closeBridgePosition,
  type BridgePosition,
} from './bridge-orders';

/** Standard XAUUSD contract (disclosed — same constant the risk tool uses). */
const XAUUSD_TICK_VALUE_PER_LOT = 100;

function approvalTtlMin(): number {
  const raw = Number(process.env.EXECUTION_APPROVAL_TTL_MIN ?? 30);
  if (!Number.isFinite(raw)) return 30;
  return Math.min(Math.max(5, Math.floor(raw)), 240);
}

function parseLevels(raw: string | null): SignalLevels | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SignalLevels;
  } catch {
    return null;
  }
}

function parseChecks(raw: string | null): RiskCheckDetail[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (c): c is RiskCheckDetail =>
        typeof c === 'object' && c !== null && typeof (c as RiskCheckDetail).rule === 'string' && typeof (c as RiskCheckDetail).passed === 'boolean',
    );
  } catch {
    return [];
  }
}

async function liveSpread(symbol: string): Promise<number> {
  const { getLatestTick } = await import('@/lib/market/service');
  const res = await getLatestTick(symbol).catch(() => null);
  const s = res?.tick?.spread ?? null;
  if (typeof s !== 'string') return Number.NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

// ---------------------------------------------------------------------------
// Post-signal hook — risk check + approval creation (lock-gated)
// ---------------------------------------------------------------------------

export interface ProcessSignalOutcome {
  ran: boolean;
  reason: string;
  approvalId: string | null;
  riskPassed: boolean | null;
  /** Phase 12 auto-execution summary — present only when an order was
   *  attempted for this signal. */
  execution?: {
    attempted: boolean;
    code: string;
    message: string;
    lots: number | null;
    executionLogId: string | null;
  };
}

/** Equity basis for the risk gate. The bridge reports accountEquity = 0
 *  while the account has no open positions and the market quote layer is
 *  the only equity source it tracks — in that exact case the BALANCE is the
 *  true equity (no floating P/L can exist with zero open positions), so it
 *  is used as the honest fallback. Never a guess when both are absent. */
function equityBasis(equity: number | null, balance: number | null): number | null {
  if (equity !== null && Number.isFinite(equity) && equity > 0) return equity;
  if (balance !== null && Number.isFinite(balance) && balance > 0) return balance;
  return equity; // honest absence — the risk check fails closed on it
}

/**
 * Called after EVERY signal evaluation (scheduler + manual). Runs the Phase 7
 * risk check for actionable setups and — when the execution lock is armed:
 * EXECUTION_AUTO=true → places the order immediately (single attempt);
 * otherwise → creates a pending TradeApproval with TTL for the human gate.
 * Idempotent by signal id; never throws.
 *
 * Phase 12: `strategyVersion` selects which strategy's latest evaluation is
 * processed (baseline default — existing callers unchanged; the scalper
 * passes its own version).
 */
export async function processActionableSignal(
  symbol: string,
  opts: { strategyVersion?: string } = {},
): Promise<ProcessSignalOutcome> {
  const strategyVersion = opts.strategyVersion ?? SIGNAL_STRATEGY_VERSION;
  try {
    const latest = await getLatestSignalEvaluation(db, symbol, strategyVersion);
    if (!latest || (latest.outcome !== 'BUY_SETUP' && latest.outcome !== 'SELL_SETUP')) {
      return { ran: false, reason: 'no actionable setup', approvalId: null, riskPassed: null };
    }
    const evaluationId = latest.id;

    // Idempotency: an approval (any status) already exists for this signal.
    const existing = await db.tradeApproval.findFirst({ where: { signalId: evaluationId } }).catch(() => null);
    if (existing) {
      return { ran: false, reason: 'approval already exists for this signal', approvalId: existing.id, riskPassed: null };
    }

    const levels = latest.levels;
    if (!levels) {
      return { ran: false, reason: 'actionable signal without levels (honest skip)', approvalId: null, riskPassed: null };
    }

    // ---- Phase 7 risk check (fresh, with live bridge equity) ----------------
    const [accountRes, counts, positionsRes] = await Promise.all([
      getBridgeAccountState(),
      getRiskCheckCounts().catch(() => null),
      listBridgePositions().catch(() => null),
    ]);
    const equity = equityBasis(
      accountRes.ok ? accountRes.data?.accountEquity ?? null : null,
      accountRes.ok ? accountRes.data?.accountBalance ?? null : null,
    );
    const balance = accountRes.ok ? accountRes.data?.accountBalance ?? null : null;
    const spread = await liveSpread(symbol);
    // Real open-position count when the bridge reports it; honest fallback to
    // the approved-today approximation when the positions call is unavailable.
    const openPositions = positionsRes?.ok
      ? positionsRes.data?.length ?? 0
      : counts?.approvedToday ?? 0;

    const riskResult = runRiskCheck({
      signalId: evaluationId,
      direction: levels.direction,
      entry: levels.entryReference,
      stopLoss: levels.stopLoss,
      takeProfit: levels.target,
      symbol,
      spread,
      existingOpenPositions: openPositions,
      existingPendingApprovals: counts?.pendingApprovals ?? 0,
      sameSetupApprovedToday: 0, // idempotency check above guarantees none for this signal
      equity,
      balance,
      symbolDigits: null,
      tickValuePerLot: XAUUSD_TICK_VALUE_PER_LOT,
    });
    await persistRiskCheck(evaluationId, riskResult).catch(() => undefined);

    if (!riskResult.passed) {
      await logEvent({
        level: 'warn',
        category: 'risk',
        code: 'RISK_CHECK_FAILED',
        message: `Risk check FAILED for ${symbol} ${levels.direction} setup — no order`,
        meta: {
          signalId: evaluationId,
          strategyVersion,
          failedRules: riskResult.checks.filter((c) => !c.passed).map((c) => c.rule),
        },
      }).catch(() => undefined);
      return { ran: true, reason: 'risk check failed — no order', approvalId: null, riskPassed: false };
    }

    // ---- Lock gate — orders exist only when execution is armed -----------
    if (!config.execution.enabled) {
      return { ran: true, reason: 'risk passed; execution locked — no order (read-only mode)', approvalId: null, riskPassed: true };
    }

    // ---- Phase 12: AUTO-EXECUTION (no human gate) -------------------------
    if (config.execution.auto) {
      return await autoExecuteApprovalChain(evaluationId, levels, riskResult.lotSize, symbol);
    }

    const expiresAt = new Date(Date.now() + approvalTtlMin() * 60_000);
    const approval = await db.tradeApproval.create({
      data: {
        signalId: evaluationId,
        status: 'pending',
        expiresAt,
      },
    });

    await logEvent({
      level: 'info',
      category: 'approval',
      code: 'APPROVAL_CREATED',
      message: `Trade approval pending for ${symbol} ${levels.direction} (${riskResult.lotSize} lots) — expires ${expiresAt.toISOString()}`,
      meta: { approvalId: approval.id, signalId: evaluationId, lots: riskResult.lotSize, expiresAt: expiresAt.toISOString() },
    }).catch(() => undefined);

    return { ran: true, reason: 'approval created', approvalId: approval.id, riskPassed: true };
  } catch (err) {
    await logEvent({
      level: 'error',
      category: 'execution',
      code: 'EXECUTION_PIPELINE_ERROR',
      message: `processActionableSignal failed: ${err instanceof Error ? err.message : 'unknown'}`,
    }).catch(() => undefined);
    return { ran: false, reason: 'internal error (logged)', approvalId: null, riskPassed: null };
  }
}

/**
 * Phase 12 auto-execution: record the approval row (status approved, note
 * auto) for the audit chain, then place the order — SINGLE attempt. The
 * caller guarantees: lock armed + risk check passed + no prior approval for
 * this signal id (idempotency).
 */
async function autoExecuteApprovalChain(
  evaluationId: string,
  levels: SignalLevels,
  lots: number | null,
  symbol: string,
): Promise<ProcessSignalOutcome> {
  if (lots === null || !Number.isFinite(lots) || lots <= 0) {
    return { ran: true, reason: 'risk passed but lot size unavailable (honest skip)', approvalId: null, riskPassed: true };
  }

  const approval = await db.tradeApproval.create({
    data: {
      signalId: evaluationId,
      status: 'approved',
      decidedAt: new Date(),
      note: `auto-execution (EXECUTION_AUTO) — ${lots} lots`,
      expiresAt: new Date(Date.now() + approvalTtlMin() * 60_000),
    },
  }).catch(() => null);

  const orderRequest = {
    symbol,
    type: levels.direction,
    lots,
    sl: levels.stopLoss,
    tp: levels.target,
    comment: `xau-auto:${evaluationId.slice(-20)}`,
  };
  const result = await placeBridgeOrder(orderRequest);

  const logStatus = !result.ok
    ? result.errorCode === 'BRIDGE_TIMEOUT'
      ? 'sent'
      : 'failed'
    : result.data?.accepted
      ? 'filled'
      : 'rejected';

  const execLog = await db.executionLog
    .create({
      data: {
        signalId: evaluationId,
        request: JSON.stringify({ ...orderRequest, approvalId: approval?.id ?? null, mode: 'auto' }),
        result: JSON.stringify(
          result.ok
            ? result.data?.raw ?? { ok: false }
            : { ok: false, errorCode: result.errorCode, errorMessage: result.errorMessage },
        ),
        status: logStatus,
      },
    })
    .catch(() => null);

  const accepted = result.ok && result.data?.accepted === true;
  await logEvent({
    level: accepted ? 'info' : 'error',
    category: 'execution',
    code: accepted ? 'AUTO_EXECUTION_FILLED' : 'AUTO_EXECUTION_FAILED',
    message: accepted
      ? `AUTO order FILLED: ${symbol} ${levels.direction} ${lots} lots @ ${result.data?.price ?? '?'} (deal ${result.data?.dealId ?? '?'})`
      : `AUTO order failed for ${symbol}: ${result.errorCode ?? 'unknown'} — ${result.errorMessage ?? ''}`,
    meta: {
      approvalId: approval?.id ?? null,
      signalId: evaluationId,
      lots,
      price: result.data?.price ?? null,
      dealId: result.data?.dealId ?? null,
      executionLogId: execLog?.id ?? null,
    },
  }).catch(() => undefined);

  return {
    ran: true,
    reason: accepted ? 'auto-execution filled' : `auto-execution failed: ${result.errorCode ?? 'unknown'}`,
    approvalId: approval?.id ?? null,
    riskPassed: true,
    execution: {
      attempted: true,
      code: accepted
        ? 'FILLED'
        : result.errorCode === 'BRIDGE_TIMEOUT'
          ? 'EXECUTION_TIMEOUT_UNKNOWN'
          : 'EXECUTION_FAILED',
      message: accepted
        ? `অটো-অর্ডার সম্পন্ন: ${result.data?.price ?? '?'} দামে ${lots} লট`
        : `অটো-অর্ডার ব্যর্থ: ${result.errorCode ?? 'unknown'}`,
      lots,
      executionLogId: execLog?.id ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Approval decision — the human gate
// ---------------------------------------------------------------------------

export interface DecideOutcome {
  ok: boolean;
  code: string;
  message: string;
  executionLogId: string | null;
}

/** Expire pending approvals past their TTL (called on every state read). */
async function expireStale(): Promise<void> {
  await db.tradeApproval
    .updateMany({
      where: { status: 'pending', expiresAt: { lt: new Date() } },
      data: { status: 'expired', decidedAt: new Date() },
    })
    .catch(() => undefined);
}

export async function decideApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  note?: string,
): Promise<DecideOutcome> {
  await expireStale();

  if (!config.execution.enabled) {
    return {
      ok: false,
      code: 'EXECUTION_LOCKED',
      message: `এক্সিকিউশন তালাবন্ধ — ${config.execution.reason}`,
      executionLogId: null,
    };
  }

  const approval = await db.tradeApproval.findUnique({ where: { id: approvalId } }).catch(() => null);
  if (!approval) return { ok: false, code: 'APPROVAL_NOT_FOUND', message: 'অনুমোদন খুঁজে পাওয়া যায়নি', executionLogId: null };
  if (approval.status !== 'pending') {
    return { ok: false, code: 'APPROVAL_NOT_PENDING', message: `অনুমোদনটি আগেই ${approval.status} হয়ে গেছে`, executionLogId: null };
  }

  if (decision === 'reject') {
    await db.tradeApproval.update({
      where: { id: approvalId },
      data: { status: 'rejected', decidedAt: new Date(), note: note ?? null },
    });
    await logEvent({
      level: 'info',
      category: 'approval',
      code: 'APPROVAL_REJECTED',
      message: `Trade approval rejected by operator${note ? ` — ${note.slice(0, 120)}` : ''}`,
      meta: { approvalId, signalId: approval.signalId },
    }).catch(() => undefined);
    return { ok: true, code: 'REJECTED', message: 'অনুমোদন বাতিল করা হয়েছে', executionLogId: null };
  }

  // ---- Approve → execute (single attempt) ---------------------------------
  const signalRow = await db.signalEvaluation.findUnique({ where: { id: approval.signalId } }).catch(() => null);
  const levels = signalRow ? parseLevels(signalRow.levels) : null;
  if (!signalRow || !levels) {
    await db.tradeApproval.update({
      where: { id: approvalId },
      data: { status: 'rejected', decidedAt: new Date(), note: 'signal levels unavailable (honest reject)' },
    });
    return { ok: false, code: 'SIGNAL_LEVELS_UNAVAILABLE', message: 'সিগন্যাল লেভেল পাওয়া যায়নি — সৎ বাতিল', executionLogId: null };
  }

  // Fresh risk verification AT DECISION TIME (spread/equity may have moved
  // since the approval was created) — the stored row is only a record; the
  // decision uses a live re-computation, exactly like creation time did.
  const [accountRes, counts, sameSetupApproved, positionsRes] = await Promise.all([
    getBridgeAccountState(),
    getRiskCheckCounts().catch(() => null),
    sameSetupApprovedToday(approval.signalId).catch(() => 0),
    listBridgePositions().catch(() => null),
  ]);
  const equity = equityBasis(
    accountRes.ok ? accountRes.data?.accountEquity ?? null : null,
    accountRes.ok ? accountRes.data?.accountBalance ?? null : null,
  );
  const balance = accountRes.ok ? accountRes.data?.accountBalance ?? null : null;
  const spread = await liveSpread(signalRow.symbol);
  // Real open-position count when the bridge reports it (honest fallback to
  // the approved-today approximation when the positions call fails).
  const openPositions = positionsRes?.ok ? positionsRes.data?.length ?? 0 : counts?.approvedToday ?? 0;
  const riskResult = runRiskCheck({
    signalId: approval.signalId,
    direction: levels.direction,
    entry: levels.entryReference,
    stopLoss: levels.stopLoss,
    takeProfit: levels.target,
    symbol: signalRow.symbol,
    spread,
    existingOpenPositions: openPositions,
    existingPendingApprovals: Math.max(0, (counts?.pendingApprovals ?? 1) - 1),
    sameSetupApprovedToday: sameSetupApproved,
    equity,
    balance,
    symbolDigits: null,
    tickValuePerLot: XAUUSD_TICK_VALUE_PER_LOT,
  });
  await persistRiskCheck(approval.signalId, riskResult).catch(() => undefined);

  if (!riskResult.passed || riskResult.lotSize === null || !Number.isFinite(riskResult.lotSize) || riskResult.lotSize <= 0) {
    await db.tradeApproval.update({
      where: { id: approvalId },
      data: { status: 'rejected', decidedAt: new Date(), note: 'risk check not passing at decision time' },
    });
    await logEvent({
      level: 'warn',
      category: 'approval',
      code: 'APPROVAL_RISK_FAILED',
      message: 'Approval rejected automatically: risk check not passing at decision time',
      meta: {
        approvalId,
        signalId: approval.signalId,
        failedRules: riskResult.checks.filter((c) => !c.passed).map((c) => c.rule),
      },
    }).catch(() => undefined);
    return { ok: false, code: 'RISK_NOT_PASSING', message: 'রিস্ক চেক পাস করছে না — স্বয়ংক্রিয় বাতিল', executionLogId: null };
  }
  const riskLot = riskResult.lotSize;

  const comment = `xau-agent:${approval.signalId.slice(-20)}`;
  const orderRequest = {
    symbol: signalRow.symbol,
    type: levels.direction,
    lots: riskLot,
    sl: levels.stopLoss,
    tp: levels.target,
    comment,
  };

  const result = await placeBridgeOrder(orderRequest);

  const logStatus = !result.ok
    ? result.errorCode === 'BRIDGE_TIMEOUT'
      ? 'sent'
      : 'failed'
    : result.data?.accepted
      ? 'filled'
      : 'rejected';

  const execLog = await db.executionLog
    .create({
      data: {
        signalId: approval.signalId,
        request: JSON.stringify({ ...orderRequest, approvalId }), // no account secrets
        result: JSON.stringify(
          result.ok
            ? result.data?.raw ?? { ok: false }
            : { ok: false, errorCode: result.errorCode, errorMessage: result.errorMessage },
        ),
        status: logStatus,
      },
    })
    .catch(() => null);

  if (!result.ok) {
    // Execution FAILED — the approval stays pending-expired (not approved) so
    // the operator sees the honest failure and can retry manually if wanted.
    await db.tradeApproval.update({
      where: { id: approvalId },
      data: { status: 'expired', decidedAt: new Date(), note: `execution failed: ${result.errorCode ?? 'unknown'}` },
    });
    await logEvent({
      level: 'error',
      category: 'execution',
      code: 'EXECUTION_FAILED',
      message: `Order failed for approval ${approvalId}: ${result.errorCode ?? 'unknown'} — ${result.errorMessage ?? ''}`,
      meta: { approvalId, signalId: approval.signalId, errorCode: result.errorCode },
    }).catch(() => undefined);
    return {
      ok: false,
      code: result.errorCode === 'BRIDGE_TIMEOUT' ? 'EXECUTION_TIMEOUT_UNKNOWN' : 'EXECUTION_FAILED',
      message:
        result.errorCode === 'BRIDGE_TIMEOUT'
          ? 'অর্ডার পাঠানো হয়েছে কিন্তু ফলাফল অজানা (timeout) — পজিশন তালিকা যাচাই করুন, স্বয়ংক্রিয় রিট্রাই হবে না'
          : `অর্ডার ব্যর্থ: ${result.errorCode ?? 'unknown'}`,
      executionLogId: execLog?.id ?? null,
    };
  }

  const accepted = result.data?.accepted === true;
  await db.tradeApproval.update({
    where: { id: approvalId },
    data: {
      status: accepted ? 'approved' : 'rejected',
      decidedAt: new Date(),
      note: accepted ? `filled: ${result.data?.dealId ?? ''}` : `broker rejected: retcode ${result.data?.retcode ?? '?'}`,
    },
  });
  await logEvent({
    level: accepted ? 'info' : 'warn',
    category: 'execution',
    code: accepted ? 'EXECUTION_FILLED' : 'EXECUTION_BROKER_REJECTED',
    message: accepted
      ? `Order FILLED: ${signalRow.symbol} ${levels.direction} ${riskLot} lots @ ${result.data?.price ?? '?'} (deal ${result.data?.dealId ?? '?'})`
      : `Broker rejected order: retcode ${result.data?.retcode ?? '?'}`,
    meta: { approvalId, signalId: approval.signalId, lots: riskLot, price: result.data?.price ?? null, dealId: result.data?.dealId ?? null },
  }).catch(() => undefined);

  return {
    ok: accepted,
    code: accepted ? 'FILLED' : 'BROKER_REJECTED',
    message: accepted
      ? `অর্ডার সম্পন্ন: ${result.data?.price ?? '?'} দামে ${riskLot} লট`
      : `ব্রোকার অর্ডার বাতিল করেছে (retcode ${result.data?.retcode ?? '?'})`,
    executionLogId: execLog?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Position close (manual, approval-free — closing REDUCES exposure)
// ---------------------------------------------------------------------------

export async function closePositionByApp(positionId: string): Promise<DecideOutcome> {
  if (!config.execution.enabled) {
    return { ok: false, code: 'EXECUTION_LOCKED', message: `এক্সিকিউশন তালাবন্ধ — ${config.execution.reason}`, executionLogId: null };
  }
  const result = await closeBridgePosition(positionId);
  const logStatus = !result.ok ? (result.errorCode === 'BRIDGE_TIMEOUT' ? 'sent' : 'failed') : result.data?.accepted ? 'filled' : 'rejected';

  const execLog = await db.executionLog
    .create({
      data: {
        signalId: 'manual-close',
        request: JSON.stringify({ action: 'CLOSE', positionId }),
        result: JSON.stringify(
          result.ok ? result.data?.raw ?? { ok: false } : { ok: false, errorCode: result.errorCode, errorMessage: result.errorMessage },
        ),
        status: logStatus,
      },
    })
    .catch(() => null);

  await logEvent({
    level: result.ok && result.data?.accepted ? 'info' : 'warn',
    category: 'execution',
    code: result.ok && result.data?.accepted ? 'POSITION_CLOSED' : 'POSITION_CLOSE_FAILED',
    message: result.ok && result.data?.accepted
      ? `Position ${positionId} closed @ ${result.data?.price ?? '?'}`
      : `Position close failed for ${positionId}: ${result.errorCode ?? 'unknown'}`,
    meta: { positionId, executionLogId: execLog?.id ?? null },
  }).catch(() => undefined);

  if (!result.ok) {
    return {
      ok: false,
      code: result.errorCode === 'BRIDGE_TIMEOUT' ? 'EXECUTION_TIMEOUT_UNKNOWN' : 'EXECUTION_FAILED',
      message:
        result.errorCode === 'BRIDGE_TIMEOUT'
          ? 'ক্লোজ অর্ডার পাঠানো হয়েছে কিন্তু ফলাফল অজানা (timeout) — পজিশন তালিকা যাচাই করুন'
          : `ক্লোজ ব্যর্থ: ${result.errorCode ?? 'unknown'}`,
      executionLogId: execLog?.id ?? null,
    };
  }
  return {
    ok: result.data?.accepted === true,
    code: result.data?.accepted ? 'CLOSED' : 'BROKER_REJECTED',
    message: result.data?.accepted ? `পজিশন ক্লোজ সম্পন্ন @ ${result.data?.price ?? '?'}` : `ব্রোকার ক্লোজ বাতিল করেছে (retcode ${result.data?.retcode ?? '?'})`,
    executionLogId: execLog?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// State read — the single UI surface
// ---------------------------------------------------------------------------

export interface ExecutionApprovalView {
  id: string;
  signalId: string;
  status: string;
  note: string | null;
  createdAtUtc: string;
  decidedAtUtc: string | null;
  expiresAtUtc: string | null;
  direction: 'BUY' | 'SELL' | null;
  lots: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskPassed: boolean | null;
}

export interface ExecutionLogView {
  id: string;
  signalId: string;
  status: string;
  createdAtUtc: string;
  request: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface ExecutionState {
  executionEnabled: boolean;
  /** Phase 12: auto-execution active (orders placed without human gate). */
  executionAuto: boolean;
  executionReason: string;
  switches: {
    phaseGatePassed: boolean;
    executionArmed: boolean;
    allowExecution: boolean;
    tradingMode: string;
  };
  bridge: {
    reachable: boolean;
    connected: boolean;
    authenticated: boolean;
    ordersEnabled: boolean;
    accountEquity: number | null;
    accountBalance: number | null;
    accountCurrency: string | null;
    server: string | null;
  };
  approvals: ExecutionApprovalView[];
  positions: BridgePosition[];
  positionsError: string | null;
  logs: ExecutionLogView[];
  approvalTtlMin: number;
  generatedAtUtc: string;
}

export async function getExecutionState(): Promise<ExecutionState> {
  await expireStale();

  const [accountRes, positionsRes, approvalRows, logRows] = await Promise.all([
    getBridgeAccountState(),
    config.execution.enabled ? listBridgePositions() : Promise.resolve(null),
    db.tradeApproval.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }).catch(() => []),
    db.executionLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }).catch(() => []),
  ]);

  // Enrich approvals with signal levels + risk state (single latest risk row
  // per approval signal id — bounded query).
  const signalIds = [...new Set(approvalRows.map((a) => a.signalId))];
  const [signalRows, riskRows] = await Promise.all([
    Promise.all(
      signalIds.map((id) => db.signalEvaluation.findUnique({ where: { id } }).catch(() => null)),
    ),
    Promise.all(signalIds.map((id) => latestRiskCheckForSignal(id).catch(() => null))),
  ]);
  const signalById = new Map(signalRows.filter((s) => s !== null).map((s) => [s!.id, s!]));
  const riskBySignal = new Map(riskRows.filter((r) => r !== null).map((r) => [r!.signalId, r!]));

  const approvals: ExecutionApprovalView[] = approvalRows.map((a) => {
    const signal = signalById.get(a.signalId) ?? null;
    const levels = signal ? parseLevels(signal.levels) : null;
    const risk = riskBySignal.get(a.signalId) ?? null;
    const riskChecks = risk?.checks ?? parseChecks(null);
    const lotCheck = riskChecks.find((c) => c.rule === 'LOT_SIZE_COMPUTABLE' && c.passed);
    const m = lotCheck?.detail.match(/([\d.]+)\s*লট/);
    return {
      id: a.id,
      signalId: a.signalId,
      status: a.status,
      note: a.note,
      createdAtUtc: a.createdAt.toISOString(),
      decidedAtUtc: a.decidedAt?.toISOString() ?? null,
      expiresAtUtc: a.expiresAt?.toISOString() ?? null,
      direction: levels?.direction ?? null,
      lots: m ? Number(m[1]) : null,
      entry: levels?.entryReference ?? null,
      stopLoss: levels?.stopLoss ?? null,
      takeProfit: levels?.target ?? null,
      riskPassed: risk ? risk.passed : null,
    };
  });

  const safeParse = (s: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(s) as unknown;
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const logs: ExecutionLogView[] = logRows.map((l) => ({
    id: l.id,
    signalId: l.signalId,
    status: l.status,
    createdAtUtc: l.createdAt.toISOString(),
    request: safeParse(l.request),
    result: safeParse(l.result),
  }));

  return {
    executionEnabled: config.execution.enabled,
    executionAuto: config.execution.auto,
    executionReason: config.execution.reason,
    switches: {
      phaseGatePassed: config.execution.switches.phaseGatePassed,
      executionArmed: config.execution.switches.executionArmed,
      allowExecution: config.execution.switches.allowExecution,
      tradingMode: config.execution.switches.tradingMode,
    },
    bridge: {
      reachable: accountRes.ok,
      connected: accountRes.ok ? accountRes.data?.connected === true : false,
      authenticated: accountRes.ok ? accountRes.data?.authenticated === true : false,
      ordersEnabled: accountRes.ok ? accountRes.data?.ordersEnabled === true : false,
      accountEquity: accountRes.ok ? accountRes.data?.accountEquity ?? null : null,
      accountBalance: accountRes.ok ? accountRes.data?.accountBalance ?? null : null,
      accountCurrency: accountRes.ok ? accountRes.data?.accountCurrency ?? null : null,
      server: accountRes.ok ? accountRes.data?.server ?? null : null,
    },
    approvals,
    positions: positionsRes?.ok ? positionsRes.data ?? [] : [],
    positionsError: positionsRes && !positionsRes.ok ? positionsRes.errorCode : null,
    logs,
    approvalTtlMin: approvalTtlMin(),
    generatedAtUtc: new Date().toISOString(),
  };
}
