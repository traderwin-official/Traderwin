import {createClient} from "@supabase/supabase-js";
import {calculateProfitProtection} from "../../../lib/profit-protection.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Demo simulator is not configured."});
 const h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return res.status(401).json({error:"Sign in is required."});
 try{
  const b=typeof req.body==="string"?JSON.parse(req.body):(req.body||{}),id=String(b.tradeId||""),price=Number(b.currentPrice);
  if(!/^[0-9a-f-]{36}$/i.test(id)||!Number.isFinite(price)||price<=0)return res.status(400).json({error:"Enter a valid trade ID and current demo price."});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:a,error:ae}=await db.auth.getUser(h.slice(7).trim());if(ae||!a.user)return res.status(401).json({error:"Invalid login session."});
  const {data:t,error:te}=await db.from("demo_bot_trades").select("id,session_id,direction,entry_price,stop_loss,virtual_units,status,peak_unrealized_profit,profit_giveback_pct,protected_stop_price").eq("id",id).eq("user_id",a.user.id).eq("status","OPEN").maybeSingle();
  if(te||!t)return res.status(404).json({error:"Open paper trade not found."});
  const p=calculateProfitProtection({direction:t.direction,entryPrice:Number(t.entry_price),currentPrice:price,units:Number(t.virtual_units),peakProfit:Number(t.peak_unrealized_profit||0),givebackPct:Number(t.profit_giveback_pct||20),existingStopLoss:Number(t.protected_stop_price||t.stop_loss)}),now=new Date().toISOString();
  if(p.shouldClose){
   const {data:closed,error}=await db.from("demo_bot_trades").update({exit_price:price,realized_pnl:p.currentProfit,status:"CLOSED",closed_at:now,peak_unrealized_profit:p.peakProfit,last_mark_price:price,last_mark_at:now,protected_stop_price:p.protectedStopPrice}).eq("id",id).eq("user_id",a.user.id).eq("status","OPEN").select("id,exit_price,realized_pnl,status,closed_at").maybeSingle();
   if(error||!closed)return res.status(409).json({error:"Trade changed during update; refresh and retry."});
   const {data:s}=await db.from("demo_bot_sessions").select("current_balance").eq("id",t.session_id).maybeSingle();
   if(s)await db.from("demo_bot_sessions").update({current_balance:Math.max(0,Number(s.current_balance)+p.currentProfit),updated_at:now}).eq("id",t.session_id);
   await db.from("bot_activity").insert({user_id:a.user.id,event_type:"DEMO_ORDER",account_mode:"DEMO",details:{trade_id:id,action:"PROFIT_GIVEBACK_CLOSE",peak_profit:p.peakProfit,giveback_pct:p.givebackPct,realized_pnl:p.currentProfit}});
   return res.status(200).json({ok:true,closed:true,trade:closed,protection:p,message:"The 20% peak-profit giveback rule closed this demo paper trade."});
  }
  const {error}=await db.from("demo_bot_trades").update({peak_unrealized_profit:p.peakProfit,protected_stop_price:p.protectedStopPrice,last_mark_price:price,last_mark_at:now}).eq("id",id).eq("user_id",a.user.id).eq("status","OPEN");
  if(error)return res.status(503).json({error:"Could not update profit protection."});
  return res.status(200).json({ok:true,closed:false,protection:p,message:p.protectionActive?"Profit protection level updated.":"Protection activates once the trade moves into profit."});
 }catch(e){console.error("Demo mark:",e.message);return res.status(500).json({error:"Could not process price update."});}
}