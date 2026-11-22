const finite = value => typeof value === "number" && Number.isFinite(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const MODES = ["DEMO", "REAL"];
const BROKERS = ["DERIV", "MT5"];

export function buildTakeProfitPlan({ direction, entry, stopLoss, riskMultiples = [1, 2, 3] }) {
  if (!["BUY", "SELL"].includes(direction) || !finite(entry) || entry <= 0 ||
      !finite(stopLoss) || stopLoss <= 0 ||
      (direction === "BUY" ? stopLoss >= entry : stopLoss <= entry) ||
      !Array.isArray(riskMultiples) || riskMultiples.length !== 3 ||
      riskMultiples.some((n, i) => !finite(n) || n <= 0 || (i > 0 && n <= riskMultiples[i - 1]))) {
    throw new RangeError("Invalid direction, entry, stop-loss or take-profit risk multiples.");
  }
  const risk = Math.abs(entry - stopLoss);
  const priceAt = multiple => direction === "BUY" ? entry + risk * multiple : entry - risk * multiple;
  const targets = riskMultiples.map(priceAt);
  if (targets.some(price => !finite(price) || price <= 0) ||
      (direction === "BUY" ? !(targets[0] < targets[1] && targets[1] < targets[2]) : !(targets[0] > targets[1] && targets[1] > targets[2]))) {
    throw new RangeError("Calculated take-profit prices are invalid.");
  }
  return { direction, risk, targets: { tp1: targets[0], tp2: targets[1], tp3: targets[2] }, riskMultiples: [...riskMultiples] };
}

function roundDownToStep(value, step) {
  const precision = Math.min(12, Math.max(0, (String(step).split(".")[1] || "").length));
  return Number((Math.floor((value + step * 1e-9) / step) * step).toFixed(precision));
}

/**
 * Returns only the next eligible stage. One stage per broker-confirmed call
 * keeps retries idempotent and makes skipped/failed stages observable.
 */
export function evaluateTakeProfitStage({ position, quote, progress = {}, now = Date.now() }) {
  if (!position || !text(position.id) || !text(position.userId) ||
      !MODES.includes(position.accountMode) || !BROKERS.includes(position.broker) ||
      !text(position.accountRef) || !["BUY", "SELL"].includes(position.direction) ||
      !finite(position.entryPrice) || position.entryPrice <= 0 ||
      !finite(position.remainingUnits) || position.remainingUnits <= 0 ||
      !finite(position.initialUnits) || position.initialUnits < position.remainingUnits ||
      !finite(position.minUnits) || position.minUnits <= 0 ||
      !finite(position.volumeStep) || position.volumeStep <= 0 ||
      !position.targets || !["tp1", "tp2", "tp3"].every(k => finite(position.targets[k]) && position.targets[k] > 0)) {
    return { action: "BLOCK", reason: "INVALID_POSITION_OR_VOLUME_METADATA" };
  }
  if (!quote || !finite(quote.price) || quote.price <= 0 || !text(quote.source) ||
      !text(quote.asOf) || !finite(Date.parse(quote.asOf)) ||
      !finite(quote.maxAgeMs) || quote.maxAgeMs <= 0) {
    return { action: "BLOCK", reason: "INVALID_QUOTE" };
  }
  const ageMs = now - Date.parse(quote.asOf);
  if (ageMs < 0 || ageMs > quote.maxAgeMs) return { action: "BLOCK", reason: "STALE_QUOTE", ageMs };
  if (!progress || typeof progress !== "object") return { action: "BLOCK", reason: "INVALID_TP_PROGRESS" };

  const reached = (key) => position.direction === "BUY"
    ? quote.price >= position.targets[key]
    : quote.price <= position.targets[key];
  const stages = [
    { key: "tp1", fraction: 0.40 },
    { key: "tp2", fraction: 0.30 },
    { key: "tp3", fraction: 1.00 }
  ];
  for (const stage of stages) {
    if (progress[stage.key] === true || !reached(stage.key)) continue;
    const requestedUnits = stage.key === "tp3"
      ? position.remainingUnits
      : roundDownToStep(position.initialUnits * stage.fraction, position.volumeStep);
    if (requestedUnits <= 0 || requestedUnits < position.minUnits) {
      if (stage.key !== "tp3") {
        return { action: "SKIP_STAGE", stage: stage.key, reason: "PARTIAL_VOLUME_BELOW_BROKER_MINIMUM", targetPrice: position.targets[stage.key] };
      }
      return { action: "BLOCK", reason: "REMAINING_VOLUME_BELOW_BROKER_MINIMUM" };
    }
    if (requestedUnits > position.remainingUnits + position.volumeStep * 1e-8) {
      return { action: "BLOCK", reason: "PARTIAL_VOLUME_EXCEEDS_REMAINING_POSITION" };
    }
    return {
      action: "CLOSE_PARTIAL",
      stage: stage.key.toUpperCase(),
      stageKey: stage.key,
      targetPrice: position.targets[stage.key],
      requestedUnits,
      remainingAfterClose: Math.max(0, Number((position.remainingUnits - requestedUnits).toFixed(12))),
      final: stage.key === "tp3",
      idempotencyKey: `traderwin:tp:${position.accountMode}:${position.broker}:${position.accountRef}:${position.id}:${stage.key}`
    };
  }
  return { action: "WAIT", reason: "NO_NEW_TAKE_PROFIT_TARGET_REACHED" };
}

/**
 * Broker-neutral execution coordinator. Adapters must confirm exact executed
 * volume and persist stage progress. REAL execution has an independent gate.
 */
export async function executeTakeProfitStage({ scope, position, quote, progress, adapters, now = Date.now() }) {
  if (!scope || !position || scope.userId !== position.userId ||
      scope.accountMode !== position.accountMode || scope.broker !== position.broker ||
      scope.accountRef !== position.accountRef) {
    return { status: "BLOCKED", reason: "ACCOUNT_SCOPE_MISMATCH" };
  }
  for (const name of ["closePosition", "saveProgress"]) {
    if (typeof adapters?.[name] !== "function") throw new TypeError(`Missing take-profit adapter: ${name}`);
  }
  if (position.source === "MANUAL" &&
      (typeof adapters.canManageManualPosition !== "function" ||
       await adapters.canManageManualPosition(scope, position) !== true)) {
    return { status: "BLOCKED", reason: "MANUAL_POSITION_PERMISSION_NOT_GRANTED" };
  }
  if (scope.accountMode === "REAL" &&
      (typeof adapters.isRealExecutionAuthorized !== "function" ||
       await adapters.isRealExecutionAuthorized(scope) !== true)) {
    return { status: "BLOCKED", reason: "REAL_EXECUTION_NOT_AUTHORIZED" };
  }
  const decision = evaluateTakeProfitStage({ position, quote, progress, now });
  if (decision.action === "WAIT") return { status: "WAIT", decision };
  if (decision.action === "BLOCK") return { status: "BLOCKED", decision };
  if (decision.action === "SKIP_STAGE") {
    try {
      const saved = await adapters.saveProgress(scope, position.id, { [decision.stage.toLowerCase()]: true, skippedReason: decision.reason });
      return saved?.saved ? { status: "STAGE_SKIPPED", decision } : { status: "RETRY", reason: "TP_PROGRESS_SAVE_FAILED", decision };
    } catch {
      return { status: "RETRY", reason: "TP_PROGRESS_SAVE_FAILED", decision };
    }
  }
  let result;
  try {
    result = await adapters.closePosition(position, {
      volume: decision.requestedUnits,
      targetPrice: decision.targetPrice,
      idempotencyKey: decision.idempotencyKey,
      reason: decision.stage
    });
  } catch {
    return { status: "RETRY", reason: "BROKER_CLOSE_FAILED", decision };
  }
  if (result?.closed !== true || !finite(result.executedUnits) ||
      Math.abs(result.executedUnits - decision.requestedUnits) > position.volumeStep * 1e-8) {
    return { status: "RETRY", reason: "BROKER_CLOSE_NOT_CONFIRMED", decision };
  }
  let saved;
  try {
    saved = await adapters.saveProgress(scope, position.id, {
      [decision.stageKey]: true,
      lastClosedUnits: result.executedUnits,
      lastClosePrice: result.fillPrice,
      lastCloseAt: result.closedAt,
      remainingUnits: decision.remainingAfterClose
    });
  } catch {
    return { status: "RECONCILE", reason: "CLOSE_CONFIRMED_PROGRESS_SAVE_FAILED", decision, brokerResult: result };
  }
  if (!saved?.saved) return { status: "RECONCILE", reason: "CLOSE_CONFIRMED_PROGRESS_SAVE_FAILED", decision, brokerResult: result };
  return { status: decision.final ? "TP3_COMPLETE" : "PARTIAL_CLOSED", decision, brokerResult: result };
}
