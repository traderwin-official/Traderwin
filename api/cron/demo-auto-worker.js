import {randomUUID} from "node:crypto";
import {createClient} from "@supabase/supabase-js";
import {getDerivPublicQuote} from "../../lib/deriv-public-quote.js";
import {getDerivCandles} from "../../lib/deriv-candles.js";
import {getDerivQuoteToUsd} from "../../lib/usd-conversion.js";
import {loadApprovedInstrument} from "../../lib/deriv/load-approved-instrument.js";
import {decideDemoAutoAction} from "../../lib/demo-auto-decision.js";
import {runDemoPortfolioProtection} from "../../lib/demo-portfolio-protection-runner.js";
export const config={maxDuration:25};
const MAX_SESSIONS_PER_TICK=3;
const safeError=e=>String(e?.message||"Worker step failed").slice(0,240);
const normalise=v=>String(v||"").trim().toUpperCase().replace(/[\s/.-]/g,"");

async function processSession(db,raw){
 const session={...raw,account_mode:"DEMO",current_balance:Number(raw.current_balance),
  max_risk_per_trade_pct:Number(raw.risk_per_trade_pct),worker_last_candle_as_of:raw.last_candle_as_of};
 const settings={...(raw.config_snapshot||{}),broker:raw.broker,instrument:raw.instrument,
  account_mode:"DEMO",strategy:raw.strategy,timeframe:raw.timeframe};
 const [{data:emergency,error:emergencyError},{data:legacyEmergency,error:legacyEmergencyError}]=await Promise.all([
  db.from("demo_paper_emergency_controls").select("entries_blocked").eq("user_id",raw.user_id).eq("broker","DERIV").eq("broker_account_ref",raw.broker_account_ref).maybeSingle(),
  db.from("bot_emergency_controls").select("kill_switch_active").eq("user_id",raw.user_id).eq("account_mode","DEMO").eq("broker","DERIV").eq("broker_account_ref",raw.broker_account_ref).maybeSingle()
 ]);
 const {data:t,error:tradeError}=await db.from("demo_paper_trades")
  .select("id,instrument,side,entry_price,stop_loss,take_profit,tp1_price,tp2_price,tp3_price,tp1_done,tp2_done,tp3_done,quantity,remaining_quantity,status,trade_origin")
  .eq("session_id",raw.id).eq("user_id",raw.user_id).eq("status","OPEN").eq("trade_origin","BOT").maybeSingle();
 if(tradeError)return {sessionId:raw.id,action:"ERROR",reason:"OPEN_TRADE_LOOKUP_FAILED"};
 if((emergencyError||legacyEmergencyError)&&!t)return {sessionId:raw.id,action:"BLOCK",reason:"EMERGENCY_STATUS_UNAVAILABLE"};
 const openTrade=t?{...t,symbol:t.instrument,direction:t.side,virtual_units:Number(t.remaining_quantity)}:null;
 if(["PAUSED","RISK_LOCKED"].includes(raw.status)&&!openTrade)return {sessionId:raw.id,action:"SKIP",reason:"SESSION_PAUSED_NO_OPEN_POSITION"};
 if((emergency?.entries_blocked||legacyEmergency?.kill_switch_active)&&!openTrade)return {sessionId:raw.id,action:"BLOCK",reason:"EMERGENCY_STOP_ACTIVE"};
 let quote;
 try{quote=await getDerivPublicQuote(raw.instrument);}catch(e){return {sessionId:raw.id,action:"BLOCK",reason:"QUOTE_UNAVAILABLE",detail:safeError(e)};}
 try{const fx=await getDerivQuoteToUsd(raw.instrument,quote);quote.quoteToUsd=fx.rate;quote.conversionSource=fx.source;quote.conversionAsOf=fx.asOf;}
 catch(e){return {sessionId:raw.id,action:"BLOCK",reason:"USD_CONVERSION_UNAVAILABLE",detail:safeError(e)};}
 let market=null;
 if(!openTrade){
  try{
   const selected=await getDerivCandles(raw.instrument,raw.timeframe||"M15");
   const trend=(raw.strategy==="TIGER_FIBONACCI_PSYCHOLOGY_V1"&&raw.timeframe!=="H1")?await getDerivCandles(raw.instrument,"H1"):selected;
   market={...selected,trendCandles:trend.candles};
  }catch(e){return {sessionId:raw.id,action:"BLOCK",reason:"CANDLE_HISTORY_UNAVAILABLE",detail:safeError(e)};}
 }
 let decision;
 try{decision=decideDemoAutoAction({session,settings,quote,market,openTrade,now:Date.now()});}
 catch(e){return {sessionId:raw.id,action:"ERROR",reason:"DECISION_ENGINE_FAILED",detail:safeError(e)};}
 if(decision.action==="MARK"){
  const {data:ok,error}=await db.rpc("mark_demo_paper_trade",{p_user_id:raw.user_id,p_trade_id:openTrade.id,p_price:quote.quote,p_quote_as_of:quote.quoteAsOf});
  return error||!ok?{sessionId:raw.id,action:"ERROR",reason:"MARK_SAVE_FAILED"}:{sessionId:raw.id,action:"MARK",tradeId:openTrade.id};
 }
 if(decision.action==="TAKE_PROFIT"||decision.action==="CLOSE"){
  const stage=decision.action==="CLOSE"?"STOP_LOSS":decision.stage;
  const {data:r,error}=await db.rpc("manage_demo_paper_exit",{p_user_id:raw.user_id,p_trade_id:decision.tradeId,p_stage:stage,p_exit_price:quote.quote,p_quote_to_usd:quote.quoteToUsd,p_quote_source:quote.source,p_quote_as_of:quote.quoteAsOf});
  if(error)return {sessionId:raw.id,action:"ERROR",reason:"ATOMIC_EXIT_FAILED",detail:safeError(error)};
  return r?.ok?{sessionId:raw.id,action:decision.action,reason:stage,tradeId:decision.tradeId,closed:r.closed,closedUnits:r.closed_units,remainingUnits:r.remaining_units,realizedPnl:r.realized_pnl_this_stage}:{sessionId:raw.id,action:"SKIP",reason:r?.reason||"EXIT_NOT_APPLIED"};
 }
 if(decision.action==="OPEN"){
  // Close the time-of-check/time-of-use gap: fetch a second server quote,
  // refresh the emergency controls, and rerun the same strategy before the
  // atomic paper-entry RPC. The browser never supplies this snapshot.
  let entryQuote;
  try{entryQuote=await getDerivPublicQuote(raw.instrument);}
  catch(e){return {sessionId:raw.id,action:"BLOCK",reason:"ENTRY_RECHECK_QUOTE_UNAVAILABLE",detail:safeError(e)};}
  try{
   const fx=await getDerivQuoteToUsd(raw.instrument,entryQuote);
   entryQuote.quoteToUsd=fx.rate;
   entryQuote.conversionSource=fx.source;
   entryQuote.conversionAsOf=fx.asOf;
  }catch(e){return {sessionId:raw.id,action:"BLOCK",reason:"ENTRY_RECHECK_USD_CONVERSION_UNAVAILABLE",detail:safeError(e)};}
  const [{data:latestEmergency,error:latestEmergencyError},{data:latestLegacyEmergency,error:latestLegacyEmergencyError}]=await Promise.all([
   db.from("demo_paper_emergency_controls").select("entries_blocked").eq("user_id",raw.user_id).eq("broker","DERIV").eq("broker_account_ref",raw.broker_account_ref).maybeSingle(),
   db.from("bot_emergency_controls").select("kill_switch_active").eq("user_id",raw.user_id).eq("account_mode","DEMO").eq("broker","DERIV").eq("broker_account_ref",raw.broker_account_ref).maybeSingle()
  ]);
  if(latestEmergencyError||latestLegacyEmergencyError)return {sessionId:raw.id,action:"BLOCK",reason:"ENTRY_RECHECK_EMERGENCY_STATUS_UNAVAILABLE"};
  if(latestEmergency?.entries_blocked||latestLegacyEmergency?.kill_switch_active)return {sessionId:raw.id,action:"BLOCK",reason:"EMERGENCY_STOP_ACTIVE"};
  const rechecked=decideDemoAutoAction({session,settings,quote:entryQuote,market,openTrade:null,now:Date.now()});
  if(rechecked.action!=="OPEN"||rechecked.symbol!==decision.symbol||rechecked.direction!==decision.direction){
   return {sessionId:raw.id,action:"SKIP",reason:"ENTRY_RECHECK_NO_LONGER_VALID",detail:rechecked.reason||rechecked.action};
  }
  const approval=await loadApprovedInstrument(db,{broker:"DERIV",instrument:decision.symbol,providerSymbol:entryQuote.providerSymbol});
  if(!approval.approved)return {sessionId:raw.id,action:"BLOCK",reason:"INSTRUMENT_NOT_APPROVED",detail:approval.reason};
  decision=rechecked;
  quote=entryQuote;
  const distance=Math.abs(decision.entry-decision.stop);
  const tp1=decision.direction==="BUY"?decision.entry+distance:decision.entry-distance;
  const tp2=decision.direction==="BUY"?decision.entry+distance*2:decision.entry-distance*2;
  const {data:r,error}=await db.rpc("open_demo_paper_trade",{
   p_user_id:raw.user_id,p_session_id:raw.id,p_instrument:decision.symbol,p_side:decision.direction,
   p_entry:decision.entry,p_stop:decision.stop,p_target:decision.target,p_quantity:decision.units,
   p_risk_amount:decision.riskAmount,p_risk_pct:decision.riskPct,p_quote_to_usd:quote.quoteToUsd,
   p_quote_source:quote.source,p_quote_as_of:quote.quoteAsOf,p_trade_origin:"BOT",
   p_candle_as_of:decision.candleAsOf,p_tp1:tp1,p_tp2:tp2,p_tp3:decision.target
  });
  if(error)return {sessionId:raw.id,action:"ERROR",reason:"ATOMIC_OPEN_FAILED",detail:safeError(error)};
  return r?.ok?{sessionId:raw.id,action:"OPEN",tradeId:r.trade_id,direction:decision.direction,instrument:decision.symbol,riskAmount:decision.riskAmount}:{sessionId:raw.id,action:"SKIP",reason:r?.reason||"OPEN_BLOCKED"};
 }
 if(decision.action==="WAIT"&&decision.candleAsOf){
  const {error}=await db.from("demo_paper_sessions").update({last_candle_as_of:decision.candleAsOf,updated_at:new Date().toISOString()}).eq("id",raw.id).eq("user_id",raw.user_id).eq("status","RUNNING");
  if(error)return {sessionId:raw.id,action:"ERROR",reason:"CANDLE_CHECKPOINT_FAILED"};
 }
 return {sessionId:raw.id,action:decision.action,reason:decision.reason};
}

