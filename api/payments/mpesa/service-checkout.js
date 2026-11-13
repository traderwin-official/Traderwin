import { createClient } from "@supabase/supabase-js";

const noStore=res=>{res.setHeader("Cache-Control","no-store");res.setHeader("Pragma","no-cache");};
function normalizePhone(value){
 const d=String(value||"").replace(/\\D/g,"");
 if(/^0[17]\\d{8}$/.test(d))return "254"+d.slice(1);
 if(/^254[17]\\d{8}$/.test(d))return d;
 if(/^[17]\\d{8}$/.test(d))return "254"+d;
 return null;
}
function nairobiTimestamp(){
 const p=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Nairobi",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
 const v=Object.fromEntries(p.map(x=>[x.type,x.value]));
 return v.year+v.month+v.day+v.hour+v.minute+v.second;
}
async function darajaToken(){
 const base=process.env.DARAJA_ENV==="production"?"https://api.safaricom.co.ke":"https://sandbox.safaricom.co.ke";
 const key=process.env.DARAJA_CONSUMER_KEY,secret=process.env.DARAJA_CONSUMER_SECRET;
 if(!key||!secret)throw new Error("Daraja credentials missing");
 const r=await fetch(base+"/oauth/v1/generate?grant_type=client_credentials",{headers:{Authorization:"Basic "+Buffer.from(key+":"+secret).toString("base64")},signal:AbortSignal.timeout(12000)});
 const d=await r.json().catch(()=>({}));
 if(!r.ok||!d.access_token)throw new Error("Daraja authentication failed");
 return {base,token:d.access_token};
}
async function getUsdKesRate(){
 // Prefer a fresh public FX quote. A manually maintained server-side rate is fallback only.
 try{
  const r=await fetch("https://open.er-api.com/v6/latest/USD",{signal:AbortSignal.timeout(8000),cache:"no-store"});
  const d=await r.json();
  const rate=Number(d?.rates?.KES);
  const age=Date.parse(d?.time_last_update_utc||"");
  if(r.ok&&d?.result==="success"&&Number.isFinite(rate)&&rate>50&&rate<300&&Number.isFinite(age)&&Date.now()-age<72*60*60*1000)
   return {rate,source:"open.er-api.com",asOf:new Date(age).toISOString()};
 }catch{}
 const fallback=Number(process.env.USD_KES_RATE);
 if(Number.isFinite(fallback)&&fallback>50&&fallback<300)
  return {rate:fallback,source:"Vercel USD_KES_RATE fallback",asOf:new Date().toISOString()};
 throw new Error("A current USD/KES exchange rate is unavailable");
}
export default async function handler(req,res){
 noStore(res);
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,DARAJA_SHORTCODE,DARAJA_PASSKEY,DARAJA_CALLBACK_URL}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY||!DARAJA_SHORTCODE||!DARAJA_PASSKEY||!DARAJA_CALLBACK_URL)
  return res.status(503).json({error:"M-Pesa checkout is not configured."});
 const bearer=String(req.headers.authorization||"");
 if(!bearer.startsWith("Bearer "))return res.status(401).json({error:"Sign in to purchase this service."});
 try{
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await db.auth.getUser(bearer.slice(7).trim());
  if(authError||!auth.user)return res.status(401).json({error:"Your login session is invalid."});
  const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  const serviceCode=String(body.serviceCode||"").trim().toUpperCase();
  const phone=normalizePhone(body.phone);
  const allowed=new Set(["REAL_TRADING","ADVANCED_BOT","SIGNALS","EDUCATION"]);
  if(!allowed.has(serviceCode)||!phone)return res.status(400).json({error:"Choose a paid service and enter a valid Kenyan M-Pesa number."});
  const {data:service,error:serviceError}=await db.from("service_catalog")
   .select("service_code,service_name,description,price_kes,billing_period,price_usd,renewal_price_usd")
   .eq("service_code",serviceCode).eq("active",true).maybeSingle();
  if(serviceError)throw serviceError;
  if(!service)return res.status(404).json({error:"This service is not available for purchase."});
  let amountKes=Number(service.price_kes),amountUsd=null,fxRate=null,fxSource=null,fxAsOf=null,priceBasis="FIXED_KES";
  if(Number(service.price_usd)>0){
   const {data:prior,error:priorError}=await db.from("payment_orders").select("id")
    .eq("user_id",auth.user.id).eq("service_code",serviceCode).eq("status","PAID").limit(1);
   if(priorError)throw priorError;
   const renewal=(prior||[]).length>0;
   amountUsd=renewal?Number(service.renewal_price_usd||service.price_usd):Number(service.price_usd);
   const fx=await getUsdKesRate();fxRate=fx.rate;fxSource=fx.source;fxAsOf=fx.asOf;
   amountKes=Math.ceil(amountUsd*fxRate);
   priceBasis=renewal?"RENEWAL":"FIRST_MONTH";
  }
  if(!Number.isFinite(amountKes)||amountKes<1||!Number.isInteger(amountKes))
   return res.status(409).json({error:"This service has no valid M-Pesa price configured."});
  const {data:pending,error:pendingError}=await db.from("payment_orders").select("id")
   .eq("user_id",auth.user.id).eq("service_code",serviceCode).eq("status","PENDING").limit(1);
  if(pendingError)throw pendingError;
  if((pending||[]).length)return res.status(409).json({error:"You already have a pending payment for this service. Complete it or contact support before starting another."});
  const {data:order,error:orderError}=await db.from("payment_orders").insert({
   user_id:auth.user.id,service_code:serviceCode,amount_kes:amountKes,amount_usd:amountUsd,
   fx_rate_kes:fxRate,fx_source:fxSource,fx_as_of:fxAsOf,price_basis:priceBasis,
   currency:"KES",payment_method:"MPESA",phone_number:phone,status:"PENDING"
  }).select("id").single();
  if(orderError)throw orderError;
  try{
   const {base,token}=await darajaToken(),timestamp=nairobiTimestamp();
   const password=Buffer.from(String(DARAJA_SHORTCODE)+String(DARAJA_PASSKEY)+timestamp).toString("base64");
   const transactionType=process.env.DARAJA_TRANSACTION_TYPE==="CustomerBuyGoodsOnline"?"CustomerBuyGoodsOnline":"CustomerPayBillOnline";
   const payload={BusinessShortCode:DARAJA_SHORTCODE,Password:password,Timestamp:timestamp,TransactionType:transactionType,
    Amount:amountKes,PartyA:phone,PartyB:DARAJA_SHORTCODE,PhoneNumber:phone,CallBackURL:DARAJA_CALLBACK_URL,
    AccountReference:"TW"+order.id.replace(/-/g,"").slice(0,10).toUpperCase(),
    TransactionDesc:"Traderwin "+serviceCode};
   const response=await fetch(base+"/mpesa/stkpush/v1/processrequest",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
   const result=await response.json().catch(()=>({}));
   if(!response.ok||String(result.ResponseCode)!=="0"||!result.CheckoutRequestID)throw new Error(result.errorMessage||result.ResponseDescription||"STK push rejected");
   const {error:updateError}=await db.from("payment_orders").update({checkout_request_id:result.CheckoutRequestID}).eq("id",order.id);
   if(updateError)throw updateError;
   return res.status(202).json({ok:true,orderId:order.id,serviceCode,serviceName:service.service_name,amountKes,
    amountUsd,fxRate,priceBasis,status:"PENDING",message:"M-Pesa prompt sent. Your paid service activates only after Safaricom confirms payment."});
  }catch(e){
   await db.from("payment_orders").update({status:"PAYMENT_REVIEW"}).eq("id",order.id);
   console.error("Traderwin STK initiation failed:",e.message);
   return res.status(502).json({error:"We could not send the M-Pesa prompt. No service access has been granted."});
  }
 }catch(error){
  console.error("Traderwin M-Pesa checkout error:",error?.message||"unknown");
  return res.status(503).json({error:"Checkout could not be completed. Please try again later."});
 }
}
