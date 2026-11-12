import test from "node:test";
import assert from "node:assert/strict";
import { aggregatePortfolioProfitProtection } from "../lib/portfolio-profit-protection.js";

const base = [
  { id: "bot-1", userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "d1", source: "BOT", status: "OPEN", profitUsd: 8 },
  { id: "manual-1", userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "d1", source: "MANUAL", status: "OPEN", profitUsd: 7 },
  { id: "bot-2", userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "d1", source: "BOT", status: "OPEN", profitUsd: 6 }
];

test("manual positions are excluded until explicit manage permission is enabled", () => {
  const result = aggregatePortfolioProfitProtection({ positions: base });
  assert.equal(result.currentProfitUsd, 14);
  assert.deepEqual(result.excludedManualPositionIds, ["manual-1"]);
  assert.equal(result.trailingActive, false);
});

test("bot and explicitly managed manual positions share the USD 20 threshold", () => {
  const result = aggregatePortfolioProfitProtection({ positions: base, manageManualTrades: true });
  assert.equal(result.currentProfitUsd, 21);
  assert.equal(result.peakProfitUsd, 21);
  assert.equal(result.trailingActive, true);
  assert.equal(result.protectedFloorUsd, 16.8);
  assert.deepEqual(result.includedManualPositionIds, ["manual-1"]);
});

test("portfolio peak is persistent input and a 20 percent giveback triggers close", () => {
  const result = aggregatePortfolioProfitProtection({
    positions: base.map(position => ({ ...position, profitUsd: position.source === "MANUAL" ? 30 : 35 })),
    previousPeakProfitUsd: 100,
    manageManualTrades: true
  });
  assert.equal(result.currentProfitUsd, 100);
  assert.equal(result.peakProfitUsd, 100);
  assert.equal(result.protectedFloorUsd, 80);
  assert.equal(result.shouldClose, false);
  const retraced = aggregatePortfolioProfitProtection({
    positions: base.map(position => ({ ...position, profitUsd: position.source === "MANUAL" ? 20 : 20 })),
    previousPeakProfitUsd: 100,
    manageManualTrades: true
  });
  assert.equal(retraced.currentProfitUsd, 60);
  assert.equal(retraced.shouldClose, true);
});

test("DEMO and REAL or different broker accounts cannot be mixed", () => {
  assert.throws(() => aggregatePortfolioProfitProtection({
    positions: [base[0], { ...base[1], accountMode: "REAL" }],
    manageManualTrades: true
  }), RangeError);
});

test("closed positions do not affect the combined open-profit calculation", () => {
  const result = aggregatePortfolioProfitProtection({
    positions: [...base, { ...base[0], id: "closed", status: "CLOSED", profitUsd: 500 }],
    manageManualTrades: true
  });
  assert.equal(result.currentProfitUsd, 21);
});

test("invalid or non-USD-normalized P&L is rejected", () => {
  assert.throws(() => aggregatePortfolioProfitProtection({
    positions: [{ ...base[0], profitUsd: "8" }]
  }), RangeError);
});
