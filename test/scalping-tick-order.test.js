import test from "node:test";
import assert from "node:assert/strict";
import {acceptMonotonicMarketTick} from "../lib/scalping-tick-order.js";

test("rejects older market ticks without rolling back the latest instrument epoch",()=>{
 const latest=new Map();
 assert.equal(acceptMonotonicMarketTick({instrument:"XAUUSD",epoch:100,latestByInstrument:latest}),true);
 assert.equal(acceptMonotonicMarketTick({instrument:"xauusd",epoch:99,latestByInstrument:latest}),false);
 assert.equal(latest.get("XAUUSD"),100);
 assert.equal(acceptMonotonicMarketTick({instrument:"XAUUSD",epoch:101,latestByInstrument:latest}),true);
 assert.equal(latest.get("XAUUSD"),101);
});

test("allows multiple valid ticks in the same Deriv epoch second",()=>{
 const latest=new Map();
 assert.equal(acceptMonotonicMarketTick({instrument:"EURUSD",epoch:200,latestByInstrument:latest}),true);
 assert.equal(acceptMonotonicMarketTick({instrument:"EURUSD",epoch:200,latestByInstrument:latest}),true);
 assert.equal(latest.get("EURUSD"),200);
});

test("keeps independent ordering state for different instruments",()=>{
 const latest=new Map();
 assert.equal(acceptMonotonicMarketTick({instrument:"XAUUSD",epoch:300,latestByInstrument:latest}),true);
 assert.equal(acceptMonotonicMarketTick({instrument:"BTCUSD",epoch:250,latestByInstrument:latest}),true);
 assert.equal(latest.get("XAUUSD"),300);
 assert.equal(latest.get("BTCUSD"),250);
});
