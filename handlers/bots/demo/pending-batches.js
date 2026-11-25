import { createClient } from "@supabase/supabase-js";
import { validatePaperSetup, calculatePaperPosition } from "../../../lib/demo-risk.js";
import { getDerivPublicQuote } from "../../../lib/deriv-public-quote.js";
import { getDerivQuoteToUsd } from "../../../lib/usd-conversion.js";
import { loadApprovedInstrument } from "../../../lib/deriv/load-approved-instrument.js";
import { detectDemoPendingEntryType } from "../../../lib/demo-pending-entry-type.js";

const num = value => { const n=Number(value); return Number.isFinite(n)?n:NaN; };
const normalise = value => String(value||"").trim().toUpperCase().replace(/[\s/.-]/g,"");
const freshQuote = (q,symbol) => {
 if(q?.source!=="DERIV"||normalise(q.instrument)!==normalise(symbol)||!q.providerSymbol) return false;
 const t=Date.parse(q.quoteAsOf||"");
 return Number.isFinite(t)&&Date.now()-t<=30000&&t<=Date.now()+5000&&Number(q.quote)>0;
};

export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Pending DEMO entry service is not configured."});
 const authHeader=req.headers.authorization||"";
 if(!authHeader.startsWith("Bearer ")||!authHeader.slice(7).trim())return res.status(401).json({error:"Sign in is required."});
 try{
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await db.auth.getUser(authHeader.slice(7).trim());
  if(authError||!auth.user)return res.status(401).json({error:"Your login session is invalid."});
  const userId=auth.user.id;

  if(req.method==="GET"){
   const {data,error}=await db.from("demo_manual_entry_batches")
    .select("id,instrument,side,entry_type,requested_trade_count,entry_price,stop_loss,tp1_price,tp2_price,tp3_price,tp1_percent,tp2_percent,tp3_percent,total_risk_usd,total_risk_pct,status,expires_at,activated_at,terminal_reason,child_trade_ids,created_at")
    .eq("user_id",userId).order("created_at",{ascending:false}).limit(25);
   if(error)return res.status(503).json({error:"Could not load pending manual DEMO setups."});
   return res.status(200).json({mode:"DEMO",paperOnly:true,batches:data||[]});
  }
  if(req.method!=="POST"){res.setHeader("Allow","GET, POST");return res.status(405).json({error:"Method not allowed."});}
  const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  if(body.action==="CANCEL"){
   const batchId=String(body.batchId||"");
   if(!/^[0-9a-f-]{36}$/i.test(batchId))return res.status(400).json({error:"Enter a valid pending batch ID."});
   const {data,error}=await db.rpc("cancel_demo_manual_entry_batch",{p_user_id:userId,p_batch_id:batchId,p_terminal_status:"CANCELLED",p_reason:"USER_CANCELLED"});
   if(error)return res.status(503).json({error:"Could not cancel the pending setup safely."});
   if(!data?.ok)return res.status(409).json({error:"This setup is no longer pending and cannot be cancelled.",reason:data?.reason});
   return res.status(200).json({ok:true,status:"CANCELLED",batchId});
  }
  if(body.action!=="CREATE")return res.status(400).json({error:"Choose CREATE or CANCEL."});

  const symbol=String(body.symbol||"").trim().toUpperCase();
  const direction=String(body.direction||"").trim().toUpperCase();
  const tradeCount=num(body.tradeCount);
  const entry=num(body.entryPrice),stop=num(body.stopLoss);
  const tp1=num(body.tp1),tp2=num(body.tp2),tp3=num(body.tp3);
  const allocations=[num(body.tp1Percent),num(body.tp2Percent),num(body.tp3Percent)];
  if(!/^[A-Z0-9._-]{2,24}$/.test(symbol))return res.status(400).json({error:"Enter a valid instrument symbol."});
  if(!Number.isInteger(tradeCount)||tradeCount<1||tradeCount>10)return res.status(400).json({error:"Number of trades must be a whole number from 1 to 10."});
  if(![entry,stop,tp1,tp2,tp3].every(v=>Number.isFinite(v)&&v>0))return res.status(400).json({error:"Enter a positive entry, stop-loss and all three target prices."});
  if(!allocations.every(v=>Number.isFinite(v)&&v>0&&v<=100&&Math.round(v*100)===v*100)||Math.round(allocations.reduce((a,b)=>a+b,0)*100)!==10000)
   return res.status(400).json({error:"T1, T2 and T3 allocations must total exactly 100%."});
  const levelError=validatePaperSetup({direction,entry,stop,target:tp3});
  if(levelError)return res.status(400).json({error:levelError});
  const ordered=direction==="BUY"?(stop<entry&&entry<tp1&&tp1<tp2&&tp2<tp3):(stop>entry&&entry>tp1&&tp1>tp2&&tp2>tp3);
  if(!ordered)return res.status(400).json({error:"T1, T2 and T3 must be ordered beyond entry in the correct trade direction."});

  const [{data:profile,error:profileError},{data:session,error:sessionError}]=await Promise.all([
   db.from("trader_profiles").select("account_mode,max_risk_per_trade_pct").eq("user_id",userId).maybeSingle(),
   db.from("demo_paper_sessions").select("*").eq("user_id",userId).eq("status","RUNNING").order("created_at",{ascending:false}).limit(1).maybeSingle()
  ]);
  if(profileError||!profile)return res.status(409).json({error:"Complete your account setup first."});
  if(profile.account_mode!=="DEMO")return res.status(403).json({error:"Pending batch entries are DEMO-only. REAL pending orders remain locked."});
  if(sessionError||!session)return res.status(409).json({error:"Start your DEMO paper session first."});
  if(normalise(symbol)!==normalise(session.instrument))return res.status(400).json({error:"Instrument must match your running DEMO session."});

  const checkEmergency=async()=>{
   const [{data:e,error:ee},{data:legacy,error:le}]=await Promise.all([
    db.from("demo_paper_emergency_controls").select("entries_blocked").eq("user_id",userId).eq("broker","DERIV").eq("broker_account_ref",session.broker_account_ref).maybeSingle(),
    db.from("bot_emergency_controls").select("kill_switch_active").eq("user_id",userId).eq("account_mode","DEMO").eq("broker","DERIV").eq("broker_account_ref",session.broker_account_ref).maybeSingle()
   ]);
   if(ee||le)throw new Error("Could not verify the DEMO emergency stop.");
   if(e?.entries_blocked||legacy?.kill_switch_active)throw new Error("Emergency stop is active. Pending entries are blocked.");
  };
  try{await checkEmergency();}catch(e){return res.status(403).json({error:e.message});}

  let quote,conversion,approval;
  try{
   quote=await getDerivPublicQuote(symbol);
   if(!freshQuote(quote,symbol))return res.status(503).json({error:"A fresh verified quote for this instrument is unavailable."});
   approval=await loadApprovedInstrument(db,{broker:"DERIV",instrument:symbol,providerSymbol:quote.providerSymbol});
   if(!approval.approved)return res.status(403).json({error:"This instrument is not currently approved for DEMO entries.",reason:approval.reason});
   conversion=await getDerivQuoteToUsd(symbol,quote);
  }catch(e){return res.status(503).json({error:e.message||"Verified market quote or USD conversion unavailable."});}

  const initiallyDetectedEntryType=detectDemoPendingEntryType(direction,quote.quote,entry);
  if(!initiallyDetectedEntryType)return res.status(409).json({error:"Market is exactly at your planned entry or the quote is invalid. Choose a different entry price.",currentPrice:Number(quote.quote)});
  let entryType=initiallyDetectedEntryType;

  const riskPct=Math.min(Number(profile.max_risk_per_trade_pct),Number(session.risk_per_trade_pct));
  if(!Number.isFinite(riskPct)||riskPct<=0)return res.status(409).json({error:"Your DEMO risk setting is invalid."});
  let sizing;
  try{sizing=calculatePaperPosition({balance:Number(session.current_balance),riskPct,entry,stop,quoteToUsd:conversion.rate});}
  catch{return res.status(400).json({error:"Could not calculate the aggregate batch risk safely."});}
  if(!Number.isFinite(sizing.units)||sizing.units<=0||sizing.units>1e12||sizing.riskAmount/tradeCount<0.01)
   return res.status(400).json({error:"The requested batch is too small or too large for safe per-position sizing."});

  // Re-fetch immediately before reserving risk; the trigger checkpoint must
  // still prove that price has not touched the requested entry.
  try{
   quote=await getDerivPublicQuote(symbol);
   if(!freshQuote(quote,symbol))return res.status(503).json({error:"Final verified quote is stale or unavailable."});
   approval=await loadApprovedInstrument(db,{broker:"DERIV",instrument:symbol,providerSymbol:quote.providerSymbol});
   if(!approval.approved)return res.status(403).json({error:"Instrument approval changed; pending setup blocked.",reason:approval.reason});
   conversion=await getDerivQuoteToUsd(symbol,quote);
   await checkEmergency();
  }catch(e){return res.status(503).json({error:e.message||"Final entry checks could not be completed."});}
  const finalDetectedEntryType=detectDemoPendingEntryType(direction,quote.quote,entry);
  if(!finalDetectedEntryType||finalDetectedEntryType!==initiallyDetectedEntryType)
   return res.status(409).json({error:"Market crossed your planned entry while you were submitting. No batch was created; review the new market price and submit again.",currentPrice:Number(quote.quote)});
  entryType=finalDetectedEntryType;

  sizing=calculatePaperPosition({balance:Number(session.current_balance),riskPct,entry,stop,quoteToUsd:conversion.rate});
  const {data:result,error}=await db.rpc("create_demo_manual_entry_batch",{
   p_user_id:userId,p_session_id:session.id,p_instrument:symbol,p_provider_symbol:quote.providerSymbol,p_side:direction,p_entry_type:entryType,p_trade_count:tradeCount,
   p_entry:entry,p_stop:stop,p_tp1:tp1,p_tp2:tp2,p_tp3:tp3,
   p_tp1_percent:allocations[0],p_tp2_percent:allocations[1],p_tp3_percent:allocations[2],
   p_total_quantity:sizing.units,p_total_risk_usd:sizing.riskAmount,p_total_risk_pct:riskPct,
   p_quote_to_usd:conversion.rate,p_quote_source:quote.source,p_quote:Number(quote.quote),p_quote_as_of:quote.quoteAsOf
  });
  if(error){console.error("Pending manual batch create:",error.message);return res.status(503).json({error:"Pending batch could not be reserved safely."});}
  if(!result?.ok)return res.status(409).json({error:({MAX_OPEN_POSITIONS:"Not enough open-position slots for this batch, including other pending setups.",TOTAL_OPEN_RISK_LIMIT:"This batch exceeds the available aggregate risk after existing and pending reservations.",DAILY_LOSS_LIMIT:"Your DEMO daily loss limit has been reached.",KILL_SWITCH_ACTIVE:"Emergency stop is active.",INSTRUMENT_MISMATCH:"Instrument no longer matches your DEMO session.",SESSION_NOT_RUNNING_OR_NOT_DERIV:"Your DEMO session is no longer running."})[result.reason]||"Pending batch rejected by a server-side safety check.",reason:result.reason});
  return res.status(201).json({ok:true,mode:"DEMO",paperOnly:true,batch:{id:result.batch_id,status:"PENDING",entryType,tradeCount:result.trade_count,entryPrice:entry,stopLoss:stop,tp1:tp1,tp2:tp2,tp3:tp3,tp1Percent:allocations[0],tp2Percent:allocations[1],tp3Percent:allocations[2],aggregateRiskUsd:Number(result.aggregate_risk_usd),aggregateRiskPct:Number(result.aggregate_risk_pct),expiresAt:result.expires_at},quote:{source:quote.source,asOf:quote.quoteAsOf,instrument:quote.providerSymbol},message:"Pending DEMO setup saved as "+direction+" "+entryType+". No position is open yet. It will activate only after a later verified quote crosses your planned entry in the detected direction; fills are simulated at your planned entry price."});
 }catch(e){console.error("Pending DEMO batch:",e?.message||e);return res.status(500).json({error:"Pending DEMO batch could not be processed safely."});}
}
