import test from "node:test";
import assert from "node:assert/strict";
import { analyzeClosedCandles } from "../lib/demo/closed-candle-analysis.js";

const now = 1_800_000_000;
const candles = (closes, complete = true) => closes.map((close, i) => ({
  symbol: "frxXAUUSD", bucket_epoch: now - (closes.length - i) * 900,
  open: close, high: close + 1, low: close - 1, close,
  complete, tick_epoch: now - (closes.length - i) * 900 + 899
}));

test("does not analyse an unfinished candle", () => {
  const result = analyzeClosedCandles({ candles: candles(Array.from({length:25},(_,i)=>100+i), false), symbol:"frxXAUUSD", nowEpoch:now });
  assert.equal(result.reason, "INSUFFICIENT_CLOSED_CANDLES");
});

test("rejects invalid or duplicate candle history", () => {
  const data = candles(Array.from({length:25},(_,i)=>100+i));
  data[1] = { ...data[1], bucket_epoch: data[0].bucket_epoch };
  assert.equal(analyzeClosedCandles({ candles:data, symbol:"frxXAUUSD", nowEpoch:now }).reason, "INVALID_CLOSED_CANDLE_HISTORY");
});

test("blocks stale completed candles using timeframe-aware default age", () => {
  const data = candles(Array.from({length:25},(_,i)=>100+i)).map(c=>({...c,bucket_epoch:c.bucket_epoch-3600}));
  assert.equal(analyzeClosedCandles({ candles:data, symbol:"frxXAUUSD", nowEpoch:now, maxAgeSeconds:30 }).reason, "CLOSED_CANDLE_DATA_STALE");
});

test("ignores candles for a different symbol", () => {
  const data = candles(Array.from({length:25},(_,i)=>100+i)).map(c=>({...c,symbol:"frxEURUSD"}));
  assert.equal(analyzeClosedCandles({ candles:data, symbol:"frxXAUUSD", nowEpoch:now }).reason, "INSUFFICIENT_CLOSED_CANDLES");
});

test("returns strategy analysis with default 15-minute provenance", () => {
  const data = candles([100,97,94,94,91,90,93,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126]);
  const result = analyzeClosedCandles({ candles:data, symbol:"frxXAUUSD", nowEpoch:now, fastPeriod:3, slowPeriod:5 });
  assert.equal(result.instrument, "frxXAUUSD");
  assert.equal(result.dataStatus, "CLOSED_CANDLES_ONLY");
  assert.equal(result.timeframeSeconds, 900);
  assert.ok(["SIGNAL","NO_SIGNAL"].includes(result.status));
});

test("supports aligned one-hour candles and derives a two-candle freshness window", () => {
  const timeframeSeconds = 3600;
  const closes = Array.from({length:25},(_,i)=>100+i);
  const latestBucket = Math.floor((now - timeframeSeconds) / timeframeSeconds) * timeframeSeconds;
  const data = closes.map((close, i) => {
    const bucket = latestBucket - (closes.length - 1 - i) * timeframeSeconds;
    return { symbol:"frxXAUUSD", bucket_epoch:bucket, open:close, high:close+1, low:close-1, close, complete:true };
  });
  const result = analyzeClosedCandles({
    candles:data, symbol:"frxXAUUSD", nowEpoch:latestBucket + timeframeSeconds + 60,
    timeframeSeconds, fastPeriod:3, slowPeriod:5
  });
  assert.equal(result.timeframeSeconds, 3600);
  assert.equal(result.latestCandleAgeSeconds, 60);
  assert.ok(["SIGNAL","NO_SIGNAL"].includes(result.status));
});

test("rejects candle buckets that are not aligned to the selected timeframe", () => {
  const data = candles(Array.from({length:25},(_,i)=>100+i));
  data[4] = { ...data[4], bucket_epoch: data[4].bucket_epoch + 30 };
  assert.equal(analyzeClosedCandles({ candles:data, symbol:"frxXAUUSD", nowEpoch:now }).reason, "INVALID_CLOSED_CANDLE_HISTORY");
});

test("rejects invalid timeframe configuration", () => {
  const result = analyzeClosedCandles({ candles:[], symbol:"frxXAUUSD", nowEpoch:now, timeframeSeconds:30 });
  assert.equal(result.reason, "INVALID_ANALYSIS_INPUT");
});
