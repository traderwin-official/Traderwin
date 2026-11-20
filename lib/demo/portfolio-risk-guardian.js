// Young Tiger FX portfolio-level risk guardian.
// Pure pre-trade calculation only. It never opens/closes orders or writes data.
// All monetary inputs must be trusted server-side estimates in account currency.
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const nonNegative = (v) => finite(v) && v >= 0;

export function evaluatePortfolioRisk({
  accountMode,
  botEnabled,
  emergencyStopped = false,
  dayStartEquity,
  realizedDailyPnlMoney,
  openPositions = [],
  proposedRiskMoney,
  maxDailyLossPct = 2,
  maxPortfolioRiskPct = 2,
  maxOpenPositions = 5,
  dailyLossReservePct = 20
} = {}) {
  const blocked = (reason, metrics = {}) => ({
    status: "BLOCKED", allowed: false, shouldStopNewEntries: true, reason, ...metrics
  });

  if (!["DEMO", "REAL"].includes(accountMode) ||
      typeof botEnabled !== "boolean" ||
      !nonNegative(dayStartEquity) || dayStartEquity <= 0 ||
      !finite(realizedDailyPnlMoney) ||
      !Array.isArray(openPositions) ||
      !nonNegative(proposedRiskMoney) || proposedRiskMoney <= 0 ||
      !finite(maxDailyLossPct) || maxDailyLossPct <= 0 || maxDailyLossPct > 10 ||
      !finite(maxPortfolioRiskPct) || maxPortfolioRiskPct <= 0 || maxPortfolioRiskPct > 10 ||
      !Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 10 ||
      !finite(dailyLossReservePct) || dailyLossReservePct < 0 || dailyLossReservePct > 50) {
    return blocked("INVALID_PORTFOLIO_RISK_INPUT");
  }
  if (emergencyStopped) return blocked("EMERGENCY_STOP_ACTIVE");
  if (!botEnabled) return blocked("BOT_DISABLED");
  if (openPositions.length >= maxOpenPositions) {
    return blocked("MAX_OPEN_POSITIONS_REACHED", {
      openPositionCount: openPositions.length, maxOpenPositions
    });
  }

  let openRiskMoney = 0;
  let floatingPnlMoney = 0;
  let stopScenarioPnlMoney = realizedDailyPnlMoney;
  for (const position of openPositions) {
    if (!position || !nonNegative(position.riskToStopMoney) ||
        position.riskToStopMoney <= 0 || !finite(position.currentPnlMoney) ||
        !finite(position.pnlAtStopMoney) || position.pnlAtStopMoney > 0) {
      return blocked("INVALID_OPEN_POSITION_RISK_DATA");
    }
    openRiskMoney += position.riskToStopMoney;
    floatingPnlMoney += position.currentPnlMoney;
    stopScenarioPnlMoney += position.pnlAtStopMoney;
  }

  const dailyLossCapMoney = dayStartEquity * maxDailyLossPct / 100;
  const entryLossCeilingMoney = dailyLossCapMoney * (1 - dailyLossReservePct / 100);
  const portfolioRiskCapMoney = dayStartEquity * maxPortfolioRiskPct / 100;
  const currentDailyPnlMoney = realizedDailyPnlMoney + floatingPnlMoney;
  const currentDailyLossMoney = Math.max(0, -currentDailyPnlMoney);
  const stopScenarioLossMoney = Math.max(0, -stopScenarioPnlMoney);
  const projectedStopScenarioLossMoney = stopScenarioLossMoney + proposedRiskMoney;
  const projectedPortfolioRiskMoney = openRiskMoney + proposedRiskMoney;
  const dailyLossUsedMoney = Math.max(currentDailyLossMoney, projectedStopScenarioLossMoney);
  const metrics = {
    accountMode,
    openPositionCount: openPositions.length,
    maxOpenPositions,
    openRiskMoney,
    proposedRiskMoney,
    projectedPortfolioRiskMoney,
    portfolioRiskCapMoney,
    currentDailyPnlMoney,
    currentDailyLossMoney,
    stopScenarioLossMoney,
    projectedStopScenarioLossMoney,
    dailyLossUsedMoney,
    dailyLossCapMoney,
    entryLossCeilingMoney,
    dailyLossReservePct,
    remainingDailyEntryBudgetMoney: Math.max(0, entryLossCeilingMoney - dailyLossUsedMoney)
  };

  if (currentDailyLossMoney >= dailyLossCapMoney ||
      stopScenarioLossMoney >= dailyLossCapMoney) {
    return blocked("DAILY_LOSS_LIMIT_REACHED", metrics);
  }
  if (dailyLossUsedMoney > entryLossCeilingMoney) {
    return blocked("DAILY_LOSS_RESERVE_REACHED", metrics);
  }
  if (projectedPortfolioRiskMoney > portfolioRiskCapMoney) {
    return blocked("PORTFOLIO_RISK_LIMIT_EXCEEDED", metrics);
  }

  return {
    status: "APPROVED_FOR_RISK_CHECK_ONLY",
    allowed: true,
    shouldStopNewEntries: false,
    paperOnly: accountMode === "DEMO",
    ...metrics,
    note: "Risk budget approval only. No order was opened; a caller must still validate feed, broker limits, margin, correlation, permissions and recheck immediately before execution."
  };
}
