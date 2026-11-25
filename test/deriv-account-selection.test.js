import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeVerifiedDerivAccounts,
  selectUnambiguousAccountId
} from "../lib/deriv-accounts.js";

test("normalizes active verified Deriv DEMO and REAL accounts without secrets", () => {
  const accounts = normalizeVerifiedDerivAccounts({
    data: [
      { account_id: "VRTC123", account_type: "demo", status: "active", currency: "USD", token: "must-not-copy" },
      { account_id: "CR123", account_type: "real", status: "active", currency: "USD" },
      { account_id: "OLD1", account_type: "demo", status: "disabled" },
      { account_id: "VRTC123", account_type: "demo", status: "active" },
      { account_id: 123, account_type: "demo", status: "active" }
    ]
  });
  assert.deepEqual(accounts, [
    { account_id: "VRTC123", account_type: "demo", currency: "USD", status: "active", group: null },
    { account_id: "CR123", account_type: "real", currency: "USD", status: "active", group: null }
  ]);
  assert.equal(JSON.stringify(accounts).includes("must-not-copy"), false);
});

test("does not silently choose between multiple DEMO accounts", () => {
  assert.equal(selectUnambiguousAccountId([
    { account_id: "D1", account_type: "demo", status: "active" },
    { account_id: "D2", account_type: "demo", status: "active" }
  ], "demo"), null);
});

test("selects the sole DEMO account only when unambiguous", () => {
  assert.equal(selectUnambiguousAccountId([
    { account_id: "D1", account_type: "demo", status: "active" },
    { account_id: "R1", account_type: "real", status: "active" }
  ], "demo"), "D1");
});

test("Deriv account listing and selection endpoints keep REAL execution disabled", async () => {
  const accounts = await readFile(new URL("../handlers/deriv/accounts.js", import.meta.url), "utf8");
  const select = await readFile(new URL("../handlers/deriv/select-account.js", import.meta.url), "utf8");
  assert.match(accounts, /auth\.getUser/);
  assert.match(accounts, /real_trading_enabled: false/);
  assert.doesNotMatch(accounts, /encrypted_access_token/);
  assert.match(select, /account_type.*demo/s);
  assert.match(select, /demo_account_id: accountId/);
  assert.match(select, /REAL accounts remain locked/);
  assert.doesNotMatch(select, /real_account_id\s*:/);
});
