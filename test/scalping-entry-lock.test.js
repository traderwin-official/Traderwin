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

test("open positions keep exiting while a separate instrument entry analysis is awaiting intelligence",async()=>{
 const entryLocks=new Set(),positionLocks=new Set();let releaseAnalysis;
 const analysisPending=new Promise(resolve=>{releaseAnalysis=resolve;});
 const entry=runInstrumentEntryAnalysis({instrument:"XAUUSD",locks:entryLocks,analyse:()=>analysisPending});
 await new Promise(resolve=>setImmediate(resolve));
 const exits=[];
 const {manageTradesIndependently}=await import("../lib/scalping-trade-concurrency.js");
 const managed=await manageTradesIndependently({
  trades:[{id:"position-1"},{id:"position-2"}],locks:positionLocks,
  manage:async trade=>{exits.push(trade.id);}
 });
 assert.equal(managed,true);
 assert.deepEqual(exits,["position-1","position-2"]);
 assert.equal(entryLocks.has("XAUUSD"),true);
 assert.equal(positionLocks.size,0);
 releaseAnalysis("candidate");
 assert.deepEqual(await entry,{skipped:false,result:"candidate"});
 assert.equal(entryLocks.size,0);
});
