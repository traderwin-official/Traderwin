import test from "node:test";
import assert from "node:assert/strict";
import { createMt5BridgeAdapter } from "../lib/mt5-bridge-adapter.js";

const scope = { userId: "user-1", accountMode: "DEMO", broker: "MT5", accountRef: "acct-7" };
const portfolio = {
  accountRef: "acct-7",
  accountMode: "DEMO",
  connected: true,
  quoteSource: "MT5_TERMINAL",
  asOf: new Date(1_000_000).toISOString(),
  maxQuoteAgeMs: 3000,
  emergency: {
    marketDataConnected: true,
    brokerConnected: true,
    killSwitchActive: false,
    brokerHeartbeatAsOf: new Date(1_000_000).toISOString(),
    maxBrokerHeartbeatAgeMs: 5000
  },
  positions: [{
    ticket: 12345,
    source: "MANUAL",
    valuationStatus: "VERIFIED",
    unrealizedProfitUsd: 25.5,
    accountRef: "acct-7",
    accountMode: "DEMO",
    symbol: "XAUUSD",
    direction: "BUY",
    volume: 0.1
  }]
};

function makeAdapter(payload = portfolio, onRequest = () => {}) {
  return createMt5BridgeAdapter({
    baseUrl: "https://mt5-bridge.example.test",
    apiToken: "server-side-test-token-long-enough",
    fetchImpl: async (url, options) => {
      onRequest(url, options);
      return { ok: true, status: 200, json: async () => payload };
    }
  });
}

test("requires HTTPS and a server-side bridge token", () => {
  assert.throws(() => createMt5BridgeAdapter({
    baseUrl: "http://bridge.example.test", apiToken: "server-side-test-token-long-enough"
  }), TypeError);
  assert.throws(() => createMt5BridgeAdapter({
    baseUrl: "https://bridge.example.test", apiToken: "short"
  }), TypeError);
});

test("normalizes verified MT5 account positions and USD P&L", async () => {
  const adapter = makeAdapter();
  const snapshot = await adapter.loadSnapshot(scope);
  assert.equal(snapshot.positions[0].id, "12345");
  assert.equal(snapshot.positions[0].profitUsd, 25.5);
  assert.equal(snapshot.positions[0].broker, "MT5");
  assert.equal(snapshot.maxAgeMs, 3000);
});

test("blocks mismatched account identity and unverified conversion", async () => {
  await assert.rejects(() => makeAdapter({ ...portfolio, accountRef: "other" }).loadSnapshot(scope));
  const unverified = {
    ...portfolio,
    positions: [{ ...portfolio.positions[0], valuationStatus: "UNAVAILABLE" }]
  };
  await assert.rejects(() => makeAdapter(unverified).loadSnapshot(scope));
});

test("sends idempotent close request to the correct MT5 account and ticket", async () => {
  let captured;
  const adapter = makeAdapter({ closed: true, status: "DONE", dealId: 88 }, (url, options) => {
    captured = { url, options };
  });
  const result = await adapter.closePosition({
    broker: "MT5", brokerPositionId: "12345", accountRef: "acct-7",
    accountMode: "DEMO", source: "MANUAL"
  }, { idempotencyKey: "protect:demo:mt5:12345", reason: "PORTFOLIO_PROFIT_GIVEBACK" });
  assert.equal(result.closed, true);
  assert.match(captured.url, /acct-7\/positions\/12345\/close$/);
  assert.equal(captured.options.headers["Idempotency-Key"], "protect:demo:mt5:12345");
  assert.equal(captured.options.headers.Authorization, "Bearer server-side-test-token-long-enough");
  assert.equal(JSON.parse(captured.options.body).expectedPositionSource, "MANUAL");
});
