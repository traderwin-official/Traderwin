import test from "node:test";
import assert from "node:assert/strict";
import {runInstrumentEntryAnalysis} from "../lib/scalping-entry-lock.js";

test("one slow instrument analysis cannot overlap another tick for the same instrument",async()=>{
 const locks=new Set();let release;let calls=0;
 const pending=new Promise(resolve=>{release=resolve;});
 const first=runInstrumentEntryAnalysis({instrument:"XAUUSD",locks,analyse:async()=>{calls++;await pending;return "done";}});
 await new Promise(resolve=>setImmediate(resolve));
 const second=await runInstrumentEntryAnalysis({instrument:"xauusd",locks,analyse:async()=>{calls++;}});
 assert.deepEqual(second,{skipped:true,reason:"ENTRY_ANALYSIS_ALREADY_RUNNING"});
 assert.equal(calls,1);
 release();
 assert.deepEqual(await first,{skipped:false,result:"done"});
 assert.equal(locks.size,0);
});

test("different instruments can analyse concurrently and failed analysis releases its lock",async()=>{
 const locks=new Set();let release;
 const pending=new Promise(resolve=>{release=resolve;});
 const first=runInstrumentEntryAnalysis({instrument:"XAUUSD",locks,analyse:()=>pending});
 const second=await runInstrumentEntryAnalysis({instrument:"EURUSD",locks,analyse:async()=>"independent"});
 assert.deepEqual(second,{skipped:false,result:"independent"});
 release();
 await first;
 await assert.rejects(runInstrumentEntryAnalysis({instrument:"XAUUSD",locks,analyse:async()=>{throw new Error("failed");}}),/failed/);
 assert.equal(locks.size,0);
});
