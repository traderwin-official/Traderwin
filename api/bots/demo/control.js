import { createClient } from "@supabase/supabase-js";

export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"DEMO paper service is not configured."});
 const h=req.headers.authorization||"";
 if(!h.startsWith("Bearer "))return res.status(401).json({error:"Sign in is required."});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 try{
  const b=typeof req.body==="string"?JSON.parse(req.body):(req.body||{}),action=String(b.action||"").toUpperCase();
  if(!["START","STOP","STATUS"].includes(action))return res.status(400).json({error:"Choose START, STOP or STATUS."});
  const {data:a,error:ae}=await db.auth.getUser(h.slice(7).trim());
  if(ae||!a.user)return res.status(401).json({error:"Your login session is invalid."});
  const uid=a.user.id;
  const {data:latest,error:latestError}=await db.from("demo_paper_sessions").select("*").eq("user_id",uid).order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(latestError)return res.status(503).json({error:"Could not load your DEMO paper session."});
  if(action==="STATUS"){
   if(!latest)return res.status(200).json({ok:true,session:null,openTrade:null,openTrades:[],workerHeartbeat:null,message:"No DEMO paper session exists yet."});
   const [{data:openTrades,error:tradeError},{data:workerHeartbeat,error:beatError}]=await Promise.all([
     db.from("demo_paper_trades").select("id,instrument,side,entry_price,stop_loss,take_profit,quantity,remaining_quantity,status,trade_origin,opened_at,risk_amount_usd,realized_pnl_usd").eq("session_id",latest.id).eq("user_id",uid).eq("status","OPEN").order("opened_at",{ascending:false}),
    db.from("demo_paper_worker_heartbeats").select("last_tick_at,last_action,last_reason,last_error").eq("session_id",latest.id).eq("user_id",uid).maybeSingle()
   ]);
   if(tradeError||beatError)return res.status(503).json({error:"Could not load DEMO positions or worker health."});
    const compatibleTrades=(openTrades||[]).map(t=>({...t,symbol:t.instrument,direction:t.side,virtual_units:t.remaining_quantity}));
    const compatibleTrade=compatibleTrades.find(t=>t.trade_origin==="BOT")||compatibleTrades[0]||null;
    return res.status(200).json({ok:true,session:latest,openTrade:compatibleTrade,openTrades:compatibleTrades,workerHeartbeat:workerHeartbeat||null,message:"DEMO paper status loaded."});
  }
  if(action==="START"){
   const {data:p,error:pe}=await db.from("trader_profiles").select("account_mode,max_risk_per_trade_pct,max_daily_loss_pct").eq("user_id",uid).maybeSingle();
   if(pe||!p)return res.status(409).json({error:"Complete your account setup first."});
   if(p.account_mode!=="DEMO")return res.status(403).json({error:"Paper automation is DEMO-only. REAL execution is not available through this route."});
   const {data:s,error:se}=await db.from("bot_settings").select("broker,instrument,account_mode,timeframe,strategy,max_risk_per_trade_pct,max_daily_loss_pct,max_open_positions").eq("user_id",uid).maybeSingle();
   if(se||!s)return res.status(409).json({error:"Save your bot preferences first."});
   if(s.account_mode!=="DEMO"||String(s.broker||"").toUpperCase()!=="DERIV")return res.status(403).json({error:"The unattended paper worker currently supports verified Deriv DEMO data only."});
   if(!["MULTI_CONFIRMATION_V1","TIGER_FIBONACCI_PSYCHOLOGY_V1"].includes(s.strategy))return res.status(409).json({error:"Choose a validated automated strategy."});
   const timeframe=String(s.timeframe||"M15").toUpperCase();
   if(!["M5","M15","H1","H4"].includes(timeframe))return res.status(409).json({error:"Choose M5, M15, H1 or H4."});
   const {data:modeProfile,error:modeError}=await db.from("bot_mode_profiles").select("max_risk_per_trade_pct,max_daily_loss_pct").eq("user_id",uid).eq("account_mode","DEMO").maybeSingle();
   if(modeError)return res.status(503).json({error:"Could not verify DEMO risk preferences."});
   const risk=Math.min(Number(p.max_risk_per_trade_pct),Number(s.max_risk_per_trade_pct),Number(modeProfile?.max_risk_per_trade_pct||p.max_risk_per_trade_pct));
   const daily=Math.min(Number(p.max_daily_loss_pct),Number(modeProfile?.max_daily_loss_pct||p.max_daily_loss_pct));
   if(!Number.isFinite(risk)||risk<=0||risk>2||!Number.isFinite(daily)||daily<=0||daily>10)return res.status(409).json({error:"Your saved risk limits are invalid."});
   const maxOpenPositions=Math.max(1,Math.min(10,Math.floor(Number(s.max_open_positions)||3)));
    const brokerAccountRef="DEMO:"+uid;
   const {data:emergency,error:emergencyError}=await db.from("demo_paper_emergency_controls").select("entries_blocked").eq("user_id",uid).eq("broker","DERIV").eq("broker_account_ref",brokerAccountRef).maybeSingle();
   if(emergencyError)return res.status(503).json({error:"Could not verify the DEMO emergency stop."});
   const {data:legacyEmergency,error:legacyEmergencyError}=await db.from("bot_emergency_controls").select("kill_switch_active").eq("user_id",uid).eq("account_mode","DEMO").eq("broker","DERIV").eq("broker_account_ref",brokerAccountRef).maybeSingle();
   if(legacyEmergencyError)return res.status(503).json({error:"Could not verify the existing DEMO emergency stop."});
   if(emergency?.entries_blocked||legacyEmergency?.kill_switch_active)return res.status(403).json({error:"DEMO emergency stop is active."});
   if(latest?.status==="RUNNING")return res.status(200).json({ok:true,session:{...latest,account_mode:"DEMO"},message:"DEMO paper session is already running."});
   if(latest?.status==="PAUSED"){
    const {data:resumed,error:resumeError}=await db.from("demo_paper_sessions").update({status:"RUNNING",stopped_at:null,updated_at:new Date().toISOString()}).eq("id",latest.id).eq("user_id",uid).select("*").single();
    if(resumeError)return res.status(503).json({error:"Could not resume DEMO automation."});
    return res.status(200).json({ok:true,session:{...resumed,account_mode:"DEMO"},message:"DEMO automation resumed. Existing BOT positions remain under automated risk management."});
   }
   if(latest?.status==="RISK_LOCKED"){
    const nairobiNow=new Date(Date.now()+3*60*60*1000);nairobiNow.setUTCHours(0,0,0,0);
    const nairobiDayStart=new Date(nairobiNow.getTime()-3*60*60*1000);
    if(!latest.risk_locked_at||new Date(latest.risk_locked_at)>=nairobiDayStart)return res.status(403).json({error:"Your DEMO daily-loss lock remains active until the next Nairobi trading day."});
    const {data:lockedOpen,error:lockedOpenError}=await db.from("demo_paper_trades").select("id").eq("session_id",latest.id).eq("user_id",uid).eq("status","OPEN").eq("trade_origin","BOT").maybeSingle();
    if(lockedOpenError)return res.status(503).json({error:"Could not verify the risk-locked BOT position."});
    if(lockedOpen)return res.status(409).json({error:"The daily lock has expired, but your existing BOT position is still open. The worker will continue protecting it; wait for it to close before starting a new session."});
    const {error:unlockError}=await db.from("demo_paper_sessions").update({status:"STOPPED",stopped_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",latest.id).eq("status","RISK_LOCKED");
    if(unlockError)return res.status(503).json({error:"Could not safely close the previous risk-locked session."});
   }
   const {data:orphanOpen,error:orphanError}=await db.from("demo_paper_trades").select("id").eq("user_id",uid).eq("status","OPEN").limit(1);
   if(orphanError)return res.status(503).json({error:"Could not verify existing DEMO positions."});
   if(orphanOpen?.length)return res.status(409).json({error:"Close your existing open DEMO paper position before starting a new session."});
   const {data:session,error}=await db.from("demo_paper_sessions").insert({
    user_id:uid,broker:"DERIV",broker_account_ref:brokerAccountRef,instrument:s.instrument,
    strategy:s.strategy,timeframe,status:"RUNNING",starting_balance:10000,current_balance:10000,
    risk_per_trade_pct:risk,max_daily_loss_pct:daily,max_open_positions:maxOpenPositions,max_total_open_risk_pct:2.00,
     config_snapshot:{broker:s.broker,instrument:s.instrument,strategy:s.strategy,timeframe,account_mode:"DEMO"}
   }).select("*").single();
   if(error||!session){console.error("DEMO paper session start:",error?.message);return res.status(409).json({error:"Could not create the DEMO paper session."});}
   return res.status(201).json({ok:true,session,message:"DEMO paper automation started. Orders, balance and P&L are virtual; no broker orders are sent."});
  }
  if(!latest||!["RUNNING","PAUSED"].includes(latest.status))return res.status(200).json({ok:true,session:latest,message:"No active DEMO session is running."});
  const {data:openTrade,error:tradeError}=await db.from("demo_paper_trades").select("id,trade_origin").eq("session_id",latest.id).eq("user_id",uid).eq("status","OPEN").eq("trade_origin","BOT").maybeSingle();
  if(tradeError)return res.status(503).json({error:"Could not verify the open paper position."});
  const nextStatus=openTrade?.trade_origin==="BOT"?"PAUSED":"STOPPED";
  const {data:stopped,error}=await db.from("demo_paper_sessions").update({status:nextStatus,stopped_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",latest.id).eq("user_id",uid).select("*").single();
  if(error)return res.status(503).json({error:"Could not stop DEMO automation."});
  return res.status(200).json({ok:true,session:stopped,message:nextStatus==="PAUSED"?"New entries stopped. The worker will continue managing the existing BOT position.":"DEMO session stopped. Any open MANUAL paper positions remain under your control."});
 }catch(e){console.error("DEMO paper control:",e.message);return res.status(500).json({error:"DEMO paper control failed safely."});}
}
