import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEmergencyGuard } from "../lib/emergency-guard.js";

const base = {
  accountMode: "REAL",
  positions: [{ id: "r1", status: "OPEN", protectiveStopVerified: true }],
  marketDataConnected: true,
  brokerConnected: true,
  killSwitchActive: false,
  quoteAgeMs: 100,
  maxQuoteAgeMs: 1000,
  brokerHeartbeatAgeMs: 100,
  maxBrokerHeartbeatAgeMs: 1000
};

test("healthy account permits entries and risk-reducing actions", () => {
  const result = evaluateEmergencyGuard(base);
  assert.equal(result.status, "READY");
  assert.equal(result.allowNewEntries, true);
  assert.equal(result.allowRiskReducingActions, true);
});

test("kill switch blocks new entries but leaves connected risk exits available", () => {
  const result = evaluateEmergencyGuard({ ...base, killSwitchActive: true });
  assert.equal(result.allowNewEntries, false);
  assert.equal(result.allowRiskReducingActions, true);
  assert.ok(result.reasons.includes("EMERGENCY_KILL_SWITCH_ACTIVE"));
});

test("broker disconnection blocks entries and prevents false close claims", () => {
  const result = evaluateEmergencyGuard({ ...base, brokerConnected: false });
  assert.equal(result.allowNewEntries, false);
  assert.equal(result.allowRiskReducingActions, false);
  assert.ok(result.reasons.includes("BROKER_DISCONNECTED"));
});

test("stale market data blocks new entries and risk-reducing requests", () => {
  const result = evaluateEmergencyGuard({ ...base, quoteAgeMs: 5000 });
  assert.equal(result.allowNewEntries, false);
  assert.equal(result.allowRiskReducingActions, false);
  assert.ok(result.reasons.includes("STALE_MARKET_DATA"));
});

test("REAL open position without verified broker stop blocks new entries", () => {
  const result = evaluateEmergencyGuard({
    ...base,
    positions: [{ id: "r2", status: "OPEN", protectiveStopVerified: false }]
  });
  assert.equal(result.allowNewEntries, false);
  assert.equal(result.allowRiskReducingActions, true);
  assert.deepEqual(result.realPositionsMissingStopLossIds, ["r2"]);
});

test("DEMO positions do not require broker-native stop verification", () => {
  const result = evaluateEmergencyGuard({
    ...base,
    accountMode: "DEMO",
    positions: [{ id: "d1", status: "OPEN" }]
  });
  assert.equal(result.allowNewEntries, true);
});
