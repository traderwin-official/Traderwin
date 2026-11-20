import test from "node:test";
import assert from "node:assert/strict";
import { aggregatePortfolioProfitProtection } from "../lib/portfolio-profit-protection.js";

const base = [
  { id: "bot-1", userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "d1", source: "BOT", status: "OPEN", profitUsd: 8, units: 1 },
  { id: "manual-1", userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "d1", source: "MANUAL", status: "OPEN", profitUsd: 7, units: 1 },
  { id: "bot-2", userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "d1", source: "BOT", status: "OPEN", profitUsd: 6, units: 1 }
];
const peakState = (entries) => Object.fromEntries(entries.map(([id, peakProfitPerUnitUsd, units = 1]) =>
  [id, { peakProfitPerUnitUsd, units }]));

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

test("combined portfolio peak is captured at one simultaneous account snapshot and a 20 percent giveback triggers close", () => {
  const positions = base.map(position => ({ ...position, profitUsd: position.source === "MANUAL" ? 30 : 35 }));
  const savedPeaks = peakState([["bot-1", 35], ["bot-2", 35], ["manual-1", 30]]);
  const result = aggregatePortfolioProfitProtection({
    positions, previousPeakProfitUsd: 100,
    previousIncludedPositionIds: ["bot-1", "bot-2", "manual-1"],
    previousPositionPeakState: savedPeaks, manageManualTrades: true
  });
  assert.equal(result.currentProfitUsd, 100);
  assert.equal(result.peakProfitUsd, 100);
  assert.equal(result.protectedFloorUsd, 80);
  assert.equal(result.shouldClose, false);
  const retraced = aggregatePortfolioProfitProtection({
    positions: positions.map(position => ({ ...position, profitUsd: 20 })),
    previousPeakProfitUsd: 100,
    previousIncludedPositionIds: ["bot-1", "bot-2", "manual-1"],
    previousPositionPeakState: savedPeaks, manageManualTrades: true
  });
  assert.equal(retraced.currentProfitUsd, 60);
  assert.equal(retraced.shouldClose, true);
});

test("combined peak snapshot preserves losing position contributions at the same valuation time", () => {
  const peakSnapshot = [
    { ...base[0], profitUsd: 120 },
    { ...base[2], profitUsd: -20 }
  ];
  const first = aggregatePortfolioProfitProtection({ positions: peakSnapshot });
  assert.equal(first.peakProfitUsd, 100);
  assert.equal(first.positionPeakState["bot-1"].peakProfitPerUnitUsd, 120);
  assert.equal(first.positionPeakState["bot-2"].peakProfitPerUnitUsd, -20);

  const retraced = aggregatePortfolioProfitProtection({
    positions: [
      { ...base[0], profitUsd: 90 },
      { ...base[2], profitUsd: -10 }
    ],
    previousPeakProfitUsd: 100,
    previousIncludedPositionIds: first.includedPositionIds,
    previousPositionPeakState: first.positionPeakState
  });
  assert.equal(retraced.currentProfitUsd, 80);
  assert.equal(retraced.peakProfitUsd, 100);
  assert.equal(retraced.shouldClose, true);
});

test("a TP partial close scales the saved combined-peak contribution by remaining volume", () => {
  const positions = [
    { ...base[0], profitUsd: 30, units: 0.6 },
    { ...base[2], profitUsd: 20, units: 1 }
  ];
  const result = aggregatePortfolioProfitProtection({
    positions, previousIncludedPositionIds: ["bot-1", "bot-2"],
    previousPositionPeakState: peakState([["bot-1", 100, 1], ["bot-2", 0, 1]])
  });
  // The old combined peak contribution falls from $100 to $60 with the 40% TP1.
  assert.equal(result.peakProfitUsd, 60);
  assert.equal(result.currentProfitUsd, 50);
  assert.equal(result.protectedFloorUsd, 48);
  assert.equal(result.shouldClose, false);
  assert.equal(result.positionPeakState["bot-1"].units, 0.6);
  assert.equal(result.positionPeakState["bot-1"].peakProfitPerUnitUsd, 100);
});

test("revoking manual management resets the peak for the new managed set", () => {
  const result = aggregatePortfolioProfitProtection({
    positions: base.map(position => ({ ...position, profitUsd: 20 })),
    previousPeakProfitUsd: 100,
    previousIncludedPositionIds: ["bot-1", "bot-2", "manual-1"],
    previousPositionPeakState: peakState([["bot-1", 50], ["bot-2", 30], ["manual-1", 20]])
  });
  assert.equal(result.currentProfitUsd, 40);
  assert.equal(result.peakProfitUsd, 80);
  assert.equal(result.protectedFloorUsd, 64);
  assert.equal(result.membershipChanged, true);
  assert.equal(result.shouldClose, true);
  assert.deepEqual(result.includedPositionIds, ["bot-1", "bot-2"]);
});