export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="GET"&&req.method!=="POST"){res.setHeader("Allow","GET, POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,CRON_SECRET}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY||!CRON_SECRET||CRON_SECRET.length<32)return res.status(503).json({error:"DEMO worker is not configured."});
 if((req.headers.authorization||"")!==`Bearer ${CRON_SECRET}`)return res.status(401).json({error:"Worker authorization failed."});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=randomUUID();
 try{
  const {data:claimed,error:claimError}=await db.rpc("claim_demo_paper_worker",{p_token:token,p_lease_seconds:90});
  if(claimError){console.error("DEMO worker lease:",claimError.message);return res.status(503).json({error:"Could not acquire the DEMO paper worker lease. Install ledger v2 migration."});}
  if(!claimed)return res.status(200).json({ok:true,skipped:true,reason:"WORKER_ALREADY_RUNNING"});
  let results=[];
  let portfolioProtection={processed:0,results:[]};
   try{   const {data:sessions,error}=await db.from("demo_paper_sessions").select("*").in("status",["RUNNING","PAUSED","RISK_LOCKED"]).order("updated_at",{ascending:true}).limit(MAX_SESSIONS_PER_TICK);
   if(error)throw new Error("Could not load DEMO paper sessions.");
   const portfolioPromise=runDemoPortfolioProtection(db,{maxAccounts:MAX_SESSIONS_PER_TICK})
    .catch(e=>({processed:0,results:[],error:safeError(e)}));
   results=await Promise.all((sessions||[]).map(s=>processSession(db,s).catch(e=>({sessionId:s.id,action:"ERROR",reason:"UNHANDLED_SESSION_ERROR",detail:safeError(e)}))));
   portfolioProtection=await portfolioPromise;
   const tick=new Date().toISOString();
   const beats=(sessions||[]).map(s=>{const r=results.find(x=>x.sessionId===s.id);return {session_id:s.id,user_id:s.user_id,last_tick_at:tick,last_action:r?.action||"UNKNOWN",last_reason:r?.reason||null,last_error:["ERROR","BLOCK"].includes(r?.action)?(r.detail||r.reason):null,updated_at:tick};});
   if(beats.length){const {error:e}=await db.from("demo_paper_worker_heartbeats").upsert(beats,{onConflict:"session_id"});if(e)console.error("DEMO heartbeat:",e.message);}
   await Promise.all((sessions||[]).map(s=>db.from("demo_paper_sessions").update({updated_at:tick}).eq("id",s.id).in("status",["RUNNING","PAUSED","RISK_LOCKED"])));
   }finally{
   const {error}=await db.rpc("release_demo_paper_worker",{p_token:token});if(error)console.error("DEMO lease release:",error.message);
  }
   const counts=results.reduce((o,r)=>(o[r.action]=(o[r.action]||0)+1,o),{});
  return res.status(200).json({ok:true,processed:results.length,counts,results,portfolioProtection,mode:"DEMO_PAPER_ONLY",realOrdersSent:0});
 }catch(e){console.error("DEMO paper worker:",e.message);return res.status(500).json({error:"DEMO paper worker failed safely."});}
}
