import {createClient} from "@supabase/supabase-js";

export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"DEMO scalping preferences are not configured."});
 const authorization=req.headers.authorization||"";
 if(!authorization.startsWith("Bearer ")||!authorization.slice(7).trim())return res.status(401).json({error:"Sign in is required."});
 try{
  const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  const action=String(body.action||"").trim().toUpperCase();
  if(!["STATUS","ENABLE","DISABLE","ENABLE_PAPER_EXECUTION","DISABLE_PAPER_EXECUTION"].includes(action))return res.status(400).json({error:"Choose a supported scalping preference action."});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await db.auth.getUser(authorization.slice(7).trim());
  if(authError||!auth.user)return res.status(401).json({error:"Your login session is invalid."});
  const userId=auth.user.id,accountRef="DEMO:"+userId;
  const {data:profile,error:profileError}=await db.from("trader_profiles")
   .select("account_mode,max_risk_per_trade_pct,max_daily_loss_pct").eq("user_id",userId).maybeSingle();
  if(profileError||!profile)return res.status(409).json({error:"Complete your account setup first."});
  if(profile.account_mode!=="DEMO")return res.status(403).json({error:"Live scalping signals are currently restricted to the explicitly selected DEMO account mode."});
  const {data:session,error:sessionError}=await db.from("demo_paper_sessions")
   .select("id,user_id,broker,broker_account_ref,instrument,status,config_snapshot")
   .eq("user_id",userId).eq("broker","DERIV").eq("broker_account_ref",accountRef)
   .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(sessionError)return res.status(503).json({error:"Could not verify your DEMO scalping session."});
  if(!session)return res.status(409).json({error:"Start a Deriv DEMO paper session first."});
  const {data:current,error:currentError}=await db.from("demo_scalping_preferences")
   .select("enabled,paper_execution_enabled,account_mode,execution,max_risk_per_trade_pct,max_daily_loss_pct,max_open_positions")
   .eq("session_id",session.id).eq("user_id",userId).maybeSingle();
  if(currentError)return res.status(503).json({error:"Could not load your scalping preference."});
  if(action==="STATUS")return res.status(200).json({ok:true,enabled:current?.enabled===true,paperExecutionEnabled:current?.paper_execution_enabled===true,accountMode:"DEMO",execution:"WEBSITE_PAPER_ONLY",instrument:session.instrument,sessionStatus:session.status,limits:current?{riskPerTradePct:Number(current.max_risk_per_trade_pct),dailyLossPct:Number(current.max_daily_loss_pct),maxOpenPositions:Number(current.max_open_positions)}:null});
  if(action==="DISABLE"||action==="DISABLE_PAPER_EXECUTION"){
   if(current){const {error}=await db.from("demo_scalping_preferences").update(action==="DISABLE"?{enabled:false,paper_execution_enabled:false,updated_at:new Date().toISOString()}:{paper_execution_enabled:false,updated_at:new Date().toISOString()}).eq("session_id",session.id).eq("user_id",userId);if(error)return res.status(503).json({error:"Could not disable scalping."});}
   return res.status(200).json({ok:true,enabled:action==="DISABLE"?false:current?.enabled===true,paperExecutionEnabled:false,accountMode:"DEMO",execution:"WEBSITE_PAPER_ONLY",message:action==="DISABLE"?"DEMO scalping feed and automatic paper entries are disabled. Existing open paper positions remain managed to their exits.":"Automatic DEMO paper entries are paused. The read-only scalping feed may remain enabled; existing open paper positions remain managed to their exits."});
  }
  if(action==="ENABLE_PAPER_EXECUTION"&&current?.enabled!==true)return res.status(409).json({error:"Enable the DEMO scalping feed first; this separate switch controls automatic paper entries."});
  if(session.status!=="RUNNING")return res.status(409).json({error:"Start your DEMO session before enabling scalping."});
  const sessionConfig=session.config_snapshot&&typeof session.config_snapshot==="object"?session.config_snapshot:{};
  if(sessionConfig.account_mode!=="DEMO"||!["WEBSITE_PAPER_ONLY","WEBSITE_DEMO_AUTO_PAPER_ONLY"].includes(sessionConfig.execution))return res.status(409).json({error:"The active session is not a verified DEMO paper session. Restart DEMO and try again."});
  if(!session.instrument)return res.status(409).json({error:"Choose a DEMO instrument first."});
  const risk=Math.min(Number(profile.max_risk_per_trade_pct),0.25);
  const daily=Math.min(Number(profile.max_daily_loss_pct),1.00);
  if(!Number.isFinite(risk)||risk<=0||!Number.isFinite(daily)||daily<=0)return res.status(409).json({error:"Your saved DEMO risk limits are invalid."});
  const {data:connection,error:connectionError}=await db.from("deriv_connections")
   .select("demo_account_id,accounts,token_expires_at").eq("user_id",userId).maybeSingle();
  if(connectionError)return res.status(503).json({error:"Could not verify your connected Deriv DEMO account."});
  const expiry=Date.parse(connection?.token_expires_at||"");
  const verified=Array.isArray(connection?.accounts)&&connection.accounts.some(a=>
   a?.account_id===connection.demo_account_id&&String(a.account_type||"").toLowerCase()==="demo"&&String(a.status||"active").toLowerCase()==="active");
  if(!connection?.demo_account_id||!verified||!Number.isFinite(expiry)||expiry<=Date.now())
   return res.status(409).json({error:"Connect and verify an active Deriv DEMO account before enabling scalping."});
  const {data:approval,error:approvalError}=await db.from("trading_instrument_approvals")
   .select("instrument,provider_symbol,status,is_active").eq("broker","DERIV").eq("instrument",String(session.instrument).toUpperCase().replace(/[\\s/.-]/g,""))
   .eq("status","APPROVED").eq("is_active",true).limit(2);
  if(approvalError)return res.status(503).json({error:"Could not verify the instrument approval."});
  if(!approval||approval.length!==1||!approval[0].provider_symbol)return res.status(403).json({error:"This instrument is not currently approved for the DEMO scalping feed."});
  const now=new Date().toISOString();
  const {error:saveError}=await db.from("demo_scalping_preferences").upsert({
   session_id:session.id,user_id:userId,enabled:true,paper_execution_enabled:action==="ENABLE_PAPER_EXECUTION"?true:current?.paper_execution_enabled===true,account_mode:"DEMO",execution:"WEBSITE_PAPER_ONLY",
   max_risk_per_trade_pct:risk,max_daily_loss_pct:daily,max_open_positions:1,updated_at:now
  },{onConflict:"session_id"});
  if(saveError){console.error("DEMO scalping preference save:",saveError.message);return res.status(503).json({error:"Could not enable DEMO scalping safely."});}
  return res.status(200).json({ok:true,enabled:true,accountMode:"DEMO",execution:"WEBSITE_PAPER_ONLY",instrument:session.instrument,
   limits:{riskPerTradePct:risk,dailyLossPct:daily,maxOpenPositions:1},
   paperExecutionEnabled:action==="ENABLE_PAPER_EXECUTION"||current?.paper_execution_enabled===true,
   message:action==="ENABLE_PAPER_EXECUTION"?"Automatic DEMO paper trading is enabled for this session. Orders remain virtual in Traderwin; no Deriv broker order or REAL trade is sent. Risk is capped at 0.25% per trade and 1% daily loss, with one open position.":"DEMO scalping signal feed enabled. This setting does not authorize automatic paper entries or any broker order."});
 }catch(error){console.error("DEMO scalping preference:",error?.message||"Unknown error");return res.status(500).json({error:"Could not update DEMO scalping preference safely."});}
}
