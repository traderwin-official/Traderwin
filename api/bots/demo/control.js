import { createClient } from "@supabase/supabase-js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Demo bot service is not configured."});
 const h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return res.status(401).json({error:"Sign in is required."});
 try{
  const b=typeof req.body==="string"?JSON.parse(req.body):(req.body||{}),action=String(b.action||"").toUpperCase();
  if(!["START","STOP","STATUS"].includes(action))return res.status(400).json({error:"Choose START, STOP or STATUS."});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:a,error:ae}=await db.auth.getUser(h.slice(7).trim());if(ae||!a.user)return res.status(401).json({error:"Your login session is invalid."});
  const uid=a.user.id;
  if(action==="STATUS"){
   const {data:active,error:activeError}=await db.from("demo_bot_sessions").select("id,status,current_balance,virtual_currency,started_at,bot_setting_id").eq("user_id",uid).order("created_at",{ascending:false}).limit(1).maybeSingle();
   if(activeError)return res.status(503).json({error:"Could not load demo session status."});
   if(!active)return res.status(200).json({ok:true,session:null,openTrade:null,message:"No demo session exists yet."});
   const {data:settings}=await db.from("bot_settings").select("instrument").eq("id",active.bot_setting_id).maybeSingle();
   const {data:openTrade,error:tradeError}=await db.from("demo_bot_trades").select("id,symbol,direction,entry_price,stop_loss,take_profit,status").eq("user_id",uid).eq("status","OPEN").order("opened_at",{ascending:false}).limit(1).maybeSingle();
   if(tradeError)return res.status(503).json({error:"Could not load your open paper trade."});
   return res.status(200).json({ok:true,session:{...active,instrument:settings?.instrument||null},openTrade:openTrade||null,message:"Demo session and open paper trade status loaded."});
  }
  if(action==="START"){
   const {data:p,error:pe}=await db.from("trader_profiles").select("account_mode,max_risk_per_trade_pct,max_daily_loss_pct").eq("user_id",uid).maybeSingle();
   if(pe||!p)return res.status(409).json({error:"Complete your account setup first."});
   if(p.account_mode!=="DEMO")return res.status(403).json({error:"Paper simulator only runs in DEMO mode. REAL mode is blocked."});
   const {data:s,error:se}=await db.from("bot_settings").select("id,broker,instrument,account_mode,max_risk_per_trade_pct").eq("user_id",uid).maybeSingle();
   if(se||!s)return res.status(409).json({error:"Save your bot preferences first."});
   if(s.account_mode!=="DEMO")return res.status(403).json({error:"Your saved bot settings are not DEMO."});
   const emergencyBroker=String(s.broker||"").toUpperCase()==="DERIV"?"DERIV":String(s.broker||"").toUpperCase()==="MT5"?"MT5":null;
   if(!emergencyBroker)return res.status(403).json({error:"Unsupported broker for emergency control."});
   const {data:emergencyControl,error:emergencyError}=await db.from("bot_emergency_controls").select("kill_switch_active").eq("user_id",uid).eq("account_mode","DEMO").eq("broker",emergencyBroker).eq("broker_account_ref",`DEMO:${uid}`).maybeSingle();
   if(emergencyError)return res.status(503).json({error:"Emergency control status is unavailable. Apply the emergency-controls migration before starting the bot."});
   if(emergencyControl?.kill_switch_active)return res.status(403).json({error:"Emergency stop is active. Clear it only after checking your account and risk controls."});
   const {data:modeProfile}=await db.from("bot_mode_profiles").select("max_risk_per_trade_pct,max_daily_loss_pct").eq("user_id",uid).eq("account_mode","DEMO").maybeSingle();
   const nairobiToday=new Date(Date.now()+3*60*60*1000);nairobiToday.setUTCHours(0,0,0,0);
   const utcNairobiDayStart=new Date(nairobiToday.getTime()-3*60*60*1000);
   const {data:lastSession,error:lastError}=await db.from("demo_bot_sessions").select("id,status,created_at").eq("user_id",uid).order("created_at",{ascending:false}).limit(1).maybeSingle();
   if(lastError)return res.status(503).json({error:"Could not verify your previous demo session."});
   if(lastSession?.status==="RISK_LOCKED"&&new Date(lastSession.created_at)>=utcNairobiDayStart)
    return res.status(403).json({error:"Your demo session hit its daily loss limit. The safety lock remains active until the next Nairobi trading day."});
   const {data:active,error:ae2}=await db.from("demo_bot_sessions").select("id,status,current_balance,virtual_currency,started_at").eq("user_id",uid).eq("status","RUNNING").maybeSingle();
   if(ae2)return res.status(503).json({error:"Could not check existing demo session."});
   if(active)return res.status(200).json({ok:true,session:active,message:"Demo paper session is already running."});
   const {data:session,error}=await db.from("demo_bot_sessions").insert({
    user_id:uid,bot_setting_id:s.id,account_mode:"DEMO",status:"RUNNING",
    starting_balance:10000,current_balance:10000,
    max_risk_per_trade_pct:Math.min(Number(p.max_risk_per_trade_pct),Number(s.max_risk_per_trade_pct),Number(modeProfile?.max_risk_per_trade_pct||p.max_risk_per_trade_pct)),
    max_daily_loss_pct:Math.min(Number(p.max_daily_loss_pct),Number(modeProfile?.max_daily_loss_pct||p.max_daily_loss_pct))
   }).select("id,status,current_balance,virtual_currency,started_at").single();
   if(error||!session){console.error("Demo start failed:",error?.message);return res.status(409).json({error:"Could not start demo session. Check for an existing session."});}
   await db.from("bot_activity").insert({user_id:uid,bot_setting_id:s.id,event_type:"START_REQUESTED",account_mode:"DEMO",details:{session_id:session.id,instrument:s.instrument,simulator:"PAPER_ONLY"}});
   return res.status(200).json({ok:true,session:{...session,instrument:s.instrument},message:"Virtual demo session started. No broker orders are sent."});
  }
  const {data:s,error:se}=await db.from("demo_bot_sessions").select("id,bot_setting_id").eq("user_id",uid).eq("status","RUNNING").maybeSingle();
  if(se)return res.status(503).json({error:"Could not load active demo session."});
  if(!s)return res.status(200).json({ok:true,session:null,message:"No demo session is running."});
  const {error}=await db.from("demo_bot_sessions").update({status:"STOPPED",stopped_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","RUNNING");
  if(error)return res.status(503).json({error:"Could not stop demo session."});
  await db.from("bot_activity").insert({user_id:uid,bot_setting_id:s.bot_setting_id,event_type:"STOP_REQUESTED",account_mode:"DEMO",details:{session_id:s.id}});
  return res.status(200).json({ok:true,session:{id:s.id,status:"STOPPED"},message:"Demo paper session stopped."});
 }catch(e){console.error("Demo control:",e.message);return res.status(500).json({error:"Demo bot service encountered an error."});}
}
