import { createClient } from "@supabase/supabase-js";

export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"DEMO portfolio permissions are not configured."});
 const authorization=req.headers.authorization||"";
 if(!authorization.startsWith("Bearer "))return res.status(401).json({error:"Sign in is required."});
 try{
  const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  const action=String(body.action||"").toUpperCase();
  if(!["STATUS","UPDATE"].includes(action))return res.status(400).json({error:"Choose STATUS or UPDATE."});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await db.auth.getUser(authorization.slice(7).trim());
  if(authError||!auth.user)return res.status(401).json({error:"Your login session is invalid."});
  const userId=auth.user.id,accountRef="DEMO:"+userId;
  const {data:profile,error:profileError}=await db.from("trader_profiles")
    .select("account_mode").eq("user_id",userId).maybeSingle();
  if(profileError||!profile)return res.status(409).json({error:"Complete your account setup first."});
  if(profile.account_mode!=="DEMO")return res.status(403).json({error:"Manual portfolio controls are DEMO-only."});
  const {data:session,error:sessionError}=await db.from("demo_paper_sessions")
    .select("id").eq("user_id",userId).eq("broker","DERIV").eq("broker_account_ref",accountRef)
    .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(sessionError)return res.status(503).json({error:"Could not verify your DEMO account."});
  if(!session)return res.status(409).json({error:"Start a DEMO session before changing portfolio permissions."});
  if(action==="STATUS"){
   const {data:permission,error}=await db.from("portfolio_trade_permissions")
    .select("manual_trade_management,close_manual_trades")
    .eq("user_id",userId).eq("account_mode","DEMO").eq("broker","DERIV").eq("broker_account_ref",accountRef).maybeSingle();
   if(error)return res.status(503).json({error:"Could not load your portfolio permissions."});
   return res.status(200).json({ok:true,manualTradeManagement:permission?.manual_trade_management===true,
    closeManualTrades:permission?.close_manual_trades===true,botTradeManagement:true,closeManagedPositions:true});
  }
  if(typeof body.monitorManualTrades!=="boolean"||typeof body.closeManualTrades!=="boolean")
   return res.status(400).json({error:"Choose both manual monitoring and manual close permissions."});
  if(body.closeManualTrades&&!body.monitorManualTrades)
   return res.status(400).json({error:"Manual closing requires manual positions to be included in portfolio monitoring."});
  const now=new Date().toISOString();
  const {error:saveError}=await db.from("portfolio_trade_permissions").upsert({
   user_id:userId,account_mode:"DEMO",broker:"DERIV",broker_account_ref:accountRef,
   manual_trade_management:body.monitorManualTrades,bot_trade_management:true,
   close_managed_positions:true,close_manual_trades:body.closeManualTrades,
   permission_granted_at:body.monitorManualTrades?now:null,
   permission_revoked_at:!body.monitorManualTrades&&!body.closeManualTrades?now:null,updated_at:now
  },{onConflict:"user_id,account_mode,broker,broker_account_ref"});
  if(saveError){console.error("DEMO portfolio permission save:",saveError.message);return res.status(503).json({error:"Could not save your portfolio permissions."});}
  return res.status(200).json({ok:true,manualTradeManagement:body.monitorManualTrades,
   closeManualTrades:body.closeManualTrades,botTradeManagement:true,closeManagedPositions:true,
   message:"Your DEMO portfolio permissions have been saved."});
 }catch(error){console.error("DEMO portfolio permissions:",error.message);return res.status(500).json({error:"Could not update DEMO portfolio permissions safely."});}
}
