// Risk-aware lot sizing for Young Tiger Forex Platform.
// Pure calculation only: no account reads, database writes, or broker orders.
// tickValuePerLot must be expressed in the account currency for one tick of one lot.
const finitePositive = (value) => Number.isFinite(value) && value > 0;
const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0;

function decimalsForStep(value) {
  const text = String(value);
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return (text.split(".")[1] || "").length;
}

// Broker lot steps are measured from minLot, not necessarily from zero.
function floorToStep(value, minLot, step) {
  if (!Number.isFinite(value) || value < minLot) return 0;
  const units = Math.floor(((value - minLot) / step) + 1e-10);
  const precision = Math.min(10, Math.max(decimalsForStep(minLot), decimalsForStep(step)) + 2);
  return Number((minLot + units * step).toFixed(precision));
}

function isOnStep(value, min, step) {
  const units = (value - min) / step;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

/**
 * mode: "AUTO" derives the largest size within all risk/margin budgets.
 * mode: "MANUAL" validates the trader's exact requested size; it never silently
 * reduces a manually requested size.
 *
 * riskPerTradePct, maxPortfolioRiskPct and maxDailyLossPct are percentages.
 * realizedDailyLossMoney and openRiskMoney are non-negative account-currency
 * amounts representing losses/risk already consumed today.
 */
export function calculateRiskAwareLotSize({
  mode,
  direction,
  equity,
  entryPrice,
  stopLoss,
  tickSize,
  tickValuePerLot,
  minLot,
  maxLot,
  lotStep,
  riskPerTradePct,
  maxPortfolioRiskPct,
  maxDailyLossPct,
  realizedDailyLossMoney = 0,
  openRiskMoney = 0,
  availableMargin,
  marginPerLot,
  manualLots
} = {}) {
  const blocked = (reason, details = {}) => ({
    status: "BLOCKED",
    allowed: false,
    reason,
    ...details
  });

  if (!["AUTO", "MANUAL"].includes(mode) ||
      !["BUY", "SELL"].includes(direction) ||
      !finitePositive(equity) || !finitePositive(entryPrice) ||
      !finitePositive(stopLoss) ||
      (direction === "BUY" && stopLoss >= entryPrice) ||
      (direction === "SELL" && stopLoss <= entryPrice) ||
      !finitePositive(tickSize) || !finitePositive(tickValuePerLot) ||
      !finitePositive(minLot) || !finitePositive(maxLot) || maxLot < minLot ||
      !finitePositive(lotStep) || !isOnStep(maxLot, minLot, lotStep) ||
      !Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 2 ||
      !Number.isFinite(maxPortfolioRiskPct) || maxPortfolioRiskPct <= 0 || maxPortfolioRiskPct > 10 ||
      !Number.isFinite(maxDailyLossPct) || maxDailyLossPct <= 0 || maxDailyLossPct > 10 ||
      !finiteNonNegative(realizedDailyLossMoney) || !finiteNonNegative(openRiskMoney) ||
      !finiteNonNegative(availableMargin) || !finitePositive(marginPerLot) ||
      (mode === "MANUAL" && !finitePositive(manualLots))) {
    return blocked("INVALID_SIZING_INPUT");
  }

  const distance = direction === "BUY" ? entryPrice - stopLoss : stopLoss - entryPrice;
  const ticksAtRisk = distance / tickSize;
  const riskPerLot = ticksAtRisk * tickValuePerLot;
  if (!finitePositive(riskPerLot)) return blocked("INVALID_INSTRUMENT_RISK_VALUE");

  const perTradeBudget = equity * riskPerTradePct / 100;
  const portfolioBudget = equity * maxPortfolioRiskPct / 100 - openRiskMoney;
  const dailyBudget = equity * maxDailyLossPct / 100 -
    realizedDailyLossMoney - openRiskMoney;
  const riskBudget = Math.min(perTradeBudget, portfolioBudget, dailyBudget);
  if (!finitePositive(riskBudget)) return blocked("RISK_BUDGET_EXHAUSTED", {
    perTradeBudget,
    portfolioBudget: Math.max(0, portfolioBudget),
    dailyBudget: Math.max(0, dailyBudget)
  });

  const maxLotsByRisk = riskBudget / riskPerLot;
  const maxLotsByMargin = availableMargin / marginPerLot;
  const permittedLots = Math.min(maxLot, maxLotsByRisk, maxLotsByMargin);

  let lots;
  if (mode === "AUTO") {
    lots = floorToStep(permittedLots, minLot, lotStep);
    if (lots < minLot) return blocked("SAFE_SIZE_BELOW_BROKER_MINIMUM", {
      maxLotsByRisk,
      maxLotsByMargin,
      riskBudget,
      riskPerLot
    });
  } else {
    lots = manualLots;
    if (lots < minLot || lots > maxLot || !isOnStep(lots, minLot, lotStep)) {
      return blocked("MANUAL_LOT_OUTSIDE_BROKER_RULES", {
        requestedLots: lots,
        minLot,
        maxLot,
        lotStep
      });
    }
    if (lots > maxLotsByRisk + 1e-10) {
      return blocked("MANUAL_LOT_EXCEEDS_RISK_BUDGET", {
        requestedLots: lots,
        maximumByRisk: floorToStep(maxLotsByRisk, minLot, lotStep),
        riskBudget
      });
    }
    if (lots > maxLotsByMargin + 1e-10) {
      return blocked("MANUAL_LOT_EXCEEDS_AVAILABLE_MARGIN", {
        requestedLots: lots,
        maximumByMargin: floorToStep(maxLotsByMargin, minLot, lotStep)
      });
    }
  }

  const estimatedLossAtStop = lots * riskPerLot;
  const requiredMargin = lots * marginPerLot;
  return {
    status: "SIZE_APPROVED",
    allowed: true,
    mode,
    lots,
    estimatedLossAtStop,
    requiredMargin,
    riskBudget,
    riskPerLot,
    maxLotsByRisk: floorToStep(maxLotsByRisk, minLot, lotStep),
    maxLotsByMargin: floorToStep(maxLotsByMargin, minLot, lotStep),
    note: "Sizing approval only. Recheck live equity, margin, instrument specifications, price, and portfolio risk immediately before any order."
  };
}
