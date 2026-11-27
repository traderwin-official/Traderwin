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
  const b=typeof req.body==="string"?JSON.parse(req.body):(req.body||{}),action=String(b.action||"").toUpperCase(),requestedInstrument=String(b.instrument||"").trim().toUpperCase(),requestedTimeframe=String(b.timeframe||"M15").trim().toUpperCase(),executionMode=String(b.executionMode||"MANUAL").toUpperCase();
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
   if(p.account_mode!=="DEMO")return res.status(403).json({error:"Website paper trading and automation are DEMO-only. REAL execution is not available through this route."});
   if(!["MANUAL","AUTO"].includes(executionMode))return res.status(400).json({error:"Choose MANUAL or AUTO DEMO mode."});
   if(!/^[A-Z0-9_]{2,24}$/.test(requestedInstrument))return res.status(400).json({error:"Choose a supported instrument before starting your DEMO session."});
   if(!["M5","M15","H1","H4"].includes(requestedTimeframe))return res.status(400).json({error:"Choose a supported DEMO timeframe: M5, M15, H1 or H4."});
   if(latest&&["RUNNING","PAUSED"].includes(latest.status)&&String(latest.instrument).toUpperCase()!==requestedInstrument)
    return res.status(409).json({error:"Stop your current DEMO session before changing its instrument."});
   // Manual website DEMO uses the account-level risk limits and must not
   // depend on optional bot preferences. AUTO reads only the matching
   // Deriv/instrument profile using the actual foundation schema columns.
   let modeProfile=null;
   if(executionMode==="AUTO"){
    const {data:modeProfiles,error:modeError}=await db.from("bot_mode_profiles")
     .select("max_risk_per_trade_pct,max_daily_loss_pct").eq("user_id",uid).eq("broker","DERIV")
     .eq("instrument",requestedInstrument).eq("account_mode","DEMO").limit(2);
    if(modeError)return res.status(503).json({error:"Could not verify DEMO risk preferences."});
    if((modeProfiles||[]).length>1)return res.status(409).json({error:"More than one matching DEMO risk profile exists; resolve the duplicate before starting automation."});
    modeProfile=modeProfiles?.[0]||null;
   }
   // The DEMO paper ledger enforces these platform-wide ceilings in SQL as well.
   const risk=Math.min(Number(p.max_risk_per_trade_pct),Number(modeProfile?.max_risk_per_trade_pct||p.max_risk_per_trade_pct),0.25);
   const daily=Math.min(Number(p.max_daily_loss_pct),Number(modeProfile?.max_daily_loss_pct||p.max_daily_loss_pct),1.00);
   let selectedStrategy="MANUAL",timeframe=requestedTimeframe;
   if(executionMode==="AUTO"){
    const {data:botSettings,error:botSettingsError}=await db.from("bot_settings")
     .select("broker,instrument,account_mode,strategy,timeframe").eq("user_id",uid).maybeSingle();
    if(botSettingsError)return res.status(503).json({error:"Could not verify your saved automated strategy settings."});
    if(!botSettings)return res.status(409).json({error:"Save your DEMO bot settings before starting automated trading."});
    const savedBroker=String(botSettings.broker||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
    const savedInstrument=String(botSettings.instrument||"").trim().toUpperCase().replace(/[\s/.-]/g,"");
    selectedStrategy=String(botSettings.strategy||"").trim().toUpperCase();
    timeframe=String(botSettings.timeframe||"M15").trim().toUpperCase();
    if(botSettings.account_mode!=="DEMO"||savedBroker!=="DERIV")
     return res.status(403).json({error:"Website automated DEMO currently supports verified Deriv market data only. Select Deriv and DEMO in your saved bot settings."});
    if(!savedInstrument||savedInstrument!==requestedInstrument.replace(/[\s/.-]/g,""))
     return res.status(409).json({error:"The DEMO instrument must match your saved bot instrument. Update your bot settings or select the matching instrument."});
    if(!["M5","M15","H1","H4"].includes(timeframe))
     return res.status(400).json({error:"Choose a supported automated timeframe: M5, M15, H1 or H4."});
    if(!["AUTO_SELECT_V1","MULTI_CONFIRMATION_V1","TIGER_FIBONACCI_PSYCHOLOGY_V1"].includes(selectedStrategy))
     return res.status(400).json({error:"Choose Auto-select, Smart Multi-Confirmation or Tiger Fibonacci Psychology for automated trading. Manual review does not place automatic entries."});
   }
   if(!Number.isFinite(risk)||risk<=0||risk>0.25||!Number.isFinite(daily)||daily<=0||daily>1.00)return res.status(409).json({error:"Your saved risk limits are invalid."});
   const maxOpenPositions=3;
   const brokerAccountRef="DEMO:"+uid;
   const {data:emergency,error:emergencyError}=await db.from("demo_paper_emergency_controls").select("entries_blocked").eq("user_id",uid).eq("broker","DERIV").eq("broker_account_ref",brokerAccountRef).maybeSingle();
   if(emergencyError)return res.status(503).json({error:"Could not verify the DEMO emergency stop."});
   const {data:legacyEmergency,error:legacyEmergencyError}=await db.from("bot_emergency_controls").select("kill_switch_active").eq("user_id",uid).eq("account_mode","DEMO").eq("broker","DERIV").eq("broker_account_ref",brokerAccountRef).maybeSingle();
   if(legacyEmergencyError)return res.status(503).json({error:"Could not verify the existing DEMO emergency stop."});
   if(emergency?.entries_blocked||legacyEmergency?.kill_switch_active)return res.status(403).json({error:"DEMO emergency stop is active."});
   if(latest?.status==="RUNNING"){
    if(latest.timeframe!==timeframe)return res.status(409).json({error:"A DEMO session is already running on a different timeframe. Stop it before changing timeframes."});
    if(latest.strategy!==selectedStrategy)return res.status(409).json({error:"A DEMO session is already running in a different mode or strategy. Stop it before changing modes."});
    return res.status(200).json({ok:true,session:{...latest,account_mode:"DEMO"},message:"Your selected DEMO session is already running."});
   }
   if(latest?.status==="PAUSED"){
    if(latest.timeframe!==timeframe)return res.status(409).json({error:"Your paused DEMO session uses a different timeframe. Resume it with its original timeframe or finish it before changing timeframes."});
    if(latest.strategy!==selectedStrategy)return res.status(409).json({error:"Your paused DEMO session uses a different mode or strategy. Resume it with its original settings or finish it before changing modes."});
    const {data:resumed,error:resumeError}=await db.from("demo_paper_sessions").update({status:"RUNNING",stopped_at:null,updated_at:new Date().toISOString()}).eq("id",latest.id).eq("user_id",uid).select("*").single();
    if(resumeError)return res.status(503).json({error:"Could not resume your DEMO session."});
    return res.status(200).json({ok:true,session:{...resumed,account_mode:"DEMO"},message:executionMode==="AUTO"?"Your automated DEMO session resumed. The selected strategy will manage BOT-originated virtual positions.":"Your manual website DEMO session resumed."});
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
   const {data:accountBalance,error:balanceError}=await db.rpc("get_demo_paper_account_balance",{p_user_id:uid});
   const carriedBalance=Number(accountBalance);
   if(balanceError||!Number.isFinite(carriedBalance)||carriedBalance<0){
    console.error("DEMO account balance lookup:",balanceError?.message||"invalid balance");
    return res.status(503).json({error:"Could not safely restore your cumulative DEMO account balance. Apply the DEMO account-balance migration and retry."});
   }
   const {data:session,error}=await db.from("demo_paper_sessions").insert({
    user_id:uid,broker:"DERIV",broker_account_ref:brokerAccountRef,instrument:requestedInstrument,
    strategy:selectedStrategy,timeframe,status:"RUNNING",starting_balance:carriedBalance,current_balance:carriedBalance,
    risk_per_trade_pct:risk,max_daily_loss_pct:daily,max_open_positions:maxOpenPositions,max_total_open_risk_pct:1.00,
     config_snapshot:{broker:"DERIV_PUBLIC_MARKET_DATA",instrument:requestedInstrument,strategy:selectedStrategy,timeframe,account_mode:"DEMO",execution:executionMode==="AUTO"?"WEBSITE_DEMO_AUTO_PAPER_ONLY":"WEBSITE_PAPER_ONLY"}
   }).select("*").single();
   if(error||!session){console.error("DEMO paper session start:",error?.message);return res.status(409).json({error:"Could not create the DEMO paper session."});}
   return res.status(201).json({ok:true,session,message:executionMode==="AUTO"?"Automated DEMO session started. The selected strategy will open and manage virtual BOT positions only; no broker orders or real money are involved.":"Website manual DEMO session started. Open and close virtual positions here; no broker orders or real money are involved."});
  }
  if(!latest||!["RUNNING","PAUSED"].includes(latest.status))return res.status(200).json({ok:true,session:latest,message:"No active DEMO session is running."});
  // AUTO sessions may hold several BOT positions; only existence is needed
  // to decide whether the session must remain PAUSED for protective management.
  const {data:openTrade,error:tradeError}=await db.from("demo_paper_trades").select("id,trade_origin").eq("session_id",latest.id).eq("user_id",uid).eq("status","OPEN").eq("trade_origin","BOT").limit(1).maybeSingle();
  if(tradeError)return res.status(503).json({error:"Could not verify the open paper position."});
  const nextStatus=openTrade?.trade_origin==="BOT"?"PAUSED":"STOPPED";
  const {data:stopped,error}=await db.from("demo_paper_sessions").update({status:nextStatus,stopped_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",latest.id).eq("user_id",uid).select("*").single();
  if(error)return res.status(503).json({error:"Could not stop DEMO automation."});
  return res.status(200).json({ok:true,session:stopped,message:nextStatus==="PAUSED"?"New entries stopped. The worker will continue managing the existing BOT position.":"DEMO session stopped. Any open MANUAL paper positions remain under your control."});
 }catch(e){console.error("DEMO paper control:",e.message);return res.status(500).json({error:"DEMO paper control failed safely."});}
}
