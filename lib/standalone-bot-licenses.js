import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function encryptionKey(){
 const value=process.env.BOT_LICENSE_ENCRYPTION_KEY||"";
 if(!/^[a-fA-F0-9]{64}$/.test(value))throw new Error("BOT_LICENSE_ENCRYPTION_KEY must be 64 hexadecimal characters");
 return Buffer.from(value,"hex");
}
export function createLicenseKey(){
 const groups=Array.from({length:6},()=>crypto.randomBytes(2).toString("hex").toUpperCase());
 return "TW-"+groups.join("-");
}
export function hashLicenseKey(key){
 return crypto.createHash("sha256").update(key).digest("hex");
}
export function encryptLicenseKey(key){
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",encryptionKey(),iv);
 const encrypted=Buffer.concat([cipher.update(key,"utf8"),cipher.final()]);
 return [iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),encrypted.toString("base64url")].join(".");
}
function decryptLicenseKey(payload){
 const [iv,tag,data]=String(payload).split(".");
 if(!iv||!tag||!data)throw new Error("Invalid encrypted license payload");
 const decipher=crypto.createDecipheriv("aes-256-gcm",encryptionKey(),Buffer.from(iv,"base64url"));
 decipher.setAuthTag(Buffer.from(tag,"base64url"));
 return Buffer.concat([decipher.update(Buffer.from(data,"base64url")),decipher.final()]).toString("utf8");
}
export async function deliverPendingBotLicenseEmails({orderId=null,limit=10}={}){
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,RESEND_API_KEY,BOT_LICENSE_FROM_EMAIL}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY||!RESEND_API_KEY||!BOT_LICENSE_FROM_EMAIL)
   return {sent:0,pending:true,reason:"Email delivery credentials are not configured"};
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 let query=db.from("bot_license_delivery_outbox").select("id,order_id,recipient_email,encrypted_license_key,attempts")
   .eq("status","PENDING").lte("next_attempt_at",new Date().toISOString()).order("created_at").limit(Math.min(Math.max(limit,1),25));
 if(orderId)query=query.eq("order_id",orderId);
 const {data:rows,error}=await query;
 if(error)throw error;
 let sent=0;
 for(const row of rows||[]){
  const {data:claimed,error:claimError}=await db.from("bot_license_delivery_outbox").update({status:"SENDING",attempts:Number(row.attempts||0)+1}).eq("id",row.id).eq("status","PENDING").select("id").maybeSingle();
  if(claimError)throw claimError;
  if(!claimed)continue;
  try{
   const licenseKey=decryptLicenseKey(row.encrypted_license_key);
   const {data:order,error:orderError}=await db.from("bot_license_orders").select("customer_name,product_code").eq("id",row.order_id).single();
   if(orderError)throw orderError;
   const {data:product,error:productError}=await db.from("bot_products").select("product_name,license_type").eq("product_code",order.product_code).single();
   if(productError)throw productError;
   const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+RESEND_API_KEY,"Content-Type":"application/json"},
    body:JSON.stringify({from:BOT_LICENSE_FROM_EMAIL,to:[row.recipient_email],subject:"Your "+product.product_name+" license",
     text:"Hello "+order.customer_name+",\n\nYour payment has been confirmed. Your "+product.product_name+" license is ready.\n\nLicense key: "+licenseKey+"\nLicense type: "+product.license_type+"\n\nKeep this key private. Install the Traderwin Expert Advisor in MetaTrader 5 and follow the included activation instructions. Traderwin will never ask for your MT5 master password.\n\nTrading involves risk. Test on a demo account first.\n\nTraderwin Support",
     html:"<p>Hello "+String(order.customer_name).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))+",</p><p>Your payment has been confirmed. Your <strong>"+String(product.product_name).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))+"</strong> license is ready.</p><p>License key: <strong style='font-size:18px'>"+licenseKey+"</strong></p><p>License type: "+product.license_type+"</p><p>Keep this key private. Install the Traderwin Expert Advisor in MetaTrader 5 and follow the activation instructions. Traderwin will never ask for your MT5 master password.</p><p>Trading involves risk. Test on a demo account first.</p><p>Traderwin Support</p>"})});
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.message||"Email provider rejected the message");
   const {error:updateError}=await db.from("bot_license_delivery_outbox").update({status:"SENT",sent_at:new Date().toISOString(),encrypted_license_key:"DELIVERED",last_error:null}).eq("id",row.id).eq("status","SENDING");
   if(updateError)throw updateError;
   sent++;
  }catch(error){
   const attempts=Number(row.attempts||0)+1;
   const delay=Math.min(60,Math.pow(2,Math.min(attempts,6)));
   await db.from("bot_license_delivery_outbox").update({status:"PENDING",attempts,next_attempt_at:new Date(Date.now()+delay*60000).toISOString(),last_error:String(error.message||"Delivery failed").slice(0,240)}).eq("id",row.id).eq("status","SENDING");
  }
 }
 return {sent,checked:(rows||[]).length};
}
