import { createClient } from "@supabase/supabase-js";
import { darajaBaseUrl, createNairobiTimestamp, buildStkPassword, normalizeKenyanPhone } from "../../../lib/mpesa.js";
import { createLicenseKey, hashLicenseKey, encryptLicenseKey, deliverPendingBotLicenseEmails } from "../../../lib/standalone-bot-licenses.js";

function metadataItems(callback){
 const items=callback?.CallbackMetadata?.Item;
 return Array.isArray(items)?Object.fromEntries(items.map(x=>[x.Name,x.Value])):{};
}
async function verifyDarajaCheckout(checkoutId){
 const {DARAJA_SHORTCODE,DARAJA_PASSKEY,DARAJA_CONSUMER_KEY,DARAJA_CONSUMER_SECRET}=process.env;
 if(!DARAJA_SHORTCODE||!DARAJA_PASSKEY||!DARAJA_CONSUMER_KEY||!DARAJA_CONSUMER_SECRET)throw new Error("Daraja credentials missing");
 const base=darajaBaseUrl(process.env.DARAJA_ENV);
 const auth=await fetch(base+"/oauth/v1/generate?grant_type=client_credentials",{
  headers:{Authorization:"Basic "+Buffer.from(DARAJA_CONSUMER_KEY+":"+DARAJA_CONSUMER_SECRET).toString("base64")},
  signal:AbortSignal.timeout(12000)
 });
 const tokenData=await auth.json().catch(()=>({}));
 if(!auth.ok||!tokenData.access_token)throw new Error("Daraja OAuth failed");
 const timestamp=createNairobiTimestamp(),password=buildStkPassword(DARAJA_SHORTCODE,DARAJA_PASSKEY,timestamp);
 const response=await fetch(base+"/mpesa/stkpushquery/v1/query",{
  method:"POST",headers:{Authorization:"Bearer "+tokenData.access_token,"Content-Type":"application/json"},
  body:JSON.stringify({BusinessShortCode:DARAJA_SHORTCODE,Password:password,Timestamp:timestamp,CheckoutRequestID:checkoutId}),
  signal:AbortSignal.timeout(15000)
 });
 const data=await response.json().catch(()=>({}));
 return response.ok&&String(data.ResultCode)==="0";
}
async function processStandaloneBot(db,order,receipt,amount,paidPhone){
 const key=createLicenseKey(),encrypted=encryptLicenseKey(key);
 const {data:fulfillment,error}=await db.rpc("fulfill_standalone_bot_order",{
  p_order_id:order.id,p_receipt:receipt,p_amount:amount,p_phone:paidPhone,
  p_license_key_hash:hashLicenseKey(key),p_encrypted_license_key:encrypted
 });
 if(error)throw error;
 try{await deliverPendingBotLicenseEmails({orderId:order.id,limit:1});}
 catch(e){console.error("Standalone bot license email deferred:",e.message);}
 return fulfillment?.status||"FULFILLED";
}
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({ResultCode:1,ResultDesc:"Method not allowed"});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,DARAJA_SHORTCODE,DARAJA_PASSKEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY||!DARAJA_SHORTCODE||!DARAJA_PASSKEY)
  return res.status(503).json({ResultCode:1,ResultDesc:"Payment callback is not configured"});
 try{
  const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  const callback=body?.Body?.stkCallback,checkoutId=String(callback?.CheckoutRequestID||"");
  if(!checkoutId)return res.status(200).json({ResultCode:0,ResultDesc:"Callback acknowledged"});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:botOrder,error:botError}=await db.from("bot_license_orders")
   .select("id,product_code,amount_kes,customer_phone,payment_phone,status")
   .eq("mpesa_checkout_request_id",checkoutId).maybeSingle();
  if(botError)throw botError;
  const {data:serviceOrder,error:serviceError}=botOrder?{data:null,error:null}:await db.from("payment_orders")
   .select("id,user_id,service_code,amount_kes,phone_number,status")
   .eq("checkout_request_id",checkoutId).maybeSingle();
  if(serviceError)throw serviceError;
  const order=botOrder||serviceOrder;
  if(!order)return res.status(200).json({ResultCode:0,ResultDesc:"Unknown checkout acknowledged"});
  if(order.status==="FULFILLED"||order.status==="PAID")return res.status(200).json({ResultCode:0,ResultDesc:"Already processed"});
  if(Number(callback.ResultCode)!==0){
   const table=botOrder?"bot_license_orders":"payment_orders";
   await db.from(table).update({status:botOrder?"PAYMENT_FAILED":"FAILED"}).eq("id",order.id).in("status",["PENDING","PENDING_PAYMENT","PAYMENT_PROCESSING","PAYMENT_REVIEW"]);
   return res.status(200).json({ResultCode:0,ResultDesc:"Failed payment recorded"});
  }
  const meta=metadataItems(callback),amount=Number(meta.Amount),receipt=String(meta.MpesaReceiptNumber||"").trim();
  const paidPhone=normalizeKenyanPhone(meta.PhoneNumber);
  const expectedPhone=normalizeKenyanPhone(botOrder?(order.payment_phone||order.customer_phone):order.phone_number);
  if(!receipt||!Number.isFinite(amount)||amount!==Number(order.amount_kes)||!paidPhone||paidPhone!==expectedPhone){
   const table=botOrder?"bot_license_orders":"payment_orders";
   await db.from(table).update({status:"PAYMENT_REVIEW"}).eq("id",order.id);
   return res.status(200).json({ResultCode:0,ResultDesc:"Payment requires reconciliation"});
  }
  const verified=await verifyDarajaCheckout(checkoutId);
  if(!verified){
   const table=botOrder?"bot_license_orders":"payment_orders";
   await db.from(table).update({status:"PAYMENT_REVIEW"}).eq("id",order.id);
   return res.status(200).json({ResultCode:0,ResultDesc:"Payment verification pending"});
  }
  if(botOrder){
   const result=await processStandaloneBot(db,order,receipt,amount,paidPhone);
   return res.status(200).json({ResultCode:0,ResultDesc:result==="FULFILLED"?"Standalone bot payment fulfilled":"Standalone bot payment already fulfilled"});
  }
  const {data:result,error:fulfillError}=await db.rpc("fulfill_traderwin_service_payment",{
   p_order_id:order.id,p_receipt:receipt,p_amount:amount,p_phone:paidPhone
  });
  if(fulfillError){
   console.error("Traderwin service payment fulfillment failed:",fulfillError.message);
   await db.from("payment_orders").update({status:"PAYMENT_REVIEW"}).eq("id",order.id).neq("status","PAID");
   return res.status(200).json({ResultCode:0,ResultDesc:"Payment verified; service activation needs reconciliation"});
  }
  return res.status(200).json({ResultCode:0,ResultDesc:result?.status==="PAID"?"Payment confirmed and service activated":"Payment already processed"});
 }catch(error){
  console.error("Unified Traderwin M-Pesa callback error:",error?.message||"unknown");
  return res.status(200).json({ResultCode:0,ResultDesc:"Callback acknowledged; payment may require reconciliation"});
 }
}
