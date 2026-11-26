import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDerivConnectionStatus } from "../lib/deriv-connection-status.js";

const future = "2030-01-01T00:00:00.000Z";
const base = {
  demo_account_id: "VRTC123",
  token_expires_at: future,
  connected_at: "2026-11-26T00:00:00.000Z",
  accounts: [
    { account_id: "VRTC123", account_type: "demo", status: "active" },
    { account_id: "CR123", account_type: "real", status: "active" }
  ]
};

test("Deriv status is connected only for an unexpired token and matching active verified DEMO account", () => {
  const status = evaluateDerivConnectionStatus(base, Date.parse("2026-11-26T00:00:00.000Z"));
  assert.equal(status.connected, true);
  assert.equal(status.connectionState, "CONNECTED");
  assert.equal(status.demoAccountVerified, true);
  assert.equal(status.demoAccountId, "VRTC123");
  assert.equal(status.realAccountAvailable, true);
  assert.equal(status.realTradingEnabled, false);
});

test("Deriv status rejects an unexpired token when selected DEMO account is absent from verified account list", () => {
  const status = evaluateDerivConnectionStatus({
    ...base,
    accounts: [{ account_id: "OTHER", account_type: "demo", status: "active" }]
  }, Date.parse("2026-11-26T00:00:00.000Z"));
  assert.equal(status.connected, false);
  assert.equal(status.connectionState, "DEMO_ACCOUNT_REQUIRES_REVERIFICATION");
  assert.equal(status.demoAccountId, null);
});

test("Deriv status rejects suspended and REAL accounts as selected DEMO accounts", () => {
  for (const account of [
    { account_id: "VRTC123", account_type: "demo", status: "suspended" },
    { account_id: "VRTC123", account_type: "real", status: "active" }
  ]) {
    const status = evaluateDerivConnectionStatus({ ...base, accounts: [account] }, Date.parse("2026-11-26T00:00:00.000Z"));
    assert.equal(status.connected, false);
    assert.equal(status.demoAccountVerified, false);
  }
});

test("Deriv status marks expired authorization disconnected and does not expose unverified account IDs", () => {
  const status = evaluateDerivConnectionStatus({
    ...base,
    token_expires_at: "2026-01-01T00:00:00.000Z"
  }, Date.parse("2026-11-26T00:00:00.000Z"));
  assert.equal(status.connected, false);
  assert.equal(status.connectionState, "AUTHORIZATION_EXPIRED");
  assert.equal(status.tokenValid, false);
  assert.equal(status.demoAccountId, null);
});
