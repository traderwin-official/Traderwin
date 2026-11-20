import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePaperExit } from "../lib/demo/paper-exit-engine.js";

const buy = { side: "BUY", entry_price: 100, quantity: 2, stop_loss: 98, take_profit: 104 };
const sell = { side: "SELL", entry_price: 100, quantity: 2, stop_loss: 102, take_profit: 96 };

test("keeps a BUY paper trade open when neither exit is touched", () => {
  assert.equal(evaluatePaperExit({ trade: buy, candle: { open: 100, high: 103, low: 99, close: 102 } }).status, "HOLD");
});

test("closes a BUY at its stop loss", () => {
  const result = evaluatePaperExit({ trade: buy, candle: { open: 100, high: 101, low: 97, close: 99 } });
  assert.equal(result.status, "CLOSED");
  assert.equal(result.exitPrice, 98);
  assert.equal(result.pricePnl, -4);
});

test("closes a SELL at take profit", () => {
  const result = evaluatePaperExit({ trade: sell, candle: { open: 100, high: 101, low: 95, close: 97 } });
  assert.equal(result.exitReason, "TAKE_PROFIT");
  assert.equal(result.exitPrice, 96);
  assert.equal(result.pricePnl, 8);
});

test("uses conservative stop-first outcome when both levels are touched", () => {
  const result = evaluatePaperExit({ trade: buy, candle: { open: 100, high: 105, low: 97, close: 103 } });
  assert.equal(result.exitReason, "STOP_LOSS_BOTH_LEVELS_TOUCHED");
  assert.equal(result.exitPrice, 98);
});

test("uses the candle open for a gap through a BUY stop", () => {
  const result = evaluatePaperExit({ trade: buy, candle: { open: 95, high: 97, low: 94, close: 96 } });
  assert.equal(result.exitReason, "STOP_LOSS_GAP");
  assert.equal(result.exitPrice, 95);
});

test("rejects invalid protective levels", () => {
  const result = evaluatePaperExit({ trade: { ...buy, stop_loss: 101 }, candle: { open: 100, high: 101, low: 99, close: 100 } });
  assert.deepEqual(result, { status: "REJECTED", reason: "INVALID_PROTECTIVE_LEVELS" });
});

test("rejects malformed OHLC candles", () => {
  const result = evaluatePaperExit({ trade: buy, candle: { open: 100, high: 98, low: 99, close: 100 } });
  assert.equal(result.status, "REJECTED");
});
