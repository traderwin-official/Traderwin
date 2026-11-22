import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="GET"){res.setHeader("Allow","GET");return res.status(405).json({error:"Method not allowed. Automatic Daraja callbacks fulfill paid orders."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,TRADERWIN_LICENSE_ADMIN_TOKEN}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY||!TRADERWIN_LICENSE_ADMIN_TOKEN)return res.status(503).json({error:"Private sales administration is not configured."});
 const supplied=String(req.headers["x-traderwin-admin-token"]||"");
 const a=Buffer.from(supplied),b=Buffer.from(TRADERWIN_LICENSE_ADMIN_TOKEN);
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:"Admin authorization failed."});
 try{
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await db.from("bot_license_orders").select("id,product_code,customer_name,customer_email,customer_phone,amount_kes,status,payment_reference,mpesa_receipt_number,created_at").order("created_at",{ascending:false}).limit(100);
  if(error)throw error;
  const ids=(data||[]).map(x=>x.id);
  let deliveries=[];
  if(ids.length){const {data:d,error:de}=await db.from("bot_license_delivery_outbox").select("order_id,status,attempts,last_error,next_attempt_at,sent_at").in("order_id",ids);if(de)throw de;deliveries=d||[];}
  return res.status(200).json({orders:data||[],deliveries});
 }catch(error){console.error("Bot sales admin list failed:",error.message);return res.status(503).json({error:"Could not load sales records."});}
}
