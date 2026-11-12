import { createClient } from "@supabase/supabase-js";
import { validatePaperSetup,calculatePaperPosition } from "../../../lib/demo-risk.js";
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN;};
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Demo simulator is not configured."});
 const h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return res.status(401).json({error:"Sign in is required."});
 try{
  const b=typeof req.body==="string"?JSON.parse(req.body):(req.body||{}),symbol=String(b.symbol||"").trim().toUpperCase(),direction=String(b.direction||"").toUpperCase();
  const entry=num(b.entryPrice),stop=num(b.stopLoss),target=num(b.takeProfit);
  if(!/^[A-Z0-9._-]{2,24}$/.test(symbol))return res.status(400).json({error:"Enter a valid instrument symbol."});
  const setupError=validatePaperSetup({direction,entry,stop,target});if(setupError)return res.status(400).json({error:setupError});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:a,error:ae}=await db.auth.getUser(h.slice(7).trim());if(ae||!a.user)return res.status(401).json({error:"Your login session is invalid."});
  const uid=a.user.id;
  const {data:p,error:pe}=await db.from("trader_profiles").select("account_mode,max_risk_per_trade_pct").eq("user_id",uid).maybeSingle();
  if(pe||!p)return res.status(409).json({error:"Complete your account setup first."});if(p.account_mode!=="DEMO")return res.status(403).json({error:"Paper trades are DEMO-only."});
  const {data:s,error:se}=await db.from("demo_bot_sessions").select("id,current_balance,max_risk_per_trade_pct,max_daily_loss_pct,status").eq("user_id",uid).eq("status","RUNNING").maybeSingle();
  if(se||!s)return res.status(409).json({error:"Start your DEMO paper session first."});
  const {data:cfg,error:ce}=await db.from("bot_settings").select("instrument,account_mode,max_risk_per_trade_pct").eq("user_id",uid).maybeSingle();
  if(ce||!cfg||cfg.account_mode!=="DEMO")return res.status(403).json({error:"Saved bot settings are not in DEMO mode."});
  if(symbol!==String(cfg.instrument).toUpperCase())return res.status(400).json({error:"Symbol must match your saved bot instrument."});
  const {data:modeProfile}=await db.from("bot_mode_profiles").select("profit_giveback_pct,max_risk_per_trade_pct,max_daily_loss_pct").eq("user_id",uid).eq("account_mode","DEMO").maybeSingle();
  const givebackPct=Math.min(50,Math.max(1,Number(modeProfile?.profit_giveback_pct||20)));
  const riskPct=Math.min(Number(p.max_risk_per_trade_pct),Number(s.max_risk_per_trade_pct),Number(cfg.max_risk_per_trade_pct),Number(modeProfile?.max_risk_per_trade_pct||p.max_risk_per_trade_pct));
  let sizing;try{sizing=calculatePaperPosition({balance:Number(s.current_balance),riskPct,entry,stop});}catch{return res.status(400).json({error:"Could not calculate safe paper position size."});}
  if(!Number.isFinite(sizing.units)||sizing.units<=0||sizing.units>1e12)return res.status(400).json({error:"Paper position size outside safe limits."});
  const {data:openTrades,error:openError}=await db.from("demo_bot_trades").select("id").eq("user_id",uid).eq("status","OPEN").limit(1);
  if(openError)return res.status(503).json({error:"Could not check open paper trades."});
  if(openTrades?.length)return res.status(409).json({error:"Close your existing open paper trade before recording another. This demo version allows one open position at a time."});
  const nairobiNow=new Date(Date.now()+3*60*60*1000);
  nairobiNow.setUTCHours(0,0,0,0);
  const dayStart=new Date(nairobiNow.getTime()-3*60*60*1000);
  const {data:closed,error:de}=await db.from("demo_bot_trades").select("realized_pnl").eq("user_id",uid).eq("status","CLOSED").gte("closed_at",dayStart.toISOString());
  if(de)return res.status(503).json({error:"Could not verify daily loss limit."});
  const losses=(closed||[]).reduce((sum,t)=>sum+Math.min(0,Number(t.realized_pnl||0)),0);
  const dailyLimit=Number(s.current_balance)*Number(s.max_daily_loss_pct)/100;
  if(Math.abs(losses)>=dailyLimit){await db.from("demo_bot_sessions").update({status:"RISK_LOCKED",stopped_at:new Date().toISOString()}).eq("id",s.id);await db.from("bot_activity").insert({user_id:uid,event_type:"RISK_BLOCK",account_mode:"DEMO",details:{reason:"DAILY_LOSS_LIMIT",daily_loss:Math.abs(losses),limit:dailyLimit}});return res.status(403).json({error:"Daily demo loss limit reached. Session locked."});}
  const {data:t,error:te}=await db.from("demo_bot_trades").insert({session_id:s.id,user_id:uid,symbol,direction,entry_price:entry,stop_loss:stop,take_profit:target,virtual_units:sizing.units,risk_amount:sizing.riskAmount,risk_pct:riskPct,profit_giveback_pct:givebackPct,quote_source:"USER_SUPPLIED_DEMO_PRICE"}).select("id,symbol,direction,entry_price,stop_loss,take_profit,virtual_units,risk_amount,risk_pct,profit_giveback_pct,status,opened_at").single();
  if(te||!t){console.error("Paper trade insert:",te?.message);return res.status(503).json({error:"Could not save paper trade."});}
  await db.from("bot_activity").insert({user_id:uid,event_type:"DEMO_ORDER",account_mode:"DEMO",details:{trade_id:t.id,symbol,direction,risk_amount:sizing.riskAmount,quote_source:"USER_SUPPLIED_DEMO_PRICE"}});
  return res.status(201).json({ok:true,trade:t,message:"Paper trade recorded. No broker order or real money is involved."});
 }catch(e){console.error("Paper trade:",e.message);return res.status(500).json({error:"Paper trade could not be processed."});}
}
