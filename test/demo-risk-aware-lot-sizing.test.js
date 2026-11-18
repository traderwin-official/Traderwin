import test from "node:test";
import assert from "node:assert/strict";
import { calculateRiskAwareLotSize } from "../lib/demo/risk-aware-lot-sizing.js";

const base = {
  mode: "AUTO",
  equity: 1000,
  entryPrice: 2000,
  stopLoss: 1990,
  tickSize: 0.1,
  tickValuePerLot: 1,
  minLot: 0.01,
  maxLot: 10,
  lotStep: 0.01,
  riskPerTradePct: 0.5,
  maxPortfolioRiskPct: 2,
  maxDailyLossPct: 2,
  realizedDailyLossMoney: 0,
  openRiskMoney: 0,
  availableMargin: 1000,
  marginPerLot: 100
};

test("auto sizing stays within the per-trade risk budget", () => {
  const result = calculateRiskAwareLotSize(base);
  assert.equal(result.allowed, true);
  assert.equal(result.lots, 0.05);
  assert.equal(result.estimatedLossAtStop, 5);
});

test("automatic size scales with equity while risk percentage stays constant", () => {
  const result = calculateRiskAwareLotSize({ ...base, equity: 2000 });
  assert.equal(result.allowed, true);
  assert.equal(result.lots, 0.1);
  assert.equal(result.estimatedLossAtStop, 10);
});

test("manual size is accepted when it passes all limits", () => {
  const result = calculateRiskAwareLotSize({ ...base, mode: "MANUAL", manualLots: 0.05 });
  assert.equal(result.allowed, true);
  assert.equal(result.lots, 0.05);
});

test("manual size above risk budget is rejected, not silently reduced", () => {
  const result = calculateRiskAwareLotSize({ ...base, mode: "MANUAL", manualLots: 0.06 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "MANUAL_LOT_EXCEEDS_RISK_BUDGET");
});

test("daily loss budget includes realized loss and existing open risk", () => {
  const result = calculateRiskAwareLotSize({
    ...base,
    realizedDailyLossMoney: 19,
    openRiskMoney: 1
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "RISK_BUDGET_EXHAUSTED");
});

test("margin limits automatic sizing", () => {
  const result = calculateRiskAwareLotSize({ ...base, availableMargin: 3 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "SAFE_SIZE_BELOW_BROKER_MINIMUM");
});

test("manual lot must respect broker minimum, maximum, and step", () => {
  const offStep = calculateRiskAwareLotSize({ ...base, mode: "MANUAL", manualLots: 0.015 });
  assert.equal(offStep.reason, "MANUAL_LOT_OUTSIDE_BROKER_RULES");
  const tooLarge = calculateRiskAwareLotSize({ ...base, mode: "MANUAL", manualLots: 11 });
  assert.equal(tooLarge.reason, "MANUAL_LOT_OUTSIDE_BROKER_RULES");
});

test("invalid or zero-risk inputs fail closed", () => {
  assert.equal(calculateRiskAwareLotSize({ ...base, tickValuePerLot: 0 }).allowed, false);
  assert.equal(calculateRiskAwareLotSize({ ...base, stopLoss: 2000 }).allowed, false);
});
