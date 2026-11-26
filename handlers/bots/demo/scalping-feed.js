import {createClient} from "@supabase/supabase-js";

const norm=value=>String(value||"").trim().toUpperCase().replace(/[\s/.-]/g,"");

export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="GET"){res.setHeader("Allow","GET");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Scalping feed is not configured."});
 const authorization=req.headers.authorization||"";
 if(!authorization.startsWith("Bearer ")||!authorization.slice(7).trim())return res.status(401).json({error:"Sign in is required."});
 try{
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await db.auth.getUser(authorization.slice(7).trim());
  if(authError||!auth.user)return res.status(401).json({error:"Your login session is invalid."});
  const userId=auth.user.id;
  const {data:profile,error:profileError}=await db.from("trader_profiles").select("account_mode").eq("user_id",userId).maybeSingle();
  if(profileError||!profile)return res.status(409).json({error:"Complete your account setup first."});
  if(profile.account_mode!=="DEMO")return res.status(403).json({error:"The scalping feed is currently restricted to DEMO mode."});
  const accountRef="DEMO:"+userId;
  const {data:session,error:sessionError}=await db.from("demo_paper_sessions")
   .select("id,user_id,broker,broker_account_ref,instrument,status,config_snapshot")
   .eq("user_id",userId).eq("broker","DERIV").eq("broker_account_ref",accountRef)
   .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(sessionError)return res.status(503).json({error:"Could not verify your DEMO session."});
  if(!session||session.status!=="RUNNING")return res.status(200).json({ok:true,enabled:false,feedStatus:"OFF",signals:[]});
  const sessionConfig=session?.config_snapshot&&typeof session.config_snapshot==="object"?session.config_snapshot:{};
  if(!session||sessionConfig.account_mode!=="DEMO"||!["WEBSITE_PAPER_ONLY","WEBSITE_DEMO_AUTO_PAPER_ONLY"].includes(sessionConfig.execution))return res.status(200).json({ok:true,enabled:false,feedStatus:"OFF",signals:[]});
  const {data:preference,error:preferenceError}=await db.from("demo_scalping_preferences")
   .select("enabled,account_mode,execution,max_risk_per_trade_pct,max_daily_loss_pct,max_open_positions")
   .eq("session_id",session.id).eq("user_id",userId).maybeSingle();
  if(preferenceError)return res.status(503).json({error:"Could not verify your scalping preference."});
  if(!preference||preference.enabled!==true||preference.account_mode!=="DEMO"||preference.execution!=="WEBSITE_PAPER_ONLY")
   return res.status(200).json({ok:true,enabled:false,feedStatus:"OFF",signals:[]});
  const instrument=norm(session.instrument);
  if(!instrument)return res.status(409).json({error:"Choose a valid DEMO instrument first."});
  const [tickResult,signalResult]=await Promise.all([
   db.from("scalping_market_ticks").select("instrument,provider_symbol,quote,bid,ask,quote_as_of,received_at,source").eq("instrument",instrument).maybeSingle(),
   db.from("scalping_signal_events").select("instrument,direction,confidence,entry,stop_loss,take_profit,risk_reward,reason,signal_as_of,candle_epoch,status").eq("instrument",instrument).order("created_at",{ascending:false}).limit(10)
  ]);
  if(tickResult.error||signalResult.error)return res.status(503).json({error:"Could not load the latest verified scalping data."});
  const now=Date.now(),tick=tickResult.data||null;
  const receivedAt=tick?Date.parse(tick.received_at):NaN,quoteAsOf=tick?Date.parse(tick.quote_as_of):NaN;
  const tickAgeMs=Number.isFinite(receivedAt)?now-receivedAt:null,quoteAgeMs=Number.isFinite(quoteAsOf)?now-quoteAsOf:null;
  const tickFresh=tickAgeMs!==null&&tickAgeMs>=0&&tickAgeMs<=3000&&quoteAgeMs!==null&&quoteAgeMs>=0&&quoteAgeMs<=10000;
  const signals=(signalResult.data||[]).map(s=>{
   const asOf=Date.parse(s.signal_as_of),age=Number.isFinite(asOf)?now-asOf:null;
   return {...s,fresh:age!==null&&age>=0&&age<=60000,ageMs:age};
  });
  return res.status(200).json({
   ok:true,enabled:true,accountMode:"DEMO",execution:"SIGNAL_ONLY",instrument,
   feedStatus:!tick?"WAITING_FOR_MARKET_DATA":tickFresh?"LIVE":"STALE",
   tick:tick?{...tick}:null,tickAgeMs,quoteAgeMs,signals,
   limits:{riskPerTradePct:Number(preference.max_risk_per_trade_pct),dailyLossPct:Number(preference.max_daily_loss_pct),maxOpenPositions:Number(preference.max_open_positions)}
  });
 }catch(error){
  console.error("DEMO scalping feed:",error?.message||"Unknown error");
  return res.status(500).json({error:"Could not load the DEMO scalping feed safely."});
 }
}
