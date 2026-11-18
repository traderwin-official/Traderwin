import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDemoEntryPreflight } from "../lib/demo/demo-entry-preflight.js";

const quote = {
  symbol: "EURUSD", provider: "DERIV_SERVER_ADAPTER", status: "LIVE",
  timestamp: 1000, bid: 1.0999, ask: 1.1001
};
const signal = {
  status: "SIGNAL", instrument: "EURUSD", side: "BUY",
  referencePrice: 1.1, stopLoss: 1.098, takeProfit: 1.104
};
const portfolioRisk = {
  dayStartEquity: 10000, realizedDailyPnlMoney: 0,
  openPositions: [], maxDailyLossPct: 2, maxPortfolioRiskPct: 2,
  maxOpenPositions: 5
};
const exposureRisk = {
  openPositions: [],
  proposedPosition: {
    symbol: "EURUSD", riskGroup: "FX_MAJOR", direction: "BUY",
    riskMoney: 25, notionalExposureMoney: 1000
  },
  maxRiskGroupRiskMoney: 100,
  maxRiskGroupExposureMoney: 5000,
  maxCorrelatedRiskMoney: 50
};
const base = {
  accountMode: "DEMO", sessionStatus: "RUNNING", botEnabled: true,
  instrument: "EURUSD", quote, nowEpoch: 1002, signal,
  sizing: { status: "VALIDATED", quantity: 0.01, proposedRiskMoney: 25 },
  brokerConstraintsPassed: true, marginCheckPassed: true,
  portfolioRisk, exposureRisk
};

test("approves only a fully checked DEMO preflight", () => {
  const result = evaluateDemoEntryPreflight(base);
  assert.equal(result.allowed, true);
  assert.equal(result.status, "ELIGIBLE_FOR_DEMO_PAPER_ENTRY");
  assert.equal(result.paperOnly, true);
});

test("rejects REAL mode, stopped sessions and disabled bots", () => {
  assert.equal(evaluateDemoEntryPreflight({ ...base, accountMode: "REAL" }).reason, "DEMO_MODE_REQUIRED");
  assert.equal(evaluateDemoEntryPreflight({ ...base, sessionStatus: "STOPPED" }).reason, "SESSION_NOT_RUNNING");
  assert.equal(evaluateDemoEntryPreflight({ ...base, botEnabled: false }).reason, "BOT_NOT_ENABLED");
});

test("rejects browser/untrusted, stale, future or mismatched quotes", () => {
  assert.equal(evaluateDemoEntryPreflight({ ...base, quote: { ...quote, provider: "BROWSER" } }).reason, "INVALID_SERVER_MARKET_SNAPSHOT");
  assert.equal(evaluateDemoEntryPreflight({ ...base, nowEpoch: 1020 }).reason, "MARKET_SNAPSHOT_STALE");
  assert.equal(evaluateDemoEntryPreflight({ ...base, nowEpoch: 990 }).reason, "MARKET_SNAPSHOT_FROM_FUTURE");
  assert.equal(evaluateDemoEntryPreflight({ ...base, quote: { ...quote, symbol: "GBPUSD" } }).reason, "INVALID_SERVER_MARKET_SNAPSHOT");
});

test("rejects invalid signal, mismatched instrument and stale price reference", () => {
  assert.equal(evaluateDemoEntryPreflight({ ...base, signal: { ...signal, instrument: "GBPUSD" } }).reason, "VALID_INSTRUMENT_SIGNAL_REQUIRED");
  assert.equal(evaluateDemoEntryPreflight({ ...base, signal: { ...signal, referencePrice: 1.2 } }).reason, "SIGNAL_PRICE_OUTSIDE_CURRENT_QUOTE");
});

test("rejects unsafe lot size, broker constraints or margin", () => {
  assert.equal(evaluateDemoEntryPreflight({ ...base, sizing: { status: "VALIDATED", quantity: 0, proposedRiskMoney: 25 } }).reason, "BROKER_SIZING_OR_MARGIN_CHECK_FAILED");
  assert.equal(evaluateDemoEntryPreflight({ ...base, brokerConstraintsPassed: false }).reason, "BROKER_SIZING_OR_MARGIN_CHECK_FAILED");
  assert.equal(evaluateDemoEntryPreflight({ ...base, marginCheckPassed: false }).reason, "BROKER_SIZING_OR_MARGIN_CHECK_FAILED");
});

test("blocks when portfolio daily risk guardian rejects", () => {
  const result = evaluateDemoEntryPreflight({
    ...base, portfolioRisk: { ...portfolioRisk, realizedDailyPnlMoney: -200 }
  });
  assert.equal(result.reason, "DAILY_LOSS_LIMIT_REACHED");
});

test("blocks when exposure/correlation guard rejects", () => {
  const result = evaluateDemoEntryPreflight({
    ...base,
    exposureRisk: {
      ...exposureRisk,
      openPositions: [{
        symbol: "GBPUSD", riskGroup: "FX_MAJOR", direction: "BUY",
        riskMoney: 40, notionalExposureMoney: 1000
      }],
      correlationDataComplete: false
    }
  });
  assert.equal(result.reason, "CORRELATION_DATA_NOT_VERIFIED");
});

test("emergency stop always blocks", () => {
  assert.equal(evaluateDemoEntryPreflight({ ...base, emergencyStopped: true }).reason, "EMERGENCY_STOP_ACTIVE");
});
