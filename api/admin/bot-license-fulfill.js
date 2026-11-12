import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const noStore=res=>{res.setHeader("Cache-Control","no-store");res.setHeader("Pragma","no-cache");};
const makeKey=()=>{const part=()=>crypto.randomBytes(3).toString("hex").toUpperCase();return "TW-"+part()+"-"+part()+"-"+part()+"-"+part();};
export default async function handler(req,res){
 noStore(res);
 if(!["GET","POST"].includes(req.method)){res.setHeader("Allow","GET, POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,TRADERWIN_LICENSE_ADMIN_TOKEN}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY||!TRADERWIN_LICENSE_ADMIN_TOKEN)return res.status(503).json({error:"Private license fulfillment is not configured."});
 const supplied=String(req.headers["x-traderwin-admin-token"]||"");
 const a=Buffer.from(supplied),b=Buffer.from(TRADERWIN_LICENSE_ADMIN_TOKEN);
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:"Admin authorization failed."});
 try{
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  if(req.method==="GET"){
   const {data,error}=await db.from("bot_license_orders").select("id,product_code,customer_name,customer_email,customer_phone,mt5_login,mt5_server,amount_kes,status,payment_reference,created_at").in("status",["PENDING_PAYMENT","PAYMENT_REVIEW","PAID","FULFILLED"]).order("created_at",{ascending:false}).limit(100);
   if(error)throw error;
   return res.status(200).json({orders:data||[]});
  }
  const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  const orderId=String(body.orderId||"").trim();
  const paymentReference=String(body.paymentReference||"").trim().slice(0,80);
  if(!/^[0-9a-f-]{36}$/i.test(orderId)||paymentReference.length<4)return res.status(400).json({error:"A valid order ID and confirmed M-Pesa transaction reference are required."});
  const {data:order,error:orderError}=await db.from("bot_license_orders").select("id,product_code,status,amount_kes,customer_email").eq("id",orderId).maybeSingle();
  if(orderError)throw orderError;
  if(!order)return res.status(404).json({error:"Order not found."});
  if(["PAID","FULFILLED"].includes(order.status)){
    const {data:existing,error:existingError}=await db.from("bot_licenses").select("id,status,license_type,expires_at").eq("order_id",order.id).maybeSingle();
    if(existingError)throw existingError;
    return res.status(200).json({ok:true,alreadyIssued:true,license:existing||null,message:"This order has already been paid. Do not issue a second license."});
  }
  if(order.status!=="PENDING_PAYMENT"&&order.status!=="PAYMENT_REVIEW")return res.status(409).json({error:"This order cannot be fulfilled in its current state."});
  const {data:product,error:productError}=await db.from("bot_products").select("license_type,active").eq("product_code",order.product_code).single();
  if(productError||!product?.active)return res.status(409).json({error:"The product is no longer active."});
  const licenseKey=makeKey(),expiresAt=product.license_type==="MONTHLY"?new Date(Date.now()+30*24*60*60*1000).toISOString():null;
  const {data:paid,error:paidError}=await db.from("bot_license_orders").update({status:"PAID",payment_reference:paymentReference,paid_at:new Date().toISOString()}).eq("id",order.id).in("status",["PENDING_PAYMENT","PAYMENT_REVIEW"]).select("id").maybeSingle();
  if(paidError)throw paidError;
  if(!paid)return res.status(409).json({error:"Order status changed. Refresh before retrying."});
  const {data:license,error:licenseError}=await db.from("bot_licenses").insert({
    order_id:order.id,product_code:order.product_code,license_key_hash:crypto.createHash("sha256").update(licenseKey).digest("hex"),
    license_type:product.license_type,expires_at:expiresAt
  }).select("id,status,license_type,expires_at").single();
  if(licenseError){
    await db.from("bot_license_orders").update({status:"PAYMENT_REVIEW",admin_note:"Payment confirmed; license issuance requires retry."}).eq("id",order.id);
    throw licenseError;
  }
  await db.from("bot_license_orders").update({status:"FULFILLED",fulfilled_at:new Date().toISOString()}).eq("id",order.id);
  return res.status(200).json({ok:true,license,licenseKey,customerEmail:order.customer_email,delivery:"Copy the key securely and send it to the customer. The full key is not stored by Traderwin and cannot be retrieved later."});
 }catch(error){
  console.error("Bot license fulfillment failed:",error?.message||"unknown");
  return res.status(503).json({error:"Could not complete license fulfillment. Check the order before retrying."});
 }
}
