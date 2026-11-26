import test from "node:test";
import assert from "node:assert/strict";
import {applyOpenTradeSnapshot} from "../lib/scalping-trade-refresh.js";

test("worker restart rehydrates all open positions from the durable snapshot",()=>{
 const active=new Map(),pending=new Map(),locks=new Set();
 const rows=Array.from({length:15},(_,i)=>({id:"p"+(i+1),tp1_done:false,remaining_quantity:100}));
 const result=applyOpenTradeSnapshot({trades:rows,activeTrades:active,locks,pendingRefresh:pending,snapshotGeneration:1});
 assert.equal(active.size,15);
 assert.equal(result.open,15);
 assert.equal(result.pending,0);
});

test("successful partial-exit reconciliation replaces stale TP flags from the database",()=>{
 const active=new Map([["p1",{id:"p1",tp1_done:false,tp2_done:false}]]);
 const pending=new Map([["p1",2]]),locks=new Set();
 const result=applyOpenTradeSnapshot({trades:[{id:"p1",tp1_done:true,tp2_done:false,remaining_quantity:75}],activeTrades:active,locks,pendingRefresh:pending,snapshotGeneration:2});
 assert.deepEqual(active.get("p1"),{id:"p1",tp1_done:true,tp2_done:false,remaining_quantity:75});
 assert.equal(pending.has("p1"),false);
 assert.deepEqual(result,{open:1,pending:0});
});

test("an older in-flight snapshot cannot erase a later pending exit reconciliation",()=>{
 const active=new Map([["p1",{id:"p1",tp1_done:false}]]);
 const pending=new Map([["p1",3]]),locks=new Set();
 applyOpenTradeSnapshot({trades:[{id:"p1",tp1_done:false}],activeTrades:active,locks,pendingRefresh:pending,snapshotGeneration:2});
 assert.equal(active.get("p1").tp1_done,false);
 assert.equal(pending.get("p1"),3);
});

test("a fresh snapshot resolves pending state and updates the actual partial quantity",()=>{
 const active=new Map([["p1",{id:"p1",tp1_done:false}]]);
 const pending=new Map([["p1",3]]),locks=new Set();
 applyOpenTradeSnapshot({trades:[{id:"p1",tp1_done:true,remaining_quantity:60}],activeTrades:active,locks,pendingRefresh:pending,snapshotGeneration:3});
 assert.equal(active.get("p1").tp1_done,true);
 assert.equal(active.get("p1").remaining_quantity,60);
 assert.equal(pending.has("p1"),false);
});

test("uncertain position state stays quarantined while its manager holds the lock",()=>{
 const active=new Map([["p1",{id:"p1",tp1_done:false}]]),pending=new Map([["p1",2]]),locks=new Set(["p1"]);
 applyOpenTradeSnapshot({trades:[{id:"p1",tp1_done:true}],activeTrades:active,locks,pendingRefresh:pending,snapshotGeneration:2});
 assert.equal(active.get("p1").tp1_done,false);
 assert.equal(pending.has("p1"),true);
});

test("a pending position missing from a sufficiently new OPEN snapshot is removed as closed",()=>{
 const active=new Map([["p1",{id:"p1"}]]),pending=new Map([["p1",2]]),removed=[];
 applyOpenTradeSnapshot({trades:[],activeTrades:active,locks:new Set(),pendingRefresh:pending,snapshotGeneration:2,onRemoved:id=>removed.push(id)});
 assert.equal(active.has("p1"),false);
 assert.equal(pending.has("p1"),false);
 assert.deepEqual(removed,["p1"]);
});

test("ordinary refresh updates unlocked positions but never overwrites a locked position",()=>{
 const active=new Map([["p1",{id:"p1",tp1_done:false}],["p2",{id:"p2",tp1_done:false}]]);
 const locks=new Set(["p2"]),pending=new Map();
 applyOpenTradeSnapshot({trades:[{id:"p1",tp1_done:true},{id:"p2",tp1_done:true}],activeTrades:active,locks,pendingRefresh:pending,snapshotGeneration:1});
 assert.equal(active.get("p1").tp1_done,true);
 assert.equal(active.get("p2").tp1_done,false);
});