test("adding manual management does not sum a new position high into an old combined peak", () => {
  const result = aggregatePortfolioProfitProtection({
    positions: base, previousPeakProfitUsd: 100,
    previousIncludedPositionIds: ["bot-1", "bot-2"],
    previousPositionPeakState: peakState([["bot-1", 50], ["bot-2", 50]]),
    manageManualTrades: true
  });
  assert.equal(result.currentProfitUsd, 21);
  assert.equal(result.peakProfitUsd, 100);
  assert.equal(result.membershipChanged, true);
  assert.equal(result.shouldClose, true);
});

test("unchanged membership retains the previous per-position peak", () => {
  const result = aggregatePortfolioProfitProtection({
    positions: base.map(position => ({ ...position, profitUsd: 20 })),
    previousPeakProfitUsd: 100,
    previousIncludedPositionIds: ["bot-1", "bot-2"],
    previousPositionPeakState: peakState([["bot-1", 50], ["bot-2", 50]])
  });
  assert.equal(result.currentProfitUsd, 40);
  assert.equal(result.peakProfitUsd, 100);
  assert.equal(result.protectedFloorUsd, 80);
  assert.equal(result.shouldClose, true);
  assert.equal(result.membershipChanged, false);
});


test("independent position highs from different times are never summed into a fake portfolio peak", () => {
  const positions = [
    { ...base[0], profitUsd: 0 },
    { ...base[2], profitUsd: 50 }
  ];
  const result = aggregatePortfolioProfitProtection({
    positions, previousPeakProfitUsd: 60,
    previousIncludedPositionIds: ["bot-1", "bot-2"],
    // At the actual combined peak, bot-1 contributed $60 and bot-2 contributed $0.
    // bot-2's later $50 rise cannot be added to bot-1's earlier $60 high.
    previousPositionPeakState: peakState([["bot-1", 60], ["bot-2", 0]])
  });
  assert.equal(result.currentProfitUsd, 50);
  assert.equal(result.peakProfitUsd, 60);
  assert.equal(result.protectedFloorUsd, 48);
  assert.equal(result.shouldClose, false);
});

test("a closed position is removed from the unrealized combined peak", () => {
  const result = aggregatePortfolioProfitProtection({
    positions: [{ ...base[2], profitUsd: 35 }],
    previousPeakProfitUsd: 100,
    previousIncludedPositionIds: ["bot-1", "bot-2"],
    previousPositionPeakState: peakState([["bot-1", 60], ["bot-2", 40]])
  });
  assert.equal(result.peakProfitUsd, 40);
  assert.equal(result.currentProfitUsd, 35);
  assert.equal(result.protectedFloorUsd, 32);
  assert.equal(result.shouldClose, false);
});

test("DEMO and REAL or different broker accounts cannot be mixed", () => {
  assert.throws(() => aggregatePortfolioProfitProtection({
    positions: [base[0], { ...base[1], accountMode: "REAL" }], manageManualTrades: true
  }), RangeError);
});

test("closed positions do not affect the combined open-profit calculation", () => {
  const result = aggregatePortfolioProfitProtection({
    positions: [...base, { ...base[0], id: "closed", status: "CLOSED", profitUsd: 500 }],
    manageManualTrades: true
  });
  assert.equal(result.currentProfitUsd, 21);
});

test("invalid or non-USD-normalized P&L or missing remaining units is rejected", () => {
  assert.throws(() => aggregatePortfolioProfitProtection({ positions: [{ ...base[0], profitUsd: "8" }] }), RangeError);
  assert.throws(() => aggregatePortfolioProfitProtection({ positions: [{ ...base[0], units: 0 }] }), RangeError);
});

test("missing membership snapshot fails safe by resetting the previous peak", () => {
  const result = aggregatePortfolioProfitProtection({ positions: base, previousPeakProfitUsd: 100, manageManualTrades: true });
  assert.equal(result.currentProfitUsd, 21);
  assert.equal(result.peakProfitUsd, 21);
  assert.equal(result.membershipChanged, true);
  assert.equal(result.shouldClose, false);
});

test("invalid previous membership IDs are rejected", () => {
  assert.throws(() => aggregatePortfolioProfitProtection({ positions: base, previousIncludedPositionIds: "bot-1" }), RangeError);
});

test("bot positions are excluded unless bot management is explicitly enabled", () => {
  const result = aggregatePortfolioProfitProtection({ positions: base, manageBotTrades: false, manageManualTrades: true });
  assert.equal(result.currentProfitUsd, 7);
  assert.deepEqual(result.includedPositionIds, ["manual-1"]);
  assert.deepEqual(result.excludedBotPositionIds, ["bot-1", "bot-2"]);
});
