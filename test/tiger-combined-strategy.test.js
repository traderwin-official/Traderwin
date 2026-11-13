import test from "node:test";
import assert from "node:assert/strict";
import { analyseCombinedTigerStrategy, analyseStrategy } from "../lib/strategy-engine.js";

function neutralCandles(count=80){
  return Array.from({length:count},(_,i)=>({
    open:100,high:100.5,low:99.5,close:100+(i%2?0.03:-0.03),time:i
  }));
}

test("combined Tiger strategy requires agreement and exposes both analyses",()=>{
  const result=analyseCombinedTigerStrategy(neutralCandles());
  assert.equal(result.direction,"WAIT");
  assert.equal(result.decision,"ANALYSIS_ONLY");
  assert.equal(result.executionAuthorized,false);
  assert.ok(result.components.trendMomentumBreakout);
  assert.ok(result.components.tigerConfluence);
  assert.equal(result.agreement.required,2);
});

test("MULTI strategy selection routes through combined Tiger consensus",()=>{
  const result=analyseStrategy(neutralCandles(),"MULTI_CONFIRMATION_V1");
  assert.equal(result.strategy,"TIGER_COMBINED_MULTI_CONFIRMATION_V1");
  assert.equal(result.direction,"WAIT");
});
