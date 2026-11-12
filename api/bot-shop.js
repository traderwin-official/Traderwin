import { createClient } from "@supabase/supabase-js";

const noStore = res => { res.setHeader("Cache-Control","no-store"); res.setHeader("Pragma","no-cache"); };
const clean = (v,n=160) => String(v ?? "").trim().slice(0,n);
const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const phoneOk = v => /^(?:\+?254|0)7\d{8}$/.test(v.replace(/[\s-]/g,""));

export default async function handler(req,res) {
  noStore(res);
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({error:"Bot shop is not configured yet."});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  try {
    if (req.method==="GET") {
      const {data,error}=await db.from("bot_products").select("product_code,product_name,broker,license_type,price_kes,currency,description").eq("active",true).not("price_kes","is",null).order("broker").order("price_kes");
      if(error) throw error;
      return res.status(200).json({products:data||[],checkoutMode:"MANUAL_MPESA",message:"Standalone purchases do not require a Traderwin member account."});
    }
    if (req.method!=="POST") { res.setHeader("Allow","GET, POST"); return res.status(405).json({error:"Method not allowed."}); }
    const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
    const productCode=clean(body.productCode,50).toUpperCase();
    const name=clean(body.name,100), email=clean(body.email,180).toLowerCase();
    const phone=clean(body.phone,24);
    const mt5Login=clean(body.mt5Login,40), mt5Server=clean(body.mt5Server,100);
    if(!/^[A-Z0-9_]{3,50}$/.test(productCode)||name.length<2||!emailOk(email)||!phoneOk(phone)) {
      return res.status(400).json({error:"Enter your name, valid email, Kenyan M-Pesa phone and choose a product."});
    }
    const {data:product,error:productError}=await db.from("bot_products").select("product_code,product_name,broker,license_type,price_kes,currency").eq("product_code",productCode).eq("active",true).not("price_kes","is",null).maybeSingle();
    if(productError) throw productError;
    if(!product) return res.status(404).json({error:"This bot is not available for purchase yet."});
    if(product.broker==="MT5" && ((mt5Login && !/^\d{4,20}$/.test(mt5Login)) || (mt5Server && mt5Server.length<2))) {
      return res.status(400).json({error:"Check the optional MT5 account number and broker server."});
    }
    const {data:order,error}=await db.from("bot_license_orders").insert({
      product_code:product.product_code,customer_name:name,customer_email:email,customer_phone:phone,
      mt5_login:mt5Login||null,mt5_server:mt5Server||null,amount_kes:product.price_kes,status:"PENDING_PAYMENT"
    }).select("id,amount_kes,status,created_at").single();
    if(error) throw error;
    return res.status(201).json({
      ok:true,order,
      paymentInstructions:{
        method:"M-Pesa manual payment",
        paybill:process.env.TRADERWIN_MPESA_PAYBILL||null,
        till:process.env.TRADERWIN_MPESA_TILL||null,
        accountReference:order.id.slice(0,8).toUpperCase(),
        accountName:process.env.TRADERWIN_MPESA_ACCOUNT_NAME||"Traderwin",
        note:"Pay only to the official details shown by Traderwin. Your license is issued only after payment is independently confirmed."
      },
      message:"Order created. No Traderwin membership account is required. Keep your order reference and check your email for fulfillment updates."
    });
  } catch(error) {
    console.error("Standalone bot shop error:",error?.message||"unknown");
    return res.status(503).json({error:"The bot shop could not complete this request. Please try again later."});
  }
}
