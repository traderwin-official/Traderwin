import test from "node:test";
import assert from "node:assert/strict";
import { getDerivCandles } from "../lib/deriv-candles.js";

function mockSocket({ symbols = ["frxXAUUSD"], candles = [], requests = [] } = {}) {
  return class MockWebSocket {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const request = JSON.parse(raw);
      requests.push(request);
      if (request.active_symbols) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
          msg_type: "active_symbols", active_symbols: symbols.map(symbol => ({ underlying_symbol: symbol }))
        }) }));
      } else if (request.ticks_history) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
          msg_type: "candles", candles
        }) }));
      }
    }
    close() {}
  };
}

test("loads completed Deriv OHLC candles for the requested symbol and timeframe", async () => {
  const now = 1_800_000_000_000;
  const nowSeconds = now / 1000;
  const candles = Array.from({ length: 40 }, (_, i) => {
    const epoch = nowSeconds - (40 - i) * 900;
    const open = 2300 + i;
    return { epoch, open, high: open + 3, low: open - 2, close: open + 1 };
  });
  const result = await getDerivCandles("XAUUSD", "M15", {
    WebSocketImpl: mockSocket({ candles }), now: () => now
  });
  assert.equal(result.providerSymbol, "frxXAUUSD");
  assert.equal(result.timeframe, "M15");
  assert.equal(result.candles.length, 40);
  assert.equal(result.source, "DERIV");
});


test("maps every supported timeframe to the exact Deriv candle granularity", async () => {
  const now = 1_800_000_000_000;
  const nowSeconds = now / 1000;
  for (const [timeframe, granularity] of [["M5", 300], ["H1", 3600], ["H4", 14400]]) {
    const requests = [];
    const candles = Array.from({ length: 40 }, (_, i) => {
      const epoch = nowSeconds - (40 - i) * granularity;
      const open = 2300 + i;
      return { epoch, open, high: open + 3, low: open - 2, close: open + 1 };
    });
    const result = await getDerivCandles("XAUUSD", timeframe, {
      WebSocketImpl: mockSocket({ candles, requests }), now: () => now
    });
    assert.equal(result.timeframe, timeframe);
    assert.equal(result.granularity, granularity);
    const historyRequest = requests.find(request => request.ticks_history);
    assert.equal(historyRequest.ticks_history, "frxXAUUSD");
    assert.equal(historyRequest.granularity, granularity);
  }
});

test("rejects stale candle history", async () => {
  const now = 1_800_000_000_000;
  const nowSeconds = now / 1000;
  const candles = Array.from({ length: 40 }, (_, i) => {
    const epoch = nowSeconds - 40 * 900 - (40 - i) * 900;
    return { epoch, open: 2300, high: 2302, low: 2298, close: 2301 };
  });
  await assert.rejects(
    getDerivCandles("XAUUSD", "M15", {
      WebSocketImpl: mockSocket({ candles }), now: () => now
    }),
    /stale/
  );
});

test("rejects unsupported instruments and timeframes", async () => {
  await assert.rejects(
    getDerivCandles("UNKNOWN", "M15", { WebSocketImpl: mockSocket() }),
    /not supported/
  );
  await assert.rejects(
    getDerivCandles("XAUUSD", "M1", { WebSocketImpl: mockSocket() }),
    /Choose M5/
  );
});
