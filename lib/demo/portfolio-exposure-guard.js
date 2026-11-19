// Young Tiger FX portfolio concentration and correlation guard.
// Pure calculation only. Correlations and exposures must come from trusted,
// current server-side sources; unknown correlation fails closed.
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const validPosition = (p) => p && typeof p.symbol === "string" && p.symbol.trim() &&
  typeof p.riskGroup === "string" && p.riskGroup.trim() &&
  ["BUY", "SELL"].includes(p.direction) &&
  finite(p.riskMoney) && p.riskMoney > 0 &&
  finite(p.notionalExposureMoney) && p.notionalExposureMoney > 0;

const pairKey = (a, b) => [a, b].sort().join("|");

export function evaluatePortfolioExposure({
  openPositions = [],
  proposedPosition,
  correlationPairs = [],
  correlationDataComplete = false,
  minPnlCorrelation = 0.8,
  maxRiskGroupRiskMoney,
  maxRiskGroupExposureMoney,
  maxCorrelatedRiskMoney
} = {}) {
  const blocked = (reason, metrics = {}) => ({
    status: "BLOCKED", allowed: false, reason, shouldStopNewEntries: true, ...metrics
  });

  if (!Array.isArray(openPositions) || !openPositions.every(validPosition) ||
      !validPosition(proposedPosition) || !Array.isArray(correlationPairs) ||
      typeof correlationDataComplete !== "boolean" ||
      !finite(minPnlCorrelation) || minPnlCorrelation <= 0 || minPnlCorrelation > 1 ||
      !finite(maxRiskGroupRiskMoney) || maxRiskGroupRiskMoney <= 0 ||
      !finite(maxRiskGroupExposureMoney) || maxRiskGroupExposureMoney <= 0 ||
      !finite(maxCorrelatedRiskMoney) || maxCorrelatedRiskMoney <= 0) {
    return blocked("INVALID_EXPOSURE_INPUT");
  }

  const groupPositions = [...openPositions, proposedPosition]
    .filter((p) => p.riskGroup === proposedPosition.riskGroup);
  const groupRiskMoney = groupPositions.reduce((sum, p) => sum + p.riskMoney, 0);
  const groupExposureMoney = groupPositions.reduce((sum, p) => sum + p.notionalExposureMoney, 0);
  const baseMetrics = {
    riskGroup: proposedPosition.riskGroup,
    groupPositionCount: groupPositions.length,
    groupRiskMoney,
    maxRiskGroupRiskMoney,
    groupExposureMoney,
    maxRiskGroupExposureMoney
  };

  if (groupRiskMoney > maxRiskGroupRiskMoney) {
    return blocked("RISK_GROUP_RISK_LIMIT_EXCEEDED", baseMetrics);
  }
  if (groupExposureMoney > maxRiskGroupExposureMoney) {
    return blocked("RISK_GROUP_EXPOSURE_LIMIT_EXCEEDED", baseMetrics);
  }
  if (openPositions.length === 0) {
    return {
      status: "APPROVED_FOR_EXPOSURE_CHECK_ONLY",
      allowed: true,
      shouldStopNewEntries: false,
      correlatedRiskMoney: proposedPosition.riskMoney,
      maxCorrelatedRiskMoney,
      ...baseMetrics
    };
  }
  if (!correlationDataComplete) {
    return blocked("CORRELATION_DATA_NOT_VERIFIED", baseMetrics);
  }

  const correlations = new Map();
  for (const pair of correlationPairs) {
    if (!pair || typeof pair.symbolA !== "string" || typeof pair.symbolB !== "string" ||
        pair.symbolA === pair.symbolB || !finite(pair.correlation) ||
        pair.correlation < -1 || pair.correlation > 1) {
      return blocked("INVALID_CORRELATION_DATA", baseMetrics);
    }
    correlations.set(pairKey(pair.symbolA, pair.symbolB), pair.correlation);
  }

  let correlatedRiskMoney = proposedPosition.riskMoney;
  const correlatedSymbols = [];
  for (const position of openPositions) {
    let returnCorrelation;
    if (position.symbol === proposedPosition.symbol) {
      returnCorrelation = 1;
    } else {
      const key = pairKey(position.symbol, proposedPosition.symbol);
      if (!correlations.has(key)) {
        return blocked("CORRELATION_PAIR_MISSING", {
          ...baseMetrics, missingPair: key
        });
      }
      returnCorrelation = correlations.get(key);
    }
    const proposedSign = proposedPosition.direction === "BUY" ? 1 : -1;
    const existingSign = position.direction === "BUY" ? 1 : -1;
    const pnlCorrelation = returnCorrelation * proposedSign * existingSign;
    if (pnlCorrelation >= minPnlCorrelation) {
      correlatedRiskMoney += position.riskMoney;
      correlatedSymbols.push(position.symbol);
    }
  }

  const metrics = {
    ...baseMetrics,
    correlatedRiskMoney,
    maxCorrelatedRiskMoney,
    minPnlCorrelation,
    correlatedSymbols
  };
  if (correlatedRiskMoney > maxCorrelatedRiskMoney) {
    return blocked("CORRELATED_RISK_LIMIT_EXCEEDED", metrics);
  }

  return {
    status: "APPROVED_FOR_EXPOSURE_CHECK_ONLY",
    allowed: true,
    shouldStopNewEntries: false,
    ...metrics,
    note: "Exposure approval only. No order was opened. A caller must also check daily loss, margin, broker limits, market-data freshness and execution authorization."
  };
}
