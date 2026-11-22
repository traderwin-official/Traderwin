import { createClient } from "@supabase/supabase-js";
import { validatePaperSetup, calculatePaperPosition } from "../../../lib/demo-risk.js";
import { getDerivPublicQuote } from "../../../lib/deriv-public-quote.js";
import { getDerivQuoteToUsd } from "../../../lib/usd-conversion.js";
import { loadApprovedInstrument } from "../../../lib/deriv/load-approved-instrument.js";
const num=value=>{const n=Number(value);return Number.isFinite(n)?n:NaN;};
const normalise=value=>String(value||"").trim().toUpperCase().replace(/[\s/.-]/g,"");
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"DEMO paper service is not configured."});
 const h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return res.status(401).json({error:"Sign in is required."});
 try{
  const b=typeof req.body==="string"?JSON.parse(req.body):(req.body||{}),symbol=String(b.symbol||"").trim().toUpperCase(),direction=String(b.direction||"").trim().toUpperCase();
  const stop=num(b.stopLoss),target=num(b.takeProfit);
  if(!/^[A-Z0-9._-]{2,24}$/.test(symbol))return res.status(400).json({error:"Enter a valid instrument symbol."});
  if(!Number.isFinite(stop)||!Number.isFinite(target)||stop<=0||target<=0)return res.status(400).json({error:"Enter valid stop-loss and take-profit levels."});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:a,error:ae}=await db.auth.getUser(h.slice(7).trim());if(ae||!a.user)return res.status(401).json({error:"Your login session is invalid."});
  const uid=a.user.id;
  const [{data:profile,error:pe},{data:session,error:se},{data:settings,error:be}]=await Promise.all([
   db.from("trader_profiles").select("account_mode,max_risk_per_trade_pct").eq("user_id",uid).maybeSingle(),
   db.from("demo_paper_sessions").select("*").eq("user_id",uid).eq("status","RUNNING").order("created_at",{ascending:false}).limit(1).maybeSingle(),
   db.from("bot_settings").select("broker,instrument,account_mode,max_risk_per_trade_pct").eq("user_id",uid).maybeSingle()
  ]);
  if(pe||!profile)return res.status(409).json({error:"Complete your account setup first."});
  if(profile.account_mode!=="DEMO")return res.status(403).json({error:"Paper trades are DEMO-only."});
  if(se||!session)return res.status(409).json({error:"Start your DEMO paper session first."});
  if(be||!settings||settings.account_mode!=="DEMO"||String(settings.broker||"").toUpperCase()!=="DERIV")return res.status(403).json({error:"A verified Deriv DEMO setup is required."});
  if(normalise(symbol)!==normalise(session.instrument)||normalise(symbol)!==normalise(settings.instrument))return res.status(400).json({error:"Symbol must match your saved DEMO instrument."});
  const {data:emergency,error:ee}=await db.from("demo_paper_emergency_controls").select("entries_blocked").eq("user_id",uid).eq("broker","DERIV").eq("broker_account_ref",session.broker_account_ref).maybeSingle();
  if(ee)return res.status(503).json({error:"Could not verify the DEMO emergency stop."});
  const {data:legacyEmergency,error:legacyEmergencyError}=await db.from("bot_emergency_controls").select("kill_switch_active").eq("user_id",uid).eq("account_mode","DEMO").eq("broker","DERIV").eq("broker_account_ref",session.broker_account_ref).maybeSingle();
  if(legacyEmergencyError)return res.status(503).json({error:"Could not verify the existing DEMO emergency stop."});
  if(emergency?.entries_blocked||legacyEmergency?.kill_switch_active)return res.status(403).json({error:"Emergency stop is active. New paper entries are blocked."});
  let quote;try{quote=await getDerivPublicQuote(symbol);}catch(e){return res.status(503).json({error:e.message||"Fresh Deriv quote unavailable."});}
  if(quote.source!=="DERIV"||normalise(quote.instrument)!==normalise(symbol)||!quote.providerSymbol)return res.status(503).json({error:"Verified quote does not match the selected instrument."});
  const approval=await loadApprovedInstrument(db,{broker:"DERIV",instrument:symbol,providerSymbol:quote.providerSymbol});
  if(!approval.approved)return res.status(403).json({error:"This instrument is not approved for DEMO entries by the platform.",reason:approval.reason});
  let conversion;try{conversion=await getDerivQuoteToUsd(symbol,quote);}catch(e){return res.status(503).json({error:e.message||"Fresh USD conversion unavailable."});}
  const entry=quote.quote,setupError=validatePaperSetup({direction,entry,stop,target});
  if(setupError)return res.status(400).json({error:setupError});
  const riskPct=Math.min(Number(profile.max_risk_per_trade_pct),Number(session.risk_per_trade_pct),Number(settings.max_risk_per_trade_pct));
  let sizing;try{sizing=calculatePaperPosition({balance:Number(session.current_balance),riskPct,entry,stop,quoteToUsd:conversion.rate});}
  catch{return res.status(400).json({error:"Could not calculate a safe paper position size."});}
  if(!Number.isFinite(sizing.units)||sizing.units<=0||sizing.units>1e12)return res.status(400).json({error:"Paper position size is outside safe limits."});
  // Refresh server-owned market and emergency state immediately before
  // the atomic paper-entry RPC; recalculate size against the final quote.
  let finalQuote,finalConversion;
  try{
   finalQuote=await getDerivPublicQuote(symbol);
   if(finalQuote.source!=="DERIV"||normalise(finalQuote.instrument)!==normalise(symbol)||!finalQuote.providerSymbol)
    return res.status(503).json({error:"Final verified quote does not match the selected instrument."});
   const finalApproval=await loadApprovedInstrument(db,{broker:"DERIV",instrument:symbol,providerSymbol:finalQuote.providerSymbol});
   if(!finalApproval.approved)return res.status(403).json({error:"Instrument approval changed or is unavailable; paper entry blocked.",reason:finalApproval.reason});
   finalConversion=await getDerivQuoteToUsd(symbol,finalQuote);
  }catch(e){return res.status(503).json({error:e.message||"Final verified quote or USD conversion unavailable."});}
  const finalSetupError=validatePaperSetup({direction,entry:finalQuote.quote,stop,target});
  if(finalSetupError)return res.status(409).json({error:"Market price changed; review your stop-loss and take-profit levels.",detail:finalSetupError});
  try{sizing=calculatePaperPosition({balance:Number(session.current_balance),riskPct,entry:finalQuote.quote,stop,quoteToUsd:finalConversion.rate});}
  catch{return res.status(409).json({error:"Could not recalculate a safe paper position size at the final quote."});}
  if(!Number.isFinite(sizing.units)||sizing.units<=0||sizing.units>1e12)
   return res.status(409).json({error:"Final paper position size is outside safe limits."});
  const [{data:finalEmergency,error:finalEmergencyError},{data:finalLegacy,error:finalLegacyError}]=await Promise.all([
   db.from("demo_paper_emergency_controls").select("entries_blocked").eq("user_id",uid).eq("broker","DERIV").eq("broker_account_ref",session.broker_account_ref).maybeSingle(),
   db.from("bot_emergency_controls").select("kill_switch_active").eq("user_id",uid).eq("account_mode","DEMO").eq("broker","DERIV").eq("broker_account_ref",session.broker_account_ref).maybeSingle()
  ]);
  if(finalEmergencyError||finalLegacyError)return res.status(503).json({error:"Could not re-verify the DEMO emergency stop before entry."});
  if(finalEmergency?.entries_blocked||finalLegacy?.kill_switch_active)return res.status(403).json({error:"Emergency stop is active. New paper entries are blocked."});
  quote=finalQuote;
  conversion=finalConversion;
  const {data:result,error}=await db.rpc("open_demo_paper_trade",{
   p_user_id:uid,p_session_id:session.id,p_instrument:symbol,p_side:direction,p_entry:quote.quote,p_stop:stop,p_target:target,
   p_quantity:sizing.units,p_risk_amount:sizing.riskAmount,p_risk_pct:riskPct,p_quote_to_usd:conversion.rate,
   p_quote_source:quote.source,p_quote_as_of:quote.quoteAsOf,p_trade_origin:"MANUAL"
  });
  if(error){console.error("DEMO paper open RPC:",error.message);return res.status(503).json({error:"Paper entry could not be committed safely."});}
  if(!result?.ok){const status=["KILL_SWITCH_ACTIVE","DAILY_LOSS_LIMIT"].includes(result?.reason)?403:409;return res.status(status).json({error:({SESSION_NOT_RUNNING:"Your DEMO session is no longer running.",INSTRUMENT_MISMATCH:"Instrument no longer matches session settings.",KILL_SWITCH_ACTIVE:"Emergency stop is active.",DAILY_LOSS_LIMIT:"Daily DEMO loss limit reached.",OPEN_POSITION_EXISTS:"Close the existing paper position first.",MAX_OPEN_POSITIONS:"Your DEMO account has reached its simultaneous position limit.",BOT_POSITION_EXISTS:"The automated strategy already has an open BOT position.",TOTAL_OPEN_RISK_LIMIT:"This entry would exceed your combined open-risk limit."})[result?.reason]||"Paper entry blocked by a server-side risk check.",reason:result?.reason});}
  return res.status(201).json({ok:true,trade:{id:result.trade_id,instrument:result.instrument,symbol:result.instrument,side:result.side,direction:result.side,entry_price:Number(result.entry_price),stop_loss:Number(result.stop_loss),take_profit:Number(result.take_profit),quantity:Number(result.quantity),virtual_units:Number(result.quantity),risk_amount:Number(result.risk_amount_usd),risk_amount_usd:Number(result.risk_amount_usd),risk_pct:Number(result.risk_pct),status:result.status,opened_at:result.opened_at},quote:{source:quote.source,asOf:quote.quoteAsOf,instrument:quote.providerSymbol},message:"Virtual DEMO position opened at a verified Deriv quote. No broker order or real money is involved."});
 }catch(e){console.error("DEMO paper trade:",e.message);return res.status(500).json({error:"Paper trade could not be processed."});}
}
