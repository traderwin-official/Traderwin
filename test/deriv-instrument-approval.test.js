import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeApprovedInstrument,
  resolveApprovedInstrument
} from "../lib/deriv/instrument-approval.js";

const approved = {
  broker: "DERIV",
  instrument: "frxXAUUSD",
  provider: "DERIV",
  provider_symbol: "frxXAUUSD",
  status: "APPROVED",
  is_active: true,
  approved_by: "admin-user-id",
  approved_at: "2026-11-20T10:00:00.000Z"
};

test("normalizes safe symbols without removing meaningful provider characters", () => {
  assert.equal(normalizeApprovedInstrument(" frxXAUUSD "), "FRXXAUUSD");
  assert.equal(normalizeApprovedInstrument("R_100"), "R_100");
  assert.equal(normalizeApprovedInstrument("bad symbol"), null);
  assert.equal(normalizeApprovedInstrument(null), null);
});

test("allows only an exact active server-approved instrument and provider mapping", () => {
  const result = resolveApprovedInstrument({
    records: [approved],
    broker: "DERIV",
    instrument: "FRXXAUUSD",
    providerSymbol: "frxXAUUSD"
  });
  assert.equal(result.approved, true);
  assert.equal(result.status, "APPROVED_INSTRUMENT");
  assert.equal(result.paperOnly, true);
  assert.equal(result.providerSymbol, "frxXAUUSD");
});

for (const [name, patch, reason] of [
  ["pending", { status: "PENDING", is_active: false, approved_by: null, approved_at: null }, "INSTRUMENT_NOT_APPROVED"],
  ["disabled", { status: "DISABLED", is_active: false }, "INSTRUMENT_NOT_APPROVED"],
  ["inactive approved row", { is_active: false }, "INSTRUMENT_NOT_APPROVED"],
  ["missing approver", { approved_by: null }, "INSTRUMENT_NOT_APPROVED"],
  ["missing approval timestamp", { approved_at: null }, "INSTRUMENT_NOT_APPROVED"],
  ["wrong provider", { provider: "MT5" }, "PROVIDER_SYMBOL_MISMATCH"],
  ["wrong provider symbol", { provider_symbol: "XAUUSD" }, "PROVIDER_SYMBOL_MISMATCH"]
]) {
  test("blocks " + name, () => {
    const result = resolveApprovedInstrument({
      records: [{ ...approved, ...patch }],
      broker: "DERIV",
      instrument: "frxXAUUSD",
      providerSymbol: "frxXAUUSD"
    });
    assert.equal(result.approved, false);
    assert.equal(result.reason, reason);
  });
}

test("deny-by-default when the registry is empty or provider discovery found a symbol only", () => {
  assert.equal(resolveApprovedInstrument({
    records: [], broker: "DERIV", instrument: "R_100", providerSymbol: "R_100"
  }).reason, "INSTRUMENT_NOT_APPROVED");
  assert.equal(resolveApprovedInstrument({
    records: [{ broker: "DERIV", instrument: "R_100", provider: "DERIV", provider_symbol: "R_100" }],
    broker: "DERIV", instrument: "R_100", providerSymbol: "R_100"
  }).reason, "INSTRUMENT_NOT_APPROVED");
});

test("blocks ambiguous duplicate registry rows", () => {
  const result = resolveApprovedInstrument({
    records: [approved, approved],
    broker: "DERIV",
    instrument: "frxXAUUSD",
    providerSymbol: "frxXAUUSD"
  });
  assert.equal(result.reason, "AMBIGUOUS_INSTRUMENT_APPROVAL");
});

test("blocks broker and symbol mismatches", () => {
  assert.equal(resolveApprovedInstrument({
    records: [approved], broker: "MT5", instrument: "frxXAUUSD", providerSymbol: "frxXAUUSD"
  }).reason, "INSTRUMENT_NOT_APPROVED");
  assert.equal(resolveApprovedInstrument({
    records: [approved], broker: "DERIV", instrument: "frxEURUSD", providerSymbol: "frxXAUUSD"
  }).reason, "INSTRUMENT_NOT_APPROVED");
});

test("rejects malformed lookup input", () => {
  assert.equal(resolveApprovedInstrument({
    records: [approved], broker: "UNKNOWN", instrument: "frxXAUUSD", providerSymbol: "frxXAUUSD"
  }).reason, "INVALID_APPROVAL_LOOKUP");
  assert.equal(resolveApprovedInstrument({
    records: [approved], broker: "DERIV", instrument: "frxXAUUSD", providerSymbol: ""
  }).reason, "INVALID_APPROVAL_LOOKUP");
});
