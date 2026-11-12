import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { encryptLicenseKey,hashLicenseKey,makeLicenseKey } from "../../lib/bot-license-crypto.js";
import { deliverStandaloneBotLicense } from "../../lib/bot-license-delivery.js";

const noStore=res=>{res.setHeader("Cache-Control","no-store");};
function itemsFromCallback(body){return body?.Body?.stkCallback?.CallbackMetadata?.Item||[];}
function valueOf(items,name){return items.find(x=>x.Name===name)?.Value??null;}
export default async function handler(req,res){
 noStore(res);
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
 if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Callback unavailable"});
 let checkoutId="";
 try{
  const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  const cb=body?.Body?.stkCallback;
  checkoutId=String(cb?.CheckoutRequestID||"");
  const resultCode=String(cb?.ResultCode??"");
  if(!checkoutId||!cb)return res.status(200).json({ResultCode:0,ResultDesc:"Callback acknowledged"});
  const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  if(resultCode!=="0"){
   await db.from("bot_license_orders").update({status:"CANCELLED",payment_result_code:resultCode,payment_result_desc:String(cb.ResultDesc||"Payment not completed").slice(0,250),payment_callback_received_at:new Date().toISOString()}).eq("mpesa_checkout_request_id",checkoutId).in("status",["PENDING_PAYMENT","PAYMENT_PROCESSING"]);
   return res.status(200).json({ResultCode:0,ResultDesc:"Payment outcome recorded"});
  }
  const items=itemsFromCallback(body),amount=Number(valueOf(items,"Amount")),receipt=String(valueOf(items,"MpesaReceiptNumber")||""),phone=String(valueOf(items,"PhoneNumber")||"");
  if(!Number.isFinite(amount)||amount<=0||!receipt||!/^2547\d{8}$/.test(phone)){
   await db.from("bot_license_orders").update({status:"PAYMENT_REVIEW",payment_result_code:resultCode,payment_result_desc:"Successful callback had incomplete payment metadata",payment_callback_received_at:new Date().toISOString()}).eq("mpesa_checkout_request_id",checkoutId);
   return res.status(200).json({ResultCode:0,ResultDesc:"Payment requires review"});
  }
  const key=makeLicenseKey(),ciphertext=encryptLicenseKey(key);
  const {data,error}=await db.rpc("finalize_standalone_bot_payment",{
   p_checkout_request_id:checkoutId,p_receipt:receipt,p_amount:amount,p_phone:phone,p_result_code:resultCode,
   p_result_desc:String(cb.ResultDesc||"Payment successful").slice(0,250),
   p_license_key_hash:hashLicenseKey(key),p_license_key_ciphertext:ciphertext
  });
  if(error)throw error;
  const row=Array.isArray(data)?data[0]:data;
  if(!row?.order_id)throw new Error("Payment finalization did not return an order");
  try{await deliverStandaloneBotLicense(row.order_id);}
  catch(deliveryError){
   console.error("Bot license email pending:",deliveryError?.message||"unknown");
   await db.from("bot_license_orders").update({delivery_status:"PENDING",last_delivery_error:String(deliveryError.message||"Email delivery failed").slice(0,250)}).eq("id",row.order_id);
  }
  return res.status(200).json({ResultCode:0,ResultDesc:"Payment verified and license fulfillment processed"});
 }catch(error){
  console.error("M-Pesa callback processing error:",error?.message||"unknown","checkout",checkoutId);
  if(checkoutId&&process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY){
   try{const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});await db.from("bot_license_orders").update({status:"PAYMENT_REVIEW",payment_result_desc:"Callback processing needs automatic reconciliation",payment_callback_received_at:new Date().toISOString()}).eq("mpesa_checkout_request_id",checkoutId).neq("status","FULFILLED");}catch{}
  }
  return res.status(200).json({ResultCode:0,ResultDesc:"Callback received; reconciliation required"});
 }
}
