import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("individual DEMO mark endpoint cannot trigger per-trade profit giveback close",async()=>{
 const s=await readFile(new URL("../handlers/bots/demo/mark.js",import.meta.url),"utf8");
 assert.doesNotMatch(s,/calculateProfitProtection/);assert.doesNotMatch(s,/PROFIT_GIVEBACK_CLOSE/);
 assert.match(s,/scope:"PORTFOLIO"/);assert.match(s,/AWAITING_PORTFOLIO_MONITOR/);
});
