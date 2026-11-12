import test from "node:test";
import assert from "node:assert/strict";
import { decideDemoAutoAction } from "../lib/demo-auto-decision.js";

const now = 1_800_000_000_000;
const base = {
  session: {
    status: "RUNNING", account_mode: "DEMO", current_balance: 10000,
    max_risk_per_trade_pct: 0.5, worker_last_candle_as_of: null
  },
  settings: {
    broker: "DERIV", account_mode: "DEMO", instrument: "XAUUSD",
    timeframe: "M15", strategy: "MULTI_CONFIRMATION_V1"
  },
  quote: { source: "DERIV", quote: 120, quoteAsOf: new Date(now - 1000).toISOString() },
  market: {
    source: "DERIV", timeframe: "M15",
    latestCandleAsOf: new Date(now - 900000).toISOString(),
    candles: Array.from({ length: 40 }, (_, i) => {
      const open = 100 + i * 0.5;
      return { epoch: now / 1000 - (40 - i) * 900, open, high: open + 0.6, low: open - 0.2, close: open + 0.5 };
    })
  }
};

test("opens a virtual position only on a new confirmed BUY/SELL candle", () => {
  const result = decideDemoAutoAction({ ...base, now });
  assert.equal(result.action, "OPEN");
  assert.equal(result.direction, "BUY");
  assert.ok(result.stop < result.entry);
  assert.ok(result.target > result.entry);
  assert.ok(result.units > 0);
  assert.ok(result.riskAmount <= 50.01);
});

test("does not process the same completed candle twice", () => {
  const input = structuredClone(base);
  input.session.worker_last_candle_as_of = input.market.latestCandleAsOf;
  assert.deepEqual(decideDemoAutoAction({ ...input, now }), {
    action: "WAIT", reason: "CANDLE_ALREADY_PROCESSED"
  });
});

test("waits and checkpoints a candle when strategy confirmations are mixed", () => {
  const input = structuredClone(base);
  input.market.candles = Array.from({ length: 40 }, (_, i) => {
    const open = i % 2 ? 100 : 101;
    return { epoch: now / 1000 - (40 - i) * 900, open, high: 102, low: 99, close: open };
  });
  const result = decideDemoAutoAction({ ...input, now });
  assert.equal(result.action, "WAIT");
  assert.equal(result.reason, "NO_CONFIRMED_SIGNAL");
  assert.ok(result.candleAsOf);
});

test("closes a BUY at stop loss and computes the paper P&L", () => {
  const input = structuredClone(base);
  input.market = null;
  input.openTrade = {
    id: "trade-1", symbol: "XAUUSD", direction: "BUY",
    entry_price: 120, stop_loss: 118, take_profit: 124, virtual_units: 2, status: "OPEN"
  };
  input.quote.quote = 117.9;
  const result = decideDemoAutoAction({ ...input, now });
  assert.equal(result.action, "CLOSE");
  assert.equal(result.reason, "STOP_LOSS");
  assert.equal(result.unrealizedPnl, -4.2);
});

test("marks a position while neither stop nor target has been reached", () => {
  const input = structuredClone(base);
  input.market = null;
  input.openTrade = {
    id: "trade-2", symbol: "XAUUSD", direction: "SELL",
    entry_price: 120, stop_loss: 124, take_profit: 114, virtual_units: 2, status: "OPEN"
  };
  input.quote.quote = 119;
  assert.equal(decideDemoAutoAction({ ...input, now }).action, "MARK");
});

test("fails closed for REAL sessions, unsupported strategy and stale quotes", () => {
  const real = structuredClone(base);
  real.session.account_mode = "REAL";
  assert.equal(decideDemoAutoAction({ ...real, now }).reason, "SESSION_NOT_RUNNING_DEMO");

  const unsupported = structuredClone(base);
  unsupported.settings.strategy = "MANUAL_REVIEW";
  assert.equal(decideDemoAutoAction({ ...unsupported, now }).reason, "STRATEGY_NOT_VALIDATED");

  const stale = structuredClone(base);
  stale.quote.quoteAsOf = new Date(now - 60000).toISOString();
  assert.equal(decideDemoAutoAction({ ...stale, now }).reason, "QUOTE_NOT_FRESH");
});
