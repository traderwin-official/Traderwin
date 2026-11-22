import {createClient} from "@supabase/supabase-js";
import {calculatePaperPnl} from "../../../lib/demo-risk.js";
import {getDerivPublicQuote} from "../../../lib/deriv-public-quote.js";
import {getDerivQuoteToUsd} from "../../../lib/usd-conversion.js";
const norm=v=>String(v||"").trim().toUpperCase().replace(/[\s/.-]/g,"");
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"DEMO paper service is not configured."});
 const h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return res.status(401).json({error:"Sign in is required."});
 try{
  const b=typeof req.body==="string"?JSON.parse(req.body):(req.body||{}),tradeId=String(b.tradeId||"");
  if(!/^[0-9a-f-]{36}$/i.test(tradeId))return res.status(400).json({error:"Enter a valid paper trade ID."});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:a,error:ae}=await db.auth.getUser(h.slice(7).trim());if(ae||!a.user)return res.status(401).json({error:"Your login session is invalid."});
  const {data:t,error:te}=await db.from("demo_paper_trades").select("id,instrument,side,entry_price,stop_loss,take_profit,remaining_quantity,status").eq("id",tradeId).eq("user_id",a.user.id).eq("status","OPEN").maybeSingle();
  if(te||!t)return res.status(404).json({error:"Open DEMO paper trade not found."});
  let q;try{q=await getDerivPublicQuote(t.instrument);}catch(e){return res.status(503).json({error:e.message||"Fresh Deriv quote unavailable."});}
  if(q.source!=="DERIV"||norm(q.instrument)!==norm(t.instrument)||!q.providerSymbol)return res.status(503).json({error:"Verified quote does not match this paper position."});
  let fx;try{fx=await getDerivQuoteToUsd(t.instrument,q);}catch(e){return res.status(503).json({error:e.message||"USD conversion quote unavailable."});}
  const pnl=calculatePaperPnl({direction:t.side,entry:Number(t.entry_price),exit:q.quote,units:Number(t.remaining_quantity),quoteToUsd:fx.rate});
  const stopHit=t.side==="BUY"?q.quote<=Number(t.stop_loss):q.quote>=Number(t.stop_loss);
  const targetHit=t.side==="BUY"?q.quote>=Number(t.take_profit):q.quote<=Number(t.take_profit);
  if(stopHit||targetHit){
   const reason=stopHit?"STOP_LOSS":"TAKE_PROFIT";
   const {data:closed,error:closeError}=await db.rpc("close_demo_paper_trade",{
    p_user_id:a.user.id,p_trade_id:t.id,p_exit_price:q.quote,p_quote_to_usd:fx.rate,
    p_quote_source:q.source,p_quote_as_of:q.quoteAsOf,p_reason:reason
   });
   if(closeError||!closed?.ok)return res.status(503).json({error:"DEMO exit level was reached but the virtual close could not be committed safely."});
   return res.status(200).json({ok:true,closed:true,reason,trade:{id:closed.trade_id,exit_price:closed.exit_price,realized_pnl:closed.realized_pnl_total,status:"CLOSED"},balance:closed.balance,quote:{source:q.source,asOf:q.quoteAsOf,instrument:q.providerSymbol},message:reason==="STOP_LOSS"?"DEMO stop-loss reached. The virtual position was closed.":"DEMO take-profit reached. The virtual position was closed."});
  }
  const {data:ok,error}=await db.rpc("mark_demo_paper_trade",{p_user_id:a.user.id,p_trade_id:t.id,p_price:q.quote,p_quote_as_of:q.quoteAsOf});
  if(error||!ok)return res.status(503).json({error:"Could not save the verified DEMO price mark."});
  return res.status(200).json({ok:true,closed:false,currentPrice:q.quote,currentUnrealizedPnl:pnl,quote:{source:q.source,asOf:q.quoteAsOf,instrument:q.providerSymbol},protection:{active:false,scope:"PORTFOLIO",reason:"AWAITING_PORTFOLIO_MONITOR"},message:"DEMO mark saved. Portfolio-level profit protection is separate; this endpoint does not close positions."});
 }catch(e){console.error("DEMO mark:",e.message);return res.status(500).json({error:"Could not mark DEMO paper position."});}
}
