import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/deriv/active-symbols.js";

function makeResponse() {
  let resolveJson;
  const jsonPromise = new Promise((resolve) => { resolveJson = resolve; });
  const res = {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; resolveJson({ statusCode: this.statusCode, body }); return this; }
  };
  return { res, jsonPromise };
}

test("read-only endpoint returns normalized Deriv symbols from server WebSocket", async () => {
  const original = globalThis.WebSocket;
  class MockWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(message) {
      const request = JSON.parse(message);
      assert.equal(request.active_symbols, "brief");
      assert.equal(request.req_id, 7319);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          msg_type: "active_symbols",
          req_id: request.req_id,
          active_symbols: [{
            underlying_symbol: "EURUSD",
            underlying_symbol_name: "EUR/USD",
            underlying_symbol_type: "forex",
            pip_size: 0.00001,
            exchange_is_open: 1,
            is_trading_suspended: 0
          }]
        })
      })));
    }
    close() {}
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: MockWebSocket });
  try {
    const { res, jsonPromise } = makeResponse();
    await handler({ method: "GET" }, res);
    const result = await jsonPromise;
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.provider, "DERIV_PUBLIC_MARKET_DATA");
    assert.equal(result.body.instruments_activated_in_platform, false);
    assert.equal(result.body.symbols[0].symbol, "EURUSD");
  } finally {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original });
  }
});

test("endpoint rejects non-GET methods", async () => {
  const { res } = makeResponse();
  await handler({ method: "POST" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
});

test("endpoint fails safely when server WebSocket support is missing", async () => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: undefined });
  try {
    const { res } = makeResponse();
    await handler({ method: "GET" }, res);
    assert.equal(res.statusCode, 503);
  } finally {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original });
  }
});
