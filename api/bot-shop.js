import { createClient } from "@supabase/supabase-js";

const noStore=res=>{res.setHeader("Cache-Control","no-store");res.setHeader("Pragma","no-cache");};
const clean=(v,n=160)=>String(v??"").trim().slice(0,n);
const emailOk=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
function normalizePhone(value){
 const digits=String(value||"").replace(/[^0-9]/g,"");
 if(/^0[17]\d{8}$/.test(digits))return "254"+digits.slice(1);
 if(/^254[17]\d{8}$/.test(digits))return digits;
 if(/^[17]\d{8}$/.test(digits))return "254"+digits;
 return null;
}
function eatTimestamp(){
 const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Nairobi",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
 const v=Object.fromEntries(parts.map(p=>[p.type,p.value]));
 return v.year+v.month+v.day+v.hour+v.minute+v.second;
}
async function darajaToken(){
 const base=process.env.DARAJA_ENV==="production"?"https://api.safaricom.co.ke":"https://sandbox.safaricom.co.ke";
 const key=process.env.DARAJA_CONSUMER_KEY,secret=process.env.DARAJA_CONSUMER_SECRET;
 if(!key||!secret)throw new Error("Daraja credentials are missing");
 const auth=Buffer.from(key+":"+secret).toString("base64");
 const r=await fetch(base+"/oauth/v1/generate?grant_type=client_credentials",{headers:{Authorization:"Basic "+auth},signal:AbortSignal.timeout(12000)});
 const d=await r.json();if(!r.ok||!d.access_token)throw new Error("Daraja OAuth failed");
 return {base,token:d.access_token};
}
export default async function handler(req,res){
 noStore(res);
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Bot shop is not configured yet."});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 try{
  if(req.method==="GET"){
   const {data,error}=await db.from("bot_products").select("product_code,product_name,broker,license_type,price_kes,currency,description").eq("active",true).not("price_kes","is",null).order("broker").order("price_kes");
   if(error)throw error;
   return res.status(200).json({products:data||[],checkoutMode:"MPESA_STK_PUSH",message:"Standalone purchases do not require a Traderwin member account."});
  }
  if(req.method!=="POST"){res.setHeader("Allow","GET, POST");return res.status(405).json({error:"Method not allowed."});}
  const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  const productCode=clean(body.productCode,50).toUpperCase(),name=clean(body.name,100),email=clean(body.email,180).toLowerCase();
  const phone=normalizePhone(body.phone),mt5Login=clean(body.mt5Login,40),mt5Server=clean(body.mt5Server,100);
  if(!/^[A-Z0-9_]{3,50}$/.test(productCode)||name.length<2||!emailOk(email)||!phone)return res.status(400).json({error:"Enter your name, valid email, Kenyan M-Pesa phone and choose a product."});
  const required=["DARAJA_CONSUMER_KEY","DARAJA_CONSUMER_SECRET","DARAJA_PASSKEY","DARAJA_SHORTCODE","DARAJA_CALLBACK_URL","BOT_LICENSE_ENCRYPTION_KEY"];
  const missing=required.filter(k=>!process.env[k]);
  if(missing.length)return res.status(503).json({error:"Automatic M-Pesa checkout is not configured yet."});
  if(!/^[a-fA-F0-9]{64}$/.test(process.env.BOT_LICENSE_ENCRYPTION_KEY))return res.status(503).json({error:"Secure license delivery is not configured yet."});
  if(!/^https:\/\//.test(process.env.DARAJA_CALLBACK_URL))return res.status(503).json({error:"The secure M-Pesa callback URL is not configured."});
  const {data:product,error:pe}=await db.from("bot_products").select("product_code,product_name,broker,license_type,price_kes,currency").eq("product_code",productCode).eq("active",true).not("price_kes","is",null).maybeSingle();
  if(pe)throw pe;if(!product)return res.status(404).json({error:"This bot is not available for purchase yet."});
  if(!Number.isInteger(Number(product.price_kes))||Number(product.price_kes)<1)return res.status(409).json({error:"This product price must be a whole number of KSh."});
  if(product.broker==="MT5"&&((mt5Login&&!/^\d{4,20}$/.test(mt5Login))||(mt5Server&&mt5Server.length<2)))return res.status(400).json({error:"Check the optional MT5 account number and broker server."});
  const {data:order,error:oe}=await db.from("bot_license_orders").insert({
   product_code:product.product_code,customer_name:name,customer_email:email,customer_phone:phone,
   mt5_login:mt5Login||null,mt5_server:mt5Server||null,amount_kes:Number(product.price_kes),status:"PENDING_PAYMENT",payment_phone:phone
  }).select("id,amount_kes,status,created_at").single();
  if(oe)throw oe;
  try{
   const {base,token}=await darajaToken(),timestamp=eatTimestamp(),shortcode=process.env.DARAJA_SHORTCODE,passkey=process.env.DARAJA_PASSKEY;
   const password=Buffer.from(shortcode+passkey+timestamp).toString("base64");
   const transactionType=process.env.DARAJA_TRANSACTION_TYPE==="CustomerBuyGoodsOnline"?"CustomerBuyGoodsOnline":"CustomerPayBillOnline";
   const payload={BusinessShortCode:shortcode,Password:password,Timestamp:timestamp,TransactionType:transactionType,Amount:Number(product.price_kes),PartyA:phone,PartyB:shortcode,PhoneNumber:phone,CallBackURL:process.env.DARAJA_CALLBACK_URL,AccountReference:"TW"+order.id.replace(/-/g,"").slice(0,10).toUpperCase(),TransactionDesc:"Traderwin "+product.product_code};
   const response=await fetch(base+"/mpesa/stkpush/v1/processrequest",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
   const result=await response.json();
   if(!response.ok||String(result.ResponseCode)!=="0"||!result.CheckoutRequestID)throw new Error(result.errorMessage||result.ResponseDescription||"STK push was not accepted");
   const {error:ue}=await db.from("bot_license_orders").update({status:"PAYMENT_PROCESSING",mpesa_checkout_request_id:result.CheckoutRequestID,mpesa_merchant_request_id:result.MerchantRequestID||null}).eq("id",order.id);
   if(ue)throw ue;
   return res.status(202).json({ok:true,orderId:order.id,status:"PAYMENT_PROCESSING",message:"M-Pesa prompt sent. Enter your M-Pesa PIN to complete payment. Your license will be emailed automatically after payment is confirmed."});
  }catch(paymentError){
   await db.from("bot_license_orders").update({status:"PAYMENT_REVIEW",admin_note:"STK initiation failed: "+String(paymentError.message||"unknown").slice(0,250)}).eq("id",order.id);
   console.error("Daraja STK initiation error:",paymentError?.message||"unknown");
   return res.status(502).json({error:"We could not send the M-Pesa prompt. No license has been issued. Please try again or contact Traderwin support."});
  }
 }catch(error){
  console.error("Bot shop checkout error:",error?.message||"unknown");
  return res.status(503).json({error:"The bot shop could not complete checkout. Please try again later."});
 }
}
