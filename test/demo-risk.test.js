import test from "node:test";import assert from "node:assert/strict";
import {validatePaperSetup,calculatePaperPosition,calculatePaperPnl} from "../lib/demo-risk.js";
test("valid BUY and SELL setups",()=>{assert.equal(validatePaperSetup({direction:"BUY",entry:100,stop:95,target:110}),null);assert.equal(validatePaperSetup({direction:"SELL",entry:100,stop:105,target:90}),null);});
test("rejects incorrect stop placement",()=>{assert.match(validatePaperSetup({direction:"BUY",entry:100,stop:105,target:110}),/BUY/);});
test("calculates virtual sizing at fixed risk",()=>{const x=calculatePaperPosition({balance:10000,riskPct:.5,entry:2000,stop:1990});assert.equal(x.riskAmount,50);assert.equal(x.units,5);});
test("caps paper risk at two percent",()=>{assert.throws(()=>calculatePaperPosition({balance:10000,riskPct:2.1,entry:100,stop:90}),RangeError);});
test("calculates paper PnL",()=>{assert.equal(calculatePaperPnl({direction:"BUY",entry:100,exit:110,units:2}),20);assert.equal(calculatePaperPnl({direction:"SELL",entry:100,exit:90,units:2}),20);});
