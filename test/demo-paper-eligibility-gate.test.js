import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDemoPaperEligibility } from "../lib/demo/paper-eligibility-gate.js";

const base = {
  accountMode: "DEMO",
  sessionStatus: "RUNNING",
  botEnabled: true,
  emergencyStopped: false,
  instrument: "frxXAUUSD",
  instrumentActive: true,
  feedTrust: "SERVER_VERIFIED",
  feedStatus: "LIVE",
  feedTimestamp: 1_800_000_000,
  nowEpoch: 1_800_000_005,
  signal: { status:"SIGNAL", side:"BUY", referencePrice:2000, stopLoss:1990, takeProfit:2020 },
  riskPerTradePct:0.5,
  maxDailyLossPct:2,
  dailyLossPct:0,
  openPositions:0,
  maxOpenPositions:1
};

test("allows only a fully gated DEMO paper simulation candidate", () => {
  const result = evaluateDemoPaperEligibility(base);
  assert.equal(result.eligible, true);
  assert.equal(result.status, "ELIGIBLE_FOR_PAPER_SIMULATION");
  assert.equal(result.paperOnly, true);
  assert.equal(result.feedAgeSeconds, 5);
});

for (const [name, patch, reason] of [
  ["REAL mode", { accountMode:"REAL" }, "DEMO_MODE_REQUIRED"],
  ["stopped session", { sessionStatus:"STOPPED" }, "SESSION_NOT_RUNNING"],
  ["disabled bot", { botEnabled:false }, "BOT_NOT_ENABLED"],
  ["emergency stop", { emergencyStopped:true }, "EMERGENCY_STOP_ACTIVE"],
  ["inactive instrument", { instrumentActive:false }, "INSTRUMENT_NOT_ACTIVE"],
  ["unverified feed", { feedTrust:"CLIENT_SUPPLIED" }, "SERVER_VERIFIED_LIVE_FEED_REQUIRED"],
  ["delayed feed", { feedStatus:"DELAYED" }, "SERVER_VERIFIED_LIVE_FEED_REQUIRED"],
  ["stale feed", { feedTimestamp:1_799_999_900 }, "MARKET_DATA_STALE"],
  ["daily loss limit", { dailyLossPct:2 }, "DAILY_LOSS_LIMIT_REACHED"],
  ["position limit", { openPositions:1 }, "MAX_OPEN_POSITIONS_REACHED"],
  ["invalid risk", { riskPerTradePct:2.1 }, "INVALID_RISK_CONFIGURATION"],
  ["invalid signal levels", { signal:{status:"SIGNAL",side:"BUY",referencePrice:2000,stopLoss:2010,takeProfit:2020} }, "INVALID_SIGNAL_PROTECTIVE_LEVELS"]
]) {
  test("blocks " + name, () => {
    const result = evaluateDemoPaperEligibility({ ...base, ...patch });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, reason);
    assert.equal(result.paperOnly, true);
  });
}

test("blocks future feed timestamps", () => {
  const result = evaluateDemoPaperEligibility({ ...base, feedTimestamp:1_800_000_100 });
  assert.equal(result.reason, "FEED_TIMESTAMP_FROM_FUTURE");
});

test("blocks missing signal", () => {
  const result = evaluateDemoPaperEligibility({ ...base, signal:null });
  assert.equal(result.reason, "VALID_TRADE_SIGNAL_REQUIRED");
});
