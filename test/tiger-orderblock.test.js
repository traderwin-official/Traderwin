import test from "node:test";
import assert from "node:assert/strict";
import { detectOrderBlockStructure } from "../lib/strategy-engine.js";

function flatCandles(count=40){
  return Array.from({length:count},(_,i)=>({
    open:100,high:100.5,low:99.5,close:100.1,
    time:i
  }));
}

test("Tiger structure detector identifies a bullish order block and break type",()=>{
  const candles=flatCandles();
  candles[38]={open:100.2,high:100.4,low:99.4,close:99.7,time:38};
  candles[39]={open:99.8,high:102.2,low:99.6,close:102,time:39};
  const result=detectOrderBlockStructure(candles);
  assert.ok(result);
  assert.equal(result.direction,"BULLISH");
  assert.ok(["BOS","CHOCH"].includes(result.type));
  assert.deepEqual(result.zone,{low:99.4,high:100.2});
  assert.equal(result.originIndex,38);
});

test("Tiger structure detector returns null without a displacement break",()=>{
  const candles=flatCandles();
  assert.equal(detectOrderBlockStructure(candles),null);
});
