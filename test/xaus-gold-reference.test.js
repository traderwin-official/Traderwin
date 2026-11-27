import test from "node:test";
import assert from "node:assert/strict";
import {getXausGoldReference,compareGoldReference,resetXausGoldReferenceCacheForTests} from "../lib/xaus-gold-reference.js";

const now=Date.parse("2026-11-26T12:00:00.000Z");
const payload=overrides=>({
 spot_usd_oz:4000,
 price_as_of:new Date(now-30000).toISOString(),
 updated_at:new Date(now-1000).toISOString(),
 data_state:{status:"fresh",source:"upstream",as_of:new Date(now-30000).toISOString()},
 price_source:"xaus.com",stale:false,...overrides
});
const response=(body,{ok=true,type="application/json"}={})=>({ok,headers:{get:n=>n==="content-type"?type:null},json:async()=>body});

test("accepts only fresh, timestamped, upstream XAU spot references",async()=>{
 resetXausGoldReferenceCacheForTests();
 const result=await getXausGoldReference({now,fetchImpl:async()=>response(payload())});
 assert.equal(result.status,"FRESH");assert.equal(result.price,4000);assert.equal(result.provider,"XAUS");
 assert.equal(result.indicative,true);assert.equal(result.executable,false);
});

test("stale, cached, malformed and unavailable references fail closed",async()=>{
 for(const body of [
  payload({stale:true}),
  payload({data_state:{status:"stale",source:"cache",as_of:new Date(now-30000).toISOString()}}),
  payload({price_as_of:new Date(now-240000).toISOString()}),
  payload({spot_usd_oz:0}),
  payload({price_as_of:"invalid"})
 ]){
  resetXausGoldReferenceCacheForTests();
  const result=await getXausGoldReference({now,fetchImpl:async()=>response(body)});
  assert.equal(result.status,"UNKNOWN");
 }
});

test("HTTP and content-type failures return UNKNOWN",async()=>{
 resetXausGoldReferenceCacheForTests();
 assert.equal((await getXausGoldReference({now,fetchImpl:async()=>response({}, {ok:false})})).status,"UNKNOWN");
 resetXausGoldReferenceCacheForTests();
 assert.equal((await getXausGoldReference({now,fetchImpl:async()=>response({}, {type:"text/html"})})).status,"UNKNOWN");
});

test("reference result is cached for the provider's 60-second freshness cadence",async()=>{
 resetXausGoldReferenceCacheForTests();let calls=0;
 const fetchImpl=async()=>{calls++;return response(payload());};
 await getXausGoldReference({now,fetchImpl});await getXausGoldReference({now:now+1000,fetchImpl});
 assert.equal(calls,1);
});

test("broker/reference comparison only passes within the configured discrepancy bound",()=>{
 const reference={status:"FRESH",provider:"XAUS",price:4000,asOf:new Date(now-30000).toISOString(),indicative:true,executable:false};
 assert.equal(compareGoldReference({brokerMid:4002,reference,now,maxDeviationBps:10}).status,"PASS");
 assert.equal(compareGoldReference({brokerMid:4020,reference,now,maxDeviationBps:10}).status,"BLOCK");
 assert.equal(compareGoldReference({brokerMid:4000,reference:{...reference,asOf:new Date(now-240000).toISOString()},now}).status,"UNKNOWN");
 assert.equal(compareGoldReference({brokerMid:4000,reference:{...reference,executable:true},now}).status,"UNKNOWN");
});
