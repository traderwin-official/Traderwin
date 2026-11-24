import {randomUUID} from "node:crypto";
import {createClient} from "@supabase/supabase-js";
import {getDerivPublicQuote} from "../../lib/deriv-public-quote.js";
import {getDerivCandles} from "../../lib/deriv-candles.js";
import {getDerivQuoteToUsd} from "../../lib/usd-conversion.js";
import {loadApprovedInstrument} from "../../lib/deriv/load-approved-instrument.js";
import {decideDemoAutoAction} from "../../lib/demo-auto-decision.js";
import {runDemoPortfolioProtection} from "../../lib/demo-portfolio-protection-runner.js";
import {resolveDemoAutoStrategy} from "../../lib/demo-session-mode.js";
export const config={maxDuration:25};
const MAX_SESSIONS_PER_TICK=3;
const safeError=e=>String(e?.message||"Worker step failed").slice(0,240);
const normalise=v=>String(v||"").trim().toUpperCase().replace(/[\s/.-]/g,"");

/**
 * Enforce individual SL/TP brackets for MANUAL-origin DEMO paper positions.
 * This is separate from portfolio giveback and requires the dedicated
 * auto_exit_manual_brackets permission for the user's DEMO Deriv account.
 */
async function processManualDemoBracketExits(db){
 const {data:permissions,error:permissionQueueError}=await db.from("portfolio_trade_permissions")
  .select("user_id,broker_account_ref").eq("account_mode","DEMO").eq("broker","DERIV")
  .eq("auto_exit_manual_brackets",true).limit(100);
 if(permissionQueueError)return {processed:0,closed:0,partialExits:0,results:[],error:"MANUAL_PERMISSION_QUEUE_FAILED"};
 const eligible=new Map((permissions||[]).map(p=>[p.user_id,p.broker_account_ref]));
 if(!eligible.size)return {processed:0,closed:0,partialExits:0,results:[]};
 const {data:trades,error}=await db.from("demo_paper_trades")
  .select("id,user_id,session_id,instrument,side,stop_loss,tp1_price,tp2_price,tp3_price,tp1_percent,tp2_percent,tp3_percent,tp1_done,tp2_done,tp3_done,quantity,remaining_quantity,status")
  .eq("status","OPEN").eq("trade_origin","MANUAL").in("user_id",[...eligible.keys()])
  .order("last_mark_at",{ascending:true,nullsFirst:true}).limit(4);
 if(error)return {processed:0,closed:0,partialExits:0,results:[],error:"MANUAL_TRADE_QUEUE_FAILED"};
 const results=[];
 for(const trade of trades||[]){
  try{
   const {data:session,error:sessionError}=await db.from("demo_paper_sessions")
    .select("broker,broker_account_ref").eq("id",trade.session_id).eq("user_id",trade.user_id).maybeSingle();
   if(sessionError||!session||session.broker!=="DERIV"||eligible.get(trade.user_id)!==session.broker_account_ref){
    results.push({tradeId:trade.id,action:"BLOCK",reason:"DEMO_SESSION_OR_PERMISSION_SCOPE_MISMATCH"});continue;
   }
   const quote=await getDerivPublicQuote(trade.instrument);
   if(quote.source!=="DERIV"||normalise(quote.instrument)!==normalise(trade.instrument)||!quote.providerSymbol){
    results.push({tradeId:trade.id,action:"BLOCK",reason:"VERIFIED_QUOTE_MISMATCH"});continue;
   }
   const fx=await getDerivQuoteToUsd(trade.instrument,quote);
   const stopHit=trade.side==="BUY"?quote.quote<=Number(trade.stop_loss):quote.quote>=Number(trade.stop_loss);
   if(stopHit){
    const {data:closed,error:closeError}=await db.rpc("manage_demo_manual_partial_exit",{
     p_user_id:trade.user_id,p_trade_id:trade.id,p_stage:"STOP_LOSS",p_exit_price:quote.quote,
     p_quote_to_usd:fx.rate,p_quote_source:quote.source,p_quote_as_of:quote.quoteAsOf
    });
    if(closeError){results.push({tradeId:trade.id,action:"ERROR",reason:"MANUAL_STOP_CLOSE_FAILED",detail:safeError(closeError)});continue;}
    results.push(closed?.ok?{tradeId:trade.id,action:"CLOSED",reason:"STOP_LOSS",closedUnits:closed.closed_units,realizedPnl:closed.realized_pnl_total}:
     {tradeId:trade.id,action:"SKIP",reason:closed?.reason||"MANUAL_STOP_NOT_APPLIED"});
    continue;
   }
   let stageDone=[trade.tp1_done===true,trade.tp2_done===true,trade.tp3_done===true];
   const targets=[Number(trade.tp1_price),Number(trade.tp2_price),Number(trade.tp3_price)];
   const stages=["TP1","TP2","TP3"];
   const allocations=[Number(trade.tp1_percent),Number(trade.tp2_percent),Number(trade.tp3_percent)];
   let remaining=Number(trade.remaining_quantity),partialExits=0,failed=false;
   for(let i=0;i<3&&remaining>0.000000000001;i++){
    if(stageDone[i])continue;
    if(i>0&&!stageDone[i-1])break;
    if(!Number.isFinite(targets[i])||!Number.isFinite(allocations[i])||allocations[i]<=0)break;
    const reached=trade.side==="BUY"?quote.quote>=targets[i]:quote.quote<=targets[i];
    if(!reached)break;
    const {data:exit,error:exitError}=await db.rpc("manage_demo_manual_partial_exit",{
     p_user_id:trade.user_id,p_trade_id:trade.id,p_stage:stages[i],p_exit_price:quote.quote,
     p_quote_to_usd:fx.rate,p_quote_source:quote.source,p_quote_as_of:quote.quoteAsOf
    });
    if(exitError||!exit?.ok){
     results.push({tradeId:trade.id,action:"ERROR",reason:"MANUAL_PARTIAL_EXIT_FAILED",detail:safeError(exitError)||exit?.reason||"EXIT_NOT_APPLIED"});
     failed=true;break;
    }
    stageDone[i]=true;remaining=Number(exit.remaining_units);partialExits++;
    if(exit.closed){remaining=0;break;}
   }
   if(failed)continue;
   if(partialExits){
    results.push({tradeId:trade.id,action:remaining<=0?"CLOSED":"PARTIAL_EXIT",partialExits,remainingUnits:remaining,exitPrice:quote.quote});
   }else{
    const {error:markError}=await db.rpc("mark_demo_paper_trade",{
     p_user_id:trade.user_id,p_trade_id:trade.id,p_price:quote.quote,p_quote_as_of:quote.quoteAsOf
    });
    results.push(markError?{tradeId:trade.id,action:"ERROR",reason:"MANUAL_MARK_FAILED"}:
     {tradeId:trade.id,action:"MARK",reason:"BRACKETS_NOT_REACHED"});
   }
  }catch(e){
   results.push({tradeId:trade.id,action:"ERROR",reason:"MANUAL_BRACKET_CHECK_FAILED",detail:safeError(e)});
  }
 }
 return {processed:results.length,closed:results.filter(r=>r.action==="CLOSED").length,
  partialExits:results.reduce((n,r)=>n+(r.partialExits||0),0),results};
}

