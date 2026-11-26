import test from "node:test";
import assert from "node:assert/strict";
import {recordMarketDataGapReview,resolveMarketDataGapReview} from "../lib/scalping-gap-review.js";

test("a feed gap with open positions latches new entries for that instrument",()=>{
 const review=new Map(),gap={instrument:"xauusd",requiresManualReview:true,gapSeconds:90};
 assert.equal(recordMarketDataGapReview({gap,reviewRequiredByInstrument:review}),true);
 assert.deepEqual(review.get("XAUUSD"),gap);
});

test("review latch remains while positions or any reconciliation are pending",()=>{
 const review=new Map([["XAUUSD",{instrument:"XAUUSD"}]]);
 const active=new Map([["t1",{id:"t1",instrument:"XAUUSD"}]]),pending=new Map();
 assert.equal(resolveMarketDataGapReview({instrument:"XAUUSD",activeTrades:active,pendingRefresh:pending,reviewRequiredByInstrument:review}),false);
 active.clear();pending.set("t1",2);
 assert.equal(resolveMarketDataGapReview({instrument:"XAUUSD",activeTrades:active,pendingRefresh:pending,reviewRequiredByInstrument:review}),false);
 assert.equal(review.has("XAUUSD"),true);
});

test("review latch clears only after authoritative state has no open or pending positions",()=>{
 const review=new Map([["XAUUSD",{instrument:"XAUUSD"}]]);
 assert.equal(resolveMarketDataGapReview({instrument:"XAUUSD",activeTrades:new Map(),pendingRefresh:new Map(),reviewRequiredByInstrument:review}),true);
 assert.equal(review.has("XAUUSD"),false);
});

test("a gap without an open position does not create a review latch",()=>{
 const review=new Map();
 assert.equal(recordMarketDataGapReview({gap:{instrument:"EURUSD",requiresManualReview:false},reviewRequiredByInstrument:review}),false);
 assert.equal(review.size,0);
});
