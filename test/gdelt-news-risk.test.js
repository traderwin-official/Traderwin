import test from "node:test";
import assert from "node:assert/strict";
import {getGdeltNewsRiskStatus,resetGdeltNewsRiskCacheForTests} from "../lib/gdelt-news-risk.js";

const response=(payload,{ok=true,type="application/json"}={})=>({
 ok,headers:{get:name=>name==="content-type"?type:null},json:async()=>payload
});

test("GDELT adverse headline can only produce a blocking news status",async()=>{
 resetGdeltNewsRiskCacheForTests();
 const result=await getGdeltNewsRiskStatus({now:Date.UTC(2026,10,26),fetchImpl:async()=>response({articles:[{title:"Federal Reserve surprise rate decision announced",seendate:"20261126T000000Z",url:"https://example.test/a"}]})});
 assert.equal(result.status,"BLACKOUT");
 assert.equal(result.reason,"POTENTIAL_HIGH_IMPACT_HEADLINE");
 assert.equal(result.articles.length,1);
 assert.equal(result.provider,"GDELT_DOC_2_0");
});

test("stale or undated high-impact headlines cannot trigger a current blackout",async()=>{
 resetGdeltNewsRiskCacheForTests();
 const now=Date.UTC(2026,10,26,12,0,0);
 const result=await getGdeltNewsRiskStatus({now,fetchImpl:async()=>response({articles:[
  {title:"Federal Reserve surprise rate decision",seendate:"20261126T090000Z"},
  {title:"War and military strike",seendate:"not-a-date"},
  {title:"Emergency central bank action"}
 ]})});
 assert.equal(result.status,"UNKNOWN");
 assert.equal(result.reason,"NEWS_CLEARANCE_NOT_ESTABLISHED");
 assert.deepEqual(result.articles,[]);
});

test("empty news search never claims CLEAR",async()=>{
 resetGdeltNewsRiskCacheForTests();
 const result=await getGdeltNewsRiskStatus({now:Date.UTC(2026,10,26),fetchImpl:async()=>response({articles:[]})});
 assert.equal(result.status,"UNKNOWN");
 assert.equal(result.reason,"NEWS_CLEARANCE_NOT_ESTABLISHED");
});

test("provider errors and invalid content types fail closed",async()=>{
 resetGdeltNewsRiskCacheForTests();
 const http=await getGdeltNewsRiskStatus({now:Date.UTC(2026,10,26),fetchImpl:async()=>response({}, {ok:false})});
 assert.equal(http.status,"UNKNOWN");
 resetGdeltNewsRiskCacheForTests();
 const content=await getGdeltNewsRiskStatus({now:Date.UTC(2026,10,26),fetchImpl:async()=>response({}, {type:"text/html"})});
 assert.equal(content.status,"UNKNOWN");
});

test("GDELT result is cached to avoid excessive provider requests",async()=>{
 resetGdeltNewsRiskCacheForTests();
 let calls=0;
 const fetchImpl=async()=>{calls++;return response({articles:[]});};
 const now=Date.UTC(2026,10,26);
 await getGdeltNewsRiskStatus({now,fetchImpl});
 await getGdeltNewsRiskStatus({now:now+1000,fetchImpl});
 assert.equal(calls,1);
});

test("failed requests never authorize news clearance",async()=>{
 resetGdeltNewsRiskCacheForTests();
 const result=await getGdeltNewsRiskStatus({now:Date.UTC(2026,10,26),fetchImpl:async()=>{throw new Error("offline");}});
 assert.equal(result.status,"UNKNOWN");
 assert.equal(result.reason,"NEWS_PROVIDER_REQUEST_FAILED");
});


test("instrument-scoped query includes relevant gold context and identifies the instrument", async () => {
 resetGdeltNewsRiskCacheForTests();
 let requested;
 const result=await getGdeltNewsRiskStatus({
  instrument:"XAUUSD",
  now:Date.UTC(2026,10,26),
  fetchImpl:async url=>{
   requested=new URL(url);
   return response({articles:[]});
  }
 });
 assert.match(requested.searchParams.get("query"),/gold/i);
 assert.match(requested.searchParams.get("query"),/Federal Reserve/i);
 assert.equal(result.instrument,"XAUUSD");
 assert.equal(result.status,"UNKNOWN");
});

test("instrument news results are cached independently and unsupported symbols stay unknown", async () => {
 resetGdeltNewsRiskCacheForTests();
 let calls=0;
 const fetchImpl=async()=>{calls++;return response({articles:[]});};
 const now=Date.UTC(2026,10,26);
 await getGdeltNewsRiskStatus({instrument:"XAUUSD",now,fetchImpl});
 await getGdeltNewsRiskStatus({instrument:"EURUSD",now:now+1000,fetchImpl});
 assert.equal(calls,2);
 const unsupported=await getGdeltNewsRiskStatus({instrument:"R_100",now,fetchImpl});
 assert.equal(unsupported.status,"UNKNOWN");
 assert.equal(unsupported.reason,"NEWS_INSTRUMENT_NOT_MAPPED");
 assert.equal(calls,2);
});
