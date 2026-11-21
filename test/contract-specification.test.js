import test from "node:test";
import assert from "node:assert/strict";
import { validateContractSpecification } from "../lib/instruments/contract-specification.js";

const fx = {
  broker: "MT5", instrument: "EURUSD", productType: "FX_CFD",
  quantityUnit: "LOTS", profitCurrency: "USD", quoteCurrency: "USD",
  contractMultiplier: 100000, tickSize: 0.00001, pricePrecision: 5,
  minQuantity: 0.01, maxQuantity: 100, quantityStep: 0.01,
  tickValuePerLot: 1, marginPerLot: 100,
  source: "BROKER_SYMBOL_SPECIFICATION", verifiedAt: "2026-11-21T10:00:00.000Z"
};

test("accepts complete broker-sourced CFD lot metadata without authorizing a trade", () => {
  const result = validateContractSpecification(fx, { broker: "MT5", instrument: "EURUSD" });
  assert.equal(result.ok, true);
  assert.equal(result.specification.tickValuePerLot, 1);
  assert.match(result.note, /does not.*authorize an order/i);
});

test("rejects absent, stale-shaped, mismatched, or incomplete specifications", () => {
  assert.equal(validateContractSpecification(null, { broker: "MT5", instrument: "EURUSD" }).reason,
    "MISSING_CONTRACT_SPECIFICATION");
  assert.equal(validateContractSpecification(fx, { broker: "DERIV", instrument: "EURUSD" }).reason,
    "INVALID_CONTRACT_SPECIFICATION");
  for (const patch of [
    { tickValuePerLot: undefined },
    { marginPerLot: 0 },
    { contractMultiplier: 0 },
    { tickSize: -0.00001 },
    { verifiedAt: "not-a-date" },
    { profitCurrency: "USDT" },
    { quantityStep: 0.04 },
    { maxQuantity: 0.015 }
  ]) {
    const result = validateContractSpecification({ ...fx, ...patch }, { broker: "MT5", instrument: "EURUSD" });
    assert.equal(result.ok, false);
  }
});

test("does not treat Deriv options contracts as CFD lots", () => {
  const options = {
    broker: "DERIV", instrument: "R_100", productType: "DERIV_OPTIONS",
    quantityUnit: "CONTRACTS", profitCurrency: "USD", quoteCurrency: "USD",
    contractMultiplier: 1, tickSize: 0.01, pricePrecision: 2,
    minQuantity: 1, maxQuantity: 1000, quantityStep: 1,
    source: "BROKER_CONTRACT_DETAILS", verifiedAt: "2026-11-21T10:00:00.000Z"
  };
  const result = validateContractSpecification(options, { broker: "DERIV", instrument: "R_100" });
  assert.equal(result.ok, true);
  assert.equal("tickValuePerLot" in result.specification, false);
  assert.equal("marginPerLot" in result.specification, false);
});

test("rejects Deriv options represented as lots or an MT5 options contract", () => {
  const options = {
    broker: "DERIV", instrument: "R__100", productType: "DERIV_OPTIONS",
    quantityUnit: "LOTS", profitCurrency: "USD", quoteCurrency: "USD",
    contractMultiplier: 1, tickSize: 0.01, pricePrecision: 2,
    minQuantity: 1, maxQuantity: 100, quantityStep: 1,
    tickValuePerLot: 1, marginPerLot: 1,
    source: "BROKER_CONTRACT_DETAILS", verifiedAt: "2026-11-21T10:00:00.000Z"
  };
  assert.equal(validateContractSpecification(options, { broker: "DERIV", instrument: "R_100" }).ok, false);
  assert.equal(validateContractSpecification({
    ...options, broker: "MT5", quantityUnit: "CONTRACTS"
  }, { broker: "MT5", instrument: "R_100" }).reason, "UNSUPPORTED_CONTRACT_QUANTITY_SEMANTICS");
});
