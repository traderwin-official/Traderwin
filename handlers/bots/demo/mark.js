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
  const {data:t,error:te}=await db.from("demo_paper_trades").select("id,user_id,session_id,instrument,side,entry_price,stop_loss,take_profit,tp1_price,tp2_price,tp3_price,tp1_percent,tp2_percent,tp3_percent,tp1_done,tp2_done,tp3_done,quantity,remaining_quantity,trade_origin,status").eq("id",tradeId).eq("user_id",a.user.id).eq("status","OPEN").maybeSingle();
  if(te||!t)return res.status(404).json({error:"Open DEMO paper trade not found."});
  let q;try{q=await getDerivPublicQuote(t.instrument);}catch(e){return res.status(503).json({error:e.message||"Fresh Deriv quote unavailable."});}
  if(q.source!=="DERIV"||norm(q.instrument)!==norm(t.instrument)||!q.providerSymbol)return res.status(503).json({error:"Verified quote does not match this paper position."});
  let fx;try{fx=await getDerivQuoteToUsd(t.instrument,q);}catch(e){return res.status(503).json({error:e.message||"USD conversion quote unavailable."});}
  const pnl=calculatePaperPnl({direction:t.side,entry:Number(t.entry_price),exit:q.quote,units:Number(t.remaining_quantity),quoteToUsd:fx.rate});
  let autoExitAllowed=false;
  if(t.trade_origin==="MANUAL"){
   const {data:session,error:sessionError}=await db.from("demo_paper_sessions").select("broker,broker_account_ref")
    .eq("id",t.session_id).eq("user_id",a.user.id).maybeSingle();
   if(sessionError)return res.status(503).json({error:"Could not verify the DEMO account scope."});
   if(session?.broker==="DERIV"){
    const {data:permission,error:permissionError}=await db.from("portfolio_trade_permissions")
     .select("auto_exit_manual_brackets").eq("user_id",a.user.id).eq("account_mode","DEMO")
     .eq("broker","DERIV").eq("broker_account_ref",session.broker_account_ref).maybeSingle();
    if(permissionError)return res.status(503).json({error:"Could not verify manual auto-exit permission."});
    autoExitAllowed=permission?.auto_exit_manual_brackets===true;
   }
  }
  if(t.trade_origin==="MANUAL"&&autoExitAllowed){
   const stopHit=t.side==="BUY"?q.quote<=Number(t.stop_loss):q.quote>=Number(t.stop_loss);
   let stage=stopHit?"STOP_LOSS":null;
   if(!stage){
    const done=[t.tp1_done===true,t.tp2_done===true,t.tp3_done===true];
    const prices=[Number(t.tp1_price),Number(t.tp2_price),Number(t.tp3_price)];
    const names=["TP1","TP2","TP3"];
    for(let i=0;i<3;i++){
     if(done[i])continue;
     if(i>0&&!done[i-1])break;
     const reached=t.side==="BUY"?q.quote>=prices[i]:q.quote<=prices[i];
     if(reached){stage=names[i];break;}
     break;
    }
   }
   if(stage){
    const {data:exit,error:exitError}=await db.rpc("manage_demo_manual_partial_exit",{
     p_user_id:a.user.id,p_trade_id:t.id,p_stage:stage,p_exit_price:q.quote,
     p_quote_to_usd:fx.rate,p_quote_source:q.source,p_quote_as_of:q.quoteAsOf
    });
    if(exitError||!exit?.ok)return res.status(503).json({error:"The manual DEMO exit level was reached but the virtual partial exit could not be committed safely."});
    return res.status(200).json({ok:true,closed:exit.closed,partialExit:true,stage,closedUnits:exit.closed_units,
     remainingUnits:exit.remaining_units,realizedPnl:exit.realized_pnl_this_stage,balance:exit.balance,
     trade:{id:exit.trade_id,status:exit.closed?"CLOSED":"OPEN"},quote:{source:q.source,asOf:q.quoteAsOf,instrument:q.providerSymbol},
     message:stage==="STOP_LOSS"?"DEMO stop-loss reached. The remaining virtual position was closed.":stage+" reached. Its configured percentage of the original virtual position was closed."});
   }
  }
  const {data:ok,error}=await db.rpc("mark_demo_paper_trade",{p_user_id:a.user.id,p_trade_id:t.id,p_price:q.quote,p_quote_as_of:q.quoteAsOf});
  if(error||!ok)return res.status(503).json({error:"Could not save the verified DEMO price mark."});
  return res.status(200).json({ok:true,closed:false,currentPrice:q.quote,currentUnrealizedPnl:pnl,quote:{source:q.source,asOf:q.quoteAsOf,instrument:q.providerSymbol},protection:{active:false,scope:"PORTFOLIO",reason:"AWAITING_PORTFOLIO_MONITOR"},message:"DEMO mark saved. Portfolio-level profit protection is separate; this endpoint does not close positions."});
 }catch(e){console.error("DEMO mark:",e.message);return res.status(500).json({error:"Could not mark DEMO paper position."});}
}
