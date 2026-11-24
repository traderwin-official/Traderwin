import { createClient } from "@supabase/supabase-js";

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  res.setHeader("Pragma","no-cache");
  if(req.method!=="GET"){res.setHeader("Allow","GET");return res.status(405).json({error:"Method not allowed."});}
  const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
  if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"DEMO history service is not configured."});
  const authorization=req.headers.authorization||"";
  if(!authorization.startsWith("Bearer "))return res.status(401).json({error:"Sign in is required."});
  try{
    const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:authData,error:authError}=await db.auth.getUser(authorization.slice(7).trim());
    if(authError||!authData.user)return res.status(401).json({error:"Your login session is invalid."});
    const userId=authData.user.id;
    const [{data:sessions,error:sessionError},{data:trades,error:tradeError},{data:balance,error:balanceError}]=await Promise.all([
      db.from("demo_paper_sessions").select("id,instrument,strategy,timeframe,status,starting_balance,current_balance,started_at,stopped_at,created_at").eq("user_id",userId).order("created_at",{ascending:false}).limit(500),
      db.from("demo_paper_trades").select("id,session_id,instrument,side,entry_price,last_mark_price,stop_loss,take_profit,quantity,remaining_quantity,risk_amount_usd,trade_origin,status,realized_pnl_usd,opened_at,closed_at,quote_source,quote_as_of").eq("user_id",userId).order("opened_at",{ascending:false}).limit(500),
      db.rpc("get_demo_paper_account_balance",{p_user_id:userId})
    ]);
    if(sessionError||tradeError){console.error("DEMO history lookup failed:",sessionError?.message||tradeError?.message);return res.status(503).json({error:"Could not load your DEMO trade history."});}
    if(balanceError){console.error("DEMO account balance lookup failed:",balanceError.message);return res.status(503).json({error:"Account balance upgrade is required before history can be displayed."});}
    const sessionMap=new Map((sessions||[]).map(s=>[s.id,s]));
    const history=(trades||[]).map(t=>({...t,session_status:sessionMap.get(t.session_id)?.status||null,session_started_at:sessionMap.get(t.session_id)?.started_at||sessionMap.get(t.session_id)?.created_at||null}));
    const realizedPnl=history.reduce((sum,t)=>sum+Number(t.realized_pnl_usd||0),0);
    return res.status(200).json({mode:"DEMO",paperOnly:true,startingBalance:10000,accountBalance:Number(balance),realizedPnl:Number(realizedPnl.toFixed(2)),sessions:sessions||[],trades:history});
  }catch(error){
    console.error("DEMO history error:",error?.message||"unknown");
    return res.status(500).json({error:"Could not load DEMO history safely."});
  }
}
