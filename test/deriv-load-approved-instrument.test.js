import test from "node:test";
import assert from "node:assert/strict";
import { loadApprovedInstrument } from "../lib/deriv/load-approved-instrument.js";

const row = {
  broker: "DERIV", instrument: "XAUUSD", provider: "DERIV",
  provider_symbol: "frxXAUUSD", status: "APPROVED", is_active: true,
  approved_by: "admin-user", approved_at: "2026-11-20T10:00:00.000Z"
};

function fakeDb({ data = [row], error = null } = {}) {
  const calls = [];
  const query = {
    from(table) { calls.push(["from", table]); return this; },
    select(columns) { calls.push(["select", columns]); return this; },
    eq(key, value) { calls.push(["eq", key, value]); return this; },
    limit(count) { calls.push(["limit", count]); return Promise.resolve({ data, error }); }
  };
  return { db: query, calls };
}

test("loads and validates an approved exact provider mapping from the server registry", async () => {
  const { db, calls } = fakeDb();
  const result = await loadApprovedInstrument(db, {
    broker: "deriv", instrument: "xauusd", providerSymbol: "frxXAUUSD"
  });
  assert.equal(result.approved, true);
  assert.equal(result.paperOnly, true);
  assert.deepEqual(calls.slice(0, 2), [
    ["from", "trading_instrument_approvals"],
    ["select", "broker,instrument,provider,provider_symbol,status,is_active,approved_by,approved_at"]
  ]);
  assert.ok(calls.some(x => x[0] === "eq" && x[1] === "instrument" && x[2] === "XAUUSD"));
  assert.ok(calls.some(x => x[0] === "limit" && x[1] === 2));
});

test("fails closed when registry is empty, pending, disabled or provider symbol mismatches", async () => {
  for (const options of [
    { data: [] },
    { data: [{ ...row, status: "PENDING", is_active: false, approved_by: null, approved_at: null }] },
    { data: [{ ...row, status: "DISABLED", is_active: false }] },
    { data: [{ ...row, provider_symbol: "XAUUSD" }] }
  ]) {
    const { db } = fakeDb(options);
    const result = await loadApprovedInstrument(db, {
      broker: "DERIV", instrument: "XAUUSD", providerSymbol: "frxXAUUSD"
    });
    assert.equal(result.approved, false);
  }
});

test("fails closed on registry query errors and malformed database responses", async () => {
  for (const options of [{ error: { message: "database unavailable" } }, { data: null }]) {
    const { db } = fakeDb(options);
    const result = await loadApprovedInstrument(db, {
      broker: "DERIV", instrument: "XAUUSD", providerSymbol: "frxXAUUSD"
    });
    assert.equal(result.approved, false);
    assert.equal(result.reason, "INSTRUMENT_APPROVAL_LOOKUP_FAILED");
  }
});

test("fails closed on invalid lookup input", async () => {
  const { db, calls } = fakeDb();
  const result = await loadApprovedInstrument(db, {
    broker: "DERIV", instrument: "XAUUSD", providerSymbol: ""
  });
  assert.equal(result.reason, "INVALID_APPROVAL_LOOKUP");
  assert.equal(calls.length, 0);
});
