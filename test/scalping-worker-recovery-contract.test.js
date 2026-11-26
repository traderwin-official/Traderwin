import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const worker=readFileSync(new URL("../services/scalping-worker/index.js",import.meta.url),"utf8");
const docker=readFileSync(new URL("../services/scalping-worker/Dockerfile",import.meta.url),"utf8");

test("worker rejects out-of-order ticks before exits and candle processing",()=>{
 const start=worker.indexOf("async function publishTick(");
 const end=worker.indexOf("\nfunction closeSocket",start);
 assert.notEqual(start,-1);
 assert.notEqual(end,-1);
 const publish=worker.slice(start,end);
 const guard=publish.indexOf("acceptMonotonicMarketTick(");
 const exits=publish.indexOf("manageOpenTrades(");
 const candle=publish.indexOf("const minute=Math.floor(epoch/60)*60");
 assert.ok(guard>=0&&exits>guard&&candle>guard,"tick ordering must run before exits and candle updates");
});

test("worker rehydrates durable open trades before reconnecting its market feed",()=>{
 const reconcile=worker.slice(worker.indexOf("async function reconcile(){"));
 const refresh=reconcile.indexOf("await refreshOpenTrades()");
 const subscribe=reconcile.indexOf("await subscribeSet(desired)");
 assert.ok(refresh>=0&&subscribe>refresh);
 assert.match(worker,/tradeStateReady\?\[\.\.\.activeTrades\.values\(\)\]/);
});

test("overlapping periodic and reconnect reconciliation calls share one in-flight run",()=>{
 assert.match(worker,/if\(reconcileInFlight\)return reconcileInFlight/);
 assert.match(worker,/finally\{reconcileInFlight=null;\}/);
});

test("worker image contains both shared modules used by absolute import paths",()=>{
 assert.match(docker,/COPY lib\/scalping-tick-order\.js \/lib\/scalping-tick-order\.js/);
 assert.match(docker,/COPY lib\/scalping-trade-refresh\.js \/lib\/scalping-trade-refresh\.js/);
});

test("worker resumes live quotes before history warm-up but gates new entries",()=>{
 const active=worker.indexOf('if(msg.msg_type==="active_symbols")');
 const tickSubscribe=worker.indexOf('ws.send(JSON.stringify({ticks:wanted.providerSymbol,subscribe:1}))',active);
 const historyRequests=worker.indexOf('for(const [kind,granularity,count] of requests)',active);
 assert.ok(active>=0&&tickSubscribe>active&&historyRequests>tickSubscribe,
  "live quote subscription must start before requesting/waiting for candle history");
 const publishStart=worker.indexOf("async function publishTick(");
 const publishEnd=worker.indexOf("\nfunction closeSocket",publishStart);
 const publish=worker.slice(publishStart,publishEnd);
 assert.ok(publish.indexOf("manageOpenTrades(")<publish.indexOf("const h=history.get(wanted.instrument)"),
  "open positions must be managed before the history warm-up return");
 assert.match(publish,/if\(!h\|\|h\.m1\.length<35\)return/);
});

test("health check treats connected quote service as healthy during candle warm-up",()=>{
 assert.match(worker,/state\.socket==="CONNECTED"&&state\.subscribed\.length>0/);
 assert.doesNotMatch(worker,/state\.socket==="CONNECTED"&&state\.readySymbols\.length>0/);
});

test("worker records reconnect gaps and never synthesizes an exit price from missing history",()=>{
 assert.match(worker,/detectMarketDataGap\(/);
 assert.match(worker,/lastMarketDataGap:null/);
 const start=worker.indexOf("async function publishTick(");
 const end=worker.indexOf("\nfunction closeSocket",start);
 const publish=worker.slice(start,end);
 assert.ok(publish.indexOf("detectMarketDataGap(")<publish.indexOf("manageOpenTrades("));
 assert.ok(publish.indexOf("manageOpenTrades(")<publish.indexOf("const h=history.get(wanted.instrument)"));
 assert.match(publish,/if\(!h\|\|h\.m1\.length<35\)return/);
});
