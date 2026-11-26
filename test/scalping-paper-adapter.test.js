import test from "node:test";
import assert from "node:assert/strict";
import {openScalpingPaperPosition as openPosition,manageScalpingPaperPosition as managePosition} from "../lib/scalping-paper-adapter.js";
const openScalpingPaperPosition = args => openPosition({leaseToken:"lease-token-1",...args});
const manageScalpingPaperPosition = args => managePosition({leaseToken:"lease-token-1",...args});

const session={id:"session-1",user_id:"user-1",broker:"DERIV",status:"RUNNING",instrument:"XAUUSD",starting_balance:10000,current_balance:10000,max_open_positions:15,max_total_open_risk_pct:5,risk_per_trade_pct:0.5,
 config_snapshot:{account_mode:"DEMO",execution:"WEBSITE_PAPER_ONLY"}};
const preference={enabled:true,paper_execution_enabled:true,account_mode:"DEMO",execution:"WEBSITE_PAPER_ONLY",max_risk_per_trade_pct:0.25,max_daily_loss_pct:1,max_open_positions:15};
const now=Date.now();
const paperDb=(rpc,rows=[])=>({
 rpc,
 from:table=>({
  select:()=>({eq:()=>({eq:()=>Promise.resolve({data:rows,error:null})})})
 })
});
const tick={source:"DERIV",instrument:"XAUUSD",bid:2000,ask:2000.1,quoteAsOf:new Date(now).toISOString(),receivedAt:new Date(now).toISOString()};
const signal={instrument:"XAUUSD",direction:"BUY",entry:2000.1,stopLoss:1990,takeProfit:2016};

test("paper adapter opens all 15 available positions through one atomic DEMO batch RPC",async()=>{
 let call;
 const db=paperDb(async(name,args)=>{call={name,args};return {data:{ok:true,trade_ids:Array.from({length:15},(_,i)=>"trade-"+(i+1)),opened_count:15},error:null};});
 const result=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,leaseToken:"lease-token-1",now});
 assert.equal(result.ok,true);
 assert.equal(call.name,"open_demo_scalping_paper_trade_batch_with_lease");
 assert.equal(call.args.p_lease_token,"lease-token-1");
 assert.equal(call.args.p_user_id,session.user_id);
 assert.equal(call.args.p_entries.length,15);
 assert.equal(call.args.p_entries[0].side,"BUY");
 assert.ok(call.args.p_entries[0].risk_pct<=0.25);
 assert.ok(call.args.p_entries[0].risk_amount<=25);
 assert.ok(call.args.p_entries[0].tp1<call.args.p_entries[0].tp2&&call.args.p_entries[0].tp2<call.args.p_entries[0].tp3);
 assert.ok(call.args.p_entries.reduce((sum,row)=>sum+row.risk_amount,0)<=100);
 assert.equal(call.args.p_entry_as_of,new Date(now).toISOString());
 assert.equal(call.args.p_entry_key,`quantum-batch:${session.id}:${signal.instrument}:${signal.direction}:${Math.floor(Date.parse(tick.quoteAsOf)/1000)}`);
 assert.equal(call.args.p_entries[0].candle_as_of,new Date(Math.floor(now/60000)*60*1000).toISOString());
});

test("paper adapter refuses a non-opted-in or REAL session without calling the database",async()=>{
 let called=false;
 const db=paperDb(async()=>{called=true;return {data:{ok:true},error:null};});
 const disabled=await openScalpingPaperPosition({db,session,preference:{...preference,enabled:false},signal,tick,candleEpoch:Math.floor(now/60000)*60});
 const realSession={...session,config_snapshot:{account_mode:"REAL",execution:"BROKER_ORDER"}};
 const real=await openScalpingPaperPosition({db,session:realSession,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60});
 assert.equal(disabled.reason,"SCALPING_DEMO_OPT_IN_REQUIRED");
 assert.equal(real.reason,"ELIGIBLE_RUNNING_DERIV_DEMO_SESSION_REQUIRED");
 assert.equal(called,false);
});

test("paper adapter refuses unsupported quote conversion and stale entry quotes",async()=>{
 let called=false;
 const db={rpc:async()=>{called=true;return {data:{ok:true},error:null};}};
 const conversion=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:null,leaseToken:"lease-token-1",now});
 const staleTick={...tick,receivedAt:new Date(now-5000).toISOString()};
 const stale=await openScalpingPaperPosition({db,session,preference,signal,tick:staleTick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(conversion.reason,"USD_CONVERSION_UNAVAILABLE");
 assert.equal(stale.reason,"FRESH_VERIFIED_DERIV_BID_ASK_REQUIRED");
 assert.equal(called,false);
});

