import test from "node:test";
import assert from "node:assert/strict";
import { createBrokerAdapterRegistry, validateBrokerPortfolioSnapshot } from "../lib/broker-adapter-contract.js";

const scope = { userId: "u1", accountMode: "DEMO", broker: "MT5", accountRef: "a1" };
const snapshot = {
  source: "verified-mt5",
  asOf: new Date(1_000_000).toISOString(),
  maxAgeMs: 5000,
  positions: [{
    id: "ticket-1", userId: "u1", accountMode: "DEMO", broker: "MT5",
    accountRef: "a1", source: "BOT", status: "OPEN", profitUsd: 21,
    profitCurrency: "USD"
  }]
};

test("accepts a fresh position only when account identity and USD valuation match", () => {
  assert.equal(validateBrokerPortfolioSnapshot(snapshot, scope, 1_001_000).ok, true);
  assert.equal(validateBrokerPortfolioSnapshot(snapshot, scope, 1_006_000).reason, "STALE_MARKET_DATA");
  const wrongCurrency = structuredClone(snapshot);
  wrongCurrency.positions[0].profitCurrency = "EUR";
  assert.equal(validateBrokerPortfolioSnapshot(wrongCurrency, scope, 1_001_000).reason, "UNVERIFIED_POSITION_OR_USD_VALUATION");
});

test("registry exposes only complete, correctly named broker adapters", () => {
  const mt5 = { broker: "MT5", loadSnapshot() {}, closePosition() {} };
  const registry = createBrokerAdapterRegistry({ MT5: mt5 });
  assert.equal(registry.supports("MT5"), true);
  assert.equal(registry.supports("DERIV"), false);
  assert.deepEqual(registry.list(), ["MT5"]);
  assert.throws(() => createBrokerAdapterRegistry({ MT5: { broker: "DERIV" } }), TypeError);
});
