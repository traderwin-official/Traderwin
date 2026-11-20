import test from "node:test";
import assert from "node:assert/strict";
import { getDerivPublicMarketSnapshot } from "../lib/deriv/public-market-snapshot.js";

const now = 1_800_000_000_000;
const baseTick = {
  instrument: "EURUSD", providerSymbol: "frxEURUSD", source: "DERIV",
  quote: 1.1, quoteAsOf: new Date(now).toISOString(),
  bid: 1.0999, ask: 1.1001,
  bidAsOf: new Date(now).toISOString(), askAsOf: new Date(now).toISOString(),
  receivedAt: new Date(now).toISOString()
};
const options = { now: () => now, getQuote: async () => baseTick };

test("returns a trusted snapshot from actual provider bid and ask fields", async () => {
  const snapshot = await getDerivPublicMarketSnapshot("EURUSD", options);
  assert.equal(snapshot.provider, "DERIV_SERVER_ADAPTER");
  assert.equal(snapshot.providerSymbol, "frxEURUSD");
  assert.equal(snapshot.bid, 1.0999);
  assert.equal(snapshot.ask, 1.1001);
  assert.equal(snapshot.timestampEpoch, now / 1000);
  assert.equal(snapshot.isTrusted, true);
});

test("blocks when Deriv omits either optional side instead of synthesizing a spread", async () => {
  await assert.rejects(getDerivPublicMarketSnapshot("EURUSD", {
    ...options, getQuote: async () => ({ ...baseTick, bid: undefined, bidAsOf: undefined })
  }), /did not provide a valid same-tick bid\/ask/);
  await assert.rejects(getDerivPublicMarketSnapshot("EURUSD", {
    ...options, getQuote: async () => ({ ...baseTick, ask: undefined, askAsOf: undefined })
  }), /did not provide a valid same-tick bid\/ask/);
});

test("blocks invalid, zero, negative and crossed markets", async () => {
  for (const patch of [
    { bid: 0 }, { ask: -1 }, { bid: 1.2, ask: 1.1 }, { bid: NaN }, { ask: Infinity }
  ]) {
    await assert.rejects(getDerivPublicMarketSnapshot("EURUSD", {
      ...options, getQuote: async () => ({ ...baseTick, ...patch })
    }), /did not provide a valid same-tick bid\/ask/);
  }
});

test("blocks instrument and provider identity mismatches", async () => {
  await assert.rejects(getDerivPublicMarketSnapshot("EURUSD", {
    ...options, getQuote: async () => ({ ...baseTick, instrument: "GBPUSD" })
  }), /did not provide a valid same-tick bid\/ask/);
  await assert.rejects(getDerivPublicMarketSnapshot("EURUSD", {
    ...options, getQuote: async () => ({ ...baseTick, source: "BROWSER" })
  }), /did not provide a valid same-tick bid\/ask/);
});

test("blocks stale or future-dated bid/ask snapshots", async () => {
  await assert.rejects(getDerivPublicMarketSnapshot("EURUSD", {
    ...options, getQuote: async () => ({
      ...baseTick, quoteAsOf: new Date(now - 31_000).toISOString(),
      bidAsOf: new Date(now - 31_000).toISOString(), askAsOf: new Date(now - 31_000).toISOString()
    })
  }), /stale or has an invalid timestamp/);
  await assert.rejects(getDerivPublicMarketSnapshot("EURUSD", {
    ...options, getQuote: async () => ({
      ...baseTick, quoteAsOf: new Date(now + 6_000).toISOString(),
      bidAsOf: new Date(now + 6_000).toISOString(), askAsOf: new Date(now + 6_000).toISOString()
    })
  }), /stale or has an invalid timestamp/);
});

test("blocks bid/ask values with timestamps that do not match the same tick", async () => {
  await assert.rejects(getDerivPublicMarketSnapshot("EURUSD", {
    ...options, getQuote: async () => ({ ...baseTick, askAsOf: new Date(now - 1000).toISOString() })
  }), /did not provide a valid same-tick bid\/ask/);
});
