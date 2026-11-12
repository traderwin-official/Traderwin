import { createClient } from "@supabase/supabase-js";
import { calculatePaperPnl } from "../../../lib/demo-risk.js";
import { getDerivPublicQuote } from "../../../lib/deriv-public-quote.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Demo simulator is not configured."});
 const h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return res.status(401).json({error:"Sign in is required."});
 try{
  const b=typeof req.body==="string"?JSON.parse(req.body):(req.body||{}),id=String(b.tradeId||"");
  if(!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:"Enter a valid paper trade ID."});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:a,error:ae}=await db.auth.getUser(h.slice(7).trim());if(ae||!a.user)return res.status(401).json({error:"Your login session is invalid."});
  const {data:t,error:te}=await db.from("demo_bot_trades").select("id,user_id,session_id,direction,entry_price,virtual_units,status").eq("id",id).eq("user_id",a.user.id).eq("status","OPEN").maybeSingle();
  if(te||!t)return res.status(404).json({error:"Open paper trade not found."});
  let quote;try{quote=await getDerivPublicQuote(t.symbol);}catch(e){return res.status(503).json({error:e.message||"Could not obtain a fresh Deriv quote."});}
  const exit=quote.quote;
  let pnl;try{pnl=calculatePaperPnl({direction:t.direction,entry:Number(t.entry_price),exit,units:Number(t.virtual_units)});}catch{return res.status(400).json({error:"Invalid paper close calculation."});}
  const {data:closed,error}=await db.from("demo_bot_trades").update({exit_price:exit,realized_pnl:pnl,status:"CLOSED",closed_at:new Date().toISOString()}).eq("id",t.id).eq("user_id",a.user.id).eq("status","OPEN").select("id,exit_price,realized_pnl,status,closed_at").maybeSingle();
  if(error||!closed)return res.status(409).json({error:"Trade could not be closed; it may already be closed."});
  const {data:s}=await db.from("demo_bot_sessions").select("current_balance,max_daily_loss_pct,status").eq("id",t.session_id).maybeSingle();
  if(s){
   const nextBalance=Math.max(0,Number(s.current_balance)+pnl);
   const {error:balanceError}=await db.from("demo_bot_sessions").update({current_balance:nextBalance,updated_at:new Date().toISOString()}).eq("id",t.session_id);
   if(balanceError)console.error("Paper balance update failed:",balanceError.message);
   const localNow=new Date(Date.now()+3*60*60*1000);localNow.setUTCHours(0,0,0,0);
   const dayStart=new Date(localNow.getTime()-3*60*60*1000);
   const {data:today,error:dailyError}=await db.from("demo_bot_trades").select("realized_pnl").eq("user_id",a.user.id).eq("status","CLOSED").gte("closed_at",dayStart.toISOString());
   if(!dailyError){
    const losses=(today||[]).reduce((sum,row)=>sum+Math.min(0,Number(row.realized_pnl||0)),0);
    const limit=Number(s.current_balance)*Number(s.max_daily_loss_pct)/100;
    if(Math.abs(losses)>=limit){
     await db.from("demo_bot_sessions").update({status:"RISK_LOCKED",stopped_at:new Date().toISOString()}).eq("id",t.session_id).eq("status","RUNNING");
     await db.from("bot_activity").insert({user_id:a.user.id,event_type:"RISK_BLOCK",account_mode:"DEMO",details:{reason:"DAILY_LOSS_LIMIT",daily_loss:Math.abs(losses),limit}});
    }
   }
  }
  return res.status(200).json({ok:true,trade:closed,quote:{source:quote.source,asOf:quote.quoteAsOf,instrument:quote.providerSymbol},message:"Paper trade closed at a fresh Deriv market quote. Result is simulated only."});
 }catch(e){console.error("Paper close:",e.message);return res.status(500).json({error:"Could not close paper trade."});}
}