/**
 * Watches MANUAL DEMO pending batches. A batch activates only when a fresh
 * verified Deriv quote crosses its planned entry from the recorded pre-touch
 * side. The SQL RPC inserts all child paper positions in one transaction.
 */
async function processPendingManualEntryBatches(db){
 const {data:batches,error}=await db.from("demo_manual_entry_batches")
  .select("id,user_id,session_id,instrument,side,entry_price,expires_at,status")
  .eq("status","PENDING").order("updated_at",{ascending:true}).limit(8);
 if(error)return {processed:0,activated:0,results:[],error:"PENDING_BATCH_QUEUE_FAILED"};
 const results=[];
 for(const batch of batches||[]){
  try{
   if(Date.parse(batch.expires_at)<=Date.now()){
    const {data:r,error:e}=await db.rpc("cancel_demo_manual_entry_batch",{
     p_user_id:batch.user_id,p_batch_id:batch.id,p_terminal_status:"EXPIRED",p_reason:"PENDING_ENTRY_EXPIRED"
    });
    results.push({batchId:batch.id,action:e?"ERROR":"EXPIRED",reason:e?safeError(e):r?.reason||"PENDING_ENTRY_EXPIRED"});
    continue;
   }
   const {data:session,error:sessionError}=await db.from("demo_paper_sessions")
    .select("id,user_id,broker,broker_account_ref,instrument,status")
    .eq("id",batch.session_id).eq("user_id",batch.user_id).maybeSingle();
   if(sessionError)throw new Error("Could not verify pending batch DEMO session.");
   if(!session||session.status!=="RUNNING"||session.broker!=="DERIV"||normalise(session.instrument)!==normalise(batch.instrument)){
    const {data:r,error:e}=await db.rpc("cancel_demo_manual_entry_batch",{
     p_user_id:batch.user_id,p_batch_id:batch.id,p_terminal_status:"BLOCKED",p_reason:"SESSION_STOPPED_OR_INSTRUMENT_CHANGED"
    });
    results.push({batchId:batch.id,action:e?"ERROR":"BLOCKED",reason:e?safeError(e):r?.reason||"SESSION_STOPPED_OR_INSTRUMENT_CHANGED"});
    continue;
   }
   const [{data:emergency,error:emergencyError},{data:legacy,error:legacyError}]=await Promise.all([
    db.from("demo_paper_emergency_controls").select("entries_blocked").eq("user_id",batch.user_id).eq("broker","DERIV").eq("broker_account_ref",session.broker_account_ref).maybeSingle(),
    db.from("bot_emergency_controls").select("kill_switch_active").eq("user_id",batch.user_id).eq("account_mode","DEMO").eq("broker","DERIV").eq("broker_account_ref",session.broker_account_ref).maybeSingle()
   ]);
   if(emergencyError||legacyError)throw new Error("Could not verify the DEMO emergency stop.");
   if(emergency?.entries_blocked||legacy?.kill_switch_active){
    const {data:r,error:e}=await db.rpc("cancel_demo_manual_entry_batch",{
     p_user_id:batch.user_id,p_batch_id:batch.id,p_terminal_status:"BLOCKED",p_reason:"EMERGENCY_STOP_ACTIVE"
    });
    results.push({batchId:batch.id,action:e?"ERROR":"BLOCKED",reason:e?safeError(e):r?.reason||"EMERGENCY_STOP_ACTIVE"});
    continue;
   }
   let quote;
   try{quote=await getDerivPublicQuote(batch.instrument);}
   catch(e){await db.from("demo_manual_entry_batches").update({updated_at:new Date().toISOString()}).eq("id",batch.id).eq("status","PENDING");results.push({batchId:batch.id,action:"WAIT",reason:"VERIFIED_QUOTE_UNAVAILABLE",detail:safeError(e)});continue;}
   const quoteTime=Date.parse(quote.quoteAsOf||"");
   if(quote.source!=="DERIV"||normalise(quote.instrument)!==normalise(batch.instrument)||!quote.providerSymbol
      ||!Number.isFinite(quoteTime)||Date.now()-quoteTime>30000||quoteTime>Date.now()+5000||!Number.isFinite(Number(quote.quote))||Number(quote.quote)<=0){
    await db.from("demo_manual_entry_batches").update({updated_at:new Date().toISOString()}).eq("id",batch.id).eq("status","PENDING");
    results.push({batchId:batch.id,action:"WAIT",reason:"VERIFIED_QUOTE_STALE_OR_MISMATCHED"});continue;
   }
   const approval=await loadApprovedInstrument(db,{broker:"DERIV",instrument:batch.instrument,providerSymbol:quote.providerSymbol});
   if(!approval.approved){
    const {data:r,error:e}=await db.rpc("cancel_demo_manual_entry_batch",{
     p_user_id:batch.user_id,p_batch_id:batch.id,p_terminal_status:"BLOCKED",p_reason:"INSTRUMENT_APPROVAL_REVOKED"
    });
    results.push({batchId:batch.id,action:e?"ERROR":"BLOCKED",reason:e?safeError(e):r?.reason||"INSTRUMENT_APPROVAL_REVOKED"});
    continue;
   }
   let fx;
   try{fx=await getDerivQuoteToUsd(batch.instrument,quote);}
   catch(e){await db.from("demo_manual_entry_batches").update({updated_at:new Date().toISOString()}).eq("id",batch.id).eq("status","PENDING");results.push({batchId:batch.id,action:"WAIT",reason:"USD_CONVERSION_UNAVAILABLE",detail:safeError(e)});continue;}
   const {data:activated,error:activationError}=await db.rpc("activate_demo_manual_entry_batch",{
    p_batch_id:batch.id,p_quote:quote.quote,p_quote_source:quote.source,p_provider_symbol:quote.providerSymbol,
    p_quote_as_of:quote.quoteAsOf,p_quote_to_usd:fx.rate
   });
   if(activationError){results.push({batchId:batch.id,action:"ERROR",reason:"ATOMIC_BATCH_ACTIVATION_FAILED",detail:safeError(activationError)});continue;}
   results.push(activated?.activated?{batchId:batch.id,action:"ACTIVATED",tradeCount:activated.trade_count,tradeIds:activated.trade_ids,plannedEntry:activated.planned_entry,triggerQuote:activated.trigger_quote}:
    {batchId:batch.id,action:["ENTRY_NOT_TOUCHED","QUOTE_CHECKPOINT_NOT_NEWER"].includes(activated?.reason)?"WAIT":"BLOCKED",reason:activated?.reason||"BATCH_NOT_ACTIVATED"});
  }catch(e){
   results.push({batchId:batch.id,action:"ERROR",reason:"PENDING_BATCH_CHECK_FAILED",detail:safeError(e)});
  }
 }
 return {processed:results.length,activated:results.filter(r=>r.action==="ACTIVATED").length,results};
}

