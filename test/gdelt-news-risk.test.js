import test from "node:test";
import assert from "node:assert/strict";
import {getGdeltNewsRiskStatus,resetGdeltNewsRiskCacheForTests} from "../lib/gdelt-news-risk.js";

const response=(payload,{ok=true,type="application/json"}={})=>({
 ok,headers:{get:name=>name==="content-type"?type:null},json:async()=>payload
});

test("GDELT adverse headline can only produce a blocking news status",async()=>{
 resetGdeltNewsRiskCacheForTests();
 const result=await getGdeltNewsRiskStatus({now:Date.UTC(2026,10,26),fetchImpl:async()=>response({articles:[{title:"Federal Reserve surprise rate decision announced",url:"https://example.test/a"}]})});
 assert.equal(result.status,"BLACKOUT");
 assert.equal(result.reason,"POTENTIAL_HIGH_IMPACT_HEADLINE");
 assert.equal(result.articles.length,1);
 assert.equal(result.provider,"GDELT_DOC_2_0");
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
