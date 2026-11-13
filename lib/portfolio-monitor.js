import { aggregatePortfolioProfitProtection } from "./portfolio-profit-protection.js";
import { evaluateEmergencyGuard } from "./emergency-guard.js";

const validDate = value => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : NaN;
};

/**
 * One-account monitoring coordinator. Position peak profit is stored per unit,
 * so partial TP closes scale the old peak to the remaining open volume instead
 * of falsely triggering the 20% giveback rule.
 */
export async function monitorPortfolio(scope, adapters, options = {}) {
  if (!scope || !scope.userId || !["DEMO", "REAL"].includes(scope.accountMode) ||
      !["DERIV", "MT5"].includes(scope.broker) || !scope.accountRef) {
    throw new RangeError("A complete single-account scope is required.");
  }
  for (const name of ["loadSnapshot", "loadState", "loadPermissions", "saveState", "closePosition"]) {
    if (typeof adapters?.[name] !== "function") throw new TypeError(`Missing portfolio adapter: ${name}`);
  }

  const [snapshot, state, permissions] = await Promise.all([
    adapters.loadSnapshot(scope), adapters.loadState(scope), adapters.loadPermissions(scope)
  ]);
  if (!snapshot || !Array.isArray(snapshot.positions) || typeof snapshot.source !== "string" ||
      !snapshot.source.trim() || !Number.isFinite(validDate(snapshot.asOf)) ||
      !Number.isFinite(snapshot.maxAgeMs) || snapshot.maxAgeMs <= 0) {
    return { status: "BLOCKED", reason: "INVALID_MARKET_SNAPSHOT" };
  }
  const now = options.now ?? Date.now();
  const ageMs = now - validDate(snapshot.asOf);
  if (ageMs < 0 || ageMs > snapshot.maxAgeMs) {
    return { status: "BLOCKED", reason: "STALE_MARKET_DATA", quoteAgeMs: ageMs, source: snapshot.source };
  }
  const emergency = snapshot.emergency;
  if (!emergency || typeof emergency.marketDataConnected !== "boolean" ||
      typeof emergency.brokerConnected !== "boolean" || typeof emergency.killSwitchActive !== "boolean" ||
      !Number.isFinite(validDate(emergency.brokerHeartbeatAsOf)) ||
      !Number.isFinite(emergency.maxBrokerHeartbeatAgeMs) || emergency.maxBrokerHeartbeatAgeMs <= 0) {
    return { status: "BLOCKED", reason: "EMERGENCY_STATUS_UNVERIFIED" };
  }
  let emergencyStatus;
  try {
    emergencyStatus = evaluateEmergencyGuard({
      accountMode: scope.accountMode, positions: snapshot.positions,
      marketDataConnected: emergency.marketDataConnected, brokerConnected: emergency.brokerConnected,
      killSwitchActive: emergency.killSwitchActive, quoteAgeMs: ageMs,
      maxQuoteAgeMs: snapshot.maxAgeMs,
      brokerHeartbeatAgeMs: now - validDate(emergency.brokerHeartbeatAsOf),
      maxBrokerHeartbeatAgeMs: emergency.maxBrokerHeartbeatAgeMs
    });
  } catch {
    return { status: "BLOCKED", reason: "EMERGENCY_STATUS_INVALID" };
  }
  if (!emergencyStatus.allowRiskReducingActions) {
    return { status: "BLOCKED", reason: emergencyStatus.reasons[0] ?? "EMERGENCY_GUARD_BLOCKED", emergency: emergencyStatus };
  }
  if (!state || !Number.isFinite(state.peakProfitUsd) ||
      !Number.isSafeInteger(state.membershipVersion) || state.membershipVersion < 0 ||
      !Number.isSafeInteger(state.stateVersion) || state.stateVersion < 0 ||
      !Array.isArray(state.includedPositionIds) ||
      !state.positionPeakState || typeof state.positionPeakState !== "object") {
    return { status: "BLOCKED", reason: "INVALID_PROTECTION_STATE" };
  }
  if (!permissions || typeof permissions.manageManualTrades !== "boolean" ||
      typeof permissions.manageBotTrades !== "boolean" || typeof permissions.closeManagedPositions !== "boolean") {
    return { status: "BLOCKED", reason: "MISSING_ACCOUNT_PERMISSIONS" };
  }

  const scopedPositions = snapshot.positions.filter(position =>
    position?.status === "OPEN" && position.userId === scope.userId &&
    position.accountMode === scope.accountMode && position.broker === scope.broker &&
    position.accountRef === scope.accountRef
  );
  if (scopedPositions.length !== snapshot.positions.filter(p => p?.status === "OPEN").length) {
    return { status: "BLOCKED", reason: "POSITION_SCOPE_MISMATCH" };
  }

  let calculation;
  try {
    calculation = aggregatePortfolioProfitProtection({
      positions: scopedPositions,
      previousPeakProfitUsd: state.peakProfitUsd,
      previousIncludedPositionIds: state.includedPositionIds,
      previousPositionPeakState: state.positionPeakState,
      manageManualTrades: permissions.manageManualTrades,
      manageBotTrades: permissions.manageBotTrades
    });
  } catch {
    return { status: "BLOCKED", reason: "INVALID_POSITION_VALUATION" };
  }

  const nextState = {
    peakProfitUsd: calculation.peakProfitUsd,
    currentProfitUsd: calculation.currentProfitUsd,
    protectedFloorUsd: calculation.protectedFloorUsd,
    trailingActive: calculation.trailingActive,
    includedPositionIds: calculation.includedPositionIds,
    positionPeakState: calculation.positionPeakState,
    membershipVersion: state.membershipVersion + (calculation.membershipChanged ? 1 : 0),
    stateVersion: state.stateVersion + 1,
    lastValuationAt: new Date(options.now ?? Date.now()).toISOString(),
    quoteSource: snapshot.source,
    quoteAsOf: snapshot.asOf
  };
  const persisted = await adapters.saveState(scope, nextState, state.stateVersion);
  if (!persisted?.saved) return { status: "RETRY", reason: "STATE_VERSION_CONFLICT" };

  if (!calculation.shouldClose) {
    return { status: "MONITORED", calculation, state: nextState, emergency: emergencyStatus, source: snapshot.source, quoteAsOf: snapshot.asOf };
  }
  if (!permissions.closeManagedPositions) {
    return { status: "CLOSE_BLOCKED", reason: "CLOSE_PERMISSION_NOT_GRANTED", calculation, state: nextState };
  }
  if (scope.accountMode === "REAL" &&
      (typeof adapters.isRealExecutionAuthorized !== "function" ||
       await adapters.isRealExecutionAuthorized(scope) !== true)) {
    return { status: "CLOSE_BLOCKED", reason: "REAL_EXECUTION_NOT_AUTHORIZED", calculation, state: nextState };
  }

  const included = new Set(calculation.includedPositionIds);
  const positionsToClose = scopedPositions.filter(position => included.has(position.id));
  const results = [];
  for (const position of positionsToClose) {
    try {
      const result = await adapters.closePosition(position, {
        idempotencyKey: `portfolio-protection:${scope.accountMode}:${scope.broker}:${scope.accountRef}:${position.id}:${nextState.membershipVersion}`,
        reason: "PORTFOLIO_PROFIT_GIVEBACK"
      });
      results.push({ positionId: position.id, closed: result?.closed === true, status: result?.status ?? "UNKNOWN" });
    } catch {
      results.push({ positionId: position.id, closed: false, status: "ERROR" });
    }
  }
  const failed = results.filter(result => !result.closed);
  return {
    status: failed.length ? "PARTIAL_CLOSE" : "CLOSE_REQUESTED",
    reason: "PORTFOLIO_PROFIT_GIVEBACK", calculation, state: nextState,
    emergency: emergencyStatus, closeResults: results,
    retryPositionIds: failed.map(result => result.positionId)
  };
}