test("paper adapter refuses spot-only or invalid bid/ask quotes before any database access",async()=>{
 let called=false;
 const db=paperDb(async()=>{called=true;return {data:{ok:true},error:null};});
 const noBid=await openScalpingPaperPosition({db,session,preference,signal,tick:{...tick,bid:undefined},candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 const noAsk=await openScalpingPaperPosition({db,session,preference,signal,tick:{...tick,ask:undefined},candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 const crossed=await openScalpingPaperPosition({db,session,preference,signal,tick:{...tick,bid:2001,ask:2000},candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(noBid.reason,"FRESH_VERIFIED_DERIV_BID_ASK_REQUIRED");
 assert.equal(noAsk.reason,"FRESH_VERIFIED_DERIV_BID_ASK_REQUIRED");
 assert.equal(crossed.reason,"FRESH_VERIFIED_DERIV_BID_ASK_REQUIRED");
 assert.equal(called,false);
});

test("paper adapter closes only tagged scalping BOT positions through the existing staged-exit RPC",async()=>{
 let call;
 const db=paperDb(async(name,args)=>{call={name,args};return {data:{ok:true,stage:args.p_stage},error:null};});
 const trade={id:"trade-1",user_id:"user-1",status:"OPEN",trade_origin:"BOT",
  metadata:{strategy:"TIGER_SCHEME_QUANTUM_SCALPING"},side:"BUY",stop_loss:"1990",
  tp1_price:"2007.5",tp2_price:"2011",tp3_price:"2016",tp1_done:false,tp2_done:false,tp3_done:false,quote_to_usd:"1"};
 const exit=await manageScalpingPaperPosition({db,trade,tick:{...tick,bid:2008,ask:2008.1},now});
 assert.equal(exit.stage,"TP1");
 assert.equal(call.name,"manage_demo_scalping_paper_exit_with_lease");
 assert.equal(call.args.p_lease_token,"lease-token-1");
 assert.equal(call.args.p_stage,"TP1");
});

test("paper adapter leaves other bot positions and stale quotes untouched",async()=>{
 let calls=0;
 const db=paperDb(async()=>{calls++;return {data:{ok:true},error:null};});
 const trade={id:"trade-2",user_id:"user-1",status:"OPEN",trade_origin:"BOT",metadata:{strategy:"OTHER"},side:"BUY"};
 const other=await manageScalpingPaperPosition({db,trade,tick,now});
 const tagged={...trade,metadata:{strategy:"TIGER_SCHEME_QUANTUM_SCALPING"},stop_loss:1990,tp1_price:2007,tp2_price:2011,tp3_price:2016,tp1_done:false,tp2_done:false,tp3_done:false,quote_to_usd:1};
 const stale=await manageScalpingPaperPosition({db,trade:tagged,tick:{...tick,receivedAt:new Date(now-5000).toISOString()},now});
 assert.equal(other.reason,"NOT_A_SCALPING_BOT_POSITION");
 assert.equal(stale.reason,"EXIT_QUOTE_STALE");
 assert.equal(calls,0);
});

test("paper adapter respects a stricter saved session risk ceiling",async()=>{
 let args;
 const db=paperDb(async(name,value)=>{args=value;return {data:{ok:true,trade_ids:["trade-2"],opened_count:1},error:null};});
 const stricter={...session,risk_per_trade_pct:0.1};
 const result=await openScalpingPaperPosition({db,session:stricter,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(result.ok,true);
 assert.ok(args.p_entries.every(entry=>entry.risk_pct<=0.1));
 assert.ok(args.p_entries.every(entry=>entry.risk_amount<=10));
});

test("paper adapter refuses automatic entries unless the separate paper-execution switch is enabled",async()=>{
 let called=false;
 const db={rpc:async()=>{called=true;return {data:{ok:true},error:null};}};
 const feedOnly=await openScalpingPaperPosition({db,session,preference:{...preference,paper_execution_enabled:false},signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(feedOnly.reason,"SCALPING_DEMO_OPT_IN_REQUIRED");
 assert.equal(called,false);
});

test("portfolio risk is divided across remaining slots for a one-position atomic batch",async()=>{
 let args;
 const rows=Array.from({length:14},()=>({risk_amount_usd:6.66,quantity:666,remaining_quantity:666}));
 const db=paperDb(async(name,value)=>{args=value;return {data:{ok:true,trade_ids:["trade-15"],opened_count:1},error:null};},rows);
 const result=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(result.ok,true);
 assert.equal(args.p_entries.length,1);
 assert.ok(args.p_entries[0].risk_amount<=6.76);
 assert.ok(args.p_entries[0].risk_pct<0.07);
});

test("portfolio refuses a sixteenth open position before requesting an entry",async()=>{
 let called=false;
 const rows=Array.from({length:15},()=>({risk_amount_usd:6.66,quantity:666,remaining_quantity:666}));
 const db=paperDb(async()=>{called=true;return {data:{ok:true},error:null};},rows);
 const result=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(result.reason,"SCALPING_MAX_OPEN_POSITIONS");
 assert.equal(called,false);
});

test("paper position management refuses missing worker lease before database access",async()=>{
 let called=false;
 const db=paperDb(async()=>{called=true;return {data:true,error:null};});
 const trade={id:"trade-3",user_id:"user-1",status:"OPEN",trade_origin:"BOT",
  metadata:{strategy:"TIGER_SCHEME_QUANTUM_SCALPING"},side:"BUY",stop_loss:1990,
  tp1_price:2007,tp2_price:2011,tp3_price:2016,tp1_done:false,tp2_done:false,tp3_done:false,quote_to_usd:1};
 const result=await managePosition({db,trade,tick:{...tick,bid:2008,ask:2008.1},now});
 assert.equal(result.reason,"SCALPING_WORKER_LEASE_NOT_OWNED");
 assert.equal(called,false);
});


test("paper adapter recovers a committed batch when the original RPC response is lost",async()=>{
 const calls=[];
 const db=paperDb(async(name,args)=>{
  calls.push(name);
  if(name==="open_demo_scalping_paper_trade_batch_with_lease")return {data:null,error:new Error("socket hang up after commit")};
  return {data:{ok:true,trade_ids:["trade-a","trade-b"],opened_count:2,batch_key:args.p_entry_key,recovered:true},error:null};
 });
 const result=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,leaseToken:"lease-token-1",now});
 assert.equal(result.ok,true);
 assert.equal(result.recovered,true);
 assert.deepEqual(result.trade_ids,["trade-a","trade-b"]);
 assert.deepEqual(calls,["open_demo_scalping_paper_trade_batch_with_lease","get_demo_scalping_entry_batch_with_lease"]);
});

test("paper adapter retries an absent batch once with the identical idempotency key",async()=>{
 const calls=[];
 const db=paperDb(async(name,args)=>{
  calls.push({name,args});
  if(name==="open_demo_scalping_paper_trade_batch_with_lease"){
   if(calls.filter(x=>x.name===name).length===1)return {data:null,error:new Error("temporary network failure")};
   return {data:{ok:true,trade_ids:["trade-retry"],opened_count:1},error:null};
  }
  return {data:{ok:false,reason:"SCALPING_BATCH_NOT_FOUND"},error:null};
 });
 const result=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,leaseToken:"lease-token-1",now});
 assert.equal(result.ok,true);
 const openCalls=calls.filter(x=>x.name==="open_demo_scalping_paper_trade_batch_with_lease");
 assert.equal(openCalls.length,2);
 assert.equal(openCalls[0].args.p_entry_key,openCalls[1].args.p_entry_key);
 assert.equal(openCalls[0].args.p_entry_as_of,openCalls[1].args.p_entry_as_of);
 assert.equal(calls.filter(x=>x.name==="get_demo_scalping_entry_batch_with_lease").length,1);
});

test("paper adapter never retries a batch when recovery itself fails",async()=>{
 let openCalls=0;
 const db=paperDb(async(name)=>{
  if(name==="open_demo_scalping_paper_trade_batch_with_lease"){openCalls++;return {data:null,error:new Error("network failure")};}
  return {data:null,error:new Error("recovery unavailable")};
 });
 await assert.rejects(()=>openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,leaseToken:"lease-token-1",now}),/network failure/);
 assert.equal(openCalls,1);
});


test("paper adapter restores trade IDs when the database reports an already-processed batch key",async()=>{
 const calls=[];
 const db=paperDb(async(name,args)=>{
  calls.push(name);
  if(name==="open_demo_scalping_paper_trade_batch_with_lease")return {data:{ok:false,reason:"SCALPING_ENTRY_ALREADY_PROCESSED"},error:null};
  return {data:{ok:true,trade_ids:["existing-a","existing-b"],opened_count:2,recovered:true,batch_key:args.p_entry_key},error:null};
 });
 const result=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,leaseToken:"lease-token-1",now});
 assert.equal(result.ok,true);
 assert.equal(result.recovered,true);
 assert.deepEqual(result.trade_ids,["existing-a","existing-b"]);
 assert.deepEqual(calls,["open_demo_scalping_paper_trade_batch_with_lease","get_demo_scalping_entry_batch_with_lease"]);
});

test("paper adapter rejects malformed durable batch recovery and never retries it",async()=>{
 let openCalls=0,recoveryCalls=0;
 const db=paperDb(async(name)=>{
  if(name==="open_demo_scalping_paper_trade_batch_with_lease"){openCalls++;return {data:null,error:new Error("lost response")};}
  recoveryCalls++;
  return {data:{ok:true,batch_key:"wrong-key",trade_ids:["trade-a","trade-b"],opened_count:1},error:null};
 });
 await assert.rejects(()=>openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,leaseToken:"lease-token-1",now}),/lost response/);
 assert.equal(openCalls,1);
 assert.equal(recoveryCalls,1);
});
