import test from "node:test";
import assert from "node:assert/strict";
import {detectMarketDataGap} from "../lib/scalping-market-data-gap.js";

test("reports a long market-data gap without inventing an exit price",()=>{
 const result=detectMarketDataGap({instrument:"xauusd",previousEpoch:1000,epoch:1065,activePositionCount:2});
 assert.deepEqual(result,{
  instrument:"XAUUSD",gapSeconds:65,previousEpoch:1000,resumedEpoch:1065,
  activePositionCount:2,executableHistoryAvailable:false,requiresManualReview:true
 });
});

test("does not report ordinary tick spacing or a first tick without a baseline",()=>{
 assert.equal(detectMarketDataGap({instrument:"XAUUSD",previousEpoch:1000,epoch:1020}),null);
 assert.equal(detectMarketDataGap({instrument:"XAUUSD",epoch:1020}),null);
});

test("reports a gap without claiming manual review when no position was open",()=>{
 const result=detectMarketDataGap({instrument:"EURUSD",previousEpoch:1000,epoch:1040,activePositionCount:0});
 assert.equal(result.requiresManualReview,false);
 assert.equal(result.executableHistoryAvailable,false);
});

test("rejects invalid instrument and ignores non-monotonic epochs",()=>{
 assert.throws(()=>detectMarketDataGap({instrument:"",previousEpoch:1,epoch:40}),/instrument/);
 assert.equal(detectMarketDataGap({instrument:"XAUUSD",previousEpoch:40,epoch:1}),null);
});
