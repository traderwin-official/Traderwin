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
  quote: { source: "DERIV", instrument: "XAUUSD", providerSymbol: "frxXAUUSD", quoteToUsd: 1, quote: 120, quoteAsOf: new Date(now - 1000).toISOString() },
  market: {
    source: "DERIV", instrument: "XAUUSD", providerSymbol: "frxXAUUSD", timeframe: "M15",
    latestCandleAsOf: new Date(now).toISOString(),
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
  assert.ok(Math.abs((result.target - result.entry) - 3 * (result.entry - result.stop)) < 1e-9);
  assert.ok(result.units > 0);
  assert.ok(result.riskAmount <= 50.01);
});

test("accepts a sweep-and-displacement continuation without requiring consolidation", () => {
  const input = structuredClone(base);
  const candles = input.market.candles;
  const referenceLow = Math.min(...candles.slice(-13, -3).map(c => c.low));
  const referenceHigh = Math.max(...candles.slice(-13, -3).map(c => c.high));
  // A quick downside liquidity sweep that closes back above the old low.
  candles[candles.length - 2] = {
    ...candles[candles.length - 2], open: referenceLow + 0.2,
    low: referenceLow - 0.8, high: referenceLow + 0.35, close: referenceLow + 0.25
  };
  // Immediate bullish displacement; there is no sideways consolidation/retest.
  const priorSweepHigh = Math.max(candles[candles.length - 3].high, candles[candles.length - 2].high);
  const continuationClose = Math.max(referenceLow + 4.0, priorSweepHigh + 0.5);
  candles[candles.length - 1] = {
    ...candles[candles.length - 1], open: referenceLow + 0.3,
    low: referenceLow + 0.2, high: continuationClose + 0.2,
    close: continuationClose
  };  input.quote.quote = candles.at(-1).close;
  const result = decideDemoAutoAction({ ...input, now });
  assert.equal(result.action, "OPEN");
  assert.equal(result.direction, "BUY");
  assert.equal(result.reason, "LIQUIDITY_SWEEP_CONTINUATION");
  assert.equal(result.analysis.indicators.sweepContinuation.sweep, "BULLISH");
});

test("does not treat a liquidity sweep without directional displacement as an entry", () => {
  const input = structuredClone(base);
  const candles = input.market.candles;
  const referenceLow = Math.min(...candles.slice(-13, -3).map(c => c.low));
  candles[candles.length - 2] = {
    ...candles[candles.length - 2], low: referenceLow - 0.8, close: referenceLow + 0.1
  };
  candles[candles.length - 1] = {
    ...candles[candles.length - 1], open: referenceLow + 0.2,
    low: referenceLow + 0.1, high: referenceLow + 0.4, close: referenceLow + 0.25
  };
  const result = decideDemoAutoAction({ ...input, now });
  assert.notEqual(result.reason, "LIQUIDITY_SWEEP_CONTINUATION");
});

test("blocks a new entry during the post-loss cooldown", () => {
  const input = structuredClone(base);
  input.session.lossCooldownUntil = new Date(now + 10 * 60_000).toISOString();
  input.session.consecutiveBotLosses = 1;
  const result = decideDemoAutoAction({ ...input, now });
  assert.equal(result.action, "WAIT");
  assert.equal(result.reason, "POST_LOSS_COOLDOWN");
});

test("requires independent higher-timeframe EMA agreement before opening", () => {
  const input = structuredClone(base);
  input.market.trendTimeframe = "M15";
  input.market.trendCandleAsOf = new Date(now).toISOString();
  input.market.trendCandles = Array.from({ length: 40 }, (_, i) => {
    const open = 140 - i * 0.5;
    return { epoch: now / 1000 - (40 - i) * 900, open, high: open + 0.2, low: open - 0.6, close: open - 0.5 };
  });
  const result = decideDemoAutoAction({ ...input, now });
  assert.equal(result.action, "WAIT");
  assert.equal(result.reason, "HIGHER_TIMEFRAME_TREND_MISMATCH");
  assert.equal(result.higherTimeframeDirection, "SELL");
});

test("blocks missing or stale higher-timeframe candles instead of trusting old trend context", () => {
  const input = structuredClone(base);
  input.market.trendTimeframe = "H1";
  input.market.trendCandleAsOf = new Date(now - 3 * 3600_000).toISOString();
  input.market.trendCandles = input.market.candles;
  const result = decideDemoAutoAction({ ...input, now });
  assert.equal(result.action, "BLOCK");
  assert.equal(result.reason, "HIGHER_TIMEFRAME_DATA_UNAVAILABLE_OR_STALE");
});

