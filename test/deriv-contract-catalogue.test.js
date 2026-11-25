import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDerivContractCatalogue } from "../lib/deriv/contract-catalogue.js";

const response = {
  msg_type: "contracts_for",
  contracts_for: {
    available: [{
      underlying_symbol: "R_100",
      contract_type: "CALL",
      contract_category: "callput",
      expiry_type: "intraday",
      market: "synthetic_index",
      min_contract_duration: "15s",
      max_contract_duration: "1d",
      barriers: 0,
      sentiment: "up"
    }]
  }
};

test("normalizes provider contract types and durations without inventing lot specs", () => {
  const result = normalizeDerivContractCatalogue(response, "R_100");
  assert.equal(result.ok, true);
  assert.deepEqual(result.contracts[0], {
    provider: "DERIV",
    providerSymbol: "R_100",
    contractType: "CALL",
    contractCategory: "callput",
    expiryType: "intraday",
    market: "synthetic_index",
    minDurationSeconds: 15,
    maxDurationSeconds: 86400,
    barriers: 0,
    sentiment: "up",
    source: "DERIV_PUBLIC_CONTRACTS_FOR"
  });
  assert.equal("minLot" in result.contracts[0], false);
  assert.equal("marginPerLot" in result.contracts[0], false);
});

test("rejects malformed responses and mismatched symbols", () => {
  assert.equal(normalizeDerivContractCatalogue({}, "R_100").ok, false);
  assert.equal(normalizeDerivContractCatalogue(response, "EURUSD").reason,
    "NO_VALID_CONTRACT_METADATA");
  assert.equal(normalizeDerivContractCatalogue(response, "../R_100").reason,
    "INVALID_CONTRACTS_FOR_RESPONSE");
});

test("rejects malformed or reversed duration ranges and incomplete records", () => {
  for (const item of [
    { ...response.contracts_for.available[0], min_contract_duration: "soon" },
    { ...response.contracts_for.available[0], min_contract_duration: "2d", max_contract_duration: "1d" },
    { ...response.contracts_for.available[0], contract_type: "" },
    { ...response.contracts_for.available[0], underlying_symbol: "R_50" }
  ]) {
    const result = normalizeDerivContractCatalogue({
      ...response, contracts_for: { available: [item] }
    }, "R_100");
    assert.equal(result.ok, false);
  }
});

test("deduplicates equivalent contract catalogue entries", () => {
  const item = response.contracts_for.available[0];
  const result = normalizeDerivContractCatalogue({
    ...response, contracts_for: { available: [item, item] }
  }, "R_100");
  assert.equal(result.contracts.length, 1);
});