async function processSession(db,raw){
 const autoStrategy=resolveDemoAutoStrategy(raw);
 if(!autoStrategy)return {sessionId:raw.id,action:"SKIP",reason:"AUTO_MODE_NOT_ENABLED"};
 const session={...raw,account_mode:"DEMO",current_balance:Number(raw.current_balance),
  max_risk_per_trade_pct:Number(raw.risk_per_trade_pct),worker_last_candle_as_of:raw.last_candle_as_of};
 const settings={...(raw.config_snapshot||{}),broker:raw.broker,instrument:raw.instrument,
  account_mode:"DEMO",strategy:autoStrategy,timeframe:raw.timeframe};
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
   const trend=(["TIGER_FIBONACCI_PSYCHOLOGY_V1","AUTO_SELECT_V1"].includes(autoStrategy)&&raw.timeframe!=="H1")?await getDerivCandles(raw.instrument,"H1"):selected;
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
  let manualBracketExits={processed:0,closed:0,results:[]};
  let pendingManualBatches={processed:0,activated:0,results:[]};
   try{   const {data:candidates,error}=await db.from("demo_paper_sessions").select("*").neq("strategy","MANUAL").in("status",["RUNNING","PAUSED","RISK_LOCKED"]).order("updated_at",{ascending:true}).limit(20);
   const sessions=(candidates||[]).filter(s=>resolveDemoAutoStrategy(s)!==null).slice(0,MAX_SESSIONS_PER_TICK);
   if(error)throw new Error("Could not load DEMO paper sessions.");
   const portfolioPromise=runDemoPortfolioProtection(db,{maxAccounts:MAX_SESSIONS_PER_TICK})
    .catch(e=>({processed:0,results:[],error:safeError(e)}));
   results=await Promise.all((sessions||[]).map(s=>processSession(db,s).catch(e=>({sessionId:s.id,action:"ERROR",reason:"UNHANDLED_SESSION_ERROR",detail:safeError(e)}))));
   portfolioProtection=await portfolioPromise;
   manualBracketExits=await processManualDemoBracketExits(db);
   pendingManualBatches=await processPendingManualEntryBatches(db);
   const tick=new Date().toISOString();
   const beats=(sessions||[]).map(s=>{const r=results.find(x=>x.sessionId===s.id);return {session_id:s.id,user_id:s.user_id,last_tick_at:tick,last_action:r?.action||"UNKNOWN",last_reason:r?.reason||null,last_error:["ERROR","BLOCK"].includes(r?.action)?(r.detail||r.reason):null,updated_at:tick};});
   if(beats.length){const {error:e}=await db.from("demo_paper_worker_heartbeats").upsert(beats,{onConflict:"session_id"});if(e)console.error("DEMO heartbeat:",e.message);}
   await Promise.all((sessions||[]).map(s=>db.from("demo_paper_sessions").update({updated_at:tick}).eq("id",s.id).in("status",["RUNNING","PAUSED","RISK_LOCKED"])));
   }finally{
   const {error}=await db.rpc("release_demo_paper_worker",{p_token:token});if(error)console.error("DEMO lease release:",error.message);
  }
   const counts=results.reduce((o,r)=>(o[r.action]=(o[r.action]||0)+1,o),{});
  return res.status(200).json({ok:true,processed:results.length,counts,results,portfolioProtection,manualBracketExits,pendingManualBatches,mode:"DEMO_PAPER_ONLY",realOrdersSent:0});
 }catch(e){console.error("DEMO paper worker:",e.message);return res.status(500).json({error:"DEMO paper worker failed safely."});}
}
