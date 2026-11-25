import test from "node:test";
import assert from "node:assert/strict";
import {analyseScalping, mergeCompletedM5, fibonacciBands, marketStructureContext} from "../lib/scalping-engine.js";
const now=Date.now();
function candles({trend="up",count=60}={}){
 let price=2000;const rows=[];
 for(let i=0;i<count;i++){
  const open=price;price+=trend==="up"?0.12:trend==="down"?-0.12:0.01;
  rows.push({epoch:Math.floor(now/60000-count*60+i*60),open,high:Math.max(open,price)+0.03,low:Math.min(open,price)-0.03,close:price});
 }
 return rows;
}
function tick(side="BUY",price=2008){
 return {source:"DERIV",instrument:"XAUUSD",providerSymbol:"frxXAUUSD",quote:price,bid:price-.05,ask:price+.05,quoteAsOf:new Date(now).toISOString(),receivedAt:new Date(now).toISOString()};
}
test("scalping engine blocks stale ticks",()=>{
 const t=tick();t.receivedAt=new Date(now-5000).toISOString();
 assert.equal(analyseScalping({instrument:"XAUUSD",candles:candles(),tick:t,now}).reason,"TICK_STALE");
});
test("scalping engine requires verified bid and ask",()=>{
 const t=tick();delete t.bid;delete t.ask;
 assert.equal(analyseScalping({instrument:"XAUUSD",candles:candles(),tick:t,now}).reason,"VERIFIED_BID_ASK_REQUIRED");
});
test("scalping engine blocks mismatched instrument",()=>{
 assert.equal(analyseScalping({instrument:"EURUSD",candles:candles(),tick:tick(),now}).reason,"VERIFIED_TICK_REQUIRED");
});
test("scalping engine returns WAIT when no momentum breakout is confirmed",()=>{
 const c=candles();const t=tick("BUY",c.at(-1).close);
 const result=analyseScalping({instrument:"XAUUSD",candles:c,tick:t,now});
 assert.equal(result.direction,"WAIT");
});
test("scalping engine rejects malformed candle history",()=>{
 assert.throws(()=>analyseScalping({instrument:"XAUUSD",candles:[],tick:tick(),now}),/35 completed M1 candles/);
});

test("scalping engine confirms a BUY only on M1 breakout with aligned M5 trend",()=>{
 const rows=[];let price=2000;
 for(let i=0;i<60;i++){
  const open=price;price+=i===59?0.05:(i%2===0?0.05:-0.03);
  rows.push({epoch:Math.floor(now/1000)-((60-i)*60),open,high:Math.max(open,price)+0.01,low:Math.min(open,price)-0.01,close:price});
 }
 const last=rows.at(-1);
 const quote=last.high+0.02;
 const t={source:"DERIV",instrument:"XAUUSD",providerSymbol:"frxXAUUSD",quote,bid:quote-0.002,ask:quote+0.002,quoteAsOf:new Date(now).toISOString(),receivedAt:new Date(now).toISOString()};
 const trend=Array.from({length:30},(_,i)=>({close:1900+i*0.5}));
 const result=analyseScalping({instrument:"XAUUSD",candles:rows,trendCandles:trend,tick:t,now});
 assert.equal(result.direction,"BUY");
 assert.ok(result.stopLoss<result.entry);
 assert.ok(result.takeProfit>result.entry);
});

test("M5 merger reconstructs only complete contiguous five-minute candles",()=>{
 const base=Math.floor((now/1000)/300)*300;
 const m1=Array.from({length:10},(_,i)=>{
  const open=2000+i,close=open+0.5;
  return {epoch:base+i*60,open,high:close+0.2,low:open-0.2,close};
 });
 const result=mergeCompletedM5([],m1);
 assert.equal(result.length,2);
 assert.equal(result[0].epoch,base);
 assert.equal(result[0].open,2000);
 assert.equal(result[0].close,2004.5);
 assert.equal(result[1].epoch,base+300);
});
test("M5 merger rejects groups with a missing or duplicated M1 minute and preserves provider history",()=>{
 const base=Math.floor((now/1000)/300)*300;
 const provider=[{epoch:base-300,open:100,high:103,low:99,close:102}];
 const m1=Array.from({length:5},(_,i)=>({epoch:base+i*60,open:2000+i,high:2001+i,low:1999+i,close:2000.5+i})).filter((_,i)=>i!==2);
 m1.push({...m1[1]});
 const result=mergeCompletedM5(provider,m1);
 assert.deepEqual(result,[provider[0]]);
});

test("Fibonacci scalping bands use the completed M1 swing range",()=>{
 const rows=Array.from({length:60},(_,i)=>({epoch:1000+i*60,open:100+i,high:100+i,low:90+i,close:95+i}));
 const fib=fibonacciBands(rows);
 assert.equal(fib.swingHigh,159);
 assert.equal(fib.swingLow,90);
 assert.equal(fib.range,69);
 assert.ok(Math.abs(fib.retracement618-(159-69*0.618))<1e-9);
 assert.ok(Math.abs(fib.extension1272Up-(159+69*0.272))<1e-9);
 assert.ok(Math.abs(fib.extension1618Down-(90-69*0.618))<1e-9);
});
test("scalping WAIT diagnostics include Fibonacci retracement and extension bands",()=>{
 const c=candles();
 const t=tick("BUY",c.at(-1).close);
 const result=analyseScalping({instrument:"XAUUSD",candles:c,tick:t,now});
 assert.equal(result.direction,"WAIT");
 assert.ok(result.indicators.fibonacci);
 assert.ok(result.indicators.fibonacci.retracement618>result.indicators.fibonacci.swingLow);
});

test("scalping instrument normalization removes spaces, slashes and separators",()=>{
 const result=analyseScalping({instrument:"XAU USD",candles:candles(),tick:tick(),now});
 assert.notEqual(result.reason,"VERIFIED_TICK_REQUIRED");
});

test("market structure reports confirmed swing levels, BOS, CHOCH and order-block candidates",()=>{
 const highs=[10,11,12,11,10,9,10,11,12,11,10,9,10,11,15,14,13,14,16];
 const rows=highs.map((high,i)=>{
  const low=high-2,open=high-1,close=i===18?high-0.2:(i%2===0?high-0.4:high-1.4);
  return {epoch:1000+i*60,open,high,low,close};
 });
 const context=marketStructureContext(rows);
 assert.equal(context.latestSwingHigh,15);
 assert.equal(context.bosDirection,"BUY");
 assert.equal(context.support,7);
 assert.ok(context.orderBlockCandidate);
 assert.equal(context.orderBlockCandidate.side,"BUY");
});

test("scalping WAIT diagnostics expose price-action structure context",()=>{
 const c=candles(),t=tick("BUY",c.at(-1).close);
 const result=analyseScalping({instrument:"XAUUSD",candles:c,tick:t,now});
 assert.equal(result.direction,"WAIT");
 assert.ok(result.indicators.marketStructure);
 assert.ok(Object.hasOwn(result.indicators.marketStructure,"liquiditySweep"));
});
