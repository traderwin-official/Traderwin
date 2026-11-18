import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePortfolioExposure } from "../lib/demo/portfolio-exposure-guard.js";

const candidate = {
  symbol: "EURUSD", riskGroup: "FX_MAJOR", direction: "BUY",
  riskMoney: 20, notionalExposureMoney: 1000
};
const base = {
  proposedPosition: candidate,
  maxRiskGroupRiskMoney: 100,
  maxRiskGroupExposureMoney: 5000,
  maxCorrelatedRiskMoney: 50
};
const existing = {
  symbol: "GBPUSD", riskGroup: "FX_MAJOR", direction: "BUY",
  riskMoney: 20, notionalExposureMoney: 1000
};

test("approves a first position within group limits", () => {
  const result = evaluatePortfolioExposure(base);
  assert.equal(result.allowed, true);
  assert.equal(result.groupRiskMoney, 20);
});

test("blocks excessive risk concentration in the same group", () => {
  const result = evaluatePortfolioExposure({
    ...base,
    proposedPosition: { ...candidate, riskMoney: 60 },
    openPositions: [{ ...existing, riskMoney: 50 }]
  });
  assert.equal(result.reason, "RISK_GROUP_RISK_LIMIT_EXCEEDED");
});

test("blocks excessive gross group exposure without netting", () => {
  const result = evaluatePortfolioExposure({
    ...base,
    proposedPosition: { ...candidate, notionalExposureMoney: 3000 },
    openPositions: [{ ...existing, notionalExposureMoney: 2500 }]
  });
  assert.equal(result.reason, "RISK_GROUP_EXPOSURE_LIMIT_EXCEEDED");
});

test("fails closed when correlation data is not verified", () => {
  const result = evaluatePortfolioExposure({ ...base, openPositions: [existing] });
  assert.equal(result.reason, "CORRELATION_DATA_NOT_VERIFIED");
});

test("blocks when same-direction positively correlated risk exceeds cap", () => {
  const result = evaluatePortfolioExposure({
    ...base,
    openPositions: [existing],
    correlationDataComplete: true,
    correlationPairs: [{ symbolA: "EURUSD", symbolB: "GBPUSD", correlation: 0.9 }],
    maxCorrelatedRiskMoney: 30
  });
  assert.equal(result.reason, "CORRELATED_RISK_LIMIT_EXCEEDED");
  assert.equal(result.correlatedRiskMoney, 40);
});

test("recognizes opposite trades in negatively correlated instruments as same P&L risk", () => {
  const result = evaluatePortfolioExposure({
    ...base,
    proposedPosition: { ...candidate, direction: "BUY" },
    openPositions: [{ ...existing, direction: "SELL" }],
    correlationDataComplete: true,
    correlationPairs: [{ symbolA: "EURUSD", symbolB: "GBPUSD", correlation: -0.9 }],
    maxCorrelatedRiskMoney: 30
  });
  assert.equal(result.reason, "CORRELATED_RISK_LIMIT_EXCEEDED");
});

test("does not treat negatively correlated same-direction trades as one risk cluster", () => {
  const result = evaluatePortfolioExposure({
    ...base,
    openPositions: [existing],
    correlationDataComplete: true,
    correlationPairs: [{ symbolA: "EURUSD", symbolB: "GBPUSD", correlation: -0.9 }],
    maxCorrelatedRiskMoney: 30
  });
  assert.equal(result.allowed, true);
  assert.equal(result.correlatedRiskMoney, 20);
});

test("blocks missing pair data and malformed correlations", () => {
  const missing = evaluatePortfolioExposure({
    ...base, openPositions: [existing], correlationDataComplete: true
  });
  assert.equal(missing.reason, "CORRELATION_PAIR_MISSING");
  const invalid = evaluatePortfolioExposure({
    ...base, openPositions: [existing], correlationDataComplete: true,
    correlationPairs: [{ symbolA: "EURUSD", symbolB: "GBPUSD", correlation: 1.2 }]
  });
  assert.equal(invalid.reason, "INVALID_CORRELATION_DATA");
});

test("rejects malformed positions and invalid limits", () => {
  assert.equal(evaluatePortfolioExposure({ ...base, proposedPosition: {} }).reason, "INVALID_EXPOSURE_INPUT");
  assert.equal(evaluatePortfolioExposure({ ...base, maxCorrelatedRiskMoney: 0 }).reason, "INVALID_EXPOSURE_INPUT");
});
