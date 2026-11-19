import test from "node:test";
import assert from "node:assert/strict";
import { getDerivQuoteToUsd } from "../lib/usd-conversion.js";

const now = 1_800_000_000_000;
const quote = (instrument, price, asOf = now - 1000) => ({
  source: "DERIV",
  instrument,
  providerSymbol: instrument,
  quote: price,
  quoteAsOf: new Date(asOf).toISOString()
});

test("USD-quoted instruments use a unit conversion without another feed request", async () => {
  let requests = 0;
  const result = await getDerivQuoteToUsd("XAUUSD", quote("XAUUSD", 2350), {
    now: () => now,
    getQuote: async () => { requests += 1; throw new Error("unexpected conversion request"); }
  });
  assert.equal(result.rate, 1);
  assert.equal(result.source, "USD_QUOTED_INSTRUMENT");
  assert.equal(requests, 0);
});

test("USDJPY uses the inverse USDJPY quote to value JPY in USD", async () => {
  const result = await getDerivQuoteToUsd("USDJPY", quote("USDJPY", 150), { now: () => now });
  assert.equal(result.rate, 1 / 150);
  assert.equal(result.instrument, "USDJPY");
});

test("cross-currency pairs use a fresh quote-currency-to-USD conversion", async () => {
  const result = await getDerivQuoteToUsd("EURGBP", quote("EURGBP", 0.85), {
    now: () => now,
    getQuote: async symbol => {
      assert.equal(symbol, "GBPUSD");
      return quote("GBPUSD", 1.25, now - 1500);
    }
  });
  assert.equal(result.rate, 1.25);
  assert.equal(result.instrument, "GBPUSD");
});

test("stale or unsupported conversion quotes fail closed", async () => {
  await assert.rejects(
    getDerivQuoteToUsd("EURGBP", quote("EURGBP", 0.85), {
      now: () => now,
      getQuote: async () => quote("GBPUSD", 1.25, now - 60000)
    }),
    /fresh, matching USD conversion/
  );
  await assert.rejects(
    getDerivQuoteToUsd("R_10", quote("R_10", 100), { now: () => now }),
    /not verified/
  );
});

test("a quote for the wrong instrument cannot be used for USD conversion", async () => {
  await assert.rejects(
    getDerivQuoteToUsd("EURUSD", quote("GBPUSD", 1.25), { now: () => now }),
    /verified instrument quote/
  );
});

test("rejects a conversion response whose instrument identity does not match the requested pair", async () => {
  await assert.rejects(
    getDerivQuoteToUsd("EURGBP", quote("EURGBP", 0.85), {
      now: () => now,
      getQuote: async () => ({ ...quote("EURUSD", 1.08), providerSymbol: "frxGBPUSD" })
    }),
    /fresh, matching USD conversion/
  );
});
