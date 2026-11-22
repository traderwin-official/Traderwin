/**
 * Fail-safe guard for account connectivity and emergency trading controls.
 * A kill switch blocks new entries; it does not suppress authorized risk-reducing
 * exits. A disconnected broker means Traderwin cannot claim to close positions.
 */
export function evaluateEmergencyGuard({
  accountMode,
  positions = [],
  marketDataConnected,
  brokerConnected,
  killSwitchActive,
  quoteAgeMs,
  maxQuoteAgeMs,
  brokerHeartbeatAgeMs,
  maxBrokerHeartbeatAgeMs
}) {
  if (!["DEMO", "REAL"].includes(accountMode) || !Array.isArray(positions) ||
      typeof marketDataConnected !== "boolean" || typeof brokerConnected !== "boolean" ||
      typeof killSwitchActive !== "boolean" ||
      ![quoteAgeMs, maxQuoteAgeMs, brokerHeartbeatAgeMs, maxBrokerHeartbeatAgeMs].every(Number.isFinite) ||
      quoteAgeMs < 0 || maxQuoteAgeMs <= 0 || brokerHeartbeatAgeMs < 0 || maxBrokerHeartbeatAgeMs <= 0) {
    throw new RangeError("Emergency guard requires verified connection and freshness status.");
  }

  const reasons = [];
  if (killSwitchActive) reasons.push("EMERGENCY_KILL_SWITCH_ACTIVE");
  if (!marketDataConnected) reasons.push("MARKET_DATA_DISCONNECTED");
  if (!brokerConnected) reasons.push("BROKER_DISCONNECTED");
  if (quoteAgeMs > maxQuoteAgeMs) reasons.push("STALE_MARKET_DATA");
  if (brokerHeartbeatAgeMs > maxBrokerHeartbeatAgeMs) reasons.push("BROKER_HEARTBEAT_STALE");

  const realPositionsMissingStop = accountMode === "REAL"
    ? positions.filter(p => p?.status === "OPEN" && p.protectiveStopVerified !== true).map(p => p.id).filter(Boolean)
    : [];
  if (realPositionsMissingStop.length) reasons.push("REAL_POSITION_STOP_NOT_VERIFIED");

  const connectivityHealthy = marketDataConnected && brokerConnected &&
    quoteAgeMs <= maxQuoteAgeMs && brokerHeartbeatAgeMs <= maxBrokerHeartbeatAgeMs;

  return {
    status: !connectivityHealthy ? "EXIT_UNAVAILABLE" :
      (reasons.length ? "ENTRY_HALTED" : "READY"),
    allowNewEntries: reasons.length === 0,
    allowRiskReducingActions: connectivityHealthy,
    killSwitchActive,
    reasons,
    realPositionsMissingStopLossIds: realPositionsMissingStop
  };
}
