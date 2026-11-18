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
