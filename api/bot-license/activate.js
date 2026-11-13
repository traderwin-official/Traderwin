import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const noStore=res=>{res.setHeader("Cache-Control","no-store");res.setHeader("Pragma","no-cache");};
const hashKey=key=>crypto.createHash("sha256").update(key).digest("hex");
const validLogin=v=>/^\d{4,20}$/.test(String(v||""));
export default async function handler(req,res) {
  noStore(res);
  if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
  const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
  if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"License verification is not configured."});
  try{
    const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
    const key=String(body.licenseKey||"").trim().toUpperCase();
    const mt5Login=String(body.mt5Login||"").trim();
    const mt5Server=String(body.mt5Server||"").trim().slice(0,100);
    const action=String(body.action||"ACTIVATE").toUpperCase();
    if(!/^TW-(?:[A-Z0-9]{4}-){5}[A-Z0-9]{4}$/.test(key)||!validLogin(mt5Login)||mt5Server.length<2||!["ACTIVATE","VERIFY"].includes(action)){
      return res.status(400).json({valid:false,error:"Provide a valid Traderwin license key, MT5 account number, broker server and action."});
    }
    const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:license,error}=await db.from("bot_licenses").select("id,product_code,license_type,status,expires_at,bound_mt5_login,bound_mt5_server,activated_at").eq("license_key_hash",hashKey(key)).maybeSingle();
    if(error)throw error;
    if(!license||license.status!=="ACTIVE")return res.status(403).json({valid:false,error:"License not found or not active. Contact Traderwin support."});
    if(license.expires_at&&new Date(license.expires_at).getTime()<=Date.now()){
      await db.from("bot_licenses").update({status:"EXPIRED"}).eq("id",license.id);
      return res.status(403).json({valid:false,error:"This license has expired."});
    }
    if(license.bound_mt5_login&&(license.bound_mt5_login!==mt5Login||license.bound_mt5_server!==mt5Server)){
      return res.status(403).json({valid:false,error:"This license is already bound to a different MT5 account. Request a license transfer from Traderwin."});
    }
    if(action==="ACTIVATE"&&!license.bound_mt5_login){
      const {data:updated,error:updateError}=await db.from("bot_licenses").update({bound_mt5_login:mt5Login,bound_mt5_server:mt5Server,activated_at:new Date().toISOString(),last_verified_at:new Date().toISOString()}).eq("id",license.id).is("bound_mt5_login",null).select("id").maybeSingle();
      if(updateError)throw updateError;
      if(!updated)return res.status(409).json({valid:false,error:"License activation changed during this request. Please verify again."});
    }else{
      const {error:updateError}=await db.from("bot_licenses").update({last_verified_at:new Date().toISOString()}).eq("id",license.id);
      if(updateError)throw updateError;
    }
    return res.status(200).json({valid:true,productCode:license.product_code,licenseType:license.license_type,expiresAt:license.expires_at||null,accountBound:true,message:"License verified. This check does not connect to MT5 or place trades."});
  }catch(error){
    console.error("License verification error:",error?.message||"unknown");
    return res.status(503).json({valid:false,error:"License verification is temporarily unavailable."});
  }
}
