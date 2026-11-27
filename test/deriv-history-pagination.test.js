import test from "node:test";
import assert from "node:assert/strict";
import {shouldFetchOlderHistory} from "../lib/deriv-history-pagination.js";

test("continues pagination when a full raw page loses the current incomplete candle",()=>{
  assert.equal(shouldFetchOlderHistory({
    receivedCount:1000,pageSize:1000,oldestEpoch:1_000,fromEpoch:0,previousOldestEpoch:Infinity
  }),true);
});

test("stops when Deriv returns a genuinely short raw page",()=>{
  assert.equal(shouldFetchOlderHistory({
    receivedCount:999,pageSize:1000,oldestEpoch:1_000,fromEpoch:0,previousOldestEpoch:Infinity
  }),false);
});

test("stops when the requested date range has been reached",()=>{
  assert.equal(shouldFetchOlderHistory({
    receivedCount:1000,pageSize:1000,oldestEpoch:100,fromEpoch:100,previousOldestEpoch:Infinity
  }),false);
});

test("stops when pagination makes no progress",()=>{
  assert.equal(shouldFetchOlderHistory({
    receivedCount:1000,pageSize:1000,oldestEpoch:1_000,fromEpoch:0,previousOldestEpoch:1_000
  }),false);
});

test("rejects invalid pagination state",()=>{
  assert.throws(()=>shouldFetchOlderHistory({
    receivedCount:-1,pageSize:1000,oldestEpoch:1_000,fromEpoch:0
  }),/Invalid Deriv history pagination state/);
});
