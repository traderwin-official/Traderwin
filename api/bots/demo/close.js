import {createClient} from "@supabase/supabase-js";
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
  const {data:t,error:te}=await db.from("demo_paper_trades").select("id,instrument,trade_origin,status").eq("id",tradeId).eq("user_id",a.user.id).eq("status","OPEN").maybeSingle();
  if(te||!t)return res.status(404).json({error:"Open DEMO paper trade not found."});
  let q;try{q=await getDerivPublicQuote(t.instrument);}catch(e){return res.status(503).json({error:e.message||"Fresh Deriv quote unavailable."});}
  if(q.source!=="DERIV"||norm(q.instrument)!==norm(t.instrument)||!q.providerSymbol)return res.status(503).json({error:"Verified quote does not match this paper position."});
  let fx;try{fx=await getDerivQuoteToUsd(t.instrument,q);}catch(e){return res.status(503).json({error:e.message||"USD conversion quote unavailable."});}
  const {data:r,error}=await db.rpc("close_demo_paper_trade",{p_user_id:a.user.id,p_trade_id:t.id,p_exit_price:q.quote,p_quote_to_usd:fx.rate,p_quote_source:q.source,p_quote_as_of:q.quoteAsOf,p_reason:"MANUAL_CLOSE"});
  if(error){console.error("DEMO close RPC:",error.message);return res.status(503).json({error:"Paper close could not be committed safely."});}
  if(!r?.ok)return res.status(409).json({error:"Paper position may already be closed.",reason:r?.reason});
  return res.status(200).json({ok:true,trade:{id:r.trade_id,exit_price:r.exit_price,realized_pnl:r.realized_pnl_total,status:"CLOSED"},balance:r.balance,quote:{source:q.source,asOf:q.quoteAsOf,instrument:q.providerSymbol},message:"DEMO paper position closed atomically. No broker order was sent."});
 }catch(e){console.error("DEMO close:",e.message);return res.status(500).json({error:"Could not close DEMO paper position."});}
}
