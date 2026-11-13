import test from "node:test";
import assert from "node:assert/strict";
import { getDerivPublicQuote } from "../lib/deriv-public-quote.js";

function mockSocket({ quote = 2345.67, epoch = 1_800_000_000, symbols = ["frxXAUUSD"] } = {}) {
  return class MockWebSocket {
    constructor(url) {
      this.url = url;
      queueMicrotask(() => this.onopen?.());
    }
    send(raw) {
      const request = JSON.parse(raw);
      if (request.active_symbols) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
          msg_type: "active_symbols",
          active_symbols: symbols.map(symbol => ({ symbol }))
        }) }));
      } else if (request.ticks) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
          msg_type: "tick",
          tick: { symbol: request.ticks, quote, epoch }
        }) }));
      }
    }
    close() { this.closed = true; }
  };
}

test("uses Deriv active-symbol catalogue and returns a timestamped XAUUSD quote", async () => {
  const now = 1_800_000_000_000;
  const result = await getDerivPublicQuote("XAUUSD", {
    WebSocketImpl: mockSocket(), now: () => now
  });
  assert.equal(result.providerSymbol, "frxXAUUSD");
  assert.equal(result.quote, 2345.67);
  assert.equal(result.source, "DERIV");
  assert.equal(result.quoteAsOf, new Date(now).toISOString());
});

test("rejects instruments that are not in the Deriv active-symbol catalogue", async () => {
  await assert.rejects(
    getDerivPublicQuote("XAUUSD", {
      WebSocketImpl: mockSocket({ symbols: ["frxEURUSD"] }),
      now: () => 1_800_000_000_000
    }),
    /not currently available/
  );
});

test("rejects stale quotes instead of recording paper trades", async () => {
  await assert.rejects(
    getDerivPublicQuote("XAUUSD", {
      WebSocketImpl: mockSocket({ epoch: 1_799_999_900 }),
      now: () => 1_800_000_000_000
    }),
    /stale or invalid quote/
  );
});

test("does not silently support an unknown market symbol", async () => {
  await assert.rejects(
    getDerivPublicQuote("UNKNOWNPAIR", {
      WebSocketImpl: mockSocket(),
      now: () => 1_800_000_000_000
    }),
    /not yet supported/
  );
});

test("resolves additional six-letter currency pairs only when Deriv lists them as active", async () => {
  const now = 1_800_000_000_000;
  const result = await getDerivPublicQuote("USDNOK", {
    WebSocketImpl: mockSocket({ symbols: ["frxUSDNOK"] }),
    now: () => now
  });
  assert.equal(result.providerSymbol, "frxUSDNOK");
});
