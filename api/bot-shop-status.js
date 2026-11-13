import { createClient } from "@supabase/supabase-js";
import { deliverPendingBotLicenseEmails } from "../lib/standalone-bot-licenses.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="GET"){res.setHeader("Allow","GET");return res.status(405).json({error:"Method not allowed"});}
 const id=String(req.query?.orderId||"").trim();
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({error:"Invalid order reference"});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Status unavailable"});
 try{
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:order,error}=await db.from("bot_license_orders").select("status").eq("id",id).maybeSingle();
  if(error)throw error;if(!order)return res.status(404).json({error:"Order not found"});
  if(order.status==="FULFILLED"){try{await deliverPendingBotLicenseEmails({orderId:id,limit:1});}catch{}}
  const {data:delivery,error:deliveryError}=await db.from("bot_license_delivery_outbox").select("status").eq("order_id",id).maybeSingle();
  if(deliveryError)throw deliveryError;
  return res.status(200).json({status:order.status,paid:["PAID","FULFILLED"].includes(order.status),delivered:delivery?.status==="SENT"});
 }catch(error){console.error("Bot order status error:",error.message);return res.status(503).json({error:"Could not check order status"});}
}
