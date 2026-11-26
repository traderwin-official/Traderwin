import test from "node:test";
import assert from "node:assert/strict";
import {runScalpingBacktest,summarizeScalpingBacktest,parseM1Csv} from "../lib/scalping-backtest.js";

function flatHistory(count=220){
 const base=Math.floor(Date.now()/60000)*60-count*60;
 return Array.from({length:count},(_,i)=>({epoch:base+i*60,open:2000,high:2000.1,low:1999.9,close:2000}));
}
test("backtest requires a long, contiguous completed M1 history",()=>{
 const rows=flatHistory(220);rows[150].epoch+=60;
 assert.throws(()=>runScalpingBacktest({instrument:"XAUUSD",candles:rows,spreadPriceUnits:0.1}),/valid, aligned and strictly contiguous/);
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
 const csv="\\uFEFFtimestamp,open,high,low,close\\r\\n"+[0,1,2].map(i=>[base+i*60,2000,2001,1999,2000.5].join(",")).join("\\r\\n");
 const rows=parseM1Csv(csv);
 assert.equal(rows.length,3);
 assert.equal(rows[1].epoch,base+60);
 const iso="time,open,high,low,close\\n"+[0,1].map(i=>[new Date((base+i*60)*1000).toISOString(),2000,2001,1999,2000.5].join(",")).join("\\n");
 assert.equal(parseM1Csv(iso).length,2);
});
test("CSV loader rejects gaps and malformed OHLC",()=>{
 const base=Math.floor(Date.now()/60000)*60;
 const gap="epoch,open,high,low,close\\n"+[0,2].map(i=>[base+i*60,2000,2001,1999,2000].join(",")).join("\\n");
 assert.throws(()=>parseM1Csv(gap),/strictly contiguous/);
 const malformed="epoch,open,high,low,close\\n"+[base,2000,1990,1999,2000].join(",");
 assert.throws(()=>parseM1Csv(malformed),/strictly contiguous/);
});
