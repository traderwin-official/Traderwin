import test from "node:test";
import assert from "node:assert/strict";
import { fetchAccountScopedWsSnapshot } from "../api/deriv/account-snapshot.js";

class FakeWebSocket extends EventTarget {
  constructor(url, fail = false) {
    super();
    this.url = url;
    this.fail = fail;
    this.sent = [];
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(raw) {
    const request = JSON.parse(raw);
    this.sent.push(request);
    queueMicrotask(() => {
      const payload = this.fail
        ? { req_id: request.req_id, error: { code: "InvalidSession" } }
        : request.req_id === 7101
          ? { req_id: 7101, msg_type: "balance", balance: { loginid: "VRTC12345", balance: 100, currency: "USD" } }
          : { req_id: 7102, msg_type: "portfolio", portfolio: { contracts: [] } };
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
    });
  }
  close() { this.dispatchEvent(new Event("close")); }
}

test("requests balance and portfolio over the supplied account-scoped websocket", async () => {
  let instance;
  class CaptureSocket extends FakeWebSocket {
    constructor(url) { super(url); instance = this; }
  }
  const result = await fetchAccountScopedWsSnapshot(
    "wss://api.derivws.com/trading/v1/options/ws/demo?otp=opaque",
    CaptureSocket
  );
  assert.equal(result.balance.balance.loginid, "VRTC12345");
  assert.deepEqual(result.portfolio.portfolio.contracts, []);
  assert.deepEqual(instance.sent, [{ balance: 1, req_id: 7101 }, { portfolio: 1, req_id: 7102 }]);
});

test("blocks authenticated websocket provider errors", async () => {
  class ErrorSocket extends FakeWebSocket {
    constructor(url) { super(url, true); }
  }
  await assert.rejects(
    fetchAccountScopedWsSnapshot("wss://api.derivws.com/trading/v1/options/ws/demo?otp=opaque", ErrorSocket),
    /DERIV_ACCOUNT_WS_PROVIDER_ERROR/
  );
});
