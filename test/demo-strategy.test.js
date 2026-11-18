import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDemoStrategy } from "../lib/demo/strategy-engine.js";

test("rejects missing candle data", () => {
  assert.equal(evaluateDemoStrategy({ candles: [] }).status, "NO_SIGNAL");
});

test("blocks after daily loss limit", () => {
  const candles = Array.from({ length: 25 }, (_, i) => ({ close: 100 + i }));
  assert.deepEqual(evaluateDemoStrategy({ candles, dailyLossPct: 2, maxDailyLossPct: 2 }), {
    status: "BLOCKED", reason: "DAILY_LOSS_LIMIT_REACHED"
  });
});

test("blocks when maximum open positions is reached", () => {
  const candles = Array.from({ length: 25 }, (_, i) => ({ close: 100 + i }));
  assert.deepEqual(evaluateDemoStrategy({ candles, openPositions: 1, maxOpenPositions: 1 }), {
    status: "BLOCKED", reason: "MAX_OPEN_POSITIONS_REACHED"
  });
});

test("returns no signal for monotonic rising closes without crossover confirmation", () => {
  const candles = Array.from({ length: 25 }, (_, i) => ({ close: 100 + i }));
  const result = evaluateDemoStrategy({ candles });
  assert.equal(result.status, "NO_SIGNAL");
});

test("generates a BUY analysis on a confirmed crossover", () => {
  const closes = [100, 97, 94, 94, 91, 90, 93, 92, 94];
  const result = evaluateDemoStrategy({ candles: closes.map(close => ({ close })), fastPeriod: 3, slowPeriod: 5 });
  assert.equal(result.status, "SIGNAL");
  assert.equal(result.side, "BUY");
  assert.equal(result.referencePrice, 94);
  assert.equal(result.stopLoss, 93.53);
  assert.equal(result.takeProfit, 94.94);
});

test("generates a SELL analysis on a confirmed crossover", () => {
  const closes = [100, 98, 101, 98, 101, 100, 100, 99, 96];
  const result = evaluateDemoStrategy({ candles: closes.map(close => ({ close })), fastPeriod: 3, slowPeriod: 5 });
  assert.equal(result.status, "SIGNAL");
  assert.equal(result.side, "SELL");
});
