import test from "node:test";
import assert from "node:assert/strict";
import {manageTradesIndependently} from "../lib/scalping-trade-concurrency.js";

function deferred(){
 let resolve,reject;
 const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
 return {promise,resolve,reject};
}

test("overlapping tick batches cannot manage the same position twice",async()=>{
 const locks=new Set(),started=deferred(),release=deferred();
 let calls=0;
 const first=manageTradesIndependently({
  trades:[{id:"p1"}],locks,
  manage:async()=>{calls++;started.resolve();await release.promise;}
 });
 await started.promise;
 const second=await manageTradesIndependently({
  trades:[{id:"p1"}],locks,
  manage:async()=>{calls++;}
 });
 assert.equal(second,true);
 assert.equal(calls,1);
 assert.equal(locks.has("p1"),true);
 release.resolve();
 assert.equal(await first,true);
 assert.equal(locks.has("p1"),false);
});

test("duplicate IDs in one tick batch are managed exactly once",async()=>{
 const locks=new Set();let calls=0;
 const ok=await manageTradesIndependently({
  trades:[{id:"p1"},{id:"p1"},{id:"p2"},{id:"p2"}],locks,
  manage:async()=>{calls++;}
 });
 assert.equal(ok,true);
 assert.equal(calls,2);
 assert.equal(locks.size,0);
});

test("one failed position does not block sibling exits and releases every lock",async()=>{
 const locks=new Set(),completed=[];
 const errors=[];
 const ok=await manageTradesIndependently({
  trades:[{id:"bad"},{id:"good"}],locks,
  manage:async trade=>{
   if(trade.id==="bad")throw new Error("simulated exit write failure");
   completed.push(trade.id);
  },
  onError:error=>errors.push(error.message)
 });
 assert.equal(ok,false);
 assert.deepEqual(completed,["good"]);
 assert.deepEqual(errors,["simulated exit write failure"]);
 assert.equal(locks.size,0);
});

test("pre-existing lock skips a position without disturbing its owner",async()=>{
 const locks=new Set(["p1"]);let calls=0;
 const ok=await manageTradesIndependently({
  trades:[{id:"p1"},{id:"p2"}],locks,
  manage:async()=>{calls++;}
 });
 assert.equal(ok,true);
 assert.equal(calls,1);
 assert.equal(locks.has("p1"),true);
 assert.equal(locks.size,1);
});
