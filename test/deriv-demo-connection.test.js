import test from "node:test";
import assert from "node:assert/strict";
import { isVerifiedActiveDerivDemoConnection } from "../lib/deriv-demo-connection.js";

const now = Date.parse("2026-11-26T12:00:00.000Z");
const valid = {
  demo_account_id: "VRTC12345",
  token_expires_at: "2026-11-26T13:00:00.000Z",
  accounts: [
    { account_id: "VRTC12345", account_type: "demo", status: "active" },
    { account_id: "CR12345", account_type: "real", status: "active" }
  ]
};

test("only the selected active DEMO account with an unexpired authorization is verified", () => {
  assert.equal(isVerifiedActiveDerivDemoConnection(valid, now), true);
});

test("expired, missing, or malformed authorizations are rejected", () => {
  for (const connection of [
    { ...valid, token_expires_at: "2026-11-26T11:59:59.000Z" },
    { ...valid, token_expires_at: "not-a-date" },
    { ...valid, token_expires_at: null },
    { ...valid, demo_account_id: null },
    null
  ]) assert.equal(isVerifiedActiveDerivDemoConnection(connection, now), false);
});

test("a selected REAL account or inactive DEMO account cannot authorize scalping entries", () => {
  assert.equal(isVerifiedActiveDerivDemoConnection({
    ...valid, demo_account_id: "CR12345"
  }, now), false);
  assert.equal(isVerifiedActiveDerivDemoConnection({
    ...valid, accounts: [{ ...valid.accounts[0], status: "inactive" }]
  }, now), false);
});

test("an unrelated active DEMO account does not satisfy the selected-account check", () => {
  assert.equal(isVerifiedActiveDerivDemoConnection({
    ...valid, accounts: [{ account_id: "VRTC99999", account_type: "demo", status: "active" }]
  }, now), false);
});