test("does not chase an entry after price has stretched from the signal candle", () => {
  const input = structuredClone(base);
  input.quote.quote = 125;
  const result = decideDemoAutoAction({ ...input, now });
  assert.equal(result.action, "WAIT");
  assert.equal(result.reason, "ENTRY_TOO_EXTENDED_FROM_SIGNAL_CANDLE");
});

test("AUTO_SELECT chooses the strongest validated strategy and still waits on unconfirmed setups", () => {
  const input = structuredClone(base);
  input.settings.strategy = "AUTO_SELECT_V1";
  const result = decideDemoAutoAction({ ...input, now });
  assert.equal(result.action, "OPEN");
  assert.equal(result.analysis.strategy, "AUTO_SELECT_V1");
  assert.equal(result.analysis.selectedStrategy, "MULTI_CONFIRMATION_V1");
  assert.equal(result.direction, "BUY");
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

test("blocks a quote for a different instrument than the selected bot instrument", () => {
  const input = structuredClone(base);
  input.quote.instrument = "EURUSD";
  assert.equal(decideDemoAutoAction({ ...input, now }).reason, "MARKET_DATA_SCOPE_INVALID");
});

test("blocks candle history for a different instrument or provider symbol", () => {
  const wrongInstrument = structuredClone(base);
  wrongInstrument.market.instrument = "EURUSD";
  assert.equal(decideDemoAutoAction({ ...wrongInstrument, now }).reason, "MARKET_DATA_SCOPE_INVALID");

  const wrongProvider = structuredClone(base);
  wrongProvider.quote.providerSymbol = "frxEURUSD";
  assert.equal(decideDemoAutoAction({ ...wrongProvider, now }).reason, "MARKET_DATA_SCOPE_INVALID");
});

test("blocks duplicated, out-of-order or timestamp-mismatched candle history", () => {
  const duplicate = structuredClone(base);
  duplicate.market.candles[10].epoch = duplicate.market.candles[9].epoch;
  assert.equal(decideDemoAutoAction({ ...duplicate, now }).reason, "MARKET_DATA_SCOPE_INVALID");

  const wrongAsOf = structuredClone(base);
  wrongAsOf.market.latestCandleAsOf = new Date(now - 900000).toISOString();
  assert.equal(decideDemoAutoAction({ ...wrongAsOf, now }).reason, "MARKET_DATA_SCOPE_INVALID");
});

test("blocks management when a quote does not identify the open position instrument", () => {
  const input = structuredClone(base);
  input.market = null;
  input.openTrade = {
    id: "trade-wrong-symbol", symbol: "XAUUSD", direction: "BUY",
    entry_price: 120, stop_loss: 118, take_profit: 126, tp1_price: 122,
    tp2_price: 124, tp3_price: 126, tp1_done: false, tp2_done: false,
    tp3_done: false, virtual_units: 2, status: "OPEN"
  };
  input.quote.instrument = "EURUSD";
  assert.equal(decideDemoAutoAction({ ...input, now }).reason, "OPEN_TRADE_SCOPE_INVALID");
});

test("blocks missing instrument identity instead of treating two empty symbols as equal", () => {
  const input = structuredClone(base);
  input.settings.instrument = "";
  input.market.instrument = "";
  input.quote.instrument = "";
  assert.equal(decideDemoAutoAction({ ...input, now }).reason, "MARKET_DATA_SCOPE_INVALID");
});

test("risk-locked DEMO sessions may manage an existing position but cannot open a new one", () => {
  const lockedWithTrade = structuredClone(base);
  lockedWithTrade.session.status = "RISK_LOCKED";
  lockedWithTrade.market = null;
  lockedWithTrade.openTrade = {
    id: "risk-locked-open-trade", symbol: "XAUUSD", direction: "BUY",
    entry_price: 120, stop_loss: 118, take_profit: 126, tp1_price: 122,
    tp2_price: 124, tp3_price: 126, tp1_done: false, tp2_done: false,
    tp3_done: false, virtual_units: 2, status: "OPEN"
  };
  lockedWithTrade.quote.quote = 119;
  assert.equal(decideDemoAutoAction({ ...lockedWithTrade, now }).action, "MARK");

  const lockedWithoutTrade = structuredClone(base);
  lockedWithoutTrade.session.status = "RISK_LOCKED";
  assert.equal(decideDemoAutoAction({ ...lockedWithoutTrade, now }).reason, "SESSION_NOT_RUNNING_DEMO");
});

test("blocks DEMO entries and position management when USD conversion is unavailable", () => {
  const input = structuredClone(base);
  delete input.quote.quoteToUsd;
  assert.equal(decideDemoAutoAction({ ...input, now }).reason, "USD_CONVERSION_UNAVAILABLE");
});
