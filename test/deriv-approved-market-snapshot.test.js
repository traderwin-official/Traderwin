import test from "node:test";
import assert from "node:assert/strict";
import { loadApprovedDerivMarketSnapshot } from "../lib/deriv/load-approved-market-snapshot.js";

const now=1_800_000_000_000;
const row={broker:"DERIV",instrument:"EURUSD",provider:"DERIV",provider_symbol:"frxEURUSD",
 status:"APPROVED",is_active:true,approved_by:"admin-user",approved_at:"2026-11-20T10:00:00.000Z"};
const tick={instrument:"EURUSD",providerSymbol:"frxEURUSD",source:"DERIV",quote:1.1,
 quoteAsOf:new Date(now).toISOString(),bid:1.0999,ask:1.1001,
 bidAsOf:new Date(now).toISOString(),askAsOf:new Date(now).toISOString(),
 receivedAt:new Date(now).toISOString()};
function fakeDb({data=[row],error=null}={}) {
 const query={from(){return this;},select(){return this;},eq(){return this;},
  limit(){return Promise.resolve({data,error});}};
 return query;
}
const getSnapshot=async()=>({
 instrument:"EURUSD",providerSymbol:"frxEURUSD",provider:"DERIV_SERVER_ADAPTER",
 dataStatus:"LIVE",bid:tick.bid,ask:tick.ask,timestampEpoch:now/1000,
 bidTimestampEpoch:now/1000,askTimestampEpoch:now/1000,receivedAt:tick.receivedAt,
 source:"DERIV",isTrusted:true
});
const options={now:()=>now,getSnapshot};

test("requires both a fresh valid snapshot and exact approved registry mapping",async()=>{
 const result=await loadApprovedDerivMarketSnapshot(fakeDb(),"EURUSD",options);
 assert.equal(result.approved,true);
 assert.equal(result.valid,true);
 assert.equal(result.paperOnly,true);
 assert.equal(result.approval.providerSymbol,"frxEURUSD");
 assert.equal(result.market.bid,1.0999);
});

test("blocks pending, disabled, missing, ambiguous and wrong provider mappings",async()=>{
 for(const data of [
  [],[{...row,status:"PENDING",is_active:false,approved_by:null,approved_at:null}],
  [{...row,status:"DISABLED",is_active:false}],
  [row,{...row}],
  [{...row,provider_symbol:"EURUSD"}]
 ]) {
  const result=await loadApprovedDerivMarketSnapshot(fakeDb({data}),"EURUSD",options);
  assert.equal(result.approved,false);
  assert.equal(result.status,"BLOCKED");
 }
});

test("blocks database errors and unavailable bid/ask data",async()=>{
 const dbError=await loadApprovedDerivMarketSnapshot(fakeDb({error:{message:"offline"}}),"EURUSD",options);
 assert.equal(dbError.reason,"INSTRUMENT_APPROVAL_LOOKUP_FAILED");
 const noQuote=await loadApprovedDerivMarketSnapshot(fakeDb(),"EURUSD",{
  ...options,getSnapshot:async()=>{throw new Error("no bid ask");}
 });
 assert.equal(noQuote.reason,"TRUSTED_MARKET_SNAPSHOT_UNAVAILABLE");
});

test("blocks a valid but too-wide spread",async()=>{
 const result=await loadApprovedDerivMarketSnapshot(fakeDb(),"EURUSD",{
  ...options,getSnapshot:async()=>({...await getSnapshot(),bid:1.09,ask:1.11})
 });
 assert.equal(result.approved,false);
 assert.equal(result.reason,"SPREAD_TOO_WIDE");
});

test("blocks stale snapshots even when the instrument is approved",async()=>{
 const result=await loadApprovedDerivMarketSnapshot(fakeDb(),"EURUSD",{
  ...options,getSnapshot:async()=>({...await getSnapshot(),timestampEpoch:now/1000-11})
 });
 assert.equal(result.approved,false);
 assert.equal(result.reason,"MARKET_DATA_STALE");
});
