import { createClient } from "@supabase/supabase-js";
import { decryptLicenseKey } from "./bot-license-crypto.js";

export async function deliverStandaloneBotLicense(orderId){
 const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:order,error}=await db.from("bot_license_orders").select("id,customer_name,customer_email,delivery_status,bot_licenses(license_key_ciphertext,license_type,expires_at,product_code)").eq("id",orderId).maybeSingle();
 if(error)throw error;if(!order)throw new Error("Order not found");
 if(order.delivery_status==="DELIVERED")return {delivered:true,alreadyDelivered:true};
 const lic=Array.isArray(order.bot_licenses)?order.bot_licenses[0]:order.bot_licenses;
 if(!lic?.license_key_ciphertext)throw new Error("Encrypted license key is unavailable");
 const apiKey=process.env.RESEND_API_KEY,from=process.env.TRADERWIN_FROM_EMAIL;
 if(!apiKey||!from)throw new Error("Email delivery is not configured");
 const key=decryptLicenseKey(lic.license_key_ciphertext);
 const expiry=lic.expires_at?new Date(lic.expires_at).toLocaleDateString("en-KE",{timeZone:"Africa/Nairobi"}):"Lifetime (no expiry)";
 const html=`<div style="font-family:Arial,sans-serif;color:#172033;max-width:600px;margin:auto"><h1 style="color:#a97913">Traderwin</h1><h2>Your bot license is ready</h2><p>Hello ${String(order.customer_name).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))},</p><p>Your payment has been confirmed and your standalone bot license has been issued.</p><p><b>Product:</b> ${lic.product_code}<br><b>License type:</b> ${lic.license_type}<br><b>Access:</b> ${expiry}</p><div style="padding:18px;background:#f3f5f8;border-radius:8px;font-size:20px;font-weight:bold;letter-spacing:1px">${key}</div><p>Keep this key private. Install the Traderwin Expert Advisor in MetaTrader 5 and activate it using this key. The license is linked to the MT5 account and broker server used at first activation.</p><p>Test on a broker demo account first. Trading bots do not guarantee profits.</p><p>Traderwin Support</p></div>`;
 const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+apiKey,"Content-Type":"application/json"},body:JSON.stringify({from,to:[order.customer_email],subject:"Your Traderwin bot license",html}),signal:AbortSignal.timeout(12000)});
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(result.message||"Email provider rejected delivery");
 const {error:updateError}=await db.from("bot_license_orders").update({delivery_status:"DELIVERED",delivery_attempts:(Number(order.delivery_attempts)||0)+1,last_delivery_error:null}).eq("id",order.id);
 if(updateError)throw updateError;
 return {delivered:true};
}
