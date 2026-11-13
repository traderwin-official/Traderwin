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

test("Tiger Fibonacci Psychology is accepted by the DEMO decision engine", () => {
  const input = structuredClone(base);
  input.settings.strategy = "TIGER_FIBONACCI_PSYCHOLOGY_V1";
  const result = decideDemoAutoAction({ ...input, now });
  assert.ok(["WAIT", "OPEN"].includes(result.action));
  assert.notEqual(result.reason, "STRATEGY_NOT_VALIDATED");
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
    entry_price: 120, stop_loss: 118, take_profit: 126, tp1_price: 122, tp2_price: 124, tp3_price: 126, tp1_done: false, tp2_done: false, tp3_done: false, virtual_units: 2, status: "OPEN"
  };
  input.quote.quote = 117.9;
  const result = decideDemoAutoAction({ ...input, now });
  assert.equal(result.action, "CLOSE");
  assert.equal(result.reason, "STOP_LOSS");
  assert.ok(Math.abs(result.unrealizedPnl + 4.2) < 1e-9);
});

test("marks a position while neither stop nor target has been reached", () => {
  const input = structuredClone(base);
  input.market = null;
  input.openTrade = {
    id: "trade-2", symbol: "XAUUSD", direction: "SELL",
    entry_price: 120, stop_loss: 124, take_profit: 108, tp1_price: 116, tp2_price: 112, tp3_price: 108, tp1_done: false, tp2_done: false, tp3_done: false, virtual_units: 2, status: "OPEN"
  };
  input.quote.quote = 119;
  assert.equal(decideDemoAutoAction({ ...input, now }).action, "MARK");
});

test("fails closed for REAL sessions, unsupported strategy and stale quotes", () => {
  const real = structuredClone(base);
  real.session.account_mode = "REAL";
  assert.equal(decideDemoAutoAction({ ...real, now }).reason, "SESSION_NOT_RUNNING_DEMO");

  const unsupported = structuredClone(base);
  unsupported.settings.strategy = "NOT_A_REAL_STRATEGY";
  assert.equal(decideDemoAutoAction({ ...unsupported, now }).reason, "STRATEGY_NOT_VALIDATED");
  const manual = structuredClone(base);
  manual.settings.strategy = "MANUAL_REVIEW";
  assert.equal(decideDemoAutoAction({ ...manual, now }).reason, "MANUAL_REVIEW_NO_AUTO");

  const stale = structuredClone(base);
  stale.quote.quoteAsOf = new Date(now - 60000).toISOString();
  assert.equal(decideDemoAutoAction({ ...stale, now }).reason, "QUOTE_NOT_FRESH");
});

test("paused session continues to manage an existing bot position but never opens a new one", () => {
  const paused = structuredClone(base);
  paused.session.status = "PAUSED";
  paused.market = null;
  paused.openTrade = {
    id: "paused-trade", symbol: "XAUUSD", direction: "BUY",
    entry_price: 120, stop_loss: 118, take_profit: 126, tp1_price: 122, tp2_price: 124, tp3_price: 126, tp1_done: false, tp2_done: false, tp3_done: false, virtual_units: 2, status: "OPEN"
  };
  paused.quote.quote = 119;
  assert.equal(decideDemoAutoAction({ ...paused, now }).action, "MARK");

  const noPosition = structuredClone(base);
  noPosition.session.status = "PAUSED";
  assert.equal(decideDemoAutoAction({ ...noPosition, now }).reason, "SESSION_PAUSED_NO_OPEN_POSITION");
});

test("existing DEMO BOT position remains manageable after the member changes future broker preferences", () => {
  const input = structuredClone(base);
  input.settings.broker = "MetaTrader 5";
  input.settings.account_mode = "REAL";
  input.market = null;
  input.openTrade = {
    id: "existing-deriv-trade", symbol: "XAUUSD", direction: "BUY",
    entry_price: 120, stop_loss: 118, take_profit: 126, tp1_price: 122, tp2_price: 124, tp3_price: 126, tp1_done: false, tp2_done: false, tp3_done: false, virtual_units: 2, status: "OPEN"
  };
  input.quote.instrument = "XAUUSD";
  input.quote.quote = 119;
  assert.equal(decideDemoAutoAction({ ...input, now }).action, "MARK");
});
