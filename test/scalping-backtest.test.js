import test from "node:test";
import assert from "node:assert/strict";
import {runScalpingBacktest,summarizeScalpingBacktest,parseM1Csv,scalpingExitFillPrice,scalpingStopFillPrice} from "../lib/scalping-backtest.js";

function flatHistory(count=220){
 const base=Math.floor(Date.now()/60000)*60-count*60;
 return Array.from({length:count},(_,i)=>({epoch:base+i*60,open:2000,high:2000.1,low:1999.9,close:2000}));
}
test("backtest rejects malformed or unsorted historical candles",()=>{
 const rows=flatHistory(220);rows[150].high=0;
 assert.throws(()=>runScalpingBacktest({instrument:"XAUUSD",candles:rows,spreadPriceUnits:0.1}),/valid, minute-aligned and sorted/);
});
test("backtest accepts market session gaps and resets its indicator warm-up",()=>{
 const rows=flatHistory(220);
 for(let i=150;i<rows.length;i++)rows[i].epoch+=60;
 const result=runScalpingBacktest({instrument:"XAUUSD",candles:rows,spreadPriceUnits:0.1});
 assert.equal(result.data.candles,220);
 assert.equal(result.totalTrades,0);
});
test("backtest rejects unrealistic or missing cost assumptions",()=>{
 assert.throws(()=>runScalpingBacktest({instrument:"XAUUSD",candles:flatHistory(),spreadPriceUnits:0}),/positive fixed spread/);
 assert.throws(()=>runScalpingBacktest({instrument:"XAUUSD",candles:flatHistory(),spreadPriceUnits:0.1,maxPositions:16}),/between 1 and 15/);
 assert.throws(()=>runScalpingBacktest({instrument:"XAUUSD",candles:flatHistory(),spreadPriceUnits:0.1,portfolioRiskPct:2}),/at most 1/);
});
test("backtest reports a no-signal market honestly without inventing trades",()=>{
 const result=runScalpingBacktest({instrument:"XAUUSD",candles:flatHistory(),spreadPriceUnits:0.1,slippagePriceUnits:0.02,commissionPriceUnitsRoundTrip:0.01});
 assert.equal(result.instrument,"XAUUSD");
 assert.equal(result.method,"M1_NEXT_BAR_OPEN_M5_CONFIRMED");
 assert.equal(result.totalTrades,0);
 assert.equal(result.winRatePct,0);
 assert.equal(result.expectancyR,0);
 assert.equal(result.assumptions.stopFirstOnAmbiguousBar,true);
 assert.equal(result.data.candles,220);
});
test("backtest summary computes win rate, expectancy, profit factor and drawdown",()=>{
 const result=summarizeScalpingBacktest([
  {netR:2,openPositionsAtEntry:1},
  {netR:-1,openPositionsAtEntry:2},
  {netR:1,openPositionsAtEntry:3},
  {netR:-0.5,openPositionsAtEntry:1}
 ],{maxPositions:5});
 assert.equal(result.totalTrades,4);
 assert.equal(result.wins,2);
 assert.equal(result.losses,2);
 assert.equal(result.winRatePct,50);
 assert.equal(result.profitFactor,2);
 assert.equal(result.expectancyR,0.375);
 assert.equal(result.netR,1.5);
 assert.equal(result.maxDrawdownR,1);
 assert.equal(result.maxConsecutiveLosses,1);
 assert.equal(result.peakOpenPositions,3);
});
test("backtest caps the requested portfolio at fifteen positions",()=>{
 assert.throws(()=>summarizeScalpingBacktest([],{maxPositions:16}),/between 1 and 15/);
});

test("CSV loader accepts epoch and ISO timestamps with CRLF and BOM",()=>{
 const base=Math.floor(Date.now()/60000)*60;
 const csv="\uFEFFtimestamp,open,high,low,close\r\n"+[0,1,2].map(i=>[base+i*60,2000,2001,1999,2000.5].join(",")).join("\r\n");
 const rows=parseM1Csv(csv);
 assert.equal(rows.length,3);
 assert.equal(rows[1].epoch,base+60);
 const iso="time,open,high,low,close\n"+[0,1].map(i=>[new Date((base+i*60)*1000).toISOString(),2000,2001,1999,2000.5].join(",")).join("\n");
 assert.equal(parseM1Csv(iso).length,2);
});
test("CSV loader accepts session gaps but rejects malformed OHLC",()=>{
 const base=Math.floor(Date.now()/60000)*60;
 const gap="epoch,open,high,low,close\n"+[0,2].map(i=>[base+i*60,2000,2001,1999,2000].join(",")).join("\n");
 assert.equal(parseM1Csv(gap).length,2);
 const malformed="epoch,open,high,low,close\n"+[base,2000,1990,1999,2000].join(",");
 assert.throws(()=>parseM1Csv(malformed),/valid, minute-aligned and sorted/);
});

test("backtest exit fills charge the correct bid/ask spread and adverse slippage",()=>{
 assert.equal(scalpingExitFillPrice("BUY",2000,0.05,0.02),1999.93);
 assert.equal(scalpingExitFillPrice("SELL",2000,0.05,0.02),2000.07);
 assert.throws(()=>scalpingExitFillPrice("HOLD",2000,0.05,0.02),/Direction must be BUY or SELL/);
 assert.throws(()=>scalpingExitFillPrice("BUY",2000,-0.05,0.02),/finite and non-negative/);
});

test("backtest stop fills worsen at gaps through the stop",()=>{
 assert.equal(scalpingStopFillPrice("BUY",1999,1998,0.05,0.02),1997.93);
 assert.equal(scalpingStopFillPrice("SELL",2001,2002,0.05,0.02),2002.07);
 assert.equal(scalpingStopFillPrice("BUY",1999,2000,0.05,0.02),1998.93);
 assert.equal(scalpingStopFillPrice("SELL",2001,2000,0.05,0.02),2001.07);
});
