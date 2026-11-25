import test from "node:test";
import assert from "node:assert/strict";
import {calculateScalpingRisk,buildScalpingTargets,evaluateScalpingExit} from "../lib/scalping-execution.js";

test("scalping sizing stays within the 0.25 percent DEMO risk budget",()=>{
 const size=calculateScalpingRisk({balance:10000,entry:2000,stopLoss:1990,quoteToUsd:1});
 assert.ok(size.quantity>0);
 assert.ok(size.riskAmount<=25);
 assert.ok(size.riskPct<=0.25);
});

test("scalping sizing converts quote-currency risk to USD",()=>{
 const size=calculateScalpingRisk({balance:5000,entry:1.1,stopLoss:1.095,quoteToUsd:1.08});
 assert.ok(size.riskAmount<=12.5);
 assert.ok(size.riskPct<=0.25);
});

test("scalping sizing rejects risk above the hard 0.25 percent cap",()=>{
 assert.throws(()=>calculateScalpingRisk({balance:10000,entry:2000,stopLoss:1990,riskPct:0.3}),/no more than 0.25/);
});

test("scalping sizing rejects invalid balance, stop distance and conversion",()=>{
 assert.throws(()=>calculateScalpingRisk({balance:0,entry:2000,stopLoss:1990}),/balance/);
 assert.throws(()=>calculateScalpingRisk({balance:10000,entry:2000,stopLoss:2000}),/distance/);
 assert.throws(()=>calculateScalpingRisk({balance:10000,entry:2000,stopLoss:1990,quoteToUsd:0}),/quoteToUsd/);
});

test("scalping target ladder is correctly ordered and ends at a 1.5R target",()=>{
 const targets=buildScalpingTargets({direction:"BUY",entry:2000,stopLoss:1990,takeProfit:2015});
 assert.deepEqual([targets.tp1,targets.tp2,targets.tp3],[2007.5,2011,2015]);
 assert.equal(targets.rewardRisk,1.5);
});

test("SELL scalping target ladder is correctly ordered",()=>{
 const targets=buildScalpingTargets({direction:"SELL",entry:2000,stopLoss:2010,takeProfit:1980});
 assert.ok(targets.tp1<2000&&targets.tp2<targets.tp1&&targets.tp3<targets.tp2);
 assert.equal(targets.rewardRisk,2);
});

test("scalping target builder rejects targets outside 1.5R to 3R",()=>{
 assert.throws(()=>buildScalpingTargets({direction:"BUY",entry:2000,stopLoss:1990,takeProfit:2014}),/between 1.5R and 3R/);
 assert.throws(()=>buildScalpingTargets({direction:"SELL",entry:2000,stopLoss:1990,takeProfit:1980}),/stop-loss|correctly ordered|between 1.5R and 3R/);
});

test("BUY exit uses bid and closes at stop before considering targets",()=>{
 const now=Date.now();
 const trade={side:"BUY",stop_loss:1990,tp1_price:2007.5,tp2_price:2011,tp3_price:2015,tp1_done:false,tp2_done:false,tp3_done:false};
 const result=evaluateScalpingExit({trade,bid:1989,ask:1989.1,quoteAsOf:now,receivedAt:now,now});
 assert.deepEqual(result,{action:"EXIT",stage:"STOP_LOSS",price:1989});
});

test("BUY exit advances TP1, TP2 and TP3 in order",()=>{
 const now=Date.now(),base={side:"BUY",stop_loss:1990,tp1_price:2007.5,tp2_price:2011,tp3_price:2015};
 const tick={bid:2008,ask:2008.1,quoteAsOf:now,receivedAt:now,now};
 assert.equal(evaluateScalpingExit({trade:{...base,tp1_done:false,tp2_done:false,tp3_done:false},...tick}).stage,"TP1");
 assert.equal(evaluateScalpingExit({trade:{...base,tp1_done:true,tp2_done:false,tp3_done:false},...tick,bid:2012,ask:2012.1}).stage,"TP2");
 assert.equal(evaluateScalpingExit({trade:{...base,tp1_done:true,tp2_done:true,tp3_done:false},...tick,bid:2016,ask:2016.1}).stage,"TP3");
});

test("SELL exit uses ask and stale quotes never close a position",()=>{
 const now=Date.now(),trade={side:"SELL",stop_loss:2010,tp1_price:1992.5,tp2_price:1989,tp3_price:1985,tp1_done:false,tp2_done:false,tp3_done:false};
 const stopped=evaluateScalpingExit({trade,bid:2010.1,ask:2010.2,quoteAsOf:now,receivedAt:now,now});
 assert.equal(stopped.stage,"STOP_LOSS");
 const stale=evaluateScalpingExit({trade,bid:1980,ask:1980.1,quoteAsOf:now-15000,receivedAt:now-15000,now});
 assert.deepEqual(stale,{action:"WAIT",reason:"EXIT_QUOTE_STALE"});
});
