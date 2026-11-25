import test from "node:test";
import assert from "node:assert/strict";
import {openScalpingPaperPosition,manageScalpingPaperPosition} from "../lib/scalping-paper-adapter.js";

const session={id:"session-1",user_id:"user-1",broker:"DERIV",status:"RUNNING",instrument:"XAUUSD",starting_balance:10000,current_balance:10000,risk_per_trade_pct:0.5,
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

test("paper adapter opens only through the strict server-side DEMO RPC and sizes at 0.25 percent",async()=>{
 let call;
 const db=paperDb(async(name,args)=>{call={name,args};return {data:{ok:true,trade_id:"trade-1"},error:null};});
 const result=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(result.ok,true);
 assert.equal(call.name,"open_demo_scalping_paper_trade");
 assert.equal(call.args.p_user_id,session.user_id);
 assert.equal(call.args.p_side,"BUY");
 assert.ok(call.args.p_risk_pct<=0.25);
 assert.ok(call.args.p_risk_amount<=25);
 assert.ok(call.args.p_tp1<call.args.p_tp2&&call.args.p_tp2<call.args.p_tp3);
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
 const conversion=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:null,now});
 const staleTick={...tick,receivedAt:new Date(now-5000).toISOString()};
 const stale=await openScalpingPaperPosition({db,session,preference,signal,tick:staleTick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(conversion.reason,"USD_CONVERSION_UNAVAILABLE");
 assert.equal(stale.reason,"FRESH_VERIFIED_DERIV_BID_ASK_REQUIRED");
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
 assert.equal(call.name,"manage_demo_paper_exit");
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
 const db=paperDb(async(name,value)=>{args=value;return {data:{ok:true,trade_id:"trade-2"},error:null};});
 const stricter={...session,risk_per_trade_pct:0.1};
 const result=await openScalpingPaperPosition({db,session:stricter,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(result.ok,true);
 assert.ok(args.p_risk_pct<=0.1);
 assert.ok(args.p_risk_amount<=10);
});

test("paper adapter refuses automatic entries unless the separate paper-execution switch is enabled",async()=>{
 let called=false;
 const db={rpc:async()=>{called=true;return {data:{ok:true},error:null};}};
 const feedOnly=await openScalpingPaperPosition({db,session,preference:{...preference,paper_execution_enabled:false},signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(feedOnly.reason,"SCALPING_DEMO_OPT_IN_REQUIRED");
 assert.equal(called,false);
});

test("portfolio risk is divided across remaining slots so 15 entries fit inside the 1 percent aggregate cap",async()=>{
 let args;
 const rows=Array.from({length:14},()=>({risk_amount_usd:6.66,quantity:666,remaining_quantity:666}));
 const db=paperDb(async(name,value)=>{args=value;return {data:{ok:true,trade_id:"trade-15"},error:null};},rows);
 const result=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(result.ok,true);
 assert.ok(args.p_risk_amount<=6.68);
 assert.ok(args.p_risk_pct<0.07);
});

test("portfolio refuses a sixteenth open position before requesting an entry",async()=>{
 let called=false;
 const rows=Array.from({length:15},()=>({risk_amount_usd:6.66,quantity:666,remaining_quantity:666}));
 const db=paperDb(async()=>{called=true;return {data:{ok:true},error:null};},rows);
 const result=await openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch:Math.floor(now/60000)*60,quoteToUsd:1,now});
 assert.equal(result.reason,"SCALPING_MAX_OPEN_POSITIONS");
 assert.equal(called,false);
});
