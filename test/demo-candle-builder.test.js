import test from "node:test";
import assert from "node:assert/strict";
import { ingestMarketTick } from "../lib/demo/candle-builder.js";

const now = 1_800_000_000;
const tick = (epoch, quote, symbol = "frxXAUUSD") => ({ epoch, quote, symbol });

test("creates a new OHLC candle from the first valid tick", () => {
  const result = ingestMarketTick({ tick: tick(now, 2000), nowEpoch: now });
  assert.equal(result.status, "ACCEPTED");
  assert.deepEqual(result.candles[0], {
    symbol: "frxXAUUSD", bucket_epoch: Math.floor(now / 900) * 900,
    open: 2000, high: 2000, low: 2000, close: 2000,
    tick_epoch: now, tick_count: 1, complete: false
  });
});

test("aggregates high, low and close within one candle", () => {
  const first = ingestMarketTick({ tick: tick(now, 2000), nowEpoch: now });
  const second = ingestMarketTick({ candles: first.candles, tick: tick(now + 1, 2005), nowEpoch: now + 1 });
  const third = ingestMarketTick({ candles: second.candles, tick: tick(now + 2, 1998), nowEpoch: now + 2 });
  assert.equal(third.candles[0].open, 2000);
  assert.equal(third.candles[0].high, 2005);
  assert.equal(third.candles[0].low, 1998);
  assert.equal(third.candles[0].close, 1998);
  assert.equal(third.candles[0].tick_count, 3);
});

test("closes the previous candle only after a later bucket tick arrives", () => {
  const first = ingestMarketTick({ tick: tick(now, 2000), nowEpoch: now });
  const laterEpoch = Math.floor(now / 900) * 900 + 900;
  const result = ingestMarketTick({ candles: first.candles, tick: tick(laterEpoch, 2002), nowEpoch: laterEpoch });
  assert.equal(result.closedCandle.complete, true);
  assert.equal(result.candles[0].complete, true);
  assert.equal(result.candles[1].open, 2002);
  assert.equal(result.candles[1].complete, false);
});

test("rejects stale ticks", () => {
  assert.deepEqual(ingestMarketTick({ tick: tick(now - 121, 2000), nowEpoch: now }), {
    status: "REJECTED", reason: "STALE_TICK"
  });
});

test("rejects duplicate and out-of-order ticks", () => {
  const first = ingestMarketTick({ tick: tick(now, 2000), nowEpoch: now });
  const duplicate = ingestMarketTick({ candles: first.candles, tick: tick(now, 2001), nowEpoch: now });
  assert.equal(duplicate.reason, "DUPLICATE_OR_OUT_OF_ORDER_TICK");
});

test("rejects a tick from another instrument", () => {
  const first = ingestMarketTick({ tick: tick(now, 2000), nowEpoch: now });
  const result = ingestMarketTick({ candles: first.candles, tick: tick(now + 1, 2001, "frxEURUSD"), nowEpoch: now + 1 });
  assert.equal(result.reason, "SYMBOL_MISMATCH");
});

test("rejects invalid and future ticks", () => {
  assert.equal(ingestMarketTick({ tick: tick(now, 0), nowEpoch: now }).reason, "INVALID_TICK");
  assert.equal(ingestMarketTick({ tick: tick(now + 6, 2000), nowEpoch: now }).reason, "TICK_FROM_FUTURE");
});

test("retains only the configured candle history", () => {
  let candles = [];
  for (let i = 0; i < 4; i++) {
    const epoch = Math.floor(now / 60) * 60 + i * 60;
    candles = ingestMarketTick({
      candles, tick: tick(epoch, 2000 + i), timeframeSeconds: 60,
      nowEpoch: epoch, maxCandles: 2
    }).candles;
  }
  assert.equal(candles.length, 2);
});
