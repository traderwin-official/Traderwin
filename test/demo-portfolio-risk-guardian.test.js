import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePortfolioRisk } from "../lib/demo/portfolio-risk-guardian.js";

const base = {
  accountMode: "DEMO",
  botEnabled: true,
  dayStartEquity: 10000,
  realizedDailyPnlMoney: 0,
  openPositions: [],
  proposedRiskMoney: 25
};

test("allows a safe entry with risk budget remaining", () => {
  const result = evaluatePortfolioRisk(base);
  assert.equal(result.allowed, true);
  assert.equal(result.paperOnly, true);
  assert.equal(result.projectedPortfolioRiskMoney, 25);
});

test("permits more than three positions when configured and within risk caps", () => {
  const openPositions = Array.from({ length: 4 }, () => ({
    riskToStopMoney: 20, currentPnlMoney: 0, pnlAtStopMoney: -20
  }));
  const result = evaluatePortfolioRisk({
    ...base, openPositions, maxOpenPositions: 6, proposedRiskMoney: 20
  });
  assert.equal(result.allowed, true);
  assert.equal(result.openPositionCount, 4);
});

test("blocks before the daily loss boundary and preserves a reserve", () => {
  const result = evaluatePortfolioRisk({
    ...base,
    realizedDailyPnlMoney: -150,
    openPositions: [{ riskToStopMoney: 20, currentPnlMoney: -10, pnlAtStopMoney: -20 }],
    proposedRiskMoney: 20
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "DAILY_LOSS_RESERVE_REACHED");
});

test("blocks when projected portfolio risk exceeds its cap", () => {
  const result = evaluatePortfolioRisk({
    ...base,
    openPositions: [{ riskToStopMoney: 180, currentPnlMoney: 0, pnlAtStopMoney: -180 }],
    proposedRiskMoney: 30,
    maxPortfolioRiskPct: 2
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "PORTFOLIO_RISK_LIMIT_EXCEEDED");
});

test("blocks at the configured open-position limit", () => {
  const result = evaluatePortfolioRisk({
    ...base,
    openPositions: Array.from({ length: 5 }, () => ({
      riskToStopMoney: 10, currentPnlMoney: 0, pnlAtStopMoney: -10
    }))
  });
  assert.equal(result.reason, "MAX_OPEN_POSITIONS_REACHED");
});

test("emergency stop and disabled bot always block", () => {
  assert.equal(evaluatePortfolioRisk({ ...base, emergencyStopped: true }).reason, "EMERGENCY_STOP_ACTIVE");
  assert.equal(evaluatePortfolioRisk({ ...base, botEnabled: false }).reason, "BOT_DISABLED");
});

test("rejects malformed or missing stop-risk data", () => {
  const result = evaluatePortfolioRisk({
    ...base,
    openPositions: [{ riskToStopMoney: 10, currentPnlMoney: 0 }]
  });
  assert.equal(result.reason, "INVALID_OPEN_POSITION_RISK_DATA");
});

test("rejects REAL/Demo ambiguity and invalid limits", () => {
  assert.equal(evaluatePortfolioRisk({ ...base, accountMode: "LIVE" }).reason, "INVALID_PORTFOLIO_RISK_INPUT");
  assert.equal(evaluatePortfolioRisk({ ...base, maxDailyLossPct: 0 }).reason, "INVALID_PORTFOLIO_RISK_INPUT");
});
