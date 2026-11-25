import { createClient } from "@supabase/supabase-js";
import { darajaBaseUrl, createNairobiTimestamp, buildStkPassword, normalizeKenyanPhone } from "../../../lib/mpesa.js";
import { createLicenseKey, hashLicenseKey, encryptLicenseKey, deliverPendingBotLicenseEmails } from "../../../lib/standalone-bot-licenses.js";

async function getDarajaToken(){
 const key=process.env.DARAJA_CONSUMER_KEY,secret=process.env.DARAJA_CONSUMER_SECRET;
 if(!key||!secret)throw new Error("Daraja credentials missing");
 const base=darajaBaseUrl(process.env.DARAJA_ENV);
 const response=await fetch(base+"/oauth/v1/generate?grant_type=client_credentials",{headers:{Authorization:"Basic "+Buffer.from(key+":"+secret).toString("base64")},signal:AbortSignal.timeout(12000)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok||!data.access_token)throw new Error("Daraja OAuth failed");
 return {base,token:data.access_token};
}
function metadataItems(callback){
 const items=callback?.CallbackMetadata?.Item;
 return Array.isArray(items)?Object.fromEntries(items.map(x=>[x.Name,x.Value])):{};
}
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({ResultCode:1,ResultDesc:"Method not allowed"});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,DARAJA_SHORTCODE,DARAJA_PASSKEY,BOT_LICENSE_ENCRYPTION_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY||!DARAJA_SHORTCODE||!DARAJA_PASSKEY||!BOT_LICENSE_ENCRYPTION_KEY)
  return res.status(503).json({ResultCode:1,ResultDesc:"Payment callback is not configured"});
 try{
  const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  const callback=body?.Body?.stkCallback,checkoutId=String(callback?.CheckoutRequestID||"");
  if(!checkoutId)return res.status(200).json({ResultCode:0,ResultDesc:"Callback acknowledged"});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:order,error:orderError}=await db.from("bot_license_orders")
   .select("id,product_code,amount_kes,customer_phone,payment_phone,status").eq("mpesa_checkout_request_id",checkoutId).maybeSingle();
  if(orderError)throw orderError;
  if(!order)return res.status(200).json({ResultCode:0,ResultDesc:"Unknown checkout acknowledged"});
  if(order.status==="FULFILLED")return res.status(200).json({ResultCode:0,ResultDesc:"Already fulfilled"});
  if(Number(callback.ResultCode)!==0){
   await db.from("bot_license_orders").update({status:"PAYMENT_FAILED",admin_note:String(callback.ResultDesc||"M-Pesa payment was not completed").slice(0,250)}).eq("id",order.id).in("status",["PENDING_PAYMENT","PAYMENT_PROCESSING"]);
   return res.status(200).json({ResultCode:0,ResultDesc:"Failed payment recorded"});
  }
  const meta=metadataItems(callback),amount=Number(meta.Amount),receipt=String(meta.MpesaReceiptNumber||"").trim();
  const paidPhone=normalizeKenyanPhone(meta.PhoneNumber),expectedPhone=normalizeKenyanPhone(order.payment_phone||order.customer_phone);
  if(!receipt||!Number.isFinite(amount)||amount!==Number(order.amount_kes)||!paidPhone||paidPhone!==expectedPhone){
   await db.from("bot_license_orders").update({status:"PAYMENT_REVIEW",admin_note:"Callback payment details did not match expected amount or phone; manual reconciliation required."}).eq("id",order.id);
   return res.status(200).json({ResultCode:0,ResultDesc:"Payment requires reconciliation"});
  }
  // Confirm the checkout directly with Daraja; never issue from a browser claim or callback alone.
  const {base,token}=await getDarajaToken(),timestamp=createNairobiTimestamp();
  const password=buildStkPassword(DARAJA_SHORTCODE,DARAJA_PASSKEY,timestamp);
  const verifyResponse=await fetch(base+"/mpesa/stkpushquery/v1/query",{method:"POST",
   headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
   body:JSON.stringify({BusinessShortCode:DARAJA_SHORTCODE,Password:password,Timestamp:timestamp,CheckoutRequestID:checkoutId}),
   signal:AbortSignal.timeout(15000)});
  const verification=await verifyResponse.json().catch(()=>({}));
  if(!verifyResponse.ok||String(verification.ResultCode)!=="0"){
   await db.from("bot_license_orders").update({status:"PAYMENT_REVIEW",admin_note:"Safaricom STK query did not confirm successful payment; awaiting reconciliation."}).eq("id",order.id).in("status",["PENDING_PAYMENT","PAYMENT_PROCESSING"]);
   return res.status(200).json({ResultCode:0,ResultDesc:"Payment verification pending"});
  }
  const key=createLicenseKey(),encrypted=encryptLicenseKey(key);
  const {data:fulfillment,error:fulfillError}=await db.rpc("fulfill_standalone_bot_order",{
   p_order_id:order.id,p_receipt:receipt,p_amount:amount,p_phone:paidPhone,
   p_license_key_hash:hashLicenseKey(key),p_encrypted_license_key:encrypted
  });
  if(fulfillError){
   console.error("Standalone bot payment fulfillment failed:",fulfillError.message);
   await db.from("bot_license_orders").update({status:"PAYMENT_REVIEW",admin_note:"Safaricom payment verified but automatic license fulfillment needs reconciliation."}).eq("id",order.id).neq("status","FULFILLED");
   return res.status(200).json({ResultCode:0,ResultDesc:"Payment verified; fulfillment queued for review"});
  }
  try{await deliverPendingBotLicenseEmails({orderId:order.id,limit:1});}
  catch(error){console.error("License email delivery deferred:",error.message);}
  return res.status(200).json({ResultCode:0,ResultDesc:fulfillment?.status==="FULFILLED"?"Payment verified and license issued":"Payment already fulfilled"});
 }catch(error){
  console.error("Standalone bot M-Pesa callback error:",error?.message||"unknown");
  return res.status(200).json({ResultCode:0,ResultDesc:"Callback acknowledged; payment may require reconciliation"});
 }
}
