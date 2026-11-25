import test from "node:test";
import assert from "node:assert/strict";
import {analyseScalping} from "../lib/scalping-engine.js";
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
