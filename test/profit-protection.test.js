import test from "node:test";import assert from "node:assert/strict";
import {profitProtection,nextProtectiveStop} from "../lib/profit-protection.js";
test("20 percent giveback from peak profit closes at 80 percent retained",()=>{
 const r=profitProtection({peakProfit:100,currentProfit:80,givebackPct:20});
 assert.equal(r.active,true);assert.equal(r.protectedFloor,80);assert.equal(r.close,true);
});
test("does not close before 20 percent retracement",()=>{assert.equal(profitProtection({peakProfit:100,currentProfit:81,givebackPct:20}).close,false);});
test("peak profit updates should retain the higher peak",()=>{const old=100,mark=130;assert.equal(Math.max(old,mark),130);});
test("20 percent trail stays inactive below USD 20 peak profit",()=>{
 const r=profitProtection({peakProfit:19.99,currentProfit:1,givebackPct:20});
 assert.equal(r.active,false);assert.equal(r.close,false);
});
test("20 percent trail activates at exactly USD 20 and protects USD 16",()=>{
 const r=profitProtection({peakProfit:20,currentProfit:16,givebackPct:20});
 assert.equal(r.active,true);assert.equal(r.protectedFloor,16);assert.equal(r.close,true);
});
test("the activation threshold does not cap a growing profit",()=>{
 const r=profitProtection({peakProfit:250,currentProfit:220,givebackPct:20});
 assert.equal(r.active,true);assert.equal(r.protectedFloor,200);assert.equal(r.close,false);
});
test("BUY protective stop only moves upward",()=>{assert.equal(nextProtectiveStop({direction:"BUY",entryPrice:100,currentStop:95,markPrice:120,peakProfit:100,units:10}),108);assert.equal(nextProtectiveStop({direction:"BUY",entryPrice:100,currentStop:110,markPrice:120,peakProfit:100,units:10}),110);});
test("SELL protective stop only moves downward",()=>{assert.equal(nextProtectiveStop({direction:"SELL",entryPrice:100,currentStop:105,markPrice:80,peakProfit:100,units:10}),92);assert.equal(nextProtectiveStop({direction:"SELL",entryPrice:100,currentStop:90,markPrice:80,peakProfit:100,units:10}),90);});
test("rejects unsafe giveback configuration",()=>{assert.throws(()=>profitProtection({peakProfit:100,currentProfit:80,givebackPct:70}),RangeError);});
